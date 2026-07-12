// Tracks recently-viewed file paths in localStorage (newest first).

const KEY = 'viewer-recent';
const MAX = 8;

export function getRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? (arr.filter((x) => typeof x === 'string') as string[]) : [];
  } catch {
    return [];
  }
}

export function pushRecent(path: string): void {
  try {
    const next = [path, ...getRecent().filter((p) => p !== path)].slice(0, MAX);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* localStorage unavailable — ignore */
  }
}
