import { useState } from 'react';
import { Button as AntButton, Modal, Alert, Spin } from '@/ui/atoms';
import { CheckCircleOutlined, CloseCircleOutlined, MessageOutlined } from '@ant-design/icons';
import { get, post } from '@/lib/apiClient';
import type { UiNodeProps, UiNode } from './registry';
import { UiTree } from './UiTree';

/** What the SERVER says a capability may do — the confirmation's only source of clauses. */
interface CapabilityView {
  id: string;
  origin: string;
  state: string;
  description: string;
  can: string[];
  cannot: string[];
}

type RunState =
  | { kind: 'idle' }
  | { kind: 'confirming'; view: CapabilityView | null; error: string | null }
  | { kind: 'running' }
  | { kind: 'done'; node: UiNode | null; text: string | null }
  | { kind: 'failed'; message: string };

/**
 * A button's action is a container verb. `send` composes the user's next message and nothing more —
 * a button labelled "Approve" produces a message, not an approval, because every consequential step
 * still passes its own gate. `runCapability` is the one verb that runs code, and it runs only code a
 * human already approved: the page supplies an id, never the code.
 *
 * The label on that button is the AGENT'S words, so it is not what the person is agreeing to. The
 * confirmation below is rendered from `/api/ui/capability/{id}` — clauses the server derived from the
 * ENFORCED grant — and nothing from the page node reaches it. Cancelling closes the dialog and runs
 * nothing; the POST happens only in the Confirm handler.
 */
export function Button({ node, onSend, onOpenRecord }: UiNodeProps) {
  const action = (node.action ?? {}) as { send?: string; openRecord?: string; runCapability?: string };
  const capId = typeof action.runCapability === 'string' ? action.runCapability : undefined;
  const [run, setRun] = useState<RunState>({ kind: 'idle' });

  const openConfirm = async () => {
    if (!capId) return;
    setRun({ kind: 'confirming', view: null, error: null });
    try {
      setRun({ kind: 'confirming', view: await get<CapabilityView>(`/api/ui/capability/${encodeURIComponent(capId)}`), error: null });
    } catch (err) {
      // No clauses, no confirmation, no run — a capability we cannot describe is one we do not offer.
      setRun({ kind: 'confirming', view: null, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const confirmRun = async () => {
    if (!capId) return;
    setRun({ kind: 'running' });
    try {
      // /api/tools/call returns `result` as a STRING — the tool's own payload, usually JSON text.
      const res = await post<{ result?: string }>('/api/tools/call', { name: capId, arguments: {} });
      const raw = typeof res?.result === 'string' ? res.result : JSON.stringify(res?.result ?? null);
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      // A capability's output is data, not a trusted view. It reaches UiTree only if the SERVER's
      // validator says it is a tree — otherwise it is shown as text, which renders nothing.
      let node: UiNode | null = null;
      if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
        try {
          const verdict = await post<{ status: string; root?: UiNode }>('/api/ui/validate', parsed);
          if (verdict.status === 'ready' && verdict.root) node = verdict.root;
        } catch { /* fall through to text */ }
      }
      setRun({ kind: 'done', node, text: node ? null : formatResult(parsed === undefined ? raw : parsed) });
    } catch (err) {
      // A 4xx (a capability that is not enabled, or refused) carries the server's message — show it.
      setRun({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const click = () => {
    if (capId) void openConfirm();
    else if (typeof action.send === 'string') onSend?.(action.send);
    else if (typeof action.openRecord === 'string') onOpenRecord?.(action.openRecord);
  };

  const inert = capId === undefined
    && ((action.send === undefined && action.openRecord === undefined)
      || (action.send !== undefined && !onSend)
      || (action.openRecord !== undefined && !onOpenRecord));

  return (
    <div className={capId ? 'ui-cap-button' : undefined}>
      <AntButton size="small" onClick={click} disabled={inert} loading={run.kind === 'running'}>
        {String(node.label)}
      </AntButton>

      {capId && (
        <Modal
          open={run.kind === 'confirming'}
          title="运行前请确认 · Confirm before this runs"
          okText="运行 · Run"
          cancelText="取消 · Cancel"
          okButtonProps={{ disabled: run.kind === 'confirming' && !run.view }}
          onOk={confirmRun}
          onCancel={() => setRun({ kind: 'idle' })}
          destroyOnHidden
        >
          {run.kind === 'confirming' && run.error && (
            <Alert type="error" showIcon message="打不开这项能力 · Could not read this capability" description={run.error} />
          )}
          {run.kind === 'confirming' && !run.view && !run.error && <Spin />}
          {run.kind === 'confirming' && run.view && (
            <div>
              <div style={{ marginBottom: 6, fontSize: 12, opacity: 0.85 }}>
                能力:<code>{run.view.id}</code> · 来源:<code>{run.view.origin}</code> · 状态:
                <code>{run.view.state}</code>
              </div>
              {run.view.description && (
                <div className="grant-claim">
                  <div className="grant-claim-label"><MessageOutlined /> 这项能力自己的说明</div>
                  <div className="grant-claim-text">{run.view.description}</div>
                </div>
              )}
              <ClauseColumns can={run.view.can} cannot={run.view.cannot} />
            </div>
          )}
        </Modal>
      )}

      {run.kind === 'failed' && (
        <Alert style={{ marginTop: 8 }} type="warning" showIcon message="没有运行 · It did not run" description={run.message} />
      )}
      {run.kind === 'done' && run.node && <div style={{ marginTop: 8 }}><UiTree node={run.node} onOpenRecord={onOpenRecord} /></div>}
      {run.kind === 'done' && run.text !== null && <pre className="ui-cap-result">{run.text}</pre>}
    </div>
  );
}

/** The enforced grant, in two columns. Both empty is the honest answer for a built-in capability:
 *  it is compiled into the app rather than sandboxed against a grant, so there is no clause to show
 *  and none is invented. */
function ClauseColumns({ can, cannot }: { can: string[]; cannot: string[] }) {
  if (can.length === 0 && cannot.length === 0) {
    return (
      <div className="grant-clause-empty" style={{ marginTop: 8 }}>
        这是应用内置的能力,没有单独的沙箱授权可以展示。 · A built-in capability; there is no separate
        sandbox grant to show.
      </div>
    );
  }
  return (
    <div className="grant-clauses">
      <div className="grant-clause-col grant-can">
        <div className="grant-clause-title"><CheckCircleOutlined /> 系统允许</div>
        {can.length > 0 ? <ul>{can.map((c, i) => <li key={i}>{c}</li>)}</ul> : <div className="grant-clause-empty">(无)</div>}
      </div>
      <div className="grant-clause-col grant-cannot">
        <div className="grant-clause-title"><CloseCircleOutlined /> 系统禁止</div>
        {cannot.length > 0 ? <ul>{cannot.map((c, i) => <li key={i}>{c}</li>)}</ul> : <div className="grant-clause-empty">(无)</div>}
      </div>
    </div>
  );
}

function formatResult(result: unknown): string {
  if (result === undefined || result === null) return '(没有返回内容 · no output)';
  if (typeof result === 'string') return result;
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}
