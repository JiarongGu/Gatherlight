using Gatherlight.Server.Platform.Agent.Llm.Services;
using Gatherlight.Server.Platform.Kernel.Services;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>The layer ids, in one place. They are stored in settings.json and appear in URLs, so a typo
/// would produce a silently unbindable layer rather than a compile error.</summary>
public static class MemoryLayers
{
    public const string Formula = "formula";
    public const string Judge = "judge";
    public const string Semantic = "semantic";
}

/// <summary>Every backend a recall layer could conceivably run on — WHERE the model comes from, which is
/// the distinction the household actually makes.
///
/// <para><b>All three are listed on every layer</b>, whether or not that layer can use them. A layer
/// showing one button and no explanation for the absent ones is the dead-control failure this surface
/// exists to end, one level up: "there is no class implementing it" is an answer only the source tree
/// gives.</para></summary>
public static class MemoryBackends
{
    /// <summary>Map a stored backend id onto one that still exists.
    ///
    /// <para>ONE entry today: <c>ollama</c> → <c>openai-compat</c>, because the dedicated Ollama backend was
    /// removed and the generic one reaches the same daemon (verified — see <see cref="Ollama"/>). Applied on
    /// READ rather than by rewriting settings.json, matching how <c>memory.judgeTransport</c> is handled: a
    /// read-time map cannot half-succeed, and there is no migration to run twice.</para></summary>
    public static string Canonical(string? id) => id ?? "";

    /// <summary>Ids that used to name a backend and no longer resolve to one.
    ///
    /// <para><b>Nothing to map them TO, which is why they are surfaced instead.</b> `ollama` briefly pointed
    /// at `openai-compat`; then that went as well — it was the one path never tested end to end, its whole
    /// proof being that it correctly refuses things. So an install bound to either has no backend, and the
    /// two ways to handle that are opposites: fall back quietly, or SAY so. Falling back is what this area
    /// keeps getting caught by — 判断 would move to the CLI and start spending account quota nobody chose,
    /// and 语义 would simply switch off and report nothing. The layer therefore carries a sentence naming
    /// what it used to use and what to pick now.</para></summary>
    public static bool IsRetired(string? id) =>
        string.Equals(id, Ollama, StringComparison.OrdinalIgnoreCase)
        || string.Equals(id, OpenAiCompatible, StringComparison.OrdinalIgnoreCase);

    /// <summary>The authenticated Claude CLI — a provisioned resource, run as a process.</summary>
    public const string ClaudeCli = "claude-cli";

    /// <summary>LEGACY ONLY — an id that may still be sitting in an existing <c>settings.json</c>. There
    /// is no Ollama backend any more.
    ///
    /// <para><b>Why it went.</b> The managed local runtime is llama.cpp: we download it, start it, pin its
    /// models by sha256 and publish their measured ranking as downloadable resources. Ollama was a second
    /// runtime we half-managed — detected, listed and depended on, but pulled and deleted from only some
    /// screens — and that inconsistency was visible to the household. It bought nothing that survives
    /// scrutiny either: verified 2026-08-22 against a live daemon, <see cref="OpenAiCompatible"/> reaches it
    /// completely (<c>/v1/models</c> enumerates, <c>/v1/embeddings</c> returned 768 dims,
    /// <c>/v1/chat/completions</c> answered). So a household running Ollama still uses it — by address, like
    /// any other service they run. The OPTION is intact; only our pretence of owning it is gone.</para>
    ///
    /// <para>See <see cref="IsRetired"/> for what happens to an install still bound to it.</para></summary>
    public const string Ollama = "ollama";

    /// <summary>Any local runtime speaking the OpenAI-compatible API — Ollama, LM Studio, vLLM, Jan,
    /// LocalAI, a llama-server they started themselves. The household supplies the address and brings their
    /// own models; we cannot download or delete anything there, and the picker says so.
    ///
    /// <para><b>RETIRED too</b>, and for a different reason from Ollama's: it was never tested end to end.
    /// Every case in <c>p51</c> was a denial (non-loopback refused, junk refused, unreachable reported) or an
    /// address round-trip against a port with nothing listening — the suite's own comment said "saving the
    /// address and REACHING it are two different steps and only the first one happens here". No test, and no
    /// run, ever listed models from a live endpoint, embedded through it, or answered a judgement through it.
    /// Its only real evidence was that <see cref="LlamaCpp"/> uses the same underlying Lyntai provider.
    /// Shipping an option we cannot stand behind is worse than not offering it; the honest alternatives were
    /// to test it properly or drop it, and dropping it is what the product wanted anyway now that every
    /// remaining path is measured and pinned.</para></summary>
    public const string OpenAiCompatible = "openai-compat";

    /// <summary>llama.cpp's <c>llama-server</c>, PROVISIONED and run by this app — the self-managed runtime
    /// as of 2026-08-22. It speaks the same OpenAI-compatible API as <see cref="OpenAiCompatible"/>, and gets
    /// its own backend for the same reason Ollama does: the app MANAGES it, so it needs no address and its
    /// model list comes from what we downloaded rather than from what a household happened to load.</summary>
    public const string LlamaCpp = "llama-cpp";

    /// <summary>A model runtime shipped INSIDE the install (<c>res/</c>) rather than found on the machine —
    /// nothing to install, nothing to keep running.</summary>
    public const string BuiltIn = "builtin";

    /// <summary>The order every layer lists them in — FIXED, and deliberately not "usable ones first".
    ///
    /// <para>Sorting by status looked more actionable and cost more than it bought: the same four labels
    /// appeared in different positions on 判断 and 语义, so a household could never learn where a backend
    /// sits. Position is a landmark; whether an option is usable is carried by how it is DRAWN (muted, and
    /// with its reason on selection), which is a job styling does better than ordering.</para>
    ///
    /// <para>Cheapest first, in the sense of what the household has to have: the account they already use,
    /// then a daemon, then a daemon they must configure, then a download.</para></summary>
    /// <para><c>llama-cpp</c> sits between the household's own service and the bundled model: both it and
    /// <c>builtin</c> cost a download, and <c>builtin</c> is the smaller of the two (a model only, against a
    /// runtime plus a model), so it stays last. This shifted <c>builtin</c> by one position, which is a cost
    /// worth naming given the comment above — a landmark that moves once, deliberately, on the release that
    /// adds a backend.</para>
    private static readonly string[] Ordered = { ClaudeCli, Ollama, OpenAiCompatible, LlamaCpp, BuiltIn };

    public static IReadOnlyList<string> Order => Ordered;

    /// <summary>Where an id sits in <see cref="Order"/>; anything unlisted sorts LAST rather than throwing,
    /// so a backend added without touching this line still appears — just at the end.</summary>
    public static int Rank(string id)
    {
        var i = Array.IndexOf(Ordered, id);
        return i < 0 ? int.MaxValue : i;
    }
}

/// <summary>A backend a layer CANNOT run on, and why — stated rather than derived.
///
/// <para><b>Why this exists at all.</b> Leaving an impossible backend out of the list is the failure this
/// surface exists to end, one level up: a household looking at 语义 with a single button cannot discover
/// why Claude is not an option, and "there is no class for it" is an answer only the source tree gives.
/// The reasons are VENDOR facts — Anthropic ships no embeddings endpoint; Ollama refuses a chat model an
/// embedding call and an embedding model a chat call (verified 2026-08-21, both directions) — so they are
/// written down here, not computed from a capability table that would drift from them.</para>
///
/// <para>A declined backend is never bindable: it has no source, so there is nothing to bind. That is why
/// this is a separate list rather than a flag on <see cref="SourceStatus"/> — a shape that cannot be
/// selected should not be reachable through the type that selects things.</para></summary>
/// <param name="Group">Which heading it appears under — see <see cref="MemoryGroups"/>. Declared, not
/// derived: there is no source to ask, and a declined backend still belongs somewhere, because "why can
/// Claude not embed?" is a question about a place a household was looking.</param>
public sealed record DeclinedBackend(string Id, string Name, string Reason, string Group);

/// <summary>Whether a source can serve its layer on THIS machine right now, and the one sentence the
/// household reads when it cannot.
///
/// <para><see cref="Suggest"/> names a model the panel may offer to fetch, when the fix IS a download.
/// It exists because the alternative — printing a shell command at a household sitting in front of a
/// console that downloads models — draws a line the system does not have.</para>
///
/// <para><b>An unavailable source is still LISTED.</b> Dropping it would answer "why can't I pick this?"
/// by making the question unaskable, which is the dead-control failure this whole surface exists to end:
/// the previous panel disabled 本机模型 with no explanation while listing, three inches below, the very
/// models the household was wondering about.</para></summary>
public sealed record SourceStatus(bool Available, string? Reason = null, string? Suggest = null)
{
    public static readonly SourceStatus Ready = new(true);
}

/// <summary>WHERE THE MODEL LIVES — the three-way choice a household actually makes.
///
/// <para><b>Five backends were never five decisions.</b> The picker listed one row per implementation, so
/// `ollama` and `openai-compat` sat side by side as separate answers when they are the same answer
/// ("something already on my machine, that I run"), and `llama-cpp` and `builtin` likewise ("Gatherlight
/// handles it"). One row per layer was also DECLINED — 内置 cannot judge, Claude cannot embed — which made
/// a fifth of the control dead. The axis the household is choosing on is WHO MANAGES THE MODEL, and there
/// are exactly three answers.</para>
///
/// <para><b>The implementation stops being a decision and becomes a consequence.</b> Within a group the
/// household picks a MODEL, and a model belongs to exactly one source — an Ollama tag is Ollama's, a GGUF
/// is llama.cpp's, the ONNX bundle is its own. So no rule has to choose an engine for them, and nothing
/// auto-selects: the model choice IS the source choice, one level down where it belongs.</para>
///
/// <para>Grouping is therefore PRESENTATION. Sources stay one class per implementation
/// (<see cref="MemorySources"/>), the wire still binds a source, and this only says which heading a source
/// appears under — so a new backend joins a group instead of adding a button.</para></summary>
public static class MemoryGroups
{
    /// <summary>The authenticated Claude account. No local model, nothing downloaded.</summary>
    public const string Cli = "cli";

    /// <summary>A model the app downloads and runs — llama.cpp's <c>llama-server</c>, or the ONNX session we
    /// host in-process. Both are ours to install, start and delete; both cost disk.</summary>
    public const string Managed = "managed";

    /// <summary>NO MODEL. Choosing it turns the layer off and leaves 公式 doing the work.
    ///
    /// <para><b>Why this is a group and not just an absence.</b> "Off" was previously reachable only by a
    /// separate 停用 button, so the picker implied a model was mandatory and the way out lived elsewhere. It
    /// is a real answer to "where does this layer's model come from" — nowhere — so it belongs in the same
    /// row as the other answers, and it holds no backends because there is nothing to configure.</para>
    ///
    /// <para><b>The name has now been wrong TWICE, in opposite directions, and both are worth keeping.</b>
    /// First 内置 labelled the download group, whose own description said the app fetches a runtime and
    /// models — 35 MB plus 222 MB–2.5 GB, nothing built-in about it. Moving the word here fixed that and
    /// created a second collision immediately: <c>builtin</c> · 内置 is the id and the 资源 label of the
    /// ONNX embedder that runs INSIDE this process, so one word then meant "a real model, hosted by us"
    /// in one panel and "no model at all" in another. For a household on the Claude CLI that is the worst
    /// possible confusion, because the in-process embedder is exactly the option that gives them real
    /// vectors without a separate program — and the picker was telling them 内置 meant switching the layer
    /// off. So this group is 不用模型, which is what it is, and 内置 belongs to the thing that is built in.
    /// The rule the first fix stated still holds; it was applied to one name and not the other.</para></summary>
    public const string None = "none";

    /// <summary>Fixed display order, cheapest-first in what the household must already have: an account they
    /// use, then a download, then nothing at all.</summary>
    private static readonly string[] Ordered = { Cli, Managed, None };
    public static IReadOnlyList<string> Order => Ordered;

    public static int Rank(string id)
    {
        var i = Array.IndexOf(Ordered, id);
        return i < 0 ? int.MaxValue : i;
    }

    /// <summary>What the picker calls each group. Three short words on one row with the model select and the
    /// button — the earlier <c>zh · en</c> shape wrapped it.</summary>
    public static string Name(string group) => group switch
    {
        Cli => "Claude CLI",
        // NOT "llama.cpp". The group holds TWO runtimes and llama.cpp is only one of them — the other is an
        // ONNX session inside our own process, which uses no part of llama.cpp. Naming a group after one
        // member made the in-process embedder read as "you must download and run llama.cpp", which is the
        // opposite of what it is, and hid the ONE option that gives a Claude-CLI household real vectors
        // without a separate program. A group is keyed on what it COSTS; both members cost the same thing,
        // so the name says that instead of naming a runtime.
        Managed => "本机模型",
        // NOT 内置 either — see the note on `None`. 内置 is the in-process ONNX backend's name in 资源, and
        // reusing it here for "no model at all" gave one word two opposite meanings across two panels.
        None => "不用模型",
        _ => group,
    };

    /// <summary>One sentence per group, answering "what does choosing this cost me" — which is the question
    /// actually being asked, and the axis the three names are ordered on.</summary>
    public static string Description(string group) => group switch
    {
        Cli => "用已登录的 Claude 账号:不在这台机器上跑模型,不用下载任何东西 —— "
             + "代价是消耗账号额度,每次调用都要启动一次 CLI。",
        Managed => "由应用下载、启动和管理的模型,两种跑法:llama.cpp 起一个常驻服务,或者「内置」—— "
             + "直接在应用进程内跑 ONNX,不额外启动任何程序。模型在「资源 · Resources」面板下载,都实测排过名 —— "
             + "占磁盘,但不消耗账号额度,也不用填地址。",
        None => "不用模型:这一层关掉,检索只靠「公式」(图衰减 + 排名融合 + 三元组全文检索)。"
             + "不下载任何东西、不消耗额度、不占显存 —— 也就没有这一层带来的提升。",
        _ => "",
    };
}

/// <summary>WHO PROVIDES THE RUNTIME behind a backend, for this install.
///
/// <para>This axis existed in the product and was invisible in the panel, and the gap cost a whole design
/// conversation. 资源 has downloaded and started Ollama since 2026-08-21 — sha256-pinned zip, started when
/// the port is silent, models pulled through <c>/api/manage/models</c> — so "the app manages Ollama for
/// you" was already true. The picker said only <b>本机 · Ollama</b>, which reads as *your* Ollama, and the
/// app-managed half surfaced nowhere except a failure message. A household could therefore conclude that
/// 语义 required them to go install a daemon, and so, separately, could we: the justification originally
/// written for the built-in arm claimed 语义 was "the only layer you cannot switch on without first
/// installing a separate program", which was simply not true.</para>
///
/// <para><b>Three kinds, not two, because the third is genuinely different.</b> A bundled runtime has no
/// process and no port at all; a provisioned one is a program the app downloaded and starts; a household
/// one is a program we found and talk to but never manage. The difference matters to a household deciding
/// what they are signing up for, and — for <c>ollama</c> and <c>claude-cli</c> — it is not a property of
/// the backend but of THIS install, which is why it is resolved per call rather than declared as a
/// constant.</para></summary>
/// <param name="Kind">One of <see cref="MemoryRuntimeOrigins"/>.</param>
/// <param name="Text">The short label the picker shows. Written by the source, because only it knows
/// whether "the app installs this" is a promise or a description.</param>
public sealed record RuntimeOrigin(string Kind, string Text);

/// <summary>The three answers to "whose runtime is this". Strings rather than an enum for the same reason
/// <see cref="MemoryBackends"/> uses strings: they cross the wire to the console verbatim.</summary>
public static class MemoryRuntimeOrigins
{
    /// <summary>Runs inside this process — no separate program, no port, nothing to start.</summary>
    public const string Bundled = "bundled";

    /// <summary>A separate program the app downloaded into the data folder and starts itself.</summary>
    public const string App = "app";

    /// <summary>A program the household installed and runs; the app connects to it and never manages
    /// it.</summary>
    public const string Household = "household";
}

/// <summary>One model a source offers for its layer.
///
/// <para><see cref="Installed"/> false means it is offerable but must be fetched first — 资源 owns that.
/// <see cref="Measured"/> is null for anything nobody benchmarked, which the UI must SAY rather than leave
/// blank: an empty cell in a comparison table reads as a zero.</para></summary>
public sealed record ModelOption(
    string Id,
    string Name,
    bool Installed,
    long? SizeBytes = null,
    string? Note = null,
    EmbeddingMeasurement? Measured = null,
    string? Vintage = null);

/// <summary>The facts a source needs to answer the two STARTUP questions — where it talks, and whether it
/// is configured enough to be wired.
///
/// <para>Separate from <see cref="MemorySourceContext"/> because those questions are asked from inside
/// <c>AddLyntai(b =&gt; …)</c>, while the container is being built: there is no <c>IOllamaRuntime</c> to
/// hand over yet. Passing a context with nulls in it would compile and then quietly depend on nobody
/// calling the wrong member; two types make the difference structural.</para>
///
/// <para><see cref="ResourcesPath"/> is here because a backend's readiness is not always a config value —
/// the built-in embedder's is "are 197 MB of weights on disk", which is a filesystem fact.</para></summary>
public sealed record MemorySourceSettings(MemoryConfig Config, string ResourcesPath);

/// <summary>What a source needs to ANSWER questions at runtime.
///
/// <para>Passed per call rather than injected, so a source can be a stateless instance in a static
/// catalog — which is what lets ONE list serve <c>GatherlightApp</c> before the container exists and the
/// console after it. Two lists for one set is the drift this arrangement is built to avoid.</para></summary>
/// <param name="Llm">The one-shot LLM client, for an arm whose work IS a model call rather than a
/// service to connect to. Nullable because most sources never need it and a null must not stop them being
/// described — a source that cannot work without it says so from <c>StatusAsync</c> instead.</param>
public sealed record MemorySourceContext(
    IClaudeCliRuntime Claude,
    ILlamaServerRuntime Llama,
    MemorySourceSettings Settings,
    Lyntai.Llm.ILlmClient? Llm = null)
{
    public MemoryConfig Config => Settings.Config;
}

/// <summary>What a source needs to REGISTER itself at startup. No DI and no container — only the two facts
/// a backend registration turns on.</summary>
/// <param name="Model">The model this layer is bound to.</param>
/// <param name="Endpoint">Where this backend talks, already resolved and loopback-checked by the source
/// that owns that address (<c>IMemorySource.Endpoint</c>) — <see cref="OllamaRuntime.ResolveBaseUrl"/> for
/// the Ollama arm, <c>OpenAiCompatibleSource.ResolveLocal</c> for a household-supplied one. ONE place
/// answers "where does this backend talk", which is what stops an install embedding against one host while
/// reporting another. Empty for a backend that is a process rather than a URL.</param>
/// <param name="Settings">The same startup facts <see cref="IMemorySource.IsConfigured"/> was asked about,
/// carried through so a backend that needs more than a URL — the built-in embedder needs the resources
/// path — does not force a new parameter onto every source that does not.</param>
public sealed record MemoryWiringContext(string Model, string Endpoint, MemorySourceSettings Settings);

/// <summary>Deciding <see cref="RuntimeOrigin"/> for the two backends the app can either provision OR find.
///
/// <para>The test is a PATH COMPARISON, not a flag: both <c>IOllamaRuntime.Locate()</c> and
/// <c>IClaudeCliRuntime.Locate()</c> prefer the provisioned copy and fall through to PATH, and neither
/// reports which branch won. Comparing what they returned against where we install is therefore the only
/// honest way to answer — and it stays correct if the preference order ever changes, which a duplicated
/// copy of that order would not.</para></summary>
internal static class RuntimeOriginFrom
{
    /// <param name="located">What the runtime's own resolver returned, or null when it found nothing.</param>
    /// <param name="provisionedPath">Where this app installs its copy.</param>
    /// <param name="whatWeInstall">Named in the label, because "应用安装并运行" on a row the household has
    /// not installed anything for would be a promise, not a description.</param>
    public static RuntimeOrigin Locate(string? located, string provisionedPath, string whatWeInstall)
    {
        // Nothing found: the honest answer is what WOULD happen, phrased as an offer rather than a state.
        if (string.IsNullOrWhiteSpace(located))
            return new RuntimeOrigin(MemoryRuntimeOrigins.App, $"应用可以下载并运行({whatWeInstall})");

        var same = string.Equals(
            System.IO.Path.GetFullPath(located).TrimEnd(System.IO.Path.DirectorySeparatorChar),
            System.IO.Path.GetFullPath(provisionedPath).TrimEnd(System.IO.Path.DirectorySeparatorChar),
            StringComparison.OrdinalIgnoreCase);

        return same
            ? new RuntimeOrigin(MemoryRuntimeOrigins.App, "应用安装并运行 —— 不需要你自己装")
            : new RuntimeOrigin(MemoryRuntimeOrigins.Household, "用你自己装的那一份 —— 应用只连接,不管理");
    }
}
