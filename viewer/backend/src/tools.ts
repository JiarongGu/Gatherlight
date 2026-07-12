// Unified backend TOOL registry — the single source of truth for the app's
// callable capabilities, MCP-shaped so it can be served over BOTH surfaces from
// one definition:
//   • HTTP  — the frontend calls  GET /api/tools  +  POST /api/tools/call
//   • MCP   — the chat agent (local claude CLI) calls them mid-conversation via
//             the stdio server in mcp-server.ts
//
// Add a capability = add ONE entry to `REGISTRY`. It instantly appears on both
// surfaces (unless it opts out via `surfaces`). The backend owns this file, so
// the backend decides when a new tool exists and where it's exposed.
//
// A tool's `handler` is fully pluggable — it may call a one-shot read-only Claude
// (the reference `extract` below), shell out to / import a tools/<name> utility
// (pdf-form, puppeteer, …), or be pure Node.

import path from 'node:path';
import { runClaude, processFilePrompt } from '@daily-planner/processors';
import { REPO_ROOT, CHAT_MODEL } from './config.ts';
import { resolveAttachment } from './uploads.ts';

/** MCP server name — tool call names the CLI sees are `mcp__<this>__<toolName>`. */
export const MCP_SERVER_NAME = 'planner-tools';

const TOOL_TIMEOUT_MS = 120_000; // hard cap so a stuck tool can't hang the caller

/** Which surfaces a tool is exposed on. Defaults to both when a tool omits it. */
export type ToolSurface = 'http' | 'mcp';
const ALL_SURFACES: ToolSurface[] = ['http', 'mcp'];

/** Error carrying an HTTP status the route maps straight through. */
export class ToolError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Minimal JSON Schema for a tool's arguments (what MCP `inputSchema` expects). */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolContext {
  signal: AbortSignal; // aborts on timeout / caller disconnect
  repoRoot: string;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  surfaces?: ToolSurface[]; // where it's exposed; omit = both
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>; // returns result text
}

// --- helpers ---------------------------------------------------------------

/** Resolve + validate an uploaded-file argument. Throws ToolError(400) if bad. */
function requireUploadedFile(
  args: Record<string, unknown>,
  key = 'relPath'
): { relPath: string; absPath: string } {
  const raw = args[key];
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ToolError(400, `参数 "${key}" 必填,且应为上传文件的路径。`);
  }
  let relPath: string;
  try {
    relPath = resolveAttachment(raw); // inside uploads dir + exists, or throws
  } catch (err: any) {
    throw new ToolError(400, err?.message ?? '附件校验失败');
  }
  return { relPath, absPath: path.join(REPO_ROOT, ...relPath.split('/')) };
}

// --- Reference tool: Claude-backed `extract` -------------------------------
// A one-shot, read-only Claude pass over an uploaded file. Copy this shape for
// other Claude-backed tools; deterministic tools set `run` to call tools/<name>.
const extract: Tool = {
  name: 'extract',
  description:
    '读取上传的文件(PDF/图片),按指令提取或总结内容,返回文本结果(默认:结构化关键信息摘要)。只读,不修改任何文件。',
  inputSchema: {
    type: 'object',
    properties: {
      relPath: {
        type: 'string',
        description: '上传文件的引用(来自 /api/upload,位于 viewer/backend/.uploads/ 下)'
      },
      instruction: {
        type: 'string',
        description: '要提取或执行的内容;省略则输出该文件的结构化关键信息摘要'
      }
    },
    required: ['relPath'],
    additionalProperties: false
  },
  async run(args, ctx) {
    const { relPath } = requireUploadedFile(args);
    const instruction =
      (typeof args.instruction === 'string' && args.instruction.trim()) ||
      '读取该文件,提取其中的关键信息,整理成简洁清晰的结构化摘要(用简体中文)。';
    const res = await runClaude({
      prompt: processFilePrompt(relPath, instruction),
      repoRoot: REPO_ROOT,
      readOnly: true,
      model: CHAT_MODEL,
      signal: ctx.signal,
      onEvent: () => {} // sync caller: only the final text matters
    });
    const out = (res.finalText ?? '').trim();
    if (!out) throw new Error('处理没有产出内容(文件可能无法读取或为空)。');
    return out;
  }
};

// --- Registry --------------------------------------------------------------
// The one source of truth. Add tools here.
const REGISTRY: Tool[] = [
  extract
  // e.g. later (deterministic, tool-backed):
  //   { name: 'visa-itinerary', surfaces: ['http'], run: (a) => fillItinerary(...) }
  //   { name: 'pdf-text',       run: (a) => extractPdfText(...) }
];

const byName = new Map(REGISTRY.map((t) => [t.name, t]));
const surfacesOf = (t: Tool): ToolSurface[] => t.surfaces ?? ALL_SURFACES;

/** Public tool definitions (name + description + inputSchema) for a surface. */
export function listTools(surface?: ToolSurface): {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}[] {
  return REGISTRY.filter((t) => !surface || surfacesOf(t).includes(surface)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema
  }));
}

/** Fully-qualified MCP tool names to pre-approve on the chat runs (--allowedTools). */
export function mcpAllowedToolNames(): string[] {
  return REGISTRY.filter((t) => surfacesOf(t).includes('mcp')).map(
    (t) => `mcp__${MCP_SERVER_NAME}__${t.name}`
  );
}

/** Minimal required-field check against the tool's inputSchema. */
function validateArgs(schema: JsonSchema, args: Record<string, unknown>): void {
  for (const key of schema.required ?? []) {
    const v = args[key];
    if (v === undefined || v === null || v === '') {
      throw new ToolError(400, `缺少必填参数:"${key}"。`);
    }
  }
}

/**
 * Run one tool by name. Shared by BOTH adapters (HTTP route + MCP server) so the
 * validation, timeout, and error semantics are identical wherever a tool is
 * called. `surface` (when given) enforces the tool is exposed there.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  surface?: ToolSurface,
  externalSignal?: AbortSignal
): Promise<string> {
  const tool = byName.get(name);
  if (!tool) {
    const known = REGISTRY.map((t) => t.name).join(', ') || '(无)';
    throw new ToolError(400, `未知工具:"${name}"。可用:${known}`);
  }
  if (surface && !surfacesOf(tool).includes(surface)) {
    throw new ToolError(404, `工具 "${name}" 未在 ${surface} 接口暴露。`);
  }
  const safeArgs = args ?? {};
  validateArgs(tool.inputSchema, safeArgs);

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  const timer = setTimeout(() => ac.abort(), TOOL_TIMEOUT_MS);
  if (externalSignal) {
    if (externalSignal.aborted) ac.abort();
    else externalSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await tool.run(safeArgs, { signal: ac.signal, repoRoot: REPO_ROOT });
  } catch (err: any) {
    if (err instanceof ToolError) throw err;
    if (ac.signal.aborted) throw new ToolError(504, '工具执行超时或被中断。');
    throw new ToolError(500, `工具执行失败:${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}
