// recall-questions.mjs — how a question about a fact is WRITTEN, shared by recall-bench (the household's own
// facts) and judge-bench-fixture (the committed bilingual fixture). One copy, because two copies of a prompt
// drift, and a bench whose questions are written differently measures a different thing.
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const NL = String.fromCharCode(10);

export const hasCjk = (fact) => /[一-鿿]/.test(`${fact.topic} ${fact.content}`);

// FOUR WAYS A REAL QUESTION ARRIVES, because a household is not monolingual.
//   same   — the fact's own language. The lexical floor's best case; kept as the control.
//   cross  — the other of zh/en.
//   third  — neither the fact's language nor English (ja).
//   mixed  — CODE-SWITCHED, the way people type in chat: a Chinese sentence carrying English nouns.
export const QUESTION_SETS = [
  { key: 'same', label: '同语言', ask: () => 'Write it in the SAME language as the fact.' },
  { key: 'cross', label: '跨语言', ask: (f) => (hasCjk(f) ? 'Write it in English.' : 'Write it in Chinese.') },
  { key: 'third', label: '第三语言', ask: () => 'Write it in Japanese.' },
  { key: 'mixed', label: '混合语言',
    ask: () => 'Write it CODE-SWITCHED the way a bilingual person types in chat: a Chinese sentence that '
      + 'keeps the key nouns in English. Do not translate everything into one language.' },
];

// RESOLVED, never shelled: prompts carry newlines, and `shell: true` concatenates arguments unescaped. On
// Windows the first `where` hit can be an extensionless shim CreateProcess cannot run, so prefer .cmd/.exe —
// the order ClaudeCliRuntime.Locate uses.
export const resolveClaude = () => {
  const explicit = process.env.GATHERLIGHT_CLAUDE_CMD || process.env.CLAUDE_CMD;
  if (explicit) return explicit;
  if (process.platform !== 'win32') return 'claude';
  const w = spawnSync('where.exe', ['claude'], { encoding: 'utf8' });
  const hits = (w.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  return hits.find((h) => /\.(cmd|exe)$/i.test(h)) ?? hits[0] ?? 'claude';
};

// A NEUTRAL cwd, like every one-shot call in this codebase: run from a data folder and the planner's whole
// knowledge base loads per call.
const run = (claude, prompt) =>
  spawnSync(claude, ['-p', prompt], { encoding: 'utf8', cwd: os.tmpdir(), maxBuffer: 1 << 20 });

/** One question in one set's language, or null. */
export const askIn = (claude, fact, set) => {
  const prompt =
    'Below is one fact from a private knowledge base. Write ONE short question that this fact answers.'
    + NL + `Language: ${set.ask(fact)}`
    + NL + "Rules: do NOT reuse the fact's distinctive words (paraphrase); do not transliterate; ask it "
    + 'the way a person would; output the question ALONE with no preamble, quotes or punctuation beyond '
    + 'the question mark.' + NL + NL + `FACT: ${fact.topic} — ${fact.content}`;
  const out = (run(claude, prompt).stdout ?? '').trim().split(NL).filter(Boolean).pop() ?? '';
  return out.length >= 4 && out.length <= 200 ? out : null;
};

/** All four questions in ONE call, as { same, cross, third, mixed }, or null. */
export const askAll = (claude, fact) => {
  const prompt =
    'Below is one fact from a private knowledge base. Write FOUR short questions this fact answers, one per key:'
    + NL + QUESTION_SETS.map((s) => `- "${s.key}": ${s.ask(fact)}`).join(NL)
    + NL + "Rules: do NOT reuse the fact's distinctive words (paraphrase); do not transliterate; ask each the "
    + 'way a person would.'
    + NL + 'Output ONLY a JSON object with exactly those four keys, each a string.'
    + NL + NL + `FACT: ${fact.topic} — ${fact.content}`;
  const text = run(claude, prompt).stdout ?? '';
  // Deliberately GREEDY: spans a fenced or prose-wrapped object. If the model emits two objects the splice
  // fails JSON.parse and returns null — fails closed — where a lazy match would risk cutting inside a value
  // that itself contains `}`.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const q = Object.fromEntries(QUESTION_SETS.map((s) => [s.key, typeof o[s.key] === 'string' ? o[s.key].trim() : null]));
    return QUESTION_SETS.every((s) => q[s.key] && q[s.key].length >= 4 && q[s.key].length <= 200) ? q : null;
  } catch {
    return null;
  }
};
