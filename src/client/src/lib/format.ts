/**
 * A count for display: thousands-separated, or an em-dash when we do not have the number yet.
 *
 * The em-dash is the point. A missing count and a count of zero mean opposite things — "not loaded"
 * versus "you have none" — and rendering both as `0` states the second when only the first is true.
 * This existed twice with two different answers (the console's overview showed the dash, the eval
 * panel did not) until they landed in separate modules and the difference became visible.
 */
export function formatCount(v?: number): string {
  return v === undefined ? '—' : v.toLocaleString();
}

/** Human file size: B / KB / MB. Empty string for 0 / undefined. */
export function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
