using System.Data;
using Dapper;
using Microsoft.Data.Sqlite;

namespace Gatherlight.Server.Modules.Core.Services;

public interface IDbConnectionFactory
{
    /// <summary>Open a pooled connection. Caller disposes (use <c>using</c>).</summary>
    IDbConnection Open();
}

/// <summary>
/// SQLite via Microsoft.Data.Sqlite + Dapper. WAL journal so web reads and background writes
/// don't block each other; snake_case columns map onto PascalCase model properties. Private
/// cache (the default): with WAL, private-cache connections read in parallel — shared-cache
/// would serialize concurrent readers with table-level locks.
/// </summary>
public sealed class SqliteConnectionFactory : IDbConnectionFactory
{
    private readonly string _connectionString;

    static SqliteConnectionFactory()
    {
        DefaultTypeMap.MatchNamesWithUnderscores = true;
    }

    public SqliteConnectionFactory(IDataContext data)
    {
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = data.DatabasePath,
        }.ToString();
    }

    public IDbConnection Open()
    {
        var conn = new SqliteConnection(_connectionString);
        conn.Open();
        conn.Execute("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
        return conn;
    }
}
