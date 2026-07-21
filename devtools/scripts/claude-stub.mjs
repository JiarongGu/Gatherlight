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
// Write (execute) runs add `--permission-mode acceptEdits` (Lyntai's ClaudeAgentArgs); read-only (plan)
// runs never do. This is the robust signal — the disallowed-tools list is now a single comma-joined arg.
const readOnly = !(args.includes('--permission-mode') && args.includes('acceptEdits'));

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

// FORCE_ERROR: emit an empty result so the server's plan phase treats it as "no content produced" →
// Fail() → records the failed turn to chat_turn. Used by e2e-p25 (error-continuity memory). Guarded by
// "no prior failure yet" so the FOLLOW-UP chat (whose thread context echoes the original FORCE_ERROR
// message but ALSO carries the 未完成 marker) proceeds normally instead of re-failing.
if (prompt.includes('FORCE_ERROR') && !prompt.includes('未完成(出错)')) {
  done('');
  process.exit(0);
}

// LLM scorer judge (Modules/Scoring): return a canned {score, reason} verdict JSON so the automated
// scorers produce a deterministic result under the stub.
if (prompt.includes('SCORING TASK')) {
  const verdict = JSON.stringify({ score: 0.8, reason: 'stub judge verdict' });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: verdict }] } });
  done(verdict);
  process.exit(0);
}

if (readOnly) {
  // Surface whether the server pre-routed discovery (e2e asserts the marker).
  const routed = prompt.includes('SERVER PRE-ROUTING') ? '[pre-routed]' : '[full-gate]';
  // Echo a token planted in a cortex prompt override back into the plan text, so an e2e can prove
  // a runtime override actually reached the spawned CLI (harmless when the token is absent).
  const echo = (prompt.match(/CORTEX_ECHO:(\S+)/) ?? [])[1];
  const echoTag = echo ? ` [echo:${echo}]` : '';
  // Prove the prior failed turn reached this run's thread context (e2e-p25 error-continuity memory).
  const priorFail = prompt.includes('未完成(出错)') ? ' [saw-prior-failure]' : '';
  const text = systemMode
    ? `## UI 改动计划(stub)\n\n- **Files to change** — src/client/src/stub-touch.txt`
    : prompt.includes("HUMAN'S FEEDBACK")
      ? `## 修订后的计划(stub)${routed}${echoTag}${priorFail}\n\n1. **What the user asked** — 修订版\n2. **Files to change** — plans/daily/2026-07-14.md`
      : `## 计划(stub)${routed}${echoTag}${priorFail}\n\n1. **What the user asked** — 新建明日计划\n2. **Files to change** — plans/daily/2026-07-14.md\n4. **Open questions** — none`;
  // Carry an e2e trigger token from the user's request into the PLAN text, so it survives into the
  // execute-phase prompt ({approvedPlan}) — that's how p28 drives the phantom-path / needs-input paths.
  // Read the token from the CURRENT request only (after "THE USER'S REQUEST:"), not the whole prompt —
  // the thread-context block echoes PRIOR turns' messages, which would otherwise mis-trigger a follow-up.
  const userReq = prompt.includes("THE USER'S REQUEST:") ? prompt.split("THE USER'S REQUEST:").pop() : prompt;
  const trig = userReq.includes('PHANTOMTEST') ? ' [TRIG:PHANTOM]'
    : userReq.includes('NEEDINPUTPLAINTEST') ? ' [TRIG:NEEDINPUTPLAIN]'
    : userReq.includes('NEEDINPUTTEST') ? ' [TRIG:NEEDINPUT]'
    : userReq.includes('NOOPTEST') ? ' [TRIG:NOOP]' : '';
  const planText = systemMode ? text : text + trig;
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: planText }] } });
  done(planText);
} else {
  // NEEDS_INPUT pause (e2e-p28): on the FIRST execute the plan carries [TRIG:NEEDINPUT] → ask for a
  // decision and write NOTHING. On the resume the prompt is the revise template ("HUMAN'S FEEDBACK",
  // no trigger tag) → fall through to the normal write. That models "agent paused → human replied".
  if (prompt.includes('[TRIG:NEEDINPUT]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('先完成前面几项。\n\nNEEDS_INPUT: 是否也要修改 .claude/mcp.json?\nOPTION: 是,一起改\nOPTION: 否,保持不变');
    process.exit(0);
  }
  // NOOP (e2e-p28): make NO change and ask nothing → empty diff → the flow ends 'rejected'. A pure
  // no-op must NOT park at awaiting-input holding the lease.
  if (prompt.includes('[TRIG:NOOP]')) {
    done('这一步不需要改动任何文件(stub)。');
    process.exit(0);
  }
  // NEEDS_INPUT with NO options (e2e-p28): a free-text question → awaiting-input with options=[], so the
  // prompt must say "在下方输入框回复", NOT "选择一个选项".
  if (prompt.includes('[TRIG:NEEDINPUTPLAIN]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('需要你确认一下。\n\nNEEDS_INPUT: 请问接下来想怎么处理?');
    process.exit(0);
  }
  // Phantom-path (e2e-p28): emit a Write tool_use for a file we DON'T create (announced-but-unwritten),
  // alongside a real file — the server must drop the phantom from the diff + commit (no `git add` 128).
  if (prompt.includes('[TRIG:PHANTOM]')) {
    const realAbs = path.resolve(process.cwd(), 'plans/daily/2026-07-15.md');
    fs.mkdirSync(path.dirname(realAbs), { recursive: true });
    fs.writeFileSync(realAbs, `# 2026-07-15 计划(fixture)\n\n- written-by-stub ${process.pid}\n`, 'utf8');
    const ghostAbs = path.resolve(process.cwd(), '.claude/skills/ghost/SKILL.md'); // never written to disk
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: realAbs } }] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: ghostAbs } }] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
    done('已创建 plans/daily/2026-07-15.md;另有一个文件未落地(stub 幻影路径)');
    process.exit(0);
  }
  const rel = systemMode ? 'src/client/src/stub-touch.txt' : 'plans/daily/2026-07-14.md';
  const abs = path.resolve(process.cwd(), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const marker = prompt.includes("HUMAN'S FEEDBACK") ? 'revised-by-stub' : 'written-by-stub';
  // An optional JOBMARK:<tok> in the prompt varies the written content so two background-job runs
  // (e2e-p26) produce DISTINCT diffs against the same file. Absent → original content (p2 unaffected).
  const jobmark = (prompt.match(/JOBMARK:(\S+)/) ?? [])[1];
  const tag = jobmark ? ` ${jobmark}` : '';
  // system-mode content varies per process so consecutive sessions produce a real diff.
  fs.writeFileSync(abs, systemMode ? `stub UI edit ${marker} ${process.pid}\n` : `# 2026-07-14 计划(fixture)\n\n- ${marker}${tag}\n`, 'utf8');
  emit({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: abs } }] },
  });
  emit({ type: 'user', message: { content: [{ type: 'tool_result' }] } });
  done(systemMode ? `已修改 ${rel}(stub)` : `已按计划创建 ${rel}(stub)`);
}
