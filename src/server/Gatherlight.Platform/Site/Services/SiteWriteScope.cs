using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Site.Services;

/// <summary>
/// The one C# reading of "what the agent may WRITE" — the SAME set the scope guard enforces for
/// Edit/Write, so the scoped MCP file tools (move/rename, delete) cannot drift from the jail the guard
/// draws around the CLI's own writes.
///
/// <para><b>One source of truth.</b> <see cref="ISiteManifestStore"/> is where the write directories come
/// from (its <c>Records</c>, plus <c>.claude</c> and the UI dir) — the guard renders <c>WRITE_DIRS</c> from
/// the same manifest (<c>ChatEnvironmentService.RenderScopeGuard</c>), so both derive the directories from
/// one declaration rather than restating a list. The PROTECTED set and the ui/-is-flat-.json rule are the
/// guard's invariants, mirrored here as constants because the guard is JS and cannot share this code; both
/// are version-gated, and the guard's copy is run by <c>e2e-p24</c> while this copy is driven by the file
/// tools' suite. A jail whose occupant can widen it is not a jail, so PROTECTED overrides the allow-list
/// exactly as it does in the guard.</para>
/// </summary>
public interface ISiteWriteScope
{
    /// <summary>The agent-writable directories (records + <c>.claude</c> + the UI dir), data-root-relative.</summary>
    IReadOnlyList<string> WriteDirs { get; }

    /// <summary>Resolve a data-root-relative path to an absolute path IFF the agent may write it there,
    /// applying the SAME rules the scope guard applies to an Edit/Write: inside a write dir, not under the
    /// PROTECTED set, and — under the UI dir — a flat <c>.json</c> page only. <paramref name="reason"/> is a
    /// household-readable refusal when it returns null.</summary>
    string? Resolve(string relPath, out string? reason);
}

public sealed class SiteWriteScope : ISiteWriteScope
{
    // Mirrors ChatEnvironmentService.ScopeGuardMjs / guard/system-scope-guard.mjs — kept in step by hand,
    // both version-gated. The planner guard protects its own hooks + settings so the agent cannot neuter
    // the guard; these tools honour the same set.
    private static readonly string[] Protected = [".claude/hooks", ".claude/settings.json", ".claude/settings.local.json"];

    private readonly ISiteContext _site;
    private readonly ISiteManifestStore _manifest;

    public SiteWriteScope(ISiteContext site, ISiteManifestStore manifest)
    {
        _site = site;
        _manifest = manifest;
    }

    private string UiDir => _manifest.Current.Ui.Spec.Trim('/');

    public IReadOnlyList<string> WriteDirs =>
        _manifest.Current.Records.Concat([".claude", UiDir]).Where(d => d.Length > 0).Distinct().ToList();

    public string? Resolve(string relPath, out string? reason)
    {
        reason = null;
        var rel = (relPath ?? "").Replace('\\', '/').Trim();
        while (rel.StartsWith("./", StringComparison.Ordinal)) rel = rel[2..];
        rel = rel.TrimEnd('/');
        if (rel.Length == 0) { reason = "路径为空。"; return null; }
        // Reject any `..` SEGMENT (not just leading) and a rooted path — same as FsOpsService.AssertInScope
        // and the guard's relTo, before the prefix test can be fooled by `plans/../.claude/x`.
        if (Path.IsPathRooted(rel) || rel.Split('/').Any(seg => seg == ".."))
        {
            reason = $"路径越界:{relPath}";
            return null;
        }

        var dirs = WriteDirs;
        if (!dirs.Any(d => rel == d || rel.StartsWith(d + "/", StringComparison.Ordinal)))
        {
            reason = $"只能改写 {string.Join(" / ", dirs)} 里的文件 —— 不允许:\"{rel}\"";
            return null;
        }
        if (Protected.Any(p => rel == p || rel.StartsWith(p + "/", StringComparison.Ordinal)))
        {
            reason = $"\"{rel}\" 是应用管理的受保护路径(scope guard / settings),不可改动。";
            return null;
        }
        // The UI dir holds pages and nothing else: flat, and a .json page. Mirrors WRITE_EXTS.
        var uiDir = UiDir;
        if (uiDir.Length > 0 && (rel == uiDir || rel.StartsWith(uiDir + "/", StringComparison.Ordinal)))
        {
            var rest = rel.Length == uiDir.Length ? "" : rel[(uiDir.Length + 1)..];
            if (rest.Length == 0 || rest.Contains('/'))
            {
                reason = $"{uiDir}/ 是扁平目录 —— 页面文件要直接放在 {uiDir}/ 下。";
                return null;
            }
            if (!rest.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            {
                reason = $"{uiDir}/ 下只能写 .json 页面 —— 不允许:\"{rel}\"";
                return null;
            }
        }

        // ResolveSitePath refuses state/ and any escape past the data root. Existence is the caller's
        // concern (a move target must not exist; a delete/move source must).
        var abs = _site.ResolveSitePath(rel);
        if (abs is null) { reason = $"路径越界:{relPath}"; return null; }
        return abs;
    }
}
