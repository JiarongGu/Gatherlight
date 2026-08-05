# The agent's own MCP channel — design

> 2026-08-06 · a correctness sub-project. Fixes a live defect and adopts Lyntai 2.4.0's
> `AgentSessionOptions.McpServers` (CLI14) in the same move, because the defect is caused by the
> wiring that feature replaces.

## Why

The jailed agent reaches the app's tools over HTTP: `ChatEnvironmentService` writes
`{data}/state/mcp.chat.json` naming `http://127.0.0.1:{port}/mcp`, and that file is handed to the
CLI as `ClaudeAgentOptions.McpConfigPath`.

That URL points at the app's **public, network-facing listener** — so the agent's tool channel
inherits whatever TLS and authentication the household configured for **remote humans**, neither of
which a child process on the same machine has any way to satisfy.

Both failure modes were reproduced on 2026-08-06 against a real server:

| Configuration | Handed to the agent | Result |
|---|---|---|
| `security.tls.enabled: true` | `http://127.0.0.1:5495/mcp` | connection fails (curl 52 — plain HTTP against a TLS socket). The same endpoint over `https` returns 200. |
| `security.trustLoopback: false` | `http://127.0.0.1:5496/mcp` | **401**. The same call carrying the token returns 200. |

The generated file is byte-identical in both: hardcoded `http://`, no token.

**The failure is silent in the worst way.** The CLI does not surface "your MCP server refused me" to
the model — the server simply contributes no tools. The agent then reports the tool *missing* rather
than *broken*, which is exactly the "`tools/pdf-form`(或其 MCP 端 `fill_itinerary`)在当前环境缺失"
message that opened this whole line of work. That report had a second, real cause — nothing under
`tools/` was packed into the bundle, fixed separately — but this path produces the identical wording
and is still live for anyone who enables TLS or runs behind a same-host proxy.

## The governing idea

**Exposure settings describe how remote humans reach the app. They have nothing to say about a child
process on the same machine.** Conflating the two is the bug: the agent is not a remote client, and
making it satisfy a remote client's controls means either weakening those controls or breaking the
agent. Give the agent its own channel and the question disappears.

## Goals

1. The agent's tools work regardless of TLS, access token, bind address, or `trustLoopback`.
2. Turning on a security control never silently removes the agent's capabilities.
3. The internal channel does not become a hole in the controls it bypasses.
4. The agent's MCP wiring stops being claude-only.
5. A regression in any of this fails a test, in the configurations that actually break today.

## Non-goals

| Deferred | What |
|---|---|
| Later | stdio transport for the app's own tools. `AgentMcpServer` supports it, but our tools live in-process with DB and registry access — a stdio child would have to reach back into the server, which is a bigger design than this fix. |
| Later | Swapping `ClaudeAgentSession` for another backend. This removes a claude-only coupling; actually running codex is its own decision. |
| Out | Making the agent satisfy the public listener's TLS/token. That is the wrong shape — see the governing idea. |

## The internal listener

A **second Kestrel endpoint**, bound to `127.0.0.1:0` — plain HTTP, ephemeral port, alongside
whatever the public endpoint is doing. The OS assigns the port; the app reads it back from
`IServerAddressesFeature` after start and exposes it through a small
`IInternalMcpEndpoint { int Port; string Token; }`.

**Never TLS.** That is the point: the channel is a loopback socket, not a network hop, and a
self-signed certificate is an obstacle for the CLI's MCP client with nothing to gain.

**Three restrictions keep it from becoming a hole:**

1. **Only `/mcp`.** A request arriving on the internal port with any other path gets 404 — it is not
   a second door into `/api`. This matters most for the `trustLoopback: false` case: that setting
   exists because a same-host proxy can make remote requests look local, and an ungated internal
   port serving `/api` would reopen precisely the hole the setting closes.
2. **A per-start bearer token.** Generated fresh each server start, held in memory, never persisted.
   Another process on the box cannot call the channel without it. Passed as `AgentMcpServer.AuthToken`
   — which Lyntai 2.4.0 guarantees never reaches argv.
3. **Loopback only.** Bound to `127.0.0.1`, so it is unreachable off-box by construction rather than
   by policy.

Requests are distinguished by `context.Connection.LocalPort`, which is not client-controllable.

## Pointing the agent at it

`AgentSessionOptions.McpServers` (Lyntai 2.4.0, neutral `Lyntai.Core`) replaces
`ClaudeAgentOptions.McpConfigPath`:

```csharp
McpServers = [ new AgentMcpServer(
    Name: "planner-tools",
    Transport: McpTransport.Http,
    Url: $"http://127.0.0.1:{_internalMcp.Port}/mcp",
    AuthToken: _internalMcp.Token) ],
```

Built **per run**, at spawn time, from the live port — so there is no generated file, no startup
ordering problem, and nothing on disk to go stale. The claude adapter renders an owner-only
`--mcp-config` document and deletes it when the turn ends; a codex adapter would render its own TOML
overrides. Naming a server does not pre-approve its tools, so the existing
`AllowedTools = _tools.McpAllowedToolNames()` pre-approval stays exactly as it is.

**`ChatEnvironmentService.McpConfigPath` and the `state/mcp.chat.json` it writes are deleted.** A
file that no longer configures anything is worse than no file: the next person to debug this will
read it and believe it.

## What this does not change

The scope guard, the settings allow-list, the two-gate flow, and `/mcp` on the public listener (the
console and any external client keep using it, gated as before) are untouched. The judges' separate
per-call MCP host — Lyntai's `AddMcpToolHost`, which reaches only the one-shot `ILlmClient` path — is
also untouched; it was never part of this channel.

## Testing

The suites that exist today all run the default configuration, which is exactly why this survived.
The new coverage is **the two configurations that break**, in a new `p44`:

| Case | Expected |
|---|---|
| Default config: agent MCP call | tools returned — the positive control |
| `security.tls.enabled: true`: agent MCP call | tools returned (today: connection refused) |
| `security.trustLoopback: false` + token: agent MCP call | tools returned (today: 401) |
| Same three, `tools/list` contents | the registry's tool names, not an empty list — an empty list is the silent failure, so asserting "no error" is not enough |
| Internal port, path `/api/health` | 404 — not a second door |
| Internal port, `/mcp` without the token | 401 |
| Public port, `/mcp` | unchanged: gated exactly as before |
| `state/mcp.chat.json` | absent — the file is gone, not merely unused |

**Asserting the tool list, not just a 200, is the load-bearing part.** The bug being fixed is a
server that answers politely with nothing.

## File structure

| File | Change |
|---|---|
| `Platform/Hosting/Security/Services/InternalMcpEndpoint.cs` (new) | the port + per-start token |
| `Gatherlight.Server/GatherlightApp.cs` | the second Kestrel endpoint; read the bound port after start |
| `Platform/Hosting/Security/AccessGateMiddleware.cs` | internal port → `/mcp` only, token-checked, public rules unchanged |
| `Platform/Agent/Chat/Services/ChatSessionService.cs` | `McpServers` instead of `McpConfigPath` |
| `Platform/Agent/Chat/Services/ChatEnvironmentService.cs` | delete `McpConfigPath` and the generated file |

## Success criteria

1. With TLS on, the agent lists the registry's tools.
2. With `trustLoopback: false`, the agent lists the registry's tools.
3. The internal port serves `/mcp` and nothing else, and refuses a call with no token.
4. `state/mcp.chat.json` no longer exists, and nothing references it.
5. `p44` passes, and the full suite stays green.
