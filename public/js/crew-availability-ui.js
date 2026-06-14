/**
 * Shared crew availability card rendering (Owner + Seller operational plan).
 */
(function (global) {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatCrewAvailDate(ymd) {
    const cap = global.MarginGuardSalesCapacity;
    if (cap && typeof cap.formatDateUS === "function") {
      return cap.formatDateUS(ymd);
    }
    const s = String(ymd || "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s || "";
    const parts = s.split("-").map(Number);
    const dt = new Date(parts[0], parts[1] - 1, parts[2]);
    if (Number.isNaN(dt.getTime())) return s;
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function buildCrewAvailabilitySummaryTableHtml(rows) {
    const esc = escapeHtml;
    let html =
      '<div class="supervisor-table-wrap sales-op-avail-kv-wrap">' +
      '<table class="table sales-op-avail-summary-table"><tbody>';
    rows.forEach(function (row) {
      html +=
        "<tr><th scope=\"row\">" +
        esc(row[0]) +
        "</th><td>" +
        row[1] +
        "</td></tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  function buildSupervisorLaborEntriesTableHtml(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return "";
    const esc = escapeHtml;
    const fmt = formatCrewAvailDate;
    let html =
      '<p class="sales-op-avail-lead sales-op-avail-lead--table">Supervisor labor reports</p>' +
      '<div class="supervisor-table-wrap sales-op-avail-entries-wrap">' +
      '<table class="table sales-op-avail-entries-table">' +
      "<thead><tr><th>Fecha</th><th>Nota</th><th>Horas</th><th>Días</th></tr></thead><tbody>";
    list.forEach(function (row) {
      const dateRaw = row && row.date ? String(row.date).trim().slice(0, 10) : "";
      const dateLabel =
        /^\d{4}-\d{2}-\d{2}$/.test(dateRaw) ? fmt(dateRaw) || dateRaw : row.date || "—";
      html +=
        "<tr><td>" +
        esc(dateLabel) +
        "</td><td>" +
        esc(row && row.note ? row.note : "—") +
        "</td><td>" +
        esc(Number(row && row.hours != null ? row.hours : 0).toFixed(2)) +
        "</td><td>" +
        esc(Number(row && row.days != null ? row.days : 0).toFixed(2)) +
        "</td></tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }

  function buildCrewAvailabilityHtml(detail, cached, options) {
    const opts = options || {};
    if (!detail || typeof detail !== "object") return "";
    const esc = escapeHtml;
    const fmt = formatCrewAvailDate;
    const st = String(detail.status || "").toLowerCase();
    const p = detail.primary_project;
    const supervisorEntries = detail._supervisorEntries;

    if (st === "released") {
      return '<p class="sales-op-avail-lead">' + esc(detail.message || "Crew released.") + "</p>";
    }
    if (st === "progress_unverified") {
      let html =
        '<p class="sales-op-avail-lead">' +
        esc(
          detail.message ||
            "Supervisor progress not available. Confirm crew availability before promising this start date."
        ) +
        "</p>";
      if (opts.showSupervisorLaborTable && supervisorEntries && supervisorEntries.length) {
        html +=
          '<p class="sales-op-avail-note sales-op-avail-note--local">Local Supervisor detail below — display only; availability decision comes from the capacity API.</p>';
        html += buildSupervisorLaborEntriesTableHtml(supervisorEntries);
      }
      return html;
    }
    if (p && !p.released && !p.is_completed_by_supervisor) {
      const projectLabel =
        esc(p.project_name || "Active project") + (p.client_name ? " · " + esc(p.client_name) : "");
      const est = Math.max(0, Math.round(Number(p.estimated_days) || 0));
      const done = Math.max(0, Math.round(Number(p.completed_days) || 0));
      const rem = Math.max(0, Math.ceil(Number(p.remaining_days) || 0));
      const rows = [
        ["Current project", projectLabel],
        ["Supervisor progress", est > 0 ? done + " of " + est + " days completed" : done + " days completed"],
        ["Remaining", rem + " scheduled day" + (rem === 1 ? "" : "s")]
      ];
      if (p.target_finish_date) {
        rows.push(["Target finish", fmt(p.target_finish_date) || p.target_finish_date]);
      }
      const recStart = detail.recommended_next_start_date || p.recommended_next_start_date;
      if (recStart) {
        rows.push(["Earliest recommended start", fmt(recStart) || recStart]);
      }
      let html = buildCrewAvailabilitySummaryTableHtml(rows);
      if (opts.showSupervisorLaborTable && supervisorEntries && supervisorEntries.length) {
        html += buildSupervisorLaborEntriesTableHtml(supervisorEntries);
      }
      if (detail.advisory_note) {
        html += '<p class="sales-op-avail-note">' + esc(detail.advisory_note) + "</p>";
      }
      if (p.is_delayed) {
        html +=
          '<p class="sales-op-avail-delay">Field delay reported — confirm with Supervisor before promising an earlier start.</p>';
      }
      if (opts.showSupervisorLaborTable && supervisorEntries && supervisorEntries.length) {
        html +=
          '<p class="sales-op-avail-note sales-op-avail-note--local">Local Supervisor labor reports (display only).</p>';
        html += buildSupervisorLaborEntriesTableHtml(supervisorEntries);
      }
      return html;
    }
    const fallbackMsg =
      detail.message ||
      (cached && (cached.crew_availability_card_message || cached.availability_message)) ||
      "";
    return fallbackMsg
      ? '<p class="sales-op-avail-lead">' +
          esc(String(fallbackMsg).replace(/\sYou may still send this estimate\.\s*$/i, "").trim()) +
          "</p>"
      : "";
  }

  /**
   * @param {string} containerId
   * @param {{ cacheKey?: string, unverifiedKey?: string, startInputId?: string, getStartDate?: function, emptyLabel?: string, enrichDetail?: function, showSupervisorLaborTable?: boolean }} options
   */
  function renderCrewAvailabilityCard(containerId, options) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const opts = options || {};
    const cacheKey = opts.cacheKey || "__mgSalesCapacityCalendar";
    const unverifiedKey = opts.unverifiedKey || "__mgSalesCapacityUnverified";
    const cap = global.MarginGuardSalesCapacity;

    if (global[unverifiedKey]) {
      const unverifiedCopy =
        opts.unverifiedMessage ||
        (cap && cap.ADVISORY_UNVERIFIED_MSG) ||
        "Crew availability could not be verified. You may still send this estimate.";
      el.innerHTML = '<p class="sales-op-avail-lead">' + escapeHtml(unverifiedCopy) + "</p>";
      el.className = "sales-op-avail sales-op-avail--warn";
      return;
    }

    const cached = global[cacheKey];
    let detail = cached && cached.crew_availability_detail;
    if (detail && typeof detail === "object" && typeof opts.enrichDetail === "function") {
      try {
        const enriched = opts.enrichDetail(Object.assign({}, detail), cached);
        if (enriched && typeof enriched === "object") detail = enriched;
      } catch (_err) {
        /* keep API detail */
      }
    }

    if (detail && typeof detail === "object") {
      el.innerHTML = buildCrewAvailabilityHtml(detail, cached, opts);
      const st = String(detail.status || (cached && cached.capacity_status) || "").toLowerCase();
      if (st === "available" || st === "released") {
        el.className = "sales-op-avail sales-op-avail--ok";
      } else {
        el.className = "sales-op-avail sales-op-avail--warn";
      }
      return;
    }

    let cardMsg = cached && (cached.crew_availability_card_message || cached.availability_message);
    if (cardMsg && cached && !cached.crew_availability_card_message && cap) {
      cardMsg = String(cardMsg).replace(/\sYou may still send this estimate\.\s*$/i, "").trim();
    }
    if (cardMsg) {
      const st = String((cached && cached.capacity_status) || "").toLowerCase();
      el.innerHTML = '<p class="sales-op-avail-lead">' + escapeHtml(String(cardMsg).trim()) + "</p>";
      el.className =
        st === "available" ? "sales-op-avail sales-op-avail--ok" : "sales-op-avail sales-op-avail--warn";
      return;
    }

    let start = "";
    if (typeof opts.getStartDate === "function") {
      start = opts.getStartDate();
    } else {
      const startInput = document.getElementById(opts.startInputId || "salesStartDate");
      start =
        cap && cap.normDate
          ? cap.normDate(startInput && startInput.value ? startInput.value : "")
          : String(startInput && startInput.value ? startInput.value : "")
              .trim()
              .slice(0, 10);
    }

    if (!start) {
      el.textContent = opts.emptyLabel || "Set a start date to preview crew schedule.";
      el.className = "sales-op-avail sales-op-avail--unknown";
      return;
    }
    el.textContent = "Checking schedule…";
    el.className = "sales-op-avail sales-op-avail--unknown";
  }

  global.MarginGuardCrewAvailabilityUi = {
    escapeHtml,
    formatCrewAvailDate,
    buildCrewAvailabilityHtml,
    buildSupervisorLaborEntriesTableHtml,
    renderCrewAvailabilityCard,
    QUOTE_ADVISORY_SUFFIX: " You may still send this quote.",
    ESTIMATE_ADVISORY_SUFFIX: " You may still send this estimate."
  };

  global.renderOwnerOpCrewAvailability = function renderOwnerOpCrewAvailability() {
    renderCrewAvailabilityCard("ownerOpCrewAvailability", {
      cacheKey: "__mgOwnerCapacityCalendar",
      unverifiedKey: "__mgOwnerCapacityUnverified",
      startInputId: "ownerStartDate",
      emptyLabel: "Set a start date to preview crew schedule.",
      showSupervisorLaborTable: true,
      enrichDetail:
        typeof global.enrichOwnerCrewAvailabilityDetail === "function"
          ? global.enrichOwnerCrewAvailabilityDetail
          : null
    });
  };
})(typeof window !== "undefined" ? window : globalThis);
