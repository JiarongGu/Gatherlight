// Frontend mirror of the backend's event/review types. (We can't import the
// processors workspace package — it pulls in node:child_process.)

import type { UiNode } from '@/ui/blocks/registry';

export type Phase =
  | 'idle'
  | 'planning'
  | 'awaiting-plan-approval'
  | 'executing'
  | 'building'
  | 'validating'
  | 'awaiting-diff-approval'
  | 'awaiting-input'
  | 'awaiting-mcp-approval'
  | 'awaiting-login'
  | 'awaiting-draft-approval'
  | 'awaiting-capability-approval'
  | 'committing'
  | 'committed'
  | 'rejected'
  | 'cancelled'
  | 'error';

export interface AgentEvent {
  kind:
    | 'phase'
    | 'text'
    | 'text-delta'
    | 'ui-block'
    | 'thinking'
    | 'tool'
    | 'tool-result'
    | 'system'
    | 'notice'
    | 'error'
    | 'usage'
    | 'usage-live'
    | 'done';
  phase?: Phase;
  text?: string;
  tool?: { name: string; detail?: string };
  sessionId?: string;
  data?: unknown;
}

/**
 * One `ui-block` event. `partial` carries no payload — half a tree is not something to render —
 * and `invalid` carries the raw text so the user can see what could not be displayed.
 */
export interface UiBlockEvent {
  segment: number;
  status: 'partial' | 'ready' | 'invalid';
  node?: UiNode;
  raw?: string;
  reason?: string;
}

/**
 * A file the user attached to a chat turn. The frontend only ever holds this
 * server-returned reference — never a real filesystem path — and passes
 * `relPath` back so the backend can inject it into the agent prompt (the CLI's
 * Read tool ingests PDFs/images natively).
 */
export interface UploadedFile {
  name: string;
  relPath: string; // repo-relative path under the backend's uploads dir
  size: number; // bytes
  type: string; // MIME type
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  isClaudeInfra: boolean;
  diff: string;
}

export interface ClaudeValidation {
  ok: boolean;
  report: string;
}

export interface BuildResult {
  ok: boolean;
  output: string;
}

export interface ReviewPayload {
  files: DiffFile[];
  hasClaudeInfra: boolean;
  validation?: ClaudeValidation;
  build?: BuildResult;
}

/**
 * The concrete, secret-free spec shown at the awaiting-mcp-approval gate. Rendered by the server
 * from the agent's parsed proposal — the human confirms the exact command/url before anything
 * connects, and fills a value for each `neededCredentials` key (which never crosses the wire back).
 */
export interface McpProposalView {
  name: string;
  transport: string;
  command?: string | null;
  args: string[];
  url?: string | null;
  neededCredentials: string[];
}

/**
 * Shown in chat when the agent decided it needs to log into an MCP server (awaiting-login). The
 * client renders the QR / URL, polls the server's login status, and resumes the agent once done.
 */
export interface McpLoginView {
  serverId: string;
  serverName: string;
  kind: string;
  imageDataUri?: string | null;
  url?: string | null;
  text?: string | null;
  message: string;
}

/**
 * Shown at the awaiting-draft-approval gate: the assistant wrote a tool and wants it enabled.
 * `can`/`cannot` are rendered by the SERVER from its reading of the enforced grant — the
 * authoritative statement. `description` is the assistant's own words about what it built and
 * why; render it visibly as a claim, never merged into the same visual register as `can`/`cannot`.
 */
export interface DraftApprovalView {
  id: string;
  title: string;
  description: string;
  can: string[];
  cannot: string[];
  entrySource: string;
}

/**
 * Shown at the awaiting-capability-approval gate: a capability call was refused mid-run and the
 * agent is asking the human to widen (or confirm) its grant. `can`/`cannot` are the server's
 * reading of the enforced grant; `agentReason` is the assistant's own account of why it wants the
 * capability — never presented as if it carries the same authority as `can`/`cannot`.
 */
export interface CapabilityApprovalView {
  id: string;
  origin: string;
  state: string;
  can: string[];
  cannot: string[];
  agentReason: string;
}

export const PHASE_LABELS: Record<Phase, string> = {
  idle: '待命',
  planning: '调研拟定计划',
  'awaiting-plan-approval': '待批准计划',
  executing: '执行修改',
  building: '构建验证中',
  validating: '校验智库变更',
  'awaiting-diff-approval': '待审阅改动',
  'awaiting-input': '待你回复',
  'awaiting-mcp-approval': '待确认 MCP 服务',
  'awaiting-login': '待登录',
  'awaiting-draft-approval': '待批准新工具',
  'awaiting-capability-approval': '待处理权限请求',
  committing: '提交中',
  committed: '已提交',
  rejected: '已撤销',
  cancelled: '已停止',
  error: '出错'
};
