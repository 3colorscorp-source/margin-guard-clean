(() => {
  const API_BASE = "/.netlify/functions";

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(message, tone) {
    const el = $("loginStatus");
    if (!el) return;
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";
    el.className = tone === "err" ? "notice err" : "notice";
  }

  async function loadPublicConfig() {
    const response = await fetch(`${API_BASE}/get-supabase-public-config`, { method: "GET" });
    const data = await response.json().catch(() => ({}));
    const url = String(data.supabaseUrl || "").trim();
    const anon = String(data.supabaseAnonKey || "").trim();
    if (!response.ok || data.ok !== true || !url || !anon) {
      throw new Error("No se pudo cargar el acceso.");
    }
    return { url, anon };
  }

  async function mintOwnerSession(accessToken) {
    const res = await fetch(`${API_BASE}/restore-owner-session`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + accessToken,
      },
      body: "{}",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error("No se pudo entrar. Verifica tu cuenta e intenta de nuevo.");
    }
  }

  async function signInAndEnter(event) {
    event.preventDefault();
    const email = String($("loginEmail")?.value || "").trim();
    const password = String($("loginPassword")?.value || "");
    const btn = $("btnOwnerLogin");

    if (!email || !email.includes("@") || !password) {
      setStatus("Ingresa email y contrasena.", "err");
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Entrando...";
    }
    setStatus("Verificando tu cuenta...", "info");

    try {
      const client = await createAuthClient();
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      const accessToken = data?.session?.access_token;
      if (error || !accessToken) {
        throw new Error("No se pudo entrar. Verifica tu cuenta e intenta de nuevo.");
      }
      await mintOwnerSession(accessToken);
      window.location.href = "/dashboard.html";
    } catch (_err) {
      setStatus("No se pudo entrar. Verifica tu cuenta e intenta de nuevo.", "err");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    }
  }

  async function createAuthClient() {
    if (typeof window.supabase?.createClient !== "function") {
      throw new Error("No se pudo cargar el acceso.");
    }
    const { url, anon } = await loadPublicConfig();
    return window.supabase.createClient(url, anon);
  }

  function hasAuthCallbackHash() {
    const hash = window.location.hash || "";
    return /access_token=|refresh_token=|type=invite|type=recovery|type=magiclink/i.test(hash);
  }

  async function completeInviteHashIfPresent() {
    if (!hasAuthCallbackHash()) return;
    const btn = $("btnOwnerLogin");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Entrando...";
    }
    setStatus("Verificando tu cuenta...", "info");
    try {
      const client = await createAuthClient();
      let session = (await client.auth.getSession()).data?.session;
      if (!session?.access_token) {
        session = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), 8000);
          const { data } = client.auth.onAuthStateChange((_event, next) => {
            if (next?.access_token) {
              clearTimeout(timer);
              data.subscription.unsubscribe();
              resolve(next);
            }
          });
        });
      }
      if (!session?.access_token) {
        throw new Error("missing");
      }
      await mintOwnerSession(session.access_token);
      window.location.href = "/dashboard.html";
    } catch (_err) {
      setStatus("No se pudo entrar. Verifica tu cuenta e intenta de nuevo.", "err");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Entrar";
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const form = $("ownerLoginForm");
    if (form) form.addEventListener("submit", signInAndEnter);
    completeInviteHashIfPresent();
  });
})();
