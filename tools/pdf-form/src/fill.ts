#!/usr/bin/env node
/**
 * General AcroForm filler — fills ANY fillable PDF from a {fieldName: value} JSON map.
 * pdf-lib does form-filling reliably (incl. CJK via fontkit) where PDFsharp's appearance
 * generation is fragile, so the C# pdf_fill tool shells out to this.
 *
 * Usage:
 *   npx tsx src/fill.ts --in <template.pdf> --data <values.json> --out <filled.pdf> [--flatten] [--font <path.ttf>]
 *
 * values.json: a flat object of string→string (checkbox values: "true"/"false").
 * stdout = JSON report { ok, fieldsSet, missing }. stderr = logs.
 */
import fs from 'node:fs';
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

function parseArgs(argv: string[]) {
  const a: { in?: string; data?: string; out?: string; flatten?: boolean; font?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--in') a.in = argv[++i];
    else if (f === '--data') a.data = argv[++i];
    else if (f === '--out') a.out = argv[++i];
    else if (f === '--flatten') a.flatten = true;
    else if (f === '--font') a.font = argv[++i];
  }
  if (!a.in || !a.data || !a.out) {
    console.error('Usage: fill --in <template.pdf> --data <values.json> --out <filled.pdf> [--flatten] [--font <ttf>]');
    process.exit(1);
  }
  return a as Required<Pick<typeof a, 'in' | 'data' | 'out'>> & typeof a;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'checked']);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const values: Record<string, string> = JSON.parse(fs.readFileSync(args.data, 'utf8'));

  const pdf = await PDFDocument.load(fs.readFileSync(args.in), { ignoreEncryption: true });
  pdf.registerFontkit(fontkit);
  let customFont;
  if (args.font) customFont = await pdf.embedFont(fs.readFileSync(args.font), { subset: true });

  const form = pdf.getForm();
  const known = new Set(form.getFields().map((f) => f.getName()));
  const fieldsSet: string[] = [];
  const missing: string[] = [];

  for (const [name, raw] of Object.entries(values)) {
    if (!known.has(name)) { missing.push(name); continue; }
    const field = form.getField(name);
    const value = String(raw);
    try {
      if (field instanceof PDFTextField) {
        field.setText(value);
        if (customFont) field.updateAppearances(customFont);
      } else if (field instanceof PDFCheckBox) {
        TRUTHY.has(value.toLowerCase()) ? field.check() : field.uncheck();
      } else if (field instanceof PDFDropdown) {
        field.select(value);
      } else if (field instanceof PDFRadioGroup) {
        field.select(value);
      } else {
        missing.push(name);
        continue;
      }
      fieldsSet.push(name);
    } catch (err) {
      process.stderr.write(`[pdf-form] warn: ${name} -> ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  if (args.flatten) form.flatten();

  fs.writeFileSync(args.out, await pdf.save());
  process.stdout.write(JSON.stringify({ ok: true, fieldsSet, missing, outPath: args.out }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
