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

  const MISSING_DATA_FALLBACK =
    "Not enough financial data to recommend an extra debt payment today. " +
    "Complete operating cash target, debt balance, APR, and invoice collection status first.";

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

    const creditCardBalance = num(d.creditCardBalance, NaN);
    const apr = num(d.apr, NaN);
    const monthlyMinimum = num(d.monthlyMinimum, NaN);
    // Operating minimum target: prefer manual input, else fall back to monthly operating cost.
    const operatingMinTargetManual = num(d.operatingCashMinTarget, NaN);
    const operatingMinTarget = Number.isFinite(operatingMinTargetManual)
      ? operatingMinTargetManual
      : operatingMonthly;

    /* ---- Interest estimates (labeled, display-only) ---- */
    let monthlyInterestEstimate = null;
    let dailyInterestEstimate = null;
    if (Number.isFinite(creditCardBalance) && Number.isFinite(apr) && creditCardBalance > 0 && apr > 0) {
      monthlyInterestEstimate = creditCardBalance * (apr / 100 / 12);
      dailyInterestEstimate = creditCardBalance * (apr / 100 / 365);
    }

    /* ---- Missing data checks ---- */
    const missing = [];
    if (!Number.isFinite(creditCardBalance) || creditCardBalance <= 0) missing.push("credit card balance");
    if (!Number.isFinite(apr) || apr <= 0) missing.push("APR");
    if (operatingMonthly <= 0 && !Number.isFinite(operatingMinTargetManual)) missing.push("operating cash target");

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
      monthlyMinimum,
    });

    /* ---- Safe available cash (conservative) ----
       Excludes: tax reserve, operating minimum target, pending invoices, unconfirmed project revenue.
       Only PROFIT bucket surplus + operating cash ABOVE the minimum target counts. */
    const operatingSurplus = Math.max(0, operatingCash - Math.max(0, operatingMinTarget));
    const safeAvailableCash = Math.max(0, profitCash) + operatingSurplus;

    /* ---- Fallback when core debt data is missing ---- */
    if (missing.length > 0) {
      return {
        toneClass: "neutral",
        recommendation: MISSING_DATA_FALLBACK,
        why: [
          missing.length
            ? `Missing inputs: ${missing.join(", ")}.`
            : "Some required inputs are incomplete.",
          "Pending invoices are not cash until collected.",
          "Tax reserve must stay protected.",
        ],
        nextAction:
          "Complete the manual debt inputs below and confirm your operating cash target, then review again.",
        risk: "Acting without complete data could drain working capital or reserves.",
        impact:
          monthlyInterestEstimate != null
            ? `Estimated interest at current balance: ~${formatMoney(monthlyInterestEstimate)}/month (~${formatMoney(dailyInterestEstimate)}/day). Estimate only.`
            : "Interest impact unavailable until debt balance and APR are entered.",
        signals,
        interest: { monthly: monthlyInterestEstimate, daily: dailyInterestEstimate },
        safeAvailableCash: null,
      };
    }

    const why = [];
    let recommendation;
    let toneClass;
    let nextAction;
    let risk;

    const operatingBelowTarget = operatingCash < operatingMinTarget;
    const runwayThin = operatingMonthly > 0 && runwayMonths < 3;
    const hasOpenReceivables = openBalance > 0;

    if (operatingBelowTarget || runwayThin || healthTone === "red") {
      /* Do NOT recommend extra debt payment: liquidity is stressed. */
      toneClass = "warn";
      recommendation = "Do not make an extra credit card payment today.";
      if (operatingBelowTarget) {
        why.push(`Operating cash (${formatMoney(operatingCash)}) is below your target (${formatMoney(operatingMinTarget)}).`);
      }
      if (runwayThin) {
        why.push(`Runway is thin (~${runwayMonths.toFixed(1)} months); protect working capital.`);
      }
      if (hasOpenReceivables) {
        why.push(`${formatMoney(openBalance)} is still outstanding in the Invoice Hub (not cash until collected).`);
      }
      why.push("Tax reserve must stay protected.");
      nextAction = hasOpenReceivables
        ? "Collect open invoices first and rebuild operating cash to target before any extra debt payment."
        : "Rebuild operating cash to target before any extra debt payment. Keep paying the monthly minimum only.";
      risk = "Reducing cash now could push operations below a safe working-capital floor.";
    } else if (safeAvailableCash <= 0) {
      /* Liquidity acceptable but no clearly-safe surplus. */
      toneClass = "neutral";
      recommendation = "Safe surplus is not confirmed yet. Hold extra credit card payments for now.";
      why.push("No confirmed safe surplus above your operating minimum and protected profit.");
      if (hasOpenReceivables) {
        why.push(`${formatMoney(openBalance)} in open invoices is not cash until collected.`);
      }
      why.push("Total cash is not spendable cash; tax reserve stays protected.");
      nextAction = hasOpenReceivables
        ? "Collect open invoices, then re-check for a confirmed safe surplus before an extra payment."
        : "Wait until a confirmed safe surplus appears in profit or operating cash above target.";
      risk = "Paying from unconfirmed surplus could drain operating cash or reserves.";
    } else {
      /* Liquidity healthy AND a conservative safe surplus exists. */
      toneClass = "ok";
      const suggestLow = Math.max(0, Math.min(safeAvailableCash, Math.round(safeAvailableCash * 0.5)));
      const suggestHigh = Math.max(suggestLow, Math.round(safeAvailableCash));
      recommendation = `A controlled extra credit card payment of ${formatMoneyRange(suggestLow, suggestHigh)} may be supportable after protecting reserves.`;
      why.push(`Safe available cash (profit surplus + operating above target) is ~${formatMoney(safeAvailableCash)}.`);
      why.push("Tax reserve and operating minimum target are excluded from this amount.");
      if (hasOpenReceivables) {
        why.push(`${formatMoney(openBalance)} in open invoices is excluded (not counted as cash).`);
      }
      why.push("This is not automated — you decide and execute the payment manually.");
      nextAction = `Review a controlled ${formatMoneyRange(suggestLow, suggestHigh)} payment while keeping the operating minimum and tax reserve intact.`;
      risk = "Even with surplus, keep the operating floor and tax reserve untouched.";
    }

    let impact;
    if (monthlyInterestEstimate != null) {
      impact = `Current interest is roughly ${formatMoney(monthlyInterestEstimate)}/month (~${formatMoney(dailyInterestEstimate)}/day). Reducing the balance lowers this proportionally. Estimate only — not accounting, tax, legal, or banking advice.`;
    } else {
      impact = "Interest impact unavailable until debt balance and APR are entered.";
    }

    return {
      toneClass,
      recommendation,
      why,
      nextAction,
      risk,
      impact,
      signals,
      interest: { monthly: monthlyInterestEstimate, daily: dailyInterestEstimate },
      safeAvailableCash,
    };
  }

  function buildDecisionSignals(ctx) {
    const {
      operatingCash,
      operatingMinTarget,
      operatingMonthly,
      runwayMonths,
      taxReserve,
      openBalance,
      overdueCount,
      healthTone,
      creditCardBalance,
      monthlyMinimum,
    } = ctx;

    const signals = [];

    /* Liquidity Status */
    if (operatingMonthly <= 0 && !(operatingMinTarget > 0)) {
      signals.push({ label: "Liquidity Status", tone: "neutral", value: "Unknown", note: "Set operating cash target." });
    } else if (operatingCash >= operatingMinTarget && (runwayMonths >= 3 || operatingMonthly <= 0)) {
      signals.push({ label: "Liquidity Status", tone: "ok", value: "Healthy", note: "Operating cash at or above target." });
    } else {
      signals.push({ label: "Liquidity Status", tone: "warn", value: "Under pressure", note: "Operating cash below target or thin runway." });
    }

    /* Debt Pressure */
    if (!Number.isFinite(creditCardBalance) || creditCardBalance <= 0) {
      signals.push({ label: "Debt Pressure", tone: "neutral", value: "No data", note: "Enter credit card balance." });
    } else if (Number.isFinite(monthlyMinimum) && monthlyMinimum > 0) {
      signals.push({ label: "Debt Pressure", tone: "warn", value: "Active", note: `Minimum due tracked (${formatMoney(monthlyMinimum)}/mo).` });
    } else {
      signals.push({ label: "Debt Pressure", tone: "warn", value: "Active", note: "Outstanding balance present." });
    }

    /* Invoice Collection Priority */
    if (openBalance > 0 && overdueCount > 0) {
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

    /* Upcoming Project Cash Need */
    if (openBalance > 0) {
      signals.push({ label: "Upcoming Project Cash Need", tone: "amber", value: "Watch", note: "Open work may require working capital." });
    } else {
      signals.push({ label: "Upcoming Project Cash Need", tone: "neutral", value: "None flagged", note: "No open receivables to fund." });
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
          </div>

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
        readyToBillCount: num(i.readyToBillCount, 0),
        healthScore: num(i.healthScore, 0),
        healthTone: String(i.healthTone || "neutral"),
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
