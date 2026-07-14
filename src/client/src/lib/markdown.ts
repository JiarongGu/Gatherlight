export interface Heading {
  level: number;
  text: string;
  line: number; // 1-based source line — the stable anchor id is `h-${line}`
}

/**
 * Extract h1–h3 headings from raw markdown.
 * Skips lines inside fenced code blocks. The 1-based `line` matches the hast
 * node position MarkdownView uses for ids, so anchors line up deterministically
 * (no render-time counter → StrictMode-safe).
 */
export function extractHeadings(source: string): Heading[] {
  const out: Heading[] = [];
  let inFence = false;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) {
      out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
    }
  }
  return out;
}

/**
 * Remove the first H1 from the body — the document title is shown in the page
 * header, so rendering it again would double it. Strips the matched line plus
 * one trailing blank line. Use the result for BOTH rendering and TOC extraction
 * so heading-${i} ids stay aligned.
 */
export function stripFirstH1(source: string): string {
  return source.replace(/^#\s+.+\r?\n(?:\r?\n)?/m, '');
}

/**
 * Flatten inline markdown to clean plain text for PREVIEW contexts (library cards, list rows) —
 * strips emphasis / code / link syntax and leading list·heading·quote markers, keeps the visible
 * text + emoji, and collapses whitespace to one line. Deliberately cheap and forgiving, not a full
 * parser: authored fields (e.g. a library summary) often carry `**bold**` / `[label](url)` that
 * would otherwise render as literal punctuation in a one-line preview.
 */
export function toPlainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → label
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italic
    .replace(/~~(.*?)~~/g, '$2') // strikethrough
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '') // leading block markers
    .replace(/\s+/g, ' ') // collapse whitespace + newlines
    .trim();
}

export interface Snippet {
  text: string;
  matchStart: number;
  matchEnd: number;
}

/**
 * Find the first non-empty line containing the query, truncated to ~80 chars
 * around the match. Returns null if no match found.
 */
export function extractSnippet(content: string, query: string): Snippet | null {
  const q = query.toLowerCase();
  if (!q) return null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.toLowerCase().indexOf(q);
    if (idx === -1) continue;
    if (line.length > 80) {
      const start = Math.max(0, idx - 25);
      const end = Math.min(line.length, start + 80);
      const slice = line.slice(start, end);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < line.length ? '…' : '';
      const newIdx = idx - start + prefix.length;
      return {
        text: prefix + slice + suffix,
        matchStart: newIdx,
        matchEnd: newIdx + query.length
      };
    }
    return { text: line, matchStart: idx, matchEnd: idx + query.length };
  }
  return null;
}
