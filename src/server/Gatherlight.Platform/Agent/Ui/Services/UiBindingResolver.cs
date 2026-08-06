using System.Globalization;
using System.Text.Json;
using Gatherlight.Server.Platform.Agent.Ui.Data;
using Gatherlight.Server.Platform.Agent.Ui.Models;
using Microsoft.Extensions.Logging;

namespace Gatherlight.Server.Platform.Agent.Ui.Services;

public interface IUiBindingResolver
{
    /// <summary>Replace every <c>bind</c> in the tree with the data it names. Returns a new tree; the
    /// input is not mutated.</summary>
    Task<UiNode> ResolveAsync(UiNode root, CancellationToken ct);
}

/// <summary>
/// Turns a validated tree into a tree with data in it. This runs SERVER-SIDE, wherever a tree is
/// already being validated, and the node that goes over the wire has its literal props filled and
/// <c>bind</c> gone. Three things fall out of that placement, and all three are the reason for it:
///
/// <list type="bullet">
/// <item><description>The client never learns what a binding is — <c>RENDERERS</c> and
/// <c>UI_COMPONENTS</c> are untouched, so <c>check-ui-registry</c> keeps meaning what it means.</description></item>
/// <item><description>A binding is not an endpoint the browser can call with parameters of its own.
/// It is a server-side fill of a tree the server already validated.</description></item>
/// <item><description>The S3b diff gate reviews a page by RENDERING it — so a bound page is reviewed
/// against live data, which is what the reviewer actually needs to see.</description></item>
/// </list>
///
/// A fetch failure never blanks the page and never yields an empty table: an empty table is
/// indistinguishable from "you have no trips", which is a lie told on the household's own data. The
/// node becomes a visible warning where the data would have been, and the rest of the page renders.
/// </summary>
public sealed class UiBindingResolver : IUiBindingResolver
{
    private readonly Dictionary<string, IUiDataSource> _sources;
    private readonly ILogger<UiBindingResolver> _log;

    public UiBindingResolver(IEnumerable<IUiDataSource> sources, ILogger<UiBindingResolver> log)
    {
        _sources = sources.ToDictionary(s => s.Id, StringComparer.Ordinal);
        _log = log;
    }

    public async Task<UiNode> ResolveAsync(UiNode root, CancellationToken ct)
    {
        var children = new List<UiNode>(root.Children.Count);
        foreach (var child in root.Children) children.Add(await ResolveAsync(child, ct));

        if (!root.Props.TryGetValue("bind", out var bind))
            return root with { Children = children };

        var props = new Dictionary<string, JsonElement>(root.Props, StringComparer.Ordinal);
        props.Remove("bind");

        var query = bind.TryGetProperty("query", out var q) ? q.GetString() ?? "" : "";
        // The validator already refused an unregistered id, so a miss here means the registry changed
        // under a page that is already committed — still a runtime problem, not a reason to blank it.
        if (!_sources.TryGetValue(query, out var source))
            return Unavailable(query, "this app no longer provides that data");

        UiData data;
        try
        {
            data = await source.FetchAsync(new UiBindArgs(ParamsOf(bind)), ct);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "ui binding '{Query}' failed", query);
            return Unavailable(query, "could not be read just now");
        }

        return root.Type switch
        {
            "Chart" => FillChart(root, props, children, data, query),
            _ => FillRows(root, props, children, data),
        };
    }

    private static Dictionary<string, string> ParamsOf(JsonElement bind)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!bind.TryGetProperty("params", out var ps) || ps.ValueKind != JsonValueKind.Object) return values;
        foreach (var p in ps.EnumerateObject())
            values[p.Name] = p.Value.ValueKind switch
            {
                JsonValueKind.String => p.Value.GetString() ?? "",
                JsonValueKind.True => "true",
                JsonValueKind.False => "false",
                _ => p.Value.ToString(),
            };
        return values;
    }

    private static UiNode FillRows(UiNode root, Dictionary<string, JsonElement> props, List<UiNode> children, UiData data)
    {
        props["rows"] = Json(data.Rows.Select(r => r.ToArray()).ToArray());
        if (data.Truncated) props["caption"] = Json(Caption(props, $"还有更多,这里只显示 {data.Rows.Count} 条 · there is more — showing {data.Rows.Count}"));
        return root with { Props = props, Children = children };
    }

    /// <summary>A chart plots pairs, so a row set becomes label(col 0) + value(col 1). A non-numeric
    /// value column is a real mismatch between the page and the query it named — shown, not coerced
    /// to zero, because a bar of height zero is a claim about the household's money.</summary>
    private static UiNode FillChart(UiNode root, Dictionary<string, JsonElement> props, List<UiNode> children, UiData data, string query)
    {
        var labels = new List<string>();
        var values = new List<double>();
        foreach (var row in data.Rows)
        {
            if (row.Count < 2) return Unavailable(query, "returns no value column to plot");
            if (!double.TryParse(row[1], NumberStyles.Any, CultureInfo.InvariantCulture, out var n))
                return Unavailable(query, $"returned a non-numeric value ({Trim(row[1])})");
            labels.Add(row[0]);
            values.Add(n);
        }
        props["labels"] = Json(labels);
        props["values"] = Json(values);
        if (data.Truncated) props["caption"] = Json(Caption(props, $"还有更多,这里只显示 {data.Rows.Count} 条 · there is more — showing {data.Rows.Count}"));
        return root with { Props = props, Children = children };
    }

    private static string Caption(Dictionary<string, JsonElement> props, string note) =>
        props.TryGetValue("caption", out var c) && c.ValueKind == JsonValueKind.String && c.GetString() is { Length: > 0 } existing
            ? $"{existing} — {note}"
            : note;

    private static string Trim(string s) => s.Length <= 40 ? s : s[..40];

    /// <summary>The visible stand-in for data that could not be read. A plain warning-toned Text, so
    /// this needs no component of its own and cannot itself fail to render.</summary>
    private static UiNode Unavailable(string query, string why) => new()
    {
        Type = "Text",
        Props = new(StringComparer.Ordinal)
        {
            ["text"] = Json($"数据暂时不可用 · data unavailable — “{query}” {why}"),
            ["tone"] = Json("warning"),
        },
    };

    private static JsonElement Json<T>(T value) =>
        JsonSerializer.SerializeToElement(value);
}
