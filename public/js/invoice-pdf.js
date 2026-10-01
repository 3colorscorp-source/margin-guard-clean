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

  function wrapLines(doc, text, maxWidth) {
    const raw = trimStr(text);
    if (!raw) return [];
    const paragraphs = raw.split(/\n+/);
    const out = [];
    paragraphs.forEach((p) => {
      const wrapped = doc.splitTextToSize(p, maxWidth);
      wrapped.forEach((line) => out.push(line));
      out.push("");
    });
    while (out.length && !out[out.length - 1]) out.pop();
    return out;
  }

  async function buildInvoicePdfPayload(data) {
    const jspdf = typeof window !== "undefined" ? window.jspdf : null;
    if (!jspdf || !jspdf.jsPDF) return null;
    const src = data && typeof data === "object" ? data : {};
    const doc = new jspdf.jsPDF({ unit: "pt", format: "letter" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const left = 48;
    const right = pageWidth - 48;
    const width = right - left;
    let y = 56;
    const dark = [17, 24, 39];
    const muted = [107, 114, 128];

    const businessName = trimStr(src.businessName);
    const serviceLine = trimStr(src.serviceLine);
    const license = formatLicenseLine(src.licenseNumber);
    const phone = trimStr(src.phone);
    const email = trimStr(src.email);
    const address = trimStr(src.address);
    const invoiceNo = trimStr(src.invoiceNo) || "Invoice";
    const currency = trimStr(src.currency);

    if (businessName) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(18);
      doc.setTextColor(...dark);
      doc.text(businessName, left, y);
      y += 20;
    }
    if (serviceLine) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(11);
      doc.setTextColor(...muted);
      doc.text(serviceLine, left, y);
      y += 16;
    }
    const letterhead = [];
    if (license) letterhead.push(license);
    if (phone) letterhead.push("Phone: " + phone);
    if (email) letterhead.push("Email: " + email);
    if (address) letterhead.push("Address: " + address);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(...dark);
    letterhead.forEach((line) => {
      doc.text(line, left, y);
      y += 13;
    });
    y += 10;
    doc.setDrawColor(229, 231, 235);
    doc.setLineWidth(1);
    doc.line(left, y, right, y);
    y += 22;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(...dark);
    doc.text("Invoice " + invoiceNo, left, y);
    y += 20;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    const meta = [
      trimStr(src.customerName) ? "Customer: " + trimStr(src.customerName) : "",
      trimStr(src.customerEmail) ? "Email: " + trimStr(src.customerEmail) : "",
      trimStr(src.projectName) ? "Project: " + trimStr(src.projectName) : "",
      trimStr(src.issueDate) ? "Issue date: " + trimStr(src.issueDate) : "",
      trimStr(src.dueDate) ? "Due date: " + trimStr(src.dueDate) : ""
    ].filter(Boolean);
    meta.forEach((line) => {
      doc.text(line, left, y);
      y += 14;
    });
    y += 10;

    const work = trimStr(src.workDetails);
    if (work) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text("Work details", left, y);
      y += 14;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      wrapLines(doc, work, width).forEach((line) => {
        if (y > 720) {
          doc.addPage();
          y = 56;
        }
        doc.text(line, left, y);
        y += 13;
      });
      y += 8;
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

    if (rows.length) {
      if (y > 640) {
        doc.addPage();
        y = 56;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.text("Summary", left, y);
      y += 16;
      rows.forEach((row, idx) => {
        const isLast = idx === rows.length - 1;
        doc.setFont("helvetica", isLast ? "bold" : "normal");
        doc.setFontSize(isLast ? 12 : 10);
        doc.text(String(row[0]), left, y);
        doc.text(String(row[1]), right, y, { align: "right" });
        y += 16;
      });
    }

    if (businessName) {
      if (y > 640) {
        doc.addPage();
        y = 56;
      } else {
        y += 12;
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(10);
      doc.setTextColor(...dark);
      doc.text("Payment instructions", left, y);
      y += 16;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      wrapLines(doc, "Make check payable to " + businessName, width).forEach((line) => {
        if (y > 720) {
          doc.addPage();
          y = 56;
        }
        doc.text(line, left, y);
        y += 13;
      });
      if (address) {
        y += 4;
        wrapLines(doc, "Mail payment to: " + address, width).forEach((line) => {
          if (y > 720) {
            doc.addPage();
            y = 56;
          }
          doc.text(line, left, y);
          y += 13;
        });
      }
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
