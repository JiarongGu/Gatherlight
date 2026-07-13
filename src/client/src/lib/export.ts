import { marked } from 'marked';
import type { PlanFile } from './collectFiles';
import { stripFirstH1 } from './markdown';

/**
 * Build a single combined-markdown document for a trip:
 *   trip + paired budget + paired packing + household snapshot.
 * Useful for offline reference, sharing with travelers, or print → PDF.
 */
export function buildTripExport(active: PlanFile, allFiles: PlanFile[]): {
  filename: string;
  content: string;
} {
  const slug = active.name; // e.g. "2026-08-kyoto"
  const today = new Date().toISOString().slice(0, 10);

  const budget = allFiles.find((f) => f.path === `plans/budgets/${slug}.md`);
  const packing = allFiles.find((f) => f.path === `plans/packing/${slug}.md`);
  // Snapshot relevant household docs (skip README which is metadata)
  const household = allFiles
    .filter((f) => f.path.startsWith('household/') && f.path !== 'household/README.md')
    .sort((a, b) => a.name.localeCompare(b.name));

  const parts: string[] = [];
  parts.push(`# ${active.title} — 旅游计划 export\n\n`);
  parts.push(`> **来源**:[\`${active.path}\`](#) · **导出时间**:${today}\n`);
  parts.push(`> 本文件汇总:行程 + 配套预算 + 打包清单 + 家庭背景快照。订票/出发前请回原 repo 检查最新版本。\n\n`);
  parts.push(`---\n\n`);

  parts.push(`## 🗺️ 行程 (Trip)\n\n`);
  parts.push(stripFirstH1(active.content));
  parts.push(`\n\n---\n\n`);

  if (budget) {
    parts.push(`## 💰 预算 (Budget)\n\n`);
    parts.push(stripFirstH1(budget.content));
    parts.push(`\n\n---\n\n`);
  } else {
    parts.push(`## 💰 预算 (Budget)\n\n_(无配对预算文件)_\n\n---\n\n`);
  }

  if (packing) {
    parts.push(`## 🎒 打包 (Packing)\n\n`);
    parts.push(stripFirstH1(packing.content));
    parts.push(`\n\n---\n\n`);
  } else {
    parts.push(`## 🎒 打包 (Packing)\n\n_(无配对打包文件)_\n\n---\n\n`);
  }

  if (household.length > 0) {
    parts.push(`## 👥 家庭背景 (Household snapshot)\n\n`);
    parts.push(`> 用于规划时的参考事实。详细信息以 repo 内最新版本为准。\n\n`);
    for (const h of household) {
      parts.push(`### ${h.name}\n\n`);
      parts.push(stripFirstH1(h.content));
      parts.push(`\n\n`);
    }
  }

  return {
    filename: `${slug}-export-${today}.md`,
    content: parts.join('')
  };
}

/** Trigger a browser download of a string as a file. */
export function downloadAsFile(filename: string, content: string, mimeType: string = 'text/markdown;charset=utf-8'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke to next tick so Firefox/Safari finalise the download
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Detect whether a PlanFile is a trip-plan file (eligible for export). */
export function isTripFile(file: PlanFile | null): boolean {
  return !!file && file.path.startsWith('plans/trips/');
}

/** Print-friendly inline CSS embedded in the PDF temp container. */
const PDF_STYLE = `
  body, .pdf-container {
    font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 11pt;
    line-height: 1.55;
    color: #111;
    background: #fff;
  }
  .pdf-container { padding: 14mm 12mm; max-width: 180mm; }
  .pdf-container h1 { font-size: 20pt; margin: 0 0 6pt; color: #111; }
  .pdf-container h2 { font-size: 15pt; margin: 18pt 0 6pt; color: #111; border-bottom: 1px solid #888; padding-bottom: 3pt; page-break-after: avoid; }
  .pdf-container h3 { font-size: 12pt; margin: 12pt 0 4pt; color: #111; page-break-after: avoid; }
  .pdf-container h4 { font-size: 11pt; margin: 10pt 0 4pt; color: #222; }
  .pdf-container p, .pdf-container ul, .pdf-container ol { margin: 4pt 0; }
  .pdf-container ul, .pdf-container ol { padding-left: 18pt; }
  .pdf-container li { margin: 2pt 0; }
  .pdf-container a { color: #0454c8; text-decoration: underline; }
  .pdf-container code { background: #f3f3f3; padding: 1pt 4pt; border-radius: 3px; font-family: ui-monospace, monospace; font-size: 9.5pt; }
  .pdf-container pre { background: #f5f5f5; padding: 8pt 10pt; border-radius: 4px; border: 1px solid #ddd; overflow-x: auto; font-size: 9pt; line-height: 1.4; }
  .pdf-container blockquote { border-left: 3px solid #aaa; margin: 6pt 0; padding: 2pt 10pt; color: #555; }
  .pdf-container table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9.5pt; page-break-inside: avoid; }
  .pdf-container th, .pdf-container td { border: 1px solid #999; padding: 3pt 5pt; text-align: left; vertical-align: top; }
  .pdf-container th { background: #f0f0f0; font-weight: 600; }
  .pdf-container hr { border: 0; border-top: 1px solid #ccc; margin: 14pt 0; }
  .pdf-container img { max-width: 100%; height: auto; }
  .pdf-container input[type="checkbox"] { margin-right: 4pt; }
`;

/**
 * PDF export via browser-native print-to-PDF.
 *
 * Opens a new tab with the formatted content + triggers print dialog.
 * User selects "Save as PDF" / "Microsoft Print to PDF" from the print
 * dialog destination. More reliable than html2canvas-based capture which
 * was producing blank PDFs (2026-05-27 user feedback: "导出pdf是空的").
 *
 * Why native print > html2canvas:
 * - No screen-capture timing / off-screen rendering issues
 * - Native typography + font handling (no canvas rasterization fuzziness)
 * - Browser controls page breaks via CSS @page rules
 * - Smaller output PDFs (text stays as text, not rasterized images)
 *
 * Trade-off: user sees a print dialog instead of an immediate file download.
 * Acceptable since "Save as PDF" is one click in the dialog.
 */
export async function downloadTripPDF(active: PlanFile, allFiles: PlanFile[]): Promise<void> {
  const { filename, content } = buildTripExport(active, allFiles);
  const documentTitle = filename.replace(/\.md$/, '');

  // Configure marked for GFM tables + checklists
  marked.setOptions({ gfm: true, breaks: false });
  const bodyHtml = await marked.parse(content);

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    // No React context here — signal the caller (App), which shows a themed toast.
    throw new Error('popup-blocked');
  }

  const printStyles = `
    ${PDF_STYLE}
    @page { size: A4; margin: 14mm 12mm; }
    @media print {
      body { margin: 0; }
      .pdf-container { padding: 0; max-width: none; }
      .no-print { display: none !important; }
    }
    body { margin: 0; background: #fff; }
    .toolbar {
      position: sticky; top: 0; padding: 10px 18px; background: #f6f6f8;
      border-bottom: 1px solid #ddd; font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
      display: flex; gap: 12px; align-items: center; z-index: 9999;
    }
    .toolbar button { padding: 6px 14px; font-size: 13px; cursor: pointer; }
    .toolbar .hint { font-size: 12px; color: #555; }
  `;

  printWindow.document.open();
  printWindow.document.write(`<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${documentTitle}</title>
    <style>${printStyles}</style>
  </head>
  <body>
    <div class="toolbar no-print">
      <button onclick="window.print()">🖨️ 打印 / 保存为 PDF (Print / Save as PDF)</button>
      <span class="hint">在打印对话框中选 "Save as PDF" / "Microsoft Print to PDF" 即可下载</span>
    </div>
    <div class="pdf-container">${bodyHtml}</div>
  </body>
</html>`);
  printWindow.document.close();

  // Auto-trigger the print dialog after a short delay for layout + fonts to settle.
  // Some browsers ignore window.print() called immediately after document.write.
  setTimeout(() => {
    try {
      printWindow.focus();
      printWindow.print();
    } catch {
      // If auto-print is blocked, user can click the toolbar button instead.
    }
  }, 400);
}
