import express, { type Request, type Response } from 'express';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatController } from './session.ts';
import { REPO_ROOT } from './config.ts';
import { uploadMiddleware, toUploadedFile, resolveAttachment } from './uploads.ts';
import { runTool, listTools, ToolError } from './tools.ts';
import {
  deleteEntries,
  retitle,
  renameEntries,
  type AgentEvent
} from '@daily-planner/processors';

// Single process, single port: Express owns 5317 and serves BOTH the API and the
// frontend (Vite in middleware mode). Run via `tsx watch` → backend changes
// auto-restart; frontend changes hot-reload through Vite without a restart.
// 5317 (a scramble of Vite's 5173) avoids colliding with other Vite projects.
const PORT = Number(process.env.PORT ?? 5317);
const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend');
const controller = new ChatController();
const app = express();
app.use(express.json({ limit: '1mb' }));

// --- helpers ---------------------------------------------------------------

function sendError(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

function sessionView(id: string) {
  const s = controller.get(id);
  if (!s) return null;
  return {
    id: s.id,
    phase: s.phase,
    userMessage: s.userMessage,
    plan: s.planText || undefined,
    review: s.review,
    commitSha: s.commitSha,
    error: s.error
  };
}

// --- routes ----------------------------------------------------------------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, repoRoot: REPO_ROOT, busy: controller.isBusy() });
});

// Attachment upload (multipart) — save PDFs/images and return server-side refs
// the frontend passes back into /api/chat. The multer middleware surfaces its
// own errors (size / count / type) via the callback.
app.post('/api/upload', (req: Request, res: Response) => {
  uploadMiddleware(req, res, (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendError(res, 400, `上传失败:${msg}`);
    }
    const files = (Array.isArray(req.files) ? req.files : []).map(toUploadedFile);
    if (files.length === 0) return sendError(res, 400, '没有收到文件(仅支持 PDF / 图片)。');
    res.json({ files });
  });
});

// Gate 0 — start a task.
app.post('/api/chat', (req: Request, res: Response) => {
  const message = String(req.body?.message ?? '').trim();
  if (!message) return sendError(res, 400, 'message is required');
  const mode = req.body?.mode === 'system' ? 'system' : 'plan';

  // Validate each attachment ref is a real file inside the uploads dir before
  // it ever reaches the agent (guards against path-traversal in the ref).
  const rawAttachments: unknown = req.body?.attachments;
  let attachments: string[] = [];
  try {
    if (Array.isArray(rawAttachments)) {
      attachments = rawAttachments.map((p) => resolveAttachment(String(p)));
    }
  } catch (err: any) {
    return sendError(res, 400, err?.message ?? '附件校验失败');
  }

  try {
    const s = controller.startChat(message, mode, attachments);
    res.json({ id: s.id, phase: s.phase });
  } catch (err: any) {
    if (err?.message === 'BUSY') {
      return sendError(res, 409, '已有一个任务在进行中,请等它完成或撤销后再试。');
    }
    sendError(res, 500, err?.message ?? 'failed to start');
  }
});

// ---- Tools (unified registry — served over HTTP here + MCP in mcp-server) --
// One source of truth (tools.ts). The frontend calls tools over HTTP; the chat
// agent calls the SAME registry over MCP. Read-only, no approval gates / commit.
// The HTTP shape mirrors MCP: `tools/list` + `tools/call { name, arguments }`.

// tools/list — catalog (name + description + inputSchema) for discovery / UI.
app.get('/api/tools', (_req: Request, res: Response) => {
  res.json({ tools: listTools('http') });
});

// tools/call — invoke a tool by name with arguments. Synchronous (awaits result).
app.post('/api/tools/call', async (req: Request, res: Response) => {
  const name = String(req.body?.name ?? '').trim();
  const args =
    req.body?.arguments && typeof req.body.arguments === 'object'
      ? (req.body.arguments as Record<string, unknown>)
      : {};
  if (!name) return sendError(res, 400, 'name is required');

  // Abort the tool run only if the client disconnects BEFORE we finish responding.
  // (Listen on res, not req — req's 'close' can fire early once the body is read.)
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const result = await runTool(name, args, 'http', ac.signal);
    res.json({ ok: true, name, result });
  } catch (err: any) {
    if (res.headersSent) return;
    const status = err instanceof ToolError ? err.status : 500;
    sendError(res, status, err?.message ?? '工具执行失败');
  }
});

// Live event stream (SSE).
app.get('/api/stream/:id', (req: Request, res: Response) => {
  const id = req.params.id;
  if (!controller.get(id)) return sendError(res, 404, 'session not found');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 3000\n\n');

  const sink = (ev: AgentEvent) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };
  const unsubscribe = controller.subscribe(id, sink);

  // Heartbeat so proxies don't drop the idle connection.
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 15000);

  req.on('close', () => {
    clearInterval(beat);
    unsubscribe();
  });
});

// Snapshot of current state (used on (re)load to rehydrate the UI).
app.get('/api/session/:id', (req: Request, res: Response) => {
  const view = sessionView(req.params.id);
  if (!view) return sendError(res, 404, 'session not found');
  res.json(view);
});

// Gate 1.
app.post('/api/plan/approve/:id', async (req, res) => {
  try {
    res.json({ ok: true });
    await controller.approvePlan(req.params.id); // runs async; events stream via SSE
  } catch (err: any) {
    // response already sent in success path; only reached on sync throw
    if (!res.headersSent) sendError(res, 409, decodePhaseError(err));
  }
});

app.post('/api/plan/reject/:id', (req, res) => {
  try {
    controller.rejectPlan(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    sendError(res, 409, decodePhaseError(err));
  }
});

// Gate 1 refine — human answered a question / added info instead of approving.
app.post('/api/plan/refine/:id', async (req, res) => {
  const feedback = String(req.body?.message ?? '').trim();
  if (!feedback) return sendError(res, 400, 'message is required');
  const s = controller.get(req.params.id);
  if (!s) return sendError(res, 404, 'session not found');
  if (s.phase !== 'awaiting-plan-approval') {
    return sendError(res, 409, `当前状态(${s.phase})不允许该操作。`);
  }
  res.json({ ok: true });
  await controller.refinePlan(req.params.id, feedback); // runs async; events stream via SSE
});

// Gate 2.
app.post('/api/approve/:id', async (req, res) => {
  try {
    res.json({ ok: true });
    await controller.approveDiff(req.params.id);
  } catch (err: any) {
    if (!res.headersSent) sendError(res, 409, decodePhaseError(err));
  }
});

app.post('/api/reject/:id', async (req, res) => {
  try {
    res.json({ ok: true });
    await controller.rejectDiff(req.params.id);
  } catch (err: any) {
    if (!res.headersSent) sendError(res, 409, decodePhaseError(err));
  }
});

// Gate 2 refine — human asked for adjustments to the file changes before commit.
app.post('/api/refine/:id', async (req, res) => {
  const feedback = String(req.body?.message ?? '').trim();
  if (!feedback) return sendError(res, 400, 'message is required');
  const s = controller.get(req.params.id);
  if (!s) return sendError(res, 404, 'session not found');
  if (s.phase !== 'awaiting-diff-approval') {
    return sendError(res, 409, `当前状态(${s.phase})不允许该操作。`);
  }
  res.json({ ok: true });
  await controller.refineDiff(req.params.id, feedback); // runs async; events stream via SSE
});

// Force-stop — valid from any non-terminal phase.
app.post('/api/cancel/:id', async (req, res) => {
  try {
    await controller.cancel(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    sendError(res, err?.message === 'NOT_FOUND' ? 404 : 500, decodePhaseError(err));
  }
});

// ---- Direct file actions (delete / rename / retitle) ---------------------
// Mechanical, no AI. Serialized against chat tasks + each other so git stays
// consistent. Each commits on success; deleted content is recoverable from git.

let fsBusy = false;

async function runFsOp(res: Response, label: string, op: () => Promise<unknown>) {
  if (controller.isBusy()) {
    return sendError(res, 409, '有 AI 任务进行中,请等它完成后再操作。');
  }
  if (fsBusy) {
    return sendError(res, 409, '另一个操作正在进行,请稍候。');
  }
  fsBusy = true;
  try {
    const result = await op();
    res.json({ ok: true, ...(result as object) });
  } catch (err: any) {
    sendError(res, 500, `${label}失败:${err?.message ?? err}`);
  } finally {
    fsBusy = false;
  }
}

app.post('/api/fs/delete', (req, res) => {
  const { paths, dirs, label } = req.body ?? {};
  void runFsOp(res, '删除', () =>
    deleteEntries(REPO_ROOT, { paths, dirs }, `删除:${label ?? (paths?.[0] ?? dirs?.[0] ?? '')}`)
  );
});

app.post('/api/fs/retitle', (req, res) => {
  const { path: p, title } = req.body ?? {};
  if (!p || !title) return sendError(res, 400, 'path 和 title 必填');
  void runFsOp(res, '改标题', () => retitle(REPO_ROOT, p, title, `改标题:${title}`));
});

app.post('/api/fs/rename', (req, res) => {
  const { renames, label } = req.body ?? {};
  if (!Array.isArray(renames) || renames.length === 0) {
    return sendError(res, 400, 'renames 必填');
  }
  void runFsOp(res, '重命名', () => renameEntries(REPO_ROOT, renames, `重命名:${label ?? ''}`));
});

function decodePhaseError(err: any): string {
  const m = String(err?.message ?? '');
  if (m === 'NOT_FOUND') return 'session not found';
  if (m.startsWith('BAD_PHASE:')) return `当前状态(${m.slice(10)})不允许该操作。`;
  return m || 'operation failed';
}

async function start() {
  const httpServer = createHttpServer(app);

  // Mount Vite (dev) as middleware AFTER the /api routes above, so /api wins and
  // everything else (frontend + HMR) is served by Vite on the same server/port.
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: FRONTEND_ROOT,
    appType: 'spa',
    server: { middlewareMode: true, host: true, hmr: { server: httpServer } }
  });
  app.use(vite.middlewares);

  httpServer.listen(PORT, '0.0.0.0', () => {
    // stderr = logs (per repo convention); keep stdout clean.
    process.stderr.write(
      `[viewer] http://localhost:${PORT}  (frontend + /api, one process; repo: ${REPO_ROOT})\n`
    );
  });
}

void start();
