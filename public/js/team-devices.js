(() => {
  "use strict";

  const API = "/.netlify/functions";
  const PROTECTED_ROLES = new Set(["owner", "admin"]);
  const MANAGED_ROLES = new Set(["seller", "supervisor"]);

  const state = {
    memberships: [],
    devices: [],
    pairingCode: null,
    inviteInFlight: false,
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

  function memberDisplayName(row) {
    const display = String(row?.display_name || "").trim();
    const full = String(row?.full_name || "").trim();
    return display || full || row?.email || "—";
  }

  function formatDate(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function formatDateTime(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function statusBadge(status) {
    const s = norm(status);
    let tone = "amber";
    if (s === "active") tone = "green";
    else if (s === "removed" || s === "revoked") tone = "red";
    else if (s === "suspended" || s === "pending_pair") tone = "amber";
    else if (s === "invited") tone = "blue";
    return `<span class="badge ${tone}">${escapeHtml(status || "—")}</span>`;
  }

  function supervisorCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function supervisorReadinessCell(row) {
    if (norm(row?.role) !== "supervisor") return "—";

    const linked = row.auth_linked === true;
    const projectCount = supervisorCount(row.assigned_project_count);
    const deviceCount = supervisorCount(row.active_device_count);
    const authBadge = linked
      ? '<span class="badge green">Auth linked</span>'
      : '<span class="badge amber">Auth not linked</span>';

    return `
      <div class="td-readiness">
        ${authBadge}
        <span class="td-readiness__counts">Projects: ${projectCount} · Devices: ${deviceCount}</span>
      </div>
    `;
  }

  function apiErrorMessage(data, fallback) {
    if (!data || typeof data !== "object") return fallback;
    if (data.error && data.code) return `${data.error} (${data.code})`;
    if (data.error) return String(data.error);
    if (data.code) return String(data.code);
    return fallback;
  }

  async function apiRequest(path, options) {
    const response = await fetch(`${API}${path}`, {
      credentials: "include",
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options?.headers || {}),
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

  function showNotice(message, type) {
    const el = $("tdNotice");
    if (!el) return;
    if (!message) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.classList.remove("ok", "err", "info");
    if (type === "err") el.classList.add("err");
    else if (type === "info") el.classList.add("info");
    else el.classList.add("ok");
  }

  function canInviteSupervisor(row) {
    return (
      norm(row?.role) === "supervisor" &&
      norm(row?.status) === "active" &&
      row?.auth_linked !== true
    );
  }

  function inviteErrorMessage(data, fallback) {
    const code = String(data?.error || data?.code || "").trim();
    if (code === "missing_membership_id") {
      return "Could not send invite. Refresh and try again.";
    }
    if (code === "membership_not_found") {
      return "Supervisor membership was not found. Refresh and try again.";
    }
    if (code === "not_supervisor_membership") {
      return "Only supervisor memberships can receive a login invite.";
    }
    if (code === "membership_not_active") {
      return "Supervisor membership must be active before sending an invite.";
    }
    if (code === "membership_email_missing") {
      return "This supervisor membership has no valid email for an invite.";
    }
    if (code === "auth_lookup_failed") {
      return "Could not verify login status. Try again later.";
    }
    if (code === "invite_failed") {
      return "Could not send login invite. Try again later.";
    }
    if (
      code === "no_owner_session" ||
      code === "owner_membership_required" ||
      code === "owner_required" ||
      code === "unauthorized"
    ) {
      return "Owner session required.";
    }
    if (code === "method_not_allowed") {
      return "Invite request was not accepted.";
    }
    return fallback;
  }

  function openModal(modal) {
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
  }

  function activeManagedMemberships(portalType) {
    const portal = norm(portalType);
    return state.memberships.filter(
      (m) =>
        MANAGED_ROLES.has(norm(m.role)) &&
        norm(m.status) === "active" &&
        (!portal || norm(m.role) === portal)
    );
  }

  function updateCreateDeviceButton() {
    const btn = $("tdBtnCreateDevice");
    if (!btn) return;
    const hasAssignable = activeManagedMemberships("").length > 0;
    btn.disabled = !hasAssignable;
    btn.title = hasAssignable
      ? "Create a portal device"
      : "Requires an active seller or supervisor membership";
  }

  function buildMembershipQuery() {
    const role = norm($("tdFilterRole")?.value);
    const status = norm($("tdFilterStatus")?.value);
    const params = new URLSearchParams();
    if (role) params.set("role", role);
    if (status) params.set("status", status);
    const qs = params.toString();
    return `/list-tenant-memberships${qs ? `?${qs}` : ""}`;
  }

  async function loadMemberships() {
    const { response, data } = await apiRequest(buildMembershipQuery(), { method: "GET" });
    if (!response.ok || data.ok !== true) {
      showNotice(apiErrorMessage(data, "Could not load memberships."), "err");
      state.memberships = [];
      renderMembersTable();
      updateCreateDeviceButton();
      return;
    }
    state.memberships = Array.isArray(data.memberships) ? data.memberships : [];
    renderMembersTable();
    updateCreateDeviceButton();
    populateDeviceMemberDropdown();
  }

  async function loadDevices() {
    const { response, data } = await apiRequest("/list-tenant-devices", { method: "GET" });
    if (!response.ok || data.ok !== true) {
      showNotice(apiErrorMessage(data, "Could not load devices."), "err");
      state.devices = [];
      renderDevicesTable();
      return;
    }
    state.devices = Array.isArray(data.devices) ? data.devices : [];
    renderDevicesTable();
  }

  function renderMembersTable() {
    const body = $("tdMembersBody");
    const empty = $("tdMembersEmpty");
    const wrap = $("tdMembersTableWrap");
    if (!body) return;

    const rows = state.memberships;
    if (!rows.length) {
      body.innerHTML = "";
      if (empty) empty.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }

    if (empty) empty.hidden = true;
    if (wrap) wrap.hidden = false;

    body.innerHTML = rows
      .map((row) => {
        const role = norm(row.role);
        const status = norm(row.status);
        const protectedRow = PROTECTED_ROLES.has(role);
        let actionsHtml = `<span class="td-protected">Protected</span>`;

        if (!protectedRow && MANAGED_ROLES.has(role)) {
          const parts = [];
          if (canInviteSupervisor(row)) {
            const inviteDisabled = state.inviteInFlight ? " disabled" : "";
            parts.push(
              `<button type="button" class="btn primary" data-td-action="invite-login" data-td-id="${escapeHtml(row.id)}"${inviteDisabled}>Send login invite</button>`
            );
          }
          if (status === "active") {
            parts.push(
              `<button type="button" class="btn ghost" data-td-action="suspend" data-td-id="${escapeHtml(row.id)}">Suspend</button>`
            );
          }
          if (status === "suspended" || status === "removed") {
            parts.push(
              `<button type="button" class="btn ghost" data-td-action="reactivate" data-td-id="${escapeHtml(row.id)}">Reactivate</button>`
            );
          }
          if (status !== "removed") {
            parts.push(
              `<button type="button" class="btn danger" data-td-action="remove" data-td-id="${escapeHtml(row.id)}">Remove</button>`
            );
          }
          actionsHtml = `<div class="td-row-actions">${parts.join("")}</div>`;
        }

        return `
          <tr>
            <td>${escapeHtml(memberDisplayName(row))}</td>
            <td>${escapeHtml(row.email || "—")}</td>
            <td>${escapeHtml(row.role || "—")}</td>
            <td>${statusBadge(row.status)}</td>
            <td>${supervisorReadinessCell(row)}</td>
            <td>${escapeHtml(formatDate(row.created_at))}</td>
            <td>${actionsHtml}</td>
          </tr>
        `;
      })
      .join("");

    body.querySelectorAll("button[data-td-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-td-action");
        const id = btn.getAttribute("data-td-id");
        if (!id) return;
        if (action === "invite-login") {
          void handleSupervisorInvite(id);
          return;
        }
        void handleMemberAction(action, id);
      });
    });
  }

  async function handleSupervisorInvite(membershipId) {
    if (state.inviteInFlight) return;

    const row = state.memberships.find((m) => String(m.id) === String(membershipId));
    if (!row || !canInviteSupervisor(row)) {
      showNotice("This supervisor is not eligible for a login invite.", "info");
      return;
    }

    const ok = window.confirm("Send a login invite to this supervisor?");
    if (!ok) return;

    state.inviteInFlight = true;
    renderMembersTable();

    try {
      const { response, data } = await apiRequest("/invite-supervisor-auth", {
        method: "POST",
        body: JSON.stringify({ membership_id: membershipId }),
      });

      if (!response.ok || data.ok !== true) {
        showNotice(
          inviteErrorMessage(data, "Could not send login invite."),
          "err"
        );
        return;
      }

      const status = String(data.status || "").trim();
      if (status === "invite_sent") {
        showNotice(
          "Login invite sent. Ask the supervisor to check their email.",
          "ok"
        );
      } else if (status === "already_linked") {
        showNotice("This supervisor is already linked.", "info");
      } else if (status === "auth_user_exists_link_pending") {
        showNotice(
          "An Auth user already exists for this supervisor. Ask them to complete login so the profile can link automatically.",
          "info"
        );
      } else {
        showNotice("Invite request completed.", "ok");
      }

      await loadMemberships();
    } catch (_err) {
      showNotice("Network error. Try again.", "err");
    } finally {
      state.inviteInFlight = false;
      renderMembersTable();
    }
  }

  function renderDevicesTable() {
    const body = $("tdDevicesBody");
    const empty = $("tdDevicesEmpty");
    const wrap = $("tdDevicesTableWrap");
    if (!body) return;

    const rows = state.devices;
    if (!rows.length) {
      body.innerHTML = "";
      if (empty) empty.hidden = false;
      if (wrap) wrap.hidden = true;
      return;
    }

    if (empty) empty.hidden = true;
    if (wrap) wrap.hidden = false;

    body.innerHTML = rows
      .map((row) => {
        const assigned = row.assigned_membership;
        const assignedLabel = assigned
          ? memberDisplayName(assigned) + (assigned.email ? ` (${assigned.email})` : "")
          : "—";
        const status = norm(row.status);
        const canManage = status !== "revoked";
        const actions = canManage
          ? `<div class="td-row-actions">
              <button type="button" class="btn ghost" data-td-device-action="reset" data-td-device-id="${escapeHtml(row.id)}">Reset Pairing</button>
              <button type="button" class="btn danger" data-td-device-action="revoke" data-td-device-id="${escapeHtml(row.id)}">Revoke</button>
            </div>`
          : `<span class="td-protected">Revoked</span>`;

        return `
          <tr>
            <td>${escapeHtml(row.display_name || "—")}</td>
            <td>${escapeHtml(row.portal_type || "—")}</td>
            <td>${escapeHtml(assignedLabel)}</td>
            <td>${statusBadge(row.status)}</td>
            <td>${escapeHtml(formatDateTime(row.last_seen_at))}</td>
            <td>${actions}</td>
          </tr>
        `;
      })
      .join("");

    body.querySelectorAll("button[data-td-device-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-td-device-action");
        const id = btn.getAttribute("data-td-device-id");
        if (!id) return;
        if (action === "reset") void handleResetPairing(id);
        if (action === "revoke") void handleRevokeDevice(id);
      });
    });
  }

  async function handleMemberAction(action, membershipId) {
    const row = state.memberships.find((m) => m.id === membershipId);
    const label = row ? memberDisplayName(row) : "this member";

    if (action === "remove") {
      const ok = window.confirm(
        `Remove ${label}? This will revoke assigned devices and active sessions.`
      );
      if (!ok) return;
    }

    let status;
    if (action === "suspend") status = "suspended";
    else if (action === "reactivate") status = "active";
    else if (action === "remove") status = "removed";
    else return;

    const { response, data } = await apiRequest("/update-tenant-membership", {
      method: "POST",
      body: JSON.stringify({ membership_id: membershipId, status }),
    });

    if (!response.ok || data.ok !== true) {
      showNotice(apiErrorMessage(data, "Membership update failed."), "err");
      return;
    }

    showNotice(`Membership updated (${status}).`, "ok");
    await loadMemberships();
    await loadDevices();
  }

  async function handleResetPairing(deviceId) {
    const errEl = $("tdPairingError");
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = "";
    }

    const { response, data } = await apiRequest("/reset-tenant-device-pairing", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId }),
    });

    if (!response.ok || data.ok !== true || !data.pairing_code) {
      showNotice(apiErrorMessage(data, "Could not reset pairing."), "err");
      return;
    }

    state.pairingCode = String(data.pairing_code);
    const codeEl = $("tdPairingCode");
    if (codeEl) codeEl.textContent = state.pairingCode;
    openModal($("tdPairingModal"));
    showNotice("Pairing code generated. Share it with the assigned device only.", "ok");
    await loadDevices();
  }

  function clearPairingModal() {
    state.pairingCode = null;
    const codeEl = $("tdPairingCode");
    if (codeEl) codeEl.textContent = "";
    const errEl = $("tdPairingError");
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = "";
    }
  }

  async function handleRevokeDevice(deviceId) {
    const row = state.devices.find((d) => d.id === deviceId);
    const label = row?.display_name || "this device";
    const ok = window.confirm(`Revoke ${label}? Active sessions on this device will be revoked.`);
    if (!ok) return;

    const { response, data } = await apiRequest("/revoke-tenant-device", {
      method: "POST",
      body: JSON.stringify({ device_id: deviceId }),
    });

    if (!response.ok || data.ok !== true) {
      showNotice(apiErrorMessage(data, "Could not revoke device."), "err");
      return;
    }

    showNotice("Device revoked.", "ok");
    await loadDevices();
  }

  function populateDeviceMemberDropdown() {
    const portalSel = $("tdDevicePortalType");
    const memberSel = $("tdDeviceMember");
    if (!portalSel || !memberSel) return;

    const portal = norm(portalSel.value) || "seller";
    const options = activeManagedMemberships(portal);
    memberSel.innerHTML = options
      .map(
        (m) =>
          `<option value="${escapeHtml(m.id)}">${escapeHtml(memberDisplayName(m))} (${escapeHtml(m.email || "")})</option>`
      )
      .join("");

    if (!options.length) {
      memberSel.innerHTML = `<option value="">No active ${portal} memberships</option>`;
    }
  }

  function openCreateMemberModal() {
    $("tdMemberEmail").value = "";
    $("tdMemberRole").value = "seller";
    $("tdMemberDisplayName").value = "";
    $("tdMemberFullName").value = "";
    const err = $("tdCreateMemberError");
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    openModal($("tdCreateMemberModal"));
  }

  function openCreateDeviceModal() {
    populateDeviceMemberDropdown();
    $("tdDevicePortalType").value = "seller";
    populateDeviceMemberDropdown();
    $("tdDeviceDisplayName").value = "";
    const err = $("tdCreateDeviceError");
    if (err) {
      err.hidden = true;
      err.textContent = "";
    }
    openModal($("tdCreateDeviceModal"));
  }

  async function submitCreateMember() {
    const err = $("tdCreateMemberError");
    const email = String($("tdMemberEmail")?.value || "").trim();
    const role = norm($("tdMemberRole")?.value);
    const display_name = String($("tdMemberDisplayName")?.value || "").trim();
    const full_name = String($("tdMemberFullName")?.value || "").trim();

    if (!email) {
      if (err) {
        err.hidden = false;
        err.textContent = "Email is required.";
      }
      return;
    }

    const { response, data } = await apiRequest("/create-tenant-membership", {
      method: "POST",
      body: JSON.stringify({ email, role, display_name, full_name }),
    });

    if (!response.ok || data.ok !== true) {
      const message = apiErrorMessage(data, "Could not create membership.");
      if (err) {
        err.hidden = false;
        err.textContent = message;
      }
      return;
    }

    closeModal($("tdCreateMemberModal"));
    showNotice("Member created.", "ok");
    await loadMemberships();
    await loadDevices();
  }

  async function submitCreateDevice() {
    const err = $("tdCreateDeviceError");
    const portal_type = norm($("tdDevicePortalType")?.value);
    const assigned_membership_id = String($("tdDeviceMember")?.value || "").trim();
    const display_name = String($("tdDeviceDisplayName")?.value || "").trim();

    if (!assigned_membership_id) {
      if (err) {
        err.hidden = false;
        err.textContent = "Select an active assigned member.";
      }
      return;
    }

    const { response, data } = await apiRequest("/create-tenant-device", {
      method: "POST",
      body: JSON.stringify({ portal_type, assigned_membership_id, display_name }),
    });

    if (!response.ok || data.ok !== true) {
      const message = apiErrorMessage(data, "Could not create device.");
      if (err) {
        err.hidden = false;
        err.textContent = message;
      }
      return;
    }

    closeModal($("tdCreateDeviceModal"));
    showNotice("Device created.", "ok");
    await loadDevices();
  }

  function bindUi() {
    $("tdBtnRefreshMembers")?.addEventListener("click", () => {
      void loadMemberships();
    });
    $("tdBtnRefreshDevices")?.addEventListener("click", () => {
      void loadDevices();
    });
    $("tdFilterRole")?.addEventListener("change", () => {
      void loadMemberships();
    });
    $("tdFilterStatus")?.addEventListener("change", () => {
      void loadMemberships();
    });

    $("tdBtnCreateMember")?.addEventListener("click", openCreateMemberModal);
    $("tdCreateMemberClose")?.addEventListener("click", () => closeModal($("tdCreateMemberModal")));
    $("tdCreateMemberCancel")?.addEventListener("click", () => closeModal($("tdCreateMemberModal")));
    $("tdCreateMemberSubmit")?.addEventListener("click", () => {
      void submitCreateMember();
    });

    $("tdBtnCreateDevice")?.addEventListener("click", openCreateDeviceModal);
    $("tdCreateDeviceClose")?.addEventListener("click", () => closeModal($("tdCreateDeviceModal")));
    $("tdCreateDeviceCancel")?.addEventListener("click", () => closeModal($("tdCreateDeviceModal")));
    $("tdCreateDeviceSubmit")?.addEventListener("click", () => {
      void submitCreateDevice();
    });
    $("tdDevicePortalType")?.addEventListener("change", populateDeviceMemberDropdown);

    $("tdPairingClose")?.addEventListener("click", () => {
      clearPairingModal();
      closeModal($("tdPairingModal"));
    });
    $("tdPairingDone")?.addEventListener("click", () => {
      clearPairingModal();
      closeModal($("tdPairingModal"));
    });
    $("tdPairingCopy")?.addEventListener("click", async () => {
      const errEl = $("tdPairingError");
      if (!state.pairingCode) return;
      try {
        await navigator.clipboard.writeText(state.pairingCode);
        showNotice("Pairing code copied to clipboard.", "ok");
      } catch (_err) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = "Could not copy automatically. Select and copy the code manually.";
        }
      }
    });

    [$("tdCreateMemberModal"), $("tdCreateDeviceModal"), $("tdPairingModal")].forEach((modal) => {
      modal?.addEventListener("click", (event) => {
        if (event.target === modal) {
          if (modal.id === "tdPairingModal") clearPairingModal();
          closeModal(modal);
        }
      });
    });
  }

  async function initWhenReady() {
    if (!document.body.classList.contains("auth-ready")) {
      window.setTimeout(initWhenReady, 50);
      return;
    }
    bindUi();
    await loadMemberships();
    await loadDevices();
  }

  document.addEventListener("DOMContentLoaded", () => {
    void initWhenReady();
  });
})();
