// 资源 · Resources — the download-at-setup runtimes and the models provisioned beside them.
//
// A section of the management console, lifted out of screens/Manage.tsx once that screen had reached
// 1957 lines holding eight of these. A screen is a surface you navigate TO; this renders inside one.
// See ./index.ts for why they share a folder.

import { useEffect, useState } from 'react';
import { PanelButton, PanelBadge } from '@/ui/atoms';
import { ResourceRow, Segmented } from '@/ui/molecules';
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
  /** WHAT it is — 'runtime' (a program) or 'model' (weights). Declared by the server, because the client
   *  deciding this from a list of ids is what put three models in the runtimes column: the list said
   *  `embed-gguf` while the ids had become `gguf-<model>`, and nothing failed — the rows just moved. */
  category: 'runtime' | 'model';
}

// An update exists only when BOTH versions are known and they differ. Unknown-vs-known is NOT an update:
// a household running a machine-wide CLI has no version marker of ours, and nagging them to "update"
// something we never installed would be a button that quietly replaces their own install.
// A MODEL goes in the 本机模型 section, even though the provisioner owns it like any other resource.
// Listing it up beside Git and Chromium put models in two places again — the split that section exists
// to end — and made its own lead text ("both layers take their models from here") false for the one
// backend that needs nothing installed.
// Grouping is the SERVER's answer now (ResourceCategory). The hardcoded id list this replaces drifted
// within two commits of being written — a rename of the GGUF ids left it matching nothing, silently.

// Both rows were hidden for one commit, while llama.cpp was provisionable but nothing could BIND to it —
// a 下载 button that fetches 354 MB and changes nothing is the dead control this console keeps refusing.
// 记忆检索 now offers llama.cpp on both layers, so they are offered again. Kept as an empty list rather
// than deleted: the next provisioned-but-unreachable resource wants exactly this, and the reasoning is
// easier to find here than in a commit message.
const NOT_YET_REACHABLE: string[] = [];

const hasUpdate = (r: ResourceStatus) => !!r.version && !!r.available && r.version !== r.available;

export function ResourcesPanel({ toast, onRestart }: { toast: (t: string, k?: 'ok' | 'err') => void; onRestart: () => void }) {
  const [items, setItems] = useState<ResourceStatus[] | null>(null);
  /** Which login the app's own spawns use, and where its own credentials live. Sent with the list rather
   *  than fetched separately, so the switch and the rows can never describe different states. */
  const [session, setSession_] = useState<{ mode: 'machine' | 'app'; home: string } | null>(null);
  const load = async () => {
    try {
      const d = await (await fetch('/api/manage/resources')).json();
      setItems(d.resources);
      if (d.claudeSession) setSession_(d.claudeSession);
    } catch {
      /* keep last */
    }
  };
  useEffect(() => { load(); }, []);

  // The CLI's login line is filled in by a PROCESS SPAWN (~0.6–0.9 s), so the server no longer waits for
  // it before answering: a cold cache sends `detail: null` and refreshes in the background. Null means
  // "not known yet" — distinct from "not signed in" — so this asks again, ONCE, rather than leaving 检查中…
  // on screen for ever. Not a poll: the answer is cached server-side once it arrives, so one retry is
  // enough, and an idle panel must not spawn processes on a timer.
  // A FEW attempts, not one — the probe it waits for costs 0.6–0.9 s, so a single fixed retry sits right
  // on top of its own answer and a slow machine loses the race permanently (the gate boolean never changes,
  // so the effect never fires again). Keyed on the attempt count so it re-runs; capped so it stays a retry
  // rather than becoming a poll that spawns a process every second on an idle screen.
  const [loginTries, setLoginTries] = useState(0);
  const claudeUnknown = items?.some((r) => r.id === 'claude' && !r.detail) ?? false;
  useEffect(() => {
    if (!claudeUnknown || loginTries >= 5) return;
    const t = setTimeout(() => { setLoginTries((n) => n + 1); load(); }, 800);
    return () => clearTimeout(t);
  }, [claudeUnknown, loginTries]);

  const setSession = async (mode: 'machine' | 'app') => {
    try {
      const res = await fetch('/api/manage/resources/claude/session', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const j = await res.json().catch(() => ({}));
      toast(j.note ?? j.error ?? '已保存', res.ok ? 'ok' : 'err');
      await load();
    } catch { toast('请求失败', 'err'); }
  };

  const logout = async () => {
    try {
      const res = await fetch('/api/manage/resources/claude/logout', { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      toast(j.note ?? j.error ?? '已退出', res.ok ? 'ok' : 'err');
      await load();
    } catch { toast('请求失败', 'err'); }
  };
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
  // Runnable but not signed in — read from the row's own DETAIL line rather than a second fetch, so the
  // button and the sentence beside it cannot disagree about the state. Keyed on the id because this is the
  // only resource that HAS a login: everything else is a file that either exists or does not.
  //
  // NOT gated on `installed`, and that was a real bug for one commit: `installed` means OUR provisioned
  // copy is present, so on a machine where the household's own claude is on PATH it reads false while the
  // CLI is perfectly usable. Gating on it hid the button from exactly the households the button exists for
  // — someone using their own CLI, signed out. The server's detail line already distinguishes "未安装或无法
  // 运行" from "已安装,但尚未登录" for both cases, so that sentence is the authority.
  const needsLogin = (r: ResourceStatus) =>
    r.id === 'claude' && !!r.detail && r.detail.includes('尚未登录');

  const login = async () => {
    try {
      const res = await fetch('/api/manage/resources/claude/login', { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      // A refusal here is INFORMATIVE, not a failure: reaching the console from another device means the
      // login window would open somewhere the household cannot see, and the server says so.
      toast(j.note ?? j.error ?? (res.ok ? '已打开登录窗口' : '无法打开登录窗口'), res.ok ? 'ok' : 'err');
      await load();
    } catch { toast('请求失败', 'err'); }
  };

  const offered = items.filter((r) => !NOT_YET_REACHABLE.includes(r.id));
  const runtimes = offered.filter((r) => r.category !== 'model');
  const modelRows = offered.filter((r) => r.category === 'model');

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
            badges={r.installed && <PanelBadge kind="state">已安装</PanelBadge>}
            installed={r.installed}
            failed={r.state === 'error'}
            lines={
              <>
                <div className="res-need">{r.neededFor}</div>
                {/* The CLI's login state rides here — the difference between installed and usable.
                    Null is "not asked yet", not "not signed in": the server stopped blocking the whole
                    panel on a process spawn, so this says 检查中… and the effect above re-asks once. */}
                {r.id === 'claude' && !r.detail
                  ? <div className="res-need">检查中…</div>
                  : r.detail && <div className="res-need">{r.detail}</div>}
                {/* WHICH LOGIN the app uses. The CLI keeps credentials in a config directory, so without
                    this the app is signed in as whoever the household is signed in as in their own
                    terminal — fine when that is the same account, wrong when it is not. */}
                {r.id === 'claude' && session && (
                  <div className="res-session">
                    <Segmented
                      value={session.mode}
                      onSelect={(m) => setSession(m as 'machine' | 'app')}
                      options={[
                        { value: 'machine', label: '共用本机登录' },
                        { value: 'app', label: '应用自己的登录' },
                      ]}
                    />
                    <span className="res-need">
                      {session.mode === 'app'
                        ? '应用用自己的账号,和你终端里的登录互不影响。'
                        : '和你自己终端里的登录是同一个账号。'}
                    </span>
                  </div>
                )}
                {r.version && (
                  <div className="res-need">
                    当前版本 {r.version}
                    {hasUpdate(r) && <PanelBadge kind="state">可更新 → {r.available}</PanelBadge>}
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
              <div className="res-act-pair">
                {/* LOGIN, only for the CLI and only while it is installed-but-not-signed-in. It is the one
                    resource where "installed" is not "usable", and the instruction we used to give — run
                    `claude auth login` in a terminal — could not work for a copy WE installed: that
                    directory is never on PATH. The primary button is whichever action the row actually
                    needs, so an unsigned CLI leads with 登录 rather than with 重新下载. */}
                {needsLogin(r) && (
                  <PanelButton variant="primary" onClick={() => login()}>登录</PanelButton>
                )}
                {/* Sign out is offered ONLY for the app's own session. The machine's login is the
                    household's own terminal credential, and offering to end it from here is the same
                    overreach as a delete button aimed at a daemon we did not install. */}
                {r.id === 'claude' && session?.mode === 'app' && !needsLogin(r) && r.detail && (
                  <PanelButton onClick={() => logout()}>退出登录</PanelButton>
                )}
                <PanelButton
                  variant={r.installed && !hasUpdate(r) || needsLogin(r) ? 'default' : 'primary'}
                  onClick={() => provision(r.id)}>
                  {hasUpdate(r) ? '更新' : r.installed ? '重新下载' : '下载'}
                </PanelButton>
              </div>
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
          <PanelButton onClick={onRestart}>重启服务</PanelButton>
          <span className="set-saved">部分资源(如 Git)需重启后生效</span>
        </div>
      )}
    </div>
  );
}
