#!/usr/bin/env node
/**
 * Merge PDFs into one (pdf-lib copyPages — reliable across arbitrary source PDFs, where
 * PDFsharp's page import chokes on some documents). The C# pdf_merge tool shells out to this.
 *
 * Usage:  npx tsx src/merge.ts --out <merged.pdf> <in1.pdf> <in2.pdf> [...]
 * stdout = JSON { ok, pages, outPath }.
 */
import fs from 'node:fs';
import { PDFDocument } from 'pdf-lib';

async function main() {
  const argv = process.argv.slice(2);
  let out: string | undefined;
  const inputs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else inputs.push(argv[i]);
  }
  if (!out || inputs.length < 2) {
    console.error('Usage: merge --out <merged.pdf> <in1.pdf> <in2.pdf> [...]');
    process.exit(1);
  }

  const merged = await PDFDocument.create();
  for (const input of inputs) {
    const src = await PDFDocument.load(fs.readFileSync(input), { ignoreEncryption: true });
    const pages = await merged.copyPages(src, src.getPageIndices());
    for (const p of pages) merged.addPage(p);
  }
  fs.writeFileSync(out, await merged.save());
  process.stdout.write(JSON.stringify({ ok: true, pages: merged.getPageCount(), outPath: out }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
