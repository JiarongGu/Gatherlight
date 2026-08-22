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
  { sources, boundSource, boundModel, busy, bind, modelsAt }:
  {
    sources: BackendView[];
    boundSource: string | null;
    boundModel: string | null;
    busy: string | null;
    bind: (source: string, model: string, endpoint?: string) => void;
    /** Panel name to point at when the fix is a download — passed in so this does not hard-code a
     *  sibling screen's title. */
    modelsAt: string;
  },
) {
  // DERIVED from the latest props, with an explicit pick layered on top — never seeded into state. A
  // useState initialiser runs once and this component is not remounted when the panel reloads, so a
  // household who started a daemon and watched their models appear would otherwise be left holding ''.
  const [pickedSource, setPickedSource] = useState<string | null>(null);
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  // Same derived-with-override rule: the saved address arrives with the data, so seeding a useState
  // initialiser from it would capture whatever the first render had (nothing).
  const [typedUrl, setTypedUrl] = useState<string | null>(null);

  // Prefer the bound backend, then the first BINDABLE one — never simply sources[0], which could be a
  // declined entry and would open on a backend it can never use.
  const source = sources.find((x) => x.id === (pickedSource ?? boundSource))
    ?? sources.find((x) => x.bindable) ?? sources[0];
  if (!source) return null;

  // Only what is ON THIS MACHINE can be bound. The rest of the list is what the provisioning panel could
  // fetch, and offering it here would be a control that fails on click.
  const usable = source.models.filter((m) => m.installed);
  const names = usable.map((m) => m.id);
  // First of: what they chose, what is saved, the first option — that still EXISTS. A pick or a saved
  // model since deleted must not survive as a value the <select> cannot show.
  const model = [pickedModel, boundModel, names[0]].find((n) => !!n && names.includes(n)) ?? '';
  const url = typedUrl ?? source.endpoint ?? '';
  const urlChanged = source.needsEndpoint && url !== (source.endpoint ?? '');
  // "Already in use" has to account for the address too: retyping a URL is a change even when the backend
  // and model are the same, and a 使用 button that read 使用中 would refuse to apply it.
  const unchanged = source.id === boundSource && model === boundModel && !urlChanged;
  const fetchable = source.models.filter((m) => !m.installed).length;

  return (
    <div className="mem-src">
      <span className="mem-src-lbl">运行于</span>
      {/* `available` rather than `disabled` on an unbindable backend: pressing it is how you read the
          reason it cannot be used. See Segmented's own comment — this is the case it exists for. */}
      <Segmented
        value={source.id}
        disabled={busy !== null}
        onSelect={(id) => { setPickedSource(id); setPickedModel(null); }}
        options={sources.map((x) => ({ value: x.id, label: x.name, available: x.bindable }))}
      />
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
          dead control wearing the colour that means "this does something" — and the rule this surface
          follows is that a disabled control saying nothing is a dead end. So when there is nothing to
          apply, the affordance goes away and a quiet label takes its place. */}
      {source.bindable && unchanged && <span className="mem-src-cur">使用中</span>}
      {source.bindable && !unchanged && (
        <PanelButton variant="primary"
          // A NEW address is bindable before its model list exists — that request is what fetches the list.
          // Requiring a model first would make the field impossible to submit.
          disabled={busy !== null || (source.needsEndpoint ? !url : (!model || !source.available))}
          onClick={() => bind(source.id, model, source.needsEndpoint ? url : undefined)}>
          {busy?.startsWith('bind:') ? '保存中…' : urlChanged && !model ? '连接' : '使用'}
        </PanelButton>
      )}
      {!source.bindable && <span className="mem-src-na">这一层用不了</span>}

      {/* WHOSE runtime, above the description. This is the question a household actually has — "do I have
          to install something?" — and the panel used to answer it only by accident, in a failure message:
          the provisioned Ollama was labelled 本机 · Ollama, which reads as theirs. */}
      {source.origin && (
        <div className={`mem-origin ${source.origin.kind}`}>{source.origin.text}</div>
      )}
      {source.bindable && <div className="mem-fine">{source.description}</div>}
      {/* WHY it cannot be used — outside the <select>, which is the whole point. An earlier version put
          this sentence in an <option>, so it could only render when there was something to select: the one
          case it existed to explain was the one case it could never appear in. */}
      {!source.available && source.reason && <div className="mem-fine warn">{source.reason}</div>}
      {/* …and where the fix is. Not a button: downloading belongs to the provisioning panel, and a second
          download control here would be the two-writers problem this arrangement exists to remove. */}
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
