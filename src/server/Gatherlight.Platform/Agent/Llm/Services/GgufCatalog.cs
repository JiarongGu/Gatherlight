namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>What a GGUF is FOR. llama-server's <c>embeddings</c> and <c>reranking</c> presets each restrict a
/// child to one API, so this is not a label — it decides how the model is launched, and a wrong value makes
/// the model refuse every call it is asked to serve.</summary>
public enum GgufCapability
{
    Embedding,
    Completion,
    /// <summary>A cross-encoder: scores (query, document) pairs, never generates. Served with
    /// <c>reranking = true</c>, which RESTRICTS its child to <c>/v1/rerank</c>.</summary>
    Reranking,
}

/// <summary>One downloadable GGUF for the app-provisioned llama.cpp runtime.</summary>
/// <param name="Id">The model id the router will answer to — and, because <c>--models-dir</c> derives an id
/// from the DIRECTORY name when a model sits in one, also this model's install directory. So the id is ours
/// to choose: the router answers to it whatever the file inside is called. And every row CHOOSES the upstream
/// file's stem, on purpose — a catalogued id is typed and fitted by its row, and the stem is also the id a
/// household who drops that same file in flat ends up with (a flat file takes its filename), so they get the
/// row too rather than a kind guessed from the name (see the mMiniLMv2 row, whose stem has no "rerank").</param>
/// <param name="Repo">HuggingFace repo.</param>
/// <param name="Commit">Pinned COMMIT, never a branch: a branch ref lets the bytes move under the checksum,
/// which then reads as a corrupt download rather than as an upstream edit.</param>
/// <param name="File">The filename inside the repo — and inside our install dir, unchanged, so the download
/// is traceable back to the thing it came from.</param>
/// <param name="Measured">What it scored on this app's own recall job, or null. Null must be SAID by the UI,
/// not left blank: an empty cell in a comparison table reads as a zero.</param>
/// <param name="ContextTokens">The model's own token window, DECLARED when it is a hard limit on what the model can
/// be sent — null for a model that takes whatever the launch preset gives it. Read for a RERANKER, by both sides of
/// one contract: the preset launches it with this <c>ctx-size</c> and batch (<see cref="LlamaServerRuntime"/>), and every
/// (query, document) pair is fitted to it — <see cref="RerankInputCap"/> fits the query and sets each candidate's budget,
/// and <see cref="ChunkedScoreProvider"/> cuts a longer candidate into windows of that budget (the default since
/// 2026-09-24; with chunking off the cap cuts the candidate itself). Past it llama.cpp refuses the WHOLE
/// <c>/v1/rerank</c> call — one over-long pair and no candidate is scored — and the verifier fails open, so a missing
/// declaration is a silent loss of verification on exactly the recalls that surface a long fact. Declared from the
/// GGUF header's <c>context_length</c> and the served slot size, both measured, never guessed.</param>
public sealed record GgufModel(
    string Id,
    string Name,
    GgufCapability Capability,
    string Repo,
    string Commit,
    string File,
    string Sha256,
    long ApproxBytes,
    string Note,
    EmbeddingMeasurement? Measured = null,
    int? ContextTokens = null);

/// <summary>
/// The GGUFs the app can download for its own llama.cpp runtime — the shelf, as
/// <see cref="EmbeddingCatalog"/> is the shelf for Ollama.
///
/// <para><b>Why this is a CLOSED list where the Ollama one is not.</b> `EmbeddingCatalog` is explicitly a
/// suggestion rather than a gate: anything Ollama can pull is selectable, because Ollama resolves a tag
/// against its own registry and we only advise. Here we are the downloader — url, commit and checksum — so
/// a model we have not pinned is a model we cannot fetch. The trade is deliberate: a household gains a
/// verified download and loses free choice, and the panel says so rather than presenting a short list as if
/// it were the whole world. A household who wants something else drops its GGUF into the models folder
/// (<c>ResourceProvisioner.ProvisionedGgufDir</c>, <c>state/resources/gguf</c>): the router serves it, 资源 lists
/// it and 记忆检索 offers it — with no note, no measurement, and a kind guessed from its file name
/// (<c>ResourceProvisioner.GgufKind</c>), which the panel's fine print says in those words. (This said "points
/// <c>openai-compat</c> at it" until that backend was retired, 2026-08-22.)</para>
///
/// <para><b>Every entry is sha256-pinned at a commit</b>, like git, node and the ONNX model. Unlike
/// <c>ollama pull</c>, which fetches a mutable tag, this cannot silently become different bytes.</para>
///
/// <para><b>Measurements are per model and honestly sparse.</b> Only the embedder has been scored on the
/// 10-query fixture (9/10 top-1, 25 ms/query through the app, 2026-08-22 — the same instrument as every
/// number in <see cref="EmbeddingCatalog"/>). The rerankers and two chat models have been scored AS 判断 on
/// the 240-question bilingual fixture (<c>docs/judge-bench.md</c>: Run 2 for LAMAR and BGE, Run 3 for Gemma 3
/// 1B, Run 4 for mMiniLMv2, Run 5b for Qwen3 0.6B) — top-1 and found@8, which is not the shape of
/// <see cref="EmbeddingMeasurement"/> (top-3 of 10 queries), so those figures live in the note and
/// <see cref="GgufModel.Measured"/> stays null rather than carrying a found@8 in a top-3 slot. The 4B chat model has
/// no measurement at all, and its note says so; claiming otherwise is the failure this whole area keeps correcting.
/// (Run 5b also measured Qwen3.5 0.8B — no significant difference from no judge — and Gemma 3 270M — worse; neither
/// is catalogued.)</para>
///
/// <para><b>There is no recommended CHAT judge, and that is a decision, not an omission.</b> Gemma 3 1B
/// was <c>RecommendedJudge</c> — 推荐 in its name, 「判断质量没有单独实测过」 in its note, the model 资源's 推荐
/// badge fell to and the download the 判断 row suggested — until Run 3 (2026-09-24) measured it significantly
/// WORSE than no judge. It stays selectable and says so; the constant is gone, and 判断's local default is
/// <see cref="RecommendedReranker"/>. Qwen3 0.6B (Run 5b) is the first chat judge measured BETTER than no judge on
/// both metrics — and it is offered, not recommended: the reranker still puts the answer on the page far more often
/// (found@8 203 against 148 in the same run), which is what the owner kept the default for (2026-09-24).</para>
/// </summary>
public static class GgufCatalog
{
    /// <summary>The embedder 语义 uses. Same weights as Ollama's recommended model, a different
    /// quantisation, and measured as an equal on retrieval at half the size.</summary>
    public const string RecommendedEmbedder = "embeddinggemma-300M-Q8_0";

    /// <summary>The reranker the bilingual bench recommends (docs/judge-bench.md, Run 2) — by the tie rule
    /// declared before the run, and by NOTHING measured. Paired on the same 240 questions, LAMAR and BGE were
    /// neither significantly different nor equivalent on top-1 or on found@8, so the rule took the smaller
    /// file — and the two files differ by 1,408 bytes.
    ///
    /// <para><b>The leans are not symmetric, and the notes say so.</b> found@8 — the metric a reranker is FOR —
    /// leans LAMAR 5–0 (exact p = 0.063, just short; the bench's own interval [−4.0, −0.1] pp excludes zero),
    /// while BGE's top-1 lead is 6–2 (p = 0.289, an interval spanning zero). The rule stands as registered:
    /// re-picking after seeing which way the data leaned would be worse than a tie-break that runs against the
    /// lean. It is a tie-break, and <see cref="RerankerPair"/> says that where the household reads it.</para>
    ///
    /// <para><b>It is also 判断's local DEFAULT</b> (owner decision, 2026-09-24): the model 资源's 推荐 badge offers
    /// once the embedders are in, and the download the 判断 row suggests when llama.cpp holds no judge model. That
    /// job was the Gemma 3 1B chat model's until Run 3 measured it worse than no judge; a reranker is a local
    /// judge that measured BETTER (Runs 2 and 4). So is Qwen3 0.6B (Run 5b), a chat judge — and it stays offered, not
    /// the default: it ranks the answer first more often than BGE and gets it onto the page far less often (found@8
    /// 148 against 203), and the owner kept the reranker (2026-09-24). Which reranker is still the tie-break above, and the note says
    /// so where the badge points. Its display name carries no 推荐 — no row's does — because a name is read in
    /// every picker, long after the advice has been taken. Re-run <c>dev.mjs judge-bench</c> before treating the
    /// choice between rerankers as more than the tie-break.</para>
    ///
    /// <para><b>Except where llama.cpp sees no GPU</b> — see <see cref="RerankerWithoutGpu"/> and
    /// <see cref="RecommendedRerankerFor"/>.</para></summary>
    public const string RecommendedReranker = "bge-reranker-v2-m3-Q5_K_M";

    /// <summary>The reranker recommended where the runtime's device probe found NO GPU (owner decision, 2026-09-25, on
    /// <c>docs/judge-bench.md</c> Run 8). On that run's CPU — Intel Core Ultra 9 185H, llama.cpp b10549 launched with
    /// <c>device = none</c> and <c>n-gpu-layers = 0</c>, 60 notes of 883–1,241 characters, 240 questions, no embedder, no
    /// subject tags, a page of 8 — mMiniLMv2 judged every recall within the minute (chunked: 17.5 s median, 22 s at most)
    /// and put the answer on the page 180 of 240 times against no judge's 104; BGE scored ~3.1 s per 1,000 pair tokens,
    /// so a recall of 40–60 long notes needed 80–120 s even at one window each, and it judged 10 of 240 (found@8 104 —
    /// no judge's). <b>Why "no GPU" and not "no layers on the GPU"</b>: the same run found that <c>n-gpu-layers = 0</c>
    /// alone is not a CPU run — with a GPU visible, llama.cpp still offloads a big batch's work to it (a 48-note BGE call:
    /// ~5 s, against 143 and 197 s with <c>device = none</c>) — so what decides is whether llama.cpp lists a GPU device at
    /// all (<see cref="LlamaServerState.Gpu"/>), which a machine without one does not.
    ///
    /// <para><b>…and that almost never fires</b> (review, 2026-09-25): the Vulkan build the app provisions lists an
    /// INTEGRATED GPU as a device — this very machine lists <c>Vulkan1: Intel Arc</c> — so nearly every x64 laptop reads
    /// "GPU". On that very laptop's Arc both rerankers were then measured SLOWER than its CPU (docs/judge-bench.md Run 8b,
    /// descriptive — its rule was not read — and the device measurement on the real binary, docs/self-managed-llm-runtime.md,
    /// 2026-09-26), which is why the app now measures a reranker's devices instead of reading the list
    /// (<see cref="RerankDeviceMeter"/>). So the recommendation follows what was measured or done HERE: a recall the pace
    /// skipped because this machine was too slow (<see cref="RerankPace.RecentSkips"/>), or BGE measured too slow on every
    /// device that gave a result, recommends this model whatever the device probe says
    /// (<see cref="RecommendedRerankerFor"/>).</para></summary>
    public const string RerankerWithoutGpu = "mmarco-mMiniLMv2-L12-H384-v1-Q8_0";

    /// <summary>Which reranker to suggest for 判断, given what the runtime's device probe found, whether the judge has
    /// been SKIPPED here for being too slow, and whether BGE was MEASURED too slow here — the ONE writer both 资源's 推荐
    /// badge and the 判断 row's suggestions read. <see cref="RerankerWithoutGpu"/> when recent recalls were skipped
    /// (<paramref name="skippedHere"/>), when BGE's fastest device on this machine would not be sent the default page's
    /// one-window call (<paramref name="bgeMeasuredTooSlow"/>, <see cref="RerankDeviceVerdict.ReferenceAdmission"/> — owner
    /// decision 2026-09-26: the device list cannot tell an integrated GPU from a discrete one, so the app measures — BGE's
    /// measurement only; another reranker measured too slow moves nothing), or when
    /// the probe ANSWERED and listed no GPU (<paramref name="gpu"/> false) — that precedence is the order the badge's
    /// reason names them in. Otherwise — a GPU, no skips and no measurement saying otherwise, or no answer yet (null: the
    /// probe has not run, or the runtime is not installed) — <see cref="RecommendedReranker"/>, claiming nothing about the
    /// machine. A measurement exists only once BGE is on disk, so on a machine whose only GPU is integrated this still says
    /// BGE until BGE has been downloaded and measured.</summary>
    public static string RecommendedRerankerFor(bool? gpu, bool skippedHere = false, bool bgeMeasuredTooSlow = false) =>
        skippedHere || bgeMeasuredTooSlow || gpu == false ? RerankerWithoutGpu : RecommendedReranker;

    /// <summary>What the 判断 row says when the pace SKIPPED recent recalls (<see cref="RerankPace.RecentSkips"/>) — a skip
    /// is otherwise an Information line in state/logs, which is where a household never looks. With
    /// <paramref name="offerSmaller"/> it points at <see cref="RerankerWithoutGpu"/>; the caller withholds that when the
    /// small reranker is the one bound or already downloaded, where the advice would be to fetch what they have.</summary>
    public static string SkipNotice(int skipped, int recalls, bool offerSmaller) =>
        $"最近 {recalls} 次检索里有 {skipped} 次因为这台机器太慢,跳过了判断、按没有判断时的顺序返回"
        + "(应用最多每十分钟重新测一次速度,赶得上就恢复)。"
        + (offerSmaller
            ? "可以在「资源 · Resources」下载 mMiniLMv2 改用它:它只有 BGE 的 28%,在一台只用 CPU 的笔记本上每次检索都在一分钟内判断完"
              + ";在同一台笔记本的集成显卡上,它和 BGE 都比它的 CPU 慢(实测和设置见它那一行的说明)。"
            : "");

    /// <summary>What every reranker row says, because it is the one thing that differs from a chat judge:
    /// only HALF of 判断 moves. The tagging clause is <see cref="Sources.MemorySources.CliTaggingCost"/>, shared
    /// with the cost line and the bind toast — it once left out that tagging spends the account.</summary>
    private const string RerankerNote =
        "判断用的重排模型:检索时的判断在本机完成;写入事实时的主题标注由 Claude CLI 完成("
        + Sources.MemorySources.CliTaggingCost + ")。";

    /// <summary>What a reranker row's measured figures are read AGAINST — the same 240 questions with 判断 off
    /// and with the Claude CLI judge, the two other answers this layer offers (docs/judge-bench.md, Runs 1 and
    /// 2: same seed, same questions, equal formula digests). Shared because the comparators are the same for
    /// every reranker, and a figure with nothing beside it cannot be weighed. The trade is stated both ways:
    /// a reranker puts the answer on the page far more often and first hardly more often, because it chooses
    /// which eight make the page and the engine still orders them.
    /// <para>The Claude figures are Run 1's CONTENT-ONLY arm (130 / 131, serial median 8.7 s, Haiku) — the judge input
    /// that ships since 2026-09-24 — not its <c>content</c> arm (topic — content: 132 / 133, 9.5 s), the 1.3.0
    /// input, which Run 1 measured equivalent. A number belongs to its configuration. The wait is
    /// <see cref="Sources.MemorySources.ClaudeJudgeWait"/>, the one writer the CLI row quotes too.</para></summary>
    private const string RerankerMeasuredAgainst =
        "同一测试集上,不开判断是 79/240 与 125/240(每次约 0.23 秒),Claude CLI 判断(Haiku)是 130/240 与 131/240"
        + "(每次" + Sources.MemorySources.ClaudeJudgeWait + "):重排把答案带进前八的次数多得多,排到第一的次数却只比不开判断略多 —— "
        + "它挑哪八条上页,先后仍按原来的排序。";

    /// <summary>The configuration every reranker row's figures were measured in (docs/judge-bench.md Runs 2 and 4): the
    /// 240-question fixture, 语义 off (no embedder), and each recall's page of 8 chosen by the reranker (EndorseCount =
    /// the page). A reranker's gain belongs to its configuration — with an embedder, or a different page, it was not
    /// measured — so the figures never appear without it.</summary>
    private const string RerankerBenchSetup = "本应用双语测试集 240 道提问、不开语义、每次检索由它挑 8 条上页:";

    /// <summary>What a reranker row's latency was measured UNDER: serial medians with the model already loaded,
    /// on one machine's GPU, over recalls of at most 60 candidates (docs/judge-bench.md, Run 2). A reranker
    /// scores every candidate it is shown, so a CPU-only machine — or a recall showing it more — may be much slower.
    /// A bare 「0.47 秒」 would promise that figure on any machine.
    ///
    /// <para><b>How many it is shown depends on the recall's LIMIT</b>, not only on its kind: Lyntai verifies 4× the
    /// candidates <c>FactIndex.RankAsync</c> asks for, which is min(3 × limit, 100) with no kind and 100 with one — so
    /// up to 96 at the default page of 8, and 400 on a recall naming a kind OR asking for 34 or more. This said
    /// 「限定类别、候选可达 400 条」 until 2026-09-24, true only at the default limit.</para>
    ///
    /// <para><b>And on how LONG the candidates are</b> (<c>docs/judge-bench.md</c> Runs 6 and 6c): the row figures are on
    /// facts of at most 101 characters. A candidate longer than one window is scored in several (ChunkedScoreProvider,
    /// the default since 2026-09-24), each window a pair the model scores, so the same recall on 60 notes of 883–1,241
    /// characters — the same GPU, warm, serial medians — took 3.2 s on BGE and LAMAR (3,150 / 3,156 ms) and 1.2 s on
    /// mMiniLMv2 (1,155 ms), against 2.0 / 2.2 / 0.5 s when each note was cut to its first window. The clause names those
    /// figures and their notes, because 「事实很长时更慢」 alone would not let a household weigh it.</para>
    ///
    /// <para><b>What happens on a SLOW machine</b> (2026-09-24, reviewed twice 2026-09-25): the per-call window count was
    /// tuned on that GPU, so a chunked call is sized by the speed this process measures (<see cref="RerankPace"/>) to fit
    /// half the 60-second verification deadline — fewer windows per long candidate, down to one, the cut, whose cost Run 6
    /// measured (an answer past the first window is not read). The clause says what the household experiences, each part
    /// what the code does:
    /// <list type="bullet">
    /// <item>After every launch the pace starts from the rate the app MEASURED for this reranker on the device it runs on
    /// (<see cref="RerankDeviceMeter"/>, <see cref="RerankDeviceVerdict.PaceSeed"/>) — never faster than the GPU figure, which
    /// is also where it starts with no measurement — and learns only from the calls it times, so an estimate that is too
    /// fast still lets the first recall after a launch with too many long facts to read run to the full minute and come
    /// back unjudged (the verification cut there is NoOpinion, the engine's own order). The GPU figure is a measurement on
    /// one discrete GPU (<see cref="RerankPace.SeedMsPerToken"/>), hence 「一块独立显卡上的参考速度」.</item>
    /// <item>ONE such wait is damped — it slows the estimate at most ×4 (<see cref="RerankPace.MaxLoneRaise"/>) — so that a
    /// single stall does not switch the judge off; a second in a row is believed. So a machine that truly is slow waits the
    /// minute TWICE before the app believes it, and the clause says so.</item>
    /// <item>After a wait, every recall with a long fact reads ONE window per fact until one comes back in time, and that
    /// answer sets the pace (<see cref="RerankPace.AfterCut"/>).</item>
    /// <item>Where even one window per fact is predicted past <see cref="RerankPace.OneWindowLimit"/> — ~48 s, 0.8 of the
    /// minute (<see cref="RerankPace.OneWindowShareOfDeadline"/>), or half the minute while the estimate is only a lower
    /// bound after a wait — the recall is SKIPPED at once, re-measured with a probe of a few seconds at most once per ten
    /// minutes (<see cref="RerankPace.ReprobeInterval"/>), resumed when that says it fits; and for a minute or two after a
    /// wait, recalls skip too, because llama-server goes on scoring the abandoned call (<see cref="RerankPace.QueueFactor"/>).
    /// The figure is computed from those constants, so the sentence cannot drift from the code. It said 「来不及」 until
    /// review, which read as "not within the minute" while the code skipped at HALF of it.</item>
    /// <item>The skips are counted and the 判断 row says so (<see cref="SkipNotice"/>).</item>
    /// </list></para>
    ///
    /// <para><b>The CPU measurement is ONE row's, not every row's</b> (review, 2026-09-25: the clause had grown to 978
    /// characters inside one parenthesis, repeated on three rows). Run 8's figures are the reason mMiniLMv2 is recommended
    /// without a GPU, so they sit in mMiniLMv2's row (<see cref="SmallRerankerCpuNote"/>); BGE's row says what that run
    /// found for BGE (<see cref="BgeCpuNote"/>) and LAMAR's that it was not run there (<see cref="LamarCpuNote"/>).</para>
    ///
    /// <para><b>Mixed recalls, for every reranker — docs/judge-bench.md Run 9</b> (VALID; 1a22630): 30 short facts beside 30
    /// long notes of ~900–1,200 characters, the same 240 questions, on the GPU, no 语义, no subject tags, a page of 8.
    /// Reading the long notes in windows did not significantly lower found@8 on the 120 questions whose answer is a SHORT
    /// fact (BGE 94 → 91, LAMAR 101 → 99, mMiniLMv2 98 → 97; 3/0, 2/0, 2/1, p ≥ 0.25), and a loss of up to 5.6 / 4.4 / 4.0
    /// points is not ruled out — so "no cost" is not claimed; on the 120 whose answer is in a LONG note, windows brought in
    /// +30 / +50 / +69 (73 → 103, 54 → 104, 18 → 87). It said 「长短事实混在一起的检索还没有量过」 until that run; the
    /// sentence is no stronger than the intervals.</para></summary>
    private static readonly string RerankerLatencyCaveat =
        "(模型已加载、在显卡上、每次不超过 60 条候选、事实都很短时测得。候选更多、事实更长或机器更慢时都会慢得多 —— "
        + "默认每次取 8 条时候选最多 96 条,限定类别或一次要 34 条以上时可达 400 条;"
        + "较长的事实会分段打分、每段算一次,在同一块显卡上、60 条约 900–1,200 字的长笔记上,"
        + "BGE 与 LAMAR 每次检索约 3.2 秒,mMiniLMv2 约 1.2 秒。"
        + "机器较慢时,应用按测到的速度让长事实少读几段,最少只读开头一段(写在后面的答案就读不到)。"
        + "每次启动后它先按应用在这台机器上为它实测的速度估计(没有实测、或实测比一块独立显卡上的参考速度还快时,按那个参考速度);"
        + "估计偏快时,启动后头一次要读的长事实太多,仍可能等满一分钟、按没有判断时的顺序返回;"
        + "单独一次等满,应用只把速度估计放慢几倍,免得一次偶然的卡顿就停掉判断,所以真正慢的机器一般要等满两次,应用才信它慢。"
        + "等满之后,遇到长事实的检索先每条只读开头一段,等有一次在时限内做完、测出这台机器的速度,再按它分段。"
        + $"预计每条只读开头一段也要超过约 {OneWindowLimitSeconds} 秒(刚等满过一分钟时是半分钟)时,"
        + "应用当即跳过这次判断、按没有判断时的顺序返回,最多每十分钟花几秒重新测一次速度,赶得上就恢复;"
        + "等满一分钟之后的一两分钟里,检索也会先跳过判断(那次打分还在后台算)。跳过了几次,「判断」那一行会写出来。"
        + "长短事实混在一起时(在显卡上,30 条短事实加 30 条约 900–1,200 字的长笔记、240 道提问、不开语义、没有主题标注、"
        + "每次由它挑 8 条上页),分段读没有让答案在短事实里的提问显著少进前八(120 道里 BGE 94→91、LAMAR 101→99、mMiniLMv2 98→97,"
        + "但排除不了最多约 4–6 个百分点的损失),答案在长笔记里的则多进了 30–69 道)";

    /// <summary>The limit a one-window call is sent under while the estimate comes from an answer, in whole seconds at the
    /// product's deadline — read from <see cref="RerankPace.OneWindowShareOfDeadline"/> and
    /// <see cref="VerificationDeadlinePolicy.Default"/>, so the household sentence quotes what the code does: 48.</summary>
    private static int OneWindowLimitSeconds =>
        (int)Math.Round(RerankPace.OneWindowShareOfDeadline * VerificationDeadlinePolicy.Default.TotalSeconds);

    /// <summary>docs/judge-bench.md Run 8, configuration first — mMiniLMv2's row, because it is why that row is recommended
    /// where llama.cpp can use no GPU, or where the judge has been skipped for being too slow (<see cref="RerankerWithoutGpu"/>).
    /// 182/240 is Run 6c's GPU figure, another run, descriptive. 「集成显卡也算显卡」 says why a laptop with only an integrated
    /// GPU is not offered it by the device probe. What an integrated GPU does is said once, here, for that same laptop's Arc:
    /// both rerankers slower than its CPU — mMiniLMv2 5.1× (Run 8b) to 6.7× (the device measurement with only the Arc
    /// visible), BGE 2.7–3.3× — figures from ONE machine, labelled so; with only the Arc visible the app chose the CPU for
    /// both and, BGE being too slow for the default page there, moved the badge to mMiniLMv2 (docs/self-managed-llm-runtime.md,
    /// 2026-09-26). Run 8b's accuracy figures are not quoted: its rule was not read. It said 「两者都还没有量过」 until then. The
    /// third reason it is recommended — BGE MEASURED too slow on this machine (<see cref="RerankDeviceVerdict"/>) — needs BGE
    /// on disk first, which the note says, and it makes 「有显卡时推荐的仍是 BGE」 conditional on that measurement.</summary>
    private const string SmallRerankerCpuNote =
        "llama.cpp 用不了任何显卡时(集成显卡也算显卡),应用推荐它而不是 BGE;"
        + "用着别的重排模型、检索却因为机器太慢跳过了判断时,「判断」那一行也会建议改用它;"
        + "BGE 下载后,应用会在这台机器的 CPU 和每块显卡上测它的速度,连最快的设备都赶不上时,「资源」也会改为推荐它。"
        + "在一台只用 CPU 的笔记本上实测过(Intel Core Ultra 9 185H,不用显卡,llama.cpp b10549;"
        + "60 条约 900–1,200 字的长笔记、240 道提问、不开语义、没有主题标注、每次由它挑 8 条上页):"
        + "它分段读每次检索约 17.5 秒、最慢约 22 秒,每次都在一分钟内判断完,答案带进前八 180/240"
        + "(不开判断 104/240;在显卡上另一轮是 182/240)。"
        + "同一台机器上 BGE 每 1,000 个词元要约 3 秒,40–60 条长笔记每条只读开头一段也要一分多钟到两分钟,"
        + "240 次里 230 次等满一分钟(那时应用还不会跳过),带进前八和不开判断一样(104/240)。"
        + "LAMAR 没有在只用 CPU 的机器上量过。有显卡、BGE 在这台机器上也没有测出太慢时,推荐的仍是 BGE。"
        + "只有集成显卡时:在同一台笔记本的 Arc 集成显卡上,两个重排模型都比它的 CPU 慢(mMiniLMv2 约 5–7 倍,BGE 约 3 倍;"
        + "只是这一台机器上的数)。所以应用在下载后第一次自己启动 llama.cpp 时,会在 CPU 和每块显卡上各测一次,"
        + "让它在最快的那个上运行 —— 那台笔记本只露出集成显卡时,两者都选了 CPU;"
        + "BGE 在那里连 CPU 上也赶不上默认检索里的长事实,应用测完就改为推荐 mMiniLMv2。";

    /// <summary>BGE's own line from Run 8 — what the household on a CPU would meet — pointing at mMiniLMv2's row for the
    /// configuration. The minute-waits were BEFORE the skip existed; the skip removes the wait and cannot add a verdict,
    /// so the sentence says both. And what the app does about it on the household's own machine — measured only once BGE
    /// is on disk (<see cref="RerankDeviceMeter"/>) — so the recommendation can move to mMiniLMv2 only after a download.</summary>
    private const string BgeCpuNote =
        "只用 CPU 时它几乎总是来不及判断:在一台只用 CPU 的笔记本上(实测和设置见 mMiniLMv2 那一行),"
        + "它每 1,000 个词元要约 3 秒,40–60 条长笔记每条只读开头一段也要一分多钟到两分钟,"
        + "240 次检索里 230 次等满一分钟、没能判断(那时应用还不会跳过;现在会当即跳过,同样没有判断),"
        + "带进前八和不开判断一样(104/240)。所以 llama.cpp 用不了任何显卡时,应用推荐 mMiniLMv2;"
        + "它在这台机器上多快,应用要等下载之后才测得出(在 CPU 和每块显卡上各测一次,之后让它在最快的那个上运行),"
        + "连最快的设备都赶不上时,也改为推荐 mMiniLMv2。"
        + "在同一台笔记本的集成显卡上,它比它的 CPU 还慢约 3 倍(实测和设置见 mMiniLMv2 那一行)。";

    /// <summary>LAMAR was not run on the CPU. Its size is BGE's, so BGE's outcome is the likely one — said as likely,
    /// pointing at the row that has the measurement.</summary>
    private const string LamarCpuNote =
        "LAMAR 没有在只用 CPU 的机器上量过;和它一样大的 BGE 在一台只用 CPU 的笔记本上几乎每次都来不及判断"
        + "(见 BGE 那一行),所以 llama.cpp 用不了任何显卡时,应用推荐 mMiniLMv2。";

    /// <summary>LAMAR against BGE, ONE sentence shared by both rows — the same comparison read from either side,
    /// so the two notes cannot tell it differently. It used to say only that the fixture could not separate
    /// them, which hid that the two leans are not symmetric: found@8, where a reranker earns its place, leans
    /// LAMAR with nothing on the other side (5–0; exact p = 0.063, just short, while the 95% interval excludes
    /// zero), and BGE's top-1 lead is 6–2 with an interval spanning zero. The Chinese count is the one the doc
    /// states exactly: every Chinese-worded question, code-switched included (120 of 240) — see "By fact
    /// language" in docs/judge-bench.md.
    ///
    /// <para><b>What "6" counts, recounted 2026-09-24 from <c>results-2026-09-23T113455.224Z.json</c></b>
    /// (partition arms, limit 8): six DISTINCT questions on which the two differ on top-1 or on found@8, and
    /// none differs on both — top-1 on four (anniversary and pharm-24h LAMAR's, onsen and flu-shot BGE's),
    /// found@8 on two (train-express and movie, both LAMAR's). It once said 「4 题 LAMAR 对,2 题 BGE 对」,
    /// which is true only as a tally across the two metrics; the sentence now names the metric each count is
    /// on.</para></summary>
    private const string RerankerPair =
        "LAMAR 和 BGE 这个测试集没有测出差别,但两边并不对称:把答案带进前八,偏向 LAMAR —— 5 题只有 LAMAR 做到,"
        + "反过来一题也没有(精确检验 p = 0.063,差一点够不上显著,95% 区间不含零);排第一,BGE 多 4 题"
        + "(6 对 2,看不出差别)。120 道中文或中英混写的提问里,两者只有 6 题结果不同,没有一题两项都不同:"
        + "排第一的 4 题两边各占 2 题,带进前八的 2 题都是 LAMAR 做到。"
        + "推荐 BGE 只是按事先定好的规则 —— 分不出时取较小的文件,而两个文件只差 1.4 KB。";

    public static readonly IReadOnlyList<GgufModel> Models = new[]
    {
        new GgufModel(
            RecommendedEmbedder, "EmbeddingGemma 300M(Q8 · 语义)", GgufCapability.Embedding,
            "ggml-org/embeddinggemma-300M-GGUF", "0f741b5a6585bd53aeb15cd1372c56f2a0f65e12",
            "embeddinggemma-300M-Q8_0.gguf",
            "b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63", 333_590_944,
            // Compared with the SIBLING in the same group, which is the choice a household is actually making —
            // it used to compare with an Ollama option the panel no longer has. Numbers are the two rows' own
            // measurements, so the note cannot disagree with the table it sits in.
            "语义检索用,由 llama.cpp 运行。和内置的 ONNX 版本是同一个 EmbeddingGemma 模型:这一版首位命中多一题"
            + "(10 题中 9 对 8),代价是多一个运行时(约 35 MB)和一个常驻服务。",
            new EmbeddingMeasurement(9, 10, 25, 10, "2026-08-22")),

        // DESCRIBED BY ITS MEASUREMENT, NOT RECOMMENDED (docs/judge-bench.md Run 3, 2026-09-24). Every figure carries
        // the configuration it was measured in — the 240-question fixture, 语义 off (no embedder), the default
        // content-only judge input, and the no-judge base (79 / 125) it is read against — because a number without
        // them cannot be weighed. Content only is the arm quoted since it is what ships; `topic — content` read
        // 44 / 121, also worse on top-1. Its speed and quota facts stay: they are true, and they are the trade-off a
        // household is weighing against the result. The latencies are the SAME fixture's serial medians, model warm,
        // on one GPU: this judge 403 ms and no judge 219 ms (Run 3), the Claude CLI judge 8,733 ms (Run 1's content-only
        // arm, the shipped input). They read 「每次判断约 0.15–0.20 秒(Claude CLI 那条实测每次检索 9–17 秒)」 until
        // 2026-09-24: a per-CALL figure beside a per-RECALL one, the second from five runs on one household's 16 facts,
        // while the reranker rows beside it quoted Run 1's 8.7 s — two configurations in adjacent rows. The GPU clause
        // then sat after all three figures, as if it covered the CLI's too; it is scoped to the one figure it
        // describes, and the CLI wait comes from its one writer (MemorySources.ClaudeJudgeWait), with its model.
        new GgufModel(
            "gemma-3-1b-it-Q4_K_M", "Gemma 3 1B(Q4 · 判断)", GgufCapability.Completion,
            "ggml-org/gemma-3-1b-it-GGUF", "f9c28bcd85737ffc5aef028638d3341d49869c27",
            "gemma-3-1b-it-Q4_K_M.gguf",
            "8ccc5cd1f1b3602548715ae25a66ed73fd5dc68a210412eea643eb20eb75a135", 806_058_240,
            "判断用的对话模型:写入时的主题标注和检索时的判断都在本机完成,不消耗账号额度。"
            + "本应用双语测试集 240 道提问、不开语义、判断按默认只读事实内容:每次检索约 0.40 秒(模型已加载、在显卡上),"
            + "不开判断约 0.22 秒,Claude CLI 判断(Haiku)" + Sources.MemorySources.ClaudeJudgeWait + ",都是串行中位数。"
            + "但实测它让检索比不开判断更差:"
            + "答案排第一从不开判断的 79 题降到 33 题,带进前八从 125 题降到 111 题,"
            + "两项都是显著变差。量的是检索时的判断,它自己写的主题标注没有量过。"
            + "要在本机做判断,重排模型和 Qwen3 0.6B 在同一测试集上都让检索变好(见它们的说明)。"),

        // UNMEASURED HERE, and not a candidate we mean to recommend — said plainly, and without borrowing the 1B's
        // result in either direction: Run 3 measured one model at one size. Its size is the two pinned files': 2,489,757,856
        // B against the 1B's 806,058,240 — 3.1×, not the "四倍" this note once claimed for both parameters and footprint
        // (the parameter counts are ~4× apart; the Q4 files are not).
        new GgufModel(
            "gemma-3-4b-it-Q4_K_M", "Gemma 3 4B(Q4 · 判断 · 更大)", GgufCapability.Completion,
            "ggml-org/gemma-3-4b-it-GGUF", "d0976223747697cb51e056d85c532013931fe52e",
            "gemma-3-4b-it-Q4_K_M.gguf",
            "882e8d2db44dc554fb0ea5077cb7e4bc49e7342a1f0da57901c0802ea21a0863", 2_489_757_856,
            "同样用于判断,参数量约是 1B 的四倍,文件约 2.5 GB,是 1B 的三倍多:更大、更慢,显存不够时会明显更慢。"
            + "判断质量没有在这里实测过 —— 1B 的实测结果说明不了它会怎样;我们也不打算推荐它。"),

        // THE LOCAL CHAT JUDGE THAT MEASURED BETTER (docs/judge-bench.md Run 5b, committed 1e8e743), offered and NOT
        // recommended: RecommendedReranker stays the local default by the owner's decision (2026-09-24). Every figure
        // is Run 5b's and carries its configuration — the 240-question fixture, 语义 off, content-only judge input,
        // thinking off with the 512-token cap (the preset LlamaServerRuntime.WritePresets writes for a chat model),
        // one chat model per run beside 公式 and BGE. top-1 79 → 110 (+12.9pp, p < 0.001) and found@8 125 → 148
        // (+9.6pp, p < 0.001) against no judge; against BGE in the same run, top-1 +8.3pp (p = 0.002) and found@8
        // 148 against 203 (−22.9pp). Serial median 381 ms against the run's 公式 220 ms. Coverage 226/234.
        //
        // ITS FOOTPRINT IS NOT ITS DOWNLOAD, and the note says so (docs/self-managed-llm-runtime.md, 2026-09-24). Its
        // training window is 40,960 tokens with full attention on all 28 layers, and an uncapped llama.cpp child reserves
        // the KV cache for all of it: +5,175 MiB of GPU memory for the router plus this child (nvidia-smi, b10549, one RTX
        // 4080 Laptop GPU) — 「约 5.4 GB」 — against a 639 MB file. The app launches chat models at 16,384
        // (LlamaServerRuntime.ChatContextTokens): +2,472 MiB on the same machine, 「约 2.6 GB」, both decimal GB like
        // every size in these notes. Run 5b launched it uncapped; the cap sits far above every fixture prompt (60
        // candidates, ~1.7k tokens), so its figures stand.
        //
        // Its TAGGING was measured in docs/judge-bench.md Run 7 (2026-09-24, same fixture, 语义 off, content-only, the
        // chat preset as the product writes it): a seed written by Qwen3-0.6B's own annotation, paired within the run
        // against Claude's final tags REPLAYED through the same path, so the two differ only in the tags. Qwen3 over its
        // own tags against Qwen3 over Claude's: top-1 104 vs 114 (24/14, p = 0.143, −4.2pp, 95% [−9.2, +0.9]), found@8
        // 155 vs 152 (16/19, p = 0.736, +1.3pp, [−3.6, +6.1]) — no significant difference and NOT equivalent (neither
        // interval inside ±3pp), so the note says what the run cannot rule out. Against no judge over the same tags,
        // +10.8 / +14.6pp, both p < 0.001. The tags are worse in KIND — Lyntai's collapse: `parent` on 12 facts, 29 of 78
        // handle assignments reused only across unrelated groups against Claude's 7 of 65 — and the fixture barely
        // exercises the linking tags exist for, so the note says a household relying on it may pay a cost this run does
        // not show. It said 「它自己写的主题标注好不好没有量过」 until Run 7. Why a household might pick it is the same
        // fact's other half: tagging and checking both stay on the machine, no account quota.
        // Pinned at Qwen's own repo, commit and sha256 as Run 5's pre-registration recorded them; HEAD-checked
        // 2026-09-24 (X-Repo-Commit and X-Linked-Size / X-Linked-ETag match). The repo itself declares Apache-2.0.
        // Id = the upstream stem, as every row.
        new GgufModel(
            "Qwen3-0.6B-Q8_0", "Qwen3 0.6B(Q8 · 判断)", GgufCapability.Completion,
            "Qwen/Qwen3-0.6B-GGUF", "23749fefcc72300e3a2ad315e1317431b06b590a",
            "Qwen3-0.6B-Q8_0.gguf",
            "9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031", 639_446_688,
            "判断用的对话模型:写入时的主题标注和检索时的判断都在本机完成,不消耗账号额度。"
            + "本应用双语测试集 240 道提问、不开语义、判断按默认只读事实内容、关闭思考(应用启动它时就这样设置),"
            + "每轮只测这一个对话模型:答案排第一从不开判断的 79 题增加到 110 题,带进前八从 125 题增加到 148 题,"
            + "两项都显著变好。和同一轮的 BGE 重排模型比:它把答案排在第一的次数更多(多 8.3 个百分点,显著),"
            + "BGE 把答案带进前八的次数多得多(203 对 148)。每次检索约 0.38 秒,同一轮不开判断约 0.22 秒"
            + "(串行中位数,模型已加载、在显卡上)。"
            + "文件约 640 MB,运行时 llama.cpp 为它预留的显存却约 2.6 GB(应用按 16,384 个词元的上下文启动它,"
            + "在一块显卡上实测、含服务本身;不设上限时会按它训练时的 40,960 个词元预留,约 5.4 GB)。"
            + "上面的数字是在 Claude 写的主题标注上量的。标注也换成它自己写的(同样的测试集和设置,写入和检索都在本机),"
            + "同一轮对比没有显著差别:答案排第一少 4.2 个百分点、带进前八多 1.3 个百分点,"
            + "但排除不了排第一最多少约 9 个、带进前八最多少约 4 个百分点;和同一批标注下不开判断相比,两项仍显著变好"
            + "(多 10.8 与 14.6 个百分点)。它的标注更宽泛,常把一个主题套到不相干的事实上(一个 parent 标了 12 条),"
            + "靠主题把关于同一个人的事实连起来的检索,可能有这个测试集看不出的代价。"
            + "许可:Apache-2.0(Qwen 的官方仓库写明)。"),

        new GgufModel(
            "LAMAR-600m.Q5_K_M", "LAMAR 600M(Q5 · 判断 · 重排)", GgufCapability.Reranking,
            "mradermacher/LAMAR-600m-GGUF", "cd4da764d5b17d9996710dbf0ef5ad31c9aed182",
            "LAMAR-600m.Q5_K_M.gguf",
            "ec708b20336577c63702dd8efb23060bc611933579572bf9ad47ce2eaeda546f", 468_393_760,
            // NO LoCoMo figure on either reranker row. Each once quoted Lyntai's English LoCoMo gain — this one
            // +9.0 of 9.5 (2026-09-15, nomic-embed-text, base 83.0%), BGE's +5.5 for its Q8 (2026-09-10,
            // embeddinggemma, base 85.5%) — so side by side they compared two different CONFIGURATIONS, and
            // tilted toward LAMAR in a run where LAMAR Q8 exactly EQUALLED BGE Q8. Lyntai's own rule is that a
            // reranker's delta belongs to its configuration (docs/memory-measurements.md). The household's
            // evidence is this app's own bench; the Lyntai figures, with their bases, are in dev-conventions.
            // The configuration rides with the figures (RerankerBenchSetup), as it does on the mMiniLMv2 row — these two
            // quoted bare 「本应用双语测试集」 while the row below said 不开语义 and 8 on the page.
            RerankerNote + RerankerBenchSetup + "首位命中 86/240,前八命中 208/240,每次检索约 0.47 秒"
            + RerankerLatencyCaveat + "。" + RerankerMeasuredAgainst + RerankerPair + LamarCpuNote),
        new GgufModel(
            RecommendedReranker, "BGE Reranker v2 M3(Q5 · 判断 · 重排)", GgufCapability.Reranking,
            "gpustack/bge-reranker-v2-m3-GGUF", "3093af03b1a635e67b084b1d8c03c5f5e020fd05",
            "bge-reranker-v2-m3-Q5_K_M.gguf",
            "1a212007526c7083627eed92b39dd4472e90ff1374a03fb068733378220813ef", 468_392_352,
            // No claim about public Chinese benchmarks: this row once said it was stronger than its peers there,
            // naming no benchmark and no source — an attribution nobody could check is not one.
            RerankerNote + RerankerBenchSetup + "首位命中 90/240,前八命中 203/240,每次检索约 0.49 秒"
            + RerankerLatencyCaveat + "。" + RerankerMeasuredAgainst + RerankerPair + BgeCpuNote),

        // THE SMALL RERANKER (docs/judge-bench.md Run 4, 2026-09-24): offered, and recommended ONLY where llama.cpp lists
        // no GPU (RerankerWithoutGpu, owner decision 2026-09-25 on Run 8) — elsewhere BGE stays RecommendedReranker by the
        // owner's decision. Every GPU figure below is Run 4's and carries its configuration: the
        // 240-question fixture, 语义 off, EndorseCount 8 = the page, candidates ≤ 60, base 79 / 125; BGE and LAMAR are
        // quoted from the SAME run (204 / 208), not from their own rows' Run 2 figures, because only a within-run
        // pairing says anything. Its found@8 against BGE is "no significant difference" and NOT "equivalent" (7/2,
        // p = 0.180, 95% [−4.6, +0.5]pp), and against LAMAR a measured loss (9/0, p = 0.004) — both said.
        // THAT PARITY IS A SHORT-FACT RESULT, so the note says 「(事实都很短时)」 on it (review, 2026-09-25). On Run 6c's
        // 60 long notes, both read in windows, the same pairing is a loss: found@8 182 against BGE's 201 of 240 (33/14,
        // p = 0.008, 95% [−13.4, −2.3]pp), mostly past 1,000 characters (38 against 51 of 60, 17/4 — one of 16 position cells,
        // so the note quotes it without a p and calls it descriptive: 「按位置拆开的数字只作描述」); top-1 79
        // against 87 (22/14, p = 0.243). It is a POST-HOC descriptive pairing — computed from the saved rows with
        // `--report-only`, not registered before the run — and the note says so (「测完后另算的比较」);
        // docs/judge-bench.md Run 6c has the table.
        //
        // THE ID IS THE UPSTREAM FILE NAME, and deliberately has no "rerank" in it. A catalogued id is typed by its
        // row (ResourceProvisioner.GgufKind asks the catalogue first), so it needs no name hint — and keeping the
        // upstream stem means a household who drops the file in under its own name gets THIS row too: typed a
        // reranker, and fitted to its window. Under an id of ours with "rerank" in it, that same dropped-in file
        // would stay uncatalogued and be typed a CHAT judge by its name — the hazard Run 4 recorded, which is why
        // the bench had to rename it. The other rows follow the same rule (id = upstream stem).
        //
        // ITS WINDOW IS 512 TOKENS — the GGUF's context_length, and the slot size llama.cpp serves it with whatever
        // the preset asks — so the row declares it: the preset launches it at 512, and RerankInputCap (the query and each
        // candidate's budget) plus ChunkedScoreProvider (a longer candidate's windows) fit every pair to it. At the 1,000-character cap every other reranker gets, dense Chinese is 781 tokens and the
        // whole call is refused. What the fit COSTS on a long fact was measured (docs/judge-bench.md Runs 6 and 6c, 60
        // notes of 883–1,241 characters, 240 questions, no subject tags, no embedder, a page of 8 chosen by the reranker):
        // cut to its first window, a note whose answer sat at its END reached the page 4 times in 60 — worse than no judge
        // (29) — and scored in windows (ChunkedScoreProvider, the default since 2026-09-24) 44 times; at the START, 52 and
        // 50, no significant difference. The note says both, with the configuration, and what is still unmeasured; its
        // long-note latency, what a slow machine does and the mixed-recall caveat are RerankerLatencyCaveat's, shared with
        // BGE and LAMAR. The note said 「这样截短…还没有量过」 until then, which Run 6 made false. Its unread-gap sentence
        // said gaps begin at FOUR window-lengths (「约 1,000–2,000 字以上」) — one window early: five windows at a quarter's
        // overlap cover four, and still cover five with the overlap shrinking to none (RerankInputCap.MaxWindows), so gaps
        // begin past 5 × 253–506 = 1,265–2,530 characters and take 1 − 5 × window ÷ length of the text.
        // Licence: the model card says Apache-2.0; its training set, mMARCO, is
        // a translation of MS MARCO, whose terms are non-commercial; the GGUF repo declares none — so the note says
        // what the CARD says rather than what the model "is".
        //
        // ITS LATENCY WAS MEASURED UNDER THE 4096 LAUNCH (Run 4's router preset, before this row declared 512), and the
        // product now launches it at 512 — so the rerank CALL was re-measured under both, 2026-09-24, on the same GPU:
        // dedicated llama-server b10549, --n-gpu-layers 99, 12 fixture questions × all 60 fixture facts per call, 36 calls
        // each after a warm-up — median 75.1 and 79.3 ms at 4096 (two runs), 76.3 ms at 512. No difference beyond the
        // 4096 launch's own run-to-run spread, so the whole-recall 0.31 s / +0.08 s stand, said as measured at 4096.
        // Reproducible: `dev.mjs rerank-window` (its part 3); docs/self-managed-llm-runtime.md records the run.
        new GgufModel(
            RerankerWithoutGpu, "mMiniLMv2(Q8 · 判断 · 重排 · 更小)", GgufCapability.Reranking,
            "keisuke-miyako/mmarco-mMiniLMv2-L12-H384-v1-gguf-q8_0", "2b37d162c88e0aeb8a1b4acb2d50f0e5ade16fd5",
            "mmarco-mMiniLMv2-L12-H384-v1-Q8_0.gguf",
            "91d70301828ba735c22eda56adb649f48975f371337e8c8b046326b885e26eed", 132_584_000,
            RerankerNote + "体积约 133 MB,是 BGE 的 28%。"
            // Its CPU result (docs/judge-bench.md Run 8) is the reason it is the no-GPU recommendation, so the row says so up
            // front, with the figures and their configuration — this row's alone; BGE's and LAMAR's point here.
            + SmallRerankerCpuNote
            + RerankerBenchSetup.TrimEnd(':')
            + "(不开判断是 79/240 与 125/240):前八命中 199/240,同一轮 BGE 是 204/240 —— 没有测出显著差别(事实都很短时),"
            + "但也不能算一样好,这一轮排除不了它最多少带进约 11 题;比 LAMAR(208/240)显著少,9 题只有 LAMAR 带进前八,"
            + "反过来一题也没有。首位命中 99/240,比同一轮 BGE 的 90 和 LAMAR 的 86 多,但和 BGE 的差距不足以下结论。"
            + "每次检索约 0.31 秒,同一轮 BGE 约 0.45 秒" + RerankerLatencyCaveat + ";这一轮是按 4096 个词元启动它的,"
            + "应用现在按 512 启动 —— 单次重排调用(60 条候选)在两种启动下另测过,都约 0.08 秒,看不出差别。"
            + "它一次最多只能读 512 个词元:应用把提问截短到放得下,较长的事实则分成几段来读 —— 每段约 250–500 个字符,"
            + "相邻两段有重叠,一条最多 5 段 —— 各段分别打分、取最高的一段。这是量过才改的:在 60 条约 900–1,200 字的长笔记上"
            + "(240 道提问、不开语义、没有主题标注、每次由它挑 8 条上页),答案在笔记末尾时,只读开头的旧做法把答案带进前八"
            + "只有 4/60,比不开判断(29/60)还差;分段读之后是 44/60。答案在开头时两种做法没有显著差别(52/60 与 50/60)。"
            + "在同一批长笔记上、两者都分段读时(在显卡上;测完后另算的比较),它把答案带进前八显著少于 BGE:182/240 对 201/240,"
            + "33 题只有 BGE 做到、14 题只有它做到(p = 0.008),差距主要在答案写在 1,000 字以后的笔记"
            + "(38/60 对 51/60;按位置拆开的数字只作描述);排第一是 79/240 对 87/240,没有显著差别。"
            + "5 段也读不完的事实(1,265–2,530 字以上,提问越长、每段越短)还没有量过:段与段之间会有读不到的部分,"
            + "事实越长读不到的越多 —— 长到 5 段总长的两倍时,约一半读不到。"
            + "许可:模型卡写的是 Apache-2.0(下载用的 GGUF 仓库没有写明许可),但训练它用的 MS MARCO 数据只许非商业使用。",
            ContextTokens: 512),
    };

    public static GgufModel? Find(string? id) =>
        id is null ? null : Models.FirstOrDefault(m => string.Equals(m.Id, id, StringComparison.OrdinalIgnoreCase));

    /// <summary>The token window a model's row DECLARES, or null — the ONE read behind both halves of a reranker's
    /// input contract: the window <see cref="LlamaServerRuntime"/> launches it with, and the window
    /// <see cref="RerankInputCap"/> fits each (query, document) pair to. Two lookups could disagree; one cannot.
    ///
    /// <para><b>A GGUF the household dropped in has no row, so no declared window — a STATED limit.</b> What then
    /// happens to a small-window model depends on its NAME, because that is all <c>ResourceProvisioner.GgufKind</c>
    /// has: named with "rerank", it is served at 4096 with the 1,000-character cap and refused on long input, as
    /// before per-model windows existed; named without it — this very model's other quants included, whose upstream
    /// stems carry no "rerank" either — <c>ResourceProvisioner.GgufKind</c> types it CHAT, so it is never used
    /// as a reranker at all. The fix for such a model is a catalogue row, measured, not a guess from its file
    /// name.</para>
    ///
    /// <para>A declared window too small to hold a pair's overhead reads as none
    /// (<see cref="RerankInputCap.UsableWindow"/>) — the same rule the fitting applies, so the two halves agree.</para></summary>
    public static int? DeclaredWindow(string? id) => RerankInputCap.UsableWindow(Find(id)?.ContextTokens);

    /// <summary>The download URL. Assembled here so the pinned commit appears in exactly one place.</summary>
    public static string UrlFor(GgufModel m) =>
        Environment.GetEnvironmentVariable("GATHERLIGHT_GGUF_BASE_URL") is { Length: > 0 } b
            ? $"{b.TrimEnd('/')}/{m.File}"
            : $"https://huggingface.co/{m.Repo}/resolve/{m.Commit}/{m.File}";

    /// <summary>The resource id 资源 provisions this model under. Prefixed so it cannot collide with a
    /// runtime's id, and stable because the model id is.</summary>
    public static string ResourceIdFor(string modelId) => $"gguf-{modelId}";

    /// <summary>Reverse of <see cref="ResourceIdFor"/>, for a caller holding a resource id.</summary>
    public static string? ModelIdFrom(string resourceId) =>
        resourceId.StartsWith("gguf-", StringComparison.Ordinal) ? resourceId["gguf-".Length..] : null;
}
