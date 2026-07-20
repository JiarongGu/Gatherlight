using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.DataRepo.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Lyntai.Providers.ClaudeCli;
using AgentToolPolicy = Lyntai.Agents.AgentToolPolicy;

namespace Gatherlight.Server.Modules.Llm.Services;

public sealed record ClaudeValidation(bool Ok, string Report);

/// <summary>
/// Extra validation pass for knowledge-base (.claude/) changes: a fresh, read-only claude run
/// inspects the .claude diff and confirms consistency + indexing. Fail-safe: an errored run or
/// a missing verdict marks NOT-ok so the UI forces the human to look closely.
/// </summary>
public interface IClaudeValidateService
{
    Task<ClaudeValidation> ValidateAsync(
        IReadOnlyList<DiffFile> claudeFiles, Action<AgentEvent> onEvent, CancellationToken ct = default);
}

public sealed partial class ClaudeValidateService : IClaudeValidateService
{
    private readonly IAgentRunner _agent;
    private readonly IPromptHarness _harness;
    private readonly IDataContext _data;
    private readonly IAppConfigService _appConfig;

    public ClaudeValidateService(
        IAgentRunner agent, IPromptHarness harness, IDataContext data, IAppConfigService appConfig)
    {
        _agent = agent;
        _harness = harness;
        _data = data;
        _appConfig = appConfig;
    }

    public async Task<ClaudeValidation> ValidateAsync(
        IReadOnlyList<DiffFile> claudeFiles, Action<AgentEvent> onEvent, CancellationToken ct = default)
    {
        var paths = claudeFiles.Select(f => f.Path).ToList();
        var diff = string.Join("\n\n", claudeFiles.Select(f => $"### {f.Path}\n{f.Diff}"));
        onEvent(new AgentEvent { Kind = "notice", Text = $"🔎 智库变更校验中 ({paths.Count} 个 .claude/ 文件)…" });

        Lyntai.Agents.AgentSessionResult result;
        try
        {
            result = await _agent.RunAsync(new ClaudeAgentOptions
            {
                Prompt = await _harness.ValidatePrompt(paths, diff),
                WorkingDirectory = _data.RootPath,
                ToolPolicy = AgentToolPolicy.ReadOnly,
                // The verdict pass is simple — a cheaper model suffices.
                Model = _appConfig.Get("llm.model.validate"),
                TimeoutSeconds = 600,
            }, label: "validate", onEvent: null, ct: ct); // swallow chatter — only its verdict matters
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            return new ClaudeValidation(false, $"校验进程启动失败:{ex.Message}。请人工检查 .claude/ 变更。");
        }

        var text = result.FinalText.Trim();
        var ok = OkRegex().IsMatch(text);
        var fail = FailRegex().IsMatch(text);
        var report = text.Length > 0 ? text : "(校验器无输出)";
        // Neither token → treat as not-ok (fail closed).
        return new ClaudeValidation(ok && !fail, report);
    }

    [GeneratedRegex(@"^VALIDATION_OK\b", RegexOptions.Multiline)]
    private static partial Regex OkRegex();

    [GeneratedRegex(@"^VALIDATION_FAIL\b", RegexOptions.Multiline)]
    private static partial Regex FailRegex();
}
