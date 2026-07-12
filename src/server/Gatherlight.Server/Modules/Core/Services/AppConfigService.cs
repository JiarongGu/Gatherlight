using Dapper;

namespace Gatherlight.Server.Modules.Core.Services;

/// <summary>
/// Dynamic key→value configuration in the <c>app_config</c> table — prompt template overrides
/// (<c>cortex.prompt.{name}</c>), per-consumer model routing (<c>llm.model.{consumer}</c>),
/// timeouts, feature flags. No migration needed for a new key; absent key = caller's default.
/// </summary>
public interface IAppConfigService
{
    string? Get(string key);
    T Get<T>(string key, T fallback) where T : IParsable<T>;
    void Set(string key, string value);
    void Delete(string key);
}

public sealed class AppConfigService : IAppConfigService
{
    private readonly IDbConnectionFactory _db;

    public AppConfigService(IDbConnectionFactory db) => _db = db;

    public string? Get(string key)
    {
        using var conn = _db.Open();
        return conn.QuerySingleOrDefault<string>("SELECT value FROM app_config WHERE key = @key", new { key });
    }

    public T Get<T>(string key, T fallback) where T : IParsable<T>
    {
        var raw = Get(key);
        return raw is not null && T.TryParse(raw, null, out var parsed) ? parsed : fallback;
    }

    public void Set(string key, string value)
    {
        using var conn = _db.Open();
        conn.Execute(
            "INSERT INTO app_config(key, value) VALUES (@key, @value) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            new { key, value });
    }

    public void Delete(string key)
    {
        using var conn = _db.Open();
        conn.Execute("DELETE FROM app_config WHERE key = @key", new { key });
    }
}
