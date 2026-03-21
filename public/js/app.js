(() => {
  const LS_SETTINGS = "mg_settings_v2";
  const LS_OWNER = "mg_owner_v2";
  const LS_DASHBOARD = "mg_dashboard_v2";
  const LS_SALES = "mg_sales_v2";
  const LS_SUPERVISOR = "mg_supervisor_v2";
  const LS_APPROVALS = "mg_approvals_v2";

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
    estimatedHours: 0,
    estimatedDays: 0,
    offeredPrice: 0,
    notes: ""
  };

  const DEFAULT_SUPERVISOR = {
    projectName: "",
    plannedHours: 0,
    laborBudget: 0,
    materialBudget: 0,
    dueDate: "",
    projectedEndDate: "",
    entries: []
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
      offeredPrice: saved.offeredPrice || owner.metrics?.recommended || 0
    };
  }
  function saveSales(state) { writeStore(LS_SALES, state); }
  function loadSupervisor() {
    const saved = readStore(LS_SUPERVISOR, {});
    const owner = loadOwner();
    const plannedHours = Array.isArray(owner.workers) ? owner.workers.reduce((sum, worker) => sum + Number(worker.hours || 0), 0) : 0;
    return {
      ...DEFAULT_SUPERVISOR,
      ...saved,
      projectName: saved.projectName || owner.projectName || "",
      plannedHours: saved.plannedHours || plannedHours,
      laborBudget: saved.laborBudget || owner.metrics?.labor || 0
    };
  }
  function saveSupervisor(state) { writeStore(LS_SUPERVISOR, state); }
  function loadApprovals() { const saved = readStore(LS_APPROVALS, []); return Array.isArray(saved) ? saved : []; }
  function saveApprovals(rows) { writeStore(LS_APPROVALS, rows); }

  function calcOwner(state, settings) {
    const laborByWorker = state.workers.map((worker) => {
      const hours = Number(worker.hours || 0);
      const baseRate = worker.type === "helper" ? Number(settings.baseHelper || 0) : Number(settings.baseInstaller || 0);
      return { hours, rate: baseRate, cost: hours * baseRate };
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
      settingsCopy.supervisorBonusPct = num("
