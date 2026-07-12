using Dapper;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.DataRepo.Services;

/// <summary>Audit index over the data repo's commits (kind: chat / fs-op / seed / import).</summary>
public interface IDataCommitRepository
{
    void Record(string sha, string message, string kind, string? sessionId = null);
    List<DataCommitRow> Recent(int count = 50);
}

public sealed record DataCommitRow(string Sha, string Message, string? SessionId, string Kind, string CreatedAt);

public sealed class DataCommitRepository : IDataCommitRepository
{
    private readonly IDbConnectionFactory _db;

    public DataCommitRepository(IDbConnectionFactory db) => _db = db;

    public void Record(string sha, string message, string kind, string? sessionId = null)
    {
        using var conn = _db.Open();
        conn.Execute(
            "INSERT INTO data_commit(sha, message, session_id, kind, created_at) " +
            "VALUES (@sha, @message, @sessionId, @kind, @now) " +
            "ON CONFLICT(sha) DO NOTHING",
            new { sha, message, sessionId, kind, now = DateTime.UtcNow.ToString("o") });
    }

    public List<DataCommitRow> Recent(int count = 50)
    {
        using var conn = _db.Open();
        return conn.Query<DataCommitRow>(
            "SELECT sha, message, session_id, kind, created_at FROM data_commit " +
            "ORDER BY created_at DESC LIMIT @count", new { count }).ToList();
    }
}
