import { useEffect, useState } from 'react';
import { PanelButton, PanelBadge } from '@/ui/atoms';
import { ResourceRow, PullProgress, ModelPullField, type ModelPullState } from '@/ui/molecules';

/**
 * 本机模型 · Local models — the provisioning half of 资源 · Resources.
 *
 * Models live here rather than in 记忆检索 because a model is a file with a size, a capability and a
 * delete button; it carries no opinion about recall. The chat/embedding split is Ollama's, enforced
 * upstream — not a product rule we chose and could relax. So downloading one is the same act as
 * downloading chromium or git, and it belongs on the same panel as the runtime that hosts it: that
 * split was visible to the household, who installed Ollama here and its models two panels away.
 *
 * What stays in 记忆检索 is the only part that IS a recall decision — which model each layer uses.
 */

const mb = (n: number) =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)} GB` : `${Math.round(n / 1_000_000)} MB`;

interface Measured { top1: number; top3: number; queries: number; msPerQuery: number }

interface InstalledModel {
  id: string; name: string; runtime: string; sizeBytes: number;
  // Ollama's own answer, and NULL on a daemon too old to report the field. Tested for the WORD rather
  // than for its absence: a guess printed as a fact is worse than a blank.
  capabilities: string[] | null;
  // Which layer is holding it, when one is — the reason its delete button is a label instead.
  inUse: string | null;
  measured: Measured | null;
}

interface OfferedModel {
  id: string; name: string; runtime: string; capability: string;
  approxBytes: number; dimensions: number | null;
  note: string; vintage: string | null; measured: Measured | null;
}

// A download's shape belongs to the molecule that renders it (PullProgress) — imported as
// ModelPullState rather than redeclared here, so the two cannot drift.

interface Inventory {
  runtime: {
    id: string; baseUrl: string; installed: boolean; serving: boolean;
    version: string | null; executable: string | null; gpuLikely: boolean; problem: string | null;
  };
  models: InstalledModel[];
  offers: OfferedModel[];
  recommendation: { id: string; reason: string; caution: string | null };
  measuredOn: string;
  pulls: ModelPullState[];
}

const LAYER_NAMES: Record<string, string> = { judge: '判断', semantic: '语义' };

/** The built-in model as the resource list knows it — passed down rather than fetched, so 资源 and this
 *  section cannot disagree about whether it is installed. */
export interface BuiltInModelRow {
  id: string; name: string; neededFor: string; approxBytes: number;
  installed: boolean; state: string; percent: number; message: string | null;
}

export function LocalModelsPanel(
  { toast, builtIn, provision }:
  {
    toast: (t: string, k?: 'ok' | 'err') => void;
    // 内置 arrives from the resource list because it IS a provisioned resource — but it is a MODEL, and
    // this is where models live. Leaving it up there made 资源 list models in two places, which is the
    // exact split this whole section exists to end, and made this section's own lead text false: it says
    // both recall layers take their models from here, and one of them could not.
    builtIn: BuiltInModelRow[];
    provision: (id: string) => void;
  },
) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = async (refresh = false) => {
    try { setInv(await (await fetch(`/api/manage/models${refresh ? '?refresh=true' : ''}`)).json()); }
    catch { /* keep last */ }
  };
  useEffect(() => { load(true); }, []);

  // Poll ONLY while a download is running. Gate on a DERIVED boolean — keying the effect on `inv` would
  // tear down and recreate the interval on every tick.
  const downloading = inv?.pulls.some((p) => p.running) ?? false;
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => { load(false); }, 1500);
    return () => clearInterval(t);
  }, [downloading]);

  const post = async (path: string, body?: unknown, label = '') => {
    setBusy(label || path);
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { toast(j.note ?? '已完成'); await load(true); return j; }
      toast(j.error ?? '操作失败', 'err');
      return null;
    } catch { toast('请求失败', 'err'); return null; } finally { setBusy(null); }
  };

  if (!inv) return null;
  const rt = inv.runtime;
  // A row's own download, matched on the id the row SENT rather than on Ollama's normalised name: a pull
  // of `bge-m3` comes back as `bge-m3:latest`, and a row keyed on the normalised name never finds itself.
  const pullOf = (id: string) => inv.pulls.find((p) => p.model === id) ?? null;
  const totalBytes = inv.models.reduce((n, m) => n + m.sizeBytes, 0);

  return (
    <div className="res-models">
      <div className="mng-title">本机模型 · Local models</div>
      <div className="set-lead">
        「记忆检索」的两层都从这里取模型。这里只负责下载与删除;哪一层用哪个,在
        「校准 · Cortex → 记忆检索」里选。
      </div>

      {/* 内置 FIRST, because it is the one that needs nothing else installed — and because a household
          reading top-to-bottom should meet the no-setup option before the one with a daemon. It is a
          resource row (the provisioner owns it), rendered HERE rather than in the list above: it is a
          model, and this is where models live. */}
      {builtIn.length > 0 && (
        <div className="res-group">
          <div className="res-group-h">内置 —— 不需要另外安装任何东西</div>
          {builtIn.map((r) => (
            <ResourceRow
              key={r.id}
              name={r.name}
              badges={r.installed && (
                <>
                  <PanelBadge kind="state">已安装</PanelBadge>
                  {/* What it can DO, the same word the Ollama disk list uses — so one glance down the
                      section tells you which layer each model can serve, whoever provides it. */}
                  <PanelBadge kind="state">嵌入</PanelBadge>
                </>
              )}
              installed={r.installed}
              failed={r.state === 'error'}
              lines={<div className="res-need">{r.neededFor}</div>}
              progress={r.state === 'running' ? { percent: r.percent, message: r.message } : null}
              problem={r.state === 'error' ? `下载失败:${r.message}` : null}
              approxBytes={r.approxBytes}
              action={r.state === 'running' ? (
                <span className="res-running">下载中…</span>
              ) : (
                <PanelButton variant={r.installed ? 'default' : 'primary'} onClick={() => provision(r.id)}>
                  {r.installed ? '重新下载' : '下载'}
                </PanelButton>
              )}
            />
          ))}
        </div>
      )}

      {/* EVERYTHING below belongs to Ollama — the runtime, what is on its disk, the comparison of what it
          could pull, and the free-form pull field. Contained rather than merely labelled: a heading with
          no boundary left the comparison table floating, where it read as applying to the whole section
          including 内置 (which offers exactly one curated model and pulls nothing). */}
      <div className="res-group">
        <div className="res-group-h">Ollama —— 需要一个常驻服务,但模型可以随便换</div>

        {/* The runtime line. It carries its own problem sentence because "no models" and "no daemon" have
            completely different fixes, and a list that is simply empty says neither. No size: there is
            nothing to download here — the runtime itself is a row in the list above. */}
        <ResourceRow
          name="Ollama 运行时"
          badges={
            <>
              {rt.installed && <PanelBadge kind="state">已安装</PanelBadge>}
              {rt.serving && <PanelBadge kind="state">运行中</PanelBadge>}
              {rt.gpuLikely && <PanelBadge kind="state">GPU 可用</PanelBadge>}
            </>
          }
          installed={rt.installed}
          failed={!!rt.problem}
          lines={
            <div className="res-need">
              {rt.installed
                ? `${rt.serving ? `运行中 ${rt.version ?? ''}` : '已安装,未运行'} · ${rt.baseUrl}`
                : '未安装 —— 在上面的资源列表里下载,或自行安装后重启应用。'}
            </div>
          }
          problem={rt.problem}
          action={rt.installed && !rt.serving && (
            <PanelButton variant="primary" disabled={busy === 'start'}
              onClick={() => post('/api/manage/models/start', undefined, 'start')}>启动</PanelButton>
          )}
        />

      {/* ON DISK — what it costs, what it can do, and what is holding it. Without this, "free up space"
          means leaving the app for a terminal, and a household that tried several models has no way to
          see what the trying cost them. */}
      {inv.models.length > 0 && (
        <div className="mem-disk">
          <PanelButton onClick={() => setOpen(!open)}>
            {open ? '收起' : '已下载的模型'} · {inv.models.length} 个 · {mb(totalBytes)}
          </PanelButton>
          {open && (
            <div className="mem-disk-list">
              {inv.models.map((m) => (
                <div className="mem-disk-row" key={m.id}>
                  {/* Name and badges share ONE grid cell: the badges are conditional, and letting them be
                      their own columns would reflow the list depending on which models are installed. */}
                  <span className="mem-disk-id">
                    <span className="mem-disk-name">{m.name}</span>
                    {m.capabilities?.includes('embedding') && <PanelBadge kind="state">嵌入</PanelBadge>}
                    {m.capabilities?.includes('completion') && <PanelBadge kind="state">对话</PanelBadge>}
                  </span>
                  <span className="mem-disk-size">{mb(m.sizeBytes)}</span>
                  {m.inUse
                    ? <span className="res-running">{LAYER_NAMES[m.inUse] ?? m.inUse}使用中</span>
                    : (
                      <PanelButton disabled={busy === `rm:${m.id}`}
                        onClick={() => post('/api/manage/models/remove', { model: m.id }, `rm:${m.id}`)}>
                        删除
                      </PanelButton>
                    )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* MODEL CHOICE AS A COMPARISON, NOT A READING TASK. Everything that decides the choice is a
          column, and the recommendation names its evidence instead of asserting itself. */}
      {inv.offers.length > 0 && (
        <>
          <div className="mem-rec">
            <b>推荐 {inv.recommendation.id}</b> —— {inv.recommendation.reason}
            {inv.recommendation.caution && <div className="mem-fine">注意:{inv.recommendation.caution}</div>}
          </div>
          <div className="mem-tbl-wrap">
            <table className="mem-tbl">
              <thead>
                <tr>
                  <th>可下载的模型</th><th>用途</th><th>检索质量</th><th>每次查询</th>
                  <th>体积</th><th>维度</th><th>发布</th><th></th>
                </tr>
              </thead>
              <tbody>
                {inv.offers.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="mem-m-name"><b>{m.name}</b>
                        {m.id === inv.recommendation.id && <PanelBadge kind="state">推荐</PanelBadge>}
                      </div>
                      <div className="mem-m-note">{m.note}</div>
                      {/* Progress goes in the NAME cell, where there is room for a bar and a status
                          line — the action cell is a narrow, right-aligned, nowrap column. */}
                      <PullProgress pull={pullOf(m.id)} />
                    </td>
                    <td className="num">{m.capability === 'embedding' ? '嵌入 · 语义' : '对话 · 判断'}</td>
                    {/* The measurement, as a number with its denominator. "9/10" invites the right
                        question (out of how many? — the footnote answers) where "很好" does not. */}
                    <td className={`num${m.measured && m.measured.top3 * 2 <= m.measured.queries ? ' bad' : ''}`}>
                      {m.measured
                        ? <><b>{m.measured.top3}/{m.measured.queries}</b><div className="mem-m-sub">首位 {m.measured.top1}</div></>
                        : <span className="mem-m-sub">未实测</span>}
                    </td>
                    <td className="num">{m.measured ? `${m.measured.msPerQuery} ms` : <span className="mem-m-sub">—</span>}</td>
                    <td className="num">{mb(m.approxBytes)}</td>
                    <td className="num">{m.dimensions || <span className="mem-m-sub">—</span>}</td>
                    <td className={`num${m.vintage && m.vintage < '2025' ? ' mem-old' : ''}`}>
                      {m.vintage ?? <span className="mem-m-sub">—</span>}
                    </td>
                    <td className="mem-act">
                      {pullOf(m.id)?.running ? (
                        <span className="res-running">下载中…</span>
                      ) : (
                        // Primary on the RECOMMENDED row only. Every row carrying a filled amber button
                        // made equal shouts out of a table whose whole job is helping you pick one.
                        <PanelButton variant={m.id === inv.recommendation.id ? 'primary' : 'default'}
                          disabled={busy === `pull:${m.id}`}
                          onClick={() => post('/api/manage/models/pull', { model: m.id }, `pull:${m.id}`)}>
                          下载
                        </PanelButton>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mem-fine">
            质量为实测:{inv.measuredOn}。样本不大 —— 它足以分辨「能用」与「不能用」,不足以在前几名之间排座次;
            速度与体积则按你自己的机器换算。发布时间取自 Ollama 官方页面:表里所有表现差的都是两年前的模型,
            但 BGE-M3 同样是两年前的却仍并列最好 —— 所以「越新越好」用来决定值不值得一试,真正拍板的还是实测。
          </div>
        </>
      )}

        {/* THE LIST IS NOT THE LIMIT. A catalog baked into a release cannot contain a model published after
            it — which is exactly how this panel shipped without the two best models available at the time.
            Anything Ollama can pull is usable the day it exists — which is the one thing 内置 cannot offer,
            and the reason these two are separate groups rather than one list. */}
        <ModelPullField
          busy={busy}
          pullOf={pullOf}
          onPull={(id) => post('/api/manage/models/pull', { model: id }, 'pull:other')}
          label="其他模型 · 直接填写 Ollama 模型名"
          placeholder="例如 nomic-embed-text-v2-moe 或 qwen3:4b"
          hint="下载后回到「校准 · Cortex → 记忆检索」,在对应的一层里选它 —— 嵌入模型给「语义」,对话模型给「判断」。"
        />
      </div>
    </div>
  );
}

