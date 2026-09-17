/**
 * CH-011I — Minimal PDF writer (no external deps).
 * Text + simple path drawing for drawn signatures.
 * Helvetica / WinAnsi, explicit Tc/Tw/Tz, width-based wrap.
 */
"use strict";

/**
 * Deterministic Unicode → ASCII for WinAnsi Helvetica.
 * Known punctuation is mapped; remaining non-ASCII still becomes "?" at escape.
 */
function normalizePdfUnicode(value) {
  return String(value ?? "")
    .replace(/\u2014|\u2013|\u2012|\u2010|\u2212|\uFE58|\uFE63|\uFF0D/g, "-")
    .replace(/\u2022|\u00B7|\u2043|\u2219|\u25E6|\u2023/g, "*")
    .replace(/\u2018|\u2019|\u201A|\u201B|\u2032|\u02BC/g, "'")
    .replace(/\u201C|\u201D|\u201E|\u201F|\u2033/g, '"')
    .replace(/\u00A0|\u202F|\u2007|\u2008|\u2009|\u200A|\u2002|\u2003|\u2004|\u2005|\u2006|\u200B|\uFEFF/g, " ")
    .replace(/\u2026/g, "...")
    .replace(/[\t\r]+/g, " ");
}

function escapePdfText(value) {
  return normalizePdfUnicode(value)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/[^\x20-\x7E\n]/g, "?");
}

/**
 * Helvetica AFM widths (WinAnsi, 1/1000 em) for ASCII 32-126.
 * Sufficiently correct for wrap; Bold/Oblique use the same table.
 */
const HELVETICA_WIDTHS = new Int16Array(128);
(function initHelveticaWidths() {
  const w = HELVETICA_WIDTHS;
  for (let i = 0; i < 128; i += 1) w[i] = 600;
  w[32] = 278;
  w[33] = 278;
  w[34] = 355;
  w[35] = 556;
  w[36] = 556;
  w[37] = 889;
  w[38] = 667;
  w[39] = 191;
  w[40] = 333;
  w[41] = 333;
  w[42] = 389;
  w[43] = 584;
  w[44] = 278;
  w[45] = 333;
  w[46] = 278;
  w[47] = 278;
  for (let d = 48; d <= 57; d += 1) w[d] = 556;
  w[58] = 278;
  w[59] = 278;
  w[60] = 584;
  w[61] = 584;
  w[62] = 584;
  w[63] = 556;
  w[64] = 1015;
  w[65] = 667;
  w[66] = 667;
  w[67] = 722;
  w[68] = 722;
  w[69] = 667;
  w[70] = 611;
  w[71] = 778;
  w[72] = 722;
  w[73] = 278;
  w[74] = 500;
  w[75] = 667;
  w[76] = 556;
  w[77] = 833;
  w[78] = 722;
  w[79] = 778;
  w[80] = 667;
  w[81] = 778;
  w[82] = 722;
  w[83] = 667;
  w[84] = 611;
  w[85] = 722;
  w[86] = 667;
  w[87] = 944;
  w[88] = 667;
  w[89] = 667;
  w[90] = 611;
  w[91] = 333;
  w[92] = 278;
  w[93] = 333;
  w[94] = 584;
  w[95] = 556;
  w[96] = 333;
  w[97] = 556;
  w[98] = 556;
  w[99] = 500;
  w[100] = 556;
  w[101] = 556;
  w[102] = 278;
  w[103] = 556;
  w[104] = 556;
  w[105] = 222;
  w[106] = 222;
  w[107] = 500;
  w[108] = 222;
  w[109] = 833;
  w[110] = 556;
  w[111] = 556;
  w[112] = 556;
  w[113] = 556;
  w[114] = 333;
  w[115] = 500;
  w[116] = 278;
  w[117] = 556;
  w[118] = 500;
  w[119] = 722;
  w[120] = 500;
  w[121] = 500;
  w[122] = 500;
  w[123] = 334;
  w[124] = 260;
  w[125] = 334;
  w[126] = 584;
})();

function measureTextWidth(text, fontSize) {
  const s = normalizePdfUnicode(text);
  const size = Number(fontSize) || 10;
  let units = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code === 10) continue;
    units += code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code] : 600;
  }
  return (units * size) / 1000;
}

function wrapTextToWidth(text, fontSize, maxWidth) {
  const raw = normalizePdfUnicode(text).replace(/\s+/g, " ").trim();
  if (!raw) return [""];
  const words = raw.split(" ");
  const out = [];
  let line = "";
  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (measureTextWidth(trial, fontSize) <= maxWidth) {
      line = trial;
      continue;
    }
    if (line) out.push(line);
    if (measureTextWidth(word, fontSize) <= maxWidth) {
      line = word;
      continue;
    }
    let chunk = "";
    for (const ch of word) {
      const next = chunk + ch;
      if (chunk && measureTextWidth(next, fontSize) > maxWidth) {
        out.push(chunk);
        chunk = ch;
      } else {
        chunk = next;
      }
    }
    line = chunk;
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function sanitizeSvgPath(raw) {
  const s = String(raw || "");
  if (/<script|javascript:|on\w+=|<img|base64|data:image|<|>/i.test(s)) {
    return "";
  }
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

    while (hasNum()) nextNum();
  }

  if (!ops.length) return "";
  return `0.6 w\n${ops.join("\n")}\nS\n`;
}

const FONT_DICT =
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
const FONT_BOLD_DICT =
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
const FONT_ITALIC_DICT =
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>";

/**
 * Build a multi-page PDF from line items.
 * lines: Array<{ text?: string, fontSize?: number, bold?: boolean, italic?: boolean,
 *   gap?: number, afterGap?: number, keepTogetherHeight?: number, pathBlock?: fn }>
 */
function buildPdfDocument(lines, options = {}) {
  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 54;
  const footerY = 36;
  const contentBottom = footerY + 28;
  const maxWidth = pageWidth - margin * 2;
  const generatedAt = options.generatedAt || new Date().toISOString();
  const title = options.title || "Signed Contract";
  const topY = pageHeight - margin;

  const pages = [];
  let current = [];
  let y = topY;

  function newPage() {
    if (!current.length) {
      y = topY;
      return;
    }
    pages.push({ items: current, endY: y });
    current = [];
    y = topY;
  }

  function ensureSpace(needed) {
    const need = Math.max(Number(needed) || 0, 1);
    if (y - need < contentBottom) newPage();
  }

  for (const item of lines) {
    if (item && item.pageBreak) {
      newPage();
      continue;
    }
    if (item && item.pathBlock) {
      const h = item.height || 70;
      ensureSpace(Math.max(h, Number(item.keepTogetherHeight) || 0));
      current.push({
        type: "path",
        ops: item.pathBlock(y),
      });
      y -= h;
      continue;
    }

    const fontSize = item.fontSize || 10;
    const leading = item.gap != null ? item.gap : fontSize + 2;
    const text = item.text == null ? "" : String(item.text);
    const wrapped = wrapTextToWidth(text, fontSize, maxWidth);
    const blockH =
      wrapped.length * leading + (item.afterGap || 0);
    const keep = Number(item.keepTogetherHeight) || 0;
    ensureSpace(Math.max(blockH, keep));

    for (const wline of wrapped) {
      ensureSpace(leading);
      current.push({
        type: "text",
        text: wline,
        fontSize,
        bold: !!item.bold,
        italic: !!item.italic,
        x: margin,
        y,
      });
      y -= leading;
    }
    if (item.afterGap) y -= item.afterGap;
  }
  if (current.length) pages.push({ items: current, endY: y });
  if (!pages.length) pages.push({ items: [], endY: topY });

  // Pull nearly empty pages back onto the previous page when they fit.
  let compactPass = true;
  while (compactPass && pages.length >= 2) {
    compactPass = false;
    for (let i = pages.length - 1; i >= 1; i -= 1) {
      const page = pages[i];
      const prev = pages[i - 1];
      const contentItems = page.items.filter(
        (el) =>
          el.type === "path" ||
          (el.type === "text" && String(el.text || "").trim())
      );
      if (contentItems.length > 2) continue;
      const used = topY - page.endY;
      if (used <= 0) continue;
      if (prev.endY - used < contentBottom) continue;
      if (page.items.some((el) => el.type === "path")) continue;
      const delta = prev.endY - topY;
      for (const el of page.items) {
        if (typeof el.y === "number") el.y += delta;
      }
      prev.items.push(...page.items);
      prev.endY -= used;
      pages.splice(i, 1);
      compactPass = true;
      break;
    }
  }

  const objects = [];
  function addObj(body) {
    objects.push(body);
    return objects.length;
  }

  const fontRegular = addObj(FONT_DICT);
  const fontBold = addObj(FONT_BOLD_DICT);
  const fontItalic = addObj(FONT_ITALIC_DICT);

  const pageIds = [];
  const contentIds = [];
  const pageList = pages.map((p) => p.items);

  for (let p = 0; p < pageList.length; p += 1) {
    const ops = [];
    for (const el of pageList[p]) {
      if (el.type === "text") {
        const fontId = el.bold ? fontBold : el.italic ? fontItalic : fontRegular;
        ops.push("BT");
        ops.push(`/F${fontId} ${el.fontSize} Tf`);
        ops.push("0 Tc");
        ops.push("0 Tw");
        ops.push("100 Tz");
        ops.push(`${el.x.toFixed(2)} ${el.y.toFixed(2)} Td`);
        ops.push(`(${escapePdfText(el.text)}) Tj`);
        ops.push("ET");
      } else if (el.type === "path" && el.ops) {
        ops.push(el.ops);
      }
    }
    const footer =
      `Page ${p + 1} of ${pageList.length}  |  Generated ${generatedAt}  |  ${title}`;
    ops.push("BT");
    ops.push(`/F${fontRegular} 8 Tf`);
    ops.push("0 Tc");
    ops.push("0 Tw");
    ops.push("100 Tz");
    ops.push(`${margin.toFixed(2)} ${footerY.toFixed(2)} Td`);
    ops.push(`(${escapePdfText(footer)}) Tj`);
    ops.push("ET");

    const stream = ops.join("\n");
    const contentId = addObj(
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`
    );
    contentIds.push(contentId);
  }

  for (let p = 0; p < pageList.length; p += 1) {
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
  normalizePdfUnicode,
  escapePdfText,
  measureTextWidth,
  wrapTextToWidth,
  sanitizeSvgPath,
  svgPathToPdfOps,
  buildPdfDocument,
};
