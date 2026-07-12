# viewer/ — family planner viewer + chat console

npm-workspaces monorepo with three packages:

| Package | What it is |
|---|---|
| [`frontend/`](frontend/README.md) | The React+Vite plan browser. Hosts the **Claude 助手** chat drawer, 系统模式 (UI self-iteration), and direct ⋯ actions. |
| `backend/` | Express server: serves `/api` (the two-gate chat flow + file actions) AND the frontend (Vite middleware) — **one process on port 5317**. |
| `processors/` | Library the backend uses: spawns the local `claude` CLI, tracks edits, runs the git flow, build-verify, validation. |

## Run

```bash
cd viewer
npm install          # installs all three workspaces
npm run dev          # ONE process on :5317 — frontend (HMR) + /api together
```

Open `http://localhost:5317` (or the LAN IP) on any device. Express owns the port
and mounts Vite in middleware mode, so the frontend and `/api` share one origin —
no proxy, no second port. Run via `tsx watch`: frontend edits hot-reload, backend
edits auto-restart the process. The chat lives behind the 🤖 button.

## How the chat works (two human gates)

```
你输入需求
  → Claude 按 CLAUDE.md gate 调研 + 拟计划   (read-only)
  → [Gate 1] 你批准计划
  → Claude 改 plans/ household/ .claude/ 文件   (acceptEdits + 范围限制 hook)
  → 智库(.claude/)变更额外跑一次自动校验
  → [Gate 2] 你审 git diff → 批准
  → 后端自动 commit(只提交 Claude 改动的文件)
```

Reject at either gate aborts cleanly — Gate 1 reject writes nothing; Gate 2
reject restores the touched files to HEAD.

### Safety model

- Runs the **already-logged-in local `claude` CLI** (subscription auth, no API key).
- An isolated [`processors/settings.chat.json`](processors/settings.chat.json) pre-grants
  permissions (so the headless run never stalls) and registers a `PreToolUse`
  **scope guard** ([`processors/scope-guard.mjs`](processors/scope-guard.mjs)) that hard-denies:
  - edits outside `plans/`, `household/`, `.claude/`
  - `git commit/add/push/reset/...` and destructive shell (the backend owns commits)
- Only **one task runs at a time** (a second `/api/chat` returns 409) — concurrent
  edits would corrupt the shared git working tree.

## Notes / follow-ups

- The chat endpoint is **LAN-trusted** (no auth), like the rest of the viewer.
- Chat history is in-memory (lost on backend restart).
- Each fresh chat re-primes the CLAUDE.md context cache (~50k tokens) — cost is
  on the subscription.
