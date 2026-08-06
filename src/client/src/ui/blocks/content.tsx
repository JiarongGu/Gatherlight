import { Table as AntTable, Tag, Image as AntImage } from '@/ui/atoms';
import { CityMap } from '@/ui/organisms/CityMap';
import { TripMap } from '@/ui/organisms/TripMap';
import type { UiNodeProps } from './registry';

const TONE: Record<string, string> = {
  default: 'inherit', muted: 'var(--muted)',
  positive: 'var(--success)', warning: 'var(--warn)',
};

export function Heading({ node }: UiNodeProps) {
  const level = Number(node.level ?? 2);
  const Tag_ = (level === 4 ? 'h4' : level === 3 ? 'h3' : 'h2') as 'h2' | 'h3' | 'h4';
  return <Tag_>{String(node.text)}</Tag_>;
}

export function Text({ node }: UiNodeProps) {
  return (
    <p style={{
      margin: 0,
      fontWeight: node.weight === 'bold' ? 600 : 400,
      color: TONE[String(node.tone ?? 'default')],
    }}>{String(node.text)}</p>
  );
}

export function List({ node }: UiNodeProps) {
  const items = (node.items as string[]) ?? [];
  const children = items.map((it, i) => <li key={i}>{it}</li>);
  return node.ordered ? <ol>{children}</ol> : <ul>{children}</ul>;
}

export function Badge({ node }: UiNodeProps) {
  const tone = String(node.tone ?? 'default');
  const color = tone === 'positive' ? 'green' : tone === 'warning' ? 'orange' : tone === 'muted' ? 'default' : 'blue';
  return <Tag color={color}>{String(node.text)}</Tag>;
}

export function Image({ node }: UiNodeProps) {
  const src = String(node.src);
  // A record path is served by the narrow asset route added in Task 2 (image MIME types only,
  // inside the site, no symlinks); https URLs pass straight through.
  const url = src.startsWith('https://')
    ? src
    : `/api/ui/asset/${src.split('/').map(encodeURIComponent).join('/')}`;
  return (
    <figure style={{ margin: 0 }}>
      <AntImage src={url} alt={(node.alt as string) ?? ''} style={{ maxWidth: '100%', borderRadius: 6 }} />
      {node.caption ? <figcaption className="ui-caption">{String(node.caption)}</figcaption> : null}
    </figure>
  );
}

export function Table({ node }: UiNodeProps) {
  const columns = ((node.columns as string[]) ?? []).map((c, i) => ({ title: c, dataIndex: String(i), key: String(i) }));
  const rows = ((node.rows as string[][]) ?? []).map((r, ri) => {
    const rec: Record<string, string> = { key: String(ri) };
    r.forEach((cell, ci) => { rec[String(ci)] = cell; });
    return rec;
  });
  return (
    <div style={{ overflowX: 'auto' }}>
      <AntTable size="small" pagination={false} columns={columns} dataSource={rows} />
      {node.caption ? <div className="ui-caption">{String(node.caption)}</div> : null}
    </div>
  );
}

/**
 * Inline SVG, no chart library. Two reasons rather than one: the CSP forbids anything a CDN would
 * serve, and a bar chart of a family budget is a hundred lines of layout, not a dependency.
 *
 * Values are drawn against `max(values)`, never against a fitted axis, so a bar's length is a
 * truthful fraction of the largest thing on the chart. Negative values would make that claim false,
 * so the baseline is pinned to zero and the domain never floats.
 */
export function Chart({ node }: UiNodeProps) {
  const labels = (node.labels as string[]) ?? [];
  const values = (node.values as number[]) ?? [];
  const unit = node.unit ? String(node.unit) : '';
  const n = Math.min(labels.length, values.length);
  if (n === 0) return <div className="ui-caption">(无数据 · no data)</div>;

  const max = Math.max(...values.slice(0, n), 0) || 1;
  const line = node.kind === 'line';
  const W = 480, H = 180, PAD_L = 8, PAD_B = 26, PAD_T = 8;
  const plotH = H - PAD_B - PAD_T;
  const step = (W - PAD_L * 2) / n;
  const fmt = (v: number) => `${v.toLocaleString()}${unit ? ` ${unit}` : ''}`;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
        aria-label={labels.slice(0, n).map((l, i) => `${l}: ${fmt(values[i])}`).join('; ')}>
        <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_L} y2={H - PAD_B} stroke="var(--border)" />
        {line ? (
          <polyline
            fill="none" stroke="var(--accent)" strokeWidth={2}
            points={Array.from({ length: n }, (_, i) =>
              `${PAD_L + step * (i + 0.5)},${PAD_T + plotH - (values[i] / max) * plotH}`).join(' ')}
          />
        ) : (
          Array.from({ length: n }, (_, i) => {
            const h = (values[i] / max) * plotH;
            return (
              <rect key={i} x={PAD_L + step * i + step * 0.15} y={PAD_T + plotH - h}
                width={step * 0.7} height={Math.max(h, 1)} fill="var(--accent)" rx={2}>
                <title>{`${labels[i]}: ${fmt(values[i])}`}</title>
              </rect>
            );
          })
        )}
        {Array.from({ length: n }, (_, i) => (
          <text key={i} x={PAD_L + step * (i + 0.5)} y={H - PAD_B + 14}
            textAnchor="middle" fontSize={10} fill="var(--muted)">
            {labels[i].length > 8 ? `${labels[i].slice(0, 7)}…` : labels[i]}
          </text>
        ))}
      </svg>
      {node.caption ? <div className="ui-caption">{String(node.caption)}</div> : null}
    </div>
  );
}

export function Map({ node }: UiNodeProps) {
  const cities = (node.cities as string[]) ?? [];
  if (cities.length > 0) return <TripMap cities={cities} />;
  const points = (node.points as { name?: string; lat: number; lng: number }[]) ?? [];
  // CityMap.parsePoints reads "lat,lng|label" lines separated by newline or semicolon — verified
  // against src/client/src/ui/organisms/CityMap.tsx:14. Do not reorder these fields.
  const raw = points.map((p) => `${p.lat},${p.lng}|${p.name ?? ''}`).join(';');
  return <CityMap pointsRaw={raw} connect={Boolean(node.connect)} title={node.title as string | undefined} />;
}

export function Link({ node }: UiNodeProps) {
  const href = String(node.href);
  let host = '';
  try { host = new URL(href).host; } catch { host = ''; }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {String(node.text)}{host ? <span className="ui-link-host"> ({host})</span> : null}
    </a>
  );
}

export function FileRef({ node, onOpenRecord }: UiNodeProps) {
  const path = String(node.path);
  return (
    <button type="button" className="ui-fileref" onClick={() => onOpenRecord?.(path)}>
      {String(node.label ?? path)}
    </button>
  );
}
