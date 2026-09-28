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
    /// applying the SAME rules the scope guard applies to an Edit/Write: inside a write dir, neither under the
    /// PROTECTED set nor CONTAINING an entry of it, and — under the UI dir — a flat <c>.json</c> page only.
    /// <paramref name="reason"/> is a household-readable refusal when it returns null.</summary>
    string? Resolve(string relPath, out string? reason);
}

public sealed class SiteWriteScope : ISiteWriteScope
{
    // Mirrors ChatEnvironmentService.ScopeGuardMjs / guard/system-scope-guard.mjs — kept in step by hand.
    // The planner guard protects its own hooks + settings + the MCP config so the agent cannot neuter the
    // guard nor add an unsandboxed server; these tools honour the same set.
    private static readonly string[] Protected =
        [".claude/hooks", ".claude/settings.json", ".claude/settings.local.json", ".mcp.json"];

    // Windows device names (CON, NUL, COM1…): a write to one hits a device, not a file. Rejected as a
    // path segment (by its stem, so CON.txt too) — conservative, and no legitimate record file matches.
    private static readonly HashSet<string> ReservedDeviceNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    };

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
        var raw = (relPath ?? "").Replace('\\', '/').Trim();
        while (raw.StartsWith("./", StringComparison.Ordinal)) raw = raw[2..];
        raw = raw.TrimEnd('/');
        if (raw.Length == 0) { reason = "路径为空。"; return null; }
        if (Path.IsPathRooted(raw)) { reason = $"路径越界:{relPath}"; return null; }

        // NORMALIZE each segment the way Windows would BEFORE any compare — the compares are prefix tests,
        // and a trailing dot/space, an alternate data stream (`name:stream`), a device name (CON/NUL/COM1…)
        // or an 8.3 short name (`~` + a digit, `SETTIN~1.JSO`) all name a file a raw string compare treats as
        // different from its PROTECTED form. Rejecting a colon/short-name here also turns `plans/x.md:evil` into a
        // clean refusal instead of a 500 out of ResolveSitePath. A tilde WITHOUT a digit after it is an ordinary
        // name (`plans/a~b.md`) — the guard's own rule (`oddSegment`: `~\d`), which this used to over-match. Windows
        // strips trailing dots and spaces per segment, so `.claude/settings.json.` and `.claude/hooks./guard`
        // resolve to the protected file — fold them.
        var segs = new List<string>();
        foreach (var rawSeg in raw.Split('/'))
        {
            if (rawSeg.Length == 0) continue;                       // // or trailing /
            var seg = rawSeg.TrimEnd('.', ' ');
            if (seg.Length == 0) { reason = $"路径段无效:{relPath}"; return null; }  // only dots/spaces
            if (seg == ".") continue;
            if (seg == "..") { reason = $"路径越界:{relPath}"; return null; }
            if (seg.Contains(':')) { reason = $"路径含非法字符(:):{relPath}"; return null; }   // ADS / drive-rel
            if (ShortName.IsMatch(seg)) { reason = $"路径含 8.3 短名(~):{relPath}"; return null; }
            if (ReservedDeviceNames.Contains(seg.Split('.')[0])) { reason = $"路径含保留设备名:{relPath}"; return null; }
            segs.Add(seg);
        }
        if (segs.Count == 0) { reason = "路径为空。"; return null; }
        var rel = string.Join('/', segs);

        // Case-INSENSITIVE containment (Windows file system): `.claude/HOOKS/guard` and `.claude/Settings.json`
        // name the protected files. Fold case in every WriteDirs / PROTECTED / ui compare.
        bool Under(string p) => rel.Equals(p, StringComparison.OrdinalIgnoreCase)
            || rel.StartsWith(p + "/", StringComparison.OrdinalIgnoreCase);

        var dirs = WriteDirs;
        if (!dirs.Any(Under))
        {
            reason = $"只能改写 {string.Join(" / ", dirs)} 里的文件 —— 不允许:\"{rel}\"";
            return null;
        }
        if (ProtectedReason(rel) is { } protectedWhy) { reason = protectedWhy; return null; }
        // The UI dir holds pages and nothing else: flat, and a .json page. Mirrors WRITE_EXTS.
        var uiDir = UiDir;
        if (uiDir.Length > 0 && Under(uiDir))
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

        // ResolveSitePath refuses state/ and any escape past the data root (GetFullPath-based). Existence is
        // the caller's concern (a move target must not exist; a delete/move source must).
        var abs = _site.ResolveSitePath(rel);
        if (abs is null) { reason = $"路径越界:{relPath}"; return null; }
        // Belt and braces: re-check PROTECTED against the path GetFullPath RESOLVED, not only the normalized
        // input — whatever Windows folds that the segment rules above miss still names the protected file.
        var resolved = Path.GetRelativePath(_site.RootPath, abs).Replace('\\', '/');
        if (ProtectedReason(resolved) is { } resolvedWhy) { reason = resolvedWhy; return null; }
        return abs;
    }

    // `~` followed by a digit — how Windows spells an 8.3 short name (`STATE~1`, `SETTIN~1.JSO`). Mirrors the guard.
    private static readonly System.Text.RegularExpressions.Regex ShortName = new(@"~\d", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>Why <paramref name="rel"/> (data-root-relative, slash-separated) may not be written, or null. Two
    /// ways to reach a protected entry, and both are refused: a path UNDER it (<c>.claude/hooks/x</c>), and a path that
    /// CONTAINS it (<c>.claude</c>, which holds the hooks and the settings). The second was missing until the round-6
    /// review: <c>.claude</c> itself resolved as writable, so the file tools could move it out, rewrite
    /// <c>settings.json</c> inside the copy and move it back — an escape one level above every prefix test.</summary>
    private static string? ProtectedReason(string rel)
    {
        foreach (var p in Protected)
        {
            if (rel.Equals(p, StringComparison.OrdinalIgnoreCase) || rel.StartsWith(p + "/", StringComparison.OrdinalIgnoreCase))
                return $"\"{rel}\" 是应用管理的受保护路径(scope guard / settings),不可改动。";
            if (p.StartsWith(rel + "/", StringComparison.OrdinalIgnoreCase))
                return $"\"{rel}\" 里有应用管理的受保护文件(scope guard / settings),不能整体改动 —— 请逐个改动其中的文件。";
        }
        return null;
    }
}
