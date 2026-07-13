interface Step {
  key: string;
  label: string;
}

/** L1 — a compact horizontal step indicator (display only). */
export function Stepper({ steps, current, allDone }: { steps: Step[]; current: number; allDone?: boolean }) {
  return (
    <div className="chat-stepper">
      {steps.map((s, i) => {
        const done = i < current || allDone;
        const active = i === current && !allDone;
        return (
          <div key={s.key} className={`chat-step ${done ? 'done' : ''} ${active ? 'active' : ''}`}>
            <span className="chat-step-dot">{done ? '✓' : i + 1}</span>
            {s.label}
          </div>
        );
      })}
    </div>
  );
}
