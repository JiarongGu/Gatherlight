import path from 'node:path';

/**
 * Accumulates the set of repo-relative file paths the agent wrote during a run,
 * read from the Edit/Write/MultiEdit/NotebookEdit tool_use events. The backend
 * stages + commits exactly these paths, so pre-existing unrelated working-tree
 * changes are never swept into the chat agent's commit.
 */
export class EditTracker {
  private readonly repoRoot: string;
  private readonly paths = new Set<string>();

  constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  /** Feed a tool_use block; records the path if it's a file-writing tool. */
  record(toolName: string, input: Record<string, unknown> | undefined): void {
    if (!input) return;
    if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return;
    const raw =
      (input.file_path as string) ??
      (input.notebook_path as string) ??
      (input.path as string);
    if (!raw) return;
    const abs = path.isAbsolute(raw) ? raw : path.resolve(this.repoRoot, raw);
    const rel = path.relative(this.repoRoot, abs).split(path.sep).join('/');
    if (rel && !rel.startsWith('..')) this.paths.add(rel);
  }

  list(): string[] {
    return [...this.paths].sort();
  }

  has(predicate: (p: string) => boolean): boolean {
    return this.list().some(predicate);
  }
}
