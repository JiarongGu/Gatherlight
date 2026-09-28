namespace Gatherlight.Server.Platform.Agent.Llm.Models;

/// <summary>
/// The bare names of the scoped file tools the agent may call over MCP. In ONE place because two Platform
/// seams read them and must not drift: the tools themselves register under these names, and
/// <c>AgentRunner</c> — which is Platform and cannot reference the Product — recognises the mutating two
/// (<c>mcp__&lt;server&gt;__&lt;name&gt;</c>) to record their touched paths into the run's <c>EditTracker</c>,
/// so a move or a delete surfaces at the diff gate exactly like an Edit/Write.
/// </summary>
public static class AgentFileTools
{
    /// <summary>Move or rename a file/dir within the write scope. MUTATING → write runs only.</summary>
    public const string Move = "fs_move";

    /// <summary>Delete a file/dir within the write scope. MUTATING → write runs only.</summary>
    public const string Delete = "fs_delete";

    /// <summary>Size + mtime of a path inside the read jail. READ-ONLY → any run.</summary>
    public const string Info = "file_info";

    /// <summary>Does an <c>mcp__&lt;server&gt;__&lt;tool&gt;</c> name end in one of the MUTATING file tools?</summary>
    public static bool IsMutating(string mcpToolName) =>
        mcpToolName.EndsWith("__" + Move, StringComparison.Ordinal)
        || mcpToolName.EndsWith("__" + Delete, StringComparison.Ordinal);
}
