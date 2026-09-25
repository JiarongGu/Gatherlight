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
//      OS picked, warmed and timed on DIFFERENT documents of one size; the fastest is named in the preset (`device =
//      Vulkan1`), `n-gpu-layers` still beside it, and nothing else gets a device key; the measurement persisted, its
//      device list stripped of the free-memory figures; the row says where it runs and that it was measured here
//   A2 validity: a device that scores 3 of 4 documents is excluded however fast, one that never answers is cut at the cap
//      and its process killed
//   B  retries: at the next start ONLY the excluded devices are measured again, valid results kept — a device valid now
//      takes over — and a device that keeps failing is tried MaxAttempts (3) times and then left, the row saying which;
//      with the store unwritable meanwhile, the row and the next retry read the NEWER unsaved measurement, attempts still
//      advance, and the save is tried again at the next start; the start's answer names only what IT measured, even when
//      the start fails; a device list whose FREE MEMORY moved measures nothing
//   C  the key: a device list whose DEVICES changed re-measures (the dGPU hidden, as GGML_VK_VISIBLE_DEVICES does); so
//      do a changed model file and a changed build; and the recommendation flips: BGE measured too slow for the default
//      page's one-window call on every device → 资源 recommends mMiniLMv2 beside the installed BGE, saying why — but NOT
//      while a retry of an excluded device is still pending
//   D  a CPU section: `device = none` beside `n-gpu-layers = 99` (harmless — verified on the real binary, see
//      LlamaServerRuntime.LaunchKeys); a declared window (mMiniLMv2, 512) is the window it is measured under; a
//      measurement that could not be SAVED is still what the preset names, the row says so, and the next start retries
//      from it and saves it
//   E  the pace seed, counted at the ROUTER: a second life of a folder where BGE was measured slow adopts a fake router, and
//      a recall of long notes sends it NOTHING (skipped at the measured rate); the control — measured with no valid device
//      — sends it the call. A never-measured reranker's row, beside a router the app did not start, says it is not
//      measured while that router is not ours, and an excluded device's retry is promised only for the app's own start.
//      The overlay's step line showed the measurement's progress
//   F  the kill-on-close job: the app TerminateProcess'd while a measurement child is running — the child dies with it
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
// the lead (C's reason) and the save not retried (B's two).
//
// NOT DRIVEN: Dispose killing a measurement child (the harness stops a server with TerminateProcess, which skips Dispose
// — F drives the job, which covers that kill too); the router's port band refused when the OS offers it (the OS cannot be
// made to); a throw inside a retry keeping the stored device key (nothing in the measurement can be made to throw there);
// a start that waited behind ANOTHER caller's measurement not claiming it (the two cannot be interleaved on demand).
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
  const srv = startServer({ dataDir: f.dir, port: PORT, env: env(f) });
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
  ok('THE POINT: …so LAMAR runs on the CPU, its one VALID device — not on the device that answered fastest with 3 of 4',
    lamarRes.none?.elapsedMs > 0 && !lamarRes.none?.error && /^device\s*=\s*none\s*$/m.test(sectionOf(preset1, LAMAR)),
    JSON.stringify({ cpu: lamarRes.none ?? null, section: sectionOf(preset1, LAMAR) }));

  const shelf1 = await getJson('/api/manage/models');
  const bgeNote = String(rowOf(shelf1, BGE)?.deviceNote ?? '');
  ok('THE POINT: BGE\'s row says WHERE it runs and that the choice was MEASURED on this machine, with the figures',
    /在这台机器上实测过/.test(bgeNote) && /所以应用启动 llama\.cpp 时让它在 zzfake dGPU 上运行/.test(bgeNote)
      && /同一批 4 段/.test(bgeNote) && /CPU \d+\.\d+ 秒/.test(bgeNote) && /zzfake iGPU \d+\.\d+ 秒/.test(bgeNote) && /b10549/.test(bgeNote)
      && /嵌入模型和对话模型仍由 llama\.cpp 自己选/.test(bgeNote) && /没有量过/.test(bgeNote),
    bgeNote);
  const lamarNote1 = String(rowOf(shelf1, LAMAR)?.deviceNote ?? '');
  ok('…LAMAR\'s names each excluded device, its reason and that it will be measured AGAIN — and says the CPU is the fastest THAT GAVE A RESULT',
    /zzfake iGPU 没有测出结果\(预热:8 秒内没有打完分;第 1 次\),应用下一次自己启动 llama\.cpp 时会再测/.test(lamarNote1)
      && /zzfake dGPU 没有测出结果\(预热:只给 4 段里的 3 段打了分;第 1 次\)/.test(lamarNote1)
      && /测出结果的设备里最快的是 CPU,所以应用启动 llama\.cpp 时让它在 CPU 上运行/.test(lamarNote1),
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
  ok('THE POINT: a device valid now takes over — the preset names the dGPU — and the ROW shows that NEWER, unsaved measurement, not the older stored one',
    /^device\s*=\s*Vulkan1\s*$/m.test(sectionOf(readPreset(f), LAMAR))
      && /测出结果的设备里最快的是 zzfake dGPU,所以应用启动 llama\.cpp 时让它在 zzfake dGPU 上运行/.test(lamarRowB1)
      && /zzfake iGPU 没有测出结果\(进程在载入模型时退出了\(退出码 3\);第 2 次\),应用下一次自己启动 llama\.cpp 时会再测/.test(lamarRowB1)
      && /这次的结果没能保存:应用下一次自己启动 llama\.cpp 时会再试着保存;要是应用重启时还没保存上,重启后会重新测。/.test(lamarRowB1),
    lamarRowB1);
  const b2 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const retry2 = startsOf(f).slice(b2);
  ok('THE POINT: the third start retries from the UNSAVED measurement — the iGPU a third time, and nothing else: attempts advance though nothing was saved',
    JSON.stringify(retry2.map((e) => `${e.model}@${e.device}`)) === JSON.stringify([`${LAMAR}@Vulkan0`])
      && /zzfake iGPU 3 次都没有测出结果/.test(rowOf(await getJson('/api/manage/models'), LAMAR)?.deviceNote ?? ''),
    JSON.stringify({ starts: retry2.map((e) => `${e.model}@${e.device}`) }));
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
    /zzfake iGPU 3 次都没有测出结果\(最近一次:进程在载入模型时退出了\(退出码 3\)\),除非模型文件、llama\.cpp 版本或设备列表变了\(更新显卡驱动不算\),不会再测/.test(lamarNote3)
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
  ok('THE POINT: BGE too slow on the CPU, but a retry of the iGPU is PENDING → no flip yet (a busy GPU once must not recommend a download)',
    (await getJson('/api/manage/models')).recommendation == null && resultsOf(f, BGE).Vulkan0?.attempts === 1,
    JSON.stringify((await getJson('/api/manage/models')).recommendation ?? null));
  await post('/api/manage/models/llama/start');
  ok('…still none after the second attempt', (await getJson('/api/manage/models')).recommendation == null && resultsOf(f, BGE).Vulkan0?.attempts === 2,
    JSON.stringify({ rec: (await getJson('/api/manage/models')).recommendation ?? null, vulkan0: resultsOf(f, BGE).Vulkan0 }));
  await post('/api/manage/models/llama/start');
  const shelf2 = await getJson('/api/manage/models');
  const rec2 = shelf2.recommendation;
  ok('THE POINT: attempts spent, no retry pending, BGE too slow for the default page on every device that gave a result → 资源 recommends mMiniLMv2, beside the installed BGE',
    rec2?.id === MMINILM && rowOf(shelf2, BGE)?.installed === true && resultsOf(f, BGE).Vulkan0?.attempts === 3, JSON.stringify(rec2 ?? null));
  ok('…and its reason says why, from the measurement: the fastest device that gave a result, the excluded one with ITS clause, its time, 96 LONG candidates, the 48 s limit, the skip — and that short facts take far less',
    /BGE 在这台机器上实测过:测出结果的设备里最快的是 CPU\(没有测出结果的:zzfake iGPU 3 次都没有测出结果\(最近一次:进程在载入模型时退出了\(退出码 3\)\),除非模型文件、llama\.cpp 版本或设备列表变了\(更新显卡驱动不算\),不会再测\)/.test(rec2?.reason ?? '')
      && /96 条候选、每条都是长事实只读一段\(约 1,000 字\)/.test(rec2?.reason ?? '') && /48\.0 秒上限/.test(rec2?.reason ?? '')
      && /跳过判断\(事实短时花的时间少得多\)/.test(rec2?.reason ?? '') && !/时会再测/.test(rec2?.reason ?? '')
      && /下载后应用下一次自己启动 llama\.cpp 时同样会测/.test(rec2?.reason ?? '') && /Claude CLI/.test(rec2?.reason ?? ''),
    String(rec2?.reason));
  ok('…and BGE\'s own row says a default recall of long facts would be skipped at this speed',
    /让它在 CPU 上运行/.test(rowOf(shelf2, BGE)?.deviceNote ?? '') && /跳过判断/.test(rowOf(shelf2, BGE)?.deviceNote ?? ''),
    String(rowOf(shelf2, BGE)?.deviceNote));

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
  ok('THE POINT: …the preset still names the device it measured — the CPU — and its row says the result was not saved, and what happens to it',
    /^device\s*=\s*none\s*$/m.test(sectionOf(readPreset(f), MMINILM)) && /让它在 CPU 上运行/.test(mmRow)
      && /这次的结果没能保存:应用下一次自己启动 llama\.cpp 时会再试着保存;要是应用重启时还没保存上,重启后会重新测。/.test(mmRow),
    mmRow);
  ok('…a device whose process EXITS before it answers is excluded with its exit code', /zzfake iGPU 没有测出结果\(进程在载入模型时退出了\(退出码 3\);第 1 次\)/.test(mmRow),
    mmRow);
  fs.rmSync(blocker, { recursive: true, force: true });
  const d2 = startsOf(f).length;
  await post('/api/manage/models/llama/start');
  const starts6 = startsOf(f).slice(d2);
  ok('…and the next start retries from the UNSAVED measurement — the iGPU only — and saves it this time',
    JSON.stringify(starts6.map((e) => `${e.model}@${e.device}`)) === JSON.stringify([`${MMINILM}@Vulkan0`])
      && resultsOf(f, MMINILM).Vulkan0?.attempts === 2 && resultsOf(f, MMINILM).none?.elapsedMs > 0
      && /^device\s*=\s*none\s*$/m.test(sectionOf(readPreset(f), MMINILM)),
    JSON.stringify({ starts: starts6.map((e) => `${e.model}@${e.device}`), stored: entryOf(f, MMINILM)?.results }));
  ok('(control) with mMiniLMv2 installed there is nothing to recommend', (await getJson('/api/manage/models')).recommendation == null,
    JSON.stringify((await getJson('/api/manage/models')).recommendation ?? null));
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

  const runPace = async (suffix, port1, port2, rates) => {
    const g = plant(suffix, [BGE], bound);
    answer(g, { devices: IGPU_ONLY });
    configure(g, { [BGE]: rates });
    const knobs = { GATHERLIGHT_JUDGE_DEADLINE_SECONDS: '3' };
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

  // The control: the same fixture, but no device gave a valid result, so there is no seed.
  const ctl = await runPace('-control', CONTROL_PORT, CONTROL2_PORT, { none: 'partial', Vulkan0: 'partial' });
  ok('(control) with no valid measurement, the same recall IS sent to the router — the GPU figure fits it',
    ctl.r.status === 200 && ctl.sent >= 1, JSON.stringify({ status: ctl.r.status, sent: ctl.sent }));
  ok('(control) …and its preset names no device', !/device/.test(sectionOf(readPreset(ctl.g), BGE)),
    JSON.stringify(sectionOf(readPreset(ctl.g), BGE)));
  const ctlRow = String(rowOf(ctl.shelf, BGE)?.deviceNote ?? '');
  ok('THE POINT: beside a router the app did NOT start, an excluded device with attempts left is promised a retry only when the APP starts llama.cpp — never "next start" as if it were this one',
    /CPU 没有测出结果\(预热:只给 4 段里的 3 段打了分;第 1 次\),等应用自己启动 llama\.cpp 时会再测\(现在运行的 llama\.cpp 不是应用这次启动的\)/.test(ctlRow)
      && !/应用下一次自己启动 llama\.cpp 时会再测/.test(ctlRow),
    ctlRow);
  ctl.s2.stop();

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
} catch (err) {
  fail('e2e-p53 fatal: ' + err.message);
  for (const s of servers) console.error(s.log().slice(-3000));
} finally {
  for (const s of servers) { try { s.stop(); } catch { /* best effort */ } }
  try { fakeRouter?.close(); } catch { /* best effort */ }
}
done();
