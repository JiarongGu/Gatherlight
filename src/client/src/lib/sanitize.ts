/**
 * Client-side XSS hardening for rendered content.
 *
 * Plan/household markdown and streamed LLM chat text are UNTRUSTED (prompt-injected
 * web content can steer the model into emitting HTML, and the agent itself can author
 * arbitrary markup — including, once approval cards land in this same transcript, a
 * forged one). The renderer enables raw HTML (`rehype-raw`) so the known `trip-map`/
 * `city-map` divs can become real map components, but everything else that comes
 * through raw HTML is now filtered by `rehype-sanitize` against an ALLOW-list
 * (`markdownSchema`, below): `rehype-sanitize`'s GitHub-derived `defaultSchema` plus
 * the exact `div` classes and `data-*` attributes the map components read, and the
 * `data-open` flag the collapsible day-section wrapper needs. Anything not explicitly
 * permitted is dropped, not merely the concrete dangerous constructs a deny-list
 * happened to enumerate.
 */

import { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';

// Elements that execute script, load external content, or restyle the page. Used only
// by `sanitizeHtml` below (the PDF-export path, a separate detached-DOM sanitizer over
// `marked()` output — not part of the react-markdown/rehype pipeline).
const DANGEROUS_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'style', 'link', 'meta', 'base',
  'form', 'frame', 'frameset', 'applet', 'noscript',
]);
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data):/i;
const DATA_IMAGE = /^\s*data:image\//i;

/**
 * `rehype-sanitize` schema for the chat/plan markdown pipeline — `defaultSchema`
 * (hast-util-sanitize's GitHub-derived allow-list: no `script`/`style`/`iframe`/on*
 * handlers/`javascript:`/`data:` URLs to begin with) extended with only:
 *  - `div.trip-map` / `div.city-map` (the classes `MarkdownView` dispatches to
 *    `TripMap`/`CityMap`) and the `data-*` attributes those components actually read
 *    (`data-cities`; `data-points`, `data-connect`, `data-title`).
 *  - `section[data-open]` — `remarkSectionizeH2` (in `MarkdownView.tsx`) synthesizes
 *    `<section data-open="…">` wrappers for collapsible day sections; without this the
 *    attribute is stripped and every section renders collapsed.
 *
 * hast-util-sanitize schema keys are hast property names (camelCase: `className` for
 * `class`, `dataCities` for `data-cities`), not literal HTML attribute strings. Each
 * per-tag array is a NEW array built from the default's (via spread) rather than a
 * mutation of it — `defaultSchema` is a shared module-level object, and separately,
 * `findDefinition` (hast-util-sanitize internals) returns the FIRST array entry whose
 * name matches a given property, so appending a second `['className', …]` entry after
 * one the default schema already defines for that tag would silently never be reached.
 * `div` and `section` have no pre-existing `className`/`dataOpen` entries respectively,
 * so plain appends here are safe; don't copy this pattern onto a tag that already has one.
 */
export const markdownSchema: SanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className', 'trip-map', 'city-map'],
      'dataCities',
      'dataPoints',
      'dataConnect',
      'dataTitle',
    ],
    section: [...(defaultSchema.attributes?.section ?? []), 'dataOpen'],
  },
};

/** Escape a string for safe interpolation into HTML text/attribute context. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/**
 * Sanitize an HTML string (e.g. `marked()` output for the PDF-export window) via a
 * detached DOM — browser-only. Deny-list policy (script-ish elements, `on*` handlers,
 * dangerous URL schemes); independent of the chat markdown pipeline's allow-list above
 * — this runs over trusted-shape `marked()` output for export, not raw agent HTML.
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
