// Shared backend config — kept in its own module so both session.ts and the
// tool layer (tools.ts) can import it without a circular dependency.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root = three levels up from this file (backend/src → backend → viewer → repo).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The embedded "frontend claude" ALWAYS runs on Sonnet (latest) — planning chat,
// 系统模式 (frontend code work), the 智库 validator, build-repair, AND the
// Claude-backed tools. The `sonnet` alias tracks the newest Sonnet the CLI knows
// (currently Sonnet 4.6), so we auto-upgrade without pinning a dated id. Override
// with CHAT_MODEL (e.g. `opus`) for one session if you want a stronger model.
export const CHAT_MODEL = process.env.CHAT_MODEL ?? 'sonnet';
