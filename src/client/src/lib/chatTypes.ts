// Frontend mirror of the backend's event/review types. (We can't import the
// processors workspace package — it pulls in node:child_process.)

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
  committing: '提交中',
  committed: '已提交',
  rejected: '已撤销',
  cancelled: '已停止',
  error: '出错'
};
