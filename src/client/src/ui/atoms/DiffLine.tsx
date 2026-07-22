import { useMemo } from 'react';

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

function classify(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index '))
    return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

// Colors live in styles.css as theme tokens (--diff-*) so the diff stays legible in BOTH light and
// dark themes; the old hardcoded dark-theme colors washed out on the light rice-paper surface.
const KIND_CLASS: Record<LineKind, string> = {
  add: 'diff-add',
  del: 'diff-del',
  hunk: 'diff-hunk',
  meta: 'diff-meta',
  ctx: 'diff-ctx'
};

/** L1 — one colorized unified-diff line. */
export function DiffLine({ line }: { line: string }) {
  return <div className={`diff-line ${KIND_CLASS[classify(line)]}`}>{line || ' '}</div>;
}

/** L1 — a full colorized unified diff (splits into DiffLine rows). */
export function DiffBlock({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.replace(/\n$/, '').split('\n'), [diff]);
  return (
    <pre className="diff-view">
      {lines.map((line, i) => (
        <DiffLine key={i} line={line} />
      ))}
    </pre>
  );
}
