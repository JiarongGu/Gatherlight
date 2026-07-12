import {
  runClaude,
  buildDiff,
  commitPaths,
  restorePaths,
  validateClaudeChanges,
  buildFrontend,
  EditTracker,
  planPrompt,
  executePrompt,
  revisePlanPrompt,
  reviseExecutePrompt,
  planPromptSystem,
  executePromptSystem,
  revisePlanPromptSystem,
  reviseExecutePromptSystem,
  repairPrompt,
  commitMessage,
  type AgentEvent,
  type EventSink,
  type Phase,
  type ReviewPayload,
  type BuildResult
} from '@daily-planner/processors';
import { REPO_ROOT, CHAT_MODEL } from './config.ts';
import { mcpAllowedToolNames } from './tools.ts';

export { REPO_ROOT, CHAT_MODEL } from './config.ts';

const SETTINGS_PATH = 'viewer/processors/settings.chat.json'; // relative to repo root

// MCP: expose the backend tool registry to the chat agent. `mcp.chat.json` launches
// the stdio MCP server; the tool names are pre-approved via --allowedTools so the
// headless run never stalls on a permission prompt. Both are passed to the chat
// runClaude calls (plan / execute / refine) below.
const MCP_CONFIG_PATH = 'viewer/processors/mcp.chat.json'; // relative to repo root
const MCP_ALLOWED_TOOLS = mcpAllowedToolNames();

const TERMINAL: Phase[] = ['committed', 'rejected', 'cancelled', 'error'];

// A "conversation thread" gives follow-ups light continuity WITHOUT growing the
// CLI context: each turn is a brand-new claude session, and we only inject a few
// one-line summaries of recent turns. The thread auto-resets so the injected
// memory stays tiny.
const THREAD_IDLE_MS = 30 * 60 * 1000; // 30 min idle → new conversation
const THREAD_MAX_TURNS = 6; // > 6 summarized turns → new conversation
const MAX_BUILD_REPAIR = 2; // system mode: auto-fix attempts before giving up

export type ChatMode = 'plan' | 'system';
const SYSTEM_ENV = { CHAT_SCOPE: 'system' } as const;

interface TurnSummary {
  message: string;
  outcome: string; // e.g. "已提交 abc123" / "已撤销" / "已停止"
}

export interface Session {
  id: string;
  phase: Phase;
  mode: ChatMode;
  userMessage: string;
  attachments: string[]; // repo-relative paths of uploaded files (read by the agent)
  claudeSessionId: string | null;
  planText: string;
  tracker: EditTracker;
  review?: ReviewPayload;
  commitSha?: string;
  error?: string;
  createdAt: number;
  log: AgentEvent[]; // buffered for SSE replay
  subscribers: Set<EventSink>;
  abort?: AbortController; // aborts the in-flight claude run
  cancelled?: boolean; // set by cancel() so post-await steps bail out
  threadContext: string; // compact summary of prior turns, injected into the planner
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `s${Date.now().toString(36)}_${counter}`;
}

/**
 * Holds chat sessions and drives the two-gate flow. Enforces a single active
 * task at a time — concurrent runs would corrupt the shared git working tree.
 */
export class ChatController {
  private readonly sessions = new Map<string, Session>();
  private activeId: string | null = null;

  // Current conversation thread (compact summaries only).
  private thread: TurnSummary[] = [];
  private threadLastAt = 0;

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Decide whether the thread should reset before this turn, and why. */
  private maybeResetThread(now: number): boolean {
    const idle = this.threadLastAt > 0 && now - this.threadLastAt > THREAD_IDLE_MS;
    const tooLong = this.thread.length >= THREAD_MAX_TURNS;
    // After a committed turn the work is durably in files → fresh slate.
    const lastCommitted = this.thread.at(-1)?.outcome.startsWith('已提交') ?? false;
    if (idle || tooLong || lastCommitted) {
      this.thread = [];
      return true;
    }
    return false;
  }

  /** Render the thread as a few one-liners for the planner prompt. */
  private threadContext(): string {
    return this.thread.map((t) => `- "${t.message}" → ${t.outcome}`).join('\n');
  }

  /** Record a finished turn's outcome into the thread (kept compact). */
  private recordOutcome(s: Session, outcome: string): void {
    const message = s.userMessage.replace(/\s+/g, ' ').trim().slice(0, 80);
    this.thread.push({ message, outcome });
    this.threadLastAt = Date.now();
  }

  isBusy(): boolean {
    if (!this.activeId) return false;
    const s = this.sessions.get(this.activeId);
    return !!s && !TERMINAL.includes(s.phase);
  }

  subscribe(id: string, sink: EventSink): () => void {
    const s = this.sessions.get(id);
    if (!s) return () => {};
    // Replay buffered events so a late subscriber catches up.
    for (const ev of s.log) sink(ev);
    s.subscribers.add(sink);
    return () => s.subscribers.delete(sink);
  }

  private emit(s: Session, ev: AgentEvent): void {
    s.log.push(ev);
    for (const sink of s.subscribers) {
      try {
        sink(ev);
      } catch {
        /* dropped subscriber */
      }
    }
  }

  private setPhase(s: Session, phase: Phase, data?: unknown): void {
    s.phase = phase;
    this.emit(s, { kind: 'phase', phase, data });
  }

  private fail(s: Session, message: string): void {
    s.error = message;
    this.emit(s, { kind: 'error', text: message });
    this.setPhase(s, 'error');
    this.emit(s, { kind: 'done', phase: 'error' });
  }

  /** Gate 0 — start a task. Returns the new session (planning kicks off async). */
  startChat(userMessage: string, mode: ChatMode = 'plan', attachments: string[] = []): Session {
    if (this.isBusy()) {
      throw new Error('BUSY');
    }
    // Silently keep the injected summary small. Each turn ALWAYS runs as a brand
    // new claude session regardless — this only bounds the compact context we
    // hand the planner; continuity otherwise comes from the repo files.
    this.maybeResetThread(Date.now());
    const s: Session = {
      id: newId(),
      phase: 'idle',
      mode,
      userMessage,
      attachments,
      claudeSessionId: null,
      planText: '',
      tracker: new EditTracker(REPO_ROOT),
      createdAt: Date.now(),
      log: [],
      subscribers: new Set(),
      threadContext: this.threadContext() // snapshot BEFORE this turn is recorded
    };
    this.sessions.set(s.id, s);
    this.activeId = s.id;
    void this.runPlanning(s);
    return s;
  }

  private async runPlanning(s: Session): Promise<void> {
    const sys = s.mode === 'system';
    this.setPhase(s, 'planning');
    this.emit(s, {
      kind: 'notice',
      text: sys ? '🔧 系统模式:正在分析界面代码 + 拟定改动计划…' : '🧭 正在按 CLAUDE.md gate 调研 + 拟定计划…'
    });
    s.abort = new AbortController();
    try {
      const res = await runClaude({
        prompt: sys
          ? planPromptSystem(s.userMessage, s.threadContext, s.attachments)
          : planPrompt(s.userMessage, s.threadContext, s.attachments),
        repoRoot: REPO_ROOT,
        readOnly: true,
        model: CHAT_MODEL,
        mcpConfigPath: MCP_CONFIG_PATH,
        allowedTools: MCP_ALLOWED_TOOLS,
        signal: s.abort.signal,
        extraEnv: sys ? SYSTEM_ENV : undefined,
        onEvent: (ev) => this.emit(s, ev)
      });
      if (s.cancelled) return; // cancel() owns the terminal state
      s.claudeSessionId = res.sessionId;
      s.planText = (res.finalText ?? '').trim();
      if (!s.planText) {
        this.fail(s, '计划阶段没有产出内容,请重试或换个说法。');
        return;
      }
      this.setPhase(s, 'awaiting-plan-approval', { plan: s.planText });
    } catch (err: any) {
      if (s.cancelled) return;
      this.fail(s, `计划阶段失败:${err?.message ?? err}`);
    }
  }

  /** Gate 1 reject — nothing written yet, just close out. */
  rejectPlan(id: string): void {
    const s = this.requirePhase(id, 'awaiting-plan-approval');
    this.recordOutcome(s, '已放弃计划');
    this.emit(s, { kind: 'notice', text: '已放弃该计划。' });
    this.setPhase(s, 'rejected');
    this.emit(s, { kind: 'done', phase: 'rejected' });
  }

  /** Gate 1 approve — execute the plan, then build the diff for gate 2. */
  async approvePlan(id: string): Promise<void> {
    const s = this.requirePhase(id, 'awaiting-plan-approval');
    const sys = s.mode === 'system';
    this.setPhase(s, 'executing');
    this.emit(s, { kind: 'notice', text: '✍️ 正在按已批准的计划修改文件…' });
    s.abort = new AbortController();
    try {
      const res = await runClaude({
        prompt: sys ? executePromptSystem(s.planText) : executePrompt(s.planText),
        repoRoot: REPO_ROOT,
        readOnly: false,
        model: CHAT_MODEL,
        mcpConfigPath: MCP_CONFIG_PATH,
        allowedTools: MCP_ALLOWED_TOOLS,
        resumeSessionId: s.claudeSessionId ?? undefined,
        settingsPath: SETTINGS_PATH,
        tracker: s.tracker,
        signal: s.abort.signal,
        extraEnv: sys ? SYSTEM_ENV : undefined,
        onEvent: (ev) => this.emit(s, ev)
      });
      if (s.cancelled) return;
      if (res.sessionId) s.claudeSessionId = res.sessionId;

      // System mode: verify the build, auto-repairing up to MAX_BUILD_REPAIR.
      let build: BuildResult | undefined;
      if (sys) {
        build = await this.buildWithRepair(s);
        if (s.cancelled) return;
      }

      await this.presentDiff(s, build);
    } catch (err: any) {
      if (s.cancelled) return;
      this.fail(s, `执行阶段失败:${err?.message ?? err}`);
    }
  }

  /**
   * Shared tail of the execute / re-execute phases: build the real-change diff,
   * validate any .claude (智库) edits, then enter gate 2 — or close out as
   * "rejected" when nothing actually changed. Assumes `s.abort` is set.
   */
  private async presentDiff(s: Session, build?: BuildResult): Promise<void> {
    const tracked = s.tracker.list();
    const files = tracked.length ? await buildDiff(REPO_ROOT, tracked) : [];
    // `files` is the REAL-change set (buildDiff drops denied / no-op edits).
    if (files.length === 0) {
      this.recordOutcome(s, '无实际改动');
      this.emit(s, {
        kind: 'notice',
        text: '没有文件被实际修改(可能被范围限制拦截,或无需改动)。'
      });
      this.setPhase(s, 'rejected');
      this.emit(s, { kind: 'done', phase: 'rejected' });
      return;
    }

    const claudeFiles = files.filter((f) => f.isClaudeInfra);
    const review: ReviewPayload = {
      files,
      hasClaudeInfra: claudeFiles.length > 0,
      build
    };

    if (claudeFiles.length > 0) {
      this.setPhase(s, 'validating');
      review.validation = await validateClaudeChanges(
        REPO_ROOT,
        claudeFiles,
        (ev) => this.emit(s, ev),
        s.abort?.signal,
        CHAT_MODEL
      );
      if (s.cancelled) return;
    }

    s.review = review;
    this.setPhase(s, 'awaiting-diff-approval', review);
  }

  /**
   * Gate 1 refine — instead of approve/reject, the human answered a question or
   * added info. Resume the (read-only) planning session and produce a revised
   * plan, landing back at the plan-approval gate.
   */
  async refinePlan(id: string, feedback: string): Promise<void> {
    const s = this.requirePhase(id, 'awaiting-plan-approval');
    const sys = s.mode === 'system';
    this.setPhase(s, 'planning');
    this.emit(s, { kind: 'notice', text: '🧭 收到你的补充,正在据此修订计划…' });
    s.abort = new AbortController();
    try {
      const res = await runClaude({
        prompt: sys
          ? revisePlanPromptSystem(s.planText, feedback)
          : revisePlanPrompt(s.planText, feedback),
        repoRoot: REPO_ROOT,
        readOnly: true,
        model: CHAT_MODEL,
        mcpConfigPath: MCP_CONFIG_PATH,
        allowedTools: MCP_ALLOWED_TOOLS,
        resumeSessionId: s.claudeSessionId ?? undefined,
        signal: s.abort.signal,
        extraEnv: sys ? SYSTEM_ENV : undefined,
        onEvent: (ev) => this.emit(s, ev)
      });
      if (s.cancelled) return;
      if (res.sessionId) s.claudeSessionId = res.sessionId;
      const text = (res.finalText ?? '').trim();
      if (!text) {
        this.fail(s, '修订计划时没有产出内容,请重试或换个说法。');
        return;
      }
      s.planText = text;
      this.setPhase(s, 'awaiting-plan-approval', { plan: s.planText });
    } catch (err: any) {
      if (s.cancelled) return;
      this.fail(s, `修订计划失败:${err?.message ?? err}`);
    }
  }

  /**
   * Gate 2 refine — instead of approve/reject, the human asked for adjustments
   * to the file changes. Resume the execute session, re-edit, rebuild the diff,
   * and land back at the diff-approval gate.
   */
  async refineDiff(id: string, feedback: string): Promise<void> {
    const s = this.requirePhase(id, 'awaiting-diff-approval');
    const sys = s.mode === 'system';
    this.setPhase(s, 'executing');
    this.emit(s, { kind: 'notice', text: '✍️ 收到调整意见,正在修改文件…' });
    s.review = undefined; // the prior diff is now stale
    s.abort = new AbortController();
    try {
      const res = await runClaude({
        prompt: sys ? reviseExecutePromptSystem(feedback) : reviseExecutePrompt(feedback),
        repoRoot: REPO_ROOT,
        readOnly: false,
        model: CHAT_MODEL,
        mcpConfigPath: MCP_CONFIG_PATH,
        allowedTools: MCP_ALLOWED_TOOLS,
        resumeSessionId: s.claudeSessionId ?? undefined,
        settingsPath: SETTINGS_PATH,
        tracker: s.tracker,
        signal: s.abort.signal,
        extraEnv: sys ? SYSTEM_ENV : undefined,
        onEvent: (ev) => this.emit(s, ev)
      });
      if (s.cancelled) return;
      if (res.sessionId) s.claudeSessionId = res.sessionId;

      let build: BuildResult | undefined;
      if (sys) {
        build = await this.buildWithRepair(s);
        if (s.cancelled) return;
      }

      await this.presentDiff(s, build);
    } catch (err: any) {
      if (s.cancelled) return;
      this.fail(s, `调整阶段失败:${err?.message ?? err}`);
    }
  }

  /** System mode: run the frontend build; on failure feed errors back to the agent. */
  private async buildWithRepair(s: Session): Promise<BuildResult> {
    for (let attempt = 0; ; attempt++) {
      this.setPhase(s, 'building');
      this.emit(s, {
        kind: 'notice',
        text: attempt === 0 ? '🔧 构建验证中…' : `🔧 重新构建(修复尝试 ${attempt}/${MAX_BUILD_REPAIR})…`
      });
      const result = await buildFrontend(REPO_ROOT, s.abort?.signal);
      if (s.cancelled) return result;
      if (result.ok) {
        this.emit(s, { kind: 'notice', text: '✅ 构建通过' });
        return result;
      }
      if (attempt >= MAX_BUILD_REPAIR) {
        this.emit(s, { kind: 'notice', text: '⚠️ 构建仍未通过,已停止自动修复 — 不能提交,请审阅错误。' });
        return result;
      }
      this.emit(s, { kind: 'notice', text: `❌ 构建失败,让 AI 修复(第 ${attempt + 1} 次)…` });
      this.setPhase(s, 'executing');
      await runClaude({
        prompt: repairPrompt(result.output),
        repoRoot: REPO_ROOT,
        readOnly: false,
        model: CHAT_MODEL,
        mcpConfigPath: MCP_CONFIG_PATH,
        allowedTools: MCP_ALLOWED_TOOLS,
        resumeSessionId: s.claudeSessionId ?? undefined,
        settingsPath: SETTINGS_PATH,
        tracker: s.tracker,
        signal: s.abort?.signal,
        extraEnv: SYSTEM_ENV,
        onEvent: (ev) => this.emit(s, ev)
      });
      if (s.cancelled) return result;
    }
  }

  /** Gate 2 approve — commit exactly the tracked paths. */
  async approveDiff(id: string): Promise<void> {
    const s = this.requirePhase(id, 'awaiting-diff-approval');
    if (s.review?.build && !s.review.build.ok) {
      this.emit(s, { kind: 'error', text: '构建未通过,不能提交。请「拒绝并还原」或让 AI 继续修复。' });
      return;
    }
    this.setPhase(s, 'committing');
    try {
      // Commit exactly the real-change set shown in the review (not raw tracker,
      // which can include denied / no-op paths → "nothing to commit").
      const paths = (s.review?.files ?? []).map((f) => f.path);
      const sha = await commitPaths(
        REPO_ROOT,
        paths,
        commitMessage(s.userMessage, paths)
      );
      s.commitSha = sha;
      this.recordOutcome(s, `已提交 ${sha}`);
      this.emit(s, { kind: 'notice', text: `✅ 已提交 ${sha}` });
      this.setPhase(s, 'committed', { sha, files: paths });
      this.emit(s, { kind: 'done', phase: 'committed', data: { sha } });
    } catch (err: any) {
      this.fail(s, `提交失败:${err?.message ?? err}`);
    }
  }

  /** Gate 2 reject — discard the agent's changes to the tracked paths. */
  async rejectDiff(id: string): Promise<void> {
    const s = this.requirePhase(id, 'awaiting-diff-approval');
    try {
      await restorePaths(REPO_ROOT, s.tracker.list());
      this.recordOutcome(s, '已撤销改动');
      this.emit(s, { kind: 'notice', text: '已撤销改动,工作区已还原。' });
      this.setPhase(s, 'rejected');
      this.emit(s, { kind: 'done', phase: 'rejected' });
    } catch (err: any) {
      this.fail(s, `还原失败:${err?.message ?? err}`);
    }
  }

  /**
   * Force-stop a task from ANY non-terminal phase. Kills the in-flight claude
   * process, discards any partial edits, releases the single-task lock.
   */
  async cancel(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new Error('NOT_FOUND');
    if (TERMINAL.includes(s.phase)) return; // already done — no-op
    if (s.cancelled) return; // cancel already in progress

    s.cancelled = true;
    s.abort?.abort(); // kills the running claude process tree (if any)
    this.emit(s, { kind: 'notice', text: '⛔ 已强制停止当前任务。' });

    // Discard anything the agent wrote so the working tree is left clean.
    const tracked = s.tracker.list();
    if (tracked.length) {
      try {
        await restorePaths(REPO_ROOT, tracked);
        this.emit(s, { kind: 'notice', text: '已还原本次产生的改动。' });
      } catch (err: any) {
        this.emit(s, { kind: 'notice', text: `还原时出错:${err?.message ?? err}` });
      }
    }

    this.recordOutcome(s, '已强制停止');
    this.setPhase(s, 'cancelled');
    this.emit(s, { kind: 'done', phase: 'cancelled' });
  }

  private requirePhase(id: string, expected: Phase): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error('NOT_FOUND');
    if (s.phase !== expected) {
      throw new Error(`BAD_PHASE:${s.phase}`);
    }
    return s;
  }
}
