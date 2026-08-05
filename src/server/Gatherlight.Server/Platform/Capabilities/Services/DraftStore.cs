using System.Text.Json;
using Gatherlight.Server.Platform.Capabilities.Models;
using Gatherlight.Server.Platform.Kernel.Services;
using Gatherlight.Server.Platform.Site.Models;
using Gatherlight.Server.Platform.Site.Services;

namespace Gatherlight.Server.Platform.Capabilities.Services;

/// <summary>
/// Enumerates and promotes agent-drafted tools written to <c>{site}/.claude/tool-drafts/&lt;id&gt;/</c>.
/// A draft is never a live capability by itself — <see cref="ICapabilityRegistry"/> has no source
/// that reads <c>tool-drafts/</c>, so listing here changes nothing until a human calls
/// <see cref="Promote"/>. That is what makes an unapproved draft inert by construction rather than
/// by policy: there is nothing to turn off, because nothing was ever on.
/// </summary>
public interface IDraftStore
{
    /// <summary>Every parseable draft. An invalid one (missing/mismatched manifest, missing entry
    /// script) is skipped and logged, never thrown from here — the same "one broken entry can't take
    /// the listing down" contract <c>ScriptToolProvider.Reload</c> already applies to script tools,
    /// and a draft is agent-authored, i.e. exactly the untrusted input that contract exists for.</summary>
    IReadOnlyList<CapabilityDraft> All();

    /// <summary>The one draft named <paramref name="id"/>, or null if it doesn't exist, its id is
    /// not a safe path segment, or it fails to parse (logged either way).</summary>
    CapabilityDraft? Get(string id);

    /// <summary>
    /// Copies the draft folder to <c>{data}/tools/&lt;id&gt;/</c>, appends its grant — BYTE FOR BYTE,
    /// never widened or defaulted — to <c>site.json</c>'s <c>capabilities.enabled</c> via
    /// <see cref="ISiteManifestStore.Write"/>, then deletes the draft folder. Throws
    /// <see cref="InvalidOperationException"/> (never partially applies) when: <paramref name="id"/>
    /// is not a safe path segment; no such draft exists or it fails to parse (which includes a
    /// folder/manifest name disagreement); a capability with the same id is already enabled; or a
    /// same-named folder already exists under <c>tools/</c>.
    /// </summary>
    void Promote(string id);

    /// <summary>Deletes the draft folder. A no-op if it does not exist or the id is unsafe.</summary>
    void Discard(string id);
}

public sealed class DraftStore : IDraftStore
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly ISiteContext _site;
    private readonly ISiteManifestStore _manifest;
    private readonly ILogger<DraftStore> _log;

    public DraftStore(ISiteContext site, ISiteManifestStore manifest, ILogger<DraftStore> log)
    {
        _site = site;
        _manifest = manifest;
        _log = log;
    }

    private string DraftsRoot => Path.Combine(_site.ZhikuPath, "tool-drafts");
    private string ToolsRoot => Path.Combine(_site.RootPath, "tools");

    public IReadOnlyList<CapabilityDraft> All()
    {
        var list = new List<CapabilityDraft>();
        if (!Directory.Exists(DraftsRoot)) return list;
        foreach (var dir in Directory.EnumerateDirectories(DraftsRoot))
        {
            var id = Path.GetFileName(dir);
            if (!IsSafeId(id))
            {
                _log.LogWarning("Tool draft folder name is not a safe path segment, skipped: {Dir}", dir);
                continue;
            }
            try
            {
                var draft = Load(id, dir);
                if (draft is not null) list.Add(draft);
            }
            catch (Exception ex)
            {
                // A broken draft never takes the listing down — an agent-authored file is exactly
                // the untrusted input this skip-and-log contract exists for.
                _log.LogWarning(ex, "Invalid tool draft skipped: {Dir}", dir);
            }
        }
        return list;
    }

    public CapabilityDraft? Get(string id)
    {
        if (!IsSafeId(id)) return null;
        try
        {
            return Load(id, Path.Combine(DraftsRoot, id));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Invalid tool draft skipped: {Id}", id);
            return null;
        }
    }

    public void Promote(string id)
    {
        // Rule 1: the id becomes a directory segment under tools/ — and, via the TOOL_DRAFT marker
        // Task 4 adds, is read straight off agent-generated (prompt-injectable) text. Anything that
        // could escape DraftsRoot/ToolsRoot must be refused before it is ever joined into a path.
        if (!IsSafeId(id))
            throw new InvalidOperationException(
                $"draft id '{id}' is not a safe path segment — refusing to promote");

        // Load() itself enforces the other half of rule 1: it throws unless tool.json's own "name"
        // and the grant's own "id" both equal this folder name, so reaching the lines below already
        // means the folder, the manifest and the grant all agree on one identity.
        var draft = Load(id, Path.Combine(DraftsRoot, id))
            ?? throw new InvalidOperationException($"no draft named '{id}'");

        // Rule 2: never silently replace an already-enabled capability.
        var current = _manifest.Load();
        if (current.Capabilities.Enabled.Any(g => string.Equals(g.Id, id, StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException(
                $"capability '{id}' is already enabled — refusing to silently replace it");

        var targetDir = Path.Combine(ToolsRoot, id);
        if (Directory.Exists(targetDir))
            throw new InvalidOperationException(
                $"'{targetDir}' already exists — refusing to overwrite it");

        CopyDirectory(draft.DirPath, targetDir);

        // Rule 3: the draft's grant, unchanged — the card showed the human exactly this object, so
        // nothing here re-derives, widens or defaults it.
        var enabled = current.Capabilities.Enabled.Append(draft.Grant).ToList();
        _manifest.Write(new SiteManifest
        {
            Name = current.Name,
            Template = current.Template,
            Agent = current.Agent,
            Records = current.Records,
            Capabilities = new SiteCapabilities { Deny = current.Capabilities.Deny, Enabled = enabled },
            Ui = current.Ui,
        });

        Directory.Delete(draft.DirPath, recursive: true);
    }

    public void Discard(string id)
    {
        if (!IsSafeId(id)) return;
        var dir = Path.Combine(DraftsRoot, id);
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }

    /// <summary>Parses <c>{dir}/tool.json</c>. Null when there is simply no manifest there (not a
    /// draft); throws for anything present but invalid, so callers can tell "absent" from "broken"
    /// (the latter is always logged by the caller, never silently treated as absent).</summary>
    private CapabilityDraft? Load(string id, string dir)
    {
        var manifestPath = Path.Combine(dir, "tool.json");
        if (!File.Exists(manifestPath)) return null;

        using var doc = JsonDocument.Parse(File.ReadAllText(manifestPath));
        var root = doc.RootElement;

        var name = root.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "";
        if (!string.Equals(name, id, StringComparison.Ordinal))
            throw new InvalidOperationException(
                $"tool.json name '{name}' does not match its draft folder '{id}' — treated as a defect, not a rename");

        var grant = root.TryGetProperty("grant", out var g) ? g.Deserialize<CapabilityGrant>(Json) : null;
        if (grant is null)
            throw new InvalidOperationException($"draft '{id}' has no grant");
        if (!string.Equals(grant.Id, id, StringComparison.Ordinal))
            throw new InvalidOperationException(
                $"draft '{id}' grant.id '{grant.Id}' does not match its draft folder — treated as a defect, not a rename");

        var title = root.TryGetProperty("title", out var t) ? t.GetString() ?? name : name;
        var description = root.TryGetProperty("description", out var d) ? d.GetString() ?? "" : "";

        var entryFile = root.TryGetProperty("command", out var cmd)
            && cmd.TryGetProperty("args", out var args)
            && args.ValueKind == JsonValueKind.Array
            && args.GetArrayLength() > 0
                ? args[0].GetString()
                : null;
        if (string.IsNullOrWhiteSpace(entryFile))
            throw new InvalidOperationException($"draft '{id}' does not name an entry script");

        // The entry file is agent-authored path text too — resolve and confirm it still lands inside
        // the draft's own folder before reading it, or a crafted "../../../state/gatherlight.db"
        // would read platform state through onto an approval card's "show code" panel.
        var entryPath = Path.GetFullPath(Path.Combine(dir, entryFile));
        var dirWithSep = dir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        if (!entryPath.StartsWith(dirWithSep, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"draft '{id}' entry script escapes its own folder");
        if (!File.Exists(entryPath))
            throw new InvalidOperationException($"draft '{id}' entry script '{entryFile}' is missing");

        return new CapabilityDraft(id, title, description, grant, File.ReadAllText(entryPath), dir);
    }

    private static void CopyDirectory(string sourceDir, string targetDir)
    {
        Directory.CreateDirectory(targetDir);
        foreach (var file in Directory.EnumerateFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(sourceDir, file);
            var dest = Path.Combine(targetDir, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            File.Copy(file, dest, overwrite: false);
        }
    }

    // A draft id becomes a directory segment under both DraftsRoot and ToolsRoot, and (once Task 4
    // wires the TOOL_DRAFT marker) is read straight off agent-generated text — so anything that could
    // escape either root by string trickery must be rejected before it is ever joined into a path.
    private static bool IsSafeId(string id) =>
        !string.IsNullOrWhiteSpace(id)
        && id.Trim() == id
        && !id.StartsWith('.') && !id.EndsWith('.')
        && !id.Contains('/') && !id.Contains('\\')
        && !id.Contains("..")
        && !id.Contains(':');
}
