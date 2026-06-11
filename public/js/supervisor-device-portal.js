(() => {
  "use strict";

  const API = "/.netlify/functions";
  const SUPERVISOR_NOTICE =
    "Supervisor Device Shell — read-only project list and operational snapshot are enabled. Field reports and expenses remain locked until the next approved phase.";
  const BLOCKED_FETCH_MSG =
    "Supervisor device endpoint blocked until approved. Read access is limited to project list and operational snapshot only.";
  const BLOCKED_CONTROL_MSG =
    "Field actions are disabled in supervisor device shell mode until a later approved phase.";

  const ALLOWED_DEVICE_READ_RES = [
    /\/get-supervisor-projects(?:\?|$|\/)/i,
    /\/get-supervisor-operational-snapshot(?:\?|$|\/)/i,
  ];

  const ALWAYS_BLOCKED_ENDPOINT_RES = [
    /\/save-project-/i,
    /\/assign-supervisor-project/i,
    /\/get-project-/i,
    /\/send-quote-zapier/i,
    /\/publish-public-quote/i,
    /\/upsert-tenant-project/i,
  ];

  const BLOCKED_CONTROL_IDS = new Set([
    "btnManagePlan",
    "btnLogout",
    "supAssignToMeBtn",
    "btnSupMarkDayCompleted",
    "btnSupReopenDay",
    "btnSupDayReportLabor",
    "btnSupDayReportExpense",
    "btnAddSupEntry",
    "btnAddSupExtra",
    "btnSupViewExpenses",
    "btnSupPrintExpenseSummary",
    "supOpExpenseCountCard",
  ]);

  let deviceModeActive = false;
  let clickGuardInstalled = false;
  let fetchGuardInstalled = false;
  let initPromise = null;

  async function api(path, options = {}) {
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

  function membershipLabel(auth) {
    const m = auth?.membership;
    if (!m || typeof m !== "object") return "Supervisor device";
    return (
      String(m.display_name || m.full_name || m.email || "").trim() ||
      "Supervisor device"
    );
  }

  function tenantLabel(auth) {
    const t = auth?.tenant;
    if (!t || typeof t !== "object") return "";
    return String(t.name || t.slug || "").trim();
  }

  function paintOwnerAccount(data) {
    const email = document.getElementById("accountEmail");
    if (email) email.textContent = data.email || "Cuenta activa";

    const plan = document.getElementById("planStatus");
    if (plan) {
      if (data.is_admin) {
        plan.textContent = "Acceso admin (sin suscripción requerida)";
      } else {
        const renewText = data.renewsAt
          ? new Date(data.renewsAt).toLocaleDateString()
          : "";
        plan.textContent = renewText
          ? `Plan anual activo · Renueva ${renewText}`
          : "Plan anual activo";
      }
    }

    const tenantNameEl = document.getElementById("tenantName");
    if (tenantNameEl && data.tenantName) {
      tenantNameEl.textContent = data.tenantName;
    }
  }

  function bindOwnerAccountButtons() {
    const btnManage = document.getElementById("btnManagePlan");
    if (btnManage && btnManage.dataset.mgSupervisorPortalBound !== "1") {
      btnManage.dataset.mgSupervisorPortalBound = "1";
      btnManage.addEventListener("click", async () => {
        btnManage.disabled = true;
        btnManage.textContent = "Abriendo...";
        try {
          const { response, data } = await api("/create-portal-session", {
            method: "POST",
            body: "{}",
          });
          if (!response.ok || !data.url) {
            throw new Error(data.error || "No se pudo abrir portal");
          }
          window.location.href = data.url;
        } catch (err) {
          window.alert(err.message || "Error al abrir el portal");
          btnManage.disabled = false;
          btnManage.textContent = "Gestionar plan";
        }
      });
    }

    const btnLogout = document.getElementById("btnLogout");
    if (btnLogout && btnLogout.dataset.mgSupervisorPortalBound !== "1") {
      btnLogout.dataset.mgSupervisorPortalBound = "1";
      btnLogout.addEventListener("click", async () => {
        btnLogout.disabled = true;
        try {
          await api("/logout", { method: "POST", body: "{}" });
        } finally {
          window.location.href = "/index.html";
        }
      });
    }
  }

  async function tryOwnerAuth() {
    const { response, data } = await api("/auth-status", { method: "GET" });
    if (!response.ok || !data.active) return null;

    if (window.MarginGuardTenant?.bootstrapTenant) {
      try {
        const { data: tenantData } = await window.MarginGuardTenant.bootstrapTenant();
        if (tenantData?.tenant?.name) data.tenantName = tenantData.tenant.name;
      } catch (_err) {
        /* keep owner access when bootstrap is optional */
      }
    }
    return data;
  }

  function applyOwnerMode(ownerData) {
    deviceModeActive = false;
    window.MG_SUPERVISOR_PORTAL_MODE = "owner";
    document.documentElement.dataset.authMode = "owner";
    delete document.documentElement.dataset.portalType;
    removeDeviceNotice();
    removeDeviceLogoutButton();
    restoreDeviceShellUi();
    paintOwnerAccount(ownerData);
    bindOwnerAccountButtons();
    document.body.classList.add("auth-ready");
  }

  function ensureDeviceNotice() {
    let notice = document.getElementById("mgSupervisorDeviceNotice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "mgSupervisorDeviceNotice";
      notice.className = "notice";
      notice.setAttribute("role", "status");
      const container = document.querySelector(".container");
      if (container) {
        container.insertBefore(notice, container.firstChild);
      } else {
        document.body.insertBefore(notice, document.body.firstChild);
      }
    }
    notice.textContent = SUPERVISOR_NOTICE;
    notice.hidden = false;
    notice.style.display = "";
  }

  function removeDeviceNotice() {
    const notice = document.getElementById("mgSupervisorDeviceNotice");
    if (notice) notice.remove();
  }

  function hideOwnerChrome() {
    document.querySelectorAll("[data-owner-nav]").forEach((el) => {
      el.setAttribute("hidden", "");
      el.setAttribute("aria-hidden", "true");
      if ("disabled" in el) {
        el.disabled = true;
      }
    });
  }

  function showDeviceAccountPill(auth) {
    const email = document.getElementById("accountEmail");
    if (!email) return;
    const tenant = tenantLabel(auth);
    const member = membershipLabel(auth);
    email.textContent = tenant ? `${member} · ${tenant}` : member;
  }

  function ensureDeviceLogoutButton() {
    let btn = document.getElementById("btnDeviceLogout");
    if (btn) return btn;

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn danger";
    btn.id = "btnDeviceLogout";
    btn.textContent = "Cerrar sesion dispositivo";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        if (window.MGDevicePortal?.logout) {
          await window.MGDevicePortal.logout();
          return;
        }
        await api("/device-logout", { method: "POST", body: "{}" });
      } finally {
        window.location.href = "/portal-pair?portal=supervisor";
      }
    });

    const actions = document.querySelector(".topbar-actions");
    if (actions) {
      actions.appendChild(btn);
    }
    return btn;
  }

  function removeDeviceLogoutButton() {
    const btn = document.getElementById("btnDeviceLogout");
    if (btn) btn.remove();
  }

  function isBlockedFetchUrl(url) {
    if (ALWAYS_BLOCKED_ENDPOINT_RES.some((re) => re.test(url))) {
      return true;
    }
    if (/\/get-supervisor-/i.test(url)) {
      return !ALLOWED_DEVICE_READ_RES.some((re) => re.test(url));
    }
    return false;
  }

  function blockedFetchResponse() {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          ok: false,
          error: BLOCKED_FETCH_MSG,
          code: "supervisor_device_blocked",
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
  }

  function installFetchGuard() {
    if (fetchGuardInstalled || typeof window.fetch !== "function") return;
    fetchGuardInstalled = true;
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function supervisorDeviceGuardedFetch(input, init) {
      if (deviceModeActive) {
        const url = String(
          typeof input === "string" ? input : input && input.url ? input.url : ""
        );
        if (isBlockedFetchUrl(url)) {
          return blockedFetchResponse();
        }
      }
      return nativeFetch(input, init);
    };
  }

  function disableBlockedControls() {
    BLOCKED_CONTROL_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = true;
      el.setAttribute("aria-disabled", "true");
      el.setAttribute("data-mg-supervisor-blocked", "1");
      el.title = BLOCKED_CONTROL_MSG;
      if (id === "supAssignToMeBtn") {
        el.setAttribute("hidden", "");
      }
      if (id === "supOpExpenseCountCard") {
        el.setAttribute("tabindex", "-1");
      }
    });
  }

  function restoreDeviceShellUi() {
    BLOCKED_CONTROL_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.disabled = false;
      el.removeAttribute("aria-disabled");
      el.removeAttribute("data-mg-supervisor-blocked");
      el.removeAttribute("title");
      if (id === "supAssignToMeBtn") {
        el.removeAttribute("hidden");
      }
      if (id === "supOpExpenseCountCard") {
        el.removeAttribute("tabindex");
      }
    });
  }

  function isBlockedControlTarget(target) {
    if (!target || typeof target.closest !== "function") return false;
    for (const id of BLOCKED_CONTROL_IDS) {
      const el = document.getElementById(id);
      if (el && (target === el || el.contains(target))) return true;
    }
    return false;
  }

  function installClickGuard() {
    if (clickGuardInstalled) return;
    clickGuardInstalled = true;
    document.addEventListener(
      "click",
      (event) => {
        if (!deviceModeActive) return;
        if (!isBlockedControlTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        window.alert(BLOCKED_CONTROL_MSG);
      },
      true
    );
  }

  function applyDeviceMode(auth) {
    deviceModeActive = true;
    window.MG_SUPERVISOR_PORTAL_MODE = "device";
    document.documentElement.dataset.authMode = "device";
    document.documentElement.dataset.portalType = "supervisor";

    const plan = document.getElementById("planStatus");
    if (plan) plan.textContent = "Supervisor device · Field shell";

    installFetchGuard();
    hideOwnerChrome();
    ensureDeviceNotice();
    showDeviceAccountPill(auth);
    ensureDeviceLogoutButton();
    disableBlockedControls();
    installClickGuard();

    requestAnimationFrame(() => {
      disableBlockedControls();
      setTimeout(disableBlockedControls, 0);
    });

    document.body.classList.add("auth-ready");
    window.dispatchEvent(
      new CustomEvent("device-auth-ready", { detail: { auth } })
    );
  }

  async function initSupervisorPortalAuth() {
    const ownerData = await tryOwnerAuth();
    if (ownerData) {
      applyOwnerMode(ownerData);
      return;
    }

    if (!window.MGDevicePortal?.init) {
      window.location.href = "/portal-pair?portal=supervisor";
      return;
    }

    const auth = await window.MGDevicePortal.init({ expectedPortal: "supervisor" });
    if (!auth) {
      return;
    }
    applyDeviceMode(auth);
  }

  function boot() {
    if (document.body?.dataset?.supervisorDualAuth !== "true") return;
    if (!initPromise) {
      initPromise = initSupervisorPortalAuth().catch(() => {
        window.location.href = "/portal-pair?portal=supervisor";
      });
    }
    return initPromise;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  window.MGSupervisorDevicePortal = {
    boot,
    isDeviceMode: () => deviceModeActive,
  };
})();
