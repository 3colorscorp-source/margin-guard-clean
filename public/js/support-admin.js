/**
 * Platform-admin Support Inbox UI.
 * Server APIs remain the authority. auth-status is_admin is UX only.
 */
(function () {
  const LIST_API = "/.netlify/functions/mg-support-admin-list-cases";
  const UPDATE_API = "/.netlify/functions/mg-support-admin-update-case";
  const CATEGORY_LABELS = {
    unresolved_question: "Unresolved question",
    diagnostic_unavailable: "Diagnostic unavailable",
    possible_bug: "Possible bug",
    other: "Other",
  };
  const MODULE_LABELS = {
    invoice_hub: "Invoice Hub",
    quote: "Quote Builder",
    project_control: "Project Control",
    contract_hub: "Contract Hub",
    documentation: "Documentation",
    unknown: "Unknown",
  };
  const STATUS_LABELS = {
    open: "Open",
    in_review: "In Review",
    waiting_on_customer: "Waiting on You",
    resolved: "Resolved",
  };
  const FILTER_BUTTON_IDS = {
    active: "siFilterActive",
    open: "siFilterOpen",
    in_review: "siFilterInReview",
    waiting_on_customer: "siFilterWaiting",
    resolved: "siFilterResolved",
    all: "siFilterAll",
  };
  const okResults = {
    resolved: true,
    reopened: true,
    in_review: true,
    waiting_on_customer: true,
    returned_to_open: true,
    already_resolved: true,
    already_open: true,
    already_in_review: true,
    already_waiting_on_customer: true,
  };

  const state = {
    status: "active",
    category: "",
    cases: [],
    selected: null,
    writing: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function categoryLabel(value) {
    return CATEGORY_LABELS[value] || "Other";
  }

  function moduleLabel(value) {
    return MODULE_LABELS[value] || String(value || "Unknown");
  }

  function statusLabel(value) {
    return STATUS_LABELS[value] || String(value || "Unknown");
  }

  function canResolve(status) {
    return status === "open" || status === "in_review" || status === "waiting_on_customer";
  }

  function canMarkInReview(status) {
    return status === "open" || status === "waiting_on_customer" || status === "resolved";
  }

  function canRequestAction(status) {
    return status === "open" || status === "in_review";
  }

  function formatWhen(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }

  function setNotice(text) {
    const el = $("siNotice");
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function showDenied() {
    const denied = $("siDenied");
    const main = $("siMain");
    if (denied) denied.hidden = false;
    if (main) main.hidden = true;
  }

  async function authStatus() {
    const res = await fetch("/.netlify/functions/auth-status", { credentials: "include" });
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    return data;
  }

  function buildListUrl() {
    const params = new URLSearchParams();
    params.set("status", state.status);
    if (state.category) params.set("category", state.category);
    return LIST_API + "?" + params.toString();
  }

  function syncSelectedFromRefreshedList() {
    if (!state.selected) {
      renderDrawer();
      return;
    }
    const selectedId = state.selected.case_id;
    const fresh = state.cases.find(function (row) {
      return row.case_id === selectedId;
    });
    state.selected = fresh || null;
    renderDrawer();
  }

  function setCount(id, value) {
    if ($(id)) $(id).textContent = String(value ?? "—");
  }

  async function loadList() {
    setNotice("");
    const list = $("siList");
    if (list) {
      list.textContent = "";
      const loading = document.createElement("div");
      loading.className = "si-loading";
      loading.textContent = "Loading support cases…";
      list.appendChild(loading);
    }
    let res;
    let data = {};
    try {
      res = await fetch(buildListUrl(), { credentials: "include" });
      try {
        data = await res.json();
      } catch (_err) {
        data = {};
      }
    } catch (_err) {
      res = { ok: false };
      data = {};
    }
    if (!res.ok || !data.ok) {
      state.cases = [];
      state.selected = null;
      if (list) list.textContent = "";
      setNotice(String(data.error || "Support cases could not be loaded."));
      renderDrawer();
      return false;
    }
    state.cases = Array.isArray(data.cases) ? data.cases : [];
    const counts = data.counts || {};
    setCount("siCountActive", counts.active);
    setCount("siCountOpen", counts.open);
    setCount("siCountInReview", counts.in_review);
    setCount("siCountWaiting", counts.waiting_on_customer);
    setCount("siCountResolved", counts.resolved);
    setCount("siCountTotal", counts.total);
    renderList();
    syncSelectedFromRefreshedList();
    return true;
  }

  function appendText(parent, tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text == null ? "" : String(text);
    parent.appendChild(el);
    return el;
  }

  function renderList() {
    const list = $("siList");
    if (!list) return;
    list.textContent = "";
    if (!state.cases.length) {
      appendText(list, "div", "si-empty", "No support cases in this view.");
      return;
    }
    state.cases.forEach(function (row) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "si-row";
      btn.setAttribute("data-case-id", String(row && row.case_id ? row.case_id : ""));
      const top = document.createElement("div");
      top.className = "si-row__top";
      appendText(top, "strong", "", row && row.case_ref ? row.case_ref : "");
      appendText(top, "span", "si-badge", row && row.status_label ? row.status_label : statusLabel(row && row.status));
      btn.appendChild(top);
      appendText(btn, "div", "", row && row.tenant_business_name ? row.tenant_business_name : "");
      appendText(btn, "div", "", row && row.subject ? row.subject : "");
      appendText(
        btn,
        "div",
        "si-row__meta",
        categoryLabel(row && row.category) +
          " · " +
          moduleLabel(row && row.support_module) +
          " · " +
          formatWhen(row && row.created_at)
      );
      list.appendChild(btn);
    });
  }

  function appendDl(parent, label, value) {
    const wrap = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = String(label || "");
    const dd = document.createElement("dd");
    dd.textContent = value == null ? "" : String(value);
    wrap.appendChild(dt);
    wrap.appendChild(dd);
    parent.appendChild(wrap);
    return dd;
  }

  function setText(id, text) {
    const el = $(id);
    if (!el) return;
    el.textContent = text == null ? "" : String(text);
  }

  function renderDrawer() {
    const row = state.selected;
    const drawer = $("siDrawer");
    const backdrop = $("siBackdrop");
    const resolveBtn = $("siResolve");
    const reopenBtn = $("siReopen");
    const reviewBtn = $("siMarkInReview");
    const returnBtn = $("siReturnToOpen");
    const requestBtn = $("siRequestAction");
    if (!row) {
      if (drawer) drawer.hidden = true;
      if (backdrop) backdrop.hidden = true;
      return;
    }
    if ($("siDrawerTitle")) $("siDrawerTitle").textContent = row.case_ref;
    const related =
      row.related_entity_type && row.related_entity_type !== "none"
        ? row.related_entity_type + (row.related_entity_ref ? " · " + row.related_entity_ref : "")
        : "None";
    const body = $("siDrawerBody");
    if (body) {
      body.textContent = "";
      appendDl(body, "Case ref", row.case_ref);
      appendDl(body, "Tenant business", row.tenant_business_name);
      appendDl(body, "Status", statusLabel(row.status));
      appendDl(body, "Category", categoryLabel(row.category));
      appendDl(body, "Subject", row.subject);
      const excerptDd = appendDl(body, "Question", row.question_excerpt || "");
      excerptDd.className = "si-excerpt";
      appendDl(body, "Module", moduleLabel(row.support_module));
      appendDl(body, "Page", row.page_path || "—");
      appendDl(body, "Related entity", related);
      appendDl(body, "Created", formatWhen(row.created_at));
      appendDl(body, "Updated", formatWhen(row.updated_at));
      appendDl(body, "Resolved", formatWhen(row.resolved_at));
    }

    const hasAction = !!(row.tenant_action_message && String(row.tenant_action_message).trim());
    const hasResolution = !!(row.customer_resolution && String(row.customer_resolution).trim());
    if ($("siSnapshot")) $("siSnapshot").hidden = !(hasAction || hasResolution);
    if ($("siActionMessageBlock")) $("siActionMessageBlock").hidden = !hasAction;
    if ($("siResolutionBlock")) $("siResolutionBlock").hidden = !hasResolution;
    setText("siActionMessageText", hasAction ? row.tenant_action_message : "");
    setText("siResolutionText", hasResolution ? row.customer_resolution : "");

    if ($("siActionCompose")) $("siActionCompose").hidden = !canRequestAction(row.status);
    if ($("siResolutionCompose")) $("siResolutionCompose").hidden = !canResolve(row.status);
    if ($("siActionMessageInput") && !state.writing) $("siActionMessageInput").value = "";
    if ($("siResolutionInput") && !state.writing && !canResolve(row.status)) {
      $("siResolutionInput").value = "";
    }

    if (reviewBtn) {
      reviewBtn.hidden = !canMarkInReview(row.status);
      reviewBtn.disabled = state.writing;
    }
    if (returnBtn) {
      returnBtn.hidden = row.status !== "in_review";
      returnBtn.disabled = state.writing;
    }
    if (requestBtn) {
      requestBtn.hidden = !canRequestAction(row.status);
      requestBtn.disabled = state.writing;
    }
    if (resolveBtn) {
      resolveBtn.hidden = !canResolve(row.status);
      resolveBtn.disabled = state.writing;
    }
    if (reopenBtn) {
      reopenBtn.hidden = row.status !== "resolved";
      reopenBtn.disabled = state.writing;
    }
    if (drawer) drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
  }

  function readTrimmed(id) {
    const el = $(id);
    return el ? String(el.value || "").trim() : "";
  }

  async function updateCase(action) {
    if (!state.selected || state.writing) return;
    const body = { case_id: state.selected.case_id, action: action };
    if (action === "request_customer_action") {
      const message = readTrimmed("siActionMessageInput");
      if (!message) {
        setNotice("Enter what the tenant needs to do before requesting customer action.");
        return;
      }
      body.tenant_action_message = message;
    }
    if (action === "resolve") {
      const resolution = readTrimmed("siResolutionInput");
      if (resolution) body.customer_resolution = resolution;
    }
    state.writing = true;
    renderDrawer();
    setNotice("");
    try {
      const res = await fetch(UPDATE_API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_err) {
        data = {};
      }
      if (data.result === "stale_state") {
        setNotice(String(data.error || "This support case was updated by another administrator. Showing the latest status."));
        await loadList();
        return;
      }
      if (!okResults[data.result]) {
        setNotice(String(data.error || "The support case could not be updated."));
        return;
      }
      await loadList();
    } finally {
      state.writing = false;
      renderDrawer();
    }
  }

  function syncFilterButtons() {
    Object.keys(FILTER_BUTTON_IDS).forEach(function (status) {
      const btn = $(FILTER_BUTTON_IDS[status]) || document.querySelector('.si-filters [data-status="' + status + '"]');
      if (!btn) return;
      btn.className = state.status === status ? "btn" : "btn ghost";
    });
  }

  function bind() {
    const list = $("siList");
    if (list) {
      list.addEventListener("click", function (ev) {
        const btn = ev.target.closest("[data-case-id]");
        if (!btn) return;
        const id = btn.getAttribute("data-case-id");
        state.selected = state.cases.find(function (row) {
          return row.case_id === id;
        }) || null;
        renderDrawer();
      });
    }
    Object.keys(FILTER_BUTTON_IDS).forEach(function (status) {
      const btn = $(FILTER_BUTTON_IDS[status]) || document.querySelector('.si-filters [data-status="' + status + '"]');
      if (!btn) return;
      btn.addEventListener("click", function () {
        state.status = status;
        syncFilterButtons();
        loadList();
      });
    });
    if ($("siCategory")) {
      $("siCategory").addEventListener("change", function (ev) {
        state.category = String(ev.target.value || "");
        loadList();
      });
    }
    if ($("siMarkInReview")) {
      $("siMarkInReview").addEventListener("click", function () {
        updateCase("mark_in_review");
      });
    }
    if ($("siReturnToOpen")) {
      $("siReturnToOpen").addEventListener("click", function () {
        updateCase("return_to_open");
      });
    }
    if ($("siRequestAction")) {
      $("siRequestAction").addEventListener("click", function () {
        updateCase("request_customer_action");
      });
    }
    if ($("siResolve")) {
      $("siResolve").addEventListener("click", function () {
        updateCase("resolve");
      });
    }
    if ($("siReopen")) {
      $("siReopen").addEventListener("click", function () {
        updateCase("reopen");
      });
    }
    function closeDrawer() {
      state.selected = null;
      renderDrawer();
    }
    if ($("siDrawerClose")) $("siDrawerClose").addEventListener("click", closeDrawer);
    if ($("siBackdrop")) $("siBackdrop").addEventListener("click", closeDrawer);
    if ($("siLogout")) {
      $("siLogout").addEventListener("click", async function () {
        try {
          await fetch("/.netlify/functions/logout", { method: "POST", credentials: "include", body: "{}" });
        } finally {
          window.location.href = "/index.html";
        }
      });
    }
  }

  async function boot() {
    bind();
    syncFilterButtons();
    let data;
    try {
      data = await authStatus();
    } catch (_err) {
      window.location.href = "/index.html?login=1";
      return;
    }
    if (!data || !data.active) {
      window.location.href = "/index.html?login=1";
      return;
    }
    if (data.is_admin !== true) {
      showDenied();
      return;
    }
    if ($("siMain")) $("siMain").hidden = false;
    await loadList();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
