namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// What a model-name comparison and an embedding probe need, independent of any one runtime.
///
/// <para>Both types used to live in <c>OllamaRuntime.cs</c>, which was fine while Ollama was a first-class
/// backend and wrong once it stopped being one: four other files depend on them, and none of them is about
/// Ollama. They moved here rather than being deleted with that runtime — the same "extract what still has
/// consumers, then delete the rest" the file split rules ask for.</para>
/// </summary>
public static class ModelId
{
    /// <summary>Does a HELD model id name the WANTED one, tolerating the <c>:latest</c> tag?
    ///
    /// <para>Tag-shaped ids are not an Ollama peculiarity — any registry-backed runtime reachable over the
    /// OpenAI-compatible API reports them, Ollama included, and <c>bge-m3</c> and <c>bge-m3:latest</c> are
    /// the same weights. Comparing them with <c>==</c> is how a bound model reads as missing, which is
    /// silent: recall is fail-open, so the layer simply stops improving.</para></summary>
    public static bool Matches(string held, string wanted) =>
        held.Equals(wanted, StringComparison.OrdinalIgnoreCase)
        || held.Equals($"{wanted}:latest", StringComparison.OrdinalIgnoreCase)
        || (wanted.EndsWith(":latest", StringComparison.OrdinalIgnoreCase)
            && held.Equals(wanted[..^7], StringComparison.OrdinalIgnoreCase));
}

/// <summary>Evidence that a backend can actually do the job, gathered before a binding is saved.</summary>
/// <param name="Dimensions">The vector width, for an embedding arm.</param>
/// <param name="Milliseconds">How long the probe took — reported because a working-but-slow arm is a
/// different decision from a working one.</param>
/// <param name="What">What was proven, when it is not a vector. Null = a vector width, which is the case
/// for every embedding arm. The CLI arm proves it can REPHRASE and reports how many phrasings it produced,
/// and the console must not print that as a dimension count — a label asserting something the code did not
/// measure is the defect this whole area keeps correcting.</param>
public sealed record EmbedProbe(int Dimensions, int Milliseconds, string? What = null);
