#!/usr/bin/env node
/**
 * Fill a "Travel Itinerary" AcroForm PDF — a dated table of rows plus a signature-header date.
 *
 * WHICH FIELDS those are is DATA, not code: --map points at a form map (see the shipped
 * .claude/forms/japan-visa-itinerary.json) naming the header fields, the per-column field-name
 * templates, the row limit and the font sizes. The PDF machinery — pdf-lib, CJK font embedding via
 * fontkit, flattening — stays here, compiled and shipped with the app.
 *
 * That split is the point: a visa form that renames a field or grows a row is a file edit the
 * household's agent can make and have reviewed at the diff gate, not a Gatherlight release. Moving
 * the machinery itself into the data folder was considered and rejected — it would mean vendoring
 * pdf-lib + fontkit into every household's data folder, where they would stop being updated.
 *
 * Usage:
 *   npx tsx src/fill-itinerary.ts --in <template.pdf> --data <data.json> --map <map.json> --out <filled.pdf>
 *
 * data.json shape:
 *   {
 *     "applicationDate": { "year": "2026", "month": "05", "day": "27" },
 *     "rows": [
 *       { "date": "Sep 5 Sat", "activity": "...", "contact": "+81-6-...", "accommodation": "Hotel ... / addr" },
 *       ...
 *     ]
 *   }
 *
 * Output: filled PDF written to --out path. stdout = brief JSON report.
 */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

type ItineraryRow = Record<string, string>;

interface ItineraryData {
  applicationDate: { year: string; month: string; day: string };
  rows: ItineraryRow[];
}

/** The form's shape, supplied by --map. Every field name here comes from the map, never from here. */
interface FormMap {
  name?: string;
  maxRows: number;
  flatten?: boolean;
  headerFontSize?: number;
  bodyFontSize?: number;
  header?: { year?: string; month?: string; day?: string };
  columns: Record<string, string>;
}

interface Args {
  in: string;
  data: string;
  map: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--in') args.in = argv[++i];
    else if (flag === '--data') args.data = argv[++i];
    else if (flag === '--map') args.map = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
  }
  if (!args.in || !args.data || !args.map || !args.out) {
    console.error('Usage: fill-itinerary --in <template.pdf> --data <data.json> --map <map.json> --out <filled.pdf>');
    process.exit(1);
  }
  return args as Args;
}

/** Read the map and refuse a shape that would fill nothing — silence here looks like success. */
function readMap(mapPath: string): FormMap {
  const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as FormMap;
  const columns = raw.columns ?? {};
  if (Object.keys(columns).length === 0) {
    console.error(`form map ${mapPath} defines no columns — nothing would be filled`);
    process.exit(1);
  }
  for (const [col, field] of Object.entries(columns)) {
    if (typeof field !== 'string' || !field.includes('{n}')) {
      console.error(`form map ${mapPath}: column "${col}" must be a field-name template containing {n}`);
      process.exit(1);
    }
  }
  const maxRows = Number(raw.maxRows);
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    console.error(`form map ${mapPath}: maxRows must be a positive integer`);
    process.exit(1);
  }
  return { ...raw, columns, maxRows };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(`[pdf-form] fill ${args.in} + ${args.data} -> ${args.out}\n`);

  const pdfBytes = fs.readFileSync(args.in);
  const data: ItineraryData = JSON.parse(fs.readFileSync(args.data, 'utf8'));
  const map = readMap(args.map);

  if (data.rows.length > map.maxRows) {
    console.error(`row count ${data.rows.length} > ${map.maxRows} (form max); truncating to ${map.maxRows}`);
    data.rows = data.rows.slice(0, map.maxRows);
  }

  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  pdf.registerFontkit(fontkit);
  const form = pdf.getForm();

  // Every miss is REPORTED, not swallowed: a map naming a field the PDF does not have produces a
  // blank row that otherwise looks like a successful fill.
  const missing: string[] = [];
  const setField = (fieldName: string, value: string, size: number) => {
    try {
      const f = form.getTextField(fieldName);
      f.setText(value);
      f.setFontSize(size);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[pdf-form] warn: ${fieldName} -> ${msg}\n`);
      missing.push(fieldName);
      return false;
    }
  };

  // Header date — visible-size font.
  const headerSize = map.headerFontSize ?? 10;
  const header = map.header ?? {};
  let headerSet = 0;
  for (const [part, value] of [
    [header.year, data.applicationDate?.year],
    [header.month, data.applicationDate?.month],
    [header.day, data.applicationDate?.day],
  ] as [string | undefined, string | undefined][]) {
    if (part && value !== undefined && setField(part, value, headerSize)) headerSet++;
  }

  // Body rows — an explicit size (default 8pt) so tall trailing widgets don't auto-scale oversize.
  const bodySize = map.bodyFontSize ?? 8;
  const filled: string[] = [];
  let cellsSet = 0;
  data.rows.forEach((row, i) => {
    const n = i + 1;
    for (const [column, template] of Object.entries(map.columns)) {
      const value = row[column];
      if (value === undefined) continue;
      if (setField(template.replaceAll('{n}', String(n)), value, bodySize)) cellsSet++;
    }
    filled.push(`Row ${n}: ${row[Object.keys(map.columns)[0]] ?? ''}`);
  });

  // Flatten so the PDF renders the text on form widgets without requiring the reader to support
  // AcroForm field display — without it some viewers (especially printed output) show empty fields.
  // Non-editable afterwards, so the map can turn it off for a form meant to be tweaked in Acrobat.
  const flatten = map.flatten !== false;
  if (flatten) form.flatten();

  const out = await pdf.save();
  fs.writeFileSync(args.out, out);

  process.stdout.write(JSON.stringify({
    input: args.in,
    dataFile: args.data,
    mapFile: args.map,
    form: map.name ?? null,
    output: args.out,
    headerDate: data.applicationDate,
    headerFieldsSet: headerSet,
    rowsFilled: data.rows.length,
    cellsSet,
    rowsMax: map.maxRows,
    // Named, not counted: "3 fields missing" sends someone hunting, and the map is where the fix is.
    missingFields: missing,
    flattened: flatten,
    bytes: out.length,
    note: flatten
      ? 'PDF form flattened — fields baked into the page, so it prints. Set "flatten": false in the form map for editable output.'
      : 'Form left editable (flatten disabled in the form map).'
  }, null, 2) + '\n');
}

main().catch((err) => {
  console.error('fill-itinerary failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
