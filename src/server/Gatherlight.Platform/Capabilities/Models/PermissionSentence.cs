namespace Gatherlight.Server.Platform.Capabilities.Models;

/// <summary>
/// Turns a <see cref="CapabilityGrant"/> into the plain-language clauses shown on the household's
/// approval card — the ONLY place those sentences come from. The audience cannot audit JavaScript,
/// so the sentence rendered here IS the thing they are agreeing to; it is derived purely from the
/// enforced grant, in code, never composed by the agent — an injected agent has no channel through
/// which to word its own permissions more reassuringly.
///
/// Every clause below is a PROMISE THE SANDBOX HAS TO KEEP. Before adding one, trace it to the
/// specific enforcement (in S2a) that makes it true:
/// <list type="bullet">
/// <item><description><c>网络 / network</c> — <c>NodeCapabilityLauncher.Build</c> imports
/// <c>cap-guard.mjs</c> (which blocks the network modules and deletes <c>fetch</c>) precisely
/// when <c>grant.Net</c> is false.</description></item>
/// <item><description><c>设置 / 数据库 · settings / database</c> —
/// <c>ISiteContext.ResolveSitePath</c> refuses <c>state/</c> (where <c>settings.json</c> and
/// <c>gatherlight.db</c> live) unconditionally, for both read and write resolution, regardless of
/// what a grant names — there is no grant vocabulary that can express <c>state/</c>.</description></item>
/// <item><description><c>运行其它程序 · run other programs</c> — <c>NodeCapabilityLauncher.Build</c>
/// always passes <c>--permission</c>, under which Node denies <c>child_process</c> spawn/exec
/// (<c>ERR_ACCESS_DENIED</c>) as well as <c>worker_threads</c> and native addons, unconditionally,
/// for every launch regardless of the grant.</description></item>
/// </list>
/// A clause that cannot be traced this way must be DELETED, not softened — an unenforced promise in
/// plain language is the single output this design must not produce, because the household has no
/// way to check it themselves.
/// </summary>
public static class PermissionSentence
{
    /// <summary>What the capability may do — entirely derived from the grant's own fields, in the
    /// site's manifest vocabulary (a record directory name, or <c>cache</c>).</summary>
    public static IReadOnlyList<string> Can(CapabilityGrant grant)
    {
        var can = new List<string>();
        foreach (var dir in grant.Fs.Read) can.Add($"读取 {dir}/ · read {dir}/");
        foreach (var dir in grant.Fs.Write) can.Add($"写入 {dir}/ · write to {dir}/");
        if (grant.Net) can.Add("访问网络 · reach the internet");
        return can;
    }

    /// <summary>
    /// What it cannot do. The settings/database and other-programs clauses are structural facts
    /// about every sandboxed capability launch — true regardless of what the grant says, because
    /// nothing in the grant vocabulary can reach them — so they are unconditional. The network
    /// clause is the one grant-dependent entry: it is printed only when <c>grant.Net</c> is false,
    /// and never alongside the network clause <see cref="Can"/> adds when it is true, so the two
    /// can never contradict each other for the same grant.
    ///
    /// Deliberately NOT included: a clause like "cannot read/write anything outside the directories
    /// listed above". <see cref="Can"/> already grants read on the capability's own code directory
    /// (and, when <c>net</c> is false, read on <c>cap-guard.mjs</c>'s directory) that never appears
    /// in its own read list — so a literal "nothing outside the list" claim would be false for read.
    /// Read and write are also separate grants with separate directory sets, so one blanket clause
    /// cannot honestly cover both verbs at once. Rather than print an imprecise catch-all, the
    /// enumerated <see cref="Can"/> list IS the closed set — nothing wider is asserted here.
    /// </summary>
    public static IReadOnlyList<string> Cannot(CapabilityGrant grant)
    {
        var cannot = new List<string>();
        if (!grant.Net) cannot.Add("访问网络 · reach the internet");
        cannot.Add("读取或修改你的设置和数据库 · read or change your settings or database");
        cannot.Add("运行其它程序 · run other programs");
        return cannot;
    }

    /// <summary>
    /// What an EXTERNAL MCP server may do once approved. This is the honest counterpart to
    /// <see cref="Can"/>/<see cref="Cannot"/>, and it is deliberately shaped differently, because the
    /// thing being described is different: a <c>Script</c> capability is contained, an <c>Mcp</c> one
    /// is not. <c>StdioMcpConnection.Start</c> is a plain <c>Process.Start</c> — no
    /// <c>--permission</c>, no <c>cap-guard.mjs</c>, no path jail — so the process runs with exactly
    /// the privileges of the account hosting Gatherlight.
    ///
    /// There is deliberately NO <c>Cannot</c> counterpart here, and that absence is the whole point.
    /// Every clause in <see cref="Cannot"/> is a promise the sandbox keeps; for an external server
    /// there is no sandbox, so there is no promise to make, and inventing a reassuring one would be
    /// precisely the unenforced-plain-language failure this class exists to prevent. A household that
    /// approves one of these is trusting the third-party package, not us — the card has to say so.
    /// </summary>
    public static IReadOnlyList<string> ExternalMcp() =>
    [
        "以你的身份在这台电脑上运行 · run on this computer as you",
        "读取和修改你的文件 · read and change your files",
        "访问网络 · reach the internet",
    ];
}
