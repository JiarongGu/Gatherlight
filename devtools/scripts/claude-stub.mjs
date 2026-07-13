#!/usr/bin/env node
// claude CLI stub for e2e — speaks just enough stream-json for the two-gate flow.
// Invoked by the server via GATHERLIGHT_CLAUDE_CMD="node devtools/scripts/claude-stub.mjs".
// cwd = the data root (like the real CLI), so file writes land in the fixture data folder.
//
// Behavior by flags + prompt content:
//   read-only (Edit in --disallowedTools):
//     prompt contains "SLOW"            -> sleep 8s first (cancel-flow testing)
//     prompt contains "HUMAN'S FEEDBACK" -> revised plan text
//     else                              -> plan text
//   execute (--permission-mode acceptEdits):
//     physically writes plans/daily/2026-07-14.md + emits the Edit tool_use for it
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const readOnly = args.includes('--disallowedTools') && args.includes('Edit');

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString('utf8');

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const sessionId = `stub-${Date.now().toString(36)}`;

emit({ type: 'system', subtype: 'init', session_id: sessionId });

if (prompt.includes('SLOW')) {
  await new Promise((r) => setTimeout(r, 8000));
}

// 系统模式 (UI editing) is distinguished by the system prompt; it writes to src/client.
const systemMode = prompt.includes('系统模式') || prompt.includes('src/client');
const usage = { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 };
const done = (text) =>
  emit({ type: 'result', result: text, usage, total_cost_usd: 0.012 });

if (readOnly) {
  // Surface whether the server pre-routed discovery (e2e asserts the marker).
  const routed = prompt.includes('SERVER PRE-ROUTING') ? '[pre-routed]' : '[full-gate]';
  // Echo a token planted in a cortex prompt override back into the plan text, so an e2e can prove
  // a runtime override actually reached the spawned CLI (harmless when the token is absent).
  const echo = (prompt.match(/CORTEX_ECHO:(\S+)/) ?? [])[1];
  const echoTag = echo ? ` [echo:${echo}]` : '';
  const text = systemMode
    ? `## UI 改动计划(stub)\n\n- **Files to change** — src/client/src/stub-touch.txt`
    : prompt.includes("HUMAN'S FEEDBACK")
      ? `## 修订后的计划(stub)${routed}${echoTag}\n\n1. **What the user asked** — 修订版\n2. **Files to change** — plans/daily/2026-07-14.md`
      : `## 计划(stub)${routed}${echoTag}\n\n1. **What the user asked** — 新建明日计划\n2. **Files to change** — plans/daily/2026-07-14.md\n4. **Open questions** — none`;
  emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  done(text);
} else {
  const rel = systemMode ? 'src/client/src/stub-touch.txt' : 'plans/daily/2026-07-14.md';
  const abs = path.resolve(process.cwd(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const marker = prompt.includes("HUMAN'S FEEDBACK") ? 'revised-by-stub' : 'written-by-stub';
  // system-mode content varies per process so consecutive sessions produce a real diff.
  fs.writeFileSync(abs, systemMode ? `stub UI edit ${marker} ${process.pid}\n` : `# 2026-07-14 计划(fixture)\n\n- ${marker}\n`, 'utf8');
  emit({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: abs } }] },
  });
  emit({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
  done(systemMode ? `已修改 ${rel}(stub)` : `已按计划创建 ${rel}(stub)`);
}
