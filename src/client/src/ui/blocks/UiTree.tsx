import { memo } from 'react';
import { RENDERERS, type UiNode } from './registry';

interface Props {
  node: UiNode;
  onSend?: (text: string) => void;
  onOpenRecord?: (path: string) => void;
}

/**
 * Renders a tree the SERVER already validated — every node here has a schema behind it. The unknown
 * branch exists only for the case where the client is older than the server (a component shipped in
 * the schema but not yet in this bundle), which `check-ui-registry` is meant to prevent.
 */
export const UiTree = memo(function UiTree({ node, onSend, onOpenRecord }: Props) {
  const Renderer = RENDERERS[node.type];
  if (!Renderer) {
    return <div className="ui-unknown">此版本暂不支持的组件 · Unsupported component: {node.type}</div>;
  }
  const children = node.children?.length
    ? node.children.map((c, i) => <UiTree key={i} node={c} onSend={onSend} onOpenRecord={onOpenRecord} />)
    : undefined;
  return <Renderer node={node} onSend={onSend} onOpenRecord={onOpenRecord}>{children}</Renderer>;
});
