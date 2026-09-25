using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>A <c>/v1/rerank</c> reply read as one score per document, in INPUT order — or null for anything unusable:
/// invalid JSON, a missing or mistyped field, an index outside the batch or seen twice, a non-finite score, or FEWER
/// results than documents. Reads <c>relevance_score</c> or <c>score</c>, as Lyntai's rerank transport does.
///
/// <para>ONE reader for the two places the app itself reads a rerank reply: the bind-time screen
/// (<c>LlamaCppSource</c>) and the device measurement (<see cref="RerankDeviceMeter"/>). "Every document scored exactly
/// once" matters in both for the same reason: llama.cpp's <c>relevance_score</c> is a raw logit that can be NEGATIVE, so
/// an unfilled slot's default zero could outrank a real score — and a reply that scored three of four documents in
/// 20 ms would read as the fastest device on the machine.</para></summary>
public static class RerankReply
{
    public static double[]? Scores(string body, int count)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("results", out var results)
                || results.ValueKind != JsonValueKind.Array) return null;

            var scores = new double[count];
            var seen = new bool[count];
            foreach (var r in results.EnumerateArray())
            {
                if (r.ValueKind != JsonValueKind.Object
                    || !r.TryGetProperty("index", out var i) || i.ValueKind != JsonValueKind.Number
                    || !i.TryGetInt32(out var index) || index < 0 || index >= count || seen[index])
                    return null;
                if ((!r.TryGetProperty("relevance_score", out var s) || s.ValueKind != JsonValueKind.Number)
                    && (!r.TryGetProperty("score", out s) || s.ValueKind != JsonValueKind.Number))
                    return null;
                var value = s.GetDouble();
                if (!double.IsFinite(value)) return null;
                scores[index] = value;
                seen[index] = true;
            }
            return Array.TrueForAll(seen, x => x) ? scores : null;
        }
        catch (JsonException) { return null; }
    }

    /// <summary>How many of <paramref name="count"/> documents a reply scored, for a sentence about one that did not
    /// score them all — 0 when it is not a reply at all.</summary>
    public static int Scored(string body, int count)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            return doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array
                ? Math.Min(results.GetArrayLength(), count)
                : 0;
        }
        catch (JsonException) { return 0; }
    }
}

/// <summary>What one device did with the fixed batch (<see cref="RerankDeviceBatch"/>).</summary>
/// <param name="Device">What the preset's <c>device</c> key would say — <c>none</c> for the CPU, otherwise the id
/// <c>--list-devices</c> printed (<c>Vulkan0</c>).</param>
/// <param name="Name">What the household reads: 「CPU」, or the device's own name from that list.</param>
/// <param name="ElapsedMs">The timed call, wall clock, when it scored every document; null when the device was excluded.</param>
/// <param name="MsPerToken">The same call in the PACE's unit (<see cref="RerankPace.RateOf"/>): ms per pair token, the
/// pace's call-overhead allowance taken off and its floor applied.</param>
/// <param name="Error">Why the device was excluded — its load, its warm call or its timed call failed or ran out of
/// time, or it did not score every document — as a household sentence (the exception, if any, goes to the log). Null for
/// a valid result.</param>
/// <param name="Attempts">How many times this device has been measured under this key. An EXCLUSION is often transient —
/// a cold shader cache or a virus scan at the first start of a new build, VRAM another program holds, contention, a lost
/// port race — so an excluded device is measured again at each router start the app performs, up to
/// <see cref="RerankDeviceMeter.MaxAttempts"/>; a valid result stands as it is. Absent in a file written before retries
/// existed, which reads as one.</param>
public sealed record RerankDeviceResult(string Device, string Name, long? ElapsedMs, double? MsPerToken, string? Error,
    int Attempts = 1)
{
    [JsonIgnore] public bool Valid => ElapsedMs is not null && MsPerToken is not null && Error is null;

    /// <summary><see cref="Attempts"/>, never below one.</summary>
    [JsonIgnore] public int AttemptsSpent => Math.Max(1, Attempts);
}

/// <summary>What makes a measurement CURRENT: the model file, the llama.cpp build, and the device list. Any of them
/// changing re-measures that model at the next router start the app performs; nothing else does.
///
/// <para><b>The device list is normalised</b> (<see cref="RerankDeviceKey.DeviceLine"/>): <c>--list-devices</c> prints
/// each device's memory, free memory included — "(11995 MiB, 11217 MiB free)" — which moves with whatever else holds the
/// GPU, so keyed as printed, every boot would re-measure.</para></summary>
public sealed record RerankDeviceKey(
    string Model, long ModelBytes, long ModelWriteTicks, string Build, IReadOnlyList<string> Devices)
{
    public bool Matches(RerankDeviceMeasurement m) =>
        string.Equals(m.Model, Model, StringComparison.OrdinalIgnoreCase)
        && m.ModelBytes == ModelBytes && m.ModelWriteTicks == ModelWriteTicks
        && string.Equals(m.Build, Build, StringComparison.Ordinal)
        && m.Devices.SequenceEqual(Devices, StringComparer.Ordinal);

    /// <summary>The key for <paramref name="modelId"/>'s file, the build tag and the device list as
    /// <c>--list-devices</c> printed it — or null when the file cannot be read or either binary fact is unknown.</summary>
    public static RerankDeviceKey? For(string modelId, string? modelFile, string? build, IReadOnlyList<string>? devices)
    {
        if (modelFile is null || build is null || devices is null) return null;
        try
        {
            var fi = new FileInfo(modelFile);
            if (!fi.Exists) return null;
            return new RerankDeviceKey(modelId, fi.Length, fi.LastWriteTimeUtc.Ticks, build,
                devices.Select(DeviceLine).ToList());
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    /// <summary>A <c>--list-devices</c> line without its trailing memory figures: "Vulkan0: NVIDIA … GPU (11995 MiB,
    /// 11217 MiB free)" → "Vulkan0: NVIDIA … GPU".</summary>
    public static string DeviceLine(string line)
    {
        var t = line.Trim();
        var open = t.LastIndexOf(" (", StringComparison.Ordinal);
        return open > 0 && t.EndsWith(')') && t[open..].Contains("MiB", StringComparison.Ordinal) ? t[..open].TrimEnd() : t;
    }

    /// <summary>The id a device line names — what <c>--device</c> takes: the text before its colon.</summary>
    public static string DeviceId(string line)
    {
        var t = DeviceLine(line);
        var colon = t.IndexOf(':');
        return colon > 0 ? t[..colon].Trim() : t;
    }

    /// <summary>The name a device line gives — the text after its colon, or the whole line.</summary>
    public static string DeviceName(string line)
    {
        var t = DeviceLine(line);
        var colon = t.IndexOf(':');
        return colon > 0 && colon + 1 < t.Length ? t[(colon + 1)..].Trim() : t;
    }
}

/// <summary>A reranker's key on this machine now, and its CURRENT measurement — null when it has none under that key
/// (never measured, or the model file, the build or the device list changed since).</summary>
/// <param name="Saved">False when the measurement is one this process took and could not write to the store: it is
/// what this process's router was started with, and the next start the app performs measures again.</param>
public sealed record RerankDeviceLookup(RerankDeviceKey Key, RerankDeviceMeasurement? Measurement, bool Saved = true);

/// <summary>One reranker's device measurement on this machine, as persisted (<see cref="RerankDeviceStore"/>).</summary>
/// <param name="Documents">How many documents the batch had — <see cref="RerankDeviceBatch.DocumentCount"/>.</param>
public sealed record RerankDeviceMeasurement(
    string Model, long ModelBytes, long ModelWriteTicks, string Build, IReadOnlyList<string> Devices,
    DateTimeOffset MeasuredAt, int Documents, int Characters, double PairTokens,
    IReadOnlyList<RerankDeviceResult> Results)
{
    /// <summary>The valid result with the shortest timed call, or null when no device gave one. Ties go to the one
    /// measured first — the CPU is measured first.</summary>
    [JsonIgnore]
    public RerankDeviceResult? Fastest =>
        Results.Where(r => r.Valid).OrderBy(r => r.ElapsedMs).FirstOrDefault();

    /// <summary>The devices excluded so far that the next router start the app performs measures AGAIN — fewer than
    /// <see cref="RerankDeviceMeter.MaxAttempts"/> attempts spent. See <see cref="RerankDeviceResult.Attempts"/>.</summary>
    [JsonIgnore]
    public IReadOnlyList<RerankDeviceResult> Retryable =>
        Results.Where(r => !r.Valid && r.AttemptsSpent < RerankDeviceMeter.MaxAttempts).ToList();

    /// <summary>Every device excluded so far, retryable or not.</summary>
    [JsonIgnore]
    public IReadOnlyList<RerankDeviceResult> Excluded => Results.Where(r => !r.Valid).ToList();
}

/// <summary>The persisted measurements — <c>rerank-devices.json</c> in the provisioned models directory
/// (<c>state/resources/gguf</c>).
///
/// <para><b>A file, not the database</b>, because two readers need it before any container or database is reachable
/// the way a controller reaches one: the preset writer inside a router start, and the pace's seed (<see cref="RerankPace"/>),
/// which is read in a registration factory. <b>Derived state that belongs to ONE machine</b>: it sits beside the GGUFs it
/// describes, under <c>state/</c>, which the whole-install backup does not carry (its folders are
/// <c>plans household .claude ui uploads .git</c> plus <c>site.json</c> and <c>state/settings.json</c>) — a device choice
/// restored onto another machine would name that machine's GPU. llama-server's router ignores it: <c>--models-dir</c>
/// lists GGUFs only (checked on b10549, 2026-09-26).</para>
///
/// <para>Written whole, through a temporary file and a move, so a crash mid-write leaves the previous file or none — never
/// half of one. An unreadable file reads as empty: every reranker is then simply measured again.</para></summary>
public static class RerankDeviceStore
{
    public const string FileName = "rerank-devices.json";

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private static readonly object Gate = new();

    public static string PathFor(string resourcesPath) =>
        Path.Combine(Hosting.Resources.Services.ResourceProvisioner.ProvisionedGgufDir(resourcesPath), FileName);

    public static IReadOnlyList<RerankDeviceMeasurement> Read(string resourcesPath)
    {
        var path = PathFor(resourcesPath);
        lock (Gate)
        {
            try
            {
                if (!File.Exists(path)) return Array.Empty<RerankDeviceMeasurement>();
                var file = JsonSerializer.Deserialize<StoreFile>(File.ReadAllText(path, Encoding.UTF8), Json);
                return file?.Measurements?.Where(m => m is not null && m.Results is not null && m.Devices is not null).ToList()
                    ?? (IReadOnlyList<RerankDeviceMeasurement>)Array.Empty<RerankDeviceMeasurement>();
            }
            catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
            {
                return Array.Empty<RerankDeviceMeasurement>();
            }
        }
    }

    /// <summary>The measurement for <paramref name="key"/>, when the store holds one that is current.</summary>
    public static RerankDeviceMeasurement? Current(string resourcesPath, RerankDeviceKey key) =>
        Read(resourcesPath).FirstOrDefault(key.Matches);

    /// <summary>Replace <paramref name="m"/>'s model's entry — one per model, the latest measurement.</summary>
    public static void Save(string resourcesPath, RerankDeviceMeasurement m)
    {
        var path = PathFor(resourcesPath);
        lock (Gate)
        {
            var all = Read(resourcesPath)
                .Where(x => !string.Equals(x.Model, m.Model, StringComparison.OrdinalIgnoreCase))
                .Append(m)
                .OrderBy(x => x.Model, StringComparer.OrdinalIgnoreCase)
                .ToList();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(new StoreFile(1, all), Json), new UTF8Encoding(false));
            File.Move(tmp, path, overwrite: true);
        }
    }

    private sealed record StoreFile(int Version, List<RerankDeviceMeasurement>? Measurements);
}

/// <summary>One call's batch: the question, the documents, their characters, and the pair tokens as
/// <see cref="RerankPace.PairTokens"/> counts them.</summary>
public sealed record MeasurementBatch(string Query, IReadOnlyList<string> Documents, int Characters, double PairTokens);

/// <summary>The fixed batch every device is timed on — deterministic, bilingual, and sized to the model's OWN window.
///
/// <para><b>What it is.</b> One question and <see cref="DocumentCount"/> documents of mixed Chinese and English prose,
/// each cut to the per-candidate budget <see cref="RerankInputCap.Fit"/> gives the model — 1,000 characters for a reranker
/// that declares no window (BGE, LAMAR), what 512 tokens leave beside the question for mMiniLMv2 — so every pair is a
/// FULL window, the shape of the chunked calls <see cref="RerankPace"/> sizes (a short pair costs less per token than a
/// long one). Under a declared window the text is prepared exactly as a recall's is (<see cref="RerankInputCap.Prepare"/>).
/// Its size is counted by <see cref="RerankPace.PairTokens"/>, the pace's own count, so the measurement and the pace speak
/// one unit through one counting.</para>
///
/// <para><b>The warm call and the timed call are different documents of the same size</b> — parts 1–4 and parts 5–8 (the
/// one-digit part number is all that differs, so their characters and pair tokens are equal). Sent byte for byte twice, a
/// future llama.cpp rerank prompt cache could answer the timed call from the warm one's work and time nothing.</para>
///
/// <para><b>Why four documents.</b> Small enough that the slowest device measured answers well inside
/// <see cref="RerankDeviceMeter.CallTimeout"/> — BGE on this laptop's integrated GPU took 14.9 s for the batch's 1,550
/// pair tokens (four 1,000-character documents; 9.6 s per 1,000), and ~2× that would still fit — and big enough that the
/// CPU's figure is a measurement (BGE there: 5.2–5.6 s, 3.35–3.58 s per 1,000 pair tokens, beside Run 8's median of 3.1;
/// mMiniLMv2's 738 pair tokens took 0.21–0.23 s). On a discrete GPU the call is mostly overhead (BGE 66 ms, mMiniLMv2
/// 18 ms), which ranks the device correctly and says little about its rate — see
/// <see cref="RerankDeviceVerdict.PaceSeed"/>. The text is invented (a community garden's notices), never a household's.</para></summary>
public static class RerankDeviceBatch
{
    public const int DocumentCount = 4;

    /// <summary>The question every pair carries.</summary>
    public const string Query = "社区花园什么时候浇水? When is the community garden watered?";

    private const string Prose =
        "社区花园每周三和周六早上七点浇水,轮值表贴在工具棚门口。The community garden is watered on Wednesday and "
        + "Saturday mornings at seven; the rota hangs on the tool shed door. 堆肥箱在东边围栏旁,只放果皮和落叶。"
        + "Compost bins sit by the east fence and take only peelings and leaves. 借用的铁锹请在天黑前放回原处。"
        + "Borrowed spades go back on their hooks before dark. ";

    /// <summary>The warm call's batch (parts 1–4) for a model whose declared window is <paramref name="window"/>.</summary>
    public static MeasurementBatch Warm(int? window) => Parts(window, 1);

    /// <summary>The timed call's batch (parts 5–8): the same size as <see cref="Warm"/>, different text.</summary>
    public static MeasurementBatch Timed(int? window) => Parts(window, 1 + DocumentCount);

    private static MeasurementBatch Parts(int? window, int first)
    {
        var (query, per) = RerankInputCap.Fit(Query, window);
        var docs = Enumerable.Range(first, DocumentCount).Select(i => Document(i, per, window)).ToList();
        return new MeasurementBatch(query, docs, docs.Sum(d => d.Length), RerankPace.PairTokens(query, docs));
    }

    /// <summary>One document of exactly <paramref name="chars"/> characters (as prepared for the window).</summary>
    public static string Document(int n, int chars, int? window)
    {
        var sb = new StringBuilder($"第{n}段 · part {n}: ");
        while (sb.Length < chars) sb.Append(Prose);
        var text = RerankInputCap.Prepare(sb.ToString(), window);
        return text.Length <= chars ? text : text[..chars];
    }
}

/// <summary>What a measurement MEANS for the product — whether a reranker is too slow here, and where the pace starts.
/// Both read a measurement through the runtime's own admission and counting, never through a threshold of their own.</summary>
public static class RerankDeviceVerdict
{
    /// <summary>How many candidates a recall at the DEFAULT page shows the verifier: 96. Followed through the recall path:
    /// <c>recall_facts</c> asks for <see cref="Storage.Knowledge.Tools.RecallFactsTool.DefaultRecallLimit"/> (8);
    /// <see cref="Storage.Knowledge.Services.FactIndex.RankLimit"/> over-asks the engine for min(3 × 8, 100) = 24 with no
    /// kind; and Lyntai 3.2.0's graph engine verifies the top <c>max(limit, VerificationDepth ?? 4 × limit)</c> of its
    /// ranking (<c>GraphMemoryEngine.RecallAsync</c>; the app sets no <c>VerificationDepth</c>, so
    /// <see cref="Lyntai.Memory.GraphMemoryOptions.DefaultVerificationDepthFactor"/> applies) — 96, when the household has
    /// that many facts to rank. docs/judge-bench.md's "≤ 60 candidates" is that fixture's size (60 facts), not a bound.
    /// A recall naming a kind, or asking for 34 or more, shows up to 400.</summary>
    public static int ReferenceCandidates
    {
        get
        {
            var asked = Storage.Knowledge.Services.FactIndex.RankLimit(null, Storage.Knowledge.Tools.RecallFactsTool.DefaultRecallLimit);
            return Math.Max(asked, Lyntai.Memory.GraphMemoryOptions.DefaultVerificationDepthFactor * asked);
        }
    }

    /// <summary>The REFERENCE PAGE's one-window call for a model with window <paramref name="window"/>, in pair tokens:
    /// <see cref="ReferenceCandidates"/> candidates, each ONE full window of the measurement's prose beside its question
    /// — the least the pace can send and still score a recall at the default page whose candidates are all long
    /// (<see cref="ChunkedScoreProvider.Shape"/>). A recall of shorter facts costs less, and that is the stated scope of
    /// "too slow": too slow for a default recall of long facts, which is where Run 8 found BGE on a CPU hopeless.</summary>
    public static double ReferencePairTokens(int? window)
    {
        var (query, per) = RerankInputCap.Fit(RerankDeviceBatch.Query, window);
        var one = RerankDeviceBatch.Document(1, per, window);
        return RerankPace.PairTokens(query, Enumerable.Repeat(one, ReferenceCandidates).ToList());
    }

    /// <summary>The characters of one reference candidate for <paramref name="window"/> — the window a long fact is read
    /// in (1,000 for BGE) — for the sentence that says what "too slow" was measured against.</summary>
    public static int ReferenceWindowChars(int? window) => RerankInputCap.Fit(RerankDeviceBatch.Query, window).PerCandidate;

    /// <summary>Would the runtime SEND the reference page's one-window call, starting from <paramref name="m"/>? A fresh
    /// <see cref="RerankPace"/> — the verifier's own budget, half the configured verification deadline — seeded exactly as
    /// the runtime seeds the verifier's pace from this measurement (<see cref="PaceSeed"/>), is asked to
    /// <see cref="RerankPace.Admit"/> it. So "too slow" is the admission the runtime itself would make on its first recall,
    /// never a threshold of this class: too slow exactly when that answer is not Send (its
    /// <see cref="RerankPace.OneWindowLimit"/>, 48 s at the product's deadline). Null when no device gave a valid result —
    /// nothing measured, nothing claimed.</summary>
    public static (bool TooSlow, double PredictedMs, double LimitMs)? ReferenceAdmission(RerankDeviceMeasurement m)
    {
        if (PaceSeed(m) is not { } seed) return null;
        var pace = new RerankPace(VerificationDeadlinePolicy.Configured / 2, seed);
        var plan = pace.Admit(ReferencePairTokens(GgufCatalog.DeclaredWindow(m.Model)));
        return (plan.Kind != RerankPace.Admission.Send, plan.PredictedMs, plan.LimitMs);
    }

    /// <summary>Where the pace starts for a reranker measured here: the chosen device's rate — but never FASTER than
    /// <see cref="RerankPace.SeedMsPerToken"/>, the GPU figure it starts from without a measurement.
    ///
    /// <para><b>Why a floor.</b> The GPU seed is a measurement at the size the count ceiling was tuned on (480 windows of
    /// 1,000 characters, Run 6b); the four-document batch on a discrete GPU is mostly call overhead (BGE on this laptop's
    /// RTX: 66 ms in all, against the pace's 50 ms allowance, 0.011 ms per pair token; mMiniLMv2 18 ms, which reads the
    /// pace's floor of 1e-4 ms per token — 2026-09-26). Seeded there, the pace would also stop learning: a call teaches
    /// only when its scoring at the current estimate would take 4 × the overhead allowance
    /// (<see cref="RerankPace.MinSignalFactor"/>), which at the floor no recall reaches. So a measurement only ever makes the
    /// pace MORE careful than the GPU figure — which is what it is for: on this laptop's CPU, BGE's 3.35 ms per pair token
    /// is 67× the seed, and the first recall of long notes seeded at the GPU figure was cut at the deadline (Run 8).</para></summary>
    public static double? PaceSeed(RerankDeviceMeasurement? m) =>
        m?.Fastest is { MsPerToken: { } rate } ? Math.Max(RerankPace.SeedMsPerToken, rate) : null;
}

/// <summary>What 资源 says about a reranker's device — its row, and the lead of the 推荐 line when BGE measured too slow.
/// ONE writer, so the sentences and the code that decides cannot drift apart. Every clause is a fact the code holds: the
/// measurement's own figures, the device the preset names (<see cref="LlamaServerRuntime"/> writes <c>device = </c> from
/// the same fastest VALID result), each excluded device's attempts against <see cref="RerankDeviceMeter.MaxAttempts"/>, and
/// the reference-page admission (<see cref="RerankDeviceVerdict.ReferenceAdmission"/>).</summary>
public static class RerankDeviceNotes
{
    /// <summary>The clause that bounds the claim to rerankers — true of <see cref="LlamaServerRuntime.LaunchKeys"/>, which
    /// writes a device key on reranker sections only, and of the measurement, which launches rerankers only. Whether an
    /// embedder or a chat model would be faster elsewhere is unmeasured, and the clause says so.</summary>
    public const string OnlyRerankers =
        "只有重排模型按实测选设备;嵌入模型和对话模型仍由 llama.cpp 自己选,它们换个设备会不会更快没有量过。";

    /// <summary>What re-measures a model whose attempts are spent — exactly the key's three halves
    /// (<see cref="RerankDeviceKey"/>); a GPU driver update is not one of them, and the sentence says so.</summary>
    public const string KeyHalves = "除非模型文件、llama.cpp 版本或设备列表变了(更新显卡驱动不算)";

    /// <summary>For an INSTALLED reranker: its measurement when one is current, or what happens until there is one.</summary>
    /// <param name="saved">False: this process measured it and could not save it (<see cref="RerankDeviceLookup.Saved"/>).</param>
    /// <param name="adopted">The router answering now is not one this process started — it is never measured for.</param>
    public static string Row(RerankDeviceMeasurement? m, bool saved = true, bool adopted = false)
    {
        if (m is null)
            return (adopted
                    ? "还没有在这台机器上测过它在哪个设备上最快。现在运行的 llama.cpp 不是应用这次启动的,应用不会替它测;"
                      + "等应用自己启动 llama.cpp 时才会测(CPU 和每块显卡一个一个测,每个几秒到一分多钟),"
                    : "还没有在这台机器上测过它在哪个设备上最快:应用下一次自己启动 llama.cpp 时会测(CPU 和每块显卡一个一个测,"
                      + "每个几秒到一分多钟),")
                + "之后让它在最快的那个上运行;在那之前由 llama.cpp 自己选设备。" + OnlyRerankers;

        var timings = string.Join("、", m.Results.Select(r => r.Valid
            ? $"{r.Name} {Seconds(r.ElapsedMs!.Value)} 秒"
            : ExcludedClause(r)));
        var head = $"在这台机器上实测过({m.MeasuredAt.ToLocalTime():yyyy-MM-dd},llama.cpp {m.Build}):"
            + $"同一批 {m.Documents} 段、共 {m.Characters.ToString("N0", CultureInfo.InvariantCulture)} 字的打分,{timings}。";
        var unsaved = saved ? "" : "这次的结果没能保存,应用下一次自己启动 llama.cpp 时会重新测。";
        if (m.Fastest is not { } best)
            return head + "没有一个设备测出可用的结果,所以仍由 llama.cpp 自己选设备。" + unsaved + OnlyRerankers;

        var admission = RerankDeviceVerdict.ReferenceAdmission(m);
        var slow = admission is { TooSlow: true } a
            ? $"按这个速度推算,默认一次检索最多给判断看的 {RerankDeviceVerdict.ReferenceCandidates} 条候选、每条都是长事实只读一段"
              + $"(约 {ReferenceChars(m).ToString("N0", CultureInfo.InvariantCulture)} 字)时约要 {Seconds((long)a.PredictedMs)} 秒,"
              + $"超过应用送出这样一次判断的 {Seconds((long)a.LimitMs)} 秒上限,这样的检索会跳过判断(事实短时花的时间少得多)。"
            : "";
        var fastest = m.Excluded.Count > 0 ? $"测出结果的设备里最快的是 {best.Name},所以" : "所以";
        return head + fastest + $"应用启动 llama.cpp 时让它在 {best.Name} 上运行。" + slow + unsaved + OnlyRerankers;
    }

    /// <summary>An excluded device, and whether it will be measured again: at the next router start the app performs while
    /// attempts remain, otherwise only when the key changes.</summary>
    public static string ExcludedClause(RerankDeviceResult r) =>
        r.AttemptsSpent < RerankDeviceMeter.MaxAttempts
            ? $"{r.Name} 没有测出结果({r.Error};第 {r.AttemptsSpent} 次),应用下一次自己启动 llama.cpp 时会再测"
            : $"{r.Name} {r.AttemptsSpent} 次都没有测出结果(最近一次:{r.Error}),{KeyHalves},不会再测";

    /// <summary>The lead of 资源's 推荐 line when BGE measured too slow — the fastest device THAT GAVE A RESULT, its time
    /// for the batch, what that rate predicts for the default page's one-window call of long facts against the limit the
    /// runtime sends one under, and the devices that gave no result, named.</summary>
    public static string TooSlowLead(RerankDeviceMeasurement m, double predictedMs, double limitMs)
    {
        var best = m.Fastest!;
        var excluded = m.Excluded.Count == 0 ? ""
            : $"(没有测出结果的:{string.Join("、", m.Excluded.Select(r => r.Name))} —— "
              + (m.Retryable.Count > 0 ? "应用下一次自己启动 llama.cpp 时会再测)" : $"{KeyHalves},不会再测)");
        return $"BGE 在这台机器上实测过:测出结果的设备里最快的是 {best.Name}{excluded},同一批 {m.Documents} 段、共 "
            + $"{m.Characters.ToString("N0", CultureInfo.InvariantCulture)} 字的打分用了 {Seconds(best.ElapsedMs!.Value)} 秒;"
            + $"按这个速度推算,默认一次检索最多给判断看的 {RerankDeviceVerdict.ReferenceCandidates} 条候选、每条都是长事实只读一段"
            + $"(约 {ReferenceChars(m).ToString("N0", CultureInfo.InvariantCulture)} 字)时约要 {Seconds((long)predictedMs)} 秒,"
            + $"超过应用送出这样一次判断的 {Seconds((long)limitMs)} 秒上限,这样的检索会跳过判断(事实短时花的时间少得多)—— "
            + "所以推荐这个更小的重排模型。";
    }

    private static int ReferenceChars(RerankDeviceMeasurement m) =>
        RerankDeviceVerdict.ReferenceWindowChars(GgufCatalog.DeclaredWindow(m.Model));

    /// <summary>Seconds as a household reads them: two decimals under ten seconds, one above.</summary>
    public static string Seconds(long ms) =>
        (ms / 1000.0).ToString(ms < 10_000 ? "0.00" : "0.0", CultureInfo.InvariantCulture);
}

/// <summary>What the last reranker device measurement in this process did: which models it measured (all devices, or the
/// excluded ones again), how long it took, and a sequence number that grows with each measuring start — so a caller can
/// tell whether the start IT asked for measured anything (资源's start button says so).</summary>
public sealed record RerankMeasurementReport(int Sequence, IReadOnlyList<string> Models, TimeSpan Took);
