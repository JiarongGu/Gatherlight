#!/usr/bin/env node
/**
 * Fill a Japanese visa "Travel Itinerary" AcroForm PDF.
 *
 * Form fields expected (per `inspect.ts` output on application7.pdf):
 *   DateRow1..DateRow16, "Activity PlanRow1".."Activity PlanRow16",
 *   ContactRow1..ContactRow16, AccommodationRow1..AccommodationRow16,
 *   Year, Month, Day  (signature header)
 *
 * Usage:
 *   npx tsx src/fill-itinerary.ts --in <template.pdf> --data <data.json> --out <filled.pdf>
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

interface ItineraryRow {
  date: string;
  activity: string;
  contact: string;
  accommodation: string;
}

interface ItineraryData {
  applicationDate: { year: string; month: string; day: string };
  rows: ItineraryRow[];
}

interface Args {
  in: string;
  data: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--in') args.in = argv[++i];
    else if (flag === '--data') args.data = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
  }
  if (!args.in || !args.data || !args.out) {
    console.error('Usage: fill-itinerary --in <template.pdf> --data <data.json> --out <filled.pdf>');
    process.exit(1);
  }
  return args as Args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(`[pdf-form] fill ${args.in} + ${args.data} -> ${args.out}\n`);

  const pdfBytes = fs.readFileSync(args.in);
  const data: ItineraryData = JSON.parse(fs.readFileSync(args.data, 'utf8'));

  if (data.rows.length > 16) {
    console.error(`row count ${data.rows.length} > 16 (form max); truncating to 16`);
    data.rows = data.rows.slice(0, 16);
  }

  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  pdf.registerFontkit(fontkit);
  const form = pdf.getForm();

  // Header date — visible-size font
  const setHeader = (name: string, value: string) => {
    const f = form.getTextField(name);
    f.setText(value);
    f.setFontSize(10);
  };
  setHeader('Year', data.applicationDate.year);
  setHeader('Month', data.applicationDate.month);
  setHeader('Day', data.applicationDate.day);

  // Body rows — force 8pt so rows 15-16 (taller widgets) don't auto-scale to oversize
  const BODY_FONT_SIZE = 8;
  const filled: string[] = [];
  data.rows.forEach((row, i) => {
    const n = i + 1;
    const setSafe = (fieldName: string, value: string) => {
      try {
        const f = form.getTextField(fieldName);
        f.setText(value);
        f.setFontSize(BODY_FONT_SIZE);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[pdf-form] warn: ${fieldName} -> ${msg}\n`);
      }
    };
    setSafe(`DateRow${n}`, row.date);
    setSafe(`Activity PlanRow${n}`, row.activity);
    setSafe(`ContactRow${n}`, row.contact);
    setSafe(`AccommodationRow${n}`, row.accommodation);
    filled.push(`Row ${n}: ${row.date}`);
  });

  // Flatten so the PDF renders the text on form widgets without requiring
  // the reader to support AcroForm field display. Without this, some PDF
  // viewers (especially printed output) show empty fields.
  // NOTE: flatten() makes the PDF non-editable. If user wants to tweak in Acrobat,
  // remove this line.
  form.flatten();

  const out = await pdf.save();
  fs.writeFileSync(args.out, out);

  process.stdout.write(JSON.stringify({
    input: args.in,
    dataFile: args.data,
    output: args.out,
    headerDate: data.applicationDate,
    rowsFilled: data.rows.length,
    rowsMax: 16,
    bytes: out.length,
    note: 'PDF form flattened — fields baked into page. Re-run without flatten() in source if you need editable output.'
  }, null, 2) + '\n');
}

main().catch((err) => {
  console.error('fill-itinerary failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
