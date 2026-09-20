/**
 * Contract Builder payment-schedule defaults (browser + Node).
 *
 * Integer-cent math only. Does not POST, confirm, or read Square/ledger.
 *
 * Received-payment policy:
 *   applied_payment means money was already received.
 *   quotes.deposit_required is a planned scheduling amount, not a receipt.
 *   get-tenant-quote-edit strips quotes.deposit_paid_at from the client quote
 *   (serializeSafeQuote), so Contract Builder has no explicit received-payment
 *   fact in already-loaded data. Defaults therefore always use future_obligation.
 *
 * due_rule:
 *   DB/RPC allow on_signature, before_start, on_start, milestone,
 *   on_completion, fixed_date, custom. on_acceptance is NOT an allowed enum.
 *   Initial Scheduling Payment uses on_signature.
 */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MarginGuardContractPaymentDefaults = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DUE_RULES_ALLOWED = [
    "on_signature",
    "before_start",
    "on_start",
    "milestone",
    "on_completion",
    "fixed_date",
    "custom",
  ];

  var INITIAL_SCHEDULING_DUE_RULE = "on_signature";
  var REMAINING_DUE_RULE = "custom";
  var PROGRESS_FINAL_LABEL = "Progress & Final Billing";
  var DEFAULT_ITEM_ROLE = "future_obligation";
  var CUSTOM_DUE_CUSTOMER_LABEL = "As scheduled in this Agreement";

  var DUE_RULE_CUSTOMER_LABELS = {
    on_signature: "Due upon acceptance",
    on_acceptance: "Due upon acceptance",
    before_start: "Due before work begins",
    on_start: "Due at project start",
    milestone: "Due at the configured milestone",
    on_completion: "Due upon completion",
    fixed_date: "Due on a fixed date",
    net_7: "Within 7 days",
    net_15: "Within 15 days",
    net_30: "Within 30 days",
  };

  var PAYMENT_TYPE_CUSTOMER_LABELS = {
    deposit: "Deposit",
    start: "Project Start",
    progress: "Progress Payment",
    material: "Material",
    completion: "Completion",
    final: "Final Payment",
    custom: "Payment",
  };

  var ITEM_ROLE_CUSTOMER_LABELS = {
    future_obligation: "Future obligation — payment is still due",
    applied_payment: "Applied payment — payment was already received",
  };

  function toMoneyCents(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }

  function centsToNumber(cents) {
    if (cents == null) return null;
    return Math.round(Number(cents)) / 100;
  }

  function trimField(value) {
    return String(value == null ? "" : value).trim();
  }

  function dueRuleCustomerLabel(raw, extras) {
    var key = trimField(raw).toLowerCase();
    var extra = extras || {};
    if (!key) return "";
    if (key === "custom") {
      return extra.omitCustom === true ? "" : CUSTOM_DUE_CUSTOMER_LABEL;
    }
    if (key === "fixed_date") {
      var date = trimField(extra.fixedDueDate);
      if (date) return "Due " + date;
    }
    if (key === "milestone" && trimField(extra.milestoneDescription)) {
      return "Due at milestone: " + trimField(extra.milestoneDescription);
    }
    if (DUE_RULE_CUSTOMER_LABELS[key]) return DUE_RULE_CUSTOMER_LABELS[key];
    return CUSTOM_DUE_CUSTOMER_LABEL;
  }

  function paymentTypeCustomerLabel(raw) {
    var key = trimField(raw).toLowerCase();
    if (!key) return "Payment";
    if (PAYMENT_TYPE_CUSTOMER_LABELS[key]) return PAYMENT_TYPE_CUSTOMER_LABELS[key];
    return "Payment";
  }

  function itemRoleCustomerLabel(raw) {
    var key = trimField(raw).toLowerCase();
    if (ITEM_ROLE_CUSTOMER_LABELS[key]) return ITEM_ROLE_CUSTOMER_LABELS[key];
    return ITEM_ROLE_CUSTOMER_LABELS.future_obligation;
  }

  function isUnsafePackageStatus(status) {
    var key = trimField(status).toLowerCase();
    return (
      key === "ready" ||
      key === "executed" ||
      key === "frozen" ||
      key === "superseded"
    );
  }

  function canSeedPaymentDefaults(input) {
    var src = input || {};
    if (src.unsafeToEdit === true) return false;
    if (isUnsafePackageStatus(src.packageStatus)) return false;
    var items = Array.isArray(src.items) ? src.items : [];
    if (items.length > 0) return false;
    if (src.confirmed === true) return false;
    var readiness = trimField(src.readinessStatus).toLowerCase();
    if (readiness === "configured") return false;
    var scheduleStatus = trimField(src.scheduleStatus).toLowerCase();
    if (scheduleStatus === "confirmed") return false;
    return true;
  }

  function makeItem(sequence, label, paymentType, amountCents, dueRule) {
    return {
      sequence_number: sequence,
      label: label,
      payment_type: paymentType,
      amount: centsToNumber(amountCents),
      amount_cents: amountCents,
      due_rule: dueRule,
      milestone_description: "",
      fixed_due_date: "",
      item_role: DEFAULT_ITEM_ROLE,
    };
  }

  function depositExceedsWarning(depositCents, totalCents) {
    return (
      "Scheduling payment (" +
      centsToNumber(depositCents).toFixed(2) +
      ") is greater than the contract total (" +
      centsToNumber(totalCents).toFixed(2) +
      "). Defaults were not created."
    );
  }

  function buildDefaultPaymentSchedule(input) {
    var src = input || {};
    if (!canSeedPaymentDefaults(src)) {
      return {
        ok: true,
        seeded: false,
        overwriteProtected: true,
        warning: null,
        items: [],
        reason: "existing_or_locked",
      };
    }

    var totalCents = toMoneyCents(src.contractTotal);
    if (!(totalCents > 0)) {
      return {
        ok: false,
        seeded: false,
        overwriteProtected: false,
        warning: "Contract total is unavailable, so a payment schedule was not generated.",
        items: [],
        code: "contract_total_unavailable",
      };
    }

    var depositCents = toMoneyCents(
      src.depositRequired == null || src.depositRequired === ""
        ? 0
        : src.depositRequired
    );
    if (depositCents == null || depositCents < 0) depositCents = 0;

    if (depositCents > totalCents) {
      return {
        ok: false,
        seeded: false,
        overwriteProtected: false,
        warning: depositExceedsWarning(depositCents, totalCents),
        items: [],
        code: "deposit_exceeds_total",
      };
    }

    var items = [];
    if (depositCents > 0) {
      items.push(
        makeItem(
          1,
          "Initial Scheduling Payment",
          "deposit",
          depositCents,
          INITIAL_SCHEDULING_DUE_RULE
        )
      );
    }

    return {
      ok: true,
      seeded: true,
      overwriteProtected: false,
      warning: null,
      items: items,
      reason: "seeded",
    };
  }

  return {
    DUE_RULES_ALLOWED: DUE_RULES_ALLOWED.slice(),
    INITIAL_SCHEDULING_DUE_RULE: INITIAL_SCHEDULING_DUE_RULE,
    REMAINING_DUE_RULE: REMAINING_DUE_RULE,
    PROGRESS_FINAL_LABEL: PROGRESS_FINAL_LABEL,
    DEFAULT_ITEM_ROLE: DEFAULT_ITEM_ROLE,
    CUSTOM_DUE_CUSTOMER_LABEL: CUSTOM_DUE_CUSTOMER_LABEL,
    toMoneyCents: toMoneyCents,
    centsToNumber: centsToNumber,
    dueRuleCustomerLabel: dueRuleCustomerLabel,
    paymentTypeCustomerLabel: paymentTypeCustomerLabel,
    itemRoleCustomerLabel: itemRoleCustomerLabel,
    canSeedPaymentDefaults: canSeedPaymentDefaults,
    buildDefaultPaymentSchedule: buildDefaultPaymentSchedule,
  };
});
