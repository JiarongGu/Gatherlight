/**
 * Every remote image the app renders goes through our own origin.
 *
 * The point is not that proxying makes an arbitrary URL safe to fetch — the server still fetches it,
 * behind the SSRF guard, the content-type check and the size cap that `ImageCache` has always
 * applied to library covers. The point is that the HOUSEHOLD'S BROWSER never calls a host chosen by
 * something they are merely reading. With `img-src https:` an image URL in a page or a plan leaked
 * their IP and the fact they had opened it, on render, with no record anywhere; that is what let the
 * CSP tighten to `img-src 'self' data: blob:`.
 *
 * Anything that is not http(s) — a data: URI, a same-origin path, an already-proxied URL — is passed
 * through untouched.
 */
export function remoteImage(src?: string | null): string {
  if (!src) return '';
  return /^https?:\/\//i.test(src) ? `/api/img?url=${encodeURIComponent(src)}` : src;
}
