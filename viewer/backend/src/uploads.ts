// File-attachment storage for the chat console.
//
// The frontend chat lets a family member attach PDFs / images to a turn (e.g. a
// visa form to fill, a booking confirmation to read). Those bytes have to land
// somewhere the *agent* can read them: the claude CLI runs with cwd = repo root
// and its Read tool ingests PDFs/images natively, so we save uploads INSIDE the
// repo (under a git-ignored dir) and hand the agent a repo-relative path.
//
// Flow:  frontend  --multipart-->  POST /api/upload  -->  { files: UploadedFile[] }
//        frontend  --relPath[]-->  POST /api/chat (attachments)  -->  agent Reads them
//
// Security: uploads are write-once here and validated on the way back in
// (`resolveAttachment`) so a crafted `attachments` value can't make the agent
// read an arbitrary file outside the uploads dir.

import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { REPO_ROOT } from './config.ts';

// Uploads live under the backend package, git-ignored (.uploads/ in .gitignore).
// Repo-relative so it matches the path the agent Reads (cwd = repo root).
export const UPLOADS_REL = 'viewer/backend/.uploads';
export const UPLOADS_DIR = path.join(REPO_ROOT, ...UPLOADS_REL.split('/'));

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB / file — comfortable for scanned PDFs
const MAX_FILES = 10; // per upload request

/** The server-side reference the frontend holds + passes back into /api/chat. */
export interface UploadedFile {
  name: string; // original (display) filename, UTF-8 decoded
  relPath: string; // repo-relative posix path under UPLOADS_REL
  size: number; // bytes
  type: string; // MIME type
}

// Minimal shape of a multer file — declared locally so we don't depend on the
// `Express.Multer.File` global (backend tsconfig uses `types: ["node"]`, which
// excludes @types/multer's ambient Express augmentation).
interface StoredFile {
  originalname: string;
  path: string;
  size: number;
  mimetype: string;
}

const toPosix = (p: string): string => p.split(path.sep).join('/');

/**
 * Multer / busboy hands `originalname` back as latin1 bytes; browsers send the
 * filename as UTF-8. Re-decode so Chinese / accented names display correctly.
 * (ASCII is a no-op — those bytes are identical under latin1 and utf8.)
 */
function decodeName(raw: string): string {
  return Buffer.from(raw, 'latin1').toString('utf8').normalize('NFC');
}

/** Make a display name safe to use as an on-disk filename (keeps the extension). */
function safeDiskName(name: string): string {
  const cleaned = name
    .replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_') // illegal / path chars
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '_'); // no leading dots (hidden / traversal)
  // Cap length but keep the tail so the extension survives.
  return (cleaned.length > 80 ? cleaned.slice(-80) : cleaned) || 'file';
}

function uniqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isAccepted(mimetype: string): boolean {
  return mimetype === 'application/pdf' || mimetype.startsWith('image/');
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    cb(null, `${uniqueId()}-${safeDiskName(decodeName(file.originalname))}`);
  }
});

/** Express middleware: parses `multipart/form-data` field `files` (up to MAX_FILES). */
export const uploadMiddleware = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (isAccepted(file.mimetype)) cb(null, true);
    else cb(new Error(`不支持的文件类型:${file.mimetype}(仅限 PDF / 图片)`));
  }
}).array('files', MAX_FILES);

/** Map a stored multer file to the reference the frontend keeps. */
export function toUploadedFile(file: StoredFile): UploadedFile {
  return {
    name: decodeName(file.originalname),
    relPath: toPosix(path.relative(REPO_ROOT, file.path)),
    size: file.size,
    type: file.mimetype
  };
}

/**
 * Validate an attachment reference coming back from the frontend and return the
 * canonical repo-relative posix path. Throws if the path escapes the uploads dir
 * or the file no longer exists — so `attachments` can never point the agent at an
 * arbitrary file.
 */
export function resolveAttachment(rawRelPath: string): string {
  const abs = path.resolve(REPO_ROOT, rawRelPath);
  const insideUploads = path.relative(UPLOADS_DIR, abs);
  if (insideUploads.startsWith('..') || path.isAbsolute(insideUploads)) {
    throw new Error(`附件路径非法(不在上传目录内):${rawRelPath}`);
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`附件不存在或已过期:${rawRelPath}`);
  }
  return toPosix(path.relative(REPO_ROOT, abs));
}
