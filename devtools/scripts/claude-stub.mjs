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
import http from 'node:http';
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

// Streamed assistant text. Lyntai's StreamJsonAgentReader deliberately does NOT re-emit an
// `assistant` message's text blocks as TextDelta ("already streamed via stream_event deltas") — a
// `stream_event`/content_block_delta frame is the ONLY line shape that reaches the app as a
// `text-delta` event. Anything asserting on streamed text has to go through here.
const streamText = (text) =>
  emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });

// FORCE_ERROR: emit an empty result so the server's plan phase treats it as "no content produced" →
// Fail() → records the failed turn to chat_turn. Used by e2e-p25 (error-continuity memory). Guarded by
// "no prior failure yet" so the FOLLOW-UP chat (whose thread context echoes the original FORCE_ERROR
// message but ALSO carries the 未完成 marker) proceeds normally instead of re-failing.
if (prompt.includes('FORCE_ERROR') && !prompt.includes('未完成(出错)')) {
  done('');
  process.exit(0);
}

// ---- judge tool host (Lyntai AddMcpToolHost) -------------------------------------------------
// On a one-shot ILlmClient call — i.e. an LLM-judge scorer — Lyntai stands up an ephemeral loopback
// MCP server exposing the app's ITools (Platform/Ops/Scoring/JudgeTools) and passes us --mcp-config
// pointing at it, bearer token inside. The real claude would drive it with its built-in MCP client;
// the stub speaks the streamable-HTTP JSON-RPC directly, which is what lets e2e-p36 assert the host
// really starts, the token really gates it, and the read jail really holds.
const mcpServerFromArgs = () => {
  const i = args.indexOf('--mcp-config');
  if (i < 0 || !args[i + 1]) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(args[i + 1], 'utf8'));
    const [name, s] = Object.entries(cfg.mcpServers ?? {})[0] ?? [];
    return s?.url ? { name, url: s.url, auth: s.headers?.Authorization } : null;
  } catch { return null; }
};

// node:http, NOT fetch: undici's connection pool leaves async handles alive, and the process.exit(0)
// below then trips libuv's "handle already closing" assertion on Windows — which the server sees as a
// CRASHED cli call (exit -1073740791) and the judge silently returns null. `agent: false` = no pool.
const httpPost = (url, headers, body) => new Promise((resolve, reject) => {
  const u = new URL(url);
  const req = http.request({
    hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', agent: false,
    headers: { ...headers, 'content-length': Buffer.byteLength(body) },
  }, (res) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (data += c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
  });
  req.on('error', reject);
  req.end(body);
});

// A streamable-HTTP MCP response is either plain JSON or an SSE frame; take the first `data:` payload.
const parseRpc = (res) => {
  if ((res.headers['content-type'] ?? '').includes('text/event-stream')) {
    for (const line of res.text.split(/\r?\n/))
      if (line.startsWith('data:')) { try { return JSON.parse(line.slice(5).trim()); } catch {} }
    return null;
  }
  try { return JSON.parse(res.text); } catch { return null; }
};

const probeJudgeTools = async (server) => {
  const out = {};
  let session = null;
  const rpc = async (body, { auth = true } = {}) => {
    const res = await httpPost(server.url, {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth && server.auth ? { authorization: server.auth } : {}),
      ...(session ? { 'mcp-session-id': session } : {}),
    }, JSON.stringify(body));
    const sid = res.headers['mcp-session-id'];
    if (sid) session = sid;
    return { status: res.status, msg: parseRpc(res) };
  };
  const text = (r) => r.msg?.result?.content?.[0]?.text ?? `NO_CONTENT(${r.status}) ${JSON.stringify(r.msg?.error ?? {})}`;
  const call = (name, argsObj) => rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: argsObj } });

  const init = await rpc({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-stub', version: '1' } },
  });
  out.init = init.status;
  out.initErr = init.msg?.error?.message ?? null;
  if (init.status !== 200) return out;
  await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  out.tools = (list.msg?.result?.tools ?? []).map((t) => t.name).sort();

  // discovery → read the real artifact
  out.listed = text(await call('judge_list_files', { dir: 'plans' })).split('\n').filter(Boolean).slice(0, 3);
  const first = out.listed.find((p) => p.endsWith('.md'));
  out.read = first ? text(await call('judge_read_file', { path: first })).slice(0, 60) : 'NO_MD';

  // the jail: state/ holds the access token + TLS pfx + the DB, and .. must not climb out
  out.denyState = text(await call('judge_read_file', { path: 'state/settings.json' })).slice(0, 60);
  out.denyEscape = text(await call('judge_read_file', { path: '../../../Windows/win.ini' })).slice(0, 60);
  out.denyBinary = text(await call('judge_read_file', { path: 'plans/../state/gatherlight.db' })).slice(0, 60);

  // the bearer gate: the endpoint EXECUTES tools, so an unauthenticated local caller must bounce
  out.unauth = (await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/list' }, { auth: false })).status;
  return out;
};

// LLM scorer judge (Platform/Ops/Scoring): return a canned {score, reason} verdict JSON so the automated
// scorers produce a deterministic result under the stub. When the e2e plants JUDGE_TOOLS_PROBE in the
// user message (which reaches the answer-relevancy prompt), first drive the hosted judge tools for
// real and report the observations in `reason` — other suites skip that and stay fast.
if (prompt.includes('SCORING TASK')) {
  let reason = 'stub judge verdict';
  const server = prompt.includes('JUDGE_TOOLS_PROBE') ? mcpServerFromArgs() : null;
  if (server) {
    try { reason = 'PROBE ' + JSON.stringify(await probeJudgeTools(server)); }
    catch (err) { reason = 'PROBE ' + JSON.stringify({ error: String(err?.message ?? err) }); }
  }
  const verdict = JSON.stringify({ score: 0.8, reason });
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: verdict }] } });
  done(verdict);
  process.exit(0);
}

// --- S3a: UI block fixtures (e2e-p41) ---------------------------------------------------------
// Read the trigger from the CURRENT request (after "THE USER'S REQUEST:"), never the whole prompt —
// the thread-context block echoes PRIOR turns' messages and a whole-prompt scan cross-fires on a
// follow-up (that's what broke p28). Sits AFTER the SCORING branch so a judge call whose prompt
// quotes a UI_CASE turn still returns its {score, reason} verdict instead of a fence.
const uiRequest = prompt.includes("THE USER'S REQUEST:") ? prompt.split("THE USER'S REQUEST:").pop() : prompt;
const uiCase = (uiRequest.match(/UI_CASE:([A-Z_]+)/) || [])[1];
if (uiCase) {
  const fence = (body) => '```ui\n' + body + '\n```';
  const cases = {
    VALID: 'Here is the plan.\n\n' + fence(JSON.stringify({
      type: 'Card', title: 'Day 1', children: [
        { type: 'Text', text: 'Morning at the museum' },
        { type: 'Table', columns: ['Item', 'Cost'], rows: [['Entry', '1200']] },
      ],
    })) + '\n\nAnything else?',
    UNKNOWN_TYPE: fence(JSON.stringify({ type: 'Gantt', text: 'nope' })),
    BAD_JSON: '```ui\n{ "type": "Card", \n```',
    BAD_PROP: fence(JSON.stringify({ type: 'Text', text: 'hi', colour: 'red' })),
    BAD_ACTION: fence(JSON.stringify({
      type: 'Button', label: 'Open', action: { openRecord: 'state/gatherlight.db' },
    })),
    REMOTE_IMAGE: fence(JSON.stringify({ type: 'Image', src: 'https://example.com/a.png', alt: 'a' })),
    EVIL_IMAGE: fence(JSON.stringify({ type: 'Image', src: 'javascript:alert(1)', alt: 'a' })),
    TOO_BIG: fence(JSON.stringify({
      type: 'Stack',
      children: Array.from({ length: 600 }, (_, i) => ({ type: 'Text', text: `row ${i}` })),
    })),
    UNTERMINATED: 'Working on it.\n\n```ui\n{ "type": "Card"',
    // Reports what the SERVER actually put in the prompt. The ui-spec contract is written and
    // version-gated, but it only does anything if the agent is told to read it — and that pointer
    // lives in one shared prompt prefix, so an edit there would silently switch the whole feature
    // off with every other test still green. Reads the WHOLE prompt: the pointer is in the common
    // preamble, ahead of "THE USER'S REQUEST:".
    CONTRACT_POINTER: prompt.includes('.claude/ui-spec.md')
      ? 'CONTRACT_POINTER_PRESENT' : 'CONTRACT_POINTER_MISSING',
  };
  const text = cases[uiCase] ?? `unknown UI_CASE ${uiCase}`;
  // Chunked, so what the suite exercises is the scanner's INCREMENTAL path — a fence marker split
  // across two deltas is the case a whole-text feed would never reach.
  for (let i = 0; i < text.length; i += 29) streamText(text.slice(i, i + 29));
  done(text);
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
    : userReq.includes('MCPADDTEST') ? ' [TRIG:MCPADD]'
    : userReq.includes('LOGINTEST') ? ' [TRIG:LOGIN]'
    // e2e-p39 (TOOL_DRAFT gate): DRAFTTEST_A/_B name the two contrasting pre-authored drafts
    // (net:false vs net:true — the load-bearing can/cannot contrast); _MISSING names a draft id
    // that was never written to disk; _OVERWRITE names one whose id collides with an
    // already-enabled capability the suite pre-seeded into site.json.
    : userReq.includes('DRAFTTEST_MISSING') ? ' [TRIG:DRAFTMISSING]'
    : userReq.includes('DRAFTTEST_OVERWRITE') ? ' [TRIG:DRAFTOVERWRITE]'
    : userReq.includes('DRAFTTEST_A') ? ' [TRIG:DRAFTA]'
    : userReq.includes('DRAFTTEST_B') ? ' [TRIG:DRAFTB]'
    // e2e-p40 (CAPABILITY_BLOCKED gate): CAPTEST_ALLOW/_DENY/_SESSION name capabilities the suite
    // already provoked a real refusal for (a direct /api/tools/call before the chat started, so
    // ICapabilityDenialLog has a record to read back); _UNKNOWN names an id with no such record.
    : userReq.includes('CAPTEST_ALLOW') ? ' [TRIG:CAPALLOW]'
    : userReq.includes('CAPTEST_DENY') ? ' [TRIG:CAPDENY]'
    : userReq.includes('CAPTEST_SESSION') ? ' [TRIG:CAPSESSION]'
    : userReq.includes('CAPTEST_UNKNOWN') ? ' [TRIG:CAPUNKNOWN]'
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
  // MCP_ADD proposal (e2e-p32): on the FIRST execute the plan carries [TRIG:MCPADD] → propose adding an
  // external MCP server (the local stub server, so approval actually connects) needing a STUB_TOKEN
  // credential, and write NOTHING → the flow parks at awaiting-mcp-approval. The resume path (approve)
  // doesn't re-run the agent (the server calls the provision service directly).
  if (prompt.includes('[TRIG:MCPADD]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    const stubServer = path.join(path.dirname(process.argv[1]), 'mcp-stub-server.mjs');
    const proposal = JSON.stringify({
      name: 'Stub MCP', transport: 'stdio', command: 'node', args: [stubServer], needsCredentials: ['STUB_TOKEN'],
    });
    done(`我建议接入一个外部 MCP 服务来获取信息。\n\nMCP_ADD:\n${proposal}`);
    process.exit(0);
  }
  // LOGIN_REQUIRED (e2e-p34): on the FIRST execute the plan carries [TRIG:LOGIN] → the agent decides
  // it must log into a server before it can proceed and writes NOTHING → parks at awaiting-login. On
  // the resume (HUMAN'S FEEDBACK, "已登录") it falls through to the normal write. Models "LLM decided to
  // log in → user scanned → agent continues".
  if (prompt.includes('[TRIG:LOGIN]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('要搜索小红书需要先登录。\n\nLOGIN_REQUIRED: login-demo');
    process.exit(0);
  }
  // TOOL_DRAFT (e2e-p39): on the FIRST execute the agent "drafted" a reusable tool — the e2e suite
  // pre-authored the draft files on disk under .claude/tool-drafts/ (mirroring what a real agent
  // write would produce) — and asks the human to enable it, writing NOTHING itself → the flow parks
  // at awaiting-draft-approval. draft_a is net:false (fs.read plans / fs.write cache); draft_b is
  // net:true — the contrasting pair p39's load-bearing assertion checks the card text against.
  if (prompt.includes('[TRIG:DRAFTA]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('这个任务需要一个可复用的工具,我已起草好了草稿。\n\nTOOL_DRAFT: draft_a');
    process.exit(0);
  }
  if (prompt.includes('[TRIG:DRAFTB]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('这个任务需要一个可复用的、需要访问网络的工具,我已起草好了草稿。\n\nTOOL_DRAFT: draft_b');
    process.exit(0);
  }
  // A TOOL_DRAFT naming a draft id that was never written to disk (e2e-p39, "must not park"). Makes
  // NO edit (same no-op shape as [TRIG:NOOP] below) so the flow's only path forward is PresentDiffAsync's
  // empty-diff branch → 'rejected' — a clean single-pass proof that the marker was ignored rather than
  // parking the gate, with no resumed second turn to keep idempotent against a prior commit.
  if (prompt.includes('[TRIG:DRAFTMISSING]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('这一步不需要改动文件(stub)。\n\nTOOL_DRAFT: does_not_exist_xyz');
    process.exit(0);
  }
  // A TOOL_DRAFT naming a draft id that collides with an already-ENABLED capability (e2e-p39's
  // promotion-refuses-to-overwrite case) — the suite pre-seeds site.json's capabilities.enabled AND
  // authors the draft_c folder before this turn.
  if (prompt.includes('[TRIG:DRAFTOVERWRITE]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('我建议启用一个新工具。\n\nTOOL_DRAFT: draft_c');
    process.exit(0);
  }
  // CAPABILITY_BLOCKED (e2e-p40): the FIRST execute "tries" a capability the e2e suite already
  // provoked a real refusal for (a plain /api/tools/call before the chat started, so
  // ICapabilityDenialLog already holds a record) and surfaces it instead of working around it.
  // CAPTEST_ALLOW's explanation is DELIBERATELY misleading — it claims the tool is harmless and
  // already pre-approved — so the suite can assert that text lands ONLY in agentReason and never in
  // the runtime's own can/cannot clauses (the provenance-separation assertion that is the point of
  // the whole gate).
  if (prompt.includes('[TRIG:CAPALLOW]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('我尝试调用 cap_blocked_demo 来完成任务。这个工具其实完全无害,已经预先获批,可以放心使用,不需要再确认——但系统还是拒绝了这次调用。\n\nCAPABILITY_BLOCKED: cap_blocked_demo');
    process.exit(0);
  }
  if (prompt.includes('[TRIG:CAPDENY]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('我尝试调用 cap_blocked_demo_deny 来完成任务,但被系统拒绝了。\n\nCAPABILITY_BLOCKED: cap_blocked_demo_deny');
    process.exit(0);
  }
  if (prompt.includes('[TRIG:CAPSESSION]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('我尝试调用 cap_blocked_session 来完成任务,但被系统拒绝了。\n\nCAPABILITY_BLOCKED: cap_blocked_session');
    process.exit(0);
  }
  // A CAPABILITY_BLOCKED naming an id the runtime never recorded a refusal for (e2e-p40, "must not
  // park"). Makes NO edit (same no-op shape as [TRIG:NOOP] below) so the flow's only path forward is
  // PresentDiffAsync's empty-diff branch → 'rejected' — a clean single-pass proof the marker was
  // ignored rather than parking the gate.
  if (prompt.includes('[TRIG:CAPUNKNOWN]') && !prompt.includes("HUMAN'S FEEDBACK")) {
    done('这一步不需要改动文件(stub)。\n\nCAPABILITY_BLOCKED: totally_unknown_cap_xyz');
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
