(() => {
  "use strict";

  const LS_SETTINGS = "mg_ai_closer_lab_settings_v1";

  const TRADE_PRESETS = {
    tile_contractor: {
      label: "Tile Contractor",
      services: [
        {
          id: "floor_tile",
          name: "Floor Tile",
          unitType: "sq_ft",
          capacityPerCrewDay: 90,
          protectedPublicCrewDayPrice: 1669.67,
          hoursPerCrewDay: 8,
          starterBufferPct: 3,
          bufferMaxDollars: 750,
        },
        {
          id: "wall_tile",
          name: "Wall Tile",
          unitType: "sq_ft",
          capacityPerCrewDay: 70,
          protectedPublicCrewDayPrice: 1669.67,
          hoursPerCrewDay: 8,
          starterBufferPct: 3,
          bufferMaxDollars: 750,
        },
      ],
    },
    painter: {
      label: "Painter",
      services: [
        {
          id: "interior_paint",
          name: "Interior Painting",
          unitType: "sq_ft",
          capacityPerCrewDay: 400,
          protectedPublicCrewDayPrice: 1420,
          hoursPerCrewDay: 8,
          starterBufferPct: 4,
          bufferMaxDollars: 600,
        },
      ],
    },
    plumber: {
      label: "Plumber",
      services: [
        {
          id: "bath_rough",
          name: "Bathroom Rough-In",
          unitType: "fixture",
          capacityPerCrewDay: 1.5,
          protectedPublicCrewDayPrice: 1850,
          hoursPerCrewDay: 8,
          starterBufferPct: 5,
          bufferMaxDollars: 900,
        },
      ],
    },
    custom: {
      label: "Custom Trade",
      services: [
        {
          id: "custom_service",
          name: "Custom Service",
          unitType: "sq_ft",
          capacityPerCrewDay: 100,
          protectedPublicCrewDayPrice: 1500,
          hoursPerCrewDay: 8,
          starterBufferPct: 4,
          bufferMaxDollars: 700,
        },
      ],
    },
  };

  const CLOSING_STYLES = [
    { id: "consultative", label: "Consultative — educate, then close" },
    { id: "direct", label: "Direct — confirm fit and book" },
    { id: "educational", label: "Educational — scope clarity first" },
  ];

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function defaultSettings() {
    const preset = TRADE_PRESETS.tile_contractor;
    return {
      tradePreset: "tile_contractor",
      customTradeName: "",
      businessName: "",
      services: preset.services.map((s) => ({ ...s })),
      guardrails: {
        minArea: 50,
        maxArea: 5000,
        requireBudgetBeforeQuote: true,
        maxStarterRangeSpreadPct: 12,
      },
      closingStyle: "consultative",
      updatedAt: new Date().toISOString(),
    };
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (!raw) return defaultSettings();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return defaultSettings();
      return { ...defaultSettings(), ...parsed, services: Array.isArray(parsed.services) ? parsed.services : defaultSettings().services };
    } catch (_err) {
      return defaultSettings();
    }
  }

  function saveSettings(settings) {
    settings.updatedAt = new Date().toISOString();
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
  }

  function unitLabel(unitType) {
    const map = { sq_ft: "sq ft", fixture: "fixtures", room: "rooms", linear_ft: "linear ft" };
    return map[unitType] || unitType;
  }

  function renderServices(settings) {
    const list = $("aclServicesList");
    if (!list) return;
    list.innerHTML = settings.services
      .map(
        (svc, index) => `
        <div class="acl-service-card" data-service-index="${index}">
          <div class="acl-service-card__head">
            <strong>${escapeHtml(svc.name || "Service")}</strong>
            <span class="badge blue">${escapeHtml(unitLabel(svc.unitType))}</span>
          </div>
          <div class="acl-form-grid acl-form-grid--3">
            <label>Service name<input type="text" data-field="name" value="${escapeHtml(svc.name)}" /></label>
            <label>Unit type
              <select data-field="unitType">
                <option value="sq_ft" ${svc.unitType === "sq_ft" ? "selected" : ""}>sq ft</option>
                <option value="fixture" ${svc.unitType === "fixture" ? "selected" : ""}>fixtures</option>
                <option value="room" ${svc.unitType === "room" ? "selected" : ""}>rooms</option>
                <option value="linear_ft" ${svc.unitType === "linear_ft" ? "selected" : ""}>linear ft</option>
              </select>
            </label>
            <label>Capacity / crew day<input type="number" min="0.1" step="0.1" data-field="capacityPerCrewDay" value="${escapeHtml(svc.capacityPerCrewDay)}" /></label>
            <label>Protected public crew day price ($)<input type="number" min="0" step="0.01" data-field="protectedPublicCrewDayPrice" value="${escapeHtml(svc.protectedPublicCrewDayPrice)}" /></label>
            <label>Hours / crew day<input type="number" min="1" max="24" step="0.5" data-field="hoursPerCrewDay" value="${escapeHtml(svc.hoursPerCrewDay)}" /></label>
            <label>Starter buffer %<input type="number" min="0" max="25" step="0.5" data-field="starterBufferPct" value="${escapeHtml(svc.starterBufferPct)}" /></label>
            <label>Buffer max ($)<input type="number" min="0" step="50" data-field="bufferMaxDollars" value="${escapeHtml(svc.bufferMaxDollars)}" /></label>
          </div>
        </div>`
      )
      .join("");
  }

  function readForm(settings) {
    const next = { ...settings };
    next.tradePreset = $("aclTradePreset")?.value || "tile_contractor";
    next.customTradeName = String($("aclCustomTradeName")?.value || "").trim();
    next.businessName = String($("aclBusinessName")?.value || "").trim();
    next.closingStyle = $("aclClosingStyle")?.value || "consultative";
    next.guardrails = {
      minArea: Number($("aclMinArea")?.value) || 50,
      maxArea: Number($("aclMaxArea")?.value) || 5000,
      requireBudgetBeforeQuote: Boolean($("aclRequireBudget")?.checked),
      maxStarterRangeSpreadPct: Number($("aclMaxSpread")?.value) || 12,
    };

    const cards = document.querySelectorAll(".acl-service-card");
    next.services = Array.from(cards).map((card) => {
      const index = Number(card.getAttribute("data-service-index"));
      const base = settings.services[index] || {};
      const read = (field) => {
        const el = card.querySelector(`[data-field="${field}"]`);
        return el ? el.value : base[field];
      };
      return {
        id: base.id || `service_${index}`,
        name: String(read("name")).trim() || "Service",
        unitType: read("unitType") || "sq_ft",
        capacityPerCrewDay: Number(read("capacityPerCrewDay")) || 90,
        protectedPublicCrewDayPrice: Number(read("protectedPublicCrewDayPrice")) || 1669.67,
        hoursPerCrewDay: Number(read("hoursPerCrewDay")) || 8,
        starterBufferPct: Number(read("starterBufferPct")) || 3,
        bufferMaxDollars: Number(read("bufferMaxDollars")) || 750,
      };
    });
    return next;
  }

  function fillForm(settings) {
    const trade = $("aclTradePreset");
    if (trade) trade.value = settings.tradePreset || "tile_contractor";
    const customWrap = $("aclCustomTradeWrap");
    const custom = $("aclCustomTradeName");
    if (customWrap) customWrap.hidden = settings.tradePreset !== "custom";
    if (custom) custom.value = settings.customTradeName || "";
    const business = $("aclBusinessName");
    if (business) business.value = settings.businessName || "";
    const closing = $("aclClosingStyle");
    if (closing) closing.value = settings.closingStyle || "consultative";
    $("aclMinArea").value = settings.guardrails.minArea;
    $("aclMaxArea").value = settings.guardrails.maxArea;
    $("aclRequireBudget").checked = settings.guardrails.requireBudgetBeforeQuote;
    $("aclMaxSpread").value = settings.guardrails.maxStarterRangeSpreadPct;
    renderServices(settings);
    updatePreview(settings);
  }

  function computePreviewQuote(service, quantity) {
    const qty = Number(quantity) || 395;
    const cap = Number(service.capacityPerCrewDay) || 90;
    const dayPrice = Number(service.protectedPublicCrewDayPrice) || 1669.67;
    const days = Math.ceil(qty / cap);
    const base = Math.round(days * dayPrice * 100) / 100;
    const rangeLow = Math.ceil(base / 100) * 100;
    const spread = Math.min(Number(service.bufferMaxDollars) || 750, Math.round(base * 0.085));
    const rangeHigh = rangeLow + Math.max(500, spread);
    return { days, base, rangeLow, rangeHigh };
  }

  function updatePreview(settings) {
    const el = $("aclPricingPreview");
    if (!el) return;
    const svc = settings.services[0];
    if (!svc) {
      el.textContent = "Add a service to preview.";
      return;
    }
    const sample = computePreviewQuote(svc, 395);
    el.innerHTML =
      `<strong>Lab preview (395 ${escapeHtml(unitLabel(svc.unitType))} — ${escapeHtml(svc.name)}):</strong> ` +
      `${sample.days} crew day(s) · starter range ${formatMoney(sample.rangeLow)} – ${formatMoney(sample.rangeHigh)}. ` +
      `Client sees range only — never internal cost.`;
  }

  function formatMoney(n) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
  }

  function applyTradePreset(presetId, settings) {
    const preset = TRADE_PRESETS[presetId];
    if (!preset) return settings;
    return {
      ...settings,
      tradePreset: presetId,
      services: preset.services.map((s) => ({ ...s })),
    };
  }

  function bindEvents(settings) {
    $("aclTradePreset")?.addEventListener("change", (ev) => {
      const id = ev.target.value;
      const customWrap = $("aclCustomTradeWrap");
      const custom = $("aclCustomTradeName");
      if (customWrap) customWrap.hidden = id !== "custom";
      const next = applyTradePreset(id, readForm(settings));
      fillForm(next);
      settings = next;
    });

    $("aclServicesList")?.addEventListener("input", () => {
      updatePreview(readForm(settings));
    });

    $("aclSaveSettings")?.addEventListener("click", () => {
      const next = readForm(settings);
      saveSettings(next);
      settings = next;
      const status = $("aclSaveStatus");
      if (status) {
        status.textContent = "Settings saved to lab localStorage.";
        status.hidden = false;
        setTimeout(() => {
          status.hidden = true;
        }, 3000);
      }
      updatePreview(settings);
    });

    $("aclResetSettings")?.addEventListener("click", () => {
      if (!window.confirm("Reset lab settings to Tile Contractor defaults?")) return;
      settings = defaultSettings();
      saveSettings(settings);
      fillForm(settings);
    });
  }

  function boot() {
    if (!$("aclSettingsRoot")) return;
    let settings = loadSettings();
    fillForm(settings);
    bindEvents(settings);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.__mgAiCloserLab = {
    LS_SETTINGS,
    loadSettings,
    saveSettings,
    defaultSettings,
    TRADE_PRESETS,
    computeStarterQuote(service, quantity, guardrails) {
      const qty = Number(quantity);
      const cap = Number(service?.capacityPerCrewDay) || 90;
      const dayPrice = Number(service?.protectedPublicCrewDayPrice) || 1669.67;
      const days = Math.ceil(qty / cap);
      const base = Math.round(days * dayPrice * 100) / 100;
      const rangeLow = Math.ceil(base / 100) * 100;
      const spread = Math.min(
        Number(service?.bufferMaxDollars) || 750,
        Math.round(base * ((Number(service?.starterBufferPct) || 3) / 100) * 2.5)
      );
      let rangeHigh = rangeLow + Math.max(500, spread);
      const maxSpreadPct = Number(guardrails?.maxStarterRangeSpreadPct) || 12;
      const maxHigh = rangeLow + Math.round(rangeLow * (maxSpreadPct / 100));
      if (rangeHigh > maxHigh) rangeHigh = maxHigh;
      return {
        estimatedDays: days,
        baseAmount: base,
        rangeLow,
        rangeHigh,
        hoursPerCrewDay: Number(service?.hoursPerCrewDay) || 8,
      };
    },
  };
})();
