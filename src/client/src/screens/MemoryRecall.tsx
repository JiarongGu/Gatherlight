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
interface MemoryState {
  formula: { alwaysOn: boolean; what: string };
  // `live` = takes effect immediately (an app_config value read per call). The local model below is a
  // startup registration instead, which is why only IT reports enabled-vs-active.
  llmEnrichment: {
    enabled: boolean; live: boolean; what: string; cost: string; model: string;
    // WHERE it runs, as opposed to WHETHER. Unlike `enabled` this is a startup registration, so the two
    // are shown as different kinds of change rather than two switches that look alike.
    transport: 'cli' | 'local'; localModel: string | null; localNote: string;
    localCandidates: { name: string; sizeBytes: number }[];
  };
  localModel: {
    enabled: boolean; active: boolean; model: string | null; what: string; cost: string;
    note: string | null;
    ollama: {
      baseUrl: string; installed: boolean; serving: boolean; version: string | null;
      executable: string | null; gpuLikely: boolean; problem: string | null;
      models: { name: string; sizeBytes: number }[];
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

  // Poll ONLY while a rebuild is running. It is minutes of work that outlives the request which started
  // it, so the panel has to go and look; polling all the time would spend a probe of Ollama every two
  // seconds for a screen that is usually idle.
  const reindexing = s?.localModel.reindex.running ?? false;
  useEffect(() => {
    if (!reindexing) return;
    const t = setInterval(() => { load(false); }, 2000);
    return () => clearInterval(t);
  }, [reindexing]);

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
  // Saved but not running = a restart is owed. Only the local model can be in that state; the
  // enrichment is live, so offering a restart for it would be theatre.
  const pending = lm.enabled !== lm.active;

  return (
    <>
      <div className="mng-title">记忆检索 · Memory recall</div>

      {/* WHAT IS ON, in one line, before any of the controls. The previous layout opened with three
          equal-weight prose blocks, so answering "what is running right now" meant reading all of them. */}
      <div className="mem-sum">
        <span className={`mem-pill on`}>公式</span>
        <span className={`mem-pill${s.llmEnrichment.enabled ? ' on' : ''}`}>
          Claude 判断{s.llmEnrichment.enabled ? '' : '(关)'}
        </span>
        <span className={`mem-pill${lm.active ? ' on' : ''}`}>
          本地语义{lm.active ? `(${lm.model})` : lm.enabled ? '(待重启)' : '(关)'}
        </span>
      </div>
      <div className="set-lead">
        三项互补,不是三选一:<b>公式</b>永远在跑;<b>Claude 判断</b>只调整已检索结果的顺序;<b>本地语义</b>改变「能不能被检索到」。
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

        {/* 2 — claude CLI enrichment */}
        <div className={`mem-layer${s.llmEnrichment.enabled ? ' on' : ''}`}>
          <div className="mem-layer-main">
            <div className="mem-layer-name">
              Claude CLI 增强
              {s.llmEnrichment.enabled && <span className="res-badge">运行中</span>}
              <span className="res-badge">即时生效</span>
            </div>
            <div className="mem-layer-desc">{s.llmEnrichment.what}</div>
            <div className="mem-layer-desc"><b>费用</b> {s.llmEnrichment.cost}</div>
            <div className="mem-layer-desc">{s.llmEnrichment.model}</div>
            {s.llmEnrichment.enabled && (
              <JudgeTransportPicker en={s.llmEnrichment} busy={busy} post={post} />
            )}
          </div>
          <div className="mem-layer-side">
            <button
              className={`cx-btn${s.llmEnrichment.enabled ? '' : ' primary'}`}
              disabled={busy === 'enrich'}
              onClick={() => post('/api/manage/memory/enrichment', { enabled: !s.llmEnrichment.enabled }, 'enrich')}
            >
              {s.llmEnrichment.enabled ? '关闭' : '启用'}
            </button>
          </div>
        </div>

        {/* 3 — local model */}
        <div className={`mem-layer${lm.active ? ' on' : ''}${o.problem && lm.enabled ? ' err' : ''}`}>
          <div className="mem-layer-main">
            <div className="mem-layer-name">
              本地模型 · Local model
              {lm.active && <span className="res-badge">运行中</span>}
              {o.gpuLikely && <span className="res-badge">GPU 可用</span>}
            </div>
            <div className="mem-layer-desc">{lm.what}</div>
            <div className="mem-layer-desc"><b>费用</b> {lm.cost}</div>
            <div className="mem-layer-desc">
              Ollama:{o.installed ? (o.serving ? `运行中 ${o.version ?? ''}` : '已安装,未运行') : '未安装'}
              {o.installed && ` · ${o.baseUrl}`}
            </div>
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
                  {s.llmEnrichment.enabled && ' · 开启了增强,每条事实会多一次模型调用,请耐心等待'}
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
          it was rendering at full size even with 本地语义 switched off, which is what made the section feel
          oversized. A sub-tab would have treated the symptom and cost more: a second level of navigation
          on a rarely-visited screen, and — worse — it would put the 本地语义 switch and the table that
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
                      {!m.present ? (
                        <button className="cx-btn" disabled={busy === `pull:${m.id}`}
                          onClick={() => post('/api/manage/memory/local/pull', { model: m.id }, `pull:${m.id}`)}>
                          {busy === `pull:${m.id}` ? '下载中…' : '下载'}
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
                            使用
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

          <LocalDisk models={o.models} inUse={[lm.model, s.llmEnrichment.localModel]} busy={busy} post={post} />

          {/* THE LIST IS NOT THE LIMIT. A catalog baked into a release cannot contain a model published
              after it — which is exactly how this panel shipped without the two best models available at
              the time. Anything Ollama can pull is usable here the day it exists. */}
          <OtherModelField busy={busy} post={post} installed={o.models.map((x) => x.name)} />
        </ModelManager>
      )}
    </>
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
  { models: { name: string; sizeBytes: number }[]; inUse: (string | null)[];
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
              <span className="mem-disk-name">{m.name}</span>
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
  { en, busy, post }:
  { en: MemoryState['llmEnrichment']; busy: string | null; post: (u: string, b: unknown, k: string) => void },
) {
  const [model, setModel] = useState(en.localModel ?? en.localCandidates[0]?.name ?? '');
  const canLocal = en.localCandidates.length > 0;
  return (
    <div className="mem-judge">
      <div className="cx-seg">
        <button className={`cx-seg-b${en.transport === 'cli' ? ' on' : ''}`} disabled={busy === 'judge'}
          onClick={() => post('/api/manage/memory/judge', { transport: 'cli' }, 'judge')}>Claude CLI</button>
        <button className={`cx-seg-b${en.transport === 'local' ? ' on' : ''}`}
          disabled={busy === 'judge' || !canLocal || !model}
          onClick={() => post('/api/manage/memory/judge', { transport: 'local', model }, 'judge')}>本机模型</button>
      </div>
      {en.transport === 'local' || canLocal ? (
        <select className="mem-judge-sel" value={model} onChange={(e) => setModel(e.target.value)}>
          {!canLocal && <option value="">没有可用的对话模型</option>}
          {en.localCandidates.map((m) => (
            <option key={m.name} value={m.name}>{m.name} · {memBytes(m.sizeBytes)}</option>
          ))}
        </select>
      ) : null}
      <div className="mem-fine">{en.localNote}</div>
    </div>
  );
}

/** Use a model the shortlist does not know about — pulled first if this machine does not have it. */
function OtherModelField(
  { busy, post, installed }:
  { busy: string | null; post: (u: string, b: unknown, k: string) => void; installed: string[] },
) {
  const [id, setId] = useState('');
  const have = installed.some((n) => n === id || n.split(':')[0] === id.split(':')[0]);
  return (
    <div className="mem-other">
      <label className="set-field">
        <span>其他模型 · 直接填写 Ollama 模型名</span>
        <input value={id} onChange={(e) => setId(e.target.value.trim())}
          placeholder="例如 nomic-embed-text-v2-moe 或 snowflake-arctic-embed2" />
      </label>
      <div className="mem-other-act">
        <button className="cx-btn" disabled={!id || busy === 'pull:other'}
          onClick={() => post('/api/manage/memory/local/pull', { model: id }, 'pull:other')}>
          {busy === 'pull:other' ? '下载中…' : '下载'}
        </button>
        <button className="cx-btn primary" disabled={!id || busy === 'use:other'}
          onClick={() => post('/api/manage/memory/local/enable', { model: id }, 'use:other')}>使用</button>
      </div>
      <div className="mem-fine">
        {id && !have && '这台机器还没有它 —— 先「下载」,再「使用」。'}
        {id && have && '已在本机,可直接「使用」。'}
        {!id && '启用前会先让它真的算一次向量:算不出来就不会保存,免得检索静悄悄地空掉。'}
      </div>
    </div>
  );
}
