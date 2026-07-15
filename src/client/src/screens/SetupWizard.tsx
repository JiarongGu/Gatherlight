import { useEffect, useState } from 'react';

// First-run setup wizard. Shown by Manage when GET /api/manage/settings reports setupCompleted=false
// (a truly fresh install — settings.json didn't exist yet). Walks server name → access mode → done,
// writes them via PUT /api/manage/settings with markSetupComplete=true, then hands back to the console.
// Styled on-brand (lantern-paper), not a generic wizard.

type Mode = 'local' | 'lan' | 'wan';

const MODES: { key: Mode; icon: string; title: string; desc: string }[] = [
  { key: 'local', icon: '🏠', title: '仅本机 · Local', desc: '只有这台电脑能访问(127.0.0.1)。最安全,推荐默认。' },
  { key: 'lan', icon: '🌐', title: '局域网 · LAN', desc: '同一 Wi-Fi / 网络下的其他设备可访问,无需令牌。仅用于可信的家庭网络。' },
  { key: 'wan', icon: '🔒', title: '公网 · WAN', desc: '对外开放,必须设置访问令牌。用于远程访问。' },
];

export default function SetupWizard({
  inHost, onDone, onRestart, toast,
}: {
  inHost: boolean;
  onDone: () => void;
  onRestart: () => void;
  toast: (t: string, k?: 'ok' | 'err') => void;
}) {
  const [step, setStep] = useState(0);
  const [serverName, setServerName] = useState('');
  const [mode, setMode] = useState<Mode>('local');
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await (await fetch('/api/manage/settings')).json();
        if (s.serverName) setServerName(s.serverName);
      } catch { /* keep the placeholder */ }
    })();
  }, []);

  const finish = async () => {
    if (mode === 'wan' && token.trim().length < 8) {
      toast('公网模式需要一个至少 8 位的访问令牌', 'err');
      setStep(1);
      return;
    }
    setSaving(true);
    const body: Record<string, unknown> = { serverName: serverName.trim() || undefined, markSetupComplete: true };
    if (mode === 'local') { body.bindAddress = '127.0.0.1'; body.allowLanWithoutToken = false; }
    else if (mode === 'lan') { body.bindAddress = '0.0.0.0'; body.allowLanWithoutToken = true; }
    else { body.bindAddress = '0.0.0.0'; body.allowLanWithoutToken = false; body.accessToken = token.trim(); }
    try {
      const res = await fetch('/api/manage/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) { toast(j.error ?? '保存失败', 'err'); setSaving(false); return; }
      onDone();
      if (mode !== 'local') {
        // Access mode applies at startup — a fresh install defaults to loopback, so only lan/wan restart.
        if (inHost) { toast('设置已保存,正在按新的访问模式重启服务…'); onRestart(); }
        else toast('设置已保存 · 请重启服务以应用新的访问模式', 'ok');
      } else {
        toast('设置完成 · 欢迎使用拾光');
      }
    } catch (e) {
      toast('保存失败:' + (e instanceof Error ? e.message : String(e)), 'err');
      setSaving(false);
    }
  };

  const openPlanner = () => (inHost
    ? (window as unknown as { chrome?: { webview?: { postMessage(m: string): void } } }).chrome?.webview?.postMessage('openPlanner')
    : window.open(`${location.origin}/`, '_blank'));

  return (
    <div className="mng-modal-overlay wiz" role="dialog" aria-modal="true">
      <div className="mng-wiz">
        <div className="mng-wiz-head">
          <span className="mng-wiz-mark" />
          <div>
            <div className="ttl">拾光 · Gatherlight</div>
            <div className="sub">首次设置 · Welcome — 三步即可开始</div>
          </div>
          <div className="mng-wiz-dots">
            {[0, 1, 2].map((i) => <span key={i} className={`d${i === step ? ' on' : ''}${i < step ? ' done' : ''}`} />)}
          </div>
        </div>

        <div className="mng-wiz-body">
          {step === 0 && (
            <div className="mng-wiz-step">
              <h3>给这个实例起个名字</h3>
              <p className="hint">显示在管理控制台与健康检查里,方便区分多台设备 / 多个家庭实例。</p>
              <input
                className="mng-wiz-input" value={serverName} placeholder="例如:客厅电脑上的拾光"
                onChange={(e) => setServerName(e.target.value)} autoFocus
              />
            </div>
          )}

          {step === 1 && (
            <div className="mng-wiz-step">
              <h3>谁可以访问?</h3>
              <p className="hint">你的数据文件夹是家庭的隐私,并且服务能调用本机的 claude。对外开放请务必谨慎。</p>
              <div className="mng-wiz-modes">
                {MODES.map((m) => (
                  <button key={m.key} className={`mng-wiz-mode${mode === m.key ? ' on' : ''}`} onClick={() => setMode(m.key)}>
                    <span className="ic">{m.icon}</span>
                    <span className="tx"><span className="t">{m.title}</span><span className="d">{m.desc}</span></span>
                  </button>
                ))}
              </div>
              {mode === 'wan' && (
                <input
                  className="mng-wiz-input" type="password" value={token} placeholder="访问令牌(至少 8 位)"
                  onChange={(e) => setToken(e.target.value)} autoFocus
                />
              )}
            </div>
          )}

          {step === 2 && (
            <div className="mng-wiz-step">
              <h3>一切就绪</h3>
              <p className="hint">
                拾光是一个 AI 家庭规划助手 —— 在规划界面用对话来安排行程、预算、清单;每次改动都会先给你审阅再保存。
              </p>
              <ul className="mng-wiz-summary">
                <li><span>名称</span><b>{serverName.trim() || '拾光'}</b></li>
                <li><span>访问</span><b>{MODES.find((m) => m.key === mode)?.title}</b></li>
              </ul>
              <button className="mng-wiz-planner" onClick={openPlanner}>先去规划界面看看 →</button>
            </div>
          )}
        </div>

        <div className="mng-wiz-foot">
          <button className="mng-mbtn" disabled={step === 0 || saving} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            上一步
          </button>
          {step < 2 ? (
            <button className="mng-mbtn primary" onClick={() => setStep((s) => Math.min(2, s + 1))}>下一步</button>
          ) : (
            <button className="mng-mbtn primary" disabled={saving} onClick={finish}>{saving ? '保存中…' : '开始使用'}</button>
          )}
        </div>
      </div>
    </div>
  );
}
