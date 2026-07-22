# MCP Client (external MCP servers) — design

**Goal:** Let Gatherlight connect *out* to external MCP servers (local `stdio` and remote
`http`/SSE), surface their tools to the planner agent through the existing tool registry, and
let a human **add servers from chat** behind a confirmation gate — with Xiaohongshu (小红书) as the
first real integration.

**Status:** design / in progress (branch `feat/mcp-client`). Built step-by-step, P1 → P3, each
phase landing with its e2e suite.

---

## Why

Today Gatherlight is an MCP **server** only: it exposes its own tools at `/mcp` to the spawned
`claude` CLI (`Modules/Tools/Services/McpEndpoint.cs`, hand-rolled JSON-RPC). It has **no MCP
client** — it can't consume a third-party MCP server. There is already a native `xhs_search`
Playwright tool, but the ecosystem ships richer capabilities as MCP servers (e.g. a Xiaohongshu
MCP). Rather than re-porting each one to C#, we add a general MCP-client subsystem: configure an
external server once, and all of its tools become callable by the agent.

## Core principle — the security boundary

External MCP code runs with **server privileges**, outside the agent's scope-guard jail (it can do
network egress, filesystem access, run arbitrary subprocesses). So **adding/enabling a server is a
privileged action that a human must confirm.** The design keeps the jail intact:

1. **The agent can *propose* a server but never *activate* one.** Adding/enabling a server flows
   through a **chat confirmation gate** (same human-in-the-loop pattern as the plan/diff gates). The
   gate renders the **concrete transport spec from the config to be applied** — the real
   `exe + args + env` or `url` — *not* the agent's free text, so a prompt-injection can propose a
   malicious server but the human sees exactly what will run before approving.
2. **Credentials are server-side only.** Login secrets (e.g. an XHS cookie) are stored in the app
   DB (`state/gatherlight.db`, untracked), never returned to the client in list DTOs, never in the
   agent's read-scope, never echoed into the chat transcript / plan / git.
3. **The agent gets to *call* proxied tools, not manage servers.** No MCP-server CRUD is exposed on
   the agent's MCP surface — only through the access-gated `/api/manage/*` API + the chat gate.

## Architecture

```
                 chat: "add the xiaohongshu MCP …"
                              │
                     ┌────────▼─────────┐   awaiting-mcp-approval gate (human sees exact spec)
                     │ ChatSessionSvc   │──────────────► approve ──┐
                     └──────────────────┘                          │
                                                                   ▼
  McpServerStore (SQLite: mcp_server)  ◄──── persist ──── McpProvisionService
        │  config + secrets + status                              │ add/enable/disable/remove
        ▼                                                         ▼
  McpConnectionManager (IHostedService)  ── connect ──►  external MCP server (stdio | http)
        │  live sessions, initialize + tools/list                 │
        ▼                                                          │ tools/call (forward)
  McpProxyToolProvider.Current : IGatherlightTool[]  ◄────────────┘
        │  one McpProxyTool per discovered tool, name = {serverId}__{tool}
        ▼
  ToolRegistry.Resolve()  ── merges builtins + script tools + external MCP tools ──►  HTTP + /mcp
        │
        ▼
  spawned claude CLI sees mcp__planner-tools__{serverId}__{tool}
```

### Module layout — `Modules/McpClient/`

- `Models/` — `McpServerConfig` (id, name, transport, command/args/env | url/headers, enabled,
  status, lastError, discoveredTools), `McpServerSecret` (server-side only), DTOs (secret-free).
- `Services/McpServerStore.cs` — Dapper repository over the `mcp_server` table (+ secrets).
- `Services/Transport/` — `IMcpClientTransport` with `StdioMcpTransport` and `HttpMcpTransport`
  (Streamable-HTTP/SSE). A minimal JSON-RPC 2.0 client: `initialize`, `tools/list`, `tools/call`.
  Prefer the official `ModelContextProtocol` client SDK if it restores cleanly; else hand-roll
  (consistent with the hand-rolled server endpoint). Decided in P1 by what builds.
- `Services/McpConnectionManager.cs` — `IHostedService`; owns live connections, (re)connects on
  config change, caches discovered tools, tracks per-server status/lastError. Never lets a bad
  server crash the host (mirror `ScriptToolProvider`'s resilience).
- `Services/McpProxyTool.cs` + `McpProxyToolProvider.cs` — `IGatherlightTool` proxy +
  `.Current` provider, wired into `ToolRegistry`.
- `Services/McpProvisionService.cs` — the privileged add/enable/disable/remove operations (called
  by the chat gate and the `/manage` API).
- `McpServersController.cs` — access-gated `/api/manage/mcp-servers` (list/status/toggle/remove;
  **no add** — add is chat-gated).

### Registry integration

`ToolRegistry` currently merges `_builtins` + `IScriptToolProvider.Current`. Add a third source,
`IExternalToolProvider` (implemented by `McpProxyToolProvider`), merged in `Resolve()`. Built-ins
still win on name collision; external tools are namespaced `{serverId}__{tool}` to avoid clashes.
This is the whole reason `Resolve()` is computed at call time — new tools appear without restart.

### Data model — migration `202607220001_McpServers`

`mcp_server`: `id` (text pk), `name`, `transport` (`stdio`|`http`), `command`, `args_json`,
`env_json`, `url`, `headers_json`, `secrets_json` (server-only), `enabled` (int), `status`
(`connected`|`error`|`disabled`), `last_error`, `discovered_tools_json`, `created_at`, `updated_at`.
snake_case columns ↔ PascalCase props (`MatchNamesWithUnderscores`), async Dapper.

### Chat confirmation gate

New phase `awaiting-mcp-approval` (non-terminal), alongside the existing gate phases in
`ChatSessionService`. Entry: the agent emits a structured proposal (a marker convention like the
existing `NEEDS_INPUT:` — e.g. `MCP_ADD:` with name/transport/command/url/env/needsCreds), OR the
user types the request in system-mode. The server parses it into an `McpServerConfig` draft, stores
it as **pending**, and surfaces the gate with the *concrete* spec + (if `needsCreds`) a credentials
field. Approve → `McpProvisionService` persists + connects + reports discovered tools back into the
chat. Reject → discard the draft, nothing runs.

## Phasing

- **P1 — foundation (no UI).** Migration + `McpServerStore`; `stdio` **and** `http` transports;
  `McpConnectionManager`; `McpProxyTool(Provider)`; `ToolRegistry` integration. e2e (`p31`): a stub
  MCP server (a tiny node script speaking JSON-RPC over stdio + an in-proc http one) is registered
  directly in the store; assert its tools appear in `/api/tools` and `/mcp` and round-trip a call.
- **P2 — chat gate + management.** `awaiting-mcp-approval` phase + `MCP_ADD` proposal parsing +
  credentials handling; `McpProvisionService`; `/api/manage/mcp-servers` list/toggle/remove +
  minimal `/manage` console panel; client gate UI (reuse the awaiting-input affordances). e2e
  (`p32`): stubbed chat proposes an add → gate → approve → server connected + tool callable; reject
  → no-op; secrets never surface in list DTOs / transcript.
- **P3 — Xiaohongshu real case.** Register a real Xiaohongshu MCP through the gate, supply login via
  the credentials field, run a **real query against real xiaohongshu.com**, and report the true
  result (including if login-walled). Docs in `docs/TOOLS.md` + the DataTemplate CLAUDE.md tool
  table. If no community MCP works cleanly under our constraints, fall back to extending the native
  `xhs_search` and record why.

## Conventions honored

Modules pattern (controller → service → repository), FluentMigrator `YYYYMMDDNNNN`, async Dapper +
snake_case, DI-collection variation points (the new provider is just another source in
`ToolRegistry`), claude-CLI-only for LLM, BOM-less UTF-8 + `<CodePage>65001</CodePage>`, e2e suite
per phase against isolated `devtools/_e2e-*` folders with the stub CLI. No secrets/paths/family
data in tracked files (`.claude/rules/sensitive-info.md`).

## Risks / open items

- **Preview MCP SDK vs hand-roll** — resolved empirically in P1 by what restores/builds.
- **Remote transport surface** — Streamable HTTP + SSE framing is fiddlier than stdio; P1 covers
  both but the real-case (P3) is stdio (`npx …-mcp`).
- **Secrets at rest** — stored server-side in the untracked DB; at-rest encryption is a future
  hardening, noted not implemented.
- **Xiaohongshu anti-bot / login wall** — the real-case result may be partial; we report honestly
  rather than claim success (per the project's "don't blindly say it works" rule).
