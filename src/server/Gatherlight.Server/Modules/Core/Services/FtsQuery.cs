namespace Gatherlight.Server.Modules.Core.Services;

/// <summary>
/// Turns a free-text query into a safe FTS5 MATCH expression for the trigram-tokenized search
/// indexes, or null when it can't (so the caller falls back to LIKE). Trigram needs ≥3 characters,
/// so short tokens are dropped; the remaining tokens are quoted (FTS5 special chars neutralized) and
/// OR-ed for forgiving recall, then ranked by bm25 at the call site.
/// </summary>
public static class FtsQuery
{
    public static string? Build(string? query)
    {
        if (string.IsNullOrWhiteSpace(query)) return null;
        var tokens = query
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(t => t.Length >= 3)                                   // trigram minimum
            .Select(t => "\"" + t.Replace("\"", "\"\"") + "\"")         // quote → literal, no operator injection
            .ToList();
        return tokens.Count == 0 ? null : string.Join(" OR ", tokens);
    }

    /// <summary>Escape a raw query for use inside a LIKE pattern with <c>ESCAPE '\'</c> — so a user's
    /// <c>%</c>/<c>_</c> is matched literally instead of becoming a wildcard (over-matching). Escape the
    /// escape char first.</summary>
    public static string EscapeLike(string q) =>
        q.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_");
}
