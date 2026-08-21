import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCount } from '@/lib/format';
import { MigrationOverlay } from '@/ui/organisms/MigrationOverlay';
// The console's eight sections. This screen is the SHELL — health poll, tabs, toast, confirm, the
// host bridge and the overview — and mounts one section per tab. It used to hold all of them inline,
// at 1957 lines; see ui/organisms/console/index.ts for the boundary.
import {
  CortexPanel, EvalPanel, JobsPanel, LogsPanel, McpPanel, ResourcesPanel, SettingsPanel, SetupWizard,
  UpdateCard,
} from '@/ui/organisms/console';
// The desktop host's native actions (restart / open data folder / open planner / exit / file dialogs)
// go through the one seam in lib/host.ts — see its header for why this is not three call sites any
// more. Opened in a plain browser, the page still monitors health + counts and does what it can
// in-page; every helper there no-ops and reports it, so nothing here needs an `inHost` branch except
// where the BROWSER has a real alternative.
import { documentTheme, hostClose, hostPost, hostTheme, inHost, onHostMessage, type HostAction } from '@/lib/host';

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
  const [view, setView] = useState<'overview' | 'eval' | 'cortex' | 'jobs' | 'mcp' | 'resources' | 'logs' | 'settings'>('overview');
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
    hostClose(choice, rememberClose);
  };

  // Host → web bridge: the desktop host posts result notices (backup / restore / memory export+import)
  // back to the console so they render as styled in-page toasts, not native MessageBoxes.
  useEffect(() =>
    onHostMessage((m) => {
      if (m.type === 'toast') toast(String(m.text ?? ''), m.kind === 'err' ? 'err' : 'ok');
      else { setRememberClose(false); setClosing(true); }
    }), [toast]);

  // Mirror the console's active theme to the desktop host so its native window + tray menu match
  // whichever theme (light ↔ dark) the user is running — posted on mount and on every change.
  useEffect(() => {
    if (!inHost) return;
    const send = () => hostTheme(documentTheme());
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
  // These read "ask the host; if there is no host, do the browser thing" — hostPost reports whether it
  // was delivered, so the fallback hangs off the attempt rather than off a separate `inHost` test that
  // could drift out of step with it.
  const openPlanner = () => { if (!hostPost('openPlanner')) window.open(plannerUrl, '_blank'); };

  const exportMemory = () => {
    if (!hostPost('exportMemory')) window.open('/api/memory/export', '_blank');
    toast('正在导出记忆(知识库 + 事实 + 校准)…');
  };
  // Shared "pick a file → POST it → toast the result" flow. In-host defers the file dialog + upload to
  // the native host, but the destructive confirm is shown here (styled) first. In a plain browser the
  // file is picked (keeping the click's user-gesture), then confirmed, then POSTed.
  const importFile = async (opts: {
    hostAction: HostAction; accept: string; url: string; contentType: string;
    body: (f: File) => BodyInit | Promise<BodyInit>; confirm?: string;
    ok: (j: any) => string; errPrefix: string;
  }) => {
    if (inHost) {
      if (opts.confirm && !(await confirm(opts.confirm, { danger: true, okText: '继续恢复' }))) return;
      hostPost(opts.hostAction);
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
    if (!hostPost('exportBackup')) window.open('/api/backup/export', '_blank');
    toast('正在导出完整备份(整个数据文件夹:计划 · 家庭 · 知识库 · 历史 · 记忆)…');
  };
  const importBackup = () => importFile({
    hostAction: 'importBackup', accept: '.zip', url: '/api/backup/import', contentType: 'application/zip',
    body: (f) => f, confirm: '恢复将覆盖当前的计划 / 家庭 / 知识库,并合并记忆。确定继续?',
    ok: (j) => `已从备份恢复:${j.restored?.files ?? 0} 个文件`, errPrefix: '恢复失败',
  });
  const restart = () => { hostPost('serverRestart'); toast('已发送重启指令,服务将很快恢复…'); };
  const stopServer = () => { hostPost('serverStop'); toast('已停止本地服务 —— 需要时点「启动」恢复。'); };
  const startServer = () => { hostPost('serverStart'); toast('正在启动本地服务…'); };

  const hColor = healthy === null ? 'var(--muted)' : healthy ? 'var(--success)' : 'var(--danger)';
  const statusText = healthy === null ? '检查中…' : healthy ? '运行正常 · Healthy' : '无响应 · Not responding';

  return (
    <div className="mng" style={{ minHeight: '100vh' }}>
      <MigrationOverlay />
      <div className="mng-tabs">
        <div className="mng-tabs-inner">
          <button className={`mng-tab${view === 'overview' ? ' on' : ''}`} onClick={() => setView('overview')}>概览 · Overview</button>
          <button className={`mng-tab${view === 'eval' ? ' on' : ''}`} onClick={() => setView('eval')}>对话评估 · Eval</button>
          <button className={`mng-tab${view === 'cortex' ? ' on' : ''}`} onClick={() => setView('cortex')}>校准 · Cortex</button>
          <button className={`mng-tab${view === 'jobs' ? ' on' : ''}`} onClick={() => setView('jobs')}>自动化 · Jobs</button>
          <button className={`mng-tab${view === 'mcp' ? ' on' : ''}`} onClick={() => setView('mcp')}>MCP 服务 · MCP</button>
          <button className={`mng-tab${view === 'resources' ? ' on' : ''}`} onClick={() => setView('resources')}>资源 · Resources</button>
          <button className={`mng-tab${view === 'logs' ? ' on' : ''}`} onClick={() => setView('logs')}>日志 · Logs</button>
          <button className={`mng-tab${view === 'settings' ? ' on' : ''}`} onClick={() => setView('settings')}>设置 · Settings</button>
        </div>
      </div>

      {view === 'eval' && <EvalPanel />}
      {view === 'cortex' && <CortexPanel toast={toast} onRestart={restart} />}
      {view === 'jobs' && <JobsPanel toast={toast} confirm={confirm} />}
      {view === 'mcp' && <McpPanel toast={toast} confirm={confirm} />}
      {view === 'resources' && <ResourcesPanel toast={toast} onRestart={restart} />}
      {view === 'logs' && <LogsPanel />}
      {view === 'settings' && <SettingsPanel toast={toast} onRestart={restart} />}

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
        <div className="mng-metric"><div className="n">{formatCount(counts.plans)}</div><div className="l">计划 Plans</div></div>
        <div className="mng-metric"><div className="n">{formatCount(counts.library)}</div><div className="l">知识库 Library</div></div>
        <div className="mng-metric"><div className="n">{formatCount(counts.tools)}</div><div className="l">工具 Tools</div></div>
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
          <button className="mng-btn" onClick={() => hostPost('openDataFolder')}>
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
          <button className="mng-btn danger" onClick={() => hostPost('exit')}>
            退出<span className="sub">stop the server + quit</span>
          </button>
        )}
      </div>

      <UpdateCard />
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
        <SetupWizard toast={toast} onRestart={restart} onDone={() => setNeedsSetup(false)} />
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
