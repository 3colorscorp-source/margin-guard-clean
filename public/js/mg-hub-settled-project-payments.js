/**
 * Invoice Hub: leftover remaining-balance / draft invoices on a job whose
 * contract is already paid must not stay collectible.
 *
 * Browser: window.MGHubSettledProjectPayments
 * Node tests: require this file.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.MGHubSettledProjectPayments = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STAGE_CHILD_LABELS = new Set([
    "remaining balance",
    "final payment",
    "progress payment",
    "start payment"
  ]);
  const EXTRA_LABELS = new Set(["material cost", "change order"]);

  function finiteMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  }

  function normText(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[.\s]+$/g, "")
      .replace(/\s+/g, " ");
  }

  function labelOf(row) {
    return String(row?.invoiceLabel || "").trim().toLowerCase();
  }

  function isExtraBilling(row) {
    return EXTRA_LABELS.has(labelOf(row));
  }

  function isStageChild(row) {
    if (row?.sourceInvoiceId) return true;
    return STAGE_CHILD_LABELS.has(labelOf(row));
  }

  function isPaidSettled(row) {
    const st = String(row?.status || "").toLowerCase();
    const bal = finiteMoney(row?.balance);
    return (st === "paid" || st === "completed") && bal <= 0.005;
  }

  function isPaidContractLike(row) {
    if (!isPaidSettled(row)) return false;
    if (isExtraBilling(row)) return false;
    if (STAGE_CHILD_LABELS.has(labelOf(row))) return false;
    return true;
  }

  function isDraftLeftover(row) {
    const st = String(row?.status || "").toLowerCase();
    const raw = String(row?.rawStatus || st).toLowerCase();
    return st === "draft" || raw === "draft" || raw === "open";
  }

  function clusterKeys(row) {
    const keys = [];
    const id = String(row?.id || "").trim().toLowerCase();
    if (id) keys.push("id:" + id);
    const src = String(row?.sourceInvoiceId || "").trim().toLowerCase();
    if (src) keys.push("id:" + src);
    const pid = String(row?.projectId || "").trim().toLowerCase();
    if (pid) keys.push("p:" + pid);
    const qid = String(row?.quoteId || "").trim().toLowerCase();
    if (qid) keys.push("q:" + qid);
    const who = normText(row?.customerEmail) || normText(row?.customer);
    const title = normText(row?.title);
    if (who && title) keys.push("n:" + who + "|" + title);
    if (!keys.length) keys.push("i:" + String(row?.id || ""));
    return keys;
  }

  function clusterKey(row) {
    return clusterKeys(row)[0] || "";
  }

  function groupedMembers(rows) {
    const parent = new Map();
    const find = (x) => {
      const p = parent.get(x) || x;
      if (p !== x) {
        const r = find(p);
        parent.set(x, r);
        return r;
      }
      return x;
    };
    const unite = (a, b) => {
      const pa = find(a);
      const pb = find(b);
      if (pa !== pb) parent.set(pa, pb);
    };
    rows.forEach((row, idx) => {
      const self = "r:" + idx;
      parent.set(self, self);
      clusterKeys(row).forEach((key) => {
        if (!parent.has(key)) parent.set(key, key);
        unite(self, key);
      });
    });
    const groups = new Map();
    rows.forEach((row, idx) => {
      const root = find("r:" + idx);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(row);
    });
    return Array.from(groups.values());
  }

  function shouldSettleMember(row, folderHasPaidContract) {
    if (!folderHasPaidContract) return false;
    if (isPaidContractLike(row)) return false;
    if (isExtraBilling(row)) return false;
    if (isStageChild(row)) return true;
    if (isDraftLeftover(row)) return true;
    return false;
  }

  function idsToSettle(rows) {
    const list = Array.isArray(rows) ? rows.filter((row) => row && row.id) : [];
    const out = new Set();
    groupedMembers(list).forEach((members) => {
      const folderHasPaidContract = members.some((row) => isPaidContractLike(row));
      if (!folderHasPaidContract) return;
      members.forEach((row) => {
        if (shouldSettleMember(row, true)) out.add(String(row.id));
      });
    });
    return out;
  }

  return {
    STAGE_CHILD_LABELS,
    EXTRA_LABELS,
    finiteMoney,
    clusterKey,
    isExtraBilling,
    isStageChild,
    isPaidContractLike,
    shouldSettleMember,
    idsToSettle
  };
});
