using System.Text.RegularExpressions;
using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Llm.Services;

/// <summary>
/// A tunable prompt template in the cortex registry: its built-in default plus the metadata the
/// management console needs to present + validate an override. <see cref="Placeholders"/> are the
/// <c>{token}</c> slots the default fills at render time — an override MUST keep every one, or the
/// corresponding dynamic content (the user's request, the diff, …) never reaches the agent.
/// </summary>
public sealed record PromptDescriptor(
    string Name, string Label, string Description, string Group,
    string Default, IReadOnlyList<string> Placeholders);

/// <summary>
/// The agent harness — instruction scaffolding wrapped around every claude CLI invocation so
/// the chat agent behaves predictably and obeys the knowledge-base rules. Instructions are
/// prepended to the stdin prompt (never --append-system-prompt) so ALL dynamic content travels
/// through stdin and the argv stays static.
///
/// Every template is overridable at runtime via app_config key <c>cortex.prompt.{name}</c>
/// (PromptRegistry pattern) — placeholders like {userMessage} are filled after override lookup.
/// The full set of tunable templates is published as <see cref="PromptHarness.Catalog"/>.
/// </summary>
public interface IPromptHarness
{
    string PlanPrompt(string userMessage, string? threadContext, IReadOnlyList<string> attachments, string? routedBlock = null);
    string RevisePlanPrompt(string prevPlan, string feedback);
    string ExecutePrompt(string approvedPlan);
    string ReviseExecutePrompt(string feedback);
    string ValidatePrompt(IReadOnlyList<string> claudePaths, string diff);
    string CommitMessage(string userMessage, IReadOnlyList<string> files);
    string ProcessFilePrompt(string absPath, string instruction);
    string SystemPlanPrompt(string userMessage, string? threadContext);
    string SystemRevisePlanPrompt(string prevPlan, string feedback);
    string SystemExecutePrompt(string approvedPlan);
    string SystemReviseExecutePrompt(string feedback);
    string RepairPrompt(string buildOutput);
    string JobExecutePrompt(string jobName, string instructions);
    string JobReportPrompt(string jobName, string instructions);
    string JobCommitMessage(string jobName, IReadOnlyList<string> files, bool autoApproved);
    string KbMergePrompt(string path, string userVersion, string templateVersion);
}

public sealed class PromptHarness : IPromptHarness
{
    // Shared knowledge-base inheritance — prepended to EVERY agent prompt (plan, execute,
    // validate) so no agent works blind to the data folder's rules / skills / workflows.
    // CLAUDE.md is auto-loaded by the CLI (cwd = data root); the rest is one read away.
    private const string KbPreamble = """
        PROJECT KNOWLEDGE BASE — inherit it, never work blind:
        - CLAUDE.md (auto-loaded) is the law of this workspace — follow it in full.
        - Consult the knowledge base before acting: run the CLAUDE.md per-task gate + scan .claude/rules/RULES_INDEX.md (read matching rules).
        - DISCOVER with the right tools: use Read / Glob / Grep and the Skill tool (the workspace's discovery skills). NEVER crawl the filesystem with Bash (no `dir`, `ls -R`, `find`) — Glob a pattern or Grep instead.
        - When you spot a recurring pattern or a correction worth keeping, evolve the knowledge base (a rule / workflow / template / household update) rather than letting it evaporate.
        - CROSS-SESSION FACT MEMORY: before re-researching a venue / price / policy you may have verified before, call the recall_facts MCP tool; after verifying a granular fact (a working URL, a scraped price with date, a venue's status), store it with remember_fact (kind + topic + source + confidence). Rules and preferences still belong in the markdown knowledge base — the fact store is only for fine-grained verified facts.
        - NEVER use interactive / flow-control tools (AskUserQuestion, ExitPlanMode, EnterPlanMode) — there is no UI to answer them here and it will hang the task. If you hit a fork or need a choice, DON'T ask: present the options IN YOUR PLAN with a clear recommended default, and the human decides at the approval gate.
        """;

    private const string Common = KbPreamble + """


        You are the embedded planning assistant for a family planner workspace, invoked from a web chat window that family members use. You are NOT in a terminal; a human will review your work through a UI before anything is committed.

        NON-NEGOTIABLE RULES (the workspace CLAUDE.md governs you in full — follow it):
        - Run the per-task gate in CLAUDE.md for any non-trivial planning task, then read what it routes you to before drafting.
        - Obey every rule in .claude/rules/ that applies: absolute-dates (YYYY-MM-DD), money-format (currency code + amount), household-profile-first, past-plans-first, no-fabrication (cite or mark TBD), link-verification + verify-policy-info (verify time-sensitive facts; restaurants/flights/visa especially).
        - You may ONLY create or edit files under: plans/, household/, .claude/. Nothing else — a hook enforces this; if you try, you'll be blocked, so don't.
        - NEVER run git commit / git add / git push / git reset / git restore / git checkout, and never delete files with rm. The human reviews your diff and the system commits for you. Just edit files.
        - Keep edits minimal and on-scope. Don't refactor unrelated content.
        - ALWAYS communicate with the user in Simplified Chinese (简体中文): your plan, explanations, tool-activity narration, and final summary are all in Chinese. Keep proper nouns / file paths / URLs / code as-is. (Plan FILE content still follows each template's own language conventions.)
        """;

    private const string PlanTemplate = Common + """


        {context}{routing}{attachments}CURRENT PHASE: PLANNING (read-only).
        - Do NOT edit any files in this phase.
        - Explore as needed (read files, search, run the gate, web-search to verify facts).
        - Then your FINAL message must be the PLAN itself, in Markdown, structured as:
          1. **What the user asked** — one line restating the request.
          2. **Files to change** — a bullet per file with the exact path and what changes.
          3. **Key facts / sources** — any dates, prices, hours, or policy you verified, with citations (or TBDs).
          4. **Open questions** — anything ambiguous (or "none").
        - Be concrete and concise. The human approves THIS plan, then you execute it verbatim.

        THE USER'S REQUEST:
        {userMessage}
        """;

    private const string RevisePlanTemplate = Common + """


        CURRENT PHASE: PLANNING (read-only) — REVISION.
        The human reviewed your previous plan and has NOT approved it. They replied with the feedback / answers / extra info below. Fold it in and output a REVISED plan in the SAME structure as before (What the user asked / Files to change / Key facts / Open questions). Do NOT edit files. Keep what still holds; change only what the feedback touches. If the feedback answers an open question, apply the answer and drop that question. If anything is still ambiguous, list it under Open questions with a recommended default — don't ask interactively.

        YOUR PREVIOUS PLAN:
        {prevPlan}

        THE HUMAN'S FEEDBACK / ANSWERS:
        {feedback}
        """;

    private const string ExecuteTemplate = Common + """


        CURRENT PHASE: EXECUTING.
        - The human APPROVED the plan below. Implement it exactly. Make the file edits now.
        - Use templates from .claude/templates/ for any new plan file. Edit existing files in place (never create -v2 / -final siblings).
        - If you discover the plan can't be followed safely (e.g. a fact you must verify turns out false), STOP, do not guess, and explain in your final message what blocked you instead of editing.
        - When done, your final message should briefly summarize what you changed (one bullet per file). Do NOT commit — the human will review your diff.

        APPROVED PLAN:
        {approvedPlan}
        """;

    private const string ReviseExecuteTemplate = Common + """


        CURRENT PHASE: EXECUTING — REVISION.
        The human reviewed the files you changed and asked for adjustments BEFORE anything is committed (feedback below). Adjust the edits now — edit files directly. Keep it minimal and on-scope; don't redo work that's already correct, and don't commit. When done, briefly summarize what changed (one bullet per file).

        THE HUMAN'S FEEDBACK:
        {feedback}
        """;

    private const string ValidateTemplate = Common + """


        CURRENT PHASE: VALIDATION (read-only — do NOT edit anything).
        The chat agent just modified these AI-infrastructure (.claude/) files:
        {paths}

        Review the diff below and confirm the changes are internally consistent and properly indexed, specifically:
        - New/changed rules are listed in .claude/rules/RULES_INDEX.md.
        - New/changed skills/workflows are routed from .claude/KEYWORDS_INDEX.md or a .claude/keywords/*.md sub-index.
        - No dangling links, no contradictions with existing rules, naming conventions respected.

        Your FINAL message must start with exactly one of these tokens on its own line:
          VALIDATION_OK
          VALIDATION_FAIL
        followed by a short bullet list of findings (what's good / what's missing).

        DIFF:
        {diff}
        """;

    // ------------------------------------------------------------------------------------
    // 系统模式 — the agent iterates Gatherlight's OWN web UI (cwd = the CODE repo).
    // ------------------------------------------------------------------------------------

    private const string SystemCommon = """
        You are the embedded developer for the Gatherlight family-planner web app, working through its own chat in 系统模式 (system mode) to improve the INTERFACE. You are NOT in a terminal; a human reviews your work through a UI before anything is committed.

        NON-NEGOTIABLE RULES:
        - Your knowledge base is docs/UI_ARCHITECTURE.md — read it FIRST (atomic tiers: ui/atoms|molecules|organisms + screens; the one-atom rule; design tokens in src/client/src/styles.css + lib/theme.ts). docs/TOOLS.md covers the tool registry if relevant.
        - You may create or edit files ONLY under `src/client/` (the UI). NOT src/server, NOT docs, NOT devtools, NOT the data folder. A hook enforces this — attempts elsewhere are blocked, so don't.
        - The app is React 18 + Vite + antd (v6) + TypeScript. Match the existing 清爽极简 design system: use the CSS variables / tokens (var(--bg), --surface, --text, --accent …) and dark+light theming — never hard-code colors that break a theme.
        - Keep changes minimal, focused on the request, and type-safe. Your code MUST pass `npm run build` (tsc -b && vite build — noUnusedLocals is on, no unused imports, no broken paths).
        - NEVER run git or destructive shell. The system builds + the human commits.
        - NEVER use interactive / flow-control tools (AskUserQuestion, ExitPlanMode, EnterPlanMode) — no UI can answer them. Present choices in your plan with a recommended default.
        - DISCOVER with Read / Glob / Grep — never crawl the filesystem with Bash.
        - Respond to the user in Simplified Chinese (代码/路径/标识符保持原样).
        """;

    private const string SystemPlanTemplate = SystemCommon + """


        {context}CURRENT PHASE: PLANNING (read-only). Do NOT edit files. Work in this ORDER:
        1. FIRST read docs/UI_ARCHITECTURE.md — one line confirming you read it.
        2. Using that map, open the specific files that own the behavior with Read/Glob/Grep.
        3. Then write the PLAN in Markdown:
           - **What the user wants** — one line (restate the UX problem, not just the literal words).
           - **Files to change** — each src/client path + what changes.
           - **Approach** — components/styles touched, how it fits the design system + tokens.
        Be concrete and concise; the human approves this, then you implement it verbatim.

        THE USER'S REQUEST:
        {userMessage}
        """;

    private const string SystemRevisePlanTemplate = SystemCommon + """


        CURRENT PHASE: PLANNING (read-only) — REVISION.
        The human reviewed your previous UI-change plan and has NOT approved it. Fold in their feedback below and output a REVISED plan in the SAME structure (What the user wants / Files to change / Approach). Do NOT edit files. If still ambiguous, note it with a recommended default.

        YOUR PREVIOUS PLAN:
        {prevPlan}

        THE HUMAN'S FEEDBACK / ANSWERS:
        {feedback}
        """;

    private const string SystemExecuteTemplate = SystemCommon + """


        CURRENT PHASE: EXECUTING. Implement the approved plan now by editing src/client files.
        Make minimal, type-safe edits that build cleanly. When done, briefly summarize what you changed (one bullet per file).

        APPROVED PLAN:
        {approvedPlan}
        """;

    private const string SystemReviseExecuteTemplate = SystemCommon + """


        CURRENT PHASE: EXECUTING — REVISION.
        The human reviewed your frontend changes and asked for adjustments BEFORE committing (feedback below). Adjust the edits now by editing src/client files. Keep it minimal, type-safe, and building cleanly; don't redo what's already correct. When done, briefly summarize what changed.

        THE HUMAN'S FEEDBACK:
        {feedback}
        """;

    private const string RepairTemplate = SystemCommon + """


        CURRENT PHASE: BUILD REPAIR. Your last edits FAILED the build (`npm run build` = tsc -b && vite build). Read the errors below and fix them by editing src/client files. Do not start over — just fix what's broken. Keep the intended change.

        BUILD OUTPUT (tail):
        {buildOutput}
        """;

    // ------------------------------------------------------------------------------------
    // Background jobs — unattended, scheduled runs (no human at the two gates). One CLI run does
    // the whole task; a human reviews the diff LATER (or it auto-commits if the job is trusted).
    // ------------------------------------------------------------------------------------

    private const string JobExecuteTemplate = Common + """


        CURRENT PHASE: SCHEDULED TASK (unattended execution).
        This is a background job named "{jobName}" running on a schedule — there is NO human watching in real time and NO separate plan-approval step. Do the task end to end NOW: explore as needed (read files, search, run the CLAUDE.md gate, verify time-sensitive facts), then make the file edits. A human reviews your diff LATER, or it auto-commits if the job is trusted — so keep edits minimal and on-scope, cite facts (no fabrication; mark TBD when unknown), and edit files in place (never -v2 / -final siblings).
        If the task can't be done safely (a fact you must verify turns out false, required info is missing), STOP — do NOT guess — and explain in your final message what blocked you, editing nothing. When done, your final message is a short Chinese summary of what you changed (one bullet per file), or why you couldn't.

        THE SCHEDULED TASK:
        {instructions}
        """;

    private const string JobReportTemplate = Common + """


        CURRENT PHASE: SCHEDULED REPORT (read-only — do NOT edit, create, or delete any file).
        This is a background job named "{jobName}" running on a schedule. Research/analyze exactly as instructed using READ-ONLY tools (Read / Glob / Grep, recall_facts, and the web/scrape MCP tools), then your FINAL message IS the report handed back to the user: well-structured Markdown in Simplified Chinese, concrete, with citations for any time-sensitive facts (no fabrication — mark unknowns TBD). No preamble like "here is the report"; output only the report itself.

        THE SCHEDULED REPORT TASK:
        {instructions}
        """;

    // Knowledge-base upgrade migration — reconcile a user's customized .claude/ file with the new
    // shipped template (2-way: A = user's current, B = new template). Output = merged file only.
    private const string KbMergeTemplate = """
        You are reconciling two versions of a knowledge-base file in a family-planner workspace (its `.claude/` config: rules / skills / workflows / templates). Produce a MERGED version and output ONLY the merged file content — no preamble, no explanation, no code fences, no commentary.

        FILE: {path}

        VERSION A — the user's CURRENT customized file (their intentional edits — preserve them):
        <<<<A
        {userVersion}
        A>>>>

        VERSION B — the NEW official template with improvements (adopt them):
        <<<<B
        {templateVersion}
        B>>>>

        Merge rules:
        - Keep every intentional customization from A (added rules/examples/wording, family- or workspace-specific content).
        - Adopt B's improvements (new sections, clearer structure, fixed links, new guidance) wherever they don't conflict with A's customizations.
        - When A and B genuinely conflict on the same point, prefer A (the user's choice), but still fold in B's non-conflicting additions around it.
        - Preserve A's language and formatting conventions.
        - Output the COMPLETE merged file, ready to save as-is.
        """;

    private static readonly Regex PlaceholderRe = new(@"\{([a-zA-Z]+)\}", RegexOptions.Compiled);

    private static IReadOnlyList<string> Ph(string template) =>
        PlaceholderRe.Matches(template).Select(m => m.Groups[1].Value).Distinct().ToArray();

    /// <summary>
    /// The tunable-prompt registry the management console drives — every template that
    /// <see cref="Render"/> can override via <c>cortex.prompt.{name}</c>, with its default body,
    /// placeholder contract, and a human label/description. Grouped for presentation:
    /// <c>planner</c> (the two-gate chat), <c>validation</c>, <c>utility</c>, <c>system</c>.
    /// </summary>
    public static IReadOnlyList<PromptDescriptor> Catalog { get; } = new[]
    {
        new PromptDescriptor("plan", "规划 · Plan",
            "闸门一:根据用户请求起草只读计划,交人审批。", "planner", PlanTemplate, Ph(PlanTemplate)),
        new PromptDescriptor("revisePlan", "修订计划 · Revise plan",
            "计划未获批准时,吸收反馈重拟计划。", "planner", RevisePlanTemplate, Ph(RevisePlanTemplate)),
        new PromptDescriptor("execute", "执行 · Execute",
            "计划批准后逐条落实文件改动。", "planner", ExecuteTemplate, Ph(ExecuteTemplate)),
        new PromptDescriptor("reviseExecute", "修订执行 · Revise execute",
            "提交前根据 diff 反馈调整已改文件。", "planner", ReviseExecuteTemplate, Ph(ReviseExecuteTemplate)),
        new PromptDescriptor("validate", "智库校验 · Validate",
            "校验 .claude/ 改动的一致性与索引完整性。", "validation", ValidateTemplate, Ph(ValidateTemplate)),
        new PromptDescriptor("processFile", "文件提取 · Extract",
            "一次性读取单个文件并返回结果(廉价工具调用,不加载智库)。", "utility", ProcessFileTemplate, Ph(ProcessFileTemplate)),
        new PromptDescriptor("systemPlan", "系统模式 · 计划",
            "系统模式:改本应用界面的计划闸门。", "system", SystemPlanTemplate, Ph(SystemPlanTemplate)),
        new PromptDescriptor("systemRevisePlan", "系统模式 · 修订计划",
            "系统模式:界面改动计划的修订。", "system", SystemRevisePlanTemplate, Ph(SystemRevisePlanTemplate)),
        new PromptDescriptor("systemExecute", "系统模式 · 执行",
            "系统模式:落实界面代码改动。", "system", SystemExecuteTemplate, Ph(SystemExecuteTemplate)),
        new PromptDescriptor("systemReviseExecute", "系统模式 · 修订执行",
            "系统模式:界面改动的修订。", "system", SystemReviseExecuteTemplate, Ph(SystemReviseExecuteTemplate)),
        new PromptDescriptor("repair", "系统模式 · 构建修复",
            "系统模式:构建失败后修复 src/client 代码。", "system", RepairTemplate, Ph(RepairTemplate)),
        new PromptDescriptor("jobExecute", "定时任务 · 执行",
            "后台定时任务:一次性完成并改动文件(供事后审阅或自动提交)。", "jobs", JobExecuteTemplate, Ph(JobExecuteTemplate)),
        new PromptDescriptor("jobReport", "定时任务 · 报告",
            "后台定时任务:只读分析并产出报告(不改动数据)。", "jobs", JobReportTemplate, Ph(JobReportTemplate)),
        new PromptDescriptor("kbMerge", "知识库升级 · 合并",
            "应用更新时,把用户自定义的 .claude 文件与新模板改进合并(2-way)。", "utility", KbMergeTemplate, Ph(KbMergeTemplate)),
    };

    private readonly IAppConfigService _appConfig;

    public PromptHarness(IAppConfigService appConfig) => _appConfig = appConfig;

    public string SystemPlanPrompt(string userMessage, string? threadContext)
    {
        var context = string.IsNullOrWhiteSpace(threadContext)
            ? ""
            : "RECENT REQUESTS IN THIS CONVERSATION (context only; a turn marked \"⚠️ 未完成(出错)\" failed — if this request continues it, recover from there):\n" + threadContext.Trim() + "\n\n";
        return Render("systemPlan", SystemPlanTemplate, new()
        {
            ["context"] = context,
            ["userMessage"] = userMessage,
        });
    }

    public string SystemRevisePlanPrompt(string prevPlan, string feedback) =>
        Render("systemRevisePlan", SystemRevisePlanTemplate, new() { ["prevPlan"] = prevPlan, ["feedback"] = feedback });

    public string SystemExecutePrompt(string approvedPlan) =>
        Render("systemExecute", SystemExecuteTemplate, new() { ["approvedPlan"] = approvedPlan });

    public string SystemReviseExecutePrompt(string feedback) =>
        Render("systemReviseExecute", SystemReviseExecuteTemplate, new() { ["feedback"] = feedback });

    public string RepairPrompt(string buildOutput) =>
        Render("repair", RepairTemplate, new() { ["buildOutput"] = buildOutput });

    public string JobExecutePrompt(string jobName, string instructions) =>
        Render("jobExecute", JobExecuteTemplate, new() { ["jobName"] = jobName, ["instructions"] = instructions });

    public string JobReportPrompt(string jobName, string instructions) =>
        Render("jobReport", JobReportTemplate, new() { ["jobName"] = jobName, ["instructions"] = instructions });

    public string KbMergePrompt(string path, string userVersion, string templateVersion) =>
        Render("kbMerge", KbMergeTemplate, new()
        {
            ["path"] = path, ["userVersion"] = userVersion, ["templateVersion"] = templateVersion,
        });

    /// <summary>Commit message for a background job's edits: subject + provenance (auto vs
    /// human-approved diff) + file list.</summary>
    public string JobCommitMessage(string jobName, IReadOnlyList<string> files, bool autoApproved)
    {
        var name = string.Join(' ', jobName.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        var subject = $"job: {(name.Length <= 60 ? name : name[..59] + "…")}";
        var provenance = autoApproved
            ? "Scheduled background job (auto-commit — no human diff review)."
            : "Scheduled background job (human-approved diff).";
        var body = string.Join('\n', files.Select(f => $"- {f}"));
        return $"{subject}\n\n{provenance}\n\nFiles:\n{body}\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
    }

    public string PlanPrompt(string userMessage, string? threadContext, IReadOnlyList<string> attachments, string? routedBlock = null)
    {
        var context = string.IsNullOrWhiteSpace(threadContext)
            ? ""
            : "RECENT REQUESTS IN THIS CONVERSATION (for understanding follow-ups only — the workspace files are the source of truth; do NOT assume these edits still exist on disk). A turn marked \"⚠️ 未完成(出错)\" did NOT finish: if the current request is a retry or continuation of it, pick up from there and address what went wrong rather than starting over blind:\n"
              + threadContext.Trim() + "\n\n";
        return Render("plan", PlanTemplate, new()
        {
            ["context"] = context,
            ["routing"] = routedBlock ?? "",
            ["attachments"] = AttachmentsBlock(attachments),
            ["userMessage"] = userMessage,
        });
    }

    public string RevisePlanPrompt(string prevPlan, string feedback) =>
        Render("revisePlan", RevisePlanTemplate, new() { ["prevPlan"] = prevPlan, ["feedback"] = feedback });

    public string ExecutePrompt(string approvedPlan) =>
        Render("execute", ExecuteTemplate, new() { ["approvedPlan"] = approvedPlan });

    public string ReviseExecutePrompt(string feedback) =>
        Render("reviseExecute", ReviseExecuteTemplate, new() { ["feedback"] = feedback });

    public string ValidatePrompt(IReadOnlyList<string> claudePaths, string diff) =>
        Render("validate", ValidateTemplate, new()
        {
            ["paths"] = string.Join('\n', claudePaths.Select(p => $"  - {p}")),
            ["diff"] = diff,
        });

    /// <summary>Commit message for the approved change: subject + gate provenance + file list.</summary>
    public string CommitMessage(string userMessage, IReadOnlyList<string> files)
    {
        var oneLine = string.Join(' ', userMessage.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
        var subject = oneLine.Length <= 68 ? oneLine : oneLine[..67] + "…";
        var body = string.Join('\n', files.Select(f => $"- {f}"));
        return $"{subject}\n\nVia family chat console. Human-approved (plan + diff gates).\n\nFiles:\n{body}\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
    }

    private const string ProcessFileTemplate = """
        You are a one-shot FILE PROCESSOR. Read ONE file and return the requested result as your FINAL message. You are read-only — do NOT edit / create / delete anything, and do NOT explore any other files.

        STEPS:
        1. Use the Read tool on this path (it ingests PDFs and images natively): {absPath}
        2. Do exactly what the INSTRUCTION says, using ONLY the file's actual contents. Never fabricate — if the file doesn't contain something the instruction asks for, say so plainly.
        3. Your FINAL message IS the result handed back to the caller — no "here is the result" preamble, no meta commentary. Output only the result itself (plain text / markdown / JSON as the instruction requests).

        INSTRUCTION:
        {instruction}
        """;

    /// <summary>One-shot file-processor prompt (the `extract` tool) — deliberately lean: no
    /// knowledge-base gate, no exploration, absolute path so it runs from a neutral cwd
    /// (no CLAUDE.md token load).</summary>
    public string ProcessFilePrompt(string absPath, string instruction) =>
        Render("processFile", ProcessFileTemplate, new() { ["absPath"] = absPath, ["instruction"] = instruction });

    /// <summary>Attachments block — data-root-relative paths of files the user uploaded for this
    /// turn. The claude CLI's Read tool ingests PDFs and images natively.</summary>
    private static string AttachmentsBlock(IReadOnlyList<string> attachments)
    {
        if (attachments.Count == 0) return "";
        var list = string.Join('\n', attachments.Select(p => $"  - {p}"));
        return "ATTACHED FILES — the user uploaded these for THIS request. BEFORE you plan, use the Read tool on EACH path below (the Read tool ingests PDFs and images natively) and base your plan on their ACTUAL contents — do not guess what they contain. These paths are workspace-relative; read them as-is:\n"
               + list + "\n\n";
    }

    /// <summary>App-config override (<c>cortex.prompt.{name}</c>) wins over the built-in template;
    /// {placeholder} tokens are filled from vars either way.</summary>
    private string Render(string name, string defaultTemplate, Dictionary<string, string> vars)
    {
        var template = _appConfig.Get($"cortex.prompt.{name}") ?? defaultTemplate;
        foreach (var (key, value) in vars)
            template = template.Replace("{" + key + "}", value);
        return template;
    }
}
