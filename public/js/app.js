const DEFAULT_SUPERVISOR = {
  projectName: "",
  plannedHours: 0,
  laborBudget: 0,
  materialBudget: 0,
  dueDate: "",
  projectedEndDate: "",
  entries: [],
  extras: []
};

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
    laborBudget: saved.laborBudget || owner.metrics?.labor || 0,
    entries: Array.isArray(saved.entries) ? saved.entries : [],
    extras: Array.isArray(saved.extras) ? saved.extras : []
  };
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
    const extraSpent = state.extras.reduce((sum, row) => sum + Number(row.amount || 0), 0);

    const totalSpent = laborSpent + materialSpent + extraSpent;
    const totalBudget = Number(state.laborBudget || 0) + Number(state.materialBudget || 0);

    const laborRemaining = Number(state.laborBudget || 0) - laborSpent;
    const materialRemaining = Number(state.materialBudget || 0) - materialSpent;
    const totalRemaining = totalBudget - totalSpent;
    const overBudget = Math.max(0, totalSpent - totalBudget);

    let dayDelta = 0;
    if (state.dueDate && state.projectedEndDate) {
      const due = new Date(state.dueDate).getTime();
      const projected = new Date(state.projectedEndDate).getTime();
      dayDelta = Math.round((projected - due) / (1000 * 60 * 60 * 24));
    }

    const delayPenalty = dayDelta > 0 ? clamp(dayDelta / 30, 0, 1) : 0;
    const budgetPenalty = totalBudget > 0 ? clamp(overBudget / totalBudget, 0, 1) : 0;

    const baseBonusPct = Number(settings.supervisorBonusPct || DEFAULTS.supervisorBonusPct);
    const bonusPct = clamp(baseBonusPct * (1 - delayPenalty) * (1 - budgetPenalty), 0, baseBonusPct);

    let tone = "green";
    let stateLabel = "En control";
    let stateMeta = "Proyecto estable. Presupuesto y fechas bajo control.";

    if (overBudget > 0 || dayDelta > 0) {
      tone = "amber";
      stateLabel = "Ajustar";
      stateMeta = "Hay presion en presupuesto o fechas. Conviene corregir hoy.";
    }

    if (overBudget > totalBudget * 0.1 || dayDelta > 3) {
      tone = "red";
      stateLabel = "Riesgo";
      stateMeta = "El proyecto ya muestra desviacion importante.";
    }

    if ($("supStatus")) {
      $("supStatus").className = `badge ${tone}`;
      $("supStatus").textContent = tone === "green"
        ? "En control"
        : (tone === "amber" ? "Ajustar presupuesto" : "Riesgo alto");
    }

    if ($("supHeroState")) $("supHeroState").textContent = stateLabel;
    if ($("supHeroMeta")) $("supHeroMeta").textContent = stateMeta;

    if ($("supExecutiveNote")) {
      $("supExecutiveNote").textContent = totalBudget > 0
        ? `Impacto total actual: ${money(totalSpent, settings.currency)}. Presupuesto restante: ${money(totalRemaining, settings.currency)}.`
        : "Define presupuesto, fechas y avances para activar el tablero.";
    }

    if ($("supPrimaryBalance")) $("supPrimaryBalance").textContent = money(totalRemaining, settings.currency);
    if ($("supPrimaryMeta")) {
      $("supPrimaryMeta").textContent = totalBudget > 0
        ? `Total presupuesto ${money(totalBudget, settings.currency)} · Impacto real ${money(totalSpent, settings.currency)}`
        : "Captura datos del proyecto para activar el resumen.";
    }

    if ($("supPrimaryDays")) $("supPrimaryDays").textContent = String(dayDelta);
    if ($("supPrimaryDaysMeta")) {
      $("supPrimaryDaysMeta").textContent = !state.dueDate || !state.projectedEndDate
        ? "Sin fechas comparables todavia"
        : (dayDelta <= 0 ? "En tiempo o adelantado" : "Dias de atraso proyectado");
    }

    if ($("supPrimaryBonus")) $("supPrimaryBonus").textContent = `${bonusPct.toFixed(2)}%`;
    if ($("supPrimaryBonusMeta")) {
      $("supPrimaryBonusMeta").textContent = `Base ${baseBonusPct.toFixed(2)}% ajustada por atraso y desviacion`;
    }

    $("supervisorKpis").innerHTML = [
      ["Labor restante", money(laborRemaining, settings.currency), "Presupuesto de labor menos gasto real"],
      ["Material restante", money(materialRemaining, settings.currency), "Presupuesto de material menos compra registrada"],
      ["Gastos extra", money(extraSpent, settings.currency), "Imprevistos fuera del presupuesto original"],
      ["Desviacion total", money(overBudget, settings.currency), overBudget > 0 ? "Proyecto sobre presupuesto" : "Sin sobrecosto todavia"],
      ["Dias de diferencia", `${dayDelta}`, !state.dueDate || !state.projectedEndDate ? "Faltan fechas comparables" : (dayDelta <= 0 ? "En tiempo o adelantado" : "Atraso proyectado")],
      ["Bonus estimado", `${bonusPct.toFixed(2)}%`, `Base ${baseBonusPct.toFixed(2)}% reducida por atraso y sobrecosto`]
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

    if ($("supExtrasBody")) {
      $("supExtrasBody").innerHTML = state.extras.map((row, index) => `
        <tr>
          <td>${escapeHtml(row.date || "-")}</td>
          <td>${escapeHtml(row.category || "-")}</td>
          <td>${escapeHtml(row.item || "-")}</td>
          <td>${money(row.amount || 0, settings.currency)}</td>
          <td>${escapeHtml(row.note || "-")}</td>
          <td><button class="btn danger" data-delete-extra="${index}">Delete</button></td>
        </tr>
      `).join("");

      $("supExtrasBody").querySelectorAll("button[data-delete-extra]").forEach((button) => {
        button.onclick = () => {
          state.extras.splice(Number(button.dataset.deleteExtra || -1), 1);
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
      saveSupervisor(state);
      refresh();
    };
  }

  if ($("btnAddSupExtra")) {
    $("btnAddSupExtra").onclick = () => {
      const extra = {
        date: val("supExtraDate"),
        category: val("supExtraCategory"),
        item: val("supExtraItem").trim(),
        amount: num("supExtraAmount", 0),
        note: val("supExtraNote").trim()
      };

      if (!extra.date) return alert("Extra expense date is required.");
      if (!extra.item) return alert("Extra expense concept is required.");

      state.extras.unshift(extra);
      setVal("supExtraDate", "");
      setVal("supExtraCategory", "consumibles");
      setVal("supExtraItem", "");
      setNum("supExtraAmount", 0);
      setVal("supExtraNote", "");
      saveSupervisor(state);
      refresh();
    };
  }

  refresh();
}
