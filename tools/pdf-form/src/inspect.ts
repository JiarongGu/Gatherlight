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
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup } from 'pdf-lib';

function fieldValue(f: unknown): string | null {
  try {
    if (f instanceof PDFTextField) return f.getText() ?? null;
    if (f instanceof PDFCheckBox) return f.isChecked() ? 'true' : 'false';
    if (f instanceof PDFDropdown || f instanceof PDFRadioGroup) return f.getSelected()?.join(',') ?? null;
  } catch {
    // ignore
  }
  return null;
}

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
    width: Math.round(p.getWidth()),
    height: Math.round(p.getHeight())
  }));
  const form = pdf.getForm();
  const fields = form.getFields().map((f) => ({
    name: f.getName(),
    type: f.constructor.name.replace(/^PDF/, ''),
    value: fieldValue(f)
  }));
  const t = pdf.getTitle();
  const a = pdf.getAuthor();
  const metadata: Record<string, string> = {};
  if (t) metadata.title = t;
  if (a) metadata.author = a;
  process.stdout.write(JSON.stringify({
    input,
    pageCount: pages.length,
    pages,
    hasForm: fields.length > 0,
    fieldCount: fields.length,
    fields,
    metadata
  }, null, 2) + '\n');
}

main().catch((err) => {
  console.error('inspect failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
