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

module.exports = {
  MARKER,
  notesIncludeBalanceMarker,
  invoiceCanJoinContractBalance,
  notesWithBalanceMarker,
};
