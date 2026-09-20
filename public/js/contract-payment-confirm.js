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
  var DEPOSIT_UNAVAILABLE_MESSAGE =
    "Deposit status could not be verified. Refresh before confirming.";
  var DEPOSIT_INCONSISTENT_MESSAGE =
    "Verified deposit exceeds the contract total. Refresh before confirming.";
  var SCHEDULE_MISMATCH_MESSAGE =
    "Future payments do not equal the remaining contract balance. Edit the payment schedule before confirming.";
  var INVOICE_CADENCE_COPY =
    "The remaining balance is billed every two weeks based on progress, or at completion if the project is finished sooner.";
  var PROGRESS_INVOICE_COPY = INVOICE_CADENCE_COPY;
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
    var summary = presentPaymentSummary({
      items: src.items,
      contractTotal: src.contractTotal,
      verifiedDeposit: src.verifiedDeposit || (src.scheduleBundle && src.scheduleBundle.deposit),
      depositRequired: src.depositRequired,
    });
    var depositBlocked = summary.blockConfirm === true;
    var confirmEnabled = kind === "unconfirmed" && !busy && !depositBlocked;
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
        enabled: confirmEnabled,
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
    if (summary.depositStatus === "verification_unavailable") {
      buttons.push({
        id: "refresh",
        label: "Refresh",
        style: "ghost",
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
      confirmEnabled: confirmEnabled,
      editStyle: kind === "unconfirmed" ? "ghost" : "primary",
      errorMessage:
        kind === "unbalanced"
          ? SUM_ERROR
          : depositBlocked
            ? summary.verificationMessage
            : "",
      confirmedLabel: kind === "confirmed" ? "Payment Schedule Confirmed" : "",
      primaryEnabledCount: primaryEnabled.length,
      primaryLabel: primaryEnabled[0] ? primaryEnabled[0].label : "",
      depositStatus: summary.depositStatus,
      blockConfirm: depositBlocked,
      refreshVisible: summary.depositStatus === "verification_unavailable",
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
    var type = trimField(item && item.payment_type).toLowerCase();
    if (type === "deposit") return true;
    var label = trimField(item && item.label).toLowerCase();
    return /\bdeposit\b/.test(label) || label === "initial scheduling payment";
  }

  function isFinalLikeItem(item) {
    var type = trimField(item && item.payment_type).toLowerCase();
    if (type === "completion" || type === "final") return true;
    var label = trimField(item && item.label).toLowerCase();
    return /\b(remaining|final|completion|balance)\b/.test(label);
  }

  function isSimpleTwoStageSchedule(items) {
    var list = Array.isArray(items) ? items : [];
    if (list.length !== 2) return false;
    var depositCount = 0;
    var finalCount = 0;
    for (var i = 0; i < list.length; i += 1) {
      if (isDepositScheduleItem(list[i])) depositCount += 1;
      else if (isFinalLikeItem(list[i])) finalCount += 1;
    }
    return depositCount === 1 && finalCount === 1;
  }

  function futureStageItems(items) {
    return cloneItems(items).filter(function (item) {
      return !isDepositScheduleItem(item);
    });
  }

  function shouldShowPaymentStages(items) {
    var list = Array.isArray(items) ? items : [];
    if (isSimpleTwoStageSchedule(list)) return false;
    return list.length >= 3 && futureStageItems(list).length > 0;
  }

  function reconcileFutureStages(stageItems, remainingCents, options) {
    var source = Array.isArray(stageItems) ? stageItems : [];
    var rows = presentPaymentRows(source, options);
    if (remainingCents == null) {
      return { rows: rows, matches: true, reconciled: false, mismatch: false };
    }
    var sumCents = 0;
    for (var i = 0; i < source.length; i += 1) {
      sumCents += moneyToCents(source[i].amount);
    }
    if (sumCents === remainingCents) {
      return { rows: rows, matches: true, reconciled: false, mismatch: false };
    }
    if (!source.length) {
      return {
        rows: rows,
        matches: remainingCents === 0,
        reconciled: false,
        mismatch: remainingCents !== 0,
      };
    }
    var adjustIndex = -1;
    for (var j = source.length - 1; j >= 0; j -= 1) {
      if (isFinalLikeItem(source[j])) {
        adjustIndex = j;
        break;
      }
    }
    if (adjustIndex < 0) adjustIndex = source.length - 1;
    var othersCents = 0;
    for (var k = 0; k < source.length; k += 1) {
      if (k !== adjustIndex) othersCents += moneyToCents(source[k].amount);
    }
    var adjustedCents = remainingCents - othersCents;
    if (adjustedCents < 0) {
      return { rows: rows, matches: false, reconciled: false, mismatch: true };
    }
    var nextRows = rows.map(function (row, idx) {
      if (idx !== adjustIndex) return row;
      return Object.assign({}, row, { amount: centsToMoneyNumber(adjustedCents) });
    });
    return { rows: nextRows, matches: true, reconciled: true, mismatch: false };
  }

  function formatCopyAmount(amount, currency) {
    var n = Number(amount);
    if (!Number.isFinite(n)) return "";
    var cur = trimField(currency) || "USD";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: cur,
      }).format(n);
    } catch (_err) {
      return (cur === "USD" ? "$" : cur + " ") + n.toFixed(2);
    }
  }

  function joinPaymentExplanation(statusCopy, cadenceCopy) {
    var status = trimField(statusCopy);
    var cadence = trimField(cadenceCopy);
    if (status && cadence) {
      if (!/[.!?]$/.test(status)) status += ".";
      return status + " " + cadence;
    }
    return status || cadence;
  }

  function paymentFieldFromSnapshot(snap, key) {
    var payment = snap && typeof snap === "object" ? snap.payment_schedule : null;
    if (!payment || typeof payment !== "object") return "";
    if (!Object.prototype.hasOwnProperty.call(payment, key)) return "";
    return trimField(payment[key]);
  }

  function invoiceCadenceCopyFromSnapshot(snap) {
    return paymentFieldFromSnapshot(snap, "invoice_cadence_copy");
  }

  function depositStatusCopyFromSnapshot(snap) {
    return paymentFieldFromSnapshot(snap, "deposit_status_copy");
  }

  function paymentExplanationFromSnapshot(snap) {
    return joinPaymentExplanation(
      depositStatusCopyFromSnapshot(snap),
      invoiceCadenceCopyFromSnapshot(snap)
    );
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
    var currency = trimField(src.currency) || "USD";
    var contractCents =
      src.contractTotal == null || !Number.isFinite(Number(src.contractTotal))
        ? null
        : moneyToCents(src.contractTotal);
    var raw = src.verifiedDeposit || {};
    var status = trimField(raw.status).toLowerCase();
    if (!status) {
      status =
        raw.verified_paid === true && moneyToCents(raw.amount) > 0 ? "paid" : "none";
    }

    var depositItem = null;
    for (var i = 0; i < items.length; i += 1) {
      if (isDepositScheduleItem(items[i])) {
        depositItem = items[i];
        break;
      }
    }
    var quoteRequiredCents =
      src.depositRequired == null || !Number.isFinite(Number(src.depositRequired))
        ? 0
        : moneyToCents(src.depositRequired);
    var itemDepositCents = depositItem ? moneyToCents(depositItem.amount) : 0;
    var plannedDepositCents = quoteRequiredCents > 0 ? quoteRequiredCents : itemDepositCents;
    if (plannedDepositCents < 0) plannedDepositCents = 0;

    var depositStatus = "none";
    var depositAmount = null;
    var verifiedCents = 0;
    var applied = false;
    var blockConfirm = false;
    var verificationMessage = "";

    if (status === "verification_unavailable") {
      depositStatus = "verification_unavailable";
      blockConfirm = true;
      verificationMessage = DEPOSIT_UNAVAILABLE_MESSAGE;
    } else if (status === "inconsistent") {
      depositStatus = "inconsistent";
      blockConfirm = true;
      verificationMessage = trimField(raw.error) || DEPOSIT_INCONSISTENT_MESSAGE;
    } else {
      var verified = status === "paid" ? verifiedDepositFromServer(raw) : null;
      if (verified) {
        verifiedCents = moneyToCents(verified.amount);
        if (contractCents != null && verifiedCents > contractCents) {
          depositStatus = "inconsistent";
          blockConfirm = true;
          verificationMessage = DEPOSIT_INCONSISTENT_MESSAGE;
          verifiedCents = 0;
        } else {
          depositStatus = "paid";
          depositAmount = verified.amount;
          applied = true;
        }
      } else if (plannedDepositCents > 0) {
        depositStatus = "due";
        depositAmount = centsToMoneyNumber(plannedDepositCents);
      }
    }

    var appliedDepositCents = 0;
    if (depositStatus === "paid") appliedDepositCents = verifiedCents;
    else if (depositStatus === "due") appliedDepositCents = plannedDepositCents;

    var remainingCents =
      contractCents == null ? null : contractCents - appliedDepositCents;
    if (remainingCents != null && remainingCents < 0) {
      remainingCents = 0;
      if (depositStatus === "paid") {
        depositStatus = "inconsistent";
        blockConfirm = true;
        verificationMessage = DEPOSIT_INCONSISTENT_MESSAGE;
        applied = false;
        appliedDepositCents = 0;
        remainingCents = contractCents;
        depositAmount = null;
      }
    }

    var remainingLabel =
      depositStatus === "due" ? "Balance After Deposit" : "Remaining Contract Balance";
    var remainingBalance =
      remainingCents == null ? null : centsToMoneyNumber(remainingCents);
    if (
      depositStatus === "verification_unavailable" ||
      depositStatus === "inconsistent"
    ) {
      remainingLabel = "";
      remainingBalance = null;
    }
    var stillDueCents = 0;
    if (depositStatus === "paid" && plannedDepositCents > verifiedCents) {
      stillDueCents = plannedDepositCents - verifiedCents;
    }
    if (!(stillDueCents > 0)) stillDueCents = 0;
    if (stillDueCents > 0) remainingLabel = "Remaining Contract Balance";

    var showStages = shouldShowPaymentStages(items);
    var stageSource = futureStageItems(items);
    var stagePlan = {
      rows: showStages ? presentPaymentRows(stageSource, src) : [],
      matches: true,
      reconciled: false,
      mismatch: false,
    };
    if (showStages && remainingCents != null) {
      stagePlan = reconcileFutureStages(stageSource, remainingCents, src);
      if (stagePlan.mismatch && !blockConfirm) {
        blockConfirm = true;
        verificationMessage = SCHEDULE_MISMATCH_MESSAGE;
      }
    }
    if (
      depositStatus === "verification_unavailable" ||
      depositStatus === "inconsistent"
    ) {
      showStages = false;
      stagePlan = { rows: [], matches: true, reconciled: false, mismatch: false };
    }

    var remainingSumMatches = showStages ? stagePlan.matches === true : true;

    var summaryCopy = "";
    if (depositStatus === "paid" && stillDueCents > 0) {
      summaryCopy =
        "A partial deposit has been received. " +
        formatCopyAmount(centsToMoneyNumber(stillDueCents), currency) +
        " remains due toward the deposit.";
    } else if (depositStatus === "due" && depositAmount != null) {
      summaryCopy =
        "The " + formatCopyAmount(depositAmount, currency) + " deposit is due now.";
    } else if (depositStatus === "paid") {
      summaryCopy = "The deposit has been received.";
    }
    var invoiceCadenceCopy =
      depositStatus === "due" || depositStatus === "paid" ? INVOICE_CADENCE_COPY : "";
    var explanationCopy = joinPaymentExplanation(summaryCopy, invoiceCadenceCopy);

    return {
      contractTotal:
        contractCents == null ? null : centsToMoneyNumber(contractCents),
      depositStatus: depositStatus,
      depositLabel:
        depositStatus === "paid"
          ? "Deposit Paid"
          : depositStatus === "due"
            ? "Deposit Due Now"
            : depositStatus === "verification_unavailable"
              ? "Deposit Status Unavailable"
              : "",
      depositAmount: depositAmount,
      depositMinus: false,
      depositStillDue: stillDueCents > 0 ? centsToMoneyNumber(stillDueCents) : null,
      depositStillDueLabel: stillDueCents > 0 ? "Deposit Still Due" : "",
      showDepositStillDue: stillDueCents > 0,
      remainingLabel: remainingLabel,
      remainingBalance: remainingBalance,
      summaryCopy: summaryCopy,
      appliedCopy: explanationCopy,
      invoiceCadenceCopy: invoiceCadenceCopy,
      explanationCopy: explanationCopy,
      showPaymentStages: showStages,
      stageTitle: showStages ? "Payment Stages" : "",
      remainingItems: showStages ? stagePlan.rows : [],
      remainingSumMatches: remainingSumMatches,
      stagesReconciled: stagePlan.reconciled === true,
      scheduleMismatch: stagePlan.mismatch === true,
      verifiedPaid: applied,
      blockConfirm: blockConfirm,
      verificationMessage: verificationMessage,
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
        var verifiedDeposit =
          typeof h.getVerifiedDeposit === "function" ? h.getVerifiedDeposit() : null;
        var depositRequired =
          typeof h.getDepositRequired === "function" ? h.getDepositRequired() : null;
        var depositSummary = presentPaymentSummary({
          items: items,
          contractTotal: contractTotal,
          verifiedDeposit: verifiedDeposit,
          depositRequired: depositRequired,
        });
        if (depositSummary.blockConfirm) {
          return {
            ok: false,
            reason: depositSummary.scheduleMismatch
              ? "payment_stages_mismatch"
              : depositSummary.depositStatus,
            posted: false,
            advance: false,
            error: depositSummary.verificationMessage,
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
    DEPOSIT_UNAVAILABLE_MESSAGE: DEPOSIT_UNAVAILABLE_MESSAGE,
    DEPOSIT_INCONSISTENT_MESSAGE: DEPOSIT_INCONSISTENT_MESSAGE,
    SCHEDULE_MISMATCH_MESSAGE: SCHEDULE_MISMATCH_MESSAGE,
    PROGRESS_INVOICE_COPY: PROGRESS_INVOICE_COPY,
    INVOICE_CADENCE_COPY: INVOICE_CADENCE_COPY,
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
    isSimpleTwoStageSchedule: isSimpleTwoStageSchedule,
    shouldShowPaymentStages: shouldShowPaymentStages,
    reconcileFutureStages: reconcileFutureStages,
    itemsMatchSource: itemsMatchSource,
    invoiceCadenceCopyFromSnapshot: invoiceCadenceCopyFromSnapshot,
    depositStatusCopyFromSnapshot: depositStatusCopyFromSnapshot,
    paymentExplanationFromSnapshot: paymentExplanationFromSnapshot,
    joinPaymentExplanation: joinPaymentExplanation,
    createPaymentConfirmRunner: createPaymentConfirmRunner,
    cloneItems: cloneItems,
  };
});
