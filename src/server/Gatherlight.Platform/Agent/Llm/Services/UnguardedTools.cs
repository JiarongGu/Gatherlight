using Lyntai.Providers.ClaudeCli;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// The claude CLI built-ins the scope guard cannot see, removed from EVERY agent run the app starts. Applied in one
/// place, <see cref="AgentRunner.RunAsync"/>, which every run site goes through — chat (plan, execute, revise, repair),
/// jobs, the eval playground, the validation pass, <c>extract</c> and the knowledge-base migrator — so no site can forget
/// it. It becomes <c>--disallowed-tools</c>, which the CLI documents as removing the named tools "from Claude's context";
/// subagents inherit only the tools the main conversation has, so they lose them too.
///
/// <para><b>Why these two.</b> The scope guard is a PreToolUse hook, and a hook's <c>matcher</c> names tools; ours is
/// <c>Edit|Write|MultiEdit|NotebookEdit|Bash|Read|Grep|Glob</c>. A built-in outside it never reaches the guard — the trap
/// dev-conventions already records for denied built-ins. Both of these run shell commands:</para>
/// <list type="bullet">
/// <item><c>PowerShell</c> is ON BY DEFAULT on Windows, the platform the app ships for: the CLI's tools reference says it
/// "is enabled automatically" without Git Bash, and "is on by default for claude.ai and Console accounts" with it — so
/// stripping <c>CLAUDE_CODE_USE_POWERSHELL_TOOL</c> (which <c>ChildEnvironment</c> does) cannot remove it. In the execute
/// runs' <c>acceptEdits</c> mode the CLI auto-approves PowerShell's <c>Set-Content</c>, <c>Add-Content</c>,
/// <c>Clear-Content</c> and <c>Remove-Item</c> on any path in the working directory the CLI itself does not protect —
/// its protected paths are <c>.git</c> and <c>.claude</c> — so <c>state/</c>, <c>site.json</c> and <c>uploads/</c> could
/// be written or deleted with no prompt and no guard, past the guard's write scope. (The CLI's docs tell hook authors to
/// match <c>Bash|PowerShell</c> for exactly this reason.)</item>
/// <item><c>Monitor</c> runs a command in the background and, per the CLI's docs, "uses the same permission rules as
/// Bash" — and the execute runs' settings allow a bare <c>Bash</c>. So any Monitor command ran unprompted, and unguarded:
/// the guard's Bash checks (network egress, inline eval, git history, path escape) never saw it.</item>
/// </list>
/// <para>The planner needs neither: its shell is Bash, which the guard inspects, and everything outside the jail is meant
/// to go through the app's MCP tools. The app's own work that needs a shell (系统模式's <c>npm run build</c>) runs
/// server-side, not through the agent.</para>
///
/// <para><b>Looked at and left</b> (the CLI's tools reference, 2026-09-28): the tools that need a permission and are not in
/// the settings' allow list are refused in a <c>-p</c> run with no permission host (the headless docs), so they cannot run
/// at all — <c>Artifact</c>, <c>Workflow</c>, <c>EnterWorktree</c>, <c>ShareOnboardingGuide</c> among them. Of those that
/// need none: <c>Agent</c> is guarded, since hooks fire for a subagent's tool calls too; <c>LSP</c> stays inactive until a
/// code-intelligence plugin is installed; and <c>SendUserFile</c>, <c>RemoteTrigger</c>, <c>CronCreate</c> and
/// <c>ReadMcpResourceTool</c> reach the household's own account, session or MCP servers, not a path past the jail.</para>
///
/// <para><b>Not covered here</b>: Lyntai's ONE-SHOT calls (the scorers, the memory judge, 语义's rephrasing) do not go
/// through <see cref="AgentRunner"/>. Their argv is Lyntai's internal <c>ClaudeArgs</c>, which disallows only
/// <c>AskUserQuestion</c>, from a neutral working directory with no settings file; the app has no seam to narrow it.
/// There, as in any <c>-p</c> run with no permission host, what needs approval is refused, and read-only commands and
/// permission-free tools remain.</para>
/// </summary>
public static class UnguardedTools
{
    /// <summary>The built-ins removed from every agent run.</summary>
    public static readonly IReadOnlyList<string> Removed = ["PowerShell", "Monitor"];

    /// <summary><paramref name="options"/> with <see cref="Removed"/> added to what it already disallows.</summary>
    public static ClaudeAgentOptions Apply(ClaudeAgentOptions options) =>
        options with
        {
            DisallowedTools = [.. options.DisallowedTools, .. Removed.Where(t => !options.DisallowedTools.Contains(t, StringComparer.Ordinal))],
        };
}
