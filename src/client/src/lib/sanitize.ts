/**
 * Client-side XSS hardening for the ONE remaining path that turns a string into HTML.
 *
 * The markdown renderer is no longer such a path: `MarkdownView` runs react-markdown with no
 * raw-HTML stage, so raw HTML in plan/household documents and in streamed LLM text is
 * emitted as TEXT, never parsed. There is therefore no allow-list schema to keep correct —
 * untrusted markup simply cannot become markup. (Documents predating that change keep their
 * maps via the remark shim in `@/ui/blocks/legacyMaps`, which never touches HTML parsing.)
 *
 * What is left here guards the PDF-export window, which builds a document from `marked()`
 * output and hands it to a real parser — a different pipeline with a different policy.
 */

// Elements that execute script, load external content, or restyle the page. Used only
// by `sanitizeHtml` below (the PDF-export path, a detached-DOM sanitizer over `marked()`
// output — not part of the react-markdown pipeline).
const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base',
  'form', 'frame', 'frameset', 'applet', 'noscript',
]);
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data):/i;
const DATA_IMAGE = /^\s*data:image\//i;

/** Escape a string for safe interpolation into HTML text/attribute context. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * Sanitize an HTML string (e.g. `marked()` output for the PDF-export window) via a
 * detached DOM — browser-only. Deny-list policy (script-ish elements, `on*` handlers,
 * dangerous URL schemes); this runs over trusted-shape `marked()` output for export, which
 * the markdown renderer's no-raw-HTML rule does not cover.
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
