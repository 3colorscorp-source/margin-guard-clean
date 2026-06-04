function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}
(() => {
  const LS_SETTINGS = "mg_settings_v2";
  const LS_OWNER = "mg_owner_v2";
  const LS_DASHBOARD = "mg_dashboard_v2";
  const LS_SALES = "mg_sales_v2";
  const LS_SUPERVISOR = "mg_supervisor_v2";
  const LS_APPROVALS = "mg_approvals_v2";
  const LS_ACTIVE_PROJECT = "mg_active_project_v1";
  const LS_PROJECTS = "mg_projects_v1";
  const LS_SUPERVISOR_REPORTS = "mg_supervisor_reports_v1";
  const LS_SUPERVISOR_SELECTED = "mg_supervisor_selected_project_v1";
  const LS_ESTIMATES = "mg_estimates_v1";
  const LS_ESTIMATE_DRAFT = "mg_estimate_draft_v1";
  const LS_HUB_VIEW = "mg_hub_view_v1";
  const LS_HUB_TEMPLATES = "mg_hub_templates_v1";
  const LS_BRANDING = "mg_business_branding_v1";
  const LS_ESTIMATE_BUILDER_DRAFT = "mg_estimate_builder_draft_v1";
  const TENANT_SNAPSHOT_VERSION = 1;
  const TENANT_STORAGE_KEYS = [
    LS_SETTINGS,
    LS_OWNER,
    LS_DASHBOARD,
    LS_SALES,
    LS_SUPERVISOR,
    LS_APPROVALS,
    LS_ACTIVE_PROJECT,
    LS_PROJECTS,
    LS_SUPERVISOR_REPORTS,
    LS_SUPERVISOR_SELECTED,
    LS_ESTIMATES,
    LS_ESTIMATE_DRAFT,
    LS_HUB_VIEW,
    LS_HUB_TEMPLATES,
    LS_BRANDING,
    LS_ESTIMATE_BUILDER_DRAFT
  ];

  const DEFAULTS = {
    bizName: "",
    publicLogoUrl: "",
    publicAccentColor: "#0f8a5f",
    currency: "$",
    baseInstaller: 75,
    baseHelper: 45,
    overheadMonthly: 0,
    stdHours: 160,
    pricingMode: "hour",
    hoursPerDay: 8,
    wcPct: 10.0,
    ficaPct: 7.65,
    futaPct: 0.6,
    casuiPct: 3.4,
    profitPct: 30,
    minimumMarginPct: 15,
    reservePct: 5,
    salesCommissionPct: 10,
    supervisorBonusPct: 1,
    workdaysEnabled: true,
    crewCapacity: 1,
    scheduleBufferDays: 2,
    allowSellerScheduleOverride: false,
    salesQuoteExpirationDays: 15
  };

  const DEFAULT_OWNER = {
    projectName: "",
    clientName: "",
    clientEmail: "",
    clientPhone: "",
    issueDate: "",
    expirationDate: "",
    committedDate: "",
    quoteNotes: "",
    location: "",
    dueDate: "",
    overheadMonthly: 0,
    stdHours: 0,
    reservePct: 5,
    workers: [
      { name: "Pro 1", type: "installer", hours: 40, rate: "" },
      { name: "Assistant 1", type: "helper", hours: 10, rate: "" }
    ]
  };

  const DEFAULT_DASHBOARD = {
    expensesBalance: 0,
    profitBalance: 0,
    savingsBalance: 0,
    taxBalance: 0,
    operatingMonthly: 0
  };

  const DEFAULT_SALES = {
    estimateNumber: "",
    estimateStatus: "draft",
    issueDate: "",
    expirationDate: "",
    projectName: "",
    clientName: "",
    customerEmail: "",
    additional_recipients: "",
    customerPhone: "",
    location: "",
    dueDate: "",
    startDate: "",
    targetFinishDate: "",
    offeredPrice: 0,
    messageToClient: "",
    notes: "",
    sentAt: "",
    workers: [
      { name: "Worker 1", type: "installer", days: 5, rate: "" }
    ],
    operational_plan: [],
    operational_estimated_days_override: "",
    price: "",
    pricingStage: 2,
    _sliderTouched: false,
    _manualPriceTouched: false,
  };

  const DEFAULT_SUPERVISOR = {
    projectId: "",
    projectName: "",
    estimatedDays: 0,
    laborBudget: 0,
    dueDate: "",
    projectedEndDate: "",
    locked: false,
    entries: [],
    extras: []
  };

  const tenantSyncState = {
    initialized: false,
    loading: false,
    saving: false,
    pending: false,
    timer: null,
    lastSerialized: "",
    lastSyncError: ""
  };

  const DEFAULT_HUB_TEMPLATES = {
    invoice_send: {
      subject: "Invoice {{invoice_no}} — {{project}}",
      body:
`Hello {{customer}},

Your project invoice is available for review.

Project: {{project}}
Invoice No: {{invoice_no}}
Invoice Date: {{invoice_date}}
Due Date: {{due_date}}
Contract total: {{total}}
Remaining invoice balance: {{balance}}

Reply if you need a revised copy or payment instructions.

Thank you.`
    },
    payment_request: {
      subject: "Invoice balance — {{invoice_no}} — {{project}}",
      body:
`Hello {{customer}},

This is a courtesy notice regarding the remaining balance on your project invoice.

Project: {{project}}
Invoice No: {{invoice_no}}
Due Date: {{due_date}}
Remaining invoice balance: {{balance}}

You can submit payment using the link on your invoice when ready.

Thank you.`
    }
  };

  const $ = (id) => document.getElementById(id);

  function parseJSON(raw, fallback) {
    try { return JSON.parse(raw); } catch (_err) { return fallback; }
  }

  function readStore(key, fallback) {
    const raw = localStorage.getItem(key);
    return raw ? parseJSON(raw, fallback) : fallback;
  }

  function writeStore(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
    scheduleTenantSnapshotSync();
  }

  function removeStore(key) {
    localStorage.removeItem(key);
    scheduleTenantSnapshotSync();
  }

  function money(value, currency) {
    const n = Number(value || 0);
    return `${currency || "$"}${(Number.isFinite(n) ? n : 0).toFixed(2)}`;
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[m]));
  }

  /** Cantidad labor (días u horas en UI Owner): enteros; "5.7" → 5 (misma idea que /sales, no concatenar dígitos). */
  function parseOwnerLaborQtyInput(value) {
    if (value == null) return { empty: true, displayInt: 0 };
    let s = String(value).trim();
    if (s === "") return { empty: true, displayInt: 0 };
    s = s.replace(/,/g, ".");
    const dot = s.indexOf(".");
    if (dot >= 0) s = s.slice(0, dot);
    s = s.replace(/\D/g, "");
    if (s === "") return { empty: true, displayInt: 0 };
    const n = Number(s);
    if (!Number.isFinite(n)) return { empty: false, displayInt: 0 };
    return { empty: false, displayInt: Math.max(0, Math.floor(n)) };
  }

  function normalizeLaborQty(value) {
    const p = parseOwnerLaborQtyInput(value);
    return p.empty ? 0 : p.displayInt;
  }

  function ownerLaborDisplayUnitsToHours(displayInt, settings, hoursPerDay) {
    const hpd = Math.max(Number(hoursPerDay || DEFAULTS.hoursPerDay), 0.25);
    if (settings.pricingMode === "day") return Math.max(0, displayInt) * hpd;
    return Math.max(0, displayInt);
  }

  function ownerLaborHoursToDisplayUnits(hours, settings, hoursPerDay) {
    const hpd = Math.max(Number(hoursPerDay || DEFAULTS.hoursPerDay), 0.25);
    const h = Math.max(0, Number(hours || 0));
    if (settings.pricingMode === "day") return Math.floor(h / hpd);
    return Math.floor(h);
  }

  if (typeof window !== "undefined") window.normalizeLaborQty = normalizeLaborQty;

  function toTitleCase(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function count(id, targetId) {
    const input = $(id);
    const target = $(targetId);
    if (input && target) target.textContent = String((input.value || "").length);
  }

  function val(id) { return $(id)?.value ?? ""; }
  function setVal(id, value) { if ($(id)) $(id).value = value ?? ""; }
  function num(id, fallback = 0) {
    const raw = $(id)?.value;
    if (raw === "" || raw == null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }
  function setNum(id, value) { if ($(id)) $(id).value = value ?? 0; }

  function healthClass(amount, warning, healthy) {
    if (amount >= healthy) return "green";
    if (amount >= warning) return "amber";
    return "red";
  }

  function nonEmptyString(...values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  /** Minimal To-address for quote email / Zapier (not full RFC). */
  function isClientEmailValidForQuoteSend(raw) {
    const s = String(raw == null ? "" : raw).trim();
    if (!s) return false;
    const at = s.indexOf("@");
    if (at < 1) return false;
    return s.indexOf(".", at + 1) > at;
  }

  function finiteNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function normalizeDateInput(value) {
    const text = nonEmptyString(value);
    if (!text) return "";
    const direct = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
    if (direct) return direct;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return "";
    return parsed.toISOString().slice(0, 10);
  }

  function formatDateUS(isoDateStr) {
    if (!isoDateStr) return "";
    const d = new Date(isoDateStr + "T00:00:00");
    if (isNaN(d.getTime())) return isoDateStr;

    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();

    return `${mm}/${dd}/${yyyy}`;
  }

  function inferSupervisorDueDate(saved, sales, owner) {
    return normalizeDateInput(nonEmptyString(
      saved?.dueDate,
      sales?.dueDate,
      sales?.targetDate,
      sales?.committedDate,
      sales?.projectDueDate,
      owner?.dueDate,
      owner?.targetDate,
      owner?.committedDate,
      owner?.projectDueDate
    ));
  }

  const SUPERVISOR_LABOR_PLAN_HOURS_PER_DAY = 8;
  const SUPERVISOR_PROJECTED_FINISH_BUSINESS_BUFFER = 2;

  function supervisorLaborRoleKey(type) {
    const t = String(type || "").trim().toLowerCase();
    if (t === "helper" || t === "assistant") return "assistant";
    return "pro";
  }

  function supervisorLaborRoleLabel(type) {
    return supervisorLaborRoleKey(type) === "assistant" ? "Assistant" : "Pro";
  }

  function supervisorLaborWorkerNameIsPlaceholder(name) {
    const n = String(name || "").trim();
    if (!n) return true;
    return /^(worker\s*\d+|pro\s*\d+|assistant\s*\d+|helper\s*\d+|installer\s*\d+)$/i.test(n);
  }

  function supervisorLaborPlanDisplayWorkerName(rawName, roleKey, indexWithinRole) {
    if (!supervisorLaborWorkerNameIsPlaceholder(rawName)) return String(rawName).trim();
    const seq = indexWithinRole + 1;
    return roleKey === "assistant" ? `Assistant ${seq}` : `Pro ${seq}`;
  }

  function supervisorChangeOrderTimeImpactFromWorkers(workers) {
    if (!Array.isArray(workers) || !workers.length) {
      return { proDaysAdded: 0, assistantDaysAdded: 0, impactDays: 0 };
    }
    let proDaysAdded = 0;
    let assistantDaysAdded = 0;
    for (const w of workers) {
      const days = finiteNumber(w?.days, 0);
      if (supervisorLaborRoleKey(w?.type) === "assistant") assistantDaysAdded += days;
      else proDaysAdded += days;
    }
    const impactDays = Math.max(proDaysAdded, assistantDaysAdded);
    return { proDaysAdded, assistantDaysAdded, impactDays };
  }

  function supervisorChangeOrderRowTimeImpact(row) {
    const workers = Array.isArray(row?.workers) ? row.workers : [];
    return supervisorChangeOrderTimeImpactFromWorkers(workers);
  }

  function supervisorFormatCoDaysLabel(value) {
    const n = finiteNumber(value, 0);
    if (n === 0) return "0 days";
    return `${n.toFixed(2)} days`;
  }

  /**
   * Tenant-level rate comes from Business Settings `supervisorBonusPct` (percent points, e.g. 5 = 5%).
   * bonus_base = labor_budget * (pct / 100). Timeline for delay/penalty: `effectiveDays` (labor plan max worker days when plan exists, else project estimated_days).
   */
  function computeSupervisorExecutionBonus({ laborBudget, effectiveDays, daysSpent, supervisorBonusPctPoints }) {
    const lb = finiteNumber(laborBudget, 0);
    const timeline = finiteNumber(effectiveDays, 0);
    const spent = finiteNumber(daysSpent, 0);
    const pctPoints = finiteNumber(supervisorBonusPctPoints, 0);
    const rate = pctPoints / 100;
    const bonusBase = lb * rate;
    const delayDays = Math.max(0, spent - timeline);
    const penaltyPerDay = timeline > 0 ? bonusBase / timeline : 0;
    const bonusActual = Math.max(0, bonusBase - delayDays * penaltyPerDay);
    const pctOfPotential = bonusBase > 0 ? Math.round((bonusActual / bonusBase) * 100) : 0;
    return { bonusBase, bonusActual, delayDays, penaltyPerDay, pctOfPotential, pctPoints };
  }

  function supervisorLaborPlanDisplayRows(workers) {
    if (!Array.isArray(workers) || !workers.length) return [];
    let proI = 0;
    let asstI = 0;
    return workers.map((w) => {
      const roleKey = supervisorLaborRoleKey(w.type);
      const idxWithinRole = roleKey === "assistant" ? asstI++ : proI++;
      const displayName = supervisorLaborPlanDisplayWorkerName(w?.name, roleKey, idxWithinRole);
      const days = finiteNumber(w?.days, 0);
      return {
        displayName,
        roleLabel: supervisorLaborRoleLabel(w.type),
        days,
        hours: days * SUPERVISOR_LABOR_PLAN_HOURS_PER_DAY,
      };
    });
  }

  function supervisorMaxPlanWorkerDays(workers) {
    if (!Array.isArray(workers) || !workers.length) return 0;
    let mx = 0;
    for (const w of workers) mx = Math.max(mx, finiteNumber(w?.days, 0));
    return mx;
  }

  function supervisorFormatYmdFromDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** If `ymd` falls on Sat/Sun, move forward to the next Monday–Friday (local calendar). */
  function supervisorSnapCommitmentToBusinessDay(ymd) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return null;
    const [y, mo, d] = ymd.split("-").map(Number);
    const cur = new Date(y, mo - 1, d);
    if (Number.isNaN(cur.getTime())) return null;
    for (let guard = 0; guard < 14; guard += 1) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) return cur;
      cur.setDate(cur.getDate() + 1);
    }
    return cur;
  }

  /**
   * Projected finish: walk forward on Mon–Fri only, counting the snapped commitment day as
   * business-day 1, until `ceil(maxWorkerDays) + 2` business days have been included.
   */
  function supervisorProjectedFinishFromCommitment(commitmentYmd, maxWorkerDays) {
    const span =
      Math.max(0, Math.ceil(finiteNumber(maxWorkerDays, 0))) + SUPERVISOR_PROJECTED_FINISH_BUSINESS_BUFFER;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(commitmentYmd || "")) || span <= 0) return "";
    let cur = supervisorSnapCommitmentToBusinessDay(commitmentYmd);
    if (!cur) return "";
    let counted = 0;
    for (let guard = 0; guard < 4000; guard += 1) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) counted += 1;
      if (counted >= span) return supervisorFormatYmdFromDate(cur);
      cur.setDate(cur.getDate() + 1);
    }
    return "";
  }

  function setSupervisorProjectedFinishDom(isoDate, opts) {
    const disp = $("supProjectedFinishDisplay");
    const meta = $("supProjectedFinishMeta");
    if (!disp) return;
    const unavailable = (opts && opts.unavailableText) || "Projected finish date unavailable";
    if (isoDate) {
      disp.textContent = formatDateUS(isoDate) || isoDate;
      if (meta) {
        meta.textContent =
          "Read-only. Based on commitment date, max budgeted days in the labor plan, plus 2 business-day buffer (Mon–Fri only).";
      }
    } else {
      disp.textContent = unavailable;
      if (meta) meta.textContent = "";
    }
  }

  /**
   * Project Control Center™ — metrics aligned with Supervisor dashboard logic.
   * @param project Tenant project row (estimatedDays, dueDate, workers, …)
   * @param reports Work report rows { days, hours, entry_date, note }
   * @param expensesList Unexpected expense rows (count only)
   */
  function computeProjectControlMetrics(
    project,
    reports,
    expensesList,
    migrationBaseline,
    dayProgressRows
  ) {
    const entries = Array.isArray(reports) ? reports : [];
    const extrasList = Array.isArray(expensesList) ? expensesList : [];
    const dayProgress = Array.isArray(dayProgressRows) ? dayProgressRows : [];
    const completedPlanDays = supervisorCountCompletedPlanDays(dayProgress);
    const mig =
      migrationBaseline && typeof migrationBaseline === "object"
        ? migrationBaseline
        : null;
    let estimatedDays = finiteNumber(project?.estimatedDays, 0);
    if (mig && finiteNumber(mig.estimated_total_days, 0) > 0) {
      estimatedDays = finiteNumber(mig.estimated_total_days, 0);
    }
    const reportedHours = entries.reduce((sum, row) => sum + finiteNumber(row?.hours, 0), 0);
    let daysSpent = entries.reduce((sum, row) => sum + finiteNumber(row?.days, 0), 0);
    if (mig) {
      const baselineDays = finiteNumber(mig.days_completed_to_date, 0);
      const cutoffRaw = mig.baseline_set_at || mig.updated_at;
      const cutoffMs = cutoffRaw ? new Date(cutoffRaw).getTime() : NaN;
      let newReportDays = 0;
      if (Number.isFinite(cutoffMs)) {
        newReportDays = entries.reduce((sum, row) => {
          const createdMs = new Date(row?.created_at || 0).getTime();
          if (!Number.isFinite(createdMs) || createdMs < cutoffMs) return sum;
          return sum + finiteNumber(row?.days, 0);
        }, 0);
      } else {
        newReportDays = entries.reduce((sum, row) => sum + finiteNumber(row?.days, 0), 0);
      }
      daysSpent = baselineDays + newReportDays;
    }
    if (completedPlanDays > 0) {
      daysSpent = Math.max(daysSpent, completedPlanDays);
    }
    const daysRemainingRaw = estimatedDays - daysSpent;
    const daysRemainingDisplay = Math.max(0, daysRemainingRaw);
    const daysRemaining = daysRemainingDisplay;
    let progressPct = estimatedDays > 0 ? (daysSpent / estimatedDays) * 100 : null;
    if (completedPlanDays > 0 && estimatedDays > 0) {
      progressPct = (completedPlanDays / estimatedDays) * 100;
    } else if (mig && progressPct != null) {
      progressPct = Math.max(finiteNumber(mig.progress_pct, 0), progressPct);
    } else if (mig && finiteNumber(mig.progress_pct, 0) > 0 && completedPlanDays <= 0) {
      progressPct = finiteNumber(mig.progress_pct, 0);
    }
    const unexpectedExpensesCount = extrasList.length;

    const workers = Array.isArray(project?.workers) ? project.workers : [];
    const maxPlanWorkerDays = supervisorMaxPlanWorkerDays(workers);
    const dueDate = normalizeDateInput(
      (mig && mig.target_finish_date) || project?.dueDate || ""
    );
    const projectedEndDate =
      dueDate && workers.length
        ? normalizeDateInput(supervisorProjectedFinishFromCommitment(dueDate, maxPlanWorkerDays))
        : "";

    let dayDelta = 0;
    if (dueDate && projectedEndDate) {
      dayDelta = Math.round(
        (new Date(projectedEndDate).getTime() - new Date(dueDate).getTime()) / (1000 * 60 * 60 * 24)
      );
    }

    const laborDeltaVsBudget = daysSpent - estimatedDays;
    let planDeviationLabel = "—";
    if (estimatedDays <= 0) {
      planDeviationLabel = "No budgeted days";
    } else if (laborDeltaVsBudget > 0 && dayDelta > 0) {
      planDeviationLabel = "Behind (labor & delivery)";
    } else if (laborDeltaVsBudget > 0) {
      planDeviationLabel = "Behind (labor)";
    } else if (dayDelta > 0) {
      planDeviationLabel = "Behind (delivery)";
    } else if (laborDeltaVsBudget < 0 && dayDelta < 0) {
      planDeviationLabel = "Ahead (labor & delivery)";
    } else if (laborDeltaVsBudget < 0 || dayDelta < 0) {
      planDeviationLabel = "Ahead (partial)";
    } else {
      planDeviationLabel = "On time";
    }

    let planDeviationDetail = "";
    if (estimatedDays <= 0) {
      planDeviationDetail =
        "No budgeted-day baseline. Compare commitment vs projected finish when both dates exist.";
    } else if (laborDeltaVsBudget > 0) {
      planDeviationDetail = `Labor: ${laborDeltaVsBudget.toFixed(2)} day(s) over budgeted days.`;
    } else if (laborDeltaVsBudget < 0) {
      planDeviationDetail = `Labor: ${Math.abs(laborDeltaVsBudget).toFixed(2)} day(s) under budgeted days.`;
    } else {
      planDeviationDetail = "Labor: aligned with budgeted days.";
    }
    if (dueDate && projectedEndDate) {
      if (dayDelta > 0) {
        planDeviationDetail += ` Projected finish ${dayDelta} calendar day(s) after commitment.`;
      } else if (dayDelta < 0) {
        planDeviationDetail += ` Projected finish ${Math.abs(dayDelta)} calendar day(s) before commitment.`;
      } else {
        planDeviationDetail += " Projected finish aligned with commitment.";
      }
    } else {
      planDeviationDetail += " Add commitment date and labor plan for finish projection.";
    }

    let tone = "green";
    if (daysRemainingDisplay <= 1 || dayDelta > 0 || laborDeltaVsBudget > 0) {
      tone = "yellow";
    }
    if (daysRemainingRaw < 0 || dayDelta > 2) {
      tone = "red";
    }

    const statusLabel = tone === "green" ? "On track" : tone === "yellow" ? "At risk" : "Delayed";

    return {
      daysSpent,
      daysRemaining,
      daysRemainingRaw,
      progressPct,
      reportedHours,
      unexpectedExpensesCount,
      dueDate,
      projectedEndDate,
      estimatedDays,
      planDeviationLabel,
      planDeviationDetail,
      dayDelta,
      laborDeltaVsBudget,
      tone,
      statusLabel
    };
  }

  window.__mgComputeProjectControlMetrics = computeProjectControlMetrics;

  function loadSettings() { return { ...DEFAULTS, ...readStore(LS_SETTINGS, {}) }; }
  function saveSettings(settings) { writeStore(LS_SETTINGS, settings); }
  function formatMoney(amount) {
    return money(finiteNumber(amount, 0), loadSettings().currency);
  }
  function buildEstimateNumber() {
    return "EST-" + String(Date.now());
  }
  function parseNumber(value) {
    return finiteNumber(value, 0);
  }
  const SALES_QUOTE_EXPIRATION_DAYS = 15;

  function salesQuoteExpirationDays(settings) {
    const n = finiteNumber(settings?.salesQuoteExpirationDays, SALES_QUOTE_EXPIRATION_DAYS);
    return n > 0 ? Math.floor(n) : SALES_QUOTE_EXPIRATION_DAYS;
  }

  function todayInputValue() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  function addDaysToInputValue(dateStr, days) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return "";
    d.setDate(d.getDate() + Number(days || 0));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  /** Local-calendar YYYY-MM-DD for hub form quick-date buttons (avoids UTC parse skew). */
  function hubQuickDateResolveValue(kind, offsetDays) {
    const anchor = new Date();
    anchor.setHours(12, 0, 0, 0);
    const fmt = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    };
    const addDays = (d, n) => {
      const x = new Date(d.getTime());
      x.setDate(x.getDate() + n);
      return x;
    };
    const k = String(kind || "today").trim();
    if (k === "today") return fmt(anchor);
    if (k === "tomorrow") return fmt(addDays(anchor, 1));
    if (k === "next_monday") {
      const d = new Date(anchor.getTime());
      const dow = d.getDay();
      let n = (8 - dow) % 7;
      if (n === 0) n = 7;
      return fmt(addDays(d, n));
    }
    if (k === "today_plus" && Number.isFinite(offsetDays)) return fmt(addDays(anchor, offsetDays));
    return fmt(anchor);
  }

  function loadOwner() {
    const saved = readStore(LS_OWNER, {});
    const merged = {
      ...DEFAULT_OWNER,
      ...saved,
      reservePct: DEFAULTS.reservePct,
      workers: Array.isArray(saved.workers) && saved.workers.length ? saved.workers : DEFAULT_OWNER.workers
    };
    merged.projectName = String(merged.projectName ?? "");
    merged.clientName = String(merged.clientName ?? "");
    merged.clientEmail = String(merged.clientEmail ?? "");
    merged.clientPhone = String(merged.clientPhone ?? "");
    merged.issueDate = normalizeDateInput(merged.issueDate);
    merged.expirationDate = normalizeDateInput(merged.expirationDate);
    merged.committedDate = normalizeDateInput(merged.committedDate);
    merged.quoteNotes = String(merged.quoteNotes ?? "");
    merged.location = String(merged.location ?? "");
    return merged;
  }
  function saveOwner(state, metrics) { writeStore(LS_OWNER, { ...state, reservePct: DEFAULTS.reservePct, metrics }); }

  /**
   * Owner active quote draft: full new-quote slate in mg_owner_v2 (and metrics).
   * Call after persist if you need the sent snapshot recorded first; this overwrites the active draft.
   */
  function resetOwnerDraftToNewQuote() {
    const settings = loadSettings();
    const prev = readStore(LS_OWNER, {});
    const today = todayInputValue();
    const expirationDate = addDaysToInputValue(today, 7);
    const workers = (DEFAULT_OWNER.workers || []).map((w) => ({
      name: String(w.name || "Worker"),
      type: w.type === "helper" ? "helper" : "installer",
      hours: 0,
      rate: ""
    }));
    const fresh = {
      projectName: "",
      clientName: "",
      clientEmail: "",
      clientPhone: "",
      issueDate: today,
      expirationDate,
      committedDate: "",
      quoteNotes: "",
      location: "",
      dueDate: "",
      overheadMonthly: 0,
      stdHours: 0,
      reservePct: DEFAULTS.reservePct,
      workers,
      laborTotal: 0,
      laborCost: 0,
      laborHours: 0,
      laborDays: 0,
      directLabor: 0,
      laborBurden: 0,
      estimateNumber: "",
      estimateStatus: "draft",
      messageToClient: "",
      notes: "",
      additional_recipients: "",
      customerEmail: "",
      quoteId: "",
      publicToken: "",
      publicQuoteUrl: "",
      sentAt: "",
      _manualPriceTouched: false,
      offeredPrice: 0,
      price: ""
    };
    const tid = prev.tenant_id;
    if (tid !== undefined && tid !== null && String(tid).trim() !== "") fresh.tenant_id = tid;
    const bid = prev.business_id;
    if (bid !== undefined && bid !== null && String(bid).trim() !== "") fresh.business_id = bid;
    const bId = prev.businessId;
    if (bId !== undefined && bId !== null && String(bId).trim() !== "") fresh.businessId = bId;
    saveOwner(fresh, calcOwner(fresh, settings));
    if (typeof console !== "undefined" && console.log) {
      console.log("[Owner New Quote] reset complete");
    }
  }

  function resetOwnerQuoteStateForNewQuote() {
    resetOwnerDraftToNewQuote();
  }

  function showOwnerNewQuoteModal() {
    const el = $("ownerNewQuoteModal");
    if (!el) return;
    el.classList.remove("hidden");
    el.setAttribute("aria-hidden", "false");
  }

  function hideOwnerNewQuoteModal() {
    const el = $("ownerNewQuoteModal");
    if (!el) return;
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
  }

  window.forceCloseSalesNewQuoteModal = function forceCloseSalesNewQuoteModal() {
    document
      .querySelectorAll(
        '[data-sales-new-quote-modal], #salesNewQuoteModal, .sales-new-quote-modal, .mg-modal, [role="dialog"]'
      )
      .forEach((el) => {
        if (el.textContent && el.textContent.includes("Start new quote?")) {
          el.classList.add("hidden");
          el.setAttribute("aria-hidden", "true");
          el.style.display = "none";
          el.style.visibility = "hidden";
          el.style.pointerEvents = "none";
        }
      });

    document.body.classList.remove("modal-open", "mg-modal-open", "overflow-hidden");
    document.documentElement.classList.remove("modal-open", "mg-modal-open", "overflow-hidden");
  };

  function showSalesNewQuoteModal() {
    const el = document.getElementById("salesNewQuoteModal");
    if (!el) return;
    el.classList.remove("hidden");
    el.style.removeProperty("display");
    el.style.removeProperty("visibility");
    el.style.removeProperty("pointer-events");
    el.setAttribute("aria-hidden", "false");
  }

  function hideSalesNewQuoteModal() {
    if (typeof window.forceCloseSalesNewQuoteModal === "function") {
      window.forceCloseSalesNewQuoteModal();
      return;
    }
    const el = document.getElementById("salesNewQuoteModal");
    if (!el) return;
    el.classList.add("hidden");
    el.setAttribute("aria-hidden", "true");
    el.style.display = "none";
    document.body.classList.remove("modal-open", "mg-modal-open", "overflow-hidden");
    document.documentElement.classList.remove("modal-open", "mg-modal-open", "overflow-hidden");
  }

  window.showSalesNewQuoteModal = showSalesNewQuoteModal;
  window.hideSalesNewQuoteModal = hideSalesNewQuoteModal;

  function setupSalesNewQuoteModalListeners() {
    const modal = document.getElementById("salesNewQuoteModal");
    if (!modal || modal.dataset.mgBound === "1") return;
    modal.dataset.mgBound = "1";
    modal.addEventListener("click", (e) => {
      if (e.target === modal) hideSalesNewQuoteModal();
    });
    const confirmBtn = document.getElementById("salesConfirmNewQuote");
    if (confirmBtn) {
      confirmBtn.addEventListener("click", () => {
        if (typeof window.performStandaloneNewQuoteReset !== "function") {
          console.error("[Sales New Quote] performStandaloneNewQuoteReset is not available");
          return;
        }
        try {
          window.performStandaloneNewQuoteReset();
        } catch (err) {
          console.error("[Sales New Quote] reset failed", err);
          return;
        }
        hideSalesNewQuoteModal();
      });
    }
    const cancelBtn = document.getElementById("salesCancelNewQuote");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => hideSalesNewQuoteModal());
    }
  }

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", setupSalesNewQuoteModalListeners);
    if (document.readyState !== "loading") setupSalesNewQuoteModalListeners();
  }

  function loadDashboard() { return { ...DEFAULT_DASHBOARD, ...readStore(LS_DASHBOARD, {}) }; }
  function saveDashboard(state) { writeStore(LS_DASHBOARD, state); }
  function loadSales() {
    const saved = readStore(LS_SALES, {});
    const owner = loadOwner();
    const hasProjectName = Object.prototype.hasOwnProperty.call(saved, "projectName");
    const hasClientName = Object.prototype.hasOwnProperty.call(saved, "clientName");
    const hasLocation = Object.prototype.hasOwnProperty.call(saved, "location");
    const hasEstimateNumber = Object.prototype.hasOwnProperty.call(saved, "estimateNumber");
    const issueDate = normalizeDateInput(saved.issueDate) || todayInputValue();
    return {
      ...DEFAULT_SALES,
      ...saved,
      estimateNumber: hasEstimateNumber
        ? String(saved.estimateNumber ?? "")
        : nonEmptyString(saved.estimateNumber) || buildEstimateNumber(),
      estimateStatus: nonEmptyString(saved.estimateStatus) || "draft",
      issueDate,
      expirationDate:
        normalizeDateInput(saved.expirationDate) ||
        addDaysToInputValue(issueDate, salesQuoteExpirationDays(loadSettings())),
      projectName: hasProjectName ? String(saved.projectName ?? "") : (owner.projectName || ""),
      clientName: hasClientName ? String(saved.clientName ?? "") : (owner.clientName || ""),
      customerEmail: String(saved.customerEmail ?? ""),
      additional_recipients: String(saved.additional_recipients ?? ""),
      customerPhone: String(saved.customerPhone ?? ""),
      location: hasLocation ? String(saved.location ?? "") : (owner.location || ""),
      messageToClient: String(saved.messageToClient ?? ""),
      workers: Array.isArray(saved.workers) && saved.workers.length ? saved.workers : DEFAULT_SALES.workers.map((worker) => ({ ...worker })),
      offeredPrice: saved.offeredPrice ?? 0
    };
  }
  function saveSales(state) { writeStore(LS_SALES, state); }

  /** Hub sales draft only: same shape as New Quote, no fake client-side quote numbers. */
  function resetSalesDraftToNewQuote() {
    const fresh = structuredClone(DEFAULT_SALES);
    fresh.issueDate = todayInputValue();
    fresh.expirationDate = addDaysToInputValue(fresh.issueDate, salesQuoteExpirationDays(loadSettings()));
    fresh.estimateStatus = "draft";
    fresh.price = "";
    fresh.notes = "";
    fresh.messageToClient = "";
    fresh.customerEmail = "";
    fresh.additional_recipients = "";
    fresh.customerPhone = "";
    fresh.location = "";
    fresh.projectName = "";
    fresh.clientName = "";
    saveSales(fresh);
  }
  function syncSellerWorkersUi(state, settings) {
    if (typeof renderSalesWorkers !== "function") return false;
    try {
      const metrics = typeof calculateSalesMetrics === "function"
        ? calculateSalesMetrics(state, settings)
        : calcSales(state, settings);
      renderSalesWorkers(state, settings, metrics);
      const hint = document.getElementById("salesCrewHint");
      if (hint) {
        const workerHours = Number(metrics.workerHours ?? metrics.totalHours ?? 0);
        const workersCount = Number(metrics.workersCount ?? (Array.isArray(state.workers) ? state.workers.length : 0));
        hint.textContent = `${workersCount} workers configured for ${workerHours.toFixed(2)} labor hours.`;
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  function addSellerWorkerFallback() {
    const state = loadSales();
    const settings = loadSettings();
    state.workers = Array.isArray(state.workers) && state.workers.length
      ? state.workers
      : cloneWorkers(DEFAULT_SALES.workers);
    state.workers.push({
      name: `Worker ${state.workers.length + 1}`,
      type: "installer",
      days: 0,
      rate: ""
    });
    saveSales(state);
    if (syncSellerWorkersUi(state, settings)) return;
    if (typeof renderSales === "function") {
      try {
        renderSales();
        return;
      } catch (_error) {}
    }
    window.location.reload();
  }

  function clearSellerWorkersFallback() {
    const state = loadSales();
    const settings = loadSettings();
    state.workers = cloneWorkers(DEFAULT_SALES.workers);
    saveSales(state);
    if (syncSellerWorkersUi(state, settings)) return;
    if (typeof renderSales === "function") {
      try {
        renderSales();
        return;
      } catch (_error) {}
    }
    window.location.reload();
  }

  window.__mgAddSalesWorker = addSellerWorkerFallback;
  window.__mgClearSalesWorkers = clearSellerWorkersFallback;

  if (!window.__mgSellerWorkerDelegationBound) {
    window.__mgSellerWorkerDelegationBound = true;
    document.addEventListener("click", (event) => {
      const addButton = event.target.closest("#btnAddSalesWorker");
      if (addButton) {
        event.preventDefault();
        addSellerWorkerFallback();
        return;
      }

      const clearButton = event.target.closest("#btnClearSalesWorkers");
      if (clearButton) {
        event.preventDefault();
        clearSellerWorkersFallback();
      }
    });
  }
  function loadSupervisor() {
    const saved = readStore(LS_SUPERVISOR, {});
    const owner = loadOwner();
    const sales = loadSales();
    const activeProject = loadActiveProject();
    const settings = loadSettings();
    const salesMetrics = calcSales(sales, settings);
    const activeProjectId = activeProject?.id || "";
    const savedEntries = Array.isArray(saved.entries) ? saved.entries : [];
    const savedExtras = Array.isArray(saved.extras) ? saved.extras : [];
    const projectChanged = Boolean(activeProjectId) && saved.projectId !== activeProjectId;
    const inferredEstimatedDays = finiteNumber(activeProject?.estimatedDays, finiteNumber(salesMetrics.totalWorkerDays, 0));
    const inferredLaborBudget = finiteNumber(activeProject?.laborBudget, finiteNumber(owner.metrics?.labor, 0));
    const locked = !projectChanged && (Boolean(saved.locked) || savedEntries.length > 0 || savedExtras.length > 0);
    const entries = projectChanged ? [] : savedEntries;
    const extras = projectChanged ? [] : savedExtras;
    const savedProjectData = projectChanged ? {} : saved;

    return {
      ...DEFAULT_SUPERVISOR,
      ...savedProjectData,
      projectId: activeProjectId || saved.projectId || "",
      projectName: locked
        ? nonEmptyString(savedProjectData.projectName, activeProject?.projectName, sales.projectName, owner.projectName)
        : nonEmptyString(activeProject?.projectName, sales.projectName, owner.projectName, savedProjectData.projectName),
      estimatedDays: locked
        ? finiteNumber(savedProjectData.estimatedDays, inferredEstimatedDays)
        : inferredEstimatedDays,
      laborBudget: locked
        ? finiteNumber(savedProjectData.laborBudget, inferredLaborBudget)
        : inferredLaborBudget,
      dueDate: locked
        ? inferSupervisorDueDate({ dueDate: savedProjectData.dueDate || activeProject?.dueDate }, {}, {})
        : inferSupervisorDueDate({ dueDate: activeProject?.dueDate || savedProjectData.dueDate }, sales, owner),
      projectedEndDate: projectChanged ? "" : (saved.projectedEndDate || ""),
      locked,
      entries,
      extras
    };
  }
  function saveSupervisor(state) { writeStore(LS_SUPERVISOR, state); }
  function loadApprovals() { const saved = readStore(LS_APPROVALS, []); return Array.isArray(saved) ? saved : []; }
  function saveApprovals(rows) { writeStore(LS_APPROVALS, rows); }
  function loadActiveProject() {
    const saved = readStore(LS_ACTIVE_PROJECT, null);
    return saved && typeof saved === "object" ? saved : null;
  }
  function saveActiveProject(project) { writeStore(LS_ACTIVE_PROJECT, project); }
  function clearActiveProject() { removeStore(LS_ACTIVE_PROJECT); }

  function loadProjects() {
    const saved = readStore(LS_PROJECTS, []);
    if (Array.isArray(saved) && saved.length) return saved;
    const legacy = loadActiveProject();
    if (legacy && typeof legacy === "object") {
      const migrated = [legacy];
      writeStore(LS_PROJECTS, migrated);
      return migrated;
    }
    return [];
  }

  function saveProjects(projects) {
    writeStore(LS_PROJECTS, Array.isArray(projects) ? projects : []);
  }

  /** Server-backed signed projects for Supervisor UI (replaces LS_PROJECTS for that surface). */
  let supervisorProjectsCache = null;

  /** Last project id painted in Supervisor `refresh()`; used to clear caches and DOM bleed on switch. */
  let supervisorLastRefreshedProjectId = null;

  /** Last supervisor project id used to force an in-memory empty slice before reloading report state on switch. */
  let lastSupervisorProjectId = null;

  /** projectId -> { ok: boolean, reports: array } for tenant_project_reports (Supervisor daily entries). */
  const supervisorProjectReportsCache = Object.create(null);
  const supervisorProjectReportsFetchInFlight = new Set();

  /** Drop API rows whose project_id does not match the requested project (trace cross-tenant/project leaks). */
  function filterFetchedTenantRowsForProjectId(rows, projectId, resourceLabel) {
    const want = supervisorProjectKey(projectId);
    if (!want || !Array.isArray(rows)) return [];
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r || typeof r !== "object") continue;
      const rid = r.project_id;
      if (rid == null || rid === "") {
        if (typeof console !== "undefined" && console.warn) {
          console.warn("[MG Supervisor] Dropping API row without project_id", { resource: resourceLabel });
        }
        continue;
      }
      if (supervisorProjectKey(rid) !== want) {
        if (typeof console !== "undefined" && console.error) {
          console.error("[MG ERROR] Cross-project data detected", {
            resource: resourceLabel,
            projectIdRequested: want,
            rowProjectId: rid,
            row: r,
          });
        }
        continue;
      }
      out.push(r);
    }
    return out;
  }

  async function fetchProjectReports(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return { ok: false, reports: [] };
    const res = await fetch(
      `/.netlify/functions/get-project-reports?project_id=${encodeURIComponent(id)}`,
      { credentials: "include" }
    );
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return { ok: false, reports: [] };
    const raw = Array.isArray(data.reports) ? data.reports : [];
    if (typeof console !== "undefined" && console.log) {
      console.log("[MG FETCH]", {
        resource: "reports",
        projectIdRequested: id,
        rowsReturned: raw.length,
        sampleRowProjectId: raw[0]?.project_id,
      });
    }
    const reports = filterFetchedTenantRowsForProjectId(raw, id, "reports");
    return { ...data, reports };
  }

  /** Canonical id for Supervisor LS + API caches (avoids string vs number equality misses). */
  function supervisorProjectKey(projectId) {
    return String(projectId == null ? "" : projectId).trim();
  }

  function isServerListedSupervisorProject(projectId) {
    const pid = supervisorProjectKey(projectId);
    if (!pid) return false;
    return getSupervisorProjectsForUi().some((p) => supervisorProjectKey(p.id) === pid);
  }

  /** Picker-visible project for Supervisor report/expense submit (not stale LS-only lookup). */
  function resolveActiveSupervisorProject() {
    const uiList = getSupervisorProjectsForUi();
    if (!uiList.length) return null;
    const pickerVal = supervisorProjectKey($("supProjectPicker")?.value || "");
    const lsSel = supervisorProjectKey(loadSupervisorSelectedProjectId());
    const wantId = pickerVal || lsSel;
    if (wantId) {
      const found = uiList.find((p) => supervisorProjectKey(p.id) === wantId);
      if (found) return found;
    }
    return uiList[0] || null;
  }

  async function recalcProjectProfitIfListed(projectId) {
    const pid = supervisorProjectKey(projectId);
    if (!pid || !isServerListedSupervisorProject(pid)) return;
    try {
      const res = await fetch("/.netlify/functions/recalc-project-profit", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: pid }),
      });
      await res.json().catch(() => ({}));
    } catch (_e) {
      /* non-fatal */
    }
  }

  /** projectId -> { ok, operational_snapshot?, error? } from get-supervisor-operational-snapshot */
  const supervisorProjectOperationalCache = Object.create(null);
  const supervisorProjectOperationalFetchInFlight = new Set();
  let supervisorActiveDayContext = null;

  function cacheSupervisorOperationalSnapshotFromFetch(pid, data) {
    const k = supervisorProjectKey(pid);
    if (!k) return;
    if (data && data.ok === true) {
      supervisorProjectOperationalCache[k] = {
        ok: true,
        snapshot:
          data.operational_snapshot && typeof data.operational_snapshot === "object"
            ? data.operational_snapshot
            : {},
        operational_plan: Array.isArray(data.operational_plan) ? data.operational_plan : [],
        schedule: data.schedule && typeof data.schedule === "object" ? data.schedule : {},
        has_execution_plan: Boolean(data.has_execution_plan),
        migration_baseline:
          data.migration_baseline && typeof data.migration_baseline === "object"
            ? data.migration_baseline
            : null,
        has_migrated_baseline: Boolean(data.has_migrated_baseline),
        show_migrated_execution: Boolean(data.show_migrated_execution),
        migrated_field_context:
          data.migrated_field_context && typeof data.migrated_field_context === "object"
            ? data.migrated_field_context
            : null,
        day_progress: Array.isArray(data.day_progress) ? data.day_progress : [],
      };
    } else {
      supervisorProjectOperationalCache[k] = {
        ok: false,
        error: (data && data.error) || "Field snapshot unavailable.",
      };
    }
  }

  async function loadSupervisorOperationalSnapshot(projectId, options) {
    const k = supervisorProjectKey(projectId);
    if (!k) return null;
    const force = Boolean(options && options.force);
    if (force) {
      delete supervisorProjectOperationalCache[k];
      supervisorProjectOperationalFetchInFlight.delete(k);
    }
    if (supervisorProjectOperationalCache[k] && !force) {
      return supervisorProjectOperationalCache[k];
    }
    if (supervisorProjectOperationalFetchInFlight.has(k)) {
      return supervisorProjectOperationalCache[k] || null;
    }
    supervisorProjectOperationalFetchInFlight.add(k);
    try {
      const data = await fetchSupervisorOperationalSnapshot(k);
      cacheSupervisorOperationalSnapshotFromFetch(k, data);
      return supervisorProjectOperationalCache[k];
    } catch (_e) {
      supervisorProjectOperationalCache[k] = {
        ok: false,
        error: "Field snapshot unavailable (network error).",
      };
      return supervisorProjectOperationalCache[k];
    } finally {
      supervisorProjectOperationalFetchInFlight.delete(k);
    }
  }

  function clearSupervisorProjectOperationalCache(pid) {
    if (pid) {
      delete supervisorProjectOperationalCache[pid];
      supervisorProjectOperationalFetchInFlight.delete(pid);
      return;
    }
    Object.keys(supervisorProjectOperationalCache).forEach((k) => {
      delete supervisorProjectOperationalCache[k];
    });
    supervisorProjectOperationalFetchInFlight.clear();
  }

  function buildSupervisorOperationalFallback(project, localState) {
    const estimatedDays = finiteNumber(project?.estimatedDays, 0);
    const entries = Array.isArray(localState?.entries) ? localState.entries : [];
    const actualDays = entries.reduce((sum, row) => sum + Number(row?.days || 0), 0);
    const actualHours = entries.reduce((sum, row) => sum + Number(row?.hours || 0), 0);
    const hpd = Math.max(Number(loadSettings()?.hoursPerDay || DEFAULTS.hoursPerDay), 0.25);
    const estimatedHours = estimatedDays > 0 ? estimatedDays * hpd : 0;
    const daysRemaining = Math.max(0, estimatedDays - actualDays);
    const laborBudget = finiteNumber(project?.laborBudget, 0);
    const laborDeviationDays = actualDays - estimatedDays;
    let laborDeviationLabel = "On budget";
    if (laborDeviationDays > 0) {
      laborDeviationLabel = `${laborDeviationDays.toFixed(2)} day(s) over budget`;
    } else if (laborDeviationDays < 0) {
      laborDeviationLabel = `${Math.abs(laborDeviationDays).toFixed(2)} day(s) under budget`;
    }
    let operationalRisk = "low";
    if (estimatedDays > 0 && actualDays > estimatedDays * 1.1) operationalRisk = "high";
    else if (estimatedDays > 0 && actualDays > estimatedDays) operationalRisk = "medium";
    return {
      labor_budget: laborBudget,
      actual_labor: 0,
      remaining_labor_budget: laborBudget,
      estimated_days: estimatedDays,
      actual_days: actualDays,
      days_remaining: daysRemaining,
      estimated_hours: estimatedHours,
      actual_hours: actualHours,
      labor_deviation_days: laborDeviationDays,
      labor_deviation_label: laborDeviationLabel,
      operational_risk: operationalRisk,
      supervisor_bonus_amount: 0,
      supervisor_bonus_status: "pending",
      supervisor_bonus_pct_of_potential: 0,
      report_count: entries.length,
      expense_count: Array.isArray(localState?.extras) ? localState.extras.length : 0,
      completion_pace_pct:
        estimatedDays > 0 ? Math.round((actualDays / estimatedDays) * 100) : null,
    };
  }

  function enrichOperationalSnapshotFromFieldCaches(pid, baseSnap, project, state, opts) {
    const snap = { ...(baseSnap && typeof baseSnap === "object" ? baseSnap : {}) };
    const hasMigration = Boolean(opts && opts.hasMigrationBaseline);
    const estFallback = finiteNumber(
      project?.estimatedDays,
      finiteNumber(state?.estimatedDays, 0)
    );
    const est = finiteNumber(snap.estimated_days, estFallback);
    if (!hasMigration && est > 0 && !finiteNumber(snap.estimated_days, 0)) {
      snap.estimated_days = est;
    }
    const repCache = supervisorProjectReportsCache[pid];
    const reportRows =
      Array.isArray(opts?.reportRows) && opts.reportRows.length
        ? opts.reportRows
        : repCache?.ok === true && Array.isArray(repCache.reports)
          ? repCache.reports
          : !hasMigration && Array.isArray(state?.entries)
            ? state.entries
            : [];
    if (!hasMigration && repCache?.ok === true && Array.isArray(repCache.reports)) {
      const fromReports = repCache.reports.reduce((s, r) => s + Number(r?.days || 0), 0);
      const fromHours = repCache.reports.reduce((s, r) => s + Number(r?.hours || 0), 0);
      snap.actual_days = Math.max(finiteNumber(snap.actual_days, 0), fromReports);
      snap.actual_hours = Math.max(finiteNumber(snap.actual_hours, 0), fromHours);
      snap.report_count = repCache.reports.length;
    } else if (!hasMigration && !Number.isFinite(Number(snap.actual_days))) {
      const entries = Array.isArray(state?.entries) ? state.entries : [];
      const fromEntries = entries.reduce((s, r) => s + Number(r?.days || 0), 0);
      snap.actual_days = Math.max(finiteNumber(snap.actual_days, 0), fromEntries);
      snap.actual_hours = entries.reduce((s, r) => s + Number(r?.hours || 0), 0);
      snap.report_count = entries.length;
    } else if (repCache?.ok === true && Array.isArray(repCache.reports)) {
      snap.report_count = repCache.reports.length;
    }
    const expCache = supervisorProjectExpensesCache[pid];
    if (expCache?.ok === true && Array.isArray(expCache.expenses)) {
      snap.expense_count = expCache.expenses.length;
    } else if (snap.expense_count == null) {
      snap.expense_count = Array.isArray(state?.extras) ? state.extras.length : 0;
    }
    const dayProgress = Array.isArray(opts?.dayProgress) ? opts.dayProgress : [];
    return applySupervisorUnifiedProgressToSnapshot(snap, {
      migrationBaseline: hasMigration ? opts?.migrationBaseline : null,
      dayProgressRows: dayProgress,
      reportRows,
      estimatedDaysFallback: estFallback,
    });
  }

  function buildSupervisorExecutionPlanFallback(project, estimatedDays) {
    const dayCount = Math.max(0, Math.ceil(finiteNumber(estimatedDays, 0)));
    if (dayCount <= 0) return [];
    const hpd = Math.max(Number(loadSettings()?.hoursPerDay || DEFAULTS.hoursPerDay), 0.25);
    const workers = Array.isArray(project?.workers) ? project.workers : [];
    const roles = [
      ...new Set(
        workers
          .map((w) =>
            String(w?.role || w?.type || w?.worker_type || "").trim()
          )
          .filter(Boolean)
      ),
    ];
    const dayWorkers = roles.length
      ? roles.map((role) => ({
          role,
          worker_type: "pro",
          estimated_hours: hpd,
        }))
      : [];
    const out = [];
    for (let d = 1; d <= dayCount; d += 1) {
      out.push({
        day_number: d,
        phase: supervisorFallbackPhaseLabel(d, dayCount),
        workers: dayWorkers.map((w) => ({ ...w })),
        plan_fallback: true,
      });
    }
    return out;
  }

  function buildMigratedCalendarPlan(baseline, estimatedDays) {
    const b = baseline && typeof baseline === "object" ? baseline : {};
    const est = Math.max(
      0,
      Math.ceil(
        finiteNumber(b.estimated_total_days, finiteNumber(estimatedDays, 0))
      )
    );
    if (est <= 0) return [];
    const completedThru = Math.max(
      0,
      Math.floor(finiteNumber(b.days_completed_to_date, 0))
    );
    const currentPhase = String(b.current_phase || "Continue scheduled work").trim();
    const out = [];
    for (let d = 1; d <= est; d += 1) {
      let phase = "Scheduled work";
      if (d < completedThru) phase = "Imported work completed";
      else if (d === completedThru) phase = currentPhase || "Imported work completed";
      else if (d === completedThru + 1) phase = currentPhase || "Continue scheduled work";
      out.push({
        day_number: d,
        phase,
        workers: [],
        migrated: true,
      });
    }
    return out;
  }

  function supervisorProgressMapWithMigratedBaseline(dayProgressRows, baseline) {
    const map = supervisorDayProgressMap(dayProgressRows);
    const thru = Math.max(
      0,
      Math.floor(finiteNumber(baseline?.days_completed_to_date, 0))
    );
    for (let d = 1; d <= thru; d += 1) {
      const key = String(d);
      const existing = map[key];
      if (existing && String(existing.status || "").toLowerCase() === "pending") {
        continue;
      }
      if (!existing || String(existing.status || "").toLowerCase() !== "completed") {
        map[key] = {
          day_number: d,
          status: "completed",
          completion_note: "Imported baseline",
        };
      }
    }
    return map;
  }

  function supervisorMigratedCurrentPlanDayIndex(baseline, execPlan) {
    const est = Array.isArray(execPlan) ? execPlan.length : 0;
    const thru = Math.max(
      0,
      Math.floor(finiteNumber(baseline?.days_completed_to_date, 0))
    );
    if (est <= 0) return 1;
    return Math.min(est, Math.max(1, thru + 1));
  }

  function resolveShowMigratedExecution(opCache) {
    if (!opCache || opCache.ok !== true) return false;
    const baseline =
      opCache.migration_baseline && typeof opCache.migration_baseline === "object"
        ? opCache.migration_baseline
        : null;
    if (!baseline) return false;
    return Boolean(opCache.show_migrated_execution || opCache.has_migrated_baseline);
  }

  function supervisorReportDaysAfterBaseline(reports, baseline) {
    if (!baseline || !Array.isArray(reports)) return 0;
    const cutoffRaw = baseline.baseline_set_at || baseline.updated_at;
    const cutoffMs = cutoffRaw ? new Date(cutoffRaw).getTime() : NaN;
    if (!Number.isFinite(cutoffMs)) {
      return reports.reduce((s, r) => s + finiteNumber(r?.days, 0), 0);
    }
    return reports.reduce((sum, row) => {
      const createdMs = new Date(row?.created_at || row?.createdAt || 0).getTime();
      if (!Number.isFinite(createdMs) || createdMs < cutoffMs) return sum;
      return sum + finiteNumber(row?.days, 0);
    }, 0);
  }

  function supervisorCountCompletedPlanDays(dayProgressRows) {
    return (Array.isArray(dayProgressRows) ? dayProgressRows : []).filter(
      (r) => r && String(r.status || "").toLowerCase() === "completed"
    ).length;
  }

  function supervisorMaxCompletedDayNumber(dayProgressRows) {
    return (Array.isArray(dayProgressRows) ? dayProgressRows : []).reduce((m, r) => {
      if (String(r?.status || "").toLowerCase() !== "completed") return m;
      return Math.max(m, Math.floor(finiteNumber(r?.day_number, 0)));
    }, 0);
  }

  /**
   * Single source of truth for Supervisor progress %, actual days, and days remaining.
   */
  function computeSupervisorUnifiedProgress(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const mig =
      o.migrationBaseline && typeof o.migrationBaseline === "object"
        ? o.migrationBaseline
        : null;
    const snap = o.snapshot && typeof o.snapshot === "object" ? o.snapshot : {};
    const dayProgress = Array.isArray(o.dayProgressRows) ? o.dayProgressRows : [];
    const reports = Array.isArray(o.reportRows) ? o.reportRows : [];
    const completedPlanDays = supervisorCountCompletedPlanDays(dayProgress);
    const maxCompletedDay = supervisorMaxCompletedDayNumber(dayProgress);
    const serverPace = snap.completion_pace_pct;
    const serverPaceNum =
      serverPace != null && serverPace !== "" && Number.isFinite(Number(serverPace))
        ? finiteNumber(serverPace, NaN)
        : NaN;

    let estimatedDays = finiteNumber(snap.estimated_days, finiteNumber(o.estimatedDaysFallback, 0));
    let actualDays = finiteNumber(snap.actual_days, 0);
    let progressPct =
      Number.isFinite(serverPaceNum) ? Math.round(serverPaceNum) : null;

    if (mig) {
      const est = finiteNumber(
        mig.estimated_total_days,
        finiteNumber(snap.estimated_days, estimatedDays)
      );
      estimatedDays = est > 0 ? est : estimatedDays;
      const baselineDays = finiteNumber(mig.days_completed_to_date, 0);
      const baselinePct = finiteNumber(mig.progress_pct, 0);
      const newReportDays = supervisorReportDaysAfterBaseline(reports, mig);
      actualDays = baselineDays + newReportDays;
      if (maxCompletedDay > 0) {
        actualDays = Math.max(actualDays, maxCompletedDay);
      }
      if (completedPlanDays > 0) {
        actualDays = Math.max(actualDays, completedPlanDays);
      }
      if (actualDays <= 0 && baselineDays > 0) {
        actualDays = baselineDays;
      }
      if (estimatedDays > 0) {
        const paceFromRatio = Math.round((actualDays / estimatedDays) * 100);
        progressPct =
          baselinePct > 0
            ? Math.max(baselinePct, paceFromRatio)
            : paceFromRatio;
      } else if (baselinePct > 0) {
        progressPct = Math.round(baselinePct);
      } else if (Number.isFinite(serverPaceNum)) {
        progressPct = Math.round(serverPaceNum);
      } else {
        progressPct = null;
      }
    } else {
      if (estimatedDays <= 0) {
        estimatedDays = finiteNumber(
          snap.estimated_days,
          finiteNumber(o.estimatedDaysFallback, 0)
        );
      }
      const reportDays = reports.reduce((s, r) => s + finiteNumber(r?.days, 0), 0);
      if (reportDays > 0) {
        actualDays = Math.max(actualDays, reportDays);
      }
      if (completedPlanDays > 0) {
        actualDays = Math.max(actualDays, completedPlanDays);
      }
      if (maxCompletedDay > 0) {
        actualDays = Math.max(actualDays, maxCompletedDay);
      }
      if (estimatedDays > 0) {
        const paceFromRatio = Math.round((actualDays / estimatedDays) * 100);
        progressPct =
          Number.isFinite(serverPaceNum) && serverPaceNum > 0
            ? Math.max(serverPaceNum, paceFromRatio)
            : paceFromRatio;
      } else if (Number.isFinite(serverPaceNum) && serverPaceNum > 0) {
        progressPct = Math.round(serverPaceNum);
      }
    }

    const daysRemaining =
      estimatedDays > 0 ? Math.max(0, estimatedDays - actualDays) : null;
    const progressOut =
      progressPct != null && Number.isFinite(progressPct)
        ? Math.min(100, Math.max(0, Math.round(progressPct)))
        : null;

    return {
      estimatedDays,
      actualDays,
      daysRemaining,
      progressPct: progressOut,
    };
  }

  function applySupervisorUnifiedProgressToSnapshot(snap, opts) {
    const base = snap && typeof snap === "object" ? { ...snap } : {};
    const progress = computeSupervisorUnifiedProgress({
      ...opts,
      snapshot: base,
    });
    if (progress.estimatedDays > 0) {
      base.estimated_days = progress.estimatedDays;
    }
    base.actual_days = progress.actualDays;
    if (progress.daysRemaining != null) {
      base.days_remaining = progress.daysRemaining;
    }
    if (progress.progressPct != null) {
      base.completion_pace_pct = progress.progressPct;
    }
    const est = finiteNumber(base.estimated_days, 0);
    const act = finiteNumber(base.actual_days, 0);
    if (est > 0) {
      const dev = act - est;
      base.labor_deviation_days = dev;
      if (Math.abs(dev) < 0.01) base.labor_deviation_label = "On budget";
      else if (dev > 0) {
        base.labor_deviation_label = `${Math.abs(dev).toFixed(2)} day(s) over budget`;
      } else {
        base.labor_deviation_label = `${Math.abs(dev).toFixed(2)} day(s) under budget`;
      }
    }
    return base;
  }

  function reconcileSupervisorMigratedSnapshot(snapshot, migrationBaseline, enrichOpts) {
    return applySupervisorUnifiedProgressToSnapshot(snapshot, {
      migrationBaseline,
      dayProgressRows: enrichOpts?.dayProgress,
      reportRows: enrichOpts?.reportRows,
      estimatedDaysFallback: enrichOpts?.estimatedDaysFallback,
    });
  }

  function resolveSupervisorExecutionPlan(opCache, project, estimatedDays) {
    const est = Math.max(
      0,
      Math.ceil(
        finiteNumber(
          estimatedDays,
          finiteNumber(project?.estimatedDays, 0)
        )
      )
    );
    if (
      opCache?.ok === true &&
      Array.isArray(opCache.operational_plan) &&
      opCache.operational_plan.length
    ) {
      return opCache.operational_plan;
    }
    if (resolveShowMigratedExecution(opCache)) {
      return buildMigratedCalendarPlan(opCache.migration_baseline, est);
    }
    if (est > 0) {
      return buildSupervisorExecutionPlanFallback(project, est);
    }
    return [];
  }

  function formatSupervisorDaysLabel(n) {
    const v = finiteNumber(n, 0);
    const rounded = Math.round(v * 10) / 10;
    const label = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    return `${label} day${Math.abs(rounded) === 1 ? "" : "s"}`;
  }

  function renderSupervisorMigratedExecutionHtml(ctx) {
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const b = c.baseline && typeof c.baseline === "object" ? c.baseline : {};
    const snap = c.snapshot && typeof c.snapshot === "object" ? c.snapshot : {};
    const sched = c.schedule && typeof c.schedule === "object" ? c.schedule : {};
    const source = escapeHtml(String(b.external_source || "Square").trim());

    const estDays = finiteNumber(
      snap.estimated_days,
      finiteNumber(b.estimated_total_days, 0)
    );
    const actDays = finiteNumber(snap.actual_days, finiteNumber(b.days_completed_to_date, 0));
    const daysRem = finiteNumber(
      snap.days_remaining,
      Math.max(0, estDays - actDays)
    );
    const pct =
      snap.completion_pace_pct != null
        ? Math.round(finiteNumber(snap.completion_pace_pct, 0))
        : estDays > 0
          ? Math.round((actDays / estDays) * 100)
          : Math.round(finiteNumber(b.progress_pct, 0));

    const startIso =
      sched.start_date || b.actual_start_date || "";
    const targetIso =
      sched.target_finish_date || sched.commitment_date || b.target_finish_date || "";
    const startLabel = startIso ? formatDateUS(startIso) || startIso : "—";
    const targetLabel = targetIso ? formatDateUS(targetIso) || targetIso : "—";

    const phase = escapeHtml(
      String(b.current_phase || "Continue scheduled work").trim()
    );
    const expenseCount = finiteNumber(
      c.expenseCount,
      finiteNumber(snap.expense_count, 0)
    );
    const invoiceLabel = escapeHtml(
      String(c.invoiceStatusLabel || "See Invoices Hub").trim()
    );

    const status = c.status && typeof c.status === "object" ? c.status : {};
    const statusBadge = escapeHtml(String(status.badge || "ON SCHEDULE"));
    const statusTone =
      status.tone === "red" ? "red" : status.tone === "amber" ? "amber" : "green";
    const statusHeadline = escapeHtml(String(status.headline || "On pace"));

    const row = (label, value) =>
      `<div class="sup-migrated-row">
        <span class="sup-migrated-row__label">${escapeHtml(label)}</span>
        <strong class="sup-migrated-row__value">${value}</strong>
      </div>`;

    return `<div class="sup-migrated-exec" data-mode="migrated">
      <header class="sup-migrated-exec__head">
        <span class="badge amber sup-migrated-exec__badge">Migrated · ${source}</span>
        <p class="small sup-migrated-exec__lead">Legacy job imported into Margin Guard. Field tracking continues from the imported baseline — not a day-by-day Sales plan.</p>
      </header>

      <section class="sup-migrated-exec__section">
        <h4 class="sup-migrated-exec__title">Migrated execution summary</h4>
        ${row("Original estimate", formatSupervisorDaysLabel(estDays))}
        ${row("Days completed", formatSupervisorDaysLabel(actDays))}
        ${row("Days remaining", formatSupervisorDaysLabel(daysRem))}
        ${row("Current phase", phase)}
        ${row("Original start", escapeHtml(startLabel))}
        ${row("Target finish", escapeHtml(targetLabel))}
        ${row("Imported expenses", `${expenseCount} entr${expenseCount === 1 ? "y" : "ies"}`)}
        ${row("Imported invoice status", invoiceLabel)}
      </section>

      <section class="sup-migrated-exec__section">
        <h4 class="sup-migrated-exec__title">Today focus</h4>
        <p class="sup-migrated-exec__focus">${phase}</p>
        <p class="small sup-migrated-exec__focus-meta">Continue the current project phase. Monitor remaining schedule against the target finish date.</p>
      </section>

      <section class="sup-migrated-exec__section sup-migrated-exec__status">
        <h4 class="sup-migrated-exec__title">Field status</h4>
        <div class="sup-migrated-exec__status-grid">
          <div class="sup-migrated-stat">
            <span class="sup-migrated-stat__label">Progress</span>
            <strong class="sup-migrated-stat__value">${pct}% complete</strong>
          </div>
          <div class="sup-migrated-stat">
            <span class="sup-migrated-stat__label">Schedule</span>
            <strong class="sup-migrated-stat__value">${formatSupervisorDaysLabel(daysRem)} remaining</strong>
          </div>
          <div class="sup-migrated-stat sup-migrated-stat--wide">
            <span class="badge ${statusTone}">${statusBadge}</span>
            <strong class="sup-migrated-stat__value">${statusHeadline}</strong>
          </div>
        </div>
      </section>
    </div>`;
  }

  function renderSupervisorMigratedCalendarBanner(migratedCtx) {
    const c = migratedCtx && typeof migratedCtx === "object" ? migratedCtx : {};
    const b = c.baseline && typeof c.baseline === "object" ? c.baseline : {};
    const snap = c.snapshot && typeof c.snapshot === "object" ? c.snapshot : {};
    const source = escapeHtml(String(b.external_source || "Square").trim());
    const estDays = finiteNumber(
      snap.estimated_days,
      finiteNumber(b.estimated_total_days, 0)
    );
    const actDays = finiteNumber(snap.actual_days, finiteNumber(b.days_completed_to_date, 0));
    const daysRem = Math.max(0, estDays - actDays);
    const phase = escapeHtml(String(b.current_phase || "Continue scheduled work").trim());
    return `<div class="sup-cal-migrated-banner" role="status">
      <span class="badge amber">Migrated from ${source}</span>
      <p class="sup-cal-migrated-banner__line"><strong>${formatSupervisorDaysLabel(actDays)}</strong> completed · <strong>${formatSupervisorDaysLabel(daysRem)}</strong> remaining · Current phase: ${phase}</p>
    </div>`;
  }

  function renderSupervisorCalendarChrome(planLength, calendarCtx) {
    const chrome = $("supExecCalendarChrome");
    const desc = $("supExecCalendarDesc");
    const n = Math.max(0, Math.floor(finiteNumber(planLength, 0)));
    if (desc) {
      desc.textContent =
        n > 0
          ? `${n}-day plan · Click a day to view details and take action`
          : "Field execution planner — click a day for details and actions.";
    }
    if (!chrome) return "";
    if (n <= 0) {
      chrome.hidden = true;
      chrome.innerHTML = "";
      return "";
    }
    chrome.hidden = false;
    chrome.innerHTML = `<div class="sup-cal-legend" aria-label="Calendar legend">
      <span class="sup-cal-legend__item"><span class="sup-cal-legend__dot sup-cal-legend__dot--completed"></span>Completed</span>
      <span class="sup-cal-legend__item"><span class="sup-cal-legend__dot sup-cal-legend__dot--in_progress"></span>In progress</span>
      <span class="sup-cal-legend__item"><span class="sup-cal-legend__dot sup-cal-legend__dot--pending"></span>Pending</span>
      <span class="sup-cal-legend__item"><span class="sup-cal-legend__dot sup-cal-legend__dot--behind"></span>Attention</span>
    </div>`;
    return chrome.innerHTML;
  }

  function renderSupervisorExecutionPlanSection(opts) {
    const o = opts && typeof opts === "object" ? opts : {};
    const body = $("supLaborPlanBody");
    const sectionTitle = document.querySelector(
      ".sup-exec-plan-section .sup-section-title"
    );
    if (!body) return;

    if (sectionTitle) sectionTitle.textContent = "Execution calendar";

    const execPlan = Array.isArray(o.execPlan) ? o.execPlan : [];
    const estDays = Math.max(
      execPlan.length,
      Math.ceil(finiteNumber(o.estimatedDays, 0))
    );

    if (!execPlan.length && estDays <= 0) {
      renderSupervisorCalendarChrome(0, o.calendarCtx);
      if ($("supExecCalendarChrome")) $("supExecCalendarChrome").hidden = true;
      body.innerHTML =
        '<p class="sup-cal-empty small">Execution plan has not been prepared in Sales.</p>';
      return;
    }

    const calendarHtml = renderSupervisorExecutionCalendarHtml(execPlan, o.calendarCtx);
    if (calendarHtml) {
      const migratedBanner = o.showMigrated
        ? renderSupervisorMigratedCalendarBanner(o.migratedCtx)
        : "";
      renderSupervisorCalendarChrome(execPlan.length, o.calendarCtx);
      body.innerHTML = migratedBanner + calendarHtml;
      supervisorActiveDayContext = {
        plan: execPlan,
        startIso: o.calendarCtx?.startIso || "",
        progressMap: o.calendarCtx?.progressMap || {},
        dayActivityMap: o.calendarCtx?.dayActivityMap || {},
        migratedCompletedThru: finiteNumber(o.calendarCtx?.migratedCompletedThru, 0),
        currentPlanDayIndex: finiteNumber(o.calendarCtx?.currentPlanDayIndex, 1),
        projectId: o.projectId || "",
        showMigrated: Boolean(o.showMigrated),
      };
      bindSupExecutionCalendarOnce();
    } else {
      renderSupervisorCalendarChrome(0, o.calendarCtx);
      body.innerHTML =
        '<p class="sup-cal-empty small">Execution plan has not been prepared in Sales.</p>';
    }
  }

  function supervisorInferDayNumberFromRow(row, startIso, maxDay) {
    const explicit = Math.floor(finiteNumber(row?.day_number, 0));
    if (explicit >= 1) return explicit;
    const entryDate = normalizeDateInput(row?.entry_date || row?.expense_date || row?.date || "");
    const start = normalizeDateInput(startIso || "");
    if (!entryDate || !start || maxDay < 1) return 0;
    const startMs = new Date(start).setHours(0, 0, 0, 0);
    const entryMs = new Date(entryDate).setHours(0, 0, 0, 0);
    const diff = Math.floor((entryMs - startMs) / 86400000) + 1;
    if (diff >= 1 && diff <= maxDay) return diff;
    return 0;
  }

  function supervisorBuildDayFieldActivityMap(pid, state, startIso, execPlan) {
    const map = Object.create(null);
    const maxDay = Array.isArray(execPlan) && execPlan.length
      ? Math.max(...execPlan.map((d) => Math.floor(finiteNumber(d?.day_number, 0))))
      : 0;
    const ensure = (dayNum) => {
      const n = Math.max(1, Math.floor(finiteNumber(dayNum, 0)));
      const k = String(n);
      if (!map[k]) {
        map[k] = {
          laborCount: 0,
          expenseCount: 0,
          hours: 0,
          days: 0,
          laborRows: [],
          expenseRows: [],
        };
      }
      return map[k];
    };

    const repCache = supervisorProjectReportsCache[pid];
    const reports =
      repCache?.ok === true && Array.isArray(repCache.reports)
        ? repCache.reports
        : Array.isArray(state?.entries)
          ? state.entries.map((e) => ({
              entry_date: e.date,
              hours: e.hours,
              days: e.days,
              note: e.note,
              day_number: e.day_number,
            }))
          : [];
    for (const row of reports) {
      const dayNum = supervisorInferDayNumberFromRow(row, startIso, maxDay);
      if (dayNum < 1) continue;
      const bucket = ensure(dayNum);
      bucket.laborCount += 1;
      bucket.hours += finiteNumber(row.hours, 0);
      bucket.days += finiteNumber(row.days, 0);
      bucket.laborRows.push(row);
    }

    const expCache = supervisorProjectExpensesCache[pid];
    const expenses =
      expCache?.ok === true && Array.isArray(expCache.expenses)
        ? expCache.expenses
        : [];
    for (const row of expenses) {
      const dayNum = supervisorInferDayNumberFromRow(row, startIso, maxDay);
      if (dayNum < 1) continue;
      const bucket = ensure(dayNum);
      bucket.expenseCount += 1;
      bucket.expenseRows.push(row);
    }

    return map;
  }

  function supervisorBuildDayContext(dayNum, overrides) {
    const base = supervisorActiveDayContext && typeof supervisorActiveDayContext === "object"
      ? supervisorActiveDayContext
      : {};
    const n = Math.max(1, Math.floor(finiteNumber(dayNum, 1)));
    const planDay =
      (base.plan || []).find((d) => Math.floor(finiteNumber(d?.day_number, 0)) === n) || {};
    const phase = String(
      (overrides && overrides.phase) || planDay.phase || ""
    ).trim();
    const plannedDate =
      (overrides && overrides.plannedDate) ||
      supervisorPlannedDateForDay(base.startIso || "", n);
    return {
      day_number: n,
      phase: phase || "Work scheduled",
      workers: planDay.workers || planDay.crew || [],
      tasks: Array.isArray(planDay.tasks) ? planDay.tasks : [],
      plannedDate,
      projectId: base.projectId || "",
      progressMap: base.progressMap || {},
      dayActivityMap: base.dayActivityMap || {},
      dayActivity: (base.dayActivityMap || {})[String(n)] || null,
      migratedCompletedThru: finiteNumber(base.migratedCompletedThru, 0),
      currentPlanDayIndex: finiteNumber(base.currentPlanDayIndex, 1),
      ...(overrides && typeof overrides === "object" ? overrides : {}),
    };
  }

  function normalizeSupDayProgressError(data, res) {
    const raw = String((data && data.error) || `Request failed (${res?.status || 0})`).trim();
    if (/tenant_project_day_progress|relation|column|42703|not available/i.test(raw)) {
      return "Day progress table is missing. Run SUPABASE_TENANT_PROJECT_DAY_PROGRESS.sql.";
    }
    return raw || "Could not mark day completed.";
  }

  function showSupervisorToast(message, type) {
    const msg = String(message || "").trim();
    if (!msg) return;
    const host = $("supToastHost") || document.body;
    let el = $("supToastLive");
    if (!el) {
      el = document.createElement("div");
      el.id = "supToastLive";
      host.appendChild(el);
    }
    const tone = type === "error" ? "error" : "success";
    el.className = `sup-toast sup-toast--${tone} sup-toast--visible`;
    el.textContent = msg;
    if (showSupervisorToast._timer) clearTimeout(showSupervisorToast._timer);
    showSupervisorToast._timer = setTimeout(() => {
      el.classList.remove("sup-toast--visible");
    }, 4200);
  }

  function setSupDayCompleteButtonBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      btn.dataset.supBusy = "1";
      btn.disabled = true;
      btn.textContent = "Saving…";
      btn.classList.add("is-saving");
    } else if (String(btn.getAttribute("data-sup-done") || "") !== "1") {
      btn.dataset.supBusy = "0";
      btn.disabled = false;
      btn.textContent = "Completed";
      btn.classList.remove("is-saving");
    }
  }

  function mergeDayProgressCompletedIntoCache(projectId, dayNum, phase) {
    const k = supervisorProjectKey(projectId);
    const day = Math.max(1, Math.floor(finiteNumber(dayNum, 0)));
    if (!k || !day) return;
    const cache = supervisorProjectOperationalCache[k];
    if (!cache || cache.ok !== true) return;
    const rows = Array.isArray(cache.day_progress) ? [...cache.day_progress] : [];
    const existingIdx = rows.findIndex(
      (r) => Math.floor(finiteNumber(r?.day_number, 0)) === day
    );
    const row = {
      day_number: day,
      status: "completed",
      completed_at: new Date().toISOString(),
      completion_note: phase
        ? `Day ${day} completed — phase: ${phase}`
        : `Day ${day} completed`,
    };
    if (existingIdx >= 0) rows[existingIdx] = { ...rows[existingIdx], ...row };
    else rows.push(row);
    cache.day_progress = rows;
    const repCache = supervisorProjectReportsCache[k];
    const reportRows =
      repCache?.ok === true && Array.isArray(repCache.reports) ? repCache.reports : [];
    cache.snapshot = applySupervisorUnifiedProgressToSnapshot(
      cache.snapshot && typeof cache.snapshot === "object" ? cache.snapshot : {},
      {
        migrationBaseline:
          cache.migration_baseline && typeof cache.migration_baseline === "object"
            ? cache.migration_baseline
            : null,
        dayProgressRows: rows,
        reportRows,
        estimatedDaysFallback: finiteNumber(cache.snapshot?.estimated_days, 0),
      }
    );
  }

  function refreshSupervisorAfterDayAction() {
    if (typeof window.renderSupervisor === "function") {
      window.renderSupervisor();
    }
  }

  function bindSupExecutionCalendarOnce() {
    const host = $("supLaborPlanBody");
    if (!host || host.dataset.supCalendarBound === "1") return;
    host.dataset.supCalendarBound = "1";
    host.addEventListener("click", async (event) => {
      const completeBtn = event.target.closest("[data-sup-complete]");
      if (completeBtn) {
        event.preventDefault();
        event.stopPropagation();
        const dayNum = Math.max(
          1,
          Math.floor(finiteNumber(completeBtn.getAttribute("data-sup-day"), 0))
        );
        const ctx = supervisorBuildDayContext(dayNum);
        if (String(completeBtn.getAttribute("data-sup-done") || "") === "1") return;
        if (String(completeBtn.dataset.supBusy || "") === "1") return;
        setSupDayCompleteButtonBusy(completeBtn, true);
        const result = await markSupervisorDayCompleted(ctx);
        if (result.ok) {
          showSupervisorToast("Day marked completed.", "success");
          refreshSupervisorAfterDayAction();
        } else {
          setSupDayCompleteButtonBusy(completeBtn, false);
          showSupervisorToast(result.error, "error");
        }
        return;
      }
      const laborBtn = event.target.closest("[data-sup-labor]");
      if (laborBtn) {
        event.preventDefault();
        event.stopPropagation();
        const dayNum = Math.max(
          1,
          Math.floor(finiteNumber(laborBtn.getAttribute("data-sup-day"), 0))
        );
        openSupFieldModal("labor", supervisorBuildDayContext(dayNum));
        return;
      }
      const expenseBtn = event.target.closest("[data-sup-expense]");
      if (expenseBtn) {
        event.preventDefault();
        event.stopPropagation();
        const dayNum = Math.max(
          1,
          Math.floor(finiteNumber(expenseBtn.getAttribute("data-sup-day"), 0))
        );
        openSupFieldModal("extra", supervisorBuildDayContext(dayNum));
        return;
      }
      const openBtn = event.target.closest("[data-sup-day-open]");
      if (!openBtn) return;
      const dayNum = Math.max(
        1,
        Math.floor(finiteNumber(openBtn.getAttribute("data-sup-day"), 1))
      );
      openSupDayDetailModal(supervisorBuildDayContext(dayNum));
    });
  }

  function openSupDayDetailModal(ctx) {
    const dayCtx = ctx && typeof ctx === "object" ? ctx : {};
    supervisorActiveDayContext = {
      ...(supervisorActiveDayContext || {}),
      ...dayCtx,
    };
    const modal = $("supDayDetailModal");
    if (!modal) return;
    const dayNum = Math.max(1, Math.floor(finiteNumber(dayCtx.day_number, 1)));
    const plannedDate = normalizeDateInput(dayCtx.plannedDate || "");
    const progressMap =
      dayCtx.progressMap && typeof dayCtx.progressMap === "object"
        ? dayCtx.progressMap
        : supervisorActiveDayContext?.progressMap || {};
    const dayActivityMap =
      dayCtx.dayActivityMap && typeof dayCtx.dayActivityMap === "object"
        ? dayCtx.dayActivityMap
        : supervisorActiveDayContext?.dayActivityMap || {};
    const activity = dayCtx.dayActivity || dayActivityMap[String(dayNum)] || null;
    const currentPlanDay = Math.max(
      1,
      Math.floor(
        finiteNumber(
          dayCtx.currentPlanDayIndex,
          finiteNumber(
            supervisorActiveDayContext?.currentPlanDayIndex,
            supervisorCurrentPlanDayIndex(
              supervisorActiveDayContext?.plan || [],
              supervisorActiveDayContext?.startIso || "",
              0
            )
          )
        )
      )
    );
    const planDay =
      (supervisorActiveDayContext?.plan || []).find(
        (d) => Math.floor(finiteNumber(d?.day_number, 0)) === dayNum
      ) || {};
    const planLen = Array.isArray(supervisorActiveDayContext?.plan)
      ? supervisorActiveDayContext.plan.length
      : 0;
    const phase = supervisorResolveDayPhaseLabel(
      { phase: dayCtx.phase, ...planDay },
      dayNum,
      planLen || dayNum
    );
    const status = supervisorResolveDayDisplayStatus(
      dayNum,
      progressMap,
      currentPlanDay,
      activity,
      {
        migratedCompletedThru: finiteNumber(
          dayCtx.migratedCompletedThru,
          finiteNumber(supervisorActiveDayContext?.migratedCompletedThru, 0)
        ),
      }
    );
    setText("supDayDetailTitle", `Day ${dayNum}`);
    setText(
      "supDayDetailSubtitle",
      plannedDate ? formatDateUS(plannedDate) || plannedDate : "Planned date pending"
    );
    setText("supDayDetailPhase", phase);
    setText("supDayDetailDate", plannedDate ? formatDateUS(plannedDate) || plannedDate : "—");
    const statusBadge = $("supDayDetailStatus");
    if (statusBadge) {
      statusBadge.textContent = supervisorDayStatusLabel(status);
      statusBadge.className = `badge ${supervisorDayStatusBadgeClass(status)}`;
    }
    const crewList = $("supDayDetailCrew");
    if (crewList) {
      const crew = (dayCtx.workers || dayCtx.crew || [])
        .map((w) => String(w.role || w.worker_type || "").trim())
        .filter(Boolean);
      const uniqueCrew = [...new Set(crew)];
      crewList.innerHTML = uniqueCrew.length
        ? uniqueCrew.map((r) => `<li>${escapeHtml(r)}</li>`).join("")
        : '<li class="small">Not set by Sales</li>';
    }
    const tasksWrap = $("supDayDetailTasksWrap");
    const tasksList = $("supDayDetailTasks");
    const tasks = Array.isArray(dayCtx.tasks) ? dayCtx.tasks : [];
    if (tasksWrap && tasksList) {
      if (tasks.length) {
        tasksWrap.hidden = false;
        tasksList.innerHTML = tasks
          .map((t) => `<li>${escapeHtml(String(t || "").trim())}</li>`)
          .join("");
      } else {
        tasksWrap.hidden = true;
        tasksList.innerHTML = "";
      }
    }
    const notesWrap = $("supDayDetailNotesWrap");
    const notesEl = $("supDayDetailNotes");
    const targetHrs = supervisorPlannedHoursForDay(planDay);
    const reportedHrs = finiteNumber(activity?.hours, 0);
    const metaParts = [];
    if (targetHrs > 0) metaParts.push(`Target hours: ${targetHrs.toFixed(1)}`);
    if (reportedHrs > 0) metaParts.push(`Hours reported: ${reportedHrs.toFixed(1)}`);
    if (finiteNumber(activity?.expenseCount, 0) > 0) {
      metaParts.push(`Expense entries: ${finiteNumber(activity.expenseCount, 0)}`);
    }
    const notesText = tasks.length
      ? tasks.join(" · ")
      : phase && phase !== "Work scheduled" && phase !== "Phase not set from Sales"
        ? phase
        : "";
    const notesFull = [notesText, metaParts.join(" · ")].filter(Boolean).join("\n");
    if (notesWrap && notesEl) {
      if (notesFull) {
        notesWrap.hidden = false;
        notesEl.textContent = notesFull;
      } else {
        notesWrap.hidden = true;
        notesEl.textContent = "";
      }
    }
    const laborList = $("supDayDetailLaborList");
    if (laborList) {
      const rows = Array.isArray(activity?.laborRows) ? activity.laborRows : [];
      laborList.innerHTML = rows.length
        ? rows
            .map((r) => {
              const d = normalizeDateInput(r.entry_date || r.date || "");
              const dl = d ? formatDateUS(d) || d : "—";
              const hrs = finiteNumber(r.hours, 0);
              const dys = finiteNumber(r.days, 0);
              const note = String(r.note || "").trim();
              return `<li><strong>${escapeHtml(dl)}</strong> — ${hrs.toFixed(2)}h / ${dys.toFixed(2)}d${note ? ` · ${escapeHtml(note)}` : ""}</li>`;
            })
            .join("")
        : '<li class="small">No labor reports for this day yet.</li>';
    }
    const expenseList = $("supDayDetailExpenseList");
    if (expenseList) {
      const rows = Array.isArray(activity?.expenseRows) ? activity.expenseRows : [];
      expenseList.innerHTML = rows.length
        ? rows
            .map((r) => {
              const d = normalizeDateInput(r.expense_date || r.date || "");
              const dl = d ? formatDateUS(d) || d : "—";
              const raw = String(r.note || "").trim();
              const nl = raw.indexOf("\n");
              const item = nl >= 0 ? raw.slice(0, nl).trim() : raw;
              return `<li><strong>${escapeHtml(dl)}</strong>${item ? ` · ${escapeHtml(item)}` : ""}</li>`;
            })
            .join("")
        : '<li class="small">No expenses for this day yet.</li>';
    }
    const markBtn = $("btnSupMarkDayCompleted");
    const reopenBtn = $("btnSupReopenDay");
    const isCompleted = status === "completed";
    if (markBtn) {
      markBtn.hidden = isCompleted;
      markBtn.disabled = false;
    }
    if (reopenBtn) reopenBtn.hidden = !isCompleted;
    modal.setAttribute("aria-hidden", "false");
    modal.style.display = "flex";
    document.body.style.overflow = "hidden";
  }

  function closeSupDayDetailModal() {
    const modal = $("supDayDetailModal");
    if (!modal) return;
    modal.setAttribute("aria-hidden", "true");
    modal.style.display = "";
    const laborOpen =
      $("supLaborReportModal")?.getAttribute("aria-hidden") === "false";
    const extraOpen =
      $("supExpenseReportModal")?.getAttribute("aria-hidden") === "false";
    if (!laborOpen && !extraOpen) document.body.style.overflow = "";
  }

  async function markSupervisorDayCompleted(ctx) {
    const dayCtx = ctx && typeof ctx === "object" ? ctx : supervisorActiveDayContext;
    const projectId = supervisorProjectKey(
      dayCtx?.projectId || resolveActiveSupervisorProject()?.id
    );
    const dayNum = Math.max(1, Math.floor(finiteNumber(dayCtx?.day_number, 0)));
    const phase = String(dayCtx?.phase || "").trim();
    if (!projectId || !dayNum) {
      return { ok: false, error: "Select a project before marking a day completed." };
    }
    const payload = {
      project_id: projectId,
      day_number: dayNum,
      phase,
    };
    let res;
    try {
      res = await fetch("/.netlify/functions/save-project-day-progress", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (_e) {
      return { ok: false, error: "Network error. Could not mark day completed." };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || data.ok !== true) {
      return { ok: false, error: normalizeSupDayProgressError(data, res) };
    }
    mergeDayProgressCompletedIntoCache(projectId, dayNum, phase);
    await loadSupervisorOperationalSnapshot(projectId, { force: true });
    return { ok: true, error: null };
  }

  async function reopenSupervisorDay(ctx) {
    const dayCtx = ctx && typeof ctx === "object" ? ctx : supervisorActiveDayContext;
    const projectId = supervisorProjectKey(
      dayCtx?.projectId || resolveActiveSupervisorProject()?.id
    );
    const dayNum = Math.max(1, Math.floor(finiteNumber(dayCtx?.day_number, 0)));
    if (!projectId || !dayNum) {
      return { ok: false, error: "Select a project before reopening a day." };
    }
    let res;
    try {
      res = await fetch("/.netlify/functions/save-project-day-progress", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          day_number: dayNum,
          reopen: true,
        }),
      });
    } catch (_e) {
      return { ok: false, error: "Network error. Could not reopen day." };
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data || data.ok !== true) {
      return { ok: false, error: normalizeSupDayProgressError(data, res) };
    }
    await loadSupervisorOperationalSnapshot(projectId, { force: true });
    return { ok: true, error: null };
  }

  function resolveSupervisorOperationalPanelState(pid, currentProject, state, opCache) {
    const cached = opCache || supervisorProjectOperationalCache[pid];
    const migrationBaseline =
      cached?.migration_baseline && typeof cached.migration_baseline === "object"
        ? cached.migration_baseline
        : null;
    const hasMigrationBaseline = Boolean(
      cached?.has_migrated_baseline && migrationBaseline
    );
    const repCache = supervisorProjectReportsCache[pid];
    const reportRows =
      repCache?.ok === true && Array.isArray(repCache.reports) ? repCache.reports : [];
    const enrichOpts = {
      hasMigrationBaseline,
      migrationBaseline: hasMigrationBaseline ? migrationBaseline : null,
      dayProgress: Array.isArray(cached?.day_progress) ? cached.day_progress : [],
      reportRows,
      estimatedDaysFallback: finiteNumber(
        currentProject?.estimatedDays,
        finiteNumber(state?.estimatedDays, 0)
      ),
    };
    const fallbackSnap = enrichOperationalSnapshotFromFieldCaches(
      pid,
      buildSupervisorOperationalFallback(currentProject, state),
      currentProject,
      state,
      enrichOpts
    );
    const inflight = supervisorProjectOperationalFetchInFlight.has(pid);
    let snapshot = fallbackSnap;
    let error = null;
    if (cached?.ok === true && cached.snapshot) {
      const merged = hasMigrationBaseline
        ? { ...cached.snapshot }
        : { ...cached.snapshot };
      snapshot = enrichOperationalSnapshotFromFieldCaches(
        pid,
        merged,
        currentProject,
        state,
        enrichOpts
      );
      if (hasMigrationBaseline) {
        snapshot = reconcileSupervisorMigratedSnapshot(
          snapshot,
          migrationBaseline,
          enrichOpts
        );
      }
    } else if (hasMigrationBaseline && migrationBaseline) {
      snapshot = reconcileSupervisorMigratedSnapshot(
        fallbackSnap,
        migrationBaseline,
        enrichOpts
      );
    } else if (cached?.ok === false) {
      error = cached.error || "Field metrics unavailable. Showing local baseline.";
      if (
        finiteNumber(fallbackSnap?.completion_pace_pct, 0) > 0 ||
        finiteNumber(fallbackSnap?.actual_days, 0) > 0
      ) {
        snapshot = fallbackSnap;
      }
    } else if (inflight && !snapshot?.estimated_days && !snapshot?.actual_days) {
      error = null;
    }
    return { snapshot, error, inflight };
  }

  function supervisorScheduleLabels(schedule, project, state, migrationBaseline) {
    const mig =
      migrationBaseline && typeof migrationBaseline === "object"
        ? migrationBaseline
        : null;
    if (mig) {
      const start = normalizeDateInput(mig.actual_start_date || "");
      const target = normalizeDateInput(mig.target_finish_date || "");
      const phase = String(mig.current_phase || "").trim();
      return {
        startIso: start,
        targetIso: target,
        startLabel: start ? formatDateUS(start) || start : "Waiting for project timeline.",
        targetLabel: target
          ? formatDateUS(target) || target
          : "Target finish not set",
        targetHint: target ? "" : "Owner/Sales should set finish date",
        crewSummary: phase,
      };
    }
    const sched = schedule && typeof schedule === "object" ? schedule : {};
    const crewFromSchedule = String(sched.crew_summary || "").trim();
    const startRaw =
      sched.start_date ||
      (project?.signedAt ? String(project.signedAt).slice(0, 10) : "") ||
      "";
    const targetRaw =
      sched.target_finish_date ||
      sched.commitment_date ||
      state?.dueDate ||
      project?.dueDate ||
      "";
    const start = normalizeDateInput(startRaw);
    const target = normalizeDateInput(targetRaw);
    return {
      startIso: start,
      targetIso: target,
      startLabel: start ? formatDateUS(start) || start : "Waiting for project timeline.",
      targetLabel: target
        ? formatDateUS(target) || target
        : "Target finish not set",
      targetHint: target ? "" : "Owner/Sales should set finish date",
      crewSummary: crewFromSchedule,
    };
  }

  function supervisorCrewSummaryFromPlan(plan) {
    const roles = new Set();
    for (const day of plan || []) {
      for (const w of day.workers || []) {
        const r = String(w.role || w.worker_type || "").trim();
        if (r) roles.add(r);
      }
    }
    if (!roles.size) return "";
    return [...roles].join(" + ");
  }

  function supervisorCrewSummaryFromProjectWorkers(project) {
    const workers = Array.isArray(project?.workers) ? project.workers : [];
    const roles = new Set();
    for (const w of workers) {
      const r = String(w?.role || w?.type || w?.worker_type || "").trim();
      if (r) roles.add(r);
    }
    if (!roles.size) return "";
    return [...roles].join(" + ");
  }

  function supervisorCurrentPlanDayIndex(plan, startIso, actualDays) {
    const maxDay =
      Array.isArray(plan) && plan.length
        ? Math.max(...plan.map((d) => Number(d.day_number) || 0))
        : 0;
    if (startIso) {
      const start = new Date(startIso);
      const today = new Date();
      start.setHours(0, 0, 0, 0);
      today.setHours(0, 0, 0, 0);
      const diff = Math.floor((today - start) / 86400000) + 1;
      if (diff >= 1) return Math.min(diff, maxDay || diff);
    }
    return Math.max(1, Math.min(Math.floor(actualDays) + 1, maxDay || 999));
  }

  function findOperationalPlanDay(plan, dayIndex) {
    if (!Array.isArray(plan) || !plan.length) return null;
    return (
      plan.find((d) => Number(d.day_number) === dayIndex) ||
      plan[dayIndex - 1] ||
      null
    );
  }

  function computeSupervisorSmartStatus(opts) {
    const est = finiteNumber(opts.estimatedDays, 0);
    const actual = finiteNumber(opts.actualDays, 0);
    const daysRemainingRaw = est - actual;
    const dayDelta = finiteNumber(opts.calendarDayDelta, 0);
    const estInt = Math.max(0, Math.round(est));

    if (est <= 0) {
      return {
        tone: "amber",
        badge: "SET PLAN",
        headline: "Timeline not set",
        subline: "Waiting for project timeline.",
      };
    }

    const overBy = Math.max(
      0,
      Math.ceil(actual - est),
      dayDelta > 0 ? dayDelta : 0
    );
    if (daysRemainingRaw < 0 || dayDelta > 2 || actual > est + 1) {
      const n = Math.max(2, overBy, Math.ceil(-daysRemainingRaw));
      return {
        tone: "red",
        badge: "BEHIND SCHEDULE",
        headline: `${n} day${n === 1 ? "" : "s"} over schedule`,
        subline: "Bonus at risk",
      };
    }

    if (daysRemainingRaw <= 1 || dayDelta > 0 || actual > est) {
      const behind = Math.max(
        1,
        Math.ceil(actual - est) || (dayDelta > 0 ? dayDelta : 1)
      );
      return {
        tone: "amber",
        badge: "WATCH PACE",
        headline: `Behind by ${behind} day${behind === 1 ? "" : "s"}`,
        subline: `${Math.floor(actual)} of ${estInt} days used`,
      };
    }

    return {
      tone: "green",
      badge: "ON SCHEDULE",
      headline: "On pace",
      subline: `${Math.floor(actual)} of ${estInt} days used`,
    };
  }

  function formatSupervisorDeviationLabel(devDays) {
    const d = finiteNumber(devDays, 0);
    if (Math.abs(d) < 0.01) return "On schedule";
    if (d > 0) return `${d.toFixed(1)}d behind`;
    return `${Math.abs(d).toFixed(1)}d ahead`;
  }

  function formatSupervisorOperationalRisk(risk) {
    const r = String(risk || "").toLowerCase();
    if (r === "high") return "High";
    if (r === "medium") return "Watch";
    if (r === "low") return "Low";
    return "—";
  }

  function compactSupervisorBonusHeaderLabel(status) {
    const s = String(status || "").trim();
    if (!s || /not configured/i.test(s)) return "Bonus not configured";
    if (/at risk/i.test(s)) return "Bonus at risk";
    if (/on track/i.test(s)) return "Bonus on track";
    return s.replace(/\.$/, "");
  }

  function formatSupervisorCalHeaderSummary(snap, risk, bonusCopy) {
    if (!snap || typeof snap !== "object") return "—";
    const estDays = Math.round(finiteNumber(snap.estimated_days, 0));
    const completed = Math.round(finiteNumber(snap.actual_days, 0));
    const rem = Math.round(
      finiteNumber(
        snap.days_remaining != null
          ? snap.days_remaining
          : Math.max(0, finiteNumber(snap.estimated_days, 0) - finiteNumber(snap.actual_days, 0)),
        0
      )
    );
    const paceNum = snap.completion_pace_pct;
    const paceStr =
      paceNum != null && paceNum !== "" && Number.isFinite(Number(paceNum))
        ? `${Math.round(Number(paceNum))}% complete`
        : null;
    const parts = [];
    if (estDays > 0) parts.push(`${estDays} days`);
    parts.push(`${completed} completed`);
    parts.push(rem === 1 ? "1 remaining" : `${rem} remaining`);
    if (paceStr) parts.push(paceStr);
    parts.push(`Reports ${finiteNumber(snap.report_count, 0)}`);
    parts.push(`Expenses ${finiteNumber(snap.expense_count, 0)}`);
    const riskLabel = formatSupervisorOperationalRisk(risk);
    if (riskLabel !== "—") parts.push(`Risk ${riskLabel}`);
    parts.push(compactSupervisorBonusHeaderLabel(bonusCopy?.status));
    return parts.join(" · ");
  }

  function setSupervisorCalHeaderSummary(text) {
    const el = $("supCalHeaderSummary");
    if (el) el.textContent = text == null || text === "" ? "—" : String(text);
  }

  function formatSupervisorBonusCopy(snap, laborBudgetConfigured) {
    if (!laborBudgetConfigured) {
      return { status: "Bonus rules not configured yet.", pace: "—" };
    }
    const risk = String(snap.operational_risk || "").toLowerCase();
    const bonusStatus = String(snap.supervisor_bonus_status || "").toLowerCase();
    const pct = finiteNumber(snap.supervisor_bonus_pct_of_potential, 0);
    let status = "On track for bonus";
    if (risk === "high" || bonusStatus.includes("risk") || bonusStatus === "at_risk") {
      status = "Bonus at risk";
    } else if (bonusStatus.includes("not") || bonusStatus === "unavailable") {
      status = "Bonus rules not configured yet.";
    }
    const pace =
      pct > 0
        ? `${Math.round(pct)}% toward bonus`
        : status === "Bonus at risk"
          ? "Behind pace"
          : "Building pace";
    return { status, pace };
  }

  function supervisorDayProgressMap(rows) {
    const map = Object.create(null);
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      if (!row || row.day_number == null) return;
      map[String(row.day_number)] = row;
    });
    return map;
  }

  function supervisorPlannedDateForDay(startIso, dayNumber) {
    const start = normalizeDateInput(startIso || "");
    const n = Math.max(1, Math.floor(finiteNumber(dayNumber, 1)));
    if (!start) return "";
    return addDaysToInputValue(start, n - 1);
  }

  function supervisorResolveDayDisplayStatus(
    dayNum,
    progressMap,
    currentPlanDayIndex,
    activity,
    opts
  ) {
    const prog = progressMap[String(dayNum)];
    const progStatus = String(prog?.status || "").toLowerCase();
    if (progStatus === "completed") return "completed";
    const migratedThru = Math.max(
      0,
      Math.floor(finiteNumber(opts?.migratedCompletedThru, 0))
    );
    if (migratedThru > 0 && dayNum <= migratedThru && progStatus !== "pending") {
      return "completed";
    }
    const act = activity && typeof activity === "object" ? activity : null;
    const cur = Math.max(1, Math.floor(finiteNumber(currentPlanDayIndex, 1)));
    if (
      dayNum === cur ||
      (act && (act.laborCount > 0 || act.expenseCount > 0))
    ) {
      return "in_progress";
    }
    if (dayNum < cur) return "behind";
    return "pending";
  }

  function supervisorDayStatusLabel(status) {
    const s = String(status || "pending").toLowerCase();
    if (s === "completed") return "Completed";
    if (s === "in_progress") return "In progress";
    if (s === "behind") return "Attention";
    return "Pending";
  }

  function supervisorDayStatusBadgeClass(status) {
    const s = String(status || "pending").toLowerCase();
    if (s === "completed") return "green";
    if (s === "in_progress") return "blue";
    if (s === "behind") return "red";
    return "";
  }

  const SUP_MISSING_PLAN_PHASE =
    /^(phase not set from sales|work scheduled|scheduled work|continue scheduled work|imported work completed)$/i;

  function supervisorIsMissingPlanPhase(phase) {
    const p = String(phase || "").trim();
    if (!p) return true;
    return SUP_MISSING_PLAN_PHASE.test(p);
  }

  function supervisorFallbackPhaseLabel(dayNum, totalDays) {
    const n = Math.max(1, Math.floor(finiteNumber(dayNum, 1)));
    const total = Math.max(n, Math.floor(finiteNumber(totalDays, 0)));
    if (total <= 1 || n === 1) return "Project start / site protection";
    if (n >= total) return "Final walkthrough / cleanup";
    return "Continue planned field work";
  }

  function supervisorResolveDayPhaseLabel(day, dayNum, totalDays) {
    const raw = String(day?.phase || "").trim();
    if (!supervisorIsMissingPlanPhase(raw)) return raw;
    return supervisorFallbackPhaseLabel(dayNum, totalDays);
  }

  function supervisorDisplayPaceStatus(progressPct, smartStatus) {
    const pct = finiteNumber(progressPct, NaN);
    if (Number.isFinite(pct) && pct >= 100) return "Completed";
    const tone = String(smartStatus?.tone || "").toLowerCase();
    if (tone === "red" || tone === "amber") return "Behind";
    return "On pace";
  }

  function supervisorFormatCrewLine(day) {
    const crew = (day?.workers || day?.crew || [])
      .map((w) => String(w.role || w.worker_type || "").trim())
      .filter(Boolean);
    const uniqueCrew = [...new Set(crew)];
    if (uniqueCrew.length) return `Crew: ${uniqueCrew.join(" + ")}`;
    return "Crew: Not set by Sales";
  }

  function supervisorFormatCrewExpected(day) {
    const crew = (day?.workers || day?.crew || [])
      .map((w) => String(w.role || w.worker_type || "").trim())
      .filter(Boolean);
    const uniqueCrew = [...new Set(crew)];
    if (uniqueCrew.length) return `Crew expected: ${uniqueCrew.join(" + ")}`;
    return "Crew expected: Not set by Sales";
  }

  function supervisorFormatHeroCrewSummary(execPlan, project, scheduleCrew) {
    const fromPlan = supervisorCrewSummaryFromPlan(execPlan);
    const fromWorkers = supervisorCrewSummaryFromProjectWorkers(project);
    const roles = fromPlan || fromWorkers || String(scheduleCrew || "").trim();
    if (!roles) return "Crew: Not set by Sales";
    if (/^crew:/i.test(roles)) return roles;
    return `Crew: ${roles}`;
  }

  function supervisorPlannedHoursForDay(day) {
    const workers = Array.isArray(day?.workers) ? day.workers : [];
    if (!workers.length) return 0;
    return workers.reduce((s, w) => s + finiteNumber(w.estimated_hours, 0), 0);
  }

  function renderSupervisorExecutionCalendarHtml(plan, calendarCtx) {
    if (!Array.isArray(plan) || !plan.length) return null;
    const ctx = calendarCtx && typeof calendarCtx === "object" ? calendarCtx : {};
    const progressMap =
      ctx.progressMap && typeof ctx.progressMap === "object" ? ctx.progressMap : {};
    const dayActivityMap =
      ctx.dayActivityMap && typeof ctx.dayActivityMap === "object"
        ? ctx.dayActivityMap
        : {};
    const startIso = normalizeDateInput(ctx.startIso || "");
    const totalDays = plan.length;
    const currentPlanDayIndex = Math.max(
      1,
      Math.floor(finiteNumber(ctx.currentPlanDayIndex, 1))
    );
    const statusOpts = {
      migratedCompletedThru: finiteNumber(ctx.migratedCompletedThru, 0),
    };
    const cards = plan.map((day) => {
      const dayNum = Math.max(1, Math.floor(finiteNumber(day.day_number, 1)));
      const phase = supervisorResolveDayPhaseLabel(day, dayNum, totalDays);
      const crewLine = supervisorFormatCrewLine(day);
      const activity = dayActivityMap[String(dayNum)] || null;
      const status = supervisorResolveDayDisplayStatus(
        dayNum,
        progressMap,
        currentPlanDayIndex,
        activity,
        statusOpts
      );
      const plannedDate = supervisorPlannedDateForDay(startIso, dayNum);
      const dateLabel = plannedDate ? formatDateUS(plannedDate) || plannedDate : "";
      const laborCount = finiteNumber(activity?.laborCount, 0);
      const expenseCount = finiteNumber(activity?.expenseCount, 0);
      const isDone = status === "completed";
      const statusLine = isDone
        ? `✓ Completed · Reports: ${laborCount} · Expenses: ${expenseCount}`
        : status === "in_progress"
          ? `In progress · Reports: ${laborCount} · Expenses: ${expenseCount}`
          : status === "behind"
            ? `Needs attention · Reports: ${laborCount} · Expenses: ${expenseCount}`
            : `Reports: ${laborCount} · Expenses: ${expenseCount}`;
      const completeBtn = isDone
        ? ""
        : `<button type="button" class="btn small primary" data-sup-complete data-sup-day="${escapeHtml(String(dayNum))}" data-sup-done="0">Mark completed</button>`;
      return `<article class="sup-diary-day sup-diary-day--${escapeHtml(status)}">
        <button type="button" class="sup-diary-day__open" data-sup-day-open="${escapeHtml(String(dayNum))}" aria-label="Day ${escapeHtml(String(dayNum))} details">
          <span class="sup-diary-day__label">Day ${escapeHtml(String(dayNum))}</span>
          ${dateLabel ? `<p class="sup-diary-day__date">${escapeHtml(dateLabel)}</p>` : ""}
          <h4 class="sup-diary-day__phase">${escapeHtml(phase)}</h4>
          <p class="sup-diary-day__crew">${escapeHtml(crewLine)}</p>
          <p class="sup-diary-day__stats">${escapeHtml(statusLine)}</p>
        </button>
        <div class="sup-diary-day__actions">
          ${completeBtn}
          <button type="button" class="btn small" data-sup-labor data-sup-day="${escapeHtml(String(dayNum))}">Labor</button>
          <button type="button" class="btn small" data-sup-expense data-sup-day="${escapeHtml(String(dayNum))}">Expense</button>
        </div>
      </article>`;
    });
    return `<div class="sup-exec-calendar-grid sup-diary-calendar-grid" role="list">${cards.join("")}</div>`;
  }

  function renderSupervisorExecutionPlanHtml(plan) {
    if (!Array.isArray(plan) || !plan.length) return null;
    const cards = plan.map((day) => {
      const dayNum = day.day_number != null ? day.day_number : "";
      const phase = String(day.phase || "").trim() || "Work scheduled";
      const crew = (day.workers || [])
        .map((w) => String(w.role || w.worker_type || "").trim())
        .filter(Boolean);
      const uniqueCrew = [...new Set(crew)];
      const crewHtml = uniqueCrew.length
        ? `<ul class="sup-exec-day-card__crew">${uniqueCrew
            .map((r) => `<li>${escapeHtml(r)}</li>`)
            .join("")}</ul>`
        : '<p class="small" style="margin:0;">Crew pending</p>';
      return `<article class="sup-exec-day-card">
        <header class="sup-exec-day-card__head">
          <span class="sup-exec-day-card__day">DAY ${escapeHtml(String(dayNum))}</span>
        </header>
        <p class="sup-exec-day-card__phase">${escapeHtml(phase)}</p>
        <div class="sup-exec-day-card__crew-label">Crew</div>
        ${crewHtml}
      </article>`;
    });
    return `<div class="sup-exec-plan-cards">${cards.join("")}</div>`;
  }

  function syncSupConsoleLogsWrap() {
    const wrap = $("supConsoleLogs");
    const laborPanel = $("supLaborLogPanel");
    const expensePanel = $("supExpenseLogPanel");
    if (!wrap) return;
    const laborOpen = laborPanel && laborPanel.hidden === false;
    const extraOpen = expensePanel && expensePanel.hidden === false;
    wrap.hidden = !(laborOpen || extraOpen);
  }

  function openSupReportPanel(kind) {
    const laborPanel = $("supLaborLogPanel");
    const expensePanel = $("supExpenseLogPanel");
    if (kind === "labor") {
      if (expensePanel) expensePanel.hidden = true;
      if (laborPanel) laborPanel.hidden = false;
    } else if (kind === "extra") {
      if (laborPanel) laborPanel.hidden = true;
      if (expensePanel) expensePanel.hidden = false;
    }
    syncSupConsoleLogsWrap();
  }

  function closeSupReportPanels(kind) {
    const laborPanel = $("supLaborLogPanel");
    const expensePanel = $("supExpenseLogPanel");
    if (kind === "labor" || kind === "all") {
      if (laborPanel) laborPanel.hidden = true;
    }
    if (kind === "extra" || kind === "all") {
      if (expensePanel) expensePanel.hidden = true;
    }
    syncSupConsoleLogsWrap();
  }

  function openSupFieldModal(kind, dayCtx) {
    if (dayCtx && typeof dayCtx === "object") {
      supervisorActiveDayContext = { ...(supervisorActiveDayContext || {}), ...dayCtx };
    }
    const labor = $("supLaborReportModal");
    const extra = $("supExpenseReportModal");
    if (kind !== "labor" && kind !== "extra") return;
    openSupReportPanel(kind);
    const ctx = dayCtx && typeof dayCtx === "object" ? dayCtx : supervisorActiveDayContext;
    if (kind === "labor") {
      if (extra) {
        extra.setAttribute("aria-hidden", "true");
        extra.style.display = "";
      }
      if (labor) {
        labor.setAttribute("aria-hidden", "false");
        labor.style.display = "flex";
        const planned = normalizeDateInput(ctx?.plannedDate || "");
        setVal("supEntryDate", planned || todayInputValue());
        const dayNum = Math.floor(finiteNumber(ctx?.day_number, 0));
        const phase = String(ctx?.phase || "").trim();
        if (dayNum > 0 && !String(val("supEntryNote") || "").trim()) {
          setVal("supEntryNote", phase ? `Day ${dayNum} — ${phase}` : `Day ${dayNum}`);
        }
        const focusEl = $("supEntryDate");
        if (focusEl && typeof focusEl.focus === "function") focusEl.focus();
      }
    } else {
      if (labor) {
        labor.setAttribute("aria-hidden", "true");
        labor.style.display = "";
      }
      if (extra) {
        extra.setAttribute("aria-hidden", "false");
        extra.style.display = "flex";
        const planned = normalizeDateInput(ctx?.plannedDate || "");
        setVal("supExtraDate", planned || todayInputValue());
        const dayNum = Math.floor(finiteNumber(ctx?.day_number, 0));
        const phase = String(ctx?.phase || "").trim();
        if (dayNum > 0 && !String(val("supExtraNote") || "").trim()) {
          setVal("supExtraNote", phase ? `Day ${dayNum} — ${phase}` : `Day ${dayNum}`);
        }
        const focusEl = $("supExtraDate");
        if (focusEl && typeof focusEl.focus === "function") focusEl.focus();
      }
    }
    document.body.style.overflow = "hidden";
  }

  function closeSupFieldModal(kind) {
    const labor = $("supLaborReportModal");
    const extra = $("supExpenseReportModal");
    if (kind === "labor" || kind === "all") {
      if (labor) {
        labor.setAttribute("aria-hidden", "true");
        labor.style.display = "";
      }
    }
    if (kind === "extra" || kind === "all") {
      if (extra) {
        extra.setAttribute("aria-hidden", "true");
        extra.style.display = "";
      }
    }
    const laborOpen = labor && labor.getAttribute("aria-hidden") === "false";
    const extraOpen = extra && extra.getAttribute("aria-hidden") === "false";
    if (!laborOpen && !extraOpen) document.body.style.overflow = "";
    if (kind === "labor" || kind === "all") closeSupReportPanels("labor");
    if (kind === "extra" || kind === "all") closeSupReportPanels("extra");
  }

  function bindSupFieldDatePicker(inputEl) {
    if (!inputEl || inputEl.dataset?.supDatePickerBound === "1") return;
    inputEl.dataset.supDatePickerBound = "1";
    const openPicker = () => {
      if (typeof inputEl.showPicker === "function") {
        try {
          inputEl.showPicker();
        } catch (_e) {
          /* ignore if browser blocks showPicker without user gesture */
        }
      }
    };
    inputEl.addEventListener("click", openPicker);
    inputEl.addEventListener("focus", openPicker);
  }

  function bindSupFieldModalsOnce() {
    if (document.body?.dataset?.supFieldModalsBound === "1") return;
    if (document.body) document.body.dataset.supFieldModalsBound = "1";
    const laborModal = $("supLaborReportModal");
    const extraModal = $("supExpenseReportModal");
    const dayModal = $("supDayDetailModal");
    bindSupFieldDatePicker($("supEntryDate"));
    bindSupFieldDatePicker($("supExtraDate"));
    const wire = (id, handler) => {
      const el = $(id);
      if (el) el.onclick = handler;
    };
    wire("btnCloseSupLaborReport", () => closeSupFieldModal("labor"));
    wire("btnCancelSupLaborReport", () => closeSupFieldModal("labor"));
    wire("btnCloseSupExpenseReport", () => closeSupFieldModal("extra"));
    wire("btnCancelSupExpenseReport", () => closeSupFieldModal("extra"));
    wire("btnCloseSupDayDetail", () => closeSupDayDetailModal());
    wire("btnSupDayReportLabor", () => {
      const ctx = supervisorActiveDayContext;
      closeSupDayDetailModal();
      openSupFieldModal("labor", ctx);
    });
    wire("btnSupDayReportExpense", () => {
      const ctx = supervisorActiveDayContext;
      closeSupDayDetailModal();
      openSupFieldModal("extra", ctx);
    });
    wire("btnSupMarkDayCompleted", async () => {
      const btn = $("btnSupMarkDayCompleted");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Saving…";
      }
      const result = await markSupervisorDayCompleted(supervisorActiveDayContext);
      if (result.ok) {
        showSupervisorToast("Day marked completed.", "success");
        closeSupDayDetailModal();
        refreshSupervisorAfterDayAction();
      } else {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Mark completed";
        }
        showSupervisorToast(result.error, "error");
      }
    });
    wire("btnSupReopenDay", async () => {
      const result = await reopenSupervisorDay(supervisorActiveDayContext);
      if (result.ok) {
        showSupervisorToast("Day reopened.", "success");
        closeSupDayDetailModal();
        refreshSupervisorAfterDayAction();
      } else {
        showSupervisorToast(result.error, "error");
      }
    });
    [laborModal, extraModal, dayModal].forEach((modal) => {
      if (!modal) return;
      modal.addEventListener("click", (e) => {
        if (e.target !== modal) return;
        if (modal === laborModal) closeSupFieldModal("labor");
        else if (modal === extraModal) closeSupFieldModal("extra");
        else closeSupDayDetailModal();
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      closeSupDayDetailModal();
      closeSupFieldModal("all");
    });
  }

  function syncSupervisorConsoleSidebar() {
    const copyText = (srcId, dstId) => {
      const src = $(srcId);
      const dst = $(dstId);
      if (!src || !dst) return;
      dst.textContent = src.textContent || "";
    };
    copyText("supHeroStatusBadge", "supSideStatusBadge");
    copyText("supHeroStatusLine", "supSideStatusLine");
    copyText("supHeroProgressPct", "supSideProgressPct");
    copyText("supOpDaysRemaining", "supSideDaysRemaining");
    copyText("supOpBonusStatus", "supSideBonusStatus");
    const sideBadge = $("supSideStatusBadge");
    const heroBadge = $("supHeroStatusBadge");
    if (sideBadge && heroBadge) {
      sideBadge.className = heroBadge.className.replace(
        "sup-exec-hero__status",
        "sup-console-rail-badge"
      );
    }
    const alerts = $("supSideAlerts");
    const err = $("supSnapshotError");
    const start = $("supHeroStart");
    const target = $("supHeroTarget");
    const parts = [];
    const errTxt = err ? String(err.textContent || "").trim() : "";
    if (
      err &&
      err.style.display !== "none" &&
      errTxt &&
      !/refreshing field metrics/i.test(errTxt)
    ) {
      parts.push(errTxt);
    }
    const startTxt = start ? String(start.textContent || "") : "";
    const targetTxt = target ? String(target.textContent || "") : "";
    if (/pending|waiting/i.test(startTxt)) parts.push(startTxt);
    if (/pending|waiting/i.test(targetTxt)) parts.push(targetTxt);
    if (alerts) {
      if (parts.length) {
        alerts.textContent = parts.join(" · ");
        alerts.style.display = "";
      } else {
        alerts.textContent = "";
        alerts.style.display = "none";
      }
    }
  }

  function renderSupervisorHero(ctx) {
    const hero = $("supExecHero");
    if (!hero) return;
    if (!ctx || !ctx.projectName) {
      hero.style.display = "none";
      return;
    }
    hero.style.display = "";
    const set = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text == null ? "" : String(text);
    };
    const estInt = Math.max(0, Math.round(finiteNumber(ctx.estimatedDays, 0)));
    const planDay = finiteNumber(ctx.planDayIndex, 1);
    const currentDay = estInt > 0 ? Math.min(planDay, estInt) : planDay;
    const pct =
      ctx.progressPct == null
        ? 0
        : Math.min(100, Math.max(0, Math.round(ctx.progressPct)));
    const paceStatus = supervisorDisplayPaceStatus(pct, ctx.status);
    const commandLine =
      estInt > 0
        ? `Day ${currentDay} of ${estInt} · ${pct}% complete · ${paceStatus}`
        : `${pct}% complete · ${paceStatus}`;
    set("supHeroProjectName", ctx.projectName);
    set("supHeroCommandLine", commandLine);
    set("supHeroDayProgress", estInt > 0 ? `Day ${currentDay} of ${estInt}` : `Day ${currentDay}`);
    set("supHeroDurationLabel", estInt > 0 ? `${estInt}-Day Project` : "Project timeline pending");
    set("supHeroStatusLine", ctx.status?.headline || paceStatus);
    set("supHeroStart", ctx.schedule.startLabel);
    set("supHeroTarget", ctx.schedule.targetLabel);
    set("supHeroCrew", ctx.crewSummary);
    const targetHint = $("supHeroTargetHint");
    if (targetHint) {
      const hint = String(ctx.schedule.targetHint || "").trim();
      if (hint) {
        targetHint.textContent = hint;
        targetHint.style.display = "";
      } else {
        targetHint.textContent = "";
        targetHint.style.display = "none";
      }
    }
    set("supHeroProgressPct", `${pct}% complete`);
    const fill = $("supHeroProgressFill");
    if (fill) fill.style.width = `${pct}%`;
    const badge = $("supHeroStatusBadge");
    if (badge) {
      badge.textContent = ctx.status.badge;
      badge.className = `badge ${ctx.status.tone} sup-exec-hero__status`;
    }
    const migBadge = $("supMigrationBadge");
    if (migBadge) {
      if (ctx.migrationBaseline) {
        migBadge.style.display = "";
        const src = String(ctx.migrationBaseline.external_source || "Square").trim();
        migBadge.textContent = `Migrated from ${src}`;
      } else {
        migBadge.style.display = "none";
        migBadge.textContent = "";
      }
    }
    syncSupervisorConsoleSidebar();
  }

  function renderSupervisorTodayTarget(plan, startIso, actualDays, migratedCtx, opts) {
    const wrap = $("supTodayTarget");
    if (!wrap) return;
    const o = opts && typeof opts === "object" ? opts : {};
    const estDays = Math.max(0, Math.floor(finiteNumber(o.estimatedDays, 0)));
    const dayIndex = Math.max(
      1,
      Math.floor(
        finiteNumber(
          o.currentDayIndex,
          Array.isArray(plan) && plan.length
            ? supervisorCurrentPlanDayIndex(plan, startIso, actualDays)
            : 1
        )
      )
    );
    if (migratedCtx && migratedCtx.baseline) {
      wrap.style.display = "";
      const baseline = migratedCtx.baseline;
      const phaseRaw = String(baseline.current_phase || "").trim();
      const phase = supervisorIsMissingPlanPhase(phaseRaw)
        ? supervisorFallbackPhaseLabel(dayIndex, estDays || dayIndex)
        : phaseRaw;
      const headline = `Day ${dayIndex} — ${phase}`;
      if ($("supTodayHeadline")) $("supTodayHeadline").textContent = headline;
      if ($("supTodayCrew")) {
        $("supTodayCrew").textContent =
          "Crew expected: Not set by Sales";
      }
      if ($("supTodayAction")) {
        $("supTodayAction").textContent =
          "Recommended action: Mark this day completed when finished.";
      }
      return;
    }
    if (!Array.isArray(plan) || !plan.length) {
      if (estDays > 0) {
        wrap.style.display = "";
        const phase = supervisorFallbackPhaseLabel(dayIndex, estDays);
        if ($("supTodayHeadline")) {
          $("supTodayHeadline").textContent = `Day ${dayIndex} — ${phase}`;
        }
        if ($("supTodayCrew")) $("supTodayCrew").textContent = "Crew expected: Not set by Sales";
        if ($("supTodayAction")) {
          $("supTodayAction").textContent =
            "Recommended action: Mark this day completed when finished.";
        }
      } else {
        wrap.style.display = "none";
      }
      return;
    }
    const day = findOperationalPlanDay(plan, dayIndex);
    if (!day) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";
    const totalDays = Math.max(plan.length, estDays);
    const phase = supervisorResolveDayPhaseLabel(day, dayIndex, totalDays);
    if ($("supTodayHeadline")) {
      $("supTodayHeadline").textContent = `Day ${dayIndex} — ${phase}`;
    }
    if ($("supTodayCrew")) $("supTodayCrew").textContent = supervisorFormatCrewExpected(day);
    if ($("supTodayAction")) {
      $("supTodayAction").textContent =
        "Recommended action: Mark this day completed when finished.";
    }
  }

  async function fetchSupervisorOperationalSnapshot(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return { ok: false, error: "Missing project id" };
    const res = await fetch(
      `/.netlify/functions/get-supervisor-operational-snapshot?project_id=${encodeURIComponent(id)}`,
      { credentials: "include" }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      const msg =
        (data && (data.error || data.message)) ||
        (res.ok ? "Field snapshot unavailable." : `Field snapshot failed (${res.status}).`);
      return { ok: false, error: String(msg) };
    }
    const snap =
      data.operational_snapshot && typeof data.operational_snapshot === "object"
        ? data.operational_snapshot
        : {};
    return {
      ok: true,
      operational_snapshot: snap,
      operational_plan: Array.isArray(data.operational_plan) ? data.operational_plan : [],
      schedule:
        data.schedule && typeof data.schedule === "object" ? data.schedule : {},
      has_execution_plan: Boolean(data.has_execution_plan),
      migration_baseline:
        data.migration_baseline && typeof data.migration_baseline === "object"
          ? data.migration_baseline
          : null,
      has_migrated_baseline: Boolean(data.has_migrated_baseline),
      show_migrated_execution: Boolean(data.show_migrated_execution),
      migrated_field_context:
        data.migrated_field_context && typeof data.migrated_field_context === "object"
          ? data.migrated_field_context
          : null,
      day_progress: Array.isArray(data.day_progress) ? data.day_progress : [],
    };
  }

  function renderSupervisorOperationalPanel(opts) {
    if (!$("supSnapshotGrid")) return;
    const o = opts && typeof opts === "object" ? opts : {};
    const loadingEl = $("supSnapshotLoading");
    const errorEl = $("supSnapshotError");
    const gridEl = $("supSnapshotGrid");
    const badgeEl = $("supOpRiskBadge");
    const riskMetaEl = $("supOpRiskMeta");

    const setOpText = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text == null || text === "" ? "—" : String(text);
    };

    const clearOperationalFields = () => {
      const ids = [
        "supOpEstimatedDays",
        "supOpActualDays",
        "supOpDaysRemaining",
        "supOpEstimatedHours",
        "supOpActualHours",
        "supOpLaborDeviation",
        "supOpLaborDeviationLabel",
        "supOpCompletionPace",
        "supOpOperationalRisk",
        "supOpBonusStatus",
        "supOpBonusPace",
        "supOpReportCount",
        "supOpExpenseCount",
      ];
      ids.forEach((id) => setOpText(id, "—"));
    };

    if (o.loading) {
      if (loadingEl) {
        loadingEl.hidden = true;
        loadingEl.style.display = "none";
      }
      if (errorEl) {
        errorEl.style.display = "none";
        errorEl.textContent = "";
      }
      if (gridEl) gridEl.style.display = "none";
      if ($("supLiveOpsStrip")) $("supLiveOpsStrip").style.display = "none";
      setSupervisorCalHeaderSummary("—");
      if (badgeEl) badgeEl.style.display = "none";
      if (riskMetaEl) riskMetaEl.style.display = "none";
      return;
    }

    const snap = o.snapshot && typeof o.snapshot === "object" ? o.snapshot : null;

    if (o.error && !snap) {
      if (loadingEl) loadingEl.style.display = "none";
      if (errorEl) {
        errorEl.style.display = "";
        errorEl.textContent = String(o.error);
      }
      if (gridEl) gridEl.style.display = "none";
      if ($("supLiveOpsStrip")) $("supLiveOpsStrip").style.display = "none";
      setSupervisorCalHeaderSummary("—");
      if (badgeEl) badgeEl.style.display = "none";
      if (riskMetaEl) riskMetaEl.style.display = "none";
      return;
    }
    if (!snap) {
      if (loadingEl) loadingEl.style.display = "none";
      if (errorEl) {
        errorEl.style.display = "none";
        errorEl.textContent = "";
      }
      if (gridEl) gridEl.style.display = "none";
      if ($("supLiveOpsStrip")) $("supLiveOpsStrip").style.display = "none";
      setSupervisorCalHeaderSummary("—");
      if (badgeEl) badgeEl.style.display = "none";
      if (riskMetaEl) riskMetaEl.style.display = "none";
      clearOperationalFields();
      return;
    }

    if (loadingEl) {
      loadingEl.hidden = true;
      loadingEl.style.display = "none";
    }
    if (errorEl) {
      const errMsg = String(o.error || "").trim();
      const showErr =
        errMsg &&
        !/refreshing field metrics/i.test(errMsg);
      if (showErr) {
        errorEl.style.display = "";
        errorEl.textContent = errMsg;
      } else {
        errorEl.style.display = "none";
        errorEl.textContent = "";
      }
    }
    if (gridEl) gridEl.style.display = "none";

    setOpText("supOpEstimatedDays", finiteNumber(snap.estimated_days, 0).toFixed(1));
    setOpText("supOpActualDays", finiteNumber(snap.actual_days, 0).toFixed(1));
    setOpText(
      "supOpDaysRemaining",
      finiteNumber(
        snap.days_remaining != null
          ? snap.days_remaining
          : Math.max(
              0,
              finiteNumber(snap.estimated_days, 0) - finiteNumber(snap.actual_days, 0)
            ),
        0
      ).toFixed(1)
    );
    setOpText("supOpEstimatedHours", finiteNumber(snap.estimated_hours, 0).toFixed(1));
    setOpText("supOpActualHours", finiteNumber(snap.actual_hours, 0).toFixed(1));

    const devDays = finiteNumber(snap.labor_deviation_days, 0);
    setOpText("supOpLaborDeviation", formatSupervisorDeviationLabel(devDays));
    setOpText("supOpLaborDeviationLabel", "vs planned days");

    const pace = snap.completion_pace_pct;
    setOpText(
      "supOpCompletionPace",
      pace == null || pace === "" || !Number.isFinite(Number(pace))
        ? "—"
        : `${Math.round(Number(pace))}%`
    );

    const laborConfigured = finiteNumber(o.laborBudget, 0) > 0;
    const bonusCopy = formatSupervisorBonusCopy(snap, laborConfigured);
    setOpText("supOpBonusStatus", bonusCopy.status);
    setOpText("supOpBonusPace", bonusCopy.pace);

    setOpText("supOpReportCount", String(finiteNumber(snap.report_count, 0)));
    setOpText("supOpExpenseCount", String(finiteNumber(snap.expense_count, 0)));

    const risk = String(snap.operational_risk || "").trim().toLowerCase();
    setOpText("supOpOperationalRisk", formatSupervisorOperationalRisk(risk));
    const riskLabels = { low: "Low", medium: "Watch", high: "High" };
    const riskClasses = { low: "green", medium: "amber", high: "red" };
    if (badgeEl) {
      badgeEl.style.display = risk && riskLabels[risk] ? "" : "none";
      badgeEl.textContent = riskLabels[risk] || "—";
      badgeEl.className = `badge ${riskClasses[risk] || "amber"}`;
    }
    if (riskMetaEl) riskMetaEl.style.display = "none";

    const estDays = Math.round(finiteNumber(snap.estimated_days, 0));
    const actDays = Math.round(finiteNumber(snap.actual_days, 0));
    const remDays = Math.round(
      finiteNumber(
        snap.days_remaining != null
          ? snap.days_remaining
          : Math.max(0, finiteNumber(snap.estimated_days, 0) - finiteNumber(snap.actual_days, 0)),
        0
      )
    );
    const paceVal =
      snap.completion_pace_pct != null && Number.isFinite(Number(snap.completion_pace_pct))
        ? `${Math.round(Number(snap.completion_pace_pct))}% complete`
        : "—";
    const strip = $("supLiveOpsStrip");
    const setStrip = (id, text) => {
      const el = $(id);
      if (el) el.textContent = text == null ? "—" : String(text);
    };
    if (strip) strip.style.display = "none";
    setStrip("supCompactPace", paceVal);
    setStrip(
      "supCompactDaysUsed",
      estDays > 0 ? `${actDays} of ${estDays} days used` : `${actDays} days used`
    );
    setStrip(
      "supCompactDaysRemaining",
      remDays === 1 ? "1 day remaining" : `${remDays} days remaining`
    );
    setStrip("supCompactReports", `Reports: ${finiteNumber(snap.report_count, 0)}`);
    setStrip("supCompactExpenses", `Expenses: ${finiteNumber(snap.expense_count, 0)}`);
    setStrip("supCompactRisk", `Risk: ${formatSupervisorOperationalRisk(risk)}`);
    setStrip("supCompactBonus", `Bonus: ${bonusCopy.status}`);
    setSupervisorCalHeaderSummary(
      formatSupervisorCalHeaderSummary(snap, risk, bonusCopy)
    );

    syncSupervisorConsoleSidebar();
  }

  function mapTenantProjectReportRowToEntry(row) {
    if (!row) return null;
    const d = row.entry_date == null ? "" : String(row.entry_date).slice(0, 10);
    return {
      reportId: row.id,
      serverProjectId: row.project_id == null ? "" : supervisorProjectKey(row.project_id),
      date: d,
      hours: Number(row.hours) || 0,
      days: Number(row.days) || 0,
      note: row.note == null ? "" : String(row.note),
    };
  }

  function clearSupervisorProjectReportsCache() {
    Object.keys(supervisorProjectReportsCache).forEach((k) => {
      delete supervisorProjectReportsCache[k];
    });
  }

  /** projectId -> { ok: boolean, expenses: array } for tenant_project_expenses (Supervisor unexpected costs). */
  const supervisorProjectExpensesCache = Object.create(null);
  const supervisorProjectExpensesFetchInFlight = new Set();

  async function fetchProjectExpenses(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return { ok: false, expenses: [] };
    const res = await fetch(
      `/.netlify/functions/get-project-expenses?project_id=${encodeURIComponent(id)}`,
      { credentials: "include" }
    );
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return { ok: false, expenses: [] };
    const raw = Array.isArray(data.expenses) ? data.expenses : [];
    if (typeof console !== "undefined" && console.log) {
      console.log("[MG FETCH]", {
        resource: "expenses",
        projectIdRequested: id,
        rowsReturned: raw.length,
        sampleRowProjectId: raw[0]?.project_id,
      });
    }
    const expenses = filterFetchedTenantRowsForProjectId(raw, id, "expenses");
    return { ...data, expenses };
  }

  function packSupervisorExpenseNote(item, note) {
    const i = String(item || "").trim();
    const n = String(note || "").trim();
    if (n) return `${i}\n${n}`;
    return i;
  }

  function mapTenantProjectExpenseRowToExtra(row) {
    if (!row) return null;
    const parsed = parseSupervisorExpenseRow(row);
    if (!parsed) return null;
    return {
      expenseId: parsed.id,
      serverProjectId: parsed.project_id == null ? "" : supervisorProjectKey(parsed.project_id),
      date: parsed.expense_date,
      item: parsed.concept,
      amount: parsed.amount,
      note: parsed.note,
    };
  }

  function parseSupervisorExpenseRow(row) {
    if (!row || typeof row !== "object") return null;
    const rawNote = row.note == null ? "" : String(row.note);
    const nl = rawNote.indexOf("\n");
    const concept = (nl >= 0 ? rawNote.slice(0, nl) : rawNote).trim();
    const note = nl >= 0 ? rawNote.slice(nl + 1).trim() : "";
    const expenseDate = normalizeDateInput(row.expense_date || row.date || "");
    const createdAt = row.created_at ? String(row.created_at) : "";
    const expenseMs = expenseDate ? new Date(expenseDate).getTime() : 0;
    const createdMs = createdAt ? new Date(createdAt).getTime() : 0;
    const dayNumRaw = row.day_number;
    const dayNumber =
      dayNumRaw == null || dayNumRaw === ""
        ? null
        : Math.max(1, Math.floor(finiteNumber(dayNumRaw, 0))) || null;
    return {
      id: row.id,
      project_id: row.project_id,
      expense_date: expenseDate,
      concept: concept || "Expense",
      amount: finiteNumber(row.amount, 0),
      note,
      day_number: dayNumber,
      created_at: createdAt || null,
      sortMs: Math.max(
        Number.isFinite(expenseMs) ? expenseMs : 0,
        Number.isFinite(createdMs) ? createdMs : 0
      ),
    };
  }

  function sortSupervisorExpensesNewestFirst(rows) {
    return (Array.isArray(rows) ? rows : [])
      .map(parseSupervisorExpenseRow)
      .filter(Boolean)
      .sort((a, b) => {
        if (b.sortMs !== a.sortMs) return b.sortMs - a.sortMs;
        return String(b.id || "").localeCompare(String(a.id || ""));
      });
  }

  function computeSupervisorExpenseSummary(rows) {
    const list = sortSupervisorExpensesNewestFirst(rows);
    const count = list.length;
    const total = list.reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
    const average = count > 0 ? total / count : 0;
    const latest = list[0] || null;
    return {
      rows: list,
      count,
      total,
      average,
      latestConcept: latest ? latest.concept : "—",
      latestDate: latest?.expense_date
        ? formatDateUS(latest.expense_date) || latest.expense_date
        : "—",
    };
  }

  async function loadSupervisorProjectExpensesForSummary(projectId) {
    const k = supervisorProjectKey(projectId);
    if (!k) return [];
    try {
      const data = await fetchProjectExpenses(k);
      if (data && data.ok !== false && Array.isArray(data.expenses)) {
        supervisorProjectExpensesCache[k] = { ok: true, expenses: data.expenses };
        return data.expenses;
      }
    } catch (_e) {
      /* fall through to cache */
    }
    const cached = supervisorProjectExpensesCache[k];
    if (cached?.ok === true && Array.isArray(cached.expenses)) {
      return cached.expenses;
    }
    return [];
  }

  function renderSupExpenseSummaryModalContent(summary, projectName) {
    const settings = loadSettings();
    const currency = settings.currency || DEFAULTS.currency;
    const countEl = $("supExpenseSummaryCount");
    const totalEl = $("supExpenseSummaryTotal");
    const avgEl = $("supExpenseSummaryAverage");
    const lastConceptEl = $("supExpenseSummaryLastConcept");
    const lastDateEl = $("supExpenseSummaryLastDate");
    const emptyEl = $("supExpenseSummaryEmpty");
    const bodyEl = $("supExpenseSummaryBody");
    const tableWrap = document.querySelector(".sup-expense-summary-table-wrap");

    if (countEl) countEl.textContent = String(summary.count);
    if (totalEl) totalEl.textContent = money(summary.total, currency);
    if (avgEl) avgEl.textContent = money(summary.average, currency);
    if (lastConceptEl) lastConceptEl.textContent = summary.latestConcept || "—";
    if (lastDateEl) lastDateEl.textContent = summary.latestDate || "—";

    if (emptyEl) emptyEl.style.display = summary.count ? "none" : "";
    if (tableWrap) tableWrap.style.display = summary.count ? "" : "none";
    if (bodyEl) {
      if (!summary.count) {
        bodyEl.innerHTML = "";
      } else {
        bodyEl.innerHTML = summary.rows
          .map((row) => {
            const dateLabel = row.expense_date
              ? formatDateUS(row.expense_date) || row.expense_date
              : "—";
            const dayCol =
              row.day_number != null && row.day_number > 0
                ? String(row.day_number)
                : "—";
            return `<tr>
              <td>${escapeHtml(dateLabel)}</td>
              <td>${escapeHtml(row.concept)}</td>
              <td>${escapeHtml(money(row.amount, currency))}</td>
              <td>${escapeHtml(row.note || "—")}</td>
              <td>${escapeHtml(dayCol)}</td>
            </tr>`;
          })
          .join("");
      }
    }

    const printBiz = $("supExpensePrintBusiness");
    const printProject = $("supExpensePrintProject");
    const printStats = $("supExpensePrintStats");
    const printBody = $("supExpensePrintBody");
    const printFooter = $("supExpensePrintFooter");
    const bizName = String(settings.bizName || DEFAULTS.bizName || "").trim();
    if (printBiz) printBiz.textContent = bizName || "Margin Guard";
    if (printProject) {
      printProject.textContent = `Project: ${projectName || "Project"} · Supervisor field expense summary`;
    }
    if (printStats) {
      printStats.textContent = `Entries: ${summary.count} · Total spent: ${money(summary.total, currency)} · Average: ${money(summary.average, currency)} · Last expense: ${summary.latestConcept} · Last date: ${summary.latestDate}`;
    }
    if (printBody) {
      printBody.innerHTML = summary.count
        ? summary.rows
            .map((row) => {
              const dateLabel = row.expense_date
                ? formatDateUS(row.expense_date) || row.expense_date
                : "—";
              const dayCol =
                row.day_number != null && row.day_number > 0
                  ? String(row.day_number)
                  : "—";
              return `<tr>
                <td>${escapeHtml(dateLabel)}</td>
                <td>${escapeHtml(row.concept)}</td>
                <td>${escapeHtml(money(row.amount, currency))}</td>
                <td>${escapeHtml(row.note || "—")}</td>
                <td>${escapeHtml(dayCol)}</td>
              </tr>`;
            })
            .join("")
        : `<tr><td colspan="5">No unexpected expenses recorded for this project yet.</td></tr>`;
    }
    if (printFooter) {
      const printedOn = formatDateUS(new Date().toISOString().slice(0, 10)) || new Date().toLocaleDateString();
      printFooter.textContent = `Printed ${printedOn}`;
    }
  }

  function closeSupExpenseSummaryModal() {
    const modal = $("supExpenseSummaryModal");
    if (!modal) return;
    modal.setAttribute("aria-hidden", "true");
    modal.style.display = "";
    document.body.classList.remove("sup-expense-summary-printing");
    const laborOpen = $("supLaborReportModal")?.getAttribute("aria-hidden") === "false";
    const extraOpen = $("supExpenseReportModal")?.getAttribute("aria-hidden") === "false";
    const dayOpen = $("supDayDetailModal")?.getAttribute("aria-hidden") === "false";
    if (!laborOpen && !extraOpen && !dayOpen) document.body.style.overflow = "";
  }

  async function openSupExpenseSummaryModal() {
    const modal = $("supExpenseSummaryModal");
    if (!modal) return;
    const project = resolveActiveSupervisorProject();
    const projectId = supervisorProjectKey(project?.id);
    if (!projectId) {
      showSupervisorToast("Select a project to view expenses.", "error");
      return;
    }
    const loadingEl = $("supExpenseSummaryLoading");
    const errorEl = $("supExpenseSummaryError");
    const contentEl = $("supExpenseSummaryContent");
    modal.setAttribute("aria-hidden", "false");
    modal.style.display = "flex";
    document.body.style.overflow = "hidden";
    if (loadingEl) loadingEl.hidden = false;
    if (errorEl) {
      errorEl.style.display = "none";
      errorEl.textContent = "";
    }
    if (contentEl) contentEl.style.opacity = "0.55";

    let rows = [];
    try {
      rows = await loadSupervisorProjectExpensesForSummary(projectId);
    } catch (_e) {
      if (errorEl) {
        errorEl.style.display = "";
        errorEl.textContent = "Could not load project expenses.";
      }
      if (loadingEl) loadingEl.hidden = true;
      if (contentEl) contentEl.style.opacity = "";
      return;
    }

    const summary = computeSupervisorExpenseSummary(rows);
    renderSupExpenseSummaryModalContent(
      summary,
      project?.projectName || "Project"
    );
    if (loadingEl) loadingEl.hidden = true;
    if (contentEl) contentEl.style.opacity = "";
  }

  function printSupExpenseSummary() {
    const modal = $("supExpenseSummaryModal");
    if (!modal || modal.getAttribute("aria-hidden") !== "false") return;
    document.body.classList.add("sup-expense-summary-printing");
    window.print();
    window.addEventListener(
      "afterprint",
      () => {
        document.body.classList.remove("sup-expense-summary-printing");
      },
      { once: true }
    );
  }

  function bindSupExpenseSummaryOnce() {
    if (document.body?.dataset?.supExpenseSummaryBound === "1") return;
    if (document.body) document.body.dataset.supExpenseSummaryBound = "1";
    const wire = (id, handler) => {
      const el = $(id);
      if (el) el.onclick = handler;
    };
    wire("btnSupViewExpenses", () => openSupExpenseSummaryModal());
    wire("btnCloseSupExpenseSummary", () => closeSupExpenseSummaryModal());
    wire("btnCloseSupExpenseSummaryFooter", () => closeSupExpenseSummaryModal());
    wire("btnSupPrintExpenseSummary", () => printSupExpenseSummary());
    const expenseCard = $("supOpExpenseCountCard");
    if (expenseCard) {
      expenseCard.onclick = () => openSupExpenseSummaryModal();
      expenseCard.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openSupExpenseSummaryModal();
        }
      };
    }
    const summaryModal = $("supExpenseSummaryModal");
    if (summaryModal) {
      summaryModal.addEventListener("click", (e) => {
        if (e.target === summaryModal) closeSupExpenseSummaryModal();
      });
    }
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if ($("supExpenseSummaryModal")?.getAttribute("aria-hidden") === "false") {
        closeSupExpenseSummaryModal();
      }
    });
  }

  function clearSupervisorProjectExpensesCache() {
    Object.keys(supervisorProjectExpensesCache).forEach((k) => {
      delete supervisorProjectExpensesCache[k];
    });
  }

  /** projectId -> { ok: boolean, changeOrders: array } for tenant_project_change_orders. */
  const supervisorProjectChangeOrdersCache = Object.create(null);
  const supervisorProjectChangeOrdersFetchInFlight = new Set();

  async function fetchProjectChangeOrders(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return { ok: false, changeOrders: [] };
    const res = await fetch(
      `/.netlify/functions/get-project-change-orders?project_id=${encodeURIComponent(id)}`,
      { credentials: "include" }
    );
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== "object") return { ok: false, changeOrders: [] };
    const raw = Array.isArray(data.changeOrders) ? data.changeOrders : [];
    if (typeof console !== "undefined" && console.log) {
      console.log("[MG FETCH]", {
        resource: "changeOrders",
        projectIdRequested: id,
        rowsReturned: raw.length,
        sampleRowProjectId: raw[0]?.project_id,
      });
    }
    const changeOrders = filterFetchedTenantRowsForProjectId(raw, id, "changeOrders");
    return { ...data, changeOrders };
  }

  function packChangeOrderNotesForApi(userNotes, metrics, workers) {
    return JSON.stringify({
      v: 1,
      userNotes: userNotes || "",
      workers: Array.isArray(workers) ? workers.map((w) => ({ ...w })) : [],
      laborBudgetAdded: finiteNumber(metrics.labor, 0),
      hoursAdded: finiteNumber(metrics.totalHours, 0),
      minimum: finiteNumber(metrics.minimum, 0),
      negotiation: finiteNumber(metrics.negotiation, 0),
    });
  }

  function parseChangeOrderNotesFromApi(raw) {
    const s = raw == null ? "" : String(raw);
    let displayNotes = s;
    let workers = [];
    let laborBudgetAdded = 0;
    let hoursAdded = 0;
    let minimum = 0;
    let negotiation = 0;
    try {
      const p = JSON.parse(s);
      if (p && typeof p === "object" && p.v === 1) {
        displayNotes = p.userNotes != null ? String(p.userNotes) : "";
        workers = Array.isArray(p.workers) ? p.workers : [];
        laborBudgetAdded = finiteNumber(p.laborBudgetAdded, 0);
        hoursAdded = finiteNumber(p.hoursAdded, 0);
        minimum = finiteNumber(p.minimum, 0);
        negotiation = finiteNumber(p.negotiation, 0);
      }
    } catch (_e) {}
    return { displayNotes, workers, laborBudgetAdded, hoursAdded, minimum, negotiation };
  }

  function isUuidLikeChangeOrderId(value) {
    const s = String(value || "").trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  }

  /** DB-backed change order rows carry a UUID; local-only rows use ids like CO-173... */
  function getServerChangeOrderApplyId(row) {
    if (!row || typeof row !== "object") return "";
    if (row.changeOrderServerId && isUuidLikeChangeOrderId(row.changeOrderServerId)) {
      return String(row.changeOrderServerId).trim();
    }
    if (row.id && isUuidLikeChangeOrderId(row.id)) return String(row.id).trim();
    return "";
  }

  function mapTenantProjectChangeOrderRowToRow(row) {
    if (!row) return null;
    const parsed = parseChangeOrderNotesFromApi(row.notes);
    const recommended = Number(row.recommended_price) || 0;
    const min = parsed.minimum > 0 ? parsed.minimum : recommended;
    const neg = parsed.negotiation > 0 ? parsed.negotiation : recommended;
    return {
      changeOrderServerId: row.id,
      id: row.id,
      serverProjectId: row.project_id == null ? "" : supervisorProjectKey(row.project_id),
      createdAt: row.created_at || new Date().toISOString(),
      title: row.title || "",
      notes: parsed.displayNotes,
      addedDays: Number(row.worker_days) || 0,
      offeredPrice: Number(row.client_price) || 0,
      recommended,
      minimum: min,
      negotiation: neg,
      laborBudgetAdded: parsed.laborBudgetAdded,
      hoursAdded: parsed.hoursAdded,
      workers: parsed.workers,
      applied: String(row.status || "").toLowerCase() === "applied",
    };
  }

  function clearSupervisorProjectChangeOrdersCache() {
    Object.keys(supervisorProjectChangeOrdersCache).forEach((k) => {
      delete supervisorProjectChangeOrdersCache[k];
    });
  }

  async function fetchSupervisorProjects() {
    const res = await fetch("/.netlify/functions/get-supervisor-projects", { credentials: "include" });
    let data = {};
    try {
      data = await res.json();
    } catch (_e) {
      data = {};
    }
    if (!res.ok || !data || data.ok !== true || !Array.isArray(data.projects)) {
      return { ok: false, projects: [] };
    }
    return { ok: true, projects: data.projects.slice() };
  }

  /** Replaces supervisor project list from API only (no merge). */
  async function pullSupervisorProjectsFromApi() {
    try {
      const data = await fetchSupervisorProjects();
      supervisorProjectsCache = data.projects;
    } catch (_e) {
      supervisorProjectsCache = [];
    }
  }

  async function refreshSupervisorProjectsFromApi() {
    try {
      const data = await fetchSupervisorProjects();
      supervisorProjectsCache = data.projects;
    } catch (_err) {
      supervisorProjectsCache = [];
    }
    clearSupervisorProjectReportsCache();
    clearSupervisorProjectExpensesCache();
    clearSupervisorProjectChangeOrdersCache();
    clearSupervisorProjectOperationalCache();
    renderSupervisor();
  }

  /** Supervisor project picker + KPIs: exact list from last get-supervisor-projects response (no local merge). */
  function getSupervisorProjectsForUi() {
    return Array.isArray(supervisorProjectsCache) ? supervisorProjectsCache.slice() : [];
  }

  function upsertProject(project) {
    const projects = loadProjects();
    const next = [project, ...projects.filter((item) => item.id !== project.id)];
    saveProjects(next);
    saveActiveProject(project);
    return next;
  }

  /** Portfolio / signed-project rows for Sales UI (renderSales). Optional legacy key; otherwise derived from LS_PROJECTS. */
  function loadSignedProjects() {
    try {
      const legacy = readStore("mg_signed_projects", null);
      if (Array.isArray(legacy)) {
        return legacy
          .filter((row) => row && typeof row === "object")
          .map((row) => ({
            ...row,
            projectId: nonEmptyString(row.projectId, row.id, row.projectName, "")
          }));
      }
    } catch (_e) {}
    const projects = loadProjects();
    if (!Array.isArray(projects)) return [];
    return projects
      .filter((p) => {
        if (!p || typeof p !== "object") return false;
        const st = String(p.status || "").trim().toLowerCase();
        return st === "signed" || st === "completed";
      })
      .map((p) => ({
        ...p,
        projectId: nonEmptyString(p.projectId, p.id, p.projectName, "")
      }));
  }

  function loadSupervisorReports() {
    const saved = readStore(LS_SUPERVISOR_REPORTS, {});
    return saved && typeof saved === "object" ? saved : {};
  }

  function saveSupervisorReports(reports) {
    writeStore(LS_SUPERVISOR_REPORTS, reports);
  }

  function loadSupervisorSelectedProjectId() {
    return nonEmptyString(localStorage.getItem(LS_SUPERVISOR_SELECTED));
  }

  function saveSupervisorSelectedProjectId(projectId) {
    if (projectId) {
      localStorage.setItem(LS_SUPERVISOR_SELECTED, projectId);
      scheduleTenantSnapshotSync();
    }
  }

  function clearSupervisorSelectedProjectId() {
    try {
      localStorage.removeItem(LS_SUPERVISOR_SELECTED);
    } catch (_e) {
      /* ignore */
    }
    scheduleTenantSnapshotSync();
  }

  function getTenantSnapshotPayload() {
    const storage = {};
    TENANT_STORAGE_KEYS.forEach((key) => {
      const raw = localStorage.getItem(key);
      if (raw != null) storage[key] = parseJSON(raw, raw);
    });
    return {
      version: TENANT_SNAPSHOT_VERSION,
      storage
    };
  }

  function applyTenantSnapshotPayload(payload) {
    const storage = payload?.storage && typeof payload.storage === "object" ? payload.storage : {};
    tenantSyncState.loading = true;
    try {
      TENANT_STORAGE_KEYS.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(storage, key)) {
          localStorage.setItem(key, JSON.stringify(storage[key]));
        } else {
          localStorage.removeItem(key);
        }
      });
    } finally {
      tenantSyncState.loading = false;
    }
  }

  function hasMeaningfulLocalState() {
    return TENANT_STORAGE_KEYS.some((key) => {
      const raw = localStorage.getItem(key);
      if (raw == null || raw === "") return false;
      if (raw === "[]" || raw === "{}" || raw === "\"\"") return false;
      return true;
    });
  }

  async function persistTenantSnapshotNow() {
    if (!tenantSyncState.initialized || tenantSyncState.loading || tenantSyncState.saving || !window.MarginGuardTenant?.saveTenantSnapshot) return;
    const payload = getTenantSnapshotPayload();
    const serialized = JSON.stringify(payload);
    if (serialized === tenantSyncState.lastSerialized) return;

    tenantSyncState.saving = true;
    try {
      const { response, data } = await window.MarginGuardTenant.saveTenantSnapshot(payload);
      if (!response?.ok) throw new Error(data?.error || "Unable to save tenant snapshot");
      tenantSyncState.lastSerialized = serialized;
      tenantSyncState.lastSyncError = "";
      if (typeof window !== "undefined") window.__mgLastTenantSnapshotSyncError = "";
    } catch (err) {
      const msg = err && err.message ? String(err.message) : String(err || "Unknown error");
      console.error("[Margin Guard] Tenant snapshot sync failed:", msg);
      tenantSyncState.lastSyncError = msg;
      if (typeof window !== "undefined") window.__mgLastTenantSnapshotSyncError = msg;
    } finally {
      tenantSyncState.saving = false;
      if (tenantSyncState.pending) {
        tenantSyncState.pending = false;
        scheduleTenantSnapshotSync();
      }
    }
  }

  function scheduleTenantSnapshotSync() {
    if (!tenantSyncState.initialized || tenantSyncState.loading) return;
    if (tenantSyncState.saving) {
      tenantSyncState.pending = true;
      return;
    }
    if (tenantSyncState.timer) window.clearTimeout(tenantSyncState.timer);
    tenantSyncState.timer = window.setTimeout(() => {
      tenantSyncState.timer = null;
      persistTenantSnapshotNow();
    }, 400);
  }

  window.__mgScheduleTenantSnapshotSync = scheduleTenantSnapshotSync;
  window.__mgBuildTenantSnapshotPayload = getTenantSnapshotPayload;
  window.__mgComputeSalesMarginDecisionFromEconomics = computeSalesMarginDecisionFromEconomics;

  async function imageUrlToPdfDataUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const res = await fetch(url, { mode: "cors" });
      if (!res.ok) return null;
      const blob = await res.blob();
      const mime = blob.type || "";
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({ dataUrl: reader.result, mime });
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (_err) {
      return null;
    }
  }

  function pdfImageFormatFromMime(mime) {
    const m = String(mime || "").toLowerCase();
    if (m.includes("png")) return "PNG";
    if (m.includes("jpeg") || m.includes("jpg")) return "JPEG";
    if (m.includes("webp")) return "WEBP";
    return "PNG";
  }

  async function drawPdfTenantLetterhead(doc, settings, yStart = 46) {
    let branding = null;
    if (window.MarginGuardTenant?.getTenantBranding) {
      try {
        const { response, data } = await window.MarginGuardTenant.getTenantBranding({ force: true });
        if (response?.ok && data?.ok && data.branding) {
          branding = data.branding;
        }
      } catch (_err) {
        branding = null;
      }
    }

    const bizName = String(branding?.business_name || settings.bizName || DEFAULTS.bizName).trim();
    const email = String(branding?.business_email || "").trim();
    const phone = String(branding?.business_phone || "").trim();
    const address = String(branding?.business_address || "").trim();
    const logoUrl = String(branding?.logo_url || settings.publicLogoUrl || "").trim();

    const left = 40;
    const logoBox = 56;
    let y = yStart;
    let textX = left;

    if (logoUrl) {
      const loaded = await imageUrlToPdfDataUrl(logoUrl);
      if (loaded?.dataUrl) {
        const fmt = pdfImageFormatFromMime(loaded.mime);
        try {
          doc.addImage(loaded.dataUrl, fmt, left, y, logoBox, logoBox);
          textX = left + logoBox + 14;
        } catch (_err) {
          textX = left;
        }
      }
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(16);
    doc.setTextColor(17, 24, 39);
    doc.text(bizName, textX, y + 12);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(75, 85, 99);
    let lineY = y + 28;
    const pushLines = (txt) => {
      if (!txt) return;
      const lines = doc.splitTextToSize(txt, 340);
      doc.text(lines, textX, lineY);
      lineY += lines.length * 12 + 4;
    };
    pushLines(address);
    if (phone) pushLines(phone);
    if (email) pushLines(email);

    const bottom = Math.max(y + logoBox + 12, lineY + 6);
    return bottom;
  }

  async function initTenantSnapshotBridge() {
    if (!window.MarginGuardTenant?.bootstrapTenant || !window.MarginGuardTenant?.loadTenantSnapshot) {
      tenantSyncState.initialized = true;
      return;
    }

    try {
      await window.MarginGuardTenant.bootstrapTenant();
      const { response, data } = await window.MarginGuardTenant.loadTenantSnapshot();
      const snapshotPayload = data?.snapshot?.payload;

      if (response?.ok && snapshotPayload && typeof snapshotPayload === "object") {
        applyTenantSnapshotPayload(snapshotPayload);
        tenantSyncState.lastSerialized = JSON.stringify(getTenantSnapshotPayload());
      } else if (hasMeaningfulLocalState()) {
        tenantSyncState.initialized = true;
        await persistTenantSnapshotNow();
        return;
      }
    } catch (_err) {
      // Mientras terminamos la migracion, la app sigue funcionando localmente.
    }

    tenantSyncState.initialized = true;

    try {
      if (window.MarginGuardTenant?.getTenantBranding) {
        await window.MarginGuardTenant.getTenantBranding();
      }
    } catch (_e) {}
  }

  let ownerBrandingHydrateDone = false;

  /**
   * Owner only: merge get-tenant-branding into mg_business_branding_v1 where local keys are empty.
   * Does not overwrite non-empty local values (v1 rule).
   */
  async function hydrateOwnerBrandingCacheFromServer() {
    if (!$("ownerKpis")) return;
    if (ownerBrandingHydrateDone) return;
    if (!window.MarginGuardTenant?.getTenantBranding) {
      ownerBrandingHydrateDone = true;
      return;
    }
    try {
      const { response, data } = await window.MarginGuardTenant.getTenantBranding({ force: true });
      if (!response?.ok || !data?.ok || !data.branding || typeof data.branding !== "object") {
        ownerBrandingHydrateDone = true;
        return;
      }
      const b = data.branding;
      const local = readStore(LS_BRANDING, {});
      const out = { ...local };
      const isEmpty = (v) => v === undefined || v === null || String(v).trim() === "";
      const pairs = [
        ["businessName", b.business_name],
        ["businessEmail", b.business_email],
        ["businessPhone", b.business_phone],
        ["businessAddress", b.business_address],
        ["businessServiceArea", b.business_service_area],
        ["logoUrl", b.logo_url],
        ["marketLine", b.market_line],
        ["accentHex", b.accent_hex],
        ["serviceLine", b.service_line],
        ["signatureLine", b.signature_line]
      ];
      let changed = false;
      for (const [localKey, serverVal] of pairs) {
        if (isEmpty(out[localKey]) && !isEmpty(serverVal)) {
          out[localKey] = String(serverVal).trim();
          changed = true;
        }
      }
      if (changed) {
        writeStore(LS_BRANDING, out);
      }
      ownerBrandingHydrateDone = true;
    } catch (_err) {
      ownerBrandingHydrateDone = true;
    }
  }

  async function ensureTenant() {
    try {
      await fetch("/.netlify/functions/bootstrap-tenant", {
        method: "POST",
        credentials: "include"
      });
    } catch (e) {
      console.warn("Bootstrap failed silently", e);
    }
  }

  function waitForAuthReadyIfNeeded() {
    if (document.body?.dataset?.requiresAuth !== "true") {
      return Promise.resolve();
    }
    if (document.body.classList.contains("auth-ready")) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => resolve();
      const id = setInterval(() => {
        if (document.body.classList.contains("auth-ready")) {
          clearInterval(id);
          done();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(id);
        done();
      }, 5000);
    });
  }

  function loadHubViewState() {
    return {
      tab: "all",
      sortKey: "dateRaw",
      sortDir: "desc",
      search: "",
      status: "all",
      dateFrom: "",
      customer: "",
      location: "",
      preset: "",
      mode: undefined,
      ...readStore(LS_HUB_VIEW, {})
    };
  }

  function saveHubViewState(state) {
    writeStore(LS_HUB_VIEW, state);
  }

  function loadHubTemplates() {
    const saved = readStore(LS_HUB_TEMPLATES, {});
    return {
      invoice_send: {
        ...DEFAULT_HUB_TEMPLATES.invoice_send,
        ...(saved.invoice_send || {})
      },
      payment_request: {
        ...DEFAULT_HUB_TEMPLATES.payment_request,
        ...(saved.payment_request || {})
      }
    };
  }

  function saveHubTemplates(templates) {
    writeStore(LS_HUB_TEMPLATES, templates);
  }

  function buildDefaultChangeOrderWorkers(project) {
    const projectWorkers = Array.isArray(project?.workers) ? project.workers : [];
    if (projectWorkers.length) {
      return projectWorkers.map((worker, index) => ({
        name: worker.name || `Worker ${index + 1}`,
        type: worker.type || "installer",
        days: 0,
        rate: worker.rate === "" || worker.rate == null ? "" : Number(worker.rate || 0)
      }));
    }
    return [{ name: "Worker 1", type: "installer", days: 0, rate: "" }];
  }

  function buildDefaultChangeOrderDraft(project) {
    return {
      title: "",
      notes: "",
      offeredPrice: 0,
      workers: buildDefaultChangeOrderWorkers(project)
    };
  }

  function buildDefaultSupervisorReport(project) {
    return {
      projectId: project?.id || "",
      projectName: project?.projectName || "",
      estimatedDays: finiteNumber(project?.estimatedDays, 0),
      laborBudget: finiteNumber(project?.laborBudget, 0),
      dueDate: normalizeDateInput(project?.dueDate),
      projectedEndDate: "",
      locked: false,
      entries: [],
      extras: [],
      changeOrders: [],
      changeOrderDraft: buildDefaultChangeOrderDraft(project)
    };
  }

  function clearSupervisorSwitchDomBleed() {
    setSupervisorProjectedFinishDom("", { unavailableText: "Projected finish date unavailable" });
    setVal("supEntryDate", "");
    setNum("supEntryHours", 0);
    setNum("supEntryDays", 0);
    setVal("supEntryNote", "");
    setVal("supExtraDate", "");
    setVal("supExtraItem", "");
    setNum("supExtraAmount", 0);
    setVal("supExtraNote", "");
  }

  /** Clears local-only rows so another project cannot leak through LS merge; keeps projected end + lock. */
  function wipeSupervisorLocalScratchOnProjectSwitch(project) {
    if (!project?.id) return;
    const pid = supervisorProjectKey(project.id);
    const reports = loadSupervisorReports();
    const saved = reports[pid];
    const blank = buildDefaultSupervisorReport(project);
    saveSupervisorReport(pid, {
      ...blank,
      ...(saved && typeof saved === "object"
        ? {
            projectedEndDate: normalizeDateInput(saved.projectedEndDate || ""),
            locked: Boolean(saved.locked),
          }
        : {}),
      projectId: pid,
      projectName: project.projectName || blank.projectName,
      estimatedDays: 0,
      laborBudget: 0,
      entries: [],
      extras: [],
      changeOrders: [],
      changeOrderDraft: buildDefaultChangeOrderDraft(project),
    });
  }

  /** API rows include project_id; drop anything not for this project (prevents cache/UI mismatch). */
  function filterTenantRowsForProject(rows, pkey) {
    const k = supervisorProjectKey(pkey);
    if (!k || !Array.isArray(rows)) return [];
    return rows.filter((row) => row && supervisorProjectKey(row.project_id) === k);
  }

  function supervisorRowHasProjectScope(r) {
    if (!r || typeof r !== "object") return false;
    const sidRaw = r.serverProjectId != null && r.serverProjectId !== "" ? r.serverProjectId : r.project_id;
    return sidRaw != null && sidRaw !== "";
  }

  /**
   * Legacy local rows may lack project id; they are scoped to the report they are stored under.
   * Stamp serverProjectId so every row is attributable to exactly one project.
   */
  function attachSupervisorProjectIdToRows(rows, pid) {
    const k = supervisorProjectKey(pid);
    if (!k || !Array.isArray(rows)) return [];
    return rows.map((r) => {
      if (!r || typeof r !== "object") return r;
      if (supervisorRowHasProjectScope(r)) return { ...r };
      return { ...r, serverProjectId: k };
    });
  }

  /** UI rows must carry a project id; unscoped rows are dropped (no longer "match all projects"). */
  function filterSupervisorStateRowsByPid(rows, pid) {
    const k = supervisorProjectKey(pid);
    if (!k || !Array.isArray(rows)) return [];
    return rows.filter((r) => {
      if (!r || typeof r !== "object") return false;
      const sidRaw = r.serverProjectId != null && r.serverProjectId !== "" ? r.serverProjectId : r.project_id;
      if (sidRaw == null || sidRaw === "") return false;
      return supervisorProjectKey(sidRaw) === k;
    });
  }

  function finalizeSupervisorRowArraysInReport(report, pkey) {
    if (!report || typeof report !== "object") return report;
    const k = supervisorProjectKey(pkey);
    if (!k) return report;
    report.entries = filterSupervisorStateRowsByPid(
      attachSupervisorProjectIdToRows(Array.isArray(report.entries) ? report.entries : [], k),
      k
    );
    report.extras = filterSupervisorStateRowsByPid(
      attachSupervisorProjectIdToRows(Array.isArray(report.extras) ? report.extras : [], k),
      k
    );
    report.changeOrders = filterSupervisorStateRowsByPid(
      attachSupervisorProjectIdToRows(Array.isArray(report.changeOrders) ? report.changeOrders : [], k),
      k
    );
    return report;
  }

  function supervisorIsolateProjectRowArrays(state, pid) {
    return finalizeSupervisorRowArraysInReport(state, pid);
  }

  function loadSupervisorReport(project) {
    if (!project?.id) return buildDefaultSupervisorReport(null);
    const pkey = supervisorProjectKey(project.id);
    const reports = loadSupervisorReports();
    let saved = reports[pkey] ?? reports[project.id];
    if (saved && typeof saved === "object" && saved.projectId != null && supervisorProjectKey(saved.projectId) !== pkey) {
      saved = null;
    }
    const base = buildDefaultSupervisorReport(project);
    const cached = supervisorProjectReportsCache[pkey];
    const cachedExp = supervisorProjectExpensesCache[pkey];
    const cachedCo = supervisorProjectChangeOrdersCache[pkey];
    if (typeof console !== "undefined" && console.log) {
      if (cached && cached.ok === true && Array.isArray(cached.reports) && cached.reports.length) {
        console.log("[MG CACHE HIT]", {
          kind: "reports",
          pid: pkey,
          cachedLength: cached.reports.length,
          firstRowProjectId: cached.reports[0]?.project_id,
        });
      }
      if (cachedExp && cachedExp.ok === true && Array.isArray(cachedExp.expenses) && cachedExp.expenses.length) {
        console.log("[MG CACHE HIT]", {
          kind: "expenses",
          pid: pkey,
          cachedLength: cachedExp.expenses.length,
          firstRowProjectId: cachedExp.expenses[0]?.project_id,
        });
      }
      if (cachedCo && cachedCo.ok === true && Array.isArray(cachedCo.changeOrders) && cachedCo.changeOrders.length) {
        console.log("[MG CACHE HIT]", {
          kind: "changeOrders",
          pid: pkey,
          cachedLength: cachedCo.changeOrders.length,
          firstRowProjectId: cachedCo.changeOrders[0]?.project_id,
        });
      }
    }
    const listed = isServerListedSupervisorProject(pkey);
    const hadRepKey = Object.prototype.hasOwnProperty.call(supervisorProjectReportsCache, pkey);
    const hadExpKey = Object.prototype.hasOwnProperty.call(supervisorProjectExpensesCache, pkey);
    const hadCoKey = Object.prototype.hasOwnProperty.call(supervisorProjectChangeOrdersCache, pkey);

    let entries;
    let extras;
    let changeOrders;
    if (listed) {
      entries =
        cached && cached.ok === true
          ? filterTenantRowsForProject(Array.isArray(cached.reports) ? cached.reports : [], pkey)
              .map(mapTenantProjectReportRowToEntry)
              .filter(Boolean)
          : [];
      extras =
        cachedExp && cachedExp.ok === true
          ? filterTenantRowsForProject(Array.isArray(cachedExp.expenses) ? cachedExp.expenses : [], pkey)
              .map(mapTenantProjectExpenseRowToExtra)
              .filter(Boolean)
          : [];
      changeOrders =
        cachedCo && cachedCo.ok === true
          ? filterTenantRowsForProject(Array.isArray(cachedCo.changeOrders) ? cachedCo.changeOrders : [], pkey)
              .map(mapTenantProjectChangeOrderRowToRow)
              .filter(Boolean)
          : [];
      if (typeof console !== "undefined" && console.info) {
        console.info("[MG Supervisor trace]", "loadSupervisorReport", "listed branch", {
          incomingProjectId: project.id,
          pkey,
          listed,
          savedExtrasLen: saved && Array.isArray(saved.extras) ? saved.extras.length : 0,
          savedChangeOrdersLen: saved && Array.isArray(saved.changeOrders) ? saved.changeOrders.length : 0,
          cacheLens: {
            reports: cached && Array.isArray(cached.reports) ? cached.reports.length : 0,
            expenses: cachedExp && Array.isArray(cachedExp.expenses) ? cachedExp.expenses.length : 0,
            changeOrders: cachedCo && Array.isArray(cachedCo.changeOrders) ? cachedCo.changeOrders.length : 0,
          },
          outLens: { entries: entries.length, extras: extras.length, changeOrders: changeOrders.length },
        });
      }
    } else {
      const apiEntries =
        cached && cached.ok === true
          ? filterTenantRowsForProject(Array.isArray(cached.reports) ? cached.reports : [], pkey)
              .map(mapTenantProjectReportRowToEntry)
              .filter(Boolean)
          : null;
      const apiExtras =
        cachedExp && cachedExp.ok === true
          ? filterTenantRowsForProject(Array.isArray(cachedExp.expenses) ? cachedExp.expenses : [], pkey)
              .map(mapTenantProjectExpenseRowToExtra)
              .filter(Boolean)
          : null;
      const apiChangeOrders =
        cachedCo && cachedCo.ok === true
          ? filterTenantRowsForProject(Array.isArray(cachedCo.changeOrders) ? cachedCo.changeOrders : [], pkey)
              .map(mapTenantProjectChangeOrderRowToRow)
              .filter(Boolean)
          : null;
      if (!saved || typeof saved !== "object") {
        const out = {
          ...base,
          projectId: pkey,
          entries: apiEntries != null ? apiEntries : (hadRepKey ? [] : base.entries),
          extras: apiExtras != null ? apiExtras : (hadExpKey ? [] : base.extras),
          changeOrders: apiChangeOrders != null ? apiChangeOrders : (hadCoKey ? [] : base.changeOrders),
          changeOrderDraft: { ...base.changeOrderDraft },
        };
        if (typeof console !== "undefined" && console.info) {
          console.info("[MG Supervisor trace]", "loadSupervisorReport", "non-listed no-saved", {
            incomingProjectId: project.id,
            pkey,
            listed,
            savedExtrasLen: 0,
            savedChangeOrdersLen: 0,
            cacheLens: {
              reports: cached && Array.isArray(cached.reports) ? cached.reports.length : 0,
              expenses: cachedExp && Array.isArray(cachedExp.expenses) ? cachedExp.expenses.length : 0,
              changeOrders: cachedCo && Array.isArray(cachedCo.changeOrders) ? cachedCo.changeOrders.length : 0,
            },
            outLens: {
              entries: out.entries.length,
              extras: out.extras.length,
              changeOrders: out.changeOrders.length,
            },
          });
        }
        return finalizeSupervisorRowArraysInReport(out, pkey);
      }
      const repServerBackedNonListed = hadRepKey || (cached && cached.ok === true);
      const expServerBackedNonListed = hadExpKey || (cachedExp && cachedExp.ok === true);
      const coServerBackedNonListed = hadCoKey || (cachedCo && cachedCo.ok === true);
      const outMerged = {
        ...base,
        ...saved,
        projectId: pkey,
        projectName: project.projectName || base.projectName,
        estimatedDays: finiteNumber(saved.estimatedDays, base.estimatedDays),
        laborBudget: finiteNumber(saved.laborBudget, base.laborBudget),
        dueDate: normalizeDateInput(saved.dueDate || base.dueDate),
        entries:
          apiEntries != null
            ? apiEntries
            : hadRepKey
              ? []
              : repServerBackedNonListed
                ? []
                : filterSupervisorStateRowsByPid(
                    attachSupervisorProjectIdToRows(Array.isArray(saved.entries) ? saved.entries : [], pkey),
                    pkey
                  ),
        extras:
          apiExtras != null
            ? apiExtras
            : hadExpKey
              ? []
              : expServerBackedNonListed
                ? []
                : filterSupervisorStateRowsByPid(
                    attachSupervisorProjectIdToRows(Array.isArray(saved.extras) ? saved.extras : [], pkey),
                    pkey
                  ),
        changeOrders:
          apiChangeOrders != null
            ? apiChangeOrders
            : hadCoKey
              ? []
              : coServerBackedNonListed
                ? []
                : filterSupervisorStateRowsByPid(
                    attachSupervisorProjectIdToRows(Array.isArray(saved.changeOrders) ? saved.changeOrders : [], pkey),
                    pkey
                  ),
        changeOrderDraft: {
          ...base.changeOrderDraft,
          ...(saved.changeOrderDraft && typeof saved.changeOrderDraft === "object" ? saved.changeOrderDraft : {}),
          workers: Array.isArray(saved.changeOrderDraft?.workers) && saved.changeOrderDraft.workers.length
            ? saved.changeOrderDraft.workers
            : base.changeOrderDraft.workers,
        },
      };
      if (typeof console !== "undefined" && console.info) {
        console.info("[MG Supervisor trace]", "loadSupervisorReport", "non-listed merged", {
          incomingProjectId: project.id,
          pkey,
          listed,
          savedExtrasLen: Array.isArray(saved.extras) ? saved.extras.length : 0,
          savedChangeOrdersLen: Array.isArray(saved.changeOrders) ? saved.changeOrders.length : 0,
          cacheLens: {
            reports: cached && Array.isArray(cached.reports) ? cached.reports.length : 0,
            expenses: cachedExp && Array.isArray(cachedExp.expenses) ? cachedExp.expenses.length : 0,
            changeOrders: cachedCo && Array.isArray(cachedCo.changeOrders) ? cachedCo.changeOrders.length : 0,
          },
          outLens: {
            entries: outMerged.entries.length,
            extras: outMerged.extras.length,
            changeOrders: outMerged.changeOrders.length,
          },
        });
      }
      return finalizeSupervisorRowArraysInReport(outMerged, pkey);
    }

    if (typeof console !== "undefined" && console.log) {
      const se = saved && Array.isArray(saved.entries) ? saved.entries.length : 0;
      const sx = saved && Array.isArray(saved.extras) ? saved.extras.length : 0;
      const sco = saved && Array.isArray(saved.changeOrders) ? saved.changeOrders.length : 0;
      console.log("[MG LISTED ROW SOURCE]", {
        projectId: project.id,
        listed: true,
        entriesLength: entries.length,
        extrasLength: extras.length,
        changeOrdersLength: changeOrders.length,
        savedArraysPresent: { entries: se, extras: sx, changeOrders: sco },
        savedRowArraysIgnoredForListed: true,
      });
    }

    if (!saved || typeof saved !== "object") {
      const outListed = {
        ...base,
        projectId: pkey,
        entries,
        extras,
        changeOrders,
        changeOrderDraft: { ...base.changeOrderDraft },
      };
      if (typeof console !== "undefined" && console.info) {
        console.info("[MG Supervisor trace]", "loadSupervisorReport", "listed no-saved", {
          incomingProjectId: project.id,
          pkey,
          listed,
          savedExtrasLen: 0,
          savedChangeOrdersLen: 0,
          cacheLens: {
            reports: cached && Array.isArray(cached.reports) ? cached.reports.length : 0,
            expenses: cachedExp && Array.isArray(cachedExp.expenses) ? cachedExp.expenses.length : 0,
            changeOrders: cachedCo && Array.isArray(cachedCo.changeOrders) ? cachedCo.changeOrders.length : 0,
          },
          outLens: {
            entries: outListed.entries.length,
            extras: outListed.extras.length,
            changeOrders: outListed.changeOrders.length,
          },
        });
      }
      return finalizeSupervisorRowArraysInReport(outListed, pkey);
    }
    /** Listed projects: row arrays come only from server caches above — never merge saved.entries/extras/changeOrders. */
    const outListedSaved = {
      ...base,
      projectId: pkey,
      projectName: project.projectName || base.projectName,
      estimatedDays: finiteNumber(saved.estimatedDays, base.estimatedDays),
      laborBudget: finiteNumber(saved.laborBudget, base.laborBudget),
      dueDate: normalizeDateInput(saved.dueDate || base.dueDate),
      projectedEndDate: normalizeDateInput(saved.projectedEndDate || base.projectedEndDate),
      locked: saved.locked != null ? !!saved.locked : base.locked,
      entries,
      extras,
      changeOrders,
      changeOrderDraft: {
        ...base.changeOrderDraft,
        ...(saved.changeOrderDraft && typeof saved.changeOrderDraft === "object" ? saved.changeOrderDraft : {}),
        workers: Array.isArray(saved.changeOrderDraft?.workers) && saved.changeOrderDraft.workers.length
          ? saved.changeOrderDraft.workers
          : base.changeOrderDraft.workers,
      },
    };
    if (typeof console !== "undefined" && console.info) {
      console.info("[MG Supervisor trace]", "loadSupervisorReport", "listed+saved", {
        incomingProjectId: project.id,
        pkey,
        listed,
        savedExtrasLen: Array.isArray(saved.extras) ? saved.extras.length : 0,
        savedChangeOrdersLen: Array.isArray(saved.changeOrders) ? saved.changeOrders.length : 0,
        cacheLens: {
          reports: cached && Array.isArray(cached.reports) ? cached.reports.length : 0,
          expenses: cachedExp && Array.isArray(cachedExp.expenses) ? cachedExp.expenses.length : 0,
          changeOrders: cachedCo && Array.isArray(cachedCo.changeOrders) ? cachedCo.changeOrders.length : 0,
        },
        outLens: {
          entries: outListedSaved.entries.length,
          extras: outListedSaved.extras.length,
          changeOrders: outListedSaved.changeOrders.length,
        },
      });
    }
    return finalizeSupervisorRowArraysInReport(outListedSaved, pkey);
  }

  function saveSupervisorReport(projectId, report) {
    const pid = supervisorProjectKey(projectId);
    if (!pid) return;
    const src = report && typeof report === "object" ? report : {};
    const next = { ...src, projectId: pid };
    if (isServerListedSupervisorProject(pid)) {
      delete next.entries;
      delete next.extras;
      delete next.changeOrders;
    } else {
      next.entries = filterSupervisorStateRowsByPid(
        attachSupervisorProjectIdToRows(Array.isArray(src.entries) ? src.entries : [], pid),
        pid
      );
      next.extras = filterSupervisorStateRowsByPid(
        attachSupervisorProjectIdToRows(Array.isArray(src.extras) ? src.extras : [], pid),
        pid
      );
      next.changeOrders = filterSupervisorStateRowsByPid(
        attachSupervisorProjectIdToRows(Array.isArray(src.changeOrders) ? src.changeOrders : [], pid),
        pid
      );
    }
    const reports = loadSupervisorReports();
    reports[pid] = next;
    saveSupervisorReports(reports);
  }

  function getProjectById(projectId, options) {
    const supervisorOnly = Boolean(options && options.supervisorOnly);
    const k = supervisorProjectKey(projectId);
    if (!k) return null;
    const fromSup = getSupervisorProjectsForUi().find((project) => supervisorProjectKey(project.id) === k) || null;
    if (fromSup) return fromSup;
    if (supervisorOnly) return null;
    return loadProjects().find((project) => supervisorProjectKey(project.id) === k) || null;
  }

  function getSelectedProject(options) {
    const supervisorOnly = Boolean(options && options.supervisorOnly);
    const selectedId = supervisorProjectKey(loadSupervisorSelectedProjectId());
    const sup = getSupervisorProjectsForUi();
    const fromSup = sup.find((project) => supervisorProjectKey(project.id) === selectedId);
    if (fromSup) return fromSup;
    if (supervisorOnly) return sup[0] || null;
    const projects = loadProjects();
    return projects.find((project) => supervisorProjectKey(project.id) === selectedId) || projects[0] || null;
  }

  function updateProjectById(projectId, updater) {
    const k = supervisorProjectKey(projectId);
    if (!k) return null;
    const sup = getSupervisorProjectsForUi();
    const sidx = sup.findIndex((project) => supervisorProjectKey(project.id) === k);
    if (sidx >= 0) {
      const current = sup[sidx];
      const nextProject =
        typeof updater === "function" ? updater({ ...current }) : { ...current, ...updater };
      const nextList = [...sup];
      nextList[sidx] = nextProject;
      supervisorProjectsCache = nextList;
      if (supervisorProjectKey(loadSupervisorSelectedProjectId()) === k) saveActiveProject(nextProject);
      return nextProject;
    }
    const projects = loadProjects();
    const index = projects.findIndex((project) => supervisorProjectKey(project.id) === k);
    if (index < 0) return null;
    const current = projects[index];
    const nextProject = typeof updater === "function"
      ? updater({ ...current })
      : { ...current, ...updater };
    projects[index] = nextProject;
    saveProjects(projects);
    if (supervisorProjectKey(loadSupervisorSelectedProjectId()) === k) saveActiveProject(nextProject);
    return nextProject;
  }

  function normalizeCommercialStatus(value) {
    return ["draft", "sent", "approved", "signed"].includes(value) ? value : "draft";
  }

  function normalizeInvoiceStatus(value) {
    return ["draft", "sent", "partial", "paid"].includes(value) ? value : "draft";
  }

  const MG_HUB_INVOICE_LABEL_PRESETS = [
    "START PROJECT DEPOSIT",
    "PROGRESS PAYMENT 1",
    "PROGRESS PAYMENT 2",
    "PROGRESS PAYMENT 3",
    "FINAL PAYMENT"
  ];

  function sanitizeInvoiceLabelInput(raw) {
    return String(raw ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  }

  function resolveHubInvoiceLabelFromForm(presetVal, customVal) {
    const c = sanitizeInvoiceLabelInput(customVal);
    if (c) return c;
    return sanitizeInvoiceLabelInput(presetVal);
  }

  const MG_HUB_INVOICE_PURPOSE_TO_PRESET = {
    deposit: "START PROJECT DEPOSIT",
    progress: "PROGRESS PAYMENT 1",
    final: "FINAL PAYMENT"
  };

  function hubInferInvoicePurposeFromLabel(lbl) {
    const s = sanitizeInvoiceLabelInput(lbl);
    if (s === MG_HUB_INVOICE_PURPOSE_TO_PRESET.deposit) return "deposit";
    if (s === MG_HUB_INVOICE_PURPOSE_TO_PRESET.final) return "final";
    if (["PROGRESS PAYMENT 1", "PROGRESS PAYMENT 2", "PROGRESS PAYMENT 3"].includes(s)) return "progress";
    return "";
  }

  function buildDefaultInvoiceState(project) {
    return {
      invoiceNo: "",
      invoiceDate: "",
      dueDate: normalizeDateInput(project?.dueDate),
      baseAmount: finiteNumber(project?.salePrice, 0),
      depositApplied: 0,
      receivedApplied: 0,
      status: "draft",
      payments: [],
      activity: [],
      publicToken: "",
      publicUrl: "",
      paymentLink: "",
      sentAt: "",
      invoiceLabel: ""
    };
  }

  function getProjectInvoiceState(project) {
    const base = buildDefaultInvoiceState(project);
    const saved = project?.invoice && typeof project.invoice === "object" ? project.invoice : {};
    return {
      ...base,
      ...saved,
      baseAmount: finiteNumber(saved.baseAmount, base.baseAmount),
      dueDate: normalizeDateInput(saved.dueDate || base.dueDate),
      depositApplied: finiteNumber(saved.depositApplied, 0),
      receivedApplied: finiteNumber(saved.receivedApplied, 0),
      status: normalizeInvoiceStatus(saved.status),
      payments: Array.isArray(saved.payments) ? saved.payments : [],
      activity: Array.isArray(saved.activity) ? saved.activity : [],
      publicToken: nonEmptyString(saved.publicToken),
      publicUrl: nonEmptyString(saved.publicUrl),
      paymentLink: nonEmptyString(saved.paymentLink),
      serverInvoiceId: nonEmptyString(saved.serverInvoiceId, saved.supabaseInvoiceId),
      sentAt: nonEmptyString(saved.sentAt),
      invoiceLabel: sanitizeInvoiceLabelInput(nonEmptyString(saved.invoiceLabel, saved.invoice_label))
    };
  }

  const MG_SERVER_INVOICE_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function isEstimatesHubPageForTenantDraftSync() {
    return document.body?.dataset?.role === "estimates-hub";
  }

  function finiteMoneyTenantDraft(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.round(x * 100) / 100;
  }

  function buildTenantInvoiceDraftBody(project, report, inv) {
    if (!project) return null;
    const metrics = calcInvoice(project, report, inv);
    const paidTotal = finiteMoneyTenantDraft(
      finiteNumber(inv.depositApplied, 0) + finiteNumber(inv.receivedApplied, 0)
    );
    const body = {
      invoice_no: String(nonEmptyString(inv.invoiceNo, `INV-${Date.now()}`)).trim(),
      customer_name: String(project.clientName || "").trim(),
      customer_email: String(project.clientEmail || "").trim(),
      project_name: String(project.projectName || "").trim(),
      amount: finiteMoneyTenantDraft(metrics.total),
      paid_amount: paidTotal,
      balance_due: finiteMoneyTenantDraft(metrics.balance),
      status: "draft",
      issue_date: normalizeDateInput(inv.invoiceDate) || new Date().toISOString().slice(0, 10),
      due_date: normalizeDateInput(inv.dueDate || project.dueDate) || null,
      type: ["DEPOSIT", "PROGRESS", "FINAL"].includes(String(nonEmptyString(inv.type, "")).trim().toUpperCase())
        ? String(inv.type).trim().toUpperCase()
        : "PROGRESS",
      payment_link: nonEmptyString(inv.paymentLink) || ""
    };
    const notesText = String(project.notes || "").trim();
    if (notesText) {
      body.notes = notesText.slice(0, 8000);
    }
    body.invoice_label = sanitizeInvoiceLabelInput(nonEmptyString(inv.invoiceLabel, inv.invoice_label));
    const qRaw = nonEmptyString(project.quoteId, project.quote_id, inv.quoteId);
    if (qRaw && MG_SERVER_INVOICE_UUID_RE.test(String(qRaw).trim())) {
      body.quote_id = String(qRaw).trim();
    }
    const sid = nonEmptyString(inv.serverInvoiceId, inv.supabaseInvoiceId);
    if (sid && MG_SERVER_INVOICE_UUID_RE.test(sid)) {
      body.id = sid;
    }
    return body;
  }

  function applyServerInvoiceRowToLocalProject(projectId, serverRow) {
    if (!serverRow?.id) return;
    updateProjectById(projectId, (project) => {
      const cur = getProjectInvoiceState(project);
      const pub = nonEmptyString(serverRow.public_token);
      const url = pub ? `/invoice-public.html?token=${encodeURIComponent(pub)}` : nonEmptyString(cur.publicUrl);
      return {
        ...project,
        invoice: {
          ...buildDefaultInvoiceState(project),
          ...cur,
          serverInvoiceId: serverRow.id,
          invoiceNo: nonEmptyString(serverRow.invoice_no, cur.invoiceNo),
          publicToken: pub || cur.publicToken,
          publicUrl: url || cur.publicUrl,
          invoiceLabel: sanitizeInvoiceLabelInput(nonEmptyString(serverRow.invoice_label, cur.invoiceLabel))
        }
      };
    });
  }

  async function saveTenantInvoiceDraftToServer(invoiceDraft) {
    try {
      const res = await fetch("/.netlify/functions/upsert-tenant-invoice-draft", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(invoiceDraft)
      });

      const rawText = await res.text();
      let data = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (_err) {
        data = {};
      }

      if (!res.ok || !data.ok) {
        console.warn("[Invoice Hub] save draft failed", {
          status: res.status,
          statusText: res.statusText,
          response: data,
          responseText: rawText,
          payload: invoiceDraft
        });
        return null;
      }

      return data.invoice || null;
    } catch (err) {
      console.warn("[Invoice Hub] save draft error", err);
      return null;
    }
  }

  function maybePushTenantInvoiceDraftAfterHubSave(projectId, projectAfterSave) {
    if (!projectAfterSave || String(projectId).startsWith("svc-inv-")) return;
    if (!isEstimatesHubPageForTenantDraftSync()) return;
    const inv = getProjectInvoiceState(projectAfterSave);
    if (normalizeInvoiceStatus(inv.status) !== "draft") return;
    const report = loadSupervisorReport(projectAfterSave);
    const body = buildTenantInvoiceDraftBody(projectAfterSave, report, inv);
    if (!body || !body.invoice_no) return;

    void saveTenantInvoiceDraftToServer(body).then((serverRow) => {
      if (!serverRow?.id) return;
      applyServerInvoiceRowToLocalProject(projectId, serverRow);
      void refreshHubServerInvoicesCacheQuietly();
    });
  }

  async function refreshHubServerInvoicesCacheQuietly() {
    try {
      const { invoices: raw } = await loadTenantInvoicesFromServer({ limit: 100 });
      hubServerNormalizedInvoicesCache = raw.map(normalizeServerInvoiceForHub);
    } catch (_err) {
      hubServerNormalizedInvoicesCache = [];
    }
    if (typeof window.__mgHubTableRefresh === "function") {
      window.__mgHubTableRefresh();
    }
  }

  function saveProjectInvoiceState(projectId, invoice, options = {}) {
    const skipTenantDraftSync = options.skipTenantDraftSync === true;
    const nextProject = updateProjectById(projectId, (project) => ({
      ...project,
      invoice: {
        ...buildDefaultInvoiceState(project),
        ...(invoice || {}),
        dueDate: normalizeDateInput(invoice?.dueDate || project?.dueDate),
        status: normalizeInvoiceStatus(invoice?.status),
        payments: Array.isArray(invoice?.payments) ? invoice.payments : [],
        activity: Array.isArray(invoice?.activity) ? invoice.activity : [],
        publicToken: nonEmptyString(invoice?.publicToken),
        publicUrl: nonEmptyString(invoice?.publicUrl),
        paymentLink: nonEmptyString(invoice?.paymentLink),
        serverInvoiceId: nonEmptyString(invoice?.serverInvoiceId, project?.invoice?.serverInvoiceId)
      }
    }));
    if (nextProject && !skipTenantDraftSync) {
      maybePushTenantInvoiceDraftAfterHubSave(projectId, nextProject);
    }
    return nextProject;
  }

  function appendInvoiceActivity(invoice, message, dateValue, type = "note") {
    const next = Array.isArray(invoice?.activity) ? invoice.activity.slice() : [];
    next.unshift({
      message,
      at: dateValue || new Date().toISOString(),
      type
    });
    return next.slice(0, 40);
  }

  function setNotice(targetId, message, tone) {
    const node = $(targetId);
    if (!node) return;
    if (!message) {
      node.style.display = "none";
      node.className = "notice";
      node.textContent = "";
      return;
    }
    node.style.display = "block";
    node.className = `notice ${tone || ""}`.trim();
    node.textContent = message;
  }

  let hubFeedbackOkClearTimer = null;

  /** Clear #hubFeedback only when it is showing a success (ok) notice; leaves err/warn visible. */
  function clearHubFeedbackOkIfShown() {
    if (hubFeedbackOkClearTimer) {
      clearTimeout(hubFeedbackOkClearTimer);
      hubFeedbackOkClearTimer = null;
    }
    const node = $("hubFeedback");
    if (!node || node.style.display === "none") return;
    const classes = String(node.className || "")
      .trim()
      .split(/\s+/);
    if (!classes.includes("ok")) return;
    setNotice("hubFeedback", "", "");
  }

  function setHubFeedback(message, tone) {
    if (hubFeedbackOkClearTimer) {
      clearTimeout(hubFeedbackOkClearTimer);
      hubFeedbackOkClearTimer = null;
    }
    setNotice("hubFeedback", message, tone);
    const t = String(tone ?? "").toLowerCase();
    if (message && t === "ok") {
      hubFeedbackOkClearTimer = setTimeout(() => {
        hubFeedbackOkClearTimer = null;
        clearHubFeedbackOkIfShown();
      }, 3500);
    }
  }

  /** Human-readable line for #hubFeedback from send-invoice-zapier JSON (or similar). */
  function formatSendInvoiceHubFailureMessage(httpStatus, data) {
    const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
    const reason = String(d.reason || "").trim();
    const msg = String(d.message || "").trim();
    const errStr = String(d.error || "").trim();
    const details = String(d.details || "").trim();
    const zapStatusRaw = d.status;
    const zapStatus =
      zapStatusRaw !== undefined && zapStatusRaw !== null && String(zapStatusRaw) !== ""
        ? String(zapStatusRaw)
        : "";

    if (reason === "zapier_error" && zapStatus) {
      let line = `Send invoice failed: Zapier returned ${zapStatus}`;
      if (msg && !line.includes(msg)) line += ` — ${msg}`;
      if (details) {
        const short = details.length > 160 ? `${details.slice(0, 160)}…` : details;
        line += ` — ${short}`;
      }
      return line;
    }

    let core = msg || errStr || (reason ? reason.replace(/_/g, " ") : "");
    if (!core) core = httpStatus ? `HTTP ${httpStatus}` : "Unknown error";
    let out = `Send invoice failed: ${core}`;
    if (details && !out.includes(details.slice(0, 60))) {
      const short = details.length > 140 ? `${details.slice(0, 140)}…` : details;
      out += ` — ${short}`;
    }
    return out;
  }

  function setText(targetId, value) {
    const node = $(targetId);
    if (!node) return;
    node.textContent = value == null ? "" : String(value);
  }


  function normalizeInvoiceFormValue(field, rawValue) {
    if (field.type === "number") {
      const value = Number(rawValue);
      return Number.isFinite(value) ? value : 0;
    }
    if (field.type === "date") return normalizeDateInput(rawValue);
    return String(rawValue || "").trim();
  }

  let hubFormState = null;

  function closeHubFormModal() {
    hubFormState = null;
    if ($("hubFormModal")) $("hubFormModal").setAttribute("aria-hidden", "true");
    if ($("hubFormFields")) $("hubFormFields").innerHTML = "";
    setNotice("hubFormFeedback", "", "");
    clearHubFeedbackOkIfShown();
  }

  function openHubFormModal(config) {
    hubFormState = config;
    if ($("hubFormTitle")) $("hubFormTitle").textContent = config.title || "Actualizar";
    if ($("hubFormSubtitle")) $("hubFormSubtitle").textContent = config.subtitle || "Completa los datos para continuar.";
    if ($("hubFormSubmit")) $("hubFormSubmit").textContent = config.submitLabel || "Guardar";
    if ($("hubFormFields")) {
      $("hubFormFields").className = "hub-form-grid";
      $("hubFormFields").innerHTML = (Array.isArray(config.fields) ? config.fields : []).map((field) => {
        if (field.type === "static") {
          return `<div class="field hub-form-static">${field.html || ""}</div>`;
        }
        if (field.type === "textarea") {
          return `
            <div class="field">
              <label>${escapeHtml(field.label || "")}</label>
              <textarea id="${escapeHtml(field.id)}" rows="${field.rows || 4}" placeholder="${escapeHtml(field.placeholder || "")}">${escapeHtml(field.value || "")}</textarea>
            </div>
          `;
        }
        if (field.type === "select") {
          return `
            <div class="field">
              <label>${escapeHtml(field.label || "")}</label>
              <select id="${escapeHtml(field.id)}">
                ${(Array.isArray(field.options) ? field.options : []).map((option) => `
                  <option value="${escapeHtml(option.value)}" ${String(option.value) === String(field.value ?? "") ? "selected" : ""}>${escapeHtml(option.label)}</option>
                `).join("")}
              </select>
            </div>
          `;
        }
        const quickRow =
          field.type === "date" && Array.isArray(field.quickDates) && field.quickDates.length
            ? `<div class="hub-form-quick-dates">${field.quickDates
                .map((q) => {
                  const kind = escapeHtml(String(q.kind || "today").trim());
                  const hasDays = q.days != null && String(q.days).trim() !== "";
                  const daysAttr = hasDays ? ` data-hub-quick-days="${escapeHtml(String(q.days))}"` : "";
                  return `<button type="button" class="hub-form-quick-date" data-hub-quick-date-target="${escapeHtml(field.id)}" data-hub-quick-kind="${kind}"${daysAttr}>${escapeHtml(q.label || "")}</button>`;
                })
                .join("")}</div>`
            : "";
        return `
          <div class="field">
            <label>${escapeHtml(field.label || "")}</label>
            <input id="${escapeHtml(field.id)}" type="${escapeHtml(field.type || "text")}" step="${field.step || ""}" placeholder="${escapeHtml(field.placeholder || "")}" value="${escapeHtml(field.value ?? "")}" />
            ${quickRow}
            ${field.hint ? `<div class="hint" style="justify-content:flex-start;">${escapeHtml(field.hint)}</div>` : ""}
          </div>
        `;
      }).join("");
    }
    setNotice("hubFormFeedback", "", "");
    if ($("hubFormFields")) {
      $("hubFormFields").querySelectorAll("button.hub-form-quick-date").forEach((btn) => {
        btn.onclick = (ev) => {
          ev.preventDefault();
          const targetId = btn.getAttribute("data-hub-quick-date-target");
          const kind = (btn.getAttribute("data-hub-quick-kind") || "today").trim();
          const daysRaw = btn.getAttribute("data-hub-quick-days");
          const offsetDays = daysRaw !== null && daysRaw !== "" ? Number.parseInt(daysRaw, 10) : NaN;
          const input = targetId ? document.getElementById(targetId) : null;
          if (!input || input.tagName !== "INPUT") return;
          const value = hubQuickDateResolveValue(kind, offsetDays);
          input.value = value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
      });
    }
    if (typeof config.afterRender === "function") {
      try {
        config.afterRender();
      } catch (_err) {
        /* ignore */
      }
    }
    if ($("hubFormModal")) $("hubFormModal").setAttribute("aria-hidden", "false");
  }

  function openHubDeleteInvoiceConfirmModal(row, onConfirmDelete) {
    const existing = document.getElementById("hubDeleteInvoiceConfirmModal");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    const balanceText = money(finiteNumber(row?.amount, 0), settings.currency);
    const invoiceNo = nonEmptyString(row?.invoiceNo, row?.serverInvoiceNo, "—");
    const clientName = nonEmptyString(row?.customer, row?.project?.clientName, "—");
    const projectName = nonEmptyString(row?.title, row?.project?.name, "—");

    const modal = document.createElement("div");
    modal.id = "hubDeleteInvoiceConfirmModal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.style.position = "fixed";
    modal.style.inset = "0";
    modal.style.zIndex = "1200";
    modal.style.display = "grid";
    modal.style.placeItems = "center";
    modal.style.background = "rgba(8,12,20,0.66)";
    modal.innerHTML = `
      <div data-hub-delete-card style="
        width:min(560px, 94vw);
        border-radius:16px;
        border:1px solid rgba(255,255,255,0.16);
        background:rgba(15,23,42,0.82);
        backdrop-filter:blur(8px);
        box-shadow:0 22px 60px rgba(0,0,0,0.45);
        color:#e5e7eb;
        padding:20px 20px 16px;
      ">
        <div style="font-size:1.12rem;font-weight:800;margin-bottom:8px;color:#fff;">Delete invoice?</div>
        <div style="font-size:0.96rem;line-height:1.5;color:#cbd5e1;margin-bottom:14px;">
          This will permanently delete this invoice. This action cannot be undone.
        </div>
        <div style="
          border:1px solid rgba(255,255,255,0.12);
          border-radius:12px;
          background:rgba(255,255,255,0.05);
          padding:10px 12px;
          margin-bottom:12px;
          font-size:0.92rem;
          line-height:1.45;
        ">
          <div><strong>Invoice:</strong> ${escapeHtml(invoiceNo)}</div>
          <div><strong>Client:</strong> ${escapeHtml(clientName)}</div>
          <div><strong>Project:</strong> ${escapeHtml(projectName)}</div>
          <div><strong>Balance:</strong> ${escapeHtml(balanceText)}</div>
        </div>
        <div id="hubDeleteInvoiceModalError" style="display:none;color:#fecaca;font-size:0.9rem;margin-bottom:10px;"></div>
        <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">
          <button type="button" id="hubDeleteInvoiceModalCancel" class="btn" style="min-width:140px;">Cancel</button>
          <button type="button" id="hubDeleteInvoiceModalConfirm" class="btn" style="min-width:180px;background:#b91c1c;color:#fff;border:1px solid #ef4444;">Delete permanently</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const card = modal.querySelector("[data-hub-delete-card]");
    const btnCancel = modal.querySelector("#hubDeleteInvoiceModalCancel");
    const btnConfirm = modal.querySelector("#hubDeleteInvoiceModalConfirm");
    const errNode = modal.querySelector("#hubDeleteInvoiceModalError");
    let submitting = false;

    const close = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (modal.parentNode) modal.parentNode.removeChild(modal);
    };
    const showError = (msg) => {
      if (!errNode) return;
      errNode.textContent = String(msg || "Could not delete invoice.");
      errNode.style.display = "block";
    };
    const setLoading = (loading) => {
      submitting = !!loading;
      if (btnCancel) btnCancel.disabled = submitting;
      if (btnConfirm) {
        btnConfirm.disabled = submitting;
        btnConfirm.textContent = submitting ? "Deleting..." : "Delete permanently";
      }
    };
    const onKeyDown = (ev) => {
      if (ev.key === "Escape" && !submitting) {
        ev.preventDefault();
        close();
      }
    };

    modal.addEventListener("click", (ev) => {
      if (ev.target === modal && !submitting) close();
    });
    if (card) {
      card.addEventListener("click", (ev) => ev.stopPropagation());
    }
    if (btnCancel) btnCancel.onclick = () => {
      if (!submitting) close();
    };
    if (btnConfirm) {
      btnConfirm.onclick = async () => {
        if (submitting) return;
        setLoading(true);
        if (errNode) errNode.style.display = "none";
        try {
          await onConfirmDelete();
          close();
        } catch (err) {
          const safe = String(err?.message || "Could not delete invoice. Please try again.");
          showError(safe);
          setLoading(false);
        }
      };
    }
    document.addEventListener("keydown", onKeyDown, true);
  }

  function canTransitionInvoiceStatus(currentStatus, nextStatus) {
    const current = normalizeInvoiceStatus(currentStatus);
    const next = normalizeInvoiceStatus(nextStatus);
    const transitions = {
      draft: ["draft", "sent", "partial", "paid"],
      sent: ["sent", "partial", "paid"],
      partial: ["partial", "paid"],
      paid: ["paid"]
    };
    return (transitions[current] || []).includes(next);
  }

  function getHubRowActionState(row) {
    if (row?.hubRowSource === "server_invoice") {
      const rawInv = String(row.hubInvoiceRawStatus || "").toLowerCase();
      const isArchived = rawInv === "archived";
      if (isArchived) {
        return {
          canConvert: false,
          canMarkSent: false,
          canSendInvoice: false,
          canTakePayment: false,
          canMarkPaid: false,
          canRequestPayment: false,
          canPublishLink: false,
          canOpenPublic: false,
          canSetPaymentLink: false,
          canExportPdf: false,
          canArchiveServerInvoice: false,
          canDeleteServerInvoice: false
        };
      }
      const hasPublic = Boolean(
        nonEmptyString(row?.project?.invoice?.publicUrl) || nonEmptyString(row?.project?.invoice?.publicToken)
      );
      const sid = nonEmptyString(row.serverInvoiceId);
      const token = nonEmptyString(row?.project?.invoice?.publicToken);
      const canTrySend =
        (sid && MG_SERVER_INVOICE_UUID_RE.test(sid)) || (token && token.length >= 8);
      const hasClient = Boolean(
        nonEmptyString(row?.customer) || nonEmptyString(row?.project?.clientEmail)
      );
      const hasAmount = finiteNumber(row?.amount, 0) > 0;
      const rawStatus = String(row?.invoiceStatus || row?.status || "").trim().toLowerCase();
      const isDraftish =
        (rawStatus === "draft" || rawStatus === "open" || rawStatus === "") &&
        !["sent", "partial", "paid", "void", "overdue", "issued"].includes(rawStatus);
      const manualLifecycleBlock =
        hubServerQuoteIsAccepted(row) ||
        String(row.hubInvoicePaymentStatus || "").toLowerCase() === "check_pending" ||
        hubServerDepositRecorded(row);
      const canSendInvoice = Boolean(
        canTrySend && hasClient && hasAmount && isDraftish && !manualLifecycleBlock
      );
      const canArchiveServerInvoice = Boolean(sid && MG_SERVER_INVOICE_UUID_RE.test(sid));
      const canDeleteServerInvoice = Boolean(
        sid &&
          MG_SERVER_INVOICE_UUID_RE.test(sid) &&
          ["draft", "sent"].includes(String(row.hubInvoiceRawStatus || "").toLowerCase()) &&
          !hubServerQuoteIsAccepted(row)
      );
      return {
        canConvert: false,
        canMarkSent: false,
        canSendInvoice,
        canTakePayment: false,
        canMarkPaid: false,
        canRequestPayment: false,
        canPublishLink: false,
        canOpenPublic: hasPublic,
        canSetPaymentLink: false,
        canExportPdf: hasPublic,
        canArchiveServerInvoice,
        canDeleteServerInvoice
      };
    }
    const hasInvoice = Boolean(row?.invoiceNo);
    const hasAmount = finiteNumber(row?.amount, 0) > 0;
    const hasBalance = finiteNumber(row?.balance, 0) > 0;
    const hasClient = Boolean(nonEmptyString(row?.customer));
    const status = normalizeInvoiceStatus(row?.invoiceStatus || row?.status);
    return {
      canConvert: !hasInvoice && hasAmount,
      canMarkSent: hasInvoice && canTransitionInvoiceStatus(status, "sent"),
      canSendInvoice: hasInvoice && hasClient && hasAmount,
      canTakePayment: hasInvoice && hasBalance,
      canMarkPaid: hasInvoice && hasBalance,
      canRequestPayment: hasInvoice && hasBalance && ["sent", "partial"].includes(status),
      canPublishLink: hasInvoice && hasClient && hasAmount,
      canOpenPublic: Boolean(row?.project?.invoice?.publicUrl || row?.project?.invoice?.publicToken),
      canSetPaymentLink: hasInvoice,
      canExportPdf: hasInvoice && hasAmount,
      canArchiveServerInvoice: false,
      canDeleteServerInvoice: false
    };
  }

  function guardHubAction(row, capability, blockedMessage) {
    const state = getHubRowActionState(row);
    if (state[capability]) return true;
    setHubFeedback(blockedMessage, "warn");
    return false;
  }

  function inferInvoiceStatus(total, depositApplied, receivedApplied, currentStatus) {
    const safeTotal = Math.max(finiteNumber(total, 0), 0);
    const paidAmount = Math.max(finiteNumber(depositApplied, 0), 0) + Math.max(finiteNumber(receivedApplied, 0), 0);
    if (safeTotal > 0 && paidAmount >= safeTotal) return "paid";
    if (paidAmount > 0) return "partial";
    return normalizeInvoiceStatus(currentStatus);
  }

  function calcInvoice(project, report, input) {
    const baseAmount = Math.max(finiteNumber(input?.baseAmount, project?.salePrice || 0), 0);
    const changeOrders = Array.isArray(report?.changeOrders)
      ? report.changeOrders.filter((row) => normalizeCommercialStatus(row.commercialStatus || (row.applied ? "approved" : "draft")) !== "draft")
      : [];
    const changeOrderAmount = changeOrders.reduce((sum, row) => sum + finiteNumber(row.offeredPrice, 0), 0);
    const subtotal = baseAmount + changeOrderAmount;
    const depositApplied = Math.max(finiteNumber(input?.depositApplied, 0), 0);
    const receivedApplied = Math.max(finiteNumber(input?.receivedApplied, 0), 0);
    const total = subtotal;
    const balance = total - depositApplied - receivedApplied;

    return {
      changeOrders,
      changeOrderAmount,
      subtotal,
      total,
      depositApplied,
      receivedApplied,
      balance
    };
  }

  function exportChangeOrderPdf(project, changeOrder, settings) {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) return alert("jsPDF is not available.");
    if (!project || !changeOrder) return alert("Select a change order first.");

    const doc = new jsPDF({ unit: "pt", format: "letter" });
    let y = 46;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(settings.bizName || DEFAULTS.bizName, 40, y);
    y += 22;
    doc.setFontSize(13);
    doc.text("Change Order", 40, y);
    y += 22;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    [
      `Project: ${project.projectId || project.projectName || "-"}`,
      `Client: ${project.clientName || "-"}`,
      `Change Order: ${changeOrder.title || "-"}`,
      `Created: ${normalizeDateInput(changeOrder.createdAt) || new Date().toISOString().slice(0, 10)}`,
      `Status: ${normalizeCommercialStatus(changeOrder.commercialStatus || (changeOrder.applied ? "approved" : "draft"))}`
    ].forEach((line) => {
      doc.text(line, 40, y);
      y += 15;
    });

    y += 8;
    doc.setFont("helvetica", "bold");
    doc.text("Scope", 40, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    doc.text(changeOrder.notes || changeOrder.title || "-", 40, y, { maxWidth: 520 });
    y += 32;

    doc.setFont("helvetica", "bold");
    doc.text("Crew Breakdown", 40, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    (Array.isArray(changeOrder.workers) ? changeOrder.workers : []).forEach((worker) => {
      const rate = worker.rate === "" || worker.rate == null
        ? (worker.type === "helper" ? Number(settings.baseHelper || 0) : Number(settings.baseInstaller || 0))
        : Number(worker.rate || 0);
      doc.text(`- ${worker.name || "Worker"} | ${worker.type || "installer"} | ${Number(worker.days || 0).toFixed(2)} dias | ${money(rate, settings.currency)}/hr`, 40, y);
      y += 14;
    });

    y += 8;
    doc.setFont("helvetica", "bold");
    doc.text("Pricing", 40, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    [
      `Worker-days: ${Number(changeOrder.addedDays || 0).toFixed(2)}`,
      `Recommended: ${money(changeOrder.recommended || 0, settings.currency)}`,
      `Client price: ${money(changeOrder.offeredPrice || 0, settings.currency)}`
    ].forEach((line) => {
      doc.text(line, 40, y);
      y += 15;
    });

    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `change-order-${(project.projectId || project.projectName || "project").replace(/\s+/g, "-")}-${(changeOrder.title || "extra").replace(/\s+/g, "-")}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sendChangeOrder(project, changeOrder, settings) {
    if (!project || !changeOrder) return alert("Select a change order first.");
    const subject = encodeURIComponent(`Change Order - ${project.projectName || "Project"} - ${changeOrder.title || "Extra work"}`);
    const body = encodeURIComponent(
`Project: ${project.projectName || "-"}
Client: ${project.clientName || "-"}
Change Order: ${changeOrder.title || "-"}
Scope: ${changeOrder.notes || "-"}
Worker-days: ${Number(changeOrder.addedDays || 0).toFixed(2)}
Recommended: ${money(changeOrder.recommended || 0, settings.currency)}
Client price: ${money(changeOrder.offeredPrice || 0, settings.currency)}`
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }

  async function exportInvoicePdf(kind, project, report, settings, input) {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) return alert("jsPDF is not available.");
    if (!project) return alert("Select a project first.");

    const metrics = calcInvoice(project, report, input);
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    let y = await drawPdfTenantLetterhead(doc, settings, 46);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(`Invoice - ${kind}`, 40, y);
    y += 20;
    const invLbl = sanitizeInvoiceLabelInput(nonEmptyString(input?.invoiceLabel, input?.invoice_label));
    if (invLbl) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.text(invLbl, 40, y);
      y += 16;
    }
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    [
      `Project: ${project.projectName || "-"}`,
      `Client: ${project.clientName || "-"}`,
      `Due date: ${project.dueDate || "-"}`,
      `Invoice date: ${normalizeDateInput(input?.invoiceDate) || new Date().toISOString().slice(0, 10)}`,
      `Invoice no: ${nonEmptyString(input?.invoiceNo, `INV-${Date.now()}`)}`
    ].forEach((line) => {
      doc.text(line, 40, y);
      y += 15;
    });

    y += 8;
    doc.setFont("helvetica", "bold");
    doc.text("Billing Summary", 40, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    [
      `Base contract: ${money(input?.baseAmount ?? project.salePrice ?? 0, settings.currency)}`,
      `Approved change orders: ${money(metrics.changeOrderAmount, settings.currency)}`,
      `Subtotal: ${money(metrics.subtotal, settings.currency)}`,
      `Total: ${money(metrics.total, settings.currency)}`,
      `Deposit applied: ${money(metrics.depositApplied, settings.currency)}`,
      `Payments received: ${money(metrics.receivedApplied, settings.currency)}`,
      `Remaining invoice balance: ${money(metrics.balance, settings.currency)}`
    ].forEach((line) => {
      doc.text(line, 40, y);
      y += 15;
    });

    if (metrics.changeOrders.length) {
      y += 10;
      doc.setFont("helvetica", "bold");
      doc.text("Included Change Orders", 40, y);
      y += 18;
      doc.setFont("helvetica", "normal");
      metrics.changeOrders.forEach((row) => {
        doc.text(`- ${row.title || "Change order"}: ${money(row.offeredPrice || 0, settings.currency)}`, 40, y);
        y += 14;
      });
    }

    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind.toLowerCase()}-${(project.projectName || "project").replace(/\s+/g, "-")}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function buildSignedProjectFromSales(state, settings, metrics) {
  const owner = loadOwner();
  const nowIso = new Date().toISOString();
  const dueDate = normalizeDateInput(state.dueDate || state.expirationDate || todayInputValue());
  return {
    id: `${Date.now()}`,
    projectId: nonEmptyString(state.projectName),
    clientName: nonEmptyString(state.clientName),
    clientEmail: nonEmptyString(state.customerEmail),
    clientPhone: nonEmptyString(state.customerPhone),
    location: nonEmptyString(state.location, owner.location),
    dueDate,
    workers: cloneWorkers(state.workers),
    extras: [],
    status: "signed",
    approvedBySales: metrics.approved,
    pricingStage: metrics.stage,
    recommendedPrice: round2(metrics.recommended),
    negotiationPrice: round2(metrics.negotiation),
    minimumPrice: round2(metrics.minimum),
    priceOffered: round2(metrics.offered),
    finalPrice: round2(metrics.offered),
    createdAt: nowIso,
    updatedAt: nowIso,
    notes: state.notes || "",
    commissionEstimate: metrics.commissionDisplay
  };
}

  function calcChangeOrder(project, report, settings, input) {
    const workers = Array.isArray(input?.workers) && input.workers.length
      ? input.workers
      : buildDefaultChangeOrderWorkers(project);
    const hoursPerDay = Math.max(Number(project?.hoursPerDay || settings.hoursPerDay || DEFAULTS.hoursPerDay), 0.25);

    const laborByWorker = workers.map((worker) => {
      const days = Math.max(finiteNumber(worker.days, 0), 0);
      const fallbackRate = worker.type === "helper"
        ? Number(settings.baseHelper || 0)
        : Number(settings.baseInstaller || 0);
      const rate = worker.rate === "" || worker.rate == null
        ? fallbackRate
        : Number(worker.rate || 0);
      const hours = days * hoursPerDay;
      const cost = hours * rate;
      return {
        name: worker.name || "Worker",
        type: worker.type || "installer",
        days,
        rate,
        hours,
        cost
      };
    });

    const labor = laborByWorker.reduce((sum, row) => sum + row.cost, 0);
    const totalHours = laborByWorker.reduce((sum, row) => sum + row.hours, 0);
    const totalWorkerDays = laborByWorker.reduce((sum, row) => sum + row.days, 0);
    const taxPct = (
      Number(settings.wcPct || 0) +
      Number(settings.ficaPct || 0) +
      Number(settings.futaPct || 0) +
      Number(settings.casuiPct || 0)
    ) / 100;
    const taxes = labor * taxPct;
    const overheadPerHour = Number(settings.stdHours || 0) > 0
      ? Number(settings.overheadMonthly || 0) / Number(settings.stdHours || 0)
      : 0;
    const overhead = totalHours * overheadPerHour;
    const beforeProfit = labor + taxes + overhead;
    const reserve = beforeProfit * (DEFAULTS.reservePct / 100);
    const recommendedProfit = beforeProfit * (Number(settings.profitPct || 0) / 100);
    const minimumProfit = beforeProfit * 0.15;
    const recommended = beforeProfit + recommendedProfit + reserve;
    const minimum = beforeProfit + minimumProfit + reserve;
    const negotiation = recommended > minimum ? minimum + ((recommended - minimum) * 0.5) : minimum;

    return {
      workers,
      laborByWorker,
      hoursPerDay,
      crewSize: laborByWorker.length,
      laborPerDay: totalWorkerDays > 0 ? labor / totalWorkerDays : 0,
      labor,
      totalHours,
      totalWorkerDays,
      taxes,
      overhead,
      beforeProfit,
      reserve,
      recommendedProfit,
      minimumProfit,
      recommended,
      minimum,
      negotiation
    };
  }
  function calcOwner(state, settings) {
    const laborByWorker = state.workers.map((worker) => {
      const hours = Number(worker.hours || 0);
      const baseRate = worker.type === "helper" ? Number(settings.baseHelper || 0) : Number(settings.baseInstaller || 0);
      const rate = worker.rate === "" || worker.rate == null ? baseRate : Number(worker.rate || 0);
      return { hours, rate, cost: hours * rate };
    });

    const labor = laborByWorker.reduce((sum, row) => sum + row.cost, 0);
    const taxes = labor * ((Number(settings.wcPct || 0) + Number(settings.ficaPct || 0) + Number(settings.futaPct || 0) + Number(settings.casuiPct || 0)) / 100);
    const totalHours = state.workers.reduce((sum, worker) => sum + Number(worker.hours || 0), 0);
    const overheadPerHour = Number(settings.stdHours || 0) > 0 ? Number(settings.overheadMonthly || 0) / Number(settings.stdHours || 0) : 0;
    const overhead = overheadPerHour * totalHours;
    const beforeProfit = labor + taxes + overhead;
    const profit = beforeProfit * (Number(settings.profitPct || 0) / 100);
    const reserve = beforeProfit * (DEFAULTS.reservePct / 100);
    const recommended = beforeProfit + profit + reserve;
    const minimum = beforeProfit * (1 + 0.15 + DEFAULTS.reservePct / 100);
    const hoursPerDay = Math.max(Number(settings.hoursPerDay || DEFAULTS.hoursPerDay), 0.25);
    const quotedUnits = settings.pricingMode === "day" ? (totalHours / hoursPerDay) : totalHours;
    const pricePerUnit = quotedUnits > 0 ? recommended / quotedUnits : 0;
    return {
      laborByWorker,
      labor,
      taxes,
      overhead,
      beforeProfit,
      profit,
      reserve,
      minimum,
      recommended,
      totalHours,
      quotedUnits,
      pricePerUnit,
      pricingModeLabel: settings.pricingMode === "day" ? "dia" : "hora"
    };
  }

  function buildOwnerDailyBriefPlain(rows, derived) {
    const { runwayMonths, savingsPct, savingsTarget, operatingMonthly } = derived;
    const parts = [];
    if (operatingMonthly > 0 && runwayMonths >= 3) {
      parts.push(`<p><strong>Caja:</strong> Con el gasto mensual que guardaste, el negocio muestra un runway aproximado de ${runwayMonths.toFixed(1)} meses; se siente estable por ahora.</p>`);
    } else if (operatingMonthly > 0) {
      parts.push(`<p><strong>Caja:</strong> El runway aproximado es ${runwayMonths.toFixed(1)} meses; conviene vigilar cobranza y gasto.</p>`);
    } else {
      parts.push("<p><strong>Caja:</strong> Sin gasto operativo mensual en el monitor no podemos medir runway; completalo para ver si la caja se siente estable o apretada.</p>");
    }
    if (savingsTarget > 0) {
      if (savingsPct >= 50) {
        parts.push(`<p><strong>Ahorros:</strong> Vas al ${savingsPct.toFixed(0)}% de tu meta de reserva de 12 meses; el colchon se ve saludable.</p>`);
      } else {
        parts.push(`<p><strong>Ahorros:</strong> Llevas ${savingsPct.toFixed(0)}% de tu meta de 12 meses; el colchon todavia se siente debil.</p>`);
      }
    } else {
      parts.push("<p><strong>Ahorros:</strong> Activa la meta de 12 meses guardando tu gasto mensual en el monitor.</p>");
    }
    const top = rows.length
      ? rows.slice().sort((left, right) => right.priorityScore - left.priorityScore)[0]
      : null;
    if (top && top.priorityScore > 0) {
      parts.push(`<p><strong>Prioridad hoy:</strong> ${escapeHtml(top.title)} — ${escapeHtml(String(top.nextAction || "revisa el hub"))}.</p>`);
    } else {
      parts.push("<p><strong>Prioridad hoy:</strong> No hay un proyecto dominante en la cartera; abre el hub si quieres revisar detalle.</p>");
    }
    const broken = rows.filter((row) => row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10) && finiteNumber(row.balance, 0) > 0 && row.status !== "paid").length;
    const overdue = rows.filter((row) => ["overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0).length;
    if (broken + overdue > 0) {
      parts.push(`<p><strong>Riesgo operativo:</strong> Hay ${broken} promesa(s) rota(s) y ${overdue} factura(s) vencida(s) con saldo en la cartera.</p>`);
    } else {
      parts.push("<p><strong>Riesgo operativo:</strong> No se ven promesas rotas ni facturas vencidas con saldo en la cartera actual.</p>");
    }
    return parts.join("");
  }

  function fillOwnerActionLayer(rows, settings, derived) {
    if ($("oalMoneyMovesGrid")) {
      const autoRemCount = buildAutoReminderRows(rows).length;
      const readyInvoicesCount = rows.filter((row) => row.rowType === "estimate" && finiteNumber(row.amount, 0) > 0 && row.projectStatus !== "completed").length;
      const highPressureCount = rows.filter((row) => finiteNumber(row.priorityScore, 0) >= 80).length;
      const card = (cls, title, count, meta, emptyHint, hubKind) => {
        const has = count > 0;
        const actions = `<div class="oal-mm-actions"><button type="button" class="btn ${has ? "primary" : ""}" data-oal-hub="${escapeHtml(hubKind)}">${has ? "Open in Hub" : "Open Hub"}</button></div>`;
        return `
          <article class="oal-mm-card oal-mm-card--${cls}">
            <h3 class="oal-mm-title">${escapeHtml(title)}</h3>
            <div class="oal-mm-value">${has ? escapeHtml(String(count)) : "0"}</div>
            <p class="oal-mm-meta">${escapeHtml(meta)}</p>
            ${has ? "" : `<div class="oal-mm-empty">${escapeHtml(emptyHint)}</div>`}
            ${actions}
          </article>`;
      };
      $("oalMoneyMovesGrid").innerHTML = [
        card("collections", "Collections to push today", autoRemCount, "Candidatos donde conviene preparar recordatorios de cobranza hoy.", "No hay cola automatica sugerida para hoy.", "collections-auto"),
        card("invoices", "Invoices ready to send", readyInvoicesCount, "Estimates listos para mover a invoice.", "No hay estimates listos para facturar aun.", "ready-estimates"),
        card("deals", "High-pressure deals to close", highPressureCount, "Filas con prioridad 80+ entre cobranza y cierre.", "No hay acuerdos en banda de maxima presion.", "high-pressure")
      ].join("");
    }
    if ($("oalOwnerActionQueue")) {
      const ownerTasks = buildOwnerTasks(rows, settings);
      $("oalOwnerActionQueue").innerHTML = ownerTasks.length
        ? ownerTasks.map((task, index) => `
            <li>
              <span class="msg-idx">${index + 1}</span>
              <div>
                <strong>${escapeHtml(task.title)}</strong>
                <span class="hub-inline-meta">${escapeHtml(task.action)}</span>
                <span class="hub-inline-meta">${escapeHtml(task.body)}</span>
              </div>
            </li>
          `).join("")
        : "<li><span class=\"msg-idx\">–</span><div><strong>No urgent owner actions right now.</strong><span class=\"hub-inline-meta\">Cuando haya cobranza o proyectos pendientes, apareceran aqui.</span></div></li>";
    }
    if ($("oalOwnerDailyBrief")) {
      $("oalOwnerDailyBrief").innerHTML = buildOwnerDailyBriefPlain(rows, derived);
    }
  }

  function renderDashboard() {
    if (!$("dashKpis")) return;

    const settings = loadSettings();
    const state = loadDashboard();
    setNum("expensesBalance", state.expensesBalance);
    setNum("profitBalance", state.profitBalance);
    setNum("savingsBalance", state.savingsBalance);
    setNum("taxBalance", state.taxBalance);
    setNum("operatingMonthly", state.operatingMonthly);

    const refresh = () => {
      state.expensesBalance = num("expensesBalance", 0);
      state.profitBalance = num("profitBalance", 0);
      state.savingsBalance = num("savingsBalance", 0);
      state.taxBalance = num("taxBalance", 0);
      state.operatingMonthly = num("operatingMonthly", 0);
      saveDashboard(state);

      const totalCash = state.expensesBalance + state.profitBalance + state.savingsBalance + state.taxBalance;
      const runwayMonths = state.operatingMonthly > 0 ? totalCash / state.operatingMonthly : 0;
      const savingsTarget = state.operatingMonthly * 12;
      const savingsPct = savingsTarget > 0 ? clamp((state.savingsBalance / savingsTarget) * 100, 0, 999) : 0;
      const healthScore = clamp((runwayMonths * 7) + (Math.min(savingsPct, 100) * 0.35) + (state.expensesBalance >= state.operatingMonthly ? 20 : 0), 0, 100);
      const healthTone = healthClass(healthScore, 55, 80);

      if ($("overallHealth")) {
        $("overallHealth").textContent = `${healthScore.toFixed(0)}%`;
        $("overallHealth").style.color = healthTone === "green" ? "#86efac" : (healthTone === "amber" ? "#fcd34d" : "#fca5a5");
      }
      if ($("overallHealthMeta")) {
        $("overallHealthMeta").textContent = healthTone === "green" ? "Cash discipline is protecting the business." : (healthTone === "amber" ? "The business is stable but under pressure." : "High risk. Real cash is not protecting operations.");
      }
      if ($("syncBadge")) {
        $("syncBadge").className = `badge ${healthTone}`;
        $("syncBadge").textContent = "Manual sync";
      }
      if ($("executiveStrip")) {
        $("executiveStrip").innerHTML = [
          ["Cash On Hand", money(totalCash, settings.currency), "Across 4 protected accounts"],
          ["Critical Runway", `${runwayMonths.toFixed(1)} months`, "Owner target: 12.0 months"],
          ["Tax Protection", money(state.taxBalance, settings.currency), "Reserved for obligations"]
        ].map(([title, big, small]) => `
          <div class="strip-card fcc-strip-card">
            <div class="title">${escapeHtml(title)}</div>
            <div class="big">${escapeHtml(big)}</div>
            <div class="small">${escapeHtml(small)}</div>
          </div>
        `).join("");
      }

      if ($("fccDateRange")) {
        try {
          const now = new Date();
          const label = now.toLocaleString("es", { month: "long", year: "numeric" });
          $("fccDateRange").textContent = `Vista: ${label} · hasta hoy`;
        } catch (_e) {
          $("fccDateRange").textContent = "Vista del mes · hasta hoy";
        }
      }

      if ($("fccCfNetLiquidity")) $("fccCfNetLiquidity").textContent = money(totalCash, settings.currency);
      if ($("fccCfNetCash")) $("fccCfNetCash").textContent = money(totalCash, settings.currency);
      if ($("fccCfCashOut")) $("fccCfCashOut").textContent = money(state.operatingMonthly, settings.currency);
      if ($("fccCfCashIn")) {
        $("fccCfCashIn").textContent = "—";
        if ($("fccCfCashInHint")) $("fccCfCashInHint").textContent = "Se completa al cargar cartera en el hub.";
      }

      const pb = Number(state.profitBalance) || 0;
      const eb = Number(state.expensesBalance) || 0;
      const splitSum = pb + eb;
      const profitDeg = splitSum > 0 ? (pb / splitSum) * 360 : 180;
      if ($("fccDonutRoot")) $("fccDonutRoot").style.setProperty("--fcc-profit-deg", `${profitDeg}deg`);
      if ($("fccDonutCenterLabel")) $("fccDonutCenterLabel").textContent = money(pb, settings.currency);
      if ($("fccProfitLegend")) {
        $("fccProfitLegend").innerHTML = `
          <li><span class="sw violet" aria-hidden="true"></span><span>Profit bucket</span><span>${escapeHtml(money(pb, settings.currency))}</span></li>
          <li><span class="sw green" aria-hidden="true"></span><span>Operating / expenses</span><span>${escapeHtml(money(eb, settings.currency))}</span></li>
        `;
      }

      const kpis = [
        { label: "Operating / Expenses", value: money(state.expensesBalance, settings.currency), meta: "Immediate working capital", tone: healthClass(state.expensesBalance, state.operatingMonthly * 0.5, state.operatingMonthly), accent: "expense", icon: "OP" },
        { label: "Profit", value: money(state.profitBalance, settings.currency), meta: "Protected owner profit", tone: healthClass(state.profitBalance, state.operatingMonthly * 0.1, state.operatingMonthly * 0.35), accent: "profit", icon: "PR" },
        { label: "Savings", value: money(state.savingsBalance, settings.currency), meta: `12-month target: ${money(savingsTarget, settings.currency)}`, tone: healthClass(state.savingsBalance, state.operatingMonthly * 6, savingsTarget), accent: "savings", icon: "SV" },
        { label: "Tax Reserve", value: money(state.taxBalance, settings.currency), meta: "Reserved tax liability", tone: healthClass(state.taxBalance, state.operatingMonthly * 0.5, state.operatingMonthly), accent: "tax", icon: "TX" },
        { label: "Total Cash", value: money(totalCash, settings.currency), meta: "Real bank cash, not paper profit", tone: healthClass(totalCash, state.operatingMonthly * 3, state.operatingMonthly * 12), accent: "total", icon: "$$" },
        { label: "Savings Progress", value: `${savingsPct.toFixed(1)}%`, meta: "Progress to 12-month safety target", tone: healthClass(savingsPct, 50, 100), accent: "progress", icon: "%" }
      ];

      $("dashKpis").innerHTML = kpis.map(({ label, value, meta, tone, accent, icon }) => `
        <div class="kpi-box finance-box fcc-kpi-card fcc-kpi--${accent}">
          <div class="fcc-kpi-top">
            <div class="label">${escapeHtml(label)} <span class="badge ${tone}">${tone === "green" ? "Healthy" : (tone === "amber" ? "Watch" : "Risk")}</span></div>
            <div class="fcc-kpi-icon" aria-hidden="true">${escapeHtml(icon)}</div>
          </div>
          <div class="value">${escapeHtml(value)}</div>
          <div class="meta">${escapeHtml(meta)}</div>
          <div class="fcc-kpi-spark" aria-hidden="true"></div>
        </div>
      `).join("");

      const dashboardHubNeeded =
        $("dashboardRevenueStrip") || $("dashboardRevenueNote") || $("dashboardCommandStrip") || $("dashboardCommandQueue") ||
        $("dashboardOwnerTasks") || $("dashboardClientScorecard") || $("dashboardDailyDigest") || $("dashboardProfitabilityRanking") ||
        $("dashboardCashForecast") || $("dashboardWeeklyReview") || $("dashboardRiskSegments") || $("dashboardOwnerAlerts") ||
        $("fccCfCashIn") || $("fccPerfTbody") || $("oalMoneyMovesGrid") || $("oalOwnerActionQueue") || $("oalOwnerDailyBrief");

      let hubRowsSnapshot = null;
      if (dashboardHubNeeded) {
        const hubRows = buildPortfolioRows(settings);
        hubRowsSnapshot = hubRows;
        const openBalance = hubRows.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
        const collectionsCount = hubRows.filter((row) => ["sent", "partial", "overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0).length;
        const paidTotal = hubRows.filter((row) => row.status === "paid").reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
        if ($("fccCfCashIn")) {
          $("fccCfCashIn").textContent = money(paidTotal, settings.currency);
          if ($("fccCfCashInHint")) $("fccCfCashInHint").textContent = "Paid total del hub (suma de facturas pagadas).";
        }
        if ($("fccPerfTbody")) {
          const dc = "—";
          const perfRows = [
            ["Total cash on hand", money(totalCash, settings.currency)],
            ["Critical runway (months)", runwayMonths > 0 ? runwayMonths.toFixed(1) : dc],
            ["Monthly operating cost", money(state.operatingMonthly, settings.currency)],
            ["Operating / expenses balance", money(state.expensesBalance, settings.currency)],
            ["Profit balance", money(state.profitBalance, settings.currency)],
            ["Savings / reserve", money(state.savingsBalance, settings.currency)],
            ["Tax reserve", money(state.taxBalance, settings.currency)],
            ["Open receivables (hub)", money(openBalance, settings.currency)]
          ];
          $("fccPerfTbody").innerHTML = perfRows.map(([metric, v]) => `
          <tr>
            <td>${escapeHtml(metric)}</td>
            <td>${escapeHtml(v)}</td>
            <td class="muted">${dc}</td>
            <td class="muted">${dc}</td>
            <td class="muted">${dc}</td>
          </tr>
        `).join("");
        }
        const topPriority = hubRows.slice().sort((left, right) => right.priorityScore - left.priorityScore)[0];
        const focusRows = hubRows
          .filter((row) => row.priorityScore > 0)
          .slice()
          .sort((left, right) => right.priorityScore - left.priorityScore)
          .slice(0, 5);
        const ownerTasks = buildOwnerTasks(hubRows, settings);
        const autoReminderRows = buildAutoReminderRows(hubRows);
        const clientScores = buildClientCollectionsScore(hubRows, settings);
        const profitability = buildProfitabilityRanking(hubRows, settings);
        const cashForecast = buildCashInForecast(hubRows, settings);
        const weeklyReview = buildWeeklyReview(hubRows, settings);
        const riskSegments = buildRiskSegments(hubRows, settings);
        const autoStageCandidates = hubRows.filter((row) =>
          (row.status === "paid" && row.collectionStage !== "resolved") ||
          ((row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10)) && row.collectionStage !== "escalated") ||
          (["overdue", "expired"].includes(row.status) && row.collectionStage !== "escalated") ||
          (["sent", "partial"].includes(row.status) && finiteNumber(row.balance, 0) > 0 && row.collectionStage === "new")
        );
        if ($("dashboardRevenueStrip")) {
          $("dashboardRevenueStrip").innerHTML = [
            ["Open Balance", money(openBalance, settings.currency), "Saldo vivo del hub"],
            ["Collections Queue", String(collectionsCount), "Rows con saldo para trabajar"],
            ["Paid Total", money(paidTotal, settings.currency), "Facturas liquidadas"],
            ["Top Priority", topPriority ? `${topPriority.title}` : "No priority", topPriority ? `Score ${topPriority.priorityScore}` : "Sin cartera activa"]
          ].map(([title, big, small]) => `
            <div class="strip-card fcc-strip-card">
              <div class="title">${escapeHtml(title)}</div>
              <div class="big">${escapeHtml(big)}</div>
              <div class="small">${escapeHtml(small)}</div>
            </div>
          `).join("");
        }
        if ($("dashboardRevenueNote")) {
          $("dashboardRevenueNote").textContent = topPriority
            ? `Prioridad de hoy: ${topPriority.title} con saldo ${money(topPriority.balance, settings.currency)} y accion sugerida ${topPriority.nextAction}.`
            : "Todavia no hay cartera activa en el hub para mostrar prioridades.";
        }
        if ($("dashboardCommandStrip")) {
          const brokenPromises = hubRows.filter((row) => row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10) && finiteNumber(row.balance, 0) > 0 && row.status !== "paid").length;
          const readyToBill = hubRows.filter((row) => row.rowType === "estimate" && finiteNumber(row.amount, 0) > 0 && row.projectStatus !== "completed").length;
          const highPressure = hubRows.filter((row) => row.priorityScore >= 80).length;
          $("dashboardCommandStrip").innerHTML = [
            ["Broken Promises", String(brokenPromises), "Clientes que incumplieron fecha prometida"],
            ["Ready To Bill", String(readyToBill), "Estimates listos para convertir"],
            ["High Pressure", String(highPressure), "Rows con prioridad 80+"],
            ["Auto Queue", String(autoReminderRows.length), "Reminders que ya conviene preparar hoy"],
            ["Auto Stage", String(autoStageCandidates.length), "Rows donde conviene normalizar stage"]
          ].map(([title, big, small]) => `
            <div class="strip-card fcc-strip-card">
              <div class="title">${escapeHtml(title)}</div>
              <div class="big">${escapeHtml(big)}</div>
              <div class="small">${escapeHtml(small)}</div>
            </div>
          `).join("");
        }
        if ($("dashboardCommandQueue")) {
          $("dashboardCommandQueue").innerHTML = focusRows.length
            ? focusRows.map((row, index) => `
                <li>
                  <span class="msg-idx">${index + 1}</span>
                  <div>
                    <strong>${escapeHtml(row.title)}</strong>
                    <span class="hub-inline-meta">${escapeHtml(row.customer)} · ${escapeHtml(row.nextAction)} · Score ${escapeHtml(String(row.priorityScore))}</span>
                    <span class="hub-inline-meta">Balance ${escapeHtml(money(row.balance, settings.currency))} · Due ${escapeHtml(row.dueDate || "No due date")} · Stage ${escapeHtml(row.collectionStage || "new")}</span>
                  </div>
                </li>
                `).join("")
            : `<li><span class="msg-idx">0</span><div><strong>Sin cola operativa</strong><span class="hub-inline-meta">Todavia no hay proyectos con prioridad para el owner.</span></div></li>`;
        }
        if ($("dashboardOwnerTasks")) {
          $("dashboardOwnerTasks").innerHTML = ownerTasks.length
            ? ownerTasks.map((task, index) => `
                <li>
                  <span class="msg-idx">${index + 1}</span>
                  <div>
                    <strong>${escapeHtml(task.title)}</strong>
                    <span class="hub-inline-meta">${escapeHtml(task.action)}</span>
                    <span class="hub-inline-meta">${escapeHtml(task.body)}</span>
                  </div>
                </li>
              `).join("")
            : `<li><span class="msg-idx">0</span><div><strong>Sin tareas urgentes</strong><span class="hub-inline-meta">La cartera no esta pidiendo accion inmediata hoy.</span></div></li>`;
        }
        if ($("dashboardClientScorecard")) {
          $("dashboardClientScorecard").innerHTML = clientScores.length
            ? clientScores.map((item, index) => `
                <li data-dashboard-customer="${escapeHtml(item.customer)}">
                  <span class="msg-idx">${index + 1}</span>
                  <div>
                    <strong>${escapeHtml(item.customer)}</strong>
                    <span class="hub-inline-meta">Score ${escapeHtml(String(item.score))} · Open ${escapeHtml(item.openBalanceLabel)} · Overdue ${escapeHtml(item.overdueBalanceLabel)}</span>
                    <span class="hub-inline-meta">${escapeHtml(String(item.projectCount))} projects · ${escapeHtml(String(item.brokenPromises))} broken promises · Paid ${escapeHtml(item.paidTotalLabel)}</span>
                  </div>
                </li>
              `).join("")
            : `<li><span class="msg-idx">0</span><div><strong>Client mix healthy</strong><span class="hub-inline-meta">No hay concentracion de riesgo relevante por cliente.</span></div></li>`;
          $("dashboardClientScorecard").querySelectorAll("[data-dashboard-customer]").forEach((item) => {
            item.onclick = () => {
              const currentView = loadHubViewState();
              saveHubViewState({ ...currentView, tab: "collections", customer: item.dataset.dashboardCustomer || "" });
              window.location.href = "/estimates-invoices";
            };
          });
        }
        if ($("dashboardDailyDigest")) {
          $("dashboardDailyDigest").textContent = buildDailyDigest(hubRows, settings);
        }
        if ($("dashboardCashForecast")) {
          $("dashboardCashForecast").innerHTML = cashForecast.map(([title, big, small]) => `
            <div class="strip-card">
              <div class="title">${escapeHtml(title)}</div>
              <div class="big">${escapeHtml(big)}</div>
              <div class="small">${escapeHtml(small)}</div>
            </div>
          `).join("");
        }
        if ($("dashboardRiskSegments")) {
          $("dashboardRiskSegments").innerHTML = riskSegments.map(([title, count, balance]) => `
            <div class="strip-card">
              <div class="title">${escapeHtml(title)}</div>
              <div class="big">${escapeHtml(count)}</div>
              <div class="small">${escapeHtml(balance)}</div>
            </div>
          `).join("");
        }
        if ($("dashboardProfitabilityRanking")) {
          $("dashboardProfitabilityRanking").innerHTML = profitability.length
            ? profitability.map((item, index) => `
                <li data-dashboard-project="${escapeHtml(item.title)}">
                  <span class="msg-idx">${index + 1}</span>
                  <div>
                    <strong>${escapeHtml(item.title)}</strong>
                    <span class="hub-inline-meta">${escapeHtml(item.customer)} · Margin ${escapeHtml(item.marginLabel)} · Sold ${escapeHtml(item.soldLabel)}</span>
                    <span class="hub-inline-meta">${escapeHtml(item.healthLabel)}</span>
                  </div>
                </li>
              `).join("")
            : `<li><span class="msg-idx">0</span><div><strong>No margin ranking yet</strong><span class="hub-inline-meta">Todavia no hay proyectos suficientes para comparar rentabilidad.</span></div></li>`;
          $("dashboardProfitabilityRanking").querySelectorAll("[data-dashboard-project]").forEach((item) => {
            item.onclick = () => {
              const currentView = loadHubViewState();
              saveHubViewState({ ...currentView, tab: "closeout", search: item.dataset.dashboardProject || "" });
              window.location.href = "/estimates-invoices";
            };
          });
        }
        if ($("dashboardWeeklyReview")) {
          $("dashboardWeeklyReview").innerHTML = weeklyReview.map((line, index) => `
            <li>
              <span class="msg-idx">${index + 1}</span>
              <div>
                <strong>Review</strong>
                <span class="hub-inline-meta">${escapeHtml(line)}</span>
              </div>
            </li>
          `).join("");
        }
        if ($("dashboardOwnerAlerts")) {
          const alerts = [];
          const brokenPromiseRows = hubRows
            .filter((row) => row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10) && finiteNumber(row.balance, 0) > 0 && row.status !== "paid")
            .sort((left, right) => right.balance - left.balance)
            .slice(0, 2);
          brokenPromiseRows.forEach((row) => {
            alerts.push({
              tone: "red",
              title: row.title,
              body: `${row.customer}: past commitment date; remaining invoice balance ${money(row.balance, settings.currency)}.`
            });
          });
          const overdueRows = hubRows.filter((row) => ["overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0)
            .sort((left, right) => right.balance - left.balance)
            .slice(0, 2);
          overdueRows.forEach((row) => {
            alerts.push({
              tone: "red",
              title: row.title,
              body: `${row.customer}: invoice balance past due (${money(row.balance, settings.currency)}). Suggested next step: ${row.nextAction}.`
            });
          });
          const draftRows = hubRows.filter((row) => row.status === "draft" && finiteNumber(row.amount, 0) > 0)
            .slice(0, 1);
          draftRows.forEach((row) => {
            alerts.push({
              tone: "amber",
              title: row.title,
              body: `Hay un estimate listo para mover a invoice por ${money(row.amount, settings.currency)}.`
            });
          });
          const partialRows = hubRows.filter((row) => row.status === "partial")
            .sort((left, right) => right.balance - left.balance)
            .slice(0, 2);
          partialRows.forEach((row) => {
            alerts.push({
              tone: "amber",
              title: row.title,
              body: `${row.customer}: project invoice has a remaining balance of ${money(row.balance, settings.currency)}.`
            });
          });
          $("dashboardOwnerAlerts").innerHTML = alerts.length
            ? alerts.map((alert, index) => `
                <li>
                  <span class="msg-idx">${index + 1}</span>
                  <div>
                    <strong>${escapeHtml(alert.title)}</strong>
                    <span class="hub-inline-meta">${escapeHtml(alert.body)}</span>
                  </div>
                </li>
              `).join("")
            : `<li><span class="msg-idx">0</span><div><strong>Todo bajo control</strong><span class="hub-inline-meta">No hay alertas urgentes en la cartera actual.</span></div></li>`;
        }
      }

      if ($("oalMoneyMovesGrid") || $("oalOwnerActionQueue") || $("oalOwnerDailyBrief")) {
        const rows = hubRowsSnapshot || buildPortfolioRows(settings);
        fillOwnerActionLayer(rows, settings, {
          totalCash,
          runwayMonths,
          savingsPct,
          savingsTarget,
          operatingMonthly: state.operatingMonthly,
          expensesBalance: state.expensesBalance,
          savingsBalance: state.savingsBalance
        });
      }
    };

    ["expensesBalance", "profitBalance", "savingsBalance", "taxBalance", "operatingMonthly"].forEach((id) => {
      const el = $(id);
      if (el) el.oninput = refresh;
    });

    const openHubPreset = (preset, tab = "all") => {
      const currentView = loadHubViewState();
      saveHubViewState({
        ...currentView,
        tab,
        preset
      });
      window.location.href = "/estimates-invoices";
    };

    if ($("oalOwnerLayer") && !$("oalOwnerLayer").dataset.oalHubBound) {
      $("oalOwnerLayer").dataset.oalHubBound = "1";
      $("oalOwnerLayer").addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-oal-hub]");
        if (!btn) return;
        ev.preventDefault();
        const kind = btn.getAttribute("data-oal-hub") || "";
        if (kind === "collections-auto") {
          openHubPreset("open", "collections");
        } else if (kind === "ready-estimates") {
          openHubPreset("ready", "estimates");
        } else if (kind === "high-pressure") {
          const currentView = loadHubViewState();
          saveHubViewState({ ...currentView, tab: "all", preset: "action", status: "all" });
          window.location.href = "/estimates-invoices";
        }
      });
    }

    if ($("oalBtnOpenPipeline")) {
      $("oalBtnOpenPipeline").onclick = () => {
        const currentView = loadHubViewState();
        saveHubViewState({ ...currentView, tab: "pipeline" });
        window.location.href = "/estimates-invoices";
      };
    }

    if ($("btnDashboardOpenBalance")) {
      $("btnDashboardOpenBalance").onclick = () => openHubPreset("open", "all");
    }
    if ($("btnDashboardBrokenPromises")) {
      $("btnDashboardBrokenPromises").onclick = () => openHubPreset("promises", "collections");
    }
    if ($("btnDashboardReadyToBill")) {
      $("btnDashboardReadyToBill").onclick = () => openHubPreset("ready", "estimates");
    }
    if ($("btnDashboardCampaignOverdue")) {
      $("btnDashboardCampaignOverdue").onclick = () => {
        const currentView = loadHubViewState();
        saveHubViewState({ ...currentView, tab: "collections", preset: "action", status: "overdue" });
        window.location.href = "/estimates-invoices";
      };
    }
    if ($("btnDashboardCampaignPromises")) {
      $("btnDashboardCampaignPromises").onclick = () => openHubPreset("promises", "collections");
    }
    if ($("btnDashboardCampaignRisk")) {
      $("btnDashboardCampaignRisk").onclick = () => {
        const currentView = loadHubViewState();
        saveHubViewState({ ...currentView, tab: "all", preset: "action", status: "all" });
        window.location.href = "/estimates-invoices";
      };
    }
    if ($("dashboardCampaignNote")) {
      $("dashboardCampaignNote").textContent = "Overdue Push abre vencidos. Broken Promises abre promesas rotas. High Risk te manda a la vista de mayor presion operativa.";
    }

    if ($("btnSaveDashboard")) $("btnSaveDashboard").onclick = () => { refresh(); alert("Owner finance monitor saved."); };
    if ($("btnResetDashboard")) $("btnResetDashboard").onclick = () => { saveDashboard({ ...DEFAULT_DASHBOARD }); renderDashboard(); };
    refresh();
  }

  function renderBusinessSettings() {
    if (!$("btnSaveBusinessSettings")) return;
    // business-settings.html define su propio Guardar/Recargar (branding + Supabase). No pisar handlers.
    if ($("btnReloadBusinessSettings")) return;
  }
  let __ownerWorkerUiTimer = null;
  function scheduleRenderOwnerAfterWorkerInput() {
    if (__ownerWorkerUiTimer) clearTimeout(__ownerWorkerUiTimer);
    __ownerWorkerUiTimer = setTimeout(() => {
      __ownerWorkerUiTimer = null;
      renderOwner();
    }, 400);
  }

  function syncOwnerWorkersTableInputsToState(state, settings) {
    const body = $("workersBody");
    if (!body) return;
    const hoursPerDay = Math.max(Number(settings.hoursPerDay || DEFAULTS.hoursPerDay), 0.25);
    body.querySelectorAll("tr[data-index]").forEach((tr) => {
      const index = Number(tr.dataset.index ?? -1);
      if (index < 0 || !state.workers[index]) return;
      const hoursInput = tr.querySelector('input[data-key="hours"]');
      const nameInput = tr.querySelector('input[data-key="name"]');
      const typeSel = tr.querySelector('select[data-key="type"]');
      if (nameInput) state.workers[index].name = nameInput.value;
      if (typeSel) state.workers[index].type = typeSel.value;
      if (hoursInput) {
        const parsed = parseOwnerLaborQtyInput(hoursInput.value);
        const displayInt = parsed.empty ? 0 : parsed.displayInt;
        state.workers[index].hours = ownerLaborDisplayUnitsToHours(displayInt, settings, hoursPerDay);
      }
    });
  }

  function buildOwnerKpis(state, settings, metrics) {
    return [
      ["Direct Labor", money(metrics.labor, settings.currency), `${state.workers.length} workers modeled`],
      ["Employer Burden", money(metrics.taxes, settings.currency), `WC ${settings.wcPct}% | FICA ${settings.ficaPct}% | FUTA ${settings.futaPct}% | CASUI ${settings.casuiPct}%`],
      ["Overhead Allocation", money(metrics.overhead, settings.currency), Number(settings.stdHours || 0) > 0 ? `${money(Number(settings.overheadMonthly || 0) / Number(settings.stdHours || 0), settings.currency)}/hour` : "Set standard hours to activate"],
      ["Cost Before Profit", money(metrics.beforeProfit, settings.currency), "Direct cost plus indirect burden"],
      ["Target Profit", money(metrics.profit, settings.currency), `${Number(settings.profitPct || 0).toFixed(1)}% owner rule`],
      ["Fixed Reserve", money(metrics.reserve, settings.currency), `${DEFAULTS.reservePct}% non-negotiable`],
      ["Minimum Floor", money(metrics.minimum, settings.currency), "Below this, the business bleeds cash"],
      ["Recommended Price", money(metrics.recommended, settings.currency), "This is the number the system wants sold"],
      [`Recommended per ${metrics.pricingModeLabel}`, money(metrics.pricePerUnit, settings.currency), `${metrics.quotedUnits.toFixed(2)} ${metrics.pricingModeLabel === "dia" ? "dias" : "horas"} cotizables`]
    ];
  }

  function renderWorkers(state, settings, metrics) {
    const body = $("workersBody");
    if (!body) return;
    const hoursPerDay = Math.max(Number(settings.hoursPerDay || DEFAULTS.hoursPerDay), 0.25);
    const unitsLabel = settings.pricingMode === "day" ? "Dias" : "Horas";
    if ($("workerUnitsHead")) $("workerUnitsHead").textContent = unitsLabel;
    if ($("workerRateHead")) $("workerRateHead").textContent = "Costo base";

    body.innerHTML = state.workers.map((worker, index) => `
      <tr data-index="${index}">
        <td><input data-key="name" maxlength="40" value="${escapeHtml(worker.name || "")}" /></td>
        <td>
          <select data-key="type">
            <option value="installer" ${worker.type === "installer" ? "selected" : ""}>Pro</option>
            <option value="helper" ${worker.type === "helper" ? "selected" : ""}>Assistant</option>
          </select>
        </td>
        <td><input data-key="hours" type="number" inputmode="numeric" min="0" step="1" pattern="[0-9]*" value="${ownerLaborHoursToDisplayUnits(worker.hours, settings, hoursPerDay)}" /></td>
        <td><input data-key="rate" type="number" step="0.01" value="${worker.type === "helper" ? settings.baseHelper : settings.baseInstaller}" readonly /></td>
        <td data-cell="labor">${money(metrics.laborByWorker[index]?.cost || 0, settings.currency)}</td>
        <td>
          <div class="row-actions">
            <button class="btn ghost" data-action="copy">Copy</button>
            <button class="btn danger" data-action="delete">Delete</button>
          </div>
        </td>
      </tr>
    `).join("");

    body.querySelectorAll("input,select").forEach((el) => {
      const commit = () => {
        if (__ownerWorkerUiTimer) {
          clearTimeout(__ownerWorkerUiTimer);
          __ownerWorkerUiTimer = null;
        }
        const tr = el.closest("tr");
        const index = Number(tr?.dataset.index ?? -1);
        const key = el.dataset.key;
        if (index < 0 || !key) return;
        const s = loadOwner();
        if (!Array.isArray(s.workers) || !s.workers[index]) return;
        if (key === "hours") {
          const parsed = parseOwnerLaborQtyInput(el.value);
          const displayInt = parsed.empty ? 0 : parsed.displayInt;
          s.workers[index].hours = ownerLaborDisplayUnitsToHours(displayInt, settings, hoursPerDay);
          el.value = parsed.empty ? "" : String(displayInt);
        } else {
          s.workers[index][key] = el.value;
        }
        if (key === "type") s.workers[index].rate = "";
        saveOwner(s, calcOwner(s, settings));
        renderOwner();
      };
      if (el.dataset.key === "hours") {
        el.addEventListener("input", () => {
          const tr = el.closest("tr");
          const index = Number(tr?.dataset.index ?? -1);
          if (index < 0) return;
          const s = loadOwner();
          if (!Array.isArray(s.workers) || !s.workers[index]) return;
          const parsed = parseOwnerLaborQtyInput(el.value);
          const displayInt = parsed.empty ? 0 : parsed.displayInt;
          s.workers[index].hours = ownerLaborDisplayUnitsToHours(displayInt, settings, hoursPerDay);
          el.value = parsed.empty ? "" : String(displayInt);
          saveOwner(s, calcOwner(s, settings));
          const m = calcOwner(s, settings);
          const laborTd = tr?.querySelector("[data-cell=\"labor\"]");
          if (laborTd) laborTd.textContent = money(m.laborByWorker[index]?.cost || 0, settings.currency);
          scheduleRenderOwnerAfterWorkerInput();
        });
        el.addEventListener("focus", () => {
          try {
            el.select();
          } catch (_e) {
            /* noop */
          }
        });
        el.addEventListener("change", commit);
        el.addEventListener("blur", commit);
      } else if (el.dataset.key === "name") {
        el.addEventListener("change", commit);
        el.addEventListener("blur", commit);
      } else if (el.tagName === "SELECT") {
        el.addEventListener("change", commit);
      }
    });

    body.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        if (__ownerWorkerUiTimer) {
          clearTimeout(__ownerWorkerUiTimer);
          __ownerWorkerUiTimer = null;
        }
        const tr = button.closest("tr");
        const index = Number(tr?.dataset.index ?? -1);
        if (index < 0) return;
        const s = loadOwner();
        if (!Array.isArray(s.workers)) return;
        if (button.dataset.action === "delete") s.workers.splice(index, 1);
        if (button.dataset.action === "copy") s.workers.splice(index + 1, 0, { ...s.workers[index] });
        saveOwner(s, calcOwner(s, settings));
        renderOwner();
      });
    });
  }

  function renderOwner() {
    if (!$("ownerKpis")) return;

    const settings = loadSettings();
    const state = loadOwner();
    state.reservePct = DEFAULTS.reservePct;
    let metrics = calcOwner(state, settings);

    const projectNameEl = $("projectName");
    if (projectNameEl && document.activeElement === projectNameEl) {
      state.projectName = val("projectName");
    } else {
      setVal("projectName", state.projectName);
    }
    const clientNameEl = $("clientName");
    if (clientNameEl && document.activeElement === clientNameEl) {
      state.clientName = val("clientName");
    } else {
      setVal("clientName", state.clientName);
    }
    const clientEmailEl = $("clientEmail");
    if (clientEmailEl && document.activeElement === clientEmailEl) {
      state.clientEmail = val("clientEmail");
    } else {
      setVal("clientEmail", state.clientEmail);
    }
    const clientPhoneEl = $("clientPhone");
    if (clientPhoneEl && document.activeElement === clientPhoneEl) {
      state.clientPhone = val("clientPhone");
    } else {
      setVal("clientPhone", state.clientPhone);
    }
    ["issueDate", "expirationDate", "committedDate"].forEach((id) => {
      const el = $(id);
      if (el && document.activeElement === el) {
        state[id] = normalizeDateInput(val(id));
      } else {
        setVal(id, state[id] || "");
      }
    });
    const locationEl = $("location");
    if (locationEl && document.activeElement === locationEl) {
      state.location = val("location");
    } else {
      setVal("location", state.location);
    }
    const bizNameOwnerEl = $("bizNameOwner");
    if (!bizNameOwnerEl || document.activeElement !== bizNameOwnerEl) {
      setVal("bizNameOwner", settings.bizName);
    }
    const quoteNotesEl = $("quoteNotes");
    if (quoteNotesEl && document.activeElement === quoteNotesEl) {
      state.quoteNotes = val("quoteNotes");
    } else {
      setVal("quoteNotes", state.quoteNotes);
    }
    count("projectName", "projectNameCount");
    count("clientName", "clientNameCount");
    count("clientEmail", "clientEmailCount");
    count("clientPhone", "clientPhoneCount");
    count("location", "locationCount");
    count("bizNameOwner", "bizNameOwnerCount");
    count("quoteNotes", "quoteNotesCount");

    const editingWorkerHours =
      document.activeElement &&
      typeof document.activeElement.matches === "function" &&
      document.activeElement.matches('input[data-key="hours"]') &&
      document.activeElement.closest("#workersBody");

    if (editingWorkerHours) {
      syncOwnerWorkersTableInputsToState(state, settings);
      metrics = calcOwner(state, settings);
    } else {
      renderWorkers(state, settings, metrics);
    }

    const ownerProject = getSelectedProject() || {
      projectName: state.projectName,
      clientName: state.clientName,
      dueDate: "",
      salePrice: metrics.recommended
    };
    const ownerReport = ownerProject?.id ? loadSupervisorReport(ownerProject) : buildDefaultSupervisorReport(null);

    const pricingModeCopy = settings.pricingMode === "day" ? "per dia laboral" : "por hora";
    const primaryCards = [
      ["Recommended", money(metrics.recommended, settings.currency), `${money(metrics.pricePerUnit, settings.currency)} ${pricingModeCopy}`],
      ["Minimum Floor", money(metrics.minimum, settings.currency), "No vender por debajo de esto"],
      ["Labor + Burden", money(metrics.labor + metrics.taxes, settings.currency), "Labor directa + employer burden"],
      ["Overhead", money(metrics.overhead, settings.currency), "Carga operativa del negocio"]
    ];
    const detailCards = [
      ["Direct Labor", money(metrics.labor, settings.currency), `${state.workers.length} workers modeled`],
      ["Employer Burden", money(metrics.taxes, settings.currency), `WC ${settings.wcPct}% | FICA ${settings.ficaPct}% | FUTA ${settings.futaPct}% | CASUI ${settings.casuiPct}%`],
      ["Target Profit", money(metrics.profit, settings.currency), `${Number(settings.profitPct || 0).toFixed(1)}% owner rule`],
      ["Reserve", money(metrics.reserve, settings.currency), `${DEFAULTS.reservePct}% fixed reserve`]
    ];

    $("ownerKpis").innerHTML = `
      <div class="owner-kpi-shell">
        <div class="owner-quote-hero">
          <div class="owner-quote-kicker">Precio recomendado</div>
          <div class="owner-quote-price">${escapeHtml(money(metrics.recommended, settings.currency))}</div>
          <div class="owner-quote-meta">${escapeHtml(money(metrics.pricePerUnit, settings.currency))} ${escapeHtml(pricingModeCopy)} · ${escapeHtml(metrics.quotedUnits.toFixed(2))} ${escapeHtml(metrics.pricingModeLabel === "dia" ? "dias" : "horas")} cotizables</div>
          <div class="owner-quote-strip">
            ${primaryCards.map(([title, big, small]) => `
              <div class="owner-mini-card">
                <div class="title">${escapeHtml(title)}</div>
                <div class="big">${escapeHtml(big)}</div>
                <div class="small">${escapeHtml(small)}</div>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="owner-detail-grid">
          ${detailCards.map(([label, value, meta]) => `
            <div class="kpi-box">
              <div class="label">${escapeHtml(label)}</div>
              <div class="value">${escapeHtml(value)}</div>
              <div class="meta">${escapeHtml(meta)}</div>
            </div>
          `).join("")}
        </div>
      </div>
    `;

    if ($("statusBadge")) {
      $("statusBadge").className = `badge ${metrics.recommended > 0 ? "green" : "amber"}`;
      $("statusBadge").textContent = metrics.recommended > 0 ? "Pricing live" : "Add labor data";
    }

    [["projectName", "projectNameCount"], ["clientName", "clientNameCount"], ["clientEmail", "clientEmailCount"], ["clientPhone", "clientPhoneCount"], ["location", "locationCount"], ["quoteNotes", "quoteNotesCount"], ["bizNameOwner", "bizNameOwnerCount"]].forEach(([id, counter]) => {
      const el = $(id);
      if (!el) return;
      el.oninput = () => {
        count(id, counter);
        if (id === "bizNameOwner") {
          const settingsCopy = loadSettings();
          settingsCopy.bizName = val("bizNameOwner") || DEFAULTS.bizName;
          saveSettings(settingsCopy);
          renderOwner();
        } else {
          state[id] = val(id);
          saveOwner(state, calcOwner(state, settings));
        }
      };
    });
    ["issueDate", "expirationDate", "committedDate"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.oninput = () => {
        state[id] = normalizeDateInput(val(id));
        saveOwner(state, calcOwner(state, settings));
      };
      el.onchange = el.oninput;
      el.onpointerdown = () => {
        if (typeof el.showPicker !== "function") return;
        try {
          el.showPicker();
        } catch (_err) {
          /* noop: unsupported or not user-activatable */
        }
      };
    });

    if ($("btnAddWorker")) $("btnAddWorker").onclick = () => {
      state.workers.push({ name: `Worker ${state.workers.length + 1}`, type: "installer", hours: 0, rate: "" });
      saveOwner(state, calcOwner(state, settings));
      renderOwner();
    };
    if ($("btnClearOwnerLabor")) {
      $("btnClearOwnerLabor").onclick = () => {
        const owner = loadOwner();
        owner.workers = [
          { name: "Pro 1", type: "pro", hours: 0, rate: "", cost: 0 },
          { name: "Assistant 1", type: "assistant", hours: 0, rate: "", cost: 0 }
        ];
        saveOwner(owner, calcOwner(owner, settings));
        renderOwner();
      };
    }
    if ($("btnClear")) $("btnClear").onclick = () => showOwnerNewQuoteModal();
    const ownerNewQuoteModal = $("ownerNewQuoteModal");
    if (ownerNewQuoteModal) {
      ownerNewQuoteModal.onclick = (e) => {
        if (e.target === ownerNewQuoteModal) hideOwnerNewQuoteModal();
      };
    }
    if ($("ownerConfirmNewQuote")) {
      $("ownerConfirmNewQuote").onclick = () => {
        resetOwnerQuoteStateForNewQuote();
        hideOwnerNewQuoteModal();
        renderOwner();
      };
    }
    if ($("ownerCancelNewQuote")) $("ownerCancelNewQuote").onclick = () => hideOwnerNewQuoteModal();
    if ($("btnExportPdf")) $("btnExportPdf").onclick = () => void exportOwnerPdf(state, settings, metrics);
    if ($("btnSendQuote")) $("btnSendQuote").onclick = () => openSendModal(state, settings, metrics);
    if ($("btnSendClose")) $("btnSendClose").onclick = closeSendModal;
    if ($("btnSendCancel")) $("btnSendCancel").onclick = closeSendModal;
    if ($("btnSendNow")) $("btnSendNow").onclick = () => sendQuote(state, settings, metrics);
    ["toEmail", "toName", "subject", "scope", "message", "salesInitials"].forEach((id) => { if ($(id)) $(id).oninput = updateSendCounts; });

    try {
      saveOwner(state, metrics);
    } catch (e) {
      console.warn("saveOwner failed, UI still usable", e);
    }

    const ownerInvoiceState = getProjectInvoiceState(ownerProject);

    if ($("ownerInvoiceProject")) {
      $("ownerInvoiceProject").textContent = ownerProject?.projectName || state.projectName || "Sin proyecto";
    }
    if ($("ownerInvoiceClient")) {
      $("ownerInvoiceClient").textContent = ownerProject?.clientName || state.clientName || "Sin cliente";
    }
    if ($("ownerInvoiceNo")) setVal("ownerInvoiceNo", ownerInvoiceState.invoiceNo || "");
    if ($("ownerInvoiceDate")) setVal("ownerInvoiceDate", ownerInvoiceState.invoiceDate || "");
    if ($("ownerInvoiceBase")) setNum("ownerInvoiceBase", ownerInvoiceState.baseAmount);
    if ($("ownerInvoiceDeposit")) setNum("ownerInvoiceDeposit", ownerInvoiceState.depositApplied);
    if ($("ownerInvoiceReceived")) setNum("ownerInvoiceReceived", ownerInvoiceState.receivedApplied);
    if ($("ownerInvoiceStatus")) setVal("ownerInvoiceStatus", ownerInvoiceState.status);

    const refreshOwnerInvoice = () => {
      const baseAmount = num("ownerInvoiceBase", ownerInvoiceState.baseAmount);
      const depositApplied = num("ownerInvoiceDeposit", 0);
      const receivedApplied = num("ownerInvoiceReceived", 0);
      const invoiceMetrics = calcInvoice(ownerProject, ownerReport, { baseAmount, depositApplied, receivedApplied });
      const nextInvoiceState = {
        invoiceNo: val("ownerInvoiceNo"),
        invoiceDate: val("ownerInvoiceDate"),
        baseAmount,
        depositApplied,
        receivedApplied,
        status: inferInvoiceStatus(invoiceMetrics.total, depositApplied, receivedApplied, val("ownerInvoiceStatus"))
      };

      if (ownerProject?.id) saveProjectInvoiceState(ownerProject.id, nextInvoiceState);
      if ($("ownerInvoiceStatus")) setVal("ownerInvoiceStatus", nextInvoiceState.status);

      if ($("ownerInvoiceSubtotal")) $("ownerInvoiceSubtotal").textContent = money(invoiceMetrics.subtotal, settings.currency);
      if ($("ownerInvoiceChangeOrders")) $("ownerInvoiceChangeOrders").textContent = money(invoiceMetrics.changeOrderAmount, settings.currency);
      if ($("ownerInvoiceTotal")) $("ownerInvoiceTotal").textContent = money(invoiceMetrics.total, settings.currency);
      if ($("ownerInvoiceBalance")) $("ownerInvoiceBalance").textContent = money(invoiceMetrics.balance, settings.currency);

      if ($("ownerInvoiceCoBody")) {
        $("ownerInvoiceCoBody").innerHTML = invoiceMetrics.changeOrders.length
          ? invoiceMetrics.changeOrders.map((row) => `
              <tr>
                <td>${escapeHtml(row.title || "Change order")}</td>
                <td>${escapeHtml(normalizeCommercialStatus(row.commercialStatus || (row.applied ? "approved" : "draft")))}</td>
                <td>${money(row.offeredPrice || 0, settings.currency)}</td>
              </tr>
            `).join("")
          : `<tr><td colspan="3">No approved change orders yet.</td></tr>`;
      }
    };

    ["ownerInvoiceNo", "ownerInvoiceDate", "ownerInvoiceBase", "ownerInvoiceDeposit", "ownerInvoiceReceived", "ownerInvoiceStatus"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.oninput = refreshOwnerInvoice;
      if (el.tagName === "SELECT") el.onchange = refreshOwnerInvoice;
    });

    if ($("btnOwnerInvoicePdf")) {
      $("btnOwnerInvoicePdf").onclick = () => {
        void exportInvoicePdf("owner", ownerProject, ownerReport, settings, {
          invoiceNo: val("ownerInvoiceNo"),
          invoiceDate: val("ownerInvoiceDate"),
          baseAmount: num("ownerInvoiceBase", ownerProject?.salePrice || metrics.recommended || 0),
          depositApplied: num("ownerInvoiceDeposit", 0),
          receivedApplied: num("ownerInvoiceReceived", 0)
        });
      };
    }

    refreshOwnerInvoice();
  }

  async function exportOwnerPdf(state, settings, metrics) {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) return alert("jsPDF is not available.");
    if ($("projectName")) {
      const next = val("projectName");
      if (next !== state.projectName) {
        state.projectName = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    if ($("clientName")) {
      const next = val("clientName");
      if (next !== state.clientName) {
        state.clientName = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    if ($("location")) {
      const next = val("location");
      if (next !== state.location) {
        state.location = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    if ($("clientEmail")) {
      const next = val("clientEmail");
      if (next !== state.clientEmail) {
        state.clientEmail = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    if ($("clientPhone")) {
      const next = val("clientPhone");
      if (next !== state.clientPhone) {
        state.clientPhone = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    ["issueDate", "expirationDate", "committedDate"].forEach((id) => {
      if (!$(id)) return;
      const next = normalizeDateInput(val(id));
      if (next !== state[id]) {
        state[id] = next;
        saveOwner(state, calcOwner(state, settings));
      }
    });
    if ($("quoteNotes")) {
      const next = val("quoteNotes");
      if (next !== state.quoteNotes) {
        state.quoteNotes = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    if ($("bizNameOwner")) {
      const s = loadSettings();
      const nextBiz = val("bizNameOwner") || DEFAULTS.bizName;
      if (nextBiz !== String(s.bizName ?? DEFAULTS.bizName)) {
        s.bizName = nextBiz;
        saveSettings(s);
      }
    }
    const settingsPdf = loadSettings();

    const doc = new jsPDF({ unit: "pt", format: "letter" });
    let y = await drawPdfTenantLetterhead(doc, settingsPdf, 48);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(12);
    doc.text("Project Pricing Report", 40, y);
    y += 24;
    [`Project: ${state.projectName || "-"}`, `Client: ${state.clientName || "-"}`, `Location: ${state.location || "-"}`, `Recommended: ${money(metrics.recommended, settingsPdf.currency)}`].forEach((line) => { doc.text(line, 40, y); y += 16; });
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.text("Financial Breakdown", 40, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    buildOwnerKpis(state, settingsPdf, metrics).forEach(([label, value]) => { doc.text(`${label}: ${value}`, 40, y); y += 15; });
    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `margin-guard-${(state.projectName || "project").replace(/\s+/g, "-")}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openSendModal(state, settings, metrics) {
  const modal = document.getElementById("sendModal");
  if (!modal) return;
  if (metrics?.marginBlocked) {
    window.alert("Price too low");
    return;
  }
  if ($("projectName")) {
    const next = val("projectName");
    if (next !== state.projectName) {
      state.projectName = next;
      saveOwner(state, calcOwner(state, settings));
    }
  }
  if ($("clientName")) {
    const next = val("clientName");
    if (next !== state.clientName) {
      state.clientName = next;
      saveOwner(state, calcOwner(state, settings));
    }
  }
  if ($("location")) {
    const next = val("location");
    if (next !== state.location) {
      state.location = next;
      saveOwner(state, calcOwner(state, settings));
    }
  }
  if ($("bizNameOwner")) {
    const s = loadSettings();
    const nextBiz = val("bizNameOwner") || DEFAULTS.bizName;
    if (nextBiz !== String(s.bizName ?? DEFAULTS.bizName)) {
      s.bizName = nextBiz;
      saveSettings(s);
    }
  }
  if ($("clientEmail")) {
    const next = val("clientEmail");
    if (next !== state.clientEmail) {
      state.clientEmail = next;
      saveOwner(state, calcOwner(state, settings));
    }
  }
  if ($("clientPhone")) {
    const next = val("clientPhone");
    if (next !== state.clientPhone) {
      state.clientPhone = next;
      saveOwner(state, calcOwner(state, settings));
    }
  }
  ["issueDate", "expirationDate", "committedDate"].forEach((id) => {
    if (!$(id)) return;
    const next = normalizeDateInput(val(id));
    if (next !== state[id]) {
      state[id] = next;
      saveOwner(state, calcOwner(state, settings));
    }
  });
  if ($("quoteNotes")) {
    const next = val("quoteNotes");
    if (next !== state.quoteNotes) {
      state.quoteNotes = next;
      saveOwner(state, calcOwner(state, settings));
    }
  }
  const estimateNumber = String(state.estimateNumber ?? "").trim();
  const issueDate = normalizeDateInput(nonEmptyString(state.issueDate) || todayInputValue());
  const expirationDate = normalizeDateInput(nonEmptyString(state.expirationDate) || addDaysToInputValue(issueDate, 7));
  state.estimateNumber = estimateNumber;
  state.issueDate = issueDate;
  state.expirationDate = expirationDate;
  const subject = estimateNumber
    ? `Estimate ${estimateNumber} - ${nonEmptyString(state.projectName, "Project")}`
    : `Estimate - ${nonEmptyString(state.projectName, "Project")}`;
  const scopeText = nonEmptyString(
    state.quoteNotes,
    state.messageToClient,
    state.notes,
    "Please review the estimate details below."
  );
  const defaultMessage = [
    `Hello ${nonEmptyString(state.clientName, "there")},`,
    "",
    "Thank you for the opportunity to work with you.",
    "",
    "Your project estimate is attached and ready for review.",
    "",
    "When you're ready to move forward, please review and approve your estimate using the link below:",
    "",
    "[PUBLIC_QUOTE_URL]",
    "",
    `Issued: ${issueDate}. Expires: ${expirationDate}.`,
    `Total estimate: ${formatMoney(metrics.offered || metrics.recommended || 0)}.`,
    "",
    "Please review the scope of work and let us know if you would like to move forward."
  ].join("\n");
  const toEmail = document.getElementById("toEmail");
  const toName = document.getElementById("toName");
  const subjectInput = document.getElementById("subject");
  const scopeInput = document.getElementById("scope");
  const messageInput = document.getElementById("message");
  const depositInput = document.getElementById("deposit");
  const sendStatus = document.getElementById("sendStatus");
  if (toEmail) toEmail.value = nonEmptyString(state.clientEmail, state.customerEmail);
  if (toName) toName.value = nonEmptyString(state.clientName);
  if (subjectInput) subjectInput.value = subject;
  if (scopeInput) scopeInput.value = scopeText;
  if (messageInput) messageInput.value = defaultMessage;
  if (depositInput && !depositInput.value) depositInput.value = "1000";
  if (sendStatus) {
    const fb = window.__MG_QUOTE_SEND_FEEDBACK__;
    if (fb && typeof fb.clear === "function") fb.clear(sendStatus);
    else {
      sendStatus.style.display = "none";
      sendStatus.innerHTML = "";
      sendStatus.className = sendStatus.getAttribute("data-mg-send-status-class") || "notice";
      sendStatus.textContent = "";
    }
  }
  modal.style.removeProperty("display");
  modal.setAttribute("aria-hidden", "false");
  updateSendCounts();
}

  function closeSendModal() {
    const modal = $("sendModal");
    if (modal) {
      modal.setAttribute("aria-hidden", "true");
      modal.style.removeProperty("display");
    }
    if ($("sendStatus")) {
      const el = $("sendStatus");
      const fb = window.__MG_QUOTE_SEND_FEEDBACK__;
      if (fb && typeof fb.clear === "function") fb.clear(el);
      else {
        el.style.display = "none";
        el.innerHTML = "";
        el.className = el.getAttribute("data-mg-send-status-class") || "notice";
        el.textContent = "";
      }
    }
  }

  function updateSendCounts() {
    count("toEmail", "toEmailCount");
    count("toName", "toNameCount");
    count("subject", "subjectCount");
    count("scope", "scopeCount");
    count("message", "messageCount");
    count("salesInitials", "salesInitialsCount");
  }

  function syncOwnerDraftToSalesStateForPublicSend(ownerState, settings, metrics) {
    const hoursPerDay = Math.max(Number(settings.hoursPerDay || DEFAULTS.hoursPerDay), 0.25);
    const salesWorkers = (Array.isArray(ownerState.workers) ? ownerState.workers : []).map((w) => {
      const hours = Number(w.hours || 0);
      const daysForSales = hours / hoursPerDay;
      return {
        name: String(w.name || "Worker"),
        type: w.type === "helper" ? "helper" : "installer",
        days: Number.isFinite(daysForSales) ? daysForSales : 0,
        rate: w.rate === "" || w.rate == null ? "" : Number(w.rate)
      };
    });
    const existing = loadSales();
    const issueDate = normalizeDateInput(nonEmptyString(ownerState.issueDate) || todayInputValue());
    const expirationDate = normalizeDateInput(nonEmptyString(ownerState.expirationDate) || addDaysToInputValue(issueDate, 7));
    const estimateNo = nonEmptyString(ownerState.estimateNumber) || buildEstimateNumber();
    const messageToClient = nonEmptyString(ownerState.messageToClient, ownerState.quoteNotes, existing.messageToClient);
    saveSales({
      ...existing,
      estimateNumber: estimateNo,
      issueDate,
      expirationDate,
      projectName: nonEmptyString(ownerState.projectName),
      clientName: nonEmptyString(ownerState.clientName),
      customerEmail: nonEmptyString(ownerState.clientEmail),
      customerPhone: nonEmptyString(ownerState.clientPhone),
      location: nonEmptyString(ownerState.location),
      messageToClient,
      workers: salesWorkers.length ? salesWorkers : existing.workers,
      depositRequired: parseNumber(document.getElementById("deposit")?.value) || 1000,
      price: "",
      _manualPriceTouched: false,
      offeredPrice: round2(metrics.recommended || 0)
    });
  }

  function persistOwnerAfterPublicSend(settings, sentQuote = null) {
    if (!$("ownerKpis")) return;
    const sales = loadSales();
    const toEmail = nonEmptyString(document.getElementById("toEmail")?.value);
    const toName = nonEmptyString(document.getElementById("toName")?.value);
    const ownerState = loadOwner();
    if (toEmail) ownerState.clientEmail = toEmail;
    if (toName) ownerState.clientName = toName;
    const backendNo = sentQuote && String(sentQuote.quote_number_display || "").trim();
    if (backendNo) ownerState.estimateNumber = backendNo;
    else if (nonEmptyString(sales.estimateNumber)) ownerState.estimateNumber = sales.estimateNumber;
    ownerState.issueDate = normalizeDateInput(nonEmptyString(sales.issueDate) || ownerState.issueDate);
    ownerState.expirationDate = normalizeDateInput(nonEmptyString(sales.expirationDate) || ownerState.expirationDate);
    ownerState.messageToClient = nonEmptyString(sales.messageToClient, ownerState.messageToClient);
    const pubUrl = sentQuote && String(sentQuote.publicQuoteUrl || "").trim();
    if (pubUrl) ownerState.publicQuoteUrl = pubUrl;
    else if (sales.publicQuoteUrl) ownerState.publicQuoteUrl = sales.publicQuoteUrl;
    const qid = sentQuote && sentQuote.quoteId;
    if (qid) ownerState.quoteId = qid;
    else if (sales.quoteId) ownerState.quoteId = sales.quoteId;
    const pTok = sentQuote && sentQuote.publicToken;
    if (pTok) ownerState.publicToken = pTok;
    else if (sales.publicToken) ownerState.publicToken = sales.publicToken;
    ownerState.estimateStatus = "sent";
    ownerState.sentAt = new Date().toISOString();
    saveOwner(ownerState, calcOwner(ownerState, settings));
  }

  function ownerEstimatePickFirstNonEmpty(...candidates) {
    for (let i = 0; i < candidates.length; i += 1) {
      const v = candidates[i];
      if (v !== undefined && v !== null && String(v).trim() !== "") {
        return String(v).trim();
      }
    }
    return "";
  }

  function ownerResolvePublishBusinessName(branding, settings) {
    const name = ownerEstimatePickFirstNonEmpty(
      branding.businessName,
      branding.business_name,
      settings.bizName
    );
    if (!name || /^business$/i.test(name) || name.includes("@")) {
      return ownerEstimatePickFirstNonEmpty(settings.bizName, "Business");
    }
    return name;
  }

  async function resolveOwnerPublishBranding(settings) {
    const cached = readStore(LS_BRANDING, {});
    let raw = {};
    if (window.MarginGuardTenant?.getTenantBranding) {
      try {
        const { response, data } = await window.MarginGuardTenant.getTenantBranding({ force: true });
        if (response?.ok && data?.ok && data.branding && typeof data.branding === "object") {
          raw = data.branding;
        }
      } catch (_e) {}
    }
    return {
      businessName: ownerEstimatePickFirstNonEmpty(
        raw.business_name,
        raw.businessName,
        cached.businessName,
        settings.bizName
      ),
      businessEmail: ownerEstimatePickFirstNonEmpty(
        raw.business_email,
        cached.businessEmail,
        settings.businessEmail,
        settings.email
      ),
      businessPhone: ownerEstimatePickFirstNonEmpty(
        raw.business_phone,
        cached.businessPhone,
        settings.businessPhone,
        settings.phone
      ),
      businessAddress: ownerEstimatePickFirstNonEmpty(
        raw.business_address,
        cached.businessAddress,
        settings.businessAddress,
        settings.address,
        settings.companyAddress
      ),
      businessServiceArea: ownerEstimatePickFirstNonEmpty(
        raw.business_service_area,
        raw.businessServiceArea,
        cached.businessServiceArea,
        settings.businessServiceArea
      ),
      logoUrl: ownerEstimatePickFirstNonEmpty(
        raw.logo_url,
        raw.logoUrl,
        cached.logoUrl,
        settings.publicLogoUrl
      ),
      marketLine: ownerEstimatePickFirstNonEmpty(
        raw.market_line,
        raw.marketLine,
        cached.marketLine,
        settings.marketLine
      ),
      accentHex: ownerEstimatePickFirstNonEmpty(
        raw.accent_hex,
        raw.accentHex,
        cached.accentHex,
        settings.publicAccentColor,
        "#8f8a5f"
      ),
      serviceLine: ownerEstimatePickFirstNonEmpty(
        raw.service_line,
        cached.serviceLine,
        "Professional Service Estimate"
      ),
      signatureLine: ownerEstimatePickFirstNonEmpty(
        raw.signature_line,
        cached.signatureLine,
        "Professional Estimate Delivery"
      )
    };
  }

  async function ownerRebuildEstimatePdfAfterPublish({
    H,
    branding,
    freshSettings,
    state,
    sm,
    toEmail,
    customerPhone,
    projectAddress,
    scope,
    messageWithLink,
    publicQuoteUrl,
    publishData,
    estimateTotal,
    depositRequired
  }) {
    if (!H || typeof H.buildEstimatePdfPayload !== "function" || typeof H.buildEstimateTenantPayload !== "function") {
      return null;
    }
    const savedRow = publishData.row && typeof publishData.row === "object" ? publishData.row : null;
    const estimateNumber = String(
      publishData.quote_number_display || (savedRow && savedRow.quote_number_display) || state.estimateNumber || ""
    ).trim();
    const issueDate = normalizeDateInput(nonEmptyString(state.issueDate) || todayInputValue());
    const expirationDate = normalizeDateInput(nonEmptyString(state.expirationDate) || addDaysToInputValue(issueDate, 7));
    const savedName = savedRow ? String(savedRow.business_name || savedRow.company_name || "").trim() : "";
    const savedEmail = savedRow ? String(savedRow.business_email || "").trim() : "";
    const savedPhone = savedRow ? String(savedRow.business_phone || "").trim() : "";
    const savedAddr = savedRow ? String(savedRow.business_address || "").trim() : "";
    const fin = publishData.financials && typeof publishData.financials === "object" ? publishData.financials : {};
    const fromRowT = savedRow != null ? Number(savedRow.total) : NaN;
    const fromRowD = savedRow != null ? Number(savedRow.deposit_required) : NaN;
    const fromRowBal = savedRow != null ? Number(savedRow.balance_after_deposit) : NaN;
    const fromFinT = Number(fin.total);
    const fromFinD = Number(fin.deposit_required);
    let rowTotal = Number.isFinite(fromRowT) && fromRowT > 0 ? fromRowT : NaN;
    let rowDeposit = Number.isFinite(fromRowD) && fromRowD > 0 ? fromRowD : NaN;
    if (!Number.isFinite(rowTotal) || rowTotal <= 0) {
      rowTotal = Number.isFinite(fromFinT) && fromFinT > 0 ? fromFinT : Number(sm.offered ?? sm.recommended ?? estimateTotal) || 0;
    }
    if (!Number.isFinite(rowDeposit) || rowDeposit <= 0) {
      rowDeposit = Number.isFinite(fromFinD) && fromFinD > 0 ? fromFinD : Number(depositRequired) || 0;
    }
    const fallbackUsed = !(
      Number.isFinite(fromRowT) &&
      fromRowT > 0 &&
      Number.isFinite(fromRowD) &&
      fromRowD > 0
    );
    console.info("[MG Owner PDF Financials]", {
      quote_id: publishData.quote_id,
      public_token: publishData.public_token,
      rowTotal,
      rowDeposit,
      row_balance_after_deposit: Number.isFinite(fromRowBal) ? fromRowBal : null,
      fin_balance_after_deposit: Number.isFinite(Number(fin.balance_after_deposit))
        ? Number(fin.balance_after_deposit)
        : null,
      fallbackUsed
    });

    const savedTenantOverlay = {};
    if (savedName) {
      savedTenantOverlay.businessName = savedName;
      savedTenantOverlay.business_name = savedName;
    }
    if (savedPhone) {
      savedTenantOverlay.businessPhone = savedPhone;
      savedTenantOverlay.business_phone = savedPhone;
    }
    if (savedEmail) {
      savedTenantOverlay.businessEmail = savedEmail;
      savedTenantOverlay.business_email = savedEmail;
    }
    if (savedAddr) {
      savedTenantOverlay.businessAddress = savedAddr;
      savedTenantOverlay.business_address = savedAddr;
    }

    const tenantPdf = H.buildEstimateTenantPayload(branding, freshSettings, {});
    const ownerForPdf = loadOwner();
    const projectNotes = nonEmptyString(ownerForPdf.quoteNotes);
    const basePayload = {
      ...tenantPdf,
      branding,
      settings: freshSettings,
      logoUrl: ownerEstimatePickFirstNonEmpty(branding.logoUrl, freshSettings.publicLogoUrl),
      marketLine: branding.marketLine || freshSettings.marketLine || "",
      estimateNumber,
      projectName: nonEmptyString(state.projectName),
      clientName: nonEmptyString(state.clientName),
      customerEmail: nonEmptyString(state.customerEmail),
      customerPhone: nonEmptyString(state.customerPhone),
      clientEmail: nonEmptyString(state.customerEmail),
      clientPhone: nonEmptyString(state.customerPhone),
      location: nonEmptyString(state.location),
      issueDate,
      expirationDate,
      totalFormatted: H.formatUsd(rowTotal),
      totalAmount: rowTotal,
      depositFormatted: H.formatUsd(rowDeposit),
      depositRequired: rowDeposit,
      projectNotes,
      quoteNotes: projectNotes,
      scopeSummary: nonEmptyString(projectNotes, scope, state.messageToClient, "-"),
      messageText: messageWithLink,
      publicQuoteUrl
    };

    const tenantForRebuild = H.buildEstimateTenantPayload({ ...branding, ...savedTenantOverlay }, freshSettings, basePayload);
    const pdfPayloadWithLink = {
      ...basePayload,
      ...tenantForRebuild,
      branding,
      settings: freshSettings,
      customerEmail: toEmail || state.customerEmail || "",
      customerPhone,
      clientEmail: toEmail || state.customerEmail || "",
      clientPhone: customerPhone,
      location: projectAddress,
      marketLine: branding.marketLine || basePayload.marketLine || "",
      messageText: messageWithLink,
      publicQuoteUrl,
      totalAmount: rowTotal,
      totalFormatted: H.formatUsd(rowTotal),
      depositRequired: rowDeposit,
      depositFormatted: H.formatUsd(rowDeposit)
    };

    const rebuilt = await H.buildEstimatePdfPayload(pdfPayloadWithLink);
    const b64 = rebuilt && typeof rebuilt.contentBase64 === "string" ? rebuilt.contentBase64 : "";
    if (!rebuilt || !b64) {
      return null;
    }
    return rebuilt;
  }

  function syncOwnerSendModalIntoSalesDraft() {
    const s = loadSales();
    const te = document.getElementById("toEmail")?.value?.trim();
    const tn = document.getElementById("toName")?.value?.trim();
    const sc = document.getElementById("scope")?.value?.trim();
    const dep = parseNumber(document.getElementById("deposit")?.value);
    if (te) s.customerEmail = te;
    if (tn) s.clientName = tn;
    if (sc) s.messageToClient = sc;
    if (dep) s.depositRequired = dep;
    saveSales(s);
  }

  async function runOwnerSellerPublicSend() {
    const freshSettings = loadSettings();
    const ownerState = loadOwner();
    ownerState.reservePct = DEFAULTS.reservePct;
    const metrics = calcOwner(ownerState, freshSettings);
    syncOwnerDraftToSalesStateForPublicSend(ownerState, freshSettings, metrics);
    syncOwnerSendModalIntoSalesDraft();

    const sendStatus = document.getElementById("sendStatus");
    const sendButton = document.getElementById("btnSendNow");

    let state = loadSales();

    const toEmail = String(document.getElementById("toEmail")?.value ?? "").trim();
    const toName = nonEmptyString(document.getElementById("toName")?.value, state.clientName);
    const salesRepInitials = nonEmptyString(document.getElementById("salesInitials")?.value).toUpperCase();
    const subject = nonEmptyString(document.getElementById("subject")?.value);
    const scope = nonEmptyString(
      ownerState.quoteNotes,
      document.getElementById("scope")?.value,
      state.messageToClient
    );
    const messageFromModal = nonEmptyString(document.getElementById("message")?.value);
    const customerPhone = nonEmptyString(
      document.getElementById("clientPhone")?.value,
      ownerState.clientPhone,
      state.customerPhone
    );
    const projectAddress = nonEmptyString(
      document.getElementById("location")?.value,
      ownerState.location,
      state.location
    );

    if (!salesRepInitials) {
      if (sendStatus) {
        sendStatus.style.display = "block";
        sendStatus.className = "notice error";
        sendStatus.textContent = "Agrega email del cliente e iniciales del vendedor antes de enviar.";
      }
      return;
    }
    if (!isClientEmailValidForQuoteSend(toEmail)) {
      if (sendStatus) {
        sendStatus.style.display = "block";
        sendStatus.className = "notice error";
        sendStatus.textContent = "Client email is required before sending the quote.";
      }
      return;
    }

    const fallbackMessage = [
      `Hello ${nonEmptyString(toName, "there")},`,
      "",
      "Please review and approve your estimate using the link below:",
      "",
      "[PUBLIC_QUOTE_URL]",
      ""
    ].join("\n");
    const message = messageFromModal || fallbackMessage;

    let successCloseScheduled = false;
    try {
      if (sendButton) {
        sendButton.disabled = true;
        sendButton.textContent = "Enviando...";
      }
      if (sendStatus) {
        const fb0 = window.__MG_QUOTE_SEND_FEEDBACK__;
        if (fb0 && typeof fb0.stripToPlainNotice === "function") fb0.stripToPlainNotice(sendStatus);
        else {
          sendStatus.innerHTML = "";
          sendStatus.className = sendStatus.getAttribute("data-mg-send-status-class") || "notice";
        }
        sendStatus.style.display = "block";
        sendStatus.textContent = "Creando enlace público...";
      }

      const branding = await resolveOwnerPublishBranding(freshSettings);
      const bn = ownerResolvePublishBusinessName(branding, freshSettings);
      syncOwnerSendModalIntoSalesDraft();
      state = loadSales();
      const smPublish = calculateSalesMetrics(state, freshSettings);
      const estimateTotal = Number(smPublish.offered || smPublish.recommended || 0);
      const depositRequired = Number(
        parseNumber(document.getElementById("deposit")?.value) || state.depositRequired || 1000
      );

      const publishResponse = await fetch("/.netlify/functions/publish-public-quote", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_name: state.projectName || "",
          title: state.projectName || "",
          client_name: toName || state.clientName || "",
          client_email: toEmail || state.customerEmail || "",
          client_phone: customerPhone,
          customer_phone: customerPhone,
          phone: customerPhone,
          project_address: projectAddress,
          customer_address: projectAddress,
          job_site: projectAddress,
          address: projectAddress,
          workers: Array.isArray(state.workers) ? state.workers : [],
          price: state.price,
          pricing_stage: state.pricingStage,
          _sliderTouched: Boolean(state._sliderTouched),
          _manualPriceTouched: Boolean(state._sliderTouched),
          offeredPrice: state.offeredPrice,
          total: estimateTotal,
          recommended_total: estimateTotal,
          deposit_required: depositRequired,
          notes: message,
          public_message: scope || "",
          currency: "USD",
          status: "READY_TO_SEND",
          business_name: bn,
          company_name: bn,
          business_email: branding.businessEmail || freshSettings.businessEmail || freshSettings.email || "",
          business_phone: branding.businessPhone || freshSettings.businessPhone || freshSettings.phone || "",
          business_address:
            branding.businessAddress || freshSettings.businessAddress || freshSettings.address || freshSettings.companyAddress || ""
        })
      });

      const publishRaw = await publishResponse.text();
      let publishData = {};
      try {
        publishData = publishRaw ? JSON.parse(publishRaw) : {};
      } catch (_e) {}

      if (!publishResponse.ok || !publishData?.quote_id || !publishData?.public_token || !publishData?.public_url) {
        throw new Error(publishData.error || publishRaw || "Unable to create public quote link.");
      }

      const finPub = publishData.financials && typeof publishData.financials === "object" ? publishData.financials : {};
      const rowPub = publishData.row && typeof publishData.row === "object" ? publishData.row : {};
      const persistedOwnerT = Number(finPub.total != null ? finPub.total : rowPub.total);
      if (
        Number.isFinite(persistedOwnerT) &&
        persistedOwnerT > 0 &&
        Math.abs(persistedOwnerT - estimateTotal) > 0.009
      ) {
        console.error("[MG Publish vs session TOTAL MISMATCH — aborting owner PDF/email]", {
          estimateTotal,
          persistedOwnerT
        });
        if (sendStatus) {
          sendStatus.style.display = "block";
          sendStatus.className = "notice error";
          sendStatus.textContent =
            "Published total does not match this estimate. Refresh the page and try again.";
        }
        throw new Error("Published total does not match the send modal.");
      }
      const persistedOwnerD = Number(
        finPub.deposit_required != null ? finPub.deposit_required : rowPub.deposit_required
      );
      if (
        Number.isFinite(persistedOwnerD) &&
        Number.isFinite(depositRequired) &&
        Math.abs(persistedOwnerD - depositRequired) > 0.009
      ) {
        console.warn("[MG Publish vs session] owner deposit differs from modal (row is source of truth)", {
          depositRequired,
          persistedOwnerD
        });
      }

      const publicQuoteUrl = publishData.public_url;
      const messageWithLink = (message || "").replace(/\[PUBLIC_QUOTE_URL\]/g, publicQuoteUrl);

      if (sendStatus) {
        const fbPdf = window.__MG_QUOTE_SEND_FEEDBACK__;
        if (fbPdf && typeof fbPdf.stripToPlainNotice === "function") fbPdf.stripToPlainNotice(sendStatus);
        else {
          sendStatus.innerHTML = "";
          sendStatus.className = sendStatus.getAttribute("data-mg-send-status-class") || "notice";
        }
        sendStatus.style.display = "block";
        sendStatus.textContent = "Generando PDF...";
      }

      const H = window.__MG_ESTIMATE_SEND_HELPERS__;
      const jspdfOk = Boolean(typeof window !== "undefined" && window.jspdf?.jsPDF);
      if (!H || typeof H.buildEstimatePdfPayload !== "function" || typeof H.buildEstimateTenantPayload !== "function") {
        throw new Error(
          "PDF: no cargaron los helpers (window.__MG_ESTIMATE_SEND_HELPERS__). Confirma que /js/estimate-send-helpers.js exista en el deploy y se cargue antes de app.js."
        );
      }
      if (!jspdfOk) {
        throw new Error(
          "PDF: jsPDF no está disponible (window.jspdf.jsPDF). El script de jsPDF debe ir antes de estimate-send-helpers.js en owner.html."
        );
      }

      let rebuiltPdf;
      try {
        rebuiltPdf = await ownerRebuildEstimatePdfAfterPublish({
          H,
          branding,
          freshSettings,
          state,
          sm: smPublish,
          toEmail,
          customerPhone,
          projectAddress,
          scope,
          messageWithLink,
          publicQuoteUrl,
          publishData,
          estimateTotal,
          depositRequired
        });
      } catch (pdfErr) {
        throw pdfErr instanceof Error ? pdfErr : new Error(String(pdfErr));
      }

      const pdfB64 = rebuiltPdf?.contentBase64 ? String(rebuiltPdf.contentBase64).trim() : "";
      if (!pdfB64) {
        throw new Error(
          "PDF: buildEstimatePdfPayload no devolvió contentBase64. Revisa consola por errores de jsPDF y que el payload de Owner tenga datos mínimos."
        );
      }

      const quoteNumberDisplay = String(
        publishData.quote_number_display || rowPub.quote_number_display || ""
      ).trim();

      const pdfFileNameFinal = nonEmptyString(
        rebuiltPdf?.fileName,
        `Estimate-${nonEmptyString(quoteNumberDisplay, "Quote")}.pdf`
      );

      const zapPdfTotal = Number(rowPub?.total ?? finPub.total ?? estimateTotal);
      const zapPdfDep = Number(rowPub?.deposit_required ?? finPub.deposit_required ?? depositRequired);

      const clientName = toName || state.clientName || "";
      const zapierPayload = {
        toName: clientName,
        toEmail,
        client_email: toEmail,
        projectName: state.projectName || "",
        subject:
          subject ||
          (quoteNumberDisplay ? `Estimate ${quoteNumberDisplay}` : "Estimate"),
        publicToken: publishData.public_token,
        publicQuoteUrl,
        public_quote_url: publicQuoteUrl,
        salesRepInitials,
        messageLanguage: "bilingual",
        messageText: messageWithLink,
        scopeOfWork: scope,
        depositRequired: round2(zapPdfDep),
        clientName,
        location: projectAddress,
        businessName: bn,
        businessPhone: branding.businessPhone || freshSettings.phone || "",
        businessEmail: branding.businessEmail || freshSettings.email || "",
        businessAddress: branding.businessAddress || freshSettings.address || freshSettings.companyAddress || "",
        quoteId: publishData.quote_id,
        estimateNumber: quoteNumberDisplay,
        issueDate: state.issueDate || "",
        expirationDate: state.expirationDate || "",
        customerPhone,
        recommendedTotal: round2(zapPdfTotal),
        currency: "USD",
        additional_recipients: String(state.additional_recipients || ""),
        pdfBase64: pdfB64,
        pdfFileName: pdfFileNameFinal,
        pdfMimeType: rebuiltPdf?.mimeType || "application/pdf"
      };

      console.info("[MG Quote Email Recipients]", {
        client_email: zapierPayload.toEmail,
        additional_recipients: String(zapierPayload.additional_recipients || "")
      });

      const zapRes = await fetch("/.netlify/functions/send-quote-zapier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(zapierPayload)
      });
      const zapRaw = await zapRes.text();
      let zapData = {};
      try {
        zapData = zapRaw ? JSON.parse(zapRaw) : {};
      } catch (_e) {}
      if (!zapRes.ok) {
        console.error("[MG Quote Send] send-quote-zapier HTTP error", zapRes.status, zapRaw, zapData);
        throw new Error("Unable to complete send. Please try again.");
      }

      const hadPdfPayload = Boolean(String(zapierPayload.pdfBase64 || "").trim());
      if (zapData.pdfUploadError || (hadPdfPayload && !zapData.pdfUrl)) {
        console.error("[MG Quote Send] PDF storage or attach issue", {
          pdfUploadError: zapData.pdfUploadError,
          pdfUrl: zapData.pdfUrl,
          hadPdfPayload
        });
      }

      let closeDelayMs = 1800;
      let zapierOutcome = null;
      try {
        if (sendStatus && window.__MG_QUOTE_SEND_FEEDBACK__ && typeof window.__MG_QUOTE_SEND_FEEDBACK__.renderQuoteZapierOutcome === "function") {
          zapierOutcome = window.__MG_QUOTE_SEND_FEEDBACK__.renderQuoteZapierOutcome(sendStatus, {
            publishData,
            zapData,
            hadPdfPayload,
            publicQuoteUrl: publishData.public_url,
            renderSuccessMode: "toast",
            successToastTitle: "Quote sent successfully",
            successToastMessage: "Client received the proposal with the approval and deposit link."
          });
          if (zapierOutcome && zapierOutcome.variant === "warning") {
            closeDelayMs = 2600;
          }
        } else if (sendStatus) {
          sendStatus.innerHTML = "";
          sendStatus.className = sendStatus.getAttribute("data-mg-send-status-class") || "notice";
          sendStatus.style.display = "none";
          const fbToast = window.__MG_QUOTE_SEND_FEEDBACK__;
          if (fbToast && typeof fbToast.showQuoteSendToast === "function") {
            fbToast.showQuoteSendToast({
              title: "Quote sent successfully",
              message: "Client received the proposal with the approval and deposit link.",
              publicUrl: publishData.public_url,
              dismissMs: 4500
            });
          }
        }
      } catch (mgOwnerOutcomeErr) {
        console.error("[MG Owner Send] renderQuoteZapierOutcome failed", mgOwnerOutcomeErr);
      }

      const fbAfter = window.__MG_QUOTE_SEND_FEEDBACK__;
      if (sendStatus && fbAfter && typeof fbAfter.clear === "function") {
        if (!zapierOutcome || zapierOutcome.variant !== "warning") {
          fbAfter.clear(sendStatus);
        }
      }

      successCloseScheduled = true;
      setTimeout(function mgOwnerSendCloseAfterSuccess() {
        closeSendModal();
        try {
          persistOwnerAfterPublicSend(freshSettings, {
            quote_number_display: quoteNumberDisplay,
            publicQuoteUrl,
            quoteId: publishData.quote_id,
            publicToken: publishData.public_token
          });
        } catch (mgOwnerPersistErr) {
          console.error("[MG Owner Send] persist after send failed", mgOwnerPersistErr);
        }
        try {
          resetOwnerDraftToNewQuote();
          resetSalesDraftToNewQuote();
          const owner = loadOwner();
          owner.workers = [
            { name: "Pro 1", type: "pro", hours: 0, rate: "", cost: 0 },
            { name: "Assistant 1", type: "assistant", hours: 0, rate: "", cost: 0 }
          ];
          saveOwner(owner, calcOwner(owner, freshSettings));
          const active = document.activeElement;
          if (active && active.closest && active.closest("#workersBody")) active.blur();
          renderOwner();
          try {
            renderSales();
          } catch (_e) {}
        } catch (mgOwnerPostSendErr) {
          console.error("[MG Owner Send] post-close draft reset failed", mgOwnerPostSendErr);
        }
        const sb = document.getElementById("btnSendNow");
        if (sb) {
          sb.disabled = false;
          sb.textContent = "Enviar";
        }
      }, closeDelayMs);
    } catch (err) {
      console.error("[MG Quote Send] owner public send failed", err);
      if (sendStatus) {
        const fbErr = window.__MG_QUOTE_SEND_FEEDBACK__;
        if (fbErr && typeof fbErr.renderSendError === "function" && typeof fbErr.friendlySendFailureMessage === "function") {
          fbErr.renderSendError(sendStatus, fbErr.friendlySendFailureMessage(err));
        } else {
          sendStatus.style.display = "block";
          sendStatus.className = "notice error";
          sendStatus.textContent = "Something went wrong. Please try again.";
        }
      }
    } finally {
      if (!successCloseScheduled) {
        if (sendButton) {
          sendButton.disabled = false;
          sendButton.textContent = "Enviar";
        }
      }
    }
  }

  async function sendQuote(state, settings, metrics, options = {}) {
  if ($("ownerKpis")) {
    await runOwnerSellerPublicSend();
    return;
  }
  if (metrics?.marginBlocked) {
    window.alert("Price too low");
    const sendStatusBlock = document.getElementById("sendStatus");
    if (sendStatusBlock) {
      sendStatusBlock.style.display = "block";
      sendStatusBlock.className = "notice error";
      sendStatusBlock.textContent = "Price too low";
    }
    return;
  }
  const skipPersistSales = Boolean(options.skipPersistSales);
  const sendStatus = document.getElementById("sendStatus");
  if (!skipPersistSales) {
    if ($("projectName")) {
      const next = val("projectName");
      if (next !== state.projectName) {
        state.projectName = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    if ($("clientName")) {
      const next = val("clientName");
      if (next !== state.clientName) {
        state.clientName = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    if ($("location")) {
      const next = val("location");
      if (next !== state.location) {
        state.location = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    if ($("bizNameOwner")) {
      const s = loadSettings();
      const nextBiz = val("bizNameOwner") || DEFAULTS.bizName;
      if (nextBiz !== String(s.bizName ?? DEFAULTS.bizName)) {
        s.bizName = nextBiz;
        saveSettings(s);
      }
    }
    if ($("clientEmail")) {
      const next = val("clientEmail");
      if (next !== state.clientEmail) {
        state.clientEmail = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    if ($("clientPhone")) {
      const next = val("clientPhone");
      if (next !== state.clientPhone) {
        state.clientPhone = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
    ["issueDate", "expirationDate", "committedDate"].forEach((id) => {
      if (!$(id)) return;
      const next = normalizeDateInput(val(id));
      if (next !== state[id]) {
        state[id] = next;
        saveOwner(state, calcOwner(state, settings));
      }
    });
    if ($("quoteNotes")) {
      const next = val("quoteNotes");
      if (next !== state.quoteNotes) {
        state.quoteNotes = next;
        saveOwner(state, calcOwner(state, settings));
      }
    }
  }
  const settingsSend = loadSettings();
  const toEmail = String(document.getElementById("toEmail")?.value ?? "").trim();
  const toName = nonEmptyString(document.getElementById("toName")?.value, state.clientName);
  const subject = nonEmptyString(document.getElementById("subject")?.value);
  const scopeOfWork = nonEmptyString(document.getElementById("scope")?.value, state.messageToClient, state.notes);
  const messageText = nonEmptyString(document.getElementById("message")?.value);
  const depositRequired = parseNumber(document.getElementById("deposit")?.value);
  const salesRepInitials = nonEmptyString(document.getElementById("salesInitials")?.value).toUpperCase();
  if (!salesRepInitials) {
    if (sendStatus) {
      sendStatus.style.display = "block";
      sendStatus.className = "notice error";
      sendStatus.textContent = "Add customer email and sales rep initials before sending the estimate.";
    }
    return;
  }
  if (!isClientEmailValidForQuoteSend(toEmail)) {
    if (sendStatus) {
      sendStatus.style.display = "block";
      sendStatus.className = "notice error";
      sendStatus.textContent = "Client email is required before sending the quote.";
    }
    return;
  }
  const estimateNumber = nonEmptyString(state.estimateNumber, buildEstimateNumber());
  const issueDate = normalizeDateInput(nonEmptyString(state.issueDate) || todayInputValue());
  const expirationDate = normalizeDateInput(nonEmptyString(state.expirationDate) || addDaysToInputValue(issueDate, 7));
  try {
    if (sendStatus) {
      const fbS = window.__MG_QUOTE_SEND_FEEDBACK__;
      if (fbS && typeof fbS.stripToPlainNotice === "function") fbS.stripToPlainNotice(sendStatus);
      else {
        sendStatus.innerHTML = "";
        sendStatus.className = sendStatus.getAttribute("data-mg-send-status-class") || "notice";
      }
      sendStatus.style.display = "block";
      sendStatus.textContent = "Sending estimate...";
    }
    const additionalRecipientsLegacy = String(state.additional_recipients || "");
    console.info("[MG Quote Email Recipients]", {
      client_email: toEmail,
      additional_recipients: additionalRecipientsLegacy
    });
    const response = await fetch("/.netlify/functions/send-quote-zapier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        salesRepInitials,
        messageLanguage: "bilingual",
        toEmail,
        client_email: toEmail,
        toName,
        subject,
        messageText,
        scopeOfWork,
        depositRequired: round2(depositRequired),
        projectName: nonEmptyString(state.projectName),
        clientName: nonEmptyString(state.clientName),
        location: nonEmptyString(state.location),
        businessName: nonEmptyString(settingsSend.bizName),
        currency: "USD",
        recommendedTotal: round2(metrics.offered || metrics.recommended || 0),
        estimateNumber,
        issueDate,
        expirationDate,
        additional_recipients: additionalRecipientsLegacy
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("[MG Quote Send] legacy send-quote-zapier failed", response.status, data);
      throw new Error(data.error || "Unable to send estimate.");
    }
    if (!skipPersistSales) {
      state.customerEmail = toEmail;
      state.clientName = toName;
      state.estimateNumber = estimateNumber;
      state.issueDate = issueDate;
      state.expirationDate = expirationDate;
      state.messageToClient = scopeOfWork;
      state.estimateStatus = "sent";
      state.sentAt = new Date().toISOString();
      saveSales(state);
    }
    if (sendStatus && window.__MG_QUOTE_SEND_FEEDBACK__ && typeof window.__MG_QUOTE_SEND_FEEDBACK__.renderQuoteZapierOutcome === "function") {
      window.__MG_QUOTE_SEND_FEEDBACK__.renderQuoteZapierOutcome(sendStatus, {
        publishData: {},
        zapData: data,
        hadPdfPayload: false,
        publicQuoteUrl: data.public_quote_url || ""
      });
    } else if (sendStatus) {
      sendStatus.innerHTML = "";
      sendStatus.className = sendStatus.getAttribute("data-mg-send-status-class") || "notice";
      sendStatus.style.display = "block";
      sendStatus.textContent = "Quote sent successfully.";
    }
    setTimeout(closeSendModal, 800);
    renderSales();
  } catch (error) {
    console.error("[MG Quote Send] legacy send failed", error);
    if (sendStatus && window.__MG_QUOTE_SEND_FEEDBACK__ && typeof window.__MG_QUOTE_SEND_FEEDBACK__.renderSendError === "function") {
      window.__MG_QUOTE_SEND_FEEDBACK__.renderSendError(
        sendStatus,
        window.__MG_QUOTE_SEND_FEEDBACK__.friendlySendFailureMessage(error)
      );
    } else if (sendStatus) {
      sendStatus.style.display = "block";
      sendStatus.className = "notice error";
      sendStatus.textContent = "Something went wrong. Please try again.";
    }
  }
}

  /**
   * real_margin_pct = ((price - internalCost) / price) * 100
   * internalCost = loaded cost before target profit: beforeProfit + reserve (same basis as recommended build).
   */
  function computeSalesMarginDecisionFromEconomics(offeredPrice, beforeProfit, reserve, settings) {
    const targetPct = finiteNumber(settings?.profitPct, DEFAULTS.profitPct);
    const minPct = finiteNumber(
      settings?.minimumMarginPct != null ? settings.minimumMarginPct : DEFAULTS.minimumMarginPct,
      DEFAULTS.minimumMarginPct
    );
    const price = finiteNumber(offeredPrice, 0);
    const bp = finiteNumber(beforeProfit, 0);
    const res = finiteNumber(reserve, 0);
    const internalCost = bp + res;
    if (!(price > 0) || !Number.isFinite(internalCost)) {
      return {
        realMarginPct: null,
        decision: "blocked",
        level: "red",
        profitPct: targetPct,
        minimumMarginPct: minPct,
        internalCost,
        message: "❌ Not allowed — price too low",
      };
    }
    const realMarginPct = ((price - internalCost) / price) * 100;
    let decision = "approved";
    let level = "green";
    let message = "✔ Approved automatically";
    if (realMarginPct >= targetPct) {
      decision = "approved";
      level = "green";
      message = "✔ Approved automatically";
    } else if (realMarginPct >= minPct) {
      decision = "review";
      level = "yellow";
      message = "⚠ Below target margin — proceed responsibly";
    } else {
      decision = "blocked";
      level = "red";
      message = "❌ Not allowed — price too low";
    }
    return {
      realMarginPct,
      decision,
      level,
      profitPct: targetPct,
      minimumMarginPct: minPct,
      internalCost,
      message,
    };
  }

  function workerRateFromSettings(worker, settings) {
    return worker.type === "helper"
      ? Number(settings.baseHelper || 0)
      : Number(settings.baseInstaller || 0);
  }

  function resolveSalesOfferedFromState(state, base) {
    const recommended = finiteNumber(base.recommended, 0);
    const minimum = finiteNumber(base.minimum, 0);
    const negotiation = finiteNumber(base.negotiation, 0);
    const sliderTouched = Boolean(state?._sliderTouched || state?._manualPriceTouched);
    if (!sliderTouched) return recommended;
    const stageRaw = state?.pricingStage;
    const stage =
      stageRaw === undefined || stageRaw === null || stageRaw === ""
        ? 2
        : Number(stageRaw);
    if (stage <= 0) return minimum;
    if (stage === 1) return negotiation;
    return recommended;
  }

  function salesPricingRuleCopy(state, metrics, isReady) {
    if (!isReady) return "Completa la mano de obra para calcular el precio.";
    if (metrics.marginBlocked && Boolean(state?._sliderTouched)) {
      return "Precio por debajo del minimo permitido.";
    }
    if (metrics.needsApproval && Boolean(state?._sliderTouched)) {
      return "Margen bajo el objetivo: no hay bloqueo, solo responsabilidad comercial.";
    }
    if (Boolean(state?._sliderTouched)) {
      return "Precio dentro del rango permitido del negocio.";
    }
    return "Precio listo segun las reglas del negocio.";
  }

  function calcSales(state, settings) {
    const hoursPerDay = Math.max(Number(settings.hoursPerDay || DEFAULTS.hoursPerDay), 0.25);
    const taxPct = (
      Number(settings.wcPct || 0) +
      Number(settings.ficaPct || 0) +
      Number(settings.futaPct || 0) +
      Number(settings.casuiPct || 0)
    ) / 100;
    const overheadPerHour = Number(settings.stdHours || 0) > 0
      ? Number(settings.overheadMonthly || 0) / Number(settings.stdHours || 0)
      : 0;

    const laborByWorker = (Array.isArray(state.workers) ? state.workers : []).map((worker) => {
      const days = Math.max(0, Number(worker.days || 0));
      const rate = workerRateFromSettings(worker, settings);
      const hours = days * hoursPerDay;
      const cost = hours * rate;
      return { days, rate, hours, cost };
    });

    const labor = laborByWorker.reduce((sum, row) => sum + row.cost, 0);
    const totalHours = laborByWorker.reduce((sum, row) => sum + row.hours, 0);
    const totalWorkerDays = laborByWorker.reduce((sum, row) => sum + row.days, 0);
    const taxes = labor * taxPct;
    const overhead = totalHours * overheadPerHour;
    const beforeProfit = labor + taxes + overhead;
    const reserve = beforeProfit * (DEFAULTS.reservePct / 100);
    const recommendedProfit = beforeProfit * (Number(settings.profitPct || 0) / 100);
    const minimumProfit = beforeProfit * 0.15;
    const recommended = beforeProfit + recommendedProfit + reserve;
    const minimum = beforeProfit + minimumProfit + reserve;
    const negotiation = recommended > minimum ? minimum + ((recommended - minimum) * 0.5) : minimum;

    return {
      hoursPerDay,
      laborByWorker,
      labor,
      totalHours,
      totalWorkerDays,
      taxes,
      overhead,
      beforeProfit,
      reserve,
      recommendedProfit,
      minimumProfit,
      recommended,
      minimum,
      negotiation
    };
  }

  function calculateSalesMetrics(state, settings) {
    const base = calcSales(state, settings);
    const workers = Array.isArray(state?.workers) ? state.workers : [];
    const workersCount = workers.length;
    const workerDays = finiteNumber(base.totalWorkerDays, 0);
    const workerHours = finiteNumber(base.totalHours, 0);
    const recommended = finiteNumber(base.recommended, 0);
    const minimum = finiteNumber(base.minimum, 0);
    const negotiation = finiteNumber(base.negotiation, 0);
    const offered = resolveSalesOfferedFromState(state, base);
    const commissionRate = finiteNumber(settings?.salesCommissionPct, DEFAULTS.salesCommissionPct);
    const commissionDisplay = round2(Math.max(offered, 0) * (commissionRate / 100));
    const stage = offered >= recommended ? 2 : offered >= negotiation ? 1 : 0;
    const marginGate = computeSalesMarginDecisionFromEconomics(offered, base.beforeProfit, base.reserve, settings);
    const needsApproval = marginGate.level === "yellow";
    const marginBlocked = marginGate.level === "red";
    const approved = !marginBlocked;

    return {
      ...base,
      workersCount,
      workerDays,
      workerHours,
      offered,
      stage,
      needsApproval,
      marginBlocked,
      marginLevel: marginGate.level,
      marginDecision: marginGate.decision,
      marginMessage: marginGate.message,
      realMarginPct: marginGate.realMarginPct,
      targetMarginPct: marginGate.profitPct,
      floorMarginPct: marginGate.minimumMarginPct,
      approved,
      commissionRate,
      commissionDisplay
    };
  }

  function renderSalesWorkers(state, settings, metrics) {
    const body = $("salesWorkersBody");
    if (!body) return;

    body.innerHTML = state.workers.map((worker, index) => `
      <tr data-index="${index}">
        <td><input data-key="name" maxlength="40" value="${escapeHtml(worker.name || "")}" /></td>
        <td>
          <select data-key="type">
            <option value="installer" ${worker.type === "installer" ? "selected" : ""}>Pro</option>
            <option value="helper" ${worker.type === "helper" ? "selected" : ""}>Assistant</option>
          </select>
        </td>
        <td><input data-key="days" type="number" min="0" step="0.25" value="${Number(worker.days || 0)}" /></td>
        <td class="sales-labor-td sales-labor-td--rate" data-cell="rate">${money(workerRateFromSettings(worker, settings), settings.currency)}<span class="small" style="display:block;margin-top:4px;opacity:.72;">Business Settings</span></td>
        <td data-cell="labor">${money(metrics.laborByWorker[index]?.cost || 0, settings.currency)}</td>
        <td>
          <div class="row-actions">
            <button class="btn ghost" data-action="copy">Copy</button>
            <button class="btn danger" data-action="delete">Delete</button>
          </div>
        </td>
      </tr>
    `).join("");

    body.querySelectorAll("input,select").forEach((el) => {
      const commit = () => {
        const tr = el.closest("tr");
        const index = Number(tr?.dataset.index ?? -1);
        const key = el.dataset.key;
        if (index < 0 || !key) return;

        if (key === "days") {
          state.workers[index][key] = el.value === "" ? "" : Number(el.value || 0);
        } else {
          state.workers[index][key] = el.value;
        }

        if (key === "type") {
          state.workers[index].rate = "";
        }

        saveSales(state);
        renderSales();
      };

      el.addEventListener("change", commit);
      if (el.tagName === "INPUT") el.addEventListener("blur", commit);
    });

    body.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const tr = button.closest("tr");
        const index = Number(tr?.dataset.index ?? -1);
        if (index < 0) return;

        if (button.dataset.action === "delete") state.workers.splice(index, 1);
        if (button.dataset.action === "copy") state.workers.splice(index + 1, 0, { ...state.workers[index] });
        if (!state.workers.length) state.workers.push({ name: "Worker 1", type: "installer", days: 0, rate: "" });

        saveSales(state);
        renderSales();
      });
    });
  }

  function renderSales() {
  const state = loadSales();
  const settings = loadSettings();
  const metrics = calculateSalesMetrics(state, settings);
  const signedProjects = loadSignedProjects();
  const projectIndex = new Map(signedProjects.map((project) => [project.projectId, project]));

  if (!state.issueDate) state.issueDate = todayInputValue();
  if (!state.expirationDate) {
    state.expirationDate = addDaysToInputValue(state.issueDate, salesQuoteExpirationDays(settings));
  }
  if (!state.estimateStatus) state.estimateStatus = "draft";

  const estimateStatusMap = {
    draft: "Draft",
    pricing_ready: "Pricing Ready",
    approval_requested: "Below recommendation",
    sent: "Sent",
    signed: "Signed"
  };

  const estimateStatusLabel = estimateStatusMap[state.estimateStatus] || toTitleCase(String(state.estimateStatus || "draft").replace(/_/g, " "));
  const offered = metrics.offered || metrics.recommended || 0;
  const isReady = metrics.workerDays > 0 && metrics.recommended > 0;
  const tone = !isReady ? "amber" : offered >= metrics.recommended ? "green" : offered >= metrics.minimum ? "amber" : "red";
  const toneLabel = tone === "green" ? "Healthy" : tone === "amber" ? "Needs Review" : "At Risk";
  const heroMeta = [
    `Estimate ${state.estimateNumber}`,
    `Issue ${state.issueDate}`,
    `Expires ${state.expirationDate}`
  ].join(" | ");

  const projectNameInput = document.getElementById("salesProjectName");
  const clientNameInput = document.getElementById("salesClientName");
  const customerEmailInput = document.getElementById("salesCustomerEmail");
  const additionalRecipientsInput = document.getElementById("salesAdditionalRecipients");
  const customerPhoneInput = document.getElementById("salesCustomerPhone");
  const locationInput = document.getElementById("salesLocation");
  const issueDateInput = document.getElementById("salesIssueDate");
  const expirationDateInput = document.getElementById("salesExpirationDate");
  const startDateInput = document.getElementById("salesStartDate");
  const targetFinishInput = document.getElementById("salesTargetFinishDate");
  const dueDateInput = document.getElementById("salesDueDate");
  const estimateNumberInput = document.getElementById("salesEstimateNumber");
  const priceInput = document.getElementById("salesPrice");
  const messageToClientInput = document.getElementById("salesMessageToClient");
  const notesInput = document.getElementById("salesNotes");
  const stageRange = document.getElementById("salesStageRange");
  const workersBody = document.getElementById("salesWorkersBody");
  const projectPicker = document.getElementById("salesProjectPicker");

  const bindNativeDatePicker = (input) => {
    if (!input || input.dataset.pickerBound === "true") return;
    input.dataset.pickerBound = "true";
    const openPicker = () => {
      if (typeof input.showPicker === "function") {
        try {
          input.showPicker();
        } catch (error) {
          // Some browsers block showPicker outside a trusted interaction.
        }
      }
    };
    input.addEventListener("click", openPicker);
    input.addEventListener("focus", openPicker);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        openPicker();
      }
    });
  };

  bindNativeDatePicker(startDateInput);

  const autoIssueDate = todayInputValue();
  const autoExpirationDate = addDaysToInputValue(autoIssueDate, salesQuoteExpirationDays(settings));
  state.issueDate = autoIssueDate;
  state.expirationDate = autoExpirationDate;
  if (issueDateInput) {
    issueDateInput.value = autoIssueDate;
    issueDateInput.readOnly = true;
  }
  if (expirationDateInput) {
    expirationDateInput.value = autoExpirationDate;
    expirationDateInput.readOnly = true;
  }

  const resolveSalesEstimatedProjectDays = (salesState, salesSettings, salesMetrics) => {
    const getOp =
      typeof window.getOperationalMetricsForState === "function"
        ? window.getOperationalMetricsForState
        : null;
    if (getOp) {
      const op = getOp(salesState, salesSettings);
      if (op && finiteNumber(op.estimated_days, 0) > 0) {
        return finiteNumber(op.estimated_days, 0);
      }
    }
    const override = finiteNumber(salesState.operational_estimated_days_override, NaN);
    if (override > 0) return override;
    return salesMetrics.workerDays > 0 ? salesMetrics.workerDays : 0;
  };

  const estimatedProjectDays = resolveSalesEstimatedProjectDays(state, settings, metrics);

  const syncSalesTargetFinish = (startYmd, projectedFinishDate) => {
    const cap = window.MarginGuardSalesCapacity;
    const start = normalizeDateInput(startYmd || startDateInput?.value || state.startDate || "");
    const finishOpts = {
      workdaysEnabled: settings.workdaysEnabled !== false,
      projectedFinishDate: projectedFinishDate || null,
    };
    if (!cap || typeof cap.updateTargetFinishDisplay !== "function") {
      if (targetFinishInput) targetFinishInput.value = "";
      if (dueDateInput) dueDateInput.value = "";
      state.targetFinishDate = "";
      state.dueDate = "";
      return "";
    }
    const result = cap.updateTargetFinishDisplay(start, estimatedProjectDays, finishOpts);
    if (result.start) state.startDate = result.start;
    state.targetFinishDate = result.finish || "";
    state.dueDate = result.finish || "";
    return result.finish || "";
  };

  let salesCapacityRefreshTimer = null;
  const refreshSalesCapacityCalendar = (desiredStart) => {
    const cap = window.MarginGuardSalesCapacity;
    if (!cap || typeof cap.fetchCapacityCalendar !== "function") return;
    const days = estimatedProjectDays;
    const desired = normalizeDateInput(desiredStart || startDateInput?.value || state.startDate || "");
    const projectId = String(state.tenantProjectId || state.projectId || "").trim();
    clearTimeout(salesCapacityRefreshTimer);
    salesCapacityRefreshTimer = setTimeout(() => {
      cap
        .fetchCapacityCalendar(days, desired, projectId)
        .then((data) => {
          window.__mgSalesCapacityCalendar = data;
          const reconciled = cap.reconcileStartDateWithCapacity(data, startDateInput, state);
          cap.applyCapacityGuidance(data);
          if (typeof window.renderSalesOpCrewAvailability === "function") {
            window.renderSalesOpCrewAvailability();
          }
          if (reconciled.cleared) {
            syncSalesTargetFinish("");
            saveSales(state);
          } else if (reconciled.value) {
            syncSalesTargetFinish(reconciled.value, data.projected_finish_date);
            saveSales(state);
          } else {
            syncSalesTargetFinish("");
          }
        })
        .catch(() => {
          const guidance = document.getElementById("salesCapacityGuidance");
          if (guidance) {
            guidance.textContent = "Production schedule unavailable right now.";
          }
          const unverified =
            cap.ADVISORY_UNVERIFIED_MSG ||
            "Crew availability could not be verified. You may still send this estimate.";
          if (typeof cap.showCapacityWarning === "function") {
            cap.showCapacityWarning(unverified);
          }
          if (typeof window.renderSalesOpCrewAvailability === "function") {
            window.renderSalesOpCrewAvailability();
          }
        });
    }, 200);
  };

  refreshSalesCapacityCalendar(state.startDate || startDateInput?.value || "");

  const ccWrap = document.getElementById("salesCcWrap");
  const ccToggle = document.getElementById("btnSalesToggleCc");
  if (ccWrap && additionalRecipientsInput) {
    const hasCc = String(additionalRecipientsInput.value || state.additional_recipients || "").trim();
    ccWrap.hidden = !hasCc;
    if (ccToggle) ccToggle.setAttribute("aria-expanded", hasCc ? "true" : "false");
  }
  if (ccToggle && ccWrap && ccToggle.dataset.bound !== "true") {
    ccToggle.dataset.bound = "true";
    ccToggle.onclick = () => {
      const open = ccWrap.hidden;
      ccWrap.hidden = !open;
      ccToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open && additionalRecipientsInput) additionalRecipientsInput.focus();
    };
  }

  if (estimateNumberInput) estimateNumberInput.value = state.estimateNumber;
  if (issueDateInput) issueDateInput.value = state.issueDate;
  if (expirationDateInput) expirationDateInput.value = state.expirationDate;
  if (projectNameInput) projectNameInput.value = state.projectName || "";
  if (clientNameInput) clientNameInput.value = state.clientName || "";
  if (customerEmailInput) customerEmailInput.value = state.customerEmail || "";
  if (additionalRecipientsInput) additionalRecipientsInput.value = state.additional_recipients || "";
  if (customerPhoneInput) customerPhoneInput.value = state.customerPhone || "";
  if (locationInput) locationInput.value = state.location || "";
  if (startDateInput) {
    startDateInput.value = normalizeDateInput(state.startDate || "");
  }
  syncSalesTargetFinish(normalizeDateInput(state.startDate || startDateInput?.value || ""));
  if (targetFinishInput) {
    targetFinishInput.readOnly = true;
    targetFinishInput.disabled = true;
  }
  const priceDisplay = document.getElementById("salesPriceDisplay");
  if (priceDisplay) {
    priceDisplay.textContent = isReady ? formatMoney(offered) : "—";
  }
  if (priceInput) priceInput.value = isReady ? String(round2(offered)) : "";
  if (messageToClientInput) messageToClientInput.value = state.messageToClient || "";
  if (notesInput) notesInput.value = state.notes || "";

  if (stageRange) {
    const normalizedStage = metrics.stage >= 2 ? 2 : metrics.stage <= 0 ? 0 : 1;
    stageRange.value = String(normalizedStage);
  }

  if (workersBody) renderSalesWorkers(state, settings, metrics);

  if (projectPicker) {
    projectPicker.innerHTML = `<option value="">Portfolio estimate link</option>${signedProjects.map((project) => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.projectId)} | ${escapeHtml(project.clientName)} | ${escapeHtml(project.status)}</option>`).join("")}`;
    projectPicker.value = signedProjects.some((project) => project.projectId === state.projectName) ? state.projectName : "";
  }

  setText("salesEstimateStatus", estimateStatusLabel);
  setText("salesEstimateSummary", `Customer ${nonEmptyString(state.clientName, "Pending")} | ${toneLabel} | Total ${formatMoney(offered)}`);
  setText("salesTraffic", toneLabel);
  setText("salesHeroState", tone === "green" ? "Green" : tone === "amber" ? "Amber" : "Red");
  setText("salesHeroMeta", heroMeta);
  setText("salesPrimaryPrice", formatMoney(metrics.recommended));
  setText("salesPrimaryMeta", `${metrics.workerDays.toFixed(2)} worker-days | ${metrics.workerHours.toFixed(2)} labor-hours | ${metrics.workersCount} workers | Current ${formatMoney(offered)}`);
  setText("salesPrimaryCommission", metrics.commissionRate.toFixed(2) + "%");
  setText("salesPrimaryCommissionMeta", `${formatMoney(metrics.commissionDisplay)} estimated commission`);
  setText("salesFlowHeadline", metrics.workerDays <= 0 ? "Complete labor" : metrics.needsApproval ? "Below recommendation" : "Ready to send");
  setText(
    "salesFlowCaption",
    metrics.workerDays <= 0
      ? "Add worker days so Margin Guard can price the job."
      : metrics.needsApproval
        ? "If the price is below the recommendation, you can still proceed — do it responsibly and confirm margin with your owner."
        : "Pricing is in a healthy range for this estimate."
  );
  setText("salesStageMin", formatMoney(metrics.minimum));
  setText("salesStageNegotiation", formatMoney(metrics.negotiation));
  setText("salesStageRecommended", formatMoney(metrics.recommended));
  setText("salesCrewHint", `${metrics.workersCount} workers configured for ${metrics.workerHours.toFixed(2)} labor hours.`);
  setText(
    "salesPricingGuidance",
    metrics.needsApproval
      ? "Precio bajo la recomendacion: puedes seguir, pero hazlo con criterio y alinea expectativas con el dueno."
      : "Precio alineado con el rango recomendado o superior."
  );
  setText("salesRule", salesPricingRuleCopy(state, metrics, isReady));
  const salesRuleEl = document.getElementById("salesRule");
  if (salesRuleEl) {
    salesRuleEl.style.display = isReady || Boolean(state._sliderTouched) ? "" : "";
    if (!isReady) {
      salesRuleEl.className = "notice";
    } else if (metrics.marginBlocked && state._sliderTouched) {
      salesRuleEl.className = "notice err";
    } else if (metrics.needsApproval && state._sliderTouched) {
      salesRuleEl.className = "notice amber";
    } else {
      salesRuleEl.className = "notice success";
    }
  }
  const marginLine = $("salesMarginDecisionLine");
  if (marginLine) {
    if (!isReady || !state._sliderTouched) {
      marginLine.style.display = "none";
      marginLine.textContent = "";
    } else {
      marginLine.style.display = "block";
      marginLine.className =
        metrics.marginLevel === "green"
          ? "notice success"
          : metrics.marginLevel === "yellow"
            ? "notice amber"
            : "notice err";
      marginLine.textContent = metrics.marginMessage || "";
    }
  }

  const kpiBlocks = [
    { label: "Subtotal", value: formatMoney(offered) },
    { label: "Recommended", value: formatMoney(metrics.recommended) },
    { label: "Minimum", value: formatMoney(metrics.minimum) },
    { label: "Commission", value: formatMoney(metrics.commissionDisplay) }
  ];
  const salesKpis = document.getElementById("salesKpis");
  if (salesKpis) {
    salesKpis.innerHTML = kpiBlocks.map((item) => `<article class="compact-stat"><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.value)}</strong></article>`).join("");
  }

  const negotiationList = document.getElementById("negotiationList");
  if (negotiationList) {
    const guidance = [
      `Estimate status: ${estimateStatusLabel}.`,
      `Offer range: ${formatMoney(metrics.minimum)} to ${formatMoney(metrics.recommended)}.`,
      metrics.needsApproval
        ? "If price is below recommendation, proceed responsibly and confirm with your owner before signing."
        : "Estimate can be sent directly to the customer."
    ];
    negotiationList.innerHTML = guidance.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  }

  const portfolioCount = document.getElementById("salesProjectPortfolioCount");
  if (portfolioCount) portfolioCount.textContent = `${signedProjects.length} active records`;

  const projectLink = projectIndex.get(state.projectName);
  setText("salesProjectProgress", projectLink ? `${toTitleCase(projectLink.status)} | ${formatMoney(projectLink.finalPrice || projectLink.priceOffered || 0)}` : "No linked signed project yet.");

  const changeOrderBody = document.getElementById("salesChangeOrderBody");
  if (changeOrderBody) {
    const orders = projectLink?.changeOrders || [];
    changeOrderBody.innerHTML = orders.length
      ? orders.map((order) => `<tr><td>${escapeHtml(order.title || order.id || "Change order")}</td><td>${escapeHtml(toTitleCase(order.status || "draft"))}</td><td>${escapeHtml(formatMoney(order.price || 0))}</td><td><button class="secondary-button" data-sales-co-pdf="${escapeHtml(order.id || "")}">PDF</button></td></tr>`).join("")
      : '<tr><td colspan="4" class="empty-row">No change orders linked yet.</td></tr>';
  }

  const invoiceSummary = projectLink?.invoice || {};
  setText("salesInvoiceNo", invoiceSummary.invoiceNo || "Not assigned");
  setText("salesInvoiceStatus", toTitleCase(invoiceSummary.status || "draft"));
  setText("salesInvoiceDue", invoiceSummary.dueDate || "Not scheduled");
  setText("salesInvoicePaid", formatMoney(invoiceSummary.paid || 0));
  setText("salesInvoiceBalance", formatMoney(invoiceSummary.balanceDue || 0));

  function persistSalesDraft(nextStatus) {
    state.estimateNumber = String(estimateNumberInput?.value ?? "").trim();
    state.issueDate = autoIssueDate;
    state.expirationDate = autoExpirationDate;
    state.projectName = nonEmptyString(projectNameInput?.value);
    state.clientName = nonEmptyString(clientNameInput?.value);
    state.customerEmail = nonEmptyString(customerEmailInput?.value);
    state.customerPhone = nonEmptyString(customerPhoneInput?.value);
    state.location = nonEmptyString(locationInput?.value);
    state.startDate = normalizeDateInput(startDateInput?.value || state.startDate || "");
    syncSalesTargetFinish(state.startDate);
    state.price = isReady ? String(round2(metrics.offered)) : "";
    state.pricingStage = metrics.stage;
    state.messageToClient = nonEmptyString(messageToClientInput?.value);
    state.notes = nonEmptyString(notesInput?.value);
    if (nextStatus) state.estimateStatus = nextStatus;
    saveSales(state);
  }

  [projectNameInput, clientNameInput, customerEmailInput, additionalRecipientsInput, customerPhoneInput, locationInput, startDateInput, estimateNumberInput, messageToClientInput, notesInput].forEach((input) => {
    if (!input) return;
    input.oninput = () => persistSalesDraft();
    input.onchange = () => {
      persistSalesDraft();
      if (input === startDateInput) {
        refreshSalesCapacityCalendar(startDateInput.value);
      }
    };
  });
  if (startDateInput && startDateInput.dataset.capacityBound !== "true") {
    startDateInput.dataset.capacityBound = "true";
    startDateInput.addEventListener("change", () => {
      refreshSalesCapacityCalendar(startDateInput.value);
    });
    startDateInput.addEventListener("input", () => {
      const cached = window.__mgSalesCapacityCalendar;
      const cap = window.MarginGuardSalesCapacity;
      if (!cached || !cap) return;
      if (typeof cap.applyCapacityGuidance === "function") {
        cap.applyCapacityGuidance(cached);
      }
    });
  }

  if (stageRange) {
    stageRange.oninput = () => {
      const stage = Number(stageRange.value || 2);
      const nextPrice = stage <= 0 ? metrics.minimum : stage === 1 ? metrics.negotiation : metrics.recommended;
      state.pricingStage = stage;
      state._sliderTouched = true;
      state._manualPriceTouched = false;
      state.price = nextPrice ? String(round2(nextPrice)) : "";
      state.estimateStatus = nextPrice ? "pricing_ready" : state.estimateStatus;
      saveSales(state);
      renderSales();
    };
  }

  if (workersBody) {
    workersBody.querySelectorAll('input, select').forEach((control) => {
      control.addEventListener('input', () => {
        state.estimateStatus = metrics.workerDays > 0 ? "pricing_ready" : state.estimateStatus;
        saveSales(state);
      });
      control.addEventListener('change', () => {
        state.estimateStatus = metrics.workerDays > 0 ? "pricing_ready" : state.estimateStatus;
        saveSales(state);
        renderSales();
      });
    });
  }

  const addSalesWorker = () => {
    if (!Array.isArray(state.workers)) state.workers = cloneWorkers(DEFAULT_SALES.workers);
    state.workers.push({ name: `Worker ${state.workers.length + 1}`, type: "installer", days: 0, rate: "" });
    saveSales(state);
    renderSales();
  };

  const clearSalesWorkers = () => {
    state.workers = cloneWorkers(DEFAULT_SALES.workers);
    saveSales(state);
    renderSales();
  };

  window.__mgAddSalesWorker = addSalesWorker;
  window.__mgClearSalesWorkers = clearSalesWorkers;

  const addSalesWorkerButton = document.getElementById("btnAddSalesWorker");
  if (addSalesWorkerButton) addSalesWorkerButton.onclick = addSalesWorker;

  const clearSalesWorkersButton = document.getElementById("btnClearSalesWorkers");
  if (clearSalesWorkersButton) clearSalesWorkersButton.onclick = clearSalesWorkers;

  if (projectPicker) {
    projectPicker.onchange = () => {
      const selected = projectIndex.get(projectPicker.value);
      if (!selected) return;
      state.projectName = selected.projectId;
      state.clientName = selected.clientName || state.clientName;
      state.customerEmail = selected.clientEmail || state.customerEmail;
      state.customerPhone = selected.clientPhone || state.customerPhone;
      state.location = selected.location || state.location;
      state.price = String(round2(selected.finalPrice || selected.priceOffered || 0));
      state.dueDate = normalizeDateInput(selected.dueDate || state.dueDate || todayInputValue());
      state.estimateStatus = "pricing_ready";
      saveSales(state);
      renderSales();
    };
  }

  const changeOrderBodyEl = document.getElementById("salesChangeOrderBody");
  if (changeOrderBodyEl && !changeOrderBodyEl.dataset.mgCoPdfDelegate) {
    changeOrderBodyEl.dataset.mgCoPdfDelegate = "1";
    changeOrderBodyEl.addEventListener("click", (event) => {
      const target = event.target.closest("[data-sales-co-pdf]");
      if (!target) return;
      const orderId = target.getAttribute("data-sales-co-pdf");
      const salesState = loadSales();
      const pmap = new Map(loadSignedProjects().map((p) => [p.projectId, p]));
      const project = pmap.get(salesState.projectName);
      const freshSettings = loadSettings();
      const orders = project?.changeOrders || [];
      const co = orders.find(
        (row) => String(row?.id ?? "") === String(orderId || "") || String(row?.title ?? "") === String(orderId || "")
      );
      if (!project) {
        window.alert("Selecciona un proyecto firmado en el selector Portfolio.");
        return;
      }
      if (!co) {
        window.alert("Change order no encontrado.");
        return;
      }
      const normalizedCo =
        co.offeredPrice == null && co.price != null ? { ...co, offeredPrice: co.price } : co;
      exportChangeOrderPdf(project, normalizedCo, freshSettings);
    });
  }

  const btnSendCloseEl = document.getElementById("btnSendClose");
  if (btnSendCloseEl) btnSendCloseEl.onclick = () => closeSendModal();
  const btnSendCancelEl = document.getElementById("btnSendCancel");
  if (btnSendCancelEl) btnSendCancelEl.onclick = () => closeSendModal();
  const btnSendNowEl = document.getElementById("btnSendNow");
  if (btnSendNowEl) {
    btnSendNowEl.onclick = () => {
      const freshSettings = loadSettings();
      if ($("ownerKpis")) {
        const ownerState = loadOwner();
        const metrics = calcOwner(ownerState, freshSettings);
        void sendQuote(ownerState, freshSettings, metrics);
        return;
      }
      const freshState = loadSales();
      void sendQuote(freshState, freshSettings, calculateSalesMetrics(freshState, freshSettings));
    };
  }

  if (projectNameInput) {
    const btnNew = document.getElementById("btnNewSalesQuote");
    if (btnNew) {
      btnNew.onclick = () => showSalesNewQuoteModal();
    }

    const btnSendQuoteInline = document.getElementById("btnSendQuoteInline");
    if (btnSendQuoteInline) {
      btnSendQuoteInline.onclick = () => {
        persistSalesDraft("sent");
        openSendModal(state, settings, calculateSalesMetrics(state, settings));
      };
    }

    const btnSendQuoteTop = document.getElementById("btnSendQuote");
    if (btnSendQuoteTop && document.getElementById("salesProjectName")) {
      btnSendQuoteTop.onclick = () => {
        persistSalesDraft("sent");
        openSendModal(state, settings, calculateSalesMetrics(state, settings));
      };
    }

    const btnMarkSold = document.getElementById("btnMarkSold");
    if (btnMarkSold) {
      btnMarkSold.onclick = () => {
        persistSalesDraft("signed");
        const currentMetrics = calculateSalesMetrics(state, settings);
        if (currentMetrics.marginBlocked) {
          window.alert("Price too low");
          return;
        }
        if (!state.projectName || !state.clientName || !(state.startDate || state.dueDate) || currentMetrics.workerDays <= 0) {
          window.alert("Complete project, customer, start date, and labor details before signing the estimate.");
          return;
        }
        const cap = window.MarginGuardSalesCapacity;
        const startDate = normalizeDateInput(state.startDate || state.dueDate || "");
        const cached = window.__mgSalesCapacityCalendar;
        if (cap && cached && cap.isStartBlocked(cached, startDate)) {
          const suffix = cap.ADVISORY_SUFFIX_SOLD || " You may still mark this project sold.";
          if (typeof cap.showCapacityWarning === "function") {
            cap.showCapacityWarning(cap.blockedStartMessage(cached) + suffix);
          }
        }
        const project = buildSignedProjectFromSales(state, settings, currentMetrics);
        saveActiveProject(project);
        upsertSignedProject(project);
        setLatestReport(ensureSupervisorReport(project));
        renderSales();
      };
    }

    const btnProjComplete = document.getElementById("btnSalesProjectComplete");
    if (btnProjComplete) {
      btnProjComplete.onclick = () => {
        const activeProject = loadActiveProject();
        if (!activeProject?.projectId) return;
        activeProject.status = "completed";
        activeProject.updatedAt = new Date().toISOString();
        saveActiveProject(activeProject);
        upsertSignedProject(activeProject);
        renderSales();
      };
    }

    const btnInvOpen = document.getElementById("btnSalesInvoiceOpen");
    if (btnInvOpen) btnInvOpen.onclick = () => { window.location.href = "/estimates-invoices"; };

    const btnInvSend = document.getElementById("btnSalesInvoiceSend");
    if (btnInvSend) {
      btnInvSend.onclick = () => openSendModal(state, settings, calculateSalesMetrics(state, settings));
    }

    const btnInvPdf = document.getElementById("btnSalesInvoicePdf");
    if (btnInvPdf) btnInvPdf.onclick = () => window.print();
  }
}

window.renderSales = renderSales;
window.openSendModal = openSendModal;
window.closeSendModal = closeSendModal;
window.sendQuote = sendQuote;

function renderSupervisor() {
    if (!$("supProjectPicker")) return;
    bindSupFieldModalsOnce();
    bindSupExpenseSummaryOnce();

    const settings = loadSettings();
    const picker = $("supProjectPicker");
    const projects = getSupervisorProjectsForUi();
    if (typeof console !== "undefined" && console.log) {
      console.log("[supervisor-filter] api count", projects.length);
    }
    const selectedProjectId = supervisorProjectKey(loadSupervisorSelectedProjectId());
    const selectedProject =
      projects.find((project) => supervisorProjectKey(project.id) === selectedProjectId) || projects[0] || null;

    if (picker) {
      picker.innerHTML = projects.length
        ? projects.map((project) => `
            <option value="${escapeHtml(project.id)}">${escapeHtml(project.projectName || "Project")} · ${escapeHtml(project.clientName || "Sin cliente")}</option>
          `).join("")
        : `<option value="">Sin proyectos firmados</option>`;
      picker.value = selectedProject?.id || "";
      picker.onchange = () => {
        const prevId = supervisorProjectKey(loadSupervisorSelectedProjectId());
        const nextId = supervisorProjectKey(picker.value);
        saveSupervisorSelectedProjectId(nextId);
        closeSupFieldModal("all");
        closeSupReportPanels("all");
        closeSupExpenseSummaryModal();
        const fb = $("supAssignFeedback");
        if (fb) fb.textContent = "";
        if (prevId && prevId !== nextId) {
          delete supervisorProjectReportsCache[prevId];
          delete supervisorProjectExpensesCache[prevId];
          delete supervisorProjectChangeOrdersCache[prevId];
          delete supervisorProjectOperationalCache[prevId];
          supervisorProjectReportsFetchInFlight.delete(prevId);
          supervisorProjectExpensesFetchInFlight.delete(prevId);
          supervisorProjectChangeOrdersFetchInFlight.delete(prevId);
          supervisorProjectOperationalFetchInFlight.delete(prevId);
        }
        if (prevId !== nextId && nextId) {
          delete supervisorProjectReportsCache[nextId];
          delete supervisorProjectExpensesCache[nextId];
          delete supervisorProjectChangeOrdersCache[nextId];
          delete supervisorProjectOperationalCache[nextId];
        }
        if (nextId && isServerListedSupervisorProject(nextId)) {
          supervisorProjectReportsFetchInFlight.add(nextId);
          supervisorProjectExpensesFetchInFlight.add(nextId);
          renderSupervisor();
          void (async () => {
            try {
              if (supervisorProjectKey(loadSupervisorSelectedProjectId()) !== nextId) return;
              const [r, e] = await Promise.all([
                fetchProjectReports(nextId),
                fetchProjectExpenses(nextId),
                loadSupervisorOperationalSnapshot(nextId, { force: true }),
              ]);
              if (supervisorProjectKey(loadSupervisorSelectedProjectId()) !== nextId) return;
              supervisorProjectReportsCache[nextId] =
                r && r.ok === true && Array.isArray(r.reports)
                  ? { ok: true, reports: r.reports }
                  : { ok: false, reports: [] };
              supervisorProjectExpensesCache[nextId] =
                e && e.ok === true && Array.isArray(e.expenses)
                  ? { ok: true, expenses: e.expenses }
                  : { ok: false, expenses: [] };
            } finally {
              supervisorProjectReportsFetchInFlight.delete(nextId);
              supervisorProjectExpensesFetchInFlight.delete(nextId);
            }
            if (supervisorProjectKey(loadSupervisorSelectedProjectId()) !== nextId) return;
            renderSupervisor();
          })();
        } else {
          renderSupervisor();
        }
      };
    }

    const btnSupAssign = $("supAssignToMeBtn");
    const supAssignFb = $("supAssignFeedback");
    if (btnSupAssign) {
      const pid = String(picker?.value || "").trim();
      btnSupAssign.disabled = !pid;
      btnSupAssign.onclick = async () => {
        const projectId = String(picker?.value || "").trim();
        if (!projectId) {
          if (supAssignFb) supAssignFb.textContent = "Select a project first.";
          return;
        }
        if (supAssignFb) supAssignFb.textContent = "";
        btnSupAssign.disabled = true;
        try {
          const res = await fetch("/.netlify/functions/assign-supervisor-project", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ project_id: projectId }),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data && data.ok === true) {
            if (supAssignFb) supAssignFb.textContent = "Assigned. List updated.";
            await refreshSupervisorProjectsFromApi();
          } else {
            const msg = (data && (data.error || data.message)) || `Assignment failed (${res.status}).`;
            if (supAssignFb) supAssignFb.textContent = msg;
          }
        } catch (_e) {
          if (supAssignFb) supAssignFb.textContent = "Network error. Try again.";
        } finally {
          const cur = String($("supProjectPicker")?.value || "").trim();
          if (btnSupAssign) btnSupAssign.disabled = !cur;
        }
      };
    }

    const apiProjectsForPicker = getSupervisorProjectsForUi();
    if (selectedProjectId && !apiProjectsForPicker.find((p) => supervisorProjectKey(p.id) === selectedProjectId)) {
      clearSupervisorSelectedProjectId();
      if (apiProjectsForPicker[0]) {
        saveSupervisorSelectedProjectId(supervisorProjectKey(apiProjectsForPicker[0].id));
      }
    }

    const refresh = () => {
      const uiList = getSupervisorProjectsForUi();

      if (picker) {
        const cur = supervisorProjectKey(picker.value || "");
        picker.innerHTML = uiList.length
          ? uiList.map((project) => `
            <option value="${escapeHtml(project.id)}">${escapeHtml(project.projectName || "Project")} · ${escapeHtml(project.clientName || "Sin cliente")}</option>
          `).join("")
          : `<option value="">Sin proyectos firmados</option>`;
        const still = uiList.find((p) => supervisorProjectKey(p.id) === cur);
        if (still) {
          picker.value = still.id;
        } else if (uiList[0]) {
          picker.value = uiList[0].id;
          saveSupervisorSelectedProjectId(supervisorProjectKey(uiList[0].id));
        } else {
          picker.value = "";
          clearSupervisorSelectedProjectId();
        }
        if (typeof console !== "undefined" && console.log) {
          console.log("[supervisor-filter] picker count", uiList.length);
        }
      }

      const lsSel = supervisorProjectKey(loadSupervisorSelectedProjectId());
      const pickerVal = supervisorProjectKey($("supProjectPicker")?.value || "");
      const wantId = lsSel || pickerVal;
      if (typeof console !== "undefined" && console.info) {
        console.info("[MG Supervisor trace]", "refresh start", {
          pickerValueRaw: $("supProjectPicker")?.value,
          pickerVal,
          lsSel,
          wantIdPreResolve: wantId,
          selectedProjectId: selectedProject?.id,
        });
      }
      let currentProject = null;
      if (wantId) {
        currentProject = uiList.find((project) => supervisorProjectKey(project.id) === wantId) || null;
        if (!currentProject) {
          if (typeof console !== "undefined" && console.warn) {
            console.warn("[MG Supervisor] Project not found for id:", wantId);
          }
          clearSupervisorSelectedProjectId();
          if (uiList.length) {
            const first = uiList[0];
            const firstId = supervisorProjectKey(first.id);
            saveSupervisorSelectedProjectId(firstId);
            if (picker) picker.value = first.id;
            currentProject = first;
          } else {
            if (picker) picker.value = "";
            currentProject = null;
          }
        } else if (
          supervisorProjectKey(currentProject.id) !== wantId &&
          typeof console !== "undefined" &&
          console.error
        ) {
          console.error("[MG Supervisor trace] currentProject.id !== wantId; blocking paint", {
            wantId,
            currentProjectId: currentProject.id,
          });
          clearSupervisorSelectedProjectId();
          if (uiList.length) {
            const first = uiList[0];
            saveSupervisorSelectedProjectId(supervisorProjectKey(first.id));
            if (picker) picker.value = first.id;
            currentProject = first;
          } else {
            if (picker) picker.value = "";
            currentProject = null;
          }
        }
      } else {
        currentProject = uiList[0] || null;
      }

      if (typeof console !== "undefined" && console.info) {
        console.info("[MG Supervisor trace]", "refresh resolved", {
          pickerValueRaw: $("supProjectPicker")?.value,
          pickerVal,
          lsSel,
          wantId,
          selectedProjectId: selectedProject?.id,
          currentProjectId: currentProject?.id,
        });
      }

      if (!currentProject) {
        supervisorLastRefreshedProjectId = null;
        renderSupervisorHero(null);
        if ($("supTodayTarget")) $("supTodayTarget").style.display = "none";
        if ($("supPortfolioCount")) $("supPortfolioCount").textContent = "0";
        syncSupervisorConsoleSidebar();
        if (typeof console !== "undefined" && console.log) {
          console.log("[supervisor-filter] kpi count", 0);
        }
        $("supervisorKpis").innerHTML = [
          ["Proyectos firmados", "0", "Firma o aprueba proyectos para empezar a reportar"],
          ["Dias estimados", "0.00", "Esperando proyecto firmado"],
          ["Target finish", "No target finish date set", "Set in Sales when signing the project"]
        ].map(([label, value, meta]) => `
          <div class="kpi-box">
            <div class="label">${escapeHtml(label)}</div>
            <div class="value">${escapeHtml(value)}</div>
            <div class="meta">${escapeHtml(meta)}</div>
          </div>
        `).join("");
        if ($("supEntriesBody")) $("supEntriesBody").innerHTML = "";
        if ($("supExtrasBody")) $("supExtrasBody").innerHTML = "";
        if ($("supLaborPlanBody")) {
          $("supLaborPlanBody").innerHTML =
            '<p class="sup-cal-empty small">Execution plan has not been prepared in Sales.</p>';
        }
        if ($("supExecCalendarChrome")) $("supExecCalendarChrome").hidden = true;
        renderSupervisorOperationalPanel({});
        if (typeof console !== "undefined" && console.log) {
          console.log("[supervisor-filter] kpi count", 0);
        }
        return;
      }

      const pid = supervisorProjectKey(currentProject.id);
      const switchedProject =
        supervisorLastRefreshedProjectId != null && supervisorProjectKey(supervisorLastRefreshedProjectId) !== pid;
      if (switchedProject) {
        const oldPid = supervisorProjectKey(supervisorLastRefreshedProjectId);
        delete supervisorProjectReportsCache[oldPid];
        delete supervisorProjectExpensesCache[oldPid];
        delete supervisorProjectChangeOrdersCache[oldPid];
        delete supervisorProjectOperationalCache[oldPid];
        supervisorProjectReportsFetchInFlight.delete(oldPid);
        supervisorProjectExpensesFetchInFlight.delete(oldPid);
        supervisorProjectChangeOrdersFetchInFlight.delete(oldPid);
        supervisorProjectOperationalFetchInFlight.delete(oldPid);
        clearSupervisorSwitchDomBleed();
        wipeSupervisorLocalScratchOnProjectSwitch(currentProject);
      }

      if (isServerListedSupervisorProject(pid)) {
        if (!supervisorProjectReportsCache[pid] && !supervisorProjectReportsFetchInFlight.has(pid)) {
          supervisorProjectReportsFetchInFlight.add(pid);
          void fetchProjectReports(pid).then((data) => {
            supervisorProjectReportsFetchInFlight.delete(pid);
            if (data && data.ok === true && Array.isArray(data.reports)) {
              supervisorProjectReportsCache[pid] = { ok: true, reports: data.reports };
            } else {
              supervisorProjectReportsCache[pid] = { ok: false, reports: [] };
            }
            if ($("supervisorKpis") && supervisorProjectKey(loadSupervisorSelectedProjectId()) === pid) {
              renderSupervisor();
            }
          });
        }
        if (!supervisorProjectExpensesCache[pid] && !supervisorProjectExpensesFetchInFlight.has(pid)) {
          supervisorProjectExpensesFetchInFlight.add(pid);
          void fetchProjectExpenses(pid).then((data) => {
            supervisorProjectExpensesFetchInFlight.delete(pid);
            if (data && data.ok === true && Array.isArray(data.expenses)) {
              supervisorProjectExpensesCache[pid] = { ok: true, expenses: data.expenses };
            } else {
              supervisorProjectExpensesCache[pid] = { ok: false, expenses: [] };
            }
            if ($("supervisorKpis") && supervisorProjectKey(loadSupervisorSelectedProjectId()) === pid) {
              renderSupervisor();
            }
          });
        }
        void loadSupervisorOperationalSnapshot(pid).then(() => {
          if (supervisorProjectKey(loadSupervisorSelectedProjectId()) === pid) {
            renderSupervisor();
          }
        });
      }

      let state = loadSupervisorReport(currentProject);
      const statePidBad = supervisorProjectKey(state.projectId) !== pid;
      const supervisorRowStateSwitched =
        lastSupervisorProjectId != null && supervisorProjectKey(lastSupervisorProjectId) !== pid;
      if (statePidBad || supervisorRowStateSwitched) {
        if (statePidBad && typeof console !== "undefined" && console.warn) {
          console.warn("[MG Supervisor] state.projectId !== currentProject; clearing row arrays", {
            stateProjectId: state.projectId,
            currentProjectId: pid,
            wantId,
          });
        }
        if (supervisorRowStateSwitched && typeof console !== "undefined" && console.log) {
          console.log("[MG FIX] State reset due to project switch", {
            from: lastSupervisorProjectId,
            to: pid,
          });
        }
        state = buildDefaultSupervisorReport(currentProject);
        state.entries = [];
        state.extras = [];
        state.changeOrders = [];
        state.projectId = pid;
      }
      lastSupervisorProjectId = pid;
      state.projectId = pid;
      state.projectName = currentProject.projectName || state.projectName;
      state.estimatedDays = finiteNumber(currentProject.estimatedDays, state.estimatedDays);
      state.laborBudget = finiteNumber(currentProject.laborBudget, state.laborBudget);
      state.dueDate = normalizeDateInput(currentProject.dueDate || state.dueDate);
      const planWorkersForProjection = Array.isArray(currentProject.workers) ? currentProject.workers : [];
      const maxPlanWorkerDays = supervisorMaxPlanWorkerDays(planWorkersForProjection);
      const autoProjected =
        state.dueDate && planWorkersForProjection.length
          ? supervisorProjectedFinishFromCommitment(state.dueDate, maxPlanWorkerDays)
          : "";
      state.projectedEndDate = normalizeDateInput(autoProjected);
      state.changeOrders = Array.isArray(state.changeOrders) ? state.changeOrders : [];
      state.changeOrderDraft = {
        ...buildDefaultChangeOrderDraft(currentProject),
        ...(state.changeOrderDraft && typeof state.changeOrderDraft === "object" ? state.changeOrderDraft : {}),
        workers: Array.isArray(state.changeOrderDraft?.workers) && state.changeOrderDraft.workers.length
          ? state.changeOrderDraft.workers
          : buildDefaultChangeOrderWorkers(currentProject)
      };
      if (typeof console !== "undefined" && console.info) {
        console.info("[MG Supervisor trace]", "refresh before save/render", {
          wantId,
          currentProjectId: pid,
          stateProjectId: supervisorProjectKey(state.projectId),
          entriesCount: state.entries.length,
          extrasCount: state.extras.length,
          changeOrdersCount: state.changeOrders.length,
        });
      }
      supervisorIsolateProjectRowArrays(state, pid);
      if (switchedProject && typeof console !== "undefined" && console.info) {
        console.info("[MG Supervisor isolation]", {
          selectedProjectId: loadSupervisorSelectedProjectId(),
          currentProjectId: currentProject.id,
          normalizedProjectId: pid,
          entriesCount: state.entries.length,
          extrasCount: state.extras.length,
          changeOrdersCount: state.changeOrders.length,
        });
      }
      saveSupervisorReport(pid, state);
      const reportedHours = state.entries.reduce((sum, row) => sum + Number(row.hours || 0), 0);
      const daysSpent = state.entries.reduce((sum, row) => sum + Number(row.days || 0), 0);
      const opCache = supervisorProjectOperationalCache[pid];
      const panelState = resolveSupervisorOperationalPanelState(
        pid,
        currentProject,
        state,
        opCache
      );
      const activeSnap = panelState.snapshot;
      const migrationBaseline =
        opCache?.migration_baseline && typeof opCache.migration_baseline === "object"
          ? opCache.migration_baseline
          : null;
      const unifiedProgress = computeSupervisorUnifiedProgress({
        migrationBaseline,
        snapshot: activeSnap,
        dayProgressRows: opCache?.day_progress || [],
        reportRows:
          supervisorProjectReportsCache[pid]?.ok === true
            ? supervisorProjectReportsCache[pid].reports
            : [],
        estimatedDaysFallback: finiteNumber(
          currentProject?.estimatedDays,
          finiteNumber(state.estimatedDays, 0)
        ),
      });
      const actualDays = unifiedProgress.actualDays;
      const progressPct = unifiedProgress.progressPct;
      const estimatedBudgetDays =
        unifiedProgress.estimatedDays > 0
          ? unifiedProgress.estimatedDays
          : finiteNumber(activeSnap.estimated_days, finiteNumber(state.estimatedDays, 0));
      const extrasRegCount = state.extras.length;
      const showMigratedExecution = resolveShowMigratedExecution(opCache);
      const scheduleLabels = supervisorScheduleLabels(
        opCache?.schedule,
        currentProject,
        state,
        showMigratedExecution ? migrationBaseline : null
      );
      const execPlan = resolveSupervisorExecutionPlan(
        opCache,
        currentProject,
        estimatedBudgetDays
      );
      const fieldCtx = opCache?.migrated_field_context;

      let dayDelta = 0;
      if (state.dueDate && state.projectedEndDate) {
        const due = new Date(state.dueDate).getTime();
        const projected = new Date(state.projectedEndDate).getTime();
        dayDelta = Math.round((projected - due) / (1000 * 60 * 60 * 24));
      }
      if (scheduleLabels.targetIso && scheduleLabels.startIso) {
        const targetMs = new Date(scheduleLabels.targetIso).getTime();
        const todayMs = new Date().setHours(0, 0, 0, 0);
        const calendarBehind = Math.round((todayMs - targetMs) / (1000 * 60 * 60 * 24));
        if (calendarBehind > dayDelta) dayDelta = calendarBehind;
      }

      const smartStatus = computeSupervisorSmartStatus({
        estimatedDays: estimatedBudgetDays,
        actualDays,
        calendarDayDelta: dayDelta,
      });
      const planDayIndex = supervisorCurrentPlanDayIndex(
        execPlan,
        scheduleLabels.startIso,
        actualDays
      );
      const crewSummary = supervisorFormatHeroCrewSummary(
        execPlan,
        currentProject,
        showMigratedExecution ? "" : scheduleLabels.crewSummary
      );

      renderSupervisorHero({
        projectName: state.projectName || "Project",
        estimatedDays: estimatedBudgetDays,
        actualDays,
        planDayIndex,
        status: smartStatus,
        schedule: scheduleLabels,
        crewSummary,
        progressPct,
        migrationBaseline,
      });
      renderSupervisorTodayTarget(
        execPlan,
        scheduleLabels.startIso,
        actualDays,
        showMigratedExecution
          ? { baseline: migrationBaseline, schedule: scheduleLabels }
          : null,
        {
          estimatedDays: estimatedBudgetDays,
          currentDayIndex: showMigratedExecution
            ? supervisorMigratedCurrentPlanDayIndex(migrationBaseline, execPlan)
            : planDayIndex,
        }
      );

      if ($("supPortfolioCount")) $("supPortfolioCount").textContent = String(uiList.length);

      const dayActivityMap = supervisorBuildDayFieldActivityMap(
        pid,
        state,
        scheduleLabels.startIso,
        execPlan
      );
      const migratedCompletedThru = showMigratedExecution
        ? Math.max(
            0,
            Math.floor(finiteNumber(migrationBaseline?.days_completed_to_date, 0))
          )
        : 0;
      const progressMap = showMigratedExecution
        ? supervisorProgressMapWithMigratedBaseline(
            opCache?.day_progress || [],
            migrationBaseline
          )
        : supervisorDayProgressMap(opCache?.day_progress || []);
      const calendarCurrentDay = showMigratedExecution
        ? supervisorMigratedCurrentPlanDayIndex(migrationBaseline, execPlan)
        : supervisorCurrentPlanDayIndex(
            execPlan,
            scheduleLabels.startIso,
            actualDays
          );
      renderSupervisorExecutionPlanSection({
        showMigrated: showMigratedExecution,
        execPlan,
        estimatedDays: estimatedBudgetDays,
        projectId: pid,
        calendarCtx: {
          startIso: scheduleLabels.startIso,
          progressMap,
          dayActivityMap,
          currentPlanDayIndex: calendarCurrentDay,
          migratedCompletedThru,
        },
        migratedCtx: showMigratedExecution
          ? {
              baseline: migrationBaseline,
              snapshot: activeSnap,
              schedule: scheduleLabels,
              status: smartStatus,
              progressPct,
              expenseCount: finiteNumber(
                activeSnap.expense_count,
                extrasRegCount
              ),
              invoiceStatusLabel:
                fieldCtx?.invoice_status_label || "See Invoices Hub",
            }
          : null,
      });

      const projectLaborBudget = finiteNumber(currentProject.laborBudget, 0);
      if ($("supSnapshotGrid")) {
        const panelOpts = { laborBudget: projectLaborBudget };
        if (!isServerListedSupervisorProject(pid)) {
          renderSupervisorOperationalPanel({});
        } else {
          renderSupervisorOperationalPanel({
            ...panelOpts,
            snapshot: panelState.snapshot,
            error:
              panelState.error &&
              !/refreshing field metrics/i.test(String(panelState.error))
                ? panelState.error
                : null,
          });
        }
      }

      if ($("supervisorKpis")) $("supervisorKpis").innerHTML = "";

      if (typeof console !== "undefined" && console.log) {
        console.log("[supervisor-filter] kpi count", uiList.length);
      }

      if (typeof console !== "undefined" && console.info) {
        console.info("[MG Supervisor trace]", "refresh render tables", {
          currentProjectId: pid,
          stateProjectId: supervisorProjectKey(state.projectId),
          entriesCount: state.entries.length,
          extrasCount: state.extras.length,
          changeOrdersCount: state.changeOrders.length,
        });
      }

      if ($("supEntriesBody")) {
        $("supEntriesBody").innerHTML = state.entries.map((row, index) => {
          const dateIso = normalizeDateInput(row.date);
          const dateLabel = dateIso ? formatDateUS(dateIso) || dateIso : row.date || "-";
          return `
          <tr>
            <td>${escapeHtml(dateLabel)}</td>
            <td>${escapeHtml(row.note || "-")}</td>
            <td>${Number(row.hours || 0).toFixed(2)}</td>
            <td>${Number(row.days || 0).toFixed(2)}</td>
            <td><button class="btn danger" data-delete-entry="${index}">Delete</button></td>
          </tr>
        `;
        }).join("");
        $("supEntriesBody").querySelectorAll("button[data-delete-entry]").forEach((button) => {
          button.onclick = async () => {
            const idx = Number(button.dataset.deleteEntry || -1);
            const row = state.entries[idx];
            if (row && row.reportId && isServerListedSupervisorProject(currentProject.id)) {
              try {
                const res = await fetch("/.netlify/functions/delete-project-report", {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ report_id: row.reportId }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data || data.ok !== true) {
                  const msg = (data && (data.error || data.message)) || `Delete failed (${res.status}).`;
                  window.alert(msg);
                  return;
                }
                delete supervisorProjectReportsCache[supervisorProjectKey(currentProject.id)];
                const fresh = await fetchProjectReports(currentProject.id);
                supervisorProjectReportsCache[supervisorProjectKey(currentProject.id)] =
                  fresh && fresh.ok === true && Array.isArray(fresh.reports)
                    ? { ok: true, reports: fresh.reports }
                    : { ok: false, reports: [] };
                state.locked = true;
                const merged = loadSupervisorReport(currentProject);
                saveSupervisorReport(currentProject.id, merged);
                await recalcProjectProfitIfListed(currentProject.id);
                await pullSupervisorProjectsFromApi();
                refresh();
                return;
              } catch (_e) {
                window.alert("Network error. Could not delete report.");
                return;
              }
            }
            if (row && row.reportId) {
              window.alert("This row is saved on the server; sync projects list to enable delete.");
              return;
            }
            state.entries.splice(idx, 1);
            saveSupervisorReport(currentProject.id, state);
            refresh();
          };
        });
      }

      if ($("supExtrasBody")) {
        $("supExtrasBody").innerHTML = state.extras.map((row, index) => {
          const dateIso = normalizeDateInput(row.date);
          const dateLabel = dateIso ? formatDateUS(dateIso) || dateIso : row.date || "-";
          return `
          <tr>
            <td>${escapeHtml(dateLabel)}</td>
            <td>${escapeHtml(row.item || "-")}</td>
            <td>${money(row.amount || 0, settings.currency)}</td>
            <td>${escapeHtml(row.note || "-")}</td>
            <td><button class="btn danger" data-delete-extra="${index}">Delete</button></td>
          </tr>
        `;
        }).join("");
        $("supExtrasBody").querySelectorAll("button[data-delete-extra]").forEach((button) => {
          button.onclick = async () => {
            const idx = Number(button.dataset.deleteExtra || -1);
            const row = state.extras[idx];
            if (row && row.expenseId && isServerListedSupervisorProject(currentProject.id)) {
              try {
                const res = await fetch("/.netlify/functions/delete-project-expense", {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ expense_id: row.expenseId }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data || data.ok !== true) {
                  const msg = (data && (data.error || data.message)) || `Delete failed (${res.status}).`;
                  window.alert(msg);
                  return;
                }
                delete supervisorProjectExpensesCache[supervisorProjectKey(currentProject.id)];
                const fresh = await fetchProjectExpenses(currentProject.id);
                supervisorProjectExpensesCache[supervisorProjectKey(currentProject.id)] =
                  fresh && fresh.ok === true && Array.isArray(fresh.expenses)
                    ? { ok: true, expenses: fresh.expenses }
                    : { ok: false, expenses: [] };
                state.locked = true;
                const merged = loadSupervisorReport(currentProject);
                saveSupervisorReport(currentProject.id, merged);
                await recalcProjectProfitIfListed(currentProject.id);
                await pullSupervisorProjectsFromApi();
                refresh();
                return;
              } catch (_e) {
                window.alert("Network error. Could not delete expense.");
                return;
              }
            }
            if (row && row.expenseId) {
              window.alert("This row is saved on the server; sync projects list to enable delete.");
              return;
            }
            state.extras.splice(idx, 1);
            saveSupervisorReport(currentProject.id, state);
            refresh();
          };
        });
      }

      supervisorLastRefreshedProjectId = pid;
    };

    if ($("btnAddSupEntry")) {
      $("btnAddSupEntry").onclick = async () => {
        const currentProject = resolveActiveSupervisorProject();
        if (!currentProject) return alert("No signed projects yet.");
        const state = loadSupervisorReport(currentProject);
        const rowPid = supervisorProjectKey(currentProject.id);
        const entry = {
          date: normalizeDateInput(val("supEntryDate")),
          hours: num("supEntryHours", 0),
          days: num("supEntryDays", 0),
          note: val("supEntryNote").trim(),
          serverProjectId: rowPid
        };
        if (!entry.date) return alert("Entry date is required.");
        if (entry.hours <= 0 && entry.days <= 0) return alert("Report hours or days worked.");

        if (isServerListedSupervisorProject(currentProject.id)) {
          try {
            const res = await fetch("/.netlify/functions/save-project-report", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                project_id: currentProject.id,
                entry_date: entry.date,
                hours: entry.hours,
                days: entry.days,
                note: entry.note,
                day_number: finiteNumber(supervisorActiveDayContext?.day_number, 0) || undefined,
                phase: String(supervisorActiveDayContext?.phase || "").trim() || undefined
              })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data || data.ok !== true) {
              const msg = (data && (data.error || data.message)) || `Save failed (${res.status}).`;
              window.alert(msg);
              return;
            }
            delete supervisorProjectReportsCache[supervisorProjectKey(currentProject.id)];
            const fresh = await fetchProjectReports(currentProject.id);
            supervisorProjectReportsCache[supervisorProjectKey(currentProject.id)] =
              fresh && fresh.ok === true && Array.isArray(fresh.reports)
                ? { ok: true, reports: fresh.reports }
                : { ok: false, reports: [] };
            state.locked = true;
            const merged = loadSupervisorReport(currentProject);
            saveSupervisorReport(currentProject.id, merged);
            setVal("supEntryDate", "");
            setNum("supEntryHours", 0);
            setNum("supEntryDays", 0);
            setVal("supEntryNote", "");
            await recalcProjectProfitIfListed(currentProject.id);
            await loadSupervisorOperationalSnapshot(currentProject.id, { force: true });
            await pullSupervisorProjectsFromApi();
            closeSupFieldModal("labor");
            refresh();
            return;
          } catch (_e) {
            window.alert("Network error. Could not save report.");
            return;
          }
        }

        state.locked = true;
        state.entries.unshift(entry);
        setVal("supEntryDate", "");
        setNum("supEntryHours", 0);
        setNum("supEntryDays", 0);
        setVal("supEntryNote", "");
        saveSupervisorReport(currentProject.id, state);
        closeSupFieldModal("labor");
        refresh();
      };
    }

    if ($("btnAddSupExtra")) {
      $("btnAddSupExtra").onclick = async () => {
        const currentProject = resolveActiveSupervisorProject();
        if (!currentProject) return alert("No signed projects yet.");
        const state = loadSupervisorReport(currentProject);
        const rowPid = supervisorProjectKey(currentProject.id);
        const extra = {
          date: normalizeDateInput(val("supExtraDate")),
          item: val("supExtraItem").trim(),
          amount: num("supExtraAmount", 0),
          note: val("supExtraNote").trim(),
          serverProjectId: rowPid
        };
        if (!extra.date) return alert("Extra expense date is required.");
        if (!extra.item) return alert("Extra expense concept is required.");
        if (extra.amount <= 0) return alert("Enter an amount greater than zero.");

        if (isServerListedSupervisorProject(currentProject.id)) {
          try {
            const res = await fetch("/.netlify/functions/save-project-expense", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                project_id: currentProject.id,
                expense_date: extra.date,
                amount: extra.amount,
                note: packSupervisorExpenseNote(extra.item, extra.note),
                day_number: finiteNumber(supervisorActiveDayContext?.day_number, 0) || undefined,
                phase: String(supervisorActiveDayContext?.phase || "").trim() || undefined
              })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data || data.ok !== true) {
              const msg = (data && (data.error || data.message)) || `Save failed (${res.status}).`;
              window.alert(msg);
              return;
            }
            delete supervisorProjectExpensesCache[supervisorProjectKey(currentProject.id)];
            const fresh = await fetchProjectExpenses(currentProject.id);
            supervisorProjectExpensesCache[supervisorProjectKey(currentProject.id)] =
              fresh && fresh.ok === true && Array.isArray(fresh.expenses)
                ? { ok: true, expenses: fresh.expenses }
                : { ok: false, expenses: [] };
            state.locked = true;
            const merged = loadSupervisorReport(currentProject);
            saveSupervisorReport(currentProject.id, merged);
            setVal("supExtraDate", "");
            setVal("supExtraItem", "");
            setNum("supExtraAmount", 0);
            setVal("supExtraNote", "");
            await recalcProjectProfitIfListed(currentProject.id);
            await loadSupervisorOperationalSnapshot(currentProject.id, { force: true });
            await pullSupervisorProjectsFromApi();
            closeSupFieldModal("extra");
            refresh();
            return;
          } catch (_e) {
            window.alert("Network error. Could not save expense.");
            return;
          }
        }

        state.locked = true;
        state.extras.unshift(extra);
        setVal("supExtraDate", "");
        setVal("supExtraItem", "");
        setNum("supExtraAmount", 0);
        setVal("supExtraNote", "");
        saveSupervisorReport(currentProject.id, state);
        closeSupFieldModal("extra");
        refresh();
      };
    }

    refresh();
  }

window.renderSupervisor = renderSupervisor;

  function formatDisplayDate(value) {
    const normalized = normalizeDateInput(value);
    if (!normalized) return "No date";
    const [year, month, day] = normalized.split("-");
    return `${month}/${day}/${year}`;
  }

  function buildPortfolioRows(settings) {
    const today = new Date().toISOString().slice(0, 10);

    return loadProjects().map((project) => {
      const report = loadSupervisorReport(project);
      const invoice = getProjectInvoiceState(project);
      const invoiceMetrics = calcInvoice(project, report, invoice);
      const hasInvoice = invoiceMetrics.total > 0 || invoice.invoiceNo || invoice.invoiceDate;
      const effectiveDueDate = invoice.dueDate || project.dueDate || "";
      let rawStatus = hasInvoice
        ? normalizeInvoiceStatus(invoice.status)
        : (project.status === "completed" ? "completed" : "draft");
      if (hasInvoice && rawStatus !== "paid" && effectiveDueDate && normalizeDateInput(effectiveDueDate) && normalizeDateInput(effectiveDueDate) < today) {
        rawStatus = "overdue";
      }
      if (!hasInvoice && effectiveDueDate && normalizeDateInput(effectiveDueDate) && normalizeDateInput(effectiveDueDate) < today) {
        rawStatus = "expired";
      }
      const changeOrderCount = Array.isArray(report.changeOrders) ? report.changeOrders.length : 0;
      const approvedChangeOrderCount = invoiceMetrics.changeOrders.length;
      const amount = invoiceMetrics.total > 0 ? invoiceMetrics.total : Math.max(finiteNumber(project.salePrice, 0), 0);
      const balance = invoiceMetrics.total > 0 ? invoiceMetrics.balance : amount;
      const primaryDate = invoice.invoiceDate || project.signedAt || project.dueDate;
      const rowType = hasInvoice ? "invoice" : "estimate";
      const paymentType = (invoice.depositApplied > 0 || invoice.receivedApplied > 0 || rawStatus === "partial" || rawStatus === "paid") ? "payment" : "";
      const extrasSpent = Array.isArray(report.extras) ? report.extras.reduce((sum, item) => sum + finiteNumber(item.amount, 0), 0) : 0;
      const finalCost = finiteNumber(project.laborBudget, 0) + extrasSpent;
      const soldAmount = Math.max(finiteNumber(project.salePrice, 0), 0) + invoiceMetrics.changeOrderAmount;
      const cashCollected = finiteNumber(invoice.depositApplied, 0) + finiteNumber(invoice.receivedApplied, 0);
      const estimatedMargin = soldAmount - finalCost;
      const priority = getHubPriority({
        invoiceNo: nonEmptyString(invoice.invoiceNo, "No invoice"),
        amount,
        balance,
        status: rawStatus,
        dueDateRaw: normalizeDateInput(effectiveDueDate)
      });
      const projectHealth = getProjectHealth({
        project,
        report,
        soldAmount,
        estimatedMargin,
        daysPastDue: priority.daysPastDue,
        balance,
        extraSpent: extrasSpent,
        dueDateRaw: normalizeDateInput(effectiveDueDate),
        projectStatus: project.status || "active"
      });

      return {
        id: project.id,
        projectId: project.id,
        serverInvoiceId: nonEmptyString(invoice.serverInvoiceId, invoice.supabaseInvoiceId),
        date: formatDisplayDate(primaryDate),
        dateRaw: normalizeDateInput(primaryDate),
        dueDate: formatDisplayDate(effectiveDueDate),
        dueDateRaw: normalizeDateInput(effectiveDueDate),
        promisedDate: formatDisplayDate(invoice.promisedDate),
        promisedDateRaw: normalizeDateInput(invoice.promisedDate),
        customer: project.clientName || "Sin cliente",
        title: project.projectName || "Project",
        hubInvoiceLabel: sanitizeInvoiceLabelInput(nonEmptyString(invoice.invoiceLabel)),
        status: rawStatus,
        invoiceStatus: normalizeInvoiceStatus(invoice.status),
        amount,
        balance,
        invoiceNo: nonEmptyString(invoice.invoiceNo, "No invoice"),
        baseAmount: invoice.baseAmount,
        depositApplied: invoice.depositApplied,
        receivedApplied: invoice.receivedApplied,
        collectionStage: invoice.collectionStage || "new",
        projectStatus: project.status || "active",
        rowType,
        paymentType,
        extraSpent: extrasSpent,
        finalCost,
        soldAmount,
        cashCollected,
        estimatedMargin,
        priorityScore: priority.score,
        priorityTone: priority.tone,
        nextAction: priority.nextAction,
        daysPastDue: priority.daysPastDue,
        projectHealthScore: projectHealth.score,
        projectHealthTone: projectHealth.tone,
        projectHealthLabel: projectHealth.label,
        changeOrderCount,
        approvedChangeOrderCount,
        location: nonEmptyString(project.location, project.address, project.clientName, ""),
        customerEmail: nonEmptyString(project.clientEmail),
        customerPhone: nonEmptyString(project.clientPhone),
        report,
        project,
        searchText: [
          project.id,
          project.projectName,
          project.clientName,
          project.clientEmail,
          project.clientPhone,
          project.location,
          invoice.invoiceNo,
          rawStatus,
          invoice.invoiceLabel
        ].join(" ").toLowerCase()
      };
    });
  }

  async function loadTenantInvoicesFromServer(filters = {}) {
    console.log("[HUB] fetching server invoices...");
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.payment_status) params.set("payment_status", filters.payment_status);
      if (filters.limit) params.set("limit", String(filters.limit));

      const res = await fetch(`/.netlify/functions/list-tenant-invoices?${params.toString()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });

      let data = {};
      try {
        data = await res.json();
      } catch (_parseErr) {
        data = {};
      }
      console.log("[HUB] server response:", data);

      if (!res.ok) {
        console.warn("[Invoice Hub] list-tenant-invoices failed", res.status);
        return { invoices: [], responseBody: data };
      }

      return {
        invoices: Array.isArray(data.invoices) ? data.invoices : [],
        responseBody: data
      };
    } catch (err) {
      console.warn("[Invoice Hub] server invoice load failed", err);
      return { invoices: [], responseBody: null };
    }
  }

  async function postHubQuoteManualStep(quoteId, action) {
    const res = await fetch("/.netlify/functions/hub-quote-manual-step", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ quote_id: quoteId, action })
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_e) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  async function postHubInvoiceArchiveDelete(invoiceId, action) {
    const res = await fetch("/.netlify/functions/hub-invoice-archive-delete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ invoice_id: invoiceId, action })
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_e) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  function normalizeServerInvoiceForHub(invoice) {
    const inv = invoice && typeof invoice === "object" ? invoice : {};
    const customerName = nonEmptyString(inv.customer_name, inv.client_name);
    const customerEmail = nonEmptyString(inv.customer_email, inv.client_email);
    const issueRaw = inv.issue_date || inv.invoice_date || "";
    const createdRaw = inv.created_at || "";
    let quoteWrap = inv.quotes;
    if (Array.isArray(quoteWrap)) quoteWrap = quoteWrap[0];
    const embed = quoteWrap && typeof quoteWrap === "object" ? quoteWrap : null;
    const quoteId = embed?.id != null ? String(embed.id).trim() : inv.quote_id != null ? String(inv.quote_id).trim() : "";
    const quoteAcceptedAt = embed?.accepted_at != null ? String(embed.accepted_at).trim() : "";
    const quoteDepositPaidAt = embed?.deposit_paid_at != null ? String(embed.deposit_paid_at).trim() : "";
    const quoteStatus = embed?.status != null ? String(embed.status).trim() : "";
    const quoteTotal = Math.max(finiteNumber(embed?.total, 0), 0);
    const hubInvoiceRawStatus = String(inv.status || "draft").toLowerCase();
    const tenantProjectId = inv.project_id != null ? String(inv.project_id).trim() : "";
    const amount = Number(inv.amount || 0);
    const dbPaid = Number(inv.paid_amount || 0);
    const ledgerRaw = inv.ledger_paid_total;
    let paidAmount = dbPaid;
    if (ledgerRaw != null && Number.isFinite(Number(ledgerRaw))) {
      paidAmount = Math.max(dbPaid, Number(ledgerRaw));
    }
    const partialForContract = {
      quoteId,
      quoteTotal,
      tenantProjectId,
      projectName: nonEmptyString(inv.project_name, inv.description, "Invoice"),
      clientName: customerName,
      amount
    };
    const contractTotal = resolveContractTotalForServerInvoiceNorm(partialForContract);
    const balanceDue = Math.max(0, contractTotal - paidAmount);
    return {
      source: "server_invoice",
      id: inv.id,
      invoiceId: inv.id,
      tenant_id: inv.tenant_id,
      hubInvoiceRawStatus,
      quoteId,
      quoteAcceptedAt,
      quoteDepositPaidAt,
      quoteStatus,
      quoteTotal,
      publicToken: nonEmptyString(inv.public_token),
      publicUrl: inv.public_token ? `/invoice-public.html?token=${encodeURIComponent(inv.public_token)}` : "",
      invoiceNo: nonEmptyString(inv.invoice_no),
      projectName: nonEmptyString(inv.project_name, inv.description, "Invoice"),
      clientName: customerName,
      clientEmail: customerEmail,
      amount,
      paidAmount,
      balanceDue,
      status: hubInvoiceRawStatus,
      paymentStatus: String(inv.payment_status || "").toLowerCase(),
      invoiceDate: issueRaw || createdRaw || "",
      dueDate: inv.due_date || "",
      sentAt: inv.sent_at || "",
      paidAt: inv.paid_at || "",
      createdAt: createdRaw,
      updatedAt: inv.updated_at || "",
      tenantProjectId,
      invoiceLabel: sanitizeInvoiceLabelInput(nonEmptyString(inv.invoice_label))
    };
  }

  function hubServerInvoiceIsFullyPaid(norm) {
    const balDue = Math.max(finiteNumber(norm?.balanceDue, 0), 0);
    if (balDue <= 0.005) return true;
    const contractTotal = resolveContractTotalForServerInvoiceNorm(norm);
    const paid = Math.max(finiteNumber(norm?.paidAmount, 0), 0);
    if (contractTotal > 0 && paid + 0.005 >= contractTotal) return true;
    return false;
  }

  function resolveContractTotalForServerInvoiceNorm(norm) {
    const quoteTotal = Math.max(finiteNumber(norm?.quoteTotal, 0), 0);
    if (quoteTotal > 0) return quoteTotal;
    const projects = loadProjects();
    const quoteId = String(norm?.quoteId || "").trim();
    const tenantProjectId = String(norm?.tenantProjectId || "").trim();
    const invoiceProjectName = String(norm?.projectName || "").trim().toLowerCase();
    const invoiceClientName = String(norm?.clientName || "").trim().toLowerCase();
    const byStrongLink = projects.find((p) => {
      const pQuoteId = String(p?.quoteId || p?.quote_id || "").trim();
      if (quoteId && pQuoteId && pQuoteId === quoteId) return true;
      const pId = String(p?.id || "").trim();
      if (tenantProjectId && pId && pId === tenantProjectId) return true;
      return false;
    });
    if (byStrongLink) return Math.max(finiteNumber(byStrongLink.salePrice, 0), 0);
    const byName = projects.find((p) => {
      const pName = String(p?.projectName || "").trim().toLowerCase();
      const pClient = String(p?.clientName || "").trim().toLowerCase();
      return pName && pClient && pName === invoiceProjectName && pClient === invoiceClientName;
    });
    if (byName) return Math.max(finiteNumber(byName.salePrice, 0), 0);
    return Math.max(finiteNumber(norm?.amount, 0), 0);
  }

  function hubServerInvoiceStatusForDisplay(norm) {
    const today = new Date().toISOString().slice(0, 10);
    let raw = String(norm?.hubInvoiceRawStatus || norm?.status || "draft").toLowerCase();
    if (raw === "archived") return "archived";
    if (raw === "void") return "void";
    if (hubServerInvoiceIsFullyPaid(norm)) return "paid";
    if (raw === "open") raw = "draft";
    const sentAtRaw = String(norm?.sentAt || "").trim();
    if (sentAtRaw && raw !== "paid" && raw !== "void") {
      raw = "sent";
    }
    const dueRaw = normalizeDateInput(norm?.dueDate || "");
    const bal = Math.max(finiteNumber(norm?.balanceDue, 0), 0);
    if (raw !== "paid" && raw !== "void" && dueRaw && dueRaw < today && bal > 0) {
      raw = "overdue";
    }
    return raw;
  }

  function hubServerInvoiceStatusForActions(norm) {
    const s = hubServerInvoiceStatusForDisplay(norm);
    if (s === "paid") return "paid";
    if (s === "partial") return "partial";
    if (s === "sent" || s === "overdue") return "sent";
    if (s === "void") return "paid";
    return "draft";
  }

  /** Hub table Status column for server invoices when quote lifecycle overrides raw invoice row. */
  function hubServerInvoiceLifecycleDisplayStatus(norm) {
    const rawInv = String(norm?.hubInvoiceRawStatus || norm?.status || "").toLowerCase();
    if (rawInv === "archived") return "archived";
    if (rawInv === "void") return "void";
    if (hubServerInvoiceIsFullyPaid(norm)) return "paid";
    const ps = String(norm?.paymentStatus || "").toLowerCase();
    const qDep = String(norm?.quoteDepositPaidAt || "").trim();
    if (ps === "deposit_paid" || qDep) return "deposit_paid";
    const qAcc = String(norm?.quoteAcceptedAt || "").trim();
    const qs = String(norm?.quoteStatus || "").toLowerCase();
    if (qAcc || qs === "accepted") return "accepted";
    return hubServerInvoiceStatusForDisplay(norm);
  }

  function hubServerQuoteIsAccepted(row) {
    if (!row || row.hubRowSource !== "server_invoice") return false;
    if (nonEmptyString(row.hubQuoteAcceptedAt)) return true;
    return String(row.hubQuoteStatus || "").trim().toLowerCase() === "accepted";
  }

  function hubServerDepositRecorded(row) {
    const ps = String(row.hubInvoicePaymentStatus || "").toLowerCase();
    return ps === "deposit_paid" || nonEmptyString(row.hubQuoteDepositPaidAt);
  }

  function hubRowMatchesNormalizedServerInvoice(existingRow, norm) {
    if (!norm) return false;
    const inv = existingRow?.project?.invoice;
    const pub = nonEmptyString(inv?.publicToken);
    if (norm.publicToken && pub && pub === norm.publicToken) return true;
    const localNo = String(inv?.invoiceNo || "").trim().toLowerCase();
    const serverNo = String(norm.invoiceNo || "").trim().toLowerCase();
    if (serverNo && localNo && localNo === serverNo) return true;
    const sid = String(
      nonEmptyString(existingRow?.serverInvoiceId, inv?.serverInvoiceId, inv?.supabaseInvoiceId) || ""
    ).trim();
    if (sid && norm.invoiceId && sid === norm.invoiceId) return true;
    return false;
  }

  /** Align merged local Hub row with normalized server invoice (ledger-aware paid/balance/status). */
  function syncHubRowFromServerInvoiceNorm(row, norm) {
    if (!row || !norm?.invoiceId) return;
    if (!hubRowMatchesNormalizedServerInvoice(row, norm)) return;
    const srv = buildPortfolioRowFromServerInvoiceNorm(norm);
    row.status = srv.status;
    row.balance = srv.balance;
    row.invoiceStatus = srv.invoiceStatus;
    row.amount = srv.amount;
    row.baseAmount = srv.baseAmount;
    row.cashCollected = srv.cashCollected;
    row.receivedApplied = srv.receivedApplied;
    row.depositApplied = srv.depositApplied;
    row.paymentType = srv.paymentType;
    row.projectContractTotal = srv.projectContractTotal;
    row.hubInvoiceRawStatus = srv.hubInvoiceRawStatus;
    row.hubQuoteId = srv.hubQuoteId || row.hubQuoteId;
    row.hubTenantProjectId = srv.hubTenantProjectId || row.hubTenantProjectId;
    row.hubQuoteAcceptedAt = srv.hubQuoteAcceptedAt;
    row.hubQuoteDepositPaidAt = srv.hubQuoteDepositPaidAt;
    row.hubQuoteStatus = srv.hubQuoteStatus;
    row.hubInvoicePaymentStatus = srv.hubInvoicePaymentStatus;
    row.serverInvoiceId = srv.serverInvoiceId;
    row.nextAction = getHubRowCollectNextActionLabel(row);
    const pr = getHubPriority(row);
    row.priorityScore = pr.score;
    row.priorityTone = pr.tone;
    row.daysPastDue = pr.daysPastDue;
    const health = getProjectHealth(row);
    row.projectHealthScore = health.score;
    row.projectHealthTone = health.tone;
    row.projectHealthLabel = health.label;
    if (row.project?.invoice) {
      row.project.invoice.receivedApplied = srv.receivedApplied;
      row.project.invoice.depositApplied = srv.depositApplied;
      row.project.invoice.status = srv.invoiceStatus;
      row.project.invoice.baseAmount = srv.baseAmount;
      row.project.salePrice = row.projectContractTotal;
    }
  }

  function mergeHubRows(existingRows, normalizedServerRows) {
    const existingLen = Array.isArray(existingRows) ? existingRows.length : 0;
    const normalizedLen = Array.isArray(normalizedServerRows) ? normalizedServerRows.length : 0;
    console.log("[HUB] merging rows:", existingLen, normalizedLen);
    const out = Array.isArray(existingRows) ? existingRows.slice() : [];
    const seenToken = new Set();
    const seenId = new Set();
    const seenNo = new Set();
    out.forEach((r) => {
      const t = nonEmptyString(r?.project?.invoice?.publicToken);
      if (t) seenToken.add(t);
      if (r?.serverInvoiceId) seenId.add(r.serverInvoiceId);
      const no = String(r?.project?.invoice?.invoiceNo || r?.invoiceNo || "").trim().toLowerCase();
      if (no && no !== "no invoice") seenNo.add(no);
    });
    const normalizedList = Array.isArray(normalizedServerRows) ? normalizedServerRows : [];
    normalizedList.forEach((norm) => {
      if (!norm?.invoiceId) return;
      const dup = out.find((e) => hubRowMatchesNormalizedServerInvoice(e, norm));
      if (dup) {
        syncHubRowFromServerInvoiceNorm(dup, norm);
        if (norm.publicToken) seenToken.add(norm.publicToken);
        seenId.add(norm.invoiceId);
        const snoDup = String(norm.invoiceNo || "").trim().toLowerCase();
        if (snoDup) seenNo.add(snoDup);
        return;
      }
      if (norm.publicToken && seenToken.has(norm.publicToken)) return;
      if (norm.invoiceId && seenId.has(norm.invoiceId)) return;
      const sno = String(norm.invoiceNo || "").trim().toLowerCase();
      if (sno && seenNo.has(sno)) return;
      if (norm.publicToken) seenToken.add(norm.publicToken);
      seenId.add(norm.invoiceId);
      if (sno) seenNo.add(sno);
      out.push(buildPortfolioRowFromServerInvoiceNorm(norm));
    });
    return out;
  }

  function buildPortfolioRowFromServerInvoiceNorm(norm) {
    const serverInvoiceId = norm.invoiceId;
    const sidRaw = serverInvoiceId != null ? String(serverInvoiceId).trim() : "";
    const projectId =
      sidRaw && MG_SERVER_INVOICE_UUID_RE.test(sidRaw) ? sidRaw : sidRaw ? `svc-inv-${sidRaw}` : `svc-inv-${Date.now()}`;
    const displayStatus = hubServerInvoiceLifecycleDisplayStatus(norm);
    const actionStatus = hubServerInvoiceStatusForActions(norm);
    const amount = Math.max(finiteNumber(norm.amount, 0), 0);
    const contractTotal = resolveContractTotalForServerInvoiceNorm(norm);
    const paid = Math.max(finiteNumber(norm.paidAmount, 0), 0);
    const balance = Math.max(contractTotal - paid, 0);
    const primaryRaw = norm.invoiceDate || norm.createdAt || "";
    const effectiveDue = norm.dueDate || "";
    const invoiceNoDisplay = nonEmptyString(norm.invoiceNo, "No invoice");
    const customer = norm.clientName || "Sin cliente";
    const title = norm.projectName || "Invoice";
    const stubReport = { changeOrders: [], extras: [], laborBudget: 0, projectedEndDate: "" };
    const stubProject = {
      id: projectId,
      projectName: title,
      clientName: norm.clientName || "",
      clientEmail: norm.clientEmail || "",
      clientPhone: "",
      location: "",
      dueDate: effectiveDue,
      salePrice: contractTotal,
      laborBudget: 0,
      status: "active",
      invoice: {
        invoiceNo: norm.invoiceNo || "",
        invoiceDate: normalizeDateInput(primaryRaw) || "",
        dueDate: normalizeDateInput(effectiveDue) || "",
        promisedDate: "",
        baseAmount: amount,
        depositApplied: 0,
        receivedApplied: paid,
        status: actionStatus,
        collectionStage: "new",
        payments: [],
        activity: [],
        publicToken: norm.publicToken || "",
        publicUrl: norm.publicUrl || "",
        paymentLink: "",
        paymentStatus: norm.paymentStatus || "",
        quoteId: norm.quoteId || "",
        serverInvoiceId: String(serverInvoiceId || "").trim(),
        invoiceLabel: sanitizeInvoiceLabelInput(nonEmptyString(norm.invoiceLabel))
      }
    };
    const row = {
      id: projectId,
      projectId,
      serverInvoiceId,
      hubQuoteId: norm.quoteId || "",
      hubTenantProjectId: norm.tenantProjectId && MG_SERVER_INVOICE_UUID_RE.test(String(norm.tenantProjectId).trim())
        ? String(norm.tenantProjectId).trim()
        : "",
      hubQuoteAcceptedAt: norm.quoteAcceptedAt || "",
      hubQuoteDepositPaidAt: norm.quoteDepositPaidAt || "",
      hubQuoteStatus: norm.quoteStatus || "",
      hubInvoicePaymentStatus: norm.paymentStatus || "",
      hubInvoiceRawStatus: norm.hubInvoiceRawStatus || String(norm.status || "").toLowerCase(),
      projectContractTotal: contractTotal,
      hubRowSource: "server_invoice",
      hubSourceLabel: "Server",
      date: formatDisplayDate(primaryRaw),
      dateRaw: normalizeDateInput(primaryRaw),
      dueDate: formatDisplayDate(effectiveDue),
      dueDateRaw: normalizeDateInput(effectiveDue),
      promisedDate: "No date",
      promisedDateRaw: "",
      customer,
      title,
      status: displayStatus,
      invoiceStatus: actionStatus,
      amount,
      balance,
      invoiceNo: invoiceNoDisplay,
      baseAmount: amount,
      depositApplied: 0,
      receivedApplied: paid,
      collectionStage: "new",
      projectStatus: "active",
      rowType: "invoice",
      paymentType: paid > 0 ? "payment" : "",
      extraSpent: 0,
      finalCost: 0,
      soldAmount: contractTotal,
      cashCollected: paid,
      estimatedMargin: 0,
      changeOrderCount: 0,
      approvedChangeOrderCount: 0,
      location: nonEmptyString(norm.clientEmail, customer),
      customerEmail: norm.clientEmail || "",
      customerPhone: "",
      report: stubReport,
      project: stubProject,
      hubInvoiceLabel: sanitizeInvoiceLabelInput(nonEmptyString(norm.invoiceLabel)),
      searchText: ""
    };
    row.projectId = row.serverInvoiceId || row.id;
    row.id = row.projectId;
    row.project.id = row.projectId;
    row.searchText = [
      row.projectId,
      title,
      customer,
      norm.clientEmail,
      norm.invoiceNo,
      displayStatus,
      "server_invoice",
      norm.publicToken,
      norm.quoteAcceptedAt,
      norm.quoteDepositPaidAt,
      norm.paymentStatus,
      norm.quoteStatus,
      norm.invoiceLabel
    ]
      .join(" ")
      .toLowerCase();
    const priority = getHubPriority(row);
    row.priorityScore = priority.score;
    row.priorityTone = priority.tone;
    row.nextAction = getHubRowCollectNextActionLabel(row);
    row.daysPastDue = priority.daysPastDue;
    const health = getProjectHealth(row);
    row.projectHealthScore = health.score;
    row.projectHealthTone = health.tone;
    row.projectHealthLabel = health.label;
    return row;
  }

  function compareHubValues(left, right, sortKey) {
    const numericKeys = new Set(["amount", "balance"]);
    if (numericKeys.has(sortKey)) {
      return finiteNumber(left, 0) - finiteNumber(right, 0);
    }
    const leftValue = String(left || "").toLowerCase();
    const rightValue = String(right || "").toLowerCase();
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  }

  const MG_HUB_INVOICE_VIEW_MODES = new Set(["all", "ready_to_bill", "sent", "paid", "needs_action"]);

  function hubRowMatchesReadyToBillView(row) {
    const na = String(row?.nextAction || "").toLowerCase();
    if (na.includes("send invoice")) return true;
    return row?.rowType === "estimate" && finiteNumber(row?.amount, 0) > 0 && row?.projectStatus !== "completed";
  }

  function hubRowMatchesWaitingPaymentKpi(row) {
    const bal = finiteNumber(row?.balance, 0);
    if (bal <= 0) return false;
    return ["sent", "partial", "overdue", "expired"].includes(String(row?.status || "").toLowerCase());
  }

  function hubTabPresetToViewMode(tab, preset) {
    const t = tab || "all";
    const pr = preset === undefined || preset === null ? "" : String(preset);
    if (pr === "action") return "needs_action";
    if (pr === "ready") return "ready_to_bill";
    if (t === "all" && pr === "") return "all";
    return "all";
  }

  function hubViewModeToTabPreset(mode) {
    switch (mode) {
      case "needs_action":
        return { tab: "all", preset: "action" };
      case "ready_to_bill":
        return { tab: "all", preset: "ready" };
      case "sent":
      case "paid":
      case "all":
      default:
        return { tab: "all", preset: "" };
    }
  }

  function hubRowMatchesPaymentsView(row) {
    if (row?.paymentType === "payment") return true;
    if (["partial", "paid"].includes(row?.status)) return true;
    if (finiteNumber(row?.depositApplied, 0) > 0 || finiteNumber(row?.receivedApplied, 0) > 0) return true;
    const inv = row?.project?.invoice;
    if (inv && (finiteNumber(inv.depositApplied, 0) > 0 || finiteNumber(inv.receivedApplied, 0) > 0)) return true;
    const ps = String(inv?.paymentStatus || row?.paymentStatus || "").toLowerCase();
    if (ps && ["deposit_paid", "paid", "partial"].includes(ps)) return true;
    return false;
  }

  function hubInvoiceHubViewTitleLabel(mode) {
    const labels = {
      all: "All",
      ready_to_bill: "Ready To Bill",
      sent: "Sent",
      paid: "Paid",
      needs_action: "Needs Action"
    };
    return labels[mode] || "All";
  }

  function getHubRowCollectNextActionLabel(row) {
    const st = String(row?.status || "").toLowerCase();
    const bal = finiteNumber(row?.balance, 0);
    if (st === "paid" || st === "completed" || st === "void") return "Completed";
    if (row?.hubRowSource === "server_invoice") {
      if (String(row.hubInvoiceRawStatus || "").toLowerCase() === "archived") return "Completed";
      if (bal <= 0) return "Completed";
      const ps = String(row.hubInvoicePaymentStatus || row?.project?.invoice?.paymentStatus || "").toLowerCase();
      const qDep = nonEmptyString(row.hubQuoteDepositPaidAt);
      if (ps === "deposit_paid" || qDep) return "Start project";
      if (hubServerQuoteIsAccepted(row)) return "Check deposit pending";
    }
    if (row?.rowType === "estimate" && finiteNumber(row?.amount, 0) > 0 && row?.projectStatus !== "completed") return "Send Invoice";
    if (row?.rowType === "invoice" && st === "draft" && finiteNumber(row?.amount, 0) > 0) return "Send Invoice";
    if (["sent", "partial"].includes(st) && bal > 0) return "Invoice balance pending";
    if (["overdue", "expired"].includes(st) && bal > 0) return "Remaining balance due";
    if (bal > 0) return "Remaining balance due";
    return "Completed";
  }

  /** Hub table display only: rows that should float to the top (same cases as "Send Invoice" next-action). */
  function hubRowIsSendNowCollectPriority(row) {
    return getHubRowCollectNextActionLabel(row) === "Send Invoice";
  }

  /**
   * Visual order for Invoice Hub table: send-now rows first, then higher balance, then active column sort.
   * Does not change underlying merge/filter logic.
   */
  function sortHubRowsForCollectDisplay(rows, sortKey, sortDir) {
    return rows.slice().sort((a, b) => {
      const pa = hubRowIsSendNowCollectPriority(a) ? 1 : 0;
      const pb = hubRowIsSendNowCollectPriority(b) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      const balA = finiteNumber(a?.balance, 0);
      const balB = finiteNumber(b?.balance, 0);
      if (balA !== balB) return balB - balA;
      const c = compareHubValues(a?.[sortKey], b?.[sortKey], sortKey);
      return sortDir === "asc" ? c : -c;
    });
  }

  /** One-line “Project — $balance” for KPI action card (no suffix). */
  function hubKpiStartWithValueLine(rows, settings) {
    if (!Array.isArray(rows) || !rows.length) return "";
    const row = rows[0];
    const name = nonEmptyString(row.title, row.customer) || "This job";
    const balStr = money(finiteNumber(row.balance, 0), settings.currency);
    return `${name} — ${balStr}`;
  }

  function hubHeroStartWithLine(rows, settings) {
    if (!rows.length) return "No invoices need action right now.";
    const row = rows[0];
    const name = nonEmptyString(row.title, row.customer) || "This job";
    const balStr = money(finiteNumber(row.balance, 0), settings.currency);
    if (hubRowIsSendNowCollectPriority(row)) {
      return `Start with: ${name} — ${balStr} ready to send`;
    }
    const na = getHubRowCollectNextActionLabel(row);
    if (na === "Invoice balance pending") return `Start with: ${name} — ${balStr} invoice balance pending`;
    if (na === "Remaining balance due") return `Start with: ${name} — ${balStr} remaining balance due`;
    if (na === "Check deposit pending") return `Start with: ${name} — ${balStr} check deposit pending`;
    if (na === "Start project") return `Start with: ${name} — ${balStr} start project`;
    if (na === "Completed") return `Start with: ${name} — ${balStr} (completed)`;
    return `Start with: ${name} — ${balStr}`;
  }

  function hubTableNextActionDisplay(row, rankIndex) {
    const raw = getHubRowCollectNextActionLabel(row);
    if (raw === "Send Invoice") {
      if (rankIndex === 0) return "Send now • High priority";
      return "Send now";
    }
    return raw;
  }

  function duplicateHubProject(projectId) {
    const sourceProject = getProjectById(projectId);
    if (!sourceProject) return null;
    const sourceReport = loadSupervisorReport(sourceProject);
    const duplicateId = `PRJ-${Date.now()}`;
    const duplicateProject = {
      ...sourceProject,
      id: duplicateId,
      status: "active",
      source: `${sourceProject.source || "hub"}-duplicate`,
      signedAt: new Date().toISOString(),
      completedAt: "",
      invoice: undefined,
      projectName: `${sourceProject.projectName || "Project"} Copy`,
      notes: sourceProject.notes || ""
    };
    upsertProject(duplicateProject);
    saveSupervisorSelectedProjectId(duplicateId);
    saveSupervisorReport(duplicateId, {
      ...buildDefaultSupervisorReport(duplicateProject),
      entries: [],
      extras: [],
      changeOrders: [],
      changeOrderDraft: buildDefaultChangeOrderDraft(duplicateProject),
      estimatedDays: finiteNumber(sourceReport?.estimatedDays, duplicateProject.estimatedDays),
      laborBudget: finiteNumber(sourceReport?.laborBudget, duplicateProject.laborBudget),
      dueDate: normalizeDateInput(sourceReport?.dueDate || duplicateProject.dueDate)
    });
    return duplicateProject;
  }

  function duplicateHubInvoiceProject(projectId) {
    const sourceProject = getProjectById(projectId);
    if (!sourceProject) return null;
    const sourceReport = loadSupervisorReport(sourceProject);
    const sourceInvoice = getProjectInvoiceState(sourceProject);
    const duplicateId = `PRJ-${Date.now()}`;
    const duplicateProject = {
      ...sourceProject,
      id: duplicateId,
      status: "active",
      source: `${sourceProject.source || "hub"}-invoice-duplicate`,
      signedAt: new Date().toISOString(),
      completedAt: "",
      projectName: `${sourceProject.projectName || "Project"} Invoice Copy`,
      invoice: {
        ...sourceInvoice,
        invoiceNo: `INV-${Date.now()}`,
        invoiceDate: new Date().toISOString().slice(0, 10),
        dueDate: sourceInvoice.dueDate || sourceProject.dueDate || "",
        promisedDate: "",
        depositApplied: 0,
        receivedApplied: 0,
        status: "draft",
        collectionStage: "new",
        payments: [],
        activity: appendInvoiceActivity({
          ...sourceInvoice,
          activity: []
        }, "Invoice duplicated into a new project shell.", undefined, "invoice"),
        publicToken: "",
        publicUrl: "",
        paymentLink: ""
      }
    };
    upsertProject(duplicateProject);
    saveSupervisorSelectedProjectId(duplicateId);
    saveSupervisorReport(duplicateId, {
      ...buildDefaultSupervisorReport(duplicateProject),
      entries: [],
      extras: [],
      changeOrders: Array.isArray(sourceReport.changeOrders) ? sourceReport.changeOrders.map((row) => ({
        ...row,
        applied: false,
        appliedAt: ""
      })) : [],
      changeOrderDraft: buildDefaultChangeOrderDraft(duplicateProject),
      estimatedDays: finiteNumber(sourceReport?.estimatedDays, duplicateProject.estimatedDays),
      laborBudget: finiteNumber(sourceReport?.laborBudget, duplicateProject.laborBudget),
      dueDate: normalizeDateInput(sourceReport?.dueDate || duplicateProject.dueDate)
    });
    return duplicateProject;
  }

  function buildHubCommunication(templateKey, row, settings) {
    const templates = loadHubTemplates();
    const template = templates[templateKey];
    if (!template) return { subject: "", body: "" };
    const invoice = getProjectInvoiceState(row.project);
    const metrics = calcInvoice(row.project, row.report, invoice);
    const tokens = {
      customer: row.customer || "",
      project: row.title || "",
      invoice_no: invoice.invoiceNo || "No invoice",
      invoice_date: invoice.invoiceDate || "-",
      due_date: invoice.dueDate || row.project?.dueDate || "-",
      total: money(metrics.total, settings.currency),
      balance: money(metrics.balance, settings.currency),
      status: row.status || "",
      location: row.location || ""
    };
    const compile = (text) => String(text || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key) => tokens[key] ?? "");
    return {
      subject: compile(template.subject),
      body: compile(template.body)
    };
  }

  function setHubCollectionStage(projectId, stage) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const invoice = buildHubInvoiceState(project, report, { collectionStage: stage });
    invoice.activity = appendInvoiceActivity(invoice, `Collections stage updated to ${stage}.`, undefined, "collections");
    saveProjectInvoiceState(projectId, invoice);
  }

  function setHubPromise(projectId, promisedDate) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const invoice = buildHubInvoiceState(project, report, {
      collectionStage: "promised",
      promisedDate
    });
    invoice.activity = appendInvoiceActivity(invoice, `Promise date updated to ${normalizeDateInput(promisedDate) || "none"}.`, undefined, "collections");
    saveProjectInvoiceState(projectId, invoice);
  }

  function getDaysPastDue(dateValue) {
    const normalized = normalizeDateInput(dateValue);
    if (!normalized) return 0;
    const due = new Date(normalized);
    due.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.max(Math.floor((today - due) / (1000 * 60 * 60 * 24)), 0);
  }

  function getHubPriority(row) {
    if (row?.status === "void") {
      return { score: 0, tone: "green", nextAction: "Void", daysPastDue: 0 };
    }
    const balance = Math.max(finiteNumber(row?.balance, 0), 0);
    const daysPastDue = getDaysPastDue(row?.dueDateRaw || row?.project?.dueDate);
    const hasInvoice = Boolean(row?.invoiceNo && row.invoiceNo !== "No invoice");
    let score = 0;
    if (hasInvoice) score += 20;
    if (["sent", "partial", "overdue", "expired"].includes(row?.status)) score += 20;
    if (row?.status === "partial") score += 12;
    if (row?.status === "overdue") score += 18;
    if (row?.status === "expired") score += 24;
    if (balance >= 10000) score += 22;
    else if (balance >= 5000) score += 16;
    else if (balance >= 1000) score += 10;
    score += Math.min(daysPastDue, 60);

    let tone = "green";
    let nextAction = "Healthy";
    if (!hasInvoice && finiteNumber(row?.amount, 0) > 0) {
      tone = "amber";
      nextAction = "Convert to invoice";
      score += 15;
    } else if (row?.status === "draft") {
      tone = "amber";
      nextAction = "Send invoice";
      score += 10;
    } else if (["sent", "partial", "overdue", "expired"].includes(row?.status) && balance > 0) {
      tone = daysPastDue > 30 || row?.status === "expired" ? "red" : "amber";
      nextAction = daysPastDue > 0 ? "Invoice balance follow-up" : "Schedule client follow-up";
    }
    if (row?.status === "paid") {
      score = 0;
      tone = "green";
      nextAction = "Paid";
    }
    return { score, tone, nextAction, daysPastDue };
  }

  function getProjectHealth(row) {
    const soldAmount = Math.max(finiteNumber(row?.soldAmount, 0), 0);
    const balance = Math.max(finiteNumber(row?.balance, 0), 0);
    const extrasSpent = Math.max(finiteNumber(row?.extraSpent, 0), 0);
    const laborBudget = Math.max(finiteNumber(row?.project?.laborBudget || row?.report?.laborBudget, 0), 0);
    const estimatedMargin = finiteNumber(row?.estimatedMargin, 0);
    const daysPastDue = Math.max(finiteNumber(row?.daysPastDue, 0), 0);
    const projectedEndDate = normalizeDateInput(row?.report?.projectedEndDate);
    const dueDate = normalizeDateInput(row?.dueDateRaw || row?.project?.dueDate);
    let score = 100;
    if (soldAmount > 0 && estimatedMargin < soldAmount * 0.12) score -= 18;
    if (soldAmount > 0 && estimatedMargin < 0) score -= 24;
    if (laborBudget > 0 && extrasSpent > laborBudget * 0.08) score -= 12;
    if (balance > 0) score -= 8;
    if (daysPastDue > 0) score -= Math.min(22, daysPastDue);
    if (projectedEndDate && dueDate && projectedEndDate > dueDate) score -= 14;
    if (row?.projectStatus === "completed" && balance <= 0) score += 8;
    score = clamp(score, 0, 100);

    let tone = "green";
    let label = "Healthy";
    if (score < 80) {
      tone = "amber";
      label = "Watch";
    }
    if (score < 55) {
      tone = "red";
      label = "At Risk";
    }
    return { score, tone, label };
  }

  function buildClientCollectionsScore(rows, settings) {
    const grouped = rows.reduce((acc, row) => {
      const key = nonEmptyString(row.customer, "Sin cliente");
      if (!acc[key]) {
        acc[key] = {
          customer: key,
          openBalance: 0,
          overdueBalance: 0,
          projectCount: 0,
          brokenPromises: 0,
          paidTotal: 0
        };
      }
      acc[key].projectCount += 1;
      acc[key].openBalance += Math.max(finiteNumber(row.balance, 0), 0);
      if (["overdue", "expired"].includes(row.status)) {
        acc[key].overdueBalance += Math.max(finiteNumber(row.balance, 0), 0);
      }
      if (row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10) && finiteNumber(row.balance, 0) > 0) {
        acc[key].brokenPromises += 1;
      }
      if (row.status === "paid") {
        acc[key].paidTotal += Math.max(finiteNumber(row.amount, 0), 0);
      }
      return acc;
    }, {});

    return Object.values(grouped)
      .map((item) => ({
        ...item,
        score: clamp(
          (item.openBalance > 0 ? 30 : 0) +
          (item.overdueBalance > 0 ? 30 : 0) +
          (item.brokenPromises * 18) +
          Math.min(item.projectCount * 4, 16),
          0,
          100
        ),
        openBalanceLabel: money(item.openBalance, settings.currency),
        overdueBalanceLabel: money(item.overdueBalance, settings.currency),
        paidTotalLabel: money(item.paidTotal, settings.currency)
      }))
      .sort((left, right) => right.score - left.score || right.openBalance - left.openBalance)
      .slice(0, 6);
  }

  function buildProfitabilityRanking(rows, settings) {
    return rows
      .filter((row) => finiteNumber(row.soldAmount, 0) > 0)
      .map((row) => ({
        title: row.title,
        customer: row.customer,
        margin: finiteNumber(row.estimatedMargin, 0),
        marginLabel: money(row.estimatedMargin, settings.currency),
        soldLabel: money(row.soldAmount, settings.currency),
        healthLabel: `${row.projectHealthScore}% ${row.projectHealthLabel}`,
        tone: row.projectHealthTone || "green"
      }))
      .sort((left, right) => right.margin - left.margin)
      .slice(0, 6);
  }

  function buildCollectionsPlaybook(rows, settings) {
    const groups = {
      bill_now: rows.filter((row) => row.rowType === "estimate" && finiteNumber(row.amount, 0) > 0 && row.projectStatus !== "completed"),
      send_now: rows.filter((row) => row.status === "draft" && Boolean(row.invoiceNo) && finiteNumber(row.amount, 0) > 0),
      follow_up: rows.filter((row) => ["sent", "partial"].includes(row.status) && finiteNumber(row.balance, 0) > 0),
      escalate_now: rows.filter((row) => ["overdue", "expired"].includes(row.status) || (row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10) && finiteNumber(row.balance, 0) > 0)),
      close_out: rows.filter((row) => row.projectStatus === "completed" && finiteNumber(row.balance, 0) <= 0)
    };
    return [
      ["Bill Now", String(groups.bill_now.length), "Estimates listos para invoice", "ready", "estimates"],
      ["Send Now", String(groups.send_now.length), "Invoices en draft listas para envio", "", "invoices"],
      ["Follow Up", String(groups.follow_up.length), "Sent y partial con saldo", "action", "collections"],
      ["Escalate", String(groups.escalate_now.length), "Overdue o promesas rotas", "promises", "collections"],
      ["Close Out", String(groups.close_out.length), "Proyectos cobrados y terminados", "", "closeout"]
    ];
  }

  function buildDailyDigest(rows, settings) {
    const openBalance = rows.reduce((sum, row) => sum + Math.max(finiteNumber(row.balance, 0), 0), 0);
    const topPriority = rows.slice().sort((left, right) => right.priorityScore - left.priorityScore)[0];
    const brokenPromises = rows.filter((row) => row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10) && finiteNumber(row.balance, 0) > 0);
    const readyToBill = rows.filter((row) => row.rowType === "estimate" && finiteNumber(row.amount, 0) > 0 && row.projectStatus !== "completed");
    const weakHealth = rows.filter((row) => row.projectHealthScore < 55);
    if (!rows.length) return "Todavia no hay cartera suficiente para generar digest.";
    return topPriority
      ? `Hoy hay ${money(openBalance, settings.currency)} abiertos. Prioridad principal: ${topPriority.title} con accion ${topPriority.nextAction}. ${brokenPromises.length} promesas rotas, ${readyToBill.length} estimates listos para invoice y ${weakHealth.length} proyectos en salud roja.`
      : `La cartera existe pero no muestra una prioridad dominante hoy.`;
  }

  function buildCashInForecast(rows, settings) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const endOfWeek = new Date();
    endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));
    const endOfWeekIso = endOfWeek.toISOString().slice(0, 10);
    const next7Iso = new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    const next14Iso = new Date(Date.now() + (14 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    const thisWeek = rows.filter((row) => {
      const due = row.dueDateRaw || "";
      return due && due >= todayIso && due <= endOfWeekIso && finiteNumber(row.balance, 0) > 0;
    }).reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
    const next7 = rows.filter((row) => {
      const due = row.dueDateRaw || "";
      return due && due > endOfWeekIso && due <= next7Iso && finiteNumber(row.balance, 0) > 0;
    }).reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
    const next14 = rows.filter((row) => {
      const due = row.dueDateRaw || "";
      return due && due > next7Iso && due <= next14Iso && finiteNumber(row.balance, 0) > 0;
    }).reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
    const promised = rows.filter((row) => row.promisedDateRaw && row.promisedDateRaw >= todayIso && finiteNumber(row.balance, 0) > 0)
      .reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
    const partial = rows.filter((row) => row.status === "partial" && finiteNumber(row.balance, 0) > 0)
      .reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
    const overdue = rows.filter((row) => ["overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0)
      .reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
    return [
      ["This Week", money(thisWeek, settings.currency), "Cobro por due date en la semana"],
      ["Next 7", money(next7, settings.currency), "Ventana posterior inmediata"],
      ["Next 14", money(next14, settings.currency), "Pipeline de cash-in cercano"],
      ["Promised", money(promised, settings.currency), "Clientes con promesa vigente"],
      ["Partial Balance", money(partial, settings.currency), "Saldo vivo ya encaminado"],
      ["At Risk", money(overdue, settings.currency), "Dinero atrasado que exige presion"]
    ];
  }

  function buildRiskSegments(rows, settings) {
    const groups = {
      healthy: rows.filter((row) => finiteNumber(row.projectHealthScore, 0) >= 80),
      watch: rows.filter((row) => finiteNumber(row.projectHealthScore, 0) >= 55 && finiteNumber(row.projectHealthScore, 0) < 80),
      risk: rows.filter((row) => finiteNumber(row.projectHealthScore, 0) < 55)
    };
    return [
      ["Healthy", String(groups.healthy.length), money(groups.healthy.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0), settings.currency)],
      ["Watch", String(groups.watch.length), money(groups.watch.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0), settings.currency)],
      ["At Risk", String(groups.risk.length), money(groups.risk.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0), settings.currency)]
    ];
  }

  function buildCampaignSegments(rows, settings) {
    const segments = {
      overdue: rows.filter((row) => ["overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0),
      promises: rows.filter((row) => row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10) && finiteNumber(row.balance, 0) > 0),
      partials: rows.filter((row) => row.status === "partial" && finiteNumber(row.balance, 0) > 0),
      ready: rows.filter((row) => row.rowType === "estimate" && finiteNumber(row.amount, 0) > 0 && row.projectStatus !== "completed"),
      high_risk: rows.filter((row) => finiteNumber(row.projectHealthScore, 0) < 55 || finiteNumber(row.priorityScore, 0) >= 80)
    };
    return [
      ["overdue", "Overdue Push", segments.overdue.length, money(segments.overdue.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0), settings.currency)],
      ["promises", "Broken Promises", segments.promises.length, money(segments.promises.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0), settings.currency)],
      ["partials", "Partials", segments.partials.length, money(segments.partials.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0), settings.currency)],
      ["ready", "Ready To Bill", segments.ready.length, money(segments.ready.reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0), settings.currency)],
      ["high_risk", "High Risk", segments.high_risk.length, money(segments.high_risk.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0), settings.currency)]
    ];
  }

  function buildWeeklyReview(rows, settings) {
    const paid = rows.filter((row) => row.status === "paid").length;
    const partial = rows.filter((row) => row.status === "partial").length;
    const overdue = rows.filter((row) => ["overdue", "expired"].includes(row.status)).length;
    const ready = rows.filter((row) => row.rowType === "estimate" && finiteNumber(row.amount, 0) > 0 && row.projectStatus !== "completed").length;
    const avgHealth = rows.length
      ? rows.reduce((sum, row) => sum + finiteNumber(row.projectHealthScore, 0), 0) / rows.length
      : 0;
    return [
      `Esta semana hay ${paid} proyectos pagados, ${partial} parciales y ${overdue} cuentas vencidas.`,
      `${ready} estimates siguen listos para convertirse a invoice.`,
      `La salud promedio del portafolio esta en ${avgHealth.toFixed(0)}%.`,
      `La prioridad del review es bajar overdue, cerrar promesas rotas y proteger margen en proyectos debiles.`
    ];
  }

  function getHubSuggestedPlaybook(row) {
    if (row.status === "draft") return "Convertir a invoice y mandar hoy mismo.";
    if (row.status === "sent" && !row.promisedDateRaw) return "Confirm due date and expected payment timing with the client.";
    if (row.collectionStage === "promised" && row.promisedDateRaw) {
      return row.promisedDateRaw < new Date().toISOString().slice(0, 10)
        ? "Promesa rota: escalar y documentar siguiente compromiso."
        : `Esperar promesa al ${row.promisedDate}.`;
    }
    if (["overdue", "expired"].includes(row.status)) return "Escalar seguimiento y definir siguiente accion hoy.";
    if (row.status === "partial") return "Confirm remaining project balance and expected payment date.";
    if (row.status === "paid") return "Cerrar seguimiento comercial y dejar historial limpio.";
    return "Mantener seguimiento y documentar siguiente paso.";
  }

  function exportPortfolioCsv(rows, settings) {
    const headers = ["Date", "Customer", "Project ID", "Title", "Status", "Amount", "Balance", "Invoice No", "Change Orders"];
    const lines = rows.map((row) => [
      row.date,
      row.customer,
      row.projectId,
      row.title,
      row.status,
      money(row.amount, settings.currency),
      money(row.balance, settings.currency),
      row.invoiceNo,
      String(row.approvedChangeOrderCount)
    ]);
    const csv = [headers, ...lines]
      .map((cols) => cols.map((value) => `"${String(value || "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "margin-guard-estimates-invoices.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCollectionsCsv(rows, settings) {
    const collectionRows = rows.filter((row) => ["partial", "overdue", "expired", "sent"].includes(row.status) && finiteNumber(row.balance, 0) > 0);
    const headers = ["Customer", "Project", "Invoice No", "Status", "Balance", "Due Date"];
    const lines = collectionRows.map((row) => [
      row.customer,
      row.title,
      row.invoiceNo,
      row.status,
      money(row.balance, settings.currency),
      row.project?.dueDate || ""
    ]);
    const csv = [headers, ...lines]
      .map((cols) => cols.map((value) => `"${String(value || "").replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "margin-guard-collections.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportHubExecutivePdf(rows, settings) {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) return alert("jsPDF is not available.");
    const totalAmount = rows.reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
    const totalBalance = rows.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
    const totalCollected = rows.reduce((sum, row) => sum + finiteNumber(row.cashCollected, 0), 0);
    const closeoutRows = rows.filter((row) => row.projectStatus === "completed");
    const totalMargin = closeoutRows.reduce((sum, row) => sum + finiteNumber(row.estimatedMargin, 0), 0);
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    let y = 46;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(settings.bizName || DEFAULTS.bizName, 40, y);
    y += 22;
    doc.setFontSize(13);
    doc.text("Owner Executive Report", 40, y);
    y += 20;
    doc.setFont("helvetica", "normal");
    [
      `Portfolio rows: ${rows.length}`,
      `Total sold/invoiced: ${money(totalAmount, settings.currency)}`,
      `Outstanding invoice balances: ${money(totalBalance, settings.currency)}`,
      `Payments received: ${money(totalCollected, settings.currency)}`,
      `Completed projects: ${closeoutRows.length}`,
      `Estimated margin on closeout: ${money(totalMargin, settings.currency)}`
    ].forEach((line) => {
      doc.text(line, 40, y);
      y += 15;
    });

    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "owner-executive-report.pdf";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function buildHubInvoiceState(project, report, overrides = {}) {
    const current = getProjectInvoiceState(project);
    const baseAmount = finiteNumber(overrides.baseAmount, current.baseAmount || project?.salePrice || 0);
    const depositApplied = finiteNumber(overrides.depositApplied, current.depositApplied);
    const receivedApplied = finiteNumber(overrides.receivedApplied, current.receivedApplied);
    const invoiceDate = normalizeDateInput(overrides.invoiceDate || current.invoiceDate) || new Date().toISOString().slice(0, 10);
    const dueDate = normalizeDateInput(overrides.dueDate || current.dueDate || project?.dueDate);
    const metrics = calcInvoice(project, report, {
      baseAmount,
      depositApplied,
      receivedApplied
    });
    const status = normalizeInvoiceStatus(
      overrides.status || inferInvoiceStatus(metrics.total || baseAmount, depositApplied, receivedApplied, current.status)
    );
    return {
      invoiceNo: nonEmptyString(overrides.invoiceNo, current.invoiceNo, `INV-${Date.now()}`),
      invoiceDate,
      dueDate,
      baseAmount,
      depositApplied,
      receivedApplied,
      status,
      payments: Array.isArray(overrides.payments) ? overrides.payments : current.payments,
      activity: Array.isArray(overrides.activity) ? overrides.activity : current.activity,
      publicToken: nonEmptyString(overrides.publicToken, current.publicToken),
      publicUrl: nonEmptyString(overrides.publicUrl, current.publicUrl),
      paymentLink: nonEmptyString(overrides.paymentLink, current.paymentLink),
      serverInvoiceId: nonEmptyString(overrides.serverInvoiceId, current.serverInvoiceId),
      sentAt: nonEmptyString(overrides.sentAt, current.sentAt),
      invoiceLabel: sanitizeInvoiceLabelInput(
        nonEmptyString(overrides.invoiceLabel, overrides.invoice_label, current.invoiceLabel)
      )
    };
  }

  async function publishHubPublicInvoice(projectId) {
    const project = getProjectById(projectId);
    if (!project) throw new Error("Project not found.");
    const report = loadSupervisorReport(project);
    const invoice = getProjectInvoiceState(project);
    const metrics = calcInvoice(project, report, invoice);
    const settings = loadSettings();

    let quoteIdFromSales = "";
    let publicQuoteTokenFromSales = "";
    try {
      const salesRaw = localStorage.getItem("mg_sales_v2");
      if (salesRaw) {
        const sales = JSON.parse(salesRaw);
        quoteIdFromSales = nonEmptyString(sales?.quoteId);
        const pqUrl = nonEmptyString(sales?.publicQuoteUrl);
        if (pqUrl) {
          const m = pqUrl.match(/[?&]token=([^&]+)/);
          if (m && m[1]) {
            try {
              publicQuoteTokenFromSales = decodeURIComponent(m[1]);
            } catch (_e) {
              publicQuoteTokenFromSales = m[1];
            }
          }
        }
      }
    } catch (_e) {
      quoteIdFromSales = "";
      publicQuoteTokenFromSales = "";
    }

    const payload = {
      public_token: invoice.publicToken || "",
      invoice_no: nonEmptyString(invoice.invoiceNo, `INV-${Date.now()}`),
      customer_name: project.clientName || "",
      customer_email: project.clientEmail || "",
      project_name: project.projectName || "",
      amount: metrics.total,
      paid_amount: Math.max(finiteNumber(invoice.depositApplied, 0) + finiteNumber(invoice.receivedApplied, 0), 0),
      balance_due: metrics.balance,
      issue_date: invoice.invoiceDate || new Date().toISOString().slice(0, 10),
      due_date: invoice.dueDate || project.dueDate || "",
      type: "service",
      notes: project.notes || "",
      payment_link: invoice.paymentLink || "",
      business_name: settings.bizName || DEFAULTS.bizName,
      logo_url: settings.publicLogoUrl || "",
      accent_color: settings.publicAccentColor || DEFAULTS.publicAccentColor,
      currency: settings.currency === "$" ? "USD" : settings.currency,
      status: String(invoice.status || "draft").toUpperCase(),
      invoice_label: sanitizeInvoiceLabelInput(nonEmptyString(invoice.invoiceLabel, invoice.invoice_label))
    };
    const hasQuoteLink = Boolean(quoteIdFromSales || publicQuoteTokenFromSales);
    if (quoteIdFromSales) {
      payload.quote_id = quoteIdFromSales;
    }
    if (publicQuoteTokenFromSales) {
      payload.public_quote_token = publicQuoteTokenFromSales;
    }
    if (!hasQuoteLink) {
      payload.standalone_invoice = true;
    }

    const response = await fetch("/.netlify/functions/publish-public-invoice", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Unable to publish public invoice.");
    }

    const nextInvoice = buildHubInvoiceState(project, report, {
      publicToken: data.public_token || payload.public_token,
      publicUrl: data.public_url || `/invoice-public.html?token=${data.public_token || payload.public_token}`
    });
    nextInvoice.activity = appendInvoiceActivity(nextInvoice, "Public invoice link published.", undefined, "public");
    saveProjectInvoiceState(projectId, nextInvoice, { skipTenantDraftSync: true });
    return nextInvoice.publicUrl;
  }

  function setHubPaymentLink(projectId, paymentLink) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const invoice = buildHubInvoiceState(project, report, {
      paymentLink: nonEmptyString(paymentLink)
    });
    invoice.activity = appendInvoiceActivity(invoice, "Payment link updated.", undefined, "link");
    saveProjectInvoiceState(projectId, invoice);
  }

  function convertEstimateToInvoice(projectId) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const metrics = calcInvoice(project, report, getProjectInvoiceState(project));
    if (!(metrics.total > 0)) return;
    const invoice = buildHubInvoiceState(project, report, { status: "draft" });
    invoice.activity = appendInvoiceActivity(invoice, "Estimate converted to invoice.", undefined, "invoice");
    saveProjectInvoiceState(projectId, invoice);
  }

  function markHubInvoiceSent(projectId) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const current = getProjectInvoiceState(project);
    if (!canTransitionInvoiceStatus(current.status, "sent")) return;
    const invoice = buildHubInvoiceState(project, report, { status: "sent" });
    invoice.activity = appendInvoiceActivity(invoice, "Invoice marked as sent.", undefined, "invoice");
    saveProjectInvoiceState(projectId, invoice);
  }

  function setHubInvoiceWorkflowState(projectId, nextStatus, extra = {}) {
    const project = getProjectById(projectId);
    if (!project) return { ok: false, reason: "Project not found." };
    const report = loadSupervisorReport(project);
    const current = getProjectInvoiceState(project);
    const actionState = getHubRowActionState(buildPortfolioRows(loadSettings()).find((row) => row.projectId === projectId) || { project, report, status: current.status, invoiceNo: current.invoiceNo });

    if (nextStatus === "sent" && !actionState.canMarkSent) {
      return { ok: false, reason: "Invoice must exist before moving to sent." };
    }
    if (nextStatus === "paid" && !actionState.canMarkPaid) {
      return { ok: false, reason: "Mark Paid only applies when an invoice has a remaining balance." };
    }
    if (nextStatus === "partial" && !(finiteNumber(current.receivedApplied, 0) > 0 && finiteNumber(calcInvoice(project, report, current).balance, 0) > 0)) {
      return { ok: false, reason: "Partial requires a recorded payment and a remaining invoice balance." };
    }
    if (nextStatus === "draft" && !current.invoiceNo) {
      return { ok: false, reason: "Draft only applies to an existing invoice workflow." };
    }

    const invoice = buildHubInvoiceState(project, report, {
      ...extra,
      status: nextStatus
    });
    invoice.activity = appendInvoiceActivity(
      invoice,
      extra.activityMessage || `Workflow moved to ${nextStatus}.`,
      undefined,
      extra.activityType || "invoice"
    );
    saveProjectInvoiceState(projectId, invoice);
    return { ok: true };
  }

  function getHubDropOutcome(row, targetKey) {
    if (!row) return { ok: false, reason: "Card not found." };
    const status = normalizeInvoiceStatus(row.invoiceStatus || row.status);
    const hasInvoice = Boolean(row.invoiceNo);
    const hasBalance = finiteNumber(row.balance, 0) > 0;
    const hasPayments = finiteNumber((row.depositApplied || 0) + (row.receivedApplied || 0), 0) > 0;

    if (targetKey === "draft") {
      if (!hasInvoice) return { ok: false, reason: "Only invoices can move back to draft." };
      if (status === "paid") return { ok: false, reason: "Paid invoices should not move back to draft." };
      return { ok: true, kind: "workflow", nextStatus: "draft", tone: "warn", message: "Tarjeta movida a draft" };
    }
    if (targetKey === "sent") {
      if (!hasInvoice) return { ok: false, reason: "Create the invoice first." };
      if (status === "paid") return { ok: false, reason: "Paid invoices cannot move to sent." };
      return { ok: true, kind: "workflow", nextStatus: "sent", tone: "ok", message: "Tarjeta movida a sent" };
    }
    if (targetKey === "partial") {
      if (!hasInvoice) return { ok: false, reason: "Partial requires a real invoice." };
      if (!hasPayments || !hasBalance) return { ok: false, reason: "Partial requires payment already applied with remaining balance." };
      return { ok: true, kind: "workflow", nextStatus: "partial", tone: "ok", message: "Tarjeta movida a partial" };
    }
    if (targetKey === "paid") {
      if (!hasInvoice) return { ok: false, reason: "Only invoices can move to paid." };
      if (!hasBalance) return { ok: true, kind: "paid", tone: "ok", message: "Invoice ya estaba liquidado" };
      return { ok: true, kind: "paid", tone: "ok", message: "Invoice liquidado desde pipeline" };
    }
    if (targetKey === "attention") {
      if (!hasInvoice) return { ok: false, reason: "Attention applies to invoiced work only." };
      if (!hasBalance) return { ok: false, reason: "No remaining invoice balance to escalate." };
      return { ok: true, kind: "escalate", tone: "warn", message: "Cuenta escalada a attention" };
    }
    return { ok: false, reason: "Target column not supported." };
  }

  function buildOwnerTasks(rows, settings) {
    const tasks = [];
    rows.forEach((row) => {
      if (row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10) && finiteNumber(row.balance, 0) > 0 && row.status !== "paid") {
        tasks.push({
          priority: 100,
          title: row.title,
          action: "Follow up account",
          body: `${row.customer}: commitment date passed; remaining invoice balance ${money(row.balance, settings.currency)} (stage ${row.collectionStage || "new"}).`
        });
      } else if (["overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0) {
        tasks.push({
          priority: 90,
          title: row.title,
          action: "Send balance reminder",
          body: `${row.customer}: invoice balance past due (${money(row.balance, settings.currency)}). Send a professional reminder.`
        });
      } else if (row.rowType === "estimate" && finiteNumber(row.amount, 0) > 0 && row.projectStatus !== "completed") {
        tasks.push({
          priority: 70,
          title: row.title,
          action: "Convert to invoice",
          body: `Estimate listo por ${money(row.amount, settings.currency)}. Conviene empujarlo a invoice.`
        });
      } else if (row.status === "partial" && finiteNumber(row.balance, 0) > 0) {
        tasks.push({
          priority: 60,
          title: row.title,
          action: "Follow up partial payment",
          body: `${row.customer}: project invoice still shows a remaining balance of ${money(row.balance, settings.currency)}.`
        });
      }
    });
    return tasks.sort((left, right) => right.priority - left.priority).slice(0, 6);
  }

  function buildAutoReminderRows(rows) {
    const todayIso = new Date().toISOString().slice(0, 10);
    return rows.filter((row) => {
      if (!(finiteNumber(row.balance, 0) > 0)) return false;
      if (!["sent", "partial", "overdue", "expired"].includes(row.status)) return false;
      const invoice = getProjectInvoiceState(row.project);
      const activity = Array.isArray(invoice.activity) ? invoice.activity : [];
      const alreadyQueuedToday = activity.some((item) => {
        const msg = String(item.message || "");
        return (
          (item.type || "") === "collections" &&
          normalizeDateInput(item.at) === todayIso &&
          (msg.includes("Invoice balance reminder prepared") || msg.includes("Auto reminder queued"))
        );
      });
      return !alreadyQueuedToday;
    }).sort((left, right) => right.priorityScore - left.priorityScore);
  }

  function queueHubAutoReminders(rows) {
    let queued = 0;
    buildAutoReminderRows(rows).slice(0, 10).forEach((row) => {
      const project = getProjectById(row.projectId);
      if (!project) return;
      const report = loadSupervisorReport(project);
      const invoice = buildHubInvoiceState(project, report, {
        collectionStage: row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10)
          ? "escalated"
          : getProjectInvoiceState(project).collectionStage || "contacted"
      });
      invoice.activity = appendInvoiceActivity(
        invoice,
        `Invoice balance reminder prepared for ${project.clientName || "customer"}.`,
        undefined,
        "collections"
      );
      saveProjectInvoiceState(row.projectId, invoice);
      queued += 1;
    });
    return queued;
  }

  function runHubStageAutomation(rows) {
    const todayIso = new Date().toISOString().slice(0, 10);
    let updated = 0;
    rows.forEach((row) => {
      const project = getProjectById(row.projectId);
      if (!project) return;
      const report = loadSupervisorReport(project);
      const current = getProjectInvoiceState(project);
      const openBalance = Math.max(finiteNumber(row.balance, 0), 0);
      let nextStage = current.collectionStage || "new";
      let reason = "";

      if (row.status === "paid" || openBalance <= 0) {
        nextStage = "resolved";
        reason = "Invoice resolved by automation.";
      } else if (row.promisedDateRaw && row.promisedDateRaw < todayIso) {
        nextStage = "escalated";
        reason = "Broken promise escalated by automation.";
      } else if (["overdue", "expired"].includes(row.status)) {
        nextStage = "escalated";
        reason = "Overdue invoice escalated by automation.";
      } else if (row.status === "partial") {
        nextStage = "contacted";
        reason = "Partial invoice moved to contacted by automation.";
      } else if (row.status === "sent" && openBalance > 0) {
        nextStage = "contacted";
        reason = "Sent invoice moved to contacted by automation.";
      }

      if (nextStage !== (current.collectionStage || "new")) {
        const invoice = buildHubInvoiceState(project, report, { collectionStage: nextStage });
        invoice.activity = appendInvoiceActivity(invoice, reason, undefined, "collections");
        saveProjectInvoiceState(row.projectId, invoice);
        updated += 1;
      }
    });
    return updated;
  }

  function queueCampaignSegment(rows, segmentKey) {
    const todayIso = new Date().toISOString().slice(0, 10);
    const segmentRows = {
      overdue: rows.filter((row) => ["overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0),
      promises: rows.filter((row) => row.promisedDateRaw && row.promisedDateRaw < todayIso && finiteNumber(row.balance, 0) > 0),
      partials: rows.filter((row) => row.status === "partial" && finiteNumber(row.balance, 0) > 0),
      ready: rows.filter((row) => row.rowType === "estimate" && finiteNumber(row.amount, 0) > 0 && row.projectStatus !== "completed"),
      high_risk: rows.filter((row) => finiteNumber(row.projectHealthScore, 0) < 55 || finiteNumber(row.priorityScore, 0) >= 80)
    }[segmentKey] || [];
    let queued = 0;
    segmentRows.slice(0, 25).forEach((row) => {
      const project = getProjectById(row.projectId);
      if (!project) return;
      const report = loadSupervisorReport(project);
      const invoice = buildHubInvoiceState(project, report, {
        collectionStage: ["overdue", "expired"].includes(row.status) || (row.promisedDateRaw && row.promisedDateRaw < todayIso)
          ? "escalated"
          : getProjectInvoiceState(project).collectionStage || "contacted"
      });
      invoice.activity = appendInvoiceActivity(
        invoice,
        `Campaign queued: ${segmentKey}.`,
        undefined,
        "collections"
      );
      saveProjectInvoiceState(row.projectId, invoice);
      queued += 1;
    });
    return queued;
  }

  function recordHubPayment(projectId, payment) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const current = getProjectInvoiceState(project);
    const nextPayment = {
      amount: Math.max(finiteNumber(payment?.amount, 0), 0),
      method: nonEmptyString(payment?.method, "manual"),
      note: nonEmptyString(payment?.note),
      date: normalizeDateInput(payment?.date) || new Date().toISOString().slice(0, 10)
    };
    const nextReceived = Math.max(finiteNumber(current.receivedApplied, 0) + nextPayment.amount, 0);
    const payments = [nextPayment, ...(Array.isArray(current.payments) ? current.payments : [])].slice(0, 50);
    const invoice = buildHubInvoiceState(project, report, {
      receivedApplied: nextReceived,
      payments
    });
    invoice.activity = appendInvoiceActivity(
      invoice,
      `Payment received: ${money(nextPayment.amount, loadSettings().currency)} via ${nextPayment.method}${nextPayment.note ? ` (${nextPayment.note})` : ""}.`,
      nextPayment.date,
      "payment"
    );
    saveProjectInvoiceState(projectId, invoice);
  }

  function markHubInvoicePaid(projectId) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const current = getProjectInvoiceState(project);
    if (!canTransitionInvoiceStatus(current.status, "paid")) return;
    const metrics = calcInvoice(project, report, current);
    const remaining = Math.max(metrics.total - finiteNumber(current.depositApplied, 0), 0);
    const invoice = buildHubInvoiceState(project, report, {
      receivedApplied: remaining,
      status: "paid"
    });
    invoice.activity = appendInvoiceActivity(invoice, "Invoice marked as paid.", undefined, "payment");
    saveProjectInvoiceState(projectId, invoice);
  }

  function applyHubSendSuccessToLocalProject(projectId, serverInvoice) {
    if (!serverInvoice?.id) return;
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const cur = getProjectInvoiceState(project);
    const sentAtIso = String(serverInvoice.sent_at || "").trim() || new Date().toISOString();
    const next = buildHubInvoiceState(project, report, {
      status: "sent",
      invoiceNo: nonEmptyString(serverInvoice.invoice_no, cur.invoiceNo),
      publicToken: nonEmptyString(serverInvoice.public_token, cur.publicToken),
      publicUrl: serverInvoice.public_token
        ? `/invoice-public.html?token=${encodeURIComponent(serverInvoice.public_token)}`
        : cur.publicUrl,
      serverInvoiceId: serverInvoice.id,
      sentAt: sentAtIso,
      invoiceLabel: sanitizeInvoiceLabelInput(
        nonEmptyString(serverInvoice.invoice_label, cur.invoiceLabel)
      )
    });
    next.activity = appendInvoiceActivity(next, "Invoice sent (webhook).", undefined, "email");
    saveProjectInvoiceState(projectId, next, { skipTenantDraftSync: true });
  }

  async function sendHubInvoice(projectId) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const cur = getProjectInvoiceState(project);
    const sid = nonEmptyString(cur.serverInvoiceId);
    const token = nonEmptyString(cur.publicToken);
    const canTryServer =
      (sid && MG_SERVER_INVOICE_UUID_RE.test(sid)) || (token && token.length >= 8);

    const doMailtoFallback = () => {
      const invoice = buildHubInvoiceState(project, report, { status: "sent" });
      invoice.activity = appendInvoiceActivity(invoice, "Project invoice email draft prepared for customer.", undefined, "email");
      saveProjectInvoiceState(projectId, invoice);
      const message = buildHubCommunication("invoice_send", buildPortfolioRows(loadSettings()).find((row) => row.projectId === projectId) || {
        customer: project.clientName || "-",
        title: project.projectName || "-",
        project,
        report
      }, loadSettings());
      const subject = encodeURIComponent(message.subject);
      const body = encodeURIComponent(message.body);
      window.location.href = `mailto:${encodeURIComponent(project.clientEmail || "")}?subject=${subject}&body=${body}`;
    };

    if (!canTryServer) {
      doMailtoFallback();
      return;
    }

    const body = {};
    if (sid && MG_SERVER_INVOICE_UUID_RE.test(sid)) {
      body.id = sid;
    } else {
      body.public_token = token;
    }

    try {
      console.info("[InvoiceHub] Send invoice payload", body);
      const res = await fetch("/.netlify/functions/send-invoice-zapier", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { ok: false, message: text ? text.slice(0, 200) : "Invalid JSON response" };
      }
      console.info("[InvoiceHub] Send invoice response", { httpStatus: res.status, body: data });
      if (res.ok && data.ok === true && data.forwarded === true && data.invoice) {
        console.log("[Invoice Send] Zapier completed");
        applyHubSendSuccessToLocalProject(projectId, data.invoice);
        console.log("[Invoice Send] invoice marked sent");
        void refreshHubServerInvoicesCacheQuietly();
        return;
      }
      console.error("[InvoiceHub] Send invoice failed", { httpStatus: res.status, body: data });
      setHubFeedback(formatSendInvoiceHubFailureMessage(res.status, data), "err");
    } catch (err) {
      console.error("[InvoiceHub] Send invoice failed", err);
      setHubFeedback(`Send invoice failed: ${String(err?.message || err || "network error")}`, "err");
    }
    doMailtoFallback();
  }

  /** Tenant invoice row from list-tenant-invoices (no local project id). */
  async function sendHubServerInvoiceRow(row) {
    if (row?.hubRowSource !== "server_invoice") return;
    const sid = nonEmptyString(row.serverInvoiceId);
    const token = nonEmptyString(row.project?.invoice?.publicToken);
    const canTryServer =
      (sid && MG_SERVER_INVOICE_UUID_RE.test(sid)) || (token && token.length >= 8);
    if (!canTryServer) {
      setHubFeedback("Este invoice no tiene id o token de servidor para enviar.", "warn");
      return;
    }
    const body = {};
    if (sid && MG_SERVER_INVOICE_UUID_RE.test(sid)) {
      body.id = sid;
    } else {
      body.public_token = token;
    }
    try {
      console.info("[InvoiceHub] Send invoice payload", body);
      const res = await fetch("/.netlify/functions/send-invoice-zapier", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body)
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { ok: false, message: text ? text.slice(0, 200) : "Invalid JSON response" };
      }
      console.info("[InvoiceHub] Send invoice response", { httpStatus: res.status, body: data });
      if (res.ok && data.ok === true && data.forwarded === true) {
        console.log("[Invoice Send] Zapier completed (server row)");
        void refreshHubServerInvoicesCacheQuietly();
        setHubFeedback("Invoice enviado.", "ok");
        return;
      }
      console.error("[InvoiceHub] Send invoice failed", { httpStatus: res.status, body: data });
      setHubFeedback(formatSendInvoiceHubFailureMessage(res.status, data), "err");
    } catch (err) {
      console.error("[InvoiceHub] Send invoice failed", err);
      setHubFeedback(`Send invoice failed: ${String(err?.message || err || "network error")}`, "err");
    }
  }

  async function sendHubInvoiceFromDrawerRow(row) {
    if (!row) return { ok: false, message: "No invoice selected." };
    const invoice = getProjectInvoiceState(row.project);
    const invoiceId = nonEmptyString(row.serverInvoiceId, invoice.serverInvoiceId, invoice.supabaseInvoiceId);
    const publicToken = nonEmptyString(invoice.publicToken);
    const publicUrl = invoice.publicUrl || (publicToken ? `/invoice-public.html?token=${encodeURIComponent(publicToken)}` : "");
    const payload = {
      id: MG_SERVER_INVOICE_UUID_RE.test(invoiceId) ? invoiceId : undefined,
      public_token: !MG_SERVER_INVOICE_UUID_RE.test(invoiceId) ? publicToken : undefined,
      tenant_id: nonEmptyString(row.tenant_id, row.project?.tenantId, row.project?.tenant_id),
      invoice_id: invoiceId,
      quote_id: nonEmptyString(row.hubQuoteId, invoice.quoteId),
      project_id: nonEmptyString(row.hubTenantProjectId, row.projectId),
      client_name: nonEmptyString(row.customer, row.project?.clientName),
      client_email: nonEmptyString(row.customerEmail, row.project?.clientEmail),
      business_name: nonEmptyString(invoice.businessName, row.project?.business_name),
      project_name: nonEmptyString(row.title, row.project?.projectName),
      public_invoice_url: publicUrl,
      invoice_number: nonEmptyString(row.invoiceNo, invoice.invoiceNo),
      invoice_amount: finiteNumber(row.amount, 0),
      contract_total: Math.max(finiteNumber(row.projectContractTotal, 0), 0),
      paid_to_date: finiteNumber(row.depositApplied, 0) + finiteNumber(row.receivedApplied, 0),
      remaining_balance: Math.max(finiteNumber(row.balance, 0), 0),
      "Client Email": nonEmptyString(row.customerEmail, row.project?.clientEmail),
      "Public Invoice Url": publicUrl
    };
    if (!payload.id && !payload.public_token) {
      return { ok: false, message: "Missing invoice_id/public_token for server send." };
    }
    try {
      const res = await fetch("/.netlify/functions/send-invoice-zapier", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_err) {
        data = {};
      }
      if (!res.ok || data.ok !== true) {
        return {
          ok: false,
          message: data?.message || data?.error || data?.details || text || `HTTP ${res.status}`
        };
      }
      return { ok: true, invoice: data.invoice || null };
    } catch (err) {
      return { ok: false, message: String(err?.message || err || "Network error") };
    }
  }

  function getHubDrawerSendInvoiceReadiness(row) {
    const invoice = getProjectInvoiceState(row?.project);
    const invoiceId = nonEmptyString(row?.serverInvoiceId, invoice.serverInvoiceId, invoice.supabaseInvoiceId);
    const invoiceNumber = nonEmptyString(row?.invoiceNo, invoice.invoiceNo);
    const publicToken = nonEmptyString(invoice.publicToken);
    const publicInvoiceUrl = invoice.publicUrl || (publicToken ? `/invoice-public.html?token=${encodeURIComponent(publicToken)}` : "");
    const clientEmail = nonEmptyString(row?.customerEmail, row?.project?.clientEmail);
    const businessName = nonEmptyString(invoice.businessName, row?.project?.business_name);
    const missing = [];
    if (!clientEmail || !clientEmail.includes("@")) missing.push("client_email");
    if (!publicInvoiceUrl) missing.push("public_invoice_url");
    if (!businessName) missing.push("business_name");
    if (!invoiceId && !invoiceNumber) missing.push("invoice_id_or_invoice_number");
    return {
      ready: missing.length === 0,
      missing
    };
  }

  function requestHubPayment(projectId) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const invoice = getProjectInvoiceState(project);
    const metrics = calcInvoice(project, report, invoice);
    const nextInvoice = buildHubInvoiceState(project, report, { status: invoice.status || "sent" });
    nextInvoice.activity = appendInvoiceActivity(
      nextInvoice,
      "Invoice balance notice prepared for customer.",
      undefined,
      "collections"
    );
    saveProjectInvoiceState(projectId, nextInvoice);
    const message = buildHubCommunication("payment_request", buildPortfolioRows(loadSettings()).find((row) => row.projectId === projectId) || {
      customer: project.clientName || "-",
      title: project.projectName || "-",
      project,
      report
    }, loadSettings());
    const subject = encodeURIComponent(message.subject);
    const body = encodeURIComponent(message.body);
    window.location.href = `mailto:${encodeURIComponent(project.clientEmail || "")}?subject=${subject}&body=${body}`;
  }

  function logHubFollowUp(projectId, note) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const invoice = getProjectInvoiceState(project);
    const nextInvoice = buildHubInvoiceState(project, report, {});
    nextInvoice.activity = appendInvoiceActivity(nextInvoice, `Follow-up logged${note ? `: ${note}` : "."}`, undefined, "followup");
    saveProjectInvoiceState(projectId, nextInvoice);
  }

  function updateHubPayments(projectId, transform, activityMessage) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const current = getProjectInvoiceState(project);
    const currentPayments = Array.isArray(current.payments) ? current.payments : [];
    const payments = transform(currentPayments.map((payment) => ({ ...payment })));
    const receivedApplied = payments.reduce((sum, payment) => sum + Math.max(finiteNumber(payment.amount, 0), 0), 0);
    const invoice = buildHubInvoiceState(project, report, {
      receivedApplied,
      payments
    });
    invoice.activity = appendInvoiceActivity(invoice, activityMessage, undefined, "payment");
    saveProjectInvoiceState(projectId, invoice);
  }

  function editHubPayment(projectId, index, updates) {
    updateHubPayments(projectId, (payments) => {
      if (!payments[index]) return payments;
      payments[index] = {
        ...payments[index],
        amount: Math.max(finiteNumber(updates.amount, payments[index].amount), 0),
        method: nonEmptyString(updates.method, payments[index].method, "manual"),
        note: nonEmptyString(updates.note, payments[index].note),
        date: normalizeDateInput(updates.date) || payments[index].date || new Date().toISOString().slice(0, 10)
      };
      return payments;
    }, "Payment edited.");
  }

  function deleteHubPayment(projectId, index) {
    updateHubPayments(projectId, (payments) => payments.filter((_, paymentIndex) => paymentIndex !== index), "Payment deleted.");
  }

  function exportCustomerStatementPdf(row, settings) {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF || !row) return alert("Statement is not available.");
    const invoice = getProjectInvoiceState(row.project);
    const metrics = calcInvoice(row.project, row.report, invoice);
    const payments = Array.isArray(invoice.payments) ? invoice.payments : [];
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    let y = 46;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(settings.bizName || DEFAULTS.bizName, 40, y);
    y += 22;
    doc.setFontSize(13);
    doc.text("Customer Statement", 40, y);
    y += 20;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    [
      `Customer: ${row.customer || "-"}`,
      `Project: ${row.title || "-"}`,
      `Invoice No: ${invoice.invoiceNo || "No invoice"}`,
      `Statement date: ${new Date().toISOString().slice(0, 10)}`,
      `Remaining invoice balance: ${money(metrics.balance, settings.currency)}`
    ].forEach((line) => {
      doc.text(line, 40, y);
      y += 15;
    });

    y += 10;
    doc.setFont("helvetica", "bold");
    doc.text("Payment History", 40, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    if (payments.length) {
      payments.forEach((payment) => {
        doc.text(`${payment.date || "-"} | ${payment.method || "manual"} | ${payment.note || "-"} | ${money(payment.amount || 0, settings.currency)}`, 40, y);
        y += 14;
      });
    } else {
      doc.text("No payments recorded yet.", 40, y);
      y += 14;
    }

    y += 12;
    doc.setFont("helvetica", "bold");
    doc.text("Summary", 40, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    [
      `Total invoice: ${money(metrics.total, settings.currency)}`,
      `Deposit applied: ${money(metrics.depositApplied, settings.currency)}`,
      `Payments received: ${money(metrics.receivedApplied, settings.currency)}`,
      `Remaining invoice balance: ${money(metrics.balance, settings.currency)}`
    ].forEach((line) => {
      doc.text(line, 40, y);
      y += 15;
    });

    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `statement-${(row.title || "project").replace(/\s+/g, "-")}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCloseoutPdf(row, settings) {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF || !row) return alert("Closeout PDF is not available.");
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    let y = 46;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(settings.bizName || DEFAULTS.bizName, 40, y);
    y += 22;
    doc.setFontSize(13);
    doc.text("Project Closeout Report", 40, y);
    y += 20;
    doc.setFont("helvetica", "normal");
    [
      `Project: ${row.title || "-"}`,
      `Customer: ${row.customer || "-"}`,
      `Sold: ${money(row.soldAmount || 0, settings.currency)}`,
      `Collected: ${money(row.cashCollected || 0, settings.currency)}`,
      `Final Cost Estimate: ${money(row.finalCost || 0, settings.currency)}`,
      `Estimated Margin: ${money(row.estimatedMargin || 0, settings.currency)}`,
      `Change Orders: ${row.changeOrderCount}`,
      `Approved Change Orders: ${row.approvedChangeOrderCount}`
    ].forEach((line) => {
      doc.text(line, 40, y);
      y += 15;
    });

    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `closeout-${(row.title || "project").replace(/\s+/g, "-")}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function hubLedgerInvoiceUuidForRow(row) {
    if (!row) return "";
    if (row.hubRowSource === "server_invoice") {
      const id = String(row.serverInvoiceId || "").trim();
      return MG_SERVER_INVOICE_UUID_RE.test(id) ? id : "";
    }
    const inv = row.project?.invoice && typeof row.project.invoice === "object" ? row.project.invoice : {};
    const id = String(nonEmptyString(inv.serverInvoiceId, inv.supabaseInvoiceId, row.serverInvoiceId) || "").trim();
    return MG_SERVER_INVOICE_UUID_RE.test(id) ? id : "";
  }

  function hubLedgerTargetIds(row) {
    const invoiceId = hubLedgerInvoiceUuidForRow(row);
    const quoteRaw = String(nonEmptyString(row.hubQuoteId, row.project?.invoice?.quoteId) || "").trim();
    const quoteId = MG_SERVER_INVOICE_UUID_RE.test(quoteRaw) ? quoteRaw : "";
    const projRaw = String(nonEmptyString(row.hubTenantProjectId) || "").trim();
    const projectId = MG_SERVER_INVOICE_UUID_RE.test(projRaw) ? projRaw : "";
    return { invoiceId, quoteId, projectId };
  }

  function hubRowCanRecordLedgerPayment(row) {
    const { invoiceId, quoteId, projectId } = hubLedgerTargetIds(row);
    return Boolean(invoiceId || quoteId || projectId);
  }

  /** Drawer / hub actions: approximate paid-to-date (local + server row aggregates; aligns with stats before ledger fetch). */
  function hubRowPaidToDateApprox(row) {
    return finiteNumber(row?.depositApplied, 0) + finiteNumber(row?.receivedApplied, 0);
  }

  async function fetchHubDrawerLedgerPayments(row) {
    const { invoiceId, quoteId, projectId } = hubLedgerTargetIds(row);
    const params = new URLSearchParams({ limit: "500" });
    if (invoiceId) params.set("invoice_id", invoiceId);
    else if (projectId) params.set("project_id", projectId);
    else if (quoteId) params.set("quote_id", quoteId);
    else return null;
    try {
      const res = await fetch(`/.netlify/functions/list-tenant-payments?${params.toString()}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok || !Array.isArray(data.payments)) return null;
      const payments = data.payments;
      const netSum = payments.reduce((s, p) => s + finiteNumber(p?.amount, 0), 0);
      return { payments, netSum };
    } catch (_e) {
      return null;
    }
  }

  function renderHubDrawerLedgerPaymentsRows(payments, settings) {
    if (!Array.isArray(payments) || !payments.length) {
      return `<tr><td colspan="5">No ledger payments yet.</td></tr>`;
    }
    return payments
      .map((p) => {
        const at = p.paid_at || p.created_at || "";
        const typ = escapeHtml(String(p.payment_type || p.paymentType || ""));
        const meth = escapeHtml(String(p.payment_method || p.paymentMethod || ""));
        const amt = finiteNumber(p.amount, 0);
        const note = escapeHtml(String(p.notes || p.note || "").slice(0, 400));
        return `<tr>
          <td>${escapeHtml(formatDisplayDate(at))}</td>
          <td>${typ}</td>
          <td>${meth}</td>
          <td>${escapeHtml(money(amt, settings.currency))}</td>
          <td>${note || "—"}</td>
        </tr>`;
      })
      .join("");
  }

  function hubDrawerPaymentProgressPct(paid, total) {
    const t = finiteNumber(total, 0);
    const p = finiteNumber(paid, 0);
    if (t <= 0) return null;
    return Math.min(100, Math.max(0, (p / t) * 100));
  }

  function hubDrawerPaymentNextActionFromTotals(paid, total) {
    const t = finiteNumber(total, 0);
    const p = finiteNumber(paid, 0);
    if (t <= 0) return "Initial deposit due";
    const pCents = Math.round(p * 100);
    const tCents = Math.round(t * 100);
    if (pCents <= 0) return "Initial deposit due";
    if (pCents >= tCents) return "Paid in full";
    return "Remaining balance due";
  }

  function hubDrawerNextPaymentPlaceholderText(paid, total) {
    const na = hubDrawerPaymentNextActionFromTotals(paid, total);
    if (na === "Paid in full") return "No further balance — project invoice is settled.";
    if (na === "Initial deposit due") return "Await initial deposit or first project payment.";
    return "Record payments until the remaining invoice balance is zero.";
  }

  function formatHubDrawerLastLedgerPaymentLine(payments, settings) {
    if (!Array.isArray(payments) || !payments.length) return "";
    const sorted = payments
      .slice()
      .sort((a, b) => {
        const da = Date.parse(String(a?.paid_at || a?.created_at || "")) || 0;
        const db = Date.parse(String(b?.paid_at || b?.created_at || "")) || 0;
        return db - da;
      });
    const p = sorted[0];
    const amt = money(finiteNumber(p?.amount, 0), settings.currency);
    const d = formatDisplayDate(p?.paid_at || p?.created_at || "");
    const typ = String(p?.payment_type || p?.paymentType || "").trim();
    const tail = typ ? ` · ${typ}` : "";
    return `${amt} · ${d}${tail}`;
  }

  function hubDrawerSetLedgerEmptyState(showEmpty) {
    const empty = $("hubDrawerLedgerEmpty");
    const wrap = $("hubDrawerLedgerTableWrap");
    if (empty) empty.style.display = showEmpty ? "block" : "none";
    if (wrap) wrap.style.display = showEmpty ? "none" : "";
  }

  function updateHubDrawerPaymentDerivedUi(paid, total, settings, lastPaymentLine) {
    const t = finiteNumber(total, 0);
    const p = finiteNumber(paid, 0);
    if ($("hubDrawerNextAction")) {
      $("hubDrawerNextAction").textContent = hubDrawerPaymentNextActionFromTotals(p, t);
    }
    const pct = hubDrawerPaymentProgressPct(p, t);
    const fill = $("hubDrawerProgressFill");
    if (fill) {
      fill.style.width = `${pct == null ? 0 : pct}%`;
    }
    const meta = $("hubDrawerProgressMeta");
    if (meta) {
      meta.textContent =
        pct == null
          ? t > 0
            ? `0% · ${money(0, settings.currency)} / ${money(t, settings.currency)}`
            : "—"
          : `${pct.toFixed(1)}% · ${money(p, settings.currency)} / ${money(t, settings.currency)}`;
    }
    const lastEl = $("hubDrawerPaymentLast");
    if (lastEl) {
      const s = lastPaymentLine != null ? String(lastPaymentLine).trim() : "";
      lastEl.textContent = s || "—";
    }
    const nextEl = $("hubDrawerPaymentNext");
    if (nextEl) {
      nextEl.textContent = hubDrawerNextPaymentPlaceholderText(p, t);
    }
  }

  function hubRowInvoiceDisplayLabel(row) {
    if (!row) return "";
    const fromRow = sanitizeInvoiceLabelInput(nonEmptyString(row.hubInvoiceLabel));
    if (fromRow) return fromRow;
    const inv = row.project?.invoice && typeof row.project.invoice === "object" ? row.project.invoice : {};
    return sanitizeInvoiceLabelInput(nonEmptyString(inv.invoiceLabel, inv.invoice_label));
  }

  function renderHubDrawerDetails(row, settings, handlers) {
    if (!row) return;
    const invoice = getProjectInvoiceState(row.project);
    const applyDrawerButtons = typeof handlers?.applyHubActionButtonState === "function" ? handlers.applyHubActionButtonState : null;
    const drawerEl = $("hubDrawer");
    if (drawerEl) {
      drawerEl.dataset.hubDrawerRowKey =
        row.hubRowSource === "server_invoice"
          ? String(row.serverInvoiceId || "").trim()
          : String(row.projectId || "");
      drawerEl.setAttribute("aria-hidden", "false");
    }
    const drawerLabel = hubRowInvoiceDisplayLabel(row);
    if ($("hubDrawerTitle")) $("hubDrawerTitle").textContent = drawerLabel || row.title;
    if ($("hubDrawerSubtitle")) {
      $("hubDrawerSubtitle").textContent = drawerLabel
        ? `${row.title} · ${row.customer} · ${row.status}`
        : `${row.customer} · ${row.status}`;
    }
    window.__MG_ACTIVE_INVOICE_ROW__ = row;
    console.log("[Invoice Hub] send invoice button rendered", row);

    const invoiceAmount = finiteNumber(row.amount, 0);
    const contractTotal = Math.max(finiteNumber(row.projectContractTotal, 0), 0);
    const localPaid = finiteNumber(row.depositApplied, 0) + finiteNumber(row.receivedApplied, 0);
    const ledgerApiOk = hubRowCanRecordLedgerPayment(row);
    const paidLabel = ledgerApiOk ? "…" : money(localPaid, settings.currency);
    const remainingLabel = ledgerApiOk ? "…" : money(Math.max(0, contractTotal - localPaid), settings.currency);

    if ($("hubDrawerStats")) {
      $("hubDrawerStats").className = "supervisor-summary-grid hub-drawer-payment-stats";
      $("hubDrawerStats").innerHTML = `
        <div class="supervisor-summary-card hub-drawer-stat-contract">
          <div class="title">Contract total</div>
          <div class="big">${escapeHtml(money(contractTotal, settings.currency))}</div>
          <div class="small">Approved project / quote total</div>
        </div>
        <div class="supervisor-summary-card hub-drawer-stat-primary">
          <div class="title">Paid to date</div>
          <div class="big" id="hubDrawerLedgerPaidBig">${escapeHtml(paidLabel)}</div>
          <div class="small" id="hubDrawerLedgerPaidSub">${
            ledgerApiOk ? "Ledger (loading…)" : "Local invoice payments + deposits"
          }</div>
        </div>
        <div class="supervisor-summary-card hub-drawer-stat-primary">
          <div class="title">Remaining balance</div>
          <div class="big" id="hubDrawerLedgerRemainingBig">${escapeHtml(remainingLabel)}</div>
          <div class="small">Project contract total minus payments recorded</div>
        </div>
        <div class="supervisor-summary-card hub-drawer-stat-secondary">
          <div class="title">Invoice amount</div>
          <div class="big">${escapeHtml(money(invoiceAmount, settings.currency))}</div>
          <div class="small">Amount billed on this invoice</div>
        </div>
      `;
    }

    updateHubDrawerPaymentDerivedUi(localPaid, contractTotal, settings, "");

    const ledgerWrap = $("hubDrawerLedgerWrap");
    const ledgerBody = $("hubDrawerLedgerPaymentsBody");
    if (ledgerWrap && ledgerBody) {
      if (ledgerApiOk) {
        ledgerWrap.style.display = "";
        hubDrawerSetLedgerEmptyState(false);
        ledgerBody.innerHTML = `<tr><td colspan="5">Loading ledger…</td></tr>`;
      } else {
        ledgerWrap.style.display = "none";
        hubDrawerSetLedgerEmptyState(false);
        ledgerBody.innerHTML = "";
      }
    }

    if (ledgerApiOk && drawerEl) {
      const rowKey = drawerEl.dataset.hubDrawerRowKey || "";
      void (async () => {
        const pack = await fetchHubDrawerLedgerPayments(row);
        const d = $("hubDrawer");
        if (!d || d.dataset.hubDrawerRowKey !== rowKey) return;
        const paidEl = $("hubDrawerLedgerPaidBig");
        const remEl = $("hubDrawerLedgerRemainingBig");
        const lb = $("hubDrawerLedgerPaymentsBody");
        if (lb && pack) {
          const rows = Array.isArray(pack.payments) ? pack.payments : [];
          if (!rows.length) {
            hubDrawerSetLedgerEmptyState(true);
            lb.innerHTML = "";
          } else {
            hubDrawerSetLedgerEmptyState(false);
            lb.innerHTML = renderHubDrawerLedgerPaymentsRows(rows, settings);
          }
        }
        if (!paidEl || !remEl) return;
        if (!pack || !Number.isFinite(pack.netSum)) {
          paidEl.textContent = "—";
          remEl.textContent = money(Math.max(0, contractTotal - localPaid), settings.currency);
          if (lb) {
            hubDrawerSetLedgerEmptyState(false);
            lb.innerHTML = `<tr><td colspan="5">Could not load ledger.</td></tr>`;
          }
          const sub = $("hubDrawerLedgerPaidSub");
          if (sub) sub.textContent = "Ledger unavailable — showing local totals";
          updateHubDrawerPaymentDerivedUi(localPaid, contractTotal, settings, "");
          return;
        }
        paidEl.textContent = money(pack.netSum, settings.currency);
        remEl.textContent = money(Math.max(0, contractTotal - pack.netSum), settings.currency);
        const subPaid = $("hubDrawerLedgerPaidSub");
        if (subPaid) subPaid.textContent = "Ledger net (tenant_project_payments)";
        const lastLine = formatHubDrawerLastLedgerPaymentLine(pack.payments, settings);
        updateHubDrawerPaymentDerivedUi(pack.netSum, contractTotal, settings, lastLine);
      })();
    }

    if (applyDrawerButtons) applyDrawerButtons(row);

    const changeOrders = Array.isArray(row.report?.changeOrders) ? row.report.changeOrders : [];
    const changeWrap = $("hubDrawerChangeOrdersWrap");
    if (changeWrap) changeWrap.style.display = changeOrders.length ? "" : "none";
    if ($("hubDrawerCoBody")) {
      $("hubDrawerCoBody").innerHTML = changeOrders.length
        ? changeOrders.map((item) => `
            <tr>
              <td>${escapeHtml(item.title || "Change order")}</td>
              <td>${escapeHtml(normalizeCommercialStatus(item.commercialStatus || (item.applied ? "approved" : "draft")))}</td>
              <td>${money(item.offeredPrice || 0, settings.currency)}</td>
            </tr>
          `).join("")
        : `<tr><td colspan="3">No change orders yet.</td></tr>`;
    }

    const renderActivityRows = (items, emptyMessage) => items.length
      ? items.map((item) => `
          <tr>
            <td><span class="hub-activity-type ${escapeHtml(item.type || "note")}">${escapeHtml(item.type || "note")}</span> ${escapeHtml(item.message || "-")}</td>
            <td>${escapeHtml(formatDisplayDate(item.at))}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="2">${escapeHtml(emptyMessage)}</td></tr>`;

    const activityList = Array.isArray(invoice.activity) ? invoice.activity : [];
    const collectionEvents = activityList.filter((item) => ["followup", "collections"].includes(item.type || "note"));
    const collectionsWrap = $("hubDrawerCollectionsWrap");
    if (collectionsWrap) collectionsWrap.style.display = collectionEvents.length ? "" : "none";
    if ($("hubDrawerCollectionsBody")) {
      $("hubDrawerCollectionsBody").innerHTML = renderActivityRows(collectionEvents, "No collections history yet.");
    }

    const activityWrap = $("hubDrawerActivityWrap");
    if (activityWrap) activityWrap.style.display = activityList.length ? "" : "none";
    if ($("hubDrawerActivityBody")) {
      $("hubDrawerActivityBody").innerHTML = renderActivityRows(activityList, "No activity recorded yet.");
    }
  }

  function renderHubTableSection(config) {
    const {
      filteredRows,
      displayOrderedRows,
      mergedHubRows,
      selectedProjectIds,
      settings,
      activeTab,
      refreshBulkBar,
      onOpenRow,
      onPay,
      onMarkPaid,
      onSendInvoice,
      onArchiveServerInvoice,
      onDeleteServerInvoice
    } = config;
    const tableRows =
      Array.isArray(displayOrderedRows) && displayOrderedRows.length ? displayOrderedRows : filteredRows;
    const hubRowPool =
      Array.isArray(mergedHubRows) && mergedHubRows.length ? mergedHubRows : filteredRows;
    const findHubRowByKey = (key) =>
      hubRowPool.find(
        (item) =>
          String(item.id || "") === key ||
          String(item.projectId || "") === key ||
          String(item.serverInvoiceId || "") === key ||
          String(item.project?.invoice?.publicToken || "") === key
      );
    if (!$("hubTableBody")) return;
    $("hubTableBody").closest(".supervisor-table-wrap").style.display = "block";
    $("hubTableBody").innerHTML = tableRows.length
      ? tableRows.map((row, rankIndex) => {
          const actionState = getHubRowActionState(row);
          const isServerRow = row.hubRowSource === "server_invoice";
          const rowDomId = escapeHtml(String(row.id != null ? row.id : row.projectId));
          const nextLabel = hubTableNextActionDisplay(row, rankIndex);
          const sendBtn = actionState.canSendInvoice
            ? `<button type="button" class="btn hub-cta-send" data-hub-send-invoice="${rowDomId}">Send now</button>`
            : "";
          const payBtn = actionState.canTakePayment
            ? `<button type="button" class="btn ghost hub-cta-secondary" data-hub-pay="${rowDomId}" title="Record a payment">Pay</button>`
            : actionState.canMarkPaid
              ? `<button type="button" class="btn ghost hub-cta-secondary" data-hub-mark-paid="${rowDomId}" title="Mark invoice paid">Mark Paid</button>`
              : "";
          const archiveBtn =
            isServerRow && actionState.canArchiveServerInvoice
              ? `<button type="button" class="btn ghost hub-cta-secondary" data-hub-archive="${rowDomId}" title="Archive invoice">Archive</button>`
              : "";
          const deleteBtn =
            isServerRow && actionState.canDeleteServerInvoice
              ? `<button type="button" class="btn ghost hub-cta-secondary" data-hub-delete="${rowDomId}" title="Delete invoice">Delete</button>`
              : "";
          const rankClass =
            rankIndex === 0 ? "hub-row--priority-1" : rankIndex === 1 ? "hub-row--priority-2" : rankIndex === 2 ? "hub-row--priority-3" : "";
          let rankBadge = "";
          if (rankIndex === 0) {
            rankBadge = `<span class="hub-priority-badge hub-priority-badge--start">Start here</span>`;
          } else if (rankIndex === 1) {
            rankBadge = `<span class="hub-priority-badge hub-priority-badge--rank">#2</span>`;
          } else if (rankIndex === 2) {
            rankBadge = `<span class="hub-priority-badge hub-priority-badge--rank">#3</span>`;
          }
          const hubInvLabel = hubRowInvoiceDisplayLabel(row);
          const hubInvLabelHtml = hubInvLabel
            ? `<span class="hub-invoice-row-label">${escapeHtml(hubInvLabel)}</span><span class="hub-invoice-row-sep"> · </span>`
            : "";
          return `
          <tr data-hub-row="${rowDomId}" class="${rankClass}" style="cursor:pointer">
            <td><input type="checkbox" data-hub-select="${rowDomId}" ${selectedProjectIds.has(row.projectId) || selectedProjectIds.has(row.id) ? "checked" : ""} /></td>
            <td>${escapeHtml(row.date)}</td>
            <td>${escapeHtml(row.customer)}</td>
            <td>
              ${rankBadge}
              ${hubInvLabelHtml}
              <strong>${escapeHtml(row.title)}</strong>
              ${isServerRow ? `<span class="hub-server-badge" style="font-size:10px;margin-left:6px;opacity:0.85" title="Tenant invoice (server)">${escapeHtml(row.hubSourceLabel || "Server")}</span>` : ""}
            </td>
            <td>${escapeHtml(row.invoiceNo)}</td>
            <td><span class="hub-status ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
            <td>${money(row.balance, settings.currency)}</td>
            <td class="hub-next-action-cell">${escapeHtml(nextLabel)}</td>
            <td>
              <div class="row-actions wrap">
                <button type="button" class="btn hub-cta-view" data-hub-view="${rowDomId}">View</button>
                ${sendBtn}
                ${payBtn}
                ${archiveBtn}
                ${deleteBtn}
              </div>
            </td>
          </tr>
        `;
        }).join("")
      : `<tr><td colspan="9">No rows match the current filters.</td></tr>`;

    $("hubTableBody").querySelectorAll("input[data-hub-select]").forEach((checkbox) => {
      checkbox.onchange = () => {
        const projectId = checkbox.dataset.hubSelect || "";
        if (!projectId) return;
        if (checkbox.checked) selectedProjectIds.add(projectId);
        else selectedProjectIds.delete(projectId);
        refreshBulkBar();
      };
    });

    const bindButton = (selector, callback) => {
      $("hubTableBody").querySelectorAll(selector).forEach((button) => {
        button.onclick = () => {
          const key = String(
            button.dataset.hubDelete ||
              button.dataset.hubArchive ||
              button.dataset.hubSendInvoice ||
              button.dataset.hubMarkPaid ||
              button.dataset.hubPay ||
              button.dataset.hubView ||
              Object.values(button.dataset)[0] ||
              button.closest("tr")?.dataset?.hubRow ||
              ""
          ).trim();
          const row = findHubRowByKey(key);
          if (!row || typeof callback !== "function") return;
          callback(row, key);
        };
      });
    };

    $("hubTableBody").querySelectorAll("tr[data-hub-row]").forEach((tr) => {
      tr.addEventListener("click", (ev) => {
        const t = ev.target;
        if (t && t.closest && t.closest("button, input, select, textarea, a, label")) return;
        const key = String(tr.dataset.hubRow || "").trim();
        const row = findHubRowByKey(key);
        if (row && typeof onOpenRow === "function") onOpenRow(row);
      });
    });

    bindButton("button[data-hub-view]", (row) => onOpenRow(row));
    bindButton("button[data-hub-pay]", (row, projectId) => onPay(row, projectId));
    bindButton("button[data-hub-mark-paid]", (row) => onMarkPaid(row));
    bindButton("button[data-hub-send-invoice]", (row) => onSendInvoice(row));
    if (typeof onArchiveServerInvoice === "function") {
      bindButton("button[data-hub-archive]", (row) => onArchiveServerInvoice(row));
    }
    if (typeof onDeleteServerInvoice === "function") {
      bindButton("button[data-hub-delete]", (row) => onDeleteServerInvoice(row));
    }
    refreshBulkBar();
  }

  function renderHubPipelineSection(_config) {
    if (!$("hubPipelineBoard")) return;
    $("hubPipelineBoard").style.display = "none";
    $("hubPipelineBoard").innerHTML = "";
  }

  function openHubClientDetail(customerName, rows, settings) {
    const filtered = rows.filter((row) => nonEmptyString(row.customer, "Sin cliente") === customerName);
    const totalOpen = filtered.reduce((sum, row) => sum + Math.max(finiteNumber(row.balance, 0), 0), 0);
    const totalSold = filtered.reduce((sum, row) => sum + Math.max(finiteNumber(row.soldAmount, 0), 0), 0);
    const brokenPromises = filtered.filter((row) => row.promisedDateRaw && row.promisedDateRaw < new Date().toISOString().slice(0, 10) && finiteNumber(row.balance, 0) > 0).length;
    const avgHealth = filtered.length
      ? filtered.reduce((sum, row) => sum + finiteNumber(row.projectHealthScore, 0), 0) / filtered.length
      : 0;

    if ($("hubClientModal")) $("hubClientModal").setAttribute("aria-hidden", "false");
    if ($("hubClientTitle")) $("hubClientTitle").textContent = customerName || "Client detail";
    if ($("hubClientSubtitle")) $("hubClientSubtitle").textContent = `${filtered.length} proyectos · Open ${money(totalOpen, settings.currency)}`;
    if ($("hubClientStats")) {
      $("hubClientStats").innerHTML = [
        ["Open Balance", money(totalOpen, settings.currency), "Saldo vivo de este cliente"],
        ["Sold", money(totalSold, settings.currency), "Venta total asociada"],
        ["Broken Promises", String(brokenPromises), "Promesas incumplidas"],
        ["Avg Health", `${avgHealth.toFixed(0)}%`, "Salud promedio del portafolio"]
      ].map(([title, big, small]) => `
        <div class="supervisor-summary-card">
          <div class="title">${escapeHtml(title)}</div>
          <div class="big">${escapeHtml(big)}</div>
          <div class="small">${escapeHtml(small)}</div>
        </div>
      `).join("");
    }
      if ($("hubClientProjectsBody")) {
        $("hubClientProjectsBody").innerHTML = filtered.length
        ? filtered.map((row) => `
            <tr>
              <td>${escapeHtml(row.title)}</td>
              <td><span class="hub-status ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
              <td>${money(row.balance, settings.currency)}</td>
              <td>${escapeHtml(String(row.projectHealthScore))}% ${escapeHtml(row.projectHealthLabel)}</td>
            </tr>
          `).join("")
        : `<tr><td colspan="4">No projects for this client.</td></tr>`;
      }
    if ($("btnHubClientRequestAll")) {
      $("btnHubClientRequestAll").onclick = () => {
        let sent = 0;
        filtered.forEach((row) => {
          if (getHubRowActionState(row).canRequestPayment) {
            requestHubPayment(row.projectId);
            sent += 1;
          }
        });
        closeHubClientDetail();
        setHubFeedback(
          sent
            ? `${sent} invoice balance reminders prepared for ${customerName}.`
            : `No eligible invoice balance reminders for ${customerName}.`,
          sent ? "ok" : "warn"
        );
      };
    }
    if ($("btnHubClientOpenCollections")) {
      $("btnHubClientOpenCollections").onclick = () => {
        const current = loadHubViewState();
        saveHubViewState({ ...current, tab: "collections", customer: customerName });
        window.location.reload();
      };
    }
    if ($("btnHubClientOpenHub")) {
      $("btnHubClientOpenHub").onclick = () => {
        const current = loadHubViewState();
        saveHubViewState({ ...current, tab: "all", customer: customerName });
        window.location.reload();
      };
    }
  }

  function closeHubClientDetail() {
    if ($("hubClientModal")) $("hubClientModal").setAttribute("aria-hidden", "true");
  }

  /** Normalized tenant invoices from list-tenant-invoices; undefined until first fetch completes. */
  let hubServerNormalizedInvoicesCache = undefined;
  let hubServerInvoicesFetchStarted = false;

  function renderEstimatesHub() {
    if (!$("hubTableBody")) return;

    const settings = loadSettings();
    const hubViewState = loadHubViewState();
    let filteredRows = [];
    let lastMergedHubRows = [];
    let activeTab = hubViewState.tab || "all";
    let activePreset = hubViewState.preset == null ? "" : String(hubViewState.preset);
    let hubViewMode =
      hubViewState.mode && MG_HUB_INVOICE_VIEW_MODES.has(hubViewState.mode)
        ? hubViewState.mode
        : hubTabPresetToViewMode(activeTab, activePreset);
    if (!MG_HUB_INVOICE_VIEW_MODES.has(hubViewMode)) hubViewMode = "all";
    const tp0 = hubViewModeToTabPreset(hubViewMode);
    activeTab = tp0.tab;
    activePreset = tp0.preset;
    let selectedRow = null;
    let sortKey = hubViewState.sortKey || "dateRaw";
    let sortDir = hubViewState.sortDir || "desc";
    const selectedProjectIds = new Set();

    const persistHubView = () => {
      saveHubViewState({
        tab: activeTab,
        preset: activePreset,
        mode: hubViewMode,
        sortKey,
        sortDir,
        search: val("hubSearch"),
        status: val("hubStatusFilter"),
        dateFrom: val("hubDateFrom"),
        customer: val("hubCustomerFilter"),
        location: val("hubLocationFilter")
      });
    };

    const clearHubFiltersIncompatibleWithMode = (_mode) => {};

    const syncHubInvoiceHubChrome = () => {
      if ($("hubModeFilter")) {
        $("hubModeFilter").querySelectorAll("button[data-hub-mode]").forEach((node) => {
          const m = node.dataset.hubMode || "all";
          node.classList.toggle("active", m === hubViewMode);
        });
      }
      if ($("hubListSectionTitle")) {
        $("hubListSectionTitle").textContent = `Invoice Hub — ${hubInvoiceHubViewTitleLabel(hubViewMode)}`;
      }
    };

    const applyHubSortButtons = () => {
      document.querySelectorAll("[data-hub-sort]").forEach((node) => {
        const isActive = node.dataset.hubSort === sortKey;
        const raw = String(node.textContent || "").trim();
        const base = raw.replace(/\s*[\u2191\u2193]\s*$/, "").trim();
        node.textContent = isActive ? `${base} ${sortDir === "asc" ? "\u2191" : "\u2193"}` : base;
        node.classList.toggle("active", isActive);
      });
    };

    const applyHubActionButtonState = (row) => {
      const actionState = getHubRowActionState(row);
      const openBtn = $("btnHubDrawerOpenPublic");
      if (openBtn) {
        openBtn.style.display = "";
        openBtn.disabled = !actionState.canOpenPublic;
        openBtn.classList.toggle("hub-action-disabled", !actionState.canOpenPublic);
        openBtn.title = actionState.canOpenPublic ? "" : "Aun no existe link publico para este invoice.";
      }

      const pdfBtn = $("btnHubDrawerPdf");
      if (pdfBtn) {
        pdfBtn.style.display = "";
        pdfBtn.disabled = !actionState.canExportPdf;
        pdfBtn.classList.toggle("hub-action-disabled", !actionState.canExportPdf);
        pdfBtn.title = actionState.canExportPdf ? "" : "El PDF del invoice requiere un invoice valido con monto.";
      }

      const recordPay = $("btnHubDrawerRecordPayment");
      if (recordPay) {
        const canLedger = hubRowCanRecordLedgerPayment(row);
        recordPay.disabled = !canLedger;
        recordPay.style.display = "";
        recordPay.classList.toggle("hub-action-disabled", !canLedger);
        recordPay.title = canLedger
          ? ""
          : "Requires a linked server invoice, quote, or tenant project UUID to post to the ledger.";
      }

      const sendBtn = $("btnHubDrawerSendInvoice");
      if (sendBtn) {
        const sendReady = getHubDrawerSendInvoiceReadiness(row);
        sendBtn.style.display = "";
        sendBtn.disabled = false;
        sendBtn.classList.remove("hub-action-disabled");
        sendBtn.title = sendReady.ready
          ? ""
          : `Missing required fields: ${sendReady.missing.join(", ")}`;
      }

      const qid = String(row?.hubQuoteId || "").trim();
      const serverQuoteRow =
        row?.hubRowSource === "server_invoice" && qid && MG_SERVER_INVOICE_UUID_RE.test(qid);
      const canMarkQuoteAccept =
        serverQuoteRow && !hubServerQuoteIsAccepted(row);
      const psLower = String(row?.hubInvoicePaymentStatus || "").toLowerCase();
      const canMarkCheckPending =
        serverQuoteRow &&
        hubServerQuoteIsAccepted(row) &&
        !hubServerDepositRecorded(row) &&
        psLower !== "check_pending";
      const paidApprox = hubRowPaidToDateApprox(row);
      const canMarkDepositReceived =
        serverQuoteRow &&
        !hubServerDepositRecorded(row) &&
        (hubServerQuoteIsAccepted(row) || psLower === "check_pending") &&
        paidApprox <= 0;

      const qa = $("btnHubDrawerQuoteAccept");
      if (qa) {
        const show = Boolean(canMarkQuoteAccept);
        qa.style.display = show ? "" : "none";
        qa.disabled = !show;
        qa.classList.toggle("hub-action-disabled", !show);
        qa.title = show ? "" : "Quote already accepted or row is not server-backed.";
      }
      const cp = $("btnHubDrawerCheckPending");
      if (cp) {
        const show = Boolean(canMarkCheckPending);
        cp.style.display = show ? "" : "none";
        cp.disabled = !show;
        cp.classList.toggle("hub-action-disabled", !show);
        cp.title = show ? "" : "Accept the quote first, or deposit is already on file.";
      }
      const dr = $("btnHubDrawerDepositReceived");
      if (dr) {
        const show = Boolean(canMarkDepositReceived);
        dr.style.display = show ? "" : "none";
        dr.disabled = !show;
        dr.classList.toggle("hub-action-disabled", !show);
        dr.title = show
          ? ""
          : paidApprox > 0
            ? "Paid-to-date must be zero before marking deposit received."
            : "Accept the quote or mark check pending first, or deposit already recorded.";
      }
    };

    const refreshBulkBar = () => {
      const hubTableSource = Array.isArray(lastMergedHubRows) && lastMergedHubRows.length
        ? lastMergedHubRows
        : filteredRows;
      const selectedRows = hubTableSource.filter((row) => selectedProjectIds.has(row.projectId));
      const total = selectedRows.reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
      if ($("hubBulkBar")) $("hubBulkBar").style.display = selectedRows.length ? "block" : "none";
      if ($("hubBulkCount")) $("hubBulkCount").textContent = String(selectedRows.length);
      if ($("hubBulkAmount")) $("hubBulkAmount").textContent = money(total, settings.currency);
      if ($("hubSelectAll")) {
        $("hubSelectAll").checked =
          Boolean(hubTableSource.length) && selectedRows.length === hubTableSource.length;
      }
    };

    const showHubActionForm = (config) => {
      openHubFormModal({
        ...config,
        onSubmit: config.onSubmit
      });
    };

    const openCreateManualInvoiceForm = () => {
      let systemHourly = 0;
      let systemDaily = 0;
      let pricingPreviewOk = false;

      const recalcTotal = () => {
        const billingType = String(val("hubManualBillingType") || "").trim();
        const qtyInput = $("hubManualQuantity");
        const qtyLabel = $("hubManualQuantityLabel");
        const rateLabel = $("hubManualRateLabel");
        const rateInput = $("hubManualRate");
        const q = Math.max(finiteNumber(val("hubManualQuantity"), 0), 0);
        const mat = Math.max(finiteNumber(val("hubManualMaterialCost"), 0), 0);
        let total = 0;
        if (billingType === "flat_amount") {
          const flatAmt = Math.max(finiteNumber(val("hubManualRate"), 0), 0);
          total = flatAmt + mat;
          if (qtyInput) qtyInput.disabled = true;
          if (qtyLabel) qtyLabel.textContent = "Quantity";
          if (rateLabel) rateLabel.textContent = "Flat service amount (before materials)";
          if (rateInput) rateInput.readOnly = false;
        } else {
          const sys = billingType === "daily" ? systemDaily : systemHourly;
          if (rateInput) {
            rateInput.readOnly = true;
            setVal("hubManualRate", round2(sys).toFixed(2));
          }
          total = q * sys + mat;
          if (qtyInput) qtyInput.disabled = false;
          if (qtyLabel) qtyLabel.textContent = billingType === "daily" ? "Days" : "Hours";
          if (rateLabel) {
            rateLabel.textContent =
              billingType === "daily" ? "System daily rate (read-only)" : "System hourly rate (read-only)";
          }
        }
        setVal("hubManualTotal", round2(total).toFixed(2));
      };

      showHubActionForm({
        title: "Create Invoice",
        subtitle: "Uses Margin Guard system sell rates from Business Settings (latest snapshot).",
        submitLabel: "Create Invoice",
        successMessage: "Invoice created",
        fields: [
          { id: "hubManualClientName", label: "Client name", type: "text", value: "" },
          { id: "hubManualClientEmail", label: "Client email", type: "email", value: "" },
          { id: "hubManualTitle", label: "Project / invoice title", type: "text", value: "" },
          { id: "hubManualDescription", label: "Description / scope", type: "textarea", rows: 3, value: "" },
          {
            id: "hubManualBillingType",
            label: "Billing type",
            type: "select",
            value: "hourly",
            options: [
              { value: "hourly", label: "Hourly" },
              { value: "daily", label: "Daily" },
              { value: "flat_amount", label: "Flat amount" },
            ],
          },
          { id: "hubManualQuantity", label: "Quantity", type: "number", step: "0.01", value: "1" },
          { id: "hubManualRate", label: "System rate", type: "number", step: "0.01", value: "0" },
          {
            type: "static",
            html: `<div class="field hub-form-static hub-manual-materials-wrap">
              <button type="button" class="btn btn-secondary" id="hubManualMaterialsBtn" style="margin-bottom:0.5rem;">+ Materials</button>
              <div id="hubManualMaterialsPanel" style="display:none;">
                <div class="field" style="margin-top:0.5rem;">
                  <label for="hubManualMaterialDescription">Material description</label>
                  <textarea id="hubManualMaterialDescription" rows="2" placeholder="Optional"></textarea>
                </div>
                <div class="field">
                  <label for="hubManualMaterialCost">Material cost</label>
                  <input id="hubManualMaterialCost" type="number" step="0.01" value="0" />
                </div>
              </div>
            </div>`,
          },
          { id: "hubManualTotal", label: "Total (auto-calculated)", type: "number", step: "0.01", value: "0.00" },
          { id: "hubManualDueDate", label: "Due date", type: "date", value: "" },
        ],
        afterRender: async () => {
          const totalInput = $("hubManualTotal");
          if (totalInput) totalInput.readOnly = true;
          const qtyInput = $("hubManualQuantity");
          const rateInput = $("hubManualRate");
          const qtyLabelNode = qtyInput?.closest(".field")?.querySelector("label");
          const rateLabelNode = rateInput?.closest(".field")?.querySelector("label");
          if (qtyLabelNode) qtyLabelNode.id = "hubManualQuantityLabel";
          if (rateLabelNode) rateLabelNode.id = "hubManualRateLabel";

          pricingPreviewOk = false;
          setNotice("hubFormFeedback", "Loading system rates…", "warn");
          try {
            const pres = await fetch("/.netlify/functions/create-manual-invoice", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify({ preview_system_rates: true }),
            });
            const pdata = await pres.json().catch(() => ({}));
            if (!pres.ok || !pdata?.ok) {
              const errRaw = String(pdata?.error || "").trim();
              const errMsg =
                errRaw === "pricing_snapshot_required"
                  ? "Save Business Settings first (tenant snapshot required for system rates)."
                  : errRaw || "Could not load system rates.";
              setNotice("hubFormFeedback", errMsg, "err");
              return;
            }
            systemHourly = finiteNumber(pdata.system_hourly_rate, 0);
            systemDaily = finiteNumber(pdata.system_daily_rate, 0);
            pricingPreviewOk = true;
            setNotice("hubFormFeedback", "", "");
          } catch (_e) {
            setNotice("hubFormFeedback", "Network error loading system rates.", "err");
            return;
          }

          const matBtn = $("hubManualMaterialsBtn");
          const matPanel = $("hubManualMaterialsPanel");
          if (matBtn && matPanel) {
            matBtn.onclick = (ev) => {
              ev.preventDefault();
              const open = matPanel.style.display !== "none";
              matPanel.style.display = open ? "none" : "block";
              matBtn.textContent = open ? "+ Materials" : "Hide materials";
            };
          }

          ["hubManualBillingType", "hubManualQuantity", "hubManualRate", "hubManualMaterialCost"].forEach((id) => {
            const node = $(id);
            if (!node) return;
            node.oninput = recalcTotal;
            node.onchange = recalcTotal;
          });
          recalcTotal();
        },
        onSubmit: async () => {
          if (!pricingPreviewOk) {
            setNotice("hubFormFeedback", "System rates are not loaded. Fix errors above or try again.", "err");
            return false;
          }
          const client_name = String(val("hubManualClientName") || "").trim();
          const client_email = String(val("hubManualClientEmail") || "").trim();
          const project_title = String(val("hubManualTitle") || "").trim();
          const description = String(val("hubManualDescription") || "").trim();
          const billing_type = String(val("hubManualBillingType") || "").trim();
          const quantity = finiteNumber(val("hubManualQuantity"), 0);
          const flat_amount = finiteNumber(val("hubManualRate"), 0);
          const due_date = normalizeDateInput(val("hubManualDueDate"));
          const total = finiteNumber(val("hubManualTotal"), 0);
          const material_description = String(val("hubManualMaterialDescription") || "").trim();
          const materials_cost = finiteNumber(val("hubManualMaterialCost"), 0);

          if (!client_name) {
            setNotice("hubFormFeedback", "Client name is required.", "err");
            return false;
          }
          if (!client_email || !client_email.includes("@")) {
            setNotice("hubFormFeedback", "Client email is required.", "err");
            return false;
          }
          if (!project_title) {
            setNotice("hubFormFeedback", "Project / invoice title is required.", "err");
            return false;
          }
          if (!billing_type) {
            setNotice("hubFormFeedback", "Billing type is required.", "err");
            return false;
          }
          if (materials_cost < 0 || !Number.isFinite(materials_cost)) {
            setNotice("hubFormFeedback", "Material cost must be zero or greater.", "err");
            return false;
          }
          if (billing_type === "hourly" || billing_type === "daily") {
            if (!(quantity > 0)) {
              setNotice("hubFormFeedback", "Enter a quantity greater than zero.", "err");
              return false;
            }
            const sys = billing_type === "daily" ? systemDaily : systemHourly;
            if (!(sys > 0)) {
              setNotice("hubFormFeedback", "System rate is invalid. Check Business Settings.", "err");
              return false;
            }
          } else if (billing_type === "flat_amount") {
            if (!(flat_amount > 0)) {
              setNotice("hubFormFeedback", "Flat service amount must be greater than zero.", "err");
              return false;
            }
          }
          if (!(total > 0)) {
            setNotice("hubFormFeedback", "Total must be greater than zero.", "err");
            return false;
          }

          try {
            const body = {
              client_name,
              client_email,
              project_title,
              description,
              work_details: description,
              workDetails: description,
              scope: description,
              scope_of_work: description,
              scopeOfWork: description,
              notes: description,
              billing_type,
              quantity: billing_type === "flat_amount" ? 0 : quantity,
              flat_amount: billing_type === "flat_amount" ? flat_amount : undefined,
              material_description,
              materials_description: material_description,
              materials_cost,
              due_date: due_date || null,
            };
            console.log("[manual invoice payload]", body);
            const res = await fetch("/.netlify/functions/create-manual-invoice", {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data?.ok) {
              const er = String(data?.error || "").trim();
              const shown =
                er === "pricing_snapshot_required"
                  ? "Save Business Settings first (snapshot required)."
                  : er || "Could not create invoice.";
              setNotice("hubFormFeedback", shown, "err");
              return false;
            }
            if (typeof window.__mgHubRefetchServerInvoices === "function") {
              await window.__mgHubRefetchServerInvoices();
            }
            return true;
          } catch (_e) {
            setNotice("hubFormFeedback", "Network error. Could not create invoice.", "err");
            return false;
          }
        },
      });
    };

    const refreshSelectedRow = () => {
      if (!selectedRow) return;
      const next = lastMergedHubRows.find(
        (row) =>
          row.projectId === selectedRow.projectId ||
          String(row.id) === String(selectedRow.id) ||
          String(row.projectId) === String(selectedRow.id)
      );
      if (!next) return;
      openHubDrawer(next);
    };

    const openHubDrawer = (row) => {
      if (!row) return;
      selectedRow = row;
      renderHubDrawerDetails(row, settings, {
        applyHubActionButtonState
      });
    };

    const closeHubDrawer = () => {
      if ($("hubDrawer")) $("hubDrawer").setAttribute("aria-hidden", "true");
      if ($("hubRecordPaymentModal")) $("hubRecordPaymentModal").setAttribute("aria-hidden", "true");
      setNotice("hubRecordPayFeedback", "", "");
      if ($("hubRecordPayOverpayWarn")) {
        $("hubRecordPayOverpayWarn").style.display = "none";
        $("hubRecordPayOverpayWarn").textContent = "";
      }
      clearHubFeedbackOkIfShown();
    };

    const openPaymentForm = (row, existingPayment, onSubmit) => {
      showHubActionForm({
        title: existingPayment ? "Editar pago" : "Registrar pago",
        subtitle: `${row.title} · ${row.customer}`,
        submitLabel: existingPayment ? "Guardar cambios" : "Guardar pago",
        fields: [
          { id: "hubFormAmount", label: "Amount", type: "number", step: "0.01", value: existingPayment?.amount ?? "", placeholder: "0.00" },
          {
            id: "hubFormMethod",
            label: "Method",
            type: "select",
            value: existingPayment?.method || "check",
            options: ["check", "cash", "zelle", "wire", "card", "manual"].map((value) => ({ value, label: value }))
          },
          { id: "hubFormDate", label: "Date", type: "date", value: existingPayment?.date || new Date().toISOString().slice(0, 10) },
          { id: "hubFormNote", label: "Note", type: "textarea", value: existingPayment?.note || "", placeholder: "Referencia, memo o detalle del pago", rows: 4 }
        ],
        onSubmit: () => {
          const amount = Number(val("hubFormAmount"));
          const method = val("hubFormMethod");
          const date = val("hubFormDate");
          const note = val("hubFormNote");
          if (!Number.isFinite(amount) || amount <= 0) {
            setNotice("hubFormFeedback", "Ingresa un monto valido mayor a cero.", "err");
            return false;
          }
          if (!normalizeDateInput(date)) {
            setNotice("hubFormFeedback", "La fecha del pago es obligatoria.", "err");
            return false;
          }
          onSubmit({ amount, method, date, note });
          return true;
        }
      });
    };

    const openFollowUpForm = (row) => {
      const invoice = getProjectInvoiceState(row.project);
      showHubActionForm({
        title: "Registrar follow-up",
        subtitle: `${row.title} · ${row.customer}`,
        submitLabel: "Guardar seguimiento",
        fields: [
          {
            id: "hubFormFollowUpStage",
            label: "Collections Stage",
            type: "select",
            value: invoice.collectionStage || "new",
            options: ["new", "contacted", "promised", "escalated", "resolved"].map((value) => ({ value, label: value }))
          },
          { id: "hubFormFollowUpPromiseDate", label: "Promised Payment Date", type: "date", value: invoice.promisedDate || "" },
          { id: "hubFormFollowUpNote", label: "Note", type: "textarea", value: "", placeholder: "Llamada, correo, promesa de pago o siguiente paso", rows: 5 }
        ],
        onSubmit: () => {
          const note = val("hubFormFollowUpNote");
          const stage = val("hubFormFollowUpStage") || "new";
          const promisedDate = val("hubFormFollowUpPromiseDate");
          if (!note.trim()) {
            setNotice("hubFormFeedback", "Escribe una nota corta del seguimiento.", "err");
            return false;
          }
          if (promisedDate && !normalizeDateInput(promisedDate)) {
            setNotice("hubFormFeedback", "Promised payment date no tiene formato valido.", "err");
            return false;
          }
          const project = getProjectById(row.projectId);
          if (!project) return false;
          const report = loadSupervisorReport(project);
          const nextInvoice = buildHubInvoiceState(project, report, {
            collectionStage: stage,
            promisedDate: stage === "promised" ? promisedDate : ""
          });
          nextInvoice.activity = appendInvoiceActivity(
            nextInvoice,
            `Follow-up logged: ${note}${stage === "promised" && promisedDate ? ` (promise ${normalizeDateInput(promisedDate)})` : ""}`,
            undefined,
            "followup"
          );
          saveProjectInvoiceState(row.projectId, nextInvoice);
          return true;
        }
      });
    };

    const openPaymentLinkForm = (row) => {
      const invoice = getProjectInvoiceState(row.project);
      showHubActionForm({
        title: "Guardar payment link",
        subtitle: `${row.title} · ${row.invoiceNo || "No invoice"}`,
        submitLabel: "Guardar link",
        fields: [
          { id: "hubFormPaymentLink", label: "Payment link URL", type: "text", value: invoice.paymentLink || "", placeholder: "https://..." }
        ],
        onSubmit: () => {
          const paymentLink = val("hubFormPaymentLink");
          if (paymentLink && !/^https?:\/\//i.test(paymentLink)) {
            setNotice("hubFormFeedback", "El link debe empezar con http:// o https://", "err");
            return false;
          }
          setHubPaymentLink(row.projectId, paymentLink);
          return true;
        }
      });
    };

    const openCustomerSetupForm = (row) => {
      showHubActionForm({
        title: "Customer setup",
        subtitle: `${row.title} · ${row.customer}`,
        submitLabel: "Guardar cliente",
        fields: [
          { id: "hubFormCustomerName", label: "Customer Name", type: "text", value: row.project?.clientName || "", placeholder: "Nombre del cliente" },
          { id: "hubFormCustomerEmail", label: "Customer Email", type: "text", value: row.project?.clientEmail || "", placeholder: "cliente@correo.com" },
          { id: "hubFormCustomerPhone", label: "Customer Phone", type: "text", value: row.project?.clientPhone || "", placeholder: "(555) 000-0000" },
          { id: "hubFormCustomerLocation", label: "Location", type: "text", value: row.project?.location || "", placeholder: "Ciudad, direccion o job site" }
        ],
        onSubmit: () => {
          const clientName = val("hubFormCustomerName");
          const clientEmail = val("hubFormCustomerEmail");
          const clientPhone = val("hubFormCustomerPhone");
          const location = val("hubFormCustomerLocation");
          if (!clientName.trim()) {
            setNotice("hubFormFeedback", "Customer name es obligatorio.", "err");
            return false;
          }
          if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
            setNotice("hubFormFeedback", "Customer email no tiene formato valido.", "err");
            return false;
          }
          updateProjectById(row.projectId, {
            clientName: clientName.trim(),
            clientEmail: clientEmail.trim(),
            clientPhone: clientPhone.trim(),
            location: location.trim()
          });
          return true;
        }
      });
    };

    const openInvoiceSetupForm = (row) => {
      const invoice = getProjectInvoiceState(row.project);
      const curLbl = sanitizeInvoiceLabelInput(invoice.invoiceLabel);
      const presetMatch = MG_HUB_INVOICE_LABEL_PRESETS.includes(curLbl) ? curLbl : "";
      const customInitial = presetMatch ? "" : curLbl;
      const purposeInitial = hubInferInvoicePurposeFromLabel(curLbl);
      const presetFieldOptions = [{ value: "", label: "— Preset (optional) —" }].concat(
        MG_HUB_INVOICE_LABEL_PRESETS.map((p) => ({ value: p, label: p }))
      );
      showHubActionForm({
        title: "Configurar invoice",
        subtitle: `${row.title} · ${row.customer}`,
        submitLabel: "Guardar invoice",
        successMessage: "Invoice guardado (incl. payment label).",
        afterRender: () => {
          const updateInvoiceSetupLabelPreview = () => {
            const el = $("hubFormInvoiceLabelPreview");
            if (!el) return;
            const txt = resolveHubInvoiceLabelFromForm(val("hubFormInvoiceLabelPreset"), val("hubFormInvoiceLabelCustom"));
            el.textContent = txt ? `Public invoice will show: ${txt}` : "Public invoice will show: —";
          };
          const syncPurposeFromPresetAndCustom = () => {
            const purposeEl = $("hubFormInvoicePurpose");
            if (!purposeEl) return;
            const cust = String(val("hubFormInvoiceLabelCustom") || "").trim();
            if (cust) {
              purposeEl.value = "";
            } else {
              purposeEl.value = hubInferInvoicePurposeFromLabel(
                resolveHubInvoiceLabelFromForm(val("hubFormInvoiceLabelPreset"), "")
              );
            }
            updateInvoiceSetupLabelPreview();
          };
          const purposeEl = $("hubFormInvoicePurpose");
          if (purposeEl) {
            purposeEl.onchange = () => {
              const p = purposeEl.value;
              const presetEl = $("hubFormInvoiceLabelPreset");
              const customEl = $("hubFormInvoiceLabelCustom");
              if (p && Object.prototype.hasOwnProperty.call(MG_HUB_INVOICE_PURPOSE_TO_PRESET, p)) {
                if (presetEl) presetEl.value = MG_HUB_INVOICE_PURPOSE_TO_PRESET[p];
                if (customEl) customEl.value = "";
              }
              updateInvoiceSetupLabelPreview();
            };
          }
          const presetEl = $("hubFormInvoiceLabelPreset");
          const customEl = $("hubFormInvoiceLabelCustom");
          if (presetEl) {
            presetEl.addEventListener("change", syncPurposeFromPresetAndCustom);
          }
          if (customEl) {
            customEl.addEventListener("input", syncPurposeFromPresetAndCustom);
            customEl.addEventListener("change", syncPurposeFromPresetAndCustom);
          }
          syncPurposeFromPresetAndCustom();
        },
        fields: [
          { id: "hubFormInvoiceNo", label: "Invoice No", type: "text", value: invoice.invoiceNo || "", placeholder: "INV-1001" },
          {
            id: "hubFormInvoicePurpose",
            label: "Purpose of invoice",
            type: "select",
            value: purposeInitial,
            options: [
              { value: "", label: "Select purpose…" },
              { value: "deposit", label: "Deposit — start project" },
              { value: "progress", label: "Progress payment" },
              { value: "final", label: "Final payment" }
            ],
            hint: "Sets the default label the client sees. Fine-tune below if needed."
          },
          {
            id: "hubFormInvoiceLabelPreset",
            label: "Exact wording (optional)",
            type: "select",
            value: presetMatch,
            options: presetFieldOptions
          },
          {
            id: "hubFormInvoiceLabelCustom",
            label: "Custom label (optional)",
            type: "text",
            value: customInitial,
            placeholder: "Overrides preset when filled",
            hint: "Custom text wins over the preset."
          },
          {
            type: "static",
            html: `<div class="hub-invoice-setup-preview" id="hubFormInvoiceLabelPreviewWrap"><div id="hubFormInvoiceLabelPreview" class="hub-invoice-setup-preview-line">Public invoice will show: —</div></div>`
          },
          {
            id: "hubFormInvoiceDate",
            label: "Invoice Date",
            type: "date",
            value: invoice.invoiceDate || new Date().toISOString().slice(0, 10),
            quickDates: [{ label: "Today", kind: "today" }]
          },
          {
            id: "hubFormInvoiceDueDate",
            label: "Due Date (optional)",
            type: "date",
            value: invoice.dueDate || row.project?.dueDate || "",
            quickDates: [
              { label: "Today", kind: "today" },
              { label: "+7 days", kind: "today_plus", days: 7 },
              { label: "+14 days", kind: "today_plus", days: 14 },
              { label: "+30 days", kind: "today_plus", days: 30 }
            ]
          },
          { id: "hubFormInvoiceBase", label: "Base Amount", type: "number", step: "0.01", value: invoice.baseAmount || row.project?.salePrice || 0, placeholder: "0.00" }
        ],
        onSubmit: () => {
          const invoiceNo = val("hubFormInvoiceNo");
          const invoiceDate = val("hubFormInvoiceDate");
          const dueDate = val("hubFormInvoiceDueDate");
          const baseAmount = Number(val("hubFormInvoiceBase"));
          const invoiceLabel = resolveHubInvoiceLabelFromForm(val("hubFormInvoiceLabelPreset"), val("hubFormInvoiceLabelCustom"));
          if (!normalizeDateInput(invoiceDate)) {
            setNotice("hubFormFeedback", "Invoice date es obligatoria.", "err");
            return false;
          }
          if (dueDate && !normalizeDateInput(dueDate)) {
            setNotice("hubFormFeedback", "Due date no tiene formato valido.", "err");
            return false;
          }
          if (!Number.isFinite(baseAmount) || baseAmount < 0) {
            setNotice("hubFormFeedback", "Base amount debe ser un numero valido.", "err");
            return false;
          }
          const isServerOnly = row.hubRowSource === "server_invoice";
          const sid = String(row.serverInvoiceId || "").trim();
          if (isServerOnly) {
            if (!MG_SERVER_INVOICE_UUID_RE.test(sid)) {
              setNotice("hubFormFeedback", "Este invoice de servidor no tiene UUID valido.", "err");
              return false;
            }
            return (async () => {
              const nextInvoice = buildHubInvoiceState(row.project, row.report, {
                invoiceNo,
                invoiceDate,
                dueDate,
                baseAmount,
                invoiceLabel,
                serverInvoiceId: sid
              });
              nextInvoice.activity = appendInvoiceActivity(nextInvoice, "Invoice setup updated.", undefined, "invoice");
              const body = buildTenantInvoiceDraftBody(row.project, row.report, nextInvoice);
              if (!body) {
                setNotice("hubFormFeedback", "No se pudo construir el payload.", "err");
                return false;
              }
              body.id = sid;
              const saved = await saveTenantInvoiceDraftToServer(body);
              if (!saved?.id) {
                setNotice("hubFormFeedback", "No se pudo guardar en el servidor.", "err");
                return false;
              }
              void refreshHubServerInvoicesCacheQuietly();
              return true;
            })();
          }
          if (!getProjectById(row.projectId)) {
            setNotice("hubFormFeedback", "Proyecto no encontrado.", "err");
            return false;
          }
          const nextInvoice = buildHubInvoiceState(row.project, row.report, {
            invoiceNo,
            invoiceDate,
            dueDate,
            baseAmount,
            invoiceLabel
          });
          nextInvoice.activity = appendInvoiceActivity(nextInvoice, "Invoice setup updated.", undefined, "invoice");
          saveProjectInvoiceState(row.projectId, nextInvoice);
          return true;
        }
      });
    };

    const openTemplateEditorForm = () => {
      const templates = loadHubTemplates();
      showHubActionForm({
        title: "Communication templates",
        subtitle: "Edita subject y body para invoice y cobranza. Usa tokens como {{customer}}, {{project}}, {{invoice_no}}, {{balance}}.",
        submitLabel: "Guardar templates",
        fields: [
          {
            id: "hubFormTemplateKey",
            label: "Template",
            type: "select",
            value: "invoice_send",
            options: [
              { value: "invoice_send", label: "invoice_send" },
              { value: "payment_request", label: "payment_request" }
            ]
          },
          { id: "hubFormTemplateSubject", label: "Subject", type: "textarea", rows: 3, value: templates.invoice_send.subject || "" },
          { id: "hubFormTemplateBody", label: "Body", type: "textarea", rows: 10, value: templates.invoice_send.body || "" }
        ],
        onSubmit: () => {
          const templateKey = val("hubFormTemplateKey");
          const subject = val("hubFormTemplateSubject");
          const body = val("hubFormTemplateBody");
          if (!subject.trim() || !body.trim()) {
            setNotice("hubFormFeedback", "Subject y body son obligatorios.", "err");
            return false;
          }
          const nextTemplates = loadHubTemplates();
          nextTemplates[templateKey] = { subject, body };
          saveHubTemplates(nextTemplates);
          return true;
        }
      });

      const templateSelect = $("hubFormTemplateKey");
      const syncTemplateFields = () => {
        const currentTemplates = loadHubTemplates();
        const templateKey = val("hubFormTemplateKey") || "invoice_send";
        const current = currentTemplates[templateKey] || DEFAULT_HUB_TEMPLATES[templateKey];
        setVal("hubFormTemplateSubject", current?.subject || "");
        setVal("hubFormTemplateBody", current?.body || "");
      };
      if (templateSelect) templateSelect.onchange = syncTemplateFields;
    };

    const refresh = () => {
      if (!MG_HUB_INVOICE_VIEW_MODES.has(hubViewMode)) hubViewMode = "all";
      const tpSync = hubViewModeToTabPreset(hubViewMode);
      activeTab = tpSync.tab;
      activePreset = tpSync.preset;
      const localRows = buildPortfolioRows(settings);
      const normalizedServer =
        hubServerNormalizedInvoicesCache === undefined ? [] : hubServerNormalizedInvoicesCache;
      lastMergedHubRows = mergeHubRows(localRows, normalizedServer);
      const allRows = lastMergedHubRows;
      const search = val("hubSearch").trim().toLowerCase();
      const statusFilter = val("hubStatusFilter") || "all";
      const dateFrom = normalizeDateInput(val("hubDateFrom"));
      const customerFilter = val("hubCustomerFilter").trim().toLowerCase();
      const locationFilter = val("hubLocationFilter").trim().toLowerCase();

      filteredRows = allRows.filter((row) => {
        switch (hubViewMode) {
          case "all":
            break;
          case "ready_to_bill":
            if (!hubRowMatchesReadyToBillView(row)) return false;
            break;
          case "sent":
            if (String(row.status || "").toLowerCase() !== "sent") return false;
            break;
          case "paid":
            if (String(row.status || "").toLowerCase() !== "paid") return false;
            break;
          case "needs_action": {
            if (
              row.hubRowSource === "server_invoice" &&
              String(row.hubInvoiceRawStatus || "").toLowerCase() === "archived"
            ) {
              return false;
            }
            const na = row.nextAction || "";
            const urgent = row.priorityScore >= 60 || ["overdue", "expired", "partial"].includes(row.status);
            const pending = !["Healthy", "Paid", "Void", ""].includes(na);
            if (!(urgent || pending)) return false;
            break;
          }
          default:
            break;
        }
        if (search && !row.searchText.includes(search)) return false;
        if (statusFilter === "all") {
          if (
            row.hubRowSource === "server_invoice" &&
            String(row.hubInvoiceRawStatus || "").toLowerCase() === "archived"
          ) {
            return false;
          }
        } else if (statusFilter === "archived") {
          if (String(row.status || "").toLowerCase() !== "archived") return false;
        } else if (statusFilter === "accepted") {
          if (
            row.hubRowSource === "server_invoice" &&
            String(row.hubInvoiceRawStatus || "").toLowerCase() === "archived"
          ) {
            return false;
          }
          const acceptedAt = nonEmptyString(row.hubQuoteAcceptedAt);
          const quoteAccepted = String(row.hubQuoteStatus || "").trim().toLowerCase() === "accepted";
          const displayAccepted = String(row.status || "").trim().toLowerCase() === "accepted";
          if (!(acceptedAt || quoteAccepted || displayAccepted)) return false;
        } else if (row.status !== statusFilter) {
          return false;
        }
        if (dateFrom && row.dateRaw && row.dateRaw < dateFrom) return false;
        if (customerFilter && !row.customer.toLowerCase().includes(customerFilter)) return false;
        if (locationFilter && !row.location.toLowerCase().includes(locationFilter)) return false;
        return true;
      });

      filteredRows = filteredRows.slice().sort((left, right) => {
        const comparison = compareHubValues(left?.[sortKey], right?.[sortKey], sortKey);
        return sortDir === "asc" ? comparison : -comparison;
      });
      applyHubSortButtons();
      persistHubView();

      const hubTableDisplayRows = sortHubRowsForCollectDisplay(filteredRows, sortKey, sortDir);

      const totalBalance = filteredRows.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
      const paidAmount = filteredRows
        .filter((row) => row.status === "paid")
        .reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
      const waitingPaymentTotal = filteredRows
        .filter((row) => hubRowMatchesWaitingPaymentKpi(row))
        .reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
      const readySendCount = filteredRows.filter((row) => hubRowMatchesReadyToBillView(row)).length;
      const waitingCount = filteredRows.filter((row) => hubRowMatchesWaitingPaymentKpi(row)).length;
      const paidCount = filteredRows.filter((row) => row.status === "paid").length;
      const openJobCount = filteredRows.filter((row) => finiteNumber(row.balance, 0) > 0).length;

      if ($("hubHeroTotal")) $("hubHeroTotal").textContent = money(totalBalance, settings.currency);
      if ($("hubHeroMeta")) {
        $("hubHeroMeta").textContent = filteredRows.length
          ? `${filteredRows.length} jobs · ${money(totalBalance, settings.currency)} in outstanding invoice balances`
          : "No invoices yet. Create an estimate to get started.";
      }
      if ($("hubPortfolioBadge")) $("hubPortfolioBadge").textContent = `${filteredRows.length} jobs`;
      if ($("hubTableBadge")) {
        $("hubTableBadge").textContent =
          hubViewMode === "all" && statusFilter !== "all" ? statusFilter : hubInvoiceHubViewTitleLabel(hubViewMode);
      }

      if ($("hubKpiTotalCollect")) $("hubKpiTotalCollect").textContent = money(totalBalance, settings.currency);
      if ($("hubKpiTotalCollectMeta")) {
        $("hubKpiTotalCollectMeta").textContent = `${openJobCount} jobs with an outstanding invoice balance`;
      }
      if ($("hubKpiStartWithValue")) {
        $("hubKpiStartWithValue").textContent = hubTableDisplayRows.length
          ? hubKpiStartWithValueLine(hubTableDisplayRows, settings)
          : "—";
      }
      if ($("hubKpiStartWithMeta")) {
        $("hubKpiStartWithMeta").textContent = hubTableDisplayRows.length
          ? `${readySendCount} invoice${readySendCount === 1 ? "" : "s"} ready to send`
          : "You're all caught up 🎉";
      }

      const showWaitingKpi = waitingCount > 0 || waitingPaymentTotal > 0;
      const showPaidKpi = paidCount > 0 || paidAmount > 0;
      if ($("hubKpiWaitingCard")) {
        $("hubKpiWaitingCard").hidden = !showWaitingKpi;
        if (showWaitingKpi) {
          if ($("hubKpiWaitingAmount")) $("hubKpiWaitingAmount").textContent = money(waitingPaymentTotal, settings.currency);
          if ($("hubKpiWaitingMeta")) {
            $("hubKpiWaitingMeta").textContent = `${waitingCount} with outstanding invoice balance`;
          }
        }
      }
      if ($("hubKpiPaidCard")) {
        $("hubKpiPaidCard").hidden = !showPaidKpi;
        if (showPaidKpi) {
          if ($("hubKpiPaidAmount")) $("hubKpiPaidAmount").textContent = money(paidAmount, settings.currency);
          if ($("hubKpiPaidMeta")) {
            $("hubKpiPaidMeta").textContent = `${paidCount} paid in this view`;
          }
        }
      }
      if ($("hubKpiSecondaryRow")) {
        $("hubKpiSecondaryRow").style.display = showWaitingKpi || showPaidKpi ? "grid" : "none";
      }

      if ($("hubHeroStartWith")) {
        $("hubHeroStartWith").textContent = hubHeroStartWithLine(hubTableDisplayRows, settings);
      }

      renderHubTableSection({
        filteredRows,
        displayOrderedRows: hubTableDisplayRows,
        mergedHubRows: lastMergedHubRows,
        selectedProjectIds,
        settings,
        activeTab,
        refreshBulkBar,
        onOpenRow: openHubDrawer,
        onPay: (row, projectId) => {
          if (row?.hubRowSource === "server_invoice") return;
          if (!guardHubAction(row, "canTakePayment", "Take Payment solo aplica cuando ya existe invoice con saldo pendiente.")) return;
          openPaymentForm(row, null, ({ amount, method, note, date }) => {
            recordHubPayment(projectId, { amount, method, note, date });
          });
          hubFormState.successMessage = `Pago registrado para ${row.title}.`;
        },
        onMarkPaid: (row) => {
          if (row?.hubRowSource === "server_invoice") return;
          if (!guardHubAction(row, "canMarkPaid", "Mark Paid solo aplica cuando existe invoice con saldo pendiente.")) return;
          markHubInvoicePaid(row.projectId);
          refresh();
          setHubFeedback(`Invoice marcado como paid para ${row.title}.`, "ok");
        },
        onSendInvoice: (row) => {
          if (!guardHubAction(row, "canSendInvoice", "Necesitas invoice, cliente y monto antes de enviar.")) return;
          void (async () => {
            if (row.hubRowSource === "server_invoice") {
              await sendHubServerInvoiceRow(row);
            } else {
              await sendHubInvoice(row.projectId);
              setHubFeedback(`Invoice email draft prepared for ${row.customer}.`, "ok");
            }
            refresh();
          })();
        },
        onArchiveServerInvoice: async (row) => {
          const iid = String(row.serverInvoiceId || "").trim();
          if (!MG_SERVER_INVOICE_UUID_RE.test(iid)) {
            setHubFeedback("No invoice valido para archivar.", "warn");
            return;
          }
          const { ok, data } = await postHubInvoiceArchiveDelete(iid, "archive");
          if (!ok) {
            setHubFeedback(data?.error || "No se pudo archivar.", "err");
            return;
          }
          if (typeof window.__mgHubRefetchServerInvoices === "function") {
            await window.__mgHubRefetchServerInvoices();
          }
          if (selectedRow && String(selectedRow.serverInvoiceId || "") === iid) {
            const sf = val("hubStatusFilter") || "all";
            if (sf === "all") closeHubDrawer();
            else {
              const next = lastMergedHubRows.find((r) => String(r.serverInvoiceId || "") === iid);
              if (next) openHubDrawer(next);
              else closeHubDrawer();
            }
          }
          setHubFeedback("Invoice archivado.", "ok");
        },
        onDeleteServerInvoice: async (row) => {
          const iid = String(row.serverInvoiceId || "").trim();
          if (!MG_SERVER_INVOICE_UUID_RE.test(iid)) {
            setHubFeedback("No invoice valido para borrar.", "warn");
            return;
          }
          openHubDeleteInvoiceConfirmModal(row, async () => {
            const { ok, data } = await postHubInvoiceArchiveDelete(iid, "delete");
            if (!ok) {
              const msg = String(data?.error || "Could not delete invoice.");
              throw new Error(msg);
            }
            if (typeof window.__mgHubRefetchServerInvoices === "function") {
              await window.__mgHubRefetchServerInvoices();
            }
            if (selectedRow && String(selectedRow.serverInvoiceId || "") === iid) {
              closeHubDrawer();
            }
            setHubFeedback("Invoice eliminado.", "ok");
          });
        }
      });

      renderHubPipelineSection({
        filteredRows,
        activeTab,
        settings,
        onOpenRow: openHubDrawer,
        onSent: (row) => {
          markHubInvoiceSent(row.projectId);
          refresh();
          setHubFeedback(`Invoice marcado como sent para ${row.title}.`, "ok");
        },
        onRequest: (row) => {
          requestHubPayment(row.projectId);
          refresh();
          setHubFeedback(`Recordatorio de pago preparado para ${row.customer}.`, "ok");
        },
        onContacted: (row) => {
          setHubCollectionStage(row.projectId, "contacted");
          refresh();
          setHubFeedback(`Collections stage actualizado a contacted para ${row.title}.`, "ok");
        },
        onPromise: (row) => {
          openHubFormModal({
            title: "Promised payment",
            subtitle: `${row.title} · ${row.customer}`,
            submitLabel: "Guardar promesa",
            fields: [
              { id: "hubFormQuickPromiseDate", label: "Promised Payment Date", type: "date", value: row.promisedDateRaw || "" }
            ],
            onSubmit: () => {
              const promisedDate = val("hubFormQuickPromiseDate");
              if (!normalizeDateInput(promisedDate)) {
                setNotice("hubFormFeedback", "Promised payment date es obligatoria.", "err");
                return false;
              }
              setHubPromise(row.projectId, promisedDate);
              return true;
            },
            successMessage: `Promesa registrada para ${row.title}.`
          });
        },
        onEscalate: (row) => {
          if (row?.hubRowSource === "server_invoice") return;
          setHubCollectionStage(row.projectId, "escalated");
          refresh();
          setHubFeedback(`Collections stage actualizado a escalated para ${row.title}.`, "warn");
        },
        onDropColumn: (row, targetKey) => {
          if (row?.hubRowSource === "server_invoice") return;
          const outcome = getHubDropOutcome(row, targetKey);
          if (!outcome.ok) {
            setHubFeedback(outcome.reason || "No fue posible mover la tarjeta.", "warn");
            return;
          }
          if (outcome.kind === "workflow") {
            const result = setHubInvoiceWorkflowState(row.projectId, outcome.nextStatus, {
              activityMessage: `Workflow moved to ${outcome.nextStatus} from pipeline.`
            });
            if (!result.ok) {
              setHubFeedback(result.reason || "No fue posible mover la tarjeta.", "warn");
              return;
            }
          } else if (outcome.kind === "paid") {
            markHubInvoicePaid(row.projectId);
          } else if (outcome.kind === "escalate") {
            setHubCollectionStage(row.projectId, "escalated");
          }
          refresh();
          refreshSelectedRow();
          setHubFeedback(`${outcome.message} para ${row.title}.`, outcome.tone || "ok");
        }
      });

      syncHubInvoiceHubChrome();
      window.__MG_INVOICE_HUB_VIEW__ = {
        mode: hubViewMode,
        status: val("hubStatusFilter"),
        search: val("hubSearch"),
        dateFrom: val("hubDateFrom"),
        client: val("hubCustomerFilter"),
        location: val("hubLocationFilter")
      };
    };

    let hubRecordPaySubmitting = false;
    const hubRecordPayModalCtx = { remaining: 0, paymentCount: 0 };

    function syncHubRecordPayAmountDefault() {
      if (!$("hubRecordPayType")) return;
      const t = val("hubRecordPayType");
      const r = finiteNumber(hubRecordPayModalCtx.remaining, 0);
      if (t === "final" && r > 0) setVal("hubRecordPayAmount", String(r));
      updateHubRecordPayOverpayWarning();
    }

    function updateHubRecordPayOverpayWarning() {
      const warnEl = $("hubRecordPayOverpayWarn");
      if (!warnEl) return;
      const payment_type = val("hubRecordPayType");
      const rem = finiteNumber(hubRecordPayModalCtx.remaining, 0);
      const raw = val("hubRecordPayAmount");
      const amt = raw === "" || raw === undefined ? NaN : Number(raw);
      if (payment_type === "adjustment" || !Number.isFinite(amt)) {
        warnEl.style.display = "none";
        warnEl.textContent = "";
        return;
      }
      if (amt > rem + 1e-6) {
        warnEl.style.display = "block";
        warnEl.className = "notice warn";
        warnEl.textContent = `This amount (${money(amt, settings.currency)}) is above remaining (${money(rem, settings.currency)}). You can still submit if intended.`;
        return;
      }
      warnEl.style.display = "none";
      warnEl.textContent = "";
    }

    async function openHubRecordPaymentModal() {
      if (!selectedRow || !hubRowCanRecordLedgerPayment(selectedRow)) return;
      const modal = $("hubRecordPaymentModal");
      if (!modal) return;
      setNotice("hubRecordPayFeedback", "", "");
      if ($("hubRecordPaySubtitle")) {
        $("hubRecordPaySubtitle").textContent = `${selectedRow.title} · ${selectedRow.customer}`;
      }
      const data = await fetchHubDrawerLedgerPayments(selectedRow);
      const payments = Array.isArray(data?.payments) ? data.payments : [];
      const netSum = Number.isFinite(data?.netSum)
        ? data.netSum
        : payments.reduce((s, p) => s + finiteNumber(p?.amount, 0), 0);
      const amountTotal = finiteNumber(selectedRow.amount, 0);
      hubRecordPayModalCtx.remaining = Math.max(0, amountTotal - netSum);
      hubRecordPayModalCtx.paymentCount = payments.length;
      setVal("hubRecordPayType", payments.length === 0 ? "deposit" : "progress");
      setVal("hubRecordPayMethod", "check");
      setVal("hubRecordPayDate", new Date().toISOString().slice(0, 10));
      setVal("hubRecordPayAmount", "");
      setVal("hubRecordPayNotes", "");
      syncHubRecordPayAmountDefault();
      modal.setAttribute("aria-hidden", "false");
    }

    async function submitHubRecordPayment() {
      if (!selectedRow || hubRecordPaySubmitting) return;
      if (!hubRowCanRecordLedgerPayment(selectedRow)) {
        setNotice(
          "hubRecordPayFeedback",
          "This row needs at least one valid invoice_id, quote_id, or project_id for the ledger.",
          "err"
        );
        return;
      }
      const ids = hubLedgerTargetIds(selectedRow);
      const payment_type = val("hubRecordPayType");
      const payment_method = val("hubRecordPayMethod");
      const amountRaw = Number(val("hubRecordPayAmount"));
      const paidDate = val("hubRecordPayDate");
      const notes = String(val("hubRecordPayNotes") || "");

      const types = ["deposit", "progress", "final", "adjustment"];
      const methods = ["check", "cash", "zelle", "stripe", "bank_transfer", "other"];
      if (!types.includes(payment_type)) {
        setNotice("hubRecordPayFeedback", "Pick a valid payment type.", "err");
        return;
      }
      if (!methods.includes(payment_method)) {
        setNotice("hubRecordPayFeedback", "Pick a valid payment method.", "err");
        return;
      }
      if (!paidDate) {
        setNotice("hubRecordPayFeedback", "Paid date is required.", "err");
        return;
      }

      let amount = amountRaw;
      if (payment_type === "adjustment") {
        if (!Number.isFinite(amount) || amount === 0) {
          setNotice("hubRecordPayFeedback", "Adjustment amount must be non-zero.", "err");
          return;
        }
      } else if (!Number.isFinite(amount) || amount <= 0) {
        setNotice("hubRecordPayFeedback", "Amount must be greater than zero.", "err");
        return;
      }

      const parsed = Date.parse(paidDate.length <= 10 ? `${paidDate}T12:00:00` : paidDate);
      if (!Number.isFinite(parsed)) {
        setNotice("hubRecordPayFeedback", "Invalid paid date.", "err");
        return;
      }
      const body = {
        invoice_id: ids.invoiceId || null,
        quote_id: ids.quoteId || null,
        project_id: ids.projectId || null,
        payment_type,
        payment_method,
        amount,
        paid_at: new Date(parsed).toISOString(),
        notes
      };

      hubRecordPaySubmitting = true;
      const submitBtn = $("btnHubRecordPaySubmit");
      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch("/.netlify/functions/record-tenant-payment", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
          setNotice("hubRecordPayFeedback", data?.error || "Unable to record payment.", "err");
          return;
        }
        if ($("hubRecordPaymentModal")) $("hubRecordPaymentModal").setAttribute("aria-hidden", "true");
        setNotice("hubRecordPayFeedback", "", "");
        if ($("hubRecordPayOverpayWarn")) {
          $("hubRecordPayOverpayWarn").style.display = "none";
          $("hubRecordPayOverpayWarn").textContent = "";
        }
        if (typeof window.__mgHubRefetchServerInvoices === "function") {
          await window.__mgHubRefetchServerInvoices();
        }
        refresh();
        refreshSelectedRow();
        setHubFeedback("Payment recorded in ledger.", "ok");
      } finally {
        hubRecordPaySubmitting = false;
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    ["hubSearch", "hubStatusFilter", "hubDateFrom", "hubCustomerFilter", "hubLocationFilter"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.oninput = refresh;
      if (el.tagName === "SELECT") el.onchange = refresh;
    });

    setVal("hubSearch", hubViewState.search || "");
    setVal("hubStatusFilter", hubViewState.status || "all");
    setVal("hubDateFrom", hubViewState.dateFrom || "");
    setVal("hubCustomerFilter", hubViewState.customer || "");
    if ($("hubLocationFilter")) setVal("hubLocationFilter", hubViewState.location || "");

    if ($("hubModeFilter")) {
      $("hubModeFilter").querySelectorAll("button[data-hub-mode]").forEach((button) => {
        button.onclick = () => {
          hubViewMode = button.dataset.hubMode || "all";
          const tp = hubViewModeToTabPreset(hubViewMode);
          activeTab = tp.tab;
          activePreset = tp.preset;
          clearHubFiltersIncompatibleWithMode(hubViewMode);
          syncHubInvoiceHubChrome();
          refresh();
        };
      });
    }

    document.querySelectorAll("[data-hub-sort]").forEach((button) => {
      button.onclick = () => {
        const nextKey = button.dataset.hubSort || "dateRaw";
        if (sortKey === nextKey) {
          sortDir = sortDir === "asc" ? "desc" : "asc";
        } else {
          sortKey = nextKey;
          sortDir = nextKey === "amount" || nextKey === "balance" || nextKey === "dateRaw" ? "desc" : "asc";
        }
        refresh();
      };
    });

    if ($("hubSelectAll")) {
      $("hubSelectAll").onchange = () => {
        if ($("hubSelectAll").checked) {
          filteredRows.forEach((row) => selectedProjectIds.add(row.projectId));
        } else {
          filteredRows.forEach((row) => selectedProjectIds.delete(row.projectId));
        }
        refresh();
      };
    }

    if ($("btnHubAutoQueue")) {
      $("btnHubAutoQueue").onclick = () => {
        const queued = queueHubAutoReminders(filteredRows);
        refresh();
        setHubFeedback(
          queued ? `${queued} reminders quedaron en auto queue para seguimiento.` : "No habia reminders nuevos para preparar hoy.",
          queued ? "ok" : "warn"
        );
      };
    }
    if ($("btnHubAutoStage")) {
      $("btnHubAutoStage").onclick = () => {
        const updated = runHubStageAutomation(filteredRows);
        refresh();
        setHubFeedback(
          updated ? `${updated} rows quedaron normalizadas por Auto Stage.` : "No habia rows que necesitaran ajuste automatico de stage.",
          updated ? "ok" : "warn"
        );
      };
    }
    if ($("btnHubCampaigns")) {
      $("btnHubCampaigns").onclick = () => {
        const segments = buildCampaignSegments(filteredRows, settings);
        openHubFormModal({
          title: "Collections campaigns",
          subtitle: "Selecciona un segmento para preparar seguimiento masivo dentro del hub.",
          submitLabel: "Queue Campaign",
          fields: [
            {
              id: "hubFormCampaignSegment",
              label: "Segment",
              type: "select",
              value: segments[0]?.[0] || "overdue",
              options: segments.map(([value, label, count, amount]) => ({
                value,
                label: `${label} · ${count} rows · ${amount}`
              }))
            }
          ],
          onSubmit: () => {
            const segmentKey = val("hubFormCampaignSegment");
            const queued = queueCampaignSegment(filteredRows, segmentKey);
            if (!queued) {
              setNotice("hubFormFeedback", "No habia rows validas para ese segmento.", "warn");
              return false;
            }
            hubFormState.successMessage = `${queued} rows quedaron en campaign queue (${segmentKey}).`;
            return true;
          }
        });
      };
    }
    if ($("btnHubTemplates")) {
      $("btnHubTemplates").onclick = () => {
        openTemplateEditorForm();
        hubFormState.successMessage = "Templates de comunicacion guardados.";
      };
    }
    if ($("btnHubCreateInvoice")) {
      $("btnHubCreateInvoice").onclick = () => {
        openCreateManualInvoiceForm();
      };
    }
    if ($("btnHubBulkClear")) {
      $("btnHubBulkClear").onclick = () => {
        selectedProjectIds.clear();
        refresh();
        setHubFeedback("Seleccion multiple limpiada.", "ok");
      };
    }
    if ($("btnHubBulkExport")) {
      $("btnHubBulkExport").onclick = () => {
        const selectedRows = filteredRows.filter((row) => selectedProjectIds.has(row.projectId));
        exportPortfolioCsv(selectedRows, settings);
      };
    }
    if ($("btnHubBulkSent")) {
      $("btnHubBulkSent").onclick = () => {
        const selectedRows = filteredRows.filter((row) => selectedProjectIds.has(row.projectId));
        let updated = 0;
        selectedRows.forEach((row) => {
          if (getHubRowActionState(row).canMarkSent) {
            markHubInvoiceSent(row.projectId);
            updated += 1;
          }
        });
        refresh();
        setHubFeedback(updated ? `${updated} invoices marcadas como sent.` : "No habia invoices validas para marcar como sent.", updated ? "ok" : "warn");
      };
    }
    if ($("btnHubBulkRequest")) {
      $("btnHubBulkRequest").onclick = () => {
        const selectedRows = filteredRows.filter((row) => selectedProjectIds.has(row.projectId));
        let prepared = 0;
        selectedRows.forEach((row) => {
          if (getHubRowActionState(row).canRequestPayment) {
            const project = getProjectById(row.projectId);
            if (!project) return;
            const report = loadSupervisorReport(project);
            const invoice = getProjectInvoiceState(project);
            const nextInvoice = buildHubInvoiceState(project, report, { status: invoice.status || "sent" });
            nextInvoice.activity = appendInvoiceActivity(nextInvoice, "Bulk payment reminder prepared.");
            saveProjectInvoiceState(row.projectId, nextInvoice);
            prepared += 1;
          }
        });
        refresh();
        setHubFeedback(prepared ? `${prepared} reminders listas para seguimiento manual.` : "No habia invoices con saldo para reminder.", prepared ? "ok" : "warn");
      };
    }

    if ($("btnHubDrawerClose")) $("btnHubDrawerClose").onclick = closeHubDrawer;
    if ($("hubRecordPayType")) {
      $("hubRecordPayType").onchange = () => syncHubRecordPayAmountDefault();
    }
    if ($("hubRecordPayAmount")) {
      $("hubRecordPayAmount").oninput = () => updateHubRecordPayOverpayWarning();
    }
    if ($("btnHubRecordPayClose")) {
      $("btnHubRecordPayClose").onclick = () => {
        if ($("hubRecordPaymentModal")) $("hubRecordPaymentModal").setAttribute("aria-hidden", "true");
        setNotice("hubRecordPayFeedback", "", "");
        if ($("hubRecordPayOverpayWarn")) {
          $("hubRecordPayOverpayWarn").style.display = "none";
          $("hubRecordPayOverpayWarn").textContent = "";
        }
      };
    }
    if ($("btnHubRecordPayCancel")) {
      $("btnHubRecordPayCancel").onclick = () => {
        if ($("hubRecordPaymentModal")) $("hubRecordPaymentModal").setAttribute("aria-hidden", "true");
        setNotice("hubRecordPayFeedback", "", "");
        if ($("hubRecordPayOverpayWarn")) {
          $("hubRecordPayOverpayWarn").style.display = "none";
          $("hubRecordPayOverpayWarn").textContent = "";
        }
      };
    }
    if ($("btnHubRecordPaySubmit")) {
      $("btnHubRecordPaySubmit").onclick = () => {
        void submitHubRecordPayment();
      };
    }
    if ($("btnHubClientClose")) $("btnHubClientClose").onclick = closeHubClientDetail;
    if ($("btnHubFormClose")) $("btnHubFormClose").onclick = closeHubFormModal;
    if ($("btnHubFormCancel")) $("btnHubFormCancel").onclick = closeHubFormModal;
    if ($("btnHubFormSubmit")) {
      $("btnHubFormSubmit").onclick = async () => {
        if (!hubFormState?.onSubmit) {
          closeHubFormModal();
          return;
        }
        const successMessage = hubFormState.successMessage || "Cambios guardados.";
        const result = hubFormState.onSubmit();
        const resolved = result && typeof result.then === "function" ? await result : result;
        if (resolved === false) return;
        closeHubFormModal();
        refresh();
        refreshSelectedRow();
        setHubFeedback(successMessage, "ok");
      };
    }
    if ($("btnHubDrawerPdf")) {
      $("btnHubDrawerPdf").onclick = () => {
        if (!selectedRow) return;
        if (selectedRow?.hubRowSource === "server_invoice") {
          const invoice = getProjectInvoiceState(selectedRow.project);
          const publicUrl = invoice.publicUrl || (invoice.publicToken ? `/invoice-public.html?token=${invoice.publicToken}` : "");
          if (!publicUrl) {
            setHubFeedback("Primero publica el invoice para generar el link publico.", "warn");
            return;
          }
          window.open(publicUrl, "_blank", "noopener");
          return;
        }
        void exportInvoicePdf("hub", selectedRow.project, selectedRow.report, settings, getProjectInvoiceState(selectedRow.project));
      };
    }
    if ($("btnHubDrawerInvoiceSetup")) {
      $("btnHubDrawerInvoiceSetup").onclick = () => {
        if (!selectedRow) return;
        openInvoiceSetupForm(selectedRow);
      };
    }
    if ($("btnHubDrawerRecordPayment")) {
      $("btnHubDrawerRecordPayment").onclick = () => {
        void openHubRecordPaymentModal();
      };
    }
    if ($("btnHubDrawerOpenPublic")) {
      $("btnHubDrawerOpenPublic").onclick = () => {
        if (!selectedRow) return;
        const invoice = getProjectInvoiceState(selectedRow.project);
        const publicUrl = invoice.publicUrl || (invoice.publicToken ? `/invoice-public.html?token=${invoice.publicToken}` : "");
        if (!publicUrl) {
          setHubFeedback("Primero publica el invoice para generar el link publico.", "warn");
          return;
        }
        window.open(publicUrl, "_blank", "noopener");
      };
    }
    if (!window.__MG_SEND_INVOICE_HANDLER_BOUND__) {
      window.__MG_SEND_INVOICE_HANDLER_BOUND__ = true;
      console.log("[Invoice Hub] send invoice listener attached");
      document.addEventListener("click", async function (event) {
        const btn = event.target.closest("[data-hub-send-invoice]");
        if (!btn) return;
        event.preventDefault();
        event.stopPropagation();
        console.log("[Invoice Hub] Send Invoice clicked");

        const row = window.__MG_ACTIVE_INVOICE_ROW__ || window.activeInvoiceRow || window.selectedInvoiceRow || null;
        console.log("[DEBUG ROW]", row);

        if (!row) {
          alert("No invoice selected.");
          console.error("[Invoice Hub] No active invoice row found");
          return;
        }
        const clientEmail =
          row.client_email ||
          row.customer_email ||
          row.email ||
          row.customerEmail ||
          row["Client Email"] ||
          row.project?.clientEmail ||
          "";
        const publicUrl =
          row.public_invoice_url ||
          row.public_url ||
          (row.public_token
            ? `${location.origin}/invoice-public.html?token=${row.public_token}`
            : "") ||
          row["Public Invoice Url"] ||
          row.project?.invoice?.publicUrl ||
          (row.project?.invoice?.publicToken
            ? `${location.origin}/invoice-public.html?token=${row.project.invoice.publicToken}`
            : "") ||
          "";
        const businessName =
          row.business_name ||
          row.tenant_business_name ||
          row.project?.business_name ||
          "Three Colors Corp";
        if (!clientEmail || !publicUrl || !businessName) {
          console.error("Missing fields", { clientEmail, publicUrl, businessName, row });
          alert("Missing required invoice data. Check console.");
          return;
        }

        const originalText = btn.textContent;
        btn.textContent = "Sending...";
        btn.disabled = true;

        try {
          const invoice = getProjectInvoiceState(row.project);
          const body = {
            invoice_id: row.invoice_id || row.id || row.invoice_number || "",
            invoice_number: row.invoice_number || row.invoice_id || row.invoiceNo || "",
            tenant_id: row.tenant_id || row.project?.tenant_id || "",
            client_name: row.client_name || row.customer_name || row.customer || row.name || "",
            client_email: clientEmail,
            "Client Email": clientEmail,
            business_name: businessName,
            project_name: row.project_name || row.project?.projectName || row.project || "",
            public_invoice_url: publicUrl,
            "Public Invoice Url": publicUrl,
            contract_total: row.contract_total || row.project_contract_total || row.projectContractTotal || "",
            amount: row.contract_total || row.project_contract_total || row.projectContractTotal || row.invoice_amount || row.amount || row.base_amount || "",
            paid_to_date: row.paid_to_date || row.depositApplied || row.receivedApplied || "",
            balance_due: row.remaining_balance || row.balance_due || row.balance || "",
            remaining_balance: row.remaining_balance || row.balance_due || row.balance || ""
          };

          console.log("[Invoice Hub] Send Invoice payload", body);

          const res = await fetch("/.netlify/functions/send-invoice-zapier", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(body)
          });

          const text = await res.text();
          let data = {};
          try {
            data = JSON.parse(text);
          } catch (_err) {}

          if (!res.ok || data.ok === false) {
            throw new Error(data.error || data.message || text || "Send invoice failed");
          }

          btn.textContent = "Sent";
          alert("Invoice sent successfully.");
          console.log("[Invoice Hub] Invoice sent successfully", data);
          if (row?.projectId) {
            applyHubSendSuccessToLocalProject(row.projectId, data.invoice || null);
          }
          await refreshHubServerInvoicesCacheQuietly();
          refreshSelectedRow();
          setHubFeedback("Invoice sent successfully", "ok");
        } catch (err) {
          console.error("[Invoice Hub] Send Invoice failed", err);
          alert(err.message || "Could not send invoice.");
          setHubFeedback(String(err?.message || err || "Could not send invoice."), "err");
          btn.disabled = false;
          btn.textContent = originalText || "Send Invoice";
        }
      });
    }

    const runHubQuoteManualStep = async (action, okMessage) => {
      if (!selectedRow) return;
      const qid = String(selectedRow.hubQuoteId || "").trim();
      if (!qid) {
        setHubFeedback("Esta fila no tiene quote vinculado en el servidor.", "warn");
        return;
      }
      const { ok, data } = await postHubQuoteManualStep(qid, action);
      if (!ok) {
        setHubFeedback(data?.error || "No se pudo actualizar el quote.", "err");
        return;
      }
      if (typeof window.__mgHubRefetchServerInvoices === "function") {
        await window.__mgHubRefetchServerInvoices();
      }
      refreshSelectedRow();
      setHubFeedback(okMessage, "ok");
    };

    if ($("btnHubDrawerQuoteAccept")) {
      $("btnHubDrawerQuoteAccept").onclick = () => {
        void runHubQuoteManualStep("accept", "Quote marcado como aceptado; proyecto e invoice actualizados.");
      };
    }
    if ($("btnHubDrawerCheckPending")) {
      $("btnHubDrawerCheckPending").onclick = () => {
        void runHubQuoteManualStep("check_pending", "Deposito en cheque marcado como pendiente.");
      };
    }
    if ($("btnHubDrawerDepositReceived")) {
      $("btnHubDrawerDepositReceived").onclick = () => {
        void runHubQuoteManualStep("deposit_received", "Deposito registrado; proyecto listo en Supervisor.");
      };
    }

    window.__mgHubTableRefresh = refresh;
    window.__mgHubRefetchServerInvoices = async () => {
      const { invoices: raw } = await loadTenantInvoicesFromServer({ limit: 100 });
      hubServerNormalizedInvoicesCache = raw.map(normalizeServerInvoiceForHub);
      refresh();
    };
    refresh();

    if (!hubServerInvoicesFetchStarted) {
      hubServerInvoicesFetchStarted = true;
      void (async () => {
        const { invoices: raw } = await loadTenantInvoicesFromServer({ limit: 100 });
        const normalized = raw.map(normalizeServerInvoiceForHub);
        console.log("[HUB] normalized invoices:", normalized);
        hubServerNormalizedInvoicesCache = normalized;
        if ($("hubTableBody")) refresh();
      })();
    }
  }

  /*
   * STEP 4D — Approvals: server (get-sales-approvals) is the source of truth for Sales Admin.
   * localStorage (mg_approvals_v2) is a mirror/cache after successful server reads/updates, and
   * last-resort fallback when the server cannot be reached.
   *
   * Legacy rows: id is a non-UUID (e.g. Date.now() from older flows). They exist only in
   * localStorage and are shown only when GET get-sales-approvals fails — never merged onto a
   * successful server response (avoids stale duplicates over server rows).
   */
  const SALES_APPROVAL_UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function isServerBackedApprovalRow(row) {
    return row && SALES_APPROVAL_UUID_RE.test(String(row.id));
  }

  /** Map Supabase sales_approval rows to the shape renderSalesAdmin / activateApprovedProject expect. */
  function mapServerApprovalsToAdminRows(serverList) {
    const list = Array.isArray(serverList) ? serverList : [];
    return list.map((a) => {
      let workers = a.workers;
      if (typeof workers === "string") {
        try {
          workers = JSON.parse(workers);
        } catch (_err) {
          workers = [];
        }
      }
      if (!Array.isArray(workers)) workers = [];
      const projectName = String(a.project_name || "").trim() || "Project";
      return {
        id: a.id,
        projectName,
        projectId: projectName,
        clientName: String(a.client_name || "").trim(),
        customerEmail: String(a.client_email || "").trim(),
        sellerEmail: String(a.requested_by_email || "").trim(),
        location: "",
        offeredPrice: finiteNumber(a.offered_price, 0),
        recommended: finiteNumber(a.recommended_price, 0),
        minimum: finiteNumber(a.minimum_price, 0),
        workers,
        status: a.status || "requested",
        requestedAt: a.created_at || "",
        price: finiteNumber(a.offered_price, 0)
      };
    });
  }

  function syncApprovalsFromServerToLocal() {
    return fetch("/.netlify/functions/get-sales-approvals", { method: "GET", credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        if (data && data.ok === true && Array.isArray(data.approvals)) {
          const mapped = mapServerApprovalsToAdminRows(data.approvals);
          saveApprovals(mapped);
          return mapped;
        }
        return null;
      });
  }

  window.__mgSyncApprovalsFromServerToLocal = syncApprovalsFromServerToLocal;

  function filterSalesAdminYellowMarginQueue(list) {
    const s = loadSettings();
    const arr = Array.isArray(list) ? list : [];
    return arr.filter((row) => {
      if (String(row?.status || "").toLowerCase() !== "requested") return false;
      const base = calcSales({ workers: Array.isArray(row.workers) ? row.workers : [], price: "" }, s);
      const gate = computeSalesMarginDecisionFromEconomics(row.offeredPrice, base.beforeProfit, base.reserve, s);
      return gate.level === "yellow";
    });
  }

  function renderSalesAdmin() {
    if (!$("adminQueueBody")) return;
    const settings = loadSettings();
    let rows = [];

    const activateApprovedProject = (row) => {
      const project = {
        id: `PRJ-${Date.now()}`,
        status: "active",
        source: "sales-admin",
        signedAt: new Date().toISOString(),
        projectName: row.projectName || "Project",
        clientName: row.clientName || "",
        dueDate: normalizeDateInput(row.dueDate),
        estimatedDays: finiteNumber(row.estimatedDays, 0),
        laborBudget: finiteNumber(row.laborBudget, 0),
        salePrice: finiteNumber(row.offeredPrice, 0),
        recommendedPrice: finiteNumber(row.recommended, 0),
        minimumPrice: finiteNumber(row.minimum, 0),
        hoursPerDay: finiteNumber(row.hoursPerDay, DEFAULTS.hoursPerDay),
        workers: Array.isArray(row.workers) ? row.workers : [],
        notes: row.note || ""
      };

      upsertProject(project);
      saveSupervisorSelectedProjectId(project.id);
      saveSupervisorReport(project.id, buildDefaultSupervisorReport(project));
    };

    const refresh = () => {
      $("adminQueueBody").innerHTML = rows.map((row, index) => {
        const base = calcSales({ workers: Array.isArray(row.workers) ? row.workers : [], price: "" }, settings);
        const mg = computeSalesMarginDecisionFromEconomics(row.offeredPrice, base.beforeProfit, base.reserve, settings);
        const realPct = mg.realMarginPct != null && Number.isFinite(mg.realMarginPct) ? `${mg.realMarginPct.toFixed(1)}%` : "—";
        return `
          <tr>
            <td>${escapeHtml(String(row.id || "").slice(0, 8))}…</td>
            <td>${escapeHtml(row.projectName)}</td>
            <td>${escapeHtml(row.sellerEmail || "—")}</td>
            <td>${money(row.offeredPrice, settings.currency)}</td>
            <td>${escapeHtml(realPct)}</td>
            <td>${escapeHtml(String(mg.profitPct))}%</td>
            <td>${escapeHtml(String(mg.minimumMarginPct))}%</td>
            <td><span class="badge amber">review</span></td>
            <td><span class="badge ${row.status === "approved" ? "green" : (row.status === "rejected" ? "red" : "amber")}">${escapeHtml(row.status)}</span></td>
            <td>
              <div class="row-actions">
                <button class="btn primary" data-admin-approve="${index}">Approve</button>
                <button class="btn danger" data-admin-reject="${index}">Reject</button>
              </div>
            </td>
          </tr>
        `;
      }).join("");
      $("adminQueueBody").querySelectorAll("button[data-admin-approve]").forEach((button) => {
        button.onclick = () => {
          const index = Number(button.dataset.adminApprove || -1);
          if (index < 0 || !rows[index]) return;
          const row = rows[index];

          const applyLocalApprove = () => {
            rows[index].status = "approved";
            activateApprovedProject(rows[index]);
            saveApprovals(rows);
            refresh();
          };

          if (!isServerBackedApprovalRow(row)) {
            applyLocalApprove();
            return;
          }

          fetch("/.netlify/functions/update-sales-approval", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ approval_id: row.id, status: "approved" })
          })
            .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
            .then(({ ok, data }) => {
              if (ok && data && data.ok === true && data.approval) {
                rows[index] = mapServerApprovalsToAdminRows([data.approval])[0];
                activateApprovedProject(rows[index]);
                saveApprovals(rows);
                refresh();
                return;
              }
              applyLocalApprove();
            })
            .catch(() => {
              applyLocalApprove();
            });
        };
      });
      $("adminQueueBody").querySelectorAll("button[data-admin-reject]").forEach((button) => {
        button.onclick = () => {
          const index = Number(button.dataset.adminReject || -1);
          if (index < 0 || !rows[index]) return;
          const row = rows[index];

          const applyLocalReject = () => {
            rows[index].status = "rejected";
            saveApprovals(rows);
            refresh();
          };

          if (!isServerBackedApprovalRow(row)) {
            applyLocalReject();
            return;
          }

          fetch("/.netlify/functions/update-sales-approval", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ approval_id: row.id, status: "rejected" })
          })
            .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
            .then(({ ok, data }) => {
              if (ok && data && data.ok === true && data.approval) {
                rows[index] = mapServerApprovalsToAdminRows([data.approval])[0];
                saveApprovals(rows);
                refresh();
                return;
              }
              applyLocalReject();
            })
            .catch(() => {
              applyLocalReject();
            });
        };
      });
    };

    refresh();

    fetch("/.netlify/functions/get-sales-approvals", { method: "GET", credentials: "include" })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (ok && data && data.ok === true && Array.isArray(data.approvals)) {
          const mapped = mapServerApprovalsToAdminRows(data.approvals);
          saveApprovals(mapped);
          rows = filterSalesAdminYellowMarginQueue(mapped);
          refresh();
          return;
        }
        rows = filterSalesAdminYellowMarginQueue(loadApprovals());
        refresh();
      })
      .catch(() => {
        rows = filterSalesAdminYellowMarginQueue(loadApprovals());
        refresh();
      });
  }

  function render() {
    saveSettings(loadSettings());
    renderDashboard();
    renderEstimatesHub();
    renderBusinessSettings();
    renderOwner();
    renderSales();
    renderSupervisor();
    renderSalesAdmin();
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await waitForAuthReadyIfNeeded();
    void ensureTenant();
    await initTenantSnapshotBridge();
    await hydrateOwnerBrandingCacheFromServer();
    render();
    if ($("supervisorKpis")) {
      void refreshSupervisorProjectsFromApi();
    }
  });
})();

































