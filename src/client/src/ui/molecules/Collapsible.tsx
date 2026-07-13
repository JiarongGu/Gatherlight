import type { ReactNode } from 'react';

interface Props {
  summary: ReactNode; // the always-visible header (also the toggle)
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode; // collapsible body
}

/** L3 — a configurable collapsible section (native <details>). */
export function Collapsible({ summary, defaultOpen, className = '', children }: Props) {
  return (
    <details className={`md-section ${className}`} open={defaultOpen}>
      <summary className="md-section-summary">{summary}</summary>
      <div className="md-section-body">{children}</div>
    </details>
  );
}

/**
 * Scroll to a heading anchor, first opening any collapsed <details> it lives in
 * so jumps into a collapsed section land correctly.
 */
export function revealAndScroll(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  let p: HTMLElement | null = el;
  while (p) {
    if (p.tagName === 'DETAILS') (p as HTMLDetailsElement).open = true;
    p = p.parentElement;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
