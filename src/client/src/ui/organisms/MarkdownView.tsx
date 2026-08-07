import { Children, isValidElement, memo, useMemo, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkLegacyMaps } from '@/ui/blocks/legacyMaps';
import { remoteImage } from '@/lib/images';
import { Image } from '@/ui/atoms';
import { Collapsible } from '@/ui/molecules';
import { TripMap } from './TripMap';
import { CityMap } from './CityMap';

interface Props {
  source: string;
  /** Trip pages: wrap each H2 section in a collapsible <details> (intro collapsed). */
  collapsible?: boolean;
}

/** Flatten a heading's children (text / <strong> / emoji) to a plain string. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

const DAY_HEADING_RE = /\bDay\s+(\d+)\b/;
const dayClass = (children: ReactNode) => (DAY_HEADING_RE.test(nodeText(children)) ? 'is-day' : undefined);
const dayNumber = (children: ReactNode): string | undefined => {
  const m = nodeText(children).match(DAY_HEADING_RE);
  return m ? m[1] : undefined;
};

// Stable anchor id from the heading's source line — deterministic + pure (no
// render-time counter, so it survives React StrictMode's double render).
function lineId(node: unknown): string | undefined {
  const line = (node as { position?: { start?: { line?: number } } })?.position?.start?.line;
  return typeof line === 'number' ? `h-${line}` : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mdText(node: any): string {
  if (node?.value) return node.value;
  if (node?.children) return node.children.map(mdText).join('');
  return '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function section(children: any[], open: boolean) {
  return {
    type: 'section',
    children,
    data: { hName: 'section', hProperties: { className: ['md-section'], 'data-open': open ? 'true' : 'false' } }
  };
}
function synthHeading(text: string) {
  return { type: 'heading', depth: 2, children: [{ type: 'text', value: text }] };
}

// remark plugin: group each top-level H2 + its content (incl. H3 days) into a
// collapsible <section>. "Day-by-day" opens by default; intro sections AND the
// leading preamble (一句话 / 摘要, wrapped under a synthetic "概览" heading) start
// collapsed — so opening a trip lands on the itinerary.
function remarkSectionizeH2() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    if (!tree.children.some((n: any) => n.type === 'heading' && n.depth === 2)) return;
    const out: any[] = [];
    const preamble: any[] = [];
    let cur: any = null;
    for (const node of tree.children) {
      if (node.type === 'heading' && node.depth === 2) {
        if (!cur && preamble.length) out.push(section([synthHeading('📋 概览 / 摘要'), ...preamble], false));
        const open = /day-by-day|每日行程|day by day/i.test(mdText(node));
        cur = section([node], open);
        out.push(cur);
      } else if (cur) cur.children.push(node);
      else preamble.push(node);
    }
    tree.children = out;
  };
}

const FALLBACK_SVG =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='120'%3E%3Crect width='200' height='120' fill='%231d2230'/%3E%3Ctext x='100' y='60' text-anchor='middle' alignment-baseline='middle' fill='%238d94a5' font-size='12' font-family='sans-serif'%3E[图片加载失败]%3C/text%3E%3C/svg%3E";

// react-markdown's plugin lists + component map are referentially stable across
// renders (memoized below) so react-markdown's internal processor cache isn't
// busted on every parent re-render. Combined with React.memo on the component,
// an 88KB trip doc (+ its Leaflet maps) is only re-parsed when source/collapsible
// actually change — not on every shell state toggle (chat / ⌘K / theme / resize).
type MdComponents = ComponentProps<typeof ReactMarkdown>['components'];

// There is NO raw-HTML stage here — no rehype plugins at all. react-markdown turns every leftover
// raw node into a TEXT node, so markup an agent (or an injected web page) writes into a plan
// document is displayed, never parsed — which is also why there is no sanitize allow-list left to
// keep correct. The one thing that used to need raw HTML, the `trip-map`/`city-map` divs in documents
// written before S3a, is handled by `remarkLegacyMaps`: remark sees those as `html` nodes in the
// mdast tree and swaps them for real map nodes before rehype ever runs.

export const MarkdownView = memo(function MarkdownView({ source, collapsible }: Props) {
  const remarkPlugins = useMemo(
    () => (collapsible ? [remarkGfm, remarkSectionizeH2, remarkLegacyMaps] : [remarkGfm, remarkLegacyMaps]),
    [collapsible]
  );

  const components = useMemo<MdComponents>(
    () => ({
      ...(collapsible
        ? {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            section: ({ children, ...p }: any) => {
              const arr = Children.toArray(children as ReactNode);
              return (
                <Collapsible summary={arr[0]} defaultOpen={p['data-open'] === 'true'}>
                  {arr.slice(1)}
                </Collapsible>
              );
            }
          }
        : {}),
      h1: ({ node, children, ...rest }) => (
        <h1 id={lineId(node)} {...(rest as Record<string, unknown>)}>
          {children}
        </h1>
      ),
      h2: ({ node, children, ...rest }) => (
        <h2 id={lineId(node)} className={dayClass(children)} data-day={dayNumber(children)} {...(rest as Record<string, unknown>)}>
          {children}
        </h2>
      ),
      h3: ({ node, children, ...rest }) => (
        <h3 id={lineId(node)} className={dayClass(children)} data-day={dayNumber(children)} {...(rest as Record<string, unknown>)}>
          {children}
        </h3>
      ),
      // A remote picture in a plan goes through the same-origin proxy, like every other remote image
      // the app renders — so opening a document never has the browser calling the host that wrote it.
      img: ({ src, alt, ...rest }) => (
        <Image
          src={remoteImage(src as string)}
          alt={alt as string | undefined}
          fallback={FALLBACK_SVG}
          style={{ maxWidth: '100%', borderRadius: 6, margin: '12px 0' }}
          preview={{ mask: '点击预览' }}
          {...(rest as Record<string, unknown>)}
        />
      ),
      // The custom element `remarkLegacyMaps` synthesizes. Not an HTML tag, hence the cast on the
      // map below — react-markdown's `Components` is keyed by intrinsic element names.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'legacy-map': ({ node, ...rest }: any) => {
        let cfg: { cities?: string[]; pointsRaw?: string; connect?: boolean; title?: string } = {};
        try { cfg = JSON.parse((rest as Record<string, string>)['data-config'] ?? '{}'); } catch { /* keep {} */ }
        if (cfg.cities?.length) return <TripMap cities={cfg.cities} />;
        return <CityMap pointsRaw={cfg.pointsRaw ?? ''} connect={Boolean(cfg.connect)} title={cfg.title} />;
      }
    }) as MdComponents,
    [collapsible]
  );

  return (
    <article className="markdown">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {source}
      </ReactMarkdown>
    </article>
  );
});
