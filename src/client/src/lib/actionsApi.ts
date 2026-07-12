// Thin client for the direct file-action endpoints (delete / rename / retitle).

async function post<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `请求失败 (${res.status})`);
  return data as T;
}

export function deleteEntries(input: { paths?: string[]; dirs?: string[]; label?: string }) {
  return post<{ sha: string | null; removed: string[] }>('/api/fs/delete', input);
}

export function retitlePlan(path: string, title: string) {
  return post<{ sha: string }>('/api/fs/retitle', { path, title });
}

export function renamePlan(renames: Array<{ from: string; to: string }>, label?: string) {
  return post<{ sha: string }>('/api/fs/rename', { renames, label });
}
