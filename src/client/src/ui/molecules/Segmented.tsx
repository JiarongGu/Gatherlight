import type { ReactNode } from 'react';

/** One choice in a {@link Segmented}. */
export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Native tooltip — the console uses it to spell out what a terse label means. */
  title?: string;
  /**
   * Can this choice actually be taken? `false` dims it and marks it `na`, and — the load-bearing part
   * — leaves it PRESSABLE. See the class note in Segmented's own comment.
   */
  available?: boolean;
};

/**
 * The console's segmented control: one row of buttons, one of them `on`.
 *
 * It existed FOUR times by hand — the backend picker, cortex's model routing, the jobs schedule
 * toggle, the settings access mode — each re-deriving `cx-seg-b${active ? ' on' : ''}`. They were
 * identical except for one thing, and that one thing is why this component has an `available` flag
 * rather than reusing `disabled`:
 *
 * AN UNAVAILABLE CHOICE STAYS PRESSABLE. In the backend picker a layer lists every backend, including
 * ones it cannot use, and pressing such a button is how the household READS THE REASON it cannot.
 * `disabled` would swallow the click, leaving a dimmed control that answers "why isn't this an option?"
 * nowhere — the exact failure the list-everything design exists to prevent. So `available: false`
 * styles the button (`na`) and nothing more; whether a press is meaningful is the caller's business.
 * `disabled` is separate and means what it says: the control is busy or inert.
 *
 * Generic over the value type so a caller's own union survives — `onSelect` hands back `'lan'`, not
 * `string`.
 */
export function Segmented<T extends string>({
  options, value, onSelect, disabled, className,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onSelect: (v: T) => void;
  disabled?: boolean;
  /** Extra class on the row, for the few places that need their own width/spacing. */
  className?: string;
}) {
  return (
    <div className={`cx-seg${className ? ` ${className}` : ''}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`cx-seg-b${o.value === value ? ' on' : ''}${o.available === false ? ' na' : ''}`}
          title={o.title}
          disabled={disabled}
          onClick={() => onSelect(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
