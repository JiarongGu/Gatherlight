import { useEffect, useState } from 'react';

/**
 * 记忆检索 · Memory recall — which backend and which model each recall layer uses.
 *
 * It renders INSIDE 校准 · Cortex, so it follows Cortex's vocabulary rather than inventing one — the amber
 * left edge for active, display serif names, mono for anything you compare.
 *
 * TWO THINGS IT DELIBERATELY NO LONGER DOES. It does not download or delete models: a model is a file with
 * a size and a capability, so it lives in 资源 beside the runtime that hosts it. And it holds no list of
 * which backend can serve which layer — the server sends the sources for each layer, and a backend is in
 * that list because a class implementing the layer's interface exists. That is why 语义 shows no Claude
 * arm: not a filter here, an absent class there.
 */

const memBytes = (n: number) =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)} GB` : `${Math.round(n / 1_000_000)} MB`;

interface SourceModel {
  id: string; name: string; installed: boolean; sizeBytes: number | null;
  note: string | null; vintage: string | null;
  measured: { top1: number; top3: number; queries: number; msPerQuery: number } | null;
}

interface SourceView {
  id: string; name: string; description: string;
  // Whether this layer can be bound to it AT ALL. False = there is no implementation behind it (Claude has
  // no embeddings endpoint; the bundled runtime is not shipped yet), so the button exists only to carry the
  // reason. Distinct from `available`, which is "could be bound once its prerequisite is met".
  bindable: boolean;
  // Whether it can serve THIS layer on THIS machine right now. An unavailable backend is still shown, with
  // its reason: hiding it answers "why can't I pick this?" by making the question unaskable.
  available: boolean; reason: string | null;
  // A model 资源 could fetch, when the fix IS a download.
  suggest: string | null;
  // Does the household have to supply an address (a service we do not manage), and what did they supply?
  // The RAW value comes back even when it was refused, so the box can show the typo the reason complains
  // about instead of silently emptying itself.
  needsEndpoint: boolean; endpoint: string | null;
  models: SourceModel[];
}

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
  sources: SourceView[];
  note?: string | null;
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

export function MemoryRecallSection(
  { toast, onRestart, inHost }:
  { toast: (t: string, k?: 'ok' | 'err') => void; onRestart: () => void; inHost: boolean },
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
  // look; polling always would spend a probe of Ollama every second and a half on an idle screen.
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
          {inHost && <button className="cx-btn primary" onClick={onRestart}>重启服务以生效</button>}
          <span className="set-saved">设置已保存,重启后生效</span>
        </div>
      )}

      <div className="mem-layers">
        {/* 1 — the floor */}
        <div className="mem-layer on">
          <div className="mem-layer-main">
            <div className="mem-layer-name">{formula.name}<span className="res-badge">始终启用</span></div>
            <div className="mem-layer-desc">{formula.what}</div>
          </div>
        </div>

        {/* 2 — judgement. Its backend is a CHOICE, so it is a picker; its on/off is LIVE, so it is not. */}
        <div className={`mem-layer${judge.on ? ' on' : ''}`}>
          <div className="mem-layer-main">
            <div className="mem-layer-name">
              {judge.name}
              {judge.on && <span className="res-badge">运行中</span>}
              {/* The RUNNING backend, not the saved one. Shown only while the layer is on, because a
                  backend named for work that is not happening is a false label. */}
              {judge.on && <span className="res-badge">{backendLabel(judge, judge.activeSource, judge.activeModel)}</span>}
              <span className="res-badge">即时生效</span>
            </div>
            <div className="mem-layer-desc">{judge.what}</div>
            <div className="mem-layer-desc"><b>费用</b> {judge.cost}</div>
            {judge.on && <SourcePicker layer={judge} busy={busy} bind={bind('judge')} modelsAt={s.modelsAt} />}
          </div>
          <div className="mem-layer-side">
            <button
              className={`cx-btn${judge.on ? '' : ' primary'}`}
              disabled={busy === 'enrich'}
              onClick={() => post('/api/manage/memory/enrichment', { enabled: !judge.on }, 'enrich')}
            >
              {judge.on ? '关闭' : '启用'}
            </button>
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
              {semantic.activeSource && <span className="res-badge">运行中</span>}
              {semantic.activeSource && semantic.activeModel &&
                <span className="res-badge">{backendLabel(semantic, semantic.activeSource, semantic.activeModel)}</span>}
              {semantic.on && !semantic.activeSource && <span className="res-badge">待重启</span>}
            </div>
            <div className="mem-layer-desc">{semantic.what}</div>
            <div className="mem-layer-desc"><b>费用</b> {semantic.cost}</div>
            <SourcePicker layer={semantic} busy={busy} bind={bind('semantic')} modelsAt={s.modelsAt} />
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
                <button className="cx-btn" disabled={busy === 'reindex' || semantic.reindex?.running}
                  onClick={() => post('/api/manage/memory/layer/semantic/reindex', undefined, 'reindex')}>
                  {semantic.reindex?.running ? '重建中…' : '重建索引'}
                </button>
                <button className="cx-btn" disabled={busy === 'off'}
                  onClick={() => post('/api/manage/memory/layer/semantic/off', undefined, 'off')}>停用</button>
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
  const src = layer.sources.find((x) => x.id === sourceId);
  const name = src?.name ?? sourceId;
  // The CLI arm's model is one of three well-known names, so it reads fine inline; a local model id is
  // long, and the badge is the wrong place for it only when there is nothing else to say.
  return model ? `${name} · ${model}` : name;
}

/** WHERE a layer runs, and on which model.
 *
 *  Rendered from the sources the SERVER reports for this layer — so 语义 shows one button today and grows
 *  a second the day a class implementing its interface is registered, with no edit here. An unavailable
 *  source stays visible and carries its own sentence: a disabled control that says nothing is a dead end,
 *  and the household can see their models listed on another panel and has no way to learn why. */
function SourcePicker(
  { layer, busy, bind, modelsAt }:
  { layer: LayerView; busy: string | null;
    bind: (source: string, model: string, endpoint?: string) => void; modelsAt: string },
) {
  // DERIVED from the latest props, with an explicit pick layered on top — never seeded into state. A
  // useState initialiser runs once and this component is not remounted when the panel reloads, so a
  // household who started Ollama and watched their models appear would otherwise be left holding ''.
  const [pickedSource, setPickedSource] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  // Same derived-with-override rule: the saved address arrives with the data, so seeding a useState
  // initialiser from it would capture whatever the first render had (nothing).
  const [typedUrl, setTypedUrl] = useState<string | null>(null);

  // Prefer the bound backend, then the first BINDABLE one — never simply sources[0], which could be a
  // declined entry and would open the layer on a backend it can never use.
  const source = layer.sources.find((x) => x.id === (pickedSource ?? layer.source))
    ?? layer.sources.find((x) => x.bindable) ?? layer.sources[0];
  if (!source) return null;

  // Only what is ON THIS MACHINE can be bound. The rest of the list is what 资源 could fetch, and offering
  // it here would be a control that fails on click.
  const usable = source.models.filter((m) => m.installed);
  const names = usable.map((m) => m.id);
  // First of: what they chose, what is saved, the first option — that still EXISTS. A pick or a saved
  // model since deleted must not survive as a value the <select> cannot show.
  const model = [pickedModel, layer.model, names[0]].find((n) => !!n && names.includes(n)) ?? '';
  const url = typedUrl ?? source.endpoint ?? '';
  const urlChanged = source.needsEndpoint && url !== (source.endpoint ?? '');
  // "Already in use" has to account for the address too: retyping a URL is a change even when the backend
  // and model are the same, and a 使用 button that read 使用中 would refuse to apply it.
  const unchanged = source.id === layer.source && model === layer.model && !urlChanged;
  const fetchable = source.models.filter((m) => !m.installed).length;

  return (
    <div className="mem-src">
      <span className="mem-src-lbl">运行于</span>
      {/* EVERY backend, including the ones this layer cannot use. Selecting a declined one shows its
          reason instead of a model list — the button exists so "why isn't Claude an option here?" has an
          answer on the screen rather than only in the source tree. It stays clickable for exactly that
          reason; what it cannot do is bind, and 使用 is what enforces that. */}
      <div className="cx-seg">
        {layer.sources.map((x) => (
          <button key={x.id}
            className={`cx-seg-b${source.id === x.id ? ' on' : ''}${x.bindable ? '' : ' na'}`}
            disabled={busy !== null} onClick={() => { setPickedSource(x.id); setPickedModel(null); }}>
            {x.name}
          </button>
        ))}
      </div>
      {/* The address, for a service we do not manage. Sits BEFORE the model list because the list comes
          FROM that address — an empty model picker above an empty URL box would read as broken rather than
          as unconfigured. */}
      {source.bindable && source.needsEndpoint && (
        <input className="mem-src-url" value={url} placeholder="http://127.0.0.1:8080"
          onChange={(e) => setTypedUrl(e.target.value)} />
      )}
      {source.bindable && usable.length > 0 && (
        <select className="mem-src-sel" value={model} onChange={(e) => setPickedModel(e.target.value)}>
          {usable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}{m.sizeBytes ? ` · ${memBytes(m.sizeBytes)}` : ''}
            </option>
          ))}
        </select>
      )}
      {/* ALREADY APPLIED is a STATUS, not a disabled button. A greyed-out amber primary reading 使用中 is a
          dead control wearing the colour that means "this does something" — and this panel's own rule is
          that a disabled control saying nothing is a dead end. So when there is nothing to apply, the
          affordance goes away and a quiet label takes its place. */}
      {source.bindable && unchanged && <span className="mem-src-cur">使用中</span>}
      {source.bindable && !unchanged && (
        <button className="cx-btn primary"
          // A NEW address is bindable before its model list exists — that request is what fetches the list.
          // Requiring a model first would make the field impossible to submit.
          disabled={busy !== null || (source.needsEndpoint ? !url : (!model || !source.available))}
          onClick={() => bind(source.id, model, source.needsEndpoint ? url : undefined)}>
          {busy?.startsWith('bind:') ? '保存中…' : urlChanged && !model ? '连接' : '使用'}
        </button>
      )}
      {!source.bindable && <span className="mem-src-na">这一层用不了</span>}

      {source.bindable && <div className="mem-fine">{source.description}</div>}
      {/* WHY it cannot be used — outside the <select>, which is the whole point. An earlier version put
          this sentence in an <option>, so it could only render when there was something to select: the one
          case it existed to explain was the one case it could never appear in. */}
      {!source.available && source.reason && <div className="mem-fine warn">{source.reason}</div>}
      {/* …and where the fix is. Not a button: downloading is 资源's job now, and a second download control
          here would be the two-writers problem this whole pass exists to remove. */}
      {source.suggest && (
        <div className="mem-fine">
          需要的模型可在「{modelsAt}」面板一键下载:<b className="mem-mono">{source.suggest}</b>
        </div>
      )}
      {source.bindable && source.available && usable.length === 0 && (
        <div className="mem-fine warn">这个后端还没有可用的模型 —— 请先在「{modelsAt}」面板下载。</div>
      )}
      {source.bindable && fetchable > 0 && (
        <div className="mem-fine">还有 {fetchable} 个可以下载的模型,在「{modelsAt}」面板。</div>
      )}
    </div>
  );
}

