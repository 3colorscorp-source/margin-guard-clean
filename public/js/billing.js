(() => {
  const API_BASE = "/.netlify/functions";
  const recoveryApi = window.MgOwnerRecoveryAuth;

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(message, tone) {
    const el = $("loginStatus") || $("recoveryStatus");
    if (!el) return;
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";
    el.className = tone === "err" ? "notice err" : "notice";
  }

  function setRecoveryStatus(message, tone) {
    const el = $("recoveryStatus");
    if (!el) {
      setStatus(message, tone);
      return;
    }
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";
    el.className = tone === "err" ? "notice err" : "notice";
  }

  function showPanel(which) {
    const login = $("ownerLoginForm");
    const recovery = $("ownerRecoveryForm");
    if (login) login.hidden = which !== "login";
    if (recovery) recovery.hidden = which !== "recovery";
  }

  function applyRecoveryCopy(mode) {
    const title = $("recoveryTitle");
    const cta = $("btnSaveNewPassword");
    if (mode === "invite") {
      if (title) title.textContent = "Set your password";
      if (cta) cta.textContent = "Save new password";
    } else {
      if (title) title.textContent = "Reset your password";
      if (cta) cta.textContent = "Save new password";
    }
  }

  function clearUrlHash() {
    if (!window.location.hash) return;
    try {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (_err) {
      /* ignore */
    }
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

  async function createAuthClient() {
    if (typeof window.supabase?.createClient !== "function") {
      throw new Error("No se pudo cargar el acceso.");
    }
    const { url, anon } = await loadPublicConfig();
    return window.supabase.createClient(url, anon);
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

  let passwordClient = null;
  let passwordMode = "recovery";

  async function waitForAuthSession(client) {
    const initial = await client.auth.getSession();
    if (initial.data?.session?.access_token) {
      return { session: initial.data.session, event: "" };
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ session: null, event: "" }), 8000);
      const { data } = client.auth.onAuthStateChange((event, next) => {
        if (next?.access_token) {
          clearTimeout(timer);
          data.subscription.unsubscribe();
          resolve({ session: next, event: String(event || "") });
        }
      });
    });
  }

  async function completeAuthHashIfPresent() {
    if (!recoveryApi) return;
    const capturedHash = window.location.hash || "";
    if (!recoveryApi.hasAuthCallbackHash(capturedHash)) return;

    showPanel("login");

    try {
      const client = await createAuthClient();
      const waited = await waitForAuthSession(client);
      const kind = recoveryApi.classifyAuthCallback(capturedHash, waited.event);
      const session = waited.session;

      if (kind === "recovery" || kind === "invite") {
        if (!session?.access_token) {
          setStatus("This reset link is invalid or has expired.", "err");
          showPanel("login");
          clearUrlHash();
          return;
        }
        passwordClient = client;
        passwordMode = kind;
        clearUrlHash();
        applyRecoveryCopy(kind);
        showPanel("recovery");
        setRecoveryStatus("", "");
        return;
      }

      clearUrlHash();
      showPanel("login");
    } catch (_err) {
      setStatus("No se pudo entrar. Verifica tu cuenta e intenta de nuevo.", "err");
      showPanel("login");
    }
  }

  async function saveNewPassword(event) {
    event.preventDefault();
    if (!recoveryApi || !passwordClient) {
      setRecoveryStatus("This reset link is invalid or has expired.", "err");
      return;
    }
    const password = String($("recoveryPassword")?.value || "");
    const confirm = String($("recoveryPasswordConfirm")?.value || "");
    const btn = $("btnSaveNewPassword");
    const valid = recoveryApi.validateNewPassword(password, confirm);
    if (!valid.ok) {
      if (valid.error === "password_mismatch") {
        setRecoveryStatus("Passwords do not match.", "err");
      } else if (valid.error === "password_too_short") {
        setRecoveryStatus("Password must be at least 8 characters.", "err");
      } else {
        setRecoveryStatus("Enter a valid new password.", "err");
      }
      return;
    }

    if (btn) btn.disabled = true;
    setRecoveryStatus("Saving password…", "info");

    try {
      const result = await recoveryApi.completePasswordEstablishment({
        password,
        confirm,
        updateUser: (payload) => passwordClient.auth.updateUser(payload),
        getSession: async () => {
          const { data } = await passwordClient.auth.getSession();
          return data?.session || null;
        },
        mintOwnerSession,
      });
      if (!result.ok || !result.minted) {
        if (result.error === "update_failed") {
          setRecoveryStatus("Could not update password. Open the email link again.", "err");
        } else {
          setRecoveryStatus("Could not update password. Open the email link again.", "err");
        }
        return;
      }
      setRecoveryStatus("Password updated. Continue to Margin Guard.", "");
      window.location.href = "/dashboard.html";
    } catch (_err) {
      setRecoveryStatus("Could not update password. Open the email link again.", "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function sendForgotPassword(event) {
    event.preventDefault();
    const email = String($("loginEmail")?.value || "").trim();
    const generic = "If an account exists for that email, a reset link will be sent.";
    if (!email || !email.includes("@")) {
      setStatus("Enter your email to reset your password.", "err");
      return;
    }
    try {
      const client = await createAuthClient();
      const redirectTo = recoveryApi
        ? recoveryApi.recoveryRedirectTo(window.location.origin)
        : window.location.origin + "/index.html";
      await client.auth.resetPasswordForEmail(email, { redirectTo });
    } catch (_err) {
      /* same generic copy — do not reveal account existence */
    }
    setStatus(generic, "");
  }

  document.addEventListener("DOMContentLoaded", () => {
    const form = $("ownerLoginForm");
    if (form) form.addEventListener("submit", signInAndEnter);
    const recoveryForm = $("ownerRecoveryForm");
    if (recoveryForm) recoveryForm.addEventListener("submit", saveNewPassword);
    const forgot = $("btnForgotPassword");
    if (forgot) forgot.addEventListener("click", sendForgotPassword);
    completeAuthHashIfPresent();
  });
})();
