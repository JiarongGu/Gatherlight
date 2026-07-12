import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { rm, readFile, writeFile, mkdir } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

// Direct user actions are restricted to user content only — 智库 (.claude/) and
// everything else stays off-limits (manage those through the AI assistant).
const ALLOWED_DIRS = ['plans', 'household'];

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    maxBuffer: 32 * 1024 * 1024
  });
  return stdout;
}

function normalize(rel: string): string {
  return rel.split(path.sep).join('/').replace(/^\.\//, '');
}

function assertInScope(rel: string): void {
  const norm = normalize(rel);
  if (norm.startsWith('..') || path.isAbsolute(norm)) {
    throw new Error(`路径越界:${rel}`);
  }
  const ok = ALLOWED_DIRS.some((d) => norm === d || norm.startsWith(d + '/'));
  if (!ok) throw new Error(`不允许操作该路径(仅限 plans/ 和 household/):${rel}`);
}

async function isTracked(repoRoot: string, rel: string): Promise<boolean> {
  try {
    await git(repoRoot, ['ls-files', '--error-unmatch', '--', rel]);
    return true;
  } catch {
    return false;
  }
}

async function hasStaged(repoRoot: string): Promise<boolean> {
  try {
    await git(repoRoot, ['diff', '--cached', '--quiet']);
    return false; // exit 0 → no staged changes
  } catch {
    return true; // exit 1 → staged changes present
  }
}

async function shortSha(repoRoot: string): Promise<string> {
  return (await git(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
}

const TRAILER = 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>';
function commitBody(subject: string): string {
  return `${subject}\n\nVia viewer 直接操作(用户已确认)。\n\n${TRAILER}`;
}

/** Delete files and/or whole directories (recursively). Commits tracked removals. */
export async function deleteEntries(
  repoRoot: string,
  entries: { paths?: string[]; dirs?: string[] },
  subject: string
): Promise<{ sha: string | null; removed: string[] }> {
  const paths = entries.paths ?? [];
  const dirs = entries.dirs ?? [];
  [...paths, ...dirs].forEach(assertInScope);

  const removed: string[] = [];
  for (const rel of paths) {
    if (await isTracked(repoRoot, rel)) await git(repoRoot, ['rm', '-f', '--', rel]);
    else await rm(path.resolve(repoRoot, rel), { force: true });
    removed.push(rel);
  }
  for (const dir of dirs) {
    // git rm -r only works if something under the dir is tracked.
    try {
      await git(repoRoot, ['rm', '-r', '-f', '--', dir]);
    } catch {
      await rm(path.resolve(repoRoot, dir), { recursive: true, force: true });
    }
    removed.push(dir + '/');
  }

  const sha = (await hasStaged(repoRoot))
    ? (await git(repoRoot, ['commit', '-m', commitBody(subject)]), await shortSha(repoRoot))
    : null;
  return { sha, removed };
}

/** Replace the first H1 (`# …`) in a file, or prepend one. Commits the edit. */
export async function retitle(
  repoRoot: string,
  rel: string,
  newTitle: string,
  subject: string
): Promise<{ sha: string }> {
  assertInScope(rel);
  const title = newTitle.trim();
  if (!title) throw new Error('标题不能为空');
  const abs = path.resolve(repoRoot, rel);
  const content = await readFile(abs, 'utf8');
  const next = /^#\s+.+$/m.test(content)
    ? content.replace(/^#\s+.+$/m, `# ${title}`)
    : `# ${title}\n\n${content}`;
  await writeFile(abs, next, 'utf8');
  await git(repoRoot, ['add', '--', rel]);
  await git(repoRoot, ['commit', '-m', commitBody(subject)]);
  return { sha: await shortSha(repoRoot) };
}

/** Rename files via `git mv` (multiple, for trip-unit slug propagation). */
export async function renameEntries(
  repoRoot: string,
  renames: Array<{ from: string; to: string }>,
  subject: string
): Promise<{ sha: string; renamed: Array<{ from: string; to: string }> }> {
  for (const r of renames) {
    assertInScope(r.from);
    assertInScope(r.to);
  }
  for (const r of renames) {
    await mkdir(path.dirname(path.resolve(repoRoot, r.to)), { recursive: true });
    if (await isTracked(repoRoot, r.from)) {
      await git(repoRoot, ['mv', '-f', '--', r.from, r.to]);
    } else {
      // untracked: plain move then stage
      const { rename } = await import('node:fs/promises');
      await rename(path.resolve(repoRoot, r.from), path.resolve(repoRoot, r.to));
      await git(repoRoot, ['add', '--', r.to]);
    }
  }
  await git(repoRoot, ['commit', '-m', commitBody(subject)]);
  return { sha: await shortSha(repoRoot), renamed: renames };
}
