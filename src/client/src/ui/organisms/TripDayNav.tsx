import { useEffect, useMemo, useState } from 'react';
import type { Heading } from '@/lib/markdown';
import { DayChip } from '@/ui/atoms';
import { Carousel, revealAndScroll } from '@/ui/molecules';

interface Props {
  headings: Heading[];
  onJump?: () => void;
}

interface DayItem {
  line: number;
  n: number;
  label: string;
  date: string | null;
  weekday: string | null;
}

const DAY_RE = /\bDay\s+(\d+)\b/;
const DATE_RE = /\d{4}-(\d{2})-(\d{2})/;
const WEEKDAY_RE = /\((Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i;
const WEEKDAY_CJK: Record<string, string> = {
  mon: '一', tue: '二', wed: '三', thu: '四', fri: '五', sat: '六', sun: '日'
};

/** Short display label for a section chip (full text stays in the tooltip). */
function sectionLabel(text: string): string {
  const head = text.split(/[(（/|]|\s[—-]\s/)[0].trim();
  return head.length > 14 ? head.slice(0, 13) + '…' : head;
}

/**
 * L2 — sticky trip nav. Row 1: jump to any H2 SECTION (carousel of section chips).
 * Row 2: jump directly to any DAY (carousel of DayChips). Both reveal-and-scroll
 * (open a collapsed section first) and highlight via scroll-spy. Renders nothing
 * for fewer than 2 day headings.
 */
export function TripDayNav({ headings, onJump }: Props) {
  const days = useMemo<DayItem[]>(() => {
    const out: DayItem[] = [];
    for (const h of headings) {
      const m = h.text.match(DAY_RE);
      if (!m) continue;
      const dm = h.text.match(DATE_RE);
      const wm = h.text.match(WEEKDAY_RE);
      out.push({
        line: h.line,
        n: parseInt(m[1], 10),
        label: h.text,
        date: dm ? `${parseInt(dm[1], 10)}·${parseInt(dm[2], 10)}` : null,
        weekday: wm ? WEEKDAY_CJK[wm[1].toLowerCase()] ?? null : null
      });
    }
    return out;
  }, [headings]);

  const sections = useMemo(
    () => headings.filter((h) => h.level === 2).map((h) => ({ line: h.line, label: sectionLabel(h.text), full: h.text })),
    [headings]
  );

  const [activeLine, setActiveLine] = useState<number | null>(null);

  // Scroll-spy over ALL headings → the topmost visible drives both rows' highlight.
  useEffect(() => {
    const els = Array.from(
      document.querySelectorAll<HTMLElement>('.markdown h1, .markdown h2, .markdown h3')
    );
    if (!els.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting).map((e) => e.target as HTMLElement);
        if (!visible.length) return;
        const topmost = visible.reduce((a, b) =>
          a.getBoundingClientRect().top < b.getBoundingClientRect().top ? a : b
        );
        const line = parseInt(topmost.id.replace('h-', ''), 10);
        if (Number.isFinite(line)) setActiveLine(line);
      },
      { rootMargin: '0px 0px -68% 0px', threshold: 0 }
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [headings]);

  if (days.length < 2) return null;

  const jump = (line: number) => {
    revealAndScroll(`h-${line}`);
    setActiveLine(line);
    onJump?.();
  };

  return (
    <nav className="trip-day-nav no-print" aria-label="行程导航">
      <div className="trip-day-nav-inner">
        {/* Row 1 — section jumps */}
        <div className="trip-day-nav-row">
          <span className="trip-day-nav-label">📑 章节</span>
          <div className="trip-day-nav-rail-wrap">
            <Carousel ariaLabel="章节" activeKey={activeLine}>
              {sections.map((s) => (
                <button
                  key={s.line}
                  type="button"
                  title={s.full}
                  data-active={s.line === activeLine ? 'true' : undefined}
                  className={`trip-section-chip ${s.line === activeLine ? 'active' : ''}`}
                  onClick={() => jump(s.line)}
                >
                  {s.label}
                </button>
              ))}
            </Carousel>
          </div>
        </div>
        {/* Row 2 — day jumps */}
        <div className="trip-day-nav-row">
          <span className="trip-day-nav-label">
            📅 每日 <span className="trip-day-nav-count">{days.length} 天</span>
          </span>
          <div className="trip-day-nav-rail-wrap">
            <Carousel ariaLabel="每日行程" activeKey={activeLine}>
              {days.map((d) => (
                <DayChip
                  key={d.line}
                  n={d.n}
                  date={d.date}
                  weekday={d.weekday}
                  label={d.label}
                  active={d.line === activeLine}
                  onClick={() => jump(d.line)}
                />
              ))}
            </Carousel>
          </div>
        </div>
      </div>
    </nav>
  );
}
