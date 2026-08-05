import { Card as AntCard, Divider as AntDivider } from '@/ui/atoms';
import type { UiNodeProps } from './registry';

const GAP: Record<string, number> = { none: 0, sm: 8, md: 16, lg: 24 };
const gapOf = (node: UiNodeProps['node']) => GAP[String(node.gap ?? 'md')] ?? 16;

export function Stack({ node, children }: UiNodeProps) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: gapOf(node) }}>{children}</div>;
}

export function Row({ node, children }: UiNodeProps) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'row',
      gap: gapOf(node),
      alignItems: String(node.align ?? 'start') === 'start' ? 'flex-start' : String(node.align),
      flexWrap: node.wrap ? 'wrap' : 'nowrap',
    }}>{children}</div>
  );
}

export function Card({ node, children }: UiNodeProps) {
  return (
    <AntCard size="small" title={node.title as string | undefined} className="ui-card">
      {node.subtitle ? <div className="ui-card-subtitle">{node.subtitle as string}</div> : null}
      {children}
    </AntCard>
  );
}

export function Divider() {
  return <AntDivider style={{ margin: '8px 0' }} />;
}
