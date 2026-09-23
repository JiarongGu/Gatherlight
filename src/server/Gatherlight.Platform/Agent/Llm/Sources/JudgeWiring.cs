using Gatherlight.Server.Platform.Agent.Llm.Services;
using Lyntai.Inference;
using Lyntai.Memory.Verification;
using Microsoft.Extensions.DependencyInjection;

namespace Gatherlight.Server.Platform.Agent.Llm.Sources;

/// <summary>What 判断 is made of once a source is bound: who ANNOTATES each write (a text client and its model)
/// and what VERIFIES each recall.
///
/// <para><b>Why the source answers this, not the composition root.</b> The two halves stopped moving together
/// the day a reranker could verify: it scores pairs and never generates, so annotation has to stay on a
/// chat model. Branching on that in <c>GatherlightApp</c> would be the if/else chain the source catalog
/// exists to replace; each source states its own wiring instead.</para></summary>
/// <param name="AnnotationClient">The named text client that annotates, or null for the default client
/// (the Claude CLI).</param>
/// <param name="AnnotationModel">The model annotation runs on — the ONE value <c>llm.model.memory</c> and
/// <c>DefaultModelByConsumer["memory"]</c> hold. Never a reranker's id: the CLI would be asked for it.</param>
/// <param name="Verifier">Builds the recall verifier from the container.</param>
public sealed record JudgeWiring(
    string? AnnotationClient,
    string AnnotationModel,
    Func<IServiceProvider, IMemoryVerificationPolicy> Verifier)
{
    /// <summary>An LLM judge on <paramref name="client"/>: both halves on the same model. The verifier is shown
    /// each fact's content (<see cref="JudgeSeesContentPolicy"/>) unless the measurement knob asks for topics.</summary>
    public static JudgeWiring Llm(string? client, string model) => new(client, model, sp =>
    {
        IMemoryVerificationPolicy llm = new LlmMemoryVerificationPolicy(
            sp.GetRequiredService<ITextClientFactory>(),
            new LlmVerificationOptions { ClientName = client },
            sp.GetService<ILogger<LlmMemoryVerificationPolicy>>());
        return JudgeSeesContentPolicy.Enabled ? new JudgeSeesContentPolicy(llm) : llm;
    });
}
