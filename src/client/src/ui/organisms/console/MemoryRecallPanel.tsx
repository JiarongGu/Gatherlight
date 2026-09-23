import { useEffect, useState } from 'react';
import { PanelButton, PanelBadge } from '@/ui/atoms';
import { BackendPicker, type BackendGroup } from '@/ui/molecules';
import { inHost } from '@/lib/host';

/**
 * 记忆检索 · Memory recall — which backend and which model each recall layer uses.
 *
 * It renders INSIDE 校准 · Cortex, so it follows Cortex's vocabulary rather than inventing one — the amber
 * left edge for active, display serif names, mono for anything you compare.
 *
 * IT MANAGES NO MODELS AT ALL, and that is now consistent rather than a gap. Everything Gatherlight
 * provisions — the pinned GGUFs, the ONNX embedder — lives in 资源 beside the runtime that hosts it, tested
 * and ranked and downloadable there. Everything else belongs to a service the household runs, reached by
 * address through 本机, and managed with that service's own tools.
 *
 * The in-between state is what was wrong: for a while this panel listed a daemon's models and offered them
 * while nothing anywhere could add or remove one. Half-managing somebody else's runtime has no consistent
 * version — either the app owns a runtime or it connects to one.
 *
 * It holds no list of which backend can serve which layer — the server sends the groups, and a backend is
 * in one because a class implementing that layer's interface exists. Nothing here FILTERS, which is the
 * property that matters; what an absent class never licensed was withholding a choice (see
 * IMemorySemanticSource — 语义 has a Claude arm precisely because that reasoning was wrong).
 */

// A backend's shape belongs to BackendPicker — the molecule that renders it — so this panel imports the
// type rather than keeping a second copy that could drift from what the picker actually reads.

interface LayerView {
  id: 'formula' | 'judge' | 'semantic';
  name: string; alwaysOn: boolean; on: boolean;
  // `live` = takes effect immediately. A BINDING never is — it is a startup registration — so the two
  // kinds of change are shown differently rather than as two switches that look alike.
  live: boolean;
  what: string; cost: string;
  source: string | null; model: string | null;
  // What is RUNNING, as opposed to what is saved — in the SAME vocabulary, because two vocabularies for
  // one comparison can never come out equal, which reads as a restart permanently owed.
  activeSource: string | null; activeModel: string | null;
  /** The three places a model can live (cli / machine / self-contained), each with its member backends —
   *  see MemoryGroups. Grouped by the SERVER so the group's name and sentence have one writer. */
  groups: BackendGroup[];
  note?: string | null;
  /** 判断 only, and only when the running judge just CHECKS (a reranker): whether its tagging — handed to the
   *  Claude CLI — is happening now. Null when the CLI's state is unknown, which the server will not guess. */
  tagging?: { works: boolean; text: string } | null;
  reindex?: {
    running: boolean; done: number; total: number;
    embedded: number | null; error: string | null;
    // Null until the run has counted its facts: a bar pinned at 0% reads as stuck.
    percent: number | null;
  };
  // STATE, not history: how much of what the household knows is actually searchable.
  coverage?: { indexed: number; total: number };
}

interface MemoryState {
  layers: LayerView[];
  weighting: { primary: string; note: string };
  modelsAt: string;
}

export function MemoryRecallPanel(
  { toast, onRestart }:
  { toast: (t: string, k?: 'ok' | 'err') => void; onRestart: () => void },
) {
  const [s, setS] = useState<MemoryState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async (refresh = false) => {
    try { setS(await (await fetch(`/api/manage/memory${refresh ? '?refresh=true' : ''}`)).json()); }
    catch { /* keep last */ }
  };
  useEffect(() => { load(true); }, []);

  const semantic = s?.layers.find((l) => l.id === 'semantic');
  // Poll ONLY while a rebuild runs. It outlives the request that started it, so the panel has to go and
  // look; polling always would probe every backend every second and a half on an idle screen.
  // Gate on a DERIVED boolean — keying the effect on `s` would tear down the interval every tick.
  const rebuilding = semantic?.reindex?.running ?? false;
  useEffect(() => {
    if (!rebuilding) return;
    const t = setInterval(() => { load(false); }, 1500);
    return () => clearInterval(t);
  }, [rebuilding]);

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

  if (!s || !semantic) return <div className="eval-empty">加载中…</div>;
  const formula = s.layers.find((l) => l.id === 'formula')!;
  const judge = s.layers.find((l) => l.id === 'judge')!;

  // Saved but not running = a restart is owed. Only a BINDING can be in that state; 判断's on/off is live,
  // so it must never contribute here or every toggle would ask for a restart it does not need.
  //
  // The MODEL is only compared when a source is actually bound. Turning 语义 off REMEMBERS its model on
  // purpose (so switching back costs neither a download nor a rebuild), and comparing that remembered value
  // against a running model of null made the banner permanent: an unbound layer would ask forever for a
  // restart that changes nothing. A restart prompt that never goes away is one nobody reads when it matters.
  const owed = (l: LayerView) =>
    l.source !== l.activeSource || (!!l.source && l.model !== l.activeModel);
  const pending = owed(judge) || owed(semantic);

  const bind = (layer: string) => (source: string, model: string, endpoint?: string) =>
    post(`/api/manage/memory/layer/${layer}`, { source, model, endpoint }, `bind:${layer}`);

  // WHAT "no model" MEANS, per layer — the 内置 group has no backend to bind, so the picker needs the
  // action handed to it. 判断 has a LIVE switch (its enrichment flag, effective immediately); 语义 is a
  // startup registration, so it unbinds. Two different verbs for one option, which is exactly why this is a
  // prop rather than something BackendPicker works out — it knows nothing about layers.
  const offFor = (l: LayerView) => l.id === 'judge'
    ? { active: !l.on, apply: () => post('/api/manage/memory/enrichment', { enabled: false }, 'enrich') }
    : { active: !l.on, apply: () => post('/api/manage/memory/layer/semantic/off', undefined, 'off') };

  return (
    <>
      <div className="mng-title">记忆检索 · Memory recall</div>

      {/* WHAT IS ON, in one line, before any of the controls — including 语义 even though it sits under
          高级 below. State is state: a layer being secondary is a reason to present it later, not a reason
          to leave it out of the answer to "what is running right now". */}
      <div className="mem-sum">
        {s.layers.map((l) => (
          <span key={l.id} className={`mem-pill${l.on ? ' on' : ''}`}>
            {l.name.split(' · ')[0]}
            {l.alwaysOn ? '' : l.on ? `(${backendLabel(l, l.activeSource, l.activeModel)})` : '(关)'}
          </span>
        ))}
      </div>
      <div className="set-lead">
        三层互补,不是三选一:<b>公式</b>永远在跑;<b>判断</b>调整已检索结果的顺序;<b>语义</b>改变「能不能被检索到」。
        模型的下载与删除在「{s.modelsAt}」面板;这里只决定每一层用哪个。
      </div>
      {/* A RECOMMENDATION of where to start, not a reason to bury a layer. It was briefly used to fold 语义
          under 高级; that put someone else's measurement in charge of this panel's shape, which is more
          than a borrowed number should decide. The note stays — attributed — and both layers stay equal. */}
      <div className="mem-fine">{s.weighting.note}</div>
      {pending && (
        <div className="set-actions">
          {inHost && <PanelButton variant="primary" onClick={onRestart}>重启服务以生效</PanelButton>}
          <span className="set-saved">设置已保存,重启后生效</span>
        </div>
      )}

      <div className="mem-layers">
        {/* 1 — the floor */}
        <div className="mem-layer on">
          <div className="mem-layer-main">
            <div className="mem-layer-name">{formula.name}<PanelBadge kind="state">始终启用</PanelBadge></div>
            <div className="mem-layer-desc">{formula.what}</div>
          </div>
        </div>

        {/* 2 — judgement. Its backend is a CHOICE, so it is a picker; its on/off is LIVE, so it is not. */}
        <div className={`mem-layer${judge.on ? ' on' : ''}`}>
          <div className="mem-layer-main">
            <div className="mem-layer-name">
              {judge.name}
              {judge.on && <PanelBadge kind="state">运行中</PanelBadge>}
              {/* The RUNNING backend, not the saved one. Shown only while the layer is on, because a
                  backend named for work that is not happening is a false label. */}
              {judge.on && <PanelBadge kind="state">{backendLabel(judge, judge.activeSource, judge.activeModel)}</PanelBadge>}
              <PanelBadge kind="state">即时生效</PanelBadge>
            </div>
            <div className="mem-layer-desc">{judge.what}</div>
            <div className="mem-layer-desc"><b>费用</b> {judge.cost}</div>
            {/* A signed-out CLI means NO tagging for a reranker judge — fail-open, so this line is the only place
                it shows. Warn-styled only when it is not happening. */}
            {judge.on && judge.tagging && (
              <div className={`mem-fine${judge.tagging.works ? '' : ' warn'}`}>{judge.tagging.text}</div>
            )}
            {judge.on && (
              <BackendPicker groups={judge.groups} boundSource={judge.source} boundModel={judge.model}
                busy={busy} bind={bind('judge')}
              off={offFor(judge)} modelsAt={s.modelsAt} />
            )}
          </div>
          <div className="mem-layer-side">
            <PanelButton
              variant={judge.on ? 'default' : 'primary'}
              disabled={busy === 'enrich'}
              onClick={() => post('/api/manage/memory/enrichment', { enabled: !judge.on }, 'enrich')}
            >
              {judge.on ? '关闭' : '启用'}
            </PanelButton>
          </div>
        </div>

        {/* 3 — semantic, a co-equal third card. It was briefly folded under a 高级 divider on Lyntai's
            measurement; that let a borrowed number decide this panel's shape, which is more than a
            measurement taken on somebody else's corpus should get to do. The recommendation is a line
            above; the layer is a card like the others. */}
        <div className={`mem-layer${semantic.activeSource ? ' on' : ''}`}>
          <div className="mem-layer-main">
            <div className="mem-layer-name">
              {semantic.name}
              {semantic.activeSource && <PanelBadge kind="state">运行中</PanelBadge>}
              {semantic.activeSource && semantic.activeModel &&
                <PanelBadge kind="state">{backendLabel(semantic, semantic.activeSource, semantic.activeModel)}</PanelBadge>}
              {semantic.on && !semantic.activeSource && <PanelBadge kind="state">待重启</PanelBadge>}
            </div>
            <div className="mem-layer-desc">{semantic.what}</div>
            <div className="mem-layer-desc"><b>费用</b> {semantic.cost}</div>
            <BackendPicker groups={semantic.groups} boundSource={semantic.source} boundModel={semantic.model}
              busy={busy} bind={bind('semantic')}
              off={offFor(semantic)} modelsAt={s.modelsAt} />
            {semantic.note && <div className="mem-fine">说明:{semantic.note}</div>}

            {/* The rebuild, while it runs and after it ends. It used to be a greyed-out button and
                nothing else, for minutes — indistinguishable from a hang. */}
            {semantic.reindex?.running && (
              <div className="mem-reindex">
                <div className="res-prog">
                  <span className="res-bar" style={{ width: `${semantic.reindex.percent ?? 8}%` }} />
                </div>
                <div className="mem-fine">
                  {semantic.reindex.total > 0
                    ? `重建索引中:${semantic.reindex.done}/${semantic.reindex.total} 条事实`
                    : '重建索引中:正在统计事实…'}
                  {judge.on && ' · 开启了判断,每条事实会多一次模型调用,请耐心等待'}
                </div>
              </div>
            )}
            {/* Coverage is the standing answer; the rebuild is an event that changes it. Shown only when
                it is NOT complete — "25/25" every day is noise, a shortfall is worth acting on. */}
            {!semantic.reindex?.running && semantic.coverage && semantic.coverage.total > 0
              && semantic.coverage.indexed < semantic.coverage.total && (
              <div className="mem-fine warn">
                索引覆盖 {semantic.coverage.indexed}/{semantic.coverage.total} 条事实 —— 其余仍可用关键词找到,
                重启后会自动补齐,也可以现在「重建索引」。
              </div>
            )}
            {!semantic.reindex?.running && semantic.reindex?.error && (
              <div className="mem-fine danger">上次重建:{semantic.reindex.error}</div>
            )}
            {!semantic.reindex?.running && semantic.reindex?.embedded ? (
              <div className="mem-fine">上次重建完成:{semantic.reindex.embedded} 条事实已重新索引。</div>
            ) : null}
          </div>
          <div className="mem-layer-side">
            {semantic.on && (
              <>
                <PanelButton disabled={busy === 'reindex' || semantic.reindex?.running}
                  onClick={() => post('/api/manage/memory/layer/semantic/reindex', undefined, 'reindex')}>
                  {semantic.reindex?.running ? '重建中…' : '重建索引'}
                </PanelButton>
                <PanelButton disabled={busy === 'off'}
                  onClick={() => post('/api/manage/memory/layer/semantic/off', undefined, 'off')}>停用</PanelButton>
              </>
            )}
          </div>
        </div>
      </div>

    </>
  );
}

/** The backend a layer is on, named for a badge. Falls back to the raw id rather than to a guess: a source
 *  this client has never heard of is one the server added, and inventing a label for it would be a lie the
 *  moment it mattered. */
function backendLabel(layer: LayerView, sourceId: string | null, model: string | null) {
  if (!sourceId) return '未设置';
  // Flattened: the badge names the BACKEND that is running, not the group, because "Ollama" and
  // "llama.cpp" are what a household needs to see when a restart is owed — the group heading (本机 · Machine)
  // holds both and is one level too coarse to tell them apart. Which is also why the member names are BARE:
  // the heading already says who manages it, so repeating that in every member just made the badge long.
  const src = (layer.groups ?? []).flatMap((g) => g.sources).find((x) => x.id === sourceId);
  const name = src?.name ?? sourceId;
  // The CLI arm's model is one of three well-known names, so it reads fine inline; a local model id is
  // long, and the badge is the wrong place for it only when there is nothing else to say.
  return model ? `${name} · ${model}` : name;
}
