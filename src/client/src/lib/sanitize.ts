/**
 * Client-side XSS hardening for rendered content.
 *
 * Plan/household markdown and streamed LLM chat text are UNTRUSTED (prompt-injected
 * web content can steer the model into emitting HTML). The renderer enables raw HTML
 * (`rehype-raw`) and relies on custom `trip-map`/`city-map` divs + position-based
 * heading anchors, so a full allow-list sanitizer (rehype-sanitize) would rebuild the
 * tree and drop those. Instead we strip the concrete dangerous subset — script-ish
 * elements, `on*` event handlers, and `javascript:`/`vbscript:`/`data:` (non-image)
 * URLs — while leaving legitimate structure untouched.
 */

// Elements that execute script, load external content, or restyle the page.
const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base',
  'form', 'frame', 'frameset', 'applet', 'noscript',
]);
// Attributes that carry a URL — checked for dangerous schemes. `xlinkHref` is hast's
// camelCase form of SVG `xlink:href`.
const URL_ATTRS = ['href', 'src', 'srcSet', 'srcset', 'xlinkHref', 'poster', 'action', 'formAction', 'formaction', 'background', 'data'];
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data):/i;
const DATA_IMAGE = /^\s*data:image\//i;

function scrubProps(props: Record<string, unknown>): void {
  for (const key of Object.keys(props)) {
    if (/^on/i.test(key)) { delete props[key]; continue; }        // event handlers
    if (URL_ATTRS.includes(key)) {
      const v = props[key];
      if (typeof v === 'string' && DANGEROUS_URL.test(v)) {
        // Permit inline data:image/... only on an <img>-style src (harmless raster).
        if (!((key === 'src' || key === 'srcSet' || key === 'srcset') && DATA_IMAGE.test(v))) delete props[key];
      }
    }
  }
}

/**
 * react-markdown rehype plugin — run it AFTER `rehypeRaw` so raw HTML is already
 * parsed into element nodes. Walks the hast tree, removing dangerous elements and
 * neutralizing dangerous attributes in place (preserving position/className/data-*).
 */
export function rehypeStripDangerous() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tree: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (node: any) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = node.children.length - 1; i >= 0; i--) {
        const child = node.children[i];
        if (child?.type === 'element' && typeof child.tagName === 'string'
            && DANGEROUS_TAGS.has(child.tagName.toLowerCase())) {
          node.children.splice(i, 1);
          continue;
        }
        if (child?.type === 'element' && child.properties) scrubProps(child.properties);
        walk(child);
      }
    };
    walk(tree);
  };
}

/** Escape a string for safe interpolation into HTML text/attribute context. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * Sanitize an HTML string (e.g. `marked()` output for the PDF-export window) via a
 * detached DOM — browser-only. Same dangerous-subset policy as the rehype plugin.
 */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll([...DANGEROUS_TAGS].join(',')).forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (/^on/.test(name)) { el.removeAttribute(attr.name); continue; }
      if ((name === 'href' || name === 'src' || name === 'srcset' || name === 'xlink:href'
           || name === 'poster' || name === 'action' || name === 'formaction')
          && DANGEROUS_URL.test(attr.value)
          && !(name === 'src' && DATA_IMAGE.test(attr.value))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

/**
 * Return `url` only if it's a relative/anchor link or an explicit safe scheme
 * (http/https/mailto); otherwise undefined. Blocks `javascript:`/`data:` hrefs from
 * agent-authored DB values used as `<a href>`.
 */
export function safeUrl(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const t = url.trim();
  if (!t) return undefined;
  const scheme = t.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return url;                          // relative path or #anchor
  return /^(?:https?|mailto)$/i.test(scheme[1]) ? url : undefined;
}
