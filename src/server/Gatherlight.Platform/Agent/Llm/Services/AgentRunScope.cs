using Lyntai.Agents;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// Whether an agent run in flight may MUTATE the household's files — the server-side half of "the scoped file
/// tools work only in an execute run, never in a read-only plan run".
///
/// <para><b>Why process-wide state and not per-call context.</b> The agent's file tools are called over the
/// loopback MCP endpoint (<c>McpEndpoint</c>), on a different request than the one awaiting the run — so an
/// <c>AsyncLocal</c> set around the run would not flow to the tool call. <see cref="AgentRunner"/> enters the scope
/// for the whole run keyed on its <see cref="AgentToolPolicy"/> — Write for execute/repair/job-execute, ReadOnly for
/// plan/revise/report and every utility run — and the mutating tools read <see cref="WritesAllowed"/>.</para>
///
/// <para><b>A COUNT of write runs, not a flag (round-6 review).</b> This used to hold the in-flight run's policy and
/// restore the previous one on exit, argued safe because the agent lease admits one run at a time. It does not admit
/// every run: the playground, the knowledge-base migrator's merges and <c>extract</c> over HTTP go through
/// <see cref="AgentRunner"/> without <c>IAgentGate</c>, so they OVERLAP an execute run. Measured on the old flag
/// (<c>e2e-p54</c>): a read-only <c>extract</c> started inside an execute run set the flag read-only, so the execute
/// run's own <c>fs_move</c> was refused; and when the execute run ended FIRST, the read-only run's exit restored the
/// "write" it had saved — writes stayed allowed with no run in flight, and an <c>fs_move</c> over HTTP succeeded. Now a
/// Write run increments a counter and decrements it once on exit, a ReadOnly run leaves it alone, and writes are
/// allowed while the count is above zero. Interleaving cannot leave it wrong: every exit undoes exactly its own enter.</para>
///
/// <para><b>Why not a per-run token</b> on the loopback MCP channel, the stronger alternative (a tool call proving
/// WHICH run it belongs to). It would thread a per-run bearer through <c>AgentMcpWiring</c>, the endpoint and the
/// registry, for a residual the second layer already closes: while an execute run is in flight a read-only run's tool
/// call also passes this check, but its <c>--allowedTools</c> omits the write-scoped tools
/// (<c>ToolRegistry.McpAllowedToolNames(writable:false)</c>) and a <c>-p</c> run refuses a tool that is not allowed
/// — so only a CLI that ignores its own allow-list (a fake one) could use the window, and only for the length of a
/// real execute run whose changes all land at the diff gate anyway.</para>
///
/// <para>This is the ENFORCEMENT the e2e drives (the stub CLI does not enforce <c>--allowedTools</c>); the allow-list
/// is the second layer. The tools are also on the MCP surface only, so nothing outside an agent run reaches them.</para>
/// </summary>
public interface IAgentRunScope
{
    /// <summary>True while at least one execute (write-policy) run is in flight.</summary>
    bool WritesAllowed { get; }

    /// <summary>Enter the scope for one run; dispose ends it. Only a <see cref="AgentToolPolicy.Write"/> run counts, and
    /// its dispose undoes exactly its own enter (idempotent), whatever else started or ended meanwhile.</summary>
    IDisposable Enter(AgentToolPolicy policy);
}

public sealed class AgentRunScope : IAgentRunScope
{
    private int _writeRuns;

    public bool WritesAllowed => Volatile.Read(ref _writeRuns) > 0;

    public IDisposable Enter(AgentToolPolicy policy)
    {
        if (policy != AgentToolPolicy.Write) return NoWrite.Instance;
        Interlocked.Increment(ref _writeRuns);
        return new WriteRun(this);
    }

    private sealed class WriteRun(AgentRunScope owner) : IDisposable
    {
        private int _done;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _done, 1) == 0) Interlocked.Decrement(ref owner._writeRuns);
        }
    }

    private sealed class NoWrite : IDisposable
    {
        public static readonly NoWrite Instance = new();
        public void Dispose() { }
    }
}
