/**
 * Read-only verified contract deposit from the payment ledger.
 * Does not write invoices, payments, quotes, or projects.
 *
 * Paid is true only when tenant_project_payments has a deposit row with
 * paid_at and a positive amount. Quote acceptance, deposit_required,
 * deposit paid flags, and Contract Builder roles are not proof.
 */
"use strict";

const { supabaseRequest } = require("./supabase-admin");

function trimField(value) {
  return String(value == null ? "" : value).trim();
}

function moneyToCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function centsToNumber(cents) {
  return Math.round(Number(cents) || 0) / 100;
}

function unpaidDeposit() {
  return {
    verified_paid: false,
    amount: null,
    paid_at: null,
    source: null,
  };
}

function qualifyingDepositRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const type = trimField(row?.payment_type).toLowerCase();
    const paidAt = trimField(row?.paid_at);
    return type === "deposit" && paidAt && moneyToCents(row?.amount) > 0;
  });
}

function fromLedgerRows(rows) {
  const deposits = qualifyingDepositRows(rows);
  if (!deposits.length) return unpaidDeposit();
  let cents = 0;
  let paidAt = null;
  for (const row of deposits) {
    cents += moneyToCents(row.amount);
    const at = trimField(row.paid_at);
    if (at && (!paidAt || at > paidAt)) paidAt = at;
  }
  if (!(cents > 0)) return unpaidDeposit();
  return {
    verified_paid: true,
    amount: centsToNumber(cents),
    paid_at: paidAt,
    source: "tenant_project_payments",
  };
}

async function loadLedgerPayments(tenantId, projectId, quoteId) {
  const tid = encodeURIComponent(String(tenantId));
  const seen = new Set();
  const out = [];
  const pushRows = (rows) => {
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = String(row?.id || `${row?.invoice_id}|${row?.paid_at}|${row?.amount}`);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  };

  const select =
    "id,amount,paid_at,created_at,invoice_id,payment_type,payment_method";

  if (projectId) {
    const pid = encodeURIComponent(String(projectId));
    pushRows(
      await supabaseRequest(
        `tenant_project_payments?tenant_id=eq.${tid}&project_id=eq.${pid}` +
          `&select=${select}&order=paid_at.desc`
      )
    );
  }
  if (quoteId) {
    const qid = encodeURIComponent(String(quoteId));
    pushRows(
      await supabaseRequest(
        `tenant_project_payments?tenant_id=eq.${tid}&quote_id=eq.${qid}` +
          `&select=${select}&order=paid_at.desc`
      )
    );
  }
  return out;
}

async function resolveVerifiedContractDeposit({ tenantId, projectId, quoteId }) {
  if (!tenantId || (!projectId && !quoteId)) return unpaidDeposit();
  try {
    const rows = await loadLedgerPayments(tenantId, projectId, quoteId);
    return fromLedgerRows(rows);
  } catch (_err) {
    return unpaidDeposit();
  }
}

module.exports = {
  unpaidDeposit,
  qualifyingDepositRows,
  fromLedgerRows,
  resolveVerifiedContractDeposit,
};
