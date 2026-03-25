
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

  const DEFAULTS = {
    bizName: "Three Colors Corp",
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
    location: "",
    dueDate: "",
    overheadMonthly: 0,
    stdHours: 0,
    reservePct: 5,
    workers: [
      { name: "Installer 1", type: "installer", hours: 40, rate: "" },
      { name: "Helper 1", type: "helper", hours: 10, rate: "" }
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
    projectName: "",
    clientName: "",
    dueDate: "",
    offeredPrice: 0,
    notes: "",
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
  }

  function removeStore(key) {
    localStorage.removeItem(key);
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
  function loadOwner() {
    const saved = readStore(LS_OWNER, {});
    return {
      ...DEFAULT_OWNER,
      ...saved,
      reservePct: DEFAULTS.reservePct,
      workers: Array.isArray(saved.workers) && saved.workers.length ? saved.workers : DEFAULT_OWNER.workers
    };
  }
  function saveOwner(state, metrics) { writeStore(LS_OWNER, { ...state, reservePct: DEFAULTS.reservePct, metrics }); }
  function loadDashboard() { return { ...DEFAULT_DASHBOARD, ...readStore(LS_DASHBOARD, {}) }; }
  function saveDashboard(state) { writeStore(LS_DASHBOARD, state); }
  function loadSales() {
    const saved = readStore(LS_SALES, {});
    const owner = loadOwner();
    return {
      ...DEFAULT_SALES,
      ...saved,
      projectName: saved.projectName || owner.projectName || "",
      clientName: saved.clientName || owner.clientName || "",
      workers: Array.isArray(saved.workers) && saved.workers.length ? saved.workers : DEFAULT_SALES.workers,
      offeredPrice: saved.offeredPrice ?? 0
    };
  }
  function saveSales(state) { writeStore(LS_SALES, state); }
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
    if (projectId) localStorage.setItem(LS_SUPERVISOR_SELECTED, projectId);
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
      baseAmount: finiteNumber(project?.salePrice, 0),
      depositApplied: 0,
      receivedApplied: 0,
      status: "draft"
    };
  }

  function getProjectInvoiceState(project) {
    const base = buildDefaultInvoiceState(project);
    const saved = project?.invoice && typeof project.invoice === "object" ? project.invoice : {};
    return {
      ...base,
      ...saved,
      baseAmount: finiteNumber(saved.baseAmount, base.baseAmount),
      depositApplied: finiteNumber(saved.depositApplied, 0),
      receivedApplied: finiteNumber(saved.receivedApplied, 0),
      status: normalizeInvoiceStatus(saved.status)
    };
  }

  function saveProjectInvoiceState(projectId, invoice) {
    return updateProjectById(projectId, (project) => ({
      ...project,
      invoice: {
        ...buildDefaultInvoiceState(project),
        ...(invoice || {}),
        status: normalizeInvoiceStatus(invoice?.status)
      }
    }));
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
      `Project: ${project.projectName || "-"}`,
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
    a.download = `change-order-${(project.projectName || "project").replace(/\s+/g, "-")}-${(changeOrder.title || "extra").replace(/\s+/g, "-")}.pdf`;
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

  function exportInvoicePdf(kind, project, report, settings, input) {
    const jsPDF = window.jspdf?.jsPDF;
    if (!jsPDF) return alert("jsPDF is not available.");
    if (!project) return alert("Select a project first.");

    const metrics = calcInvoice(project, report, input);
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    let y = 46;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(settings.bizName || DEFAULTS.bizName, 40, y);
    y += 22;
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
    const dueDate = normalizeDateInput(state.dueDate);
    return {
      id: `PRJ-${Date.now()}`,
      status: "active",
      source: "sales",
      signedAt: new Date().toISOString(),
      projectName: state.projectName || "Project",
      clientName: state.clientName || "",
      dueDate,
      estimatedDays: Number(metrics.totalWorkerDays || 0),
      laborBudget: Number(metrics.labor || 0),
      salePrice: Number(state.offeredPrice || 0),
      recommendedPrice: Number(metrics.recommended || 0),
      minimumPrice: Number(metrics.minimum || 0),
      hoursPerDay: Number(settings.hoursPerDay || DEFAULTS.hoursPerDay),
      workers: Array.isArray(state.workers) ? state.workers.map((worker) => ({
        name: worker.name || "",
        type: worker.type || "installer",
        days: Number(worker.days || 0),
        rate: worker.rate === "" || worker.rate == null ? "" : Number(worker.rate || 0)
      })) : [],
      notes: state.notes || ""
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
    };

    ["expensesBalance", "profitBalance", "savingsBalance", "taxBalance", "operatingMonthly"].forEach((id) => {
      const el = $(id);
      if (el) el.oninput = refresh;
    });

    if ($("btnSaveDashboard")) $("btnSaveDashboard").onclick = () => { refresh(); alert("Owner finance monitor saved."); };
    if ($("btnResetDashboard")) $("btnResetDashboard").onclick = () => { saveDashboard({ ...DEFAULT_DASHBOARD }); renderDashboard(); };
    refresh();
  }

  function renderBusinessSettings() {
    if (!$("btnSaveBusinessSettings")) return;

    const settings = loadSettings();
    setVal("bizNameOwner", settings.bizName);
    setNum("baseInstaller", settings.baseInstaller);
    setNum("baseHelper", settings.baseHelper);
    setVal("pricingMode", settings.pricingMode);
    setNum("hoursPerDay", settings.hoursPerDay);
    setNum("overheadMonthly", settings.overheadMonthly);
    setNum("stdHours", settings.stdHours);
    setNum("salesCommissionPct", settings.salesCommissionPct);
    setNum("supervisorBonusPct", settings.supervisorBonusPct);
    setNum("profitPct", settings.profitPct);
    setNum("reservePct", DEFAULTS.reservePct);
    count("bizNameOwner", "bizNameOwnerCount");

    const status = $("businessSettingsStatus");

    if ($("bizNameOwner")) {
      $("bizNameOwner").oninput = () => count("bizNameOwner", "bizNameOwnerCount");
    }

    $("btnSaveBusinessSettings").onclick = () => {
      const settingsCopy = loadSettings();
      settingsCopy.bizName = val("bizNameOwner") || DEFAULTS.bizName;
      settingsCopy.baseInstaller = num("baseInstaller", DEFAULTS.baseInstaller);
      settingsCopy.baseHelper = num("baseHelper", DEFAULTS.baseHelper);
      settingsCopy.pricingMode = val("pricingMode") || DEFAULTS.pricingMode;
      settingsCopy.hoursPerDay = Math.max(num("hoursPerDay", DEFAULTS.hoursPerDay), 0.25);
      settingsCopy.overheadMonthly = num("overheadMonthly", 0);
      settingsCopy.stdHours = num("stdHours", DEFAULTS.stdHours);
      settingsCopy.salesCommissionPct = num("salesCommissionPct", DEFAULTS.salesCommissionPct);
      settingsCopy.supervisorBonusPct = num("supervisorBonusPct", DEFAULTS.supervisorBonusPct);
      settingsCopy.profitPct = num("profitPct", DEFAULTS.profitPct);
      saveSettings(settingsCopy);
      if (status) {
        status.style.display = "block";
        status.className = "notice ok";
        status.textContent = "Business settings guardados.";
      }
    };
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
            <option value="installer" ${worker.type === "installer" ? "selected" : ""}>Installer</option>
            <option value="helper" ${worker.type === "helper" ? "selected" : ""}>Helper</option>
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

    setVal("projectName", state.projectName);
    setVal("clientName", state.clientName);
    setVal("location", state.location);
    setVal("bizNameOwner", settings.bizName);
    count("projectName", "projectNameCount");
    count("clientName", "clientNameCount");
    count("location", "locationCount");
    count("bizNameOwner", "bizNameOwnerCount");

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
          <div class="owner-quote-meta">${escapeHtml(money(metrics.pricePerUnit, settings.currency))} ${escapeHtml(pricingModeCopy)} � ${escapeHtml(metrics.quotedUnits.toFixed(2))} ${escapeHtml(metrics.pricingModeLabel === "dia" ? "dias" : "horas")} cotizables</div>
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

    saveOwner(state, metrics);

    [["projectName", "projectNameCount"], ["clientName", "clientNameCount"], ["location", "locationCount"], ["bizNameOwner", "bizNameOwnerCount"]].forEach(([id, counter]) => {
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

    if ($("btnAddWorker")) $("btnAddWorker").onclick = () => {
      state.workers.push({ name: `Worker ${state.workers.length + 1}`, type: "installer", hours: 0, rate: "" });
      saveOwner(state, calcOwner(state, settings));
      renderOwner();
    };
    if ($("btnClear")) $("btnClear").onclick = () => { if (!confirm("Clear this quote?")) return; writeStore(LS_OWNER, DEFAULT_OWNER); renderOwner(); };
    if ($("btnExportPdf")) $("btnExportPdf").onclick = () => exportOwnerPdf(state, settings, metrics);
    if ($("btnSendQuote")) $("btnSendQuote").onclick = () => openSendModal(state, settings, metrics);
    if ($("btnSendClose")) $("btnSendClose").onclick = closeSendModal;
    if ($("btnSendCancel")) $("btnSendCancel").onclick = closeSendModal;
    if ($("btnSendNow")) $("btnSendNow").onclick = () => sendQuote(state, settings, metrics);
    ["toEmail", "toName", "subject", "scope", "message", "salesInitials"].forEach((id) => { if ($(id)) $(id).oninput = updateSendCounts; });

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
        exportInvoicePdf("owner", ownerProject, ownerReport, settings, {
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

    const doc = new jsPDF({ unit: "pt", format: "letter" });
    let y = 48;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(18);
    doc.text(settings.bizName || DEFAULTS.bizName, 40, y);
    y += 22;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(12);
    doc.text("Project Pricing Report", 40, y);
    y += 24;
    [`Project: ${state.projectName || "-"}`, `Client: ${state.clientName || "-"}`, `Location: ${state.location || "-"}`, `Recommended: ${money(metrics.recommended, settings.currency)}`].forEach((line) => { doc.text(line, 40, y); y += 16; });
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.text("Financial Breakdown", 40, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    buildOwnerKpis(state, settings, metrics).forEach(([label, value]) => { doc.text(`${label}: ${value}`, 40, y); y += 15; });
    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `margin-guard-${(state.projectName || "project").replace(/\s+/g, "-")}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openSendModal(state, settings, metrics) {
    const modal = $("sendModal");
    if (!modal) return;
    modal.setAttribute("aria-hidden", "false");
    if ($("subject") && !$("subject").value) $("subject").value = `Project Quote - ${state.projectName || "Project"} - ${money(metrics.recommended, settings.currency)}`;
    if ($("deposit")) { $("deposit").value = "1000.00"; $("deposit").setAttribute("readonly", "readonly"); }
    if ($("message") && !$("message").value) {
      $("message").value =
`Hello${state.clientName ? ` ${state.clientName}` : ""},

Thank you for the opportunity to quote your project.

Recommended project total: ${money(metrics.recommended, settings.currency)}
Required deposit to start: ${money(1000, settings.currency)}

We can confirm schedule and next steps once deposit is received.

Regards,
${val("salesInitials") || "MG"}`;
    }
    updateSendCounts();
  }

  function closeSendModal() {
    if ($("sendModal")) $("sendModal").setAttribute("aria-hidden", "true");
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

  async function sendQuote(state, settings, metrics) {
    const status = $("sendStatus");
    const setStatus = (message, tone) => {
      if (!status) return;
      status.style.display = "block";
      status.className = `notice ${tone || ""}`.trim();
      status.textContent = message;
    };

    const toEmail = val("toEmail").trim();
    const initials = val("salesInitials").trim();
    if (!toEmail) return setStatus("Customer email is required.", "err");
    if (!initials) return setStatus("Sales initials are required.", "err");

    setStatus("Sending quote...", "");
    try {
      const response = await fetch("/.netlify/functions/send-quote-zapier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          salesRepInitials: initials,
          messageLanguage: "bilingual",
          toEmail,
          toName: val("toName").trim(),
          subject: val("subject").trim() || "Project Quote",
          messageText: val("message").trim(),
          scopeOfWork: val("scope").trim(),
          depositRequired: 1000,
          projectName: state.projectName || "",
          clientName: state.clientName || "",
          location: state.location || "",
          businessName: settings.bizName || DEFAULTS.bizName,
          currency: settings.currency || "$",
          recommendedTotal: metrics.recommended
        })
      });
      if (!response.ok) throw new Error("Unable to send quote.");
      setStatus("Quote sent successfully.", "ok");
      setTimeout(closeSendModal, 900);
    } catch (_err) {
      setStatus("Quote delivery failed. Check Functions and Zapier env vars.", "err");
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

  function renderSalesWorkers(state, settings, metrics) {
    const body = $("salesWorkersBody");
    if (!body) return;

    body.innerHTML = state.workers.map((worker, index) => `
      <tr data-index="${index}">
        <td><input data-key="name" maxlength="40" value="${escapeHtml(worker.name || "")}" /></td>
        <td>
          <select data-key="type">
            <option value="installer" ${worker.type === "installer" ? "selected" : ""}>Installer</option>
            <option value="helper" ${worker.type === "helper" ? "selected" : ""}>Helper</option>
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
    if (!$("salesKpis")) return;

    const settings = loadSettings();
    const state = loadSales();
    const activeProject = loadActiveProject();
    const salesProjectPicker = $("salesProjectPicker");
    const stageRange = $("salesStageRange");
    const metrics = calcSales(state, settings);
    const salesProjects = loadProjects();
    const selectedProjectId = loadSupervisorSelectedProjectId();
    const selectedProject = salesProjects.find((project) => project.id === selectedProjectId) || salesProjects[0] || null;

    if (salesProjectPicker) {
      salesProjectPicker.innerHTML = salesProjects.length
        ? salesProjects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.projectName || "Project")} - ${escapeHtml(project.clientName || "Sin cliente")}</option>`).join("")
        : `<option value="">Sin proyectos firmados</option>`;
      salesProjectPicker.value = selectedProject?.id || "";
      salesProjectPicker.onchange = () => {
        saveSupervisorSelectedProjectId(salesProjectPicker.value);
        renderSales();
      };
    }

    setVal("salesProjectName", state.projectName);
    setVal("salesClientName", state.clientName);
    setVal("salesDueDate", state.dueDate);
    setNum("salesPrice", state.offeredPrice);
    setVal("salesNotes", state.notes);
    count("salesProjectName", "salesProjectNameCount");
    count("salesClientName", "salesClientNameCount");
    count("salesNotes", "salesNotesCount");

    renderSalesWorkers(state, settings, metrics);

    const refresh = () => {
      state.projectName = val("salesProjectName");
      state.clientName = val("salesClientName");
      state.dueDate = normalizeDateInput(val("salesDueDate"));
      const nextMetrics = calcSales(state, settings);
      const recommended = nextMetrics.recommended;
      const minimum = nextMetrics.minimum;
      const negotiation = nextMetrics.negotiation;
      const priceInput = $("salesPrice");
      const priceTouched = priceInput?.dataset.touched === "true";

      if (priceInput && (!priceTouched || Number(priceInput.value || 0) === 0)) {
        const stageValue = Number(stageRange?.value || 2);
        const stagePrice = stageValue === 2 ? recommended : (stageValue === 1 ? negotiation : minimum);
        setNum("salesPrice", stagePrice);
      }

      state.offeredPrice = num("salesPrice", 0);
      state.notes = val("salesNotes");
      saveSales(state);

      const offered = state.offeredPrice;
      const discountPct = recommended > 0 ? clamp(((recommended - offered) / recommended) * 100, 0, 100) : 0;
      let tone = "red";
      let commissionPct = 0;
      let confidence = 10;
      let message = "El precio esta por debajo del piso permitido. Requiere aprobacion obligatoria.";
      let heroState = "Rojo";
      let heroMeta = "No se puede cerrar asi. Hay que subir precio o pedir aprobacion.";
      let action = "Pedir aprobacion";
      let actionMeta = "Este precio no se debe vender sin autorizacion.";

      if (!state.workers.length) {
        message = "Agrega al menos un trabajador para calcular la cotizacion.";
        heroState = "Base";
        heroMeta = "Define mano de obra por trabajador, con dias individuales.";
        action = "Agregar trabajador";
        actionMeta = "Sin mano de obra no se puede calcular el precio.";
        tone = "amber";
        confidence = 0;
      } else if (recommended <= 0) {
        message = nextMetrics.totalHours > 0
          ? "Todavia no hay suficiente informacion para calcular el precio recomendado."
          : "Ingresa dias por trabajador para calcular el objetivo recomendado.";
        heroState = "Base";
        heroMeta = nextMetrics.totalHours > 0
          ? "Revisa los dias o costos base de los trabajadores."
          : "Esperando mano de obra para calcular.";
        action = "Completar datos";
        actionMeta = "Primero captura dias por trabajador.";
        tone = "amber";
        confidence = 0;
      } else if (offered <= 0) {
        tone = "amber";
        confidence = 0;
        message = "Ya existe un recomendado. Ahora captura el precio que le vas a presentar al cliente.";
        heroState = "Listo";
        heroMeta = "El recomendado ya fue calculado con las unidades capturadas.";
        action = "Proponer precio";
        actionMeta = "Ingresa el numero que vas a presentar.";
      } else if (offered >= recommended) {
        tone = "green";
        commissionPct = settings.salesCommissionPct;
        confidence = 100;
        message = "Precio sano. Se puede vender con confianza.";
        heroState = "Verde";
        heroMeta = "El precio protege margen, operacion y comision.";
        action = "Cerrar venta";
        actionMeta = "No necesita aprobacion. Puedes avanzar.";
      } else if (offered >= minimum) {
        tone = "amber";
        const factor = clamp((offered - minimum) / Math.max(1, recommended - minimum), 0, 1);
        commissionPct = settings.salesCommissionPct * (0.45 + factor * 0.55);
        confidence = 45 + factor * 55;
        message = "Precio negociable, pero cada descuento reduce tu comision.";
        heroState = "Amarillo";
        heroMeta = "Se puede trabajar, pero conviene defender el precio.";
        action = "Negociar";
        actionMeta = "Intenta acercarte al recomendado antes de cerrar.";
      }

      if ($("salesTraffic")) {
        $("salesTraffic").className = `badge ${tone}`;
        $("salesTraffic").textContent = tone === "green" ? "Aprobado" : (tone === "amber" ? "Negociar con cuidado" : "Bloqueado");
      }
      if ($("salesRule")) $("salesRule").textContent = message;
      if ($("approvalHint")) $("approvalHint").textContent = tone === "red" ? "Precio rojo: aprobacion obligatoria del dueno o Sales Admin." : (tone === "amber" ? "Precio amarillo: se puede vender, pero conviene defender margen." : "Precio verde: no necesita aprobacion.");
      if ($("salesProgress")) $("salesProgress").value = confidence;
      if ($("salesHeroState")) $("salesHeroState").textContent = heroState;
      if ($("salesHeroMeta")) $("salesHeroMeta").textContent = heroMeta;
      if ($("salesPrimaryPrice")) $("salesPrimaryPrice").textContent = money(recommended, settings.currency);
      if ($("salesPrimaryMeta")) {
        $("salesPrimaryMeta").textContent = state.workers.length && nextMetrics.totalHours > 0
          ? `${nextMetrics.totalWorkerDays.toFixed(2)} worker-days � ${nextMetrics.totalHours.toFixed(2)} horas-hombre � ${state.workers.length} trabajadores`
          : "Ingresa mano de obra para calcular el recomendado.";
      }
      if ($("salesPrimaryCommission")) $("salesPrimaryCommission").textContent = `${commissionPct.toFixed(2)}%`;
      if ($("salesPrimaryCommissionMeta")) $("salesPrimaryCommissionMeta").textContent = `${money(offered * (commissionPct / 100), settings.currency)} estimado`;
      if ($("salesApprovalAction")) $("salesApprovalAction").textContent = action;
      if ($("salesApprovalActionMeta")) $("salesApprovalActionMeta").textContent = actionMeta;
      if ($("salesStageMin")) $("salesStageMin").textContent = `Minimo ${money(minimum, settings.currency)}`;
      if ($("salesStageNegotiation")) $("salesStageNegotiation").textContent = `Negociacion ${money(negotiation, settings.currency)}`;
      if ($("salesStageRecommended")) $("salesStageRecommended").textContent = `Recomendado ${money(recommended, settings.currency)}`;
      if ($("salesCrewHint")) {
        $("salesCrewHint").textContent = state.workers.length
          ? `${state.workers.length} trabajadores � ${nextMetrics.totalWorkerDays.toFixed(2)} worker-days � ${nextMetrics.totalHours.toFixed(2)} horas-hombre`
          : "Define mano de obra por trabajador para calcular horas-hombre y precio recomendado.";
      }

      if ($("salesSignedProject")) {
        $("salesSignedProject").textContent = activeProject?.projectName || "Sin proyecto firmado";
      }
      if ($("salesSignedMeta")) {
        if (activeProject) {
          $("salesSignedMeta").textContent = `Proyecto activo � ${activeProject.dueDate || "Sin fecha"} � ${money(activeProject.laborBudget, settings.currency)} labor � ${Number(activeProject.estimatedDays || 0).toFixed(2)} dias`;
        } else {
          $("salesSignedMeta").textContent = "Firma una cotizacion para mandarla a Supervisor.";
        }
      }
      if ($("salesSignedBadge")) {
        $("salesSignedBadge").className = `badge ${activeProject ? "green" : "amber"}`;
        $("salesSignedBadge").textContent = activeProject ? "Proyecto activo" : "Pendiente de firma";
      }

      if ($("salesProjectPortfolioCount")) {
        $("salesProjectPortfolioCount").textContent = String(salesProjects.length);
      }
      if ($("salesProjectStatus")) {
        $("salesProjectStatus").textContent = selectedProject?.status || "draft";
      }

      const commissionAmount = offered * (commissionPct / 100);
      $("salesKpis").innerHTML = [
        ["Trabajadores", `${state.workers.length}`, "Mano de obra modelada para este proyecto"],
        ["Worker-days", nextMetrics.totalWorkerDays.toFixed(2), "Suma de dias por trabajador"],
        ["Horas-hombre", nextMetrics.totalHours.toFixed(2), "Carga total de mano de obra estimada"],
        ["Piso minimo", money(minimum, settings.currency), "No vender por debajo de este numero"],
        ["Precio negociacion", money(negotiation, settings.currency), "Punto medio para negociar sin caer al piso"],
        ["Objetivo recomendado", money(recommended, settings.currency), "Numero ideal para vender con margen sano"],
        ["Precio al cliente", money(offered, settings.currency), "Numero actual de la negociacion"],
        ["Descuento aplicado", `${discountPct.toFixed(2)}%`, "Comparado contra el recomendado"],
        ["Comision estimada", `${commissionPct.toFixed(2)}% � ${money(commissionAmount, settings.currency)}`, "Pago estimado del vendedor"]
      ].map(([label, value, meta]) => `
        <div class="kpi-box">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${escapeHtml(value)}</div>
          <div class="meta">${escapeHtml(meta)}</div>
        </div>
      `).join("");

      const scripts = tone === "green"
        ? ["Este precio protege calidad, calendario y garantia.", "Si aprobamos hoy, podemos asegurar mano de obra y agenda de instalacion."]
        : tone === "amber"
          ? ["Podemos sostener ese numero si ajustamos alcance o dividimos el trabajo por fases.", "Prefiero proteger el resultado final antes que crear problemas con cambios y extras despues."]
          : ["Ese numero no esta aprobado. Hay que ajustar alcance, calendario o precio.", "Para vender abajo de esto se necesita autorizacion del dueno o Sales Admin."];

      if ($("negotiationList")) {
        $("negotiationList").innerHTML = scripts.map((line, index) => `
          <li><span class="msg-idx">${index + 1}</span>${escapeHtml(line)}</li>
        `).join("");
      }

      if (selectedProject) {
        const selectedReport = loadSupervisorReport(selectedProject);

        if ($("salesChangeOrderBody")) {
          $("salesChangeOrderBody").innerHTML = selectedReport.changeOrders?.length
            ? selectedReport.changeOrders.map((row, index) => `
                <tr>
                  <td>${escapeHtml(row.title || "Change order")}</td>
                  <td>${money(row.offeredPrice || 0, settings.currency)}</td>
                  <td>
                    <select data-co-status="${index}">
                      ${["draft", "sent", "approved", "signed"].map((statusValue) => `
                        <option value="${statusValue}" ${normalizeCommercialStatus(row.commercialStatus || (row.applied ? "approved" : "draft")) === statusValue ? "selected" : ""}>${statusValue}</option>
                      `).join("")}
                    </select>
                  </td>
                  <td>
                    <div class="row-actions">
                      <button class="btn ghost" data-co-pdf="${index}">PDF</button>
                      <button class="btn primary" data-co-send="${index}">Send</button>
                    </div>
                  </td>
                </tr>
              `).join("")
            : `<tr><td colspan="4">No change orders yet.</td></tr>`;

          $("salesChangeOrderBody").querySelectorAll("select[data-co-status]").forEach((el) => {
            el.onchange = () => {
              const report = loadSupervisorReport(selectedProject);
              const index = Number(el.dataset.coStatus || -1);
              if (index < 0 || !report.changeOrders[index]) return;
              report.changeOrders[index].commercialStatus = normalizeCommercialStatus(el.value);
              saveSupervisorReport(selectedProject.id, report);
              renderSales();
            };
          });

          $("salesChangeOrderBody").querySelectorAll("button[data-co-pdf]").forEach((button) => {
            button.onclick = () => {
              const index = Number(button.dataset.coPdf || -1);
              const row = selectedReport.changeOrders?.[index];
              if (!row) return;
              exportChangeOrderPdf(selectedProject, row, settings);
            };
          });

          $("salesChangeOrderBody").querySelectorAll("button[data-co-send]").forEach((button) => {
            button.onclick = () => {
              const index = Number(button.dataset.coSend || -1);
              const report = loadSupervisorReport(selectedProject);
              const row = report.changeOrders?.[index];
              if (!row) return;
              report.changeOrders[index] = {
                ...row,
                commercialStatus: "sent",
                sentAt: new Date().toISOString()
              };
              saveSupervisorReport(selectedProject.id, report);
              sendChangeOrder(selectedProject, report.changeOrders[index], settings);
              renderSales();
            };
          });
        }

        const salesInvoiceState = getProjectInvoiceState(selectedProject);
        if ($("salesInvoiceProject")) $("salesInvoiceProject").textContent = selectedProject.projectName || "Sin proyecto";
        if ($("salesInvoiceClient")) $("salesInvoiceClient").textContent = selectedProject.clientName || "Sin cliente";
        if ($("salesInvoiceNo")) setVal("salesInvoiceNo", salesInvoiceState.invoiceNo || "");
        if ($("salesInvoiceDate")) setVal("salesInvoiceDate", salesInvoiceState.invoiceDate || "");
        if ($("salesInvoiceBase")) setNum("salesInvoiceBase", salesInvoiceState.baseAmount);
        if ($("salesInvoiceDeposit")) setNum("salesInvoiceDeposit", salesInvoiceState.depositApplied);
        if ($("salesInvoiceReceived")) setNum("salesInvoiceReceived", salesInvoiceState.receivedApplied);
        if ($("salesInvoiceStatus")) setVal("salesInvoiceStatus", salesInvoiceState.status);

        const refreshSalesInvoice = () => {
          const baseAmount = num("salesInvoiceBase", salesInvoiceState.baseAmount);
          const depositApplied = num("salesInvoiceDeposit", 0);
          const receivedApplied = num("salesInvoiceReceived", 0);
          const invoiceMetrics = calcInvoice(selectedProject, selectedReport, {
            baseAmount,
            depositApplied,
            receivedApplied
          });
          const nextInvoiceState = {
            invoiceNo: val("salesInvoiceNo"),
            invoiceDate: val("salesInvoiceDate"),
            baseAmount,
            depositApplied,
            receivedApplied,
            status: inferInvoiceStatus(invoiceMetrics.total, depositApplied, receivedApplied, val("salesInvoiceStatus"))
          };

          saveProjectInvoiceState(selectedProject.id, nextInvoiceState);
          if ($("salesInvoiceStatus")) setVal("salesInvoiceStatus", nextInvoiceState.status);

          if ($("salesInvoiceSubtotal")) $("salesInvoiceSubtotal").textContent = money(invoiceMetrics.subtotal, settings.currency);
          if ($("salesInvoiceChangeOrders")) $("salesInvoiceChangeOrders").textContent = money(invoiceMetrics.changeOrderAmount, settings.currency);
          if ($("salesInvoiceTotal")) $("salesInvoiceTotal").textContent = money(invoiceMetrics.total, settings.currency);
          if ($("salesInvoiceBalance")) $("salesInvoiceBalance").textContent = money(invoiceMetrics.balance, settings.currency);
        };

        ["salesInvoiceNo", "salesInvoiceDate", "salesInvoiceBase", "salesInvoiceDeposit", "salesInvoiceReceived", "salesInvoiceStatus"].forEach((id) => {
          const el = $(id);
          if (!el) return;
          el.oninput = refreshSalesInvoice;
          if (el.tagName === "SELECT") el.onchange = refreshSalesInvoice;
        });

        if ($("btnSalesInvoicePdf")) {
          $("btnSalesInvoicePdf").onclick = () => {
            exportInvoicePdf("sales", selectedProject, selectedReport, settings, {
              invoiceNo: val("salesInvoiceNo"),
              invoiceDate: val("salesInvoiceDate"),
              baseAmount: num("salesInvoiceBase", selectedProject.salePrice || 0),
              depositApplied: num("salesInvoiceDeposit", 0),
              receivedApplied: num("salesInvoiceReceived", 0)
            });
          };
        }

        if ($("btnSalesProjectComplete")) {
          $("btnSalesProjectComplete").onclick = () => {
            updateProjectById(selectedProject.id, { status: "completed", completedAt: new Date().toISOString() });
            renderSales();
          };
        }

        refreshSalesInvoice();
      } else {
        if ($("salesChangeOrderBody")) $("salesChangeOrderBody").innerHTML = `<tr><td colspan="3">No projects signed yet.</td></tr>`;
      }
    };

    if ($("salesModeHint")) $("salesModeHint").textContent = `Cada trabajador usa ${metrics.hoursPerDay.toFixed(2)} horas por dia. Si el costo base queda vacio, usa Business Settings segun el tipo.`;
    if ($("salesEntryHint")) $("salesEntryHint").textContent = "Captura los dias de cada trabajador por individual. El sistema calcula horas-hombre, recomendado, negociacion y minimo.";

    ["salesProjectName", "salesClientName", "salesDueDate", "salesPrice", "salesNotes"].forEach((id) => {
      const el = $(id);
      if (el) {
        el.oninput = () => {
          if (id === "salesPrice") el.dataset.touched = "true";
          if (id === "salesProjectName") count("salesProjectName", "salesProjectNameCount");
          if (id === "salesClientName") count("salesClientName", "salesClientNameCount");
          if (id === "salesNotes") count("salesNotes", "salesNotesCount");
          refresh();
        };
      }
    });

    if (stageRange) {
      stageRange.oninput = () => {
        const nextMetrics = calcSales(state, settings);
        const minimum = nextMetrics.minimum;
        const recommended = nextMetrics.recommended;
        const negotiation = nextMetrics.negotiation;
        const stageValue = Number(stageRange.value || 2);
        const stagePrice = stageValue === 2 ? recommended : (stageValue === 1 ? negotiation : minimum);
        if ($("salesPrice")) {
          $("salesPrice").dataset.touched = "false";
          setNum("salesPrice", stagePrice);
        }
        refresh();
      };
    }

    if ($("btnSubmitApproval")) {
      $("btnSubmitApproval").onclick = () => {
        const nextMetrics = calcSales(state, settings);
        const rows = loadApprovals();
        rows.unshift({
          id: `APR-${Date.now()}`,
          createdAt: new Date().toISOString(),
          projectName: state.projectName || "Project",
          clientName: state.clientName || "",
          dueDate: normalizeDateInput(state.dueDate),
          offeredPrice: state.offeredPrice,
          recommended: nextMetrics.recommended,
          minimum: nextMetrics.minimum,
          estimatedDays: nextMetrics.totalWorkerDays,
          laborBudget: nextMetrics.labor,
          hoursPerDay: nextMetrics.hoursPerDay,
          workers: Array.isArray(state.workers) ? state.workers.map((worker) => ({
            name: worker.name || "",
            type: worker.type || "installer",
            days: Number(worker.days || 0),
            rate: worker.rate === "" || worker.rate == null ? "" : Number(worker.rate || 0)
          })) : [],
          note: state.notes || "",
          status: "pending"
        });
        saveApprovals(rows);
        if ($("approvalStatus")) {
          $("approvalStatus").style.display = "block";
          $("approvalStatus").className = "notice ok";
          $("approvalStatus").textContent = "Solicitud enviada a Sales Admin.";
        }
      };
    }

    if ($("btnMarkSold")) {
      $("btnMarkSold").onclick = () => {
        const nextMetrics = calcSales(state, settings);
        state.projectName = val("salesProjectName");
        state.clientName = val("salesClientName");
        state.dueDate = normalizeDateInput(val("salesDueDate"));
        state.offeredPrice = num("salesPrice", 0);
        state.notes = val("salesNotes");
        saveSales(state);

        if (!state.projectName.trim()) return alert("Project name is required.");
        if (!state.clientName.trim()) return alert("Client name is required.");
        if (!state.dueDate) return alert("Committed date is required.");
        if (!state.workers.length || nextMetrics.totalWorkerDays <= 0) return alert("Add worker-days before signing the project.");

        const project = buildSignedProjectFromSales(state, settings, nextMetrics);
        upsertProject(project);
        saveSupervisorSelectedProjectId(project.id);
        saveSupervisorReport(project.id, buildDefaultSupervisorReport(project));

        if ($("salesSignedStatus")) {
          $("salesSignedStatus").style.display = "block";
          $("salesSignedStatus").className = "notice ok";
          $("salesSignedStatus").textContent = `Proyecto firmado y agregado a Supervisor: ${project.projectName}.`;
        }

        renderSales();
      };
    }

    if ($("btnSendQuote")) {
      $("btnSendQuote").onclick = () => {
        const nextMetrics = calcSales(state, settings);
        if ($("scope") && !$("scope").value) $("scope").value = state.notes || "";
        openSendModal(state, settings, nextMetrics);
      };
    }

    if ($("btnSendClose")) $("btnSendClose").onclick = closeSendModal;
    if ($("btnSendCancel")) $("btnSendCancel").onclick = closeSendModal;
    if ($("btnSendNow")) {
      $("btnSendNow").onclick = () => {
        const nextMetrics = calcSales(state, settings);
        sendQuote(state, settings, nextMetrics);
      };
    }

    ["toEmail", "toName", "subject", "scope", "message", "salesInitials"].forEach((id) => {
      if ($(id)) $(id).oninput = updateSendCounts;
    });

    if ($("btnAddSalesWorker")) {
      $("btnAddSalesWorker").onclick = () => {
        state.workers.push({
          name: `Worker ${state.workers.length + 1}`,
          type: "installer",
          days: 0,
          rate: ""
        });
        saveSales(state);
        renderSales();
      };
    }

    if ($("btnClearSalesWorkers")) {
      $("btnClearSalesWorkers").onclick = () => {
        if (!confirm("Limpiar mano de obra de vendedor?")) return;
        state.workers = [{ name: "Worker 1", type: "installer", days: 0, rate: "" }];
        if ($("salesPrice")) $("salesPrice").dataset.touched = "false";
        saveSales(state);
        renderSales();
      };
    }

    refresh();
  }

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
            <option value="${escapeHtml(project.id)}">${escapeHtml(project.projectName || "Project")} � ${escapeHtml(project.clientName || "Sin cliente")}</option>
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
              <option value="installer" ${worker.type === "installer" ? "selected" : ""}>Installer</option>
              <option value="helper" ${worker.type === "helper" ? "selected" : ""}>Helper</option>
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
          ? `${changeMetrics.totalWorkerDays.toFixed(2)} worker-days � ${changeMetrics.totalHours.toFixed(2)} horas de equipo � ${changeMetrics.crewSize} trabajadores`
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
    renderBusinessSettings();
    renderOwner();
    renderSales();
    renderSupervisor();
    renderSalesAdmin();
  }

  document.addEventListener("DOMContentLoaded", render);
})();





