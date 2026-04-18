(() => {
  const API_BASE = "/.netlify/functions";

  function $(id) {
    return document.getElementById(id);
  }

  async function post(path, payload) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  function error(message) {
    const el = $("checkoutStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "notice err";
    el.style.display = "block";
  }

  function info(message) {
    const el = $("checkoutStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "notice";
    el.style.display = "block";
  }

  async function startCheckout(event) {
    event.preventDefault();

    const email = String($("email")?.value || "").trim();
    if (!email || !email.includes("@")) {
      error("Ingresa un correo valido para continuar.");
      return;
    }

    const btn = $("btnCheckout");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Conectando...";
    }

    info("Preparando checkout seguro...");

    try {
      const { res, data } = await post("/create-checkout-session", { email });
      if (!res.ok || !data.url) {
        throw new Error(data.error || "No se pudo iniciar checkout");
      }
      window.location.href = data.url;
    } catch (err) {
      error(err.message || "Error iniciando checkout");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Suscribirme anual";
      }
    }
  }

  async function openPortal() {
    const btn = $("btnOpenPortal");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Abriendo...";
    }

    try {
      const { res, data } = await post("/create-portal-session", {});
      if (!res.ok || !data.url) {
        throw new Error(data.error || "No se pudo abrir el portal");
      }
      window.location.href = data.url;
    } catch (err) {
      const msg = err.message || "Error abriendo portal";
      error(msg);
      const st = $("checkoutStatus");
      if (st) st.scrollIntoView({ behavior: "smooth", block: "nearest" });
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Ya soy cliente";
      }
    }
  }

  async function restoreOwnerSession(event) {
    event.preventDefault();
    const email = String($("restoreEmail")?.value || "").trim();
    const statusEl = $("restoreSessionStatus");
    const btn = $("btnRestoreSession");
    if (!email || !email.includes("@")) {
      if (statusEl) {
        statusEl.textContent = "Ingresa el correo del dueno del negocio.";
        statusEl.className = "notice err";
        statusEl.style.display = "block";
      }
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Entrando...";
    }
    if (statusEl) {
      statusEl.textContent = "Verificando suscripcion...";
      statusEl.className = "notice";
      statusEl.style.display = "block";
    }
    try {
      const { res, data } = await post("/restore-owner-session", { email });
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "No se pudo restaurar la sesion");
      }
      window.location.href = "/dashboard.html";
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = err.message || "Error al entrar";
        statusEl.className = "notice err";
        statusEl.style.display = "block";
      }
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Entrar con mi correo";
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const form = $("checkoutForm");
    if (form) form.addEventListener("submit", startCheckout);

    const portalBtn = $("btnOpenPortal");
    if (portalBtn) portalBtn.addEventListener("click", openPortal);

    const restoreForm = $("restoreSessionForm");
    if (restoreForm) restoreForm.addEventListener("submit", restoreOwnerSession);
  });
})();
