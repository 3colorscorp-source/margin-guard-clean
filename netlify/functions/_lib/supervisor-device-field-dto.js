/**
 * Sanitized supervisor device field DTOs — no tenant/auth/raw row linkage.
 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v, max = 8000) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}

function optionalDayNumber(row) {
  if (!row || row.day_number == null || row.day_number === "") return null;
  const dn = Math.max(1, Math.floor(Number(row.day_number) || 0));
  return dn >= 1 ? dn : null;
}

function mapDeviceReportRow(row) {
  if (!row || typeof row !== "object") return null;
  const out = {
    entry_date: row.entry_date == null ? null : String(row.entry_date).slice(0, 10),
    hours: num(row.hours, 0),
    days: num(row.days, 0),
    note: row.note == null ? "" : String(row.note),
  };
  const dayNumber = optionalDayNumber(row);
  if (dayNumber != null) out.day_number = dayNumber;
  const phase = str(row.phase, 500);
  if (phase) out.phase = phase;
  return out;
}

function mapDeviceExpenseRow(row) {
  if (!row || typeof row !== "object") return null;
  const out = {
    expense_date: row.expense_date == null ? null : String(row.expense_date).slice(0, 10),
    amount: num(row.amount, 0),
    note: row.note == null ? "" : String(row.note),
  };
  const dayNumber = optionalDayNumber(row);
  if (dayNumber != null) out.day_number = dayNumber;
  const phase = str(row.phase, 500);
  if (phase) out.phase = phase;
  return out;
}

function mapDeviceDayProgressWriteResult(result) {
  if (!result || typeof result !== "object") return { ok: true };
  const out = { ok: true };
  const dayNumber = Math.max(1, Math.floor(num(result.day_number, 0)));
  if (dayNumber >= 1) out.day_number = dayNumber;
  if (result.already_completed === true) out.already_completed = true;
  else if (result.already_completed === false) out.already_completed = false;
  return out;
}

function mapDeviceReportList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(mapDeviceReportRow).filter(Boolean);
}

function mapDeviceExpenseList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(mapDeviceExpenseRow).filter(Boolean);
}

module.exports = {
  mapDeviceDayProgressWriteResult,
  mapDeviceExpenseList,
  mapDeviceExpenseRow,
  mapDeviceReportList,
  mapDeviceReportRow,
};
