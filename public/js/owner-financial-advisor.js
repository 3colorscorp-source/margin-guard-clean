/**
 * Owner Financial Advisor™ / AI CFO™ — Phase 1 (READ-ONLY)
 *
 * Isolated, read-only decision engine + DOM rendering for the Dashboard card.
 *
 * SAFETY CONTRACT (Phase 1):
 *  - The ONLY write allowed is the dedicated manual-debt localStorage key below.
 *  - No app/invoice/dashboard/quote/Supabase/API/payment writes.
 *  - No quote formula logic. No bank sync. No payment automation.
 *  - Consumes existing computed values passed in from the Dashboard refresh hook.
 *  - Recommendations are conservative and deterministic (auditable, no LLM).
 */
(() => {
  "use strict";

  const DEBT_KEY = "mg_owner_advisor_debt_v1";

  /* ------------------------------------------------------------------ */
  /* Utilities                                                           */
  /* ------------------------------------------------------------------ */

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatMoney(value) {
    const n = num(value, 0);
    try {
      return n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });
    } catch (_e) {
      return `$${Math.round(n)}`;
    }
  }

  function formatMoneyRange(low, high) {
    return `${formatMoney(low)}–${formatMoney(high)}`;
  }

  /* ------------------------------------------------------------------ */
  /* Manual debt inputs — the ONLY allowed write (dedicated key)         */
  /* ------------------------------------------------------------------ */

  function loadDebtInputs() {
    const defaults = {
      creditCardBalance: "",
      apr: "",
      monthlyMinimum: "",
      operatingCashMinTarget: "",
    };
    try {
      const raw = localStorage.getItem(DEBT_KEY);
      if (!raw) return { ...defaults };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { ...defaults };
      return {
        creditCardBalance: parsed.creditCardBalance ?? "",
        apr: parsed.apr ?? "",
        monthlyMinimum: parsed.monthlyMinimum ?? "",
        operatingCashMinTarget: parsed.operatingCashMinTarget ?? "",
      };
    } catch (_e) {
      return { ...defaults };
    }
  }

  function saveDebtInputs(inputs) {
    try {
      const safe = {
        creditCardBalance: inputs?.creditCardBalance ?? "",
        apr: inputs?.apr ?? "",
        monthlyMinimum: inputs?.monthlyMinimum ?? "",
        operatingCashMinTarget: inputs?.operatingCashMinTarget ?? "",
      };
      localStorage.setItem(DEBT_KEY, JSON.stringify(safe));
    } catch (_e) {
      /* ignore storage failures — read-only advisor must not break */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Missing-data fallback copy (Phase 2A — dynamic, owner-focused)      */
  /* ------------------------------------------------------------------ */

  function isLiquidityHealthy(operatingCash, operatingMinTarget, operatingMonthly, runwayMonths) {
    if (operatingMonthly <= 0 && !(operatingMinTarget > 0)) return false;
    return operatingCash >= operatingMinTarget && (runwayMonths >= 3 || operatingMonthly <= 0);
  }

  function buildFallbackRecommendation(ctx) {
    const {
      balanceMissing,
      aprMissing,
      operatingTargetMissing,
      invoiceDataAvailable,
      openBalance,
      safeAvailableCash,
    } = ctx;

    const hasOpenReceivables = invoiceDataAvailable && openBalance > 0;

    if (hasOpenReceivables && (balanceMissing || aprMissing)) {
      return "Collect open invoices first; debt guidance waits on balance and APR.";
    }
    if (operatingTargetMissing && !balanceMissing && !aprMissing) {
      return "Set operating cash target before evaluating extra debt payments.";
    }
    if (balanceMissing && aprMissing) {
      return `Safe cash available: ${formatMoney(safeAvailableCash)}. Enter debt balance and APR to estimate a payment range.`;
    }
    if (balanceMissing || aprMissing) {
      return `Safe cash available: ${formatMoney(safeAvailableCash)}. Enter missing debt details to estimate a payment range.`;
    }
    if (operatingTargetMissing) {
      return "Set operating cash target before evaluating extra debt payments.";
    }
    return "Hold extra debt payments until required details are entered.";
  }

  function buildFallbackWhy(missing, invoiceDataAvailable, openBalance) {
    const why = [];
    if (missing.length) {
      why.push(`Missing inputs: ${missing.join(", ")}.`);
    }
    if (!invoiceDataAvailable) {
      why.push("Invoice data unavailable — collection status could not be confirmed.");
    } else if (openBalance > 0) {
      why.push(`${formatMoney(openBalance)} is outstanding in the Invoice Hub (not cash until collected).`);
    }
    why.push("Tax reserve must stay protected.");
    return why;
  }

  function buildFallbackNextAction(missing, invoiceDataAvailable, openBalance) {
    const needsDebt = missing.some((item) => item === "credit card balance" || item === "APR");
    const parts = [];
    if (needsDebt) {
      parts.push("Enter the missing debt details in Manual debt inputs below.");
    }
    if (missing.includes("operating cash target")) {
      parts.push("Set your operating cash minimum target.");
    }
    if (!invoiceDataAvailable) {
      parts.push("Open Invoice Hub when available to confirm collection status.");
    } else if (openBalance > 0) {
      parts.push("Prioritize collecting open invoices, then complete debt inputs.");
    }
    return parts.length
      ? parts.join(" ")
      : "Complete the manual debt inputs below, then review again.";
  }

  function formatRunway(runwayMonths) {
    return runwayMonths > 0 ? `${runwayMonths.toFixed(1)} months` : "unknown";
  }

  function computeSafeCashBreakdown(snapshot, debt) {
    const s = snapshot || {};
    const d = debt || {};
    const operatingCash = num(s.operatingCash, 0);
    const profitCash = num(s.profitCash, 0);
    const operatingMonthly = num(s.operatingMonthly, 0);
    const manualTarget = num(d.operatingCashMinTarget, NaN);
    const manualTargetKnown = Number.isFinite(manualTarget) && manualTarget > 0;
    const dashboardTargetKnown = Number.isFinite(operatingMonthly) && operatingMonthly > 0;
    const operatingTargetKnown = manualTargetKnown || dashboardTargetKnown;
    const operatingMinTarget = manualTargetKnown
      ? manualTarget
      : dashboardTargetKnown
        ? operatingMonthly
        : 0;
    const operatingSurplus = operatingTargetKnown
      ? Math.max(0, operatingCash - operatingMinTarget)
      : 0;
    const profitAvailable = Math.max(0, profitCash);

    return {
      operatingMinTarget,
      operatingSurplus,
      profitAvailable,
      safeAvailableCash: profitAvailable + operatingSurplus,
      debtPaymentCapacity: profitAvailable,
      operatingTargetKnown,
    };
  }

  function buildSafeCashSummary(breakdown) {
    const { safeAvailableCash, operatingTargetKnown } = breakdown;
    if (!operatingTargetKnown) {
      return `Safe cash available: ${formatMoney(safeAvailableCash)} (profit only). Set operating cash target to include operating surplus. Payment range uses profit cash only.`;
    }
    return `Safe cash available: ${formatMoney(safeAvailableCash)}. Payment range uses profit cash only.`;
  }

  function computeDebtPaymentRange(ctx) {
    const {
      creditCardBalance,
      apr,
      debtPaymentCapacity,
      operatingBelowTarget,
      runwayThin,
      healthTone,
      openBalance,
      overdueCount,
    } = ctx;

    if (!Number.isFinite(creditCardBalance) || creditCardBalance <= 0 || !Number.isFinite(apr) || apr <= 0) {
      return { allowed: false, reason: "missing-debt" };
    }
    if (operatingBelowTarget || runwayThin || healthTone === "red") {
      return { allowed: false, reason: "cash-protection" };
    }
    if (openBalance > 0 && overdueCount > 0) {
      return { allowed: false, reason: "collect-overdue" };
    }

    const capacity = Math.max(0, Math.min(debtPaymentCapacity, creditCardBalance));
    if (capacity <= 0) {
      return { allowed: false, reason: "no-profit-capacity" };
    }

    if (openBalance > 0) {
      const high = Math.min(Math.round(capacity * 0.5), creditCardBalance);
      return high > 0
        ? { allowed: true, contingent: true, low: 0, high, label: `Consider up to ${formatMoney(high)} only after invoice collection clears.` }
        : { allowed: false, reason: "no-profit-capacity" };
    }

    const low = Math.max(0, Math.min(Math.round(capacity * 0.5), creditCardBalance));
    const high = Math.max(low, Math.min(Math.round(capacity), creditCardBalance));
    return high > 0
      ? { allowed: true, contingent: false, low, high, label: `Safe payment range: ${formatMoneyRange(low, high)} from profit cash only.` }
      : { allowed: false, reason: "no-profit-capacity" };
  }

  function buildOwnerWhy(ctx) {
    const {
      missing,
      operatingCash,
      operatingMinTarget,
      operatingTargetKnown,
      profitAvailable,
      safeAvailableCash,
      taxReserve,
      invoiceDataAvailable,
      openBalance,
      monthlyInterestEstimate,
      dailyInterestEstimate,
      runwayMonths,
    } = ctx;

    const why = [];
    if (Array.isArray(missing) && missing.length) {
      why.push(`Missing inputs: ${missing.join(", ")}.`);
    }

    if (!operatingTargetKnown) {
      why.push(`Operating cash: ${formatMoney(operatingCash)} — target not set.`);
      why.push("Operating target is not set; operating cash is protected.");
    } else {
      const status = operatingCash >= operatingMinTarget ? "above" : "below";
      why.push(`Operating cash: ${formatMoney(operatingCash)} — ${status} target ${formatMoney(operatingMinTarget)}.`);
    }

    why.push(`Profit cash available: ${formatMoney(profitAvailable)}.`);
    why.push(`Safe available cash: ${formatMoney(safeAvailableCash)} — excludes tax reserve, savings, and invoices.`);
    why.push(`Tax reserve: ${formatMoney(taxReserve)} — protected.`);

    if (!invoiceDataAvailable) {
      why.push("Open invoices: invoice data unavailable.");
    } else if (openBalance > 0) {
      why.push(`Open invoices: ${formatMoney(openBalance)} outstanding, not cash yet.`);
    } else {
      why.push("Open invoices: none.");
    }

    if (monthlyInterestEstimate != null) {
      why.push(`Debt interest estimate: ~${formatMoney(monthlyInterestEstimate)}/mo (~${formatMoney(dailyInterestEstimate)}/day).`);
    }

    const runwayTone = runwayMonths > 0 ? (runwayMonths < 3 ? "thin" : "healthy") : "unknown";
    why.push(`Runway: ${formatRunway(runwayMonths)} — ${runwayTone}.`);
    return why;
  }

  function buildEstimatedImpact(paymentRange, monthlyInterestEstimate, dailyInterestEstimate) {
    if (paymentRange.reason === "missing-debt") {
      return "Enter balance and APR to estimate interest and payment range.";
    }

    const interestCopy = monthlyInterestEstimate != null
      ? `Estimated interest: ~${formatMoney(monthlyInterestEstimate)}/mo (~${formatMoney(dailyInterestEstimate)}/day). Estimate only.`
      : "Interest estimate unavailable until balance and APR are entered.";

    if (!paymentRange.allowed) {
      return `No extra payment recommended today. ${interestCopy}`;
    }

    return `${paymentRange.label} ${interestCopy}`;
  }

  function collectionSubject(action) {
    if (!action || typeof action !== "object") return "";
    return nonEmptyString(action.customerName, action.projectTitle, "");
  }

  function nonEmptyString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function refinePrimaryRecommendation(ctx, baseRecommendation) {
    const {
      operatingTargetMissing,
      operatingBelowTarget,
      runwayThin,
      healthTone,
      topCollectionAction,
      overdueCount,
      invoiceDataAvailable,
      openBalance,
      paymentRange,
    } = ctx;

    if (operatingTargetMissing) {
      return "Set operating cash target before making optional debt decisions.";
    }
    if (operatingBelowTarget) {
      return "Do not make an extra debt payment today. Operating cash is below target.";
    }
    if (runwayThin || healthTone === "red") {
      return "Do not make an extra debt payment today. Protect runway first.";
    }
    if (invoiceDataAvailable && overdueCount > 0) {
      const name = collectionSubject(topCollectionAction);
      if (name) return `Collect ${name}'s invoice before reducing cash.`;
      return "Collect open invoices before reducing cash.";
    }
    if (invoiceDataAvailable && openBalance > 0 && (!paymentRange?.allowed || paymentRange?.contingent)) {
      return "Collect open invoices before reducing cash.";
    }
    if (paymentRange?.allowed && !paymentRange?.contingent) {
      return "Safe to review a controlled debt payment from profit cash only.";
    }
    return baseRecommendation;
  }

  /**
   * Deterministic Top 3 owner actions — priority stack, no LLM.
   */
  function buildTopOwnerActions(ctx) {
    const candidates = [];
    const seen = new Set();
    const add = (title, detail, tone, order) => {
      const key = String(title || "").trim();
      if (!key || seen.has(key)) return;
      seen.add(key);
      candidates.push({ title: key, detail: String(detail || ""), tone: tone || "neutral", order });
    };

    /* 1. Operating protection */
    if (ctx.operatingTargetMissing) {
      add(
        "Set operating cash target",
        "Set operating cash target before making optional debt decisions.",
        "warn",
        10
      );
    }
    if (ctx.operatingBelowTarget) {
      add(
        "Rebuild operating cash",
        "Rebuild operating cash before paying extra debt.",
        "danger",
        11
      );
    }

    /* 2. Collections */
    if (ctx.invoiceDataAvailable && ctx.overdueCount > 0) {
      const top = ctx.topCollectionAction;
      const name = collectionSubject(top);
      if (name) {
        add(
          `Collect ${name}'s invoice`,
          top && top.balance > 0
            ? `${formatMoney(top.balance)} is still open.`
            : "Overdue balance needs collection before cash moves.",
          "danger",
          20
        );
      } else {
        add(
          "Collect overdue invoices first",
          ctx.overdueBalance > 0
            ? `${formatMoney(ctx.overdueBalance)} overdue — not cash until collected.`
            : "Work overdue invoices before reducing cash.",
          "danger",
          21
        );
      }
    } else if (ctx.invoiceDataAvailable && ctx.openBalance > 0) {
      add(
        "Follow up on open invoices",
        `${formatMoney(ctx.openBalance)} outstanding — not cash until collected.`,
        "amber",
        22
      );
    }

    if (ctx.brokenPromiseCount > 0) {
      add(
        "Follow up broken payment promises",
        `${ctx.brokenPromiseCount} promised date(s) passed with balance still open.`,
        "danger",
        23
      );
    }

    const invoiceActions = Array.isArray(ctx.topInvoiceActions) ? ctx.topInvoiceActions : [];
    invoiceActions.forEach((action, index) => {
      const name = collectionSubject(action);
      if (!name) return;
      const tone = ["overdue", "expired"].includes(String(action.status || "")) ? "danger" : "amber";
      add(
        `${action.nextAction || "Invoice follow-up"}: ${name}`,
        `${formatMoney(action.balance)} open.`,
        tone,
        24 + index
      );
    });

    /* 3. Billing */
    if (ctx.readyToBillCount > 0) {
      add(
        "Send or review ready-to-bill invoices",
        `${ctx.readyToBillCount} estimate(s) ready to convert.`,
        "amber",
        30
      );
    }

    /* 4. Debt inputs */
    if (ctx.balanceMissing && ctx.aprMissing) {
      add(
        "Enter credit card balance and APR",
        "Debt pressure cannot be measured yet.",
        "neutral",
        40
      );
    } else if (ctx.balanceMissing || ctx.aprMissing) {
      add(
        "Enter missing debt details",
        ctx.balanceMissing ? "Credit card balance is required." : "APR is required.",
        "neutral",
        41
      );
    }

    /* 5. Debt payment */
    if (ctx.paymentRange?.allowed && !ctx.paymentRange?.contingent) {
      const low = num(ctx.paymentRange.low, 0);
      const high = num(ctx.paymentRange.high, 0);
      add(
        "Review controlled debt payment",
        high > 0
          ? `Consider ${formatMoneyRange(low, high)} from profit cash only.`
          : "Review a controlled payment from profit cash only.",
        "ok",
        50
      );
    } else if (ctx.paymentRange?.allowed && ctx.paymentRange?.contingent) {
      add(
        "Wait for invoice collection",
        ctx.paymentRange.label || "Collect open invoices before any extra debt payment.",
        "amber",
        51
      );
    }

    /* 6. Cash protection */
    if (ctx.runwayThin) {
      add(
        "Hold extra debt payment",
        "Runway is below 3 months.",
        "warn",
        60
      );
    }
    if (ctx.healthTone === "red" && !ctx.runwayThin) {
      add(
        "Protect cash first",
        "Business health is under pressure — optional payments wait.",
        "warn",
        61
      );
    }

    const hasTitleMatching = (pattern) =>
      candidates.some((c) => pattern.test(String(c.title || "")));

    const contextualFallbacks = [
      {
        order: 70,
        title: "Update debt details before making optional payments",
        detail: "Enter credit card balance and APR in Manual debt inputs below.",
        tone: "neutral",
        when: (c) =>
          (c.balanceMissing || c.aprMissing) &&
          !hasTitleMatching(/Enter credit card balance|Enter missing debt details/i),
      },
      {
        order: 71,
        title: "Recheck Advisor after invoice payments are received",
        detail: "Open invoices are not cash until money is in the bank.",
        tone: "neutral",
        when: (c) => c.invoiceDataAvailable && c.openBalance > 0,
      },
      {
        order: 72,
        title: "Set operating cash target",
        detail: "Set your operating cash minimum before optional cash decisions.",
        tone: "warn",
        when: (c) => c.operatingTargetMissing,
      },
    ];

    contextualFallbacks.forEach((fb) => {
      if (candidates.length >= 3) return;
      if (fb.when && !fb.when(ctx)) return;
      add(fb.title, fb.detail, fb.tone, fb.order);
    });

    const unconditionalFallbacks = [
      {
        title: "Review Dashboard after payments clear",
        detail: "Recheck when new cash hits the bank.",
        tone: "neutral",
      },
      {
        title: "Keep tax reserve and savings protected",
        detail: "Do not use tax reserve, savings, or pending invoices for optional payments.",
        tone: "neutral",
      },
      {
        title: "Recheck Advisor when cash data changes",
        detail: "Update balances after deposits, payroll, or invoice collections.",
        tone: "neutral",
      },
    ];

    let fallbackIdx = 0;
    while (candidates.length < 3 && fallbackIdx < unconditionalFallbacks.length * 3) {
      const fb = unconditionalFallbacks[fallbackIdx % unconditionalFallbacks.length];
      fallbackIdx += 1;
      add(fb.title, fb.detail, fb.tone, 90 + fallbackIdx);
    }

    return candidates
      .sort((left, right) => left.order - right.order)
      .slice(0, 3)
      .map(({ title, detail, tone }) => ({ title, detail, tone }));
  }

  function renderTopActions(topActions) {
    if (!Array.isArray(topActions) || !topActions.length) {
      return "";
    }
    return `
      <div class="ofa-block" style="margin-bottom:12px;">
        <h3 class="ofa-block__title">Today’s Top 3 Actions</h3>
        <ul class="ofa-why">
          ${topActions
            .map(
              (action, index) =>
                `<li><strong>${index + 1}. ${escapeHtml(action.title)}</strong> — ${escapeHtml(action.detail)}</li>`
            )
            .join("")}
        </ul>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Recommendation engine — conservative, deterministic                */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} snapshot
   * @param {number} snapshot.operatingCash   Operating/expenses bucket balance
   * @param {number} snapshot.profitCash      Profit bucket balance
   * @param {number} snapshot.savingsCash     Savings bucket balance
   * @param {number} snapshot.taxReserve      Tax reserve bucket balance
   * @param {number} snapshot.totalCash       Sum of buckets (NOT spendable)
   * @param {number} snapshot.operatingMonthly Monthly operating cost
   * @param {number} snapshot.runwayMonths
   * @param {number} snapshot.openBalance     Open receivables from hub (NOT cash)
   * @param {number} snapshot.overdueCount
   * @param {number} snapshot.readyToBillCount
   * @param {number} snapshot.healthScore
   * @param {string} snapshot.healthTone      green|amber|red
   * @param {boolean} snapshot.invoiceDataAvailable Hub rows were loaded on Dashboard
   * @param {object} debt                     Manual debt inputs (parsed numbers)
   */
  function computeAdvisorRecommendation(snapshot, debt) {
    const s = snapshot || {};
    const d = debt || {};

    const operatingCash = num(s.operatingCash, 0);
    const profitCash = num(s.profitCash, 0);
    const taxReserve = num(s.taxReserve, 0);
    const operatingMonthly = num(s.operatingMonthly, 0);
    const runwayMonths = num(s.runwayMonths, 0);
    const openBalance = num(s.openBalance, 0);
    const overdueCount = num(s.overdueCount, 0);
    const healthTone = String(s.healthTone || "").toLowerCase();
    const invoiceDataAvailable = s.invoiceDataAvailable !== false;
    const topCollectionAction = s.topCollectionAction && typeof s.topCollectionAction === "object"
      ? s.topCollectionAction
      : null;
    const topInvoiceActions = Array.isArray(s.topInvoiceActions) ? s.topInvoiceActions.slice(0, 3) : [];
    const readyToBillCount = num(s.readyToBillCount, 0);
    const brokenPromiseCount = num(s.brokenPromiseCount, 0);
    const overdueBalance = num(s.overdueBalance, 0);

    const creditCardBalance = num(d.creditCardBalance, NaN);
    const apr = num(d.apr, NaN);
    const monthlyMinimum = num(d.monthlyMinimum, NaN);
    const balanceMissing = !Number.isFinite(creditCardBalance) || creditCardBalance <= 0;
    const aprMissing = !Number.isFinite(apr) || apr <= 0;

    /* ---- Interest estimates (labeled, display-only) ---- */
    let monthlyInterestEstimate = null;
    let dailyInterestEstimate = null;
    let annualInterestEstimate = null;
    if (Number.isFinite(creditCardBalance) && Number.isFinite(apr) && creditCardBalance > 0 && apr > 0) {
      monthlyInterestEstimate = creditCardBalance * (apr / 100 / 12);
      dailyInterestEstimate = creditCardBalance * (apr / 100 / 365);
      annualInterestEstimate = creditCardBalance * (apr / 100);
    }

    /* ---- Missing data checks ---- */
    const safeCashBreakdown = computeSafeCashBreakdown(
      { operatingCash, profitCash, operatingMonthly },
      { operatingCashMinTarget: d.operatingCashMinTarget }
    );
    const {
      operatingMinTarget,
      operatingTargetKnown,
      safeAvailableCash: safeAvailableCashAmount,
    } = safeCashBreakdown;
    const operatingTargetMissing = !operatingTargetKnown;
    const operatingBelowTarget = operatingTargetKnown && operatingCash < operatingMinTarget;
    const runwayThin = operatingMonthly > 0 && runwayMonths < 3;

    const missing = [];
    if (balanceMissing) missing.push("credit card balance");
    if (aprMissing) missing.push("APR");
    if (operatingTargetMissing) missing.push("operating cash target");

    const hasOpenReceivables = invoiceDataAvailable && openBalance > 0;
    const paymentRange = computeDebtPaymentRange({
      creditCardBalance,
      apr,
      debtPaymentCapacity: safeCashBreakdown.debtPaymentCapacity,
      operatingBelowTarget,
      runwayThin,
      healthTone,
      openBalance,
      overdueCount,
    });

    const actionCtx = {
      operatingTargetMissing,
      operatingBelowTarget,
      runwayThin,
      healthTone,
      topCollectionAction,
      topInvoiceActions,
      readyToBillCount,
      brokenPromiseCount,
      overdueBalance,
      overdueCount,
      invoiceDataAvailable,
      openBalance,
      balanceMissing,
      aprMissing,
      paymentRange,
    };
    const topActions = buildTopOwnerActions(actionCtx);

    /* ---- Decision Signals (always computed from safe aggregates) ---- */
    const signals = buildDecisionSignals({
      operatingCash,
      operatingMinTarget,
      operatingMonthly,
      runwayMonths,
      taxReserve,
      openBalance,
      overdueCount,
      healthTone,
      creditCardBalance,
      apr,
      monthlyMinimum,
      invoiceDataAvailable,
      operatingTargetKnown,
      safeAvailableCash: safeAvailableCashAmount,
    });

    /* ---- Fallback when core debt data is missing ---- */
    if (missing.length > 0) {
      const fallbackRec = buildFallbackRecommendation({
          balanceMissing,
          aprMissing,
          operatingTargetMissing,
          invoiceDataAvailable,
          openBalance,
          safeAvailableCash: safeCashBreakdown.safeAvailableCash,
        });
      return {
        toneClass: "neutral",
        recommendation: refinePrimaryRecommendation(actionCtx, fallbackRec),
        why: buildOwnerWhy({
          missing,
          operatingCash,
          operatingMinTarget,
          operatingTargetKnown,
          profitAvailable: safeCashBreakdown.profitAvailable,
          safeAvailableCash: safeCashBreakdown.safeAvailableCash,
          taxReserve,
          invoiceDataAvailable,
          openBalance,
          monthlyInterestEstimate,
          dailyInterestEstimate,
          runwayMonths,
        }),
        nextAction: buildFallbackNextAction(missing, invoiceDataAvailable, openBalance),
        risk: "Acting without complete data could drain working capital or reserves.",
        impact: buildEstimatedImpact(paymentRange, monthlyInterestEstimate, dailyInterestEstimate),
        signals,
        topActions,
        interest: {
          monthly: monthlyInterestEstimate,
          daily: dailyInterestEstimate,
          annual: annualInterestEstimate,
        },
        safeAvailableCash: safeCashBreakdown.safeAvailableCash,
        safeCashSummary: buildSafeCashSummary(safeCashBreakdown),
        paymentRange,
      };
    }

    const why = buildOwnerWhy({
      missing,
      operatingCash,
      operatingMinTarget,
      operatingTargetKnown,
      profitAvailable: safeCashBreakdown.profitAvailable,
      safeAvailableCash: safeCashBreakdown.safeAvailableCash,
      taxReserve,
      invoiceDataAvailable,
      openBalance,
      monthlyInterestEstimate,
      dailyInterestEstimate,
      runwayMonths,
    });
    let recommendation;
    let toneClass;
    let nextAction;
    let risk;

    if (operatingBelowTarget || runwayThin || healthTone === "red") {
      /* Do NOT recommend extra debt payment: liquidity is stressed. */
      toneClass = "warn";
      recommendation = operatingBelowTarget
        ? "Do not pay extra debt today. Operating cash is below target."
        : apr >= 18
        ? "Debt pressure is high, but cash protection comes first."
        : "No extra payment recommended today. Protect runway first.";
      nextAction = hasOpenReceivables
        ? "Collect open invoices first and rebuild operating cash to target before any extra debt payment."
        : "Rebuild operating cash to target before any extra debt payment. Keep paying the monthly minimum only.";
      risk = "Reducing cash now could push operations below a safe working-capital floor.";
    } else if (hasOpenReceivables && overdueCount > 0) {
      toneClass = "warn";
      recommendation = "Collect open invoices before reducing cash.";
      nextAction = "Work overdue invoices first, then re-check profit cash before any extra debt payment.";
      risk = "Paying extra debt before overdue collections clear can tighten working capital.";
    } else if (!paymentRange.allowed) {
      /* Liquidity acceptable but no clearly-safe profit capacity for extra debt. */
      toneClass = "neutral";
      recommendation = "No extra payment recommended today.";
      nextAction = hasOpenReceivables
        ? "Collect open invoices, then re-check profit cash before an extra payment."
        : "Wait until confirmed profit cash is available for an extra payment.";
      risk = "Paying from unconfirmed surplus could drain operating cash or reserves.";
    } else if (paymentRange.contingent) {
      toneClass = "neutral";
      recommendation = "Collect open invoices before reducing cash.";
      nextAction = paymentRange.label;
      risk = "Pending invoices are not cash; do not reduce cash until collections clear.";
    } else {
      /* Liquidity healthy AND conservative profit-only payment capacity exists. */
      toneClass = "ok";
      recommendation = "No collection priority today. Review a controlled debt payment from profit cash only.";
      nextAction = paymentRange.label;
      risk = "Do not pay from tax reserve, savings, invoices, or operating cash below target.";
    }

    const impact = buildEstimatedImpact(paymentRange, monthlyInterestEstimate, dailyInterestEstimate);

    return {
      toneClass,
      recommendation: refinePrimaryRecommendation(actionCtx, recommendation),
      why,
      nextAction,
      risk,
      impact,
      signals,
      topActions,
      interest: {
        monthly: monthlyInterestEstimate,
        daily: dailyInterestEstimate,
        annual: annualInterestEstimate,
      },
      safeAvailableCash: safeCashBreakdown.safeAvailableCash,
      safeCashSummary: buildSafeCashSummary(safeCashBreakdown),
      paymentRange,
    };
  }

  function buildDecisionSignals(ctx) {
    const {
      operatingCash,
      operatingMinTarget,
      runwayMonths,
      taxReserve,
      openBalance,
      overdueCount,
      creditCardBalance,
      apr,
      monthlyMinimum,
      invoiceDataAvailable,
      operatingTargetKnown,
      safeAvailableCash,
    } = ctx;

    const signals = [];
    const debtInputMissing =
      !Number.isFinite(creditCardBalance) || creditCardBalance <= 0 ||
      !Number.isFinite(apr) || apr <= 0;

    /* Liquidity Status */
    if (!operatingTargetKnown) {
      signals.push({ label: "Liquidity Status", tone: "neutral", value: "Unknown", note: "Set operating cash target." });
    } else if (operatingCash >= operatingMinTarget && runwayMonths >= 3) {
      signals.push({ label: "Liquidity Status", tone: "ok", value: "Healthy", note: "Operating cash at or above target." });
    } else {
      signals.push({ label: "Liquidity Status", tone: "warn", value: "Under pressure", note: "Operating cash below target or thin runway." });
    }

    /* Debt Pressure */
    if (debtInputMissing) {
      signals.push({ label: "Debt Pressure", tone: "neutral", value: "Needs debt input", note: "Enter credit card balance and APR." });
    } else if (Number.isFinite(monthlyMinimum) && monthlyMinimum > 0) {
      signals.push({ label: "Debt Pressure", tone: "warn", value: "Active", note: `Minimum due tracked (${formatMoney(monthlyMinimum)}/mo).` });
    } else {
      signals.push({ label: "Debt Pressure", tone: "warn", value: "Active", note: "Outstanding balance present." });
    }

    /* Invoice Collection Priority */
    if (!invoiceDataAvailable) {
      signals.push({ label: "Invoice Collection Priority", tone: "neutral", value: "Unknown", note: "Invoice data unavailable." });
    } else if (openBalance > 0 && overdueCount > 0) {
      signals.push({ label: "Invoice Collection Priority", tone: "warn", value: "High", note: `${formatMoney(openBalance)} open · ${overdueCount} overdue.` });
    } else if (openBalance > 0) {
      signals.push({ label: "Invoice Collection Priority", tone: "amber", value: "Moderate", note: `${formatMoney(openBalance)} open (not cash yet).` });
    } else {
      signals.push({ label: "Invoice Collection Priority", tone: "ok", value: "Clear", note: "No open receivables detected." });
    }

    /* Reserve Protection */
    if (taxReserve > 0) {
      signals.push({ label: "Reserve Protection", tone: "ok", value: "Protected", note: "Tax reserve is set aside." });
    } else {
      signals.push({ label: "Reserve Protection", tone: "warn", value: "Low / unset", note: "Tax reserve is low or not entered." });
    }

    /* Safe Cash Available */
    if (!operatingTargetKnown) {
      signals.push({
        label: "Safe Cash Available",
        tone: safeAvailableCash > 0 ? "neutral" : "neutral",
        value: formatMoney(safeAvailableCash),
        note: "Set operating cash target to include operating surplus.",
      });
    } else if (safeAvailableCash > 0) {
      signals.push({ label: "Safe Cash Available", tone: "ok", value: formatMoney(safeAvailableCash), note: "Excludes tax, savings, and invoices." });
    } else {
      signals.push({ label: "Safe Cash Available", tone: "neutral", value: formatMoney(0), note: "No protected surplus confirmed." });
    }

    return signals;
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function renderSignals(signals) {
    if (!Array.isArray(signals) || !signals.length) {
      return `<p class="ofa-empty">No decision signals available yet.</p>`;
    }
    return signals
      .map(
        (sig) => `
      <div class="ofa-signal ofa-signal--${escapeHtml(sig.tone || "neutral")}">
        <div class="ofa-signal__label">${escapeHtml(sig.label)}</div>
        <div class="ofa-signal__value">${escapeHtml(sig.value)}</div>
        <div class="ofa-signal__note">${escapeHtml(sig.note || "")}</div>
      </div>`
      )
      .join("");
  }

  function renderWhy(why) {
    if (!Array.isArray(why) || !why.length) return "";
    return `<ul class="ofa-why">${why.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`;
  }

  function formatAprPercent(apr) {
    const n = num(apr, NaN);
    if (!Number.isFinite(n)) return "";
    return n % 1 === 0 ? `${Math.round(n)}%` : `${n.toFixed(2).replace(/\.?0+$/, "")}%`;
  }

  function mapPaymentSafetyStatus(paymentRange) {
    const reason = String(paymentRange?.reason || "");
    if (reason === "cash-protection") {
      return "Blocked — Protect operating cash, runway, or business health first.";
    }
    if (reason === "collect-overdue") {
      return "Blocked — Collect overdue invoices before reducing cash.";
    }
    if (reason === "no-profit-capacity") {
      return "Blocked — No confirmed profit cash available for extra payment.";
    }
    return "";
  }

  function formatMonthlyInterestSavings(apr, low, high) {
    const rateMonthly = apr / 100 / 12;
    const savingsLow = low > 0 ? low * rateMonthly : null;
    const savingsHigh = high > 0 ? high * rateMonthly : null;
    if (savingsLow != null && savingsHigh != null && savingsLow !== savingsHigh) {
      return `~${formatMoney(savingsLow)}–${formatMoney(savingsHigh)}`;
    }
    if (savingsHigh != null) {
      return `~${formatMoney(savingsHigh)}`;
    }
    if (savingsLow != null) {
      return `~${formatMoney(savingsLow)}`;
    }
    return null;
  }

  function buildDebtAnalysisPanel(result, debtRaw) {
    const balance = num(debtRaw?.creditCardBalance, NaN);
    const apr = num(debtRaw?.apr, NaN);
    const balanceMissing = !Number.isFinite(balance) || balance <= 0;
    const aprMissing = !Number.isFinite(apr) || apr <= 0;
    const disclaimer =
      '<p class="ofa-debt__hint">Estimate only. Not tax, accounting, legal, or banking advice.</p>';

    if (balanceMissing && aprMissing) {
      return `
          <details class="ofa-debt">
            <summary class="ofa-debt__summary">Debt Analysis</summary>
            ${disclaimer}
            <p class="ofa-block__text">Debt details incomplete.<br>Enter credit card balance and APR to estimate interest cost and payment savings.</p>
          </details>`;
    }
    if (balanceMissing) {
      return `
          <details class="ofa-debt">
            <summary class="ofa-debt__summary">Debt Analysis</summary>
            ${disclaimer}
            <p class="ofa-block__text">Credit card balance is required to estimate interest cost.</p>
          </details>`;
    }
    if (aprMissing) {
      return `
          <details class="ofa-debt">
            <summary class="ofa-debt__summary">Debt Analysis</summary>
            ${disclaimer}
            <p class="ofa-block__text">APR is required to estimate interest cost.</p>
          </details>`;
    }

    const daily = result?.interest?.daily;
    const monthly = result?.interest?.monthly;
    const annual =
      result?.interest?.annual != null ? result.interest.annual : balance * (apr / 100);
    const paymentRange = result?.paymentRange || {};
    const lines = [
      `Current Debt: ${formatMoney(balance)}`,
      `APR: ${formatAprPercent(apr)}`,
      `Estimated Daily Interest: ~${formatMoney(daily)}`,
      `Estimated Monthly Interest: ~${formatMoney(monthly)}`,
      `Estimated Annual Interest: ~${formatMoney(annual)}`,
    ];

    if (paymentRange.allowed && paymentRange.contingent) {
      lines.push(paymentRange.label || "Consider payment only after invoice collection clears.");
      const high = num(paymentRange.high, 0);
      const savingsHigh = high > 0 ? high * (apr / 100 / 12) : null;
      if (savingsHigh != null) {
        lines.push(
          `Estimated Monthly Interest Savings: Up to ~${formatMoney(savingsHigh)} after collection clears. Estimate only.`
        );
      }
      lines.push("Payment Safety Status: Conditional — pending invoices are not cash.");
    } else if (paymentRange.allowed) {
      lines.push(paymentRange.label || "Safe payment range: review profit cash only.");
      const savingsRange = formatMonthlyInterestSavings(
        apr,
        num(paymentRange.low, 0),
        num(paymentRange.high, 0)
      );
      if (savingsRange) {
        lines.push(`Estimated Monthly Interest Savings: ${savingsRange}. Estimate only.`);
      }
      lines.push(
        "Payment Safety Status: Approved for review from profit cash only. Operating cash, tax reserve, savings, and invoices must stay protected."
      );
    } else {
      lines.push("Safe Payment Range: Not recommended today.");
      lines.push("Estimated Interest Savings: Not estimated — extra payment is blocked today.");
      const safetyStatus = mapPaymentSafetyStatus(paymentRange);
      if (safetyStatus) {
        lines.push(`Payment Safety Status: ${safetyStatus}`);
      }
    }

    return `
          <details class="ofa-debt">
            <summary class="ofa-debt__summary">Debt Analysis</summary>
            ${disclaimer}
            <p class="ofa-block__text">${lines.map((line) => escapeHtml(line)).join("<br>")}</p>
          </details>`;
  }

  function bindDebtInputs(root) {
    if (!root || root.dataset.ofaBound === "1") return;
    root.dataset.ofaBound = "1";
    const ids = ["ofaDebtBalance", "ofaDebtApr", "ofaDebtMinimum", "ofaOperatingTarget"];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("input", () => {
        saveDebtInputs({
          creditCardBalance: document.getElementById("ofaDebtBalance")?.value ?? "",
          apr: document.getElementById("ofaDebtApr")?.value ?? "",
          monthlyMinimum: document.getElementById("ofaDebtMinimum")?.value ?? "",
          operatingCashMinTarget: document.getElementById("ofaOperatingTarget")?.value ?? "",
        });
        rerenderFromStoredSnapshot(root);
      });
    });
  }

  /* Cache last snapshot passed from Dashboard so debt-input edits can re-render
     without needing a full Dashboard refresh. Read-only; no app data written. */
  let lastSnapshot = null;

  function rerenderFromStoredSnapshot(root) {
    if (!lastSnapshot) return;
    renderInto(root, lastSnapshot);
  }

  function renderInto(root, snapshot) {
    if (!root) return;
    lastSnapshot = snapshot;

    const debtRaw = loadDebtInputs();
    const debtNumbers = {
      creditCardBalance: debtRaw.creditCardBalance,
      apr: debtRaw.apr,
      monthlyMinimum: debtRaw.monthlyMinimum,
      operatingCashMinTarget: debtRaw.operatingCashMinTarget,
    };

    const result = computeAdvisorRecommendation(snapshot, debtNumbers);

    root.innerHTML = `
      <section class="card ofa-card" aria-label="Owner Financial Advisor">
        <div class="card-inner">
          <div class="ofa-head">
            <div>
              <h2 class="ofa-title">Owner Financial Advisor™</h2>
              <p class="ofa-sub">Read-only guidance from your existing cash and invoice data. Not accounting, tax, legal, or banking advice.</p>
            </div>
            <span class="ofa-badge ofa-badge--${escapeHtml(result.toneClass)}">AI CFO™</span>
          </div>

          <div class="ofa-rec ofa-rec--${escapeHtml(result.toneClass)}">
            <div class="ofa-rec__label">Today’s Recommendation</div>
            <div class="ofa-rec__text">${escapeHtml(result.recommendation)}</div>
            <p class="ofa-block__text">${escapeHtml(result.safeCashSummary || "")}</p>
          </div>

          ${renderTopActions(result.topActions)}

          <div class="ofa-grid">
            <div class="ofa-block">
              <h3 class="ofa-block__title">Why</h3>
              ${renderWhy(result.why)}
            </div>
            <div class="ofa-block">
              <h3 class="ofa-block__title">Next best action</h3>
              <p class="ofa-block__text">${escapeHtml(result.nextAction)}</p>
            </div>
            <div class="ofa-block">
              <h3 class="ofa-block__title">Risk warning</h3>
              <p class="ofa-block__text">${escapeHtml(result.risk)}</p>
            </div>
            <div class="ofa-block">
              <h3 class="ofa-block__title">Estimated impact</h3>
              <p class="ofa-block__text">${escapeHtml(result.impact)}</p>
            </div>
          </div>

          <div class="ofa-signals-wrap">
            <h3 class="ofa-block__title">Decision Signals</h3>
            <div class="ofa-signals">${renderSignals(result.signals)}</div>
          </div>

          ${buildDebtAnalysisPanel(result, debtRaw)}

          <details class="ofa-debt">
            <summary class="ofa-debt__summary">Manual debt inputs (v1)</summary>
            <p class="ofa-debt__hint">Stored only in your browser. No bank connection, no payment, no app data is written.</p>
            <div class="ofa-debt__grid">
              <label class="ofa-field">
                <span>Credit card balance</span>
                <input type="number" step="0.01" min="0" id="ofaDebtBalance" value="${escapeHtml(debtRaw.creditCardBalance)}" placeholder="0" />
              </label>
              <label class="ofa-field">
                <span>APR (%)</span>
                <input type="number" step="0.01" min="0" id="ofaDebtApr" value="${escapeHtml(debtRaw.apr)}" placeholder="0" />
              </label>
              <label class="ofa-field">
                <span>Monthly minimum</span>
                <input type="number" step="0.01" min="0" id="ofaDebtMinimum" value="${escapeHtml(debtRaw.monthlyMinimum)}" placeholder="0" />
              </label>
              <label class="ofa-field">
                <span>Operating cash min target</span>
                <input type="number" step="0.01" min="0" id="ofaOperatingTarget" value="${escapeHtml(debtRaw.operatingCashMinTarget)}" placeholder="Defaults to monthly operating cost" />
              </label>
            </div>
          </details>
        </div>
      </section>`;

    // Re-bind after innerHTML replace (dataset flag lives on root, reset it here).
    root.dataset.ofaBound = "";
    bindDebtInputs(root);
  }

  /**
   * Public entry point called by the Dashboard refresh hook in app.js.
   * Accepts existing computed Dashboard/hub values only. Never throws.
   */
  function renderOwnerFinancialAdvisor(input) {
    try {
      const root = document.getElementById("ownerFinancialAdvisorRoot");
      if (!root) return;

      const i = input || {};
      const snapshot = {
        operatingCash: num(i.operatingCash, num(i.expensesBalance, 0)),
        profitCash: num(i.profitCash, num(i.profitBalance, 0)),
        savingsCash: num(i.savingsCash, num(i.savingsBalance, 0)),
        taxReserve: num(i.taxReserve, num(i.taxBalance, 0)),
        totalCash: num(i.totalCash, 0),
        operatingMonthly: num(i.operatingMonthly, 0),
        runwayMonths: num(i.runwayMonths, 0),
        openBalance: num(i.openBalance, 0),
        overdueCount: num(i.overdueCount, 0),
        overdueBalance: num(i.overdueBalance, 0),
        brokenPromiseCount: num(i.brokenPromiseCount, 0),
        readyToBillCount: num(i.readyToBillCount, 0),
        topCollectionAction: i.topCollectionAction && typeof i.topCollectionAction === "object" ? i.topCollectionAction : null,
        topInvoiceActions: Array.isArray(i.topInvoiceActions) ? i.topInvoiceActions.slice(0, 3) : [],
        healthScore: num(i.healthScore, 0),
        healthTone: String(i.healthTone || "neutral"),
        invoiceDataAvailable: i.invoiceDataAvailable !== false,
      };

      renderInto(root, snapshot);
    } catch (_e) {
      /* Read-only advisor must never break the Dashboard. */
    }
  }

  if (typeof window !== "undefined") {
    window.__mgRenderOwnerFinancialAdvisor = renderOwnerFinancialAdvisor;
    // Exposed for isolated testing; not required by the Dashboard.
    window.__mgOwnerAdvisorComputeRecommendation = computeAdvisorRecommendation;
  }
})();
