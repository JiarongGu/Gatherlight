#!/usr/bin/env node
// e2e P53 — a reranker's DEVICE is measured on this machine, not guessed from the device list.
//
// docs/judge-bench.md Run 8b found this laptop's integrated GPU 3–5× SLOWER than its CPU for both rerankers, and
// `--list-devices` prints an integrated GPU exactly like a discrete one. So at a router start the app performs, every
// installed reranker without a current measurement is timed on the CPU and on every listed device, ONE AT A TIME, and the
// preset names the fastest (RerankDeviceMeter). This suite drives that through the measurement-only seam
// GATHERLIGHT_LLAMA_MEASURE_CMD — a fake llama-server (devtools/scripts/fake-llama-measure.mjs) that answers in time
// proportional to the pair tokens it is sent, per (model, device) — while the provisioned "binary" is a copy of Windows'
// more.com answering `--version` and `--list-devices` from planted files (p51's trick), so the key is the real one.
//
//   A  the choice: three devices timed one at a time, each launched with the reranker's own launch keys and a port the
//      OS picked; the fastest is named in the preset (`device = Vulkan1`), `n-gpu-layers` still beside it, and nothing
//      else gets a device key; the measurement persisted, its device list stripped of the free-memory figures; the row
//      says where it runs and that it was measured here
//   A2 validity: a device that scores 3 of 4 documents is excluded however fast, one that never answers is cut at the cap
//      and its process killed, and a model with no valid device keeps no device key
//   B  the key: the same start again measures nothing; a device list whose FREE MEMORY moved measures nothing; a device
//      list whose DEVICES changed re-measures — here the dGPU hidden, as GGML_VK_VISIBLE_DEVICES does; so does a changed
//      model file and a changed build
//   C  the recommendation flip: BGE measured too slow for the default page's one-window call on every device here → 资源
//      recommends mMiniLMv2 beside the installed BGE, saying why; fast enough → nothing (one reranker is enough)
//   D  a CPU section: `device = none` beside `n-gpu-layers = 99` (harmless — verified on the real binary, see
//      LlamaServerRuntime.LaunchKeys); a declared window (mMiniLMv2, 512) is the window it is measured under
//   E  the pace seed: a server BOUND to BGE, measured slow here, skips at once a recall the GPU figure would have sent;
//      the control — the same fixture whose measurement found no valid device — sends it
//
// NOT DRIVEN (stated in RerankDeviceMeter and dev-conventions): Dispose killing a measurement child — this harness stops
// a server with TerminateProcess, which skips Dispose.
import fs from 'node:fs';
import path from 'node:path';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, until, repo } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p53');
const PORT = 5437;
const PACE_PORT = 5438;
const CONTROL_PORT = 5439;

const BGE = 'bge-reranker-v2-m3-Q5_K_M';
const LAMAR = 'LAMAR-600m.Q5_K_M';
const MMINILM = 'mmarco-mMiniLMv2-L12-H384-v1-Q8_0';
const EMBEDDER = 'embeddinggemma-300M-Q8_0';
const FAKE = `node ${path.join(repo, 'devtools', 'scripts', 'fake-llama-measure.mjs')}`;
// Every cap at 8 s, so the device that never answers costs 8 s rather than 30.
const CAP_SECONDS = '8';

const TWO_GPUS = 'Available devices:\r\n  Vulkan0: zzfake iGPU (16384 MiB, 15000 MiB free)\r\n  Vulkan1: zzfake dGPU (8192 MiB, 7000 MiB free)\r\n';
const TWO_GPUS_OTHER_FREE = 'Available devices:\r\n  Vulkan0: zzfake iGPU (16384 MiB, 9123 MiB free)\r\n  Vulkan1: zzfake dGPU (8192 MiB, 1234 MiB free)\r\n';
const IGPU_ONLY = 'Available devices:\r\n  Vulkan0: zzfake iGPU (16384 MiB, 15000 MiB free)\r\n';
const VERSION = (build) => `version: 0.1.2-dev (build ${build}, commit b2e5e9b28)\r\nbuilt with Clang 20.1.8 for Windows x86_64\r\n`;

/** A data folder whose provisioned llama-server answers --version and --list-devices, with the given GGUFs planted. */
const plant = (suffix, models, settings) => {
  const dir = dataDirFor(`p53${suffix}`);
  fs.rmSync(dir, { recursive: true, force: true });
  if (settings) makeTestData(dir); else fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const res = path.join(dir, 'state', 'resources');
  const exeDir = path.join(res, 'llama-cpp');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.mkdirSync(path.join(res, 'gguf'), { recursive: true });
  fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'more.com'), path.join(exeDir, 'llama-server.exe'));
  for (const m of models) fs.writeFileSync(path.join(res, 'gguf', `${m}.gguf`), 'x');
  if (settings) fs.writeFileSync(path.join(dir, 'state', 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  return { dir, res, exe: path.join(exeDir, 'llama-server.exe'), gguf: path.join(res, 'gguf'), cfg: path.join(dir, 'fake-config.json'),
    log: path.join(dir, 'fake-measure.jsonl') };
};

/** The binary's answers — and a new file time, because the runtime memoises them on the binary's identity. */
let stamp = Math.floor(Date.now() / 1000) - 100_000;
const answer = (f, { devices, build = '10549' }) => {
  fs.writeFileSync(path.join(path.dirname(f.exe), '--list-devices'), devices);
  fs.writeFileSync(path.join(path.dirname(f.exe), '--version'), VERSION(build));
  stamp += 10;
  fs.utimesSync(f.exe, stamp, stamp);
};
const configure = (f, rates) => fs.writeFileSync(f.cfg, JSON.stringify({ log: f.log, rates }, null, 2));
const events = (f) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sectionOf = (preset, id) => ((preset.split(`[${id}]`)[1] ?? '').split('[')[0]);
const readPreset = (f) => { const p = path.join(f.gguf, 'presets.ini'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
const readStore = (f) => { const p = path.join(f.gguf, 'rerank-devices.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const entryOf = (f, model) => (readStore(f)?.measurements ?? []).find((m) => m.model === model) ?? null;

const servers = [];
try {
  // =============================================================================================================
  const f = plant('', [BGE, LAMAR, EMBEDDER]);
  answer(f, { devices: TWO_GPUS });
  // BGE: the dGPU fastest. LAMAR: the CPU the only VALID device — the dGPU answers at once but scores 3 of 4, the iGPU
  // never answers. The embedder is never measured: only rerankers are.
  configure(f, {
    [BGE]: { none: 0.4, Vulkan0: 1.0, Vulkan1: 0.05 },
    [LAMAR]: { none: 0.05, Vulkan0: 'hang', Vulkan1: 'partial' },
  });
  const srv = startServer({
    dataDir: f.dir, port: PORT,
    env: { GATHERLIGHT_LLAMA_MEASURE_CMD: FAKE, FAKE_LLAMA_MEASURE_CONFIG: f.cfg, GATHERLIGHT_RERANK_MEASURE_CAP_SECONDS: CAP_SECONDS },
  });
  servers.push(srv);
  await waitHealthy(srv.base);
  const { getJson, post } = makeClient(srv.base);
  // The runtime memoises the binary's answers on its first FULL probe; 资源's refresh is that probe.
  await getJson('/api/manage/models/llama?refresh=true');

  // ---- A · the choice --------------------------------------------------------------------------------------------
  const t0 = Date.now();
  const start1 = await post('/api/manage/models/llama/start');   // the router (more.com) exits; the measurement came first
  const ev1 = events(f);
  const starts1 = ev1.filter((e) => e.event === 'start');
  const bgeStarts = starts1.filter((e) => e.model === BGE);
  ok('(fixture) the start measured before it tried the router — which, being more.com, did not come up',
    start1.status === 409 && starts1.length === 6, JSON.stringify({ status: start1.status, starts: starts1.map((e) => `${e.model}@${e.device}`) }));
  ok('THE POINT: BGE was timed on the CPU and on EVERY listed device, in that order — the device list says nothing about which is fast',
    JSON.stringify(bgeStarts.map((e) => e.device)) === JSON.stringify(['none', 'Vulkan0', 'Vulkan1']),
    JSON.stringify(bgeStarts.map((e) => e.device)));
  ok('…ONE AT A TIME: no measurement child started while another was alive',
    starts1.every((e) => e.overlap === false), JSON.stringify(starts1.map((e) => [e.device, e.overlap])));
  ok('…and one reranker after the other: every BGE start before every LAMAR start',
    Math.max(...bgeStarts.map((e) => e.at)) < Math.min(...starts1.filter((e) => e.model === LAMAR).map((e) => e.at)),
    JSON.stringify(starts1.map((e) => `${e.model}@${e.device}`)));
  ok('…only rerankers: the embedder was never launched to be measured', !starts1.some((e) => e.model === EMBEDDER),
    JSON.stringify(starts1.map((e) => e.model)));
  const argvOf = (e) => e.argv.join(' ');
  ok('THE POINT: each child got the reranker section\'s OWN launch keys — n-gpu-layers, reranking, the 4096 window — plus --device',
    bgeStarts.every((e) => /--n-gpu-layers 99/.test(argvOf(e)) && /--reranking(?! \S*\d)/.test(argvOf(e))
      && /--ctx-size 4096/.test(argvOf(e)) && /--batch-size 4096/.test(argvOf(e)) && /--ubatch-size 4096/.test(argvOf(e))
      && argvOf(e).includes(`--device ${e.device}`) && argvOf(e).includes(`${BGE}.gguf`) && /--host 127\.0\.0\.1/.test(argvOf(e))),
    JSON.stringify(bgeStarts.map(argvOf)));
  const ports = starts1.map((e) => e.port);
  ok('…on loopback ports the OS picked — never a fixed one: six starts, more than one port, none of them the router\'s',
    ports.every((p) => p > 0) && new Set(ports).size > 1 && !ports.includes(Number(new URL((await getJson('/api/manage/models/llama')).baseUrl).port)),
    JSON.stringify(ports));
  const bgeCalls = ev1.filter((e) => e.event === 'rerank' && e.model === BGE);
  ok('…each timed on the SAME fixed batch, warmed with it first: two calls per device, four documents, one question',
    bgeCalls.length === 6 && bgeCalls.every((c) => c.documents === 4 && c.query === bgeCalls[0].query)
      && /浇水/.test(bgeCalls[0].query ?? '') && /watered/.test(bgeCalls[0].query ?? ''),
    JSON.stringify(bgeCalls.map((c) => [c.device, c.documents, Math.round(c.pairTokens)])));
  ok('…and every measurement child is gone', starts1.every((e) => !alive(e.pid)),
    JSON.stringify(starts1.filter((e) => alive(e.pid)).map((e) => e.pid)));

  const preset1 = readPreset(f);
  ok('THE POINT: the preset names BGE\'s FASTEST device — the dGPU, listed second — and keeps n-gpu-layers beside it',
    /^device\s*=\s*Vulkan1\s*$/m.test(sectionOf(preset1, BGE)) && /^n-gpu-layers\s*=\s*99\s*$/m.test(sectionOf(preset1, BGE))
      && (sectionOf(preset1, BGE).match(/^device/gm) ?? []).length === 1,
    JSON.stringify(sectionOf(preset1, BGE)));
  ok('…and the embedder, never measured, gets no device key — llama.cpp chooses for it as it always did',
    !/device/.test(sectionOf(preset1, EMBEDDER)), JSON.stringify({ embed: sectionOf(preset1, EMBEDDER) }));

  const bgeEntry = entryOf(f, BGE);
  ok('THE POINT: the measurement is PERSISTED in the models directory, keyed by the build and a device list without its free-memory figures',
    bgeEntry?.build === 'b10549' && JSON.stringify(bgeEntry?.devices) === JSON.stringify(['Vulkan0: zzfake iGPU', 'Vulkan1: zzfake dGPU'])
      && bgeEntry?.modelBytes === 1 && bgeEntry?.results?.length === 3,
    JSON.stringify(bgeEntry ?? null));
  const rate = (e, d) => e?.results?.find((r) => r.device === d)?.msPerToken;
  ok('…each device\'s figure in the PACE\'s unit — ms per pair token, read back near the rate the fake was told',
    Math.abs(rate(bgeEntry, 'none') - 0.4) < 0.1 && Math.abs(rate(bgeEntry, 'Vulkan0') - 1.0) < 0.15 && rate(bgeEntry, 'Vulkan1') < 0.15,
    JSON.stringify(bgeEntry?.results ?? null));

  // ---- A2 · validity ---------------------------------------------------------------------------------------------
  const lamarEntry = entryOf(f, LAMAR);
  const lamarRes = Object.fromEntries((lamarEntry?.results ?? []).map((r) => [r.device, r]));
  ok('THE POINT: a device that scored 3 of 4 documents is EXCLUDED however fast it answered — a result counts only if every document came back scored',
    lamarRes.Vulkan1?.elapsedMs == null && /只给 4 段里的 3 段打了分/.test(lamarRes.Vulkan1?.error ?? ''),
    JSON.stringify(lamarRes.Vulkan1 ?? null));
  const hung = starts1.find((e) => e.model === LAMAR && e.device === 'Vulkan0');
  ok('THE POINT: a device that never answers is cut at the cap, excluded with the reason — and its process KILLED',
    /8 秒内没有打完分/.test(lamarRes.Vulkan0?.error ?? '') && hung && !alive(hung.pid),
    JSON.stringify({ result: lamarRes.Vulkan0 ?? null, alive: hung ? alive(hung.pid) : null }));
  ok('THE POINT: …so LAMAR runs on the CPU, its one VALID device — not on the device that answered fastest with 3 of 4',
    lamarRes.none?.elapsedMs > 0 && !lamarRes.none?.error && /^device\s*=\s*none\s*$/m.test(sectionOf(preset1, LAMAR)),
    JSON.stringify({ cpu: lamarRes.none ?? null, section: sectionOf(preset1, LAMAR) }));

  const shelf1 = await getJson('/api/manage/models');
  const rowOf = (shelf, id) => (shelf.models ?? []).find((m) => m.id === id);
  const bgeRow = rowOf(shelf1, BGE);
  ok('THE POINT: BGE\'s row says WHERE it runs and that the choice was MEASURED on this machine, with the figures',
    /在这台机器上实测过/.test(bgeRow?.device ?? '') && /让它在 zzfake dGPU 上运行/.test(bgeRow?.device ?? '')
      && /同一批 4 段/.test(bgeRow?.device ?? '') && /CPU \d+\.\d+ 秒/.test(bgeRow?.device ?? '')
      && /zzfake iGPU \d+\.\d+ 秒/.test(bgeRow?.device ?? '') && /b10549/.test(bgeRow?.device ?? '')
      && /嵌入模型和对话模型仍由 llama\.cpp 自己选/.test(bgeRow?.device ?? '') && /没有量过/.test(bgeRow?.device ?? ''),
    String(bgeRow?.device));
  ok('…the excluded devices are named with their reasons in LAMAR\'s row', /没有测出结果/.test(rowOf(shelf1, LAMAR)?.device ?? ''),
    String(rowOf(shelf1, LAMAR)?.device));
  ok('…and no other kind of row says anything about a device', rowOf(shelf1, EMBEDDER)?.device == null
    && (shelf1.models ?? []).filter((m) => !m.installed).every((m) => m.device == null),
    JSON.stringify((shelf1.models ?? []).map((m) => [m.id, !!m.device])));
  ok('THE POINT: BGE measured fast enough here, with an embedder in → no badge: one reranker is enough',
    shelf1.recommendation == null, JSON.stringify(shelf1.recommendation ?? null));
  ok('(timing) the whole first measurement took under a minute', Date.now() - t0 < 60_000, `${Date.now() - t0} ms`);

  // ---- B · the key -----------------------------------------------------------------------------------------------
  const before = events(f).filter((e) => e.event === 'start').length;
  await post('/api/manage/models/llama/start');
  ok('THE POINT: a second start with the same key measures NOTHING', events(f).filter((e) => e.event === 'start').length === before,
    `${events(f).filter((e) => e.event === 'start').length - before} new start(s)`);
  ok('…and the preset still names the measured device', /^device\s*=\s*Vulkan1\s*$/m.test(sectionOf(readPreset(f), BGE)),
    JSON.stringify(sectionOf(readPreset(f), BGE)));

  answer(f, { devices: TWO_GPUS_OTHER_FREE });
  const moved = await getJson('/api/manage/models/llama?refresh=true');
  await post('/api/manage/models/llama/start');
  ok('(non-vacuity) the binary answered the new list — the free-memory figures moved',
    JSON.stringify(moved.devices).includes('1234 MiB free'), JSON.stringify(moved.devices));
  ok('THE POINT: free memory MOVING is not a new key — nothing re-measured (keyed as printed, every boot would re-measure)',
    events(f).filter((e) => e.event === 'start').length === before,
    `${events(f).filter((e) => e.event === 'start').length - before} new start(s)`);

  // ---- C · the dGPU hidden: a new device list re-measures, and BGE is now too slow here ----------------------------
  answer(f, { devices: IGPU_ONLY });
  await getJson('/api/manage/models/llama?refresh=true');
  configure(f, {
    [BGE]: { none: 2.0, Vulkan0: 3.0 },
    [LAMAR]: { none: 0.05, Vulkan0: 0.3 },
  });
  const before2 = events(f).filter((e) => e.event === 'start').length;
  await post('/api/manage/models/llama/start');
  const starts2 = events(f).filter((e) => e.event === 'start').slice(before2);
  ok('THE POINT: a CHANGED device list (the dGPU hidden) re-measures every reranker, on the devices now listed',
    JSON.stringify(starts2.map((e) => `${e.model}@${e.device}`)) === JSON.stringify([`${BGE}@none`, `${BGE}@Vulkan0`, `${LAMAR}@none`, `${LAMAR}@Vulkan0`]),
    JSON.stringify(starts2.map((e) => `${e.model}@${e.device}`)));
  const preset2 = readPreset(f);
  ok('THE POINT (D): the iGPU measured SLOWER than the CPU, so BGE\'s section says `device = none` — with n-gpu-layers = 99 beside it',
    /^device\s*=\s*none\s*$/m.test(sectionOf(preset2, BGE)) && /^n-gpu-layers\s*=\s*99\s*$/m.test(sectionOf(preset2, BGE)),
    JSON.stringify(sectionOf(preset2, BGE)));
  ok('…and LAMAR, the CPU fastest too, likewise', /^device\s*=\s*none\s*$/m.test(sectionOf(preset2, LAMAR)),
    JSON.stringify(sectionOf(preset2, LAMAR)));

  const shelf2 = await getJson('/api/manage/models');
  const rec2 = shelf2.recommendation;
  ok('THE POINT: BGE measured too slow for the default page on EVERY device here → 资源 recommends mMiniLMv2, beside the installed BGE',
    rec2?.id === MMINILM && rowOf(shelf2, BGE)?.installed === true, JSON.stringify(rec2 ?? null));
  ok('…and its reason says why, from the measurement: the fastest device, its time, the 96 candidates, the 48 s limit, the skip',
    /BGE 在这台机器上实测过/.test(rec2?.reason ?? '') && /它最快的设备是 CPU/.test(rec2?.reason ?? '')
      && /96 条候选/.test(rec2?.reason ?? '') && /48\.0 秒上限/.test(rec2?.reason ?? '') && /跳过判断/.test(rec2?.reason ?? '')
      && /下载后应用下一次自己启动 llama\.cpp 时同样会测/.test(rec2?.reason ?? '') && /Claude CLI/.test(rec2?.reason ?? ''),
    String(rec2?.reason));
  ok('…and BGE\'s own row says a default recall of long facts would be skipped at this speed',
    /让它在 CPU 上运行/.test(rowOf(shelf2, BGE)?.device ?? '') && /跳过判断/.test(rowOf(shelf2, BGE)?.device ?? ''),
    String(rowOf(shelf2, BGE)?.device));

  // A changed MODEL FILE re-measures that model alone; a changed BUILD re-measures every one.
  configure(f, { [BGE]: { none: 0.05, Vulkan0: 0.3 }, [LAMAR]: { none: 0.05, Vulkan0: 0.3 } });
  fs.writeFileSync(path.join(f.gguf, `${BGE}.gguf`), 'xy');
  const before3 = events(f).filter((e) => e.event === 'start').length;
  await post('/api/manage/models/llama/start');
  const starts3 = events(f).filter((e) => e.event === 'start').slice(before3);
  ok('THE POINT: a changed MODEL FILE re-measures that model and no other',
    starts3.length === 2 && starts3.every((e) => e.model === BGE), JSON.stringify(starts3.map((e) => `${e.model}@${e.device}`)));
  ok('…and BGE, fast again, is no longer too slow — the badge goes back to nothing', (await getJson('/api/manage/models')).recommendation == null,
    JSON.stringify((await getJson('/api/manage/models')).recommendation ?? null));
  answer(f, { devices: IGPU_ONLY, build: '10550' });
  await getJson('/api/manage/models/llama?refresh=true');
  const before4 = events(f).filter((e) => e.event === 'start').length;
  await post('/api/manage/models/llama/start');
  const starts4 = events(f).filter((e) => e.event === 'start').slice(before4);
  ok('THE POINT: a changed llama.cpp BUILD re-measures every reranker', starts4.length === 4 && entryOf(f, BGE)?.build === 'b10550',
    JSON.stringify({ starts: starts4.map((e) => `${e.model}@${e.device}`), build: entryOf(f, BGE)?.build }));

  // ---- D · a declared window, and a device whose process exits ---------------------------------------------------
  fs.writeFileSync(path.join(f.gguf, `${MMINILM}.gguf`), 'x');
  configure(f, { [MMINILM]: { none: 0.05, Vulkan0: 'exit' } });
  const before5 = events(f).filter((e) => e.event === 'start').length;
  await post('/api/manage/models/llama/start');
  const starts5 = events(f).filter((e) => e.event === 'start').slice(before5);
  ok('THE POINT: a newly installed reranker is measured, and it alone — the others are current',
    starts5.length === 2 && starts5.every((e) => e.model === MMINILM), JSON.stringify(starts5.map((e) => `${e.model}@${e.device}`)));
  ok('…under ITS declared window — 512, the one the preset launches it with',
    starts5.every((e) => /--ctx-size 512/.test(e.argv.join(' ')) && /--ubatch-size 512/.test(e.argv.join(' '))),
    JSON.stringify(starts5.map((e) => e.argv.join(' '))));
  const mmRes = Object.fromEntries((entryOf(f, MMINILM)?.results ?? []).map((r) => [r.device, r]));
  ok('…a device whose process EXITS before it answers is excluded with its exit code',
    /退出码 3/.test(mmRes.Vulkan0?.error ?? '') && mmRes.Vulkan0?.elapsedMs == null, JSON.stringify(mmRes.Vulkan0 ?? null));
  ok('…and the CPU, valid, is named in its section', /^device\s*=\s*none\s*$/m.test(sectionOf(readPreset(f), MMINILM)),
    JSON.stringify(sectionOf(readPreset(f), MMINILM)));
  ok('(control) with mMiniLMv2 installed there is nothing to recommend', (await getJson('/api/manage/models')).recommendation == null,
    JSON.stringify((await getJson('/api/manage/models')).recommendation ?? null));
  srv.stop();

  // ---- E · the pace starts from the measurement --------------------------------------------------------------------
  // Two servers BOUND to BGE, a 3-second verification deadline (the knob): a sized call has 1.5 s and a one-window call may
  // be predicted up to 2.4 s. Four notes of ~1,000 characters make a one-window call of ~2,200 pair tokens: at the GPU
  // figure (~0.05 ms per pair token) ~0.16 s — sent; at this machine's measured ~1.2 ms per pair token ~2.7 s — skipped at once.
  // The router never comes up (more.com), so a SENT call fails, fail-open; the SKIP is decided before any call.
  const bound = { memory: { judgeSource: 'llama-cpp', judgeModel: BGE } };
  const notes = [1, 2, 3, 4].map((i) => `zzpace${i}head 社区花园每周三和周六早上七点浇水,轮值表贴在工具棚门口。`
    + '堆肥箱在东边围栏旁,只放果皮和落叶,借用的铁锹请在天黑前放回原处。'.repeat(28) + ` zzpace${i}tail`);
  const runPace = async (suffix, port, rates) => {
    const g = plant(suffix, [BGE], bound);
    answer(g, { devices: IGPU_ONLY });
    configure(g, { [BGE]: rates });
    const s = startServer({
      dataDir: g.dir, port,
      env: { GATHERLIGHT_LLAMA_MEASURE_CMD: FAKE, FAKE_LLAMA_MEASURE_CONFIG: g.cfg, GATHERLIGHT_RERANK_MEASURE_CAP_SECONDS: CAP_SECONDS,
        GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '3' },
    });
    servers.push(s);
    await waitHealthy(s.base);
    const c = makeClient(s.base);
    for (const [i, note] of notes.entries()) {
      const wrote = await c.call('remember_fact', { kind: 'household', topic: `zzpace${i + 1}topic 社区花园`, content: note,
        source: 'https://example.test/zzpace', confidence: 0.8 });
      if (!(wrote.status === 200 && wrote.result?.ok === true)) throw new Error(`remember_fact failed: ${JSON.stringify(wrote.result)}`);
    }
    const t = Date.now();
    const r = await c.call('recall_facts', { query: 'zzpacequery 社区花园什么时候浇水', limit: 4 });
    const ms = Date.now() - t;
    // Not fatal when it never appears: the assertions below then say which half is missing.
    await until(async () => /the rerank pace starts from/.test(s.log() + readLogs(g.dir)), 30000).catch(() => {});
    return { g, s, r, ms, log: () => s.log() + readLogs(g.dir) };
  };
  const readLogs = (dir) => {
    const d = path.join(dir, 'state', 'logs');
    return fs.existsSync(d) ? fs.readdirSync(d).map((x) => fs.readFileSync(path.join(d, x), 'utf8')).join('\n') : '';
  };

  const slow = await runPace('-pace', PACE_PORT, { none: 1.2, Vulkan0: 2.0 });
  const slowEntry = entryOf(slow.g, BGE);
  ok('(fixture) the bound server measured BGE at boot, behind the migration overlay — the CPU fastest',
    slowEntry?.results?.find((r) => r.device === 'none')?.elapsedMs > 0 && /^device\s*=\s*none\s*$/m.test(sectionOf(readPreset(slow.g), BGE)),
    JSON.stringify(slowEntry?.results ?? null));
  const seedLine = slow.log().split(/\r?\n/).find((l) => /the rerank pace starts from/.test(l)) ?? '';
  ok('THE POINT: the pace STARTS from this machine\'s measurement on the device BGE runs on — not the GPU figure',
    /this machine's measurement on none \(CPU\)/.test(seedLine) && /starts from 1[0-9]{3}(\.\d+)? ms per 1,000 pair tokens/.test(seedLine),
    seedLine);
  const skipLine = slow.log().split(/\r?\n/).find((l) => /the judge is skipped for this recall/.test(l)) ?? '';
  ok('THE POINT: …so the first recall of long notes is SKIPPED at once, at that rate — where the GPU figure would have sent it',
    slow.r.status === 200 && /at the 1[0-9]{3}(\.\d+)? ms per 1,000 pair tokens measured here/.test(skipLine) && slow.ms < 2500,
    JSON.stringify({ status: slow.r.status, ms: slow.ms, skipLine }));
  slow.s.stop();

  // The control: the same fixture, but no device gave a valid result, so there is no seed.
  const ctl = await runPace('-control', CONTROL_PORT, { none: 'partial', Vulkan0: 'partial' });
  const ctlSeed = ctl.log().split(/\r?\n/).find((l) => /the rerank pace starts from/.test(l)) ?? '';
  ok('(control) with no valid measurement the pace starts from the GPU figure, and says why',
    /starts from the GPU figure/.test(ctlSeed) && /found no device that scored the batch/.test(ctlSeed), ctlSeed);
  ok('(control) …and the same recall is NOT skipped — sent, at the GPU figure', ctl.r.status === 200
    && !/the judge is skipped for this recall/.test(ctl.log()),
    JSON.stringify({ status: ctl.r.status, skipped: /the judge is skipped for this recall/.test(ctl.log()) }));
  ok('(control) …and its preset names no device', !/device/.test(sectionOf(readPreset(ctl.g), BGE)),
    JSON.stringify(sectionOf(readPreset(ctl.g), BGE)));
  ctl.s.stop();
} catch (err) {
  fail('e2e-p53 fatal: ' + err.message);
  for (const s of servers) console.error(s.log().slice(-3000));
} finally {
  for (const s of servers) { try { s.stop(); } catch { /* best effort */ } }
}
done();
