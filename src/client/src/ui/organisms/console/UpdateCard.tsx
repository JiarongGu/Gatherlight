// 更新 · Update — the release check + staged download, and the host restart that applies it.
//
// A section of the management console, lifted out of screens/Manage.tsx once that screen had reached
// 1957 lines holding eight of these. A screen is a surface you navigate TO; this renders inside one.
// See ./index.ts for why they share a folder.

import { useEffect, useRef, useState } from 'react';
import { hostPost, inHost } from '@/lib/host';

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

export function UpdateCard() {
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
              <button className="mng-btn primary compact" onClick={() => hostPost('applyUpdate')}>重启并安装</button>
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
