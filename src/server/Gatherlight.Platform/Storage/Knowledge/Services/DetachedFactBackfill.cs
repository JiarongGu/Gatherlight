using Microsoft.Extensions.Logging;

namespace Gatherlight.Server.Platform.Storage.Knowledge.Services;

/// <summary>
/// Runs <see cref="IFactIndex.SyncAsync"/> DETACHED, for a caller that has just written facts without indexing them
/// and must not wait for the index — <c>POST /api/memory/import</c>, and the startup seed (<c>MemorySeedStep</c>,
/// which runs after <c>FactIndexStep</c> and so after the startup back-fill).
///
/// <para><b>Why the import needs it.</b> The import writes through <c>KnowledgeStore.LearnAsync</c> and never indexes:
/// a NEW fact arrives with no <c>graph_ref</c>, and an EDITED one (same kind + topic, new content) has its ref
/// cleared, because the graph dedups by content hash and the old ref names a node holding the previous text. Until
/// the next start's back-fill (<c>FactIndexStep</c>) those facts were found by keyword only — for as long as the app
/// stayed up. This is that same back-fill, run now.</para>
///
/// <para><b>Back-fill ONLY, never a rebuild.</b> <see cref="IFactIndex.SyncAsync"/> indexes the rows whose ref is
/// empty and touches nothing else, so every decay position and link the index has accumulated survives. The backup
/// import is the one caller that rebuilds (its facts were REPLACED, so every restored ref names a node this install
/// never had), and it does so inline — which is why it must not also call this: a back-fill racing a rebuild that has
/// just cleared every ref would remember facts twice.</para>
///
/// <para><b>Detached, and not bound to the request</b>, like the semantic reindex: each fact is a model call when 判断
/// is on, so a large bundle takes minutes, and a browser that stops waiting must not cancel the work. Runs are
/// SERIALISED: a second import's back-fill starts after the first ends and finds only what is still unindexed, so no
/// fact is annotated twice — unless the embedder dies MID-RUN: a write that kept no vector while it was down stays
/// unindexed (<see cref="IFactIndex.IndexAsync"/>), and the next start's back-fill annotates it again. Nothing is persisted about a run — the rows ARE the state: a run cut short by a shutdown
/// leaves its remaining refs empty, and the startup back-fill finishes them. A judge that hangs meets the provider's
/// own timeout here as it would at startup, and annotation fails open to no subjects, as it does there.</para>
///
/// <para><b>Gated like the startup back-fill</b> (<see cref="IFactIndex.EmbedderReadyAsync"/>, our cost policy): with an
/// embedder wired and not answering it walks nothing and says so in the log. Walking would re-remember every imported
/// fact — an annotation call each when 判断 is on the CLI — for writes that lose their vector and stay unindexed
/// (<see cref="IFactIndex.IndexAsync"/>), to be walked again, and paid again, by the next start. Skipped, they are
/// simply rows with empty refs, which the next start's gated back-fill finishes.</para>
///
/// <para>Proof: <c>e2e-p14</c> imports an edit and a new fact and sees both indexed with their new content without a
/// restart, and sees a seeded install's facts indexed in the same life; confirmed to FAIL with each call removed.
/// <c>e2e-p52</c> case 9 imports a fact while the embedder refuses and sees the back-fill skip — no fact content
/// reaches the embedder — and the next start index it; confirmed to FAIL with the gate removed.</para>
/// </summary>
public sealed class DetachedFactBackfill
{
    private readonly IFactIndex _index;
    private readonly ILogger<DetachedFactBackfill>? _log;
    private readonly SemaphoreSlim _one = new(1, 1);

    public DetachedFactBackfill(IFactIndex index, ILogger<DetachedFactBackfill>? log = null)
    {
        _index = index;
        _log = log;
    }

    /// <summary>Queue one back-fill and return at once. <paramref name="why"/> names the caller in the log.</summary>
    public void Start(string why) => _ = Task.Run(async () =>
    {
        await _one.WaitAsync().ConfigureAwait(false);
        try
        {
            // The cost gate first — see the class comment.
            if (!await _index.EmbedderReadyAsync(CancellationToken.None).ConfigureAwait(false))
            {
                _log?.LogWarning("fact index: back-fill after {Why} skipped — the embedder does not answer a probe; " +
                    "the facts stay findable by keyword and the next start's back-fill indexes them", why);
                return;
            }
            // SyncAsync logs what it back-filled and degrades rather than throwing; the catch is for anything outside it.
            var indexed = await _index.SyncAsync(CancellationToken.None).ConfigureAwait(false);
            _log?.LogInformation("fact index: back-fill after {Why} indexed {Indexed} fact(s)", why, indexed);
        }
        catch (Exception ex)
        {
            _log?.LogWarning(ex, "fact index: back-fill after {Why} failed; the next start retries it", why);
        }
        finally { _one.Release(); }
    });
}
