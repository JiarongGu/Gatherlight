#!/usr/bin/env node
// embed-bench.mjs — measure embedding models on the job THIS app gives them: find the fact whose
// MEANING answers a question worded nothing like it.
//
// Why this is committed rather than a scratch script: the shortlist in EmbeddingCatalog.cs carries
// measured numbers, embedding models keep appearing, and a number nobody can reproduce decays into a
// claim. Re-run this when a model shows up, and update the catalog from what it prints.
//
// Usage:
//   node devtools/scripts/embed-bench.mjs                 # every embedding-looking model installed
//   node devtools/scripts/embed-bench.mjs bge-m3 …        # just these
//
// Fidelity matters more than convenience here, so three things are deliberate:
//   · it calls the OpenAI-COMPATIBLE /v1/embeddings, the endpoint AddOpenAiCompatibleEmbedder uses.
//     Ollama's native /api/embed can normalise differently, which would measure a different product.
//   · query and document are embedded SYMMETRICALLY with no instruction prefix, because that is what
//     the app does. Several models score better with an asymmetric prefix — flattering a model we do
//     not run that way is worse than not measuring it.
//   · the corpus is fictional and mixed zh/en, matching a household whose notes are mostly Chinese.
//     An English-only fixture is how `nomic-embed-text` came to be recommended in the first place.
const BASE = process.env.GATHERLIGHT_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

// 20 facts. The distractors carry as much weight as the targets: several share vocabulary with the
// WRONG question, so a model cannot score by keyword overlap.
const FACTS = [
  '山间神社在入口处请访客脱鞋,石阶共两百级。',
  '港口渡轮与地铁共用同一张交通卡,不需另外购票。',
  '机场快线每二十分钟一班,末班车在午夜前十分钟发出。',
  'N9 路夜间巴士周末通宵运行,平日只到凌晨一点。',
  '共享单车前三十分钟免费,超时按每半小时计费。',
  '玻璃吊桥在强风天气关闭,官网当天上午九点更新。',
  '河边灯会每晚从黄昏持续到二十二点,雨天照常。',
  '老城区的石板路很滑,下雨天推婴儿车会很吃力。',
  '温泉旅馆的家庭房需要提前三个月预订,旺季更早。',
  '博物馆每月第一个周一闭馆,学生凭证件半价。',
  'The harbour teahouse holds a booking for fifteen minutes past the reserved time.',
  'The set menu was 2800 per head when checked, drinks not included.',
  'Luggage lockers at the main station take coins only, no cards.',
  'The observation deck closes to new visitors one hour before the building shuts.',
  'A stroller can be borrowed free at the visitor centre, deposit refunded on return.',
  '儿童在动物园需由成人陪同,推车可在门口免费寄存。',
  '市集只在周三和周六上午开,摊主多半只收现金。',
  '缆车在维护日停运,通常是每年一月的第二周。',
  'Tap water is safe to drink; most restaurants serve it chilled without asking.',
  '药妆店在车站出口右转两百米,营业到晚上十点。',
];

// [question, index of the fact that answers it]
const QUERIES = [
  ['哪里需要把鞋子脱掉', 0],
  ['一张卡能不能同时坐船和地铁', 1],
  ['深夜还有没有车回市区', 3],
  ['骑车短途要不要花钱', 4],
  ['刮大风的时候哪个景点会关', 5],
  ['带小孩去哪里可以借到推车', 14],
  ['存行李需要准备零钱吗', 12],
  ['what happens if we arrive a little late for the reservation', 10],
  ['can we drink from the tap', 18],
  ['哪天去博物馆会白跑一趟', 9],
];

const embed = async (model, input) => {
  const r = await fetch(`${BASE}/v1/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
  return (await r.json()).data.map((d) => d.embedding);
};

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb) || 1);
};

const installed = async () => {
  const r = await fetch(`${BASE}/api/tags`);
  if (!r.ok) throw new Error(`Ollama not reachable at ${BASE}`);
  // Name-matched rather than probed: a chat model answers /v1/embeddings on some builds, and running
  // the whole corpus through one to find out is minutes wasted. Name an explicit list to override.
  return (await r.json()).models.map((m) => m.name)
    .filter((n) => /embed|minilm|bge|gte|e5/i.test(n));
};

let models = process.argv.slice(2);
if (models.length === 0) {
  models = await installed();
  if (models.length === 0) {
    console.log(`no embedding-looking models installed at ${BASE} — pull one, or name models explicitly.`);
    process.exit(1);
  }
  console.log(`measuring the ${models.length} embedding model(s) installed here\n`);
}

const rows = [];
for (const model of models) {
  try {
    const t0 = Date.now();
    const docs = await embed(model, FACTS);
    const corpusMs = Date.now() - t0;
    let top1 = 0, top3 = 0;
    const misses = [];
    const tq = Date.now();
    for (const [q, want] of QUERIES) {
      const [qv] = await embed(model, [q]);
      const pos = docs.map((d, i) => [i, cos(qv, d)]).sort((a, b) => b[1] - a[1])
        .findIndex(([i]) => i === want);
      if (pos === 0) top1++;
      if (pos < 3) top3++; else misses.push(`${q} → #${pos + 1}`);
    }
    const msPerQuery = Math.round((Date.now() - tq) / QUERIES.length);
    rows.push({ model, dims: docs[0].length, top1, top3, msPerQuery });
    console.log(`${model}: dims=${docs[0].length} top1=${top1}/${QUERIES.length} top3=${top3}/${QUERIES.length}`
      + ` · corpus ${corpusMs}ms · ${msPerQuery}ms/query`);
    for (const m of misses) console.log(`    miss: ${m}`);
  } catch (e) {
    console.log(`${model}: FAILED — ${e.message}`);
  }
}

if (rows.length) {
  console.log('\n| model | dims | top-1 | top-3 | ms/query |');
  console.log('|---|---|---|---|---|');
  for (const r of rows.sort((a, b) => b.top1 - a.top1 || a.msPerQuery - b.msPerQuery)) {
    console.log(`| ${r.model} | ${r.dims} | ${r.top1}/${QUERIES.length} | ${r.top3}/${QUERIES.length} | ${r.msPerQuery} |`);
  }
  console.log('\nUpdate EmbeddingCatalog.cs from this — and keep the caveat with it: 10 queries separates'
    + '\na broken model from a working one, and cannot rank two working ones.');
}
