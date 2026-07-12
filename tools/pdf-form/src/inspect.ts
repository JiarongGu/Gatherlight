#!/usr/bin/env node
/**
 * Inspect a PDF — report page count, dimensions, AcroForm fields (if any).
 * Helps decide between AcroForm fill vs text-overlay approach for fill-itinerary.
 *
 * Usage:
 *   npx tsx src/inspect.ts <input.pdf>
 *
 * Output (stdout JSON):
 *   { pages: [{ width, height }], hasForm: bool, fields: [{ name, type, page, rect }] }
 */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: inspect <input.pdf>');
    process.exit(1);
  }
  const bytes = fs.readFileSync(input);
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdf.getPages().map((p, i) => ({
    index: i,
    width: p.getWidth(),
    height: p.getHeight()
  }));
  const form = pdf.getForm();
  const fields = form.getFields().map((f) => {
    const name = f.getName();
    const type = f.constructor.name;
    let widget: { page: number; x: number; y: number; w: number; h: number } | null = null;
    try {
      const w = (f as unknown as { acroField: { getWidgets: () => Array<{ getRectangle: () => { x: number; y: number; width: number; height: number }; P?: () => unknown }> } }).acroField.getWidgets();
      if (w[0]) {
        const r = w[0].getRectangle();
        widget = { page: -1, x: r.x, y: r.y, w: r.width, h: r.height };
      }
    } catch {
      // ignore
    }
    return { name, type, widget };
  });
  process.stdout.write(JSON.stringify({
    input,
    pages,
    hasForm: fields.length > 0,
    fieldCount: fields.length,
    fields
  }, null, 2) + '\n');
}

main().catch((err) => {
  console.error('inspect failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
