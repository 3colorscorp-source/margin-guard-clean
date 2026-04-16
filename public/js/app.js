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
    reservePct: 5,
    salesCommissionPct: 10,
    supervisorBonusPct: 1
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
    customerPhone: "",
    location: "",
    dueDate: "",
    offeredPrice: 0,
    messageToClient: "",
    notes: "",
    sentAt: "",
    workers: [
      { name: "Worker 1", type: "installer", days: 5, rate: "" }
    ]
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
      subject: "Invoice {{invoice_no}} - {{project}}",
      body:
`Hello {{customer}},

Your invoice is ready.

Project: {{project}}
Invoice No: {{invoice_no}}
Invoice Date: {{invoice_date}}
Due Date: {{due_date}}
Total: {{total}}
Balance Due: {{balance}}

Please reply if you need a copy or payment instructions.

Thank you.`
    },
    payment_request: {
      subject: "Payment Reminder - {{invoice_no}} - {{project}}",
      body:
`Hello {{customer}},

This is a friendly reminder for your open balance.

Project: {{project}}
Invoice No: {{invoice_no}}
Due Date: {{due_date}}
Balance Due: {{balance}}

Please let us know once payment has been sent.

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
  function loadDashboard() { return { ...DEFAULT_DASHBOARD, ...readStore(LS_DASHBOARD, {}) }; }
  function saveDashboard(state) { writeStore(LS_DASHBOARD, state); }
  function loadSales() {
    const saved = readStore(LS_SALES, {});
    const owner = loadOwner();
    const hasProjectName = Object.prototype.hasOwnProperty.call(saved, "projectName");
    const hasClientName = Object.prototype.hasOwnProperty.call(saved, "clientName");
    const hasLocation = Object.prototype.hasOwnProperty.call(saved, "location");
    const issueDate = normalizeDateInput(saved.issueDate) || todayInputValue();
    return {
      ...DEFAULT_SALES,
      ...saved,
      estimateNumber: nonEmptyString(saved.estimateNumber) || buildEstimateNumber(),
      estimateStatus: nonEmptyString(saved.estimateStatus) || "draft",
      issueDate,
      expirationDate: normalizeDateInput(saved.expirationDate) || addDaysToInputValue(issueDate, 7),
      projectName: hasProjectName ? String(saved.projectName ?? "") : (owner.projectName || ""),
      clientName: hasClientName ? String(saved.clientName ?? "") : (owner.clientName || ""),
      customerEmail: String(saved.customerEmail ?? ""),
      customerPhone: String(saved.customerPhone ?? ""),
      location: hasLocation ? String(saved.location ?? "") : (owner.location || ""),
      messageToClient: String(saved.messageToClient ?? ""),
      workers: Array.isArray(saved.workers) && saved.workers.length ? saved.workers : DEFAULT_SALES.workers.map((worker) => ({ ...worker })),
      offeredPrice: saved.offeredPrice ?? 0
    };
  }
  function saveSales(state) { writeStore(LS_SALES, state); }
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

  function loadSupervisorReport(project) {
    if (!project?.id) return buildDefaultSupervisorReport(null);
    const reports = loadSupervisorReports();
    const saved = reports[project.id];
    const base = buildDefaultSupervisorReport(project);
    if (!saved || typeof saved !== "object") return base;
    return {
      ...base,
      ...saved,
      projectId: project.id,
      projectName: project.projectName || base.projectName,
      estimatedDays: finiteNumber(saved.estimatedDays, base.estimatedDays),
      laborBudget: finiteNumber(saved.laborBudget, base.laborBudget),
      dueDate: normalizeDateInput(saved.dueDate || base.dueDate),
      entries: Array.isArray(saved.entries) ? saved.entries : [],
      extras: Array.isArray(saved.extras) ? saved.extras : [],
      changeOrders: Array.isArray(saved.changeOrders) ? saved.changeOrders : [],
      changeOrderDraft: {
        ...base.changeOrderDraft,
        ...(saved.changeOrderDraft && typeof saved.changeOrderDraft === "object" ? saved.changeOrderDraft : {}),
        workers: Array.isArray(saved.changeOrderDraft?.workers) && saved.changeOrderDraft.workers.length
          ? saved.changeOrderDraft.workers
          : base.changeOrderDraft.workers
      }
    };
  }

  function saveSupervisorReport(projectId, report) {
    if (!projectId) return;
    const reports = loadSupervisorReports();
    reports[projectId] = { ...report, projectId };
    saveSupervisorReports(reports);
  }

  function getProjectById(projectId) {
    return loadProjects().find((project) => project.id === projectId) || null;
  }

  function getSelectedProject() {
    const projects = loadProjects();
    const selectedId = loadSupervisorSelectedProjectId();
    return projects.find((project) => project.id === selectedId) || projects[0] || null;
  }

  function updateProjectById(projectId, updater) {
    const projects = loadProjects();
    const index = projects.findIndex((project) => project.id === projectId);
    if (index < 0) return null;
    const current = projects[index];
    const nextProject = typeof updater === "function"
      ? updater({ ...current })
      : { ...current, ...updater };
    projects[index] = nextProject;
    saveProjects(projects);
    if (loadSupervisorSelectedProjectId() === projectId) saveActiveProject(nextProject);
    return nextProject;
  }

  function normalizeCommercialStatus(value) {
    return ["draft", "sent", "approved", "signed"].includes(value) ? value : "draft";
  }

  function normalizeInvoiceStatus(value) {
    return ["draft", "sent", "partial", "paid"].includes(value) ? value : "draft";
  }

  function buildDefaultInvoiceState(project) {
    return {
      invoiceNo: "",
      invoiceDate: "",
      dueDate: normalizeDateInput(project?.dueDate),
      promisedDate: "",
      baseAmount: finiteNumber(project?.salePrice, 0),
      depositApplied: 0,
      receivedApplied: 0,
      status: "draft",
      collectionStage: "new",
      payments: [],
      activity: [],
      publicToken: "",
      publicUrl: "",
      paymentLink: ""
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
      promisedDate: normalizeDateInput(saved.promisedDate),
      depositApplied: finiteNumber(saved.depositApplied, 0),
      receivedApplied: finiteNumber(saved.receivedApplied, 0),
      status: normalizeInvoiceStatus(saved.status),
      collectionStage: ["new", "contacted", "promised", "escalated", "resolved"].includes(saved.collectionStage) ? saved.collectionStage : "new",
      payments: Array.isArray(saved.payments) ? saved.payments : [],
      activity: Array.isArray(saved.activity) ? saved.activity : [],
      publicToken: nonEmptyString(saved.publicToken),
      publicUrl: nonEmptyString(saved.publicUrl),
      paymentLink: nonEmptyString(saved.paymentLink)
    };
  }

  function saveProjectInvoiceState(projectId, invoice) {
    return updateProjectById(projectId, (project) => ({
      ...project,
      invoice: {
        ...buildDefaultInvoiceState(project),
        ...(invoice || {}),
        dueDate: normalizeDateInput(invoice?.dueDate || project?.dueDate),
        promisedDate: normalizeDateInput(invoice?.promisedDate),
        status: normalizeInvoiceStatus(invoice?.status),
        collectionStage: ["new", "contacted", "promised", "escalated", "resolved"].includes(invoice?.collectionStage) ? invoice.collectionStage : "new",
        payments: Array.isArray(invoice?.payments) ? invoice.payments : [],
        activity: Array.isArray(invoice?.activity) ? invoice.activity : [],
        publicToken: nonEmptyString(invoice?.publicToken),
        publicUrl: nonEmptyString(invoice?.publicUrl),
        paymentLink: nonEmptyString(invoice?.paymentLink)
      }
    }));
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

  function setHubFeedback(message, tone) {
    setNotice("hubFeedback", message, tone);
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
  }

  function openHubFormModal(config) {
    hubFormState = config;
    if ($("hubFormTitle")) $("hubFormTitle").textContent = config.title || "Actualizar";
    if ($("hubFormSubtitle")) $("hubFormSubtitle").textContent = config.subtitle || "Completa los datos para continuar.";
    if ($("hubFormSubmit")) $("hubFormSubmit").textContent = config.submitLabel || "Guardar";
    if ($("hubFormFields")) {
      $("hubFormFields").className = "hub-form-grid";
      $("hubFormFields").innerHTML = (Array.isArray(config.fields) ? config.fields : []).map((field) => {
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
        return `
          <div class="field">
            <label>${escapeHtml(field.label || "")}</label>
            <input id="${escapeHtml(field.id)}" type="${escapeHtml(field.type || "text")}" step="${field.step || ""}" placeholder="${escapeHtml(field.placeholder || "")}" value="${escapeHtml(field.value ?? "")}" />
            ${field.hint ? `<div class="hint" style="justify-content:flex-start;">${escapeHtml(field.hint)}</div>` : ""}
          </div>
        `;
      }).join("");
    }
    setNotice("hubFormFeedback", "", "");
    if ($("hubFormModal")) $("hubFormModal").setAttribute("aria-hidden", "false");
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
      canExportPdf: hasInvoice && hasAmount
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
      `Balance due: ${money(metrics.balance, settings.currency)}`
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
          <div class="strip-card">
            <div class="title">${escapeHtml(title)}</div>
            <div class="big">${escapeHtml(big)}</div>
            <div class="small">${escapeHtml(small)}</div>
          </div>
        `).join("");
      }

      const cards = [
        ["Operating / Expenses", money(state.expensesBalance, settings.currency), "Immediate working capital", healthClass(state.expensesBalance, state.operatingMonthly * 0.5, state.operatingMonthly)],
        ["Profit", money(state.profitBalance, settings.currency), "Protected owner profit", healthClass(state.profitBalance, state.operatingMonthly * 0.1, state.operatingMonthly * 0.35)],
        ["Savings", money(state.savingsBalance, settings.currency), `12-month target: ${money(savingsTarget, settings.currency)}`, healthClass(state.savingsBalance, state.operatingMonthly * 6, savingsTarget)],
        ["Tax Reserve", money(state.taxBalance, settings.currency), "Reserved tax liability", healthClass(state.taxBalance, state.operatingMonthly * 0.5, state.operatingMonthly)],
        ["Total Cash", money(totalCash, settings.currency), "Real bank cash, not paper profit", healthClass(totalCash, state.operatingMonthly * 3, state.operatingMonthly * 12)],
        ["Savings Progress", `${savingsPct.toFixed(1)}%`, "Progress to 12-month safety target", healthClass(savingsPct, 50, 100)]
      ];

      $("dashKpis").innerHTML = cards.map(([label, value, meta, tone]) => `
        <div class="kpi-box finance-box">
          <div class="label">${escapeHtml(label)} <span class="badge ${tone}">${tone === "green" ? "Healthy" : (tone === "amber" ? "Watch" : "Risk")}</span></div>
          <div class="value">${escapeHtml(value)}</div>
          <div class="meta">${escapeHtml(meta)}</div>
        </div>
      `).join("");

      if ($("dashboardRevenueStrip") || $("dashboardRevenueNote") || $("dashboardCommandStrip") || $("dashboardCommandQueue") || $("dashboardOwnerTasks") || $("dashboardClientScorecard") || $("dashboardDailyDigest") || $("dashboardProfitabilityRanking") || $("dashboardCashForecast") || $("dashboardWeeklyReview") || $("dashboardRiskSegments")) {
        const hubRows = buildPortfolioRows(settings);
        const openBalance = hubRows.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
        const collectionsCount = hubRows.filter((row) => ["sent", "partial", "overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0).length;
        const paidTotal = hubRows.filter((row) => row.status === "paid").reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
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
            <div class="strip-card">
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
            <div class="strip-card">
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
                    <span class="hub-inline-meta">${escapeHtml(row.customer)} Â· ${escapeHtml(row.nextAction)} Â· Score ${escapeHtml(String(row.priorityScore))}</span>
                    <span class="hub-inline-meta">Balance ${escapeHtml(money(row.balance, settings.currency))} Â· Due ${escapeHtml(row.dueDate || "No due date")} Â· Stage ${escapeHtml(row.collectionStage || "new")}</span>
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
                    <span class="hub-inline-meta">Score ${escapeHtml(String(item.score))} Â· Open ${escapeHtml(item.openBalanceLabel)} Â· Overdue ${escapeHtml(item.overdueBalanceLabel)}</span>
                    <span class="hub-inline-meta">${escapeHtml(String(item.projectCount))} projects Â· ${escapeHtml(String(item.brokenPromises))} broken promises Â· Paid ${escapeHtml(item.paidTotalLabel)}</span>
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
                    <span class="hub-inline-meta">${escapeHtml(item.customer)} Â· Margin ${escapeHtml(item.marginLabel)} Â· Sold ${escapeHtml(item.soldLabel)}</span>
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
              body: `${row.customer} rompio promesa de pago del ${row.promisedDate}. Saldo abierto ${money(row.balance, settings.currency)}.`
            });
          });
          const overdueRows = hubRows.filter((row) => ["overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0)
            .sort((left, right) => right.balance - left.balance)
            .slice(0, 2);
          overdueRows.forEach((row) => {
            alerts.push({
              tone: "red",
              title: row.title,
              body: `${row.customer} tiene ${money(row.balance, settings.currency)} vencidos. Accion sugerida: ${row.nextAction}.`
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
              body: `${row.customer} va parcial. Quedan ${money(row.balance, settings.currency)} por cobrar.`
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
        <td><input data-key="hours" type="number" step="0.25" value="${settings.pricingMode === "day" ? ((Number(worker.hours || 0) / hoursPerDay) || 0) : (worker.hours ?? 0)}" /></td>
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
        const tr = el.closest("tr");
        const index = Number(tr?.dataset.index ?? -1);
        const key = el.dataset.key;
        if (index < 0 || !key) return;
        if (key === "hours") {
          const rawUnits = Number(el.value || 0);
          state.workers[index][key] = settings.pricingMode === "day" ? rawUnits * hoursPerDay : rawUnits;
        } else {
          state.workers[index][key] = el.value;
        }
        if (key === "type") state.workers[index].rate = "";
        saveOwner(state, calcOwner(state, settings));
        renderOwner();
      };
      if (el.dataset.key === "name" || el.dataset.key === "hours") {
        el.addEventListener("change", commit);
        el.addEventListener("blur", commit);
      } else if (el.tagName === "SELECT") {
        el.addEventListener("change", commit);
      }
    });

    body.querySelectorAll("button[data-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const tr = button.closest("tr");
        const index = Number(tr?.dataset.index ?? -1);
        if (index < 0) return;
        if (button.dataset.action === "delete") state.workers.splice(index, 1);
        if (button.dataset.action === "copy") state.workers.splice(index + 1, 0, { ...state.workers[index] });
        saveOwner(state, calcOwner(state, settings));
        renderOwner();
      });
    });
  }

  function renderOwner() {
    if (!$("ownerKpis")) return;

    const settings = loadSettings();
    const state = loadOwner();
    state.reservePct = DEFAULTS.reservePct;
    const metrics = calcOwner(state, settings);

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

    renderWorkers(state, settings, metrics);

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
    if ($("btnClear")) $("btnClear").onclick = () => { if (!confirm("Clear this quote?")) return; writeStore(LS_OWNER, DEFAULT_OWNER); renderOwner(); };
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
  const estimateNumber = nonEmptyString(state.estimateNumber, buildEstimateNumber());
  const issueDate = normalizeDateInput(nonEmptyString(state.issueDate) || todayInputValue());
  const expirationDate = normalizeDateInput(nonEmptyString(state.expirationDate) || addDaysToInputValue(issueDate, 7));
  state.estimateNumber = estimateNumber;
  state.issueDate = issueDate;
  state.expirationDate = expirationDate;
  const subject = `Estimate ${estimateNumber} - ${nonEmptyString(state.projectName, "Project")}`;
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
  if (sendStatus) { sendStatus.style.display = "none"; sendStatus.textContent = ""; }
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
    if ($("sendStatus")) { $("sendStatus").style.display = "none"; $("sendStatus").className = "notice"; $("sendStatus").textContent = ""; }
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

  function persistOwnerAfterPublicSend(settings) {
    if (!$("ownerKpis")) return;
    const sales = loadSales();
    const toEmail = nonEmptyString(document.getElementById("toEmail")?.value);
    const toName = nonEmptyString(document.getElementById("toName")?.value);
    const ownerState = loadOwner();
    if (toEmail) ownerState.clientEmail = toEmail;
    if (toName) ownerState.clientName = toName;
    if (nonEmptyString(sales.estimateNumber)) ownerState.estimateNumber = sales.estimateNumber;
    ownerState.issueDate = normalizeDateInput(nonEmptyString(sales.issueDate) || ownerState.issueDate);
    ownerState.expirationDate = normalizeDateInput(nonEmptyString(sales.expirationDate) || ownerState.expirationDate);
    ownerState.messageToClient = nonEmptyString(sales.messageToClient, ownerState.messageToClient);
    if (sales.publicQuoteUrl) ownerState.publicQuoteUrl = sales.publicQuoteUrl;
    if (sales.quoteId) ownerState.quoteId = sales.quoteId;
    if (sales.publicToken) ownerState.publicToken = sales.publicToken;
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
    const estimateNumber = nonEmptyString(state.estimateNumber, buildEstimateNumber());
    const issueDate = normalizeDateInput(nonEmptyString(state.issueDate) || todayInputValue());
    const expirationDate = normalizeDateInput(nonEmptyString(state.expirationDate) || addDaysToInputValue(issueDate, 7));
    const savedRow = publishData.row && typeof publishData.row === "object" ? publishData.row : null;
    const savedName = savedRow ? String(savedRow.business_name || savedRow.company_name || "").trim() : "";
    const savedEmail = savedRow ? String(savedRow.business_email || "").trim() : "";
    const savedPhone = savedRow ? String(savedRow.business_phone || "").trim() : "";
    const savedAddr = savedRow ? String(savedRow.business_address || "").trim() : "";
    const rowTotal = Number(savedRow?.total ?? sm.offered ?? sm.recommended ?? estimateTotal) || 0;
    const rowDeposit = Number(savedRow?.deposit_required ?? depositRequired) || 0;

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
    const sm = calculateSalesMetrics(state, freshSettings);

    const toEmail = nonEmptyString(document.getElementById("toEmail")?.value);
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

    if (!toEmail || !salesRepInitials) {
      if (sendStatus) {
        sendStatus.style.display = "block";
        sendStatus.className = "notice error";
        sendStatus.textContent = "Agrega email del cliente e iniciales del vendedor antes de enviar.";
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

    try {
      if (sendButton) {
        sendButton.disabled = true;
        sendButton.textContent = "Enviando...";
      }
      if (sendStatus) {
        sendStatus.style.display = "block";
        sendStatus.className = "notice";
        sendStatus.textContent = "Creando enlace público...";
      }

      const branding = await resolveOwnerPublishBranding(freshSettings);
      const bn = ownerResolvePublishBusinessName(branding, freshSettings);
      const estimateTotal = Number(sm.offered || sm.recommended || 0);
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

      const publicQuoteUrl = publishData.public_url;
      const messageWithLink = (message || "").replace(/\[PUBLIC_QUOTE_URL\]/g, publicQuoteUrl);

      if (sendStatus) {
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

      const pdfFileNameFinal = nonEmptyString(
        rebuiltPdf?.fileName,
        `Estimate-${nonEmptyString(state.estimateNumber, "Quote")}.pdf`
      );

      const clientName = toName || state.clientName || "";
      const zapierPayload = {
        toName: clientName,
        toEmail,
        projectName: state.projectName || "",
        subject: subject || `Estimate ${state.estimateNumber || ""}`,
        publicToken: publishData.public_token,
        publicQuoteUrl,
        public_quote_url: publicQuoteUrl,
        salesRepInitials,
        messageLanguage: "bilingual",
        messageText: messageWithLink,
        scopeOfWork: scope,
        depositRequired: round2(depositRequired),
        clientName,
        location: projectAddress,
        businessName: bn,
        businessPhone: branding.businessPhone || freshSettings.phone || "",
        businessEmail: branding.businessEmail || freshSettings.email || "",
        businessAddress: branding.businessAddress || freshSettings.address || freshSettings.companyAddress || "",
        quoteId: publishData.quote_id,
        estimateNumber: state.estimateNumber || "",
        issueDate: state.issueDate || "",
        expirationDate: state.expirationDate || "",
        customerPhone,
        recommendedTotal: round2(estimateTotal),
        currency: "USD",
        pdfBase64: pdfB64,
        pdfFileName: pdfFileNameFinal,
        pdfMimeType: rebuiltPdf?.mimeType || "application/pdf"
      };

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
        throw new Error(zapData.error || zapRaw || "Unable to send estimate.");
      }
      if (zapData.pdfUploadError) {
        throw new Error(`PDF: la subida en send-quote-zapier falló (${zapData.pdfUploadError}).`);
      }
      if (!zapData.pdfUrl) {
        throw new Error("PDF: send-quote-zapier no devolvió pdfUrl; Zapier solo recibe pdf_url. Sin URL no hay adjunto.");
      }

      state = loadSales();
      state.publicQuoteUrl = publicQuoteUrl;
      state.quoteId = publishData.quote_id;
      state.publicToken = publishData.public_token;
      saveSales(state);

      if (sendStatus) {
        sendStatus.style.display = "block";
        sendStatus.className = "notice";
        sendStatus.textContent = "Cotización enviada correctamente.";
      }

      persistOwnerAfterPublicSend(freshSettings);
      renderOwner();
      try {
        renderSales();
      } catch (_e) {}
      setTimeout(closeSendModal, 500);
    } catch (err) {
      if (sendStatus) {
        sendStatus.style.display = "block";
        sendStatus.className = "notice error";
        sendStatus.textContent = err?.message || String(err);
      }
    } finally {
      if (sendButton) {
        sendButton.disabled = false;
        sendButton.textContent = "Enviar";
      }
    }
  }

  async function sendQuote(state, settings, metrics, options = {}) {
  if ($("ownerKpis")) {
    await runOwnerSellerPublicSend();
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
  const toEmail = nonEmptyString(document.getElementById("toEmail")?.value);
  const toName = nonEmptyString(document.getElementById("toName")?.value, state.clientName);
  const subject = nonEmptyString(document.getElementById("subject")?.value);
  const scopeOfWork = nonEmptyString(document.getElementById("scope")?.value, state.messageToClient, state.notes);
  const messageText = nonEmptyString(document.getElementById("message")?.value);
  const depositRequired = parseNumber(document.getElementById("deposit")?.value);
  const salesRepInitials = nonEmptyString(document.getElementById("salesInitials")?.value).toUpperCase();
  if (!toEmail || !salesRepInitials) {
    if (sendStatus) { sendStatus.style.display = "block"; sendStatus.textContent = "Add customer email and sales rep initials before sending the estimate."; }
    return;
  }
  const estimateNumber = nonEmptyString(state.estimateNumber, buildEstimateNumber());
  const issueDate = normalizeDateInput(nonEmptyString(state.issueDate) || todayInputValue());
  const expirationDate = normalizeDateInput(nonEmptyString(state.expirationDate) || addDaysToInputValue(issueDate, 7));
  try {
    if (sendStatus) { sendStatus.style.display = "block"; sendStatus.textContent = "Sending estimate..."; }
    const response = await fetch("/.netlify/functions/send-quote-zapier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        salesRepInitials,
        messageLanguage: "bilingual",
        toEmail,
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
        expirationDate
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Unable to send estimate.");
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
    if (sendStatus) { sendStatus.style.display = "block"; sendStatus.textContent = "Estimate sent successfully."; }
    setTimeout(closeSendModal, 500);
    renderSales();
  } catch (error) {
    if (sendStatus) { sendStatus.style.display = "block"; sendStatus.textContent = error.message || "Unable to send estimate."; }
  }
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
      const baseRate = worker.type === "helper"
        ? Number(settings.baseHelper || 0)
        : Number(settings.baseInstaller || 0);
      const rate = worker.rate === "" || worker.rate == null ? baseRate : Number(worker.rate || 0);
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
    const rawOffered = nonEmptyString(state?.price, state?.offeredPrice);
    const manualOfferedActive = Boolean(state?._manualPriceTouched) && rawOffered !== "";
    const offered = manualOfferedActive ? finiteNumber(rawOffered, recommended) : recommended;
    const commissionRate = finiteNumber(settings?.salesCommissionPct, DEFAULTS.salesCommissionPct);
    const commissionDisplay = round2(Math.max(offered, 0) * (commissionRate / 100));
    const stage = offered >= recommended ? 2 : offered >= negotiation ? 1 : 0;
    const needsApproval = offered < negotiation;
    const approved = !needsApproval || state?.estimateStatus === "signed" || state?.estimateStatus === "approved";

    return {
      ...base,
      workersCount,
      workerDays,
      workerHours,
      offered,
      stage,
      needsApproval,
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
        <td><input data-key="rate" type="number" min="0" step="0.01" value="${worker.rate === "" || worker.rate == null ? (worker.type === "helper" ? Number(settings.baseHelper || 0) : Number(settings.baseInstaller || 0)) : Number(worker.rate || 0)}" /></td>
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

        if (key === "days" || key === "rate") {
          state.workers[index][key] = el.value === "" ? "" : Number(el.value || 0);
        } else {
          state.workers[index][key] = el.value;
        }

        if (key === "type" && (state.workers[index].rate === "" || state.workers[index].rate == null)) {
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
  const approvals = loadApprovals();
  const approvedItems = approvals.filter((item) => item.status === "approved");
  const currentApproval = approvedItems[approvedItems.length - 1];
  const signedProjects = loadSignedProjects();
  const projectIndex = new Map(signedProjects.map((project) => [project.projectId, project]));

  if (!state.estimateNumber) state.estimateNumber = buildEstimateNumber();
  if (!state.issueDate) state.issueDate = todayInputValue();
  if (!state.expirationDate) state.expirationDate = addDaysToInputValue(state.issueDate, 7);
  if (!state.estimateStatus) state.estimateStatus = "draft";

  const estimateStatusMap = {
    draft: "Draft",
    pricing_ready: "Pricing Ready",
    approval_requested: "Approval Requested",
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
  const customerPhoneInput = document.getElementById("salesCustomerPhone");
  const locationInput = document.getElementById("salesLocation");
  const issueDateInput = document.getElementById("salesIssueDate");
  const expirationDateInput = document.getElementById("salesExpirationDate");
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

  bindNativeDatePicker(issueDateInput);
  bindNativeDatePicker(expirationDateInput);
  bindNativeDatePicker(dueDateInput);

  if (estimateNumberInput) estimateNumberInput.value = state.estimateNumber;
  if (issueDateInput) issueDateInput.value = state.issueDate;
  if (expirationDateInput) expirationDateInput.value = state.expirationDate;
  if (projectNameInput) projectNameInput.value = state.projectName || "";
  if (clientNameInput) clientNameInput.value = state.clientName || "";
  if (customerEmailInput) customerEmailInput.value = state.customerEmail || "";
  if (customerPhoneInput) customerPhoneInput.value = state.customerPhone || "";
  if (locationInput) locationInput.value = state.location || "";
  if (dueDateInput) dueDateInput.value = state.dueDate || "";
  if (priceInput) priceInput.value = state.price || "";
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
  setText("salesApprovalAction", currentApproval ? "Pending Approval" : metrics.needsApproval ? "Request Approval" : "Ready to Send");
  setText("salesApprovalActionMeta", metrics.needsApproval ? "Pricing is below recommendation or approval is required." : "Estimate can move forward without extra approval.");
  setText("salesStageMin", formatMoney(metrics.minimum));
  setText("salesStageNegotiation", formatMoney(metrics.negotiation));
  setText("salesStageRecommended", formatMoney(metrics.recommended));
  setText("salesCrewHint", `${metrics.workersCount} workers configured for ${metrics.workerHours.toFixed(2)} labor hours.`);
  setText("approvalHint", currentApproval ? `Latest approval for ${currentApproval.projectId} | ${formatMoney(currentApproval.price)}` : "No active approval request.");
  setText("salesRule", metrics.needsApproval ? "Estimate requires approval before signing below recommendation." : "Estimate is inside a healthy selling range.");

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
      metrics.needsApproval ? "Approval is recommended before signing this estimate." : "Estimate can be sent directly to the customer."
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
    state.estimateNumber = nonEmptyString(estimateNumberInput?.value, buildEstimateNumber());
    state.issueDate = normalizeDateInput(issueDateInput?.value || todayInputValue());
    state.expirationDate = normalizeDateInput(expirationDateInput?.value || addDaysToInputValue(state.issueDate, 7));
    state.projectName = nonEmptyString(projectNameInput?.value);
    state.clientName = nonEmptyString(clientNameInput?.value);
    state.customerEmail = nonEmptyString(customerEmailInput?.value);
    state.customerPhone = nonEmptyString(customerPhoneInput?.value);
    state.location = nonEmptyString(locationInput?.value);
    state.dueDate = normalizeDateInput(dueDateInput?.value || state.expirationDate);
    state.price = priceInput?.value || "";
    state.messageToClient = nonEmptyString(messageToClientInput?.value);
    state.notes = nonEmptyString(notesInput?.value);
    if (nextStatus) state.estimateStatus = nextStatus;
    saveSales(state);
  }

  [projectNameInput, clientNameInput, customerEmailInput, customerPhoneInput, locationInput, issueDateInput, expirationDateInput, dueDateInput, estimateNumberInput, messageToClientInput, notesInput].forEach((input) => {
    if (!input) return;
    input.oninput = () => persistSalesDraft();
    input.onchange = () => persistSalesDraft();
  });

  if (priceInput) {
    priceInput.oninput = () => {
      state.price = priceInput.value;
      state._manualPriceTouched = true;
      state.estimateStatus = metrics.recommended > 0 ? "pricing_ready" : state.estimateStatus;
      saveSales(state);
      renderSales();
    };
  }

  if (stageRange) {
    stageRange.oninput = () => {
      const stage = Number(stageRange.value || 2);
      const nextPrice = stage <= 0 ? metrics.minimum : stage === 1 ? metrics.negotiation : metrics.recommended;
      state.price = nextPrice ? String(round2(nextPrice)) : "";
      state._manualPriceTouched = true;
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
      btnNew.onclick = () => {
        if (!window.confirm("Start a new estimate draft? Current sales values will reset.")) return;
        const fresh = structuredClone(DEFAULT_SALES);
        fresh.estimateNumber = buildEstimateNumber();
        fresh.issueDate = todayInputValue();
        fresh.expirationDate = addDaysToInputValue(fresh.issueDate, 7);
        fresh.estimateStatus = "draft";
        fresh.price = "";
        fresh.notes = "";
        fresh.messageToClient = "";
        fresh.customerEmail = "";
        fresh.customerPhone = "";
        fresh.location = "";
        fresh.projectName = "";
        fresh.clientName = "";
        saveSales(fresh);
        renderSales();
      };
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

    const btnSubmit = document.getElementById("btnSubmitApproval");
    if (btnSubmit) {
      btnSubmit.onclick = () => {
        persistSalesDraft("approval_requested");
        const currentMetrics = calculateSalesMetrics(state, settings);
        const payload = {
          id: Date.now(),
          status: "requested",
          requestedAt: new Date().toISOString(),
          projectId: nonEmptyString(state.projectName, "Estimate"),
          clientName: nonEmptyString(state.clientName),
          customerEmail: nonEmptyString(state.customerEmail),
          location: nonEmptyString(state.location),
          price: round2(currentMetrics.offered),
          recommended: round2(currentMetrics.recommended),
          minimum: round2(currentMetrics.minimum),
          estimateNumber: state.estimateNumber,
          expirationDate: state.expirationDate
        };
        const queue = loadApprovals();
        queue.push(payload);
        saveApprovals(queue);
        renderSales();
      };
    }

    const btnMarkSold = document.getElementById("btnMarkSold");
    if (btnMarkSold) {
      btnMarkSold.onclick = () => {
        persistSalesDraft("signed");
        const currentMetrics = calculateSalesMetrics(state, settings);
        if (!state.projectName || !state.clientName || !state.dueDate || currentMetrics.workerDays <= 0) {
          window.alert("Complete project, customer, due date, and labor details before signing the estimate.");
          return;
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
    if (!$("supervisorKpis")) return;

    const settings = loadSettings();
    const picker = $("supProjectPicker");
    const projects = loadProjects();
    const selectedProjectId = loadSupervisorSelectedProjectId();
    const selectedProject = projects.find((project) => project.id === selectedProjectId) || projects[0] || null;
    const changeRange = $("coStageRange");

    if (picker) {
      picker.innerHTML = projects.length
        ? projects.map((project) => `
            <option value="${escapeHtml(project.id)}">${escapeHtml(project.projectName || "Project")} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${escapeHtml(project.clientName || "Sin cliente")}</option>
          `).join("")
        : `<option value="">Sin proyectos firmados</option>`;
      picker.value = selectedProject?.id || "";
      picker.onchange = () => {
        saveSupervisorSelectedProjectId(picker.value);
        renderSupervisor();
      };
    }

    if (selectedProject) saveSupervisorSelectedProjectId(selectedProject.id);

    const renderChangeOrderWorkers = (currentProject, state, metrics) => {
      const body = $("coWorkersBody");
      if (!body) return;
      const draft = state.changeOrderDraft;
      body.innerHTML = draft.workers.map((worker, index) => `
        <tr data-index="${index}">
          <td><input data-key="name" maxlength="40" value="${escapeHtml(worker.name || "")}" /></td>
          <td>
            <select data-key="type">
              <option value="installer" ${worker.type === "installer" ? "selected" : ""}>Pro</option>
              <option value="helper" ${worker.type === "helper" ? "selected" : ""}>Assistant</option>
            </select>
          </td>
          <td><input data-key="days" type="number" min="0" step="0.25" value="${Number(worker.days || 0)}" /></td>
          <td><input data-key="rate" type="number" min="0" step="0.01" value="${worker.rate === "" || worker.rate == null ? (worker.type === "helper" ? Number(settings.baseHelper || 0) : Number(settings.baseInstaller || 0)) : Number(worker.rate || 0)}" /></td>
          <td>${money(metrics.laborByWorker[index]?.cost || 0, settings.currency)}</td>
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
          if (key === "days" || key === "rate") {
            state.changeOrderDraft.workers[index][key] = el.value === "" ? "" : Number(el.value || 0);
          } else {
            state.changeOrderDraft.workers[index][key] = el.value;
          }
          if (key === "type" && (state.changeOrderDraft.workers[index].rate === "" || state.changeOrderDraft.workers[index].rate == null)) {
            state.changeOrderDraft.workers[index].rate = "";
          }
          saveSupervisorReport(currentProject.id, state);
          renderSupervisor();
        };
        el.addEventListener("change", commit);
        if (el.tagName === "INPUT") el.addEventListener("blur", commit);
      });

      body.querySelectorAll("button[data-action]").forEach((button) => {
        button.addEventListener("click", () => {
          const tr = button.closest("tr");
          const index = Number(tr?.dataset.index ?? -1);
          if (index < 0) return;
          if (button.dataset.action === "delete") state.changeOrderDraft.workers.splice(index, 1);
          if (button.dataset.action === "copy") state.changeOrderDraft.workers.splice(index + 1, 0, { ...state.changeOrderDraft.workers[index] });
          if (!state.changeOrderDraft.workers.length) {
            state.changeOrderDraft.workers = buildDefaultChangeOrderWorkers(currentProject);
          }
          saveSupervisorReport(currentProject.id, state);
          renderSupervisor();
        });
      });
    };

    const paintChangeOrderEmpty = () => {
      if ($("coTraffic")) {
        $("coTraffic").className = "badge amber";
        $("coTraffic").textContent = "Sin proyecto";
      }
      if ($("coRule")) $("coRule").textContent = "Selecciona o firma un proyecto para cotizar change orders.";
      if ($("coPrimaryPrice")) $("coPrimaryPrice").textContent = money(0, settings.currency);
      if ($("coPrimaryMeta")) $("coPrimaryMeta").textContent = "Sin proyecto activo para cotizar extras.";
      if ($("coSuggestedDays")) $("coSuggestedDays").textContent = "0.00 dias";
      if ($("coSuggestedDaysMeta")) $("coSuggestedDaysMeta").textContent = "Dias adicionales del trabajo extra";
      if ($("coSuggestedPrice")) $("coSuggestedPrice").textContent = money(0, settings.currency);
      if ($("coSuggestedPriceMeta")) $("coSuggestedPriceMeta").textContent = "Precio propuesto al cliente";
      if ($("coStageMin")) $("coStageMin").textContent = `Minimo ${money(0, settings.currency)}`;
      if ($("coStageNegotiation")) $("coStageNegotiation").textContent = `Negociacion ${money(0, settings.currency)}`;
      if ($("coStageRecommended")) $("coStageRecommended").textContent = `Recomendado ${money(0, settings.currency)}`;
      if ($("coListBody")) $("coListBody").innerHTML = "";
      if ($("coWorkersBody")) $("coWorkersBody").innerHTML = "";
    };

    const refresh = () => {
      const currentProject = (loadProjects().find((project) => project.id === loadSupervisorSelectedProjectId())) || selectedProject;

      if (!currentProject) {
        if ($("supStatus")) {
          $("supStatus").className = "badge amber";
          $("supStatus").textContent = "Sin proyectos";
        }
        if ($("supHeroState")) $("supHeroState").textContent = "Base";
        if ($("supHeroMeta")) $("supHeroMeta").textContent = "No hay proyectos firmados. Firma uno desde Vendedor o apruebalo en Sales Admin.";
        if ($("supProjectLabel")) $("supProjectLabel").textContent = "Sin proyecto";
        if ($("supDueDateLabel")) $("supDueDateLabel").textContent = "Sin fecha";
        if ($("supEstimatedDaysLabel")) $("supEstimatedDaysLabel").textContent = "0.00";
        if ($("supLaborBudgetLabel")) $("supLaborBudgetLabel").textContent = money(0, settings.currency);
        if ($("supExecutiveNote")) $("supExecutiveNote").textContent = "Todavia no hay proyectos firmados para este supervisor.";
        if ($("supPrimaryBalance")) $("supPrimaryBalance").textContent = money(0, settings.currency);
        if ($("supPrimaryMeta")) $("supPrimaryMeta").textContent = "Esperando proyecto firmado";
        if ($("supPrimaryDays")) $("supPrimaryDays").textContent = "0.00";
        if ($("supPrimaryDaysMeta")) $("supPrimaryDaysMeta").textContent = "Sin meta activa";
        if ($("supPrimaryExtras")) $("supPrimaryExtras").textContent = money(0, settings.currency);
        if ($("supPrimaryExtrasMeta")) $("supPrimaryExtrasMeta").textContent = "Sin proyecto activo";
        if ($("supPortfolioCount")) $("supPortfolioCount").textContent = "0";
        $("supervisorKpis").innerHTML = [
          ["Proyectos firmados", "0", "Firma o aprueba proyectos para empezar a reportar"],
          ["Dias estimados", "0.00", "Esperando proyecto firmado"],
          ["Presupuesto labor", money(0, settings.currency), "Sin presupuesto asignado"],
          ["Fecha comprometida", "Sin fecha", "La fecha entra desde el proyecto firmado"]
        ].map(([label, value, meta]) => `
          <div class="kpi-box">
            <div class="label">${escapeHtml(label)}</div>
            <div class="value">${escapeHtml(value)}</div>
            <div class="meta">${escapeHtml(meta)}</div>
          </div>
        `).join("");
        if ($("supEntriesBody")) $("supEntriesBody").innerHTML = "";
        if ($("supExtrasBody")) $("supExtrasBody").innerHTML = "";
        setVal("supProjectedDate", "");
        paintChangeOrderEmpty();
        return;
      }

      const state = loadSupervisorReport(currentProject);
      state.projectId = currentProject.id;
      state.projectName = currentProject.projectName || state.projectName;
      state.estimatedDays = finiteNumber(currentProject.estimatedDays, state.estimatedDays);
      state.laborBudget = finiteNumber(currentProject.laborBudget, state.laborBudget);
      state.dueDate = normalizeDateInput(currentProject.dueDate || state.dueDate);
      state.projectedEndDate = normalizeDateInput(val("supProjectedDate") || state.projectedEndDate);
      state.changeOrders = Array.isArray(state.changeOrders) ? state.changeOrders : [];
      state.changeOrderDraft = {
        ...buildDefaultChangeOrderDraft(currentProject),
        ...(state.changeOrderDraft && typeof state.changeOrderDraft === "object" ? state.changeOrderDraft : {}),
        workers: Array.isArray(state.changeOrderDraft?.workers) && state.changeOrderDraft.workers.length
          ? state.changeOrderDraft.workers
          : buildDefaultChangeOrderWorkers(currentProject)
      };
      saveSupervisorReport(currentProject.id, state);
      setVal("supProjectedDate", state.projectedEndDate);

      const reportedHours = state.entries.reduce((sum, row) => sum + Number(row.hours || 0), 0);
      const reportedDays = state.entries.reduce((sum, row) => sum + Number(row.days || 0), 0);
      const extraSpent = state.extras.reduce((sum, row) => sum + Number(row.amount || 0), 0);
      const owner = loadOwner();
      const ownerHours = Number(owner.metrics?.totalHours || 0);
      const blendedRate = ownerHours > 0
        ? Number(owner.metrics?.labor || 0) / ownerHours
        : Number(settings.baseInstaller || 0);
      const laborSpent = reportedHours * blendedRate;
      const totalSpent = laborSpent + extraSpent;
      const laborRemaining = Number(state.laborBudget || 0) - totalSpent;
      const daysRemaining = Number(state.estimatedDays || 0) - reportedDays;

      let dayDelta = 0;
      if (state.dueDate && state.projectedEndDate) {
        const due = new Date(state.dueDate).getTime();
        const projected = new Date(state.projectedEndDate).getTime();
        dayDelta = Math.round((projected - due) / (1000 * 60 * 60 * 24));
      }

      let tone = "green";
      let stateLabel = "Verde";
      let stateMeta = "Vas bien. El proyecto sigue dentro del ritmo esperado.";

      if (daysRemaining <= 1 || laborRemaining <= Number(state.laborBudget || 0) * 0.2 || dayDelta > 0 || extraSpent > Number(state.laborBudget || 0) * 0.05) {
        tone = "amber";
        stateLabel = "Amarillo";
        stateMeta = "Necesitas atencion. Conviene apurarte o cuidar el presupuesto.";
      }

      if (daysRemaining < 0 || laborRemaining < 0 || dayDelta > 2) {
        tone = "red";
        stateLabel = "Rojo";
        stateMeta = "Necesitas apurarte. El proyecto ya se esta saliendo del plan.";
      }

      if ($("supStatus")) {
        $("supStatus").className = `badge ${tone}`;
        $("supStatus").textContent = tone === "green" ? "Vas bien" : (tone === "amber" ? "Atencion" : "Necesitas apurarte");
      }
      if ($("supHeroState")) $("supHeroState").textContent = stateLabel;
      if ($("supHeroMeta")) $("supHeroMeta").textContent = stateMeta;
      if ($("supProjectLabel")) $("supProjectLabel").textContent = state.projectName || "Sin proyecto";
      if ($("supDueDateLabel")) $("supDueDateLabel").textContent = state.dueDate || "Sin fecha";
      if ($("supEstimatedDaysLabel")) $("supEstimatedDaysLabel").textContent = Number(state.estimatedDays || 0).toFixed(2);
      if ($("supLaborBudgetLabel")) $("supLaborBudgetLabel").textContent = money(state.laborBudget, settings.currency);
      if ($("supPortfolioCount")) $("supPortfolioCount").textContent = String(projects.length);

      if ($("supExecutiveNote")) {
        $("supExecutiveNote").textContent = `Proyecto seleccionado: ${state.projectName}. Has reportado ${reportedDays.toFixed(2)} dias y ${reportedHours.toFixed(2)} horas. Te quedan ${daysRemaining.toFixed(2)} dias estimados y ${money(laborRemaining, settings.currency)} de presupuesto restante.`;
      }

      if ($("supPrimaryBalance")) $("supPrimaryBalance").textContent = money(laborRemaining, settings.currency);
      if ($("supPrimaryMeta")) $("supPrimaryMeta").textContent = "Presupuesto restante despues de horas y extras";
      if ($("supPrimaryDays")) $("supPrimaryDays").textContent = daysRemaining.toFixed(2);
      if ($("supPrimaryDaysMeta")) $("supPrimaryDaysMeta").textContent = "Dias estimados que faltan por reportar";
      if ($("supPrimaryExtras")) $("supPrimaryExtras").textContent = money(extraSpent, settings.currency);
      if ($("supPrimaryExtrasMeta")) $("supPrimaryExtrasMeta").textContent = "Acumulado de gasto imprevisto";

      $("supervisorKpis").innerHTML = [
        ["Proyectos activos", `${projects.length}`, "El supervisor puede alternar entre varios trabajos"],
        ["Dias reportados", reportedDays.toFixed(2), "Avance real del proyecto seleccionado"],
        ["Dias restantes", daysRemaining.toFixed(2), "Dias estimados pendientes para terminar"],
        ["Horas reportadas", reportedHours.toFixed(2), "Horas reales capturadas en campo"],
        ["Presupuesto restante", money(laborRemaining, settings.currency), "Presupuesto disponible despues de horas y extras"],
        ["Gasto imprevisto", money(extraSpent, settings.currency), "Compras y costos no contemplados"],
        ["Dias de atraso", `${dayDelta}`, !state.dueDate || !state.projectedEndDate ? "Sin comparacion de fechas todavia" : (dayDelta <= 0 ? "No hay atraso proyectado" : "Diferencia contra fecha comprometida")]
      ].map(([label, value, meta]) => `
        <div class="kpi-box">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${escapeHtml(value)}</div>
          <div class="meta">${escapeHtml(meta)}</div>
        </div>
      `).join("");

      setVal("coTitle", state.changeOrderDraft.title || "");
      setVal("coNotes", state.changeOrderDraft.notes || "");
      if ($("coPrice") && $("coPrice").dataset.touched !== "true") {
        setNum("coPrice", state.changeOrderDraft.offeredPrice || 0);
      }

      const changeMetrics = calcChangeOrder(currentProject, state, settings, {
        workers: state.changeOrderDraft.workers
      });
      renderChangeOrderWorkers(currentProject, state, changeMetrics);
      const changePriceInput = $("coPrice");
      const changePriceTouched = changePriceInput?.dataset.touched === "true";
      if (changePriceInput && (!changePriceTouched || Number(changePriceInput.value || 0) === 0)) {
        const stageValue = Number(changeRange?.value || 2);
        const stagePrice = stageValue === 2 ? changeMetrics.recommended : (stageValue === 1 ? changeMetrics.negotiation : changeMetrics.minimum);
        setNum("coPrice", stagePrice);
        state.changeOrderDraft.offeredPrice = stagePrice;
        saveSupervisorReport(currentProject.id, state);
      }
      const changeOffered = num("coPrice", 0);
      let changeTone = "red";
      let changeMessage = "Precio abajo del minimo. Debe corregirse antes de enviarlo al cliente.";
      if (changeMetrics.totalWorkerDays <= 0) {
        changeTone = "amber";
        changeMessage = "Captura dias por trabajador para cotizar el change order.";
      } else if (changeOffered >= changeMetrics.recommended) {
        changeTone = "green";
        changeMessage = "Change order sano. Puedes cotizarlo con confianza.";
      } else if (changeOffered >= changeMetrics.minimum) {
        changeTone = "amber";
        changeMessage = "Precio negociable. Conviene defenderlo antes de mandarlo.";
      }

      if ($("coTraffic")) {
        $("coTraffic").className = `badge ${changeTone}`;
        $("coTraffic").textContent = changeTone === "green" ? "Listo" : (changeTone === "amber" ? "Negociable" : "Ajustar");
      }
      if ($("coRule")) $("coRule").textContent = changeMessage;
      if ($("coPrimaryPrice")) $("coPrimaryPrice").textContent = money(changeMetrics.recommended, settings.currency);
      if ($("coPrimaryMeta")) {
        $("coPrimaryMeta").textContent = changeMetrics.totalWorkerDays > 0
          ? `${changeMetrics.totalWorkerDays.toFixed(2)} worker-days ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${changeMetrics.totalHours.toFixed(2)} horas de equipo ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${changeMetrics.crewSize} trabajadores`
          : "Ingresa dias por trabajador para cotizar el trabajo extra.";
      }
      if ($("coSuggestedDays")) $("coSuggestedDays").textContent = `${changeMetrics.totalWorkerDays.toFixed(2)} dias`;
      if ($("coSuggestedDaysMeta")) $("coSuggestedDaysMeta").textContent = "Tiempo total del trabajo agregado";
      if ($("coSuggestedPrice")) $("coSuggestedPrice").textContent = money(changeOffered, settings.currency);
      if ($("coSuggestedPriceMeta")) $("coSuggestedPriceMeta").textContent = "Precio actual a presentar al cliente";
      if ($("coStageMin")) $("coStageMin").textContent = `Minimo ${money(changeMetrics.minimum, settings.currency)}`;
      if ($("coStageNegotiation")) $("coStageNegotiation").textContent = `Negociacion ${money(changeMetrics.negotiation, settings.currency)}`;
      if ($("coStageRecommended")) $("coStageRecommended").textContent = `Recomendado ${money(changeMetrics.recommended, settings.currency)}`;

      if ($("coListBody")) {
        $("coListBody").innerHTML = state.changeOrders.map((row, index) => `
          <tr>
            <td>${escapeHtml(row.title || "-")}</td>
            <td>${Number(row.addedDays || 0).toFixed(2)}</td>
            <td>${money(row.recommended || 0, settings.currency)}</td>
            <td>${money(row.offeredPrice || 0, settings.currency)}</td>
            <td><span class="badge ${row.applied ? "green" : "amber"}">${row.applied ? "applied" : "draft"}</span></td>
            <td>
              <div class="row-actions">
                <button class="btn ghost" data-pdf-change="${index}">PDF</button>
                <button class="btn primary" data-apply-change="${index}">${row.applied ? "Applied" : "Apply"}</button>
                <button class="btn danger" data-delete-change="${index}">Delete</button>
              </div>
            </td>
          </tr>
        `).join("");

        $("coListBody").querySelectorAll("button[data-pdf-change]").forEach((button) => {
          button.onclick = () => {
            const index = Number(button.dataset.pdfChange || -1);
            const row = state.changeOrders[index];
            if (!row) return;
            exportChangeOrderPdf(currentProject, row, settings);
          };
        });

        $("coListBody").querySelectorAll("button[data-delete-change]").forEach((button) => {
          button.onclick = () => {
            state.changeOrders.splice(Number(button.dataset.deleteChange || -1), 1);
            saveSupervisorReport(currentProject.id, state);
            refresh();
          };
        });

        $("coListBody").querySelectorAll("button[data-apply-change]").forEach((button) => {
          button.onclick = () => {
            const index = Number(button.dataset.applyChange || -1);
            if (index < 0 || !state.changeOrders[index] || state.changeOrders[index].applied) return;
            const row = state.changeOrders[index];
            const allProjects = loadProjects();
            const projectIndex = allProjects.findIndex((item) => item.id === currentProject.id);
            if (projectIndex < 0) return;
            allProjects[projectIndex] = {
              ...allProjects[projectIndex],
              estimatedDays: finiteNumber(allProjects[projectIndex].estimatedDays, 0) + finiteNumber(row.addedDays, 0),
              laborBudget: finiteNumber(allProjects[projectIndex].laborBudget, 0) + finiteNumber(row.laborBudgetAdded, 0)
            };
            saveProjects(allProjects);
            saveActiveProject(allProjects[projectIndex]);
            state.estimatedDays = finiteNumber(allProjects[projectIndex].estimatedDays, state.estimatedDays);
            state.laborBudget = finiteNumber(allProjects[projectIndex].laborBudget, state.laborBudget);
            state.changeOrders[index] = {
              ...row,
              applied: true,
              appliedAt: new Date().toISOString()
            };
            saveSupervisorReport(currentProject.id, state);
            refresh();
          };
        });
      }

      if ($("supEntriesBody")) {
        $("supEntriesBody").innerHTML = state.entries.map((row, index) => `
          <tr>
            <td>${escapeHtml(row.date || "-")}</td>
            <td>${escapeHtml(row.note || "-")}</td>
            <td>${Number(row.hours || 0).toFixed(2)}</td>
            <td>${Number(row.days || 0).toFixed(2)}</td>
            <td><button class="btn danger" data-delete-entry="${index}">Delete</button></td>
          </tr>
        `).join("");
        $("supEntriesBody").querySelectorAll("button[data-delete-entry]").forEach((button) => {
          button.onclick = () => {
            state.entries.splice(Number(button.dataset.deleteEntry || -1), 1);
            saveSupervisorReport(currentProject.id, state);
            refresh();
          };
        });
      }

      if ($("supExtrasBody")) {
        $("supExtrasBody").innerHTML = state.extras.map((row, index) => `
          <tr>
            <td>${escapeHtml(row.date || "-")}</td>
            <td>${escapeHtml(row.item || "-")}</td>
            <td>${money(row.amount || 0, settings.currency)}</td>
            <td>${escapeHtml(row.note || "-")}</td>
            <td><button class="btn danger" data-delete-extra="${index}">Delete</button></td>
          </tr>
        `).join("");
        $("supExtrasBody").querySelectorAll("button[data-delete-extra]").forEach((button) => {
          button.onclick = () => {
            state.extras.splice(Number(button.dataset.deleteExtra || -1), 1);
            saveSupervisorReport(currentProject.id, state);
            refresh();
          };
        });
      }
    };

    if ($("supProjectedDate")) $("supProjectedDate").oninput = refresh;

    ["coTitle", "coNotes", "coPrice"].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.oninput = () => {
        const currentProject = (loadProjects().find((project) => project.id === loadSupervisorSelectedProjectId())) || selectedProject;
        if (!currentProject) return;
        const state = loadSupervisorReport(currentProject);
        state.changeOrderDraft = {
          ...buildDefaultChangeOrderDraft(currentProject),
          ...(state.changeOrderDraft || {})
        };
        if (id === "coPrice") {
          el.dataset.touched = "true";
          state.changeOrderDraft.offeredPrice = num("coPrice", 0);
        } else {
          state.changeOrderDraft[id === "coTitle" ? "title" : "notes"] = val(id);
        }
        saveSupervisorReport(currentProject.id, state);
        refresh();
      };
    });

    if (changeRange) {
      changeRange.oninput = () => {
        const currentProject = (loadProjects().find((project) => project.id === loadSupervisorSelectedProjectId())) || selectedProject;
        const state = currentProject ? loadSupervisorReport(currentProject) : null;
        if (!currentProject || !state) return;
        const changeMetrics = calcChangeOrder(currentProject, state, settings, {
          workers: state.changeOrderDraft?.workers
        });
        const stageValue = Number(changeRange.value || 2);
        const stagePrice = stageValue === 2 ? changeMetrics.recommended : (stageValue === 1 ? changeMetrics.negotiation : changeMetrics.minimum);
        if ($("coPrice")) {
          $("coPrice").dataset.touched = "false";
          setNum("coPrice", stagePrice);
        }
        state.changeOrderDraft.offeredPrice = stagePrice;
        saveSupervisorReport(currentProject.id, state);
        refresh();
      };
    }

    if ($("btnAddCoWorker")) {
      $("btnAddCoWorker").onclick = () => {
        const currentProject = (loadProjects().find((project) => project.id === loadSupervisorSelectedProjectId())) || selectedProject;
        if (!currentProject) return alert("No signed projects yet.");
        const state = loadSupervisorReport(currentProject);
        state.changeOrderDraft = {
          ...buildDefaultChangeOrderDraft(currentProject),
          ...(state.changeOrderDraft || {})
        };
        state.changeOrderDraft.workers = Array.isArray(state.changeOrderDraft.workers) ? state.changeOrderDraft.workers : buildDefaultChangeOrderWorkers(currentProject);
        state.changeOrderDraft.workers.push({
          name: `Worker ${state.changeOrderDraft.workers.length + 1}`,
          type: "installer",
          days: 0,
          rate: ""
        });
        saveSupervisorReport(currentProject.id, state);
        renderSupervisor();
      };
    }

    if ($("btnClearCoWorkers")) {
      $("btnClearCoWorkers").onclick = () => {
        const currentProject = (loadProjects().find((project) => project.id === loadSupervisorSelectedProjectId())) || selectedProject;
        if (!currentProject) return alert("No signed projects yet.");
        const state = loadSupervisorReport(currentProject);
        state.changeOrderDraft = buildDefaultChangeOrderDraft(currentProject);
        if ($("coPrice")) $("coPrice").dataset.touched = "false";
        if (changeRange) changeRange.value = "2";
        saveSupervisorReport(currentProject.id, state);
        renderSupervisor();
      };
    }

    if ($("btnAddSupEntry")) {
      $("btnAddSupEntry").onclick = () => {
        const currentProject = (loadProjects().find((project) => project.id === loadSupervisorSelectedProjectId())) || selectedProject;
        if (!currentProject) return alert("No signed projects yet.");
        const state = loadSupervisorReport(currentProject);
        const entry = {
          date: val("supEntryDate"),
          hours: num("supEntryHours", 0),
          days: num("supEntryDays", 0),
          note: val("supEntryNote").trim()
        };
        if (!entry.date) return alert("Entry date is required.");
        if (entry.hours <= 0 && entry.days <= 0) return alert("Report hours or days worked.");
        state.locked = true;
        state.entries.unshift(entry);
        setVal("supEntryDate", "");
        setNum("supEntryHours", 0);
        setNum("supEntryDays", 0);
        setVal("supEntryNote", "");
        saveSupervisorReport(currentProject.id, state);
        refresh();
      };
    }

    if ($("btnAddSupExtra")) {
      $("btnAddSupExtra").onclick = () => {
        const currentProject = (loadProjects().find((project) => project.id === loadSupervisorSelectedProjectId())) || selectedProject;
        if (!currentProject) return alert("No signed projects yet.");
        const state = loadSupervisorReport(currentProject);
        const extra = {
          date: val("supExtraDate"),
          item: val("supExtraItem").trim(),
          amount: num("supExtraAmount", 0),
          note: val("supExtraNote").trim()
        };
        if (!extra.date) return alert("Extra expense date is required.");
        if (!extra.item) return alert("Extra expense concept is required.");
        state.locked = true;
        state.extras.unshift(extra);
        setVal("supExtraDate", "");
        setVal("supExtraItem", "");
        setNum("supExtraAmount", 0);
        setVal("supExtraNote", "");
        saveSupervisorReport(currentProject.id, state);
        refresh();
      };
    }

    if ($("btnAddChangeOrder")) {
      $("btnAddChangeOrder").onclick = () => {
        const currentProject = (loadProjects().find((project) => project.id === loadSupervisorSelectedProjectId())) || selectedProject;
        if (!currentProject) return alert("No signed projects yet.");
        const state = loadSupervisorReport(currentProject);
        state.changeOrderDraft = {
          ...buildDefaultChangeOrderDraft(currentProject),
          ...(state.changeOrderDraft || {}),
          workers: Array.isArray(state.changeOrderDraft?.workers) && state.changeOrderDraft.workers.length
            ? state.changeOrderDraft.workers
            : buildDefaultChangeOrderWorkers(currentProject)
        };
        const title = val("coTitle").trim();
        const notes = val("coNotes").trim();
        const metrics = calcChangeOrder(currentProject, state, settings, {
          workers: state.changeOrderDraft.workers
        });
        if (!title) return alert("Change order title is required.");
        if (metrics.totalWorkerDays <= 0) return alert("Capture worker-days for the extra work.");
        const offeredPrice = num("coPrice", metrics.recommended);
        state.changeOrders = Array.isArray(state.changeOrders) ? state.changeOrders : [];
        state.changeOrders.unshift({
          id: `CO-${Date.now()}`,
          createdAt: new Date().toISOString(),
          title,
          addedDays: metrics.totalWorkerDays,
          notes,
          offeredPrice,
          recommended: metrics.recommended,
          minimum: metrics.minimum,
          negotiation: metrics.negotiation,
          laborBudgetAdded: metrics.labor,
          hoursAdded: metrics.totalHours,
          workers: state.changeOrderDraft.workers.map((worker) => ({ ...worker })),
          applied: false
        });
        state.changeOrderDraft = buildDefaultChangeOrderDraft(currentProject);
        if ($("coPrice")) $("coPrice").dataset.touched = "false";
        if (changeRange) changeRange.value = "2";
        saveSupervisorReport(currentProject.id, state);
        renderSupervisor();
      };
    }

    refresh();
  }

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
        date: formatDisplayDate(primaryDate),
        dateRaw: normalizeDateInput(primaryDate),
        dueDate: formatDisplayDate(effectiveDueDate),
        dueDateRaw: normalizeDateInput(effectiveDueDate),
        promisedDate: formatDisplayDate(invoice.promisedDate),
        promisedDateRaw: normalizeDateInput(invoice.promisedDate),
        customer: project.clientName || "Sin cliente",
        title: project.projectName || "Project",
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
          rawStatus
        ].join(" ").toLowerCase()
      };
    });
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
      nextAction = daysPastDue > 0 ? "Request payment" : "Follow up";
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
    if (row.status === "sent" && !row.promisedDateRaw) return "Contactar cliente y buscar promesa de pago concreta.";
    if (row.collectionStage === "promised" && row.promisedDateRaw) {
      return row.promisedDateRaw < new Date().toISOString().slice(0, 10)
        ? "Promesa rota: escalar y documentar siguiente compromiso."
        : `Esperar promesa al ${row.promisedDate}.`;
    }
    if (["overdue", "expired"].includes(row.status)) return "Escalar seguimiento y definir siguiente accion hoy.";
    if (row.status === "partial") return "Cobrar saldo restante y confirmar fecha final.";
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
      `Open balance: ${money(totalBalance, settings.currency)}`,
      `Collected cash: ${money(totalCollected, settings.currency)}`,
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
    const promisedDate = normalizeDateInput(overrides.promisedDate || current.promisedDate);
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
    let collectionStage = ["new", "contacted", "promised", "escalated", "resolved"].includes(overrides.collectionStage)
      ? overrides.collectionStage
      : current.collectionStage;
    const todayIso = new Date().toISOString().slice(0, 10);
    const openBalance = Math.max(finiteNumber(metrics.balance, 0), 0);
    if (status === "paid") collectionStage = "resolved";
    else if (promisedDate && promisedDate < todayIso && openBalance > 0) collectionStage = "escalated";
    else if (status === "partial" && (!collectionStage || collectionStage === "new")) collectionStage = "contacted";
    else if (!collectionStage) collectionStage = "new";
    return {
      invoiceNo: nonEmptyString(overrides.invoiceNo, current.invoiceNo, `INV-${Date.now()}`),
      invoiceDate,
      dueDate,
      promisedDate,
      baseAmount,
      depositApplied,
      receivedApplied,
      status,
      collectionStage,
      payments: Array.isArray(overrides.payments) ? overrides.payments : current.payments,
      activity: Array.isArray(overrides.activity) ? overrides.activity : current.activity,
      publicToken: nonEmptyString(overrides.publicToken, current.publicToken),
      publicUrl: nonEmptyString(overrides.publicUrl, current.publicUrl),
      paymentLink: nonEmptyString(overrides.paymentLink, current.paymentLink)
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
      status: String(invoice.status || "draft").toUpperCase()
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
    saveProjectInvoiceState(projectId, nextInvoice);
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
      return { ok: false, reason: "Mark Paid only applies to invoices with open balance." };
    }
    if (nextStatus === "partial" && !(finiteNumber(current.receivedApplied, 0) > 0 && finiteNumber(calcInvoice(project, report, current).balance, 0) > 0)) {
      return { ok: false, reason: "Partial requires a real payment and open balance." };
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
      if (!hasBalance) return { ok: false, reason: "No open balance to escalate." };
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
          action: "Call client now",
          body: `${row.customer} rompio promesa. Saldo ${money(row.balance, settings.currency)} y stage ${row.collectionStage || "new"}.`
        });
      } else if (["overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0) {
        tasks.push({
          priority: 90,
          title: row.title,
          action: "Send reminder",
          body: `${row.customer} tiene vencido ${money(row.balance, settings.currency)}. Conviene reminder hoy.`
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
          action: "Follow up partial",
          body: `${row.customer} sigue parcial. Faltan ${money(row.balance, settings.currency)} por cobrar.`
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
      const alreadyQueuedToday = activity.some((item) =>
        (item.type || "") === "collections" &&
        normalizeDateInput(item.at) === todayIso &&
        String(item.message || "").includes("Auto reminder queued")
      );
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
        `Auto reminder queued for ${project.clientName || "client"}.`,
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

  function sendHubInvoice(projectId) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const invoice = buildHubInvoiceState(project, report, { status: "sent" });
    const metrics = calcInvoice(project, report, invoice);
    invoice.activity = appendInvoiceActivity(invoice, "Invoice email prepared for client.", undefined, "email");
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
  }

  function requestHubPayment(projectId) {
    const project = getProjectById(projectId);
    if (!project) return;
    const report = loadSupervisorReport(project);
    const invoice = getProjectInvoiceState(project);
    const metrics = calcInvoice(project, report, invoice);
    const nextInvoice = buildHubInvoiceState(project, report, { status: invoice.status || "sent" });
    nextInvoice.activity = appendInvoiceActivity(nextInvoice, "Payment request email prepared for client.", undefined, "collections");
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
      `Open balance: ${money(metrics.balance, settings.currency)}`
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
      `Balance due: ${money(metrics.balance, settings.currency)}`
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

  function renderHubDrawerDetails(row, settings, handlers) {
    if (!row) return;
    const invoice = getProjectInvoiceState(row.project);
    if ($("hubDrawer")) $("hubDrawer").setAttribute("aria-hidden", "false");
    if ($("hubDrawerTitle")) $("hubDrawerTitle").textContent = row.title;
    if ($("hubDrawerSubtitle")) {
      $("hubDrawerSubtitle").textContent = `${row.customer}   ${row.projectId}   ${row.status}   ${money(row.amount, settings.currency)}`;
    }
    if ($("hubDrawerStats")) {
      $("hubDrawerStats").innerHTML = [
        ["Location", row.location || "No location", "Ubicacion asociada al proyecto"],
        ["Customer", row.customerEmail || "No email", row.customerPhone || "No phone"],
        ["Invoice", row.invoiceNo || "No invoice", "Folio o referencia actual"],
        ["Collections", row.collectionStage || "new", "Etapa actual de seguimiento"],
        ["Balance", money(row.balance, settings.currency), "Saldo pendiente del proyecto"],
        ["Due Date", row.dueDate || "No due date", row.daysPastDue > 0 ? `${row.daysPastDue} dias past due` : "Fecha comprometida del cobro"],
        ["Promise", row.promisedDate || "No promise", row.promisedDateRaw ? "Promesa de pago registrada" : "Sin promesa activa"],
        ["Priority", `${row.priorityScore}`, `Next: ${row.nextAction}`],
        ["Health", `${row.projectHealthScore}%`, row.projectHealthLabel],
        ["Payments", money((row.depositApplied || 0) + (row.receivedApplied || 0), settings.currency), "Depositos y cobros aplicados"]
      ].map(([title, big, small]) => `
        <div class="supervisor-summary-card">
          <div class="title">${escapeHtml(title)}</div>
          <div class="big">${escapeHtml(big)}</div>
          <div class="small">${escapeHtml(small)}</div>
        </div>
      `).join("");
    }
    if ($("hubDrawerNote")) {
      $("hubDrawerNote").textContent = `Proyecto ${row.title}. Estado ${row.status}. Proxima accion sugerida: ${row.nextAction}. Playbook: ${getHubSuggestedPlaybook(row)} Change orders totales: ${row.changeOrderCount}. Change orders incluidos en invoice: ${row.approvedChangeOrderCount}.`;
    }
    if (typeof handlers.applyHubActionButtonState === "function") {
      handlers.applyHubActionButtonState(row);
    }

    if ($("hubDrawerCoBody")) {
      const changeOrders = Array.isArray(row.report?.changeOrders) ? row.report.changeOrders : [];
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

    if ($("hubDrawerPaymentsBody")) {
      $("hubDrawerPaymentsBody").innerHTML = invoice.payments.length
        ? invoice.payments.map((payment, index) => `
            <tr>
              <td>${escapeHtml(formatDisplayDate(payment.date))}</td>
              <td>${escapeHtml(payment.method || "manual")}</td>
              <td>${escapeHtml(payment.note || "-")}</td>
              <td>${money(payment.amount || 0, settings.currency)}</td>
              <td>
                <div class="row-actions">
                  <button class="btn ghost" data-edit-payment="${index}">Edit</button>
                  <button class="btn danger" data-delete-payment="${index}">Delete</button>
                </div>
              </td>
            </tr>
          `).join("")
        : `<tr><td colspan="5">No payments recorded yet.</td></tr>`;

      $("hubDrawerPaymentsBody").querySelectorAll("button[data-edit-payment]").forEach((button) => {
        button.onclick = () => {
          const index = Number(button.dataset.editPayment || -1);
          const payment = invoice.payments[index];
          if (!payment || typeof handlers.onEditPayment !== "function") return;
          handlers.onEditPayment(index, payment);
        };
      });

      $("hubDrawerPaymentsBody").querySelectorAll("button[data-delete-payment]").forEach((button) => {
        button.onclick = () => {
          const index = Number(button.dataset.deletePayment || -1);
          if (index < 0 || typeof handlers.onDeletePayment !== "function") return;
          handlers.onDeletePayment(index);
        };
      });
    }

    if ($("hubDrawerPaymentTotals")) {
      const totalsByMethod = invoice.payments.reduce((acc, payment) => {
        const key = nonEmptyString(payment.method, "manual");
        acc[key] = (acc[key] || 0) + Math.max(finiteNumber(payment.amount, 0), 0);
        return acc;
      }, {});
      const methodEntries = Object.entries(totalsByMethod);
      $("hubDrawerPaymentTotals").innerHTML = methodEntries.length
        ? methodEntries.map(([method, amount]) => `
            <div class="supervisor-summary-card">
              <div class="title">Method</div>
              <div class="big">${escapeHtml(method)}</div>
              <div class="small">${escapeHtml(money(amount, settings.currency))}</div>
            </div>
          `).join("")
        : `
            <div class="supervisor-summary-card">
              <div class="title">Methods</div>
              <div class="big">No payments</div>
              <div class="small">Aun no hay cobros registrados</div>
            </div>
          `;
    }

    const renderActivityRows = (items, emptyMessage) => items.length
      ? items.map((item) => `
          <tr>
            <td><span class="hub-activity-type ${escapeHtml(item.type || "note")}">${escapeHtml(item.type || "note")}</span> ${escapeHtml(item.message || "-")}</td>
            <td>${escapeHtml(formatDisplayDate(item.at))}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="2">${escapeHtml(emptyMessage)}</td></tr>`;

    if ($("hubDrawerActivityBody")) {
      $("hubDrawerActivityBody").innerHTML = renderActivityRows(invoice.activity, "No activity recorded yet.");
    }
    if ($("hubDrawerCollectionsBody")) {
      const collectionEvents = invoice.activity.filter((item) => ["followup", "collections"].includes(item.type || "note"));
      $("hubDrawerCollectionsBody").innerHTML = renderActivityRows(collectionEvents, "No collections history yet.");
    }
  }

  function renderHubFocusQueueList(filteredRows, settings, onOpenRow) {
    if (!$("hubFocusQueue")) return;
    const focusRows = filteredRows
      .filter((row) => row.priorityScore > 0)
      .slice()
      .sort((left, right) => right.priorityScore - left.priorityScore)
      .slice(0, 5);
    $("hubFocusQueue").innerHTML = focusRows.length
      ? focusRows.map((row, index) => `
          <li data-project-id="${escapeHtml(row.projectId)}">
            <span class="msg-idx">${index + 1}</span>
            <div>
              <strong>${escapeHtml(row.title)}</strong>
              <span class="hub-inline-meta">${escapeHtml(row.customer)} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· Score ${escapeHtml(String(row.priorityScore))} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${escapeHtml(row.nextAction)}</span>
              <span class="hub-health ${escapeHtml(row.projectHealthTone || "green")}">Health ${escapeHtml(String(row.projectHealthScore))}% ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${escapeHtml(row.projectHealthLabel)}</span>
              <span class="hub-inline-meta">Balance ${escapeHtml(money(row.balance, settings.currency))} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· Due ${escapeHtml(row.dueDate || "No due date")}</span>
            </div>
          </li>
        `).join("")
      : `<li><span class="msg-idx">0</span><div><strong>Sin urgencias</strong><span class="hub-inline-meta">No hay cuentas con prioridad alta en este filtro.</span></div></li>`;
    $("hubFocusQueue").querySelectorAll("li[data-project-id]").forEach((item) => {
      item.onclick = () => {
        const row = filteredRows.find((entry) => entry.projectId === (item.dataset.projectId || ""));
        if (!row || typeof onOpenRow !== "function") return;
        onOpenRow(row);
      };
    });
  }

  function renderHubTableSection(config) {
    const {
      filteredRows,
      selectedProjectIds,
      settings,
      activeTab,
      refreshBulkBar,
      onOpenRow,
      onConvert,
      onSent,
      onPay,
      onReminder,
      onSales,
      onOwner,
      onPdf
    } = config;
    if (!$("hubTableBody")) return;
    $("hubTableBody").closest(".supervisor-table-wrap").style.display = activeTab === "pipeline" ? "none" : "block";
    $("hubTableBody").innerHTML = filteredRows.length
      ? filteredRows.map((row) => {
          const actionState = getHubRowActionState(row);
          return `
          <tr>
            <td><input type="checkbox" data-hub-select="${escapeHtml(row.projectId)}" ${selectedProjectIds.has(row.projectId) ? "checked" : ""} /></td>
            <td>${escapeHtml(row.date)}</td>
            <td>${escapeHtml(row.customer)}</td>
            <td>${escapeHtml(row.projectId)}</td>
            <td>${escapeHtml(row.location || "No location")}</td>
            <td>
              <strong>${escapeHtml(row.title)}</strong>
              <div class="meta">${escapeHtml(row.invoiceNo)}</div>
              <span class="hub-inline-meta">Priority ${escapeHtml(String(row.priorityScore))} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${escapeHtml(row.nextAction)}</span>
              <span class="hub-health ${escapeHtml(row.projectHealthTone || "green")}">Health ${escapeHtml(String(row.projectHealthScore))}% ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${escapeHtml(row.projectHealthLabel)}</span>
            </td>
            <td><span class="hub-status ${escapeHtml(row.status)}">${escapeHtml(row.status)}</span></td>
            <td>${money(row.amount, settings.currency)}</td>
            <td>${money(row.balance, settings.currency)}</td>
            <td>
              <div class="row-actions wrap">
                <button class="btn ghost" data-hub-view="${escapeHtml(row.projectId)}">View</button>
                <button class="btn ghost ${actionState.canConvert ? "" : "hub-action-disabled"}" ${actionState.canConvert ? "" : "disabled"} title="${actionState.canConvert ? "" : "Create invoice first"}" data-hub-convert="${escapeHtml(row.projectId)}">Convert</button>
                <button class="btn ghost ${actionState.canMarkSent ? "" : "hub-action-disabled"}" ${actionState.canMarkSent ? "" : "disabled"} title="${actionState.canMarkSent ? "" : "Invoice required"}" data-hub-sent="${escapeHtml(row.projectId)}">Sent</button>
                <button class="btn ghost ${actionState.canRequestPayment ? "" : "hub-action-disabled"}" ${actionState.canRequestPayment ? "" : "disabled"} title="${actionState.canRequestPayment ? "" : "Invoice with open balance required"}" data-hub-reminder="${escapeHtml(row.projectId)}">Reminder</button>
                <button class="btn ghost ${actionState.canTakePayment ? "" : "hub-action-disabled"}" ${actionState.canTakePayment ? "" : "disabled"} title="${actionState.canTakePayment ? "" : "Invoice with balance required"}" data-hub-pay="${escapeHtml(row.projectId)}">Pay</button>
                <button class="btn ghost" data-hub-sales="${escapeHtml(row.projectId)}">Sales</button>
                <button class="btn ghost" data-hub-owner="${escapeHtml(row.projectId)}">Owner</button>
                <button class="btn primary ${actionState.canExportPdf ? "" : "hub-action-disabled"}" ${actionState.canExportPdf ? "" : "disabled"} title="${actionState.canExportPdf ? "" : "Invoice required"}" data-hub-pdf="${escapeHtml(row.projectId)}">PDF</button>
              </div>
            </td>
          </tr>
        `;
        }).join("")
      : `<tr><td colspan="10">No rows match the current filters.</td></tr>`;

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
          const projectId = Object.values(button.dataset)[0] || "";
          const row = filteredRows.find((item) => item.projectId === projectId);
          if (!row || typeof callback !== "function") return;
          callback(row, projectId);
        };
      });
    };

    bindButton("button[data-hub-view]", (row) => onOpenRow(row));
    bindButton("button[data-hub-convert]", (row) => onConvert(row));
    bindButton("button[data-hub-sent]", (row) => onSent(row));
    bindButton("button[data-hub-pay]", (row, projectId) => onPay(row, projectId));
    bindButton("button[data-hub-reminder]", (row) => onReminder(row));
    bindButton("button[data-hub-sales]", (row) => onSales(row));
    bindButton("button[data-hub-owner]", (row) => onOwner(row));
    bindButton("button[data-hub-pdf]", (row, projectId) => onPdf(row, projectId));
    refreshBulkBar();
  }

  function renderHubPipelineSection(config) {
    const { filteredRows, activeTab, settings, onOpenRow, onSent, onRequest, onContacted, onPromise, onEscalate, onDropColumn } = config;
    if (!$("hubPipelineBoard")) return;
    const columns = [
      { key: "draft", label: "Draft" },
      { key: "sent", label: "Sent" },
      { key: "partial", label: "Partial" },
      { key: "paid", label: "Paid" },
      { key: "attention", label: "Overdue / Expired" }
    ];
    const groups = {
      draft: filteredRows.filter((row) => row.status === "draft"),
      sent: filteredRows.filter((row) => row.status === "sent"),
      partial: filteredRows.filter((row) => row.status === "partial"),
      paid: filteredRows.filter((row) => row.status === "paid"),
      attention: filteredRows.filter((row) => ["overdue", "expired"].includes(row.status))
    };
    $("hubPipelineBoard").style.display = activeTab === "pipeline" ? "block" : "none";
    $("hubPipelineBoard").innerHTML = activeTab === "pipeline"
      ? `
          <div class="hub-pipeline">
            ${columns.map((column) => `
              <div class="hub-pipeline-column" data-pipeline-column="${escapeHtml(column.key)}">
                <div class="section-head" style="margin-bottom:10px;">
                  <div>
                    <h2 style="margin:0;">${escapeHtml(column.label)}</h2>
                    <div class="sub">${groups[column.key].length} rows</div>
                  </div>
                </div>
                <div class="hub-pipeline-stack">
                  ${groups[column.key].length ? groups[column.key].map((row) => `
                    <div class="hub-pipeline-card" draggable="true" data-hub-pipeline="${escapeHtml(row.projectId)}">
                      <strong>${escapeHtml(row.title)}</strong>
                      <span class="hub-inline-meta">${escapeHtml(row.customer)}</span>
                      <span class="hub-inline-meta">${escapeHtml(money(row.amount, settings.currency))} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· Balance ${escapeHtml(money(row.balance, settings.currency))}</span>
                      <span class="hub-inline-meta">Priority ${escapeHtml(String(row.priorityScore))} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${escapeHtml(row.nextAction)}</span>
                      <span class="hub-health ${escapeHtml(row.projectHealthTone || "green")}">Health ${escapeHtml(String(row.projectHealthScore))}% ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${escapeHtml(row.projectHealthLabel)}</span>
                      <div class="hub-pipeline-actions">
                        <button class="btn ghost" type="button" data-hub-pipeline-view="${escapeHtml(row.projectId)}">View</button>
                        ${getHubRowActionState(row).canMarkSent ? `<button class="btn ghost" type="button" data-hub-pipeline-sent="${escapeHtml(row.projectId)}">Sent</button>` : ""}
                        ${getHubRowActionState(row).canRequestPayment ? `<button class="btn ghost" type="button" data-hub-pipeline-request="${escapeHtml(row.projectId)}">Request</button>` : ""}
                        ${row.status !== "paid" ? `<button class="btn ghost" type="button" data-hub-pipeline-contacted="${escapeHtml(row.projectId)}">Contacted</button>` : ""}
                        ${row.status !== "paid" ? `<button class="btn ghost" type="button" data-hub-pipeline-promise="${escapeHtml(row.projectId)}">Promised</button>` : ""}
                        ${["sent", "partial", "overdue", "expired"].includes(row.status) ? `<button class="btn ghost" type="button" data-hub-pipeline-escalate="${escapeHtml(row.projectId)}">Escalate</button>` : ""}
                      </div>
                    </div>
                  `).join("") : `<div class="notice">No rows</div>`}
                </div>
              </div>
            `).join("")}
          </div>
        `
      : "";

    $("hubPipelineBoard").querySelectorAll("[data-hub-pipeline]").forEach((card) => {
      card.ondragstart = (event) => {
        event.dataTransfer?.setData("text/plain", card.dataset.hubPipeline || "");
        card.classList.add("dragging");
      };
      card.ondragend = () => {
        card.classList.remove("dragging");
      };
      card.onclick = () => {
        const row = filteredRows.find((entry) => entry.projectId === (card.dataset.hubPipeline || ""));
        if (!row || typeof onOpenRow !== "function") return;
        onOpenRow(row);
      };
    });

    $("hubPipelineBoard").querySelectorAll(".hub-pipeline-column").forEach((column) => {
      column.ondragover = (event) => {
        event.preventDefault();
        column.classList.add("drag-over");
      };
      column.ondragleave = () => {
        column.classList.remove("drag-over");
      };
      column.ondrop = (event) => {
        event.preventDefault();
        column.classList.remove("drag-over");
        const projectId = event.dataTransfer?.getData("text/plain") || "";
        const row = filteredRows.find((entry) => entry.projectId === projectId);
        const targetKey = column.dataset.pipelineColumn || "";
        if (!row || !targetKey || typeof onDropColumn !== "function") return;
        onDropColumn(row, targetKey);
      };
    });

    const bindPipelineButton = (selector, callback) => {
      $("hubPipelineBoard").querySelectorAll(selector).forEach((button) => {
        button.onclick = (event) => {
          event.stopPropagation();
          const projectId = Object.values(button.dataset)[0] || "";
          const row = filteredRows.find((entry) => entry.projectId === projectId);
          if (!row || typeof callback !== "function") return;
          callback(row);
        };
      });
    };

    bindPipelineButton("[data-hub-pipeline-view]", onOpenRow);
    bindPipelineButton("[data-hub-pipeline-sent]", onSent);
    bindPipelineButton("[data-hub-pipeline-request]", onRequest);
    bindPipelineButton("[data-hub-pipeline-contacted]", onContacted);
    bindPipelineButton("[data-hub-pipeline-promise]", onPromise);
    bindPipelineButton("[data-hub-pipeline-escalate]", onEscalate);
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
    if ($("hubClientSubtitle")) $("hubClientSubtitle").textContent = `${filtered.length} proyectos ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· Open ${money(totalOpen, settings.currency)}`;
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
          sent ? `${sent} reminders preparados para ${customerName}.` : `No habia reminders validos para ${customerName}.`,
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

  function renderEstimatesHub() {
    if (!$("hubTableBody")) return;

    const settings = loadSettings();
    const hubViewState = loadHubViewState();
    let filteredRows = [];
    let activeTab = hubViewState.tab || "all";
    let activePreset = hubViewState.preset || "";
    let selectedRow = null;
    let sortKey = hubViewState.sortKey || "dateRaw";
    let sortDir = hubViewState.sortDir || "desc";
    const selectedProjectIds = new Set();

    const persistHubView = () => {
      saveHubViewState({
        tab: activeTab,
        preset: activePreset,
        sortKey,
        sortDir,
        search: val("hubSearch"),
        status: val("hubStatusFilter"),
        dateFrom: val("hubDateFrom"),
        customer: val("hubCustomerFilter"),
        location: val("hubLocationFilter")
      });
    };

    const applyHubSortButtons = () => {
      document.querySelectorAll("[data-hub-sort]").forEach((node) => {
        const isActive = node.dataset.hubSort === sortKey;
        const label = node.textContent.replace(/\s+[??]$/, "");
        node.textContent = isActive ? `${label} ${sortDir === "asc" ? "?" : "?"}` : label;
        node.classList.toggle("active", isActive);
      });
    };

    const applyHubActionButtonState = (row) => {
      const actionState = getHubRowActionState(row);
      const buttonRules = [
        ["btnHubDrawerCustomer", true, ""],
        ["btnHubDrawerDuplicate", true, ""],
        ["btnHubDrawerDuplicateInvoice", actionState.canExportPdf, "Necesitas un invoice real antes de duplicarlo."],
        ["btnHubDrawerSetup", true, ""],
        ["btnHubDrawerConvert", actionState.canConvert, "Convierte primero el estimate a invoice cuando ya exista monto vendible."],
        ["btnHubDrawerSendInvoice", actionState.canSendInvoice, "Necesitas invoice, cliente y monto antes de preparar el envio."],
        ["btnHubDrawerRequestPayment", actionState.canRequestPayment, "Request Payment solo aplica a invoices enviadas o parciales con saldo pendiente."],
        ["btnHubDrawerSent", actionState.canMarkSent, "Primero crea el invoice; despues ya lo puedes marcar como sent."],
        ["btnHubDrawerPayment", actionState.canTakePayment, "Take Payment solo aplica cuando el invoice ya existe y aun tiene saldo."],
        ["btnHubDrawerPaid", actionState.canMarkPaid, "Mark Paid solo aplica cuando existe invoice con saldo pendiente."],
        ["btnHubDrawerStatement", actionState.canExportPdf, "El statement necesita un invoice real para generarse."],
        ["btnHubDrawerPublish", actionState.canPublishLink, "Publish Link requiere invoice, cliente y monto valido."],
        ["btnHubDrawerPaymentLink", actionState.canSetPaymentLink, "Primero crea el invoice para guardar un payment link."],
        ["btnHubDrawerOpenPublic", actionState.canOpenPublic, "Aun no existe link publico para este invoice."],
        ["btnHubDrawerPdf", actionState.canExportPdf, "El PDF del invoice requiere un invoice valido con monto."]
      ];
      buttonRules.forEach(([id, allowed, title]) => {
        const node = $(id);
        if (!node) return;
        node.disabled = !allowed;
        node.classList.toggle("hub-action-disabled", !allowed);
        node.title = allowed ? "" : title;
      });
    };

    const refreshBulkBar = () => {
      const selectedRows = filteredRows.filter((row) => selectedProjectIds.has(row.projectId));
      const total = selectedRows.reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
      if ($("hubBulkBar")) $("hubBulkBar").style.display = selectedRows.length ? "block" : "none";
      if ($("hubBulkCount")) $("hubBulkCount").textContent = String(selectedRows.length);
      if ($("hubBulkAmount")) $("hubBulkAmount").textContent = money(total, settings.currency);
      if ($("hubSelectAll")) {
        $("hubSelectAll").checked = Boolean(filteredRows.length) && selectedRows.length === filteredRows.length;
      }
    };

    const showHubActionForm = (config) => {
      openHubFormModal({
        ...config,
        onSubmit: config.onSubmit
      });
    };

    const refreshSelectedRow = () => {
      if (!selectedRow) return;
      const next = buildPortfolioRows(settings).find((row) => row.projectId === selectedRow.projectId);
      if (!next) return;
      openHubDrawer(next);
    };

    const openHubDrawer = (row) => {
      selectedRow = row;
      renderHubDrawerDetails(row, settings, {
        applyHubActionButtonState,
        onEditPayment: (index, payment) => {
          if (!selectedRow) return;
          openPaymentForm(selectedRow, payment, ({ amount, method, note, date }) => {
            editHubPayment(selectedRow.projectId, index, { amount, method, note, date });
          });
          hubFormState.successMessage = `Pago actualizado para ${selectedRow.title}.`;
        },
        onDeletePayment: (index) => {
          if (!selectedRow || index < 0) return;
          deleteHubPayment(selectedRow.projectId, index);
          refresh();
          refreshSelectedRow();
          setHubFeedback(`Pago eliminado de ${selectedRow.title}.`, "ok");
        }
      });
    };

    const closeHubDrawer = () => {
      if ($("hubDrawer")) $("hubDrawer").setAttribute("aria-hidden", "true");
    };

    const openPaymentForm = (row, existingPayment, onSubmit) => {
      showHubActionForm({
        title: existingPayment ? "Editar pago" : "Registrar pago",
        subtitle: `${row.title} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${row.customer}`,
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
        subtitle: `${row.title} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${row.customer}`,
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
        subtitle: `${row.title} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${row.invoiceNo || "No invoice"}`,
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
        subtitle: `${row.title} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${row.customer}`,
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
      showHubActionForm({
        title: "Configurar invoice",
        subtitle: `${row.title} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${row.customer}`,
        submitLabel: "Guardar invoice",
        fields: [
          { id: "hubFormInvoiceNo", label: "Invoice No", type: "text", value: invoice.invoiceNo || "", placeholder: "INV-1001" },
          { id: "hubFormInvoiceDate", label: "Invoice Date", type: "date", value: invoice.invoiceDate || new Date().toISOString().slice(0, 10) },
          { id: "hubFormInvoiceDueDate", label: "Due Date", type: "date", value: invoice.dueDate || row.project?.dueDate || "" },
          { id: "hubFormInvoicePromiseDate", label: "Promised Payment Date", type: "date", value: invoice.promisedDate || "" },
          { id: "hubFormInvoiceBase", label: "Base Amount", type: "number", step: "0.01", value: invoice.baseAmount || row.project?.salePrice || 0, placeholder: "0.00" },
          {
            id: "hubFormCollectionStage",
            label: "Collections Stage",
            type: "select",
            value: invoice.collectionStage || "new",
            options: ["new", "contacted", "promised", "escalated", "resolved"].map((value) => ({ value, label: value }))
          }
        ],
        onSubmit: () => {
          const invoiceNo = val("hubFormInvoiceNo");
          const invoiceDate = val("hubFormInvoiceDate");
          const dueDate = val("hubFormInvoiceDueDate");
          const promisedDate = val("hubFormInvoicePromiseDate");
          const baseAmount = Number(val("hubFormInvoiceBase"));
          const collectionStage = val("hubFormCollectionStage") || "new";
          if (!normalizeDateInput(invoiceDate)) {
            setNotice("hubFormFeedback", "Invoice date es obligatoria.", "err");
            return false;
          }
          if (dueDate && !normalizeDateInput(dueDate)) {
            setNotice("hubFormFeedback", "Due date no tiene formato valido.", "err");
            return false;
          }
          if (promisedDate && !normalizeDateInput(promisedDate)) {
            setNotice("hubFormFeedback", "Promised payment date no tiene formato valido.", "err");
            return false;
          }
          if (!Number.isFinite(baseAmount) || baseAmount < 0) {
            setNotice("hubFormFeedback", "Base amount debe ser un numero valido.", "err");
            return false;
          }
          const nextInvoice = buildHubInvoiceState(row.project, row.report, {
            invoiceNo,
            invoiceDate,
            dueDate,
            promisedDate: collectionStage === "promised" ? promisedDate : "",
            baseAmount,
            collectionStage
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
      const allRows = buildPortfolioRows(settings);
      const search = val("hubSearch").trim().toLowerCase();
      const statusFilter = val("hubStatusFilter") || "all";
      const dateFrom = normalizeDateInput(val("hubDateFrom"));
      const customerFilter = val("hubCustomerFilter").trim().toLowerCase();
      const locationFilter = val("hubLocationFilter").trim().toLowerCase();
      const todayIso = new Date().toISOString().slice(0, 10);

      filteredRows = allRows.filter((row) => {
        if (activeTab === "estimates" && row.rowType !== "estimate") return false;
        if (activeTab === "invoices" && row.rowType !== "invoice") return false;
        if (activeTab === "payments" && row.paymentType !== "payment") return false;
        if (activeTab === "pipeline" && !["draft", "sent", "partial", "paid", "overdue", "expired"].includes(row.status)) return false;
        if (activeTab === "collections" && !(["partial", "overdue", "expired", "sent"].includes(row.status) && finiteNumber(row.balance, 0) > 0)) return false;
        if (activeTab === "closeout" && row.projectStatus !== "completed") return false;
        if (search && !row.searchText.includes(search)) return false;
        if (statusFilter !== "all" && row.status !== statusFilter) return false;
        if (dateFrom && row.dateRaw && row.dateRaw < dateFrom) return false;
        if (customerFilter && !row.customer.toLowerCase().includes(customerFilter)) return false;
        if (locationFilter && !row.location.toLowerCase().includes(locationFilter)) return false;
        if (activePreset === "open" && !(finiteNumber(row.balance, 0) > 0)) return false;
        if (activePreset === "action" && !(row.priorityScore >= 60 || ["overdue", "expired", "partial"].includes(row.status))) return false;
        if (activePreset === "promises" && !(row.promisedDateRaw && row.promisedDateRaw < todayIso && finiteNumber(row.balance, 0) > 0 && row.status !== "paid")) return false;
        if (activePreset === "ready" && !(row.rowType === "estimate" && row.amount > 0 && row.projectStatus !== "completed")) return false;
        return true;
      });

      filteredRows = filteredRows.slice().sort((left, right) => {
        const comparison = compareHubValues(left?.[sortKey], right?.[sortKey], sortKey);
        return sortDir === "asc" ? comparison : -comparison;
      });
      applyHubSortButtons();
      persistHubView();

      const totalAmount = filteredRows.reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
      const totalBalance = filteredRows.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0);
      const pendingAmount = filteredRows
        .filter((row) => ["draft", "sent", "completed", "expired", "overdue"].includes(row.status))
        .reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
      const partialAmount = filteredRows
        .filter((row) => row.status === "partial")
        .reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
      const paidAmount = filteredRows
        .filter((row) => row.status === "paid")
        .reduce((sum, row) => sum + finiteNumber(row.amount, 0), 0);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const ageBuckets = filteredRows.reduce((acc, row) => {
        if (!(finiteNumber(row.balance, 0) > 0)) return acc;
        if (!row.project?.dueDate) {
          acc.current += finiteNumber(row.balance, 0);
          return acc;
        }
        const dueDate = new Date(normalizeDateInput(row.project.dueDate));
        dueDate.setHours(0, 0, 0, 0);
        const daysPastDue = Math.floor((today - dueDate) / (1000 * 60 * 60 * 24));
        if (daysPastDue <= 0) acc.current += finiteNumber(row.balance, 0);
        else if (daysPastDue <= 30) acc.age30 += finiteNumber(row.balance, 0);
        else if (daysPastDue <= 60) acc.age60 += finiteNumber(row.balance, 0);
        else acc.age61 += finiteNumber(row.balance, 0);
        return acc;
      }, { current: 0, age30: 0, age60: 0, age61: 0 });
      const collectionsRows = filteredRows.filter((row) => ["partial", "overdue", "expired", "sent"].includes(row.status) && finiteNumber(row.balance, 0) > 0);
      const closeoutRows = filteredRows.filter((row) => row.projectStatus === "completed");
      const averagePastDue = collectionsRows.length
        ? collectionsRows.reduce((sum, row) => {
            const due = normalizeDateInput(row.project?.dueDate);
            if (!due) return sum;
            const days = Math.max(Math.floor((today - new Date(due)) / (1000 * 60 * 60 * 24)), 0);
            return sum + days;
          }, 0) / collectionsRows.length
        : 0;

      if ($("hubHeroTotal")) $("hubHeroTotal").textContent = money(totalAmount, settings.currency);
      if ($("hubHeroMeta")) {
        $("hubHeroMeta").textContent = filteredRows.length
          ? (activeTab === "collections"
            ? `${collectionsRows.length} rows en cobranza con atraso promedio de ${averagePastDue.toFixed(1)} dias.`
            : activeTab === "closeout"
              ? `${closeoutRows.length} proyectos terminados con ${money(closeoutRows.reduce((sum, row) => sum + row.estimatedMargin, 0), settings.currency)} de margen estimado.`
              : `${filteredRows.length} rows activas con ${money(totalBalance, settings.currency)} por cobrar.`)
          : "Todavia no hay estimates o invoices en cartera.";
      }
      if ($("hubPortfolioBadge")) $("hubPortfolioBadge").textContent = `${filteredRows.length} rows`;
      if ($("hubTableBadge")) $("hubTableBadge").textContent = activeTab === "all" ? (statusFilter === "all" ? "All estimates" : statusFilter) : activeTab;
      if ($("hubInvoicedTotal")) $("hubInvoicedTotal").textContent = money(totalAmount, settings.currency);
      if ($("hubPendingTotal")) $("hubPendingTotal").textContent = money(pendingAmount, settings.currency);
      if ($("hubPartialTotal")) $("hubPartialTotal").textContent = money(partialAmount, settings.currency);
      if ($("hubPaidTotal")) $("hubPaidTotal").textContent = money(paidAmount, settings.currency);
      if ($("hubPendingMeta")) $("hubPendingMeta").textContent = `${filteredRows.filter((row) => ["draft", "sent", "completed", "expired", "overdue"].includes(row.status)).length} projects`;
      if ($("hubPartialMeta")) $("hubPartialMeta").textContent = `${filteredRows.filter((row) => row.status === "partial").length} projects`;
      if ($("hubPaidMeta")) $("hubPaidMeta").textContent = `${filteredRows.filter((row) => row.status === "paid").length} projects`;
      if ($("hubInvoicedMeta")) $("hubInvoicedMeta").textContent = `${filteredRows.length} rows en pantalla`;
      if ($("hubPendingLabel")) $("hubPendingLabel").textContent = `Pending ${money(pendingAmount, settings.currency)}`;
      if ($("hubPartialLabel")) $("hubPartialLabel").textContent = `Partial ${money(partialAmount, settings.currency)}`;
      if ($("hubPaidLabel")) $("hubPaidLabel").textContent = `Paid ${money(paidAmount, settings.currency)}`;
      if ($("hubAgeCurrent")) $("hubAgeCurrent").textContent = money(ageBuckets.current, settings.currency);
      if ($("hubAge30")) $("hubAge30").textContent = money(ageBuckets.age30, settings.currency);
      if ($("hubAge60")) $("hubAge60").textContent = money(ageBuckets.age60, settings.currency);
      if ($("hubAge61")) $("hubAge61").textContent = money(ageBuckets.age61, settings.currency);

      const progressBase = totalAmount > 0 ? totalAmount : 1;
      if ($("hubProgressPending")) $("hubProgressPending").style.width = `${(pendingAmount / progressBase) * 100}%`;
      if ($("hubProgressPartial")) $("hubProgressPartial").style.width = `${(partialAmount / progressBase) * 100}%`;
      if ($("hubProgressPaid")) $("hubProgressPaid").style.width = `${(paidAmount / progressBase) * 100}%`;

      if ($("hubKpis")) {
        const totalChangeOrders = filteredRows.reduce((sum, row) => sum + row.changeOrderCount, 0);
        const approvedChangeOrders = filteredRows.reduce((sum, row) => sum + row.approvedChangeOrderCount, 0);
        const overdueLikeCount = filteredRows.filter((row) => ["draft", "sent", "partial", "overdue", "expired"].includes(row.status) && finiteNumber(row.balance, 0) > 0).length;
        const kpis = activeTab === "collections"
          ? [
              ["Collections Queue", String(collectionsRows.length), "Rows que necesitan cobro o seguimiento"],
              ["Collections Balance", money(collectionsRows.reduce((sum, row) => sum + finiteNumber(row.balance, 0), 0), settings.currency), "Saldo total en cobranza"],
              ["Avg Days Past Due", averagePastDue.toFixed(1), "Promedio de atraso actual"],
              ["Critical 61+", money(ageBuckets.age61, settings.currency), "Cobro urgente"]
            ]
          : activeTab === "pipeline"
            ? [
                ["Draft", String(filteredRows.filter((row) => row.status === "draft").length), "Estimados listos para trabajar"],
                ["Sent", String(filteredRows.filter((row) => row.status === "sent").length), "Esperando respuesta o pago"],
                ["Partial", String(filteredRows.filter((row) => row.status === "partial").length), "Cobros en progreso"],
                ["Overdue+", String(filteredRows.filter((row) => ["overdue", "expired"].includes(row.status)).length), "Cuentas que ya necesitan accion"]
              ]
          : activeTab === "closeout"
            ? [
                ["Completed Projects", String(closeoutRows.length), "Proyectos marcados como terminados"],
                ["Sold", money(closeoutRows.reduce((sum, row) => sum + row.soldAmount, 0), settings.currency), "Contrato base mas change orders aprobados"],
                ["Collected", money(closeoutRows.reduce((sum, row) => sum + row.cashCollected, 0), settings.currency), "Depositos y pagos reales"],
                ["Estimated Margin", money(closeoutRows.reduce((sum, row) => sum + row.estimatedMargin, 0), settings.currency), "Venta menos labor budget y extras"]
              ]
          : [
              ["Projects", String(filteredRows.length), "Estimate o invoice por proyecto"],
              ["Open Balance", money(totalBalance, settings.currency), "Saldo pendiente de toda la cartera"],
              ["Change Orders", String(totalChangeOrders), `${approvedChangeOrders} incluidos en invoice`],
              ["Follow-up", String(overdueLikeCount), "Rows que conviene trabajar hoy"]
            ];
        $("hubKpis").innerHTML = kpis.map(([label, value, meta]) => `
          <div class="kpi-box">
            <div class="label">${escapeHtml(label)}</div>
            <div class="value">${escapeHtml(value)}</div>
            <div class="meta">${escapeHtml(meta)}</div>
          </div>
        `).join("");
      }

      const topBalance = filteredRows.slice().sort((a, b) => b.balance - a.balance)[0];
      if ($("hubActionNote")) {
        $("hubActionNote").textContent = topBalance
          ? (activeTab === "collections"
            ? `Cobranza prioritaria: ${topBalance.title} con saldo ${money(topBalance.balance, settings.currency)}. Usa Request Payment y Log Follow-up.`
            : activeTab === "pipeline"
              ? `Pipeline activo: mueve drafts a sent, trabaja parciales y baja overdue antes de crecer cartera nueva.`
            : activeTab === "closeout"
              ? `Closeout destacado: ${topBalance.title}. Vendido ${money(topBalance.soldAmount, settings.currency)} vs cobrado ${money(topBalance.cashCollected, settings.currency)}.`
              : activePreset === "promises"
                ? `Promesa rota prioritaria: ${topBalance.title}. Conviene llamar, confirmar pago y decidir si escalas hoy.`
                : activePreset === "ready"
                  ? `Ready to bill: ${topBalance.title}. Ya trae monto para convertirse y empujar a invoice.`
                  : `Mayor oportunidad actual: ${topBalance.title} con saldo ${money(topBalance.balance, settings.currency)} y estado ${topBalance.status}.`)
          : "Firma proyectos en Vendedor, conviertelos en invoice y luego sigue pagos aqui.";
      }

      renderHubFocusQueueList(filteredRows, settings, openHubDrawer);
      if ($("hubClientScorecard")) {
        const clientScores = buildClientCollectionsScore(filteredRows, settings);
        $("hubClientScorecard").innerHTML = clientScores.length
          ? clientScores.map((item, index) => `
              <li data-hub-customer="${escapeHtml(item.customer)}">
                <span class="msg-idx">${index + 1}</span>
                <div>
                  <strong>${escapeHtml(item.customer)}</strong>
                  <span class="hub-inline-meta">Score ${escapeHtml(String(item.score))} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· Open ${escapeHtml(item.openBalanceLabel)} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· Overdue ${escapeHtml(item.overdueBalanceLabel)}</span>
                  <span class="hub-inline-meta">${escapeHtml(String(item.projectCount))} projects ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${escapeHtml(String(item.brokenPromises))} broken promises ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· Paid ${escapeHtml(item.paidTotalLabel)}</span>
                </div>
              </li>
            `).join("")
          : `<li><span class="msg-idx">0</span><div><strong>No client pressure</strong><span class="hub-inline-meta">No hay clientes con saldo o riesgo en este filtro.</span></div></li>`;
        $("hubClientScorecard").querySelectorAll("li[data-hub-customer]").forEach((item) => {
          item.onclick = () => openHubClientDetail(item.dataset.hubCustomer || "", filteredRows, settings);
        });
      }
      if ($("hubPlaybookBoard")) {
        $("hubPlaybookBoard").innerHTML = buildCollectionsPlaybook(filteredRows, settings).map(([title, big, small, preset, tab]) => `
          <div class="strip-card" data-hub-playbook="${escapeHtml(title)}" data-hub-playbook-preset="${escapeHtml(preset || "")}" data-hub-playbook-tab="${escapeHtml(tab || "all")}">
            <div class="title">${escapeHtml(title)}</div>
            <div class="big">${escapeHtml(big)}</div>
            <div class="small">${escapeHtml(small)}</div>
          </div>
        `).join("");
        $("hubPlaybookBoard").querySelectorAll("[data-hub-playbook]").forEach((item) => {
          item.onclick = () => {
            activePreset = item.dataset.hubPlaybookPreset || "";
            activeTab = item.dataset.hubPlaybookTab || "all";
            if ($("hubTabFilter")) {
              $("hubTabFilter").querySelectorAll("button[data-hub-tab]").forEach((node) => {
                node.classList.toggle("active", (node.dataset.hubTab || "all") === activeTab);
              });
            }
            if ($("hubQuickViews")) {
              $("hubQuickViews").querySelectorAll("button[data-hub-preset]").forEach((node) => {
                node.classList.toggle("active", (node.dataset.hubPreset || "") === activePreset);
              });
            }
            refresh();
          };
        });
      }

      const campaignSegments = buildCampaignSegments(filteredRows, settings);

      renderHubTableSection({
        filteredRows,
        selectedProjectIds,
        settings,
        activeTab,
        refreshBulkBar,
        onOpenRow: openHubDrawer,
        onConvert: (row) => {
          if (!guardHubAction(row, "canConvert", "Este proyecto ya tiene invoice o aun no tiene monto listo para convertir.")) return;
          convertEstimateToInvoice(row.projectId);
          refresh();
          setHubFeedback(`Invoice creado para ${row.title}.`, "ok");
        },
        onSent: (row) => {
          if (!guardHubAction(row, "canMarkSent", "Primero crea el invoice antes de marcarlo como enviado.")) return;
          markHubInvoiceSent(row.projectId);
          refresh();
          setHubFeedback(`Invoice marcado como sent para ${row.title}.`, "ok");
        },
        onPay: (row, projectId) => {
          if (!guardHubAction(row, "canTakePayment", "Take Payment solo aplica cuando ya existe invoice con saldo pendiente.")) return;
          openPaymentForm(row, null, ({ amount, method, note, date }) => {
            recordHubPayment(projectId, { amount, method, note, date });
          });
          hubFormState.successMessage = `Pago registrado para ${row.title}.`;
        },
        onReminder: (row) => {
          if (!guardHubAction(row, "canRequestPayment", "Solo puedes pedir pago cuando hay invoice enviado o parcial con saldo.")) return;
          requestHubPayment(row.projectId);
          refresh();
          setHubFeedback(`Recordatorio de pago preparado para ${row.customer}.`, "ok");
        },
        onSales: (row) => {
          saveSupervisorSelectedProjectId(row.projectId);
          window.location.href = "/sales";
        },
        onOwner: (row) => {
          saveSupervisorSelectedProjectId(row.projectId);
          window.location.href = "/owner";
        },
        onPdf: (row) => {
          if (!guardHubAction(row, "canExportPdf", "El PDF del invoice requiere un invoice valido.")) return;
          void exportInvoicePdf("hub", row.project, row.report, settings, getProjectInvoiceState(row.project));
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
            subtitle: `${row.title} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${row.customer}`,
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
          setHubCollectionStage(row.projectId, "escalated");
          refresh();
          setHubFeedback(`Collections stage actualizado a escalated para ${row.title}.`, "warn");
        },
        onDropColumn: (row, targetKey) => {
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
    };

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
    setVal("hubLocationFilter", hubViewState.location || "");

    if ($("hubTabFilter")) {
      $("hubTabFilter").querySelectorAll("button[data-hub-tab]").forEach((button) => {
        button.classList.toggle("active", (button.dataset.hubTab || "all") === activeTab);
        button.onclick = () => {
          activeTab = button.dataset.hubTab || "all";
          $("hubTabFilter").querySelectorAll("button[data-hub-tab]").forEach((node) => {
            node.classList.toggle("active", node === button);
          });
          refresh();
        };
      });
    }

    if ($("hubQuickViews")) {
      $("hubQuickViews").querySelectorAll("button[data-hub-preset]").forEach((button) => {
        button.classList.toggle("active", (button.dataset.hubPreset || "") === activePreset);
        button.onclick = () => {
          activePreset = button.dataset.hubPreset || "";
          $("hubQuickViews").querySelectorAll("button[data-hub-preset]").forEach((node) => {
            node.classList.toggle("active", node === button);
          });
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

    if ($("btnHubExport")) {
      $("btnHubExport").onclick = () => exportPortfolioCsv(filteredRows, settings);
    }
    if ($("btnHubCollectionsExport")) {
      $("btnHubCollectionsExport").onclick = () => exportCollectionsCsv(filteredRows, settings);
    }
    if ($("btnHubExecutivePdf")) {
      $("btnHubExecutivePdf").onclick = () => exportHubExecutivePdf(filteredRows, settings);
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
                label: `${label} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${count} rows ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â· ${amount}`
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
    if ($("btnHubClientClose")) $("btnHubClientClose").onclick = closeHubClientDetail;
    if ($("btnHubFormClose")) $("btnHubFormClose").onclick = closeHubFormModal;
    if ($("btnHubFormCancel")) $("btnHubFormCancel").onclick = closeHubFormModal;
    if ($("btnHubFormSubmit")) {
      $("btnHubFormSubmit").onclick = () => {
        if (!hubFormState?.onSubmit) {
          closeHubFormModal();
          return;
        }
        const successMessage = hubFormState.successMessage || "Cambios guardados.";
        const result = hubFormState.onSubmit();
        if (result === false) return;
        closeHubFormModal();
        refresh();
        refreshSelectedRow();
        setHubFeedback(successMessage, "ok");
      };
    }
    if ($("btnHubDrawerCustomer")) {
      $("btnHubDrawerCustomer").onclick = () => {
        if (!selectedRow) return;
        openCustomerSetupForm(selectedRow);
        hubFormState.successMessage = `Cliente actualizado para ${selectedRow.title}.`;
      };
    }
    if ($("btnHubDrawerDuplicate")) {
      $("btnHubDrawerDuplicate").onclick = () => {
        if (!selectedRow) return;
        const duplicate = duplicateHubProject(selectedRow.projectId);
        refresh();
        if (duplicate) {
          const nextRow = buildPortfolioRows(settings).find((row) => row.projectId === duplicate.id);
          if (nextRow) openHubDrawer(nextRow);
          setHubFeedback(`Estimate duplicado como ${duplicate.projectName}.`, "ok");
        } else {
          setHubFeedback("No fue posible duplicar el estimate.", "err");
        }
      };
    }
    if ($("btnHubDrawerDuplicateInvoice")) {
      $("btnHubDrawerDuplicateInvoice").onclick = () => {
        if (!selectedRow) return;
        if (!guardHubAction(selectedRow, "canExportPdf", "Necesitas un invoice real antes de duplicarlo.")) return;
        const duplicate = duplicateHubInvoiceProject(selectedRow.projectId);
        refresh();
        if (duplicate) {
          const nextRow = buildPortfolioRows(settings).find((row) => row.projectId === duplicate.id);
          if (nextRow) openHubDrawer(nextRow);
          setHubFeedback(`Invoice duplicado como ${duplicate.projectName}.`, "ok");
        } else {
          setHubFeedback("No fue posible duplicar el invoice.", "err");
        }
      };
    }
    if ($("btnHubDrawerSetup")) {
      $("btnHubDrawerSetup").onclick = () => {
        if (!selectedRow) return;
        openInvoiceSetupForm(selectedRow);
        hubFormState.successMessage = `Invoice setup actualizado para ${selectedRow.title}.`;
      };
    }
    if ($("btnHubDrawerConvert")) {
      $("btnHubDrawerConvert").onclick = () => {
        if (!selectedRow) return;
        if (!guardHubAction(selectedRow, "canConvert", "Este proyecto ya tiene invoice o aun no tiene un monto listo para convertir.")) return;
        convertEstimateToInvoice(selectedRow.projectId);
        refresh();
        refreshSelectedRow();
        setHubFeedback(`Invoice creado para ${selectedRow.title}.`, "ok");
      };
    }
    if ($("btnHubDrawerSent")) {
      $("btnHubDrawerSent").onclick = () => {
        if (!selectedRow) return;
        if (!guardHubAction(selectedRow, "canMarkSent", "Primero crea el invoice antes de marcarlo como enviado.")) return;
        markHubInvoiceSent(selectedRow.projectId);
        refresh();
        refreshSelectedRow();
        setHubFeedback(`Invoice marcado como sent para ${selectedRow.title}.`, "ok");
      };
    }
    if ($("btnHubDrawerSendInvoice")) {
      $("btnHubDrawerSendInvoice").onclick = () => {
        if (!selectedRow) return;
        if (!guardHubAction(selectedRow, "canSendInvoice", "Necesitas invoice, cliente y monto antes de enviar.")) return;
        sendHubInvoice(selectedRow.projectId);
        refresh();
        refreshSelectedRow();
        setHubFeedback(`Correo de invoice preparado para ${selectedRow.customer}.`, "ok");
      };
    }
    if ($("btnHubDrawerRequestPayment")) {
      $("btnHubDrawerRequestPayment").onclick = () => {
        if (!selectedRow) return;
        if (!guardHubAction(selectedRow, "canRequestPayment", "Solo puedes pedir pago cuando hay invoice enviado o parcial con saldo.")) return;
        requestHubPayment(selectedRow.projectId);
        refresh();
        refreshSelectedRow();
        setHubFeedback(`Recordatorio de pago preparado para ${selectedRow.customer}.`, "ok");
      };
    }
    if ($("btnHubDrawerFollowUp")) {
      $("btnHubDrawerFollowUp").onclick = () => {
        if (!selectedRow) return;
        openFollowUpForm(selectedRow);
        hubFormState.successMessage = `Follow-up guardado para ${selectedRow.title}.`;
      };
    }
    if ($("btnHubDrawerPayment")) {
      $("btnHubDrawerPayment").onclick = () => {
        if (!selectedRow) return;
        if (!guardHubAction(selectedRow, "canTakePayment", "Take Payment solo aplica cuando ya existe invoice con saldo pendiente.")) return;
        openPaymentForm(selectedRow, null, ({ amount, method, note, date }) => {
          recordHubPayment(selectedRow.projectId, { amount, method, note, date });
        });
        hubFormState.successMessage = `Pago registrado para ${selectedRow.title}.`;
      };
    }
    if ($("btnHubDrawerPaid")) {
      $("btnHubDrawerPaid").onclick = () => {
        if (!selectedRow) return;
        if (!guardHubAction(selectedRow, "canMarkPaid", "Mark Paid solo aplica cuando existe invoice con saldo pendiente.")) return;
        markHubInvoicePaid(selectedRow.projectId);
        refresh();
        refreshSelectedRow();
        setHubFeedback(`Invoice liquidado para ${selectedRow.title}.`, "ok");
      };
    }
    if ($("btnHubDrawerSales")) {
      $("btnHubDrawerSales").onclick = () => {
        if (!selectedRow) return;
        saveSupervisorSelectedProjectId(selectedRow.projectId);
        window.location.href = "/sales";
      };
    }
    if ($("btnHubDrawerOwner")) {
      $("btnHubDrawerOwner").onclick = () => {
        if (!selectedRow) return;
        saveSupervisorSelectedProjectId(selectedRow.projectId);
        window.location.href = "/owner";
      };
    }
    if ($("btnHubDrawerPdf")) {
      $("btnHubDrawerPdf").onclick = () => {
        if (!selectedRow) return;
        void exportInvoicePdf("hub", selectedRow.project, selectedRow.report, settings, getProjectInvoiceState(selectedRow.project));
      };
    }
    if ($("btnHubDrawerStatement")) {
      $("btnHubDrawerStatement").onclick = () => {
        if (!selectedRow) return;
        exportCustomerStatementPdf(selectedRow, settings);
      };
    }
    if ($("btnHubDrawerCloseout")) {
      $("btnHubDrawerCloseout").onclick = () => {
        if (!selectedRow) return;
        exportCloseoutPdf(selectedRow, settings);
      };
    }
    if ($("btnHubDrawerPublish")) {
      $("btnHubDrawerPublish").onclick = async () => {
        if (!selectedRow) return;
        if (!guardHubAction(selectedRow, "canPublishLink", "Publish Link requiere invoice, cliente y monto valido.")) return;
        try {
          const publicUrl = await publishHubPublicInvoice(selectedRow.projectId);
          refresh();
          refreshSelectedRow();
          setHubFeedback(`Public invoice link listo: ${publicUrl}`, "ok");
        } catch (err) {
          setHubFeedback(err.message || "Unable to publish public invoice.", "err");
        }
      };
    }
    if ($("btnHubDrawerPaymentLink")) {
      $("btnHubDrawerPaymentLink").onclick = () => {
        if (!selectedRow) return;
        if (!guardHubAction(selectedRow, "canSetPaymentLink", "Primero crea el invoice para guardar un payment link.")) return;
        openPaymentLinkForm(selectedRow);
        hubFormState.successMessage = `Payment link actualizado para ${selectedRow.title}.`;
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

    refresh();
  }

  function renderSalesAdmin() {
    if (!$("adminQueueBody")) return;
    const settings = loadSettings();
    const rows = loadApprovals();

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
        const tone = row.offeredPrice >= row.recommended ? "green" : (row.offeredPrice >= row.minimum ? "amber" : "red");
        const discount = row.recommended > 0 ? (((row.recommended - row.offeredPrice) / row.recommended) * 100) : 0;
        return `
          <tr>
            <td>${escapeHtml(row.id)}</td>
            <td>${escapeHtml(row.projectName)}</td>
            <td>${money(row.offeredPrice, settings.currency)}</td>
            <td>${discount.toFixed(2)}%</td>
            <td><span class="badge ${tone}">${tone}</span></td>
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
          rows[index].status = "approved";
          activateApprovedProject(rows[index]);
          saveApprovals(rows);
          refresh();
        };
      });
      $("adminQueueBody").querySelectorAll("button[data-admin-reject]").forEach((button) => {
        button.onclick = () => { rows[Number(button.dataset.adminReject || -1)].status = "rejected"; saveApprovals(rows); refresh(); };
      });
    };

    refresh();
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
  });
})();

































