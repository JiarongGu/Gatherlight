import { useEffect, useRef, useState } from 'react';

// The desktop host injects window.__gatherlightHost + a WebView2 message bridge for native actions
// (restart / open data folder / open planner in browser / exit / memory file dialogs). Opened in a
// plain browser, the page still monitors health + counts and does what it can in-page.
const inHost = typeof window !== 'undefined' && (window as { __gatherlightHost?: boolean }).__gatherlightHost === true;
function host(action: string) {
  try {
    (window as unknown as { chrome?: { webview?: { postMessage(m: string): void } } }).chrome?.webview?.postMessage(action);
  } catch {
    /* not in the host */
  }
}

const STRIP = 44;

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export function Manage() {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [latency, setLatency] = useState(0);
  const [strip, setStrip] = useState<boolean[]>([]);
  const [counts, setCounts] = useState<{ plans?: number; library?: number; tools?: number }>({});
  const [uptime, setUptime] = useState('0s');
  const [view, setView] = useState<'overview' | 'eval' | 'cortex'>('overview');
  const started = useRef(Date.now());

  useEffect(() => {
    let mounted = true;
    let tick = 0;
    const refreshCounts = async () => {
      const num = async (path: string, pick: (d: any) => number) => {
        try { return pick(await (await fetch(path)).json()); } catch { return undefined; }
      };
      const [plans, library, tools] = await Promise.all([
        num('/api/plans', (d) => (d.files || []).length),
        num('/api/library', (d) => d.facets?.total ?? 0),
        num('/api/tools', (d) => (d.tools || []).length),
      ]);
      if (mounted) setCounts({ plans, library, tools });
    };
    const poll = async () => {
      const t0 = performance.now();
      let ok = false;
      try { ok = (await fetch('/api/health')).ok; } catch { ok = false; }
      if (!mounted) return;
      setHealthy(ok);
      setLatency(Math.round(performance.now() - t0));
      setStrip((s) => [...s, ok].slice(-STRIP));
      setUptime(fmtUptime(Date.now() - started.current));
      if (ok && tick % 3 === 0) refreshCounts();
      tick++;
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { mounted = false; clearInterval(id); };
  }, []);

  const plannerUrl = `${location.origin}/`;
  const openPlanner = () => (inHost ? host('openPlanner') : window.open(plannerUrl, '_blank'));

  const exportMemory = () => {
    if (inHost) host('exportMemory');
    else window.open('/api/memory/export', '_blank');
  };
  const importMemory = () => {
    if (inHost) { host('importMemory'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const res = await fetch('/api/memory/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: await file.text() });
        const j = await res.json();
        alert(res.ok ? `已导入:${JSON.stringify(j.imported)}` : `导入失败:${j.error ?? res.status}`);
      } catch (e) {
        alert('导入失败:' + (e instanceof Error ? e.message : String(e)));
      }
    };
    input.click();
  };

  const hColor = healthy === null ? 'var(--muted)' : healthy ? 'var(--success)' : 'var(--danger)';
  const statusText = healthy === null ? '检查中…' : healthy ? '运行正常 · Healthy' : '无响应 · Not responding';

  const N = (v?: number) => (v === undefined ? '—' : v.toLocaleString());

  return (
    <div className="mng" style={{ minHeight: '100vh' }}>
      <div className="mng-top">
        <span className="seal">拾</span>
        <div>
          <h1>管理控制台</h1>
          <span className="sub">GATHERLIGHT · CONSOLE</span>
        </div>
        <span className="ver">拾光</span>
      </div>

      <div className="mng-tabs">
        <button className={`mng-tab${view === 'overview' ? ' on' : ''}`} onClick={() => setView('overview')}>概览 · Overview</button>
        <button className={`mng-tab${view === 'eval' ? ' on' : ''}`} onClick={() => setView('eval')}>对话评估 · Eval</button>
        <button className={`mng-tab${view === 'cortex' ? ' on' : ''}`} onClick={() => setView('cortex')}>校准 · Cortex</button>
      </div>

      {view === 'eval' && <EvalView />}
      {view === 'cortex' && <CortexView />}

      {view === 'overview' && (
      <>
      <div className={`mng-health${healthy ? ' ok' : ''}`} style={{ ['--h' as any]: hColor }}>
        <div className="mng-health-row">
          <span className="mng-lantern" />
          <div className="mng-status">
            <div className="t" style={{ color: healthy === false ? 'var(--danger)' : 'var(--text)' }}>{statusText}</div>
            <div className="d">
              {healthy ? `延迟 ${latency} ms · 站点自检每 2 秒` : healthy === null ? '连接本地服务…' : '本地服务未响应,可尝试「重启服务」'}
            </div>
          </div>
          <div className="mng-uptime">
            <div className="n">{uptime}</div>
            <div className="l">运行时长</div>
          </div>
        </div>
        <div className="mng-strip">
          {Array.from({ length: STRIP }).map((_, i) => {
            const idx = i - (STRIP - strip.length);
            const v = idx >= 0 ? strip[idx] : undefined;
            return <i key={i} className={v === undefined ? '' : v ? 'ok' : 'bad'} />;
          })}
        </div>
      </div>

      <div className="mng-metrics">
        <div className="mng-metric"><div className="n">{N(counts.plans)}</div><div className="l">计划 Plans</div></div>
        <div className="mng-metric"><div className="n">{N(counts.library)}</div><div className="l">知识库 Library</div></div>
        <div className="mng-metric"><div className="n">{N(counts.tools)}</div><div className="l">工具 Tools</div></div>
      </div>

      <div className="mng-title">操作 · Controls</div>
      <div className="mng-actions">
        <button className="mng-btn primary" onClick={openPlanner}>在浏览器打开规划界面</button>
        {inHost && (
          <button className="mng-btn" onClick={() => host('openDataFolder')}>
            打开数据文件夹<span className="sub">plans · household · 知识库 · SQLite</span>
          </button>
        )}
        {inHost && (
          <button className="mng-btn" onClick={() => host('restart')}>
            重启服务<span className="sub">recycle the in-process server</span>
          </button>
        )}
        <button className="mng-btn" onClick={exportMemory}>
          导出记忆<span className="sub">知识库 + 事实 → 可迁移文件</span>
        </button>
        <button className="mng-btn" onClick={importMemory}>
          导入记忆<span className="sub">合并另一台机器的记忆</span>
        </button>
        {inHost && (
          <button className="mng-btn danger" onClick={() => host('exit')}>
            退出<span className="sub">stop the server + quit</span>
          </button>
        )}
      </div>

      <div className="mng-meta">
        端口 {location.port || '5317'} · 站点 {plannerUrl}
        <br />
        规划界面在浏览器中打开;此页监控本机服务的健康。数据(计划/家庭/知识库/SQLite)在数据文件夹,数据库不进 git,请随数据文件夹备份。
      </div>
      {!inHost && <div className="mng-hint">提示:部分主机操作(重启 / 数据文件夹 / 退出)仅在桌面管理端可用。</div>}
      </>
      )}
    </div>
  );
}

// ---- Eval / observability view (conversation rankings + tuning dataset) ----
interface Conversation {
  id: string;
  phase: string;
  mode: string;
  userMessage?: string | null;
  commitSha?: string | null;
  error?: string | null;
  createdAt: string;
  rating?: number | null;
  note?: string | null;
}
interface Stats {
  total: number;
  rated: number;
  avgRating: number;
  distribution: { rating: number; count: number }[];
}

function EvalView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [s, c] = await Promise.all([
        fetch('/api/manage/stats').then((r) => r.json()),
        fetch('/api/manage/conversations?limit=100').then((r) => r.json()),
      ]);
      setStats(s);
      setRows(c.conversations ?? []);
    } catch {
      /* leave empty */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const maxDist = Math.max(1, ...(stats?.distribution ?? []).map((d) => d.count));
  const distByStar = (n: number) => stats?.distribution.find((d) => d.rating === n)?.count ?? 0;

  return (
    <div>
      <div className="eval-stats">
        <div className="eval-stat"><div className="n">{stats?.total ?? '—'}</div><div className="l">对话总数 Conversations</div></div>
        <div className="eval-stat"><div className="n">{stats?.rated ?? '—'}</div><div className="l">已评分 Rated</div></div>
        <div className="eval-stat"><div className="n">{stats?.avgRating ? stats.avgRating.toFixed(2) : '—'}<small> / 5</small></div><div className="l">平均分 Avg rating</div></div>
        <div className="eval-stat">
          <div className="eval-bar">
            {[5, 4, 3, 2, 1].map((n) => (
              <span className="b" key={n} title={`${n}★ · ${distByStar(n)}`}>
                <span style={{ ['--h' as any]: `${(distByStar(n) / maxDist) * 100}%` }} />
              </span>
            ))}
          </div>
          <div className="l">评分分布 5★→1★</div>
        </div>
      </div>

      <div className="eval-toolbar">
        <h2>对话记录</h2>
        <button className="eval-export" onClick={() => window.open('/api/manage/eval/export', '_blank')}>导出评估数据集 (JSONL)</button>
      </div>

      {loading ? (
        <div className="eval-empty">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="eval-empty">还没有对话。用规划界面的 AI 助手对话,结束后为它打分,数据会出现在这里。</div>
      ) : (
        <div className="eval-list">
          {rows.map((c) => (
            <div className="eval-row" key={c.id}>
              <div className="eval-row-main">
                <div className="eval-row-msg">{c.userMessage || '(空)'}</div>
                <div className="eval-row-meta">
                  <span className="phase">{c.phase}</span>
                  {c.mode === 'system' && <span>系统模式</span>}
                  {c.commitSha && <span className="k">{c.commitSha.slice(0, 7)}</span>}
                  <span>{c.createdAt.slice(0, 16).replace('T', ' ')}</span>
                </div>
                {c.note && <div className="eval-row-note">“{c.note}”</div>}
              </div>
              {c.rating ? (
                <div className="eval-row-rating">
                  <span className="on">{'★'.repeat(c.rating)}</span>
                  <span className="off">{'★'.repeat(5 - c.rating)}</span>
                </div>
              ) : (
                <div className="eval-row-rating unrated">未评分</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Cortex tuning view (prompt-template + model-routing overrides) ----
interface PromptItem {
  name: string;
  label: string;
  description: string;
  group: string;
  placeholders: string[];
  default: string;
  override: string | null;
  effective: string;
  overridden: boolean;
}
interface ModelItem {
  consumer: string;
  label: string;
  description: string;
  default: string | null;
  override: string | null;
  effective: string | null;
  overridden: boolean;
  suggestions: string[];
}

const GROUP_LABELS: Record<string, string> = {
  planner: '规划闸门 · Planner gates',
  validation: '智库校验 · Validation',
  utility: '工具 · Utility',
  system: '系统模式 · System mode',
};
const GROUP_ORDER = ['planner', 'validation', 'utility', 'system'];
const modelLabel = (v: string | null) => (v && v.length ? v : 'CLI 默认');

function CortexView() {
  const [prompts, setPrompts] = useState<PromptItem[]>([]);
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const d = await (await fetch('/api/manage/cortex')).json();
      setPrompts(d.prompts ?? []);
      setModels(d.models ?? []);
    } catch {
      /* leave empty */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const expand = (p: PromptItem) => {
    if (open === p.name) {
      setOpen(null);
      return;
    }
    setOpen(p.name);
    setDraft(p.effective);
    setErr(null);
  };

  const savePrompt = async (p: PromptItem) => {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(`/api/manage/cortex/prompt/${p.name}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: draft }),
      });
      if (res.ok) {
        setOpen(null);
        await load();
      } else {
        const j = await res.json().catch(() => ({}));
        setErr(
          j.missing?.length
            ? `缺少占位符:${j.missing.map((m: string) => `{${m}}`).join(' ')} — 覆写必须保留全部占位符,否则动态内容会丢失。`
            : `保存失败:${j.error ?? res.status}`,
        );
      }
    } catch (e) {
      setErr('保存失败:' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const resetPrompt = async (p: PromptItem) => {
    setBusy(true);
    setErr(null);
    try {
      await fetch(`/api/manage/cortex/prompt/${p.name}`, { method: 'DELETE' });
      setOpen(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setModel = async (m: ModelItem, value: string) => {
    if ((m.override ?? '') === value) return;
    setModels((prev) => prev.map((x) => (x.consumer === m.consumer ? { ...x, override: value || null, overridden: !!value, effective: value || m.default } : x)));
    try {
      await fetch(`/api/manage/cortex/model/${m.consumer}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value }),
      });
    } finally {
      load();
    }
  };

  if (loading) return <div className="eval-empty">加载中…</div>;

  return (
    <div className="cx">
      <div className="cx-lead">
        校准“cortex”——每次 LLM 调用所用的提示词与模型都在这里调,存入 <code>app_config</code>,下次调用即时生效,无需重启。
        与「对话评估」形成闭环:先评分收集数据,再回到这里调提示词/模型。
      </div>

      <div className="mng-title">模型路由 · Model routing</div>
      <div className="cx-models">
        {models.map((m) => (
          <div className={`cx-model${m.overridden ? ' on' : ''}`} key={m.consumer}>
            <div className="cx-model-head">
              <span className="cx-model-name">{m.label}</span>
              {m.overridden && <span className="cx-badge">已自定义</span>}
            </div>
            <div className="cx-model-desc">{m.description}</div>
            <div className="cx-seg">
              {m.suggestions.map((s) => {
                const active = (m.override ?? '') === s;
                return (
                  <button
                    key={s || 'default'}
                    className={`cx-seg-b${active ? ' on' : ''}`}
                    onClick={() => setModel(m, s)}
                    title={s ? s : `使用默认(${modelLabel(m.default)})`}
                  >
                    {s ? s : '默认'}
                  </button>
                );
              })}
            </div>
            <div className="cx-model-eff">
              生效:<b>{modelLabel(m.effective)}</b>
              {m.default !== null && <span className="cx-dim"> · 默认 {modelLabel(m.default)}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="mng-title">提示词模板 · Prompt templates</div>
      {GROUP_ORDER.filter((g) => prompts.some((p) => p.group === g)).map((g) => (
        <div className="cx-group" key={g}>
          <div className="cx-group-h">{GROUP_LABELS[g] ?? g}</div>
          {prompts
            .filter((p) => p.group === g)
            .map((p) => (
              <div className={`cx-prompt${open === p.name ? ' open' : ''}${p.overridden ? ' on' : ''}`} key={p.name}>
                <button className="cx-prompt-head" onClick={() => expand(p)}>
                  <span className="cx-caret">{open === p.name ? '▾' : '▸'}</span>
                  <span className="cx-prompt-main">
                    <span className="cx-prompt-label">
                      {p.label}
                      {p.overridden && <span className="cx-badge">已自定义</span>}
                    </span>
                    <span className="cx-prompt-desc">{p.description}</span>
                  </span>
                  <span className="cx-chips">
                    {p.placeholders.map((ph) => (
                      <code key={ph}>{`{${ph}}`}</code>
                    ))}
                  </span>
                </button>
                {open === p.name && (
                  <div className="cx-editor">
                    <textarea
                      value={draft}
                      spellCheck={false}
                      onChange={(e) => setDraft(e.target.value)}
                      rows={Math.min(26, Math.max(8, draft.split('\n').length + 1))}
                    />
                    {err && <div className="cx-err">{err}</div>}
                    <div className="cx-editor-bar">
                      <span className="cx-hint">
                        必须保留占位符:{p.placeholders.length ? p.placeholders.map((ph) => `{${ph}}`).join(' ') : '(无)'}
                      </span>
                      <div className="cx-editor-btns">
                        <button className="cx-btn ghost" onClick={() => setOpen(null)} disabled={busy}>
                          收起
                        </button>
                        {p.overridden && (
                          <button className="cx-btn ghost" onClick={() => resetPrompt(p)} disabled={busy}>
                            重置为默认
                          </button>
                        )}
                        <button className="cx-btn primary" onClick={() => savePrompt(p)} disabled={busy || draft === p.effective}>
                          保存
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
