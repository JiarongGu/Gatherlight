// MCP 服务 · MCP — external servers this install connects OUT to, and their login state.
//
// A section of the management console, lifted out of screens/Manage.tsx once that screen had reached
// 1957 lines holding eight of these. A screen is a surface you navigate TO; this renders inside one.
// See ./index.ts for why they share a folder.

import { useCallback, useEffect, useState } from 'react';

interface McpServer {
  id: string;
  name: string;
  transport: string;
  command?: string | null;
  args: string[];
  url?: string | null;
  enabled: boolean;
  status: string;
  lastError?: string | null;
  hasSecrets: boolean;
  loginKind: string;
  needsLogin: boolean;
  tools: { name: string; description: string }[];
}

interface McpLoginState {
  serverId: string;
  name: string;
  challenge: { imageDataUri?: string | null; url?: string | null; text?: string | null; message: string };
  loggedIn: boolean;
}

const MCP_STATUS: Record<string, { label: string; color: string }> = {
  connected: { label: '已连接', color: '#2e7d32' },
  error: { label: '连接失败', color: '#c62828' },
  disabled: { label: '已停用', color: '#888' },
  pending: { label: '待连接', color: '#b26a00' }
};

// Minimal, read-mostly management of external MCP servers. Adding is deliberately NOT here — it
// runs through the chat confirmation gate (human confirms the concrete spec + enters credentials).
// This panel lists what's configured, its live status + proxied tools, and lets you disable/remove.
export function McpPanel({ toast, confirm }: {
  toast: (t: string, k?: 'ok' | 'err') => void;
  confirm: (t: string, o?: { danger?: boolean; okText?: string }) => Promise<boolean>;
}) {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [login, setLogin] = useState<McpLoginState | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/manage/mcp-servers');
      setServers(await r.json());
    } catch {
      setServers([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // While a login modal is open and not yet complete, poll the server's login status. When it flips
  // to logged-in, refresh the list (the server can now do authenticated calls).
  useEffect(() => {
    if (!login || login.loggedIn) return;
    let stop = false;
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`/api/manage/mcp-servers/${login.serverId}/login/status`);
        const st = await r.json();
        if (!stop && st?.loggedIn) {
          setLogin((l) => (l ? { ...l, loggedIn: true } : l));
          toast('登录成功');
          load();
        }
      } catch { /* keep polling */ }
    }, 2000);
    return () => { stop = true; clearInterval(iv); };
  }, [login, load, toast]);

  const startLogin = async (s: McpServer) => {
    try {
      const r = await fetch(`/api/manage/mcp-servers/${s.id}/login/start`, { method: 'POST' });
      const challenge = await r.json();
      if (!r.ok) { toast(challenge?.error ?? '登录启动失败', 'err'); return; }
      setLogin({ serverId: s.id, name: s.name, challenge, loggedIn: false });
    } catch (e) {
      toast('登录启动失败:' + (e instanceof Error ? e.message : String(e)), 'err');
    }
  };

  const setEnabled = async (s: McpServer, enabled: boolean) => {
    setServers((prev) => prev?.map((x) => (x.id === s.id ? { ...x, enabled } : x)) ?? prev);
    try {
      const r = await fetch(`/api/manage/mcp-servers/${s.id}/enabled`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled })
      });
      if (!r.ok) throw new Error(String(r.status));
      toast(enabled ? '已启用' : '已停用');
    } catch (e) {
      toast('操作失败:' + (e instanceof Error ? e.message : String(e)), 'err');
    }
    load();
  };
  const del = async (s: McpServer) => {
    if (!(await confirm(`移除 MCP 服务「${s.name}」?它的工具将不再可用。`, { danger: true, okText: '移除' }))) return;
    try {
      await fetch(`/api/manage/mcp-servers/${s.id}`, { method: 'DELETE' });
      toast('已移除');
    } catch (e) {
      toast('移除失败:' + (e instanceof Error ? e.message : String(e)), 'err');
    }
    load();
  };

  if (servers === null) return <div className="eval-empty">加载中…</div>;

  return (
    <div className="mng-view mcp">
      <div className="set-lead">
        外部 MCP 服务:Gatherlight 连接到这些服务,并把它们的工具提供给 AI 使用。
        <b>要新增,请在规划界面对 AI 说「帮我接入 …… MCP」</b> —— 会弹出确认卡片,核对启动命令、填入登录凭据后生效(凭据仅存本机,不写入对话记录)。
      </div>
      {servers.length === 0 ? (
        <div className="eval-empty">还没有外部 MCP 服务。去规划界面让 AI 帮你接入一个。</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {servers.map((s) => {
            const st = MCP_STATUS[s.status] ?? { label: s.status, color: '#888' };
            const launch = s.transport === 'http' ? (s.url ?? '') : [s.command, ...(s.args ?? [])].filter(Boolean).join(' ');
            return (
              <div key={s.id} style={{ border: '1px solid rgba(0,0,0,0.12)', borderRadius: 6, padding: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <b>{s.name}</b>
                  <span style={{ color: st.color, fontSize: 12, fontWeight: 600 }}>● {st.label}</span>
                  <span style={{ fontSize: 12, opacity: 0.7, fontFamily: 'monospace' }}>{s.transport}</span>
                  {s.hasSecrets && <span style={{ fontSize: 12, opacity: 0.7 }}>🔑 已存凭据</span>}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
                    {s.needsLogin && (
                      <button className="cx-btn primary" onClick={() => startLogin(s)}>登录</button>
                    )}
                    <label className="set-check" style={{ margin: 0 }}>
                      <input type="checkbox" checked={s.enabled} onChange={(e) => setEnabled(s, e.target.checked)} />
                      {s.enabled ? '启用' : '停用'}
                    </label>
                    <button className="cx-btn" onClick={() => del(s)}>移除</button>
                  </span>
                </div>
                <code style={{ display: 'block', marginTop: 6, fontSize: 12, wordBreak: 'break-all', opacity: 0.85 }}>{launch}</code>
                {s.lastError && <div style={{ marginTop: 6, fontSize: 12, color: '#c62828' }}>⚠️ {s.lastError}</div>}
                {s.tools.length > 0 && (
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>工具:{s.tools.map((t) => t.name).join('、')}</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {login && (
        <div
          onClick={() => setLogin(null)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: 'var(--bg, #fff)', borderRadius: 10, padding: 24, width: 340, textAlign: 'center', boxShadow: '0 8px 40px rgba(0,0,0,0.25)' }}
          >
            <div style={{ fontWeight: 600, marginBottom: 12 }}>登录 {login.name}</div>
            {login.loggedIn ? (
              <div style={{ padding: '24px 0', color: '#2e7d32', fontSize: 16 }}>✅ 已登录</div>
            ) : (
              <>
                {login.challenge.imageDataUri && (
                  <img
                    src={login.challenge.imageDataUri}
                    alt="登录二维码"
                    style={{ width: 220, height: 220, imageRendering: 'pixelated', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 6 }}
                  />
                )}
                {login.challenge.url && (
                  <div style={{ margin: '12px 0', wordBreak: 'break-all' }}>
                    <a href={login.challenge.url} target="_blank" rel="noreferrer">{login.challenge.url}</a>
                  </div>
                )}
                <div style={{ marginTop: 12, opacity: 0.85 }}>{login.challenge.message}</div>
                {login.challenge.text && (
                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7, whiteSpace: 'pre-wrap' }}>{login.challenge.text}</div>
                )}
                <div style={{ marginTop: 12, fontSize: 12, opacity: 0.6 }}>等待登录完成…（每 2 秒自动检测）</div>
              </>
            )}
            <div style={{ marginTop: 16 }}>
              <button className="cx-btn" onClick={() => setLogin(null)}>{login.loggedIn ? '完成' : '关闭'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
