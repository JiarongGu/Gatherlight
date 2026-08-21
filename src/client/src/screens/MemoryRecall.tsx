import { useEffect, useState } from 'react';

/**
 * 记忆检索 · Memory recall — the setup surface for how the assistant searches what it knows.
 *
 * Lives in its own file because it reached 440 lines inside Manage.tsx (18% of it) as five
 * components with one subject between them, which is the client-side shape of the rule this
 * codebase already applies to growing C# classes: split into units with a boundary, not into
 * partials that keep absorbing.
 *
 * It renders INSIDE 校准 · Cortex, so it follows Cortex's vocabulary rather than inventing one —
 * the amber left edge for active, display serif names, mono for anything you compare. See the
 * 记忆检索 block in styles.css for why that mattered.
 */

const memBytes = (n: number) =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)} GB` : `${Math.round(n / 1_000_000)} MB`;

interface MemoryOption {
  id: string; name: string; approxBytes: number; dimensions: number;
  multilingual: boolean; note: string; present: boolean;
  // Approximate release, from ollama.com's own "updated N ago". A column because age turned out to be a
  // strong NEGATIVE filter here: every model that scores badly is two years old.
  vintage: string | null;
  // Null on a model nobody measured — rendered as "未实测" rather than left blank, because an empty cell
  // in a comparison table reads as a zero.
  measured: { top1: number; top3: number; queries: number; msPerQuery: number } | null;
}
/** A model download in flight, or one that finished in the last few minutes. */
interface ModelPull {
  model: string; running: boolean;
  // Null while Ollama is resolving manifests and has no total to divide by — rendered as indeterminate,
  // because a bar pinned at 0% reads as stuck.
  percent: number | null;
  status: string | null; error: string | null;
}

interface MemoryState {
  formula: { alwaysOn: boolean; what: string };
  // `live` = takes effect immediately (an app_config value read per call). The local model below is a
  // startup registration instead, which is why only IT reports enabled-vs-active.
  llmEnrichment: {
    enabled: boolean; live: boolean; what: string; cost: string; model: string;
    // WHERE it runs, as opposed to WHETHER. Unlike `enabled` this is a startup registration, so the two
    // are shown as different kinds of change rather than two switches that look alike.
    transport: 'cli' | 'local'; localModel: string | null; localNote: string;
    // What is RUNNING, as opposed to what is saved. The header names its backend, so it has to name the
    // one doing the work — between saving and restarting those are different answers.
    transportActive: 'cli' | 'local'; activeModel: string | null;
    localCandidates: { name: string; sizeBytes: number }[];
    // Why there are no candidates, when there are none. The server names WHICH of the three causes it is
    // (no Ollama · not running · only embedders) because they have three different fixes.
    localBlocked: string | null;
    // A chat model the panel can pull, when that IS the fix. Same Ollama and same endpoint the embedding
    // table downloads through — the judge and the embedder are one provider with two models on it.
    localSuggest: string | null;
  };
  localModel: {
    enabled: boolean; active: boolean; model: string | null; what: string; cost: string;
    // Why this layer has no backend picker while 判断 has one.
    backend: string;
    note: string | null;
    ollama: {
      baseUrl: string; installed: boolean; serving: boolean; version: string | null;
      executable: string | null; gpuLikely: boolean; problem: string | null;
      // `capabilities` is Ollama's own answer and is null on a daemon too old to report it — which is why
      // the disk list below tests for the word rather than for "not completion".
      models: { name: string; sizeBytes: number; capabilities: string[] | null }[];
    };
    options: MemoryOption[];
    recommendation: { id: string; reason: string; caution: string | null };
    current: string | null;
    currentCatalogued: boolean;
    measuredOn: string;
    // `percent` is null until the run has counted its facts: a bar pinned at 0% reads as stuck, which is
    // the impression this whole thing exists to remove.
    reindex: {
      running: boolean; done: number; total: number;
      embedded: number | null; error: string | null; percent: number | null;
    };
    // STATE, not history: how much of what the household knows is actually searchable.
    coverage: { indexed: number; total: number };
    // Downloads the server has in flight. Keyed by the id the row asked for, so a row can find its own.
    pulls: ModelPull[];
  };
}

// Lives INSIDE Cortex rather than in a tab of its own: cortex is 校准 — where you tune how the brain
// works — and this is exactly that. The enrichment's model routing is already a row in the table below
// it, so a separate tab put one feature's controls in two places. Only the Ollama runtime DOWNLOAD stays
// in 资源, which is the panel for large files fetched into the data folder.
export function MemoryRecallSection({ toast, onRestart, inHost }: { toast: (t: string, k?: 'ok' | 'err') => void; onRestart: () => void; inHost: boolean }) {
  const [s, setS] = useState<MemoryState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async (refresh = false) => {
    try { setS(await (await fetch(`/api/manage/memory${refresh ? '?refresh=true' : ''}`)).json()); }
    catch { /* keep last */ }
  };
  useEffect(() => { load(true); }, []);

  // Poll ONLY while long work is running — a rebuild or a model download. Both outlive the request that
  // started them, so the panel has to go and look; polling all the time would spend a probe of Ollama every
  // two seconds for a screen that is usually idle.
  // `load(false)` on purpose: the probe's own 20s cache keeps these ticks cheap, and the two things that
  // must stay live (reindex + pulls) are read from memory, not from the probe. A finished pull invalidates
  // the cache itself, so the model list still refreshes promptly when one lands.
  // Gate on a DERIVED boolean — keying the effect on `s` would tear down and recreate the interval on
  // every tick.
  const working = (s?.localModel.reindex.running ?? false)
    || (s?.localModel.pulls.some((p) => p.running) ?? false);
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => { load(false); }, 1500);
    return () => clearInterval(t);
  }, [working]);

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

  const mb = (n: number) => (n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)} GB` : `${Math.round(n / 1_000_000)} MB`);
  if (!s) return <div className="eval-empty">加载中…</div>;
  const lm = s.localModel;
  const o = lm.ollama;
  // A row's own download. Matched on the id the row SENT rather than on Ollama's normalised name, because
  // a pull of `bge-m3` is reported by Ollama as `bge-m3:latest` and the row would never find itself.
  const pullOf = (id: string) => lm.pulls.find((p) => p.model === id) ?? null;
  // Saved but not running = a restart is owed. TWO things can be in that state, and for the same reason:
  // both are startup registrations. The judge's on/off switch is not one of them — it is live — so the
  // restart is offered for the transport and the semantic layer only, never for the switch.
  const en = s.llmEnrichment;
  const judgePending = en.transport !== en.transportActive
    || (en.transport === 'local' && en.localModel !== en.activeModel);
  const pending = lm.enabled !== lm.active || judgePending;
  // The backend RUNNING the judge, named. `本机` rather than `本地`: 本地 belongs to the semantic layer's
  // own vocabulary, and the two used to sit one card apart meaning different things.
  const judgeBackend = en.transportActive === 'local' ? `本机 ${en.activeModel}` : 'Claude CLI';

  return (
    <>
      <div className="mng-title">记忆检索 · Memory recall</div>

      {/* WHAT IS ON, in one line, before any of the controls. The previous layout opened with three
          equal-weight prose blocks, so answering "what is running right now" meant reading all of them. */}
      {/* Each layer is named for WHAT IT DOES, and carries the backend running it. The middle one used to
          be called Claude CLI 增强 — a name that asserted a backend it may not be using, since the very
          control inside it moves the work to a model on this machine. Worse, its 本机模型 option sat one
          card above a layer called 本地模型 · Local model: two near-synonyms, different meanings, adjacent.
          Naming by function makes the backend a property rather than the title. */}
      <div className="mem-sum">
        <span className={`mem-pill on`}>公式</span>
        <span className={`mem-pill${en.enabled ? ' on' : ''}`}>
          判断{en.enabled ? `(${judgeBackend})` : '(关)'}
        </span>
        <span className={`mem-pill${lm.active ? ' on' : ''}`}>
          语义{lm.active ? `(${lm.model})` : lm.enabled ? '(待重启)' : '(关)'}
        </span>
      </div>
      <div className="set-lead">
        三项互补,不是三选一:<b>公式</b>永远在跑;<b>判断</b>只调整已检索结果的顺序;<b>语义</b>改变「能不能被检索到」。
      </div>
      {pending && (
        <div className="set-actions">
          {inHost && <button className="cx-btn primary" onClick={onRestart}>重启服务以生效</button>}
          <span className="set-saved">设置已保存,重启后生效</span>
        </div>
      )}

      <div className="mem-layers">
        {/* 1 — the floor */}
        <div className="mem-layer on">
          <div className="mem-layer-main">
            <div className="mem-layer-name">公式 · Formula<span className="res-badge">始终启用</span></div>
            <div className="mem-layer-desc">{s.formula.what}</div>
          </div>
        </div>

        {/* 2 — judgement: annotate on write, reorder on recall. Backend is a CHOICE, hence a badge. */}
        <div className={`mem-layer${en.enabled ? ' on' : ''}`}>
          <div className="mem-layer-main">
            <div className="mem-layer-name">
              判断 · Judgement
              {en.enabled && <span className="res-badge">运行中</span>}
              {/* The RUNNING backend, not the saved one. Shown only while the layer is on, because a
                  backend named for work that is not happening is the same false label as the old title. */}
              {en.enabled && <span className="res-badge">{judgeBackend}</span>}
              <span className="res-badge">即时生效</span>
            </div>
            <div className="mem-layer-desc">{en.what}</div>
            <div className="mem-layer-desc"><b>费用</b> {en.cost}</div>
            <div className="mem-layer-desc">{en.model}</div>
            {en.enabled && <JudgeTransportPicker en={en} busy={busy} post={post} pullOf={pullOf} />}
          </div>
          <div className="mem-layer-side">
            <button
              className={`cx-btn${en.enabled ? '' : ' primary'}`}
              disabled={busy === 'enrich'}
              onClick={() => post('/api/manage/memory/enrichment', { enabled: !en.enabled }, 'enrich')}
            >
              {en.enabled ? '关闭' : '启用'}
            </button>
          </div>
        </div>

        {/* 3 — semantic: real vectors, so a paraphrase finds the fact. Named for what it does; the local
            model is its backend, the same way the CLI is the judge's — not its title. */}
        <div className={`mem-layer${lm.active ? ' on' : ''}${o.problem && lm.enabled ? ' err' : ''}`}>
          <div className="mem-layer-main">
            <div className="mem-layer-name">
              语义 · Semantic
              {lm.active && <span className="res-badge">运行中</span>}
              {lm.active && lm.model && <span className="res-badge">本机 {lm.model}</span>}
              {o.gpuLikely && <span className="res-badge">GPU 可用</span>}
            </div>
            <div className="mem-layer-desc">{lm.what}</div>
            <div className="mem-layer-desc"><b>费用</b> {lm.cost}</div>
            <div className="mem-layer-desc">
              运行于 Ollama:{o.installed ? (o.serving ? `运行中 ${o.version ?? ''}` : '已安装,未运行') : '未安装'}
              {o.installed && ` · ${o.baseUrl}`}
            </div>
            {/* 判断 offers two backends and this one offers none — an asymmetry the by-function naming
                makes plain, so say why rather than leaving it to be read as an omission. */}
            <div className="mem-fine">{lm.backend}</div>
            {o.problem && <div className="res-msg danger">{o.problem}</div>}
            {!o.installed && (
              <div className="mem-fine warn">在「资源 · Resources」面板下载 Ollama 运行时,或自行安装后重启应用。</div>
            )}
            {lm.note && <div className="mem-fine">说明:{lm.note}</div>}
            {/* The rebuild, while it runs and after it ends. It used to be a greyed-out button and
                nothing else, for minutes — indistinguishable from a hang. */}
            {lm.reindex.running && (
              <div className="mem-reindex">
                <div className="res-prog">
                  <span className="res-bar" style={{ width: `${lm.reindex.percent ?? 8}%` }} />
                </div>
                <div className="mem-fine">
                  {lm.reindex.total > 0
                    ? `重建索引中:${lm.reindex.done}/${lm.reindex.total} 条事实`
                    : '重建索引中:正在统计事实…'}
                  {en.enabled && ' · 开启了判断,每条事实会多一次模型调用,请耐心等待'}
                </div>
              </div>
            )}
            {/* Coverage sits above the rebuild's own messages because it is the standing answer; the
                rebuild is an event that changes it. Shown only when it is NOT complete — "25/25" every
                day is noise, whereas a shortfall is the one thing worth acting on. */}
            {!lm.reindex.running && lm.coverage.total > 0 && lm.coverage.indexed < lm.coverage.total && (
              <div className="mem-fine warn">
                索引覆盖 {lm.coverage.indexed}/{lm.coverage.total} 条事实 —— 其余仍可用关键词找到,
                重启后会自动补齐,也可以现在「重建索引」。
              </div>
            )}
            {!lm.reindex.running && lm.reindex.error && (
              <div className="mem-fine danger">上次重建:{lm.reindex.error}</div>
            )}
            {!lm.reindex.running && lm.reindex.embedded ? (
              <div className="mem-fine">上次重建完成:{lm.reindex.embedded} 条事实已重新索引。</div>
            ) : null}
          </div>
          <div className="mem-layer-side">
            {o.installed && !o.serving && (
              <button className="cx-btn primary" disabled={busy === 'start'}
                onClick={() => post('/api/manage/memory/local/start', undefined, 'start')}>启动</button>
            )}
            {lm.enabled && (
              <>
                <button className="cx-btn" disabled={busy === 'reindex' || lm.reindex.running}
                  onClick={() => post('/api/manage/memory/local/reindex', undefined, 'reindex')}>
                  {lm.reindex.running ? '重建中…' : '重建索引'}
                </button>
                <button className="cx-btn" disabled={busy === 'off'}
                  onClick={() => post('/api/manage/memory/local/disable', undefined, 'off')}>停用</button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* MODEL CHOICE AS A COMPARISON, NOT A READING TASK. Five models across quality / size / speed is a
          table; the previous layout stacked them as prose blocks, so choosing meant reading five
          paragraphs and holding the numbers in your head. Everything that decides the choice is now a
          column, and the recommendation names its evidence instead of asserting itself. */}
      {/* PROGRESSIVE DISCLOSURE, not a sub-tab. The bulk of this section is a comparison table, and a
          comparison is a SETUP-TIME artifact: you read it once, choose, and never look at it again — yet
          it was rendering at full size even with 语义 switched off, which is what made the section feel
          oversized. A sub-tab would have treated the symptom and cost more: a second level of navigation
          on a rarely-visited screen, and — worse — it would put the 语义 switch and the table that
          satisfies it in different places, so turning the feature on would mean going somewhere else to
          finish. Collapsed, they stay one click apart.

          Open by default only when you are MID-SETUP (the feature is on but no model is chosen), because
          that is the one state where the table is the thing you came for. */}
      {o.serving && (
        <ModelManager defaultOpen={!lm.model} count={lm.options.length} current={lm.model}>
          <div className="mem-rec">
            <b>推荐 {lm.recommendation.id}</b> —— {lm.recommendation.reason}
            {lm.recommendation.caution && <div className="mem-fine">注意:{lm.recommendation.caution}</div>}
          </div>
          <div className="mem-tbl-wrap">
            <table className="mem-tbl">
              <thead>
                <tr>
                  <th>模型</th><th>检索质量</th><th>每次查询</th><th>体积</th><th>维度</th><th>发布</th><th></th>
                </tr>
              </thead>
              <tbody>
                {lm.options.map((m) => (
                  <tr key={m.id} className={lm.model === m.id ? 'on' : ''}>
                    <td>
                      <div className="mem-m-name">
                        <b>{m.name}</b>
                        {m.id === lm.recommendation.id && <span className="res-badge">推荐</span>}
                        {lm.model === m.id && <span className="res-badge">使用中</span>}
                      </div>
                      <div className="mem-m-note">{m.note}</div>
                      {/* Progress goes in the NAME cell, where there is room for a bar and a status line —
                          the action cell is a narrow, right-aligned, nowrap column. Same split the
                          Resources panel uses: bar in the main column, 下载中… in the side column. */}
                      <PullProgress pull={pullOf(m.id)} />
                      {busy === `use:${m.id}` && <EnablingNote />}
                    </td>
                    {/* The measurement, as a number with its denominator. "9/10" invites the right
                        question (out of how many? — the footnote answers) where "很好" does not. */}
                    <td className={`num${m.measured && m.measured.top3 * 2 <= m.measured.queries ? ' bad' : ''}`}>
                      {m.measured
                        ? <><b>{m.measured.top3}/{m.measured.queries}</b><div className="mem-m-sub">首位 {m.measured.top1}</div></>
                        : <span className="mem-m-sub">未实测</span>}
                    </td>
                    <td className="num">{m.measured ? `${m.measured.msPerQuery} ms` : <span className="mem-m-sub">—</span>}</td>
                    <td className="num">{mb(m.approxBytes)}</td>
                    <td className="num">{m.dimensions}</td>
                    <td className={`num${m.vintage && m.vintage < '2025' ? ' mem-old' : ''}`}>
                      {m.vintage ?? <span className="mem-m-sub">—</span>}
                    </td>
                    <td className="mem-act">
                      {pullOf(m.id)?.running ? (
                        <span className="res-running">下载中…</span>
                      ) : !m.present ? (
                        <button className="cx-btn" disabled={busy === `pull:${m.id}`}
                          onClick={() => post('/api/manage/memory/local/pull', { model: m.id }, `pull:${m.id}`)}>
                          下载
                        </button>
                      ) : lm.model === m.id && lm.enabled ? (
                        <span className="res-running">使用中</span>
                      ) : (
                        <div className="mem-act-pair">
                          {/* Primary on the RECOMMENDED row only. Every row carrying a filled amber
                              button made eight equal shouts out of a table whose whole job is to help
                              you pick one — emphasis that is everywhere is emphasis nowhere. */}
                          <button className={`cx-btn${m.id === lm.recommendation.id ? ' primary' : ''}`}
                            disabled={busy === `use:${m.id}`}
                            onClick={() => post('/api/manage/memory/local/enable', { model: m.id }, `use:${m.id}`)}>
                            {busy === `use:${m.id}` ? '启用中…' : '使用'}
                          </button>
                          {/* Downloaded but unused = disk doing nothing. The server refuses to delete one
                              that is configured, so this never has to guess. */}
                          <button className="cx-btn" disabled={busy === `rm:${m.id}`}
                            onClick={() => post('/api/manage/memory/local/remove', { model: m.id }, `rm:${m.id}`)}
                            title={`删除 ${m.id},释放 ${mb(m.approxBytes)}`}>删除</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mem-fine">
            质量为实测:{lm.measuredOn}。样本不大 —— 它足以分辨「能用」与「不能用」,不足以在前几名之间排座次;
            速度与体积则按你自己的机器换算。发布时间取自 Ollama 官方页面:表里所有表现差的都是两年前的模型
            (同一家的 nomic 新版 9/10、旧版 4/10),但 BGE-M3 同样是两年前的却仍并列最好 —— 所以「越新越好」
            用来决定值不值得一试,真正拍板的还是实测。
          </div>

          <LocalDisk models={o.models} inUse={[lm.model, en.localModel]} busy={busy} post={post} />

          {/* THE LIST IS NOT THE LIMIT. A catalog baked into a release cannot contain a model published
              after it — which is exactly how this panel shipped without the two best models available at
              the time. Anything Ollama can pull is usable here the day it exists. */}
          <OtherModelField busy={busy} post={post} installed={o.models.map((x) => x.name)} pullOf={pullOf} />
        </ModelManager>
      )}
    </>
  );
}

/** A download in flight, or the outcome of one that just finished. Reuses the Resources bar — the app has
 *  one progress idiom and this is it.
 *
 *  It exists because the pull used to be awaited INSIDE the POST: the button said 下载中… and nothing else
 *  changed for however long a gigabyte takes on the household's line, which is the same "greyed-out button,
 *  indistinguishable from a hang" the rebuild was fixed for. Renders nothing when there is no download, so
 *  every caller can mount it unconditionally. */
function PullProgress({ pull }: { pull: ModelPull | null }) {
  if (!pull) return null;
  if (!pull.running) {
    return pull.error
      ? <div className="mem-fine danger">下载失败:{pull.error}</div>
      : <div className="mem-fine">下载完成。</div>;
  }
  return (
    <div className="mem-prog">
      {/* The 6% floor is for the indeterminate case only: a bar with no width at all reads as a bar that
          has not started, which is exactly wrong while manifests are being fetched. */}
      <div className="res-prog"><span className="res-bar" style={{ width: `${pull.percent ?? 6}%` }} /></div>
      <div className="mem-fine">
        {pull.percent === null ? '正在准备…' : `${pull.percent}%`}
        {pull.status ? ` · ${pull.status}` : ''}
      </div>
    </div>
  );
}

/** What 「使用」 is doing while it sits there disabled. There is no progress to report — it is one embed
 *  call that blocks until the model is in memory — so the honest thing is to say WHAT is being waited on
 *  and that tens of seconds is normal, rather than leaving a dead button to be read as a hang. */
function EnablingNote() {
  return (
    <div className="mem-fine">
      正在让它真的算一次向量 —— 首次调用要把模型读进内存,可能要几十秒。算不出来就不会保存。
    </div>
  );
}

/** The model comparison + disk + free-form field, behind one disclosure. Summarised when closed, so the
 *  section still ANSWERS "which model am I using and how many are there" without unfolding. */
function ModelManager(
  { defaultOpen, count, current, children }:
  { defaultOpen: boolean; count: number; current: string | null; children: React.ReactNode },
) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mem-mgr">
      <button className={`mem-mgr-h${open ? ' on' : ''}`} onClick={() => setOpen(!open)}>
        <span className="cx-caret">{open ? '▾' : '▸'}</span>
        <span className="mem-mgr-label">{open ? '收起模型列表' : '选择 · 下载 · 删除嵌入模型'}</span>
        <span className="mem-mgr-meta">{current ? `当前 ${current}` : '尚未选择'} · {count} 个已实测</span>
      </button>
      {open && <div className="mem-mgr-body">{children}</div>}
    </div>
  );
}

/** Everything Ollama holds, with what it costs in disk — including models this panel's shortlist has
 *  never heard of. Without this, "free up space" means leaving the app for a terminal, and a household
 *  that tried several models has no way to see what the trying cost them. */
function LocalDisk(
  { models, inUse, busy, post }:
  { models: { name: string; sizeBytes: number; capabilities: string[] | null }[]; inUse: (string | null)[];
    busy: string | null; post: (u: string, b: unknown, k: string) => void },
) {
  const [open, setOpen] = useState(false);
  const total = models.reduce((n, m) => n + m.sizeBytes, 0);
  const used = (n: string) => inUse.some((u) => !!u && (u === n || u.split(':')[0] === n.split(':')[0]));
  if (models.length === 0) return null;
  return (
    <div className="mem-disk">
      <button className="cx-btn" onClick={() => setOpen(!open)}>
        {open ? '收起' : '本机模型占用'} · {models.length} 个 · {memBytes(total)}
      </button>
      {open && (
        <div className="mem-disk-list">
          {models.map((m) => (
            <div className="mem-disk-row" key={m.name}>
              {/* Name and badges share ONE grid cell: the badges are conditional, and letting them be
                  their own columns would reflow the whole list depending on which models are installed. */}
              <span className="mem-disk-id">
                <span className="mem-disk-name">{m.name}</span>
                {/* What Ollama says it can DO, so this list answers the question it used to raise: "I have
                    nine models here — why can't I pick one as the judge?". Tested for the word rather than
                    for its absence, because an older daemon reports no capabilities at all and a guess
                    printed as a fact is worse than a blank. */}
                {m.capabilities?.includes('embedding') && <span className="res-badge">嵌入</span>}
                {m.capabilities?.includes('completion') && <span className="res-badge">对话</span>}
              </span>
              <span className="mem-disk-size">{memBytes(m.sizeBytes)}</span>
              {used(m.name)
                ? <span className="res-running">使用中</span>
                : (
                  <button className="cx-btn" disabled={busy === `rm:${m.name}`}
                    onClick={() => post('/api/manage/memory/local/remove', { model: m.name }, `rm:${m.name}`)}>
                    删除
                  </button>
                )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** WHERE the judge runs. Two backends, same feature — so a segmented control, the same idiom the
 *  Local/LAN/WAN access picker uses, rather than a third toggle that would read as a third feature. */
function JudgeTransportPicker(
  { en, busy, post, pullOf }:
  { en: MemoryState['llmEnrichment']; busy: string | null; post: (u: string, b: unknown, k: string) => void;
    pullOf: (id: string) => ModelPull | null },
) {
  // DERIVED from the latest props, with an explicit pick layered on top — never seeded into state.
  // `useState(en.localCandidates[0]?.name ?? '')` ran its initialiser once, on the first render, and this
  // component is not remounted when the panel reloads. So a household that opened the panel with Ollama
  // stopped, hit 启动, and watched their models appear was left holding '' — and the 本机模型 button, which
  // is disabled on `!model`, stayed dead with every model on screen and no way to explain it.
  const [picked, setPicked] = useState<string | null>(null);
  const names = en.localCandidates.map((c) => c.name);
  // First of: what they chose, what is saved, the first candidate — that still EXISTS. A pick or a saved
  // model that has since been deleted must not survive as a value the <select> cannot show.
  const model = [picked, en.localModel, names[0]].find((n) => !!n && names.includes(n)) ?? '';
  const canLocal = names.length > 0;
  return (
    <div className="mem-judge">
      {/* Labelled, because the layer is no longer NAMED after one of these two. When the title said
          Claude CLI 增强, the picker read as a modifier on a Claude feature; under 判断 it reads as what
          it is — the same work, on a backend you choose. */}
      <span className="mem-judge-lbl">运行于</span>
      <div className="cx-seg">
        <button className={`cx-seg-b${en.transport === 'cli' ? ' on' : ''}`} disabled={busy === 'judge'}
          onClick={() => post('/api/manage/memory/judge', { transport: 'cli' }, 'judge')}>Claude CLI</button>
        <button className={`cx-seg-b${en.transport === 'local' ? ' on' : ''}`}
          disabled={busy === 'judge' || !canLocal || !model}
          onClick={() => post('/api/manage/memory/judge', { transport: 'local', model }, 'judge')}>
          {busy === 'judge' ? '切换中…' : '本机模型'}
        </button>
      </div>
      {canLocal && (
        <select className="mem-judge-sel" value={model} onChange={(e) => setPicked(e.target.value)}>
          {en.localCandidates.map((m) => (
            <option key={m.name} value={m.name}>{m.name} · {memBytes(m.sizeBytes)}</option>
          ))}
        </select>
      )}
      {/* WHY the switch is unavailable — outside the <select>, which is the whole point. The previous
          version put this sentence in an <option>, so it could only render when there was something to
          select: the one case it existed to explain was the one case it could never appear in. */}
      {en.localBlocked && <div className="mem-fine warn">{en.localBlocked}</div>}
      {/* …and the FIX, as a button. The local judge and the local embedder are one provider — same Ollama,
          same /api/pull — so a panel that downloads an embedding model with a click has no reason to
          answer "you need a chat model" with a terminal command. */}
      {en.localSuggest && (
        <div className="mem-judge-fix">
          {pullOf(en.localSuggest)?.running ? (
            <span className="res-running">下载中…</span>
          ) : (
            <button className="cx-btn primary" disabled={busy === 'pull:judge'}
              onClick={() => post('/api/manage/memory/local/pull', { model: en.localSuggest }, 'pull:judge')}>
              下载 {en.localSuggest}
            </button>
          )}
          <PullProgress pull={pullOf(en.localSuggest)} />
        </div>
      )}
      <div className="mem-fine">{en.localNote}</div>
    </div>
  );
}

/** Use a model the shortlist does not know about — pulled first if this machine does not have it. */
function OtherModelField(
  { busy, post, installed, pullOf }:
  { busy: string | null; post: (u: string, b: unknown, k: string) => void; installed: string[];
    pullOf: (id: string) => ModelPull | null },
) {
  const [id, setId] = useState('');
  const have = installed.some((n) => n === id || n.split(':')[0] === id.split(':')[0]);
  const pull = id ? pullOf(id) : null;
  return (
    <div className="mem-other">
      <label className="set-field">
        <span>其他模型 · 直接填写 Ollama 模型名</span>
        <input value={id} onChange={(e) => setId(e.target.value.trim())}
          placeholder="例如 nomic-embed-text-v2-moe 或 snowflake-arctic-embed2" />
      </label>
      <div className="mem-other-act">
        {pull?.running ? (
          <span className="res-running">下载中…</span>
        ) : (
          <button className="cx-btn" disabled={!id || busy === 'pull:other'}
            onClick={() => post('/api/manage/memory/local/pull', { model: id }, 'pull:other')}>下载</button>
        )}
        <button className="cx-btn primary" disabled={!id || busy === 'use:other'}
          onClick={() => post('/api/manage/memory/local/enable', { model: id }, 'use:other')}>
          {busy === 'use:other' ? '启用中…' : '使用'}
        </button>
      </div>
      {/* Same two components the table rows use — the free-form field starts exactly the same two long
          operations, so it must not be the one place that still goes quiet during them. */}
      <PullProgress pull={pull} />
      {busy === 'use:other' && <EnablingNote />}
      <div className="mem-fine">
        {id && !have && '这台机器还没有它 —— 先「下载」,再「使用」。'}
        {id && have && '已在本机,可直接「使用」。'}
        {!id && '启用前会先让它真的算一次向量:算不出来就不会保存,免得检索静悄悄地空掉。'}
      </div>
    </div>
  );
}
