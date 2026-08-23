import type { ReactNode } from 'react';

/**
 * A labelled control in the console: the label, then whatever the control is.
 *
 * The control is `children` rather than a prop because it is genuinely anything — text input, select,
 * textarea, or an input followed by a row of preset buttons. A molecule that tried to own the control
 * would need a discriminated union covering every form element the console uses, which is a worse
 * component than one that owns the LABEL RELATIONSHIP and nothing else.
 *
 * That relationship is the guarantee worth having. `<label>` wrapping the control is what associates
 * the two for a screen reader, and it is invisible when it is wrong: a `<div className="set-field">`
 * looks pixel-identical and silently drops the association. Seventeen hand-written copies all got it
 * right; none of the eighteenth's readers should have to know to.
 */
export function Field({ label, className, children }: {
  label: ReactNode;
  /** Extra class on the label, for the few places needing their own span/width. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`set-field${className ? ` ${className}` : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * A checkbox and its sentence.
 *
 * `onChange` hands back a BOOLEAN, not the event: every call site read exactly `e.target.checked` and
 * nothing else, and a component that passes the raw event invites one of them to reach for something
 * the others do not.
 *
 * `children` is optional because one caller — the per-job enable toggle — is a bare checkbox in a
 * table row with its meaning in a `title`. That is a legitimate use, so it is expressible rather than
 * worked around.
 */
export function CheckField({ checked, onChange, title, className, children }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title?: string;
  /** `tight` drops the row's margin, for a checkbox sitting inside another row. */
  className?: string;
  children?: ReactNode;
}) {
  return (
    <label className={`set-check${className ? ` ${className}` : ''}`} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}
