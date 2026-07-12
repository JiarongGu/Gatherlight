// Shared types for the chat console pipeline.

export type Phase =
  | 'idle'
  | 'planning'
  | 'awaiting-plan-approval'
  | 'executing'
  | 'building'
  | 'validating'
  | 'awaiting-diff-approval'
  | 'committing'
  | 'committed'
  | 'rejected'
  | 'cancelled'
  | 'error';

/** A normalized event the runner emits and the backend forwards to the UI over SSE. */
export interface AgentEvent {
  kind:
    | 'phase' // phase transition
    | 'text' // a complete assistant text block
    | 'text-delta' // a streamed token chunk (partial)
    | 'thinking' // extended-thinking text
    | 'tool' // agent invoked a tool
    | 'tool-result' // a tool returned
    | 'system' // session init / metadata
    | 'notice' // human-facing status line from the harness
    | 'error'
    | 'done'; // terminal for the current run
  phase?: Phase;
  text?: string;
  tool?: { name: string; detail?: string };
  sessionId?: string;
  /** arbitrary structured payload (diff, validation report, commit sha, …) */
  data?: unknown;
}

export interface DiffFile {
  path: string; // repo-relative, posix
  status: 'added' | 'modified' | 'deleted';
  isClaudeInfra: boolean; // under .claude/ → needs extra review
  diff: string; // unified diff text
}

export interface BuildResult {
  ok: boolean;
  output: string;
}

export interface ReviewPayload {
  files: DiffFile[];
  hasClaudeInfra: boolean;
  validation?: ClaudeValidation; // present iff hasClaudeInfra
  build?: BuildResult; // present iff system mode (UI build gate)
}

export interface ClaudeValidation {
  ok: boolean;
  report: string;
}

export type EventSink = (event: AgentEvent) => void;
