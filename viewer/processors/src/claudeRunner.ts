import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentEvent, EventSink } from './types.ts';
import { EditTracker } from './editTracker.ts';

const IS_WIN = process.platform === 'win32';
const CLAUDE_BIN = IS_WIN ? 'claude.cmd' : 'claude';

export interface RunOptions {
  prompt: string; // full prompt text (harness already prepended) — sent via stdin
  repoRoot: string; // cwd for claude → auto-loads CLAUDE.md + .claude/
  readOnly: boolean; // true = plan/validation (no edits allowed via flags)
  resumeSessionId?: string; // resume a prior session (execute phase)
  settingsPath?: string; // --settings (scope-guard) for the execute phase
  model?: string; // --model alias/id (e.g. 'sonnet'); omit = CLI default
  mcpConfigPath?: string; // --mcp-config (expose backend tools to the agent)
  allowedTools?: string[]; // --allowedTools (pre-approve, e.g. the MCP tool names)
  tracker?: EditTracker; // populated from Edit/Write tool_use events
  signal?: AbortSignal; // abort → kill the claude process tree
  extraEnv?: Record<string, string>; // merged into the spawn env (e.g. CHAT_SCOPE)
  onEvent: EventSink;
}

export interface RunResult {
  sessionId: string | null;
  finalText: string; // the agent's final assistant text / result
  exitCode: number;
}

/** Build the static argv (no dynamic user content — that goes through stdin). */
function buildArgs(opts: RunOptions): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages'
  ];
  // Interactive / flow-control tools have no UI in this headless flow — calling
  // them would hang the run (no way to answer). Forks belong in the plan, decided
  // at the human approval gate. Always disallow them.
  const disallowed = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'];
  if (opts.readOnly) {
    // Plan / validation: also hard read-only via tool denial.
    disallowed.push('Edit', 'Write', 'MultiEdit', 'NotebookEdit');
  } else {
    // Execute: auto-accept edits so the headless run never stalls on a prompt
    // (settings.chat.json also sets this; explicit flag is belt-and-suspenders).
    args.push('--permission-mode', 'acceptEdits');
  }
  args.push('--disallowedTools', ...disallowed);
  if (opts.allowedTools && opts.allowedTools.length) {
    // Pre-approve these tools so the headless run never stalls on a permission
    // prompt. Additive — read-only tools (Read/Grep/Glob) stay auto-allowed.
    args.push('--allowedTools', ...opts.allowedTools);
  }
  if (opts.mcpConfigPath) {
    // Non-strict: merge with any default MCP config rather than replacing it.
    args.push('--mcp-config', opts.mcpConfigPath);
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }
  if (opts.settingsPath) {
    args.push('--settings', opts.settingsPath);
  }
  return args;
}

/**
 * Spawn the local (already-logged-in) claude CLI, stream its stream-json output,
 * and translate each line into normalized AgentEvents. Resolves when the process
 * exits. Rejects only on spawn failure.
 */
export function runClaude(opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(opts);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: opts.repoRoot,
        shell: IS_WIN, // needed to resolve claude.cmd on Windows
        env: { ...process.env, ...opts.extraEnv }
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      reject(err);
      return;
    }

    let sessionId: string | null = null;
    let finalText = '';
    let stdoutBuf = '';
    let killed = false;

    // Abort → kill the whole process tree (on Windows the shell spawns claude
    // as a child, so child.kill() alone would orphan it).
    const onAbort = () => {
      killed = true;
      opts.onEvent({ kind: 'notice', text: '⛔ 正在停止 claude…' });
      killTree(child);
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // Prompt over stdin → keeps argv free of dynamic content.
    child.stdin.write(opts.prompt);
    child.stdin.end();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // non-JSON log line
        }
        const r = handleMessage(msg, opts);
        if (r.sessionId) sessionId = r.sessionId;
        if (r.finalText) finalText = r.finalText;
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // CLI logs go to stderr; surface only as a low-key notice if it looks like an error.
      const text = chunk.trim();
      if (/error|fatal|denied|not found/i.test(text)) {
        opts.onEvent({ kind: 'notice', text: `[claude] ${text.slice(0, 400)}` });
      }
    });

    child.on('error', (err) => {
      if (killed) resolve({ sessionId, finalText, exitCode: -1 });
      else reject(err);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ sessionId, finalText, exitCode: code ?? 0 });
    });
  });
}

/** Kill a child and its descendants (Windows needs taskkill /T). */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) return;
  if (IS_WIN) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
  }
}

/** Translate one stream-json object into events; returns sessionId/finalText if present. */
function handleMessage(
  msg: any,
  opts: RunOptions
): { sessionId?: string; finalText?: string } {
  const out: { sessionId?: string; finalText?: string } = {};

  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init' && msg.session_id) {
        out.sessionId = msg.session_id;
        opts.onEvent({ kind: 'system', sessionId: msg.session_id });
      }
      break;
    }

    // Partial token streaming (with --include-partial-messages).
    case 'stream_event': {
      const ev = msg.event;
      if (ev?.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta' && ev.delta.text) {
          opts.onEvent({ kind: 'text-delta', text: ev.delta.text });
        } else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
          opts.onEvent({ kind: 'thinking', text: ev.delta.thinking });
        }
      }
      break;
    }

    case 'assistant': {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          opts.tracker?.record(block.name, block.input);
          opts.onEvent({
            kind: 'tool',
            tool: { name: block.name, detail: toolDetail(block.name, block.input) }
          });
        } else if (block.type === 'text' && block.text) {
          // Full text block — used when partial streaming isn't available.
          opts.onEvent({ kind: 'text', text: block.text });
          out.finalText = block.text;
        }
      }
      break;
    }

    case 'user': {
      // tool results coming back
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          opts.onEvent({ kind: 'tool-result' });
        }
      }
      break;
    }

    case 'result': {
      if (typeof msg.result === 'string' && msg.result.trim()) {
        out.finalText = msg.result;
      }
      if (msg.is_error) {
        opts.onEvent({ kind: 'error', text: msg.result ?? 'claude reported an error' });
      }
      break;
    }
  }
  return out;
}

function toolDetail(name: string, input: any): string | undefined {
  if (!input) return undefined;
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return input.file_path;
    case 'Grep':
      return input.pattern;
    case 'Glob':
      return input.pattern;
    case 'Bash':
      return typeof input.command === 'string' ? input.command.slice(0, 80) : undefined;
    case 'Skill':
      return input.skill ?? input.command;
    case 'WebSearch':
      return input.query;
    case 'WebFetch':
      return input.url;
    default:
      return undefined;
  }
}
