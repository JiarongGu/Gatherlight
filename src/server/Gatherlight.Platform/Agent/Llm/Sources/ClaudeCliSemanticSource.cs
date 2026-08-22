using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// 语义 on the Claude CLI — by REPHRASING rather than by embedding.
///
/// <para><b>Why this exists, and why its absence was a defect.</b> This layer was defined as "turn a fact
/// into a vector", so the only backends it could have were embedders — which made it unavailable on exactly
/// the installs that need it most: a machine with no GPU to spare, a machine whose GPU is wanted for
/// something else, a household who declines a 222 MB download. On those, the panel offered no option and
/// explained why instead. "No class implements the interface" was true and circular: the class was absent
/// because we had defined the layer as embeddings.</para>
///
/// <para><b>What it actually does.</b> Claude ships no embeddings endpoint and this does not pretend
/// otherwise. Instead, when a fact is written it asks for a few other ways to say the same thing and stores
/// them beside the fact (<c>knowledge.aka</c>, indexed by the trigram FTS table). A later question phrased
/// differently then matches a stored phrasing. That changes what is RETRIEVABLE, which is this layer's job
/// and precisely what the judge cannot do — the judge only reorders what retrieval already found.</para>
///
/// <para><b>The cost is at WRITE time, deliberately.</b> The same idea at query time — rewrite the question,
/// then search — costs a CLI spawn on every recall, measured at ~9 s on the judge path, and on the very
/// machine that has no local alternative that is likely worse than no feature. Writes are rarer than
/// recalls and already carry a model call when 判断 is on, so this rides a cost the household has usually
/// accepted rather than adding one to the path they wait on.</para>
///
/// <para><b>What it is NOT.</b> Not a substitute for vectors. Stored phrasings generalise only to wording
/// somebody anticipated; an embedding generalises to wording nobody wrote down. Where a local model is
/// available, it remains the better arm — which is why this one says so in its own description rather than
/// letting a household discover it by measuring.</para>
/// </summary>
public sealed class ClaudeCliSemanticSource : IMemorySemanticSource
{
    /// <summary>How many phrasings to ask for. Small on purpose: each one is indexed text competing for
    /// bm25 relevance against the fact's own words, and a fact drowned in near-duplicates ranks worse for
    /// the query it was actually written for.</summary>
    public const int Phrasings = 4;

    public string Id => MemoryBackends.ClaudeCli;
    public string Name => "Claude CLI";
    public string Group => MemoryGroups.Cli;

    /// <summary>What it is, when to use it, and when NOT to — in that order, because this arm has a real
    /// downside and the household is the one who should weigh it.
    ///
    /// <para>It says the weakness out loud rather than leaving it to be discovered: stored phrasings only
    /// cover wording somebody anticipated. That is a reason to DESCRIBE this option, never a reason to
    /// withhold it — which is what happened for months, and what left a machine that cannot run a local
    /// model with no 语义 at all.</para></summary>
    public string Description =>
        "它不生成向量:写入每条事实时,让 Claude 把同一件事换几种说法再说一遍,一起存进检索索引 —— "
        + "之后换个问法也能命中。花费在写入那一次调用上;检索时不额外调用,也不变慢。"
        + "适合:这台机器跑不了或不想跑模型 —— 没有独立显卡、显卡要留给别的事,或者不想下载几百 MB;"
        + "也适合已经在用 Claude 做「判断」、不想再多一个常驻服务的情况。"
        + "不适合:能跑本机模型的时候。向量对「没人预料过的问法」更强,而这一条只覆盖改写时想到的说法 —— "
        + "同一个问题,向量可能命中而它可能漏。事实很多时,写入的调用次数也是要算的一笔。";

    public bool NeedsEndpoint => false;
    public string? Endpoint(MemorySourceSettings s) => null;

    /// <summary>Configured = the CLI is resolvable. There is no model file and no address; the model is
    /// whichever Claude model the household picked, and the account is already logged in or not.</summary>
    public bool IsConfigured(MemorySourceSettings s) => true;

    /// <summary>NOTHING to register. No embedder, no vector store, no <c>AddSemanticMemory()</c> — this arm
    /// does not produce vectors, so registering the vector half would create a store nothing ever fills and
    /// leave the engine reporting a semantic member that answers nothing.
    ///
    /// <para>Its effect is at write time instead: <c>FactIndex</c> reads the saved binding and expands each
    /// fact. That is why this is the one source whose <c>Register</c> is empty and still means something —
    /// and why the panel must report it as a binding that takes effect on the NEXT write rather than one
    /// that needs a restart to serve recalls.</para></summary>
    public void Register(LyntaiBuilder b, MemoryWiringContext ctx) { }

    /// <summary>Whose runtime: the household's own Claude account, through a CLI the app provisions.
    /// Deliberately the same answer <see cref="ClaudeCliJudgeSource"/> gives, because it is the same
    /// runtime — a household who has the CLI working for 判断 has it working here.</summary>
    public RuntimeOrigin Origin(MemorySourceContext ctx) =>
        RuntimeOriginFrom.Locate(ctx.Claude.Locate(),
            Hosting.Resources.Services.ResourceProvisioner.ProvisionedClaude(ctx.Settings.ResourcesPath),
            "Claude CLI");

    /// <summary>Three states with three different fixes: no CLI, a CLI that is not signed in, or ready.
    /// The same probe the judge arm uses — installed is not usable, and a signed-out CLI fails at the first
    /// write with a message about a missing file rather than about a login.</summary>
    public async Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        // Deliberately the SAME two questions, in the same order, as the judge arm asks — it is the same
        // runtime, and two wordings for one state is how a household ends up believing they are different.
        var state = await ctx.Claude.ProbeAsync(ct: ct);
        return !state.Runnable
            ? new SourceStatus(false,
                "这台机器上没有可运行的 Claude CLI —— 可在「资源 · Resources」面板安装。", "claude")
            : !state.LoggedIn
                ? new SourceStatus(false,
                    "Claude CLI 已安装但尚未登录 —— 在「资源」面板点「登录」,浏览器里完成一次即可。")
                : SourceStatus.Ready;
    }

    /// <summary>The Claude models this layer may use. The same three the judge offers, and cheap-first for
    /// the same reason: this runs once per fact written, so it is the household's second most frequent
    /// model call after the judge's.</summary>
    public Task<IReadOnlyList<ModelOption>> ModelsAsync(
        MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<ModelOption>>(new[]
        {
            new ModelOption("haiku", "haiku(便宜,够用)", Installed: true,
                Note: "写入每条事实时多一次调用 —— 改写几种说法,这一层用它就够。"),
            new ModelOption("sonnet", "sonnet(更贵,改写更好)", Installed: true,
                Note: "改写质量更好,但每条事实都要付一次 —— 事实多的时候差别明显。"),
            // NOT "you do not need this". The trade-off is stated and the choice is left where it
            // belongs:改写 is a small job, so the gain is likely slight — but "likely" is not measured,
            // and a household with a plan that makes cost irrelevant is entitled to spend it.
            new ModelOption("opus", "opus(最贵)", Installed: true,
                Note: "改写这件事很小,换更大的模型收益大概有限 —— 这一点没有实测过。每条事实都按 opus 计费。"),
        });

    /// <summary>PROVE it can actually rephrase before the binding is saved — the same rule every other arm
    /// follows, for the same reason: a signed-out CLI or a bad model would otherwise surface as facts that
    /// silently stop gaining phrasings, which reads as recall that never improved.
    ///
    /// <para>Returns the number of phrasings it produced in place of a vector width. That is not a vector
    /// and the label the console prints for it says so — what the caller needs from this is "it worked, and
    /// here is the evidence", which is the same question for both kinds of arm.</para></summary>
    public async Task<EmbedProbe?> ProveAsync(
        MemorySourceContext ctx, string model, CancellationToken ct = default)
    {
        if (ctx.Llm is null) return null;
        var started = System.Diagnostics.Stopwatch.StartNew();
        var phrasings = await RephraseAsync(ctx.Llm, model,
            "家里的猫叫做「豆豆」,吃鱼味的罐头。", ct);
        return phrasings.Count > 0
            ? new EmbedProbe(phrasings.Count, (int)started.ElapsedMilliseconds, "phrasings")
            : null;
    }

    /// <summary>Ask for other ways to say the same thing.
    ///
    /// <para>Static and dependency-free so the WRITE path can call it without going through a source
    /// instance — <c>FactIndex</c> owns the write, and duplicating this prompt there is how the phrasings
    /// a household proved at bind time would come to differ from the ones actually stored.</para>
    ///
    /// <para>Returns an empty list on any failure, never throws: expansion is an enhancement, and a fact
    /// that fails to gain phrasings must still be written. Failing the write would trade a better search
    /// for a lost fact.</para></summary>
    public static async Task<IReadOnlyList<string>> RephraseAsync(
        Lyntai.Llm.ILlmClient llm, string? model, string fact, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(fact)) return Array.Empty<string>();
        try
        {
            var prompt =
                "下面是一条家庭记录。请用不同的说法把同一件事再说几遍,用于全文检索的同义扩展。\n"
                + $"要求:{Phrasings} 行以内,每行一种说法,只输出这些行,不要编号、不要解释、不要引号。\n"
                + "用词要换(同义词、口语说法、另一种语言的常见叫法),但不要添加原文没有的信息。\n\n"
                + fact;
            var reply = await llm.CompleteAsync(new Lyntai.Llm.LlmRequest
            {
                Messages = new[] { new Lyntai.Llm.LlmMessage("user", prompt) },
                Model = model,
                // Bounded: four short lines. An unbounded reply here is an unbounded amount of text going
                // into the search index for one fact.
                MaxTokens = 300,
            }, ct);
            return (reply?.Text ?? string.Empty)
                .Split('\n')
                .Select(l => l.Trim().TrimStart('-', '*', '•').Trim())
                // Drop a line that is just the fact again, and anything long enough to be an explanation
                // rather than a phrasing — both add index noise without adding a way to find the fact.
                .Where(l => l.Length >= 2 && l.Length <= 200
                    && !string.Equals(l, fact.Trim(), StringComparison.OrdinalIgnoreCase))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(Phrasings)
                .ToList();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }
}
