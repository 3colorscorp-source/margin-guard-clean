/**
 * CH-011I — Minimal PDF writer (no external deps).
 * Text + simple path drawing for drawn signatures.
 */
"use strict";

function escapePdfText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E\n\r\t]/g, "?");
}

function sanitizeSvgPath(raw) {
  const s = String(raw || "");
  if (/<script|javascript:|on\w+=|<img|base64|data:image|<|>/i.test(s)) {
    return "";
  }
  // Allow only path command letters and numbers/commas/spaces/decimals
  const cleaned = s.replace(/[^MmLlHhVvCcSsQqTtAaZz0-9eE.,+\-\s]/g, "");
  if (cleaned.length > 50000) return cleaned.slice(0, 50000);
  return cleaned.trim();
}

/**
 * Convert sanitized SVG path data to PDF path operators (user space).
 * Supports M/L/H/V/C/Q/Z (absolute and relative). Curves approximated as lines if needed.
 */
function svgPathToPdfOps(pathData, { scale = 0.35, offsetX = 0, offsetY = 0, flipY = true } = {}) {
  const cleaned = sanitizeSvgPath(pathData);
  if (!cleaned) return "";

  const tokens = cleaned.match(/[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens || !tokens.length) return "";

  let i = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  const ops = [];

  function mapX(x) {
    return offsetX + Number(x) * scale;
  }
  function mapY(y) {
    const n = Number(y) * scale;
    return flipY ? offsetY - n : offsetY + n;
  }
  function nextNum() {
    const t = tokens[i++];
    return Number(t);
  }
  function hasNum() {
    return i < tokens.length && !/^[MmLlHhVvCcSsQqTtAaZz]$/.test(tokens[i]);
  }

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MmLlHhVvCcSsQqTtAaZz]$/.test(t)) {
      cmd = t;
      i += 1;
    } else if (!cmd) {
      i += 1;
      continue;
    }

    if (cmd === "M" || cmd === "m") {
      const rel = cmd === "m";
      let x = nextNum();
      let y = nextNum();
      if (rel) {
        x += cx;
        y += cy;
      }
      cx = x;
      cy = y;
      startX = cx;
      startY = cy;
      ops.push(`${mapX(cx).toFixed(2)} ${mapY(cy).toFixed(2)} m`);
      while (hasNum()) {
        x = nextNum();
        y = nextNum();
        if (rel) {
          x += cx;
          y += cy;
        }
        cx = x;
        cy = y;
        ops.push(`${mapX(cx).toFixed(2)} ${mapY(cy).toFixed(2)} l`);
      }
      continue;
    }

    if (cmd === "L" || cmd === "l") {
      const rel = cmd === "l";
      while (hasNum()) {
        let x = nextNum();
        let y = nextNum();
        if (rel) {
          x += cx;
          y += cy;
        }
        cx = x;
        cy = y;
        ops.push(`${mapX(cx).toFixed(2)} ${mapY(cy).toFixed(2)} l`);
      }
      continue;
    }

    if (cmd === "H" || cmd === "h") {
      const rel = cmd === "h";
      while (hasNum()) {
        let x = nextNum();
        if (rel) x += cx;
        cx = x;
        ops.push(`${mapX(cx).toFixed(2)} ${mapY(cy).toFixed(2)} l`);
      }
      continue;
    }

    if (cmd === "V" || cmd === "v") {
      const rel = cmd === "v";
      while (hasNum()) {
        let y = nextNum();
        if (rel) y += cy;
        cy = y;
        ops.push(`${mapX(cx).toFixed(2)} ${mapY(cy).toFixed(2)} l`);
      }
      continue;
    }

    if (cmd === "C" || cmd === "c") {
      const rel = cmd === "c";
      while (hasNum()) {
        let x1 = nextNum();
        let y1 = nextNum();
        let x2 = nextNum();
        let y2 = nextNum();
        let x = nextNum();
        let y = nextNum();
        if (rel) {
          x1 += cx;
          y1 += cy;
          x2 += cx;
          y2 += cy;
          x += cx;
          y += cy;
        }
        cx = x;
        cy = y;
        ops.push(
          `${mapX(x1).toFixed(2)} ${mapY(y1).toFixed(2)} ` +
            `${mapX(x2).toFixed(2)} ${mapY(y2).toFixed(2)} ` +
            `${mapX(cx).toFixed(2)} ${mapY(cy).toFixed(2)} c`
        );
      }
      continue;
    }

    if (cmd === "Q" || cmd === "q") {
      const rel = cmd === "q";
      while (hasNum()) {
        let x1 = nextNum();
        let y1 = nextNum();
        let x = nextNum();
        let y = nextNum();
        if (rel) {
          x1 += cx;
          y1 += cy;
          x += cx;
          y += cy;
        }
        // Approximate quadratic as cubic
        const c1x = cx + (2 / 3) * (x1 - cx);
        const c1y = cy + (2 / 3) * (y1 - cy);
        const c2x = x + (2 / 3) * (x1 - x);
        const c2y = y + (2 / 3) * (y1 - y);
        cx = x;
        cy = y;
        ops.push(
          `${mapX(c1x).toFixed(2)} ${mapY(c1y).toFixed(2)} ` +
            `${mapX(c2x).toFixed(2)} ${mapY(c2y).toFixed(2)} ` +
            `${mapX(cx).toFixed(2)} ${mapY(cy).toFixed(2)} c`
        );
      }
      continue;
    }

    if (cmd === "Z" || cmd === "z") {
      ops.push("h");
      cx = startX;
      cy = startY;
      continue;
    }

    // Unsupported command: skip numeric args
    while (hasNum()) nextNum();
  }

  if (!ops.length) return "";
  return `0.6 w\n${ops.join("\n")}\nS\n`;
}

/**
 * Build a multi-page PDF from line items.
 * lines: Array<{ text?: string, fontSize?: number, bold?: boolean, italic?: boolean, gap?: number, pathOps?: string }>
 */
function buildPdfDocument(lines, options = {}) {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const footerY = 36;
  const maxWidth = pageWidth - margin * 2;
  const generatedAt = options.generatedAt || new Date().toISOString();
  const title = options.title || "Signed Contract";

  const pages = [];
  let current = [];
  let y = pageHeight - margin;

  function newPage() {
    if (current.length) pages.push(current);
    current = [];
    y = pageHeight - margin;
  }

  function ensureSpace(needed) {
    if (y - needed < footerY + 28) newPage();
  }

  function wrapText(text, fontSize) {
    const raw = String(text ?? "");
    const avgChar = fontSize * 0.5;
    const maxChars = Math.max(24, Math.floor(maxWidth / avgChar));
    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const out = [];
    let line = "";
    for (const w of words) {
      const trial = line ? `${line} ${w}` : w;
      if (trial.length > maxChars && line) {
        out.push(line);
        line = w;
      } else if (w.length > maxChars) {
        if (line) out.push(line);
        for (let i = 0; i < w.length; i += maxChars) {
          out.push(w.slice(i, i + maxChars));
        }
        line = "";
      } else {
        line = trial;
      }
    }
    if (line) out.push(line);
    return out;
  }

  for (const item of lines) {
    if (item.pageBreak) {
      newPage();
      continue;
    }
    if (item.pathBlock) {
      ensureSpace(item.height || 70);
      current.push({
        type: "path",
        ops: item.pathBlock(y),
      });
      y -= item.height || 70;
      continue;
    }

    const fontSize = item.fontSize || 10;
    const gap = item.gap != null ? item.gap : fontSize + 4;
    const text = item.text == null ? "" : String(item.text);
    const wrapped = wrapText(text, fontSize);
    for (const wline of wrapped) {
      ensureSpace(gap);
      current.push({
        type: "text",
        text: wline,
        fontSize,
        bold: !!item.bold,
        italic: !!item.italic,
        x: margin,
        y,
      });
      y -= gap;
    }
    if (item.afterGap) y -= item.afterGap;
  }
  if (current.length) pages.push(current);
  if (!pages.length) pages.push([]);

  const objects = [];
  function addObj(body) {
    objects.push(body);
    return objects.length;
  }

  const fontRegular = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const fontBold = addObj("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const fontItalic = addObj(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>"
  );

  const pageIds = [];
  const contentIds = [];

  for (let p = 0; p < pages.length; p += 1) {
    const ops = [];
    for (const el of pages[p]) {
      if (el.type === "text") {
        const fontId = el.bold ? fontBold : el.italic ? fontItalic : fontRegular;
        ops.push("BT");
        ops.push(`/F${fontId} ${el.fontSize} Tf`);
        ops.push(`${el.x.toFixed(2)} ${el.y.toFixed(2)} Td`);
        ops.push(`(${escapePdfText(el.text)}) Tj`);
        ops.push("ET");
      } else if (el.type === "path" && el.ops) {
        ops.push(el.ops);
      }
    }
    // Footer page number + generated stamp
    const footer =
      `Page ${p + 1} of ${pages.length}  |  Generated ${generatedAt}  |  ${title}`;
    ops.push("BT");
    ops.push(`/F${fontRegular} 8 Tf`);
    ops.push(`${margin.toFixed(2)} ${footerY.toFixed(2)} Td`);
    ops.push(`(${escapePdfText(footer)}) Tj`);
    ops.push("ET");

    const stream = ops.join("\n");
    const contentId = addObj(
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
    );
    contentIds.push(contentId);
  }

  for (let p = 0; p < pages.length; p += 1) {
    const pageId = addObj(
      `<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
        `/Contents ${contentIds[p]} 0 R ` +
        `/Resources << /Font << /F${fontRegular} ${fontRegular} 0 R /F${fontBold} ${fontBold} 0 R /F${fontItalic} ${fontItalic} 0 R >> >> >>`
    );
    pageIds.push(pageId);
  }

  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  const pagesId = addObj(
    `<< /Type /Pages /Kids [ ${kids} ] /Count ${pageIds.length} >>`
  );
  // Patch parent refs
  for (let i = 0; i < pageIds.length; i += 1) {
    objects[pageIds[i] - 1] = objects[pageIds[i] - 1].replace(
      "PAGES_REF",
      `${pagesId} 0 R`
    );
  }

  const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += `startxref\n${xrefPos}\n%%EOF\n`;

  return Buffer.from(pdf, "utf8");
}

module.exports = {
  escapePdfText,
  sanitizeSvgPath,
  svgPathToPdfOps,
  buildPdfDocument,
};
