/**
 * Reported material and project-expense invoices can be added to the
 * contract balance. The contract total itself is not changed.
 */

const MARKER = "[included_in_contract_balance]";

function notesIncludeBalanceMarker(notes) {
  return String(notes || "").toLowerCase().indexOf(MARKER) >= 0;
}

function invoiceCanJoinContractBalance(row) {
  const label = String(row && row.invoice_label ? row.invoice_label : "")
    .trim()
    .toLowerCase();
  const notes = String(row && row.notes ? row.notes : "");
  const lower = notes.toLowerCase();
  if (label === "project expenses" || lower.indexOf("[invoice_type:project_expenses]") >= 0) return true;
  if (label === "material cost" || lower.indexOf("[invoice_type:unexpected_material_cost]") >= 0) return true;
  return false;
}

function notesWithBalanceMarker(notes) {
  const raw = String(notes || "").trim();
  if (notesIncludeBalanceMarker(raw)) return raw;
  return raw ? raw + "\n" + MARKER : MARKER;
}

const BILLED_ON_RE = /\[billed_on_balance_invoice:[0-9a-f-]{36}\]/i;
const CLOSED = new Set(["void", "voided", "cancelled", "canceled", "archived"]);

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function notesAlreadyBilledOnBalanceInvoice(notes) {
  return BILLED_ON_RE.test(String(notes || ""));
}

function expenseLinesFromNotes(notes) {
  const lines = [];
  let on = false;
  String(notes || "")
    .split(/\r?\n/)
    .forEach((line) => {
      const trimmed = String(line || "").trim();
      if (/^project expenses:/i.test(trimmed)) {
        on = true;
        return;
      }
      if (/^invoice total:/i.test(trimmed)) {
        on = false;
        return;
      }
      if (on && trimmed && trimmed.charAt(0) !== "[") lines.push(trimmed);
    });
  return lines;
}

function materialsReadyForInvoice(rows) {
  const lines = [];
  const ids = [];
  let amount = 0;
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    if (!row || !invoiceCanJoinContractBalance(row)) return;
    if (!notesIncludeBalanceMarker(row.notes)) return;
    if (notesAlreadyBilledOnBalanceInvoice(row.notes)) return;
    const status = String(row.status || "").trim().toLowerCase();
    if (CLOSED.has(status)) return;
    const due = money(Math.max(0, money(row.amount) - money(row.paid_amount)));
    if (!(due > 0)) return;
    amount += due;
    if (row.id) ids.push(String(row.id));
    const parsed = expenseLinesFromNotes(row.notes);
    if (parsed.length) parsed.forEach((line) => lines.push(line));
    else lines.push("Materials — $" + due.toFixed(2));
  });
  return { amount: money(amount), lines, ids };
}

function notesWithMaterials(clientNotes, materials) {
  const base = String(clientNotes || "").trim();
  if (!materials || !(Number(materials.amount) > 0)) return base;
  const block = ["Materials reported:"]
    .concat(materials.lines || [])
    .concat(["Materials on this invoice: $" + money(materials.amount).toFixed(2)])
    .join("\n");
  return base ? base + "\n\n" + block : block;
}

function notesWithBilledOn(notes, invoiceId) {
  const id = String(invoiceId || "").trim();
  const raw = String(notes || "").trim();
  if (!id || notesAlreadyBilledOnBalanceInvoice(raw)) return raw;
  const marker = "[billed_on_balance_invoice:" + id + "]";
  return raw ? raw + "\n" + marker : marker;
}

module.exports = {
  MARKER,
  notesIncludeBalanceMarker,
  invoiceCanJoinContractBalance,
  notesWithBalanceMarker,
  notesAlreadyBilledOnBalanceInvoice,
  expenseLinesFromNotes,
  materialsReadyForInvoice,
  notesWithMaterials,
  notesWithBilledOn,
};
