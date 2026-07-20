# Cortex on Lyntai (IPromptRegistry + IModelRoutingStore) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Move Gatherlight's cortex (prompt-template overrides + per-consumer model routing) onto Lyntai 0.29.0's `IPromptRegistry` + `IModelRoutingStore`, over Gatherlight's OWN `app_config` table — so the render/validate/route LOGIC belongs to Lyntai while the storage stays single-sourced in `app_config` (no `lyntai_kv` duplicate). The end state: all LLM/cortex machinery is Lyntai's; Gatherlight keeps the prompt/model **catalog** + the `/manage` admin UI + its business logic.

**Architecture:** Register a `AppConfigKeyValueStore : Lyntai.Storage.IKeyValueStore` that wraps Gatherlight's `IAppConfigService` (→ `app_config`), so Lyntai's cortex reads/writes the app's table. Set `LyntaiOptions.PromptKeyPrefix = "cortex.prompt."` + `ModelKeyPrefix = "llm.model."` so Lyntai uses the app's EXISTING key names (no shim, no data migration). `PromptHarness` delegates rendering to `IPromptRegistry.RenderAsync` (async — a mechanical `await` ripple through the already-async callers); `CortexConfigService` validates overrides via `IPromptRegistry.ValidateOverride`; the LLM-judge scorers resolve their model live via `IModelRoutingStore` (`AddLiveModelRouting`). The prompt templates + `PromptHarness.Catalog` + `CortexConfigService`'s model catalog + `CortexController` + the `/manage` UI all stay app-side (business config).

## Key facts (verified)
- Lyntai `IPromptRegistry.RenderAsync(name, defaultTemplate, vars, ct)` reads override `{PromptKeyPrefix}{name}` from `IKeyValueStore`, fills `{placeholder}`s, rejects an override that drops a default placeholder (logs + falls back). `ValidateOverride(default, candidate) → missing[]`.
- `IPromptRegistry` (TryAdd) + `KeyValueModelRoutingStore` (via `AddLiveModelRouting`) both resolve `sp.GetService<IKeyValueStore>()` lazily + take the prefix from `LyntaiOptions.PromptKeyPrefix`/`ModelKeyPrefix`.
- `LyntaiOptions.PromptKeyPrefix`/`ModelKeyPrefix` are settable via `.Configure(o => …)`. `ResolveModel(consumer, requestModel, liveOverride)`: explicit → live (IModelRoutingStore) → `DefaultModelByConsumer[consumer]` → `["default"]` → null.
- Gatherlight `IAppConfigService`: `string? Get(key)`, `void Set(key,value)`, `void Delete(key)` (sync; `app_config` table).
- `PromptHarness.Render(name, default, vars)` is the ONLY cortex-store touch; 14 of its 16 methods call it (`CommitMessage`/`JobCommitMessage` build strings directly → stay sync). Callers (all already async): ChatSessionService (9 sites), ClaudeValidateService, ExtractTool, UnattendedRunService (2), ZhikuMigrator, PlaygroundService.
- Scorers today: `Model => config.Get("llm.model.scorer") ?? "haiku"`, `Consumer => "scorer:answer-relevancy"`/`"scorer:faithfulness"`.

---

## Phase 1 — App KV seam + AddLyntai cortex config

- [ ] **Create** `src/server/Gatherlight.Server/Modules/Cortex/Services/AppConfigKeyValueStore.cs`:
```csharp
using Gatherlight.Server.Modules.Core.Services;
using Lyntai.Storage;

namespace Gatherlight.Server.Modules.Cortex.Services;

/// <summary>
/// Plugs Gatherlight's own app_config table into Lyntai's cortex as its IKeyValueStore, so Lyntai's
/// IPromptRegistry + IModelRoutingStore read/write the app's EXISTING cortex.prompt.* / llm.model.* keys
/// directly (via the configurable key prefixes) — single source of truth, no lyntai_kv duplicate. Lyntai
/// owns the cortex LOGIC; the app owns the one storage table. The sync IAppConfigService (in-process
/// app_config) is wrapped as the async IKeyValueStore.
/// </summary>
public sealed class AppConfigKeyValueStore(IAppConfigService config) : IKeyValueStore
{
    public Task<string?> GetAsync(string key, CancellationToken ct = default) => Task.FromResult(config.Get(key));
    public Task SetAsync(string key, string value, CancellationToken ct = default) { config.Set(key, value); return Task.CompletedTask; }
    public Task DeleteAsync(string key, CancellationToken ct = default) { config.Delete(key); return Task.CompletedTask; }
}
```
- [ ] **Modify** `GatherlightApp.cs` — extend the `AddLyntai` `.Configure(...)` and add `.AddLiveModelRouting()`:
```csharp
                .Configure(o =>
                {
                    o.MaxProviderTimeout = TimeSpan.FromHours(2);
                    // Point Lyntai's cortex at the app's EXISTING config keys — no shim, no lyntai_kv copy.
                    o.PromptKeyPrefix = "cortex.prompt.";
                    o.ModelKeyPrefix = "llm.model.";
                    o.DefaultModelByConsumer["scorer"] = "haiku"; // cheap-judge default; llm.model.scorer overrides live
                })
                .AddLiveModelRouting()
```
  and register the app KV **after** the `AddLyntai(...)` block (plain `AddSingleton` → wins over Lyntai's `TryAdd` SqliteKeyValueStore, so cortex reads app_config):
```csharp
            // Lyntai's cortex (IPromptRegistry / IModelRoutingStore) reads/writes the app's OWN app_config
            // table — single source of truth for cortex.prompt.* / llm.model.*; no lyntai_kv duplicate.
            .AddSingleton<Lyntai.Storage.IKeyValueStore, Modules.Cortex.Services.AppConfigKeyValueStore>()
```
- [ ] **Build** → 0 errors.

---

## Phase 2 — `PromptHarness` → `IPromptRegistry` (async)

- [ ] **`IPromptHarness`** — the 14 render methods return `Task<string>` (rename `…Prompt` → keep name, change return type); `CommitMessage`/`JobCommitMessage` stay `string`.
- [ ] **`PromptHarness`** — inject `Lyntai.Prompts.IPromptRegistry _registry`; replace `Render(name, default, vars)` with `RenderAsync`:
```csharp
private Task<string> RenderAsync(string name, string defaultTemplate, Dictionary<string, string> vars) =>
    _registry.RenderAsync(name, defaultTemplate, vars);
```
  and make each of the 14 methods `async Task<string>` returning `await RenderAsync(...)`. (Delete the old app_config-reading `Render`.) Drop the now-unused `IAppConfigService` field if nothing else uses it.
- [ ] **Build** — will fail at the callers (expected; fixed in Phase 3).

---

## Phase 3 — Callers `await` the async prompt methods

- [ ] **`ChatSessionService`** (9 sites, all in async methods): `_harness.PlanPrompt(...)` → `await _harness.PlanPrompt(...)`, etc. `BaseRunOptions(s, _harness.X(...), …)` becomes `BaseRunOptions(s, await _harness.X(...), …)`.
- [ ] **`ClaudeValidateService`** `Prompt = _harness.ValidatePrompt(...)` → `Prompt = await _harness.ValidatePrompt(...)`.
- [ ] **`ExtractTool`**, **`UnattendedRunService`** (JobReport/JobExecute — the `?:` becomes `spec.ReadOnly ? await … : await …`), **`ZhikuMigrator`**, **`PlaygroundService`** — same `await`.
- [ ] **Build** → 0 errors.

---

## Phase 4 — Validation via Lyntai + scorers via live routing

- [ ] **`CortexConfigService.SetPrompt`** — replace the hand-rolled placeholder check with `IPromptRegistry.ValidateOverride(desc.Default, value)` (inject `IPromptRegistry`); keep writing via `IAppConfigService` (same `app_config` table) or the KV. Reads (`Prompts()`/`Models()`) unchanged (still `IAppConfigService`, same table).
- [ ] **`BuiltInScorers`** — `AnswerRelevancyScorer` + `FaithfulnessScorer`: remove the `Model` override (let the router resolve), set `Consumer => "scorer"` (both — the single "scorer" knob = `llm.model.scorer`), drop the now-unused `IAppConfigService` ctor param. `DefaultModelByConsumer["scorer"]="haiku"` (Phase 1) is the default; a live `llm.model.scorer` override wins.
- [ ] **Build** → 0 errors.

---

## Phase 5 — Verify + commit

- [ ] **Full e2e** `node devtools/dev.mjs e2e all` → 27/27 (esp. p21/p23 scoring — judges resolve model via routing; any cortex-override e2e; p2 chat renders prompts).
- [ ] **Manual check**: a `cortex.prompt.plan` override set via `/api/manage/cortex/prompt/plan` reaches the spawned CLI (e2e `CORTEX_ECHO` marker if present); `llm.model.scorer` override changes the judge model live.
- [ ] **Commit.**

## Notes
- No data migration: the app's `cortex.prompt.*`/`llm.model.*` rows stay in `app_config`; Lyntai reads them via the app KV + configured prefixes. `lyntai_kv` (created by `UseSqliteStorage`) is unused (acceptable; a Part-9 toggle could drop it later).
- Agent-session model (chat/jobs/validate/extract): still `_appConfig.Get("llm.model.{consumer}")` → `ClaudeAgentOptions.Model` — Lyntai's agent session takes an explicit model (no router path); `app_config` is the single source, so no duplication. Only the ILlmClient/router path (scorers) uses `IModelRoutingStore`.
- The prompt/model **catalog** (`PromptHarness.Catalog`, `CortexConfigService` model catalog), `CortexController`, and the `/manage` UI stay app-side — Lyntai renders/validates/routes; the app owns its domain metadata + UI.
