// 设置 · Settings — server name, access mode, token; the values that need a restart.
//
// A section of the management console, lifted out of screens/Manage.tsx once that screen had reached
// 1957 lines holding eight of these. A screen is a surface you navigate TO; this renders inside one.
// See ./index.ts for why they share a folder.

import { useEffect, useState } from 'react';
import { PanelButton } from '@/ui/atoms';
import { inHost } from '@/lib/host';
import { Segmented, Field, CheckField } from '@/ui/molecules';

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

export function SettingsPanel({ toast, onRestart }: { toast: (t: string, k?: 'ok' | 'err') => void; onRestart: () => void }) {
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
          <Field label="实例名称 · Server name">
            <input value={serverName} onChange={(e) => setServerName(e.target.value)} />
          </Field>
          <Field label={<>端口 · Port {envWarn('port') && <em>(env)</em>}</>}>
            <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} />
          </Field>
          <Field label={<>日志级别 · Log level {envWarn('logLevel') && <em>(env)</em>}</>}>
            <select value={logLevel} onChange={(e) => setLogLevel(e.target.value)}>
              {['Trace', 'Debug', 'Information', 'Warning', 'Error', 'Critical'].map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </Field>
          {inHost && (
            <Field label="关闭窗口时 · On window close">
              <select value={closeAction} onChange={(e) => setCloseAction(e.target.value)}>
                <option value="ask">每次询问 · Ask each time</option>
                <option value="tray">最小化到托盘 · Minimize to tray</option>
                <option value="exit">退出程序 · Exit</option>
              </select>
            </Field>
          )}
        </div>

        <div className="set-group">
          <div className="set-group-h">更新源 · Updates</div>
          <Field label={<>GitHub 仓库 {envWarn('selfUpdate.githubRepo') && <em>(env)</em>}</>}>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name(留空 = 关闭)" />
          </Field>
          <div className="set-group-h" style={{ marginTop: 14 }}>HTTPS / TLS</div>
          <CheckField checked={tlsEnabled} onChange={(v) => setTlsEnabled(v)}>启用 HTTPS(默认自签,浏览器会提示)</CheckField>
          <Field label="证书 · Cert (PFX)">
            <input value={certPath} onChange={(e) => setCertPath(e.target.value)} placeholder="留空 = 自签" />
          </Field>
        </div>

        <div className="set-group set-span">
          <div className="set-group-h">访问范围 · Access {envWarn('bindAddress') && <em>(env)</em>}</div>
          <div className="set-access">
            <div className="set-access-main">
              <Segmented
                className="set-access-seg"
                value={mode}
                onSelect={setMode}
                options={[
                  { value: 'local', label: '本机 · Local' },
                  { value: 'lan', label: '局域网 · LAN' },
                  { value: 'wan', label: '公网 · WAN' },
                ]}
              />
              {/* WAN + no TLS is a bearer token crossing the internet in PLAINTEXT, and it used to look
                  exactly as calm as a safe setup: the danger styling keyed only on a missing token, and
                  HTTPS was a 建议 in the same grey sentence. The token claim itself is enforced (the
                  service refuses to start without one) — this is the half that was true, correctly
                  labelled advice, and invisible. Called out separately rather than folded into the hint,
                  because it is a DIFFERENT hole from having no token and is fixed by a different switch. */}
              {mode === 'wan' && !tlsEnabled && (
                <div className="set-hint danger">
                  ⚠ 没有启用 HTTPS:访问令牌会以明文经过互联网传输,任何中间环节都能读到它 ——
                  读到就等于拿到这台机器上全部资料的访问权。请在下方勾选「启用 HTTPS」(自签证书即可,
                  浏览器会提示一次)。
                </div>
              )}
              <div className={`set-hint${mode === 'wan' && !data.hasAccessToken && !token ? ' danger' : ''}`}>
                {mode === 'local' && '仅本机可访问(127.0.0.1)—— 最安全,无需令牌。'}
                {mode === 'lan' && '本机 + 局域网设备可访问(0.0.0.0 含 127.0.0.1),无需令牌 —— 仅在可信内网使用,任何能连上的设备都可进入。'}
                {mode === 'wan' && '对公网开放(0.0.0.0 含本机与局域网)—— 必须设置访问令牌,否则服务拒绝启动。建议同时启用 HTTPS。'}
              </div>
            </div>
            <div className="set-access-side">
              {mode !== 'local' && (
                <>
                  <Field label={<>访问令牌 · Token {mode === 'wan' && <b style={{ color: 'var(--danger)' }}>*</b>} {envWarn('accessToken') && <em>(env)</em>}</>}>
                    <input type="password" autoComplete="off" value={token}
                      placeholder={data.hasAccessToken ? '已设置(留空不改)' : mode === 'wan' ? '必填' : '可选(留空 = 无令牌)'}
                      onChange={(e) => { setToken(e.target.value); setClearToken(false); }} />
                  </Field>
                  {data.hasAccessToken && (
                    <CheckField checked={clearToken} onChange={(v) => { setClearToken(v); if (v) setToken(''); }}>清除已设置的令牌</CheckField>
                  )}
                </>
              )}
              <CheckField checked={trustLoopback} onChange={(v) => setTrustLoopback(v)}>信任本机请求(同机反代时关闭)</CheckField>
            </div>
          </div>
        </div>
      </div>

      <div className="set-actions">
        <PanelButton variant="primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存设置'}</PanelButton>
        {saved && inHost && <PanelButton onClick={onRestart}>立即重启以生效</PanelButton>}
        {saved && <span className="set-saved">✓ 已保存,重启后生效</span>}
      </div>
    </div>
  );
}
