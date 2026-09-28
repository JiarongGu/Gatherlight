// A TINY but REAL cross-encoder export for the e2e suites — an ONNX graph plus a SentencePiece Unigram tokenizer.json —
// so the in-process 内置 reranker runs through the real ONNX Runtime and Lyntai's real ONNX provider and tokenizer
// (Lyntai D124/D157/D191) with nothing mocked, while its SCORES are chosen by the suite. Leading `_`: the runner
// (`^p\d+\.mjs$`) never takes it for a suite.
//
// The real export is 136 MB; a fixture cannot download that per run, and a planted empty file would only prove that
// presence checks pass. This writes, in the pinned layout (InProcessReranker.Files):
//   onnx/model_qint8_avx512_vnni.onnx — input_ids, attention_mask [batch, seq] → logits [batch, 1], where a row's logit is
//                       the sum over its attended tokens of a per-token WEIGHT: Gather(W, input_ids) · Cast(mask) → ReduceSum.
//                       A pair's row holds the query AND the document (XLM-R's <s> q </s></s> d </s>), so every document of
//                       one call shares the query's part and the documents differ only by their own weighted tokens.
//   tokenizer.json   — Unigram over single-character pieces: the four specials, the Metaspace ▁, and one piece per character
//                       the suite weights; every other character is <unk> (weight 0), which Lyntai's Unigram fuses into one.
//   config.json / tokenizer_config.json — 514 positions narrowed to 512, as the real export declares.
// The graph is written as protobuf by hand below (a few ONNX message fields), because nothing on a fixture machine is
// assumed to have the `onnx` Python package.
import fs from 'node:fs';
import path from 'node:path';

const varint = (n) => {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
};
const key = (field, wire) => varint((field << 3) | wire);
const bytes = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);
const str = (field, s) => bytes(field, Buffer.from(s, 'utf8'));
const int = (field, v) => Buffer.concat([key(field, 0), varint(v)]);
const msg = (...parts) => Buffer.concat(parts);

const FLOAT = 1;
const INT64 = 7;
const dim = (d) => (typeof d === 'number' ? bytes(1, int(1, d)) : bytes(1, str(2, d)));
const valueInfo = (name, elemType, dims) =>
  msg(str(1, name), bytes(2, bytes(1, msg(int(1, elemType), bytes(2, msg(...dims.map(dim)))))));
const tensor = (name, dataType, dims, raw) => msg(...dims.map((d) => int(1, d)), int(2, dataType), str(8, name), bytes(9, raw));
const attrInt = (name, v) => msg(str(1, name), int(3, v), int(20, 2));
const node = (op, inputs, outputs, attrs = []) =>
  msg(...inputs.map((i) => str(1, i)), ...outputs.map((o) => str(2, o)), str(3, `${op}_${outputs[0]}`), str(4, op),
    ...attrs.map((a) => bytes(5, a)));

/** Write the export into `dir`. `weights` maps a single character to its per-token weight; every other token weighs 0. */
export function writeTinyCrossEncoder(dir, weights) {
  const chars = Object.keys(weights);
  for (const c of chars) if ([...c].length !== 1 || c === '▁') throw new Error(`a weighted piece must be one character: ${c}`);
  const pieces = [['<s>', 0], ['<pad>', 0], ['</s>', 0], ['<unk>', 0], ['▁', -1], ...chars.map((c) => [c, -2])];
  const w = Buffer.alloc(4 * pieces.length);
  pieces.forEach(([p], i) => w.writeFloatLE(weights[p] ?? 0, 4 * i));
  const axes = Buffer.alloc(8);
  axes.writeBigInt64LE(1n);

  const graph = msg(
    bytes(1, node('Gather', ['W', 'input_ids'], ['g'], [attrInt('axis', 0)])),
    bytes(1, node('Cast', ['attention_mask'], ['m'], [attrInt('to', FLOAT)])),
    bytes(1, node('Mul', ['g', 'm'], ['gm'])),
    bytes(1, node('ReduceSum', ['gm', 'axes'], ['logits'], [attrInt('keepdims', 1)])),
    str(2, 'tiny-cross-encoder'),
    bytes(5, tensor('W', FLOAT, [pieces.length], w)),
    bytes(5, tensor('axes', INT64, [1], axes)),
    bytes(11, valueInfo('input_ids', INT64, ['batch', 'sequence'])),
    bytes(11, valueInfo('attention_mask', INT64, ['batch', 'sequence'])),
    bytes(12, valueInfo('logits', FLOAT, ['batch', 1])),
  );
  const model = msg(int(1, 8), str(2, 'gatherlight-e2e'), bytes(7, graph), bytes(8, msg(str(1, ''), int(2, 13))));

  fs.mkdirSync(path.join(dir, 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'onnx', 'model_qint8_avx512_vnni.onnx'), model);
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), JSON.stringify({
    version: '1.0',
    added_tokens: [0, 1, 2, 3].map((id) => ({ id, content: pieces[id][0], single_word: false, lstrip: false, rstrip: false, normalized: false, special: true })),
    normalizer: null,
    pre_tokenizer: { type: 'Metaspace', replacement: '▁', prepend_scheme: 'always', split: true },
    post_processor: { type: 'RobertaProcessing', sep: ['</s>', 2], cls: ['<s>', 0], trim_offsets: true, add_prefix_space: true },
    model: { type: 'Unigram', unk_id: 3, vocab: pieces, byte_fallback: false },
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    architectures: ['XLMRobertaForSequenceClassification'], max_position_embeddings: 514, model_type: 'xlm-roberta',
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'tokenizer_config.json'), JSON.stringify({ model_max_length: 512 }), 'utf8');
}

/** The bind screen's own pair (RerankScreen): the answer states the price, 四十元; the distractor never does. */
export const SCREEN_ANSWER_CHARS = ['四', '十', '元'];
