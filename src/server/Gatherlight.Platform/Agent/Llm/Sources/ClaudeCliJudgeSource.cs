using Lyntai;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// 判断 on the authenticated claude CLI — the default, and what shipped before any of this was a choice.
///
/// <para>It registers nothing: the CLI provider is added unconditionally at startup and is the default
/// client. That asymmetry is the point of the seam — a source contributes only what its backend needs.</para>
/// </summary>
public sealed class ClaudeCliJudgeSource : IMemoryJudgeSource
{
    public string Id => "claude-cli";
    public string Name => "Claude CLI";

    public string Description =>
        "适合:不想在这台机器上跑模型 —— 没有独立显卡、不想再下载几百 MB,而账号本来就有。" +
        "每次记录事实、每次检索各消耗一次调用,实测每次检索 9–17 秒(本机模型没有这次进程启动)。" +
        "Lyntai 在自己的语料上实测这是漏检最低的一档(0.54 → 0.19)。";

    /// <summary>Null client = the default client: the CLI provider is already registered.</summary>
    public JudgeWiring Wiring(MemoryWiringContext ctx) => JudgeWiring.Llm(null, AnnotationModel(ctx.Model));

    public string AnnotationModel(string model) => model;

    public string Cost(string? model) =>
        "每次记录事实与每次检索各消耗一次 Claude CLI 调用(使用已登录的账号)。"
        + "实测每次检索 9–17 秒(五次测量,多数在 15 秒上下)—— 每次调用都要启动一次 CLI 进程;"
        + "只用「公式」时是 0.07–0.09 秒。"
        + "换成本机模型可以省掉这次进程启动。";

    /// <summary>Not a URL: the CLI is a process this install spawns.</summary>
    public bool NeedsEndpoint => false;

    public string? Endpoint(MemorySourceSettings s) => null;

    /// <summary>Always ready to be WIRED. Whether it can actually answer is <see cref="StatusAsync"/>'s
    /// question — a signed-out CLI is a real problem, but not one that should stop the app coming up.</summary>
    public bool IsConfigured(MemorySourceSettings s) => true;

    /// <summary>Provisioned or the household's own. 资源 fetches the CLI too — with the live vendor version
    /// and checksum — so this arm is app-managed on an install that took that offer, and the household's on
    /// a machine that already had one. Installed is still not signed in; that is StatusAsync's job.</summary>
    /// <summary>Cli — the account itself.</summary>
    public string Group => MemoryGroups.Cli;

    public RuntimeOrigin Origin(MemorySourceContext ctx) =>
        RuntimeOriginFrom.Locate(ctx.Claude.Locate(),
            Hosting.Resources.Services.ResourceProvisioner.ProvisionedClaude(ctx.Settings.ResourcesPath),
            "Claude CLI");

    /// <summary>Its provider is already registered, but the JUDGE binding is still read at
    /// startup, so a change is owed a restart like any other.</summary>
    public bool TakesEffectOnRestart => true;

    public void Register(LyntaiBuilder b, MemoryWiringContext ctx) { }

    /// <summary>INSTALLED IS NOT USABLE. A downloaded CLI is not a signed-in one, and <c>claude auth login</c>
    /// is a browser flow with no headless variant — so this reports the state exactly and names the command
    /// rather than pretending it can complete it.</summary>
    public async Task<SourceStatus> StatusAsync(MemorySourceContext ctx, CancellationToken ct = default)
    {
        var s = await ctx.Claude.ProbeAsync(ct: ct);
        return !s.Runnable
            ? new SourceStatus(false, "这台机器上没有可运行的 Claude CLI —— 可在「资源 · Resources」面板安装。")
            : !s.LoggedIn
                ? new SourceStatus(false, "Claude CLI 已安装但尚未登录 —— 在「资源」面板点「登录」,浏览器里完成一次即可。")
                : SourceStatus.Ready;
    }

    /// <summary>The same vocabulary the router uses for every other consumer, because it IS the same router.
    /// Ordered cheapest first: this seam runs on every write and every recall, so the frequency — not the
    /// capability — is what should decide.</summary>
    public Task<IReadOnlyList<ModelOption>> ModelsAsync(MemorySourceContext ctx, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<ModelOption>>(new[]
        {
            new ModelOption("haiku", "Haiku(默认 · 最省)", Installed: true,
                Note: "判断这类短任务足够,也是三者里最便宜的 —— 每次写入与每次检索都会调用一次。"),
            new ModelOption("sonnet", "Sonnet", Installed: true,
                Note: "更强,但这一层调用极其频繁,费用按次数放大。"),
            new ModelOption("opus", "Opus", Installed: true,
                Note: "最强也最贵;这一层不建议 —— 判断的收益远小于它的调用次数。"),
        });

    /// <summary>Nothing to refuse: every model here is one the CLI can answer with. The check exists on the
    /// interface for backends whose model list and capability list are not the same thing.</summary>
    public Task<string?> RejectAsync(MemorySourceContext ctx, string model, CancellationToken ct = default) =>
        Task.FromResult<string?>(null);
}
