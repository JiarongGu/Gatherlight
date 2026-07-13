using Gatherlight.Server.Modules.Core.Services;

namespace Gatherlight.Server.Modules.Llm.Services;

/// <summary>
/// The agent harness — instruction scaffolding wrapped around every claude CLI invocation so
/// the chat agent behaves predictably and obeys the knowledge-base rules. Instructions are
/// prepended to the stdin prompt (never --append-system-prompt) so ALL dynamic content travels
/// through stdin and the argv stays static.
///
/// Every template is overridable at runtime via app_config key <c>cortex.prompt.{name}</c>
/// (PromptRegistry pattern) — placeholders like {userMessage} are filled after override lookup.
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

    private readonly IAppConfigService _appConfig;

    public PromptHarness(IAppConfigService appConfig) => _appConfig = appConfig;

    public string PlanPrompt(string userMessage, string? threadContext, IReadOnlyList<string> attachments, string? routedBlock = null)
    {
        var context = string.IsNullOrWhiteSpace(threadContext)
            ? ""
            : "RECENT REQUESTS IN THIS CONVERSATION (for understanding follow-ups only — the workspace files are the source of truth; do NOT assume these edits still exist on disk):\n"
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
