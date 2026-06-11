(() => {
  "use strict";

  const API = "/.netlify/functions";
  const MIN_PASSWORD_LEN = 8;
  const SUCCESS_MSG =
    "Login linked. You can now be assigned projects and paired to a supervisor device.";

  let supabase = null;
  let sessionReady = false;

  function $(id) {
    return document.getElementById(id);
  }

  function readStaticConfig() {
    let url =
      typeof window.__MG_SUPABASE_URL === "string" ? window.__MG_SUPABASE_URL.trim() : "";
    let anon =
      typeof window.__MG_SUPABASE_ANON_KEY === "string"
        ? window.__MG_SUPABASE_ANON_KEY.trim()
        : "";

    if (!url) {
      const meta = document.querySelector('meta[name="mg-supabase-url"]');
      const content = meta?.getAttribute("content");
      if (content && String(content).trim()) url = String(content).trim();
    }
    if (!anon) {
      const meta = document.querySelector('meta[name="mg-supabase-anon-key"]');
      const content = meta?.getAttribute("content");
      if (content && String(content).trim()) anon = String(content).trim();
    }

    return { url, anon };
  }

  async function loadConfig() {
    const staticConfig = readStaticConfig();
    if (staticConfig.url && staticConfig.anon) {
      return staticConfig;
    }

    try {
      const response = await fetch(`${API}/get-supabase-public-config`, { method: "GET" });
      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        data = {};
      }
      if (response.ok && data.ok === true) {
        const url = String(data.supabaseUrl || "").trim();
        const anon = String(data.supabaseAnonKey || "").trim();
        if (url && anon) {
          return { url, anon };
        }
      }
    } catch (_err) {
      /* ignore */
    }

    return staticConfig;
  }

  function setStatus(message, tone) {
    const el = $("siStatus");
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
    el.classList.remove("si-status--ok", "si-status--err", "si-status--info");
    if (tone === "ok") el.classList.add("si-status--ok");
    else if (tone === "err") el.classList.add("si-status--err");
    else if (tone === "info") el.classList.add("si-status--info");
  }

  function showForm(show) {
    const panel = $("siFormPanel");
    const form = $("siForm");
    if (panel) panel.hidden = !show;
    if (form) form.hidden = !show;
  }

  function clearUrlHash() {
    if (!window.location.hash) return;
    try {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (_err) {
      /* ignore */
    }
  }

  function hasAuthCallbackHash() {
    const hash = window.location.hash || "";
    return /access_token=|refresh_token=|type=invite|type=recovery|type=magiclink/i.test(hash);
  }

  async function waitForAuthSession(client) {
    const initial = await client.auth.getSession();
    if (initial.data?.session?.access_token) {
      return initial.data.session;
    }
    if (!hasAuthCallbackHash()) {
      return null;
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (session) => {
        if (settled) return;
        settled = true;
        subscription.unsubscribe();
        clearTimeout(timer);
        resolve(session || null);
      };

      const {
        data: { subscription },
      } = client.auth.onAuthStateChange((event, session) => {
        if (
          event === "INITIAL_SESSION" ||
          event === "SIGNED_IN" ||
          event === "PASSWORD_RECOVERY"
        ) {
          finish(session);
        }
      });

      const timer = setTimeout(async () => {
        const { data } = await client.auth.getSession();
        finish(data?.session || null);
      }, 2500);
    });
  }

  function mapLinkError(code) {
    const value = String(code || "").trim();
    if (value === "membership_not_found") {
      return "No active supervisor membership was found for this login.";
    }
    if (value === "ambiguous_membership") {
      return "This login matches more than one supervisor membership. Contact your company owner.";
    }
    if (value === "not_supervisor_membership") {
      return "Only supervisor memberships can be linked here.";
    }
    if (value === "membership_not_active") {
      return "This supervisor membership is not active.";
    }
    if (value === "conflict") {
      return "This membership is already linked to a different login.";
    }
    if (value === "invalid_token") {
      return "Your login session expired. Open the login link again from your email.";
    }
    if (value === "link_failed") {
      return "Could not link your login. Try again or contact your company owner.";
    }
    return "Could not link your login. Try again.";
  }

  async function linkMembership(accessToken) {
    const response = await fetch(`${API}/link-membership-auth`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: "{}",
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_err) {
      data = {};
    }
    return { response, data };
  }

  async function initSession() {
    const { url, anon } = await loadConfig();
    if (!url || !anon) {
      setStatus("Supervisor login setup is not configured. Contact your company owner.", "err");
      showForm(false);
      return false;
    }
    if (typeof window.supabase?.createClient !== "function") {
      setStatus("Supervisor login setup is not configured. Contact your company owner.", "err");
      showForm(false);
      return false;
    }

    supabase = window.supabase.createClient(url, anon, {
      auth: {
        detectSessionInUrl: true,
        persistSession: true,
      },
    });

    const session = await waitForAuthSession(supabase);
    if (!session?.access_token) {
      setStatus("Open this page from your supervisor login email.", "info");
      showForm(false);
      return false;
    }

    clearUrlHash();
    sessionReady = true;
    setStatus("Set a password to finish linking your supervisor login.", "info");
    showForm(true);
    return true;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!sessionReady || !supabase) return;

    const password = String($("siPassword")?.value || "");
    const confirm = String($("siPasswordConfirm")?.value || "");
    const btn = $("siSubmitBtn");

    if (password.length < MIN_PASSWORD_LEN) {
      setStatus(`Password must be at least ${MIN_PASSWORD_LEN} characters.`, "err");
      return;
    }
    if (password !== confirm) {
      setStatus("Passwords do not match.", "err");
      return;
    }

    if (btn) btn.disabled = true;
    setStatus("Creating password…", "info");

    try {
      const { error: passwordError } = await supabase.auth.updateUser({ password });
      if (passwordError) {
        setStatus("Could not set password. Try again or open the login link again.", "err");
        return;
      }

      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !sessionData?.session?.access_token) {
        setStatus("Password saved but session was lost. Open the login link again.", "err");
        return;
      }

      setStatus("Linking supervisor access…", "info");
      const { response, data } = await linkMembership(sessionData.session.access_token);

      if (!response.ok || data.ok !== true) {
        setStatus(mapLinkError(data.error), "err");
        return;
      }

      const status = String(data.status || "").trim();
      if (status === "linked" || status === "already_linked") {
        setStatus(SUCCESS_MSG, "ok");
        showForm(false);
        return;
      }

      setStatus("Link request completed.", "ok");
      showForm(false);
    } catch (_err) {
      setStatus("Network error. Try again.", "err");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("siForm")?.addEventListener("submit", (event) => {
      void handleSubmit(event);
    });
    void initSession();
  });
})();
