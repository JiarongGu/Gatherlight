using Gatherlight.Server.Platform.Agent.Ui.Data;

namespace Gatherlight.Server.Platform.Storage.Library.Services;

/// <summary>
/// The knowledge library as a bindable query. Platform, not Planner: the library is domain-neutral
/// machinery (entities, regions, FTS) and the travel flavour lives in the data, not the code.
/// </summary>
public sealed class LibraryUiSource : UiDataSource
{
    private readonly ILibraryRepository _repo;

    public LibraryUiSource(ILibraryRepository repo) => _repo = repo;

    public override string Id => "library";

    public override string Description =>
        "知识库中已验证的条目 · verified entries from the knowledge library, newest first";

    public override IReadOnlyList<string> Columns => ["名称 · Name", "地区 · Region", "简介 · Summary"];

    public override IReadOnlyDictionary<string, UiParamSpec> Params => P(
        ("kind", new UiParamSpec(UiParamKind.String)),
        ("region", new UiParamSpec(UiParamKind.String)),
        ("query", new UiParamSpec(UiParamKind.String)),
        ("limit", new UiParamSpec(UiParamKind.Number)));

    public override async Task<UiData> FetchAsync(UiBindArgs args, CancellationToken ct)
    {
        var limit = Math.Clamp(args.Int("limit", 20), 1, MaxRows);
        // One more than asked for, so Limited can tell "that is all of it" from "there is more".
        var items = await _repo.QueryAsync(args.Str("kind"), args.Str("region"), args.Str("query"), limit + 1);
        return Limited(items
            .Select(i => (IReadOnlyList<string>)new[] { i.Name, i.Region ?? "", i.Summary ?? "" })
            .ToList(), limit);
    }
}
