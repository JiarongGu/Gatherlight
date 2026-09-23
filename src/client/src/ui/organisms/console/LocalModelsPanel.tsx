import { useEffect, useState } from 'react';
import { PanelButton, PanelBadge } from '@/ui/atoms';
import { ResourceRow } from '@/ui/molecules';

/**
 * 本机模型 · Local models — the provisioning half of 资源 · Resources.
 *
 * Models live here rather than in 记忆检索 because a model is a file with a size, a capability and a
 * delete button; it carries no opinion about recall. What stays in 记忆检索 is the only part that IS a
 * recall decision — which model each layer uses.
 *
 * <b>ONE ROW SHAPE, whatever state a model is in.</b> This section used to render a model three different
 * ways: a bordered `ResourceRow` card for the built-in one, a grid row inside a 已下载的模型 disclosure
 * for a downloaded GGUF, and a table row for an undownloaded one. Three components, three left edges
 * (measured: 395 · 410 · 423) and two different verbs in the action column — for one kind of object
 * differing only by a boolean. Downloaded is a STATE of a model, not a separate species, so there is one
 * table, `installed` is a field, and the sort puts what you have above what you could get.
 *
 * <b>This section shows only what Gatherlight provisions</b> — the models of the 本机模型 group in 记忆检索:
 * the sha256-pinned GGUFs our own llama.cpp runtime serves (embedders for 语义; chat models and rerankers for
 * 判断) and the built-in ONNX embedder, which runs in this process. A GGUF the household dropped into the
 * folder themselves also gets a row, with no note and no measurement, because it is on their disk and they
 * may want the space back.
 *
 * It once listed the household's Ollama models too, with pull and delete buttons aimed at a program the app
 * did not install. Ollama stopped being a backend on 2026-08-22 (and the address-typed OpenAI-compatible
 * backend with it), so there is no model managed elsewhere left to point at: every model a layer can use is
 * a row here.
 */

/** What each GGUF kind is FOR. A reranker judges too, but only by scoring — it never writes a tag. */
const CAPABILITY_LABEL: Record<string, string> = {
  embedding: '嵌入 · 语义',
  completion: '对话 · 判断',
  reranking: '重排 · 判断',
};

const mb = (n: number) =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)} GB` : `${Math.round(n / 1_000_000)} MB`;

interface Measured { top1: number; top3: number; queries: number; msPerQuery: number }

/** One model the app manages. `installed` is the only thing that differs between a row you can delete
 *  and a row you can download — which is why there is one type here and not two. */
interface Model {
  id: string; name: string; runtime: string; capability: string;
  sizeBytes: number; installed: boolean;
  /** Which layer is holding it, when one is — the reason its delete button is a label instead. */
  inUse: string | null;
  note: string; measured: Measured | null;
  /** The resource to provision. Sent by the server rather than built from the id here — deriving it
   *  client-side is what put models in the runtimes column twice already. */
  resourceId: string;
}

interface Inventory {
  /** OUR runtime — llama.cpp, which hosts the GGUF rows. Not Ollama; see the note at the top. */
  runtime: {
    id: string; baseUrl: string; installed: boolean; serving: boolean;
    version: string | null; executable: string | null;
    gpuLikely: boolean; devices: string[]; problem: string | null;
  };
  models: Model[];
  /** Null once every model has been installed — there is then nothing to advise. */
  recommendation: { id: string; reason: string; caution: string | null } | null;
  measuredOn: string;
}

const LAYER_NAMES: Record<string, string> = { judge: '判断', semantic: '语义' };
const RUNTIME_NAMES: Record<string, string> = { 'llama-cpp': 'llama.cpp', builtin: '内置' };

/** A model resource as the resource list knows it — passed down rather than fetched, so 资源 and this
 *  section cannot disagree about how far a download has got. */
export interface BuiltInModelRow {
  id: string; name: string; neededFor: string; approxBytes: number;
  installed: boolean; state: string; percent: number; message: string | null;
  modelId?: string | null;
}

export function LocalModelsPanel(
  { toast, builtIn, provision }:
  {
    toast: (t: string, k?: 'ok' | 'err') => void;
    /** Every model-category resource, read ONLY for live download progress: the table below is the list,
     *  and a second list of the same models is the split this section exists to end. */
    builtIn: BuiltInModelRow[];
    provision: (id: string) => void;
  },
) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async (refresh = false) => {
    try { setInv(await (await fetch(`/api/manage/models${refresh ? '?refresh=true' : ''}`)).json()); }
    catch { /* keep last */ }
  };
  useEffect(() => { load(true); }, []);

  // Poll ONLY while a model is downloading. Gate on a DERIVED boolean — keying the effect on the array
  // itself would tear down and recreate the interval on every tick.
  const downloading = builtIn.some((r) => r.state === 'running');
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(() => { load(false); }, 1500);
    return () => clearInterval(t);
  }, [downloading]);

  // The runtime's BUILD TAG and DEVICE LIST cost two process starts, so the server no longer waits for them
  // — it sends null and probes in the background. This panel loads once and otherwise only polls while
  // downloading, so without a re-ask those fields stayed blank until the household navigated away and back:
  // an installed runtime showing no version and no GPU badge, permanently, on the first open after every
  // restart. One retry, not a poll — the answer is cached server-side once it lands.
  //
  // A FEW attempts, not one. The first version asked again after a fixed 900 ms, which RACES the thing it
  // is waiting for: on a cold process the background probe shells out to `--version` and `--list-devices`
  // and takes ~1.9 s, so the single retry landed early, found the same null, and — because the gate boolean
  // had not changed — never fired again. The row then stayed blank for ever, which is the exact bug this
  // retry exists to prevent, reintroduced by the retry. Caught by desktop-e2e, which is the only thing that
  // renders the row.
  //
  // Keying the effect on the ATTEMPT COUNT is what makes it re-run; the cap is what stops it becoming the
  // poll this deliberately is not.
  const [probeTries, setProbeTries] = useState(0);
  const runtimeUnknown = !!inv && inv.runtime.installed && inv.runtime.version === null;
  useEffect(() => {
    if (!runtimeUnknown || probeTries >= 5) return;
    const t = setTimeout(() => { setProbeTries((n) => n + 1); load(false); }, 800);
    return () => clearTimeout(t);
  }, [runtimeUnknown, probeTries]);

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
  const held = inv.models.filter((m) => m.installed);
  const onDisk = held.reduce((n, m) => n + m.sizeBytes, 0);
  // A row's live download state, by resource id.
  const resOf = (resourceId: string) => builtIn.find((r) => r.id === resourceId) ?? null;
  // A column that reads "—" in EVERY row is noise: with only chat models left to fetch, 每次查询 and 实测
  // were dashes across ~140px of a table whose whole job is helping you compare. Dropped when nothing
  // fills them and back the moment something does. 检索质量 always stays and says 未实测, which is a
  // statement about what nobody has measured rather than a missing value.
  const anyMeasured = inv.models.some((m) => !!m.measured);

  return (
    <div className="res-models">
      <div className="mng-title">本机模型 · Local models</div>
      <div className="set-lead">
        {/* The group is 本机模型: this said 内置 from when that word named the group, and 内置 now names
            one member of it (the ONNX embedder). The fine print below it offered Ollama and a self-run
            service as 记忆检索 options — both retired on 2026-08-22 — so it pointed at choices that no longer
            exist; what it says now is the true boundary of this list. */}
        应用自己下载和管理的模型 —— 对应「记忆检索」里的<b>本机模型</b>那一组。哪一层用哪个,在
        「校准 · Cortex → 记忆检索」里选。
        <div className="mem-fine">
          「记忆检索」能用的本机模型都列在这里,它不连接你自己另外运行的模型服务。
          自己放进模型文件夹的 GGUF 文件也会列出,但没有说明和实测数据。
        </div>
      </div>

      {/* The runtime, as a runtime — the same card the list above uses for git, node and the CLI, because
          that is what it is. Only the llama.cpp rows below need it; the 内置 row runs in this process.

          When it is NOT installed its own problem sentence points at the 资源 list, which is this very
          panel, so that sentence is suppressed and replaced by one pointing UP at the row that installs
          it. A message telling you to go where you already are is the self-referential dead end the git
          provisioning step had to fix. */}
      <ResourceRow
        name="llama.cpp 运行时"
        badges={
          <>
            {rt.installed && <PanelBadge kind="state">已安装</PanelBadge>}
            {rt.serving && <PanelBadge kind="state">运行中</PanelBadge>}
            {rt.gpuLikely && <PanelBadge kind="state">GPU 可用</PanelBadge>}
          </>
        }
        installed={rt.installed}
        failed={rt.installed && !!rt.problem}
        lines={
          <div className="res-need">
            {/* The BUILD TAG shows whichever state it is in. It used to appear only while serving, so a
                household who had downloaded the runtime could not see which build they had until they
                started it — and 资源's job is telling you what you have. It is also the field that arrives
                LATE (two process starts), so this is where the background probe becomes visible. */}
            {rt.installed
              ? `${rt.serving ? '运行中' : '已安装,未运行'}${rt.version ? ` ${rt.version}` : ''}`
                + ` · ${rt.baseUrl} · 下面标着 llama.cpp 的模型跑在它上面`
              : '未安装 —— 在上面的资源列表里下载「本机模型运行时 · llama.cpp」(约 35 MB)。标着 内置 的模型不需要它。'}
          </div>
        }
        problem={rt.installed ? rt.problem : null}
        action={rt.installed && !rt.serving && (
          <PanelButton variant="primary" disabled={busy === 'start'}
            onClick={() => post('/api/manage/models/llama/start', undefined, 'start')}>启动</PanelButton>
        )}
      />

      {inv.recommendation && (
        <div className="mem-rec">
          <b>推荐 {inv.recommendation.id}</b> —— {inv.recommendation.reason}
          {inv.recommendation.caution && <div className="mem-fine">注意:{inv.recommendation.caution}</div>}
        </div>
      )}

      {/* ONE TABLE. Everything that decides the choice is a column, the recommendation names its evidence
          instead of asserting itself, and what you already have sorts above what you could get — with the
          same row, the same left edge and the same action column for both. */}
      <div className="mem-tbl-wrap">
        <table className="mem-tbl">
          <thead>
            <tr>
              <th>模型</th><th>运行</th><th>用途</th><th>检索质量</th>
              {anyMeasured && <th>每次查询</th>}
              <th>体积</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {inv.models.map((m) => {
              const res = resOf(m.resourceId);
              const running = res?.state === 'running';
              return (
                <tr key={`${m.runtime}:${m.id}`} className={m.inUse ? 'on' : undefined}>
                  <td>
                    <div className="mem-m-name">
                      <b>{m.name}</b>
                      {m.installed && <PanelBadge kind="state">已安装</PanelBadge>}
                      {m.id === inv.recommendation?.id && <PanelBadge kind="state">推荐</PanelBadge>}
                    </div>
                    {/* The id, because it is what 记忆检索 shows and what you would match against. */}
                    <div className="mem-m-sub">{m.id}</div>
                    {m.note && <div className="mem-m-note">{m.note}</div>}
                    {/* Progress goes in the NAME cell, where there is room for a bar and a status line —
                        the action cell is a narrow, right-aligned, nowrap column. */}
                    {running && (
                      <div className="mem-prog">
                        <div className="res-prog"><span style={{ width: `${res!.percent}%` }} /></div>
                        <div className="mem-m-sub">{res!.message ?? '下载中…'}</div>
                      </div>
                    )}
                    {res?.state === 'error' && <div className="mem-m-sub warn">下载失败:{res.message}</div>}
                  </td>
                  {/* WHICH of the two 内置 arms. Two runtimes can hold the same weights under different
                      names (embeddinggemma-300m-onnx in-process, embeddinggemma-300M-Q8_0 as a GGUF), so a
                      row that does not say leaves you unable to tell what you are deleting. */}
                  <td className="num">{RUNTIME_NAMES[m.runtime] ?? m.runtime}</td>
                  <td className="num">{CAPABILITY_LABEL[m.capability] ?? m.capability}</td>
                  {/* The measurement, as a number with its denominator. "9/10" invites the right question
                      (out of how many? — the footnote answers) where "很好" does not. */}
                  <td className={`num${m.measured && m.measured.top3 * 2 <= m.measured.queries ? ' bad' : ''}`}>
                    {m.measured
                      ? <><b>{m.measured.top3}/{m.measured.queries}</b><div className="mem-m-sub">首位 {m.measured.top1}</div></>
                      : <span className="mem-m-sub">未实测</span>}
                  </td>
                  {anyMeasured && (
                    <td className="num">
                      {m.measured ? `${m.measured.msPerQuery} ms` : <span className="mem-m-sub">—</span>}
                    </td>
                  )}
                  <td className="num">{mb(m.sizeBytes)}</td>
                  <td className="mem-act">
                    {running ? <span className="res-running">下载中…</span>
                      : m.inUse ? <span className="res-running">{LAYER_NAMES[m.inUse] ?? m.inUse}使用中</span>
                      : m.installed ? (
                        <PanelButton disabled={busy === `rm:${m.id}`}
                          onClick={() => post('/api/manage/models/remove',
                            { model: m.id, runtime: m.runtime }, `rm:${m.id}`)}>
                          删除
                        </PanelButton>
                      ) : (
                        // Primary on the RECOMMENDED row only. Every row carrying a filled amber button
                        // made equal shouts out of a table whose whole job is helping you pick one.
                        <PanelButton variant={m.id === inv.recommendation?.id ? 'primary' : 'default'}
                          onClick={() => provision(m.resourceId)}>
                          下载
                        </PanelButton>
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mem-fine">
        已装 {held.length} 个 · 占用 {mb(onDisk)}。检索质量为实测:{inv.measuredOn}。样本不大 —— 它足以分辨
        「能用」与「不能用」,不足以在前几名之间排座次;速度与体积则按你自己的机器换算。「判断」那一层的质量还没有
        按模型实测过,所以对话模型只列延迟与体积,不给质量分 —— 没量过就说没量过。
      </div>
      <div className="mem-fine">
        这是一份<b>固定</b>的清单:这些模型由应用按仓库、提交和 sha256 下载,所以只能是我们钉过的那几个。
        想用别的?自己跑起来,然后在「记忆检索」里用<b>本机</b>填地址连上去 —— 那正是它的用途。
      </div>
    </div>
  );
}
