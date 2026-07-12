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

const COLORS: Record<LineKind, { bg: string; fg: string }> = {
  add: { bg: 'rgba(63,185,80,0.14)', fg: '#7ee787' },
  del: { bg: 'rgba(248,81,73,0.14)', fg: '#ff9492' },
  hunk: { bg: 'transparent', fg: '#6aa0ff' },
  meta: { bg: 'transparent', fg: '#8d94a5' },
  ctx: { bg: 'transparent', fg: '#c9d1d9' }
};

/** L1 — one colorized unified-diff line. */
export function DiffLine({ line }: { line: string }) {
  const c = COLORS[classify(line)];
  return (
    <div style={{ background: c.bg, color: c.fg, padding: '0 8px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
      {line || ' '}
    </div>
  );
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
