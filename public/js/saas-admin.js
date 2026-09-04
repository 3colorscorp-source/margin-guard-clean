/**
 * Platform-admin SaaS revenue console. Server APIs remain the authority.
 */
(function () {
  const LIST_API = "/.netlify/functions/admin-saas-list-customers";
  const CREATE_API = "/.netlify/functions/admin-saas-create-pending-customer";
  const SEND_API = "/.netlify/functions/admin-saas-send-owner-access";
  const STATUS_API = "/.netlify/functions/get-saas-onboarding-status";

  const state = { customers: [], writing: false };

  function $(id) {
    return document.getElementById(id);
  }

  function setNotice(text) {
    const el = $("saNotice");
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || "";
  }

  function setFormError(text) {
    const el = $("saFormError");
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || "";
  }

  function lockModal(open) {
    document.documentElement.classList.toggle("sa-modal-open", open);
    document.body.classList.toggle("sa-modal-open", open);
    if ($("saModal")) $("saModal").hidden = !open;
    if ($("saBackdrop")) $("saBackdrop").hidden = !open;
  }

  function formatWhen(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString();
  }

  function isActiveSubscription(row) {
    return row && row.subscription_status === "active";
  }

  function nextStep(row) {
    if (!row) return "";
    if (isActiveSubscription(row) && row.access_status === "access_not_sent") return "Send owner access";
    if (isActiveSubscription(row) && row.access_status === "already_invited") return "Owner invite already sent";
    if (isActiveSubscription(row)) return "Owner can sign in";
    if (row.payment_status === "awaiting_payment") return "Awaiting Square payment";
    if (!row.square_invoice_id) return "Register Square invoice";
    return "Waiting for trusted Square activation";
  }

  function renderList() {
    const list = $("saList");
    if (!list) return;
    list.textContent = "";
    if (!state.customers.length) {
      const empty = document.createElement("div");
      empty.className = "sa-card";
      empty.textContent = "No SaaS customers yet.";
      list.appendChild(empty);
      return;
    }
    state.customers.forEach(function (row) {
      const card = document.createElement("article");
      card.className = "sa-card";
      const h = document.createElement("h3");
      h.textContent = row.business_name || row.slug || "Customer";
      card.appendChild(h);
      const meta = document.createElement("div");
      meta.className = "sa-meta";
      meta.appendChild(document.createTextNode("$2,000/year · Square " + (row.square_invoice_id || "not registered")));
      meta.appendChild(document.createElement("br"));
      meta.appendChild(document.createTextNode(row.owner_email || ""));
      meta.appendChild(document.createElement("br"));
      meta.appendChild(
        document.createTextNode(
          "Registered " +
            formatWhen(row.registered_at) +
            " · Paid " +
            formatWhen(row.paid_at) +
            " · Activated " +
            formatWhen(row.activated_at) +
            " · Expires " +
            formatWhen(row.term_expires_at)
        )
      );
      meta.appendChild(document.createElement("br"));
      meta.appendChild(document.createTextNode("Next: " + nextStep(row)));
      card.appendChild(meta);
      const badges = document.createElement("div");
      badges.className = "sa-badges";
      (row.badges || []).forEach(function (label) {
        const b = document.createElement("span");
        b.className = "sa-badge";
        b.textContent = label;
        badges.appendChild(b);
      });
      card.appendChild(badges);
      const actions = document.createElement("div");
      actions.className = "sa-actions";
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.className = "btn ghost";
      refresh.textContent = "Refresh Status";
      refresh.setAttribute("data-refresh", row.tenant_id);
      actions.appendChild(refresh);
      if (isActiveSubscription(row) && row.access_status !== "already_has_access") {
        const send = document.createElement("button");
        send.type = "button";
        send.className = "btn";
        send.textContent = "Send Owner Access";
        send.setAttribute("data-send", row.tenant_id);
        actions.appendChild(send);
      }
      card.appendChild(actions);
      list.appendChild(card);
    });
  }

  async function loadList() {
    setNotice("");
    const res = await fetch(LIST_API, { credentials: "include" });
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    if (!res.ok || !data.ok) {
      state.customers = [];
      setNotice(String(data.error || "Customers could not be loaded."));
      renderList();
      return;
    }
    state.customers = Array.isArray(data.customers) ? data.customers : [];
    renderList();
  }

  async function refreshOne(tenantId) {
    const url = STATUS_API + "?tenant_id=" + encodeURIComponent(tenantId);
    await fetch(url, { credentials: "include" });
    await loadList();
  }

  async function sendAccess(tenantId) {
    if (state.writing) return;
    state.writing = true;
    setNotice("");
    try {
      const res = await fetch(SEND_API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: tenantId }),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_err) {
        data = {};
      }
      if (!res.ok || !data.ok) {
        setNotice(String(data.error || data.status || "Owner access could not be sent."));
      } else {
        setNotice("Owner access: " + String(data.status || "ok"));
      }
      await loadList();
    } finally {
      state.writing = false;
    }
  }

  async function createCustomer(ev) {
    ev.preventDefault();
    if (state.writing) return;
    if (!$("saTerms") || !$("saTerms").checked) {
      setFormError("Terms confirmation is required.");
      return;
    }
    const body = {
      business_name: $("saBusinessName").value,
      owner_name: $("saOwnerName").value,
      owner_email: $("saOwnerEmail").value,
      business_slug: $("saSlug").value,
      square_invoice_id: $("saInvoice").value,
      terms_confirmed: true,
    };
    state.writing = true;
    setFormError("");
    try {
      const res = await fetch(CREATE_API, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data = {};
      try {
        data = await res.json();
      } catch (_err) {
        data = {};
      }
      if (!res.ok || !data.ok) {
        setFormError(String((data.register && data.register.error) || data.error || "Customer could not be created."));
        await loadList();
        return;
      }
      lockModal(false);
      setNotice("Pending customer created. Awaiting trusted Square payment.");
      await loadList();
    } finally {
      state.writing = false;
    }
  }

  function bind() {
    if ($("saNew")) $("saNew").addEventListener("click", function () { lockModal(true); });
    if ($("saCancel")) $("saCancel").addEventListener("click", function () { lockModal(false); });
    if ($("saForm")) $("saForm").addEventListener("submit", createCustomer);
    if ($("saList")) {
      $("saList").addEventListener("click", function (ev) {
        const send = ev.target.closest("[data-send]");
        if (send) {
          sendAccess(send.getAttribute("data-send"));
          return;
        }
        const refresh = ev.target.closest("[data-refresh]");
        if (refresh) refreshOne(refresh.getAttribute("data-refresh"));
      });
    }
    if ($("saLogout")) {
      $("saLogout").addEventListener("click", async function () {
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
    let data = {};
    try {
      const res = await fetch("/.netlify/functions/auth-status", { credentials: "include" });
      data = await res.json();
    } catch (_err) {
      window.location.href = "/index.html?login=1";
      return;
    }
    if (!data || !data.active) {
      window.location.href = "/index.html?login=1";
      return;
    }
    if (data.is_admin !== true) {
      if ($("saDenied")) $("saDenied").hidden = false;
      return;
    }
    if ($("saMain")) $("saMain").hidden = false;
    await loadList();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
