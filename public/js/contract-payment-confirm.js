/**
 * Contract Builder Article 7 — Payment Terms confirm decisions (browser + Node).
 *
 * Owns CTA plan, payload shape, busy lock, and persist/no-persist outcomes.
 * Does not invent future invoice amounts. Progress invoices are calculated later
 * from actual billable progress (Invoice Hub; not in this module).
 * Cumulative invoicing must not exceed the contract plus approved change orders.
 * Does not write Invoice Hub, the ledger, or Payment Intents.
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
  var DEPOSIT_UNAVAILABLE_MESSAGE =
    "Deposit status could not be verified. Refresh before confirming.";
  var DEPOSIT_INCONSISTENT_MESSAGE =
    "Verified deposit exceeds the contract total. Refresh before confirming.";
  var BALANCE_AFTER_DEPOSIT_LABEL = "Balance After Deposit";
  var REMAINING_CONTRACT_BALANCE_LABEL = "Remaining Contract Balance";
  var BILLING_TERMS_COPY =
    "Progress invoices are sent every two weeks based on completed work. If the project is completed sooner, the final invoice is sent when the work is complete.";
  var DEPOSIT_DUE_COPY = "The deposit is due now.";
  var DEPOSIT_PAID_COPY =
    "The deposit has been received and applied to the contract total.";
  var BILLING_SCHEDULE_COPY = BILLING_TERMS_COPY;
  var BILLING_BALANCE_COPY = BILLING_TERMS_COPY;
  var INVOICE_CADENCE_COPY = BILLING_TERMS_COPY;
  var PROGRESS_FINAL_LABEL = "Progress & Final Billing";
  var PROGRESS_FINAL_NOTE =
    "If the project is completed sooner, the final invoice is sent at completion.";
  var INCOMPLETE_STAGE_ERROR = "Complete or remove the unfinished payment stage.";
  var DEFAULT_REMAINING_DUE_RULE = "custom";
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
      residual: item.residual === true,
      is_new: item.is_new === true,
    };
  }

  function parseMoneyInput(raw) {
    var text = String(raw == null ? "" : raw).trim();
    if (!text) return { empty: true, cents: null, invalid: false };
    var cleaned = text.replace(/\$/g, "").replace(/,/g, "").replace(/\s/g, "");
    var neg = cleaned.charAt(0) === "-";
    if (neg) cleaned = cleaned.slice(1);
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned) && !/^\d+$/.test(cleaned)) {
      return { empty: false, cents: null, invalid: true };
    }
    var parts = cleaned.split(".");
    var dollars = parts[0] ? Number(parts[0]) : 0;
    var frac = ((parts[1] || "") + "00").slice(0, 2);
    if (!Number.isFinite(dollars)) return { empty: false, cents: null, invalid: true };
    var cents = dollars * 100 + Number(frac);
    if (neg) cents = -cents;
    return { empty: false, cents: cents, invalid: false };
  }

  function formatMoneyInputFromCents(cents) {
    var abs = Math.abs(Math.round(Number(cents) || 0));
    var dollars = Math.floor(abs / 100);
    var frac = String(abs % 100);
    if (frac.length < 2) frac = "0" + frac;
    var grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return grouped + "." + frac;
  }

  function isResidualProgressBilling(item) {
    if (isDepositScheduleItem(item)) return false;
    if (item && item.residual === true) return true;
    var label = trimField(item && item.label);
    return label === PROGRESS_FINAL_LABEL || label === "Remaining Contract Balance";
  }

  function isPaymentStageValid(item) {
    if (!trimField(item && item.label)) return false;
    var parsed = parseMoneyInput(item && item.amount);
    if (parsed.empty || parsed.invalid || parsed.cents == null || !(parsed.cents > 0)) {
      return false;
    }
    var due = trimField(item && item.due_rule).toLowerCase();
    if (!due) return false;
    return true;
  }

  function paymentStageIntegrity(items, remainingCents) {
    var list = Array.isArray(items) ? items : [];
    var incomplete = false;
    var scheduledCents = 0;
    for (var i = 0; i < list.length; i += 1) {
      if (!isPaymentStageValid(list[i])) incomplete = true;
      else scheduledCents += parseMoneyInput(list[i].amount).cents;
    }
    return {
      incomplete: incomplete,
      scheduledCents: scheduledCents,
      differenceCents: remainingCents == null ? null : remainingCents - scheduledCents,
      mismatch: false,
      blockConfirm: false,
      error: "",
    };
  }

  function paymentSaveControl(input) {
    var src = input || {};
    var remainingCents = src.remainingCents;
    if (remainingCents == null && src.remainingBalance != null) {
      remainingCents = moneyToCents(src.remainingBalance);
    }
    var integrity = paymentStageIntegrity(futureStageItems(src.items), remainingCents);
    var blocked = integrity.blockConfirm === true || src.busy === true;
    return {
      disabled: blocked,
      ariaDisabled: blocked,
      enabled: !blocked,
      posted: false,
      message: integrity.error,
    };
  }

  function paymentStageReorderActions(index, count) {
    var total = Number(count) || 0;
    var i = Number(index) || 0;
    if (total < 2) return { up: false, down: false };
    return {
      up: i > 0,
      down: i < total - 1,
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
    var confirmed = src.confirmed === true || paymentConfigured(src.scheduleBundle);
    if (confirmed) return "confirmed";
    return "unconfirmed";
  }

  function paymentFooterPlan(input) {
    var src = input || {};
    var kind = paymentKind(src);
    var busy = Boolean(src.busy);
    var summary = src.source
      ? presentAuthenticatedPaymentArticleFromBuilderSource(src.source)
      : presentAuthenticatedPaymentArticle({
          items: src.items,
          contractTotal: src.contractTotal,
          verifiedDeposit: src.verifiedDeposit || (src.scheduleBundle && src.scheduleBundle.deposit),
          depositRequired: src.depositRequired,
          readinessStatus:
            src.readinessStatus ||
            (src.scheduleBundle && src.scheduleBundle.readiness && src.scheduleBundle.readiness.status),
        });
    var depositBlocked = summary.blockConfirm === true;
    var confirmEnabled = kind !== "confirmed" && !busy && !depositBlocked;
    var buttons = [];
    if (kind !== "confirmed") {
      buttons.push({
        id: "confirm",
        label: "Confirm Payment Terms",
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
      confirmVisible: kind !== "confirmed",
      confirmEnabled: confirmEnabled,
      customizeVisible: false,
      editStyle: "ghost",
      errorMessage: depositBlocked ? summary.verificationMessage : "",
      confirmedLabel: kind === "confirmed" ? "Payment Terms Confirmed" : "",
      primaryEnabledCount: primaryEnabled.length,
      primaryLabel: primaryEnabled[0] ? primaryEnabled[0].label : "",
      depositStatus: summary.depositStatus,
      blockConfirm: depositBlocked,
      incompleteStages: false,
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
    var dueFn =
      typeof opts.dueRuleLabel === "function" ? opts.dueRuleLabel : article7DueRuleLabel;
    return cloneItems(items).map(function (item, index) {
      var due = dueFn(item.due_rule, {
        fixedDueDate: item.fixed_due_date,
        milestoneDescription: item.milestone_description,
      });
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

  function article7DueRuleLabel(raw, extras) {
    var extra = extras || {};
    var key = trimField(raw).toLowerCase();
    if (key === "fixed_date") {
      var date = trimField(extra.fixedDueDate);
      if (date && extra.editor !== true) return "Due " + date;
      return "On a specific date";
    }
    if (key === "milestone") {
      var milestone = trimField(extra.milestoneDescription);
      if (milestone && extra.editor !== true) return "Due at milestone: " + milestone;
      return "Custom milestone";
    }
    if (key === "on_completion") {
      return extra.editor === true ? "At project completion" : "Due at project completion";
    }
    if (key === "custom" || key === "on_start" || key === "before_start") {
      return "Every two weeks based on progress";
    }
    return extra.editor === true ? "Every two weeks based on progress" : "";
  }

  function article7DueTimingOptionsHtml(selected) {
    var current = trimField(selected).toLowerCase();
    var known =
      current === "custom" ||
      current === "on_completion" ||
      current === "fixed_date" ||
      current === "milestone";
    var options = [
      ["", "Select timing"],
      ["custom", "Every two weeks based on progress"],
      ["on_completion", "At project completion"],
      ["fixed_date", "On a specific date"],
      ["milestone", "Custom milestone"],
    ];
    return options
      .map(function (pair) {
        var isPlaceholder = pair[0] === "";
        var selectedAttr = (!known && isPlaceholder) || (known && pair[0] === current);
        return (
          '<option value="' +
          pair[0] +
          '"' +
          (selectedAttr ? " selected" : "") +
          (isPlaceholder ? " disabled" : "") +
          ">" +
          pair[1] +
          "</option>"
        );
      })
      .join("");
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
    var terms = snap && typeof snap === "object" ? snap.payment_terms : null;
    if (terms && typeof terms === "object" && Object.prototype.hasOwnProperty.call(terms, key)) {
      var fromTerms = trimField(terms[key]);
      if (fromTerms) return fromTerms;
    }
    var payment = snap && typeof snap === "object" ? snap.payment_schedule : null;
    if (!payment || typeof payment !== "object") return "";
    if (!Object.prototype.hasOwnProperty.call(payment, key)) return "";
    return trimField(payment[key]);
  }

  function invoiceCadenceCopyFromSnapshot(snap) {
    return (
      paymentFieldFromSnapshot(snap, "billing_terms_copy") ||
      paymentFieldFromSnapshot(snap, "invoice_cadence_copy")
    );
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

    var appliedDepositCents = depositStatus === "paid" ? verifiedCents : 0;
    var stillDueCents = 0;
    if (depositStatus === "paid" && plannedDepositCents > verifiedCents) {
      stillDueCents = plannedDepositCents - verifiedCents;
    }
    if (!(stillDueCents > 0)) stillDueCents = 0;

    var remainingLabel = REMAINING_CONTRACT_BALANCE_LABEL;
    var remainingCents = contractCents;
    var frozenLabel = trimField(src.frozenRemainingLabel);
    if (frozenLabel) {
      remainingLabel = frozenLabel;
      remainingCents =
        src.frozenRemainingBalance == null || !Number.isFinite(Number(src.frozenRemainingBalance))
          ? null
          : moneyToCents(src.frozenRemainingBalance);
    } else if (src.legacyRemaining === true) {
      remainingCents =
        contractCents == null ? null : contractCents - appliedDepositCents;
    } else if (depositStatus === "due" && plannedDepositCents > 0) {
      remainingLabel = BALANCE_AFTER_DEPOSIT_LABEL;
      remainingCents =
        contractCents == null ? null : contractCents - plannedDepositCents;
    } else if (depositStatus === "paid") {
      remainingLabel = REMAINING_CONTRACT_BALANCE_LABEL;
      remainingCents =
        contractCents == null ? null : contractCents - verifiedCents;
    } else {
      remainingLabel = REMAINING_CONTRACT_BALANCE_LABEL;
      remainingCents = contractCents;
    }
    if (remainingCents != null && remainingCents < 0) {
      remainingCents = 0;
      if (depositStatus === "paid" && !frozenLabel) {
        depositStatus = "inconsistent";
        blockConfirm = true;
        verificationMessage = DEPOSIT_INCONSISTENT_MESSAGE;
        applied = false;
        appliedDepositCents = 0;
        remainingCents = contractCents;
        depositAmount = null;
      }
    }
    var remainingBalance =
      remainingCents == null ? null : centsToMoneyNumber(remainingCents);
    if (
      depositStatus === "verification_unavailable" ||
      depositStatus === "inconsistent"
    ) {
      remainingLabel = "";
      remainingBalance = null;
    }

    var showStages = src.hideFutureStages === true ? false : shouldShowPaymentStages(items);
    var stageSource = futureStageItems(items);
    var stagePlan = {
      rows: showStages ? presentPaymentRows(stageSource, src) : [],
      matches: true,
      reconciled: false,
      mismatch: false,
    };
    if (
      depositStatus === "verification_unavailable" ||
      depositStatus === "inconsistent"
    ) {
      showStages = false;
      stagePlan = { rows: [], matches: true, reconciled: false, mismatch: false };
    }

    var remainingSumMatches = showStages ? stagePlan.matches === true : true;
    var integrity = paymentStageIntegrity(futureStageItems(items), remainingCents);

    var summaryCopy = "";
    if (depositStatus === "paid" && stillDueCents > 0) {
      summaryCopy =
        "A partial deposit has been received. " +
        formatCopyAmount(centsToMoneyNumber(stillDueCents), currency) +
        " remains due toward the deposit.";
    } else if (depositStatus === "due") {
      summaryCopy = DEPOSIT_DUE_COPY;
    } else if (depositStatus === "paid") {
      summaryCopy = DEPOSIT_PAID_COPY;
    }
    var invoiceCadenceCopy =
      depositStatus === "verification_unavailable" || depositStatus === "inconsistent"
        ? ""
        : BILLING_TERMS_COPY;
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
      billingTermsCopy: invoiceCadenceCopy,
      explanationCopy: explanationCopy,
      showPaymentStages: showStages,
      stageTitle: showStages ? "Payment Stages" : "",
      remainingItems: showStages ? stagePlan.rows : [],
      remainingSumMatches: remainingSumMatches,
      stagesReconciled: stagePlan.reconciled === true,
      scheduleMismatch: stagePlan.mismatch === true,
      incompleteStages: integrity.incomplete === true,
      verifiedPaid: applied,
      blockConfirm: blockConfirm,
      verificationMessage: verificationMessage,
    };
  }

  function presentPaymentSummaryFromSnapshot(snap, extras) {
    extras = extras || {};
    var terms =
      snap && snap.payment_terms && typeof snap.payment_terms === "object"
        ? snap.payment_terms
        : null;
    var price = (snap && snap.price) || {};
    var quote = (snap && snap.quote) || {};
    var schedule = (snap && snap.payment_schedule) || {};
    return presentPaymentSummary({
      contractTotal:
        extras.contractTotal != null
          ? extras.contractTotal
          : price.contract_total != null
            ? price.contract_total
            : quote.total,
      items: Array.isArray(schedule.items) ? schedule.items : [],
      verifiedDeposit: schedule.deposit,
      depositRequired:
        price.deposit_required != null ? price.deposit_required : quote.deposit_required,
      currency: extras.currency,
      dueRuleLabel: extras.dueRuleLabel,
      hideFutureStages: Boolean(terms),
      legacyRemaining: !terms,
      frozenRemainingLabel: terms && terms.remaining_label,
      frozenRemainingBalance: terms && terms.remaining_contract_balance,
    });
  }

  function paymentTermsReadiness(status) {
    if (String(status || "").toLowerCase() === "configured") {
      return {
        status: "available",
        caption: "COMPLETE — PAYMENT TERMS",
        label: "PAYMENT TERMS",
      };
    }
    return {
      status: "needs_confirmation",
      caption: "NEEDS CONFIRMATION — PAYMENT TERMS",
      label: "PAYMENT TERMS",
    };
  }

  function presentAuthenticatedPaymentArticle(input) {
    var src = input || {};
    var summary = presentPaymentSummary({
      contractTotal: src.contractTotal,
      items: src.items,
      verifiedDeposit: src.verifiedDeposit,
      depositRequired: src.depositRequired,
      currency: src.currency,
      dueRuleLabel: src.dueRuleLabel,
      hideFutureStages: true,
      legacyRemaining: false,
    });
    var readiness = paymentTermsReadiness(src.readinessStatus);
    return Object.assign({}, summary, {
      showPaymentStages: false,
      remainingItems: [],
      errorMessage: summary.blockConfirm ? summary.verificationMessage : "",
      readinessStatus: readiness.status,
      readinessCaption: readiness.caption,
      sumError: "",
    });
  }

  function resolveAuthenticatedBuilderPaymentInput(source) {
    var src = source || {};
    var bundle = src.paymentSchedule || {};
    var readiness = bundle.readiness || {};
    var status = String(readiness.status || "missing").toLowerCase();
    var contractTotal = null;
    if (readiness.contract_total != null && Number.isFinite(Number(readiness.contract_total))) {
      contractTotal = Number(readiness.contract_total);
    } else if (src.contractTotal != null && Number.isFinite(Number(src.contractTotal))) {
      contractTotal = Number(src.contractTotal);
    }
    var depositRequired = src.depositRequired;
    if (
      (depositRequired == null || !Number.isFinite(Number(depositRequired))) &&
      src.depositRequiredAmount != null &&
      Number.isFinite(Number(src.depositRequiredAmount))
    ) {
      depositRequired = Number(src.depositRequiredAmount);
    }
    return {
      contractTotal: contractTotal,
      items: Array.isArray(bundle.items) ? bundle.items : [],
      verifiedDeposit: bundle.deposit,
      depositRequired: depositRequired,
      currency: trimField(src.currency) || "USD",
      dueRuleLabel: src.dueRuleLabel,
      readinessStatus: status,
    };
  }

  function presentAuthenticatedPaymentArticleFromBuilderSource(source) {
    return presentAuthenticatedPaymentArticle(resolveAuthenticatedBuilderPaymentInput(source));
  }

  function presentAuthenticatedPaymentChrome(input) {
    var src = input || {};
    var source = src.source || src;
    var article = presentAuthenticatedPaymentArticleFromBuilderSource(source);
    var confirmed =
      src.confirmed === true ||
      String(
        (source.paymentSchedule &&
          source.paymentSchedule.readiness &&
          source.paymentSchedule.readiness.status) ||
          src.readinessStatus ||
          ""
      ).toLowerCase() === "configured";
    var readiness = paymentTermsReadiness(confirmed ? "configured" : "needs_confirmation");
    var activeArticleId = String(src.activeArticleId || "");
    var articleOpen = activeArticleId === "art-payment";
    var nextStepLabel = "";
    var nextCta = "";
    var nextCtaVisible = false;
    if (!confirmed) {
      if (articleOpen) {
        nextStepLabel = "Confirm Payment Terms";
      } else {
        nextCta = "Open Payment Terms";
        nextCtaVisible = true;
      }
    }
    return {
      article: article,
      readinessStatus: readiness.status,
      readinessCaption: readiness.caption,
      readinessLabel: readiness.label,
      showInWarnings: false,
      showInMissing: false,
      nextStepLabel: nextStepLabel,
      nextCta: nextCta,
      nextCtaVisible: nextCtaVisible,
      nextCtaConfirms: false,
      nextCtaPersists: false,
      nextArticle: "art-payment",
      openPaymentTermsVisible: nextCtaVisible,
      footerPrimaryVisible: articleOpen && !confirmed,
      footerPrimaryLabel: articleOpen && !confirmed ? "Confirm Payment Terms" : "",
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
        var verifiedDeposit =
          typeof h.getVerifiedDeposit === "function" ? h.getVerifiedDeposit() : null;
        var depositRequired =
          typeof h.getDepositRequired === "function" ? h.getDepositRequired() : null;
        var depositSummary = presentPaymentSummary({
          items: items,
          contractTotal: contractTotal,
          verifiedDeposit: verifiedDeposit,
          depositRequired: depositRequired,
          hideFutureStages: true,
        });
        if (depositSummary.blockConfirm) {
          return {
            ok: false,
            reason: depositSummary.depositStatus,
            posted: false,
            advance: false,
            openEdit: false,
            error: depositSummary.verificationMessage,
            items: items,
          };
        }
        var confirmItems = items.filter(function (row) {
          return isDepositScheduleItem(row);
        });
        if (!confirmItems.length && depositRequired != null && moneyToCents(depositRequired) > 0) {
          confirmItems = [
            {
              label: "Initial Scheduling Payment",
              payment_type: "deposit",
              amount: depositRequired,
              due_rule: "on_signature",
              item_role: "future_obligation",
            },
          ];
        }
        var ids = typeof h.getIds === "function" ? h.getIds() : {};
        var expectedUpdatedAt = typeof h.getExpectedUpdatedAt === "function" ? h.getExpectedUpdatedAt() : null;
        var payload = buildPaymentConfirmPayload(
          ids.projectId,
          ids.quoteId,
          confirmItems,
          expectedUpdatedAt
        );
        if (!itemsMatchSource(payload.items, confirmItems)) {
          return {
            ok: false,
            reason: "mutated",
            posted: false,
            advance: false,
            items: confirmItems,
          };
        }
        if (typeof h.postJson !== "function") {
          throw new Error("postJson is required to confirm payment terms.");
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
            error: trimField(res && res.data && res.data.error) || "Payment terms could not be confirmed.",
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
    DEPOSIT_UNAVAILABLE_MESSAGE: DEPOSIT_UNAVAILABLE_MESSAGE,
    DEPOSIT_INCONSISTENT_MESSAGE: DEPOSIT_INCONSISTENT_MESSAGE,
    BALANCE_AFTER_DEPOSIT_LABEL: BALANCE_AFTER_DEPOSIT_LABEL,
    REMAINING_CONTRACT_BALANCE_LABEL: REMAINING_CONTRACT_BALANCE_LABEL,
    BILLING_TERMS_COPY: BILLING_TERMS_COPY,
    DEPOSIT_DUE_COPY: DEPOSIT_DUE_COPY,
    DEPOSIT_PAID_COPY: DEPOSIT_PAID_COPY,
    PROGRESS_INVOICE_COPY: PROGRESS_INVOICE_COPY,
    INVOICE_CADENCE_COPY: INVOICE_CADENCE_COPY,
    BILLING_SCHEDULE_COPY: BILLING_SCHEDULE_COPY,
    BILLING_BALANCE_COPY: BILLING_BALANCE_COPY,
    PROGRESS_FINAL_LABEL: PROGRESS_FINAL_LABEL,
    PROGRESS_FINAL_NOTE: PROGRESS_FINAL_NOTE,
    INCOMPLETE_STAGE_ERROR: INCOMPLETE_STAGE_ERROR,
    DEFAULT_REMAINING_DUE_RULE: DEFAULT_REMAINING_DUE_RULE,
    parseMoneyInput: parseMoneyInput,
    formatMoneyInputFromCents: formatMoneyInputFromCents,
    isPaymentStageValid: isPaymentStageValid,
    isResidualProgressBilling: isResidualProgressBilling,
    paymentStageIntegrity: paymentStageIntegrity,
    paymentSaveControl: paymentSaveControl,
    paymentStageReorderActions: paymentStageReorderActions,
    centsToMoneyNumber: centsToMoneyNumber,
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
    presentPaymentSummaryFromSnapshot: presentPaymentSummaryFromSnapshot,
    paymentTermsReadiness: paymentTermsReadiness,
    presentAuthenticatedPaymentArticle: presentAuthenticatedPaymentArticle,
    resolveAuthenticatedBuilderPaymentInput: resolveAuthenticatedBuilderPaymentInput,
    presentAuthenticatedPaymentArticleFromBuilderSource: presentAuthenticatedPaymentArticleFromBuilderSource,
    presentAuthenticatedPaymentChrome: presentAuthenticatedPaymentChrome,
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
    article7DueRuleLabel: article7DueRuleLabel,
    article7DueTimingOptionsHtml: article7DueTimingOptionsHtml,
    futureStageItems: futureStageItems,
    createPaymentConfirmRunner: createPaymentConfirmRunner,
    cloneItems: cloneItems,
  };
});
