import { forwardRef } from 'react';

interface Props {
  n: number; // day number
  date?: string | null; // "9·5"
  weekday?: string | null; // CJK single char, e.g. "六"
  label?: string; // tooltip (full heading)
  active?: boolean;
  onClick?: () => void;
}

/** L1 — a single day chip (Day N + optional date/weekday). Display + onClick. */
export const DayChip = forwardRef<HTMLButtonElement, Props>(function DayChip(
  { n, date, weekday, label, active, onClick },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      data-active={active ? 'true' : undefined}
      className={`trip-day-chip ${date ? 'has-date' : ''} ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      <span className="trip-day-chip-n">Day {n}</span>
      {date && (
        <span className="trip-day-chip-date">
          {date}
          {weekday && <span className="trip-day-chip-wd"> 周{weekday}</span>}
        </span>
      )}
    </button>
  );
});
