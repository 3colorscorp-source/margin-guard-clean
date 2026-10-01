/**
 * Client-side invoice PDF for Invoice Hub send.
 * Letterhead matches the public invoice / quote memberete. Does not invent slogan or L#.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MgInvoicePdf = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function trimStr(value) {
    return String(value == null ? "" : value).trim();
  }

  function formatLicenseLine(raw) {
    const n = trimStr(raw);
    if (!n) return "";
    if (/^l#/i.test(n) || /^lic(ense)?\.?\s*#/i.test(n)) return n;
    return "L# " + n;
  }

  function formatMoney(value, currency) {
    const cur = trimStr(currency) || "USD";
    const num = Number(value);
    const n = Number.isFinite(num) ? num : 0;
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);
    } catch (_err) {
      return "$" + n.toFixed(2);
    }
  }

  function formatMoneyOrText(value, currency) {
    const raw = trimStr(value);
    if (!raw) return "";
    const m = raw.match(/\$?([0-9][0-9,]*(?:\.[0-9]{2})?)/);
    if (!m) return raw;
    const n = Number(String(m[1]).replace(/,/g, ""));
    return Number.isFinite(n) ? formatMoney(n, currency) : raw;
  }

  function wrapLines(doc, text, maxWidth, tight) {
    const raw = trimStr(text);
    if (!raw) return [];
    const paragraphs = raw.split(/\n+/);
    const out = [];
    paragraphs.forEach((p, idx) => {
      const wrapped = doc.splitTextToSize(p, maxWidth);
      wrapped.forEach((line) => out.push(line));
      if (!tight && idx < paragraphs.length - 1) out.push("");
    });
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  }

  function storedHasAddress(stored, address) {
    const s = trimStr(stored).toLowerCase();
    const a = trimStr(address).toLowerCase();
    if (!s || !a) return false;
    if (s.indexOf(a) >= 0) return true;
    const compact = (t) => t.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
    if (compact(s).indexOf(compact(a)) >= 0) return true;
    const street = a.match(/\d+\s+[a-z0-9]+/i);
    return !!(street && s.indexOf(street[0].toLowerCase()) >= 0);
  }

  async function buildInvoicePdfPayload(data) {
    const jspdf = typeof window !== "undefined" ? window.jspdf : null;
    if (!jspdf || !jspdf.jsPDF) return null;
    const src = data && typeof data === "object" ? data : {};
    const doc = new jspdf.jsPDF({ unit: "pt", format: "letter" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const left = 48;
    const right = pageWidth - 48;
    const width = right - left;
    const pageBottom = 752;
    const headerTop = 44;
    const padX = 10;
    const sectionHeadH = 16;
    const workRowH = 14;
    const ledgerRowH = 16;
    const ledgerLastH = 20;
    let y = headerTop;
    let currentSection = "header";
    let frameY = 0;
    const dark = [17, 24, 39];
    const muted = [107, 114, 128];
    const bodyText = [55, 65, 81];
    const hair = [216, 221, 229];
    const headBg = [247, 248, 250];
    const lastBg = [251, 252, 253];
    const ruleSoft = [238, 241, 245];

    const businessName = trimStr(src.businessName);
    const serviceLine = trimStr(src.serviceLine);
    const license = formatLicenseLine(src.licenseNumber);
    const phone = trimStr(src.phone);
    const email = trimStr(src.email);
    const address = trimStr(src.address);
    const invoiceNo = trimStr(src.invoiceNo) || "Invoice";
    const currency = trimStr(src.currency);
    const dueAmount = src.remainingBalance != null ? src.remainingBalance : src.invoiceAmount;

    function drawRule(atY, color) {
      const c = color || hair;
      doc.setDrawColor(...c);
      doc.setLineWidth(0.7);
      doc.line(left, atY, right, atY);
    }

    function closeFrame() {
      if (!frameY || y <= frameY) {
        frameY = 0;
        return;
      }
      doc.setDrawColor(...hair);
      doc.setLineWidth(0.7);
      doc.rect(left, frameY, width, y - frameY);
      frameY = 0;
    }

    function beginFrame() {
      frameY = y;
    }

    function drawSectionBar(title) {
      ensureLine(sectionHeadH + 2);
      doc.setFillColor(...headBg);
      doc.setDrawColor(...hair);
      doc.setLineWidth(0.7);
      doc.rect(left, y, width, sectionHeadH, "FD");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text(String(title).toUpperCase(), left + padX, y + 11);
      y += sectionHeadH;
    }

    function drawContinuationHeader() {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...dark);
      doc.text(businessName || "Invoice", left, y);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.text("Invoice " + invoiceNo, right, y, { align: "right" });
      y += 10;
      drawRule(y);
      y += 12;
    }

    function startNewPage() {
      closeFrame();
      doc.addPage();
      y = headerTop;
      drawContinuationHeader();
      if (currentSection === "work") {
        drawSectionBar("Work details (continued)");
        beginFrame();
      }
    }

    function ensureLine(step) {
      const next = y + (step || 12);
      if (next > pageBottom) startNewPage();
    }

    const leftColWidth = 300;
    let leftY = headerTop;
    if (businessName) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(15);
      doc.setTextColor(...dark);
      wrapLines(doc, businessName, leftColWidth, true).forEach((line) => {
        doc.text(line, left, leftY);
        leftY += 16;
      });
    }
    if (serviceLine) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...muted);
      wrapLines(doc, serviceLine, leftColWidth, true).forEach((line) => {
        doc.text(line, left, leftY);
        leftY += 12;
      });
    }
    const letterhead = [];
    if (license) letterhead.push(license);
    if (phone) letterhead.push("Phone: " + phone);
    if (email) letterhead.push("Email: " + email);
    if (address) letterhead.push("Address: " + address);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...dark);
    letterhead.forEach((entry) => {
      wrapLines(doc, entry, leftColWidth, true).forEach((line) => {
        doc.text(line, left, leftY);
        leftY += 11;
      });
    });

    const metaW = 196;
    const metaX = right - metaW;
    let rightY = headerTop;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(...dark);
    doc.text("INVOICE", right, rightY, { align: "right" });
    rightY += 18;

    const metaRows = [["Invoice #", invoiceNo]];
    if (trimStr(src.issueDate)) metaRows.push(["Issue date", trimStr(src.issueDate)]);
    if (trimStr(src.dueDate)) metaRows.push(["Due date", trimStr(src.dueDate)]);
    const metaRowH = 15;
    const metaBoxH = metaRows.length * metaRowH + (dueAmount != null ? 34 : 0);
    doc.setDrawColor(...hair);
    doc.setLineWidth(0.7);
    doc.setFillColor(255, 255, 255);
    doc.rect(metaX, rightY, metaW, metaBoxH, "FD");
    metaRows.forEach((row, idx) => {
      const rowY = rightY + idx * metaRowH;
      if (idx > 0) {
        doc.setDrawColor(...ruleSoft);
        doc.setLineWidth(0.5);
        doc.line(metaX + 8, rowY, right - 8, rowY);
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text(row[0], metaX + 8, rowY + 11);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...dark);
      doc.text(row[1], right - 8, rowY + 11, { align: "right" });
    });
    rightY += metaRows.length * metaRowH;
    if (dueAmount != null) {
      doc.setFillColor(...headBg);
      doc.rect(metaX, rightY, metaW, 34, "F");
      doc.setDrawColor(...hair);
      doc.setLineWidth(0.7);
      doc.line(metaX, rightY, right, rightY);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(...muted);
      doc.text("Amount due", right - 8, rightY + 12, { align: "right" });
      doc.setFont("helvetica", "bold");
      doc.setFontSize(12);
      doc.setTextColor(...dark);
      doc.text(formatMoney(dueAmount, currency), right - 8, rightY + 26, { align: "right" });
      rightY += 34;
    }
    doc.setDrawColor(...hair);
    doc.setLineWidth(0.7);
    doc.rect(metaX, headerTop + 18, metaW, rightY - (headerTop + 18));

    y = Math.max(leftY, rightY) + 12;

    const billName = trimStr(src.customerName);
    const billEmail = trimStr(src.customerEmail);
    const billProject = trimStr(src.projectName);
    if (billName || billEmail || billProject) {
      currentSection = "bill";
      drawSectionBar("Bill to");
      beginFrame();
      const billRows = [];
      if (billName) billRows.push(["Name", billName]);
      if (billEmail) billRows.push(["Email", billEmail]);
      if (billProject) billRows.push(["Project", billProject]);
      billRows.forEach((row, idx) => {
        const h = 16;
        ensureLine(h);
        if (idx > 0) {
          doc.setDrawColor(...ruleSoft);
          doc.setLineWidth(0.5);
          doc.line(left + padX, y, right - padX, y);
        }
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(...muted);
        doc.text(row[0], left + padX, y + 11);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.setTextColor(...dark);
        doc.text(row[1], left + 72, y + 11);
        y += h;
      });
      closeFrame();
      y += 8;
    }

    const work = trimStr(src.workDetails);
    const workInnerW = width - padX * 2;
    if (work) {
      currentSection = "work";
      drawSectionBar("Work details");
      beginFrame();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      wrapLines(doc, work, workInnerW, true).forEach((line) => {
        ensureLine(workRowH);
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(...bodyText);
        doc.text(line, left + padX, y + 10);
        doc.setDrawColor(...ruleSoft);
        doc.setLineWidth(0.5);
        doc.line(left + padX, y + workRowH - 1, right - padX, y + workRowH - 1);
        y += workRowH;
      });
      closeFrame();
      y += 8;
    }

    const rows = [
      trimStr(src.contractTotalLabel) && src.contractTotal != null
        ? [src.contractTotalLabel, formatMoney(src.contractTotal, currency)]
        : null,
      trimStr(src.laborAmount) ? ["Labor", formatMoneyOrText(src.laborAmount, currency)] : null,
      trimStr(src.materialsAmount) ? ["Materials", formatMoneyOrText(src.materialsAmount, currency)] : null,
      src.invoiceAmount != null ? ["Invoice amount", formatMoney(src.invoiceAmount, currency)] : null,
      src.paidToDate != null ? ["Paid to date", formatMoney(src.paidToDate, currency)] : null,
      src.remainingBalance != null ? ["Remaining balance", formatMoney(src.remainingBalance, currency)] : null
    ].filter(Boolean);

    const storedInstr = trimStr(src.paymentInstructions);
    const payLine = businessName ? "Make check payable to " + businessName : "";
    const mailLine = address ? "Mail payment to: " + address : "";
    const instrHasPayable = /payable to/i.test(storedInstr);
    const instrHasMail = /mail payment to/i.test(storedInstr) || storedHasAddress(storedInstr, address);
    const instrParts = [];
    if (storedInstr) instrParts.push(storedInstr);
    if (payLine && !instrHasPayable) instrParts.push(payLine);
    if (mailLine && !instrHasMail) instrParts.push(mailLine);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    const instrLines = instrParts.map((part) => wrapLines(doc, part, workInnerW, true));

    function measureClosingHeight() {
      let h = 0;
      if (rows.length) {
        h += 8 + sectionHeadH;
        rows.forEach((_, idx) => {
          h += idx === rows.length - 1 ? ledgerLastH : ledgerRowH;
        });
      }
      if (instrParts.length) {
        h += 8 + sectionHeadH + 8;
        instrLines.forEach((lines, partIdx) => {
          if (partIdx > 0) h += 4;
          h += lines.length * workRowH;
        });
        h += 6;
      }
      return h;
    }

    currentSection = "closing";
    if (y + measureClosingHeight() > pageBottom) startNewPage();

    if (rows.length) {
      drawSectionBar("Summary");
      beginFrame();
      rows.forEach((row, idx) => {
        const isLast = idx === rows.length - 1;
        const h = isLast ? ledgerLastH : ledgerRowH;
        ensureLine(h);
        if (isLast) {
          doc.setFillColor(...lastBg);
          doc.rect(left, y, width, h, "F");
          doc.setDrawColor(...dark);
          doc.setLineWidth(1.1);
          doc.line(left, y, right, y);
        } else if (idx > 0) {
          doc.setDrawColor(...ruleSoft);
          doc.setLineWidth(0.5);
          doc.line(left + padX, y, right - padX, y);
        }
        doc.setFont("helvetica", isLast ? "bold" : "normal");
        doc.setFontSize(isLast ? 10 : 9);
        doc.setTextColor(...dark);
        doc.text(String(row[0]), left + padX, y + (isLast ? 13 : 11));
        doc.text(String(row[1]), right - padX, y + (isLast ? 13 : 11), { align: "right" });
        y += h;
      });
      closeFrame();
      y += 8;
    }

    if (instrParts.length) {
      drawSectionBar("Payment instructions");
      beginFrame();
      y += 6;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...bodyText);
      instrLines.forEach((lines, partIdx) => {
        if (partIdx > 0) y += 4;
        lines.forEach((line) => {
          ensureLine(workRowH);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(9);
          doc.setTextColor(...bodyText);
          doc.text(line, left + padX, y + 10);
          y += workRowH;
        });
      });
      y += 4;
      closeFrame();
    }

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i += 1) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text("Page " + i + " of " + pageCount, pageWidth / 2, pageHeight - 28, { align: "center" });
    }

    const base64 = doc.output("datauristring").split(",")[1];
    const safeNo = invoiceNo.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, "-") || "Invoice";
    return {
      fileName: "Invoice-" + safeNo + ".pdf",
      mimeType: "application/pdf",
      contentBase64: base64
    };
  }

  return { buildInvoicePdfPayload, formatLicenseLine };
});
