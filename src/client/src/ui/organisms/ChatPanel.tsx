import { useEffect, useReducer, useRef, useCallback, useState, memo } from 'react';
import { Button, Input, Alert, Tag, Spin, Switch, Tooltip, IconButton, Stepper as StepperBar } from '@/ui/atoms';
import {
  SendOutlined,
  RobotOutlined,
  ToolOutlined,
  CheckCircleFilled,
  StopOutlined,
  PaperClipOutlined
} from '@ant-design/icons';
import { MarkdownView } from './MarkdownView';
import { PlanActions, DiffReview } from './ChatReview';
import { ChatRating } from './ChatRating';
import {
  startChat,
  openStream,
  approvePlan,
  rejectPlan,
  approveDiff,
  rejectDiff,
  refinePlan,
  refineDiff,
  respondInput,
  cancelChat,
  uploadFiles
} from '@/lib/chatApi';
import {
  type AgentEvent,
  type Phase,
  type ReviewPayload,
  type UploadedFile,
  PHASE_LABELS
} from '@/lib/chatTypes';
import { formatFileSize } from '@/lib/format';

interface TranscriptItem {
  id: number;
  role: 'user' | 'assistant' | 'notice' | 'tool' | 'divider';
  text?: string;
  tool?: { name: string; detail?: string };
}

interface ChatState {
  sessionId: string | null;
  phase: Phase;
  items: TranscriptItem[];
  live: string; // streaming assistant text
  thinking: string;
  review: ReviewPayload | null;
  // The agent's question when it paused (phase 'awaiting-input'); shown as a prompt to reply to.
  inputQuestion: string | null;
  // Discrete choices the agent offered (OPTION: lines) — rendered as click-to-select buttons.
  inputOptions: string[];
  commitSha: string | null;
  error: string | null;
  busy: boolean; // an approve/reject request is in flight
  // Cumulative session usage (committed via one 'usage' event per CLI run: plan / execute / refine…).
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number };
  // Live usage of the IN-FLIGHT run — accumulates 'usage-live' ticks (per assistant turn) so tokens
  // climb visibly during a long plan/research phase; reset to zero when the run's 'usage' total commits.
  liveUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 };
const ZERO_LIVE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

const initialState: ChatState = {
  sessionId: null,
  phase: 'idle',
  items: [],
  live: '',
  thinking: '',
  review: null,
  inputQuestion: null,
  inputOptions: [],
  commitSha: null,
  error: null,
  busy: false,
  usage: ZERO_USAGE,
  liveUsage: ZERO_LIVE
};

let seq = 0;
const nextId = () => ++seq;

const SESSION_KEY = 'viewer-chat-session';
// Persist the unsent input so closing/reopening the chat drawer (or a reload) doesn't lose it.
const DRAFT_KEY = 'viewer-chat-draft';

// Clickable starter prompts for the empty chat — a new user's fastest way in.
const CHAT_STARTERS = [
  '把日本行程 Day 3 改成京都一日游',
  '在 household 里记一下家人的饮食偏好',
  '给 8 月日本之行建一个打包清单',
];

type Action =
  | { type: 'reset'; sessionId: string; message: string }
  | { type: 'rehydrate'; sessionId: string }
  | { type: 'refine'; phase: Phase; message: string }
  | { type: 'event'; ev: AgentEvent }
  | { type: 'busy'; value: boolean };

function flushLive(state: ChatState): TranscriptItem[] {
  if (!state.live.trim()) return state.items;
  return [...state.items, { id: nextId(), role: 'assistant', text: state.live }];
}

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'reset':
      // New turn — keep the visible conversation, just append a separator + the
      // new user message. (Each turn still runs as a fresh CLI session server-side.)
      return {
        ...state,
        sessionId: action.sessionId,
        phase: 'planning',
        items: [
          ...state.items,
          ...(state.items.length ? [{ id: nextId(), role: 'divider' as const }] : []),
          { id: nextId(), role: 'user' as const, text: action.message }
        ],
        live: '',
        thinking: '',
        review: null,
        inputQuestion: null,
        inputOptions: [],
        commitSha: null,
        error: null,
        busy: false,
        usage: ZERO_USAGE,
        liveUsage: ZERO_LIVE
      };

    case 'rehydrate':
      // Reconnecting to a session after a reload — the backend replays its event
      // log, which repopulates phase / transcript / review.
      return { ...initialState, sessionId: action.sessionId };

    case 'refine':
      // Talking back at a gate: append the user's message and re-enter the
      // working phase optimistically (the SSE phase event confirms it). Same
      // session — the stream stays open; the old plan/review is now stale.
      return {
        ...state,
        phase: action.phase,
        items: [...state.items, { id: nextId(), role: 'user' as const, text: action.message }],
        live: '',
        thinking: '',
        review: null,
        inputQuestion: null,
        inputOptions: [],
        error: null,
        busy: false
      };

    case 'busy':
      return { ...state, busy: action.value };

    case 'event': {
      const ev = action.ev;
      switch (ev.kind) {
        case 'text-delta':
          return { ...state, live: state.live + (ev.text ?? '') };

        case 'usage': {
          // Authoritative per-run total — commit it to the session usage and clear the live counter
          // (whose ticks approximated this same run and are now superseded).
          const u = (ev.data ?? {}) as Partial<ChatState['usage']>;
          return {
            ...state,
            usage: {
              inputTokens: state.usage.inputTokens + (u.inputTokens ?? 0),
              outputTokens: state.usage.outputTokens + (u.outputTokens ?? 0),
              cacheReadTokens: state.usage.cacheReadTokens + (u.cacheReadTokens ?? 0),
              costUsd: state.usage.costUsd + (u.costUsd ?? 0)
            },
            liveUsage: ZERO_LIVE
          };
        }

        case 'usage-live': {
          // Ephemeral per-turn tick — accumulate into the in-flight run's live counter so tokens climb
          // visibly during a long plan/research phase. Reset when the run's 'usage' total commits.
          const u = (ev.data ?? {}) as Partial<ChatState['liveUsage']>;
          return {
            ...state,
            liveUsage: {
              inputTokens: state.liveUsage.inputTokens + (u.inputTokens ?? 0),
              outputTokens: state.liveUsage.outputTokens + (u.outputTokens ?? 0),
              cacheReadTokens: state.liveUsage.cacheReadTokens + (u.cacheReadTokens ?? 0)
            }
          };
        }

        case 'thinking':
          return { ...state, thinking: state.thinking + (ev.text ?? '') };

        case 'text': {
          // Full block — authoritative; replaces whatever streamed into `live`.
          const items = state.live.trim()
            ? state.items
            : [...state.items];
          return {
            ...state,
            items: [...items, { id: nextId(), role: 'assistant', text: ev.text ?? '' }],
            live: '',
            thinking: ''
          };
        }

        case 'tool':
          return {
            ...state,
            items: [
              ...flushLive(state),
              { id: nextId(), role: 'tool', tool: ev.tool }
            ],
            live: ''
          };

        case 'notice':
          return {
            ...state,
            items: [
              ...flushLive(state),
              { id: nextId(), role: 'notice', text: ev.text }
            ],
            live: ''
          };

        case 'phase': {
          const phase = ev.phase ?? state.phase;
          const next: ChatState = {
            ...state,
            phase,
            busy: false,
            items: flushLive(state),
            live: ''
          };
          if (phase === 'awaiting-diff-approval' && ev.data) {
            next.review = ev.data as ReviewPayload;
          }
          if (phase === 'awaiting-input') {
            const d = ev.data as { question?: string; options?: string[] } | undefined;
            next.inputQuestion = d?.question ?? null;
            next.inputOptions = d?.options ?? [];
          }
          if (phase === 'committed' && ev.data) {
            next.commitSha = (ev.data as { sha?: string }).sha ?? null;
          }
          return next;
        }

        case 'error':
          return {
            ...state,
            error: ev.text ?? '出错了',
            items: flushLive(state),
            live: ''
          };

        case 'done':
          return { ...state, busy: false };

        default:
          return state;
      }
    }

    default:
      return state;
  }
}

const IN_PROGRESS: Phase[] = ['planning', 'executing', 'building', 'validating', 'committing'];
const STEPS: { key: Phase; label: string }[] = [
  { key: 'planning', label: '计划' },
  { key: 'awaiting-plan-approval', label: '审计划' },
  { key: 'executing', label: '执行' },
  { key: 'awaiting-diff-approval', label: '审改动' },
  { key: 'committed', label: '提交' }
];
const STEP_ORDER: Record<string, number> = {
  planning: 0,
  'awaiting-plan-approval': 1,
  executing: 2,
  building: 2,
  validating: 2,
  'awaiting-diff-approval': 3,
  'awaiting-input': 2,
  committing: 4,
  committed: 4
};

function Stepper({ phase }: { phase: Phase }) {
  if (phase === 'idle') return null;
  const current = STEP_ORDER[phase] ?? -1;
  return <StepperBar steps={STEPS} current={current} allDone={phase === 'committed'} />;
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Cumulative session token usage — one line under the stepper, updates live via SSE. */
function UsageLine({ usage, live }: { usage: ChatState['usage']; live: ChatState['liveUsage'] }) {
  // Committed session totals + the in-flight run's live ticks, so tokens climb during a long
  // plan/research phase instead of only appearing at the end.
  const input = usage.inputTokens + live.inputTokens;
  const output = usage.outputTokens + live.outputTokens;
  const cacheRead = usage.cacheReadTokens + live.cacheReadTokens;
  if (input + output === 0) return null;
  const streaming = live.inputTokens + live.outputTokens > 0;
  return (
    <Tooltip title={`输入 ${input.toLocaleString()} · 输出 ${output.toLocaleString()} · 缓存读取 ${cacheRead.toLocaleString()}`}>
      <div className={`chat-usage${streaming ? ' live' : ''}`}>
        ⚡ {fmtTokens(input)} in · {fmtTokens(output)} out
        {usage.costUsd > 0 && <> · ~USD {usage.costUsd.toFixed(3)}</>}
        {streaming && <> · 计算中…</>}
      </div>
    </Tooltip>
  );
}

export function ChatPanel({ prefill, prefillNonce }: { prefill?: string; prefillNonce?: number }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Restore any unsent draft (closing the drawer unmounts this component).
  const [draft, setDraft] = useState(() => {
    try { return localStorage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
  });
  const [cancelling, setCancelling] = useState(false);
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  // 系统模式: the agent edits the app's OWN UI code (src/client), builds it, and the
  // approved change ships on the next refresh. Off = normal planning on the data workspace.
  const [systemMode, setSystemMode] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Highest SSE frame seq applied — reset to -1 whenever a fresh stream opens (both open from the
  // server's log at seq 0). Guards against a re-delivered frame doubling token/cost + transcript if a
  // reconnect ever replays past what Last-Event-ID already covered.
  const lastSeqRef = useRef(-1);
  // Dispatch an event + drop the persisted session id once it finishes.
  const onEvent = useCallback((ev: AgentEvent, seq: number) => {
    if (seq >= 0 && seq <= lastSeqRef.current) return;   // already applied — skip replay
    if (seq >= 0) lastSeqRef.current = seq;
    if (ev.kind === 'done') localStorage.removeItem(SESSION_KEY);
    dispatch({ type: 'event', ev });
  }, []);

  const closeRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Track whether the transcript is scrolled to the bottom so streaming updates don't yank the user
  // back when they've scrolled up to re-read; a "jump to latest" button appears when they have.
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const onScrollList = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = near;
    setShowJump(!near); // show the jump button only when scrolled away from the bottom
  }, []);
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  // Seed the input when an action routes here (user reviews, then sends).
  useEffect(() => {
    if (prefill) setDraft(prefill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce]);

  // Persist the unsent draft (cleared when send() sets it to '').
  useEffect(() => {
    try { if (draft) localStorage.setItem(DRAFT_KEY, draft); else localStorage.removeItem(DRAFT_KEY); } catch { /* storage disabled */ }
  }, [draft]);

  // Reconnect to an in-flight session after a reload (e.g. a system-mode HMR
  // reload of this very page). The backend replays its event log to rebuild state.
  useEffect(() => {
    const id = localStorage.getItem(SESSION_KEY);
    if (!id) return;
    dispatch({ type: 'rehydrate', sessionId: id });
    lastSeqRef.current = -1;   // fresh stream replays from seq 0
    closeRef.current = openStream(id, onEvent, () => localStorage.removeItem(SESSION_KEY));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll to newest content — but only when the user is already near the bottom, so scrolling
  // up to re-read mid-stream isn't yanked back (the jump button handles the return).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [state.items, state.live, state.review, state.phase]);

  useEffect(() => () => closeRef.current?.(), []);

  // `inFlow` = a session is ongoing (locks the mode switch). `active` = the AI is
  // actively working (input disabled; use 停止). At the two approval gates AND when the
  // agent paused for input, the input is ENABLED so the user can answer / request adjustments.
  const inFlow =
    IN_PROGRESS.includes(state.phase) ||
    state.phase === 'awaiting-plan-approval' ||
    state.phase === 'awaiting-diff-approval' ||
    state.phase === 'awaiting-input';
  const active = IN_PROGRESS.includes(state.phase);
  // A fresh turn can be sent with text OR attachments alone (attachments-only
  // falls back to a default instruction in send()).
  const canSend =
    !active && !state.busy && !uploading && (draft.trim().length > 0 || attachments.length > 0);

  // Upload picked files → append their server references to the pending list.
  const pickFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const uploaded = await uploadFiles(Array.from(files));
      setAttachments((prev) => [...prev, ...uploaded]);
    } catch (err: any) {
      dispatch({ type: 'event', ev: { kind: 'error', text: err?.message ?? '上传失败' } });
    } finally {
      setUploading(false);
    }
  }, []);

  const removeAttachment = useCallback((relPath: string) => {
    setAttachments((prev) => prev.filter((a) => a.relPath !== relPath));
  }, []);

  // Reply to a paused agent — free text OR a clicked OPTION. Optimistically re-enter executing (the
  // SSE phase event confirms it); same session, so the stream stays open and the agent resumes.
  const replyInput = useCallback(async (message: string) => {
    const { sessionId } = state;
    const text = message.trim();
    if (!sessionId || !text) return;
    dispatch({ type: 'refine', phase: 'executing', message: text });
    setDraft('');
    try {
      await respondInput(sessionId, text);
    } catch (err: any) {
      dispatch({ type: 'event', ev: { kind: 'error', text: err?.message ?? '发送失败' } });
    }
  }, [state]);

  const send = useCallback(async () => {
    const message = draft.trim();
    const { phase, sessionId } = state;
    try {
      // At a gate: talk back instead of starting a new turn — the agent revises
      // and returns to the gate (same session, stream stays open). A typed
      // message is required here; attachments aren't supported at gates yet.
      if (phase === 'awaiting-plan-approval' && sessionId) {
        if (!message) return;
        dispatch({ type: 'refine', phase: 'planning', message });
        setDraft('');
        await refinePlan(sessionId, message);
        return;
      }
      if (phase === 'awaiting-diff-approval' && sessionId) {
        if (!message) return;
        dispatch({ type: 'refine', phase: 'executing', message });
        setDraft('');
        await refineDiff(sessionId, message);
        return;
      }
      // Agent paused for a decision: reply resumes the SAME session and continues executing.
      if (phase === 'awaiting-input' && sessionId) {
        if (!message) return;
        await replyInput(message);
        return;
      }
      // Otherwise (idle / terminal): a fresh turn on a new session. Allow an
      // attachments-only send with a default instruction so the backend (which
      // requires a message) still gets one.
      if (!message && attachments.length === 0) return;
      const outgoing = message || '请阅读我上传的附件,并据此帮我规划 / 填写行程。';
      closeRef.current?.();
      const { id } = await startChat(outgoing, attachments, systemMode ? 'system' : 'plan');
      localStorage.setItem(SESSION_KEY, id);
      dispatch({ type: 'reset', sessionId: id, message: outgoing });
      setDraft('');
      setAttachments([]);
      lastSeqRef.current = -1;   // fresh session/stream starts at seq 0
      closeRef.current = openStream(id, onEvent);
    } catch (err: any) {
      dispatch({ type: 'event', ev: { kind: 'error', text: err?.message ?? '发送失败' } });
    }
  }, [draft, onEvent, state, attachments, systemMode, replyInput]);

  const act = useCallback(
    async (fn: (id: string) => Promise<unknown>) => {
      if (!state.sessionId) return;
      dispatch({ type: 'busy', value: true });
      try {
        await fn(state.sessionId);
      } catch (err: any) {
        dispatch({ type: 'event', ev: { kind: 'error', text: err?.message ?? '操作失败' } });
        dispatch({ type: 'busy', value: false });
      }
    },
    [state.sessionId]
  );

  const cancel = useCallback(async () => {
    if (!state.sessionId) return;
    setCancelling(true);
    try {
      await cancelChat(state.sessionId);
    } catch (err: any) {
      dispatch({ type: 'event', ev: { kind: 'error', text: err?.message ?? '停止失败' } });
    }
  }, [state.sessionId]);

  // Reset the local "cancelling" flag once the task leaves the active state.
  useEffect(() => {
    if (!IN_PROGRESS.includes(state.phase)) setCancelling(false);
  }, [state.phase]);

  // Safety net: `busy` is normally cleared by the confirming `phase`/`done` SSE event (which now
  // reliably arrives — the stream resumes on reconnect). But a permanently-stuck gate button is worse
  // than a re-enabled one, so force-clear after a grace period if no event ever lands. The phase-event
  // path clears busy first, and this effect's cleanup cancels the timer, so it only fires on a true stall.
  useEffect(() => {
    if (!state.busy) return;
    const t = window.setTimeout(() => dispatch({ type: 'busy', value: false }), 30000);
    return () => window.clearTimeout(t);
  }, [state.busy]);

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <RobotOutlined style={{ color: 'var(--accent)' }} />
        <span className="chat-title">Claude 助手</span>
        {state.phase !== 'idle' && (
          <Tag
            color={IN_PROGRESS.includes(state.phase) ? 'processing' : undefined}
            style={{ marginLeft: 'auto' }}
          >
            {IN_PROGRESS.includes(state.phase) && <Spin size="small" style={{ marginRight: 6 }} />}
            {PHASE_LABELS[state.phase]}
          </Tag>
        )}
        {IN_PROGRESS.includes(state.phase) && (
          <Button
            danger
            size="small"
            icon={<StopOutlined />}
            loading={cancelling}
            onClick={() => void cancel()}
            style={{ marginLeft: 8 }}
          >
            停止
          </Button>
        )}
      </div>

      <Stepper phase={state.phase} />
      <UsageLine usage={state.usage} live={state.liveUsage} />

      {showJump && (
        <button className="chat-jump" onClick={jumpToLatest} aria-label="滚动到最新">
          ↓ 最新
        </button>
      )}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScrollList} role="log" aria-live="polite" aria-relevant="additions text">
        {state.items.length === 0 && state.phase === 'idle' && (
          <div className="chat-empty">
            <p>用大白话告诉我要改什么,点一条试试:</p>
            <ul className="chat-starters">
              {CHAT_STARTERS.map((s) => (
                <li key={s}>
                  <button type="button" onClick={() => setDraft(s)}>{s}</button>
                </li>
              ))}
            </ul>
            <p className="chat-empty-note">
              我会先按家庭规则拟一份计划给你看 → 你批准 → 我改文件 → 你审改动 → 自动提交。
              每个审阅环节,你都可以直接在下方输入框回话补充或提要求,我会据此修订。
            </p>
          </div>
        )}

        {state.items.map((it) => (
          <TranscriptRow key={it.id} item={it} />
        ))}

        {state.live.trim() && (
          <div className="chat-msg assistant">
            <MarkdownView source={state.live} />
          </div>
        )}

        {state.phase === 'awaiting-plan-approval' && (
          <PlanActions
            busy={state.busy}
            onApprove={() => act(approvePlan)}
            onReject={() => act(rejectPlan)}
          />
        )}

        {state.phase === 'awaiting-diff-approval' && state.review && (
          <DiffReview
            review={state.review}
            busy={state.busy}
            onApprove={() => act(approveDiff)}
            onReject={() => act(rejectDiff)}
          />
        )}

        {state.phase === 'awaiting-input' && (
          <Alert
            type="info"
            showIcon
            style={{ margin: '8px 0' }}
            message="AI 需要你的选择 / 回复才能继续"
            description={
              <div>
                {state.inputQuestion && (
                  <div style={{ marginBottom: 8, whiteSpace: 'pre-wrap' }}>{state.inputQuestion}</div>
                )}
                {state.inputOptions.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                    {state.inputOptions.map((opt, i) => (
                      <Button key={i} size="small" type="primary" ghost onClick={() => void replyInput(opt)}>
                        {opt}
                      </Button>
                    ))}
                  </div>
                )}
                <span style={{ opacity: 0.75 }}>
                  {state.inputOptions.length > 0
                    ? '点一个选项,或在下方输入框回复。'
                    : '在下方输入框回复,我会带着你的答复继续这次任务。'}
                </span>
                <Button
                  size="small"
                  danger
                  loading={cancelling}
                  onClick={() => void cancel()}
                  style={{ marginLeft: 8 }}
                >
                  放弃任务
                </Button>
              </div>
            }
          />
        )}

        {state.phase === 'committed' && (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleFilled />}
            style={{ margin: '8px 0' }}
            message={`已提交 ${state.commitSha ?? ''}`}
            description="改动已写入仓库,页面内容会自动刷新。"
          />
        )}

        {state.phase === 'rejected' && (
          <Alert type="info" showIcon style={{ margin: '8px 0' }} message="已取消,无改动落库。" />
        )}

        {state.phase === 'cancelled' && (
          <Alert
            type="warning"
            showIcon
            style={{ margin: '8px 0' }}
            message="已强制停止,本次改动已还原。"
          />
        )}

        {state.error && (
          <Alert type="error" showIcon style={{ margin: '8px 0' }} message={state.error} />
        )}

        {/* key on the session so a new conversation gets a fresh rating widget (local sent/rating
            state would otherwise persist and lock out rating every turn after the first). */}
        <ChatRating key={state.sessionId ?? 'none'} sessionId={state.sessionId} phase={state.phase} />
      </div>

      <div className="chat-composer">
        <div className="chat-mode-row">
          <Tooltip title="开启后,本次对话改的是 Gatherlight 界面本身(src/client 代码),改完自动构建验证,构建不过不能提交;批准后刷新即生效。">
            <label className={`chat-mode-label ${systemMode ? 'on' : ''}`}>
              <Switch size="small" checked={systemMode} disabled={inFlow} onChange={setSystemMode} />
              系统模式 · 改界面
            </label>
          </Tooltip>
          {systemMode && <span className="chat-mode-hint">AI 将编辑前端代码并自检构建</span>}
        </div>

        {attachments.length > 0 && (
          <div className="chat-attachments">
            {attachments.map((a) => (
              <Tag
                key={a.relPath}
                closable
                icon={<PaperClipOutlined />}
                onClose={(e) => {
                  e.preventDefault();
                  removeAttachment(a.relPath);
                }}
              >
                <span className="chat-attach-name">{a.name}</span>
                <span className="chat-attach-size">{formatFileSize(a.size)}</span>
              </Tag>
            ))}
          </div>
        )}

        <div className="chat-input">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,image/*"
            multiple
            hidden
            onChange={(e) => {
              void pickFiles(e.target.files);
              e.target.value = ''; // allow re-picking the same file
            }}
          />
          <Tooltip title="上传 PDF / 图片附件 — 我会先读取内容再规划">
            <span>
              <IconButton
                className="chat-attach-btn"
                icon={uploading ? <Spin size="small" /> : <PaperClipOutlined />}
                ariaLabel="上传附件"
                disabled={inFlow || uploading}
                onClick={() => fileInputRef.current?.click()}
              />
            </span>
          </Tooltip>
          <Input.TextArea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              active
                ? '任务进行中…(可点「停止」中断)'
                : state.phase === 'awaiting-plan-approval'
                  ? '可批准,或在此回答问题 / 补充信息 → 我据此改计划'
                  : state.phase === 'awaiting-diff-approval'
                    ? '可批准,或在此说明要怎么调整 → 我据此改文件'
                    : state.phase === 'awaiting-input'
                      ? '回答 AI 的问题 / 补充信息 → 我带着你的答复继续'
                      : '要改什么?(Enter 发送,Shift+Enter 换行)'
            }
            autoSize={{ minRows: 2, maxRows: 8 }}
            disabled={active}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            disabled={!canSend}
            onClick={() => void send()}
          />
        </div>
      </div>
    </div>
  );
}

// Memoized: a chat turn streams many `text-delta` events; each re-renders
// ChatPanel. Without memo, every finished message (each a MarkdownView) would
// re-parse its markdown on every delta. `item` is referentially stable per id,
// so finished rows stay static and only the live streaming block re-renders.
const TranscriptRow = memo(function TranscriptRow({ item }: { item: TranscriptItem }) {
  if (item.role === 'divider') {
    return <div className="chat-divider" aria-hidden />;
  }
  if (item.role === 'user') {
    return <div className="chat-msg user">{item.text}</div>;
  }
  if (item.role === 'assistant') {
    return (
      <div className="chat-msg assistant">
        <MarkdownView source={item.text ?? ''} />
      </div>
    );
  }
  if (item.role === 'tool') {
    return (
      <div className="chat-tool">
        <ToolOutlined />
        <span className="chat-tool-name">{item.tool?.name}</span>
        {item.tool?.detail && <span className="chat-tool-detail">{item.tool.detail}</span>}
      </div>
    );
  }
  // notice
  return <div className="chat-notice">{item.text}</div>;
});
