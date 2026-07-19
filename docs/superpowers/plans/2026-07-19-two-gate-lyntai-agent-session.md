# Two-Gate on Lyntai `IAgentSession` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Gatherlight's hand-rolled native `ClaudeCliRunner` with Lyntai's shipped `IAgentSession`/`ClaudeAgentSession` (0.28.5) across every consumer, deleting the native runner entirely (clean base, no compat) — the last blocker before the cortex migration.

**Architecture:** Introduce one app-side adapter — `IAgentRunner` (`Modules/Llm/Services/AgentRunner.cs`) — that drives a Lyntai `IAgentSession.StreamAsync` run and maps each `AgentStreamEvent` to the app's existing `AgentEvent` (the SSE wire shape is unchanged), records written files into `EditTracker`, prices usage via `ModelPricing`, and logs spawn/outcome lines. Every current runner consumer builds a `ClaudeAgentOptions` and calls `_agent.RunAsync(...)`. Because `AgentEvent`, `EditTracker`, `ModelPricing`, the SSE bridge, git stage/diff/commit, and the scope-guard content all stay app-side, consumer churn is confined to constructing options + reading a result record. Cortex (prompts + model routing) is deliberately **out of scope** — prompts still come from `PromptHarness` as plain strings.

**Tech Stack:** net10.0 · C# 13 · Lyntai.Core / Lyntai.Providers.ClaudeCli 0.28.5 (`Lyntai.Agents.IAgentSession`, `AgentStreamEvent`, `Lyntai.Providers.ClaudeCli.ClaudeAgentOptions`/`ClaudeToolCalls`) · e2e suites (`devtools/dev.mjs e2e`) are the per-phase gate (this repo tests via e2e, not server xUnit).

---

## Key facts (verified in code — the contract this plan builds on)

- **Lyntai `IAgentSession.StreamAsync(AgentSessionOptions, ct)`** yields a sealed `AgentStreamEvent` hierarchy: `SessionStarted(SessionId)`, `TextDelta(Text)`, `Thinking(Text)`, `ToolCall(Name, ArgumentsJson, CallId)`, `ToolResult(CallId, Content, IsError)`, `UsageLive(Input, Output, CacheRead)`, `UsageFinal(Input, Output, CacheRead, CacheCreate, Model)`, and exactly one terminal `SessionEnded(Verdict, IsError, Subtype, SessionId, FinalText, Diagnostic)` (synthesized if the stream ends without a `result` line; `Diagnostic` carries the stderr tail / `exit N: …`).
- **`ClaudeAgentOptions : AgentSessionOptions`** fields: `Prompt` (required, over stdin), `WorkingDirectory` (caller-set cwd — the inverse of the provider's neutral cwd), `ToolPolicy` (`AgentToolPolicy.ReadOnly` denies Edit/Write/NotebookEdit; `.Write` adds `--permission-mode acceptEdits`), `DisallowedTools` (always-denied AskUserQuestion/ExitPlanMode/EnterPlanMode are added by the adapter), `Model`, `ResumeToken` (`--resume`), `TimeoutSeconds`, `SettingsPath` (`--settings` scope-guard), `McpConfigPath` (`--mcp-config`), `AllowedTools` (`--allowedTools`).
- **Final text**: Lyntai's reader intentionally **drops full assistant `text` blocks** — final text arrives via `SessionEnded.FinalText` (the `result` line) or accumulated `TextDelta`s (`--include-partial-messages`). The e2e stub (`devtools/scripts/claude-stub.mjs`) emits the text in the `result` line (`done(text)`), so the migrated path sees it.
- **Timeout**: `LyntaiOptions.ProviderTimeout` defaults to **2 min**, `MaxProviderTimeout` to 30 min; `ResolveTimeout(int? seconds)` clamps a per-call value to `MaxProviderTimeout`. The old chat run had **no** timeout → we lift `MaxProviderTimeout` and pass a generous per-call `TimeoutSeconds` so long agentic runs aren't killed.
- **DI**: `AddClaudeCliAgentSession()` registers `IAgentSession` (singleton, honors `CLAUDE_CMD`/`LYNTAI_PROVIDER_CMD`; `GatherlightApp` already bridges `GATHERLIGHT_CLAUDE_CMD` → `CLAUDE_CMD`). `LyntaiBuilder.Configure(Action<LyntaiOptions>)` exists.
- **Consumers of the native runner** (all migrate): `ChatSessionService` (two-gate), `PlaygroundService` (dry plan), `UnattendedRunService` (jobs), `ClaudeValidateService`, `ExtractTool`, `ZhikuMigrator`. `JobHandlers` use `IUnattendedRunService` (unaffected). Kept app-side: `AgentEvent`/`ToolInfo` (`Modules/Llm/Models/AgentEvent.cs`), `EditTracker`, `ModelPricing`.

---

## File Structure

- **Create** `src/server/Gatherlight.Server/Modules/Llm/Services/AgentRunner.cs` — `AgentRunResult`, `IAgentRunner`, `AgentRunner` (the only new seam).
- **Modify** `src/server/Gatherlight.Server/GatherlightApp.cs` — wire `AddClaudeCliAgentSession()` + `Configure` timeout + `IAgentRunner`; (Phase 4) drop `IClaudeCliRunner`.
- **Modify** `Modules/Chat/Services/ChatSessionService.cs` — the two-gate (5 call sites + `BaseRunOptions` + ctor + `DiagnoseFailedRun`).
- **Modify** `Modules/Playground/Services/PlaygroundService.cs`, `Modules/Jobs/Services/UnattendedRunService.cs`, `Modules/Llm/Services/ClaudeValidateService.cs`, `Modules/Tools/Services/Tools/ExtractTool.cs`, `Modules/Seed/Services/ZhikuMigrator.cs`.
- **Delete** `Modules/Llm/Services/ClaudeCliRunner.cs` (ClaudeRunOptions + ClaudeRunResult + IClaudeCliRunner + ClaudeCliRunner).
- **Touch** `Modules/Core/Services/ModelPricing.cs` — doc-comment only.

---

## Phase 0 — Wiring: register the session + the adapter (build stays green; old runner still registered)

### Task 0.1: Create the `AgentRunner` adapter

**Files:**
- Create: `src/server/Gatherlight.Server/Modules/Llm/Services/AgentRunner.cs`

- [ ] **Step 1: Write the file**

```csharp
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Gatherlight.Server.Modules.Core.Services;
using Gatherlight.Server.Modules.Llm.Models;
using Lyntai.Agents;
using Lyntai.Providers.ClaudeCli;

namespace Gatherlight.Server.Modules.Llm.Services;

/// <summary>The outcome of an agent-session run in the app's shape — sourced from Lyntai's terminal
/// <see cref="SessionEnded"/> event. Replaces the retired ClaudeRunResult.</summary>
public sealed record AgentRunResult(string? SessionId, string FinalText, bool IsError, string? Subtype, string? Diagnostic);

/// <summary>
/// Drives ONE Lyntai <see cref="IAgentSession"/> run and adapts it to the app: maps each
/// <see cref="AgentStreamEvent"/> to the app's <see cref="AgentEvent"/> (the SSE wire shape), records the
/// files the agent wrote into an <see cref="EditTracker"/>, prices per-run usage via <see cref="ModelPricing"/>,
/// logs a spawn + outcome line per consumer (label), and returns an <see cref="AgentRunResult"/>. This is the
/// thin app-side replacement for the native ClaudeCliRunner — the CLI-agent loop itself now lives in Lyntai.
/// </summary>
public interface IAgentRunner
{
    Task<AgentRunResult> RunAsync(ClaudeAgentOptions options, string label,
        Action<AgentEvent>? onEvent = null, EditTracker? tracker = null, CancellationToken ct = default);
}

public sealed class AgentRunner : IAgentRunner
{
    private readonly IAgentSession _session;
    private readonly ILogger<AgentRunner> _log;

    public AgentRunner(IAgentSession session, ILogger<AgentRunner> log)
    {
        _session = session;
        _log = log;
    }

    public async Task<AgentRunResult> RunAsync(ClaudeAgentOptions options, string label,
        Action<AgentEvent>? onEvent = null, EditTracker? tracker = null, CancellationToken ct = default)
    {
        var emit = onEvent ?? (_ => { });
        var sw = Stopwatch.StartNew();
        // The one line that makes every LLM call traceable — consumer, cwd, model, policy, flags, prompt
        // SIZE (never content: it may hold family data + rides over stdin). Mirrors the retired runner's
        // spawn line so an instant/empty run stays diagnosable (see the claude-spawn-logging note).
        _log.LogInformation(
            "[{Label}] agent spawn: cwd={Cwd} policy={Policy} model={Model} mcp={Mcp} settings={Set} resume={Res} allowedTools={Tools} promptChars={Len}",
            label, options.WorkingDirectory, options.ToolPolicy, options.Model ?? "(cli-default)",
            !string.IsNullOrEmpty(options.McpConfigPath), !string.IsNullOrEmpty(options.SettingsPath),
            !string.IsNullOrEmpty(options.ResumeToken), options.AllowedTools.Count, options.Prompt.Length);

        string? sessionId = null;
        var finalText = new StringBuilder();
        AgentRunResult? result = null;

        try
        {
            await foreach (var e in _session.StreamAsync(options, ct).ConfigureAwait(false))
            {
                switch (e)
                {
                    case SessionStarted s:
                        sessionId = s.SessionId;
                        emit(new AgentEvent { Kind = "system", SessionId = s.SessionId });
                        break;
                    case TextDelta t:
                        finalText.Append(t.Text);
                        emit(new AgentEvent { Kind = "text-delta", Text = t.Text });
                        break;
                    case Thinking th:
                        emit(new AgentEvent { Kind = "thinking", Text = th.Text });
                        break;
                    case ToolCall tc:
                        var args = ParseArgs(tc.ArgumentsJson);
                        tracker?.Record(tc.Name, First(args, "file_path", "notebook_path", "path"));
                        emit(new AgentEvent { Kind = "tool", Tool = new ToolInfo(tc.Name, ToolDetail(tc.Name, args)) });
                        break;
                    case ToolResult:
                        emit(new AgentEvent { Kind = "tool-result" });
                        break;
                    case UsageLive u:
                        emit(new AgentEvent
                        {
                            Kind = "usage-live",
                            Data = new { inputTokens = u.Input, outputTokens = u.Output, cacheReadTokens = u.CacheRead },
                        });
                        break;
                    case UsageFinal u:
                        emit(new AgentEvent
                        {
                            Kind = "usage",
                            Data = new
                            {
                                inputTokens = u.Input,
                                outputTokens = u.Output,
                                cacheReadTokens = u.CacheRead,
                                cacheCreationTokens = u.CacheCreate,
                                costUsd = ModelPricing.CostUsd(u.Model ?? options.Model, u.Input, u.Output, u.CacheRead, u.CacheCreate),
                            },
                        });
                        break;
                    case SessionEnded end:
                        var text = !string.IsNullOrEmpty(end.FinalText) ? end.FinalText : finalText.ToString();
                        if (end.IsError)
                            emit(new AgentEvent { Kind = "error", Text = string.IsNullOrEmpty(text) ? "claude reported an error" : text });
                        result = new AgentRunResult(end.SessionId ?? sessionId, text, end.IsError, end.Subtype, end.Diagnostic);
                        break;
                }
            }
        }
        catch (OperationCanceledException)
        {
            _log.LogInformation("[{Label}] agent aborted after {Ms}ms", label, sw.ElapsedMilliseconds);
            emit(new AgentEvent { Kind = "notice", Text = "⛔ 正在停止 claude…" });
            throw;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "[{Label}] agent FAILED after {Ms}ms: {Msg}", label, sw.ElapsedMilliseconds, ex.Message);
            throw;
        }

        // Lyntai always yields a terminal SessionEnded (synthesized if the stream ends without a result),
        // so `result` is non-null here; guard defensively.
        result ??= new AgentRunResult(sessionId, finalText.ToString(), IsError: true, Subtype: null,
            Diagnostic: "stream ended without a terminal event");

        if (result.IsError || result.FinalText.Length == 0)
            _log.LogWarning("[{Label}] agent produced no usable output: isError={Err} subtype={Sub} in {Ms}ms · diag={Diag}",
                label, result.IsError, result.Subtype ?? "(none)", sw.ElapsedMilliseconds, result.Diagnostic ?? "(none)");
        else
            _log.LogInformation("[{Label}] agent done: outChars={Out} session={Sid} subtype={Sub} in {Ms}ms",
                label, result.FinalText.Length, result.SessionId ?? "(none)", result.Subtype ?? "(none)", sw.ElapsedMilliseconds);

        return result;
    }

    // Parse the tool-call arguments JSON once (object or default). Never throws.
    private static JsonElement ParseArgs(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return default;
        try { using var doc = JsonDocument.Parse(json); return doc.RootElement.Clone(); }
        catch { return default; }
    }

    // Detail string for the UI 'tool' event — the relevant arg per tool (ported from the retired
    // ClaudeCliRunner.ToolDetail; claude tool-arg conventions).
    private static string? ToolDetail(string name, JsonElement input) => name switch
    {
        "Read" or "Edit" or "Write" or "MultiEdit" or "NotebookEdit" => First(input, "file_path", "notebook_path", "path"),
        "Grep" or "Glob" => First(input, "pattern"),
        "Bash" => Trunc(First(input, "command"), 80),
        "Skill" => First(input, "skill", "command"),
        "WebSearch" => First(input, "query"),
        "WebFetch" => First(input, "url"),
        _ => null,
    };

    private static string? First(JsonElement obj, params string[] keys)
    {
        if (obj.ValueKind != JsonValueKind.Object) return null;
        foreach (var k in keys)
            if (obj.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String)
                return v.GetString();
        return null;
    }

    private static string? Trunc(string? s, int n) => s is null || s.Length <= n ? s : s[..n];
}
```

- [ ] **Step 2: Verify it does not yet compile against DI** — this is fine; wiring is Task 0.2. Do NOT build yet.

### Task 0.2: Register the session, the adapter, and lift the timeout ceiling

**Files:**
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs:92-106` (the `AddLyntai(...)` chain) and the line after it.

- [ ] **Step 1: Add `AddClaudeCliAgentSession()` + `Configure` inside the `AddLyntai` builder.** Change the builder lambda's first lines from:

```csharp
            .AddLyntai(b => b
                .AddClaudeCliProvider()
                .DefaultCandidates("claude-cli")
```

to:

```csharp
            .AddLyntai(b => b
                .AddClaudeCliProvider()
                // The interactive two-gate + jobs + playground drive the CLI's own agent loop through
                // Lyntai's IAgentSession (registered here). Long agentic runs need a budget bigger than the
                // 2-min provider default: lift the ceiling so a per-call TimeoutSeconds up to 2h is honored
                // (short one-shot/scorer calls keep the 2-min ProviderTimeout default).
                .AddClaudeCliAgentSession()
                .Configure(o => o.MaxProviderTimeout = TimeSpan.FromHours(2))
                .DefaultCandidates("claude-cli")
```

- [ ] **Step 2: Register `IAgentRunner` next to where the native runner is registered.** After the `AddLyntai(...)` chain closes (the `.AddScorer<...FaithfulnessScorer>())` line, before `.AddSingleton<IAgentGate, AgentGate>()`), add:

```csharp
            // App-side adapter over Lyntai's IAgentSession — the two-gate / jobs / playground run through this.
            .AddSingleton<IAgentRunner, AgentRunner>()
```

Leave `.AddSingleton<IClaudeCliRunner, ClaudeCliRunner>()` in place — consumers still inject it until Phase 4.

- [ ] **Step 3: Build.**

Run: `node devtools/dev.mjs build`
Expected: build succeeds (0 errors). `IAgentRunner` resolves; nothing consumes it yet.

- [ ] **Step 4: Commit.**

```bash
git add src/server/Gatherlight.Server/Modules/Llm/Services/AgentRunner.cs src/server/Gatherlight.Server/GatherlightApp.cs
git commit -m "feat(llm): add AgentRunner over Lyntai IAgentSession + wiring"
```

---

## Phase 1 — Migrate the two-gate (`ChatSessionService`)

**Files:**
- Modify: `src/server/Gatherlight.Server/Modules/Chat/Services/ChatSessionService.cs`

### Task 1.1: Swap the dependency + options builder + result diagnosis

- [ ] **Step 1: Add usings** at the top (after the existing `using Gatherlight.Server.Modules.Tools.Services;`):

```csharp
using Lyntai.Agents;
using Lyntai.Providers.ClaudeCli;
```

- [ ] **Step 2: Replace the field + ctor param.** Change `private readonly IClaudeCliRunner _runner;` (line 78) to:

```csharp
    private readonly IAgentRunner _agent;
```

In the constructor signature change `IClaudeCliRunner runner` (line 100) to `IAgentRunner agent`, and the assignment `_runner = runner;` (line 113) to `_agent = agent;`.

- [ ] **Step 3: Replace `BaseRunOptions`** (lines 310-321) with a `ClaudeAgentOptions` builder (drops `Cwd`/`ReadOnly`/`Label`/`OnEvent` — those move to the `RunAsync` call; adds `ToolPolicy`/`TimeoutSeconds`, `AllowedTools` becomes a non-null list):

```csharp
    // Per-call chat budget: the old runner was unbounded (abort-only). Preserve "effectively unbounded"
    // with a generous per-call timeout (clamped to LyntaiOptions.MaxProviderTimeout = 2h); overridable
    // via llm.timeout.chat. The human can always abort.
    private int ChatTimeoutSeconds =>
        int.TryParse(_appConfig.Get("llm.timeout.chat"), out var s) && s > 0 ? s : 7200;

    private ClaudeAgentOptions BaseRunOptions(ChatSession s, string prompt, bool readOnly) => new()
    {
        Prompt = prompt,
        WorkingDirectory = WorkRootFor(s),
        ToolPolicy = readOnly ? AgentToolPolicy.ReadOnly : AgentToolPolicy.Write,
        Model = _appConfig.Get("llm.model.chat"),
        TimeoutSeconds = ChatTimeoutSeconds,
        McpConfigPath = File.Exists(_env.McpConfigPath) ? _env.McpConfigPath : null,
        // Pre-approve registry tools so the headless run never stalls on a permission prompt.
        AllowedTools = _tools.McpAllowedToolNames() is { Length: > 0 } names ? names : Array.Empty<string>(),
    };
```

- [ ] **Step 4: Change `DiagnoseFailedRun`'s parameter type** (line 207) from `ClaudeRunResult res` to `AgentRunResult res`, and update its log line + switch (no `ExitCode`; use `Diagnostic`; `Subtype` replaces `ResultSubtype`):

```csharp
    private string DiagnoseFailedRun(ChatSession s, AgentRunResult res, string zhPhase)
    {
        _log.LogWarning(
            "No usable plan ({Phase}) session={Session} isError={Err} subtype={Sub} chars={Chars} diag={Diag}",
            zhPhase, s.Id, res.IsError, res.Subtype ?? "(none)", res.FinalText.Trim().Length, res.Diagnostic ?? "(none)");
        var why = res.Subtype switch
        {
            "error_max_turns" => "(达到回合上限)",
            "error_during_execution" => "(执行出错)",
            _ => res.IsError ? "(CLI 报告错误)" : "(无内容)",
        };
        return $"{zhPhase}未能完成{why},请重试。若反复失败,请查看日志(state/logs)了解原因。";
    }
```

### Task 1.2: Rewrite the 5 run call sites

- [ ] **Step 1: `RunPlanningAsync`** — replace line 349:

```csharp
            var res = await _agent.RunAsync(
                BaseRunOptions(s, prompt, readOnly: true),
                label: $"chat:{s.Mode}:plan", onEvent: ev => Emit(s, ev), ct: s.Abort.Token);
```

(The surrounding logic — `s.ClaudeSessionId = res.SessionId; s.PlanText = res.FinalText.Trim(); if (res.IsError || s.PlanText.Length == 0) Fail(...)` — is unchanged; `AgentRunResult` has `SessionId`/`FinalText`/`IsError`.)

- [ ] **Step 2: `ApprovePlanAsync`** — replace lines 389-396:

```csharp
            var res = await _agent.RunAsync(
                BaseRunOptions(s,
                    IsSystem(s) ? _harness.SystemExecutePrompt(s.PlanText) : _harness.ExecutePrompt(s.PlanText),
                    readOnly: false) with
                {
                    ResumeToken = s.ClaudeSessionId,
                    SettingsPath = IsSystem(s) ? _env.SystemSettingsPath : _env.SettingsPath,
                },
                label: $"chat:{s.Mode}:exec", onEvent: ev => Emit(s, ev), tracker: s.Tracker, ct: s.Abort.Token);
```

- [ ] **Step 3: `BuildWithRepairAsync`** — replace lines 442-447:

```csharp
            await _agent.RunAsync(
                BaseRunOptions(s, _harness.RepairPrompt(result.Output), readOnly: false) with
                {
                    ResumeToken = s.ClaudeSessionId,
                    SettingsPath = _env.SystemSettingsPath,
                },
                label: $"chat:{s.Mode}:repair", onEvent: ev => Emit(s, ev), tracker: s.Tracker,
                ct: s.Abort?.Token ?? default);
```

- [ ] **Step 4: `RefinePlanAsync`** — replace lines 463-467:

```csharp
            var res = await _agent.RunAsync(
                BaseRunOptions(s, revisePrompt, readOnly: true) with { ResumeToken = s.ClaudeSessionId },
                label: $"chat:{s.Mode}:revise-plan", onEvent: ev => Emit(s, ev), ct: s.Abort.Token);
```

- [ ] **Step 5: `RefineDiffAsync`** — replace lines 598-606:

```csharp
            var res = await _agent.RunAsync(
                BaseRunOptions(s,
                    IsSystem(s) ? _harness.SystemReviseExecutePrompt(feedback) : _harness.ReviseExecutePrompt(feedback),
                    readOnly: false) with
                {
                    ResumeToken = s.ClaudeSessionId,
                    SettingsPath = IsSystem(s) ? _env.SystemSettingsPath : _env.SettingsPath,
                },
                label: $"chat:{s.Mode}:revise-exec", onEvent: ev => Emit(s, ev), tracker: s.Tracker, ct: s.Abort.Token);
```

- [ ] **Step 6: Build.**

Run: `node devtools/dev.mjs build`
Expected: build succeeds. (`ClaudeCliRunner` is still registered/compiled; only `ChatSessionService` no longer references it.)

- [ ] **Step 7: Run the chat + guard + error-continuity e2e suites.**

Run: `node devtools/dev.mjs e2e p2 && node devtools/dev.mjs e2e p24 && node devtools/dev.mjs e2e p25`
Expected: each prints its `PASS` marker. p2 drives the full two-gate to committed (plan → approve → execute → diff → commit), p24 exercises the scope-guard (`--settings` still forwarded), p25 the empty-result → `Fail` path (`FORCE_ERROR`).

- [ ] **Step 8: Commit.**

```bash
git add src/server/Gatherlight.Server/Modules/Chat/Services/ChatSessionService.cs
git commit -m "refactor(chat): drive the two-gate through Lyntai IAgentSession"
```

---

## Phase 2 — Migrate the other agentic consumers (playground, jobs)

### Task 2.1: `PlaygroundService`

**Files:**
- Modify: `src/server/Gatherlight.Server/Modules/Playground/Services/PlaygroundService.cs`

- [ ] **Step 1: Swap the dependency.** Add usings `using Lyntai.Agents;` and `using Lyntai.Providers.ClaudeCli;`. Change field `private readonly IClaudeCliRunner _runner;` (line 53) to `private readonly IAgentRunner _agent;`, the ctor param `IClaudeCliRunner runner` (line 62) to `IAgentRunner agent`, and `_runner = runner;` (line 65) to `_agent = agent;`.

- [ ] **Step 2: Replace the run** (lines 101-114) with:

```csharp
            var res = await _agent.RunAsync(new ClaudeAgentOptions
            {
                // Mirror the real plan phase's read-only run (cwd = data root → loads the knowledge base;
                // MCP tools available) so the eval reflects actual planner behaviour — just no gate/commit.
                Prompt = _harness.PlanPrompt(s.Message, threadContext: null, attachments: Array.Empty<string>()),
                WorkingDirectory = _data.RootPath,
                ToolPolicy = AgentToolPolicy.ReadOnly,
                Model = model,
                TimeoutSeconds = 3600,
                McpConfigPath = File.Exists(_env.McpConfigPath) ? _env.McpConfigPath : null,
                AllowedTools = _tools.McpAllowedToolNames() is { Length: > 0 } names ? names : Array.Empty<string>(),
            }, label: "playground", onEvent: ev =>
            {
                if (ev.Kind == "usage" && ev.Data is not null) AccumulateUsage(result, ev.Data);
            }, ct: ct);
```

(`res.FinalText.Trim()` below is unchanged; `AccumulateUsage` reads the same `usage` event shape `AgentRunner` emits.)

### Task 2.2: `UnattendedRunService`

**Files:**
- Modify: `src/server/Gatherlight.Server/Modules/Jobs/Services/UnattendedRunService.cs`

- [ ] **Step 1: Swap the dependency.** Add usings `using Lyntai.Agents;` and `using Lyntai.Providers.ClaudeCli;`. Change field `private readonly IClaudeCliRunner _runner;` (line 59) to `private readonly IAgentRunner _agent;`, ctor param `IClaudeCliRunner runner` (line 70) to `IAgentRunner agent`, and `_runner = runner;` (line 75) to `_agent = agent;`.

- [ ] **Step 2: Replace the options + run.** Replace lines 102-124 (`var opts = new ClaudeRunOptions {…};` through `res = await _runner.RunAsync(opts, timeoutCts.Token);`) with:

```csharp
        var opts = new ClaudeAgentOptions
        {
            Prompt = prompt,
            WorkingDirectory = _data.RootPath,
            ToolPolicy = spec.ReadOnly ? AgentToolPolicy.ReadOnly : AgentToolPolicy.Write,
            Model = _appConfig.Get("llm.model.chat"),
            TimeoutSeconds = Math.Clamp(spec.TimeoutSeconds, 10, 3600),
            McpConfigPath = File.Exists(_env.McpConfigPath) ? _env.McpConfigPath : null,
            AllowedTools = _tools.McpAllowedToolNames() is { Length: > 0 } names ? names : Array.Empty<string>(),
            SettingsPath = spec.ReadOnly ? null : (File.Exists(_env.SettingsPath) ? _env.SettingsPath : null),
        };

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(spec.TimeoutSeconds, 10, 3600)));

        AgentRunResult? res = null;
        string? error = null;
        var timedOut = false;
        try
        {
            res = await _agent.RunAsync(opts, label: $"job:{spec.RunId}", onEvent: spec.OnEvent,
                tracker: tracker, ct: timeoutCts.Token);
        }
```

(The `catch` blocks and everything after — `res?.FinalText.Trim()`, the diff/commit/patch handling — are unchanged; `AgentRunResult.FinalText` matches.)

- [ ] **Step 3: Build.**

Run: `node devtools/dev.mjs build`
Expected: build succeeds.

- [ ] **Step 4: Run the playground + jobs e2e suites.**

Run: `node devtools/dev.mjs e2e p23 && node devtools/dev.mjs e2e p26`
Expected: both `PASS`. p23 = dry playground eval (no persistence), p26 = background jobs (report + agent, auto-commit + stage-for-review, distinct diffs).

- [ ] **Step 5: Commit.**

```bash
git add src/server/Gatherlight.Server/Modules/Playground/Services/PlaygroundService.cs src/server/Gatherlight.Server/Modules/Jobs/Services/UnattendedRunService.cs
git commit -m "refactor(playground,jobs): run through Lyntai IAgentSession"
```

---

## Phase 3 — Migrate the one-shot consumers (validate, extract, kb-merge)

These are read-only, non-gated single runs. They stay on the agent session (`ToolPolicy.ReadOnly`) rather than `ILlmClient` so each keeps its exact cwd/tool behavior (validate loads the KB at data root; extract reads an absolute upload path; kb-merge streams progress). `onEvent: null` where the caller ignored chatter.

### Task 3.1: `ClaudeValidateService`

**Files:**
- Modify: `src/server/Gatherlight.Server/Modules/Llm/Services/ClaudeValidateService.cs`

- [ ] **Step 1: Swap the dependency.** Add usings `using Lyntai.Agents;` and `using Lyntai.Providers.ClaudeCli;`. Change field `private readonly IClaudeCliRunner _runner;` (line 23) to `private readonly IAgentRunner _agent;`, ctor param `IClaudeCliRunner runner` (line 29) to `IAgentRunner agent`, and `_runner = runner;` (line 32) to `_agent = agent;`.

- [ ] **Step 2: Replace the run** (lines 44-56, the `ClaudeRunResult result; try { result = await _runner.RunAsync(new ClaudeRunOptions {…}, ct); }`) with:

```csharp
        AgentRunResult result;
        try
        {
            result = await _agent.RunAsync(new ClaudeAgentOptions
            {
                Prompt = _harness.ValidatePrompt(paths, diff),
                WorkingDirectory = _data.RootPath,
                ToolPolicy = AgentToolPolicy.ReadOnly,
                // The verdict pass is simple — a cheaper model suffices.
                Model = _appConfig.Get("llm.model.validate"),
                TimeoutSeconds = 600,
            }, label: "validate", onEvent: null, ct: ct);
        }
```

(The `catch (OperationCanceledException) { throw; }` / `catch (Exception ex) { return new ClaudeValidation(false, …); }` and the `result.FinalText.Trim()` verdict parse below are unchanged. Note: a Lyntai spawn failure now surfaces as `result.IsError == true` with empty `FinalText` → the existing "neither OK nor FAIL token → not-ok" path still fails closed.)

### Task 3.2: `ExtractTool`

**Files:**
- Modify: `src/server/Gatherlight.Server/Modules/Tools/Services/Tools/ExtractTool.cs`

- [ ] **Step 1: Swap the dependency.** Add usings `using Lyntai.Agents;` and `using Lyntai.Providers.ClaudeCli;`. Change field `private readonly IClaudeCliRunner _runner;` (line 16) to `private readonly IAgentRunner _agent;`, ctor param `IClaudeCliRunner runner` (line 23) to `IAgentRunner agent`, and `_runner = runner;` (line 26) to `_agent = agent;`.

- [ ] **Step 2: Replace the run** (lines 58-66) with:

```csharp
        var res = await _agent.RunAsync(new ClaudeAgentOptions
        {
            Prompt = _harness.ProcessFilePrompt(absPath, instruction),
            WorkingDirectory = Path.GetTempPath(), // neutral: no CLAUDE.md / knowledge-base load
            ToolPolicy = AgentToolPolicy.ReadOnly, // read-only: Read allowed, Edit/Write denied
            Model = _appConfig.Get("llm.model.extract") ?? "sonnet",
            TimeoutSeconds = 600,
        }, label: "extract", onEvent: null, ct: ct);
```

(`res.FinalText.Trim()` and the empty-output `ToolException` below are unchanged.)

### Task 3.3: `ZhikuMigrator`

**Files:**
- Modify: `src/server/Gatherlight.Server/Modules/Seed/Services/ZhikuMigrator.cs`

- [ ] **Step 1: Swap the dependency.** Add usings `using Lyntai.Agents;` and `using Lyntai.Providers.ClaudeCli;`. Change field `private readonly IClaudeCliRunner _runner;` (line 54) to `private readonly IAgentRunner _agent;`, ctor param `IClaudeCliRunner runner` (line 68) to `IAgentRunner agent`, and the corresponding assignment to `_agent = agent;`.

- [ ] **Step 2: Replace the run head** (lines 246-251, from `var res = await _runner.RunAsync(new ClaudeRunOptions {` through `Label = $"kb-merge:{path}",`) with:

```csharp
        var res = await _agent.RunAsync(new ClaudeAgentOptions
        {
            Prompt = _harness.KbMergePrompt(path, userContent, templateContent),
            WorkingDirectory = Path.GetTempPath(),   // neutral: the merge is self-contained in the prompt
            ToolPolicy = AgentToolPolicy.ReadOnly,
            Model = model,
            TimeoutSeconds = 1800,
        }, label: $"kb-merge:{path}", onEvent: ev =>
```

Then, at the end of the `OnEvent`/`onEvent` lambda, the trailing `}, ct);` that closed `RunAsync(new ClaudeRunOptions {…}, ct)` becomes `}, ct: ct);`. The lambda **body** (the `switch (ev.Kind)` on `text-delta` / `usage-live` / `usage` computing `_progress`) is unchanged — `AgentRunner` emits those same event kinds. `return res.FinalText;` is unchanged.

- [ ] **Step 3: Build.**

Run: `node devtools/dev.mjs build`
Expected: build succeeds. No source now references `IClaudeCliRunner` except its own file + the DI registration.

- [ ] **Step 4: Run the full e2e suite** (validate/extract/kb-merge are covered across suites; run everything).

Run: `node devtools/dev.mjs e2e all`
Expected: `e2e: N/N passed` (trust each suite's printed `PASS` marker even if the Windows libuv teardown abort prints after — see the e2e-runner-order-flake note).

- [ ] **Step 5: Commit.**

```bash
git add src/server/Gatherlight.Server/Modules/Llm/Services/ClaudeValidateService.cs src/server/Gatherlight.Server/Modules/Tools/Services/Tools/ExtractTool.cs src/server/Gatherlight.Server/Modules/Seed/Services/ZhikuMigrator.cs
git commit -m "refactor(validate,extract,kb-merge): run through Lyntai IAgentSession"
```

---

## Phase 4 — Delete the native runner (clean base)

### Task 4.1: Remove `ClaudeCliRunner` + its DI registration

**Files:**
- Delete: `src/server/Gatherlight.Server/Modules/Llm/Services/ClaudeCliRunner.cs`
- Modify: `src/server/Gatherlight.Server/GatherlightApp.cs` (remove the registration)
- Modify: `src/server/Gatherlight.Server/Modules/Core/Services/ModelPricing.cs` (doc comment)

- [ ] **Step 1: Delete the file.**

```bash
git rm src/server/Gatherlight.Server/Modules/Llm/Services/ClaudeCliRunner.cs
```

- [ ] **Step 2: Remove the registration** in `GatherlightApp.cs` — delete the line and its comment:

```csharp
            // LLM — spawn the authenticated claude CLI, never an API key
            .AddSingleton<IClaudeCliRunner, ClaudeCliRunner>()
```

- [ ] **Step 3: Fix the `ModelPricing` doc comment** — in `Modules/Core/Services/ModelPricing.cs:7-8` replace `Consumed by <c>ClaudeCliRunner</c> (the 'usage' event cost, which chat` with `Consumed by <c>AgentRunner</c> (the 'usage' event cost, which chat`.

- [ ] **Step 4: Confirm no dangling references.**

Run: `node devtools/dev.mjs build`
Expected: build succeeds with 0 errors. (If any `IClaudeCliRunner` / `ClaudeRunOptions` / `ClaudeRunResult` reference remains, the compiler names the file — fix it.)

- [ ] **Step 5: Full build + full e2e (the acceptance gate).**

Run: `node devtools/dev.mjs build && node devtools/dev.mjs e2e all`
Expected: build clean; `e2e: N/N passed` (every suite's `PASS`). This is the definition of done for the migration.

- [ ] **Step 6: Sensitive-info scan + commit.**

```bash
node devtools/scripts/check-sensitive.mjs --tree
git add -A
git commit -m "refactor(llm): delete native ClaudeCliRunner — two-gate fully on Lyntai"
```

---

## Notes & follow-ups (not tasks)

- **Deliberate behavior changes** (acceptable, called out): (1) live per-line **stderr notices** during a run are no longer streamed to the UI — the stderr tail is captured on the terminal `SessionEnded.Diagnostic` + the outcome log line instead; (2) the old runner emitted a full `text` event in addition to `text-delta`; now only `text-delta` streams (final text still arrives via the result line / phase payload) — always on because the adapter passes `--include-partial-messages`; (3) a per-call timeout now exists where chat previously had none (set generously, human-abortable, configurable via `llm.timeout.chat`).
- **Cortex is the next migration, now unblocked:** with the two-gate on Lyntai, `PromptHarness` → `IPromptRegistry` and model routing → `AddLiveModelRouting()`/`IModelRoutingStore` become clean (a separate plan).
- **`chat_score` drop migration** remains optionally offered (the table is unused since the scoring migration).

---

## Self-Review

- **Spec coverage:** every native-runner consumer from the grep is migrated — ChatSessionService (1.1–1.2), PlaygroundService (2.1), UnattendedRunService (2.2), ClaudeValidateService (3.1), ExtractTool (3.2), ZhikuMigrator (3.3) — then the runner is deleted (4.1). `JobHandlers` correctly untouched (uses `IUnattendedRunService`).
- **Type consistency:** `AgentRunResult(SessionId, FinalText, IsError, Subtype, Diagnostic)` is the single result shape; `DiagnoseFailedRun` uses `Subtype`/`Diagnostic` (not the old `ResultSubtype`/`ExitCode`). `ClaudeAgentOptions.AllowedTools` is always assigned a non-null list (`Array.Empty<string>()`), matching its `IReadOnlyList<string>` init. `IAgentRunner.RunAsync` signature is identical across all call sites.
- **No placeholders:** every code step shows the full replacement text and exact line anchors.
- **Green-at-every-phase:** the old runner stays registered through Phases 1–3 (consumers migrate incrementally); it is deleted only in Phase 4 after the last consumer moves. Each phase ends on a build + the relevant e2e suite.
