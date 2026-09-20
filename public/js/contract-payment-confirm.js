/**
 * Contract Builder Article 7 — payment schedule confirm decisions (browser + Node).
 *
 * Owns CTA plan, payload shape, busy lock, and persist/no-persist outcomes.
 * Does not change amounts, due rules, tenant defaults, or processed payments.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MarginGuardContractPaymentConfirm = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SCHEDULE_API = "/.netlify/functions/project-contract-payment-schedule";
  var SUM_ERROR = "Payment amounts must equal the contract total.";
  var confirmLock = false;

  function trimField(value) {
    return String(value == null ? "" : value).trim();
  }

  function moneyToCents(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  function centsToMoneyNumber(cents) {
    return Math.round(Number(cents) || 0) / 100;
  }

  function cloneItem(row) {
    var item = row || {};
    return {
      client_id: item.client_id,
      sequence_number: item.sequence_number,
      label: trimField(item.label),
      payment_type: item.payment_type,
      amount: item.amount,
      due_rule: item.due_rule,
      milestone_description: trimField(item.milestone_description),
      fixed_due_date: trimField(item.fixed_due_date).slice(0, 10),
      item_role: item.item_role,
    };
  }

  function cloneItems(items) {
    return (Array.isArray(items) ? items : []).map(cloneItem);
  }

  function computePaymentTotals(items, contractTotal) {
    var scheduledCents = cloneItems(items).reduce(function (sum, row) {
      return sum + moneyToCents(row.amount);
    }, 0);
    var contractCents = contractTotal == null || !Number.isFinite(Number(contractTotal))
      ? null
      : moneyToCents(contractTotal);
    var differenceCents = contractCents == null ? null : contractCents - scheduledCents;
    return {
      scheduled: centsToMoneyNumber(scheduledCents),
      scheduledCents: scheduledCents,
      contract: contractTotal == null ? null : Number(contractTotal),
      contractCents: contractCents,
      difference: differenceCents == null ? null : centsToMoneyNumber(differenceCents),
      differenceCents: differenceCents,
      balanced: differenceCents === 0,
    };
  }

  function paymentConfigured(scheduleBundle) {
    return String((scheduleBundle && scheduleBundle.readiness && scheduleBundle.readiness.status) || "")
      .toLowerCase() === "configured";
  }

  function paymentKind(input) {
    var src = input || {};
    var items = cloneItems(src.items);
    var confirmed = src.confirmed === true || paymentConfigured(src.scheduleBundle);
    if (confirmed) return "confirmed";
    if (!items.length) return "missing";
    var totals = computePaymentTotals(items, src.contractTotal);
    if (!totals.balanced) return "unbalanced";
    return "unconfirmed";
  }

  function paymentFooterPlan(input) {
    var src = input || {};
    var kind = paymentKind(src);
    var busy = Boolean(src.busy);
    var buttons = [];
    if (kind !== "confirmed") {
      buttons.push({
        id: "edit",
        label: "Edit Payment Schedule",
        style: kind === "unconfirmed" ? "ghost" : "primary",
        enabled: !busy,
      });
    }
    if (kind === "unconfirmed") {
      buttons.push({
        id: "confirm",
        label: "Confirm Payment Schedule",
        style: "primary",
        enabled: !busy,
      });
    }
    if (kind === "confirmed") {
      buttons.push({
        id: "continue",
        label: "Continue",
        style: "primary",
        enabled: !busy,
      });
    }
    var primaryEnabled = buttons.filter(function (btn) {
      return btn.style === "primary" && btn.enabled;
    });
    return {
      kind: kind,
      buttons: buttons,
      continueVisible: kind === "confirmed",
      continueEnabled: kind === "confirmed" && !busy,
      confirmVisible: kind === "unconfirmed",
      editStyle: kind === "unconfirmed" ? "ghost" : "primary",
      errorMessage: kind === "unbalanced" ? SUM_ERROR : "",
      confirmedLabel: kind === "confirmed" ? "Payment Schedule Confirmed" : "",
      primaryEnabledCount: primaryEnabled.length,
      primaryLabel: primaryEnabled[0] ? primaryEnabled[0].label : "",
    };
  }

  function formatAmountForApi(value) {
    var n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    var rounded = Math.round(n * 100) / 100;
    if (Math.abs(n - rounded) > 1e-9) return null;
    return rounded.toFixed(2);
  }

  function mapItemsForApi(items) {
    return cloneItems(items).map(function (row, index) {
      var item = {
        sequence_number: index + 1,
        label: trimField(row.label),
        payment_type: row.payment_type,
        amount: formatAmountForApi(row.amount),
        due_rule: row.due_rule,
        item_role: row.item_role || "future_obligation",
      };
      if (row.milestone_description) item.milestone_description = row.milestone_description;
      if (row.fixed_due_date) item.fixed_due_date = row.fixed_due_date;
      return item;
    });
  }

  function buildPaymentConfirmPayload(projectId, quoteId, items, expectedUpdatedAt) {
    var body = {
      project_id: projectId,
      quote_id: quoteId,
      items: mapItemsForApi(items),
      confirm_schedule: true,
    };
    if (expectedUpdatedAt) body.expected_updated_at = expectedUpdatedAt;
    return body;
  }

  function presentPaymentRows(items, options) {
    var opts = options || {};
    var dueFn = typeof opts.dueRuleLabel === "function" ? opts.dueRuleLabel : null;
    return cloneItems(items).map(function (item, index) {
      var due = dueFn
        ? dueFn(item.due_rule, {
            fixedDueDate: item.fixed_due_date,
            milestoneDescription: item.milestone_description,
          })
        : trimField(item.due_label);
      return {
        index: index + 1,
        name: trimField(item.label) || "Payment",
        amount: item.amount,
        due: due || "",
        due_rule: item.due_rule,
        payment_type: item.payment_type,
      };
    });
  }

  function isDepositScheduleItem(item) {
    return trimField(item && item.payment_type).toLowerCase() === "deposit";
  }

  function verifiedDepositFromServer(raw) {
    var src = raw || {};
    if (src.verified_paid !== true) return null;
    var cents = moneyToCents(src.amount);
    if (!(cents > 0)) return null;
    return {
      verified_paid: true,
      amount: centsToMoneyNumber(cents),
      paid_at: src.paid_at || null,
      source: trimField(src.source) || "tenant_project_payments",
    };
  }

  function presentPaymentSummary(input) {
    var src = input || {};
    var items = cloneItems(src.items);
    var contractCents =
      src.contractTotal == null || !Number.isFinite(Number(src.contractTotal))
        ? null
        : moneyToCents(src.contractTotal);
    var verified = verifiedDepositFromServer(src.verifiedDeposit);
    var verifiedCents = verified ? moneyToCents(verified.amount) : 0;
    var remainingCents = contractCents == null ? null : contractCents - verifiedCents;

    var depositItem = null;
    for (var i = 0; i < items.length; i += 1) {
      if (isDepositScheduleItem(items[i])) {
        depositItem = items[i];
        break;
      }
    }
    var plannedDepositCents = depositItem
      ? moneyToCents(depositItem.amount)
      : moneyToCents(src.depositRequired);
    if (plannedDepositCents < 0) plannedDepositCents = 0;

    var depositStatus = "none";
    var depositAmount = null;
    if (verified) {
      depositStatus = "paid";
      depositAmount = verified.amount;
    } else if (plannedDepositCents > 0) {
      depositStatus = "due";
      depositAmount = centsToMoneyNumber(plannedDepositCents);
    }

    var remainingSource = verified
      ? items.filter(function (item) {
          return !isDepositScheduleItem(item);
        })
      : items;
    var remainingRows = presentPaymentRows(remainingSource, src);
    var remainingSumCents = remainingSource.reduce(function (sum, item) {
      return sum + moneyToCents(item.amount);
    }, 0);

    return {
      contractTotal:
        contractCents == null ? null : centsToMoneyNumber(contractCents),
      depositStatus: depositStatus,
      depositLabel:
        depositStatus === "paid"
          ? "Deposit Paid"
          : depositStatus === "due"
            ? "Deposit Due"
            : "",
      depositAmount: depositAmount,
      depositMinus: depositStatus === "paid",
      remainingBalance:
        remainingCents == null ? null : centsToMoneyNumber(remainingCents),
      appliedCopy:
        depositStatus === "paid"
          ? "The deposit has been received and applied to the contract total."
          : "",
      remainingItems: remainingRows,
      remainingSumMatches:
        remainingCents != null && remainingSumCents === remainingCents,
      verifiedPaid: Boolean(verified),
    };
  }

  function itemsMatchSource(payloadItems, sourceItems) {
    var src = cloneItems(sourceItems);
    var out = Array.isArray(payloadItems) ? payloadItems : [];
    if (out.length !== src.length) return false;
    for (var i = 0; i < src.length; i += 1) {
      if (trimField(out[i].label) !== trimField(src[i].label)) return false;
      if (String(out[i].due_rule) !== String(src[i].due_rule)) return false;
      if (moneyToCents(out[i].amount) !== moneyToCents(src[i].amount)) return false;
    }
    return true;
  }

  function createPaymentConfirmRunner(hooks) {
    var h = hooks || {};

    function tryLock() {
      if (confirmLock) return false;
      if (typeof h.getBusy === "function" && h.getBusy()) return false;
      confirmLock = true;
      if (typeof h.setBusy === "function") h.setBusy(true);
      return true;
    }

    function unlock() {
      confirmLock = false;
      if (typeof h.setBusy === "function") h.setBusy(false);
    }

    async function confirm() {
      if (!tryLock()) {
        return { ok: false, reason: "busy", posted: false, advance: false };
      }
      try {
        if (typeof h.isConfirmed === "function" && h.isConfirmed()) {
          return { ok: true, reason: "already_confirmed", posted: false, advance: false };
        }
        var items = typeof h.getItems === "function" ? cloneItems(h.getItems()) : [];
        var contractTotal = typeof h.getContractTotal === "function" ? h.getContractTotal() : null;
        var kind = paymentKind({ items: items, contractTotal: contractTotal });
        if (kind === "missing") {
          return { ok: false, reason: "missing", posted: false, advance: false, openEdit: true };
        }
        if (kind === "unbalanced") {
          return {
            ok: false,
            reason: "unbalanced",
            posted: false,
            advance: false,
            openEdit: true,
            error: SUM_ERROR,
            items: items,
          };
        }
        for (var i = 0; i < items.length; i += 1) {
          if (!trimField(items[i].label)) {
            return {
              ok: false,
              reason: "incomplete",
              posted: false,
              advance: false,
              openEdit: true,
              items: items,
            };
          }
          if (formatAmountForApi(items[i].amount) == null) {
            return {
              ok: false,
              reason: "incomplete",
              posted: false,
              advance: false,
              openEdit: true,
              items: items,
            };
          }
        }
        var ids = typeof h.getIds === "function" ? h.getIds() : {};
        var expectedUpdatedAt = typeof h.getExpectedUpdatedAt === "function" ? h.getExpectedUpdatedAt() : null;
        var payload = buildPaymentConfirmPayload(ids.projectId, ids.quoteId, items, expectedUpdatedAt);
        if (!itemsMatchSource(payload.items, items)) {
          return {
            ok: false,
            reason: "mutated",
            posted: false,
            advance: false,
            items: items,
          };
        }
        if (typeof h.postJson !== "function") {
          throw new Error("postJson is required to confirm a payment schedule.");
        }
        var res = await h.postJson(h.apiUrl || SCHEDULE_API, payload);
        if (!res || res.ok !== true || !res.data || res.data.ok !== true) {
          return {
            ok: false,
            reason: "http",
            posted: true,
            advance: false,
            payload: payload,
            items: items,
            error: trimField(res && res.data && res.data.error) || "Payment schedule could not be confirmed.",
            status: res && res.status,
          };
        }
        if (typeof h.applySuccess === "function") {
          h.applySuccess(res.data, payload);
        }
        return {
          ok: true,
          reason: "confirmed",
          posted: true,
          advance: true,
          payload: payload,
          schedule: res.data.schedule || null,
          items: res.data.items || payload.items,
          readiness: res.data.readiness || null,
        };
      } finally {
        unlock();
      }
    }

    return {
      confirm: confirm,
      isLocked: function () {
        return confirmLock;
      },
    };
  }

  return {
    SCHEDULE_API: SCHEDULE_API,
    SUM_ERROR: SUM_ERROR,
    moneyToCents: moneyToCents,
    computePaymentTotals: computePaymentTotals,
    paymentConfigured: paymentConfigured,
    paymentKind: paymentKind,
    paymentFooterPlan: paymentFooterPlan,
    formatAmountForApi: formatAmountForApi,
    mapItemsForApi: mapItemsForApi,
    buildPaymentConfirmPayload: buildPaymentConfirmPayload,
    presentPaymentRows: presentPaymentRows,
    presentPaymentSummary: presentPaymentSummary,
    verifiedDepositFromServer: verifiedDepositFromServer,
    isDepositScheduleItem: isDepositScheduleItem,
    itemsMatchSource: itemsMatchSource,
    createPaymentConfirmRunner: createPaymentConfirmRunner,
    cloneItems: cloneItems,
  };
});
