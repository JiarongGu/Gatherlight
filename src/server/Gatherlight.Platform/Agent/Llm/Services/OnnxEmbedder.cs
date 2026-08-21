using Lyntai.Embeddings;
using Microsoft.ML.OnnxRuntime;
using Microsoft.ML.OnnxRuntime.Tensors;
using Microsoft.ML.Tokenizers;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// The 内置 embedder: EmbeddingGemma 300M as ONNX, run IN-PROCESS by ONNX Runtime. No daemon, no port,
/// nothing for the household to install or keep running.
///
/// <para><b>Everything here was measured before it was written</b> (2026-08-22, probe recorded in
/// <c>docs/builtin-model-runner.md</c>), because every way of getting this wrong fails SILENTLY — a wrong
/// tokenizer, variant, prompt or pooling produces worse recall, never an error:</para>
///
/// <list type="bullet">
/// <item><b>Pooling is the model's, not ours.</b> The export carries the sentence-transformers head and
/// emits <c>sentence_embedding [batch, 768]</c> beside <c>last_hidden_state</c>. Mean-pooling the hidden
/// states by hand would be the single most likely source of a plausible-but-wrong vector, so we read the
/// head's output and normalise, and nothing else.</item>
/// <item><b>Raw text, no task prompt.</b> EmbeddingGemma is asymmetric by design
/// (<c>task: search result | query: </c> · <c>title: none | text: </c>), so applying them is the obvious
/// move — and it measured WORSE (7/8 against 8/8). Symmetric is also what this app already does through
/// Ollama, so the built-in path matches the product instead of quietly diverging from it. Do not "fix"
/// this without re-running the fixture.</item>
/// <item><b>q4, not fp32.</b> Ties Ollama's own quantisation of the same model on the fixture (8/8 top-1)
/// at 197 MB against 1.23 GB.</item>
/// </list>
///
/// <para><b>It is NOT vector-compatible with the Ollama arm</b>, and that is expected rather than a defect:
/// cosine between the two lands at 0.67–0.84, which is two different quantisations of the same weights, not
/// a wiring mistake (a prompt mismatch would be wrong in a consistent direction; this flips per text). It
/// costs nothing because switching backend already forces a reindex — a changed embedder invalidates stored
/// vectors whatever the reason, and the binding endpoint reports that.</para>
///
/// <para><b>Loaded lazily.</b> 197 MB of weights should not be paged in because the container was built;
/// the first embed pays for it. <see cref="InferenceSession"/> is safe for concurrent
/// <see cref="InferenceSession.Run(IReadOnlyCollection{NamedOnnxValue})"/>, so one instance serves every
/// caller.</para>
/// </summary>
public sealed class OnnxEmbedder : IEmbedder, IDisposable
{
    /// <summary>Paths inside the provisioned model directory. They are the resource's own layout, so a
    /// change here is a change to <c>ResourceProvisioner</c>'s file list too — and the external-weights
    /// file must stay BESIDE its .onnx, which is why the resource declares per-file destinations.</summary>
    public const string ModelFile = "onnx/model_q4.onnx";
    public const string TokenizerFile = "tokenizer.model";

    /// <summary>The model's own limit (<c>max_position_embeddings</c> in its config.json). Longer input is
    /// truncated rather than refused: a fact too long to embed whole is still worth embedding.</summary>
    private const int MaxTokens = 2048;

    private readonly string _dir;
    private readonly ILogger<OnnxEmbedder>? _log;
    private readonly Lazy<(InferenceSession Session, SentencePieceTokenizer Tokenizer)> _model;

    public OnnxEmbedder(string modelDir, ILogger<OnnxEmbedder>? log = null)
    {
        _dir = modelDir;
        _log = log;
        _model = new Lazy<(InferenceSession, SentencePieceTokenizer)>(Load, isThreadSafe: true);
    }

    /// <summary>Is the model actually on disk? Asked before anything is bound to this backend, so a missing
    /// download is a sentence in the console rather than an exception on the first fact written.</summary>
    public static bool IsPresent(string modelDir) =>
        File.Exists(Path.Combine(modelDir, ModelFile.Replace('/', Path.DirectorySeparatorChar)))
        && File.Exists(Path.Combine(modelDir, TokenizerFile));

    private (InferenceSession, SentencePieceTokenizer) Load()
    {
        var onnx = Path.Combine(_dir, ModelFile.Replace('/', Path.DirectorySeparatorChar));
        var sp = Path.Combine(_dir, TokenizerFile);
        if (!File.Exists(onnx) || !File.Exists(sp))
            throw new InvalidOperationException(
                $"内置嵌入模型不完整({_dir})—— 请在「资源 · Resources」面板重新下载。");

        var started = System.Diagnostics.Stopwatch.StartNew();
        var session = new InferenceSession(onnx);
        using var stream = File.OpenRead(sp);
        // SentencePiece, not the 20 MB tokenizer.json: Microsoft.ML.Tokenizers cannot read the HuggingFace
        // fast-tokenizer JSON, and the .model protobuf is the same vocabulary at a quarter of the size.
        // BOS on, EOS off — what the model was exported expecting.
        var tokenizer = SentencePieceTokenizer.Create(stream, addBeginningOfSentence: true, addEndOfSentence: false);
        _log?.LogInformation("内置 embedder loaded in {Ms} ms from {Dir}", started.ElapsedMilliseconds, _dir);
        return (session, tokenizer);
    }

    public Task<IReadOnlyList<float[]>> EmbedAsync(
        IReadOnlyList<string> texts, CancellationToken ct = default)
    {
        if (texts.Count == 0) return Task.FromResult<IReadOnlyList<float[]>>(Array.Empty<float[]>());

        var (session, tokenizer) = _model.Value;

        // Tokenise first so the batch's padded width is known. Padding to the batch maximum rather than to
        // MaxTokens matters: this runs on a household CPU, and a 2048-wide tensor for a one-line fact would
        // spend the whole cost of the longest possible input on every write.
        var ids = new List<long[]>(texts.Count);
        foreach (var text in texts)
        {
            ct.ThrowIfCancellationRequested();
            var t = tokenizer.EncodeToIds(text ?? "");
            ids.Add(t.Take(MaxTokens).Select(i => (long)i).ToArray());
        }

        var width = Math.Max(1, ids.Max(x => x.Length));
        var flatIds = new long[texts.Count * width];
        var flatMask = new long[texts.Count * width];
        for (var row = 0; row < ids.Count; row++)
        {
            for (var col = 0; col < ids[row].Length; col++)
            {
                flatIds[row * width + col] = ids[row][col];
                // 1 for real tokens, 0 for padding — the pooling head weights by this, so getting it wrong
                // would average padding into the vector and produce a subtly worse embedding, silently.
                flatMask[row * width + col] = 1;
            }
        }

        using var results = session.Run(new[]
        {
            NamedOnnxValue.CreateFromTensor("input_ids", new DenseTensor<long>(flatIds, new[] { texts.Count, width })),
            NamedOnnxValue.CreateFromTensor("attention_mask", new DenseTensor<long>(flatMask, new[] { texts.Count, width })),
        });

        var pooled = results.First(r => r.Name == "sentence_embedding").AsTensor<float>();
        var dims = pooled.Dimensions[^1];
        var output = new List<float[]>(texts.Count);
        for (var row = 0; row < texts.Count; row++)
        {
            var v = new float[dims];
            for (var d = 0; d < dims; d++) v[d] = pooled[row, d];
            output.Add(Normalize(v));
        }
        return Task.FromResult<IReadOnlyList<float[]>>(output);
    }

    /// <summary>Unit length, so cosine is a dot product and every store that assumes normalised vectors
    /// gets what it assumes. The Ollama arm's endpoint already returns normalised vectors; matching that
    /// keeps the two backends comparable even though their VALUES differ.</summary>
    private static float[] Normalize(float[] v)
    {
        var norm = MathF.Sqrt(v.Sum(x => x * x));
        if (norm == 0) return v;
        for (var i = 0; i < v.Length; i++) v[i] /= norm;
        return v;
    }

    public void Dispose()
    {
        if (_model.IsValueCreated) _model.Value.Session.Dispose();
    }
}
