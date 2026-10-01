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
    let y = headerTop;
    let currentSection = "header";
    const dark = [17, 24, 39];
    const muted = [107, 114, 128];
    const lineGray = [229, 231, 235];

    const businessName = trimStr(src.businessName);
    const serviceLine = trimStr(src.serviceLine);
    const license = formatLicenseLine(src.licenseNumber);
    const phone = trimStr(src.phone);
    const email = trimStr(src.email);
    const address = trimStr(src.address);
    const invoiceNo = trimStr(src.invoiceNo) || "Invoice";
    const currency = trimStr(src.currency);
    const dueAmount = src.remainingBalance != null ? src.remainingBalance : src.invoiceAmount;

    function drawRule(atY) {
      doc.setDrawColor(...lineGray);
      doc.setLineWidth(1);
      doc.line(left, atY, right, atY);
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
      y += 14;
      if (currentSection === "work") {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(...muted);
        doc.text("Work details (continued)", left, y);
        y += 14;
        doc.setTextColor(...dark);
      }
    }

    function startNewPage() {
      doc.addPage();
      y = headerTop;
      drawContinuationHeader();
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

    let rightY = headerTop;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.setTextColor(...dark);
    doc.text("INVOICE", right, rightY, { align: "right" });
    rightY += 20;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.text("Invoice #  " + invoiceNo, right, rightY, { align: "right" });
    rightY += 12;
    if (trimStr(src.issueDate)) {
      doc.text("Issue date  " + trimStr(src.issueDate), right, rightY, { align: "right" });
      rightY += 12;
    }
    if (trimStr(src.dueDate)) {
      doc.text("Due date  " + trimStr(src.dueDate), right, rightY, { align: "right" });
      rightY += 12;
    }
    if (dueAmount != null) {
      rightY += 6;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text("Amount due", right, rightY, { align: "right" });
      rightY += 14;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(13);
      doc.setTextColor(...dark);
      doc.text(formatMoney(dueAmount, currency), right, rightY, { align: "right" });
      rightY += 8;
    }

    y = Math.max(leftY, rightY) + 10;
    drawRule(y);
    y += 16;

    const billName = trimStr(src.customerName);
    const billEmail = trimStr(src.customerEmail);
    const billProject = trimStr(src.projectName);
    if (billName || billEmail || billProject) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text("Bill to", left, y);
      y += 12;
      doc.setTextColor(...dark);
      if (billName) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        doc.text(billName, left, y);
        y += 12;
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      if (billEmail) {
        doc.text(billEmail, left, y);
        y += 11;
      }
      if (billProject) {
        doc.text(billProject, left, y);
        y += 11;
      }
      y += 8;
    }

    const work = trimStr(src.workDetails);
    if (work) {
      currentSection = "work";
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text("Work details", left, y);
      y += 6;
      drawRule(y);
      y += 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...dark);
      wrapLines(doc, work, width, true).forEach((line) => {
        ensureLine(11);
        doc.text(line, left, y);
        y += 11;
      });
      y += 10;
    }

    const rows = [
      trimStr(src.contractTotalLabel) && src.contractTotal != null
        ? [src.contractTotalLabel, formatMoney(src.contractTotal, currency)]
        : null,
      trimStr(src.laborAmount) ? ["Labor", trimStr(src.laborAmount)] : null,
      trimStr(src.materialsAmount) ? ["Materials", trimStr(src.materialsAmount)] : null,
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
    const instrLines = instrParts.map((part) => wrapLines(doc, part, width, true));

    function measureClosingHeight() {
      let h = 0;
      if (rows.length) {
        h += 8;
        rows.forEach((_, idx) => {
          h += idx === rows.length - 1 ? 16 : 13;
        });
        h += 8;
      }
      if (instrParts.length) {
        h += 20;
        instrLines.forEach((lines, partIdx) => {
          if (partIdx > 0) h += 4;
          h += lines.length * 11;
        });
      }
      return h;
    }

    currentSection = "closing";
    if (y + measureClosingHeight() > pageBottom) startNewPage();

    if (rows.length) {
      const labelX = right - 220;
      rows.forEach((row, idx) => {
        const isLast = idx === rows.length - 1;
        if (isLast) {
          y += 4;
          doc.setDrawColor(...lineGray);
          doc.setLineWidth(1);
          doc.line(labelX, y, right, y);
          y += 12;
        }
        doc.setFont("helvetica", isLast ? "bold" : "normal");
        doc.setFontSize(isLast ? 10 : 9);
        doc.setTextColor(...dark);
        doc.text(String(row[0]), labelX, y);
        doc.text(String(row[1]), right, y, { align: "right" });
        y += isLast ? 16 : 13;
      });
    }

    if (instrParts.length) {
      y += 8;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(...muted);
      doc.text("Payment instructions", left, y);
      y += 6;
      drawRule(y);
      y += 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...dark);
      instrLines.forEach((lines, partIdx) => {
        if (partIdx > 0) y += 4;
        lines.forEach((line) => {
          ensureLine(11);
          doc.text(line, left, y);
          y += 11;
        });
      });
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
