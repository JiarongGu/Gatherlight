using Microsoft.Extensions.Logging;

namespace Gatherlight.Server.Platform.Storage.DataRepo.Services;

/// <summary>What a maintenance pass did, or why it did nothing.</summary>
public sealed record RepoMaintenanceReport(bool Ran, int LooseBefore, int LooseAfter, long PackedKb, string Reason);

/// <summary>
/// Keeps the data repo's object store compact.
///
/// <para><b>Why this exists, measured rather than assumed.</b> Git writes every new object LOOSE — one
/// zlib file each — and only packs them when told. The whole-install backup carries <c>.git</c>, and a
/// loose object compresses badly inside a zip because it is already compressed. After a few restore
/// cycles a real data folder held 223 loose objects at 1.93 MiB against 158 packed at 790 KiB, and the
/// exported backup had grown by 1.2 MB — none of it the household's content. Repacking took
/// <c>.git</c> from 3.1 MB to 1.1 MB and the backup from 4.86 MB to 2.79 MB, which is SMALLER than the
/// one taken before any of it.</para>
///
/// <para><b>Lossless on purpose.</b> This repacks and expires reflogs; it never drops a commit. The
/// data repo is the audit trail the diff gate rests on — "what did the agent change last Tuesday" is
/// answerable only while that history exists. Bounding how far back it goes is a separate, destructive
/// decision that belongs to the household, not to a maintenance pass that runs on its own.</para>
/// </summary>
public interface IDataRepoMaintenance
{
    /// <summary>Repack when loose objects have piled up. Cheap to call: the check is one git command,
    /// and it does nothing until there is something to gain.
    /// <para><paramref name="force"/> skips the threshold, for a caller that KNOWS it just wrote a
    /// tree's worth of objects — a restore does exactly that, and making it wait for a threshold means
    /// a small household never packs at all and every export carries the loose pile.</para></summary>
    Task<RepoMaintenanceReport> RunAsync(bool force = false, CancellationToken ct = default);
}

public sealed class DataRepoMaintenance : IDataRepoMaintenance
{
    /// <summary>Below this, packing costs more than it saves. A quiet week of planning makes a handful
    /// of objects; the pile only becomes worth collecting after a restore or a burst of commits.</summary>
    private const int LooseThreshold = 150;

    private readonly IGitCliService _git;
    private readonly DataWriteLock _writeLock;
    private readonly ILogger<DataRepoMaintenance> _log;

    public DataRepoMaintenance(IGitCliService git, DataWriteLock writeLock, ILogger<DataRepoMaintenance> log)
        => (_git, _writeLock, _log) = (git, writeLock, log);

    public async Task<RepoMaintenanceReport> RunAsync(bool force = false, CancellationToken ct = default)
    {
        var before = await LooseCountAsync(ct);
        if (before < 0) return new RepoMaintenanceReport(false, 0, 0, 0, "no data repo");
        if (before == 0 && !force)
            return new RepoMaintenanceReport(false, 0, 0, await PackedKbAsync(ct), "nothing loose");
        if (!force && before < LooseThreshold)
            return new RepoMaintenanceReport(false, before, before, await PackedKbAsync(ct), $"{before} loose objects — below the {LooseThreshold} threshold");

        // One writer at a time. git gc rewrites the object store, and a commit landing mid-pack is the
        // kind of corruption that is discovered much later, in a backup nobody can restore.
        using (await _writeLock.AcquireAsync(ct))
        {
            // Reflogs are per-clone breadcrumbs, not history — they pin otherwise-unreachable objects
            // and travel in the backup for no one's benefit. Expire them first so gc can actually
            // reclaim what the imports left behind.
            await _git.RunAsync(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"], ct);
            var gc = await _git.RunAsync(["gc", "--quiet", "--prune=now"], ct);
            if (gc.ExitCode != 0)
            {
                // Non-fatal by design: a repo that failed to compact still works perfectly. Say so and
                // carry on rather than blocking startup on housekeeping.
                _log.LogWarning("data repo: gc failed ({Code}) — {Err}", gc.ExitCode, gc.Stderr.Trim());
                return new RepoMaintenanceReport(false, before, before, await PackedKbAsync(ct), "gc failed");
            }
        }

        var after = await LooseCountAsync(ct);
        var packedKb = await PackedKbAsync(ct);
        _log.LogInformation("data repo: packed {Before} loose objects → {After} loose, {PackedKb} KB in pack",
            before, after, packedKb);
        return new RepoMaintenanceReport(true, before, after, packedKb, "packed");
    }

    /// <summary>Loose object count from <c>git count-objects -v</c> (`count:`), or -1 when there is no repo.</summary>
    private async Task<int> LooseCountAsync(CancellationToken ct)
    {
        var r = await _git.RunAsync(["count-objects", "-v"], ct);
        if (r.ExitCode != 0) return -1;
        return ReadField(r.Stdout, "count:") ?? -1;
    }

    private async Task<long> PackedKbAsync(CancellationToken ct)
    {
        var r = await _git.RunAsync(["count-objects", "-v"], ct);
        return r.ExitCode == 0 ? ReadField(r.Stdout, "size-pack:") ?? 0 : 0;
    }

    private static int? ReadField(string stdout, string key)
    {
        foreach (var line in stdout.Split('\n'))
        {
            var t = line.Trim();
            if (!t.StartsWith(key, StringComparison.Ordinal)) continue;
            if (int.TryParse(t[key.Length..].Trim(), out var v)) return v;
        }
        return null;
    }
}
