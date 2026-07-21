// IMigrationStep.cs
namespace Gatherlight.Server.Modules.Migration.Services;

/// <summary>One ordered, idempotent startup-migration step. Registered as a DI collection
/// (AddSingleton&lt;IMigrationStep,…&gt;) in registration order = run order. An Essential step that
/// throws keeps the gate closed (never serve half-migrated); a best-effort step that throws is
/// recorded and skipped past.</summary>
public interface IMigrationStep
{
    string Id { get; }
    string Title { get; }        // shown in the /manage overlay — Simplified Chinese
    bool Essential { get; }
    Task RunAsync(CancellationToken ct);
}
