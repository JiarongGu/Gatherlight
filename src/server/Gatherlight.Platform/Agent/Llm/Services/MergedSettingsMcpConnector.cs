using System.Text.Json.Nodes;
using Lyntai.Agents;

namespace Gatherlight.Server.Platform.Agent.Llm.Services;

/// <summary>
/// The judge-tools host's claude connector, with the app's one-shot settings MERGED into the settings file it hands the
/// CLI — so a scorer applies the same settings as every other one-shot call.
///
/// <para><b>Why.</b> Every one-shot call is handed the app's one-shot settings (<c>ClaudeCompletionOptions.SettingsPath</c>,
/// Lyntai 3.5.2: the blanked key paths, <c>disableSkillShellExecution</c>, the read fence). A SCORER is handed a second
/// <c>--settings</c> after it, by Lyntai's <c>ClaudeCliMcpConnector</c>: a file whose only content is the allow-list that
/// pre-approves the judge tools. The CLI applies only the LAST <c>--settings</c> — measured on claude 2.1.285 at 0 tokens
/// (<c>docs/self-managed-llm-runtime.md</c> 2026-09-30): with the one-shot file first and an allow-list file after it, a
/// project key helper the one-shot file blanks RAN, and in the reverse order it did not. So the one consumer that grades
/// agent-written text ran with no read fence and no blanks, while every sentence about the one-shot settings said it had
/// them. Here the host's file is replaced by one holding both: the app's settings, and the host's on top where they do not
/// collide — objects merged, arrays joined, and on a scalar the APP's value wins, since the host's file carries only its
/// allow-list and the app's carries what keeps a call on the subscription.</para>
///
/// <para>It keys on the CLI's own documented flag, <c>--settings</c>, not on how Lyntai names its temp file. A connector
/// that hands no settings file leaves the app's the one applied, so this does nothing; one whose file cannot be read gets
/// the app's settings alone, and its tools stay pre-approved by the <c>--allowedTools</c> it passes beside it.</para>
///
/// <para><b>A workaround for a Lyntai gap, recorded on both sides</b>: Lyntai <c>TASKS.md</c> Part 342 asks the library to
/// merge the tool host's allow-list into the completion's settings file (or hand only one). When it ships, the scorer's
/// argv carries one <c>--settings</c> holding both, and this class is deleted — <c>e2e-p36</c>'s row asserting what a
/// scorer APPLIES then passes without it.</para>
/// </summary>
public sealed class MergedSettingsMcpConnector(IMcpCliConnector inner, string settingsJson) : IMcpCliConnector
{
    /// <inheritdoc />
    public string ProviderId => inner.ProviderId;

    /// <inheritdoc />
    public async ValueTask<IReadOnlyList<string>> BuildArgsAsync(McpCliContext context, CancellationToken ct = default)
    {
        var args = await inner.BuildArgsAsync(context, ct);
        var at = -1;
        for (var i = 0; i < args.Count - 1; i++)
            if (string.Equals(args[i], "--settings", StringComparison.Ordinal)) at = i;
        if (at < 0) return args;

        var merged = JsonNode.Parse(settingsJson)!.AsObject();
        if (ReadSettings(args[at + 1]) is { } theirs) Merge(merged, theirs);
        var copy = args.ToList();
        copy[at + 1] = context.WriteTempFile("settings", merged.ToJsonString());
        return copy;
    }

    // The CLI takes a file path or inline JSON.
    private static JsonObject? ReadSettings(string value)
    {
        try
        {
            var text = value.TrimStart().StartsWith('{') ? value : File.ReadAllText(value);
            return JsonNode.Parse(text) as JsonObject;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Text.Json.JsonException
                                     or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }

    /// <summary>Folds <paramref name="theirs"/> into <paramref name="ours"/>: objects merged key by key, arrays joined
    /// (ours first, a value already there not repeated), and a scalar — or a kind mismatch — left as OURS.</summary>
    internal static void Merge(JsonObject ours, JsonObject theirs)
    {
        foreach (var (key, value) in theirs.ToList())
        {
            if (value is null) continue;
            if (!ours.TryGetPropertyValue(key, out var mine) || mine is null)
            {
                ours[key] = value.DeepClone();
                continue;
            }
            switch (mine, value)
            {
                case (JsonObject a, JsonObject b):
                    Merge(a, b);
                    break;
                case (JsonArray a, JsonArray b):
                    foreach (var item in b)
                        if (item is not null && !a.Any(x => JsonNode.DeepEquals(x, item)))
                            a.Add(item.DeepClone());
                    break;
            }
        }
    }
}
