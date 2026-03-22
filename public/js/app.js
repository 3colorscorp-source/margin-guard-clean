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
    offeredPrice: 0,
    notes: "",
    workers: [
      { name: "Worker 1", type: "installer", days: 5, rate: "" }
    ]
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

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
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

  function loadSettings() {
    return { ...DEFAULTS, ...readStore(LS_SETTINGS, {}) };
  }

  function saveSettings(settings) {
    writeStore(LS_SETTINGS, settings);
  }

  function loadOwner() {
    const saved = readStore(LS_OWNER, {});
    return {
      ...DEFAULT_OWNER,
      ...saved,
      reservePct: DEFAULTS.reservePct,
      workers: Array.isArray(saved.workers) && saved.workers.length ? saved.workers : DEFAULT_OWNER.workers
    };
  }

  function saveOwner(state, metrics) {
    writeStore(LS_OWNER, { ...state, reservePct: DEFAULTS.reservePct, metrics });
  }

  function loadDashboard() {
    return { ...DEFAULT_DASHBOARD, ...readStore(LS_DASHBOARD, {}) };
  }

  function saveDashboard(state) {
    writeStore(LS_DASHBOARD, state);
  }

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

  function saveSales(state) {
    writeStore(LS_SALES, state);
  }

  function loadSupervisor() {
    const saved = readStore(LS_SUPERVISOR, {});
    const owner = loadOwner();
    const plannedHours = Array.isArray(owner.workers)
      ? owner.workers.reduce((sum, worker) => sum + Number(worker.hours || 0), 0)
      : 0;
    return {
      ...DEFAULT_SUPERVISOR,
      ...saved,
      projectName: saved.projectName || owner.projectName || "",
      plannedHours: saved.plannedHours || plannedHours,
      laborBudget: saved.laborBudget || owner.metrics?.labor || 0
    };
  }

  function saveSupervisor(state) {
    writeStore(LS_SUPERVISOR, state);
  }

  function loadApprovals() {
    const saved = readStore(LS_APPROVALS, []);
    return Array.isArray(saved) ? saved : [];
  }

  function saveApprovals(rows) {
    writeStore(LS_APPROVALS, rows);
  }

  function calcOwner(state, settings) {
    const laborByWorker = state.workers.map((worker) => {
      const hours = Number(worker.hours || 0);
      const baseRate = worker.type === "helper"
        ? Number(settings.baseHelper || 0)
        : Number(settings.baseInstaller || 0);
      const rate = worker.rate === "" || worker.rate == null ? baseRate : Number(worker.rate || 0);
      return { hours, rate, cost: hours * rate };
    });

    const labor = laborByWorker.reduce((sum, row) => sum + row.cost, 0);
    const taxes = labor * (
      (
        Number(settings.wcPct || 0) +
        Number(settings.ficaPct || 0) +
        Number(settings.futaPct || 0) +
        Number(settings.casuiPct || 0)
      ) / 100
    );
    const totalHours = state.workers.reduce((sum, worker) => sum + Number(worker.hours || 0), 0);
    const overheadPerHour = Number(settings.stdHours || 0) > 0
      ? Number(settings.overheadMonthly || 0) / Number(settings.stdHours || 0)
      : 0;
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
      const healthScore = clamp(
        (runwayMonths * 7) + (Math.min(savingsPct, 100) * 0.35) + (state.expensesBalance >= state.operatingMonthly ? 20 : 0),
        0,
        100
      );
      const healthTone = healthClass(healthScore, 55, 80);

      if ($("overallHealth")) {
        $("overallHealth").textContent = `${healthScore.toFixed(0)}%`;
        $("overallHealth").style.color = healthTone === "green"
          ? "#86efac"
          : (healthTone === "amber" ? "#fcd34d" : "#fca5a5");
      }

      if ($("overallHealthMeta")) {
        $("overallHealthMeta").textContent = healthTone === "green"
          ? "Cash discipline is protecting the business."
          : (healthTone === "amber"
            ? "The business is stable but under pressure."
            : "High risk. Real cash is not protecting operations.");
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

    if ($("btnSaveDashboard")) {
      $("btnSaveDashboard").onclick = () => {
        refresh();
        alert("Owner finance monitor saved.");
      };
    }

    if ($("btnResetDashboard")) {
      $("btnResetDashboard").onclick = () => {
        saveDashboard({ ...DEFAULT_DASHBOARD });
        renderDashboard();
      };
    }

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

    if ($("btnAddWorker")) {
      $("btnAddWorker").onclick = () => {
        state.workers.push({
          name: `Worker ${state.workers.length + 1}`,
          type: "installer",
          hours: 0,
          rate: ""
        });
        saveOwner(state, calcOwner(state, settings));
        renderOwner();
      };
    }

    if ($("btnClear")) {
      $("btnClear").onclick = () => {
        if (!confirm("Clear this quote?")) return;
        writeStore(LS_OWNER, DEFAULT_OWNER);
        renderOwner();
      };
    }

    if ($("btnExportPdf")) $("btnExportPdf").onclick = () => exportOwnerPdf(state, settings, metrics);
    if ($("btnSendQuote")) $("btnSendQuote").onclick = () => openSendModal(state, settings, metrics);
    if ($("btnSendClose")) $("btnSendClose").onclick = closeSendModal;
    if ($("btnSendCancel")) $("btnSendCancel").onclick = closeSendModal;
    if ($("btnSendNow")) $("btnSendNow").onclick = () => sendQuote(state, settings, metrics);
    ["toEmail", "toName", "subject", "scope", "message", "salesInitials"].forEach((id) => {
      if ($(id)) $(id).oninput = updateSendCounts;
    });
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
    [`Project: ${state.projectName || "-"}`, `Client: ${state.clientName || "-"}`, `Location: ${state.location || "-"}`, `Recommended: ${money(metrics.recommended, settings.currency)}`].forEach((line) => {
      doc.text(line, 40, y);
      y += 16;
    });
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.text("Financial Breakdown", 40, y);
    y += 18;
    doc.setFont("helvetica", "normal");
    buildOwnerKpis(state, settings, metrics).forEach(([label, value]) => {
      doc.text(`${label}: ${value}`, 40, y);
      y += 15;
    });
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

    if ($("subject") && !$("subject").value) {
      $("subject").value = `Project Quote - ${state.projectName || "Project"} - ${money(metrics.recommended, settings.currency)}`;
    }

    if ($("deposit")) {
      $("deposit").value = "1000.00";
      $("deposit").setAttribute("readonly", "readonly");
    }

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
    if ($("sendStatus")) {
      $("sendStatus").style.display = "none";
      $("sendStatus").className = "notice";
      $("sendStatus").textContent = "";
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
    const stageRange = $("salesStageRange");
    const metrics = calcSales(state, settings);

    setVal("salesProjectName", state.projectName);
    setVal("salesClientName", state.clientName);
    setNum("salesPrice", state.offeredPrice);
    setVal("salesNotes", state.notes);
    count("salesProjectName", "salesProjectNameCount");
    count("salesClientName", "salesClientNameCount");
    count("salesNotes", "salesNotesCount");

    renderSalesWorkers(state, settings, metrics);

    const refresh = () => {
      state.projectName = val("salesProjectName");
      state.clientName = val("salesClientName");
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
        heroMeta = "El recomendado ya fue calculado con la mano de obra capturada.";
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
        $("salesTraffic").textContent = tone === "green"
          ? "Aprobado"
          : (tone === "amber" ? "Negociar con cuidado" : "Bloqueado");
      }

      if ($("salesRule")) $("salesRule").textContent = message;
      if ($("approvalHint")) {
        $("approvalHint").textContent = tone === "red"
          ? "Precio rojo: aprobacion obligatoria del dueno o Sales Admin."
          : (tone === "amber"
            ? "Precio amarillo: se puede vender, pero conviene defender margen."
            : "Precio verde: no necesita aprobacion.");
      }

      if ($("salesHeroState")) $("salesHeroState").textContent = heroState;
      if ($("salesHeroMeta")) $("salesHeroMeta").textContent = heroMeta;
      if ($("salesPrimaryPrice")) $("salesPrimaryPrice").textContent = money(recommended, settings.currency);

      if ($("salesPrimaryMeta")) {
        $("salesPrimaryMeta").textContent = state.workers.length && nextMetrics.totalHours > 0
          ? `${nextMetrics.totalWorkerDays.toFixed(2)} worker-days · ${nextMetrics.totalHours.toFixed(2)} horas-hombre · ${state.workers.length} trabajadores`
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
          ? `${state.workers.length} trabajadores · ${nextMetrics.totalWorkerDays.toFixed(2)} worker-days · ${nextMetrics.totalHours.toFixed(2)} horas-hombre`
          : "Define mano de obra por trabajador para calcular horas-hombre y precio recomendado.";
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
        ["Comision estimada", `${commissionPct.toFixed(2)}% · ${money(commissionAmount, settings.currency)}`, "Pago estimado del vendedor"]
      ].map(([label, value, meta]) => `
        <div class="kpi-box">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${escapeHtml(value)}</div>
          <div class="meta">${escapeHtml(meta)}</div>
        </div>
      `).join("");

      const scripts = tone === "green"
        ? [
            "Este precio protege calidad, calendario y garantia.",
            "Si aprobamos hoy, podemos asegurar mano de obra y agenda de instalacion."
          ]
        : tone === "amber"
          ? [
              "Podemos sostener ese numero si ajustamos alcance o dividimos el trabajo por fases.",
              "Prefiero proteger el resultado final antes que crear problemas con cambios y extras despues."
            ]
          : [
              "Ese numero no esta aprobado. Hay que ajustar alcance, calendario o precio.",
              "Para vender abajo de esto se necesita autorizacion del dueno o Sales Admin."
            ];

      if ($("negotiationList")) {
        $("negotiationList").innerHTML = scripts.map((line, index) => `
          <li><span class="msg-idx">${index + 1}</span>${escapeHtml(line)}</li>
        `).join("");
      }
    };

    if ($("salesModeHint")) {
      $("salesModeHint").textContent = `Cada trabajador usa ${metrics.hoursPerDay.toFixed(2)} horas por dia. Si el costo base queda vacio, usa Business Settings segun el tipo.`;
    }
    if ($("salesEntryHint")) {
      $("salesEntryHint").textContent = "Captura los dias de cada trabajador por individual. El sistema calcula horas-hombre, recomendado, negociacion y minimo.";
    }

    ["salesProjectName", "salesClientName", "salesPrice", "salesNotes"].forEach((id) => {
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
          offeredPrice: state.offeredPrice,
          recommended: nextMetrics.recommended,
          minimum: nextMetrics.minimum,
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
    const state = loadSupervisor();
    setVal("supProjectName", state.projectName);
    setNum("supPlannedHours", state.plannedHours);
    setNum("supLaborBudget", state.laborBudget);
    setNum("supMaterialBudget", state.materialBudget);
    setVal("supDueDate", state.dueDate);
    setVal("supProjectedDate", state.projectedEndDate);

    const refresh = () => {
      state.projectName = val("supProjectName");
      state.plannedHours = num("supPlannedHours", 0);
      state.laborBudget = num("supLaborBudget", 0);
      state.materialBudget = num("supMaterialBudget", 0);
      state.dueDate = val("supDueDate");
      state.projectedEndDate = val("supProjectedDate");
      saveSupervisor(state);

      const laborSpent = state.entries.reduce((sum, row) => sum + Number(row.labor || 0), 0);
      const materialSpent = state.entries.reduce((sum, row) => sum + Number(row.material || 0), 0);
      const totalSpent = laborSpent + materialSpent;
      const totalBudget = Number(state.laborBudget || 0) + Number(state.materialBudget || 0);
      const overBudget = Math.max(0, totalSpent - totalBudget);

      let delayPenalty = 0;
      if (state.dueDate && state.projectedEndDate) {
        const due = new Date(state.dueDate).getTime();
        const projected = new Date(state.projectedEndDate).getTime();
        if (projected > due) {
          delayPenalty = clamp((projected - due) / (1000 * 60 * 60 * 24 * 30), 0, 1);
        }
      }

      const budgetPenalty = totalBudget > 0 ? clamp(overBudget / totalBudget, 0, 1) : 0;
      const baseBonusPct = Number(settings.supervisorBonusPct || DEFAULTS.supervisorBonusPct);
      const bonusPct = clamp(baseBonusPct * (1 - delayPenalty) * (1 - budgetPenalty), 0, baseBonusPct);
      const bonusHealth = baseBonusPct > 0 ? bonusPct / baseBonusPct : 0;
      const tone = overBudget <= 0 && bonusHealth >= 0.85
        ? "green"
        : (overBudget <= totalBudget * 0.1 ? "amber" : "red");

      if ($("supStatus")) {
        $("supStatus").className = `badge ${tone}`;
        $("supStatus").textContent = tone === "green"
          ? "Controlled"
          : (tone === "amber" ? "Watch budget" : "At risk");
      }

      $("supervisorKpis").innerHTML = [
        ["Labor budget", money(state.laborBudget, settings.currency), "Labor only"],
        ["Material budget", money(state.materialBudget, settings.currency), "Material allocation"],
        ["Actual spend", money(totalSpent, settings.currency), "Real labor + material spent"],
        ["Budget drift", money(overBudget, settings.currency), overBudget > 0 ? "Project is over budget" : "Still inside budget"],
        ["Supervisor bonus", `${bonusPct.toFixed(2)}%`, `Base ${baseBonusPct.toFixed(2)}% reduced by delay and overrun`]
      ].map(([label, value, meta]) => `
        <div class="kpi-box">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${escapeHtml(value)}</div>
          <div class="meta">${escapeHtml(meta)}</div>
        </div>
      `).join("");

      if ($("supEntriesBody")) {
        $("supEntriesBody").innerHTML = state.entries.map((row, index) => `
          <tr>
            <td>${escapeHtml(row.date || "-")}</td>
            <td>${escapeHtml(row.note || "-")}</td>
            <td>${money(row.labor || 0, settings.currency)}</td>
            <td>${money(row.material || 0, settings.currency)}</td>
            <td><button class="btn danger" data-delete-entry="${index}">Delete</button></td>
          </tr>
        `).join("");

        $("supEntriesBody").querySelectorAll("button[data-delete-entry]").forEach((button) => {
          button.onclick = () => {
            state.entries.splice(Number(button.dataset.deleteEntry || -1), 1);
            saveSupervisor(state);
            refresh();
          };
        });
      }
    };

    ["supProjectName", "supPlannedHours", "supLaborBudget", "supMaterialBudget", "supDueDate", "supProjectedDate"].forEach((id) => {
      const el = $(id);
      if (el) el.oninput = refresh;
    });

    if ($("btnAddSupEntry")) {
      $("btnAddSupEntry").onclick = () => {
        const entry = {
          date: val("supEntryDate"),
          labor: num("supEntryLabor", 0),
          material: num("supEntryMaterial", 0),
          note: val("supEntryNote").trim()
        };

        if (!entry.date) return alert("Entry date is required.");

        state.entries.unshift(entry);
        setVal("supEntryDate", "");
        setNum("supEntryLabor", 0);
        setNum("supEntryMaterial", 0);
        setVal("supEntryNote", "");
        refresh();
      };
    }

    refresh();
  }

  function renderSalesAdmin() {
    if (!$("adminQueueBody")) return;

    const settings = loadSettings();
    const rows = loadApprovals();

    const refresh = () => {
      $("adminQueueBody").innerHTML = rows.map((row, index) => {
        const tone = row.offeredPrice >= row.recommended
          ? "green"
          : (row.offeredPrice >= row.minimum ? "amber" : "red");
        const discount = row.recommended > 0
          ? (((row.recommended - row.offeredPrice) / row.recommended) * 100)
          : 0;

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
          rows[Number(button.dataset.adminApprove || -1)].status = "approved";
          saveApprovals(rows);
          refresh();
        };
      });

      $("adminQueueBody").querySelectorAll("button[data-admin-reject]").forEach((button) => {
        button.onclick = () => {
          rows[Number(button.dataset.adminReject || -1)].status = "rejected";
          saveApprovals(rows);
          refresh();
        };
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
