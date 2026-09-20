/**
 * Read-only verified contract deposit from the payment ledger.
 * Does not write invoices, payments, quotes, or projects.
 *
 * Paid is true only when tenant_project_payments has deposit rows scoped to
 * tenant + project + quote, with paid_at, and a positive net amount after
 * same-scope adjustments.
 *
 * Ledger SoT (SUPABASE_TENANT_PROJECT_PAYMENTS.sql):
 *   payment_type in (deposit, progress, final, adjustment)
 *   amount <> 0 (numeric dollars)
 *   paid_at required
 * There is no voided_at, refunded_at, reversed_at, cancelled_at, status, or
 * payment_status on this table. Refunds/voids/reversals are additional rows:
 * payment_type = adjustment with a negative amount. Notes are not authority.
 *
 * Quote acceptance, deposit_required, deposit paid flags, and Contract Builder
 * roles are not proof.
 */
"use strict";

const { supabaseRequest } = require("./supabase-admin");

const DEPOSIT_UNAVAILABLE_MESSAGE =
  "Deposit status could not be verified. Refresh before confirming.";
const DEPOSIT_INCONSISTENT_MESSAGE =
  "Verified deposit exceeds the contract total. Refresh before confirming.";
const LEDGER_COLUMNS = Object.freeze([
  "id",
  "amount",
  "paid_at",
  "created_at",
  "invoice_id",
  "quote_id",
  "project_id",
  "tenant_id",
  "payment_type",
  "payment_method",
  "notes",
]);
const LEDGER_SELECT = LEDGER_COLUMNS.join(",");
const INVENTED_LEDGER_COLUMNS = Object.freeze([
  "voided_at",
  "refunded_at",
  "reversed_at",
  "cancelled_at",
  "status",
  "payment_status",
]);

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

function noneDeposit(meta) {
  return {
    status: "none",
    verified_paid: false,
    amount: null,
    paid_at: null,
    source: null,
    quote_id: meta?.quoteId || null,
    project_id: meta?.projectId || null,
    scope: meta?.scope || null,
  };
}

function unpaidDeposit() {
  return noneDeposit();
}

function unavailableDeposit(meta) {
  return {
    status: "verification_unavailable",
    verified_paid: false,
    amount: null,
    paid_at: null,
    source: null,
    quote_id: meta?.quoteId || null,
    project_id: meta?.projectId || null,
    scope: meta?.scope || null,
    error: DEPOSIT_UNAVAILABLE_MESSAGE,
  };
}

function inconsistentDeposit({ amount, paidAt, quoteId, projectId, scope, contractTotal }) {
  return {
    status: "inconsistent",
    verified_paid: false,
    amount,
    paid_at: paidAt || null,
    source: "tenant_project_payments",
    quote_id: quoteId || null,
    project_id: projectId || null,
    scope: scope || null,
    contract_total: contractTotal,
    error: DEPOSIT_INCONSISTENT_MESSAGE,
  };
}

function paidDeposit({ amount, paidAt, quoteId, projectId, scope }) {
  return {
    status: "paid",
    verified_paid: true,
    amount,
    paid_at: paidAt || null,
    source: "tenant_project_payments",
    quote_id: quoteId || null,
    project_id: projectId || null,
    scope: scope || null,
  };
}

function scopedDepositRequestPath({ tenantId, projectId, quoteId }) {
  const tid = encodeURIComponent(String(tenantId));
  const pid = encodeURIComponent(String(projectId));
  const qid = encodeURIComponent(String(quoteId));
  return (
    `tenant_project_payments?tenant_id=eq.${tid}` +
    `&project_id=eq.${pid}` +
    `&quote_id=eq.${qid}` +
    `&select=${LEDGER_SELECT}` +
    `&order=paid_at.desc`
  );
}

function legacyNullQuoteRequestPath({ tenantId, projectId }) {
  const tid = encodeURIComponent(String(tenantId));
  const pid = encodeURIComponent(String(projectId));
  return (
    `tenant_project_payments?tenant_id=eq.${tid}` +
    `&project_id=eq.${pid}` +
    `&quote_id=is.null` +
    `&select=${LEDGER_SELECT}` +
    `&order=paid_at.desc`
  );
}

function rowDedupeKey(row) {
  if (row && row.id != null && String(row.id).trim()) {
    return `id:${String(row.id).trim()}`;
  }
  return (
    `inv:${trimField(row?.invoice_id)}|at:${trimField(row?.paid_at)}` +
    `|amt:${row?.amount}|type:${trimField(row?.payment_type).toLowerCase()}`
  );
}

function dedupeLedgerRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = rowDedupeKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function rowsInContractScope(rows, { tenantId, projectId, quoteId, allowNullQuoteId } = {}) {
  const tid = trimField(tenantId);
  const pid = trimField(projectId);
  const qid = trimField(quoteId);
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (tid && trimField(row?.tenant_id) && trimField(row?.tenant_id) !== tid) return false;
    if (pid && trimField(row?.project_id) && trimField(row?.project_id) !== pid) return false;
    if (qid) {
      const rowQuote = trimField(row?.quote_id);
      if (rowQuote && rowQuote !== qid) return false;
      if (!rowQuote && !allowNullQuoteId) return false;
    }
    return true;
  });
}

function isLegacyProjectDepositUnique({
  targetQuoteId,
  projectQuoteId,
  paymentQuoteIds,
} = {}) {
  const target = trimField(targetQuoteId);
  const projectQuote = trimField(projectQuoteId);
  const ids = [
    ...new Set(
      (Array.isArray(paymentQuoteIds) ? paymentQuoteIds : [])
        .map((id) => trimField(id))
        .filter(Boolean)
    ),
  ];
  if (ids.length > 1) return false;
  if (target) {
    if (ids.length === 1 && ids[0] !== target) return false;
    if (projectQuote && projectQuote !== target) return false;
    if (projectQuote === target && ids.length <= 1) return true;
    if (!projectQuote && ids.length === 1 && ids[0] === target) return true;
    return false;
  }
  if (projectQuote && (ids.length === 0 || (ids.length === 1 && ids[0] === projectQuote))) {
    return true;
  }
  if (!projectQuote && ids.length === 1) return true;
  return false;
}

function netDepositFromRows(rows) {
  let cents = 0;
  let paidAt = null;
  for (const row of rows) {
    const type = trimField(row?.payment_type).toLowerCase();
    const amountCents = moneyToCents(row?.amount);
    const at = trimField(row?.paid_at);
    if (type === "deposit") {
      if (!at) continue;
      cents += amountCents;
      if (amountCents > 0 && (!paidAt || at > paidAt)) paidAt = at;
      continue;
    }
    if (type === "adjustment") {
      cents += amountCents;
    }
  }
  return { cents, paidAt };
}

function fromLedgerRows(rows, options) {
  const opts = options || {};
  const scoped = dedupeLedgerRows(
    rowsInContractScope(rows, {
      tenantId: opts.tenantId,
      projectId: opts.projectId,
      quoteId: opts.quoteId,
      allowNullQuoteId: opts.allowNullQuoteId === true,
    })
  );
  const { cents, paidAt } = netDepositFromRows(scoped);
  const meta = {
    quoteId: opts.quoteId || null,
    projectId: opts.projectId || null,
    scope: opts.scope || (opts.quoteId ? "tenant_project_quote" : null),
  };
  if (!(cents > 0)) return noneDeposit(meta);
  const amount = centsToNumber(cents);
  const contractTotal =
    opts.contractTotal == null || !Number.isFinite(Number(opts.contractTotal))
      ? null
      : Number(opts.contractTotal);
  if (contractTotal != null && cents > moneyToCents(contractTotal)) {
    return inconsistentDeposit({
      amount,
      paidAt,
      quoteId: meta.quoteId,
      projectId: meta.projectId,
      scope: meta.scope,
      contractTotal,
    });
  }
  return paidDeposit({
    amount,
    paidAt,
    quoteId: meta.quoteId,
    projectId: meta.projectId,
    scope: meta.scope,
  });
}

function qualifyingDepositRows(rows, options) {
  return dedupeLedgerRows(rowsInContractScope(rows, options)).filter((row) => {
    const type = trimField(row?.payment_type).toLowerCase();
    const paidAt = trimField(row?.paid_at);
    return type === "deposit" && paidAt && moneyToCents(row?.amount) > 0;
  });
}

function depositBlocksConfirm(deposit) {
  const status = trimField(deposit?.status).toLowerCase();
  return status === "verification_unavailable" || status === "inconsistent";
}

function depositBlocksFreeze(deposit) {
  return depositBlocksConfirm(deposit);
}

function assertDepositReadyForFreeze(deposit) {
  const status = trimField(deposit?.status).toLowerCase();
  if (status === "verification_unavailable" || !deposit) {
    return {
      ok: false,
      error: DEPOSIT_UNAVAILABLE_MESSAGE,
      code: "deposit_verification_unavailable",
      status: 422,
    };
  }
  if (status === "inconsistent") {
    return {
      ok: false,
      error: trimField(deposit.error) || DEPOSIT_INCONSISTENT_MESSAGE,
      code: "deposit_inconsistent",
      status: 422,
    };
  }
  return { ok: true };
}

function serializeDepositForSnapshot(deposit, quoteId) {
  const src = deposit && typeof deposit === "object" ? deposit : noneDeposit({ quoteId });
  const status = trimField(src.status).toLowerCase();
  if (status === "verification_unavailable") {
    return {
      status: "verification_unavailable",
      verified_paid: false,
      amount: null,
      paid_at: null,
      source: null,
      quote_id: src.quote_id || quoteId || null,
    };
  }
  const paid = status === "paid" && src.verified_paid === true;
  return {
    status: paid ? "paid" : status === "inconsistent" ? "inconsistent" : "none",
    verified_paid: paid,
    amount: paid ? src.amount : null,
    paid_at: paid ? src.paid_at : null,
    source: paid ? src.source || "tenant_project_payments" : null,
    quote_id: src.quote_id || quoteId || null,
  };
}

async function proveLegacyUnique({ tenantId, projectId, quoteId, request }) {
  const tid = encodeURIComponent(String(tenantId));
  const pid = encodeURIComponent(String(projectId));
  const projects = await request(
    `tenant_projects?id=eq.${pid}&tenant_id=eq.${tid}&select=id,quote_id&limit=1`
  );
  const projectQuoteId = trimField(Array.isArray(projects) && projects[0] ? projects[0].quote_id : "");
  const paymentQuoteRows = await request(
    `tenant_project_payments?tenant_id=eq.${tid}&project_id=eq.${pid}` +
      `&quote_id=not.is.null&select=quote_id`
  );
  const paymentQuoteIds = (Array.isArray(paymentQuoteRows) ? paymentQuoteRows : []).map(
    (row) => row?.quote_id
  );
  return {
    unique: isLegacyProjectDepositUnique({
      targetQuoteId: quoteId,
      projectQuoteId,
      paymentQuoteIds,
    }),
    quoteId: trimField(quoteId) || projectQuoteId || trimField(paymentQuoteIds[0]) || null,
  };
}

async function resolveVerifiedContractDeposit(input, deps) {
  const tenantId = trimField(input?.tenantId);
  const projectId = trimField(input?.projectId);
  const quoteId = trimField(input?.quoteId);
  const contractTotal = input?.contractTotal;
  const request = deps && typeof deps.request === "function" ? deps.request : supabaseRequest;

  if (!tenantId) return unavailableDeposit({ quoteId, projectId });
  if (!projectId && !quoteId) return noneDeposit({ quoteId, projectId });

  try {
    if (quoteId && projectId) {
      const scoped = await request(
        scopedDepositRequestPath({ tenantId, projectId, quoteId })
      );
      const scopedResult = fromLedgerRows(scoped, {
        tenantId,
        projectId,
        quoteId,
        contractTotal,
        scope: "tenant_project_quote",
      });
      if (scopedResult.status === "paid" || scopedResult.status === "inconsistent") {
        return scopedResult;
      }

      let uniqueness;
      try {
        uniqueness = await proveLegacyUnique({
          tenantId,
          projectId,
          quoteId,
          request,
        });
      } catch (_err) {
        return unavailableDeposit({ quoteId, projectId });
      }
      if (!uniqueness.unique) {
        return noneDeposit({
          quoteId,
          projectId,
          scope: "tenant_project_quote",
        });
      }
      const legacy = await request(legacyNullQuoteRequestPath({ tenantId, projectId }));
      return fromLedgerRows(legacy, {
        tenantId,
        projectId,
        quoteId,
        contractTotal,
        allowNullQuoteId: true,
        scope: "legacy_project_unique",
      });
    }

    if (projectId && !quoteId) {
      let uniqueness;
      try {
        uniqueness = await proveLegacyUnique({
          tenantId,
          projectId,
          quoteId: null,
          request,
        });
      } catch (_err) {
        return unavailableDeposit({ projectId });
      }
      if (!uniqueness.unique) {
        return noneDeposit({ projectId, scope: "ambiguous" });
      }
      const legacy = await request(legacyNullQuoteRequestPath({ tenantId, projectId }));
      return fromLedgerRows(legacy, {
        tenantId,
        projectId,
        quoteId: uniqueness.quoteId || null,
        contractTotal,
        allowNullQuoteId: true,
        scope: "legacy_project_unique",
      });
    }

    return unavailableDeposit({ quoteId, projectId });
  } catch (_err) {
    return unavailableDeposit({ quoteId, projectId });
  }
}

module.exports = {
  DEPOSIT_UNAVAILABLE_MESSAGE,
  DEPOSIT_INCONSISTENT_MESSAGE,
  LEDGER_COLUMNS,
  LEDGER_SELECT,
  INVENTED_LEDGER_COLUMNS,
  unpaidDeposit,
  noneDeposit,
  unavailableDeposit,
  qualifyingDepositRows,
  fromLedgerRows,
  rowsInContractScope,
  isLegacyProjectDepositUnique,
  scopedDepositRequestPath,
  legacyNullQuoteRequestPath,
  serializeDepositForSnapshot,
  depositBlocksConfirm,
  depositBlocksFreeze,
  assertDepositReadyForFreeze,
  resolveVerifiedContractDeposit,
};
