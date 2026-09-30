namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>Which of EmbeddingGemma's ONNX exports the 内置 embedder loads — a MEASUREMENT mode, never a default
/// (<c>docs/judge-bench.md</c> Run 16, 2026-10-01): read ONCE at startup from <c>GATHERLIGHT_EMBED_ONNX_EXPORT</c>, and
/// announced whenever it is SET, raw value beside what it resolved to — the pattern every measurement knob follows
/// (<see cref="EmbedSegmentation"/>, <see cref="RerankChunking"/>).
///
/// <para><b>Unset — the default, and the product</b>: the pinned q4 export, <see cref="OnnxEmbedder.ModelFile"/>.
/// <c>int8</c> loads <c>onnx/model_quantized.onnx</c> and <c>fp32</c> loads <c>onnx/model.onnx</c>, from the same
/// repository and commit as the q4 pin. Any other value resolves to the default, visibly (the announcement names the file).
/// Only the GRAPH FILE changes: the tokenizer, the export's own <c>sentence_embedding</c> head, normalisation, raw text with
/// no task prompt and the 2,048-token truncation are the product's for every export. Run 15 found the q4 export
/// significantly worse than llama.cpp's Q8_0 GGUF on long notes without separating the quantisation from the tokenizer and
/// the kernels; this is what lets one run hold the other two fixed. Run 16 (2026-09-30) read it: int8 and fp32 each
/// recovered part of the long-note loss over q4 and still lost to llama.cpp significantly, so q4 stays pinned and this
/// stays a knob.</para>
///
/// <para>Nothing provisions the other exports: 资源 downloads q4 alone, so the knob finds the files only where a bench put
/// them, and <see cref="OnnxEmbedder.IsPresent"/> answers for the resolved file — a knob pointing at a file that is not
/// there reads as the model not being installed, never as the q4 export silently standing in.</para></summary>
public static class EmbedExport
{
    /// <summary>The knob's name.</summary>
    public const string KnobName = "GATHERLIGHT_EMBED_ONNX_EXPORT";

    /// <summary>What the knob was set to, or null.</summary>
    public static readonly string? Raw = Environment.GetEnvironmentVariable(KnobName);

    /// <summary>The export as the knob spells it: <c>int8</c>, <c>fp32</c>, or <c>q4</c> (the default).</summary>
    public static readonly string Name = Raw?.Trim().ToLowerInvariant() switch
    {
        "int8" => "int8",
        "fp32" => "fp32",
        _ => "q4",
    };

    /// <summary>The graph file this process's 内置 embedder loads, relative to its model directory.</summary>
    public static readonly string ModelFile = Name switch
    {
        "int8" => "onnx/model_quantized.onnx",
        "fp32" => "onnx/model.onnx",
        _ => OnnxEmbedder.ModelFile,
    };
}
