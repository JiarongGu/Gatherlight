import { Highlight } from '@/ui/atoms';
import type { Snippet } from '@/lib/markdown';

/**
 * A search-result snippet line with the matched span highlighted (delegates to the `Highlight` atom).
 * `className` styles the wrapper + its `<mark>` via CSS — Sidebar uses `.side-snippet`, the command
 * palette uses `.cmdk-snippet`.
 */
export function SnippetText({ snippet, className }: { snippet: Snippet; className?: string }) {
  return (
    <div className={className}>
      <Highlight text={snippet.text} start={snippet.matchStart} end={snippet.matchEnd} />
    </div>
  );
}
