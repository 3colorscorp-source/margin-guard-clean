(() => {
  "use strict";

  const API = "/.netlify/functions";
  const ASSIGNABLE_STATUSES = new Set([
    "signed",
    "assigned",
    "active",
    "in_progress",
    "approved",
    "deposit_paid",
  ]);
  const UNLINKED_SUPERVISOR_WARNING =
    "This supervisor is not linked to a login yet. Create/link the supervisor Auth user before assigning projects.";

  const state = {
    projects: [],
    supervisors: [],
    busy: false,
    initialized: false,
  };

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

  function norm(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function isDeviceMode() {
    if (window.MGSupervisorDevicePortal?.isDeviceMode?.()) return true;
    if (document.documentElement.dataset.authMode === "device") return true;
    if (window.MG_SUPERVISOR_PORTAL_MODE === "device") return true;
    return false;
  }

  function isOwnerMode() {
    if (isDeviceMode()) return false;
    if (document.documentElement.dataset.authMode === "owner") return true;
    if (window.MG_SUPERVISOR_PORTAL_MODE === "owner") return true;
    return false;
  }

  function hidePanel() {
    const panel = $("supOwnerAssignPanel");
    if (panel) {
      panel.setAttribute("hidden", "");
      panel.setAttribute("aria-hidden", "true");
    }
  }

  async function api(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_err) {
      data = {};
    }
    return { response, data };
  }

  function supervisorCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function isSupervisorLinked(row) {
    return row?.auth_linked === true;
  }

  function supervisorName(row) {
    const display = String(row?.display_name || row?.full_name || "").trim();
    const email = String(row?.email || "").trim();
    return display || email || "Supervisor";
  }

  function supervisorLabel(row) {
    const display = String(row?.display_name || row?.full_name || "").trim();
    const email = String(row?.email || "").trim();
    if (display && email) return `${display} · ${email}`;
    return display || email || "Supervisor";
  }

  function supervisorDropdownLabel(row) {
    const linked = isSupervisorLinked(row);
    const projects = supervisorCount(row?.assigned_project_count);
    const devices = supervisorCount(row?.active_device_count);
    const authLabel = linked ? "linked" : "auth not linked";
    const projectWord = projects === 1 ? "project" : "projects";
    const deviceWord = devices === 1 ? "device" : "devices";
    return `${supervisorName(row)} — ${authLabel} — ${projects} ${projectWord} — ${devices} ${deviceWord}`;
  }

  function projectLabel(row) {
    const name = String(row?.projectName || "").trim() || "Project";
    const client = String(row?.clientName || "").trim();
    const status = String(row?.status || "").trim();
    const parts = [name];
    if (client) parts.push(client);
    if (status) parts.push(`(${status})`);
    return parts.join(" · ");
  }

  function setFeedback(message, tone) {
    const el = $("supOwnerAssignFeedback");
    if (!el) return;
    el.textContent = message || "";
    el.classList.remove("is-ok", "is-err", "is-warn");
    if (tone === "ok") el.classList.add("is-ok");
    if (tone === "err") el.classList.add("is-err");
    if (tone === "warn") el.classList.add("is-warn");
  }

  function safeErrorMessage(data, fallback) {
    const code = String(data?.code || "").trim();
    if (code === "no_owner_session" || code === "owner_membership_required") {
      return "Owner session required.";
    }
    if (code === "supervisor_active_required" || code === "membership_inactive") {
      return "Supervisor must be active.";
    }
    if (code === "supervisor_auth_user_id_missing") {
      return "Supervisor must sign in once before assignment.";
    }
    if (code === "project_not_assignable") {
      return "Project is not in an assignable status.";
    }
    if (code === "supervisor_not_found" || code === "supervisor_role_required") {
      return "Selected supervisor is not valid.";
    }
    if (code === "project_not_found") {
      return "Selected project was not found.";
    }
    if (code === "assignment_failed") {
      return "Assignment failed. Try again.";
    }
    if (data?.error) return String(data.error);
    return fallback;
  }

  function selectedSupervisorRow() {
    const select = $("supOwnerAssignSupervisor");
    const id = String(select?.value || "").trim();
    if (!id) return null;
    return state.supervisors.find((m) => String(m.id) === id) || null;
  }

  function updateAssignGuard() {
    const btn = $("supOwnerAssignBtn");
    const row = selectedSupervisorRow();
    const blocked = Boolean(row && !isSupervisorLinked(row));

    if (btn) btn.disabled = state.busy || blocked;

    if (blocked) {
      setFeedback(UNLINKED_SUPERVISOR_WARNING, "warn");
      return;
    }

    const el = $("supOwnerAssignFeedback");
    if (el?.classList.contains("is-warn")) {
      setFeedback("", null);
    }
  }

  function renderProjectOptions() {
    const select = $("supOwnerAssignProject");
    if (!select) return;

    const current = select.value;
    const options = ['<option value="">Select a project…</option>'];

    for (const row of state.projects) {
      if (!row?.id) continue;
      const status = norm(row.status);
      if (status && !ASSIGNABLE_STATUSES.has(status)) continue;
      options.push(
        `<option value="${escapeHtml(row.id)}">${escapeHtml(projectLabel(row))}</option>`
      );
    }

    select.innerHTML = options.join("");
    if (current && [...select.options].some((opt) => opt.value === current)) {
      select.value = current;
    }
  }

  function renderSupervisorOptions() {
    const select = $("supOwnerAssignSupervisor");
    if (!select) return;

    const current = select.value;
    const options = ['<option value="">Select a supervisor…</option>'];

    for (const row of state.supervisors) {
      if (!row?.id) continue;
      const linked = isSupervisorLinked(row);
      options.push(
        `<option value="${escapeHtml(row.id)}"${linked ? "" : " disabled"}>${escapeHtml(supervisorDropdownLabel(row))}</option>`
      );
    }

    select.innerHTML = options.join("");
    if (current && [...select.options].some((opt) => opt.value === current && !opt.disabled)) {
      select.value = current;
    } else if (
      current &&
      [...select.options].some((opt) => opt.value === current && opt.disabled)
    ) {
      select.value = "";
    }
    updateAssignGuard();
  }

  async function loadProjects() {
    const { response, data } = await api("/get-supervisor-projects", { method: "GET" });
    if (!response.ok || data.ok !== true) {
      throw new Error(safeErrorMessage(data, "Could not load projects."));
    }
    state.projects = Array.isArray(data.projects) ? data.projects : [];
    renderProjectOptions();
  }

  async function loadSupervisors() {
    const { response, data } = await api(
      "/list-tenant-memberships?role=supervisor&status=active",
      { method: "GET" }
    );
    if (!response.ok || data.ok !== true) {
      throw new Error(safeErrorMessage(data, "Could not load supervisors."));
    }
    state.supervisors = Array.isArray(data.memberships) ? data.memberships : [];
    renderSupervisorOptions();
  }

  async function refreshLists() {
    await Promise.all([loadProjects(), loadSupervisors()]);
  }

  async function refreshSupervisorProjectPicker() {
    if (typeof window.refreshSupervisorProjectsFromApi !== "function") return;
    try {
      await window.refreshSupervisorProjectsFromApi();
    } catch (_err) {
      console.warn("Supervisor project picker refresh failed.");
    }
  }

  function selectedProjectSummary() {
    const select = $("supOwnerAssignProject");
    const id = String(select?.value || "").trim();
    if (!id) return null;
    const row = state.projects.find((p) => String(p.id) === id);
    if (!row) return { name: "Selected project" };
    return {
      name: String(row.projectName || "").trim() || "Selected project",
      client: String(row.clientName || "").trim(),
      status: String(row.status || "").trim(),
    };
  }

  function selectedSupervisorSummary() {
    const row = selectedSupervisorRow();
    if (!row) return null;
    return {
      label: supervisorLabel(row),
      display: String(row.display_name || row.full_name || "").trim(),
      email: String(row.email || "").trim(),
    };
  }

  async function handleAssign() {
    if (state.busy || isDeviceMode() || !isOwnerMode()) return;

    const projectId = String($("supOwnerAssignProject")?.value || "").trim();
    const supervisorMembershipId = String(
      $("supOwnerAssignSupervisor")?.value || ""
    ).trim();

    if (!projectId) {
      setFeedback("Select a project first.", "err");
      return;
    }
    if (!supervisorMembershipId) {
      setFeedback("Select a supervisor first.", "err");
      return;
    }

    const supervisorRow = selectedSupervisorRow();
    if (!supervisorRow || !isSupervisorLinked(supervisorRow)) {
      setFeedback(UNLINKED_SUPERVISOR_WARNING, "warn");
      return;
    }

    const project = selectedProjectSummary();
    const supervisor = selectedSupervisorSummary();
    const confirmText =
      "Assign this project to this supervisor? This changes the supervisor assignment for the selected project.";
    if (!window.confirm(confirmText)) return;

    const btn = $("supOwnerAssignBtn");
    state.busy = true;
    if (btn) btn.disabled = true;
    setFeedback("Assigning…", null);

    try {
      const { response, data } = await api("/assign-project-to-supervisor", {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId,
          supervisor_membership_id: supervisorMembershipId,
        }),
      });

      if (!response.ok || data.ok !== true) {
        if (response.status === 401 || response.status === 403) {
          setFeedback(safeErrorMessage(data, "Unauthorized."), "err");
          return;
        }
        setFeedback(safeErrorMessage(data, "Assignment failed."), "err");
        return;
      }

      const projectName =
        String(data.project?.name || "").trim() || project?.name || "Project";
      const supervisorName =
        String(data.supervisor?.display_name || "").trim() ||
        supervisor?.display ||
        String(data.supervisor?.email || "").trim() ||
        supervisor?.label ||
        "Supervisor";

      setFeedback(`Assigned ${projectName} to ${supervisorName}.`, "ok");
      await loadProjects();
      await loadSupervisors();
      await refreshSupervisorProjectPicker();
    } catch (_err) {
      setFeedback("Network error. Try again.", "err");
    } finally {
      state.busy = false;
      updateAssignGuard();
    }
  }

  function bindEvents() {
    $("supOwnerAssignBtn")?.addEventListener("click", () => {
      void handleAssign();
    });

    $("supOwnerAssignSupervisor")?.addEventListener("change", () => {
      updateAssignGuard();
    });

    document.addEventListener("device-auth-ready", hidePanel, { once: true });
  }

  async function waitForOwnerMode(timeoutMs = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (isDeviceMode()) return false;
      if (isOwnerMode()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (isDeviceMode()) return false;
    const { response, data } = await api("/auth-status", { method: "GET" });
    return response.ok && data.active === true && !isDeviceMode();
  }

  async function init() {
    if (state.initialized) return;
    if (document.body?.dataset?.supervisorDualAuth !== "true") return;

    const ready = await waitForOwnerMode();
    if (!ready || isDeviceMode()) {
      hidePanel();
      return;
    }

    const panel = $("supOwnerAssignPanel");
    if (!panel) return;

    panel.removeAttribute("hidden");
    panel.setAttribute("aria-hidden", "false");
    state.initialized = true;
    bindEvents();

    try {
      setFeedback("Loading assignment options…", null);
      await refreshLists();
      setFeedback("", null);
    } catch (err) {
      setFeedback(err.message || "Could not load assignment options.", "err");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void init();
    });
  } else {
    void init();
  }
})();
