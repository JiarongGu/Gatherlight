using Lyntai.Agents;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// Whether the agent run in flight may MUTATE the household's files — the server-side half of "the
/// scoped file tools work only in an execute run, never in a read-only plan run".
///
/// <para><b>Why a singleton flag and not per-call context.</b> The agent's file tools are called over the
/// loopback MCP endpoint (<c>McpEndpoint</c>), on a different request than the one awaiting the run — so an
/// <c>AsyncLocal</c> set around the run would not flow to the tool call. What makes a shared flag correct is
/// the agent lease: exactly one run holds it at a time (<c>IAgentGate</c>), so while a run is active there is
/// one answer to "may this run write". <see cref="AgentRunner"/> enters the scope for the whole run keyed on
/// its <see cref="AgentToolPolicy"/> — Write for execute/repair/job-execute, ReadOnly for plan/revise/report
/// — and the mutating tools read <see cref="WritesAllowed"/>.</para>
///
/// <para>This is the ENFORCEMENT the e2e drives (the stub CLI does not enforce <c>--allowedTools</c>);
/// <c>ToolRegistry.McpAllowedToolNames(writable:false)</c> is the second layer, keeping a real CLI from
/// offering the tools in a plan run at all.</para>
/// </summary>
public interface IAgentRunScope
{
    /// <summary>True only while an execute (write-policy) run is in flight.</summary>
    bool WritesAllowed { get; }

    /// <summary>Enter the scope for one run; dispose restores the previous policy. Nesting restores rather
    /// than clears so a stray concurrent enter cannot leave writes open, though the lease admits one run.</summary>
    IDisposable Enter(AgentToolPolicy policy);
}

public sealed class AgentRunScope : IAgentRunScope
{
    private readonly object _gate = new();
    private AgentToolPolicy _policy = AgentToolPolicy.ReadOnly;

    public bool WritesAllowed { get { lock (_gate) return _policy == AgentToolPolicy.Write; } }

    public IDisposable Enter(AgentToolPolicy policy)
    {
        AgentToolPolicy prev;
        lock (_gate) { prev = _policy; _policy = policy; }
        return new Restore(this, prev);
    }

    private sealed class Restore(AgentRunScope owner, AgentToolPolicy prev) : IDisposable
    {
        private bool _done;
        public void Dispose()
        {
            if (_done) return;
            _done = true;
            lock (owner._gate) owner._policy = prev;
        }
    }
}
