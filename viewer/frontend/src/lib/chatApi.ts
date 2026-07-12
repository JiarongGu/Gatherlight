import type { AgentEvent, UploadedFile } from './chatTypes';

// All requests go through the Vite proxy (/api → backend on localhost:5174).

async function post<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `请求失败 (${res.status})`);
  }
  return data as T;
}

export async function startChat(
  message: string,
  mode: 'plan' | 'system' = 'plan',
  attachments: UploadedFile[] = []
): Promise<{ id: string; phase: string }> {
  return post('/api/chat', {
    message,
    mode,
    // Send just the server-side references; the backend validates each path is
    // inside the uploads dir before handing it to the agent.
    attachments: attachments.map((a) => a.relPath)
  });
}

/**
 * Upload attachment files (PDF / image) via multipart. Returns the server-side
 * references to pass back into `startChat`. Requires the backend `/api/upload`
 * endpoint — until that lands this rejects and the UI surfaces the error.
 */
export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `上传失败 (${res.status})`);
  }
  return (data as { files?: UploadedFile[] }).files ?? [];
}

export const approvePlan = (id: string) => post(`/api/plan/approve/${id}`);
export const rejectPlan = (id: string) => post(`/api/plan/reject/${id}`);
export const approveDiff = (id: string) => post(`/api/approve/${id}`);
export const rejectDiff = (id: string) => post(`/api/reject/${id}`);
export const cancelChat = (id: string) => post(`/api/cancel/${id}`);

// Talk back at a gate: answer a question / add info (gate 1) or request
// adjustments to the changes (gate 2). The agent revises and returns to the gate.
export const refinePlan = (id: string, message: string) =>
  post(`/api/plan/refine/${id}`, { message });
export const refineDiff = (id: string, message: string) =>
  post(`/api/refine/${id}`, { message });

/**
 * Subscribe to a session's event stream. Returns a close() fn.
 * Reconnects are handled by the browser's EventSource automatically; the backend
 * replays buffered events on (re)connect so nothing is missed.
 */
export function openStream(
  id: string,
  onEvent: (ev: AgentEvent) => void,
  onError?: (e: Event) => void
): () => void {
  const es = new EventSource(`/api/stream/${id}`);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as AgentEvent);
    } catch {
      /* ignore malformed frame */
    }
  };
  if (onError) es.onerror = onError;
  return () => es.close();
}
