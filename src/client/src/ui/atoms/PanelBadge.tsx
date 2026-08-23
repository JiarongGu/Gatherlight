import type { ReactNode } from 'react';

/**
 * A small pill in the management console. `kind` is the ROLE, not the look — the two are genuinely
 * different primitives that happened to both be spelled as a `<span>` with a class:
 *
 *  · `note`  (.cx-badge)  — annotates a heading with something about it: 已自定义 · LLM. Accent-filled,
 *                           and carries its own left margin because it always follows a title.
 *  · `state` (.res-badge) — states what something IS: 已安装 · 运行中 · 内置 · GPU 可用. Mono and outlined,
 *                           no margin, because it sits in a row of them.
 *
 * They were not merged into one styled pill with a `tone` prop, because a caller choosing between
 * "accent" and "outline" is choosing an appearance; a caller choosing between "note" and "state" is
 * saying what the pill MEANS, and the appearance follows from that. If the design changes, one of
 * these moves and the call sites do not.
 */
export function PanelBadge({ kind, children }: { kind: 'note' | 'state'; children: ReactNode }) {
  return <span className={kind === 'note' ? 'cx-badge' : 'res-badge'}>{children}</span>;
}
