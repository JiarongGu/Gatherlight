#!/usr/bin/env node
// e2e P53 — a reranker's DEVICE is measured on this machine, not guessed from the device list.
//
// The device measurement found this laptop's integrated GPU SLOWER than its CPU for both rerankers (within each run BGE
// 2.7–2.9×, mMiniLMv2 6.0–6.7×; docs/judge-bench.md Run 8b, an unread run, pointed the same way), and
// `--list-devices` prints an integrated GPU exactly like a discrete one. So at a router start the app performs, every
// installed reranker without a current measurement is timed on the CPU and on every listed device, ONE AT A TIME, and the
// preset names the fastest (RerankDeviceMeter). This suite drives that through the measurement-only seam
// GATHERLIGHT_LLAMA_MEASURE_CMD — a fake llama-server (devtools/scripts/fake-llama-measure.mjs) that answers in time
// proportional to the pair tokens it is sent, per (model, device) — while the provisioned "binary" is a copy of Windows'
// more.com answering `--version` and `--list-devices` from planted files (p51's trick), so the key is the real one.
//
//   A  the choice: three devices timed one at a time, each launched with the reranker's own launch keys and a port the
//      OS picked, warmed and timed on DIFFERENT documents of one size; the fastest is named in the preset (`device =
//      Vulkan1`), `n-gpu-layers` still beside it, and nothing else gets a device key; the measurement persisted, its
//      device list stripped of the free-memory figures; the row says where it runs and that it was measured here; and
//      no child inherited LLAMA_API_KEY, a launch argument by environment or the router's child switch from the server,
//      while logging and device selection still reach it (ChildEnvironment.ForLlamaServer)
//   A2 validity: a device that scores 3 of 4 documents is excluded however fast, one that never answers is cut at the cap
//      and its process killed — and while those exclusions have retries left, NO device key: llama.cpp chooses until the
//      measurement is complete, and the row says so and why
//   B  retries: at the next start ONLY the excluded devices are measured again, valid results kept — a device valid now
//      is the fastest, pinned once the last retry is spent — and a device that keeps failing is tried MaxAttempts (3)
//      times and then left, the row saying which;
//      with the store unwritable meanwhile, the row and the next retry read the NEWER unsaved measurement, attempts still
//      advance, and the save is tried again at the next start; the start's answer names only what IT measured, even when
//      the start fails; a device list whose FREE MEMORY moved measures nothing
//   C  the key: a device list whose DEVICES changed re-measures (the dGPU hidden, as GGML_VK_VISIBLE_DEVICES does); so
//      do a changed model file and a changed build; and the recommendation flips: BGE measured too slow for the default
//      page's one-window call on every device → 资源 recommends mMiniLMv2 beside the installed BGE, saying why — but NOT
//      while a retry of an excluded device is still pending — and AHEAD of the embedder when none is installed
//   D  a CPU section: `device = none` beside `n-gpu-layers = 99` (harmless — verified on the real binary, see
//      LlamaServerRuntime.LaunchKeys); a declared window (mMiniLMv2, 512) is the window it is measured under; a
//      measurement that could not be SAVED is still what this process reads, the row says so, and the next start retries
//      from it, completes it and saves it; a stored measurement taken under another SHAPE (launch keys, batch, measurement
//      version) is measured again
//   E  the pace seed, counted at the ROUTER: a second life of a folder where BGE was measured slow adopts a fake router, and
//      a recall of long notes sends it NOTHING (skipped at the measured rate); the control — the same slow CPU, but a retry
//      of the iGPU PENDING, its speed unknown — sends it the call (the GPU seed) and names no device; and where every device
//      TIMED OUT (three starts), the pace starts from their lower bound and sends nothing. A never-measured reranker's row, beside a
//      router the app did not start, says it is not
//      measured while that router is not ours, and an excluded device's retry is promised only for the app's own start.
//      The overlay's step line showed the measurement's progress
//   F  the kill-on-close job: the app TerminateProcess'd while a measurement child is running — the child dies with it
//   H  a device still to be measured that TIMED OUT does not hold back the pin (its lower bound proves it slower): the
//      CPU is named at once, the row says why, and the device measured again takes over when it is faster
//   G  no device answers within the cap (a 3 s cap, both devices hang): each timed-out call leaves a LOWER BOUND; no verdict
//      while retries are pending; once they are spent the best lower bound fails the default page's admission, so BGE is
//      too slow here — the badge (no embedder installed: the repair outranks it) and the row say 「至少要」, and the preset
//      names no device. The measurement ran inside a BIND, whose refusal says where the time went (「启动 llama.cpp 前先测了…」);
//      a bind that measured nothing says nothing of the kind; and with one device excluded for ANOTHER reason (it exited),
//      its speed unknown, the lower bounds claim nothing
//
// CONFIRMED TO FAIL with their half removed (2026-09-26, each on a build of its own; devtools/_dm/mutate.mjs, scratch):
// no device key in LaunchKeys (22 assertions), the preset not given the devices (7), validity off — a partial reply
// counted (A2's, B's and E's control), the free-memory figures kept in the key (B's free-memory case and A's persisted
// list), the flip off (C's badge and reason), the seed not wired (E's count and seed line), devices measured in parallel
// (A's one-at-a-time), no kill (A's children-gone and A2's hang killed), the store ignored (B's re-measures), the key
// without devices / without the file / without the build (C's three), and — added with the retries — retries off (B's
// retry and the attempts after it), retries unbounded (B's attempts), the warm call sent byte for byte as the timed one (A's
// different documents), the save failure hidden (D's unsaved row), the adopted router ignored (E's row), no progress line
// (E's step line) and the job off (F); and with the re-review — the store read before the unsaved measurement in the lookup
// (B's row and B's third start) and in the retry (B's four), the flip while a retry is pending (C's two), the adopted
// clause ignored (E's retry row), the failed start's sentence dropped (A's and B's), one clause for all excluded devices in
// the lead (C's reason) and the save not retried (B's two); and with the final review — the device pinned while a retry is
// pending (A2's, B's, C's and D's no-key, E's control preset), the pace seeded while a retry is pending (E's control), the
// embedder ahead of the repair (C's no-embedder badge and G's; p52 6h's for the skips), no lower bound (G's verdict, reason
// and row), a lower-bound verdict while retries are pending (G's pending row), the lower bounds judged beside a device that
// exited (G's unknown-speed case), no shape in the key (D's shape), and the bind's measured clause dropped or the sink not
// threaded into EnsureServesAsync (G's bind, each); and with the re-review — the pace NOT starting from the lower bound
// when every device timed out (E's bound case: the recall sent), a timed-out device holding back the pin (H's), and no
// excluded device holding it back at all (ten assertions across A2, B, C, D and E's control).
//
// NOT DRIVEN: Dispose killing a measurement child (the harness stops a server with TerminateProcess, which skips Dispose
// — F drives the job, which covers that kill too); the router's port band refused when the OS offers it (the OS's port
// sequence cannot be positioned on demand — it walks in order here, and a run whose sequence reached the band excluded two
// devices with 20 tries, which is why the search now runs past the whole band; a later green run crossed it); a bind that
// SUCCEEDS after measuring (the fake router can only be adopted — G asserts the clause on a refused bind); a throw inside
// a retry keeping the stored device key (nothing in the measurement can be made to throw there); a start that waited behind ANOTHER caller's measurement not claiming it (the two cannot be interleaved on demand).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, until, repo } from './_e2e-common.mjs';

const { ok, fail, done } = makeReporter('p53');
const PORT = 5437;
const PACE_PORT = 5438;
const CONTROL_PORT = 5439;
const PACE2_PORT = 5440;
const CONTROL2_PORT = 5441;
const JOB_PORT = 5446;
const SLOWEST_PORT = 5447;
const BOUND_PORT = 5448;
const BOUND2_PORT = 5450;

const BGE = 'bge-reranker-v2-m3-Q5_K_M';
const LAMAR = 'LAMAR-600m.Q5_K_M';
const MMINILM = 'mmarco-mMiniLMv2-L12-H384-v1-Q8_0';
// What BGE measured too slow now recommends: 内置, the same model in process (docs/judge-bench.md Run 13) — it was the
// llama.cpp GGUF above until that run. Its one-clause comparison (BuiltInJudgeSource.CpuComparison), as the reason quotes it.
const BUILTIN_RERANK = 'mmarco-mMiniLMv2-L12-H384-v1-onnx';
const CPU_COMPARISON = '它判断得和 llama.cpp 上的同一个模型一样好,每次检索却快得多(短事实约 0.47 秒对 0.82 秒,长笔记约 8.1 秒对 20 秒';
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
const startsOf = (f) => events(f).filter((e) => e.event === 'start');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sectionOf = (preset, id) => ((preset.split(`[${id}]`)[1] ?? '').split('[')[0]);
const readPreset = (f) => { const p = path.join(f.gguf, 'presets.ini'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
const readStore = (f) => { const p = path.join(f.gguf, 'rerank-devices.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const entryOf = (f, model) => (readStore(f)?.measurements ?? []).find((m) => m.model === model) ?? null;
const resultsOf = (f, model) => Object.fromEntries((entryOf(f, model)?.results ?? []).map((r) => [r.device, r]));
const readLogs = (dir) => {
  const d = path.join(dir, 'state', 'logs');
  return fs.existsSync(d) ? fs.readdirSync(d).map((x) => fs.readFileSync(path.join(d, x), 'utf8')).join('\n') : '';
};
const env = (f, extra = {}) => ({
  GATHERLIGHT_LLAMA_MEASURE_CMD: FAKE, FAKE_LLAMA_MEASURE_CONFIG: f.cfg, GATHERLIGHT_RERANK_MEASURE_CAP_SECONDS: CAP_SECONDS, ...extra,
});

const servers = [];
let fakeRouter;
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
  // The server is started with llama.cpp variables a launcher's environment could carry (ChildEnvironment.ForLlamaServer):
  // an API key — measured on the real binary, the router then answers the app's own clients 401 — and a launch argument
  // by environment (a quantized KV cache nobody measured) and the router's internal child switch, all three of which
  // must not reach a llama-server the app launches; and the two it must keep, logging and the machine's device choice.
  const INHERITED_LLAMA = { LLAMA_API_KEY: 'zzp53-key', LLAMA_ARG_CACHE_TYPE_K: 'q4_0', LLAMA_SERVER_CHILD_MODE: '1',
    LLAMA_ARG_LOG_VERBOSITY: '3', GGML_VK_VISIBLE_DEVICES: '0,1,2' };
  const srv = startServer({ dataDir: f.dir, port: PORT, env: env(f, INHERITED_LLAMA) });
  servers.push(srv);
  await waitHealthy(srv.base);
  const { getJson, post } = makeClient(srv.base);
  const rowOf = (shelf, id) => (shelf.models ?? []).find((m) => m.id === id);
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
  ok('THE POINT: …and the FAILED start still says the time went on measuring, and on what — what THIS start measured',
    /^启动前先测了 bge-reranker-v2-m3-Q5_K_M、LAMAR-600m\.Q5_K_M 在哪个设备上最快\(用了 \d+\.\d+ 秒\),结果写在下面各自那一行。$/.test(start1.body?.measured ?? '')
      && String(start1.body?.error ?? '').endsWith(start1.body?.measured ?? '\u0000'),
    JSON.stringify(start1.body));
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
  const envOf = (e) => e.env ?? [];
  ok('THE POINT (environment): no measurement child inherited the API key, a launch argument or the child switch',
    starts1.length > 0 && starts1.every((e) => !['LLAMA_API_KEY', 'LLAMA_ARG_CACHE_TYPE_K', 'LLAMA_SERVER_CHILD_MODE']
      .some((n) => envOf(e).includes(n))), JSON.stringify(starts1.map(envOf)));
  ok('…while the logging keys and the device selection still reach it (narrowed, not wiped)',
    starts1.length > 0 && starts1.every((e) => envOf(e).includes('LLAMA_ARG_LOG_VERBOSITY') && envOf(e).includes('GGML_VK_VISIBLE_DEVICES')),
    JSON.stringify(starts1.map(envOf)));
  const argvOf = (e) => e.argv.join(' ');
  ok('THE POINT: each child got the reranker section\'s OWN launch keys — n-gpu-layers, reranking, the 4096 window — plus --device',
    bgeStarts.every((e) => /--n-gpu-layers 99/.test(argvOf(e)) && /--reranking(?! \S*\d)/.test(argvOf(e))
      && /--ctx-size 4096/.test(argvOf(e)) && /--batch-size 4096/.test(argvOf(e)) && /--ubatch-size 4096/.test(argvOf(e))
      && argvOf(e).includes(`--device ${e.device}`) && argvOf(e).includes(`${BGE}.gguf`) && /--host 127\.0\.0\.1/.test(argvOf(e))),
    JSON.stringify(bgeStarts.map(argvOf)));
  const ports = starts1.map((e) => e.port);
  const routerPort = Number(new URL((await getJson('/api/manage/models/llama')).baseUrl).port);
  ok('…on loopback ports the OS picked — never a fixed one: six starts, more than one port, none of them the router\'s',
    ports.every((p) => p > 0) && new Set(ports).size > 1 && !ports.includes(routerPort), JSON.stringify(ports));
  const bgeCalls = ev1.filter((e) => e.event === 'rerank' && e.model === BGE);
  const pairs = [0, 2, 4].map((i) => [bgeCalls[i], bgeCalls[i + 1]]);
  ok('…each warmed and then timed on the SAME-SIZED batch: two calls per device, four documents, one question, equal pair tokens',
    bgeCalls.length === 6 && bgeCalls.every((c) => c.documents === 4 && c.query === bgeCalls[0].query)
      && pairs.every(([w, t]) => w && t && w.pairTokens === t.pairTokens && w.characters === t.characters)
      && /浇水/.test(bgeCalls[0].query ?? '') && /watered/.test(bgeCalls[0].query ?? ''),
    JSON.stringify(bgeCalls.map((c) => [c.device, c.documents, Math.round(c.pairTokens)])));
  ok('THE POINT: …but DIFFERENT documents — the timed call is never the warm call byte for byte, which a prompt cache could answer',
    pairs.every(([w, t]) => w && t && w.head !== t.head), JSON.stringify(pairs.map(([w, t]) => [w?.head, t?.head])));
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
  const lamarRes = resultsOf(f, LAMAR);
  ok('THE POINT: a device that scored 3 of 4 documents is EXCLUDED however fast it answered — a result counts only if every document came back scored',
    lamarRes.Vulkan1?.elapsedMs == null && /只给 4 段里的 3 段打了分/.test(lamarRes.Vulkan1?.error ?? ''),
    JSON.stringify(lamarRes.Vulkan1 ?? null));
  const hung = starts1.find((e) => e.model === LAMAR && e.device === 'Vulkan0');
  ok('THE POINT: a device that never answers is cut at the cap, excluded with the reason — and its process KILLED',
    /8 秒内没有打完分/.test(lamarRes.Vulkan0?.error ?? '') && hung && !alive(hung.pid),
    JSON.stringify({ result: lamarRes.Vulkan0 ?? null, alive: hung ? alive(hung.pid) : null }));
  ok('THE POINT: LAMAR\'s one VALID device is the CPU — but both exclusions have retries LEFT, so its section names NO device yet: llama.cpp chooses until the measurement is complete (one busy GPU must not move a reranker to the CPU)',
    lamarRes.none?.elapsedMs > 0 && !lamarRes.none?.error && !/device/.test(sectionOf(preset1, LAMAR))
      && /^n-gpu-layers\s*=\s*99\s*$/m.test(sectionOf(preset1, LAMAR)) && /^reranking\s*=\s*true\s*$/m.test(sectionOf(preset1, LAMAR)),
    JSON.stringify({ cpu: lamarRes.none ?? null, section: sectionOf(preset1, LAMAR) }));

  const shelf1 = await getJson('/api/manage/models');
  const bgeNote = String(rowOf(shelf1, BGE)?.deviceNote ?? '');
  ok('THE POINT: BGE\'s row says WHERE it runs and that the choice was MEASURED on this machine, with the figures',
    /在这台机器上实测过/.test(bgeNote) && /所以应用启动 llama\.cpp 时让它在 zzfake dGPU 上运行/.test(bgeNote)
      && /同一批 4 段/.test(bgeNote) && /CPU \d+\.\d+ 秒/.test(bgeNote) && /zzfake iGPU \d+\.\d+ 秒/.test(bgeNote) && /b10549/.test(bgeNote)
      && /嵌入模型和对话模型仍由 llama\.cpp 自己选/.test(bgeNote) && /没有量过/.test(bgeNote),
    bgeNote);
  const lamarNote1 = String(rowOf(shelf1, LAMAR)?.deviceNote ?? '');
  ok('…LAMAR\'s names each excluded device, its reason and that it will be measured AGAIN — and says that until then llama.cpp chooses, and WHY: the device not yet measured could turn out faster',
    /zzfake iGPU 没有测出结果\(预热:8 秒内没有打完分;第 1 次\),应用下一次自己启动 llama\.cpp 时会再测/.test(lamarNote1)
      && /zzfake dGPU 没有测出结果\(预热:只给 4 段里的 3 段打了分;第 1 次\)/.test(lamarNote1)
      && lamarNote1.includes('测出结果的设备里目前最快的是 CPU,但还有设备没测完,所以测完之前仍由 llama.cpp 自己选设备:'
        + '没测完的设备重测时可能比 CPU 更快(一次没测出结果常常只是暂时的,比如当时正被别的程序占着),所以应用等它测完再定用哪个。')
      && !/让它在 CPU 上运行/.test(lamarNote1),
    lamarNote1);
  ok('…and no other kind of row says anything about a device', rowOf(shelf1, EMBEDDER)?.deviceNote == null
    && (shelf1.models ?? []).filter((m) => !m.installed).every((m) => m.deviceNote == null),
    JSON.stringify((shelf1.models ?? []).map((m) => [m.id, !!m.deviceNote])));
  ok('THE POINT: BGE measured fast enough here, with an embedder in → no badge: one reranker is enough',
    shelf1.recommendation == null, JSON.stringify(shelf1.recommendation ?? null));
  ok('(timing) the whole first measurement took under a minute', Date.now() - t0 < 60_000, `${Date.now() - t0} ms`);

  // ---- B · retries -------------------------------------------------------------------------------------------------
  // An exclusion is often TRANSIENT, so the next start measures the excluded devices again — ONLY those. Here the dGPU
  // has come good and the iGPU now exits at once (as a child that cannot bind or load does). And the store cannot be
  // WRITTEN meanwhile (a directory where it writes its temporary file): the merged measurement is what runs, and what the
  // row, the next retry and the save retried all read — never the OLDER one still stored under the same key.
  configure(f, {
    [BGE]: { none: 0.4, Vulkan0: 1.0, Vulkan1: 0.05 },
    [LAMAR]: { none: 0.05, Vulkan0: 'exit', Vulkan1: 0.02 },
  });
  const blocker = path.join(f.gguf, 'rerank-devices.json.tmp');
  fs.mkdirSync(blocker, { recursive: true });
  const b1 = startsOf(f).length;
  const start2 = await post('/api/manage/models/llama/start');
  const retry1 = startsOf(f).slice(b1);
  ok('THE POINT: the next start measures ONLY the devices excluded last time — LAMAR\'s iGPU and dGPU — never a valid result again',
    JSON.stringify(retry1.map((e) => `${e.model}@${e.device}`)) === JSON.stringify([`${LAMAR}@Vulkan0`, `${LAMAR}@Vulkan1`]),
    JSON.stringify(retry1.map((e) => `${e.model}@${e.device}`)));
  ok('…and its answer says it measured LAMAR — only what THIS start measured', /^启动前先测了 LAMAR-600m\.Q5_K_M 在哪个设备上最快/.test(start2.body?.measured ?? ''),
    JSON.stringify(start2.body?.measured ?? null));
  ok('(fixture) the merged measurement could not be saved — the store still holds the older one',
    resultsOf(f, LAMAR).Vulkan1?.elapsedMs == null && resultsOf(f, LAMAR).Vulkan1?.attempts === 1, JSON.stringify(entryOf(f, LAMAR)?.results));
  const lamarRowB1 = String(rowOf(await getJson('/api/manage/models'), LAMAR)?.deviceNote ?? '');
  ok('THE POINT: a device valid now is the fastest — but the iGPU\'s retry is still pending, so still NO device key — and the ROW shows that NEWER, unsaved measurement, not the older stored one',
    !/device/.test(sectionOf(readPreset(f), LAMAR))
      && /测出结果的设备里目前最快的是 zzfake dGPU,但还有设备没测完,所以测完之前仍由 llama\.cpp 自己选设备/.test(lamarRowB1)
      && /zzfake iGPU 没有测出结果\(进程在载入模型时退出了\(退出码 3\);第 2 次\),应用下一次自己启动 llama\.cpp 时会再测/.test(lamarRowB1)
      && /这次的结果没能保存:应用下一次自己启动 llama\.cpp 时会再试着保存;要是应用重启时还没保存上,重启后会重新测。/.test(lamarRowB1),
    lamarRowB1);
  const b2 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const retry2 = startsOf(f).slice(b2);
  const lamarRowB2 = String(rowOf(await getJson('/api/manage/models'), LAMAR)?.deviceNote ?? '');
  ok('THE POINT: the third start retries from the UNSAVED measurement — the iGPU a third time, and nothing else: attempts advance though nothing was saved',
    JSON.stringify(retry2.map((e) => `${e.model}@${e.device}`)) === JSON.stringify([`${LAMAR}@Vulkan0`])
      && /zzfake iGPU 3 次都没有测出结果/.test(lamarRowB2),
    JSON.stringify({ starts: retry2.map((e) => `${e.model}@${e.device}`) }));
  ok('THE POINT: …the measurement is now COMPLETE (the iGPU\'s attempts spent), so that start\'s preset PINS the fastest valid device — the dGPU — and the row says it runs there',
    /^device\s*=\s*Vulkan1\s*$/m.test(sectionOf(readPreset(f), LAMAR))
      && /测出结果的设备里最快的是 zzfake dGPU,所以应用启动 llama\.cpp 时让它在 zzfake dGPU 上运行/.test(lamarRowB2)
      && !/还有设备没测完/.test(lamarRowB2),
    JSON.stringify({ section: sectionOf(readPreset(f), LAMAR), row: lamarRowB2 }));
  fs.rmSync(blocker, { recursive: true, force: true });
  const b3 = startsOf(f).length;
  const start4 = await post('/api/manage/models/llama/start');
  ok('THE POINT: after 3 attempts the exclusion STANDS — the next start measures nothing, and says nothing about measuring',
    startsOf(f).length === b3 && start4.body?.measured == null, `${startsOf(f).length - b3} new start(s); ${JSON.stringify(start4.body?.measured ?? null)}`);
  const lamar3 = resultsOf(f, LAMAR);
  ok('…and the SAVE was tried again at that start: the store now holds the merged measurement',
    lamar3.Vulkan1?.elapsedMs > 0 && lamar3.Vulkan1?.attempts === 2 && lamar3.Vulkan0?.attempts === 3 && lamar3.none?.attempts === 1,
    JSON.stringify(entryOf(f, LAMAR)?.results));
  const lamarNote3 = String(rowOf(await getJson('/api/manage/models'), LAMAR)?.deviceNote ?? '');
  ok('…and LAMAR\'s row says so, naming what would measure it again — and that a driver update does not — with no 「没能保存」 left',
    /zzfake iGPU 3 次都没有测出结果\(最近一次:进程在载入模型时退出了\(退出码 3\)\),除非模型文件、llama\.cpp 版本、设备列表或应用的测法变了\(更新显卡驱动不算\),不会再测/.test(lamarNote3)
      && !/没能保存/.test(lamarNote3),
    lamarNote3);
  ok('…and the preset still names the measured devices', /^device\s*=\s*Vulkan1\s*$/m.test(sectionOf(readPreset(f), BGE))
    && /^device\s*=\s*Vulkan1\s*$/m.test(sectionOf(readPreset(f), LAMAR)),
    JSON.stringify({ bge: sectionOf(readPreset(f), BGE), lamar: sectionOf(readPreset(f), LAMAR) }));

  answer(f, { devices: TWO_GPUS_OTHER_FREE });
  const moved = await getJson('/api/manage/models/llama?refresh=true');
  const b4 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  ok('(non-vacuity) the binary answered the new list — the free-memory figures moved',
    JSON.stringify(moved.devices).includes('1234 MiB free'), JSON.stringify(moved.devices));
  ok('THE POINT: free memory MOVING is not a new key — nothing re-measured (keyed as printed, every boot would re-measure)',
    startsOf(f).length === b4, `${startsOf(f).length - b4} new start(s)`);

  // ---- C · the dGPU hidden: a new device list re-measures, and BGE is now too slow here ----------------------------
  // The iGPU EXITS: a retryable exclusion, so the badge must NOT flip yet — the next start's retry could still find a device
  // fast enough. It flips once the iGPU's attempts are spent, naming it with its own clause.
  answer(f, { devices: IGPU_ONLY });
  await getJson('/api/manage/models/llama?refresh=true');
  configure(f, {
    [BGE]: { none: 2.0, Vulkan0: 'exit' },
    [LAMAR]: { none: 0.05, Vulkan0: 0.3 },
  });
  const c1 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const starts2 = startsOf(f).slice(c1);
  ok('THE POINT: a CHANGED device list (the dGPU hidden) re-measures every reranker, on the devices now listed — its attempts afresh',
    JSON.stringify(starts2.map((e) => `${e.model}@${e.device}`)) === JSON.stringify([`${BGE}@none`, `${BGE}@Vulkan0`, `${LAMAR}@none`, `${LAMAR}@Vulkan0`])
      && Object.values(resultsOf(f, LAMAR)).every((r) => r.attempts === 1),
    JSON.stringify(starts2.map((e) => `${e.model}@${e.device}`)));
  ok('THE POINT: BGE too slow on the CPU, but a retry of the iGPU is PENDING → no flip yet (a busy GPU once must not recommend a download), and no device key',
    (await getJson('/api/manage/models')).recommendation == null && resultsOf(f, BGE).Vulkan0?.attempts === 1
      && !/device/.test(sectionOf(readPreset(f), BGE)),
    JSON.stringify({ rec: (await getJson('/api/manage/models')).recommendation ?? null, section: sectionOf(readPreset(f), BGE) }));
  await post('/api/manage/models/llama/start');
  ok('…still none after the second attempt', (await getJson('/api/manage/models')).recommendation == null && resultsOf(f, BGE).Vulkan0?.attempts === 2,
    JSON.stringify({ rec: (await getJson('/api/manage/models')).recommendation ?? null, vulkan0: resultsOf(f, BGE).Vulkan0 }));
  await post('/api/manage/models/llama/start');
  const shelf2 = await getJson('/api/manage/models');
  const rec2 = shelf2.recommendation;
  ok('THE POINT: attempts spent, no retry pending, BGE too slow for the default page on every device that gave a result → 资源 recommends 内置 (the in-process mMiniLMv2), beside the installed BGE',
    rec2?.id === BUILTIN_RERANK && rowOf(shelf2, BGE)?.installed === true && resultsOf(f, BGE).Vulkan0?.attempts === 3, JSON.stringify(rec2 ?? null));
  ok('…and its reason says why, from the measurement: the fastest device that gave a result, the excluded one with ITS clause, its time, 96 LONG candidates, the 48 s limit, the skip — and that short facts take far less',
    /BGE 在这台机器上实测过:测出结果的设备里最快的是 CPU\(没有测出结果的:zzfake iGPU 3 次都没有测出结果\(最近一次:进程在载入模型时退出了\(退出码 3\)\),除非模型文件、llama\.cpp 版本、设备列表或应用的测法变了\(更新显卡驱动不算\),不会再测\)/.test(rec2?.reason ?? '')
      && /96 条候选、每条都是长事实只读一段\(约 1,000 字\)/.test(rec2?.reason ?? '') && /48\.0 秒上限/.test(rec2?.reason ?? '')
      && /跳过判断\(事实短时花的时间少得多\)/.test(rec2?.reason ?? '') && !/时会再测/.test(rec2?.reason ?? '')
      && /所以推荐在应用进程里运行的「内置」mMiniLMv2:/.test(rec2?.reason ?? '') && (rec2?.reason ?? '').includes(CPU_COMPARISON)
      // BGE's fastest device here is the CPU, so Run 13's comparison applies as it stands: no integrated-GPU caveat.
      && !/没有量过/.test(rec2?.reason ?? '') && !/更小的重排模型/.test(rec2?.reason ?? '') && /Claude CLI/.test(rec2?.reason ?? ''),
    String(rec2?.reason));
  // An installed copy of the recommended model ends the suggestion — 内置's four files, planted (presence is what counts).
  const builtinDir = path.join(path.dirname(f.gguf), 'rerank-model');
  fs.mkdirSync(path.join(builtinDir, 'onnx'), { recursive: true });
  for (const x of ['onnx/model_qint8_avx512_vnni.onnx', 'tokenizer.json', 'config.json', 'tokenizer_config.json'])
    fs.writeFileSync(path.join(builtinDir, x), '');
  const shelfWithBuiltin = await getJson('/api/manage/models');
  fs.rmSync(builtinDir, { recursive: true, force: true });
  ok('…and with 内置 already on disk, BGE measured too slow recommends nothing — the repair never names what is installed',
    shelfWithBuiltin.recommendation == null && rowOf(shelfWithBuiltin, BUILTIN_RERANK)?.installed === true,
    JSON.stringify({ rec: shelfWithBuiltin.recommendation ?? null, builtin: rowOf(shelfWithBuiltin, BUILTIN_RERANK)?.installed }));
  ok('…and BGE\'s own row says a default recall of long facts would be skipped at this speed — and, the measurement complete, the preset pins the CPU',
    /让它在 CPU 上运行/.test(rowOf(shelf2, BGE)?.deviceNote ?? '') && /约要 \d+\.\d+ 秒/.test(rowOf(shelf2, BGE)?.deviceNote ?? '')
      && /跳过判断/.test(rowOf(shelf2, BGE)?.deviceNote ?? '') && /^device\s*=\s*none\s*$/m.test(sectionOf(readPreset(f), BGE)),
    String(rowOf(shelf2, BGE)?.deviceNote));
  // No embedder installed: the embedder suggestion used to come FIRST, so the household whose BGE measured too slow was
  // offered an embedder instead — while the reranker notes promised 资源 would recommend the smaller one.
  const embedderFile = path.join(f.gguf, `${EMBEDDER}.gguf`);
  fs.rmSync(embedderFile);
  const shelfNoEmbedder = await getJson('/api/manage/models');
  fs.writeFileSync(embedderFile, 'x');
  ok('THE POINT (final review): with NO embedder installed, BGE measured too slow still recommends 内置 — the repair outranks the embedder suggestion',
    rowOf(shelfNoEmbedder, EMBEDDER)?.installed === false && shelfNoEmbedder.recommendation?.id === BUILTIN_RERANK
      && /BGE 在这台机器上实测过/.test(shelfNoEmbedder.recommendation?.reason ?? ''),
    JSON.stringify({ embedder: rowOf(shelfNoEmbedder, EMBEDDER)?.installed, rec: shelfNoEmbedder.recommendation ?? null }));

  // A changed MODEL FILE re-measures that model alone; a changed BUILD re-measures every one.
  configure(f, { [BGE]: { none: 0.05, Vulkan0: 0.3 }, [LAMAR]: { none: 0.05, Vulkan0: 0.3 } });
  fs.writeFileSync(path.join(f.gguf, `${BGE}.gguf`), 'xy');
  const c2 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const starts3 = startsOf(f).slice(c2);
  ok('THE POINT: a changed MODEL FILE re-measures that model and no other',
    starts3.length === 2 && starts3.every((e) => e.model === BGE), JSON.stringify(starts3.map((e) => `${e.model}@${e.device}`)));
  ok('…and BGE, fast again, is no longer too slow — the badge goes back to nothing', (await getJson('/api/manage/models')).recommendation == null,
    JSON.stringify((await getJson('/api/manage/models')).recommendation ?? null));
  answer(f, { devices: IGPU_ONLY, build: '10550' });
  await getJson('/api/manage/models/llama?refresh=true');
  const c3 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const starts4 = startsOf(f).slice(c3);
  ok('THE POINT: a changed llama.cpp BUILD re-measures every reranker', starts4.length === 4 && entryOf(f, BGE)?.build === 'b10550',
    JSON.stringify({ starts: starts4.map((e) => `${e.model}@${e.device}`), build: entryOf(f, BGE)?.build }));
  const preset2 = readPreset(f);
  ok('THE POINT (D): the iGPU measured SLOWER than the CPU, so BGE\'s section says `device = none` — with n-gpu-layers = 99 beside it',
    resultsOf(f, BGE).Vulkan0?.elapsedMs > resultsOf(f, BGE).none?.elapsedMs
      && /^device\s*=\s*none\s*$/m.test(sectionOf(preset2, BGE)) && /^n-gpu-layers\s*=\s*99\s*$/m.test(sectionOf(preset2, BGE)),
    JSON.stringify({ results: entryOf(f, BGE)?.results, section: sectionOf(preset2, BGE) }));
  ok('…and LAMAR, the CPU fastest too, likewise', /^device\s*=\s*none\s*$/m.test(sectionOf(preset2, LAMAR)),
    JSON.stringify(sectionOf(preset2, LAMAR)));

  // ---- D · a declared window; a measurement that could not be SAVED ------------------------------------------------
  // The store cannot be written again (the same directory where it writes its temporary file).
  fs.mkdirSync(blocker, { recursive: true });
  fs.writeFileSync(path.join(f.gguf, `${MMINILM}.gguf`), 'x');
  configure(f, { [MMINILM]: { none: 0.05, Vulkan0: 'exit' } });
  const d1 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const starts5 = startsOf(f).slice(d1);
  ok('THE POINT: a newly installed reranker is measured, and it alone — the others are current',
    starts5.length === 2 && starts5.every((e) => e.model === MMINILM), JSON.stringify(starts5.map((e) => `${e.model}@${e.device}`)));
  ok('…under ITS declared window — 512, the one the preset launches it with',
    starts5.every((e) => /--ctx-size 512/.test(e.argv.join(' ')) && /--ubatch-size 512/.test(e.argv.join(' '))),
    JSON.stringify(starts5.map((e) => e.argv.join(' '))));
  ok('(fixture) its measurement could not be saved', entryOf(f, MMINILM) == null, JSON.stringify(entryOf(f, MMINILM)));
  const mmRow = String(rowOf(await getJson('/api/manage/models'), MMINILM)?.deviceNote ?? '');
  ok('THE POINT: …the unsaved measurement is what the row reads — the CPU the fastest so far, the iGPU\'s retry pending, so no device key yet — and it says the result was not saved, and what happens to it',
    !/device/.test(sectionOf(readPreset(f), MMINILM)) && /测出结果的设备里目前最快的是 CPU,但还有设备没测完/.test(mmRow)
      && /这次的结果没能保存:应用下一次自己启动 llama\.cpp 时会再试着保存;要是应用重启时还没保存上,重启后会重新测。/.test(mmRow),
    mmRow);
  ok('…a device whose process EXITS before it answers is excluded with its exit code', /zzfake iGPU 没有测出结果\(进程在载入模型时退出了\(退出码 3\);第 1 次\)/.test(mmRow),
    mmRow);
  fs.rmSync(blocker, { recursive: true, force: true });
  // The iGPU answers this time, slower than the CPU: the retry completes the measurement.
  configure(f, { [MMINILM]: { none: 0.05, Vulkan0: 0.3 } });
  const d2 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const starts6 = startsOf(f).slice(d2);
  ok('…and the next start retries from the UNSAVED measurement — the iGPU only — which completes it: the CPU pinned, and saved this time',
    JSON.stringify(starts6.map((e) => `${e.model}@${e.device}`)) === JSON.stringify([`${MMINILM}@Vulkan0`])
      && resultsOf(f, MMINILM).Vulkan0?.attempts === 2 && resultsOf(f, MMINILM).none?.elapsedMs > 0
      && /^device\s*=\s*none\s*$/m.test(sectionOf(readPreset(f), MMINILM)),
    JSON.stringify({ starts: starts6.map((e) => `${e.model}@${e.device}`), stored: entryOf(f, MMINILM)?.results }));
  ok('(control) with rerankers installed and BGE fast here, there is nothing to recommend', (await getJson('/api/manage/models')).recommendation == null,
    JSON.stringify((await getJson('/api/manage/models')).recommendation ?? null));

  // The SHAPE is in the key: the measurement version, the launch keys (hashed), the batch's documents and pair tokens.
  const mmEntry = entryOf(f, MMINILM);
  ok('THE POINT (final review): a measurement is stored with the SHAPE it was taken under — version, launch-key hash, 4 documents, the pair tokens',
    /^v1\|[0-9A-F]{16}\|4\|\d+(\.\d+)?$/.test(mmEntry?.shape ?? '') && Math.abs(Number(mmEntry.shape.split('|')[3]) - mmEntry.pairTokens) < 0.001
      && entryOf(f, BGE)?.shape !== mmEntry.shape,
    JSON.stringify({ mm: mmEntry?.shape, bge: entryOf(f, BGE)?.shape, pairTokens: mmEntry?.pairTokens }));
  // Edited as TEXT: a JSON round trip through a JS number would round the file's write ticks (past 2^53) and change every
  // entry's key.
  const storePath = path.join(f.gguf, 'rerank-devices.json');
  const storeText = fs.readFileSync(storePath, 'utf8');
  fs.writeFileSync(storePath, storeText.replace(`"shape": "${mmEntry.shape}"`, `"shape": "${mmEntry.shape.replace(/^v1\|/, 'v0|')}"`));
  ok('(fixture) the stored shape was edited', fs.readFileSync(storePath, 'utf8') !== storeText, storePath);
  const d3 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const starts7 = startsOf(f).slice(d3);
  ok('THE POINT: …and one taken under another shape is measured AGAIN — that model alone, on every device',
    JSON.stringify(starts7.map((e) => `${e.model}@${e.device}`)) === JSON.stringify([`${MMINILM}@none`, `${MMINILM}@Vulkan0`])
      && /^v1\|/.test(entryOf(f, MMINILM)?.shape ?? ''),
    JSON.stringify({ starts: starts7.map((e) => `${e.model}@${e.device}`), shape: entryOf(f, MMINILM)?.shape }));

  // ---- H · a device that TIMED OUT does not hold back the pin (re-review) --------------------------------------------
  // A new build re-measures everything. BGE's iGPU never answers within the 8 s cap — its lower bound (~5 ms per pair
  // token) already proves it slower than the CPU's 0.4 — so the CPU is pinned NOW, not after three starts of llama.cpp's
  // own choice (on an iGPU-only laptop, the iGPU). The iGPU is still measured again, and takes over when it is faster.
  answer(f, { devices: IGPU_ONLY, build: '10551' });
  await getJson('/api/manage/models/llama?refresh=true');
  configure(f, {
    [BGE]: { none: 0.4, Vulkan0: 'hang' },
    [LAMAR]: { none: 0.05, Vulkan0: 0.3 },
    [MMINILM]: { none: 0.05, Vulkan0: 0.3 },
  });
  await post('/api/manage/models/llama/start');
  const h1 = resultsOf(f, BGE);
  ok('(fixture) the new build re-measured BGE: the CPU valid, the iGPU timed out with a lower bound and a retry left',
    h1.none?.msPerToken > 0 && h1.Vulkan0?.elapsedMs == null && h1.Vulkan0?.lowerBoundMsPerToken > h1.none?.msPerToken
      && h1.Vulkan0?.attempts === 1,
    JSON.stringify(entryOf(f, BGE)?.results ?? null));
  const hRow = String(rowOf(await getJson('/api/manage/models'), BGE)?.deviceNote ?? '');
  ok('THE POINT (re-review): a device still to be measured that TIMED OUT does not hold back the pin — the CPU is named NOW, and the row says why it did not wait',
    /^device\s*=\s*none\s*$/m.test(sectionOf(readPreset(f), BGE))
      && hRow.includes('测出结果的设备里最快的是 CPU,所以应用启动 llama.cpp 时让它在 CPU 上运行。'
        + 'zzfake iGPU 在限定时间内没有打完,已经比 CPU 慢,所以不等重测就先定下来;重测时要是更快,就改用它。')
      && /zzfake iGPU 没有测出结果\(预热:8 秒内没有打完分;第 1 次\),应用下一次自己启动 llama\.cpp 时会再测/.test(hRow)
      && !/还有设备没测完/.test(hRow),
    JSON.stringify({ section: sectionOf(readPreset(f), BGE), row: hRow }));
  configure(f, {
    [BGE]: { none: 0.4, Vulkan0: 0.05 },
    [LAMAR]: { none: 0.05, Vulkan0: 0.3 },
    [MMINILM]: { none: 0.05, Vulkan0: 0.3 },
  });
  const h2 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const startsH = startsOf(f).slice(h2);
  ok('THE POINT: …it is still measured again — it alone — and, faster this time, it TAKES OVER',
    JSON.stringify(startsH.map((e) => `${e.model}@${e.device}`)) === JSON.stringify([`${BGE}@Vulkan0`])
      && /^device\s*=\s*Vulkan0\s*$/m.test(sectionOf(readPreset(f), BGE)) && resultsOf(f, BGE).Vulkan0?.attempts === 2,
    JSON.stringify({ starts: startsH.map((e) => `${e.model}@${e.device}`), section: sectionOf(readPreset(f), BGE) }));
  srv.stop();

  // ---- E · the pace starts from the measurement — counted at the router ----------------------------------------------
  // Each fixture lives TWICE. First life: bound to BGE, it measures BGE at boot (behind the overlay, whose step line is
  // polled) against more.com as the router, which never comes up, and writes four long notes. Second life, the same folder:
  // the router is a FAKE the app adopts (GATHERLIGHT_LLAMACPP_URL) — the full probe still runs the "binary", so the memo and
  // the key are the same, the measurement current, the seed read. A 3-second verification deadline (the knob): a one-window
  // call may be predicted up to 2.4 s. The four notes make a one-window call of ~3,300 pair tokens: at the GPU figure (~0.05
  // ms per pair token) ~0.2 s — sent; at the ~1.2 ms per pair token measured here ~3.9 s — skipped at once, nothing sent.
  // What decides is what ARRIVES at the router, never a line the app writes about itself.
  const bound = { memory: { judgeSource: 'llama-cpp', judgeModel: BGE } };
  const QUERY = 'zzpacequery 社区花园什么时候浇水';
  const notes = [1, 2, 3, 4].map((i) => `zzpace${i}head 社区花园每周三和周六早上七点浇水,轮值表贴在工具棚门口。`
    + '堆肥箱在东边围栏旁,只放果皮和落叶,借用的铁锹请在天黑前放回原处。'.repeat(28) + ` zzpace${i}tail`);
  const rerankHits = [];
  fakeRouter = http.createServer((req, res) => {
    const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/v1/models') return send({ object: 'list', data: [{ id: BGE }, { id: LAMAR }] });
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body); } catch { /* recorded raw */ }
      if (req.url === '/v1/rerank') {
        rerankHits.push({ query: String(json.query ?? ''), documents: (json.documents ?? []).length });
        const docs = Array.isArray(json.documents) ? json.documents : [];
        return send({ model: json.model, results: docs.map((_, index) => ({ index, relevance_score: 1 - index / 100 })) });
      }
      send({ id: 'p53', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'noted' } }] });
    });
  });
  await new Promise((r) => fakeRouter.listen(0, '127.0.0.1', r));
  const fakeUrl = `http://127.0.0.1:${fakeRouter.address().port}`;

  const runPace = async (suffix, port1, port2, rates, { extraStarts = 0, extraKnobs = {} } = {}) => {
    const g = plant(suffix, [BGE], bound);
    answer(g, { devices: IGPU_ONLY });
    configure(g, { [BGE]: rates });
    const knobs = { GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '3', ...extraKnobs };
    // Life 1: measure at boot; watch the overlay's step line while it does.
    const s1 = startServer({ dataDir: g.dir, port: port1, env: env(g, knobs) });
    servers.push(s1);
    const details = new Set();
    await until(async () => {
      try {
        const st = await (await fetch(`${s1.base}/api/migration/status`)).json();
        const d = (st.steps ?? []).find((x) => x.id === 'llama-warm')?.detail;
        if (d) details.add(d);
      } catch { /* not up yet */ }
      try { const h = await (await fetch(`${s1.base}/api/health`)).json(); return h.migrating === false; } catch { return false; }
    }, 180000, 100);
    const c1 = makeClient(s1.base);
    // More starts of the app's own, for a measurement whose excluded devices need their retries.
    for (let i = 0; i < extraStarts; i++) await c1.post('/api/manage/models/llama/start');
    for (const [i, note] of notes.entries()) {
      const wrote = await c1.call('remember_fact', { kind: 'household', topic: `zzpace${i + 1}topic 社区花园`, content: note,
        source: 'https://example.test/zzpace', confidence: 0.8 });
      if (!(wrote.status === 200 && wrote.result?.ok === true)) throw new Error(`remember_fact failed: ${JSON.stringify(wrote.result)}`);
    }
    s1.stop();
    // Life 2: the same folder, adopting the fake router — with a second reranker on disk that no start of OURS has seen,
    // so it has no measurement.
    fs.writeFileSync(path.join(g.gguf, `${LAMAR}.gguf`), 'x');
    const s2 = startServer({ dataDir: g.dir, port: port2, env: env(g, { ...knobs, GATHERLIGHT_LLAMACPP_URL: fakeUrl }) });
    servers.push(s2);
    await waitHealthy(s2.base);
    const c2 = makeClient(s2.base);
    const before = rerankHits.filter((h) => h.query.includes('zzpacequery')).length;
    const r = await c2.call('recall_facts', { query: QUERY, limit: 4 });
    const sent = rerankHits.filter((h) => h.query.includes('zzpacequery')).length - before;
    await until(async () => /the rerank pace starts from/.test(s2.log() + readLogs(g.dir)), 30000).catch(() => {});
    const shelf = await c2.getJson('/api/manage/models');
    return { g, s2, r, sent, details: [...details], shelf, log: () => s2.log() + readLogs(g.dir) };
  };

  const slow = await runPace('-pace', PACE_PORT, PACE2_PORT, { none: 1.2, Vulkan0: 2.0 });
  const slowEntry = entryOf(slow.g, BGE);
  ok('(fixture) the bound server measured BGE at boot, behind the migration overlay — the CPU fastest',
    slowEntry?.results?.find((r) => r.device === 'none')?.elapsedMs > 0 && /^device\s*=\s*none\s*$/m.test(sectionOf(readPreset(slow.g), BGE)),
    JSON.stringify(slowEntry?.results ?? null));
  ok('…and the overlay\'s step line said so while it ran — which reranker, which device of how many',
    slow.details.some((d) => /正在测重排模型 bge-reranker-v2-m3-Q5_K_M 在哪个设备上最快:第 [12]\/2 个/.test(d)),
    JSON.stringify(slow.details));
  ok('THE POINT: the recall of long notes SENT NOTHING to the router — skipped at the rate measured here, where the GPU figure would have sent it',
    slow.r.status === 200 && slow.sent === 0, JSON.stringify({ status: slow.r.status, sent: slow.sent }));
  const seedLine = slow.log().split(/\r?\n/).find((l) => /the rerank pace starts from/.test(l)) ?? '';
  ok('…and the log says where the pace started (secondary: the count above is the evidence)',
    /this machine's measurement on none \(CPU\)/.test(seedLine), seedLine);
  const lamarRow = String(rowOf(slow.shelf, LAMAR)?.deviceNote ?? '');
  ok('THE POINT: a never-measured reranker beside a router the app did NOT start says it is not measured while that router is not ours',
    /现在运行的 llama\.cpp 不是应用这次启动的,应用不会替它测;等应用自己启动 llama\.cpp 时才会测/.test(lamarRow)
      && !/应用下一次自己启动 llama\.cpp 时会测/.test(lamarRow),
    lamarRow);
  slow.s2.stop();

  // The control: the same slow CPU, but the iGPU EXITED once — a retry is pending, so the measurement is not complete: no
  // device key, and the pace starts from the GPU figure (final review).
  const ctl = await runPace('-control', CONTROL_PORT, CONTROL2_PORT, { none: 1.2, Vulkan0: 'exit' });
  ok('(fixture) the control measured the same slow CPU — and the iGPU exited, with a retry left',
    Math.abs((entryOf(ctl.g, BGE)?.results ?? []).find((r) => r.device === 'none')?.msPerToken - 1.2) < 0.15
      && (entryOf(ctl.g, BGE)?.results ?? []).find((r) => r.device === 'Vulkan0')?.attempts === 1,
    JSON.stringify(entryOf(ctl.g, BGE)?.results ?? null));
  ok('THE POINT (final review): while a retry is PENDING the pace starts from the GPU figure — the same recall IS sent to the router',
    ctl.r.status === 200 && ctl.sent >= 1, JSON.stringify({ status: ctl.r.status, sent: ctl.sent }));
  const ctlSeed = ctl.log().split(/\r?\n/).find((l) => /the rerank pace starts from/.test(l)) ?? '';
  ok('…and the log says why (secondary: the count above is the evidence)', /no device is pinned yet/.test(ctlSeed), ctlSeed);
  ok('THE POINT: …and its preset names no device — llama.cpp chooses until the measurement is complete', !/device/.test(sectionOf(readPreset(ctl.g), BGE)),
    JSON.stringify(sectionOf(readPreset(ctl.g), BGE)));
  const ctlRow = String(rowOf(ctl.shelf, BGE)?.deviceNote ?? '');
  ok('THE POINT: beside a router the app did NOT start, an excluded device with attempts left is promised a retry only when the APP starts llama.cpp — never "next start" as if it were this one',
    /zzfake iGPU 没有测出结果\(进程在载入模型时退出了\(退出码 3\);第 1 次\),等应用自己启动 llama\.cpp 时会再测\(现在运行的 llama\.cpp 不是应用这次启动的\)/.test(ctlRow)
      && !/应用下一次自己启动 llama\.cpp 时会再测/.test(ctlRow) && /测出结果的设备里目前最快的是 CPU,但还有设备没测完/.test(ctlRow),
    ctlRow);
  ctl.s2.stop();

  // Every device TIMES OUT (a 3 s cap), over three starts of the app's own — the measurement complete, nothing valid, every
  // device a lower bound (~1.9 ms per pair token). The verdict says 「会跳过判断」; the pace must start from the same bound, or
  // the first long recalls are sent and cut at the deadline (re-review).
  const lb = await runPace('-bound', BOUND_PORT, BOUND2_PORT, { none: 'hang', Vulkan0: 'hang' },
    { extraStarts: 2, extraKnobs: { GATHERLIGHT_RERANK_MEASURE_CAP_SECONDS: '3' } });
  const lbRes = resultsOf(lb.g, BGE);
  ok('(fixture) three attempts each, every device timed out — a lower bound on each, no valid result, no device named',
    ['none', 'Vulkan0'].every((d) => lbRes[d]?.attempts === 3 && lbRes[d]?.elapsedMs == null && lbRes[d]?.lowerBoundMsPerToken > 1)
      && !/device/.test(sectionOf(readPreset(lb.g), BGE)),
    JSON.stringify(entryOf(lb.g, BGE)?.results ?? null));
  ok('THE POINT (re-review): the recall of long notes SENT NOTHING to the router — the pace starts from the LOWER BOUND the verdict reads, not the GPU figure',
    lb.r.status === 200 && lb.sent === 0, JSON.stringify({ status: lb.r.status, sent: lb.sent }));
  const lbSeed = lb.log().split(/\r?\n/).find((l) => /the rerank pace starts from/.test(l)) ?? '';
  ok('…and the log says so (secondary: the count above is the evidence)', /a LOWER BOUND: every device timed out/.test(lbSeed), lbSeed);
  lb.s2.stop();

  // ---- F · a measurement child dies with the app, however the app dies ----------------------------------------------
  // The app is ended with TerminateProcess while a child is measuring (a device that never answers keeps it busy for the
  // 8 s cap): no Dispose, no finally. The child is in the app's kill-on-close JOB OBJECT, so it dies with the app.
  const j = plant('-job', [BGE]);
  answer(j, { devices: IGPU_ONLY });
  configure(j, { [BGE]: { none: 'hang', Vulkan0: 'hang' } });
  const sj = startServer({ dataDir: j.dir, port: JOB_PORT, env: env(j) });
  servers.push(sj);
  await waitHealthy(sj.base);
  await fetch(`${sj.base}/api/manage/models/llama?refresh=true`);
  fetch(`${sj.base}/api/manage/models/llama/start`, { method: 'POST' }).catch(() => { /* the app is killed under it */ });
  const child = await until(async () => {
    const e = events(j);
    const st = e.find((x) => x.event === 'start');
    return st && e.some((x) => x.event === 'rerank' && x.device === st.device) ? st : null;
  }, 60000);
  ok('(fixture) a measurement child is running, and busy', !!child && alive(child.pid), JSON.stringify(child ?? null));
  try { execFileSync('taskkill', ['/PID', String(child.ppid), '/F'], { stdio: 'ignore' }); } catch { /* reported below */ }
  const gone = await until(async () => !alive(child.pid), 10000).then(() => true).catch(() => false);
  ok('THE POINT: the app TerminateProcess\'d — no Dispose ran — and its measurement child died WITH it (the kill-on-close job)',
    !alive(child.ppid) && gone, JSON.stringify({ app: child.ppid, appAlive: alive(child.ppid), child: child.pid, childAlive: alive(child.pid) }));
  if (alive(child.pid)) process.kill(child.pid);   // never leave it behind, even when the assertion failed

  // ---- G · no device answers in time: a LOWER BOUND decides; a bind says where its time went ---------------------------
  // BGE only — no embedder — and a 3 s cap; both devices never answer, so every warm call times out and leaves a lower
  // bound (the cap over the batch's pair tokens, ~1.9 ms per pair token here — well past what the default page admits).
  const g = plant('-slowest', [BGE]);
  answer(g, { devices: IGPU_ONLY });
  configure(g, { [BGE]: { none: 'hang', Vulkan0: 'hang' } });
  const sg = startServer({ dataDir: g.dir, port: SLOWEST_PORT, env: env(g, { GATHERLIGHT_RERANK_MEASURE_CAP_SECONDS: '3' }) });
  servers.push(sg);
  await waitHealthy(sg.base);
  const cg = makeClient(sg.base);
  await cg.getJson('/api/manage/models/llama?refresh=true');
  const bind1 = await cg.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: BGE });
  const clause = /启动 llama\.cpp 前先测了 bge-reranker-v2-m3-Q5_K_M 在哪个设备上最快\(用了 \d+\.\d+ 秒\),结果写在「资源」里各自那一行。$/;
  ok('(fixture) the bind started llama.cpp — measuring BGE on both devices first — and was refused: the router (more.com) never came up',
    bind1.status === 409 && startsOf(g).length === 2, JSON.stringify({ status: bind1.status, starts: startsOf(g).length, body: bind1.body }));
  ok('THE POINT (final review): the REFUSED bind still says where its time went — the measurement, and how long — like the start button',
    clause.test(String(bind1.body?.error ?? '')) && clause.test(String(bind1.body?.measured ?? ''))
      && String(bind1.body?.error ?? '').startsWith('llama.cpp 没能启动'),
    JSON.stringify(bind1.body));
  const g1 = resultsOf(g, BGE);
  ok('THE POINT: each timed-out call left a LOWER BOUND on the device\'s rate — never a valid result',
    ['none', 'Vulkan0'].every((d) => g1[d]?.elapsedMs == null && /预热:3 秒内没有打完分/.test(g1[d]?.error ?? '')
      && g1[d]?.lowerBoundMsPerToken > 1.5 && g1[d]?.lowerBoundMsPerToken < 2.5),
    JSON.stringify(entryOf(g, BGE)?.results ?? null));
  const shelfG1 = await cg.getJson('/api/manage/models');
  ok('THE POINT: …but with retries PENDING there is no verdict — no embedder installed, so the badge still offers the embedder, and the row claims nothing about speed',
    shelfG1.recommendation?.id === EMBEDDER && !/至少要/.test(rowOf(shelfG1, BGE)?.deviceNote ?? ''),
    JSON.stringify({ rec: shelfG1.recommendation?.id, row: rowOf(shelfG1, BGE)?.deviceNote }));
  await cg.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: BGE });
  await cg.post('/api/manage/models/llama/start');
  const bind4 = await cg.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: BGE });
  ok('(fixture) three attempts each — six measurement starts — and the fourth bind measured nothing',
    startsOf(g).length === 6 && Object.values(resultsOf(g, BGE)).every((r) => r.attempts === 3),
    JSON.stringify({ starts: startsOf(g).length, results: entryOf(g, BGE)?.results }));
  ok('(control) a bind that measured nothing says nothing about measuring',
    bind4.status === 409 && bind4.body?.measured == null && !/先测了/.test(String(bind4.body?.error ?? '')),
    JSON.stringify(bind4.body));
  const shelfG = await cg.getJson('/api/manage/models');
  const recG = shelfG.recommendation;
  ok('THE POINT (final review): attempts spent, every device timed out — the best LOWER BOUND fails the default page, so BGE is too slow here: 内置 is recommended, AHEAD of the missing embedder',
    recG?.id === BUILTIN_RERANK, JSON.stringify(recG ?? null));
  ok('…and the reason says it is a lower bound — 「至少要」, never 「约要」 — naming every device that did not finish',
    /^「判断」那一层在本机用它核对检索结果 —— 它在应用进程里运行,这台机器不需要为「判断」装 llama\.cpp。BGE 在这台机器上实测过:同一批 4 段、共 [\d,]+ 字的打分,没有一个设备在限定时间内打完\(CPU 3 次都没有测出结果\(最近一次:预热:3 秒内没有打完分\)[^;]*;zzfake iGPU 3 次都没有测出结果\(最近一次:预热:3 秒内没有打完分\),除非[^;]*不会再测\);照这个下限推算,默认一次检索最多给判断看的 96 条候选、每条都是长事实只读一段\(约 1,000 字\)时至少要 \d+\.\d+ 秒,超过应用送出这样一次判断的 48\.0 秒上限/.test(recG?.reason ?? '')
      && !/约要/.test(recG?.reason ?? ''),
    String(recG?.reason));
  const gRow = String(rowOf(shelfG, BGE)?.deviceNote ?? '');
  ok('…and BGE\'s row too: no device gave a result, llama.cpp chooses, and at least this long — while the preset names no device',
    gRow.includes('没有一个设备测出可用的结果,所以仍由 llama.cpp 自己选设备。每个设备都在限定时间内没有打完这一批,照这个下限推算,')
      && /时至少要 \d+\.\d+ 秒,超过应用送出这样一次判断的 48\.0 秒上限/.test(gRow) && !/device/.test(sectionOf(readPreset(g), BGE)),
    JSON.stringify({ row: gRow, section: sectionOf(readPreset(g), BGE) }));

  // A device excluded for ANOTHER reason — it exited — says nothing about its speed, and llama.cpp, choosing when nothing
  // is pinned, may put BGE there: then no lower bound decides and nothing is claimed.
  answer(g, { devices: TWO_GPUS });
  await cg.getJson('/api/manage/models/llama?refresh=true');
  configure(g, { [BGE]: { none: 'hang', Vulkan0: 'hang', Vulkan1: 'exit' } });
  for (let i = 0; i < 3; i++) await cg.post('/api/manage/models/llama/start');
  const g2 = resultsOf(g, BGE);
  ok('(fixture) a new device list, three attempts each: the CPU and the iGPU timed out, the dGPU exited',
    ['none', 'Vulkan0', 'Vulkan1'].every((d) => g2[d]?.attempts === 3) && g2.none?.lowerBoundMsPerToken > 0
      && g2.Vulkan0?.lowerBoundMsPerToken > 0 && g2.Vulkan1?.lowerBoundMsPerToken == null,
    JSON.stringify(entryOf(g, BGE)?.results ?? null));
  const shelfG2 = await cg.getJson('/api/manage/models');
  ok('THE POINT: one device\'s speed UNKNOWN (it exited), so the lower bounds claim nothing — no 「至少要」, and the badge offers the embedder again',
    shelfG2.recommendation?.id === EMBEDDER && !/至少要/.test(rowOf(shelfG2, BGE)?.deviceNote ?? '')
      && /没有一个设备测出可用的结果,所以仍由 llama\.cpp 自己选设备。/.test(rowOf(shelfG2, BGE)?.deviceNote ?? ''),
    JSON.stringify({ rec: shelfG2.recommendation?.id, row: rowOf(shelfG2, BGE)?.deviceNote }));
} catch (err) {
  fail('e2e-p53 fatal: ' + err.message);
  for (const s of servers) console.error(s.log().slice(-3000));
} finally {
  for (const s of servers) { try { s.stop(); } catch { /* best effort */ } }
  try { fakeRouter?.close(); } catch { /* best effort */ }
}
done();
