#!/usr/bin/env node
/**
 * PreToolUse scope guard for the chat console's headless claude runs.
 *
 * Registered in settings.chat.json. Reads the hook payload on stdin and DENIES:
 *   - Edit/Write/MultiEdit/NotebookEdit whose target path is outside the
 *     allow-list (plans/, household/, .claude/).
 *   - Bash commands that would commit / mutate git history or destroy files
 *     (the BACKEND owns commits, only after human diff approval).
 *
 * Anything else: stay silent (exit 0) so the normal acceptEdits flow proceeds.
 *
 * Deny contract (current Claude Code hook API):
 *   { "hookSpecificOutput": { "hookEventName": "PreToolUse",
 *       "permissionDecision": "deny", "permissionDecisionReason": "..." } }
 */
import path from 'node:path';

// Writable roots depend on the chat mode (CHAT_SCOPE, set by the backend).
//   plan (default) → user content + 智库
//   system         → ONLY the frontend code (the agent iterating the UI)
const SCOPE = process.env.CHAT_SCOPE === 'system' ? 'system' : 'plan';
const ALLOWED_DIRS =
  SCOPE === 'system'
    ? ['viewer/frontend', '.claude/dev'] // UI code + its own knowledge set
    : ['plans', 'household', '.claude'];

// Bash patterns that must never run from the chat agent — commits + history
// mutation are the backend's job; the rest are destructive.
const FORBIDDEN_BASH = [
  /\bgit\s+commit\b/,
  /\bgit\s+add\b/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+restore\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+stash\b/,
  /\bgit\s+rm\b/,
  /\brm\s+-[rf]/,
  /\bRemove-Item\b/i
];

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    })
  );
  process.exit(0);
}

function allowSilently() {
  process.exit(0);
}

function isInsideAllowed(relPath) {
  const norm = relPath.split(path.sep).join('/').replace(/^\.\//, '');
  return ALLOWED_DIRS.some(
    (dir) => norm === dir || norm.startsWith(dir + '/')
  );
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw || '{}');
} catch {
  // Can't parse → don't block (fail open for non-targeted tools), but log.
  process.stderr.write('[scope-guard] could not parse hook payload\n');
  allowSilently();
}

const toolName = payload.tool_name ?? '';
const toolInput = payload.tool_input ?? {};
const projectDir = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

if (toolName === 'Bash') {
  const command = String(toolInput.command ?? '');
  const hit = FORBIDDEN_BASH.find((re) => re.test(command));
  if (hit) {
    deny(
      `Blocked: the chat agent may not run git-history / destructive commands ` +
        `(matched ${hit}). The backend commits only after you approve the diff.`
    );
  }
  // System mode: force clean discovery via Read/Glob/Grep — no filesystem crawling.
  if (SCOPE === 'system') {
    const CRAWL = [/(^|[\s;&|(])dir(\s|$)/i, /(^|[\s;&|(])find\s/, /(^|[\s;&|(])ls\s+-[a-zA-Z]*[Rr]/];
    if (CRAWL.some((re) => re.test(command))) {
      deny(
        `Blocked: use the Read / Glob / Grep tools to find code — not Bash filesystem ` +
          `crawling (dir / find / ls -R). Glob a pattern like "viewer/frontend/src/**/*.tsx".`
      );
    }
  }
  allowSilently();
}

if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
  const filePath =
    toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path ?? '';
  if (!filePath) allowSilently();

  const abs = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(projectDir, filePath);
  const rel = path.relative(projectDir, abs);

  // Escapes the repo root entirely (../) → deny.
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    deny(`Blocked: ${filePath} is outside the repo.`);
  }
  if (!isInsideAllowed(rel)) {
    deny(
      `Blocked: in ${SCOPE} mode the chat agent may only edit ${ALLOWED_DIRS.join(', ')} — ` +
        `not "${rel.split(path.sep).join('/')}".`
    );
  }
  allowSilently();
}

allowSilently();
