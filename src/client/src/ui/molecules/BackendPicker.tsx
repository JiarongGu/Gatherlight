import { useState } from 'react';
import { PanelButton } from '@/ui/atoms';
import { Segmented } from './Segmented';

const memBytes = (n: number) =>
  n >= 1_000_000_000 ? `${(n / 1_000_000_000).toFixed(1)} GB` : `${Math.round(n / 1_000_000)} MB`;

/** One model a backend offers. */
export interface BackendModel {
  id: string; name: string; installed: boolean; sizeBytes: number | null;
  note: string | null; vintage: string | null;
  measured: { top1: number; top3: number; queries: number; msPerQuery: number } | null;
}

/** One backend a layer could run on, as the server describes it. */
export interface BackendView {
  id: string; name: string; description: string;
  /** Whether this layer can be bound to it AT ALL. False = there is no implementation behind it, so the
   *  button exists only to carry the reason. Distinct from `available`, which is "could be bound once its
   *  prerequisite is met". */
  bindable: boolean;
  available: boolean; reason: string | null;
  /** Something the provisioning panel could fetch, when the fix IS a download. */
  suggest: string | null;
  /** Does the household have to supply an address (a service we do not manage), and what did they supply?
   *  The RAW value comes back even when it was refused, so the box can show the typo the reason complains
   *  about instead of silently emptying itself. */
  needsEndpoint: boolean; endpoint: string | null;
  /** WHOSE runtime this is on THIS install. Null on a declined backend — there is no runtime behind it, so
   *  the server sends nothing rather than a plausible label, and this renders nothing rather than a
   *  placeholder. `kind` styles it, `text` is the sentence the household reads. */
  origin: { kind: 'bundled' | 'app' | 'household'; text: string } | null;
  models: BackendModel[];
  /** Which heading it sits under. Sent for completeness; the grouping itself arrives pre-built below. */
  group: string;
}

/** One of the three places a model can live, with the backends that implement it. */
export interface BackendGroup {
  id: string;
  /** From the server — a group is a product statement about who manages a model, so its words have one
   *  writer (MemoryGroups) rather than being restated here. */
  name: string;
  description: string;
  sources: BackendView[];
}

/**
 * WHERE something runs, and on which model.
 *
 * Rendered from the backends the SERVER reports — so a layer shows one button today and grows a second the
 * day a class implementing its interface is registered, with no edit here.
 *
 * <b>Every backend is shown, including the ones this layer cannot use.</b> Selecting a declined one shows
 * its reason instead of a model list: the button exists so "why isn't this an option here?" has an answer
 * on the screen rather than only in the source tree. It stays clickable for exactly that reason; what it
 * cannot do is bind, and 使用 is what enforces that.
 *
 * Takes the backends and the current binding rather than a whole layer — nothing here needs to know what a
 * recall layer is, which is what makes it a molecule rather than part of the panel.
 */
export function BackendPicker(
  { groups, boundSource, boundModel, busy, bind, off, modelsAt }:
  {
    groups: BackendGroup[];
    boundSource: string | null;
    boundModel: string | null;
    busy: string | null;
    bind: (source: string, model: string, endpoint?: string) => void;
    /** The group that has no backends — choosing it turns the layer off. Passed in rather than derived,
     *  because "off" means something different per layer (判断 has a live switch, 语义 unbinds) and this
     *  molecule deliberately knows nothing about layers. `active` is whether the layer is ALREADY off, so
     *  the button can read 使用中 instead of offering a change that would do nothing. */
    off?: { active: boolean; apply: () => void };
    /** Panel name to point at when the fix is a download — passed in so this does not hard-code a
     *  sibling screen's title. */
    modelsAt: string;
  },
) {
  // DERIVED from the latest props, with an explicit pick layered on top — never seeded into state. A
  // useState initialiser runs once and this component is not remounted when the panel reloads, so a
  // household who started a daemon and watched their models appear would otherwise be left holding ''.
  const [pickedGroup, setPickedGroup] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  // Same derived-with-override rule: the saved address arrives with the data, so seeding a useState
  // initialiser from it would capture whatever the first render had (nothing).
  const [typedUrl, setTypedUrl] = useState<string | null>(null);

  const groupOf = (sourceId: string | null) =>
    groups.find((g) => g.sources.some((x) => x.id === sourceId));
  // Prefer the group holding the bound backend, then the first with a BINDABLE member — never groups[0],
  // which could be a heading whose only member this layer cannot use.
  // An UNBOUND layer is already in the "no model" state, so that group is what it should open on —
  // otherwise the picker opens on a backend the layer is not using and the row misdescribes itself.
  const group = groups.find((g) => g.id === pickedGroup)
    ?? groupOf(boundSource)
    ?? (boundSource === null ? groups.find((g) => g.sources.length === 0) : undefined)
    ?? groups.find((g) => g.sources.some((x) => x.bindable))
    ?? groups[0];
  if (!group) return null;

  // THE GROUP WITH NOTHING TO CONFIGURE. No address, no model list, no reason sentence — its description
  // already says what choosing it costs. Rendered before all of that rather than falling through the
  // model-select path, which would show "这一层用不了" for the one option that always works.
  if (group.sources.length === 0) {
    return (
      <div className="mem-src">
        <span className="mem-src-lbl">模型来自</span>
        <Segmented
          value={group.id}
          disabled={busy !== null}
          onSelect={(id) => { setPickedGroup(id); setPickedModel(null); }}
          options={groups.map((g) => ({
            value: g.id,
            label: g.name,
            available: g.sources.length === 0 || g.sources.some((x) => x.bindable),
          }))}
        />
        {off?.active
          ? <span className="mem-src-cur">使用中</span>
          : (
            <PanelButton variant="primary" disabled={busy !== null || !off}
              onClick={() => off?.apply()}>
              {busy?.startsWith('bind:') || busy === 'off' || busy === 'enrich' ? '保存中…' : '使用'}
            </PanelButton>
          )}
        <div className="mem-fine">{group.description}</div>
      </div>
    );
  }

  const bindable = group.sources.filter((x) => x.bindable);
  // EVERY installed model the group can offer, each remembering which backend owns it. This is what makes
  // the implementation a consequence rather than a decision: an Ollama tag is Ollama's, a GGUF is
  // llama.cpp's, so choosing the MODEL chooses the source — nothing has to pick an engine for the
  // household, and no rule can pick the wrong one.
  const usable = bindable.flatMap((x) => x.models.filter((m) => m.installed).map((m) => ({ ...m, src: x })));
  const names = usable.map((m) => m.id);
  // First of: what they chose, what is saved, the first option — that still EXISTS. A pick or a saved
  // model since deleted must not survive as a value the <select> cannot show.
  const model = [pickedModel, boundModel, names[0]].find((n) => !!n && names.includes(n)) ?? '';
  // The chosen model names its own backend. Falling back to the first bindable member covers the one case
  // with no model yet: a household typing an address, whose bind request is what fetches the list.
  const source = usable.find((m) => m.id === model)?.src
    ?? bindable.find((x) => x.needsEndpoint) ?? bindable[0] ?? group.sources[0];

  // The address belongs to whichever member asks for one — inside 本机, that is the household's own
  // service, sitting beside Ollama rather than as a rival heading.
  const addressed = bindable.find((x) => x.needsEndpoint);
  const url = typedUrl ?? addressed?.endpoint ?? '';
  const urlChanged = !!addressed && url !== (addressed.endpoint ?? '');
  const unchanged = source?.id === boundSource && model === boundModel && !urlChanged;
  // The SELECTED model's own note — a reranker moving only half of 判断, say. A trade-off the household
  // cannot see at the moment of choosing is one they did not get to weigh, so it belongs under the
  // <select> itself rather than one click away in 本机模型.
  const selectedNote = usable.find((m) => m.id === model)?.note;
  const fetchable = bindable.reduce((n, x) => n + x.models.filter((m) => !m.installed).length, 0);
  // A group is usable when ANY member is. The reason to show, when it is not, belongs to the member that
  // came closest — the bindable one, or the declined one if that is all there is.
  const blocker = bindable.find((x) => !x.available) ?? group.sources.find((x) => !x.bindable);

  return (
    <div className="mem-src">
      <span className="mem-src-lbl">模型来自</span>
      {/* THREE headings, not five implementations. `available` rather than `disabled` on a group nothing in
          it can serve: pressing it is how you read why — the case Segmented's flag exists for. */}
      <Segmented
        value={group.id}
        disabled={busy !== null}
        onSelect={(id) => { setPickedGroup(id); setPickedModel(null); }}
        options={groups.map((g) => ({
          value: g.id,
          label: g.name,
          available: g.sources.some((x) => x.bindable),
        }))}
      />
      {/* The address, for the member of 本机 that we do not manage. Sits BEFORE the model list because the
          list comes FROM that address — an empty picker above an empty box reads as broken rather than as
          unconfigured. Inside a group it is additive: Ollama's models are already listed, and this adds
          another service's. */}
      {addressed && (
        <input className="mem-src-url" value={url} placeholder="http://127.0.0.1:8080"
          onChange={(e) => setTypedUrl(e.target.value)} />
      )}
      {usable.length > 0 && (
        <select className="mem-src-sel" value={model} onChange={(e) => setPickedModel(e.target.value)}>
          {usable.map((m) => (
            <option key={`${m.src.id}:${m.id}`} value={m.id}>
              {m.name}{m.sizeBytes ? ` · ${memBytes(m.sizeBytes)}` : ''}
            </option>
          ))}
        </select>
      )}
      {/* The chosen model's own trade-off — a reranker moving only half of 判断, say. Shown where the
          model is picked, not only in 本机模型: a trade-off you cannot see at the moment of choosing is
          one you did not get to weigh. */}
      {selectedNote && <div className="mem-src-note">{selectedNote}</div>}
      {/* ALREADY APPLIED is a STATUS, not a disabled button. A greyed-out amber primary reading 使用中 is a
          dead control wearing the colour that means "this does something". */}
      {bindable.length > 0 && unchanged && <span className="mem-src-cur">使用中</span>}
      {bindable.length > 0 && !unchanged && source && (
        <PanelButton variant="primary"
          // A NEW address is bindable before its model list exists — that request is what fetches the list.
          disabled={busy !== null
            || (addressed && !model ? !url : (!model || !source.available))}
          onClick={() => bind(source.id, model, source.needsEndpoint ? url : undefined)}>
          {busy?.startsWith('bind:') ? '保存中…' : urlChanged && !model ? '连接' : '使用'}
        </PanelButton>
      )}
      {bindable.length === 0 && <span className="mem-src-na">这一层用不了</span>}

      {/* The GROUP's sentence — who manages a model, which is the level the choice is actually made at.
          The per-implementation description lives one level down and is no longer a thing the household
          has to read to choose. */}
      <div className="mem-fine">{group.description}</div>
      {/* WHOSE runtime, for the backend the chosen model belongs to. Inside 本机 this is the answer that
          differs between members — Ollama may be ours or theirs — which is exactly why it stayed. */}
      {source?.origin && (
        <div className={`mem-origin ${source.origin.kind}`}>{source.origin.text}</div>
      )}
      {/* WHY it cannot be used, from whichever member came closest. Outside the <select>, which is the
          point: an earlier version put this in an <option>, so it could only render when there was
          something to select — the one case it existed to explain was the one it could never appear in. */}
      {blocker?.reason && <div className="mem-fine warn">{blocker.reason}</div>}
      {/* …and where the fix is. Not a button: downloading belongs to the provisioning panel, and a second
          download control here would be the two-writers problem this arrangement exists to remove. */}
      {blocker?.suggest && (
        <div className="mem-fine">
          需要的模型可在「{modelsAt}」面板一键下载:<b className="mem-mono">{blocker.suggest}</b>
        </div>
      )}
      {bindable.length > 0 && usable.length === 0 && !blocker?.suggest && (
        <div className="mem-fine warn">这里还没有可用的模型 —— 请先在「{modelsAt}」面板下载。</div>
      )}
      {fetchable > 0 && (
        <div className="mem-fine">还有 {fetchable} 个可以下载的模型,在「{modelsAt}」面板。</div>
      )}
    </div>
  );
}
