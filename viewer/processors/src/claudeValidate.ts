import { runClaude } from './claudeRunner.ts';
import { validatePrompt } from './harness.ts';
import type { ClaudeValidation, DiffFile, EventSink } from './types.ts';

/**
 * Extra validation pass for 智库 (.claude/) changes. Runs a fresh, read-only
 * claude that inspects the .claude/ diff and confirms consistency + indexing.
 * Fail-safe: if the run errors or returns no verdict, we mark NOT-ok so the UI
 * forces the human to look closely.
 */
export async function validateClaudeChanges(
  repoRoot: string,
  claudeFiles: DiffFile[],
  onEvent: EventSink,
  signal?: AbortSignal,
  model?: string // verdict pass is simple — a cheaper model (e.g. 'sonnet') suffices
): Promise<ClaudeValidation> {
  const paths = claudeFiles.map((f) => f.path);
  const diff = claudeFiles.map((f) => `### ${f.path}\n${f.diff}`).join('\n\n');

  onEvent({ kind: 'notice', text: `🔎 智库变更校验中 (${paths.length} 个 .claude/ 文件)…` });

  let result;
  try {
    result = await runClaude({
      prompt: validatePrompt(paths, diff),
      repoRoot,
      readOnly: true,
      model,
      signal,
      onEvent: () => {
        /* swallow the validator's chatter — only its verdict matters */
      }
    });
  } catch (err: any) {
    return {
      ok: false,
      report: `校验进程启动失败:${err?.message ?? err}。请人工检查 .claude/ 变更。`
    };
  }

  const text = (result.finalText ?? '').trim();
  const ok = /^VALIDATION_OK\b/m.test(text);
  const fail = /^VALIDATION_FAIL\b/m.test(text);
  const report = text || '(校验器无输出)';

  // Neither token → treat as not-ok (fail closed).
  return { ok: ok && !fail, report };
}
