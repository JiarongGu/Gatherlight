import { useEffect, useRef, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';

interface Props {
  children: ReactNode;
  ariaLabel?: string;
  /** When this changes, the rail scrolls the element marked data-active="true" into view. */
  activeKey?: string | number | null;
}

/**
 * L3 — a horizontal scroller: ◀ ▶ arrow buttons, drag-to-scroll, hidden
 * scrollbar, and auto-centering of the active child. Consumers render any chips
 * as children and mark the active one with `data-active="true"`.
 */
export function Carousel({ children, ariaLabel, activeKey }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);
  const dragRef = useRef<{ x: number; left: number } | null>(null);

  useEffect(() => {
    const rail = railRef.current;
    const chip = rail?.querySelector<HTMLElement>('[data-active="true"]');
    if (!rail || !chip) return;
    // Center the active chip by scrolling ONLY the rail horizontally. Using
    // element.scrollIntoView() here would also scroll vertical ancestors
    // (.content-scroll), cancelling the in-flight smooth page scroll a day-nav
    // jump just started → the jump would get stuck partway.
    const railRect = rail.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    const delta = chipRect.left - railRect.left - (rail.clientWidth - chip.clientWidth) / 2;
    rail.scrollTo({ left: rail.scrollLeft + delta, behavior: 'smooth' });
  }, [activeKey]);

  const scrollBy = (dir: number) => railRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' });

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !railRef.current) return;
    dragRef.current = { x: e.clientX, left: railRef.current.scrollLeft };
    movedRef.current = false;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !railRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    if (Math.abs(dx) > 4) movedRef.current = true;
    railRef.current.scrollLeft = dragRef.current.left - dx;
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  return (
    <div className="carousel" aria-label={ariaLabel}>
      <button type="button" className="carousel-arrow" aria-label="向左" onClick={() => scrollBy(-1)}>
        ‹
      </button>
      <div
        className="carousel-rail"
        ref={railRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        // Suppress a child click that was actually a drag (capture phase).
        onClickCapture={(e) => {
          if (movedRef.current) {
            e.stopPropagation();
            e.preventDefault();
            movedRef.current = false;
          }
        }}
      >
        {children}
      </div>
      <button type="button" className="carousel-arrow" aria-label="向右" onClick={() => scrollBy(1)}>
        ›
      </button>
    </div>
  );
}
