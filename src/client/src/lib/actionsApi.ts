// Thin client for the direct file-action endpoints (delete / rename / retitle).
import { post } from './apiClient';

export function deleteEntries(input: { paths?: string[]; dirs?: string[]; label?: string }) {
  return post<{ sha: string | null; removed: string[] }>('/api/fs/delete', input);
}

export function retitlePlan(path: string, title: string) {
  return post<{ sha: string }>('/api/fs/retitle', { path, title });
}

export function renamePlan(renames: Array<{ from: string; to: string }>, label?: string) {
  return post<{ sha: string }>('/api/fs/rename', { renames, label });
}
