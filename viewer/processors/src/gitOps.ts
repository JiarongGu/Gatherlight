import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { DiffFile } from './types.ts';

const execFileAsync = promisify(execFile);

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout;
}

/** Does this path exist in HEAD? (distinguishes new files from modified). */
async function existsInHead(repoRoot: string, rel: string): Promise<boolean> {
  try {
    await git(repoRoot, ['cat-file', '-e', `HEAD:${rel}`]);
    return true;
  } catch {
    return false;
  }
}

const isClaudeInfra = (rel: string) =>
  rel === '.claude' || rel.startsWith('.claude/');

/**
 * Build the per-file diff for exactly the agent-touched paths. New (untracked)
 * files are shown via --no-index against an empty tree; modified/deleted via
 * `git diff HEAD`.
 */
export async function buildDiff(
  repoRoot: string,
  trackedPaths: string[]
): Promise<DiffFile[]> {
  const files: DiffFile[] = [];
  for (const rel of trackedPaths) {
    const inHead = await existsInHead(repoRoot, rel);
    const abs = path.resolve(repoRoot, rel);
    const fileExists = await fileOnDisk(abs);

    let status: DiffFile['status'];
    let diff = '';

    if (inHead && fileExists) {
      status = 'modified';
      diff = await git(repoRoot, ['diff', '--no-color', 'HEAD', '--', rel]);
      // No actual change (e.g. a denied edit still emits a tool_use, or a no-op
      // rewrite) → skip so the UI + commit only show real changes.
      if (!diff.trim()) continue;
    } else if (inHead && !fileExists) {
      status = 'deleted';
      diff = await git(repoRoot, ['diff', '--no-color', 'HEAD', '--', rel]);
    } else {
      status = 'added';
      // Untracked: diff against /dev/null so the UI shows the full new content.
      diff = await diffNoIndex(repoRoot, rel);
    }

    files.push({ path: rel, status, isClaudeInfra: isClaudeInfra(rel), diff });
  }
  return files;
}

async function diffNoIndex(repoRoot: string, rel: string): Promise<string> {
  const nullDev = process.platform === 'win32' ? 'NUL' : '/dev/null';
  try {
    await git(repoRoot, ['diff', '--no-color', '--no-index', '--', nullDev, rel]);
    return '';
  } catch (err: any) {
    // --no-index exits 1 when files differ; the diff is on stdout.
    return err?.stdout ?? '';
  }
}

async function fileOnDisk(abs: string): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    await stat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Stage + commit exactly the tracked paths. Returns the short sha. */
export async function commitPaths(
  repoRoot: string,
  trackedPaths: string[],
  message: string
): Promise<string> {
  await git(repoRoot, ['add', '--', ...trackedPaths]);
  await git(repoRoot, ['commit', '-m', message, '--', ...trackedPaths]);
  const sha = (await git(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
  return sha;
}

/**
 * Discard the agent's changes to the tracked paths only: restore tracked files
 * to HEAD, delete files the agent newly created. Pre-existing unrelated changes
 * to other files are untouched.
 */
export async function restorePaths(
  repoRoot: string,
  trackedPaths: string[]
): Promise<void> {
  // Unstage anything we may have intent-added (defensive).
  await git(repoRoot, ['reset', '-q', 'HEAD', '--', ...trackedPaths]).catch(() => {});
  const { rm } = await import('node:fs/promises');
  for (const rel of trackedPaths) {
    if (await existsInHead(repoRoot, rel)) {
      await git(repoRoot, ['checkout', '-q', 'HEAD', '--', rel]).catch(() => {});
    } else {
      await rm(path.resolve(repoRoot, rel), { force: true }).catch(() => {});
    }
  }
}
