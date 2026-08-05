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
