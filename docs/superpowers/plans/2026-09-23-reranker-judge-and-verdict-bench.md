# 判断 on a local reranker, a judge that sees the fact, and a bench for both — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let 判断 verify recalls with a local llama.cpp reranker (tagging stays on the Claude CLI), make the Claude judge see each fact's content instead of its topic, and measure all of it — plus `VerdictCombination.Fuse` — on a committed bilingual fixture.

**Architecture:** A reranker is a third GGUF *kind* served by the llama-server the app already provisions (`reranking = true` preset, `/v1/rerank`). A judge source now returns a `JudgeWiring` (annotation client + model + verifier factory) so the composition root has no per-kind branch. A decorator shows an LLM judge `topic — content`. A new `judge-bench` seeds one data folder from a fixture, snapshots it per arm, and runs identical question sequences against one server per arm.

**Tech Stack:** ASP.NET Core (net10.0), Lyntai 3.2 (`ScoringVerificationPolicy`, `AddHttpProvider` with `Produces = Score`), llama.cpp `llama-server` router mode, Node 22+ e2e suites (`devtools/scripts/e2e/pNN.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-23-reranker-judge-and-verdict-bench-design.md`

---

## Conventions every task follows

- **Build before e2e.** Suites run the server with `--no-build`. After a server change:
  `dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -nologo -v q` (expect `Build succeeded.`).
  After a CLIENT change: `node devtools/dev.mjs build`.
- **Run one suite:** `node devtools/dev.mjs e2e p48` (prints `e2e-p48 PASS`/`FAIL (n)`).
  **If it fails with `fatal: timeout` and the fixture log names `SocketException … forbidden by its access
  permissions`**, Windows has reserved that tcp range (`netsh interface ipv4 show excludedportrange protocol=tcp`;
  see `.claude/rules/dev-conventions.md` §fatal: timeout). Run the suite port-shifted instead:
  `node devtools/_run-shifted.mjs 5458 5557 200 p48` (a gitignored scratch runner that copies the suite to
  `devtools/_shifted/`, moves 5xxx ports in `[5458,5557]` up by 200, and runs it). Never renumber suites for this.
- **Sources are BOM-less UTF-8.** Never write files with PowerShell `Set-Content`.
- **Commits:** end every message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  The pre-commit hook runs `check-sensitive`; if it blocks, fix the content — never `--no-verify`.
- **Lyntai is review-only.** Do not edit anything in the Lyntai repo. (Parts 272 and 274 are already filed.)

## File map

| File | Responsibility | Tasks |
|---|---|---|
| `src/server/Gatherlight.Platform/Agent/Llm/Services/MemoryEnrichmentPolicies.cs` | + `JudgeSeesContentPolicy` (judge sees `topic — content`) | 2 |
| `src/server/Gatherlight.Server/GatherlightApp.cs` | judge wiring via `JudgeWiring`; measurement knobs | 2, 6, 13 |
| `devtools/scripts/e2e/p48.mjs` | judge notes carry content | 1 |
| `devtools/scripts/recall-questions.mjs` (new) | question generation shared by recall-bench + fixture | 3 |
| `devtools/scripts/recall-bench.mjs` | imports the shared module | 3 |
| `devtools/fixtures/recall-bilingual.facts.json` (new) | 60 authored facts incl. near-duplicates | 4 |
| `devtools/scripts/judge-bench-fixture.mjs` (new) | writes `recall-bilingual.json` (facts + 4 questions each) | 5 |
| `devtools/fixtures/recall-bilingual.json` (new, generated) | the bench fixture | 5 |
| `devtools/scripts/judge-bench.mjs` (new) + `devtools/dev.mjs` | the bench | 7 |
| `docs/judge-bench.md` (new) | the measured numbers | 8, 19 |
| `docs/self-managed-llm-runtime.md` | the real-binary reranker gate result | 9 |
| `src/server/Gatherlight.Platform/Agent/Llm/Services/GgufCatalog.cs` | `Reranking` capability + 2 pinned rerankers | 10 |
| `src/server/Gatherlight.Platform/Hosting/Resources/Services/ResourceProvisioner.cs` | `GgufKind` replaces `IsEmbeddingGguf` | 10 |
| `src/server/Gatherlight.Platform/Agent/Llm/Services/LlamaServerRuntime.cs` | reranker preset; `WarmAsync(kind)` | 11 |
| `src/server/Gatherlight.Platform/Hosting/Migration/Steps/LlamaWarmStep.cs`, `Hosting/Resources/ModelsController.cs` | callers of the kind API | 10, 11 |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/JudgeWiring.cs` (new) | what a judge is made of | 12 |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/IMemorySource.cs` | `Wiring`, `AnnotationModel`, `Cost` on judge sources | 12 |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/ClaudeCliJudgeSource.cs` | implements the three | 12 |
| `src/server/Gatherlight.Platform/Agent/Llm/Sources/LlamaCppSource.cs` | reranker models, screen, registration, wiring, cost | 14 |
| `src/server/Gatherlight.Platform/Agent/Llm/MemoryRecallController.cs` | cost from the source; binding writes the annotation model | 15 |
| `src/client/src/ui/organisms/console/LocalModelsPanel.tsx` | `reranking` capability label | 16 |
| `devtools/scripts/e2e/p51.mjs` | reranker preset + warm | 11 |
| `devtools/scripts/e2e/p52.mjs` | reranker binding screen + routing | 17 |
| `.claude/rules/dev-conventions.md`, `docs/release-notes/next.md` | record it | 18, 19 |

---

# Part A — the Claude judge sees the fact

### Task 1: p48 asserts the judge is shown content (failing test)

**Files:** Modify `devtools/scripts/e2e/p48.mjs` (the `A VERDICT REACHES THE ORDERING` block, ~line 357–382)

Background: the claude stub records the numbered notes a verification prompt showed it in
`devtools/_stub-verdict.txt` and endorses the last one. Today each note is the fact's TOPIC (its graph headline).
The harbour teahouse listing fact's content is `The harbour teahouse listing is verified at listing-id 4417 and
open on weekends.` — `listing-id 4417` appears only in content, never in a topic.

- [ ] **Step 1: Replace the two assertions after the fixture check**

Find:
```js
  ok('THE POINT: the endorsed candidate was NOT top of the pre-verdict ranking',
    shown[shown.length - 1] !== shown[0], JSON.stringify(shown));

  ok('...and it comes back at the top of the page',
    verdictPage[0]?.topic === shown[shown.length - 1],
    JSON.stringify({ endorsed: shown[shown.length - 1], page: verdictPage.map((f) => f.topic) }));
```
Replace with:
```js
  // THE JUDGE SEES THE FACT, NOT ITS LABEL. Lyntai's LLM verifier renders `{n}. {Headline}`, and the fact
  // index writes each fact's TOPIC as its headline — so the judge used to decide "did this answer?" from
  // topics alone. JudgeSeesContentPolicy hands it `topic — content`. `listing-id 4417` exists only in the
  // content of one fact, so its presence in the notes is proof the content arrived.
  ok('the judge is shown each fact’s CONTENT, not only its topic',
    shown.some((n) => n.includes('listing-id 4417')), JSON.stringify(shown));

  ok('THE POINT: the endorsed candidate was NOT top of the pre-verdict ranking',
    shown[shown.length - 1] !== shown[0], JSON.stringify(shown));

  // A note is now `topic — content`, so the endorsed note is matched by the topic it starts with.
  ok('...and it comes back at the top of the page',
    !!verdictPage[0]?.topic && String(shown[shown.length - 1] ?? '').startsWith(`${verdictPage[0].topic} — `),
    JSON.stringify({ endorsed: shown[shown.length - 1], page: verdictPage.map((f) => f.topic) }));
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `node devtools/dev.mjs e2e p48` (or port-shifted, see Conventions)
Expected: `✗ the judge is shown each fact’s CONTENT, not only its topic` and `✗ ...and it comes back at the top of the page`, with the `shown` list containing topics only. Every other p48 check passes.

(Do not commit yet — Task 2 makes it pass.)

### Task 2: `JudgeSeesContentPolicy`

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Services/MemoryEnrichmentPolicies.cs` (append a class)
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs` (the `IMemoryVerificationPolicy` registration)

- [ ] **Step 1: Add the decorator** at the end of `MemoryEnrichmentPolicies.cs`:

```csharp
/// <summary>Shows an LLM judge each candidate's CONTENT, not only its headline.
///
/// <para><b>Why.</b> Lyntai's <see cref="LlmMemoryVerificationPolicy"/> renders each candidate as
/// <c>"{n}. {Headline}"</c>, and the fact index writes a fact's TOPIC as its headline — so the judge decided
/// "did this answer the question?" from topics alone. Verified against the real claude CLI 2.1.280: a fact whose
/// topic was "weekend market" and whose content said when the market opens came back <c>answered=false</c>,
/// which is the correct verdict on what the judge was shown. Lyntai's D108 gave every verifier
/// <see cref="MemoryVerificationCandidate.Content"/> and left the choice of text to the POLICY; its reranker
/// policy reads content, its LLM policy has no option to.</para>
///
/// <para><b>A WORKAROUND FOR A LYNTAI GAP — delete it when the gap closes.</b> Filed as Lyntai TASKS.md
/// <b>Part 274</b> (a policy-level opt-in on <c>LlmVerificationOptions</c> to read <c>Content ?? Headline</c>).
/// When that ships, set the option where <see cref="Sources.JudgeWiring.Llm"/> builds the policy and delete
/// this class: the option would render the same text, so keeping both would only double the content.</para>
///
/// <para>Topics stay the STORED headline, so <c>expand_fact</c>'s neighbour list is unchanged; only what the judge
/// reads changes. <c>GATHERLIGHT_JUDGE_INPUT=headline</c> turns it off — a measurement knob for
/// <c>dev.mjs judge-bench</c>, not a setting.</para></summary>
public sealed class JudgeSeesContentPolicy : IMemoryVerificationPolicy
{
    /// <summary>The most one candidate may contribute. Facts are short; the cap exists so one pathological
    /// fact cannot multiply the cost of every recall that surfaces it.</summary>
    public const int MaxChars = 400;

    private readonly IMemoryVerificationPolicy _inner;

    public JudgeSeesContentPolicy(IMemoryVerificationPolicy inner) => _inner = inner;

    /// <summary>False only under the measurement knob.</summary>
    public static bool Enabled => !string.Equals(
        Environment.GetEnvironmentVariable("GATHERLIGHT_JUDGE_INPUT"), "headline", StringComparison.OrdinalIgnoreCase);

    public Task<MemoryVerification> VerifyAsync(MemoryVerificationRequest request, CancellationToken ct = default)
        => _inner.VerifyAsync(request with
        {
            Candidates = [.. request.Candidates.Select(c => c.Content is { Length: > 0 } content
                ? c with { Headline = Line($"{c.Headline} — {content}") }
                : c)],
        }, ct);

    /// <summary>ONE line, bounded. The judge's prompt is a numbered list, so a newline inside an entry would
    /// start a line the judge reads as another note — the same shape Lyntai's D166 fixed for recalled memory.</summary>
    internal static string Line(string text)
    {
        var flat = string.Join(' ', text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)).Trim();
        return flat.Length <= MaxChars ? flat : flat[..MaxChars] + "…";
    }
}
```

- [ ] **Step 2: Wrap the LLM verifier with it in `GatherlightApp.cs`**

Find:
```csharp
                b.Services.AddSingleton<Lyntai.Memory.Verification.IMemoryVerificationPolicy>(sp =>
                    new Platform.Agent.Llm.Services.SwitchableVerificationPolicy(
                        new Lyntai.Memory.Verification.LlmMemoryVerificationPolicy(
                            sp.GetRequiredService<Lyntai.Inference.ITextClientFactory>(),
                            new Lyntai.Memory.Verification.LlmVerificationOptions { ClientName = judgeClient },
                            sp.GetService<ILogger<Lyntai.Memory.Verification.LlmMemoryVerificationPolicy>>()),
                        sp.GetRequiredService<IAppConfigService>()));
```
Replace with:
```csharp
                b.Services.AddSingleton<Lyntai.Memory.Verification.IMemoryVerificationPolicy>(sp =>
                {
                    Lyntai.Memory.Verification.IMemoryVerificationPolicy llm =
                        new Lyntai.Memory.Verification.LlmMemoryVerificationPolicy(
                            sp.GetRequiredService<Lyntai.Inference.ITextClientFactory>(),
                            new Lyntai.Memory.Verification.LlmVerificationOptions { ClientName = judgeClient },
                            sp.GetService<ILogger<Lyntai.Memory.Verification.LlmMemoryVerificationPolicy>>());
                    // The judge reads `topic — content`, not the topic headline — see JudgeSeesContentPolicy.
                    if (Platform.Agent.Llm.Services.JudgeSeesContentPolicy.Enabled)
                        llm = new Platform.Agent.Llm.Services.JudgeSeesContentPolicy(llm);
                    return new Platform.Agent.Llm.Services.SwitchableVerificationPolicy(
                        llm, sp.GetRequiredService<IAppConfigService>());
                });
```

- [ ] **Step 3: Build and run p48**

Run: `dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -nologo -v q` → `Build succeeded.`
Run: `node devtools/dev.mjs e2e p48` → `e2e-p48 PASS`

- [ ] **Step 4: Confirm the other memory suites are unaffected**

Run: `node devtools/dev.mjs e2e p51,p52` → both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Llm/Services/MemoryEnrichmentPolicies.cs src/server/Gatherlight.Server/GatherlightApp.cs devtools/scripts/e2e/p48.mjs
git commit -m "fix(memory): the Claude judge saw fact TOPICS, never the facts

Lyntai's LLM verifier renders each candidate as its headline, and the fact index stores a fact's
topic as its headline — so 判断 decided \"did this answer?\" from labels. Against the real CLI a fact
that plainly answered came back answered=false. JudgeSeesContentPolicy hands the judge
'topic — content' (one line, capped at 400 chars); topics stay the stored headline. Workaround for
Lyntai TASKS Part 274, recorded on both sides. p48 asserts the notes carry content and failed before.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

# Part B — fixture, bench, knobs, Claude-judge arms

### Task 3: Extract question generation into a shared module

**Files:**
- Create: `devtools/scripts/recall-questions.mjs`
- Modify: `devtools/scripts/recall-bench.mjs` (remove the moved definitions, import them)

- [ ] **Step 1: Create `devtools/scripts/recall-questions.mjs`**

```js
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
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    return QUESTION_SETS.every((s) => typeof o[s.key] === 'string' && o[s.key].length >= 4 && o[s.key].length <= 200)
      ? Object.fromEntries(QUESTION_SETS.map((s) => [s.key, o[s.key].trim()]))
      : null;
  } catch {
    return null;
  }
};
```

- [ ] **Step 2: Make `recall-bench.mjs` import it**

In `devtools/scripts/recall-bench.mjs`:
1. Add after the existing imports: `import { QUESTION_SETS, hasCjk, resolveClaude, askIn } from './recall-questions.mjs';`
2. Delete the local definitions of `resolveClaude`, `QUESTION_SETS`, `hasCjk`, `askIn` and the unused `askForQuestion` (keep the long explanatory comments above `QUESTION_SETS` — they now describe the imported constant; move them to sit above the import if they read oddly).
3. Keep `const claude = resolveClaude();`.
4. Change the call `const q = askIn(f, set);` to `const q = askIn(claude, f, set);`.
5. If `hasCjk` is now unused in recall-bench, drop it from the import.

- [ ] **Step 3: Verify both files parse and recall-bench still starts**

Run: `node --check devtools/scripts/recall-questions.mjs && node --check devtools/scripts/recall-bench.mjs && echo ok` → `ok`
Run (no server on 59999): `GATHERLIGHT_URL=http://127.0.0.1:59999 node devtools/scripts/recall-bench.mjs`
Expected: `no server at http://127.0.0.1:59999 — start one …` (proves the module graph loads).

- [ ] **Step 4: Commit**

```bash
git add devtools/scripts/recall-questions.mjs devtools/scripts/recall-bench.mjs
git commit -m "refactor(devtools): question generation is one module, shared by recall-bench and the fixture

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 4: The authored facts

**Files:** Create `devtools/fixtures/recall-bilingual.facts.json`

Composition rules (why each exists): ~⅔ Chinese, the rest English and some Japanese; **near-duplicate clusters**
(two markets, three museum prices incl. a superseded one, two pools, two noodle shops…) so a ranking has something
to get wrong — without them every arm ties and the bench cannot express an effect. All content is invented, and people appear only as neutral roles (家长A, 大孩子, 长辈) — the pre-commit guard bans family-role words, and the fixture must pass it.

- [ ] **Step 1: Write the file exactly as below**

```json
[
  { "id": "mkt-east", "kind": "venue", "topic": "东门农贸市场营业时间", "content": "东门农贸市场每周六、周日早上七点开门,中午十二点收摊,周一到周五不开。" },
  { "id": "mkt-west", "kind": "venue", "topic": "西街夜市营业时间", "content": "西街夜市只在周五和周六晚上营业,从傍晚六点开到十一点。" },
  { "id": "mkt-harbor", "kind": "venue", "topic": "Harbor fish market hours", "content": "The harbor fish market opens at 5 a.m. on weekdays and is closed on Sundays." },
  { "id": "museum-adult", "kind": "price", "topic": "市立博物馆成人票价", "content": "市立博物馆成人门票现在是六十元,2026年7月起执行。" },
  { "id": "museum-adult-old", "kind": "price", "topic": "市立博物馆旧票价", "content": "2026年7月之前,市立博物馆成人门票是四十五元,这个价格已经不用了。" },
  { "id": "museum-child", "kind": "price", "topic": "市立博物馆儿童票", "content": "身高一米二以下的儿童进市立博物馆免费,一米二到一米四半价。" },
  { "id": "lib-weekday", "kind": "venue", "topic": "Riverside Library weekday hours", "content": "Riverside Library is open 9 a.m. to 8 p.m. Monday through Friday." },
  { "id": "lib-weekend", "kind": "venue", "topic": "Riverside Library weekend hours", "content": "On Saturdays Riverside Library closes early at 4 p.m., and it is closed all day Sunday." },
  { "id": "pool-north", "kind": "venue", "topic": "北区游泳馆休息日", "content": "北区游泳馆每周二闭馆做水质消毒,其他日子早上六点开门。" },
  { "id": "pool-south", "kind": "venue", "topic": "南湖露天泳池开放时间", "content": "南湖游泳馆是露天泳池,只在六月到九月开放,每天下午一点到晚上八点。" },
  { "id": "pharm-24h", "kind": "venue", "topic": "二十四小时药店", "content": "火车站旁边的健民药房二十四小时营业,半夜也能买到退烧药。" },
  { "id": "pharm-local", "kind": "venue", "topic": "小区门口药店", "content": "小区门口的药店晚上九点就关门,周日下午不营业。" },
  { "id": "passport", "kind": "household", "topic": "护照有效期", "content": "家长A的护照2027年3月到期,出国前要确认剩余有效期超过六个月。" },
  { "id": "visa", "kind": "household", "topic": "日本签证有效期", "content": "家长B的日本多次往返签证有效期到2028年1月,每次停留不超过三十天。" },
  { "id": "id-card", "kind": "household", "topic": "孩子身份证换领", "content": "孩子的身份证明年五月到期,需要本人去派出所拍照换领。" },
  { "id": "school-pickup", "kind": "schedule", "topic": "放学接孩子时间", "content": "小学周一到周四下午三点半放学,周五提前到两点四十。" },
  { "id": "school-dropoff", "kind": "schedule", "topic": "早上送孩子时间", "content": "早上七点四十之前必须送到校门口,迟到要登记。" },
  { "id": "school-lunch", "kind": "price", "topic": "School lunch payment", "content": "School lunch is paid monthly through the parents' app, 280 yuan per month." },
  { "id": "allergy-peanut", "kind": "health", "topic": "花生过敏", "content": "小的那个孩子对花生严重过敏,外出吃饭要提前告诉店家,随身带肾上腺素笔。" },
  { "id": "allergy-shellfish", "kind": "health", "topic": "Shellfish allergy", "content": "One grandparent is allergic to shellfish — shrimp and crab cause hives, but fish is fine." },
  { "id": "car-insurance", "kind": "household", "topic": "车险续保", "content": "家里的车险每年十月十五号到期,去年是在线上续的,保费四千二。" },
  { "id": "car-inspection", "kind": "household", "topic": "车辆年检", "content": "车辆年检是每两年一次,下一次在2027年6月之前办完。" },
  { "id": "rest-noodle", "kind": "venue", "topic": "老街面馆", "content": "老街面馆周一休息,牛肉面二十八元一碗,晚上八点以后不接新客。" },
  { "id": "rest-noodle2", "kind": "venue", "topic": "新街面馆", "content": "新街面馆全年无休,招牌是番茄鸡蛋面,可以提前电话订座。" },
  { "id": "rest-sushi", "kind": "venue", "topic": "駅前の寿司屋", "content": "駅前の寿司屋は水曜日が定休日で、ランチは十一時半から二時まで。" },
  { "id": "train-express", "kind": "travel", "topic": "Express train fare to the coast", "content": "The express train to the coast costs 120 yuan one way and takes 55 minutes." },
  { "id": "train-local", "kind": "travel", "topic": "Local train fare to the coast", "content": "The local train to the coast is only 35 yuan but takes two and a half hours with many stops." },
  { "id": "hotel-lake", "kind": "policy", "topic": "湖边酒店取消政策", "content": "湖边酒店入住前三天可以免费取消,之后取消扣一晚房费。" },
  { "id": "hotel-mountain", "kind": "policy", "topic": "山顶民宿取消政策", "content": "山顶民宿订了就不能退,但可以免费改期一次。" },
  { "id": "trash-day", "kind": "schedule", "topic": "垃圾分类投放时间", "content": "可回收垃圾每周三早上收,厨余垃圾每天晚上七点到九点投放。" },
  { "id": "dentist", "kind": "health", "topic": "牙齿矫正复诊", "content": "大孩子的牙齿矫正每六周复诊一次,下次在十一月八号上午。" },
  { "id": "piano", "kind": "schedule", "topic": "钢琴课", "content": "钢琴课每周六下午两点,一节课一百八十元,请假要提前一天说。" },
  { "id": "swim-class", "kind": "schedule", "topic": "Swimming lessons", "content": "The kids' swimming lessons run on Tuesday evenings and the term costs 1,200 yuan." },
  { "id": "gym", "kind": "policy", "topic": "Gym membership renewal", "content": "The gym membership renews automatically every January; cancel before December 20 to avoid the charge." },
  { "id": "vet", "kind": "health", "topic": "猫咪疫苗", "content": "家里的猫每年三月打一次三联疫苗,狂犬疫苗是九月。" },
  { "id": "cat-food", "kind": "household", "topic": "猫粮口味", "content": "猫只吃鸡肉味的干粮,换牌子会拉肚子。" },
  { "id": "plant", "kind": "household", "topic": "阳台柠檬树浇水", "content": "阳台的柠檬树夏天每两天浇一次水,冬天一周一次。" },
  { "id": "power-bill", "kind": "household", "topic": "电费缴纳", "content": "电费每月二十号自动扣款,绑定的是工资卡。" },
  { "id": "water-bill", "kind": "household", "topic": "水费", "content": "水费两个月收一次,上次是一百一十元。" },
  { "id": "internet", "kind": "household", "topic": "Home internet plan", "content": "The home internet plan is 500 Mbps and the contract ends in April 2027." },
  { "id": "parking", "kind": "price", "topic": "小区停车", "content": "小区地下车位月租三百元,访客车只能停两个小时。" },
  { "id": "bike", "kind": "price", "topic": "共享单车月卡", "content": "共享单车月卡十五元,每次骑行前两小时免费。" },
  { "id": "airport", "kind": "travel", "topic": "Getting to the airport", "content": "A taxi to the airport takes about 50 minutes and costs around 150 yuan; the airport bus is 30 yuan." },
  { "id": "hospital", "kind": "health", "topic": "儿科专家号", "content": "儿童医院的专家号每天早上八点在手机上放号,几分钟就会抢完。" },
  { "id": "bank", "kind": "venue", "topic": "银行周末营业", "content": "附近的银行支行周末只开半天,上午九点到十二点。" },
  { "id": "post", "kind": "venue", "topic": "Elm Street post office", "content": "The post office on Elm Street handles international parcels only on weekday mornings." },
  { "id": "grandma-bday", "kind": "household", "topic": "长辈生日", "content": "家里长辈的生日是农历八月初三,每年要提前订好蛋糕。" },
  { "id": "anniversary", "kind": "household", "topic": "Wedding anniversary", "content": "The wedding anniversary is on May 20th, and the tradition is dinner by the river." },
  { "id": "hotpot", "kind": "venue", "topic": "火锅店排队", "content": "周末去那家火锅店要提前在小程序取号,一般要等一个小时。" },
  { "id": "onsen", "kind": "travel", "topic": "温泉旅館の予約", "content": "温泉旅館は二ヶ月前から予約でき、夕食付きプランは一人二万円。" },
  { "id": "ramen", "kind": "venue", "topic": "近所のラーメン屋", "content": "近所のラーメン屋は深夜二時まで営業していて、替え玉は無料。" },
  { "id": "konbini", "kind": "household", "topic": "コンビニでの荷物受け取り", "content": "コンビニで荷物を受け取るときは、アプリのバーコードを見せればいい。" },
  { "id": "summer-camp", "kind": "schedule", "topic": "夏令营报名", "content": "夏令营每年四月一号开始报名,名额满了就截止,费用三千八。" },
  { "id": "flu-shot", "kind": "health", "topic": "Flu vaccine", "content": "Everyone in the family gets a flu shot in October at the community clinic, free for children." },
  { "id": "ski", "kind": "travel", "topic": "滑雪场租雪具", "content": "滑雪场的雪具可以现场租,一天一百五十元,儿童教练要提前一周预约。" },
  { "id": "zoo", "kind": "price", "topic": "Zoo tickets", "content": "Zoo tickets are cheaper when bought online the day before — 80 yuan instead of 100." },
  { "id": "laundry", "kind": "price", "topic": "楼下干洗店", "content": "楼下的干洗店洗一件大衣三十五元,三天后取。" },
  { "id": "babysitter", "kind": "price", "topic": "Babysitter rates", "content": "The babysitter charges 50 yuan an hour and needs to be booked two days ahead." },
  { "id": "movie", "kind": "price", "topic": "电影院会员日", "content": "商场电影院每周二是会员日,票价半价。" }
]
```

- [ ] **Step 2: Validate it**

Run: `node -e "const f=require('./devtools/fixtures/recall-bilingual.facts.json');const ids=new Set(f.map(x=>x.id));console.log(f.length, ids.size, f.every(x=>x.id&&x.kind&&x.topic&&x.content.length>=20))"`
Expected: `60 60 true`
Run: `node devtools/scripts/check-sensitive.mjs --tree` → `clean`.

(Commit together with the generated fixture in Task 5.)

### Task 5: Generate the questions and commit the fixture

**Files:**
- Create: `devtools/scripts/judge-bench-fixture.mjs`
- Create (generated): `devtools/fixtures/recall-bilingual.json`

- [ ] **Step 1: Create the generator**

```js
#!/usr/bin/env node
// judge-bench-fixture.mjs — writes devtools/fixtures/recall-bilingual.json: the authored facts
// (recall-bilingual.facts.json) plus four questions each, generated through the CLI so they are written
// independently of whoever wrote the facts. Re-runnable: a fact whose topic and content are unchanged keeps
// its questions, so editing one fact costs one call, not sixty.
//
// Usage: node devtools/scripts/judge-bench-fixture.mjs      (uses the signed-in claude CLI)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { askAll, resolveClaude, QUESTION_SETS } from './recall-questions.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FACTS = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.facts.json');
const OUT = path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json');

const facts = JSON.parse(fs.readFileSync(FACTS, 'utf8'));
const held = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { facts: [] };
const prior = new Map(held.facts.map((f) => [f.id, f]));
const claude = resolveClaude();

let asked = 0;
const failed = [];
const out = facts.map((f) => {
  const was = prior.get(f.id);
  if (was && was.topic === f.topic && was.content === f.content && was.questions) return { ...f, questions: was.questions };
  let q = null;
  for (let attempt = 0; attempt < 2 && !q; attempt++) q = askAll(claude, f);
  asked++;
  process.stdout.write(`\r  questions: ${asked} fact(s) asked…   `);
  if (!q) failed.push(f.id);
  return { ...f, questions: q };
});

fs.writeFileSync(OUT, JSON.stringify({
  generatedBy: 'devtools/scripts/judge-bench-fixture.mjs',
  sets: QUESTION_SETS.map((s) => s.key),
  facts: out,
}, null, 2) + '\n', 'utf8');
console.log(`\nwrote ${out.length} facts (${asked} asked, ${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''})`);
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: Run it** (≈60 haiku-sized CLI calls; a few minutes)

Run: `node devtools/scripts/judge-bench-fixture.mjs`
Expected: `wrote 60 facts (60 asked, 0 failed)`. On failures, re-run — reused facts cost nothing.

- [ ] **Step 3: Review the questions** — this is a real step, not a formality

Run: `node -e "const f=require('./devtools/fixtures/recall-bilingual.json').facts;for(const x of f)console.log(x.id,'|',x.content,'\n  ',JSON.stringify(x.questions))" | less`
Check, and hand-edit `recall-bilingual.json` where violated:
1. Every question is answered by ITS fact and not equally by its near-duplicate (e.g. the `museum-adult` question must ask the CURRENT price, not "how much was it").
2. No question copies the fact's distinctive words (e.g. a `same` question for `mkt-east` must not say 东门农贸市场).
3. `cross`/`third`/`mixed` are really in English/Japanese/code-switched as their key says.

- [ ] **Step 4: Commit the fixture**

```bash
node devtools/scripts/check-sensitive.mjs --tree
git add devtools/fixtures/recall-bilingual.facts.json devtools/fixtures/recall-bilingual.json devtools/scripts/judge-bench-fixture.mjs
git commit -m "test(devtools): a committed bilingual recall fixture — 60 invented facts with near-duplicates, 4 questions each

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 6: Measurement knobs

**Files:** Modify `src/server/Gatherlight.Server/GatherlightApp.cs`

- [ ] **Step 1: Read the knobs and announce them** — directly after `var semanticOn = …;` add:

```csharp
        // MEASUREMENT KNOBS — read by `dev.mjs judge-bench` (docs/judge-bench.md), never settings. Each one
        // that is active says so on the console, because the bench refuses to report an arm whose knob did
        // not take: two arms that silently ran the same configuration would read as "no difference".
        var fuseVerdicts = string.Equals(
            Environment.GetEnvironmentVariable("GATHERLIGHT_VERDICT_COMBINATION"), "fuse", StringComparison.OrdinalIgnoreCase);
        if (fuseVerdicts) Console.WriteLine("[measurement] verdict combination = Fuse (GATHERLIGHT_VERDICT_COMBINATION)");
        if (!Platform.Agent.Llm.Services.JudgeSeesContentPolicy.Enabled)
            Console.WriteLine("[measurement] judge input = headline only (GATHERLIGHT_JUDGE_INPUT)");
```

- [ ] **Step 2: Apply the combination** — replace `.AddMemoryEngine("facts", e => e.UseGraph());` with:

```csharp
                .AddMemoryEngine("facts", e => e.UseGraph(fuseVerdicts
                    ? new Lyntai.Memory.GraphMemoryOptions
                        { VerdictCombination = Lyntai.Memory.Verification.MemoryVerdictCombination.Fuse }
                    : null));
```

- [ ] **Step 3: Build, then prove each knob announces itself**

Run: `dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -nologo -v q` → `Build succeeded.`
Run:
```bash
node --input-type=module -e "
import { makeTestData, startServer, waitHealthy } from './devtools/scripts/e2e/_e2e-common.mjs';
const d = process.cwd() + '/devtools/_knob-check'; makeTestData(d);
const s = startServer({ dataDir: d, port: 5415, env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse', GATHERLIGHT_JUDGE_INPUT: 'headline' } });
try { await waitHealthy(s.base); console.log(s.log().split('\n').filter((l) => l.includes('[measurement]')).join('\n')); } finally { s.stop(); }"
```
Expected: both `[measurement] …` lines printed.

- [ ] **Step 4: Commit**

```bash
git add src/server/Gatherlight.Server/GatherlightApp.cs
git commit -m "feat(devtools): measurement-only knobs for the verdict combination and the judge's input

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 7: `judge-bench`

**Files:**
- Create: `devtools/scripts/judge-bench.mjs`
- Modify: `devtools/dev.mjs` (header usage comment, a `case 'judge-bench'`, the usage line)

- [ ] **Step 1: Create `devtools/scripts/judge-bench.mjs`**

```js
#!/usr/bin/env node
// judge-bench.mjs — what each way of JUDGING a recall is worth, on the committed bilingual fixture.
//
// WHY SNAPSHOTS. A recall reinforces what it returns and links it, so a run mutates what it measures. The
// combination and the reranker are STARTUP choices, so the within-run pairing recall-bench uses is
// impossible here. Instead ONE data folder is seeded, copied once per arm, and every arm answers the SAME
// questions in the SAME order from the SAME starting graph. Each arm's own drift is part of its effect.
//
// PRIVACY. The fixture is invented and committed; this touches no household data. Reranker arms READ the
// llama.cpp binary and GGUFs from --resources (default local/state/resources) and nothing else there.
//
// Usage:
//   node devtools/dev.mjs judge-bench                                 # formula, topic, content, fuse
//   node devtools/dev.mjs judge-bench --arms=formula,content --n=20
//   node devtools/dev.mjs judge-bench --arms=formula --rerankers=LAMAR-600m.Q5_K_M,bge-reranker-v2-m3-Q5_K_M
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeTestData, startServer, waitHealthy, makeClient, until, repo } from './e2e/_e2e-common.mjs';
import { resolveClaude, QUESTION_SETS } from './recall-questions.mjs';

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const FIXTURE = JSON.parse(fs.readFileSync(path.join(repo, 'devtools', 'fixtures', 'recall-bilingual.json'), 'utf8'));
const LIMIT = 8;
const PORT_BASE = Number(arg('port-base', '5620'));
const LLAMA_PORT = Number(arg('llama-port', '5660'));
const WORK = path.join(repo, 'devtools', '_judge-bench');
const RESOURCES = path.resolve(arg('resources', path.join(repo, 'local', 'state', 'resources')));

// A deterministic stride sample, so --n=20 covers every cluster rather than the first twenty rows.
const all = FIXTURE.facts.filter((f) => f.questions);
const N = Math.min(Number(arg('n', String(all.length))), all.length);
const stride = all.length / N;
const facts = Array.from({ length: N }, (_, i) => all[Math.floor(i * stride)]);

const ARMS = {
  formula: { label: '公式 only (判断 off)', enrichment: false, env: {} },
  topic: { label: 'Claude judge · topic only', enrichment: true,
    env: { GATHERLIGHT_JUDGE_INPUT: 'headline' }, knob: /judge input = headline/ },
  content: { label: 'Claude judge · content · partition', enrichment: true, env: {} },
  fuse: { label: 'Claude judge · content · fuse', enrichment: true,
    env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse' }, knob: /verdict combination = Fuse/ },
};
const arms = arg('arms', 'formula,topic,content,fuse').split(',').filter(Boolean).map((k) => {
  if (!ARMS[k]) throw new Error(`unknown arm '${k}' — one of ${Object.keys(ARMS).join(', ')}`);
  return { key: k, ...ARMS[k] };
});
const rerankers = arg('rerankers', '').split(',').filter(Boolean);
for (const m of rerankers) {
  arms.push({ key: `rr:${m}`, label: `reranker ${m} · partition`, enrichment: true, env: {}, reranker: m });
  arms.push({ key: `rrf:${m}`, label: `reranker ${m} · fuse`, enrichment: true,
    env: { GATHERLIGHT_VERDICT_COMBINATION: 'fuse' }, knob: /verdict combination = Fuse/, reranker: m });
}

const claude = resolveClaude();
const servers = [];
let router = null;
const stopAll = () => {
  for (const s of servers) try { s.stop(); } catch { /* best effort */ }
  try { router?.kill(); } catch { /* best effort */ }
};

try {
  // ---- 1. seed ONE folder (real CLI, so annotation writes subject tags) ------------------------------------
  fs.rmSync(WORK, { recursive: true, force: true });
  const seedDir = path.join(WORK, 'seed');
  makeTestData(seedDir);
  const seed = startServer({ dataDir: seedDir, port: PORT_BASE, env: { GATHERLIGHT_CLAUDE_CMD: claude } });
  servers.push(seed);
  await waitHealthy(seed.base);
  const sc = makeClient(seed.base);
  const idOf = new Map();
  for (const [i, f] of FIXTURE.facts.entries()) {
    const w = await sc.call('remember_fact', {
      kind: f.kind, topic: f.topic, content: f.content, source: `https://example.test/${f.id}`, confidence: 0.8,
    });
    if (w.result?.ok !== true) throw new Error(`seed: ${f.id} → ${JSON.stringify(w.result)}`);
    idOf.set(f.id, Number(w.result.id));
    process.stdout.write(`\r  seeding ${i + 1}/${FIXTURE.facts.length}   `);
  }
  seed.stop();
  servers.length = 0;
  await until(async () => { try { await fetch(`${seed.base}/api/health`); return false; } catch { return true; } }, 60000);

  // ---- 2. the reranker arms share ONE real router, started here ---------------------------------------------
  // Each arm's own resources get EMPTY stand-ins for the runtime and the model, which is all IsConfigured asks;
  // the arm then ADOPTS this router at GATHERLIGHT_LLAMACPP_URL (EnsureServingAsync probes before it spawns).
  if (rerankers.length > 0) {
    const exe = path.join(RESOURCES, 'llama-cpp', 'llama-server.exe');
    const gguf = path.join(RESOURCES, 'gguf');
    if (!fs.existsSync(exe)) throw new Error(`no llama-server at ${exe} — download llama.cpp in 资源 first`);
    for (const m of rerankers)
      if (!fs.existsSync(path.join(gguf, `${m}.gguf`))) throw new Error(`${m}.gguf is not in ${gguf} — download it in 资源 first`);
    const preset = path.join(WORK, 'presets.ini');
    fs.writeFileSync(preset, rerankers.map((m) =>
      `[${m}]\nn-gpu-layers = 99\nreranking = true\nctx-size = 4096\nbatch-size = 4096\nubatch-size = 4096\n`).join('\n'));
    router = spawn(exe, ['--models-dir', gguf, '--models-preset', preset, '--models-max', '2',
      '--host', '127.0.0.1', '--port', String(LLAMA_PORT)], { cwd: path.dirname(exe), stdio: 'ignore' });
    await until(async () => (await fetch(`http://127.0.0.1:${LLAMA_PORT}/v1/models`)).ok, 60000);
  }

  // ---- 3. one snapshot + one server per arm ------------------------------------------------------------------
  for (const [i, arm] of arms.entries()) {
    const dir = path.join(WORK, `arm-${i}`);
    fs.cpSync(seedDir, dir, { recursive: true });
    fs.rmSync(path.join(dir, 'state', 'logs'), { recursive: true, force: true });
    const env = { GATHERLIGHT_CLAUDE_CMD: claude, ...arm.env };
    if (arm.reranker) {
      const res = path.join(dir, 'state', 'resources');
      fs.mkdirSync(path.join(res, 'llama-cpp'), { recursive: true });
      fs.mkdirSync(path.join(res, 'gguf'), { recursive: true });
      fs.writeFileSync(path.join(res, 'llama-cpp', 'llama-server.exe'), '');
      fs.writeFileSync(path.join(res, 'gguf', `${arm.reranker}.gguf`), '');
      const settingsPath = path.join(dir, 'state', 'settings.json');
      const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
      settings.memory = { ...(settings.memory ?? {}), judgeSource: 'llama-cpp', judgeModel: arm.reranker };
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      env.GATHERLIGHT_LLAMACPP_URL = `http://127.0.0.1:${LLAMA_PORT}`;
    }
    arm.srv = startServer({ dataDir: dir, port: PORT_BASE + 1 + i, env });
    servers.push(arm.srv);
  }
  for (const arm of arms) {
    await waitHealthy(arm.srv.base);
    // NON-VACUITY: an arm whose knob or binding did not take would silently duplicate another arm.
    if (arm.knob && !arm.knob.test(arm.srv.log())) throw new Error(`arm ${arm.key}: its knob did not announce itself`);
    if (arm.reranker) {
      const judge = ((await makeClient(arm.srv.base).getJson('/api/manage/memory')).layers ?? []).find((l) => l.id === 'judge');
      if (judge?.activeModel !== arm.reranker) throw new Error(`arm ${arm.key}: judge is running ${judge?.activeModel}, not ${arm.reranker}`);
    }
    await makeClient(arm.srv.base).post('/api/manage/memory/enrichment', { enabled: arm.enrichment });
  }

  // ---- 4. identical questions, identical order, every arm in parallel ----------------------------------------
  const queries = facts.flatMap((f) => QUESTION_SETS.map((s) => ({ fact: f.id, set: s.key, q: f.questions[s.key] })));
  await Promise.all(arms.map(async (arm) => {
    const c = makeClient(arm.srv.base);
    arm.rows = [];
    for (const x of queries) {
      const t0 = Date.now();
      const r = await c.call('recall_facts', { query: x.q, limit: LIMIT });
      const ids = (r.result?.facts ?? []).map((f) => Number(f.id));
      arm.rows.push({ ...x, pos: ids.indexOf(idOf.get(x.fact)), ms: Date.now() - t0, answered: r.result?.answered ?? null });
    }
  }));

  // ---- 5. report — numbers and ids only ---------------------------------------------------------------------
  const stat = (rows) => ({
    n: rows.length,
    top1: rows.filter((r) => r.pos === 0).length,
    found: rows.filter((r) => r.pos >= 0).length,
    mrr: rows.reduce((a, r) => a + (r.pos >= 0 ? 1 / (r.pos + 1) : 0), 0) / Math.max(1, rows.length),
    ms: Math.round(rows.reduce((a, r) => a + r.ms, 0) / Math.max(1, rows.length)),
    judged: rows.filter((r) => r.answered !== null).length,
  });
  const base = arms.find((a) => a.key === 'formula');
  const report = { fixture: 'devtools/fixtures/recall-bilingual.json', facts: N, limit: LIMIT, at: new Date().toISOString(), sets: {} };
  for (const set of [...QUESTION_SETS.map((s) => s.key), 'all']) {
    console.log(`\n== ${set} ==`);
    console.log('arm'.padEnd(46) + 'top-1   found@8  MRR     ms     judged  vs 公式 (top-1 / found)');
    report.sets[set] = {};
    for (const arm of arms) {
      const s = stat(arm.rows.filter((r) => set === 'all' || r.set === set));
      report.sets[set][arm.key] = s;
      let delta = '';
      if (base && arm !== base) {
        const b = stat(base.rows.filter((r) => set === 'all' || r.set === set));
        delta = `${s.top1 - b.top1 >= 0 ? '+' : ''}${s.top1 - b.top1} / ${s.found - b.found >= 0 ? '+' : ''}${s.found - b.found}`;
      }
      console.log(arm.label.padEnd(46)
        + `${s.top1}/${s.n}`.padEnd(8) + `${s.found}/${s.n}`.padEnd(9) + s.mrr.toFixed(3).padEnd(8)
        + String(s.ms).padEnd(7) + String(s.judged).padEnd(8) + delta);
    }
  }
  fs.writeFileSync(path.join(WORK, 'results.json'),
    JSON.stringify({ ...report, rows: Object.fromEntries(arms.map((a) => [a.key, a.rows])) }, null, 2));
  console.log(`\nraw rows: ${path.join(WORK, 'results.json')}`);
} finally {
  stopAll();
}
```

- [ ] **Step 2: Register it in `devtools/dev.mjs`**

1. In the header usage comment block, after the `embed-bench` line add:
   `//   node devtools/dev.mjs judge-bench [--arms=…] [--rerankers=…] [--n=…] - what each way of judging a recall is worth (docs/judge-bench.md)`
2. After the `case 'recall-bench': … break;` block add:
```js
  case 'judge-bench':
    // What each way of JUDGING a recall is worth, on the committed bilingual fixture — no household data.
    // Seeds one folder, snapshots it per arm, one server per arm; see the script header for why.
    run('node', [path.join(repo, 'devtools', 'scripts', 'judge-bench.mjs'), ...args]);
    break;
```
3. In the `console.log('usage: …')` line change `|recall-bench|` to `|recall-bench|judge-bench|`.

- [ ] **Step 3: Smoke-run the cheapest arm only**

Run: `node devtools/dev.mjs judge-bench --arms=formula --n=4`
Expected: seeding progress to 60 (the seed always loads every fact — ~60 annotation calls), then five tables (`same`, `cross`, `third`, `mixed`, `all`) each with one `公式 only` row of `n = 4`, and `raw rows: …results.json`. `judged` is 0 (判断 off).

- [ ] **Step 4: Commit**

```bash
git add devtools/scripts/judge-bench.mjs devtools/dev.mjs
git commit -m "feat(devtools): judge-bench — every way of judging a recall, on one fixture, from identical snapshots

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 8: Run the Claude-judge arms and record them

**Files:** Create `docs/judge-bench.md`

- [ ] **Step 1: Run** (≈720 recalls with a CLI judge call each, arms in parallel; about an hour)

Run: `node devtools/dev.mjs judge-bench --arms=formula,topic,content,fuse > devtools/_judge-bench-cli.txt 2>&1`
Expected: the five tables at the end of the file. If a seed or arm error aborts, fix the cause and re-run — do not report partial tables.

- [ ] **Step 2: Write `docs/judge-bench.md`** with the measured numbers (copy the `all` table and the four per-set tables verbatim from `devtools/_judge-bench-cli.txt`), in this structure:

```markdown
# judge-bench — what each way of judging a recall is worth

Measured with `node devtools/dev.mjs judge-bench` on `devtools/fixtures/recall-bilingual.json` (60 invented
facts incl. near-duplicate clusters; four questions each: same / cross / third language / code-switched),
`limit 8`, one snapshot per arm. Date, claude CLI version, and the exact command go in each run's heading.

## Run 1 — the Claude judge (YYYY-MM-DD, claude X.Y.Z)

<the five tables>

### What it says
- topic-only vs content: <the measured difference, per set>
- content partition vs fuse: <the measured difference, per set>
- latency: <ms per recall per arm>

### What it does NOT say
- One fixture, 60 facts, one run per arm. A difference of one or two questions is inside noise.
- Arms drift independently after the shared start; that drift is part of each arm's effect.
```

Fill the "What it says" bullets from the numbers only. **Decision rules (write the one that applies):**
- If `content` beats `topic` on top-1 or found@8 in `all` → the Task 2 fix is confirmed; say by how much.
- If `content` is WORSE than `topic` → stop and report to the owner before Part C; do not rationalise it.
- `fuse` changes the product default ONLY as a separate, owner-approved decision, and only if it beats
  `content` (partition) in `all` without losing in any set. Otherwise record it as insurance, per Lyntai.

- [ ] **Step 3: Commit**

```bash
node devtools/dev.mjs check-doc-refs
git add docs/judge-bench.md
git commit -m "docs(measure): the Claude judge on the bilingual fixture — topic-only vs content, partition vs fuse

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

# Part C — the llama.cpp reranker as 判断

### Task 9: GATE — the real llama-server serves `/v1/rerank` from a router preset

Everything after this depends on router mode honouring a per-model `reranking = true`. Prove it on the real
binary first. **If any step fails, STOP and report to the owner** — the fallback (a second, dedicated
`--reranking` process) is a different design.

**Files:** Modify `docs/self-managed-llm-runtime.md` (append a dated section)

- [ ] **Step 1: Download LAMAR and verify its checksum** (468 MB)

```bash
mkdir -p devtools/_rerank-gate/gguf
curl -L --fail -o devtools/_rerank-gate/gguf/LAMAR-600m.Q5_K_M.gguf \
  "https://huggingface.co/mradermacher/LAMAR-600m-GGUF/resolve/cd4da764d5b17d9996710dbf0ef5ad31c9aed182/LAMAR-600m.Q5_K_M.gguf"
sha256sum devtools/_rerank-gate/gguf/LAMAR-600m.Q5_K_M.gguf
```
Expected: `ec708b20336577c63702dd8efb23060bc611933579572bf9ad47ce2eaeda546f`

- [ ] **Step 2: Start the installed llama-server in router mode with a reranker preset**

```bash
printf '[LAMAR-600m.Q5_K_M]\nn-gpu-layers = 99\nreranking = true\nctx-size = 4096\nbatch-size = 4096\nubatch-size = 4096\n' > devtools/_rerank-gate/presets.ini
( cd local/state/resources/llama-cpp && ./llama-server.exe --models-dir ../../../../devtools/_rerank-gate/gguf \
    --models-preset ../../../../devtools/_rerank-gate/presets.ini --models-max 2 --host 127.0.0.1 --port 5661 ) &
sleep 5; curl -s http://127.0.0.1:5661/v1/models
```
Expected: JSON listing `LAMAR-600m.Q5_K_M`.

- [ ] **Step 3: Rerank a Chinese pair where the answer is SECOND in input order**

```bash
curl -s http://127.0.0.1:5661/v1/rerank -H 'content-type: application/json' -d '{"model":"LAMAR-600m.Q5_K_M","query":"市场周末几点开门?","documents":["图书馆周一闭馆。","东门市场周六周日早上七点开门。"],"top_n":2}'
```
Expected: `results` with `index 1` carrying the higher `relevance_score`. Repeat with an English query over the
same Chinese documents (`"What time does the market open on weekends?"`) — index 1 must still win.

- [ ] **Step 4: Stop it and record the result**

Kill the process (`taskkill //F //IM llama-server.exe` only if no other llama-server of yours is running;
otherwise kill by the PID `$!` printed). Append to `docs/self-managed-llm-runtime.md`:

```markdown
## 2026-09-23 — a RERANKER in router mode (gate for 判断's reranker arm)

Build `llama-server --version` → <paste>. Preset section `reranking = true` + `ctx-size`/`batch-size`/
`ubatch-size = 4096` (a cross-encoder needs the whole pair in one physical batch). `/v1/models` listed the model;
`/v1/rerank` on 「市场周末几点开门?」 over [图书馆周一闭馆。, 东门市场周六周日早上七点开门。] ranked index 1 first
(<scores>); the English query over the same Chinese documents also ranked index 1 first (<scores>).
First call (model load) <ms>, warm call <ms>.
```

- [ ] **Step 5: Commit**

```bash
git add docs/self-managed-llm-runtime.md
git commit -m "docs(runtime): llama-server router mode serves /v1/rerank from a per-model preset — measured

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 10: A GGUF has one of THREE kinds, from one writer

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Services/GgufCatalog.cs`
- Modify: `src/server/Gatherlight.Platform/Hosting/Resources/Services/ResourceProvisioner.cs:296-312`
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Services/LlamaServerRuntime.cs:196-199,217`
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Sources/LlamaCppSource.cs:80,180`
- Modify: `src/server/Gatherlight.Platform/Hosting/Resources/ModelsController.cs:206-212`

- [ ] **Step 1: Add the capability and the two pinned rerankers** in `GgufCatalog.cs`

Change the enum to:
```csharp
public enum GgufCapability
{
    Embedding,
    Completion,
    /// <summary>A cross-encoder: scores (query, document) pairs, never generates. Served with
    /// <c>reranking = true</c>, which RESTRICTS its child to <c>/v1/rerank</c>.</summary>
    Reranking,
}
```
Add inside `GgufCatalog`, above `Models`:
```csharp
    /// <summary>What every reranker row says, because it is the one thing that differs from a chat judge:
    /// only HALF of 判断 moves.</summary>
    private const string RerankerNote =
        "判断用的重排模型:检索时的判断在本机完成;写入事实时的主题标注仍由 Claude CLI 完成(每条事实一次调用)。";
```
Append to the `Models` array:
```csharp
        new GgufModel(
            "LAMAR-600m.Q5_K_M", "LAMAR 600M(Q5 · 判断 · 重排)", GgufCapability.Reranking,
            "mradermacher/LAMAR-600m-GGUF", "cd4da764d5b17d9996710dbf0ef5ad31c9aed182",
            "LAMAR-600m.Q5_K_M.gguf",
            "ec708b20336577c63702dd8efb23060bc611933579572bf9ad47ce2eaeda546f", 468_393_760,
            RerankerNote + "Lyntai 在英文 LoCoMo 上实测:+9.0(完美判断是 +9.5);本应用的双语数据尚未实测。"),
        new GgufModel(
            "bge-reranker-v2-m3-Q5_K_M", "BGE Reranker v2 M3(Q5 · 判断 · 重排)", GgufCapability.Reranking,
            "gpustack/bge-reranker-v2-m3-GGUF", "3093af03b1a635e67b084b1d8c03c5f5e020fd05",
            "bge-reranker-v2-m3-Q5_K_M.gguf",
            "1a212007526c7083627eed92b39dd4472e90ff1374a03fb068733378220813ef", 468_392_352,
            RerankerNote + "中文评测上比同类更强;Lyntai 量过的是它的 Q8 版本(+5.5),这个 Q5 版本与本应用的双语数据均尚未实测。"),
```

- [ ] **Step 2: Replace `IsEmbeddingGguf` with `GgufKind`** in `ResourceProvisioner.cs`

Replace the whole `IsEmbeddingGguf` method (and keep/adjust its doc comment) with:
```csharp
    /// <summary>What a GGUF IS — the ONE writer of that answer. llama-server's <c>embeddings</c> and
    /// <c>reranking</c> presets each RESTRICT a child to one API, so a wrong answer makes a judge refuse to talk,
    /// an embedder serve chat it cannot, or a reranker never be asked.
    ///
    /// <para><b>Exact for what we ship; a NAME HEURISTIC for anything else, stated rather than hidden.</b> A
    /// household may drop its own GGUF into the folder and we have no manifest for it. "rerank" is checked
    /// before "embed" because a reranker's name is the more specific of the two.</para></summary>
    public static Agent.Llm.Services.GgufCapability GgufKind(string modelId) =>
        Agent.Llm.Services.GgufCatalog.Find(modelId) is { } known
            ? known.Capability
            : modelId.Contains("rerank", StringComparison.OrdinalIgnoreCase)
                ? Agent.Llm.Services.GgufCapability.Reranking
                : modelId.Contains("embed", StringComparison.OrdinalIgnoreCase)
                    ? Agent.Llm.Services.GgufCapability.Embedding
                    : Agent.Llm.Services.GgufCapability.Completion;
```

- [ ] **Step 3: Move every caller** (the build lists any you miss)

- `LlamaServerRuntime.cs`: delete the `IsEmbeddingModel` helper (lines ~196–199); Task 11 rewrites the preset line.
  For now change line ~217 to `if (ResourceProvisioner.GgufKind(m) == GgufCapability.Embedding) sb.AppendLine("embeddings = true");`
- `LlamaCppSource.cs` `ModelsOnDisk`: replace the `.Where(...)` with
  `.Where(id => ServesLayer(ResourceProvisioner.GgufKind(id)))` and add below it:
```csharp
    /// <summary>Which kinds this layer can use: 语义 embeds; 判断 either converses (a chat judge) or scores
    /// pairs (a reranker verifies, the CLI tags).</summary>
    private bool ServesLayer(GgufCapability kind) => _layer == MemoryLayers.Semantic
        ? kind == GgufCapability.Embedding
        : kind is GgufCapability.Completion or GgufCapability.Reranking;
```
- `LlamaCppSource.cs` `RejectAsync`: `if (ResourceProvisioner.IsEmbeddingGguf(model))` →
  `if (ResourceProvisioner.GgufKind(model) == GgufCapability.Embedding)` (Task 14 rewrites the rest).
- `ModelsController.cs` inventory: replace the `var embedding = …;` expression and the `embedding ? "embedding" : "completion"` argument with
```csharp
            var kind = known?.Capability ?? Services.ResourceProvisioner.GgufKind(id);
```
  and the argument `kind switch { GgufCapability.Embedding => "embedding", GgufCapability.Reranking => "reranking", _ => "completion" }`.
- `ModelsController.cs` warm loop and `LlamaWarmStep`: leave for Task 11 (the `WarmAsync` signature changes there);
  temporarily pass `Services.ResourceProvisioner.GgufKind(m) == GgufCapability.Embedding` where a bool is expected.

- [ ] **Step 4: Build** → `Build succeeded.` Then `grep -rn "IsEmbeddingGguf" src/` → no output.

- [ ] **Step 5: Run p49 and p51** (catalog-as-resources and the capability split)

Run: `node devtools/dev.mjs e2e p49,p51` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src/server
git commit -m "feat(models): a GGUF has three kinds — chat, embedding, reranking — and two pinned rerankers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 11: The reranker preset and warm call (p51 first)

**Files:**
- Test: `devtools/scripts/e2e/p51.mjs` (the launch-contract block and the warm block)
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Services/LlamaServerRuntime.cs` (`ILlamaServerRuntime.WarmAsync`, `WarmAsync`, `WritePresets`)
- Modify: `src/server/Gatherlight.Platform/Hosting/Migration/Steps/LlamaWarmStep.cs`
- Modify: `src/server/Gatherlight.Platform/Hosting/Resources/ModelsController.cs` (warm loop)
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Sources/LlamaCppSource.cs` (`RejectAsync` warm call)

- [ ] **Step 1: Extend p51's launch-contract case**

In the `THE LLAMA LAUNCH CONTRACT` block, after `fs.writeFileSync(path.join(ggufDir, 'zztest-chat-model.gguf'), 'x');` add:
```js
    // A RERANKER is the third kind: `reranking = true` restricts its child to /v1/rerank, and a cross-encoder
    // needs the whole (query, document) pair in ONE physical batch, so the batch sizes are contract too.
    fs.writeFileSync(path.join(ggufDir, 'zztest-rerank-model.gguf'), 'x');
```
After the `embeddings = true goes on the EMBEDDER and nowhere else` assertion add:
```js
    ok('a RERANKER gets reranking = true and a whole-pair batch — and nothing else does',
      /reranking\s*=\s*true/.test(sectionOf('zztest-rerank-model'))
        && /^ubatch-size\s*=\s*4096/m.test(sectionOf('zztest-rerank-model'))
        && /^batch-size\s*=\s*4096/m.test(sectionOf('zztest-rerank-model'))
        && !/embeddings\s*=\s*true/.test(sectionOf('zztest-rerank-model'))
        && !/reranking\s*=\s*true/.test(sectionOf('zztest-embed-model'))
        && !/reranking\s*=\s*true/.test(sectionOf('zztest-chat-model')),
      JSON.stringify({ rerank: sectionOf('zztest-rerank-model'), embed: sectionOf('zztest-embed-model'),
        chat: sectionOf('zztest-chat-model') }));
```

- [ ] **Step 2: Extend p51's warm case**

In the `AN ALREADY-SERVING ROUTER IS ADOPTED` block: change the fake's model list to
`{ data: [{ id: 'zzwarm-embed-model' }, { id: 'zzwarm-chat-model' }, { id: 'zzwarm-rerank-model' }] }`;
change `hits.length === 2 && (started.body?.warmed ?? []).length === 2` to `=== 3` on both sides; and after the
`a CHAT model is warmed` assertion add:
```js
      const rerankHit = hits.find((h) => h.body.includes('zzwarm-rerank-model'));
      ok('a RERANKER is warmed through /v1/rerank',
        rerankHit?.path === '/v1/rerank' && rerankHit.body.includes('"documents"'),
        JSON.stringify(rerankHit));
```

- [ ] **Step 3: Run p51 → expect the two new checks to FAIL**

Run: `dotnet build … && node devtools/dev.mjs e2e p51`
Expected: `✗ a RERANKER gets reranking = true…` and `✗ every model the router reports is warmed` (2 hits, not 3) / `✗ a RERANKER is warmed through /v1/rerank` (it was sent a chat completion).

- [ ] **Step 4: Implement**

`LlamaServerRuntime.cs` — interface member:
```csharp
    Task<bool> WarmAsync(string modelId, GgufCapability kind, CancellationToken ct = default);
```
Class: change the signature the same way and replace the `var (path, body) = isEmbedding ? … : …;` with:
```csharp
            // THREE call shapes, because each preset restricts its child to ONE API: an embedder answers only
            // /v1/embeddings, a reranker only /v1/rerank, and a judge the chat route.
            var (path, body) = kind switch
            {
                GgufCapability.Embedding => ("/v1/embeddings",
                    $"{{\"model\":\"{modelId}\",\"input\":[\"warm\"]}}"),
                GgufCapability.Reranking => ("/v1/rerank",
                    $"{{\"model\":\"{modelId}\",\"query\":\"warm\",\"documents\":[\"warm\"],\"top_n\":1}}"),
                _ => ("/v1/chat/completions",
                    $"{{\"model\":\"{modelId}\",\"messages\":[{{\"role\":\"user\",\"content\":\"hi\"}}],\"max_tokens\":1}}"),
            };
```
Add a constant near `GpuLayers`:
```csharp
    /// <summary>A cross-encoder scores (query, document) as ONE sequence, which must fit one physical batch;
    /// 4096 is how Lyntai's own harness runs the same reranker files. Launch CONTRACT, like GpuLayers.</summary>
    private const int RerankBatch = 4096;
```
In `WritePresets` replace the `embeddings` line with:
```csharp
            switch (ResourceProvisioner.GgufKind(m))
            {
                // `embeddings` RESTRICTS a child to embedding-only. Right for an embedder, fatal for a judge.
                case GgufCapability.Embedding:
                    sb.AppendLine("embeddings = true");
                    break;
                // `reranking` restricts it to /v1/rerank, and the pair must fit one batch — see RerankBatch.
                case GgufCapability.Reranking:
                    sb.AppendLine("reranking = true");
                    sb.AppendLine($"ctx-size = {RerankBatch}");
                    sb.AppendLine($"batch-size = {RerankBatch}");
                    sb.AppendLine($"ubatch-size = {RerankBatch}");
                    break;
            }
```
Callers:
- `ModelsController.cs` warm loop: `await _llama.WarmAsync(m, Services.ResourceProvisioner.GgufKind(m))`.
- `LlamaWarmStep.cs`: change the tuple to carry the kind —
```csharp
        foreach (var (model, layer) in new[] { (embedModel, "语义"), (judgeModel, "判断") })
        {
            if (string.IsNullOrWhiteSpace(model)) continue;
            if (await _llama.WarmAsync(model!, ResourceProvisioner.GgufKind(model!), ct)) continue;
```
  (add `using Gatherlight.Server.Platform.Hosting.Resources.Services;` if missing; keep the two warning lines that follow).
- `LlamaCppSource.RejectAsync`: `ctx.Llama.WarmAsync(model, isEmbedding: false, ct)` → `ctx.Llama.WarmAsync(model, GgufCapability.Completion, ct)`.

- [ ] **Step 5: Build and run p51 → PASS**; also `node devtools/dev.mjs e2e p52` → PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src/server devtools/scripts/e2e/p51.mjs
git commit -m "feat(runtime): rerankers get reranking = true + a whole-pair batch, and warm through /v1/rerank

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 12: `JudgeWiring` — a judge source owns its whole wiring

**Files:**
- Create: `src/server/Gatherlight.Platform/Agent/Llm/Sources/JudgeWiring.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Sources/IMemorySource.cs` (`IMemoryJudgeSource`)
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Sources/ClaudeCliJudgeSource.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/Sources/LlamaCppSource.cs` (chat-only for now; Task 14 adds the reranker)

- [ ] **Step 1: Create `JudgeWiring.cs`**

```csharp
using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai.Inference;
using Lyntai.Memory.Verification;
using Microsoft.Extensions.DependencyInjection;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>What 判断 is made of once a source is bound: who ANNOTATES each write (a text client and its model)
/// and what VERIFIES each recall.
///
/// <para><b>Why the source answers this, not the composition root.</b> The two halves stopped moving together
/// the day a reranker could verify: it scores pairs and never generates, so annotation has to stay on a
/// chat model. Branching on that in <c>GatherlightApp</c> would be the if/else chain the source catalog
/// exists to replace; each source states its own wiring instead.</para></summary>
/// <param name="AnnotationClient">The named text client that annotates, or null for the default client
/// (the Claude CLI).</param>
/// <param name="AnnotationModel">The model annotation runs on — the ONE value <c>llm.model.memory</c> and
/// <c>DefaultModelByConsumer["memory"]</c> hold. Never a reranker's id: the CLI would be asked for it.</param>
/// <param name="Verifier">Builds the recall verifier from the container.</param>
public sealed record JudgeWiring(
    string? AnnotationClient,
    string AnnotationModel,
    Func<IServiceProvider, IMemoryVerificationPolicy> Verifier)
{
    /// <summary>An LLM judge on <paramref name="client"/>: both halves on the same model. The verifier is shown
    /// each fact's content (<see cref="JudgeSeesContentPolicy"/>) unless the measurement knob asks for topics.</summary>
    public static JudgeWiring Llm(string? client, string model) => new(client, model, sp =>
    {
        IMemoryVerificationPolicy llm = new LlmMemoryVerificationPolicy(
            sp.GetRequiredService<ITextClientFactory>(),
            new LlmVerificationOptions { ClientName = client },
            sp.GetService<ILogger<LlmMemoryVerificationPolicy>>());
        return JudgeSeesContentPolicy.Enabled ? new JudgeSeesContentPolicy(llm) : llm;
    });
}
```

- [ ] **Step 2: Add three members to `IMemoryJudgeSource`** (in `IMemorySource.cs`, after `ClientName`):

```csharp
    /// <summary>How this source's judge is wired for <c>ctx.Model</c>. Called at composition, alongside
    /// <see cref="IMemorySource.Register"/> — see <see cref="JudgeWiring"/> for why the source decides.</summary>
    JudgeWiring Wiring(MemoryWiringContext ctx);

    /// <summary>The model ANNOTATION runs on when this source is bound to <paramref name="model"/> — what the
    /// binding endpoint writes to <c>llm.model.memory</c>. Must agree with <see cref="Wiring"/>.</summary>
    string AnnotationModel(string model);

    /// <summary>The layer's cost line for this source bound to <paramref name="model"/>. It describes the BOUND
    /// arm (dev-conventions: a layer's cost line describes the bound arm), which is why the source owns it: an arm
    /// whose two halves cost different things has to say both.</summary>
    string Cost(string? model);
```

- [ ] **Step 3: Implement them in `ClaudeCliJudgeSource`** (the cost text moves here verbatim from the controller):

```csharp
    public JudgeWiring Wiring(MemoryWiringContext ctx) => JudgeWiring.Llm(null, ctx.Model);

    public string AnnotationModel(string model) => model;

    public string Cost(string? model) =>
        "每次记录事实与每次检索各消耗一次 Claude CLI 调用(使用已登录的账号)。"
        + "实测每次检索 9–17 秒(五次测量,多数在 15 秒上下)—— 每次调用都要启动一次 CLI 进程;"
        + "只用「公式」时是 0.07–0.09 秒。"
        + "换成本机模型可以省掉这次进程启动。";
```

- [ ] **Step 4: Implement them in `LlamaCppSource`** (chat judge only for now):

```csharp
    public JudgeWiring Wiring(MemoryWiringContext ctx) => JudgeWiring.Llm(ClientId, ctx.Model);

    public string AnnotationModel(string model) => model;

    public string Cost(string? model) =>
        "每次记录事实与每次检索各调用一次本机模型:不消耗账号额度,不联网,断网也能用。"
        + "没有 CLI 那条的进程启动开销(那条实测每次检索 9–17 秒)。";
```

- [ ] **Step 5: Build** → `Build succeeded.` (Nothing calls the new members yet — Task 13 does.)

- [ ] **Step 6: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Llm/Sources
git commit -m "refactor(memory): a judge source states its whole wiring — annotation client, annotation model, verifier, cost

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 13: The composition root and the panel read the wiring

**Files:**
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Llm/MemoryRecallController.cs` (the judge `cost` and the binding endpoint)

- [ ] **Step 1: Compute the wiring once, before `AddLyntai`** — after `var judgeModel = …;` add:

```csharp
        // What 判断 is made of for the bound model — the source decides (see JudgeWiring). Computed before the
        // container exists because DefaultModelByConsumer below needs the ANNOTATION model, which for a
        // reranker is not the bound one.
        var judgeCtx = new Platform.Agent.Llm.Sources.MemoryWiringContext(
            judgeModel, judgeSource.Endpoint(memorySettings) ?? "", memorySettings);
        var judgeWiring = judgeSource.Wiring(judgeCtx);
```

- [ ] **Step 2: Use it** in `GatherlightApp.cs`:
1. `o.DefaultModelByConsumer["memory"] = judgeModel;` → `o.DefaultModelByConsumer["memory"] = judgeWiring.AnnotationModel;`
2. Delete `var judgeClient = judgeSource.ClientName;`.
3. In the annotation registration: `new Lyntai.Memory.Annotation.LlmAnnotationOptions { ClientName = judgeClient }` → `{ ClientName = judgeWiring.AnnotationClient }`.
4. Replace the whole verification registration (the block from Task 2) with:
```csharp
                b.Services.AddSingleton<Lyntai.Memory.Verification.IMemoryVerificationPolicy>(sp =>
                    new Platform.Agent.Llm.Services.SwitchableVerificationPolicy(
                        judgeWiring.Verifier(sp), sp.GetRequiredService<IAppConfigService>()));
```
5. `judgeSource.Register(b, new Platform.Agent.Llm.Sources.MemoryWiringContext(judgeModel, judgeSource.Endpoint(memorySettings) ?? "", memorySettings));` → `judgeSource.Register(b, judgeCtx);`

Leave `new MemoryJudgeWiring(judgeSource.Id, judgeModel)` as is — the panel compares the BOUND model.

- [ ] **Step 3: The controller** (`MemoryRecallController.cs`):
1. Replace the whole `cost = boundJudge.Id == MemorySources.DefaultJudgeSource ? … : …,` expression (keep the explanatory comment above it) with
   `cost = boundJudge.Cost(MemorySources.ResolveJudgeModel(Settings())),`
2. In `Bind`, `_appConfig.Set("llm.model.memory", model!);` → `_appConfig.Set("llm.model.memory", source.AnnotationModel(model!));`
   and add above it: `// The ANNOTATION model — for a reranker that is the CLI's, never the reranker's id (JudgeWiring).`

- [ ] **Step 4: Build, then run the memory suites** — behaviour is unchanged for both existing arms:

Run: `node devtools/dev.mjs e2e p48,p51,p52` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/Gatherlight.Server/GatherlightApp.cs src/server/Gatherlight.Platform/Agent/Llm/MemoryRecallController.cs
git commit -m "refactor(memory): the composition root and the panel read the judge source's wiring

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 14: `LlamaCppSource` serves a reranker (screen, registration, wiring, cost)

**Files:** Modify `src/server/Gatherlight.Platform/Agent/Llm/Sources/LlamaCppSource.cs`

- [ ] **Step 1: Constants** — next to `ProviderId`/`ClientId` add:

```csharp
    /// <summary>The reranker's own provider id — a third registration against the same router (Lyntai D133:
    /// one host serving several routes is several registrations), named so a trace says which one answered.</summary>
    private const string RerankProviderId = "llamacpp-rerank";

    /// <summary><c>recall_facts</c>' default page. Lyntai: endorsing more than a page REPLACES the ranking
    /// instead of refining it, and the verifier is never told the caller's limit — so this is a constant.</summary>
    private const int RerankEndorseCount = 8;

    /// <summary>The screen a reranker must pass before it may bind: the ANSWER is second in input order, so a
    /// model that returns input order unchanged fails as surely as one that ranks backwards. Chinese query,
    /// Chinese documents — the household's own case.</summary>
    private const string ScreenQuery = "市场周末几点开门?";
    private static readonly string[] ScreenDocuments = ["图书馆周一闭馆。", "东门市场周六周日早上七点开门。"];
```

- [ ] **Step 2: `Register` for the judge layer** — at the start of the non-semantic branch (before `b.AddLlamaProvider(…)`):

```csharp
        if (ResourceProvisioner.GgufKind(ctx.Model) == GgufCapability.Reranking)
        {
            // A reranker only SCORES. Annotation stays on the default client (the Claude CLI) — see Wiring.
            b.AddHttpProvider(RerankProviderId, o =>
            {
                o.BaseUrl = ctx.Endpoint;
                o.Model = ctx.Model;
                o.Produces = Lyntai.Inference.ProviderKinds.Score;
            });
            return;
        }
```

- [ ] **Step 3: `Wiring`, `AnnotationModel` and `Cost` become kind-aware** — replace the three Task 12 bodies:

```csharp
    public JudgeWiring Wiring(MemoryWiringContext ctx) =>
        ResourceProvisioner.GgufKind(ctx.Model) != GgufCapability.Reranking
            ? JudgeWiring.Llm(ClientId, ctx.Model)
            // Verification by the reranker; annotation by the default client on the CLI's default model.
            : new JudgeWiring(null, MemorySources.DefaultJudgeModel, sp =>
                new Lyntai.Memory.Verification.ScoringVerificationPolicy(
                    sp.GetServices<Lyntai.Inference.IModelProvider>(),
                    new Lyntai.Memory.Verification.ScoringVerificationOptions
                        { ProviderId = RerankProviderId, EndorseCount = RerankEndorseCount },
                    sp.GetService<ILogger<Lyntai.Memory.Verification.ScoringVerificationPolicy>>(),
                    sp.GetService<Lyntai.Inference.IProviderRouterFactory>()));

    public string AnnotationModel(string model) =>
        ResourceProvisioner.GgufKind(model) == GgufCapability.Reranking ? MemorySources.DefaultJudgeModel : model;

    public string Cost(string? model) =>
        model is not null && ResourceProvisioner.GgufKind(model) == GgufCapability.Reranking
            // BOTH halves, because they cost different things — and the second sentence is the one a household
            // relies on: their facts DO leave the machine, for tagging.
            ? "检索时的判断由本机重排模型完成:不消耗账号额度,不联网。"
              + "写入事实时的主题标注仍由 Claude CLI 完成 —— 每条事实一次调用,事实内容会发给 Claude;"
              + "没有已登录的 CLI 时只是不标注,检索时的判断照常。"
            : "每次记录事实与每次检索各调用一次本机模型:不消耗账号额度,不联网,断网也能用。"
              + "没有 CLI 那条的进程启动开销(那条实测每次检索 9–17 秒)。";
```
Add `using Microsoft.Extensions.DependencyInjection;` to `LlamaCppSource.cs` for `GetServices`. (`ILogger<>`
comes from the project's global usings — `BuiltInSemanticSource` already relies on it.)

- [ ] **Step 4: `RejectAsync` screens a reranker** — replace the method body with:

```csharp
        var kind = ResourceProvisioner.GgufKind(model);
        if (kind == GgufCapability.Embedding)
            return $"{model} 是嵌入模型,不能用来做判断 —— 判断需要一个对话模型或重排模型。";

        // Then PROVE it: installed is not usable, and a judge that cannot answer fails open, i.e. silently.
        if (!await ctx.Llama.EnsureServingAsync(ct))
            return "llama.cpp 没能启动 —— 请看「日志」里的原因。";
        if (kind == GgufCapability.Reranking) return await ScreenRerankerAsync(ctx, model, ct);
        return await ctx.Llama.WarmAsync(model, GgufCapability.Completion, ct)
            ? null
            : $"{model} 没能在 llama.cpp 上回答 —— 换一个模型,或看「日志」。";
```
and add the screen:
```csharp
    /// <summary>A reranker must put the ANSWER first before it may bind. "It returned scores" is not enough:
    /// Lyntai found a converted model that ranked backwards while passing a looser check, and a fail-open
    /// verifier would turn that into recall that quietly gets worse.</summary>
    private static async Task<string?> ScreenRerankerAsync(MemorySourceContext ctx, string model, CancellationToken ct)
    {
        var url = LlamaServerRuntime.ResolveBaseUrl(ctx.Settings.ResourcesPath);
        try
        {
            // Generous: this call also pays the model load (measured in docs/self-managed-llm-runtime.md).
            using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
            using var content = new StringContent(
                JsonSerializer.Serialize(new { model, query = ScreenQuery, documents = ScreenDocuments, top_n = 2 }),
                new UTF8Encoding(false), "application/json");
            using var resp = await http.PostAsync($"{url}/v1/rerank", content, ct);
            if (!resp.IsSuccessStatusCode) return $"{model} 没能在 llama.cpp 上完成重排(HTTP {(int)resp.StatusCode})—— 看「日志」。";
            using var doc = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            var scores = new double[ScreenDocuments.Length];
            var seen = 0;
            foreach (var r in doc.RootElement.GetProperty("results").EnumerateArray())
            {
                var i = r.GetProperty("index").GetInt32();
                var s = r.GetProperty("relevance_score").GetDouble();
                if (i < 0 || i >= scores.Length || double.IsNaN(s) || double.IsInfinity(s)) return $"{model} 返回的重排结果无法使用。";
                scores[i] = s;
                seen++;
            }
            return seen == ScreenDocuments.Length && scores[1] > scores[0]
                ? null
                : $"{model} 没有通过重排自检:答案没有排在前面 —— 这个模型文件可能转换有问题,换一个。";
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return $"{model} 没能在 llama.cpp 上完成重排 —— {ex.Message}";
        }
    }
```

- [ ] **Step 5: `ModelsAsync` carries the note** — in the `new ModelOption(...)` add
  `Note: GgufCatalog.Find(id)?.Note,` so a household-dropped reranker shows nothing invented and a catalogued one shows its row text.

- [ ] **Step 6: Build** → `Build succeeded.` (Tests arrive in Task 17.)

- [ ] **Step 7: Commit**

```bash
git add src/server/Gatherlight.Platform/Agent/Llm/Sources/LlamaCppSource.cs
git commit -m "feat(memory): 判断 can verify with a llama.cpp reranker — screened before binding, tagging stays on the CLI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 15: Existing tests still describe the CLI arm's cost

**Files:** none new — this task is a check.

- [ ] **Step 1:** `grep -n "cost" devtools/scripts/e2e/p51.mjs` and read each judge-cost assertion. The CLI and chat texts moved verbatim (Task 12), so they must still pass. Run `node devtools/dev.mjs e2e p51` → PASS. If any failed, the moved text differs from the original — copy it exactly; do not edit the assertion.

### Task 16: The models table names the third kind

**Files:** Modify `src/client/src/ui/organisms/console/LocalModelsPanel.tsx:245`

- [ ] **Step 1:** Replace
```tsx
                  <td className="num">{m.capability === 'embedding' ? '嵌入 · 语义' : '对话 · 判断'}</td>
```
with
```tsx
                  <td className="num">{CAPABILITY_LABEL[m.capability] ?? m.capability}</td>
```
and add near the top of the file (after the imports):
```tsx
/** What each GGUF kind is FOR. A reranker judges too, but only by scoring — it never writes a tag. */
const CAPABILITY_LABEL: Record<string, string> = {
  embedding: '嵌入 · 语义',
  completion: '对话 · 判断',
  reranking: '重排 · 判断',
};
```

- [ ] **Step 2:** `node devtools/dev.mjs build` → client + server build succeed.

- [ ] **Step 3: Commit**

```bash
git add src/client/src/ui/organisms/console/LocalModelsPanel.tsx
git commit -m "feat(console): the models table labels rerankers 重排 · 判断

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 17: p52 — binding a reranker, and a reranker at work

**Files:** Modify `devtools/scripts/e2e/p52.mjs`

- [ ] **Step 1: Teach the fake llama-server to rerank**

At the top add `import { DatabaseSync } from 'node:sqlite';` and constants:
```js
const RERANK_MODEL = 'zzroute-rerank';
// Ranks the ANSWER LAST — the screen must refuse it.
const BACKWARDS_MODEL = 'zzroute-backwards-rerank';
const RERANK_PORT = 5414;
```
Plant both next to the other GGUFs: `fs.writeFileSync(path.join(resources, 'gguf', \`${RERANK_MODEL}.gguf\`), '');` and the same for `BACKWARDS_MODEL`.

In the fake's `req.on('end', …)` handler, before the chat fallback, add:
```js
    if (req.url === '/v1/rerank') {
      // Score = characters a document shares with the query: crude, deterministic, and it puts the answer
      // first on the screen pair. The BACKWARDS model negates it, so the answer comes last.
      const sign = json.model === BACKWARDS_MODEL ? -1 : 1;
      const results = (json.documents ?? []).map((d, index) => ({
        index, relevance_score: sign * [...String(d)].filter((ch) => String(json.query ?? '').includes(ch)).length,
      })).sort((a, b) => b.relevance_score - a.relevance_score);
      send({ model: json.model, results, usage: { prompt_tokens: 1, total_tokens: 1 } });
      return;
    }
```

- [ ] **Step 2: Binding assertions on the existing server** — before `} catch (err) {` add:

```js
  // --- 4. binding a RERANKER as 判断: screened first, and the model written is the TAGGING model -----------
  const backwards = await c.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: BACKWARDS_MODEL });
  ok('a reranker that ranks the answer LAST is refused', backwards.status === 409, JSON.stringify(backwards.body));

  const bound = await c.post('/api/manage/memory/layer/judge', { source: 'llama-cpp', model: RERANK_MODEL });
  ok('a reranker that puts the answer first binds as the judge', bound.status === 200, JSON.stringify(bound.body));
  ok('…because the screen really ran against the runtime',
    hits.some((h) => h.path === '/v1/rerank' && h.model === RERANK_MODEL));

  const memKey = new DatabaseSync(path.join(dataDir, 'state', 'gatherlight.db'))
    .prepare("SELECT value FROM app_config WHERE key = 'llm.model.memory'").get()?.value;
  ok('THE TRAP: the memory model written is the TAGGING model, never the reranker id',
    memKey === 'haiku', String(memKey));

  const judgeCost = ((await c.getJson('/api/manage/memory')).layers ?? []).find((l) => l.id === 'judge')?.cost ?? '';
  ok('the cost line names both halves — local verification AND CLI tagging that sends the fact to Claude',
    /重排/.test(judgeCost) && /Claude CLI/.test(judgeCost) && /发给 Claude/.test(judgeCost), judgeCost);
```

- [ ] **Step 3: A second server wired to the reranker at startup** — after the block above add:

```js
  // --- 5. a reranker AT WORK: a recall is scored on the fact's CONTENT, and tagging reaches the CLI ----------
  const rrDir = dataDirFor('p52-rerank');
  makeTestData(rrDir);
  const rrRes = path.join(rrDir, 'state', 'resources');
  fs.mkdirSync(path.join(rrRes, 'llama-cpp'), { recursive: true });
  fs.mkdirSync(path.join(rrRes, 'gguf'), { recursive: true });
  fs.writeFileSync(path.join(rrRes, 'llama-cpp', 'llama-server.exe'), '');
  fs.writeFileSync(path.join(rrRes, 'gguf', `${RERANK_MODEL}.gguf`), '');
  fs.writeFileSync(path.join(rrDir, 'state', 'settings.json'),
    JSON.stringify({ memory: { judgeSource: 'llama-cpp', judgeModel: RERANK_MODEL } }, null, 2), 'utf8');
  rrServer = startServer({ dataDir: rrDir, port: RERANK_PORT, env: { GATHERLIGHT_LLAMACPP_URL: fakeUrl } });
  await waitHealthy(rrServer.base);
  const rc = makeClient(rrServer.base);
  const rrJudge = ((await rc.getJson('/api/manage/memory')).layers ?? []).find((l) => l.id === 'judge') ?? {};
  ok('(fixture) 判断 is running on the reranker', rrJudge.activeModel === RERANK_MODEL, JSON.stringify(rrJudge));

  const beforeWrite = hits.length;
  await rc.call('remember_fact', {
    kind: 'travel', topic: 'zzrerank-topic ferry',
    content: 'The zzrerankfact ferry leaves the pier at nine every morning.', source: 'https://example.test/f', confidence: 0.8,
  });
  ok('tagging does NOT reach the runtime — a reranker never generates',
    !hits.slice(beforeWrite).some((h) => h.path === '/v1/chat/completions'),
    JSON.stringify(hits.slice(beforeWrite).map((h) => h.path)));
  const logs = () => fs.readdirSync(path.join(rrDir, 'state', 'logs'))
    .map((f) => fs.readFileSync(path.join(rrDir, 'state', 'logs', f), 'utf8')).join('\n');
  await until(() => /router: claude-cli \(model haiku\)/.test(logs()), 30000).catch(() => {});
  ok('…it reaches the Claude CLI on the tagging model', /router: claude-cli \(model haiku\)/.test(logs()));

  const beforeRecall = hits.length;
  await rc.call('recall_facts', { query: 'zzrerankq when does the ferry leave', limit: 5 });
  const scored = hits.slice(beforeRecall).filter((h) => h.path === '/v1/rerank');
  ok('THE POINT: a recall is verified by the reranker', scored.length > 0,
    JSON.stringify(hits.slice(beforeRecall).map((h) => h.path)));
  ok('…scoring the query against the fact’s CONTENT, not its topic',
    scored.some((h) => h.body.includes('zzrerankq') && h.body.includes('zzrerankfact')),
    JSON.stringify(scored.map((h) => h.body.slice(0, 200))));
```
Declare `let rrServer = null;` next to `let server = null;`, add `dataDirFor` to the import list if missing, and in
`finally` add `try { rrServer?.stop(); } catch {}` before the fake closes.

- [ ] **Step 4: Run p52** → `e2e-p52 PASS`.

- [ ] **Step 5: Prove each new check can fail** (restore after each; rebuild between):
1. In `LlamaCppSource.ScreenRerankerAsync` change `scores[1] > scores[0]` to `true` → `✗ a reranker that ranks the answer LAST is refused`.
2. In `LlamaCppSource.AnnotationModel` return `model` unconditionally → `✗ THE TRAP: the memory model written is the TAGGING model`.
3. In `LlamaCppSource.Wiring` return `JudgeWiring.Llm(ClientId, ctx.Model)` unconditionally → `✗ THE POINT: a recall is verified by the reranker`.

- [ ] **Step 6: Commit**

```bash
git add devtools/scripts/e2e/p52.mjs
git commit -m "test(e2e): p52 — a reranker is screened before it binds, verifies on content, and never tags

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 18: Record it in the rules and the release notes

**Files:** Modify `.claude/rules/dev-conventions.md`, `docs/release-notes/next.md`

- [ ] **Step 1: dev-conventions** —
1. Every mention of `ResourceProvisioner.IsEmbeddingGguf` → `ResourceProvisioner.GgufKind` (three kinds; "rerank" before "embed" in the name heuristic).
2. In the `WHAT THE RECALL LAYERS DO` table add a row:
   `| **判断 · reranker** | verification by a llama.cpp cross-encoder; tagging stays on the Claude CLI | Lyntai: +9.0 of 9.5 on English LoCoMo (LAMAR-600m Q5). Ours: see docs/judge-bench.md |`
3. A new bullet after the `ONE control writes the judge's model` bullet:
   **"A reranker verifies; it never annotates."** — why the halves split (`JudgeWiring`), that `llm.model.memory`
   holds the ANNOTATION model (p52's THE TRAP), the screen (answer-second input, Lyntai's backwards-model finding),
   `EndorseCount = 8` and why it is a constant, and the preset contract (`reranking = true` + 4096 batches; p51).
4. Under the judge-content workaround: cite `JudgeSeesContentPolicy` ↔ Lyntai Part 274 (recorded on both sides).
- Run: `node devtools/dev.mjs check-doc-refs` → OK.

- [ ] **Step 2: release notes** — append to `docs/release-notes/next.md`:

```markdown
### 判断 可以改用本机的「重排模型」

「校准 · Cortex → 记忆检索 → 判断 → 本机模型」里现在可以选重排模型(LAMAR 600M 或 BGE Reranker v2 M3,
在「资源」面板下载,约 470 MB)。它只接管**检索时的判断**:在本机完成,不消耗账号额度,不联网,每次检索不再
要等 9–17 秒的 CLI 启动。**写入事实时的主题标注仍由 Claude CLI 完成**(每条事实一次调用,事实内容会发给
Claude)—— 重排模型只会打分,不会写标注。选用前会先做一次自检:答案排不到前面的模型文件会被拒绝。

另外修好了一个老问题:判断检索结果时,Claude 以前只看得到每条事实的**主题**,看不到事实本身,所以常常判断
「没有答到」。现在它看到的是「主题 — 内容」。
```

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/dev-conventions.md docs/release-notes/next.md
git commit -m "docs: the reranker judge, the judge that sees the fact, and what each costs

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

# Part D — measure the rerankers and record the numbers

### Task 19: Reranker arms, then choose the recommended model

**Files:** Modify `docs/judge-bench.md`, `src/server/Gatherlight.Platform/Agent/Llm/Services/GgufCatalog.cs` (notes + a recommended constant), `.claude/rules/dev-conventions.md`

- [ ] **Step 1: Download both rerankers through the app** — start the dev server (`node devtools/dev.mjs server`),
open 资源 · Resources, download `LAMAR 600M` and `BGE Reranker v2 M3`, wait for both rows to read 已安装. Stop the server.

- [ ] **Step 2: Run the reranker arms** (free — no CLI judge calls; tagging during the seed still uses the CLI)

Run: `node devtools/dev.mjs judge-bench --arms=formula,content --rerankers=LAMAR-600m.Q5_K_M,bge-reranker-v2-m3-Q5_K_M > devtools/_judge-bench-rr.txt 2>&1`
Expected: tables with six arms (`公式`, content partition, and partition/fuse for each reranker).

- [ ] **Step 3: Append "Run 2 — rerankers" to `docs/judge-bench.md`** — the tables verbatim, then:
- reranker vs 公式, per set; reranker vs the Claude judge (content), per set; latency per arm;
- LAMAR vs BGE, per set — the Chinese sets (`same` on zh facts, `mixed`) are the household's case;
- partition vs fuse per reranker (Lyntai measured fuse = insurance: the base, no more).
Same "What it does NOT say" section as Run 1.

- [ ] **Step 4: Put the measurement where the household reads it** — in `GgufCatalog.cs`, replace the
「本应用的双语数据尚未实测」 clause of each reranker's note with its measured `all`-set figures in the same
style as the embedder rows (e.g. 「本应用双语测试集:首位命中 X/240,前八命中 Y/240,每次检索约 Z 秒」), and add
```csharp
    /// <summary>The reranker the bilingual bench measured best (docs/judge-bench.md, Run 2).</summary>
    public const string RecommendedReranker = "<the winning id>";
```
If the two are within 2 questions on `all`, recommend the smaller file and say "tie" in the note — the ~1-point
band Lyntai measured is the same shape.

- [ ] **Step 5: Update dev-conventions' measured row** (Task 18's table row) with our numbers and the date.

- [ ] **Step 6: Build, run the memory suites, commit**

Run: `dotnet build … && node devtools/dev.mjs e2e p49,p51,p52` → PASS.
```bash
git add docs/judge-bench.md src/server/Gatherlight.Platform/Agent/Llm/Services/GgufCatalog.cs .claude/rules/dev-conventions.md
git commit -m "docs(measure): the rerankers on the bilingual fixture — and the recommended one

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 20: Full fleet

- [ ] **Step 1:** `node devtools/dev.mjs build`
- [ ] **Step 2:** `node devtools/dev.mjs e2e all --parallel` — every suite PASS. For suites that fail with the
  reserved-port signature, re-run them via `node devtools/_run-shifted.mjs 5458 5557 200 <suites…>`. Re-run any
  known flake (p17/p36/p43/p46) solo before investigating.
- [ ] **Step 3:** Report the tally to the owner: in-fleet passes, shifted passes, any re-run.
