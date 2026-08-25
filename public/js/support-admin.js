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

  const state = {
    status: "open",
    category: "",
    cases: [],
    selected: null,
    writing: false,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function categoryLabel(value) {
    return CATEGORY_LABELS[value] || "Other";
  }

  function moduleLabel(value) {
    return MODULE_LABELS[value] || String(value || "Unknown");
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

  async function loadList() {
    setNotice("");
    const list = $("siList");
    if (list) list.innerHTML = '<div class="si-loading">Loading support cases…</div>';
    const res = await fetch(buildListUrl(), { credentials: "include" });
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    if (!res.ok || !data.ok) {
      state.cases = [];
      if (list) list.innerHTML = "";
      setNotice(String(data.error || "Support cases could not be loaded."));
      return;
    }
    state.cases = Array.isArray(data.cases) ? data.cases : [];
    const counts = data.counts || {};
    if ($("siCountOpen")) $("siCountOpen").textContent = String(counts.open ?? "—");
    if ($("siCountResolved")) $("siCountResolved").textContent = String(counts.resolved ?? "—");
    if ($("siCountTotal")) $("siCountTotal").textContent = String(counts.total ?? "—");
    renderList();
    if (state.selected) {
      const fresh = state.cases.find(function (row) {
        return row.case_id === state.selected.case_id;
      });
      if (fresh) {
        state.selected = fresh;
        renderDrawer();
      }
    }
  }

  function renderList() {
    const list = $("siList");
    if (!list) return;
    if (!state.cases.length) {
      list.innerHTML = '<div class="si-empty">No support cases in this view.</div>';
      return;
    }
    list.innerHTML = state.cases
      .map(function (row) {
        return (
          '<button type="button" class="si-row" data-case-id="' +
          escapeHtml(row.case_id) +
          '">' +
          '<div class="si-row__top">' +
          "<strong>" +
          escapeHtml(row.case_ref) +
          "</strong>" +
          '<span class="si-badge">' +
          escapeHtml(row.status) +
          "</span>" +
          "</div>" +
          "<div>" +
          escapeHtml(row.tenant_business_name) +
          "</div>" +
          "<div>" +
          escapeHtml(row.subject) +
          "</div>" +
          '<div class="si-row__meta">' +
          escapeHtml(categoryLabel(row.category)) +
          " · " +
          escapeHtml(moduleLabel(row.support_module)) +
          " · " +
          escapeHtml(formatWhen(row.created_at)) +
          "</div>" +
          "</button>"
        );
      })
      .join("");
  }

  function dl(label, value) {
    return (
      "<div><dt>" +
      escapeHtml(label) +
      "</dt><dd>" +
      value +
      "</dd></div>"
    );
  }

  function renderDrawer() {
    const row = state.selected;
    const drawer = $("siDrawer");
    const backdrop = $("siBackdrop");
    const resolveBtn = $("siResolve");
    const reopenBtn = $("siReopen");
    if (!row) {
      if (drawer) drawer.hidden = true;
      if (backdrop) backdrop.hidden = true;
      return;
    }
    if ($("siDrawerTitle")) $("siDrawerTitle").textContent = row.case_ref;
    const related =
      row.related_entity_type && row.related_entity_type !== "none"
        ? escapeHtml(row.related_entity_type) +
          (row.related_entity_ref ? " · " + escapeHtml(row.related_entity_ref) : "")
        : "None";
    if ($("siDrawerBody")) {
      $("siDrawerBody").innerHTML =
        dl("Case ref", escapeHtml(row.case_ref)) +
        dl("Tenant business", escapeHtml(row.tenant_business_name)) +
        dl("Status", escapeHtml(row.status)) +
        dl("Category", escapeHtml(categoryLabel(row.category))) +
        dl("Subject", escapeHtml(row.subject)) +
        dl("Question", '<span class="si-excerpt">' + escapeHtml(row.question_excerpt || "") + "</span>") +
        dl("Module", escapeHtml(moduleLabel(row.support_module))) +
        dl("Page", escapeHtml(row.page_path || "—")) +
        dl("Related entity", related) +
        dl("Created", escapeHtml(formatWhen(row.created_at))) +
        dl("Updated", escapeHtml(formatWhen(row.updated_at))) +
        dl("Resolved", escapeHtml(formatWhen(row.resolved_at)));
    }
    if (resolveBtn) {
      resolveBtn.hidden = row.status !== "open";
      resolveBtn.disabled = state.writing;
    }
    if (reopenBtn) {
      reopenBtn.hidden = row.status !== "resolved";
      reopenBtn.disabled = state.writing;
    }
    if (drawer) drawer.hidden = false;
    if (backdrop) backdrop.hidden = false;
  }

  async function updateCase(action) {
    if (!state.selected || state.writing) return;
    state.writing = true;
    renderDrawer();
    setNotice("");
    try {
      const res = await fetch(UPDATE_API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: state.selected.case_id, action: action }),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_err) {
        data = {};
      }
      const okResults = { resolved: true, reopened: true, already_resolved: true, already_open: true };
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
    ["open", "resolved", "all"].forEach(function (status) {
      const id = status === "open" ? "siFilterOpen" : status === "resolved" ? "siFilterResolved" : "siFilterAll";
      const btn = $(id);
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
    if ($("siFilterOpen")) {
      $("siFilterOpen").addEventListener("click", function () {
        state.status = "open";
        syncFilterButtons();
        loadList();
      });
    }
    if ($("siFilterResolved")) {
      $("siFilterResolved").addEventListener("click", function () {
        state.status = "resolved";
        syncFilterButtons();
        loadList();
      });
    }
    if ($("siFilterAll")) {
      $("siFilterAll").addEventListener("click", function () {
        state.status = "all";
        syncFilterButtons();
        loadList();
      });
    }
    if ($("siCategory")) {
      $("siCategory").addEventListener("change", function (ev) {
        state.category = String(ev.target.value || "");
        loadList();
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
