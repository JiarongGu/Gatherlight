import type { ButtonHTMLAttributes } from 'react';

/**
 * The management console's button.
 *
 * The console does not use the antd surface the planner does — it has its own lantern-paper look, so
 * its button is a native `<button>` carrying `.cx-btn` plus modifiers. That was written out by hand at
 * 32 call sites, each concatenating its own class string, which is the state atomic design exists to
 * end: a primitive of the design system should be a COMPONENT, so markup is composed rather than
 * retyped. Nothing had drifted yet — that is the point of doing it before something does.
 *
 * Native button props pass straight through (`onClick`, `disabled`, `title`, `type`), so this is a
 * drop-in for the element it replaces and adds no vocabulary of its own beyond the two visual axes
 * the CSS actually has.
 */
export function PanelButton({
  variant = 'default', compact = false, className, ...rest
}: {
  /** `primary` is the filled accent call-to-action; `ghost` is transparent until hovered. */
  variant?: 'default' | 'primary' | 'ghost';
  /** The tighter size used inside rows and cards. */
  compact?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ['cx-btn', compact ? 'compact' : '', variant === 'default' ? '' : variant, className ?? '']
    .filter(Boolean).join(' ');
  // `type="button"` by default: every one of these sits inside a form-ish panel and none of them
  // means "submit". A native button defaults to submit, which is a real trap in the jobs form.
  return <button type="button" {...rest} className={cls} />;
}
