import { useCallback, useEffect, useRef, useState } from 'react';
import SetupWizard from './SetupWizard';

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

// Human-friendly summary of a memory-import result (vs. dumping raw JSON at the user).
function summarizeImported(im: { library?: number; knowledge?: number; cortex?: number } | undefined): string {
  const parts: string[] = [];
  if (im?.library) parts.push(`知识库 +${im.library}`);
  if (im?.knowledge) parts.push(`事实 +${im.knowledge}`);
  if (im?.cortex) parts.push(`校准 +${im.cortex}`);
  return parts.length ? parts.join(' · ') : '无新增(已是最新)';
}

export function Manage() {
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [latency, setLatency] = useState(0);
  const [strip, setStrip] = useState<boolean[]>([]);
  const [counts, setCounts] = useState<{ plans?: number; library?: number; tools?: number }>({});
  const [uptime, setUptime] = useState('0s');
  const [accessMode, setAccessMode] = useState<'local' | 'lan' | 'wan' | null>(null);
  const [view, setView] = useState<'overview' | 'eval' | 'cortex' | 'jobs' | 'resources' | 'logs' | 'settings'>('overview');
  const [needsSetup, setNeedsSetup] = useState(false);
  const [info, setInfo] = useState<{ serverName?: string; dataRoot?: string; version?: string }>({});
  const started = useRef(Date.now());

  // Static instance details for the Overview (server name / version / data folder) — fetched once;
  // these don't change during a session (a rename needs a restart), so no need to poll them.
  useEffect(() => {
    let on = true;
    (async () => {
      const [h, u] = await Promise.all([
        fetch('/api/health').then((r) => r.json()).catch(() => ({})),
        fetch('/api/manage/update/check').then((r) => r.json()).catch(() => ({})),
      ]);
      if (on) setInfo({ serverName: h.serverName, dataRoot: h.dataRoot, version: u.currentVersion });
    })();
    return () => { on = false; };
  }, []);

  // First run: a truly fresh install (no settings.json yet) reports setupCompleted=false → show the
  // one-time setup wizard. Existing installs are migrated to completed server-side, so they skip it.
  useEffect(() => {
    let on = true;
    (async () => {
      try {
        const s = await (await fetch('/api/manage/settings')).json();
        if (on && s && s.setupCompleted === false) setNeedsSetup(true);
      } catch { /* if settings can't be read, don't block the console with a wizard */ }
    })();
    return () => { on = false; };
  }, []);

  // Lightweight in-page toast — replaces alert()/confirm(), which in the WebView2 host block the
  // native message bridge (and look nothing like the rest of the console).
  const [notice, setNotice] = useState<{ text: string; kind?: 'ok' | 'err' } | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const toast = useCallback((text: string, kind?: 'ok' | 'err') => {
    setNotice({ text, kind });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), kind === 'err' ? 5200 : 3400);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) window.clearTimeout(noticeTimer.current); }, []);

  // On-brand confirm dialog (replaces window.confirm / the host's native MessageBox). Returns a
  // promise that resolves true/false — so callers `await confirm(...)` inline.
  const [ask, setAsk] = useState<{ text: string; danger?: boolean; okText?: string; resolve: (v: boolean) => void } | null>(null);
  const confirm = useCallback(
    (text: string, opts?: { danger?: boolean; okText?: string }) =>
      new Promise<boolean>((resolve) => setAsk({ text, danger: opts?.danger, okText: opts?.okText, resolve })),
    []);
  const answerAsk = useCallback((v: boolean) => setAsk((a) => { a?.resolve(v); return null; }), []);

  // Styled window-close prompt (host mode): when the user presses ✕ and the close action is "ask", the
  // host cancels the close + asks the console to show this, then applies whatever we post back.
  const [closing, setClosing] = useState(false);
  const [rememberClose, setRememberClose] = useState(false);
  const answerClose = (choice: 'tray' | 'exit' | 'cancel') => {
    setClosing(false);
    host(`close:${choice}${rememberClose && choice !== 'cancel' ? ':remember' : ''}`);
  };

  // Host → web bridge: the desktop host posts result notices (backup / restore / memory export+import)
  // back to the console so they render as styled in-page toasts, not native MessageBoxes.
  useEffect(() => {
    if (!inHost) return;
    const cw = (window as unknown as {
      chrome?: { webview?: {
        addEventListener?: (t: string, h: (e: { data: unknown }) => void) => void;
        removeEventListener?: (t: string, h: (e: { data: unknown }) => void) => void;
      } };
    }).chrome?.webview;
    if (!cw?.addEventListener) return;
    const handler = (e: { data: unknown }) => {
      const d = e.data as { type?: string; kind?: string; text?: string } | null;
      if (!d) return;
      if (d.type === 'toast') toast(String(d.text ?? ''), d.kind === 'err' ? 'err' : 'ok');
      else if (d.type === 'close-prompt') { setRememberClose(false); setClosing(true); }
    };
    cw.addEventListener('message', handler);
    return () => cw.removeEventListener?.('message', handler);
  }, [toast]);

  // Mirror the console's active theme to the desktop host so its native window + tray menu match
  // whichever theme (light ↔ dark) the user is running — posted on mount and on every change.
  useEffect(() => {
    if (!inHost) return;
    const send = () => host('theme:' + (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
    send();
    const obs = new MutationObserver(send);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

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
    // Re-read the access mode each cycle so the footer reflects a settings change after a restart
    // (it's fetched every poll, not once on mount — the old bug left the footer stale).
    const refreshAuth = async () => {
      try {
        const s = await (await fetch('/api/auth/status')).json();
        if (!mounted) return;
        setAccessMode((s.mode as 'local' | 'lan' | 'wan') ?? null);
      } catch { if (mounted) setAccessMode(null); }
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
      if (ok && tick % 3 === 0) { refreshCounts(); refreshAuth(); }
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
    toast('正在导出记忆(知识库 + 事实 + 校准)…');
  };
  // Shared "pick a file → POST it → toast the result" flow. In-host defers the file dialog + upload to
  // the native host, but the destructive confirm is shown here (styled) first. In a plain browser the
  // file is picked (keeping the click's user-gesture), then confirmed, then POSTed.
  const importFile = async (opts: {
    hostAction: string; accept: string; url: string; contentType: string;
    body: (f: File) => BodyInit | Promise<BodyInit>; confirm?: string;
    ok: (j: any) => string; errPrefix: string;
  }) => {
    if (inHost) {
      if (opts.confirm && !(await confirm(opts.confirm, { danger: true, okText: '继续恢复' }))) return;
      host(opts.hostAction);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = opts.accept;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (opts.confirm && !(await confirm(opts.confirm, { danger: true, okText: '继续恢复' }))) return;
      try {
        const res = await fetch(opts.url, { method: 'POST', headers: { 'content-type': opts.contentType }, body: await opts.body(file) });
        const j = await res.json();
        if (res.ok) toast(opts.ok(j));
        else toast(`${opts.errPrefix}:${j.error ?? res.status}`, 'err');
      } catch (e) {
        toast(`${opts.errPrefix}:` + (e instanceof Error ? e.message : String(e)), 'err');
      }
    };
    input.click();
  };
  const importMemory = () => importFile({
    hostAction: 'importMemory', accept: '.json', url: '/api/memory/import', contentType: 'application/json',
    body: (f) => f.text(), ok: (j) => `已导入记忆:${summarizeImported(j.imported)}`, errPrefix: '导入失败',
  });
  const exportBackup = () => {
    if (inHost) host('exportBackup');
    else window.open('/api/backup/export', '_blank');
    toast('正在导出完整备份(整个数据文件夹:计划 · 家庭 · 知识库 · 历史 · 记忆)…');
  };
  const importBackup = () => importFile({
    hostAction: 'importBackup', accept: '.zip', url: '/api/backup/import', contentType: 'application/zip',
    body: (f) => f, confirm: '恢复将覆盖当前的计划 / 家庭 / 知识库,并合并记忆。确定继续?',
    ok: (j) => `已从备份恢复:${j.restored?.files ?? 0} 个文件`, errPrefix: '恢复失败',
  });
  const restart = () => { host('serverRestart'); toast('已发送重启指令,服务将很快恢复…'); };
  const stopServer = () => { host('serverStop'); toast('已停止本地服务 —— 需要时点「启动」恢复。'); };
  const startServer = () => { host('serverStart'); toast('正在启动本地服务…'); };

  const hColor = healthy === null ? 'var(--muted)' : healthy ? 'var(--success)' : 'var(--danger)';
  const statusText = healthy === null ? '检查中…' : healthy ? '运行正常 · Healthy' : '无响应 · Not responding';

  const N = (v?: number) => (v === undefined ? '—' : v.toLocaleString());

  return (
    <div className="mng" style={{ minHeight: '100vh' }}>
      <div className="mng-tabs">
        <div className="mng-tabs-inner">
          <button className={`mng-tab${view === 'overview' ? ' on' : ''}`} onClick={() => setView('overview')}>概览 · Overview</button>
          <button className={`mng-tab${view === 'eval' ? ' on' : ''}`} onClick={() => setView('eval')}>对话评估 · Eval</button>
          <button className={`mng-tab${view === 'cortex' ? ' on' : ''}`} onClick={() => setView('cortex')}>校准 · Cortex</button>
          <button className={`mng-tab${view === 'jobs' ? ' on' : ''}`} onClick={() => setView('jobs')}>自动化 · Jobs</button>
          <button className={`mng-tab${view === 'resources' ? ' on' : ''}`} onClick={() => setView('resources')}>资源 · Resources</button>
          <button className={`mng-tab${view === 'logs' ? ' on' : ''}`} onClick={() => setView('logs')}>日志 · Logs</button>
          <button className={`mng-tab${view === 'settings' ? ' on' : ''}`} onClick={() => setView('settings')}>设置 · Settings</button>
        </div>
      </div>

      {view === 'eval' && <EvalView />}
      {view === 'cortex' && <CortexView toast={toast} />}
      {view === 'jobs' && <JobsView toast={toast} confirm={confirm} />}
      {view === 'resources' && <ResourcesView toast={toast} onRestart={restart} inHost={inHost} />}
      {view === 'logs' && <LogsView inHost={inHost} />}
      {view === 'settings' && <SettingsView inHost={inHost} toast={toast} onRestart={restart} />}

      {view === 'overview' && (
      <div className="mng-view mng-overview">
      <div className="mng-grid">
      <div className="mng-col">
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

      <div className="mng-title">详情 · Details</div>
      <div className="mng-detail">
        <div className="mng-detail-row"><span>服务器 · Server</span><b>{info.serverName ?? '—'}</b></div>
        <div className="mng-detail-row"><span>版本 · Version</span><b>{info.version ? `v${info.version}` : '—'}</b></div>
        <div className="mng-detail-row"><span>访问 · Access</span><b>
          {accessMode === 'local' ? '仅本机' : accessMode === 'lan' ? '局域网' : accessMode === 'wan' ? '公网' : '—'}
          {' · '}端口 {location.port || '5317'}
        </b></div>
        <div className="mng-detail-row"><span>运行时长 · Uptime</span><b>{uptime}</b></div>
        <div className="mng-detail-row wide"><span>数据文件夹 · Data</span><b title={info.dataRoot}>{info.dataRoot ?? '—'}</b></div>
      </div>
      </div>

      <div className="mng-col">
      <div className="mng-title">操作 · Controls</div>
      <div className="mng-actions">
        <button className="mng-btn primary" onClick={openPlanner}>在浏览器打开规划界面</button>
        {inHost && (
          <div className="mng-srv">
            <div className="mng-srv-h">本地服务 · Server</div>
            <div className="mng-srv-row">
              <button className="mng-srv-b restart" onClick={restart} title="回收并重启进程内服务">
                重启<span>Restart</span>
              </button>
              <button className="mng-srv-b" onClick={stopServer} disabled={healthy === false} title="停止服务(管理端保持打开)">
                停止<span>Stop</span>
              </button>
              <button className="mng-srv-b" onClick={startServer} disabled={healthy === true} title="重新启动服务">
                启动<span>Start</span>
              </button>
            </div>
          </div>
        )}
        {inHost && (
          <button className="mng-btn" onClick={() => host('openDataFolder')}>
            打开数据文件夹<span className="sub">plans · household · 知识库 · SQLite</span>
          </button>
        )}
        <button className="mng-btn" onClick={exportMemory}>
          导出记忆<span className="sub">知识库 + 事实 → 可迁移文件</span>
        </button>
        <button className="mng-btn" onClick={importMemory}>
          导入记忆<span className="sub">合并另一台机器的记忆</span>
        </button>
        <button className="mng-btn" onClick={exportBackup}>
          完整备份<span className="sub">整个数据文件夹(含 git 历史)→ 一个 .zip</span>
        </button>
        <button className="mng-btn" onClick={importBackup}>
          恢复备份<span className="sub">从 .zip 还原(覆盖记录 · 合并记忆)</span>
        </button>
        {inHost && (
          <button className="mng-btn danger" onClick={() => host('exit')}>
            退出<span className="sub">stop the server + quit</span>
          </button>
        )}
      </div>

      <UpdateCard inHost={inHost} />
      </div>
      </div>

      {!inHost && <div className="mng-hint">提示:部分主机操作(重启 / 数据文件夹 / 退出)仅在桌面管理端可用。</div>}
      </div>
      )}

      <div className="mng-foot">
        <div className="mng-foot-inner">
          <span className="mng-foot-brand"><span className="mng-seal sm" aria-hidden="true">拾</span>拾光 · 管理控制台</span>
          <span className="mng-foot-sep" />
          <span>端口 {location.port || '5317'}</span>
          <a className="mng-foot-link" href={plannerUrl} target="_blank" rel="noreferrer">{plannerUrl}</a>
          {accessMode !== null && (
            <span className={`mng-sec${accessMode !== 'local' ? ' on' : ''}`} title={
              accessMode === 'local' ? '仅本机可访问(127.0.0.1)' :
              accessMode === 'lan' ? '局域网开放(0.0.0.0),无令牌' : '公网开放,需访问令牌'
            }>
              {accessMode === 'local' ? '🏠 仅本机' : accessMode === 'lan' ? '🌐 局域网' : '🔒 公网'}
            </span>
          )}
          <span className="mng-foot-h" title={statusText}>
            <span className={`mng-top-dot${healthy ? ' ok' : healthy === false ? ' bad' : ''}`} />
            {statusText}
            {healthy && latency != null ? ` · ${latency}ms` : ''}
          </span>
        </div>
      </div>

      {notice && (
        <div className={`mng-toast${notice.kind === 'err' ? ' err' : ''}`} role="status" aria-live="polite">
          {notice.text}
        </div>
      )}

      {needsSetup && (
        <SetupWizard inHost={inHost} toast={toast} onRestart={restart} onDone={() => setNeedsSetup(false)} />
      )}

      {ask && (
        <div className="mng-modal-overlay" role="dialog" aria-modal="true" onClick={() => answerAsk(false)}>
          <div className="mng-modal" onClick={(e) => e.stopPropagation()}>
            <div className="mng-modal-body">
              <div className="t">确认操作 · Confirm</div>
              <div className="m">{ask.text}</div>
            </div>
            <div className="mng-modal-actions">
              <button className="mng-mbtn" onClick={() => answerAsk(false)}>取消</button>
              <button className={`mng-mbtn ${ask.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => answerAsk(true)}>
                {ask.okText ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {closing && (
        <div className="mng-modal-overlay" role="dialog" aria-modal="true">
          <div className="mng-modal">
            <div className="mng-modal-body">
              <div className="t">关闭管理控制台?</div>
              <div className="m">服务会在后台继续运行。要最小化到托盘,还是完全退出?</div>
              <label className="mng-modal-check">
                <input type="checkbox" checked={rememberClose} onChange={(e) => setRememberClose(e.target.checked)} />
                记住我的选择(可在「设置」中更改)
              </label>
            </div>
            <div className="mng-modal-actions">
              <button className="mng-mbtn" onClick={() => answerClose('cancel')}>取消</button>
              <button className="mng-mbtn danger" onClick={() => answerClose('exit')}>退出</button>
              <button className="mng-mbtn primary" autoFocus onClick={() => answerClose('tray')}>最小化到托盘</button>
            </div>
          </div>
        </div>
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
  avgScore?: number | null;
  scoreCount?: number;
}
interface Stats {
  total: number;
  rated: number;
  avgRating: number;
  distribution: { rating: number; count: number }[];
}
interface ScorerMeta {
  id: string;
  name: string;
  description: string;
  group: string;
  isLlm: boolean;
}
interface ScoreAgg {
  scorerId: string;
  avgScore: number;
  count: number;
}
interface StoredScore {
  scorerId: string;
  score: number;
  reason?: string | null;
  isLlm: boolean;
}
interface TraceStep {
  seq: number;
  kind: string;
  label: string;
  detail?: string | null;
  durationMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
}
interface RunTrace {
  totalDurationMs: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  steps: TraceStep[];
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtNum = (n: number) => n.toLocaleString();

function EvalView() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Conversation[]>([]);
  const [scorers, setScorers] = useState<ScorerMeta[]>([]);
  const [agg, setAgg] = useState<ScoreAgg[]>([]);
  const [scoring, setScoring] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [s, c, sc, a] = await Promise.all([
        fetch('/api/manage/stats').then((r) => r.json()),
        fetch('/api/manage/conversations?limit=100').then((r) => r.json()),
        fetch('/api/manage/scores/scorers').then((r) => r.json()),
        fetch('/api/manage/scores/aggregate').then((r) => r.json()),
      ]);
      setStats(s);
      setRows(c.conversations ?? []);
      setScorers(sc.scorers ?? []);
      setAgg(a.scorers ?? []);
    } catch {
      /* leave empty */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const runScorers = async () => {
    setScoring(true);
    try {
      await fetch('/api/manage/scores/run-all', { method: 'POST' });
      // batch scoring runs in the background — give the judges a moment, then refresh.
      await new Promise((r) => setTimeout(r, 2500));
      await load();
    } finally {
      setScoring(false);
    }
  };

  // Expand a conversation → load its run trace + per-dimension scores.
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ trace: RunTrace; scores: StoredScore[] } | null>(null);
  const toggle = async (id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id);
    setDetail(null);
    try {
      const [t, s] = await Promise.all([
        fetch(`/api/manage/trace/${id}`).then((r) => r.json()),
        fetch(`/api/manage/scores/${id}`).then((r) => r.json()),
      ]);
      setDetail({ trace: t, scores: s.scores ?? [] });
    } catch {
      /* leave detail null */
    }
  };

  const maxDist = Math.max(1, ...(stats?.distribution ?? []).map((d) => d.count));
  const distByStar = (n: number) => stats?.distribution.find((d) => d.rating === n)?.count ?? 0;

  return (
    <div className="mng-view">
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

      {scorers.length > 0 && (
        <div className="eval-scorers">
          <div className="eval-toolbar">
            <h2>自动评分 · Scorers</h2>
            <button className="eval-export" onClick={runScorers} disabled={scoring}>{scoring ? '评分中…' : '运行评分(未评分对话)'}</button>
          </div>
          <div className="eval-scorer-grid">
            {scorers.map((s) => {
              const a = agg.find((x) => x.scorerId === s.id);
              const pct = a ? Math.round(a.avgScore * 100) : 0;
              return (
                <div className={`eval-scorer${s.group === 'guardrails' ? ' guard' : ''}`} key={s.id} title={s.description}>
                  <div className="eval-scorer-top">
                    <span className="nm">{s.name}{s.isLlm && <span className="llm">LLM</span>}</span>
                    <span className="v">{a ? a.avgScore.toFixed(2) : '—'}</span>
                  </div>
                  <div className="eval-scorer-bar"><span style={{ width: `${pct}%` }} /></div>
                  <div className="eval-scorer-sub">{a ? `${a.count} 次评分` : '未评分'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

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
            <div className="eval-item" key={c.id}>
              <div className={`eval-row clickable${openId === c.id ? ' open' : ''}`} onClick={() => toggle(c.id)}>
                <span className="eval-caret">{openId === c.id ? '▾' : '▸'}</span>
                <div className="eval-row-main">
                  <div className="eval-row-msg">{c.userMessage || '(空)'}</div>
                  <div className="eval-row-meta">
                    <span className="phase">{c.phase}</span>
                    {c.mode === 'system' && <span>系统模式</span>}
                    {c.commitSha && <span className="k">{c.commitSha.slice(0, 7)}</span>}
                    {!!c.scoreCount && c.avgScore != null && (
                      <span className="score" title={`${c.scoreCount} 个维度自动评分`}>评分 {c.avgScore.toFixed(2)}</span>
                    )}
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
              {openId === c.id && <ConversationDetail detail={detail} scorers={scorers} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Conversation detail: run trace (phase timeline + tools + LLM runs) + per-dimension scores ----
function ConversationDetail({ detail, scorers }: { detail: { trace: RunTrace; scores: StoredScore[] } | null; scorers: ScorerMeta[] }) {
  if (!detail) return <div className="eval-detail loading">加载运行轨迹…</div>;
  const { trace, scores } = detail;
  const nameOf = (id: string) => scorers.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="eval-detail">
      <div className="eval-trace-totals">
        <span>耗时 <b>{fmtMs(trace.totalDurationMs)}</b></span>
        <span>工具 <b>{trace.toolCalls}</b></span>
        <span>输入 <b>{fmtNum(trace.inputTokens)}</b> tok</span>
        <span>输出 <b>{fmtNum(trace.outputTokens)}</b> tok</span>
        {trace.costUsd > 0 && <span>成本 <b>${trace.costUsd.toFixed(4)}</b></span>}
      </div>
      <div className="eval-trace">
        {trace.steps.map((s, i) => (
          <div className={`eval-tstep ${s.kind}`} key={i}>
            <span className="k">{s.kind}</span>
            <span className="lb">{s.label}{s.detail ? <em> · {s.detail}</em> : null}</span>
            {s.kind === 'usage' ? (
              <span className="d">{fmtNum(s.inputTokens ?? 0)}/{fmtNum(s.outputTokens ?? 0)} tok</span>
            ) : s.durationMs > 0 ? (
              <span className="d">{fmtMs(s.durationMs)}</span>
            ) : null}
          </div>
        ))}
      </div>
      {scores.length > 0 && (
        <div className="eval-detail-scores">
          {scores.map((sc) => (
            <div className="eval-dscore" key={sc.scorerId} title={sc.reason ?? ''}>
              <span className="nm">{nameOf(sc.scorerId)}{sc.isLlm && <span className="llm">LLM</span>}</span>
              <span className="bar"><span className={sc.score >= 0.75 ? 'ok' : sc.score >= 0.4 ? 'mid' : 'low'} style={{ width: `${Math.round(sc.score * 100)}%` }} /></span>
              <span className="v">{sc.score.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Self-update card (check GitHub release → download/stage → restart-to-apply) ----
interface UpdateCheck {
  configured: boolean;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  releaseNotes?: string;
  releaseUrl?: string;
  error?: string;
}
interface UpdateStatus {
  configured: boolean;
  downloading: boolean;
  progress: number;
  pending: boolean;
  pendingVersion?: string;
  error?: string;
}

function UpdateCard({ inHost }: { inHost: boolean }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const timer = useRef<number | null>(null);

  const loadState = async () => {
    try { setSt(await (await fetch('/api/manage/update/state')).json()); } catch { /* ignore */ }
  };
  useEffect(() => {
    fetch('/api/manage/update/check').then((r) => r.json()).then(setCheck).catch(() => setCheck(null));
    loadState();
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);
  // Poll while a download is in flight.
  useEffect(() => {
    if (st?.downloading && !timer.current) {
      timer.current = window.setInterval(loadState, 1500);
    } else if (!st?.downloading && timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, [st?.downloading]);

  const download = async () => {
    await fetch('/api/manage/update/download', { method: 'POST' });
    setSt((s) => (s ? { ...s, downloading: true, progress: 0, error: undefined } : s));
    loadState();
  };

  if (!check) return null;
  const pending = st?.pending;
  const downloading = st?.downloading;

  return (
    <>
      <div className="mng-title">更新 · Updates</div>
      <div className="mng-update">
        {!check.configured ? (
          <div className="mng-update-row">
            <span className="mng-update-msg">
              当前版本 <b>v{check.currentVersion}</b> · 更新源未配置
              <span className="sub">在 settings.json 设置 <code>selfUpdate.githubRepo</code> 以启用自动更新</span>
            </span>
          </div>
        ) : pending ? (
          <div className="mng-update-row on">
            <span className="mng-update-msg">
              更新已就绪 <b>v{st?.pendingVersion}</b> — 重启以安装
              <span className="sub">当前 v{check.currentVersion}</span>
            </span>
            {inHost ? (
              <button className="mng-btn primary compact" onClick={() => host('applyUpdate')}>重启并安装</button>
            ) : (
              <span className="mng-update-hint">在桌面管理端点击「重启并安装」以完成</span>
            )}
          </div>
        ) : downloading ? (
          <div className="mng-update-row">
            <span className="mng-update-msg">
              正在下载更新… <b>{st?.progress ?? 0}%</b>
              <span className="mng-update-bar"><span style={{ width: `${st?.progress ?? 0}%` }} /></span>
            </span>
          </div>
        ) : check.updateAvailable ? (
          <div className="mng-update-row on">
            <span className="mng-update-msg">
              发现新版本 <b>v{check.latestVersion}</b>
              <span className="sub">当前 v{check.currentVersion}{check.releaseUrl ? ' · ' : ''}
                {check.releaseUrl && <a href={check.releaseUrl} target="_blank" rel="noreferrer">发行说明</a>}</span>
            </span>
            <button className="mng-btn primary compact" onClick={download}>下载更新</button>
          </div>
        ) : (
          <div className="mng-update-row">
            <span className="mng-update-msg">
              已是最新 <b>v{check.currentVersion}</b>
              {check.error && <span className="sub">检查失败:{check.error}</span>}
            </span>
          </div>
        )}
      </div>
    </>
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

// ---- Knowledge-base upgrade migration (customized .claude/ files vs. shipped template improvements) ----
interface KbStatus {
  available: { path: string }[];
  hasStaged: boolean;
  staged?: { path: string; status: string; diff: string }[] | null;
  stagedAt?: string | null;
  progress?: {
    current: number; total: number; file?: string | null; running: boolean;
    outChars?: number; tokens?: number; costUsd?: number; elapsedMs?: number; model?: string | null;
  } | null;
}

const fmtElapsed = (ms?: number) => {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
};
const fmtUsd = (n?: number) => {
  const v = n ?? 0;
  if (v <= 0) return null;
  return v < 0.001 ? '<$0.001' : `$${v.toFixed(v < 1 ? 3 : 2)}`;
};
function KbUpgradesCard({ toast }: { toast: (t: string, k?: 'ok' | 'err') => void }) {
  const [status, setStatus] = useState<KbStatus | null>(null);
  const [busy, setBusy] = useState(false); // local (approve/reject/starting) — not the merge itself
  const load = async () => { try { setStatus(await (await fetch('/api/manage/kb-upgrades')).json()); } catch { /* ignore */ } };
  useEffect(() => { load(); }, []);

  // The merge runs server-side; its progress is server truth. Poll while a run is in flight — `running`
  // (server truth) so the live status survives leaving this tab and coming back or a full reload, plus
  // `busy` so the initiating click polls during the blocking POST before `running` has flipped on. The
  // old bug: busy + the poll lived only in local state and died on unmount, leaving a blank card.
  const running = status?.progress?.running ?? false;
  const active = running || busy;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(load, 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!status) return null;
  const nAvail = status.available?.length ?? 0;
  if (!status.hasStaged && nAvail === 0 && !running) return null; // nothing to surface
  const prog = status.progress;

  const run = async () => {
    if (busy || running) return;
    setBusy(true);
    await load(); // flip `running` on quickly so the poll effect above takes over the live updates
    try {
      const res = await fetch('/api/manage/kb-upgrades/run', { method: 'POST' });
      const r = await res.json();
      if (res.ok && r.staged) toast(`已合并 ${r.merged} 个文件${r.failed ? `(${r.failed} 个失败)` : ''},请审阅`);
      else toast(r.error ?? '合并无改动', res.ok ? 'ok' : 'err');
    } catch { toast('合并失败', 'err'); }
    finally { setBusy(false); await load(); }
  };
  const approve = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/manage/kb-upgrades/approve', { method: 'POST' });
      const r = await res.json();
      toast(res.ok ? `已应用升级 ${r.sha ?? ''}` : (r.error ?? '应用失败'), res.ok ? 'ok' : 'err');
      await load();
    } finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true);
    try { await fetch('/api/manage/kb-upgrades/reject', { method: 'POST' }); toast('已保留你的版本'); await load(); }
    finally { setBusy(false); }
  };

  return (
    <div className="kbup">
      <div className="kbup-title">🔄 知识库升级 · Knowledge-base upgrades</div>
      {status.hasStaged ? (
        <>
          <div className="kbup-desc">已把 {status.staged?.length ?? 0} 个文件与新模板合并(保留你的自定义 + 采纳改进),审阅后应用:</div>
          <div className="kbup-diffs">
            {status.staged?.map((f) => (
              <details className="kbup-file" key={f.path}>
                <summary>{f.path} <span className="jobs-kind">{f.status}</span></summary>
                <pre className="kbup-diff">
                  {(f.diff || '').split('\n').map((l, i) => (
                    <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : ''}>{l || ' '}</div>
                  ))}
                </pre>
              </details>
            ))}
          </div>
          <div className="kbup-btns">
            <button className="cx-btn primary" onClick={approve} disabled={busy}>应用升级</button>
            <button className="cx-btn ghost" onClick={reject} disabled={busy}>保留我的版本</button>
          </div>
        </>
      ) : (
        <>
          <div className="kbup-desc">{nAvail} 个你自定义过的知识库文件有新模板改进。AI 合并会保留你的改动并采纳改进,结果需你审阅后才生效。</div>
          <ul className="kbup-list">{status.available.map((u) => <li key={u.path}>{u.path}</li>)}</ul>
          {running && prog && (
            <div className="kbup-progress">
              <div className="kbup-progress-head">
                合并中 {prog.current}/{prog.total}
                {prog.file ? <> · <code>{prog.file}</code></> : null}
                {prog.model ? <> · {prog.model}</> : null}
              </div>
              <div className="kbup-progress-live">
                ⏱ {fmtElapsed(prog.elapsedMs)}
                {prog.outChars ? <> · 生成中 ~{prog.outChars.toLocaleString()} 字</> : null}
                {prog.tokens ? <> · {prog.tokens.toLocaleString()} tok</> : null}
                {fmtUsd(prog.costUsd) ? <> · ~{fmtUsd(prog.costUsd)}</> : null}
              </div>
            </div>
          )}
          <div className="kbup-btns">
            <button className="cx-btn primary" onClick={run} disabled={busy || running}>
              {running
                ? `合并中 ${prog?.current ?? 0}/${prog?.total ?? 0}…（AI）`
                : busy ? '启动中…' : '运行合并(AI)'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CortexView({ toast }: { toast: (t: string, k?: 'ok' | 'err') => void }) {
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
    <div className="cx mng-view">
      <div className="cx-lead">
        校准“cortex”——每次 LLM 调用所用的提示词与模型都在这里调,存入 <code>app_config</code>,下次调用即时生效,无需重启。
        与「对话评估」形成闭环:先评分收集数据,再回到这里调提示词/模型。
      </div>

      <KbUpgradesCard toast={toast} />


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

// ---- Resources view (download-at-setup: chromium / git / … provisioned into the data folder) ----
interface ResourceStatus {
  id: string;
  name: string;
  neededFor: string;
  approxBytes: number;
  installed: boolean;
  state: string;
  percent: number;
  message: string | null;
}

function ResourcesView({ toast, onRestart, inHost }: { toast: (t: string, k?: 'ok' | 'err') => void; onRestart: () => void; inHost: boolean }) {
  const [items, setItems] = useState<ResourceStatus[] | null>(null);
  const load = async () => {
    try {
      const d = await (await fetch('/api/manage/resources')).json();
      setItems(d.resources);
    } catch {
      /* keep last */
    }
  };
  useEffect(() => { load(); }, []);
  // Poll while anything is downloading so the progress bar advances live. Gate on a DERIVED boolean —
  // keying on `items` would tear down + recreate the interval on every 1.2s load() (items changes each tick).
  const anyRunning = items?.some((r) => r.state === 'running') ?? false;
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 1200);
    return () => clearInterval(t);
  }, [anyRunning]);

  const provision = async (id: string) => {
    try {
      const res = await fetch(`/api/manage/resources/${id}/provision`, { method: 'POST' });
      if (res.ok) { toast('开始下载…'); load(); }
      else toast('无法开始下载', 'err');
    } catch {
      toast('请求失败', 'err');
    }
  };

  const mb = (n: number) => `${Math.round(n / 1_000_000)} MB`;
  if (!items) return <div className="eval-empty">加载中…</div>;

  return (
    <div className="mng-view set">
      <div className="set-lead">
        大型资源(Chromium、Git 等)按需下载到数据文件夹,不打包进安装包 —— 保持安装包小巧。下载一次即长期保留(应用更新不会清除)。
      </div>
      <div className="res-list">
        {items.map((r) => (
          <div className={`res-item${r.installed ? ' ok' : ''}${r.state === 'error' ? ' err' : ''}`} key={r.id}>
            <div className="res-main">
              <div className="res-name">
                {r.name}
                {r.installed && <span className="res-badge">已安装</span>}
              </div>
              <div className="res-need">{r.neededFor}</div>
              {r.state === 'running' && (
                <>
                  <div className="res-prog"><span className="res-bar" style={{ width: `${r.percent}%` }} /></div>
                  <div className="res-msg">{r.message} · {r.percent}%</div>
                </>
              )}
              {r.state === 'error' && <div className="res-msg danger">下载失败:{r.message}</div>}
            </div>
            <div className="res-side">
              <div className="res-size">≈ {mb(r.approxBytes)}</div>
              {r.state === 'running' ? (
                <span className="res-running">下载中…</span>
              ) : (
                <button className={`cx-btn${r.installed ? '' : ' primary'}`} onClick={() => provision(r.id)}>
                  {r.installed ? '重新下载' : '下载'}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {inHost && (
        <div className="set-actions">
          <button className="cx-btn" onClick={onRestart}>重启服务</button>
          <span className="set-saved">部分资源(如 Git)需重启后生效</span>
        </div>
      )}
    </div>
  );
}

// ---- Logs view (tail the app's daily file logs under {data}/state/logs) ----
interface LogsData {
  dir: string;
  files: string[];
  file: string | null;
  lines: string[];
}
function LogsView({ inHost }: { inHost: boolean }) {
  const [data, setData] = useState<LogsData | null>(null);
  const [file, setFile] = useState('');
  const [auto, setAuto] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const load = async (f?: string) => {
    try {
      const q = (f ?? file) ? `?file=${encodeURIComponent(f ?? file)}` : '';
      const d: LogsData = await (await fetch(`/api/manage/logs${q}`)).json();
      setData(d);
      if (!file && d.file) setFile(d.file);
    } catch {
      /* keep last */
    }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => load(), 3000);
    return () => clearInterval(t);
  }, [auto, file]);
  // Stick to the bottom after each refresh (newest lines).
  useEffect(() => { if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight; }, [data]);

  const cls = (l: string) =>
    /\[(ERROR|CRIT)/.test(l) ? ' err' : /\[WARN/.test(l) ? ' warn' : /^\s*(→|at )/.test(l) ? ' dim' : '';

  if (!data) return <div className="eval-empty">加载中…</div>;

  return (
    <div className="mng-view logs">
      <div className="logs-bar">
        <select className="logs-file" value={file} onChange={(e) => { setFile(e.target.value); load(e.target.value); }}>
          {data.files.length === 0 && <option value="">(暂无日志)</option>}
          {data.files.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <button className="cx-btn" onClick={() => load()}>刷新</button>
        <label className="set-check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 自动刷新(3s)</label>
        {inHost && <button className="cx-btn" onClick={() => host('openLogs')}>打开日志文件夹</button>}
        <span className="logs-path" title={data.dir}>{data.dir}</span>
      </div>
      {data.files.length === 0 ? (
        <div className="eval-empty">暂无日志 —— 应用运行后会写入 state/logs/。</div>
      ) : (
        <pre className="logs-view" ref={preRef}>
          {data.lines.map((l, i) => <div className={`logs-line${cls(l)}`} key={i}>{l || ' '}</div>)}
        </pre>
      )}
    </div>
  );
}

// ---- Settings view (edit state/settings.json — port / remote access / TLS / update source) ----
interface SettingsData {
  serverName: string;
  port: number;
  logLevel: string;
  hostCloseAction: string;
  bindAddress: string;
  trustLoopback: boolean;
  allowLanWithoutToken: boolean;
  hasAccessToken: boolean;
  tls: { enabled: boolean; certPath: string | null; hasCertPassword: boolean };
  selfUpdate: { githubRepo: string | null; apiUrl: string | null };
  envOverrides: string[];
}

function SettingsView({ inHost, toast, onRestart }: { inHost: boolean; toast: (t: string, k?: 'ok' | 'err') => void; onRestart: () => void }) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [serverName, setServerName] = useState('');
  const [port, setPort] = useState('');
  const [logLevel, setLogLevel] = useState('Information');
  const [closeAction, setCloseAction] = useState('ask');
  // Access scope: local (loopback) · lan (0.0.0.0, no token) · wan (0.0.0.0, token required).
  const [mode, setMode] = useState<'local' | 'lan' | 'wan'>('local');
  const [trustLoopback, setTrustLoopback] = useState(true);
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [tlsEnabled, setTlsEnabled] = useState(false);
  const [certPath, setCertPath] = useState('');
  const [repo, setRepo] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const d: SettingsData = await (await fetch('/api/manage/settings')).json();
      setData(d);
      setServerName(d.serverName);
      setPort(String(d.port));
      setLogLevel(d.logLevel || 'Information');
      setCloseAction(d.hostCloseAction || 'ask');
      const loopback = d.bindAddress === '127.0.0.1' || d.bindAddress === '::1';
      setMode(loopback ? 'local' : d.allowLanWithoutToken ? 'lan' : 'wan');
      setTrustLoopback(d.trustLoopback);
      setTlsEnabled(d.tls.enabled);
      setCertPath(d.tls.certPath ?? '');
      setRepo(d.selfUpdate.githubRepo ?? '');
      setToken('');
      setClearToken(false);
    } catch {
      /* leave empty */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true);
    setSaved(false);
    const body: Record<string, unknown> = {
      serverName,
      port: Number(port) || undefined,
      logLevel,
      hostCloseAction: closeAction,
      bindAddress: mode === 'local' ? '127.0.0.1' : '0.0.0.0',
      allowLanWithoutToken: mode === 'lan',
      trustLoopback,
      tls: { enabled: tlsEnabled, certPath: certPath || null },
      selfUpdate: { githubRepo: repo || null },
    };
    if (clearToken) body.clearAccessToken = true;
    else if (token) body.accessToken = token;
    try {
      const res = await fetch('/api/manage/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (res.ok) { setSaved(true); toast('设置已保存 · 重启后生效'); await load(); }
      else toast(j.error ?? '保存失败', 'err');
    } catch (e) {
      toast('保存失败:' + (e instanceof Error ? e.message : String(e)), 'err');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !data) return <div className="eval-empty">加载中…</div>;
  const envWarn = (field: string) => data.envOverrides.includes(field);

  return (
    <div className="mng-view set">
      <div className="set-lead">
        编辑本机服务配置(<code>state/settings.json</code>)。大多数项在<b>重启服务后</b>生效 —— 保存后点「重启服务」。
        {data.envOverrides.length > 0 && (
          <div className="set-envwarn">⚠ 这些项被环境变量覆盖,改此处暂不生效:<code>{data.envOverrides.join(', ')}</code></div>
        )}
      </div>

      <div className="set-grid">
        <div className="set-group">
          <div className="set-group-h">基本 · General</div>
          <label className="set-field"><span>实例名称 · Server name</span>
            <input value={serverName} onChange={(e) => setServerName(e.target.value)} />
          </label>
          <label className="set-field"><span>端口 · Port {envWarn('port') && <em>(env)</em>}</span>
            <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} />
          </label>
          <label className="set-field"><span>日志级别 · Log level {envWarn('logLevel') && <em>(env)</em>}</span>
            <select value={logLevel} onChange={(e) => setLogLevel(e.target.value)}>
              {['Trace', 'Debug', 'Information', 'Warning', 'Error', 'Critical'].map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
          {inHost && (
            <label className="set-field"><span>关闭窗口时 · On window close</span>
              <select value={closeAction} onChange={(e) => setCloseAction(e.target.value)}>
                <option value="ask">每次询问 · Ask each time</option>
                <option value="tray">最小化到托盘 · Minimize to tray</option>
                <option value="exit">退出程序 · Exit</option>
              </select>
            </label>
          )}
        </div>

        <div className="set-group">
          <div className="set-group-h">更新源 · Updates</div>
          <label className="set-field"><span>GitHub 仓库 {envWarn('selfUpdate.githubRepo') && <em>(env)</em>}</span>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name(留空 = 关闭)" />
          </label>
          <div className="set-group-h" style={{ marginTop: 14 }}>HTTPS / TLS</div>
          <label className="set-check"><input type="checkbox" checked={tlsEnabled} onChange={(e) => setTlsEnabled(e.target.checked)} /> 启用 HTTPS(默认自签,浏览器会提示)</label>
          <label className="set-field"><span>证书 · Cert (PFX)</span>
            <input value={certPath} onChange={(e) => setCertPath(e.target.value)} placeholder="留空 = 自签" />
          </label>
        </div>

        <div className="set-group set-span">
          <div className="set-group-h">访问范围 · Access {envWarn('bindAddress') && <em>(env)</em>}</div>
          <div className="set-access">
            <div className="set-access-main">
              <div className="cx-seg set-access-seg">
                <button className={`cx-seg-b${mode === 'local' ? ' on' : ''}`} onClick={() => setMode('local')}>本机 · Local</button>
                <button className={`cx-seg-b${mode === 'lan' ? ' on' : ''}`} onClick={() => setMode('lan')}>局域网 · LAN</button>
                <button className={`cx-seg-b${mode === 'wan' ? ' on' : ''}`} onClick={() => setMode('wan')}>公网 · WAN</button>
              </div>
              <div className={`set-hint${mode === 'wan' && !data.hasAccessToken && !token ? ' danger' : ''}`}>
                {mode === 'local' && '仅本机可访问(127.0.0.1)—— 最安全,无需令牌。'}
                {mode === 'lan' && '本机 + 局域网设备可访问(0.0.0.0 含 127.0.0.1),无需令牌 —— 仅在可信内网使用,任何能连上的设备都可进入。'}
                {mode === 'wan' && '对公网开放(0.0.0.0 含本机与局域网)—— 必须设置访问令牌,否则服务拒绝启动。建议同时启用 HTTPS。'}
              </div>
            </div>
            <div className="set-access-side">
              {mode !== 'local' && (
                <>
                  <label className="set-field"><span>访问令牌 · Token {mode === 'wan' && <b style={{ color: 'var(--danger)' }}>*</b>} {envWarn('accessToken') && <em>(env)</em>}</span>
                    <input type="password" autoComplete="off" value={token}
                      placeholder={data.hasAccessToken ? '已设置(留空不改)' : mode === 'wan' ? '必填' : '可选(留空 = 无令牌)'}
                      onChange={(e) => { setToken(e.target.value); setClearToken(false); }} />
                  </label>
                  {data.hasAccessToken && (
                    <label className="set-check"><input type="checkbox" checked={clearToken} onChange={(e) => { setClearToken(e.target.checked); if (e.target.checked) setToken(''); }} /> 清除已设置的令牌</label>
                  )}
                </>
              )}
              <label className="set-check"><input type="checkbox" checked={trustLoopback} onChange={(e) => setTrustLoopback(e.target.checked)} /> 信任本机请求(同机反代时关闭)</label>
            </div>
          </div>
        </div>
      </div>

      <div className="set-actions">
        <button className="cx-btn primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存设置'}</button>
        {saved && inHost && <button className="cx-btn" onClick={onRestart}>立即重启以生效</button>}
        {saved && <span className="set-saved">✓ 已保存,重启后生效</span>}
      </div>
    </div>
  );
}

// ---- Automation view (background jobs: schedule / manage / run history) ----
interface Job {
  id: string; name: string; kind: string; configJson: string;
  scheduleKind: string; cron?: string | null; runAt?: string | null; timezone?: string | null;
  enabled: boolean; autoCommit: boolean; timeoutSeconds?: number | null; maxRuns?: number | null;
  runCount: number; consecutiveFailures: number;
  nextRunAt?: string | null; lastRunAt?: string | null; lastStatus?: string | null;
}
interface JobRun {
  id: string; jobId: string; startedAt: string; finishedAt?: string | null;
  status: string; outcome?: string | null; detail?: string | null; durationMs?: number | null;
}
interface JobsSettings { enabled: boolean; pollSeconds: number; catchUpGraceHours: number; defaultTimeoutSeconds: number; maxConsecutiveFailures: number; maxRetries: number; retryBackoffSeconds: number; }
interface JobMeta { kinds: string[]; tools: { name: string; description: string }[]; settings: JobsSettings; }

const KIND_LABEL: Record<string, string> = { agent: '智能体任务', tool: '工具调用', notify: '定时提醒', report: '生成报告' };
const KIND_HINT: Record<string, string> = {
  agent: '交给 AI 执行、会改文件的任务(默认暂存待审阅)',
  report: 'AI 只读分析,产出一份报告',
  tool: '调用一个确定性工具(不耗 token)',
  notify: '到点发送一条提醒通知',
};
const CRON_PRESETS = [
  { label: '每天9点', cron: '0 9 * * *' },
  { label: '每周一9点', cron: '0 9 * * 1' },
  { label: '每月1号9点', cron: '0 9 1 * *' },
  { label: '每周日20点', cron: '0 20 * * 0' },
  { label: '每小时', cron: '0 * * * *' },
];
const STATUS_LABEL: Record<string, string> = {
  success: '成功', failed: '失败', timeout: '超时', staged: '待审阅', rejected: '已拒绝', skipped: '已跳过', running: '运行中',
};
const fmtWhen = (iso?: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '—');
// Scheduled instants are stored UTC; show them in the job's own timezone so "每天9点" reads as 09:00,
// not the UTC 01:00. Falls back to the raw slice if the tz/date is unusable.
const fmtWhenTz = (iso?: string | null, tz?: string | null) => {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: tz || undefined,
    }).format(new Date(iso)).replace(/\//g, '-');
  } catch { return fmtWhen(iso); }
};

function JobsView({ toast, confirm }: {
  toast: (t: string, k?: 'ok' | 'err') => void;
  confirm: (t: string, o?: { danger?: boolean; okText?: string }) => Promise<boolean>;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [settings, setSettings] = useState<JobsSettings | null>(null);
  const [meta, setMeta] = useState<JobMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [showForm, setShowForm] = useState(false);

  const [fName, setFName] = useState('');
  const [fKind, setFKind] = useState('report');
  const [fSchedule, setFSchedule] = useState<'once' | 'cron'>('cron');
  const [fCron, setFCron] = useState('0 9 * * *');
  const [fRunAt, setFRunAt] = useState('');
  const [fTimezone, setFTimezone] = useState('Asia/Shanghai');
  const [fInstructions, setFInstructions] = useState('');
  const [fTool, setFTool] = useState('');
  const [fNotifyTitle, setFNotifyTitle] = useState('');
  const [fNotifyBody, setFNotifyBody] = useState('');
  const [fAutoCommit, setFAutoCommit] = useState(false);
  const [fBusy, setFBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [j, m] = await Promise.all([
        fetch('/api/jobs').then((r) => r.json()),
        fetch('/api/jobs/meta').then((r) => r.json()),
      ]);
      setJobs(j.jobs ?? []);
      setSettings(j.settings ?? null);
      setMeta(m);
      if (m?.tools?.length) setFTool((prev) => prev || m.tools[0].name);
    } catch { /* leave */ } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openRuns = async (id: string) => {
    const d = await fetch(`/api/jobs/${id}/runs?limit=20`).then((r) => r.json()).catch(() => ({ runs: [] }));
    setRuns(d.runs ?? []);
  };
  const toggleOpen = (id: string) => {
    if (openId === id) { setOpenId(null); return; }
    setOpenId(id); setRuns([]); openRuns(id);
  };

  const toggleKill = async () => {
    if (!settings) return;
    const next = !settings.enabled;
    setSettings({ ...settings, enabled: next });
    await fetch('/api/jobs/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: next }) }).catch(() => {});
    toast(next ? '已启用后台任务调度' : '已暂停全部后台任务');
  };

  const submit = async () => {
    const config: Record<string, unknown> =
      fKind === 'agent' || fKind === 'report' ? { instructions: fInstructions }
      : fKind === 'tool' ? { tool: fTool, args: {} }
      : { title: fNotifyTitle || fName, body: fNotifyBody };
    setFBusy(true);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: fName, kind: fKind, config, schedule: fSchedule,
          cron: fSchedule === 'cron' ? fCron : undefined,
          runAt: fSchedule === 'once' ? fRunAt : undefined,
          timezone: fTimezone || undefined, autoCommit: fAutoCommit,
        }),
      });
      const jj = await res.json();
      if (res.ok) { toast('已创建任务'); setShowForm(false); setFName(''); setFInstructions(''); setFNotifyTitle(''); setFNotifyBody(''); load(); }
      else toast(`创建失败:${jj.error ?? res.status}`, 'err');
    } catch (e) { toast('创建失败:' + (e instanceof Error ? e.message : String(e)), 'err'); }
    finally { setFBusy(false); }
  };

  const setEnabled = async (job: Job, enabled: boolean) => {
    setJobs((prev) => prev.map((x) => (x.id === job.id ? { ...x, enabled } : x)));
    await fetch(`/api/jobs/${job.id}/enabled`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }).catch(() => {});
  };
  const runNow = async (job: Job) => {
    toast(`正在运行「${job.name}」…`);
    try {
      const res = await fetch(`/api/jobs/${job.id}/run`, { method: 'POST' });
      const jj = await res.json();
      if (res.ok) { toast(`运行完成:${jj.run?.outcome ?? jj.run?.status ?? ''}`); if (openId === job.id) openRuns(job.id); load(); }
      else toast(`运行失败:${jj.error ?? res.status}`, 'err');
    } catch (e) { toast('运行失败:' + (e instanceof Error ? e.message : String(e)), 'err'); }
  };
  const del = async (job: Job) => {
    if (!(await confirm(`删除任务「${job.name}」?`, { danger: true, okText: '删除' }))) return;
    await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {});
    if (openId === job.id) setOpenId(null);
    load();
  };
  const approve = async (run: JobRun) => {
    const res = await fetch(`/api/jobs/runs/${run.id}/approve`, { method: 'POST' });
    const jj = await res.json();
    if (res.ok) { toast(`已提交 ${jj.sha ?? ''}`); openRuns(run.jobId); }
    else toast(`提交失败:${jj.error ?? res.status}`, 'err');
  };
  const reject = async (run: JobRun) => {
    await fetch(`/api/jobs/runs/${run.id}/reject`, { method: 'POST' }).catch(() => {});
    openRuns(run.jobId); toast('已拒绝暂存的改动');
  };

  if (loading) return <div className="eval-empty">加载中…</div>;

  return (
    <div className="mng-view jobs">
      <div className="set-lead">
        后台任务:定时或一次性地跑分析报告、发提醒、执行工具或智能体任务。智能体改动默认<b>暂存待你审阅</b>。也可以直接在规划界面对 AI 说「每月…提醒我…」。
      </div>

      <div className="jobs-toolbar">
        <label className="set-check jobs-kill">
          <input type="checkbox" checked={!!settings?.enabled} onChange={toggleKill} />
          {settings?.enabled ? '调度已启用' : '调度已暂停(全局开关)'}
        </label>
        <button className="cx-btn primary" onClick={() => setShowForm((s) => !s)}>{showForm ? '取消' : '＋ 新建任务'}</button>
      </div>

      {showForm && (
        <div className="jobs-form">
          <div className="set-grid">
            <label className="set-field"><span>名称</span><input value={fName} onChange={(e) => setFName(e.target.value)} placeholder="如:月度预算复盘" /></label>
            <label className="set-field"><span>类型</span>
              <select value={fKind} onChange={(e) => setFKind(e.target.value)}>
                {(meta?.kinds ?? ['report', 'agent', 'tool', 'notify']).map((k) => <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>)}
              </select>
            </label>
          </div>
          <div className="jobs-kindhint">{KIND_HINT[fKind]}</div>

          {(fKind === 'agent' || fKind === 'report') && (
            <label className="set-field"><span>指令 · Instructions</span>
              <textarea value={fInstructions} rows={3} onChange={(e) => setFInstructions(e.target.value)} placeholder="交给 AI 的任务描述(遵循知识库规则)" />
            </label>
          )}
          {fKind === 'tool' && (
            <label className="set-field"><span>工具</span>
              <select value={fTool} onChange={(e) => setFTool(e.target.value)}>
                {(meta?.tools ?? []).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
              </select>
            </label>
          )}
          {fKind === 'notify' && (
            <div className="set-grid">
              <label className="set-field"><span>通知标题</span><input value={fNotifyTitle} onChange={(e) => setFNotifyTitle(e.target.value)} /></label>
              <label className="set-field"><span>通知内容</span><input value={fNotifyBody} onChange={(e) => setFNotifyBody(e.target.value)} /></label>
            </div>
          )}
          {fKind === 'agent' && (
            <label className="set-check"><input type="checkbox" checked={fAutoCommit} onChange={(e) => setFAutoCommit(e.target.checked)} /> 自动提交改动(不勾选 = 暂存待你审阅,更安全)</label>
          )}

          <div className="cx-seg jobs-seg">
            <button className={`cx-seg-b${fSchedule === 'cron' ? ' on' : ''}`} onClick={() => setFSchedule('cron')}>周期 · Cron</button>
            <button className={`cx-seg-b${fSchedule === 'once' ? ' on' : ''}`} onClick={() => setFSchedule('once')}>一次 · Once</button>
          </div>
          {fSchedule === 'cron' ? (
            <div className="set-grid">
              <label className="set-field"><span>cron 表达式</span>
                <input value={fCron} onChange={(e) => setFCron(e.target.value)} placeholder="0 9 * * 1" />
                <span className="jobs-presets">{CRON_PRESETS.map((p) => <button type="button" key={p.cron} onClick={() => setFCron(p.cron)}>{p.label}</button>)}</span>
              </label>
              <label className="set-field"><span>时区</span><input value={fTimezone} onChange={(e) => setFTimezone(e.target.value)} placeholder="Asia/Shanghai" /></label>
            </div>
          ) : (
            <label className="set-field"><span>执行时间 (ISO)</span><input value={fRunAt} onChange={(e) => setFRunAt(e.target.value)} placeholder="2026-09-01T09:00:00Z" /></label>
          )}

          <div className="set-actions">
            <button className="cx-btn primary" onClick={submit} disabled={fBusy || !fName}>{fBusy ? '创建中…' : '创建任务'}</button>
          </div>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="eval-empty">还没有后台任务。点「新建任务」,或在规划界面让 AI 帮你安排。</div>
      ) : (
        <div className="jobs-list">
          {jobs.map((job) => (
            <div className="jobs-item" key={job.id}>
              <div className="jobs-row">
                <button className="jobs-caret" onClick={() => toggleOpen(job.id)}>{openId === job.id ? '▾' : '▸'}</button>
                <div className="jobs-row-main" onClick={() => toggleOpen(job.id)}>
                  <div className="jobs-row-name">{job.name} <span className={`jobs-kind k-${job.kind}`}>{KIND_LABEL[job.kind] ?? job.kind}</span>{!job.enabled && <span className="jobs-off">已停用</span>}</div>
                  <div className="jobs-row-meta">
                    <span>{job.scheduleKind === 'cron' ? `cron ${job.cron}` : `一次 ${fmtWhenTz(job.runAt, job.timezone)}`}</span>
                    <span>下次 {fmtWhenTz(job.nextRunAt, job.timezone)}{job.timezone ? ` (${job.timezone})` : ''}</span>
                    {job.lastStatus && <span className={`jobs-st s-${job.lastStatus}`}>{STATUS_LABEL[job.lastStatus] ?? job.lastStatus}</span>}
                    <span>运行 {job.runCount} 次</span>
                  </div>
                </div>
                <div className="jobs-row-actions">
                  <label className="set-check" title={job.enabled ? '已启用' : '已停用'}>
                    <input type="checkbox" checked={job.enabled} onChange={(e) => setEnabled(job, e.target.checked)} />
                  </label>
                  <button className="cx-btn compact" onClick={() => runNow(job)}>运行</button>
                  <button className="cx-btn compact ghost" onClick={() => del(job)}>删除</button>
                </div>
              </div>
              {openId === job.id && (
                <div className="jobs-runs">
                  {runs.length === 0 ? <div className="jobs-runs-empty">暂无运行记录</div> : runs.map((r) => (
                    <div className={`jobs-run s-${r.status}`} key={r.id}>
                      <span className={`jobs-st s-${r.status}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
                      <span className="jobs-run-out">{r.outcome ?? ''}</span>
                      <span className="jobs-run-when">{fmtWhen(r.startedAt)}</span>
                      {r.status === 'staged' && (
                        <span className="jobs-run-btns">
                          <button className="cx-btn compact primary" onClick={() => approve(r)}>批准提交</button>
                          <button className="cx-btn compact ghost" onClick={() => reject(r)}>拒绝</button>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
