// 资源 · Resources — the download-at-setup runtimes and the models provisioned beside them.
//
// A section of the management console, lifted out of screens/Manage.tsx once that screen had reached
// 1957 lines holding eight of these. A screen is a surface you navigate TO; this renders inside one.
// See ./index.ts for why they share a folder.

import { useEffect, useState } from 'react';
import { ResourceRow } from '@/ui/molecules';
import { inHost } from '@/lib/host';
import { LocalModelsPanel } from './LocalModelsPanel';

// ---- Memory view (记忆检索 — three INDEPENDENT switches, not one setting) ------------------------
// Formula is the floor and always on; the other two cost different things and improve different things,
// so they toggle separately: verification REORDERS what was retrieved, embeddings change what is
// RETRIEVABLE. Every switch is a startup registration, so `enabled` (saved) and `active` (running) are
// reported separately — between saving and restarting they disagree, and showing only the saved value
// would claim a feature that is not running.
// Module scope: the section's own `mb` is a local, and the pickers below are separate components.
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
  // Only the claude CLI tracks a version: git and node are pinned to a version WE chose, so "newer exists"
  // is a fact about our source, not the household's install. `detail` carries the CLI's login state —
  // the difference between installed and usable, which no other resource has.
  version: string | null;
  available: string | null;
  detail: string | null;
}

// An update exists only when BOTH versions are known and they differ. Unknown-vs-known is NOT an update:
// a household running a machine-wide CLI has no version marker of ours, and nagging them to "update"
// something we never installed would be a button that quietly replaces their own install.
// A MODEL goes in the 本机模型 section, even though the provisioner owns it like any other resource.
// Listing it up beside Git and Chromium put models in two places again — the split that section exists
// to end — and made its own lead text ("both layers take their models from here") false for the one
// backend that needs nothing installed.
const MODEL_RESOURCES = ['embed-model'];

const hasUpdate = (r: ResourceStatus) => !!r.version && !!r.available && r.version !== r.available;

export function ResourcesPanel({ toast, onRestart }: { toast: (t: string, k?: 'ok' | 'err') => void; onRestart: () => void }) {
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

  // (size formatting now belongs to ResourceRow, which is the thing that renders it)
  if (!items) return <div className="eval-empty">加载中…</div>;

  // A MODEL goes in the models section, even though the provisioner owns it like any other resource.
  const runtimes = items.filter((r) => !MODEL_RESOURCES.includes(r.id));
  const modelRows = items.filter((r) => MODEL_RESOURCES.includes(r.id));

  return (
    <div className="mng-view set">
      <div className="set-lead">
        大型资源(Chromium、Git、Claude CLI 等)按需下载到数据文件夹,不打包进安装包 —— 保持安装包小巧。下载一次即长期保留(应用更新不会清除)。
      </div>
      <div className="res-list">
        {runtimes.map((r) => (
          <ResourceRow
            key={r.id}
            name={r.name}
            badges={r.installed && <span className="res-badge">已安装</span>}
            installed={r.installed}
            failed={r.state === 'error'}
            lines={
              <>
                <div className="res-need">{r.neededFor}</div>
                {/* The CLI's login state rides here — the difference between installed and usable. */}
                {r.detail && <div className="res-need">{r.detail}</div>}
                {r.version && (
                  <div className="res-need">
                    当前版本 {r.version}
                    {hasUpdate(r) && <span className="res-badge">可更新 → {r.available}</span>}
                  </div>
                )}
              </>
            }
            progress={r.state === 'running' ? { percent: r.percent, message: r.message } : null}
            problem={r.state === 'error' ? `下载失败:${r.message}` : null}
            approxBytes={r.approxBytes}
            action={r.state === 'running' ? (
              <span className="res-running">下载中…</span>
            ) : (
              <button className={`cx-btn${r.installed && !hasUpdate(r) ? '' : ' primary'}`} onClick={() => provision(r.id)}>
                {hasUpdate(r) ? '更新' : r.installed ? '重新下载' : '下载'}
              </button>
            )}
          />
        ))}
      </div>
      {/* Models are provisioned artifacts too, so they live beside chromium and git — one panel for
          everything downloaded into the data folder, including the runtime that hosts them. Which model
          each recall layer USES stays in 校准 · Cortex → 记忆检索, because that is a recall decision and
          not a provisioning one. */}
      <LocalModelsPanel toast={toast} builtIn={modelRows} provision={provision} />
      {inHost && (
        <div className="set-actions">
          <button className="cx-btn" onClick={onRestart}>重启服务</button>
          <span className="set-saved">部分资源(如 Git)需重启后生效</span>
        </div>
      )}
    </div>
  );
}
