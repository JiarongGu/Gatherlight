import { useEffect, useState } from 'react';
import type { Heading } from '@/lib/markdown';
import { revealAndScroll } from '@/shared/components/configured';

interface Props {
  headings: Heading[];
  onItemClick?: () => void;
}

/** L2 — table of contents with scroll-spy + reveal-into-collapsed-section jumps. */
export function TOC({ headings, onItemClick }: Props) {
  const [activeLine, setActiveLine] = useState<number | null>(null);

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

  return (
    <div className="toc">
      <h3 className="toc-title">目录</h3>
      <nav>
        {headings.map((h) => (
          <a
            key={`${h.line}-${h.text}`}
            href={`#h-${h.line}`}
            className={`toc-item lvl-${h.level} ${h.line === activeLine ? 'active' : ''}`}
            onClick={(e) => {
              e.preventDefault();
              revealAndScroll(`h-${h.line}`);
              setActiveLine(h.line);
              onItemClick?.();
            }}
          >
            {h.text}
          </a>
        ))}
      </nav>
    </div>
  );
}
