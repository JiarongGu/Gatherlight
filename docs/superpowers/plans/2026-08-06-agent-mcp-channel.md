# The agent's own MCP channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the jailed agent's tools work regardless of TLS, access token or `trustLoopback`, by giving it a loopback-only MCP channel of its own instead of routing it through the app's public listener.

**Architecture:** A second Kestrel endpoint on `127.0.0.1:0` (plain HTTP, ephemeral port) serves `/mcp` and nothing else, behind a per-start bearer token held only in memory. `AgentSessionOptions.McpServers` (Lyntai 2.4.0) points the agent at it per run, replacing the generated `state/mcp.chat.json` and `ClaudeAgentOptions.McpConfigPath`.

**Tech Stack:** ASP.NET Core net10.0, Kestrel multi-endpoint binding, Lyntai 2.4.0 `Lyntai.Agents`, node e2e suites.

**Spec:** `docs/superpowers/specs/2026-08-06-agent-mcp-channel-design.md`

---

## Before you start

**The defect, reproduced on 2026-08-06 — read this so you know what "working" means:**

| Configuration | Handed to the agent | Result |
|---|---|---|
| `security.tls.enabled: true` | `http://127.0.0.1:{port}/mcp` | connection fails (plain HTTP against a TLS socket) |
| `security.trustLoopback: false` | same | 401 |

Neither surfaces to the model — the CLI just contributes no tools, so the agent reports the tool
**missing**. Asserting a 200 is therefore not enough anywhere in this work: **assert the tool list**.

**Read these first:**

- `src/server/Gatherlight.Server/GatherlightApp.cs:51-56` — the public listener: `UseUrls` when no cert, `ConfigureKestrel` + `UseHttps` when there is one. The internal endpoint must be added in **both** branches.
- `src/server/Gatherlight.Platform/Hosting/Security/AccessGateMiddleware.cs` — note it early-returns when `!_guard.Enabled`. The internal-port rules must sit **before** that return, or a token-less install serves `/api` on the internal port.
- `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatSessionService.cs:468-470` — `McpConfigPath` + `AllowedTools`.
- `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatEnvironmentService.cs` — `McpConfigPath` and the `state/mcp.chat.json` writer, both of which this plan deletes.

**Lyntai 2.4.0 API (verified in source, use exactly this):**

```csharp
// Lyntai.Agents
AgentMcpServer.Http(string name, string url, string? authToken = null)
AgentSessionOptions.McpServers  // IReadOnlyList<AgentMcpServer>, defaults to []
```

`Name` is restricted to letters, digits, `_` and `-`; an adapter refuses anything else. `AuthToken`
never reaches argv — the claude adapter writes it to an owner-only temp file deleted at turn end.
Naming a server does **not** pre-approve its tools, so `AllowedTools` stays exactly as it is.

```bash
cd D:/Development/Games/Gatherlight
git checkout -b fix/agent-mcp-channel
```

Per-task commits. Do not push. Do not run `e2e all` from a subagent.

---

### Task 1: The internal endpoint

**Files:**
- Create: `src/server/Gatherlight.Platform/Hosting/Security/Services/InternalMcpEndpoint.cs`
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs`

- [ ] **Step 1: The service**

```csharp
using System.Security.Cryptography;

namespace Gatherlight.Server.Platform.Hosting.Security.Services;

/// <summary>
/// The agent's own way in. The app's public listener carries whatever TLS and authentication the
/// household configured for REMOTE HUMANS — controls a child process on this machine has no way to
/// satisfy, and whose failure the CLI does not surface (the server simply contributes no tools, and
/// the agent reports them missing). So the agent gets a loopback-only, plain-HTTP endpoint instead.
///
/// It is not a hole in the controls it bypasses: it serves ONLY /mcp, requires a bearer token
/// generated fresh each start and never persisted, and is bound to 127.0.0.1 so it is unreachable
/// off-box by construction rather than by policy.
/// </summary>
public interface IInternalMcpEndpoint
{
    /// <summary>The bound port, or 0 before the server has started.</summary>
    int Port { get; }
    string Token { get; }
    string Url { get; }
    void Bound(int port);
}

public sealed class InternalMcpEndpoint : IInternalMcpEndpoint
{
    public int Port { get; private set; }
    // In memory only. Nothing on disk to leak, go stale, or be read by the next process.
    public string Token { get; } = Convert.ToHexString(RandomNumberGenerator.GetBytes(24));
    public string Url => $"http://127.0.0.1:{Port}/mcp";
    public void Bound(int port) => Port = port;
}
```

- [ ] **Step 2: Bind it**

In `GatherlightApp.cs`, replace the listener block so the internal endpoint is added in **both**
branches:

```csharp
        var cert = Platform.Hosting.Security.Services.TlsCertificate.Resolve(options);
        // The agent's channel is a SECOND endpoint: loopback, plain HTTP, ephemeral port. Never TLS —
        // it is a loopback socket, not a network hop, and a self-signed cert is an obstacle to the
        // CLI's MCP client with nothing to gain. Added in both branches: the TLS case is precisely
        // the one where routing the agent through the public listener breaks.
        builder.WebHost.ConfigureKestrel(k =>
        {
            if (cert is null) k.Listen(ParseBindAddress(options.BindAddress), options.Port);
            else k.Listen(ParseBindAddress(options.BindAddress), options.Port, lo => lo.UseHttps(cert));
            k.ListenLocalhost(0);
        });
```

and delete the `builder.WebHost.UseUrls(...)` line — `UseUrls` and `ConfigureKestrel` listeners do
not compose, and leaving both means the public endpoint is bound twice or not as intended.

- [ ] **Step 3: Read the bound port**

`ListenLocalhost(0)` lets the OS choose, so the port is only known after start. In the
`ApplicationStarted` hook that already exists for the migration runner, add — before it:

```csharp
        // The ephemeral port is only known once Kestrel has bound. Everything that needs it (the
        // access gate, the agent's session options) reads it from IInternalMcpEndpoint, so nothing
        // captures it at build time.
        life.ApplicationStarted.Register(() =>
        {
            var addresses = app.Services.GetRequiredService<IServer>()
                .Features.Get<IServerAddressesFeature>()?.Addresses ?? [];
            var internalUrl = addresses.FirstOrDefault(a =>
                a.StartsWith("http://127.0.0.1:", StringComparison.Ordinal)
                && !a.EndsWith($":{options.Port}", StringComparison.Ordinal));
            if (internalUrl is not null && Uri.TryCreate(internalUrl, UriKind.Absolute, out var uri))
            {
                app.Services.GetRequiredService<IInternalMcpEndpoint>().Bound(uri.Port);
                app.Logger.LogInformation("Agent MCP channel on loopback port {Port}", uri.Port);
            }
            else
            {
                app.Logger.LogError(
                    "Agent MCP channel did not bind — the agent will have no server tools. Addresses: {Addr}",
                    string.Join(", ", addresses));
            }
        });
```

with `using Microsoft.AspNetCore.Hosting.Server;` and
`using Microsoft.AspNetCore.Hosting.Server.Features;`.

**The `else` branch matters.** A silent failure here reproduces the exact bug being fixed — no tools,
no explanation — so it must be loud in the log.

- [ ] **Step 4: Register it**

In the DI block, as a singleton (one token per process):

```csharp
            .AddSingleton<IInternalMcpEndpoint, InternalMcpEndpoint>()
```

- [ ] **Step 5: Build and see it bind**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
```

Start the server against a scratch data folder under `devtools/_*` (**never `local/`**) and confirm
the log line `Agent MCP channel on loopback port <n>` appears with a non-zero port, and that the
public port still answers `/api/health`. Stop it and delete the folder.

- [ ] **Step 6: Commit**

```bash
git add src/server
git commit -m "feat(agent): a loopback-only endpoint for the agent's tools

The public listener carries TLS and authentication meant for remote humans —
controls a child process on this machine cannot satisfy, and whose failure the
CLI never surfaces. The agent gets its own endpoint instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Restrict it, and prove the restrictions

**Files:**
- Modify: `src/server/Gatherlight.Platform/Hosting/Security/AccessGateMiddleware.cs`
- Create: `devtools/scripts/e2e/p44.mjs`

- [ ] **Step 1: The internal-port rules**

In `AccessGateMiddleware.Invoke`, **before** the `if (!_guard.Enabled)` early return:

```csharp
        // The agent's channel. Placed ahead of the Enabled check on purpose: when no token is
        // configured the public gate is off entirely, and an unrestricted internal port would then
        // serve /api too. Requests are told apart by the LOCAL port, which no client controls.
        if (_internal.Port != 0 && ctx.Connection.LocalPort == _internal.Port)
        {
            // Only /mcp. This is not a second door into /api — which matters most when
            // trustLoopback is false, a setting that exists because a same-host proxy can make
            // remote requests look local.
            if (!ctx.Request.Path.StartsWithSegments("/mcp"))
            {
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }
            var presented = ctx.Request.Headers.Authorization.ToString();
            var expected = "Bearer " + _internal.Token;
            if (!CryptographicOperations.FixedTimeEquals(
                    System.Text.Encoding.UTF8.GetBytes(presented),
                    System.Text.Encoding.UTF8.GetBytes(expected)))
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                return;
            }
            await _next(ctx);
            return;
        }
```

`FixedTimeEquals` throws on length mismatch in some overloads — use the byte-array overload, which
returns false for different lengths, and confirm that by testing a short wrong token in Step 3.

Inject `IInternalMcpEndpoint _internal` into the middleware constructor and add
`using System.Security.Cryptography;`.

- [ ] **Step 2: The suite**

Create `devtools/scripts/e2e/p44.mjs`:

```javascript
#!/usr/bin/env node
// e2e P44 — the agent's own MCP channel. The bug this covers is a server that answers politely with
// NOTHING: with TLS on, or trustLoopback off, the agent's MCP connection failed and the CLI simply
// contributed no tools, so the agent reported them missing. Every row therefore asserts the TOOL
// LIST, never merely a 200.
import fs from 'node:fs';
import path from 'node:path';
import {
  dataDirFor, makeReporter, makeTestData, startServer, waitHealthy, makeClient, claudeStubCmd, until,
} from './_e2e-common.mjs';

const dataDir = dataDirFor('p44');
const { ok, fail, done } = makeReporter('p44');
makeTestData(dataDir);

// Free port — suites use up to 5486 (p42); this one is clear.
const PORT = 5488;

const settingsPath = path.join(dataDir, 'state', 'settings.json');
const writeSettings = (security) => {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ security }, null, 2), 'utf8');
};

// The channel's port + token are in memory; the server reports them on /api/manage/agent-mcp
// (added in Step 4 below) so a test can reach the same endpoint the agent is handed.
const toolNames = async (base, scheme, token, headers = {}) => {
  const res = await fetch(`${scheme}://127.0.0.1:${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  if (!res.ok) return { status: res.status, names: [] };
  const body = await res.json();
  return { status: res.status, names: (body?.result?.tools ?? []).map((t) => t.name) };
};

let server = null;
try {
  // --- 1. default config: the positive control -----------------------------------------------
  writeSettings({});
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  const base = server.base ?? `http://127.0.0.1:${PORT}`;
  const { j } = makeClient(base);
  await waitHealthy(base);

  const ch = (await j('/api/manage/agent-mcp')).body;
  ok('the channel reports a bound port', (ch?.port ?? 0) > 0, JSON.stringify(ch));
  ok('the channel port is not the public port', ch?.port !== PORT, String(ch?.port));

  const def = await toolNames(ch.port, 'http', ch.token);
  ok('default config: the agent channel lists tools', def.names.length > 0, JSON.stringify(def));

  // The restrictions.
  const noTok = await fetch(`http://127.0.0.1:${ch.port}/mcp`, { method: 'POST' });
  ok('the channel refuses a call with no token', noTok.status === 401, String(noTok.status));
  const badTok = await toolNames(ch.port, 'http', 'x');
  ok('the channel refuses a SHORT wrong token (no length-mismatch throw)', badTok.status === 401, String(badTok.status));
  const apiOnChannel = await fetch(`http://127.0.0.1:${ch.port}/api/health`);
  ok('the channel is not a second door into /api', apiOnChannel.status === 404, String(apiOnChannel.status));

  ok('the generated mcp.chat.json is gone', !fs.existsSync(path.join(dataDir, 'state', 'mcp.chat.json')));
  server.stop();

  // --- 2. TLS on — the first configuration that broke -----------------------------------------
  writeSettings({ tls: { enabled: true } });
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await until(async () => {
    try { return (await fetch(`https://127.0.0.1:${PORT}/api/health`)).ok; } catch { return false; }
  }, 60000);
  const tlsCh = await (await fetch(`https://127.0.0.1:${PORT}/api/manage/agent-mcp`)).json();
  const withTls = await toolNames(tlsCh.port, 'http', tlsCh.token);
  ok('TLS on: the agent channel still lists tools', withTls.names.length > 0, JSON.stringify(withTls));
  ok('TLS on: the channel is plain http, not https', tlsCh.url.startsWith('http://'), tlsCh.url ?? '');
  server.stop();

  // --- 3. trustLoopback off — the second ------------------------------------------------------
  writeSettings({ accessToken: 'p44-token', trustLoopback: false });
  server = startServer({ dataDir, port: PORT, env: { GATHERLIGHT_CLAUDE_CMD: claudeStubCmd } });
  await until(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: { 'X-Gatherlight-Token': 'p44-token' } });
      return r.ok && (await r.json())?.migrating === false;
    } catch { return false; }
  }, 60000);
  const gatedCh = await (await fetch(`http://127.0.0.1:${PORT}/api/manage/agent-mcp`,
    { headers: { 'X-Gatherlight-Token': 'p44-token' } })).json();
  const withGate = await toolNames(gatedCh.port, 'http', gatedCh.token);
  ok('trustLoopback off: the agent channel still lists tools', withGate.names.length > 0, JSON.stringify(withGate));
  // The public /mcp stays gated exactly as before — the channel does not weaken it.
  const publicMcp = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST' });
  ok('the PUBLIC /mcp is still gated', publicMcp.status === 401, String(publicMcp.status));
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  server?.stop();
}

done();
```

Node rejects a self-signed certificate, so the TLS section needs
`process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` set at the top of the file with a comment saying
why (a test talking to the app's own generated cert). Do not disable it for the whole runner — only
this suite.

- [ ] **Step 3: Run it and watch it fail**

```bash
node devtools/dev.mjs e2e p44
```
Expected: **FAIL** — `/api/manage/agent-mcp` does not exist yet.

- [ ] **Step 4: The diagnostic route**

The port and token are in memory by design, and a test (and a human debugging "why does the agent
say the tool is missing") needs to see them. Add to the management controller — find the file that
serves the other `/api/manage/*` routes and follow its shape:

```csharp
    /// <summary>The agent's MCP channel, for diagnosis: this is exactly what the spawned CLI is
    /// handed. "The agent says the tool is missing" is otherwise unanswerable from outside the
    /// process, because the port and token are deliberately in memory only. The token is regenerated
    /// every start and the endpoint is loopback-only, so surfacing it on the already-gated management
    /// surface tells an operator what they need without widening anything.</summary>
    [HttpGet("api/manage/agent-mcp")]
    public IActionResult AgentMcp() =>
        Ok(new { port = _internalMcp.Port, url = _internalMcp.Url, token = _internalMcp.Token });
```

- [ ] **Step 5: Build and pass**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p44
```

**Every row in this suite must pass at this task**, including the TLS and trustLoopback ones. They
exercise the *channel*, not the agent, and the channel's whole purpose is to be independent of the
public listener — so if either fails here, that independence does not hold. Fix it now rather than
deferring to Task 3, which only changes who points at the channel.

- [ ] **Step 6: Commit**

```bash
git add src/server devtools/scripts/e2e/p44.mjs
git commit -m "feat(agent): restrict the channel, and cover the configs that broke

/mcp only, bearer-gated, loopback-only — the restrictions sit ahead of the public
gate's Enabled check, because a token-less install turns that gate off entirely
and an unrestricted internal port would then serve /api. The suite asserts the
TOOL LIST in each configuration: the bug was a server answering politely with
nothing.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Point the agent at it, and delete the old wiring

**Files:**
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatSessionService.cs`
- Modify: `src/server/Gatherlight.Platform/Agent/Chat/Services/ChatEnvironmentService.cs`
- Modify: `devtools/scripts/e2e/p44.mjs`

- [ ] **Step 1: Swap the wiring**

In `ChatSessionService.cs`, replace the `McpConfigPath` line:

```csharp
        // The agent's tools come from the loopback channel, not the public listener — so they work
        // whatever TLS/token/bind the household configured. Built per run from the live port: no
        // generated file, nothing on disk to go stale. Naming a server does not pre-approve its
        // tools, so AllowedTools below still does that job.
        McpServers = _internalMcp.Port == 0
            ? []
            : [Lyntai.Agents.AgentMcpServer.Http("planner-tools", _internalMcp.Url, _internalMcp.Token)],
        AllowedTools = _tools.McpAllowedToolNames() is { Length: > 0 } names ? names : Array.Empty<string>(),
```

Inject `IInternalMcpEndpoint _internalMcp`. The server name **must** stay `planner-tools`:
`ToolRegistry.McpServerName` is `"planner-tools"` and `McpAllowedToolNames()` builds
`mcp__planner-tools__<tool>` from it, so a different name here silently un-approves every tool.

- [ ] **Step 2: Delete the generated file**

In `ChatEnvironmentService.cs`, remove `McpConfigPath` (the property) and the `File.WriteAllText`
that produces `state/mcp.chat.json`. Then find every reference:

```bash
grep -rn "McpConfigPath\|mcp.chat.json" --include=*.cs --include=*.mjs --include=*.md src/ devtools/ docs/ .claude/
```

Fix each. **A stale file left on disk is worse than none** — the next person to debug this will read
it and believe it — so also delete it from existing data folders: add a line to the startup step that
already re-issues app-managed files (`ChatEnvironmentService.EnsureFiles`) that removes
`state/mcp.chat.json` if present.

- [ ] **Step 3: Prove the agent actually gets tools**

The rows so far test the channel. This one tests the **agent**: drive a turn through the stub and
have it report what MCP servers its config named. In `devtools/scripts/claude-stub.mjs`, beside the
other trigger checks and after the `SCORING TASK` branch:

```javascript
// Reports what the SERVER wired up for MCP. The agent losing its tools is silent — the CLI just
// contributes none — so a test has to look at the config the CLI was actually handed.
if (uiRequest.includes('MCP_ECHO')) {
  const cfgArg = args[args.indexOf('--mcp-config') + 1];
  let named = 'NO_MCP_CONFIG';
  if (args.includes('--mcp-config') && cfgArg) {
    try {
      const doc = cfgArg.trim().startsWith('{') ? JSON.parse(cfgArg) : JSON.parse(fs.readFileSync(cfgArg, 'utf8'));
      named = 'MCP_SERVERS:' + Object.keys(doc.mcpServers ?? {}).join(',');
    } catch (e) { named = 'MCP_CONFIG_UNREADABLE'; }
  }
  done(`计划:${named}`);
  process.exit(0);
}
```

The claude adapter may pass `--mcp-config` a **file path or a JSON string** — handle both, as above.

Then in p44, in the default-config section:

```javascript
  const started = await post('/api/chat', { message: 'MCP_ECHO 看看工具', mode: 'plan' });
  const id = started.body?.id;
  await until(async () => {
    const p = (await j(`/api/chat/${id}`)).body?.phase;
    return p && p !== 'idle' && p !== 'planning';
  }, 60000);
  const plan = (await j(`/api/chat/${id}`)).body?.plan ?? '';
  ok('the spawned agent is given the planner-tools server',
    /MCP_SERVERS:[^\n]*planner-tools/.test(plan), plan.slice(0, 160));
  await post(`/api/chat/${id}/cancel`);
```

Add `post` to the `makeClient` destructure.

- [ ] **Step 4: Build and run**

```bash
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
node devtools/dev.mjs e2e p44
node devtools/dev.mjs e2e p36
node devtools/dev.mjs e2e p31
```

`p36` covers the judges' separate MCP host (untouched, but adjacent) and `p31` the MCP client —
both are the suites most likely to notice a wiring change.

- [ ] **Step 5: Commit**

```bash
git add src/server devtools/scripts
git commit -m "feat(agent): the agent's MCP comes from the channel, not the public listener

Replaces ClaudeAgentOptions.McpConfigPath and the generated state/mcp.chat.json
with Lyntai 2.4.0's neutral AgentSessionOptions.McpServers, built per run from
the live loopback port. The generated file is deleted from existing data folders
too: one that no longer configures anything is worse than none.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Close out

**Files:** `.claude/rules/dev-conventions.md`, `CLAUDE.md`

- [ ] **Step 1: Document it**

Replace the sentence in `.claude/rules/dev-conventions.md` that describes the agent's MCP as "the
CLI's mcp-config flag pointed at this server's own persistent `/mcp`" — it is now false. Say instead:

```markdown
  The agent's own tools come from a **loopback-only channel**, not the public listener: a second
  Kestrel endpoint on `127.0.0.1:0`, plain HTTP, serving `/mcp` only, behind a per-start bearer token
  held in memory. `AgentSessionOptions.McpServers` (Lyntai) points each run at it. This exists because
  the public listener carries TLS and authentication meant for REMOTE HUMANS — with TLS on the agent's
  `http://` connection failed, and with `trustLoopback:false` it got a 401, and in both cases the CLI
  surfaced nothing: the server contributed no tools and the agent reported them **missing**. Exposure
  settings describe how remote humans reach the app; they have nothing to say about a child process on
  the same machine.
```

Update the same claim in `CLAUDE.md` if it appears there (`grep -n "mcp.chat.json\|persistent /mcp" CLAUDE.md`).

- [ ] **Step 2: Full verification**

```bash
node devtools/dev.mjs check-layering
node devtools/dev.mjs check-ui-registry
node devtools/scripts/check-sensitive.mjs --tree
dotnet build src/server/Gatherlight.Platform/Gatherlight.Platform.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Planner/Gatherlight.Planner.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Server/Gatherlight.Server.csproj -v minimal --nologo
dotnet build src/server/Gatherlight.Host/Gatherlight.Host.csproj -v minimal --nologo
node devtools/dev.mjs build
node devtools/dev.mjs e2e p44
```

The coordinator runs `node devtools/dev.mjs e2e all`, expecting `44/44`.

- [ ] **Step 3: Commit**

```bash
git add .claude/rules/dev-conventions.md CLAUDE.md
git commit -m "docs: the agent's tools come from a loopback channel

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Not in scope

- **stdio transport** for the app's own tools — our tools live in-process with DB and registry
  access; a stdio child would have to reach back into the server.
- **Actually running codex.** This removes a claude-only coupling; choosing another backend is its
  own decision.
- **The judges' MCP host** (`AddMcpToolHost`) — a different path, reaching only the one-shot
  `ILlmClient`, and untouched here.
