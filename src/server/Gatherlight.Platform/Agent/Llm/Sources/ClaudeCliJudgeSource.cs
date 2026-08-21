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
        "用已登录的账号判断:每次记录事实、每次检索各消耗一次调用。" +
        "Lyntai 实测这是漏检最低的一档(0.54 → 0.19),代价是它跑在你的账号额度上。";

    /// <summary>Null = the default client. The CLI provider is already registered.</summary>
    public string? ClientName => null;

    public IReadOnlyList<string> CandidateProviderIds => Array.Empty<string>();

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
                ? new SourceStatus(false, "Claude CLI 已安装但尚未登录 —— 在本机运行 `claude auth login` 后即可使用。")
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
