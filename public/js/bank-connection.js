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

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load script"));
      document.head.appendChild(s);
    });
  }

  let stripePromise = null;

  function ensureStripe() {
    if (!stripePromise) {
      stripePromise = (async () => {
        const { response, data } = await api("/get-stripe-publishable-key", { method: "GET" });
        if (!response.ok || !data.publishable_key) {
          throw new Error(data.error || "Stripe publishable key unavailable");
        }
        await loadScript("https://js.stripe.com/v3/");
        if (typeof window.Stripe !== "function") {
          throw new Error("Stripe.js did not initialize");
        }
        return window.Stripe(data.publishable_key);
      })();
    }
    return stripePromise;
  }

  function setStatus(root, msg, kind) {
    const el = root.querySelector("[data-mg-bank-status]");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "dashboard-note-copy" + (kind ? ` ${kind}` : "");
  }

  function fillSelect(select, accounts, selectedId) {
    const sid = selectedId ? String(selectedId) : "";
    select.textContent = "";
    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "— None —";
    select.appendChild(opt0);
    (accounts || []).forEach((a) => {
      const id = String(a.id);
      const o = document.createElement("option");
      o.value = id;
      o.textContent = String(a.label || "Account");
      if (id === sid) {
        o.selected = true;
      }
      select.appendChild(o);
    });
  }

  async function loadAccountsAndMappings(root) {
    const { response, data } = await api("/list-tenant-bank-accounts", { method: "GET" });
    if (!response.ok) {
      throw new Error(data.error || "Could not load linked accounts");
    }
    const accounts = data.accounts || [];
    const mappings = data.mappings || [];
    const byBucket = {};
    mappings.forEach((m) => {
      if (m && m.bucket) {
        byBucket[m.bucket] = m.tenant_bank_account_id;
      }
    });

    ["operating", "savings", "profit", "tax_reserve"].forEach((bucket) => {
      const sel = root.querySelector(`[data-mg-map-bucket="${bucket}"]`);
      if (sel) {
        fillSelect(sel, accounts, byBucket[bucket] || "");
      }
    });

    return accounts.length;
  }

  async function applySummaryToDashboard(summary) {
    if (!summary) return;
    const map = [
      ["operating_balance", "expensesBalance"],
      ["savings_balance", "savingsBalance"],
      ["profit_balance", "profitBalance"],
      ["tax_reserve_balance", "taxBalance"],
    ];
    map.forEach(([serverKey, inputId]) => {
      const el = document.getElementById(inputId);
      if (!el) return;
      const v = summary[serverKey];
      if (v === undefined || v === null) return;
      el.value = String(Number(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const badge = document.getElementById("syncBadge");
    if (badge) {
      badge.textContent = "Bank snapshot (server)";
      badge.className = "badge green";
    }
    const bankNote = document.getElementById("dashboardBankSyncMeta");
    if (bankNote) {
      bankNote.textContent = `Last server sync: ${
        summary.computed_at ? new Date(summary.computed_at).toLocaleString() : "—"
      }`;
    }
  }

  function paintSummaryInline(root, summary) {
    const host = root.querySelector("[data-mg-bank-summary]");
    if (!host) return;
    if (!summary) {
      host.textContent = "No bank snapshot on server yet. Connect accounts, map buckets, then sync.";
      return;
    }
    const cash = Number(summary.cash_on_hand);
    const cur = summary.currency || "USD";
    const fmt = (n) =>
      new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(Number(n) || 0);
    host.textContent = `Cash on hand (server): ${fmt(cash)} · Operating ${fmt(
      summary.operating_balance
    )} · Savings ${fmt(summary.savings_balance)} · Profit ${fmt(summary.profit_balance)} · Tax ${fmt(
      summary.tax_reserve_balance
    )}`;
  }

  async function refreshSummaryDisplay(root) {
    const { response, data } = await api("/get-tenant-financial-summary", { method: "GET" });
    if (!response.ok) {
      setStatus(root, data.error || "Could not load summary", "err");
      return;
    }
    paintSummaryInline(root, data.summary);
    await applySummaryToDashboard(data.summary);
  }

  async function initPanel(root) {
    const connectBtn = root.querySelector('[data-mg-action="connect-bank"]');
    const saveMapBtn = root.querySelector('[data-mg-action="save-mapping"]');
    const syncBtn = root.querySelector('[data-mg-action="sync-summary"]');

    function deferInitialLoad() {
      setTimeout(async () => {
        try {
          setStatus(root, "Loading bank link status…", "");
          await loadAccountsAndMappings(root);
          setStatus(root, "", "");
        } catch (err) {
          setStatus(root, err.message || "Could not load bank data", "err");
        }
        try {
          await refreshSummaryDisplay(root);
        } catch (_e) {
          /* optional */
        }
      }, 400);
    }
    deferInitialLoad();

    if (connectBtn) {
      connectBtn.addEventListener("click", async () => {
        connectBtn.disabled = true;
        setStatus(root, "Starting bank connection…", "");
        try {
          const stripe = await ensureStripe();
          const { response, data } = await api("/create-financial-connections-session", {
            method: "POST",
            body: "{}",
          });
          if (!response.ok || !data.client_secret) {
            throw new Error(data.error || "Could not start Financial Connections session");
          }
          const createdSessionId = String(data.financial_connections_session_id || "").trim();
          const collect = stripe.collectFinancialConnectionsAccounts;
          if (typeof collect !== "function") {
            throw new Error("Financial Connections is not available in this Stripe.js build.");
          }
          const result = await collect.call(stripe, { clientSecret: data.client_secret });
          if (result.error) {
            throw new Error(result.error.message || "Bank connection cancelled or failed");
          }
          const fcSession = result.session;
          let sessionIdFromStripe = "";
          if (typeof fcSession === "string") {
            sessionIdFromStripe = fcSession.trim();
          } else if (fcSession && typeof fcSession.id === "string") {
            sessionIdFromStripe = String(fcSession.id).trim();
          }
          const sessionId = sessionIdFromStripe || createdSessionId;
          if (!sessionId) {
            throw new Error("Missing Financial Connections session after link");
          }
          const done = await api("/complete-financial-connections", {
            method: "POST",
            body: JSON.stringify({ financial_connections_session_id: sessionId }),
          });
          if (!done.response.ok) {
            throw new Error(done.data.error || "Could not finalize bank link");
          }
          setStatus(root, "Bank linked. Map each account to a bucket below, then save.", "");
          await loadAccountsAndMappings(root);
        } catch (err) {
          setStatus(root, err.message || "Connect failed", "err");
        } finally {
          connectBtn.disabled = false;
        }
      });
    }

    if (saveMapBtn) {
      saveMapBtn.addEventListener("click", async () => {
        saveMapBtn.disabled = true;
        setStatus(root, "Saving bucket mapping…", "");
        try {
          const mappings = ["operating", "savings", "profit", "tax_reserve"].map((bucket) => {
            const sel = root.querySelector(`[data-mg-map-bucket="${bucket}"]`);
            const v = sel && sel.value ? String(sel.value).trim() : "";
            return { bucket, tenant_bank_account_id: v };
          });
          const { response, data } = await api("/save-tenant-financial-account-mapping", {
            method: "POST",
            body: JSON.stringify({ mappings }),
          });
          if (!response.ok) {
            throw new Error(data.error || "Save failed");
          }
          setStatus(root, "Mapping saved.", "");
        } catch (err) {
          setStatus(root, err.message || "Save failed", "err");
        } finally {
          saveMapBtn.disabled = false;
        }
      });
    }

    if (syncBtn) {
      syncBtn.addEventListener("click", async () => {
        syncBtn.disabled = true;
        setStatus(root, "Syncing balances from Stripe…", "");
        try {
          const { response, data } = await api("/sync-tenant-financial-summary", {
            method: "POST",
            body: "{}",
          });
          if (!response.ok) {
            throw new Error(data.error || "Sync failed");
          }
          setStatus(root, "Sync complete.", "");
          await refreshSummaryDisplay(root);
        } catch (err) {
          setStatus(root, err.message || "Sync failed", "err");
        } finally {
          syncBtn.disabled = false;
        }
      });
    }
  }

  function boot() {
    document.querySelectorAll("[data-mg-bank-panel]").forEach((root) => {
      initPanel(root);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
