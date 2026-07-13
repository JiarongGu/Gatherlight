import { useEffect, useMemo, useState } from 'react';
import { SearchOutlined, EnvironmentOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { loadLibrary, KIND_LABEL, type LibraryItem, type LibraryFacets } from '@/lib/libraryApi';

// Route cover images through the server proxy — fetch-once, disk-cached, offline-safe.
const proxied = (url: string) => `/api/library/image?url=${encodeURIComponent(url)}`;

// The 知识库 gallery — verified reference entities from the DB, browsed read-only. Family-scale, so
// we load everything once and filter client-side (snappy chips + search, no round-trips).
export function Library() {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [facets, setFacets] = useState<LibraryFacets | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  const [kind, setKind] = useState<string | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const fetchData = () => {
    setStatus('loading');
    loadLibrary().then(
      (d) => {
        setItems(d.items);
        setFacets(d.facets);
        setStatus('ready');
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    );
  };
  useEffect(fetchData, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (kind && it.kind !== kind) return false;
      if (region && it.region !== region) return false;
      if (needle) {
        const hay = `${it.name} ${it.nameLocal ?? ''} ${it.summary ?? ''} ${it.tags ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [items, kind, region, q]);

  const total = facets?.total ?? 0;

  return (
    <div className="lib">
      <div className="lib-hero">
        <div className="lib-eyebrow">知识库 · Knowledge Library</div>
        <h1>
          核验过的<span className="accent">灵感</span>,可跨行程复用
        </h1>
        <p className="lib-sub">
          景点、餐厅、住宿与体验的可信资料 —— 由 AI 在规划时核验并沉淀到数据库,而非零散的 Markdown。
        </p>
      </div>

      {status === 'error' && (
        <div className="lib-empty">
          <div className="seal">!</div>
          <h3>加载失败</h3>
          <p>{error}</p>
          <button className="lib-chip" onClick={fetchData} style={{ marginTop: 12 }}>
            <ReloadOutlined /> 重试
          </button>
        </div>
      )}

      {status !== 'error' && (
        <>
          <div className="lib-toolbar">
            <label className="lib-search">
              <SearchOutlined />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索名称 / 简介 / 标签…"
                aria-label="搜索知识库"
              />
            </label>
            <div className="lib-filters">
              <Chip active={!kind} onClick={() => setKind(null)} label="全部" n={total} />
              {facets?.kinds.map((f) => (
                <Chip
                  key={f.value}
                  active={kind === f.value}
                  onClick={() => setKind((k) => (k === f.value ? null : f.value))}
                  label={KIND_LABEL[f.value] ?? f.value}
                  n={f.count}
                />
              ))}
            </div>
          </div>

          {facets && facets.regions.length > 1 && (
            <div className="lib-filters" style={{ marginBottom: 4 }}>
              <Chip active={!region} onClick={() => setRegion(null)} label="所有地区" />
              {facets.regions.map((f) => (
                <Chip
                  key={f.value}
                  active={region === f.value}
                  onClick={() => setRegion((r) => (r === f.value ? null : f.value))}
                  label={f.value}
                  n={f.count}
                />
              ))}
            </div>
          )}

          <div className="lib-groupbar">
            <h2>{kind ? KIND_LABEL[kind] ?? kind : '全部条目'}</h2>
            <span className="n">{filtered.length}</span>
          </div>

          {status === 'ready' && filtered.length === 0 ? (
            <div className="lib-empty">
              <div className="seal">拾</div>
              <h3>{total === 0 ? '知识库还是空的' : '没有匹配的条目'}</h3>
              <p>
                {total === 0
                  ? '让 AI 助手在规划时把核验过的景点/餐厅存进来 —— 它会调用 library_upsert 工具。'
                  : '换个筛选或搜索词试试。'}
              </p>
            </div>
          ) : (
            <div className="lib-grid">
              {filtered.map((it) => (
                <LibraryCard key={`${it.kind}:${it.key}`} item={it} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  n
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  n?: number;
}) {
  return (
    <button className={`lib-chip${active ? ' active' : ''}`} onClick={onClick}>
      {label}
      {n !== undefined && <span className="lib-chip-n">{n}</span>}
    </button>
  );
}

function LibraryCard({ item }: { item: LibraryItem }) {
  const glyph = (item.nameLocal ?? item.name).trim().charAt(0) || '拾';
  const pct = Math.round(Math.max(0, Math.min(1, item.confidence)) * 100);
  const tags = (item.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 3);
  const href = item.url ?? undefined;
  // If the proxied image fails (dead URL / offline first load), fall back to the glyph.
  const [imgOk, setImgOk] = useState(true);
  const showImg = !!item.imageUrl && imgOk;

  const inner = (
    <>
      <div className={`lib-card-media${showImg ? '' : ' empty'}`}>
        {showImg ? (
          <img src={proxied(item.imageUrl!)} alt={item.name} loading="lazy" onError={() => setImgOk(false)} />
        ) : (
          <span className="lib-card-glyph">{glyph}</span>
        )}
        <span className="lib-kind-tag">{KIND_LABEL[item.kind] ?? item.kind}</span>
      </div>
      <div className="lib-card-body">
        <div className="lib-card-name">{item.name}</div>
        {item.nameLocal && item.nameLocal !== item.name && (
          <div className="lib-card-local">{item.nameLocal}</div>
        )}
        {item.summary && <div className="lib-card-summary">{item.summary}</div>}
        {tags.length > 0 && (
          <div className="lib-tags">
            {tags.map((t) => (
              <span className="lib-tag" key={t}>
                {t}
              </span>
            ))}
          </div>
        )}
        <div className="lib-card-foot">
          {item.region && (
            <span className="lib-card-region">
              <EnvironmentOutlined />
              {item.region}
            </span>
          )}
          {href && <LinkOutlined title="有官方链接" />}
          <span className="lib-conf" title={`置信度 ${pct}%`}>
            <span className="lib-conf-track">
              <span className="lib-conf-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="lib-conf-val">{pct}</span>
          </span>
        </div>
      </div>
    </>
  );

  return href ? (
    <a className="lib-card" href={href} target="_blank" rel="noopener noreferrer" title={`打开官网 · ${item.name}`}>
      {inner}
    </a>
  ) : (
    <div className="lib-card" style={{ cursor: 'default' }}>
      {inner}
    </div>
  );
}
