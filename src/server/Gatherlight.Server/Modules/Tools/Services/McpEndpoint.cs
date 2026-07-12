using System.Text.Json;
using System.Text.Json.Nodes;
using Gatherlight.Server.Modules.Tools.Models;

namespace Gatherlight.Server.Modules.Tools.Services;

/// <summary>
/// Minimal MCP "streamable HTTP" endpoint bridging the tool registry to the spawned claude CLI
/// (configured via state/mcp.chat.json as <c>{"type":"http","url":"http://127.0.0.1:{port}/mcp"}</c>).
/// Hand-rolled JSON-RPC (initialize / tools/list / tools/call) instead of the prerelease MCP SDK —
/// our tools are plain string-returning functions, and plain-JSON responses are within spec for
/// POST when the server chooses not to stream.
/// </summary>
public static class McpEndpoint
{
    public static void Map(WebApplication app)
    {
        // Optional server-initiated stream — we have no server-initiated messages.
        app.MapGet("/mcp", () => Results.StatusCode(StatusCodes.Status405MethodNotAllowed));

        app.MapPost("/mcp", async (HttpContext ctx, IToolRegistry registry) =>
        {
            JsonNode? rpc;
            try
            {
                rpc = await JsonNode.ParseAsync(ctx.Request.Body, cancellationToken: ctx.RequestAborted);
            }
            catch (JsonException)
            {
                return Results.Json(RpcError(null, -32700, "parse error"), statusCode: 400);
            }
            if (rpc is not JsonObject msg) return Results.Json(RpcError(null, -32600, "invalid request"), statusCode: 400);

            var id = msg["id"]?.DeepClone();
            var method = msg["method"]?.GetValue<string>() ?? "";

            // Notifications (no id) need no response body.
            if (id is null) return Results.StatusCode(StatusCodes.Status202Accepted);

            switch (method)
            {
                case "initialize":
                {
                    var requested = msg["params"]?["protocolVersion"]?.GetValue<string>() ?? "2025-03-26";
                    ctx.Response.Headers["Mcp-Session-Id"] = Guid.NewGuid().ToString("N");
                    return Results.Json(RpcResult(id, new JsonObject
                    {
                        ["protocolVersion"] = requested,
                        ["capabilities"] = new JsonObject { ["tools"] = new JsonObject() },
                        ["serverInfo"] = new JsonObject { ["name"] = registry.McpServerName, ["version"] = "1.0" },
                    }));
                }

                case "ping":
                    return Results.Json(RpcResult(id, new JsonObject()));

                case "tools/list":
                {
                    var tools = new JsonArray();
                    foreach (var t in registry.List("mcp"))
                    {
                        tools.Add(new JsonObject
                        {
                            ["name"] = t.Name,
                            ["description"] = t.Description,
                            ["inputSchema"] = JsonNode.Parse(t.InputSchema.GetRawText()),
                        });
                    }
                    return Results.Json(RpcResult(id, new JsonObject { ["tools"] = tools }));
                }

                case "tools/call":
                {
                    var name = msg["params"]?["name"]?.GetValue<string>() ?? "";
                    var argsNode = msg["params"]?["arguments"] ?? new JsonObject();
                    using var argsDoc = JsonDocument.Parse(argsNode.ToJsonString());
                    try
                    {
                        var result = await registry.RunAsync(name, argsDoc.RootElement, "mcp", ctx.RequestAborted);
                        return Results.Json(RpcResult(id, ToolResult(result, isError: false)));
                    }
                    catch (ToolException ex)
                    {
                        // Tool-level failures are results with isError (per MCP), not protocol errors.
                        return Results.Json(RpcResult(id, ToolResult(ex.Message, isError: true)));
                    }
                }

                default:
                    return Results.Json(RpcError(id, -32601, $"method not found: {method}"));
            }
        });
    }

    private static JsonObject ToolResult(string text, bool isError) => new()
    {
        ["content"] = new JsonArray { new JsonObject { ["type"] = "text", ["text"] = text } },
        ["isError"] = isError,
    };

    private static JsonObject RpcResult(JsonNode? id, JsonNode result) => new()
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id?.DeepClone(),
        ["result"] = result,
    };

    private static JsonObject RpcError(JsonNode? id, int code, string message) => new()
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id?.DeepClone(),
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    };
}
