#!/usr/bin/env node
// e2e P10 — general document/media processing: pdf_inspect / pdf_extract_text / pdf_fill /
// pdf_merge (PdfPig + PDFsharp) and image_info / image_resize / image_convert (ImageSharp).
// Fixtures: a form PDF built with pdf-lib (from tools/pdf-form), a BMP built by hand.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataDir = path.join(repo, 'devtools', '_e2e-p10-data');
const PORT = 5390;
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !extra ? '' : ` — ${extra}`}`);
  if (!cond) failures++;
};

spawnSync('node', [path.join(repo, 'devtools', 'scripts', 'make-test-data.mjs'), dataDir], { stdio: 'inherit' });
const up = path.join(dataDir, 'uploads');
fs.mkdirSync(up, { recursive: true });

// --- fixture PDF: one text field "applicant" + drawn text (pdf-lib from tools/pdf-form) --------
const pdfGen = `
const { PDFDocument } = require('pdf-lib');
(async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([320, 200]);
  page.drawText('GATHERLIGHT PDF FIXTURE TEXT', { x: 20, y: 150, size: 12 });
  const tf = doc.getForm().createTextField('applicant');
  tf.addToPage(page, { x: 20, y: 100, width: 220, height: 20 });
  require('fs').writeFileSync(process.argv[1], Buffer.from(await doc.save()));
})();`;
const pdfPath = path.join(up, 'form.pdf');
const gen = spawnSync('node', ['-e', pdfGen, pdfPath], { cwd: path.join(repo, 'tools', 'pdf-form'), encoding: 'utf8' });
if (!fs.existsSync(pdfPath)) {
  console.error('fixture PDF generation failed:', gen.stderr || gen.stdout);
  process.exit(1);
}

// --- fixture image: an 8x8 24-bit BMP built by hand (no dependency) ----------------------------
function bmp(w, h) {
  const rowSize = Math.floor((24 * w + 31) / 32) * 4;
  const buf = Buffer.alloc(54 + rowSize * h);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  let off = 54;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) { buf[off++] = x * 30; buf[off++] = y * 30; buf[off++] = 128; }
    off += rowSize - w * 3;
  }
  return buf;
}
fs.writeFileSync(path.join(up, 'pic.bmp'), bmp(8, 8));

const server = spawn('dotnet', ['run', '--project', 'src/server/Gatherlight.Server', '--no-build'], {
  cwd: repo,
  env: { ...process.env, GATHERLIGHT_DATA: dataDir, GATHERLIGHT_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fn(); if (r) return r; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 300));
  }
};
const call = async (name, args) => {
  const res = await fetch(`${base}/api/tools/call`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, result: body?.result ? JSON.parse(body.result) : body };
};
const onDisk = (rel) => fs.existsSync(path.join(dataDir, rel));

try {
  await until(() => fetch(`${base}/api/health`).then((r) => r.ok));

  // --- PDF ---
  const inspect = await call('pdf_inspect', { path: 'uploads/form.pdf' });
  ok('pdf_inspect: 1 page', inspect.status === 200 && inspect.result.pageCount === 1);
  ok('pdf_inspect: finds "applicant" field', inspect.result.fields.some((f) => f.name === 'applicant'), JSON.stringify(inspect.result.fields));

  const text = await call('pdf_extract_text', { path: 'uploads/form.pdf' });
  ok('pdf_extract_text: recovers drawn text', text.result.text.includes('GATHERLIGHT PDF FIXTURE TEXT'), text.result.text?.slice(0, 60));

  // Fill (not flattened) so the field value round-trips through pdf_inspect.
  const fill = await call('pdf_fill', {
    templatePath: 'uploads/form.pdf', values: { applicant: 'Test Name' }, outPath: 'uploads/filled.pdf',
  });
  ok('pdf_fill: set applicant', fill.status === 200 && fill.result.fieldsSet.includes('applicant'));
  ok('pdf_fill: wrote output', onDisk('uploads/filled.pdf'));
  const reinspect = await call('pdf_inspect', { path: 'uploads/filled.pdf' });
  ok('pdf_fill: value round-trips', reinspect.result.fields?.find((f) => f.name === 'applicant')?.value === 'Test Name',
    reinspect.result.fields?.find((f) => f.name === 'applicant')?.value);

  // Flatten path: field baked into page content, no longer a form field.
  const flat = await call('pdf_fill', {
    templatePath: 'uploads/form.pdf', values: { applicant: 'Baked In' }, outPath: 'uploads/flat.pdf', flatten: true,
  });
  ok('pdf_fill: flatten removes the field', flat.status === 200
    && (await call('pdf_inspect', { path: 'uploads/flat.pdf' })).result.fields.length === 0);

  const merge = await call('pdf_merge', { paths: ['uploads/form.pdf', 'uploads/filled.pdf'], outPath: 'uploads/merged.pdf' });
  ok('pdf_merge: 2 pages', merge.status === 200 && merge.result?.pages === 2 && onDisk('uploads/merged.pdf'),
    JSON.stringify(merge.result));

  // --- image ---
  const iinfo = await call('image_info', { path: 'uploads/pic.bmp' });
  ok('image_info: 8x8 bmp', iinfo.result.width === 8 && iinfo.result.height === 8, JSON.stringify(iinfo.result));

  const resize = await call('image_resize', { path: 'uploads/pic.bmp', outPath: 'uploads/small.png', maxWidth: 4, maxHeight: 4 });
  ok('image_resize: fits box', resize.result.width <= 4 && resize.result.height <= 4 && onDisk('uploads/small.png'));

  const conv = await call('image_convert', { path: 'uploads/pic.bmp', outPath: 'uploads/pic.webp', format: 'webp' });
  ok('image_convert: webp written', conv.status === 200 && onDisk('uploads/pic.webp'));
  const webpInfo = await call('image_info', { path: 'uploads/pic.webp' });
  ok('converted webp is valid', webpInfo.result.format?.toLowerCase().includes('webp'), JSON.stringify(webpInfo.result));

  // --- registered on both surfaces ---
  const tools = (await (await fetch(`${base}/api/tools`)).json()).tools.map((t) => t.name);
  const docTools = ['pdf_inspect', 'pdf_extract_text', 'pdf_fill', 'pdf_merge', 'image_info', 'image_resize', 'image_convert'];
  ok('all document tools registered', docTools.every((n) => tools.includes(n)), docTools.filter((n) => !tools.includes(n)).join(','));

  // --- guard ---
  const bad = await call('pdf_inspect', { path: '../CLAUDE.md' });
  ok('traversal guarded', bad.status >= 400);
} catch (err) {
  console.error('e2e-p10 fatal:', err.message);
  console.error(serverLog.slice(-3000));
  failures++;
} finally {
  server.kill();
}

console.log(failures === 0 ? '\ne2e-p10 PASS' : `\ne2e-p10 FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
