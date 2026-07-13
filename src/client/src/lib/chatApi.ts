import type { AgentEvent, UploadedFile } from './chatTypes';
import { post } from './apiClient';

export async function startChat(
  message: string,
  attachments: UploadedFile[] = [],
  mode: 'plan' | 'system' = 'plan'
): Promise<{ id: string; phase: string }> {
  return post('/api/chat', {
    message,
    mode,
    // Send just the server-side references; the server validates each path is
    // inside the uploads dir before handing it to the agent.
    attachments: attachments.map((a) => a.relPath)
  });
}

/**
 * Upload attachment files (PDF / image) via multipart. Returns the server-side
 * references to pass back into `startChat`.
 */
export async function uploadFiles(files: File[]): Promise<UploadedFile[]> {
  const form = new FormData();
  for (const f of files) form.append('files', f);
  const res = await fetch('/api/uploads', { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `上传失败 (${res.status})`);
  }
  return (data as { files?: UploadedFile[] }).files ?? [];
}

export const approvePlan = (id: string) => post(`/api/chat/${id}/plan/approve`);
export const rejectPlan = (id: string) => post(`/api/chat/${id}/plan/reject`);
export const approveDiff = (id: string) => post(`/api/chat/${id}/diff/approve`);
export const rejectDiff = (id: string) => post(`/api/chat/${id}/diff/reject`);
export const cancelChat = (id: string) => post(`/api/chat/${id}/cancel`);

// Talk back at a gate: answer a question / add info (gate 1) or request
// adjustments to the changes (gate 2). The agent revises and returns to the gate.
export const refinePlan = (id: string, message: string) =>
  post(`/api/chat/${id}/plan/refine`, { message });
export const refineDiff = (id: string, message: string) =>
  post(`/api/chat/${id}/diff/refine`, { message });

/**
 * Subscribe to a session's event stream. Returns a close() fn.
 * Reconnects are handled by the browser's EventSource automatically; the server
 * replays buffered events on (re)connect so nothing is missed.
 */
export function openStream(
  id: string,
  onEvent: (ev: AgentEvent) => void,
  onError?: (e: Event) => void
): () => void {
  const es = new EventSource(`/api/chat/${id}/stream`);
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
