using Lyntai;
using Lyntai.Memory.Seeding;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>
/// What every EMBEDDER arm of 语义 adds beside its own backend: somewhere to keep the vectors, the stated
/// intent to recall by meaning, and the recall channel that actually reads them.
///
/// <para><b>One place, because the three belong together and the third is easy to lose.</b> Until Lyntai 3.2
/// the channel was a graph option (<c>GraphMemoryOptions.SemanticSeedK</c>) set in <c>GatherlightApp</c>
/// whenever 语义 was bound — including to the Claude CLI arm, which registers no embedder, so the option
/// then configured a channel with nothing to search. 3.2 made it a registered seed SOURCE whose constructor
/// needs a vector backend and a vector store, so it now has to be added exactly where those are: here,
/// called only by the arms that register them. Without it an embedder is paid for on every write and read
/// by no recall — the "bought and never consulted" shape Lyntai's own wiring check warns about.</para>
/// </summary>
public static class VectorRecallWiring
{
    /// <summary>How many semantically-similar entries a fact recall considers on top of its lexical matches.
    /// <para>Sized against the over-ask in <c>FactIndex.RankAsync</c> rather than against the page the agent
    /// asked for: seeds are CANDIDATES, fused with the lexical and subject channels by rank, so a seed that
    /// means nothing here simply loses. Too small and a paraphrase whose fact sits outside the top few never
    /// enters the ranking at all. (Lyntai's own default is 20.)</para></summary>
    public const int SeedK = 24;

    /// <summary>Register the store, the intent and the channel. <c>UseSqliteVectorStore</c> must run after
    /// <c>UseSqliteStorage</c> — it checks for the governance feature that owns the <c>lyntai_vector</c>
    /// table at wiring time.</summary>
    public static LyntaiBuilder AddVectorRecall(this LyntaiBuilder b) =>
        b.UseSqliteVectorStore()
         .AddSemanticMemory()
         .AddMemorySemanticSeeds(new SemanticSeedOptions { K = SeedK });
}
