using Lyntai.Inference;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>Whether the llama.cpp EMBEDDER segments an input longer than its window — Lyntai's D177 on the
/// <c>llamacpp-embed</c> registration: <c>HttpModelOptions.MaxInputChars</c> plus <c>Segmentation</c>, each over-long input
/// split into pieces that are embedded and pooled into ONE length-weighted mean vector. A MEASUREMENT mode, never a
/// default (<c>docs/judge-bench.md</c> Run 14, 2026-09-28): read ONCE at startup from <c>GATHERLIGHT_EMBED_SEGMENTATION</c>,
/// on for <c>d177</c> and off for anything else, announced whenever it is SET — the pattern every measurement knob follows
/// (<see cref="RerankChunking"/>).
///
/// <para><b>Off — the default, and the no-knob arm</b>: an input past the window is refused whole by llama.cpp, and the
/// fact index keeps that fact without a vector (<c>FactIndex.IndexAsync</c>'s classifier, dev-conventions' workaround (3)).</para>
///
/// <para><b>The piece size is the tokenizer's WORST CASE, so no piece is refused.</b> Lyntai COUNTS an input's characters
/// after NFKC, per text element, and SENDS THE ORIGINAL text, so the bound needs the most tokens the original text of one
/// counted unit can cost. Measured on the pinned EmbeddingGemma GGUF's own <c>/tokenize</c> (llama.cpp b10549, every
/// assigned non-control scalar, 292,466; <c>docs/judge-bench.md</c> Run 14's design): at most
/// <see cref="WorstTokensPerCountedUnit"/> — an astral scalar whose NFKC form is one unit (𝐉 → J, 丽 → 丽) costs four byte
/// tokens; a BMP scalar outside the vocabulary three (丌, U+3000); an astral one left as a surrogate pair two per unit.
/// With the <see cref="SpecialTokens"/> llama.cpp adds to every input, a piece of
/// (window − <see cref="SpecialTokens"/>) ÷ <see cref="WorstTokensPerCountedUnit"/> counted units fits the window whatever
/// it holds: 511 for EmbeddingGemma's 2,048. <b>Stated residual</b>: NFKC COMPOSES — conjoining Hangul jamo, a letter and
/// its combining mark — so a decomposed text counts fewer units than it has characters, and a piece dense in them can pass
/// the bound; llama.cpp then refuses that input whole, which is today's behaviour for it. The price of the worst case:
/// ordinary text reads far below it — the long fixture's notes 0.77–0.80 tokens per unit in Chinese, 0.63–0.64 in
/// Japanese, 0.20–0.22 in English — so a piece holds ~410 tokens of Chinese and ~105 of English, and a long English fact
/// is cut into many more pieces than its tokens need. A segmenter counting TOKENS would not pay that; Lyntai's HTTP one
/// counts characters.</para>
///
/// <para><b>Segmentation</b>: Lyntai's default overlap, 0.15 of a piece (the next piece restarts at a sentence end or
/// space inside the last 15%), and NO piece cap, so every part of a fact is embedded — a cap keeps the first, the last
/// and evenly spaced pieces and drops the rest, which for an embedding means text that never reaches the vector.</para></summary>
public static class EmbedSegmentation
{
    /// <summary>The knob's name.</summary>
    public const string KnobName = "GATHERLIGHT_EMBED_SEGMENTATION";

    /// <summary>What the knob was set to, or null.</summary>
    public static readonly string? Raw = Environment.GetEnvironmentVariable(KnobName);

    /// <summary>Whether this process's llama.cpp embedder segments over-long inputs.</summary>
    public static readonly bool On = string.Equals(Raw?.Trim(), "d177", StringComparison.OrdinalIgnoreCase);

    /// <summary>The mode as the knob spells it — what the startup announcement prints.</summary>
    public static string Name => On ? "d177" : "off";

    /// <summary>The special tokens llama.cpp adds to an embedding input (BOS and EOS), measured on EmbeddingGemma.</summary>
    public const int SpecialTokens = 2;

    /// <summary>The most tokens the ORIGINAL text of one NFKC-counted unit costs on EmbeddingGemma's tokenizer — measured,
    /// see the class comment.</summary>
    public const int WorstTokensPerCountedUnit = 4;

    /// <summary>Lyntai's default overlap, kept (see the class comment).</summary>
    public const double Overlap = 0.15;

    /// <summary>The <c>MaxInputChars</c> for an embedder whose DECLARED window is <paramref name="window"/> — or, without
    /// one, the physical batch it is launched with (<see cref="LlamaServerRuntime.EmbedBatch"/>).</summary>
    public static int MaxInputChars(int? window) =>
        ((window ?? LlamaServerRuntime.EmbedBatch) - SpecialTokens) / WorstTokensPerCountedUnit;

    /// <summary>The segmentation record: segment (not truncate), the default overlap, no piece cap.</summary>
    public static InputSegmentation Segmentation() => new() { Overlap = Overlap };
}
