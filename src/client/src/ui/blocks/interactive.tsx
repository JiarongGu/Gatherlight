import { Button as AntButton } from '@/ui/atoms';
import type { UiNodeProps } from './registry';

/**
 * A button's action is a container verb. `send` composes the user's next message and nothing more —
 * a button labelled "Approve" produces a message, not an approval, because every consequential step
 * still passes its own gate.
 */
export function Button({ node, onSend, onOpenRecord }: UiNodeProps) {
  const action = (node.action ?? {}) as { send?: string; openRecord?: string };
  const click = () => {
    if (typeof action.send === 'string') onSend?.(action.send);
    else if (typeof action.openRecord === 'string') onOpenRecord?.(action.openRecord);
  };
  const inert = (action.send === undefined && action.openRecord === undefined)
    || (action.send !== undefined && !onSend)
    || (action.openRecord !== undefined && !onOpenRecord);
  return <AntButton size="small" onClick={click} disabled={inert}>{String(node.label)}</AntButton>;
}
