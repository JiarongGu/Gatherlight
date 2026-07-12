// L1 — small status/label pills. Reuse the existing class names so the visuals
// are byte-identical to the pre-refactor markup.

/** Category pill shown in a plan's header (旅游 / 日程 / …). */
export function CatBadge({ label }: { label: string }) {
  return <span className="cat-badge">{label}</span>;
}

export type TripStatus = 'upcoming' | 'ongoing' | 'past';

/** Trip countdown/status pill on Home cards. */
export function StatusBadge({ status, text }: { status: TripStatus; text: string }) {
  return <span className={`trip-badge ${status}`}>{text}</span>;
}

/** Inline keyboard key. */
export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd>{children}</kbd>;
}
