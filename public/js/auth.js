(() => {
  const API_BASE = "/.netlify/functions";

  async function api(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
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

  function bindAccountButtons() {
    const btnManage = document.getElementById("btnManagePlan");
    if (btnManage) {
      btnManage.addEventListener("click", async () => {
        btnManage.disabled = true;
        btnManage.textContent = "Abriendo...";
        try {
          const { response, data } = await api("/create-portal-session", { method: "POST", body: "{}" });
          if (!response.ok || !data.url) {
            throw new Error(data.error || "No se pudo abrir portal");
          }
          window.location.href = data.url;
        } catch (err) {
          alert(err.message || "Error al abrir el portal");
          btnManage.disabled = false;
          btnManage.textContent = "Gestionar plan";
        }
      });
    }

    const btnLogout = document.getElementById("btnLogout");
    if (btnLogout) {
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

  function paintAccount(data) {
    const email = document.getElementById("accountEmail");
    if (email) email.textContent = data.email || "Cuenta activa";

    const plan = document.getElementById("planStatus");
    if (plan) {
      if (data.is_admin) {
        plan.textContent = "Acceso admin (sin suscripción requerida)";
      } else {
        const renewText = data.renewsAt ? new Date(data.renewsAt).toLocaleDateString() : "";
        plan.textContent = renewText ? `Plan anual activo · Renueva ${renewText}` : "Plan anual activo";
      }
    }

    const tenantLabel = document.getElementById("tenantName");
    if (tenantLabel && data.tenantName) {
      tenantLabel.textContent = data.tenantName;
    }
  }

  async function enforceAuth() {
    const requiresAuth = document.body?.dataset?.requiresAuth === "true";
    if (!requiresAuth) return;

    const { data } = await api("/auth-status", { method: "GET" });
    console.log("ACCESS CHECK", {
      userId: data.userId ?? null,
      subscription_status: data.subscription_status ?? null,
      is_admin: !!data.is_admin,
      allowAccess: !!data.active,
    });
    if (!data.active) {
      window.location.href = "/index.html?login=1";
      return;
    }

    if (window.MarginGuardTenant?.bootstrapTenant) {
      try {
        const { data: tenantData } = await window.MarginGuardTenant.bootstrapTenant();
        if (tenantData?.tenant?.name) data.tenantName = tenantData.tenant.name;
      } catch (_err) {
        // No interrumpir acceso mientras migramos a multitenant.
      }
    }

    paintAccount(data);
    bindAccountButtons();
    document.body.classList.add("auth-ready");
  }

  document.addEventListener("DOMContentLoaded", enforceAuth);
})();
