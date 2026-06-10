(() => {
  "use strict";

  const API = "/.netlify/functions/list-tenant-quotes";
  const LIST_QUERY = "?limit=25&offset=0";

  let publishedThisMonth = null;
  let kpiObserverInstalled = false;

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

  function normStatus(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase();
  }

  function formatStatusLabel(raw) {
    const st = normStatus(raw);
    if (st === "ready_to_send") return "Ready to send";
    if (st === "accepted") return "Accepted";
    if (st === "approved") return "Approved";
    if (st === "archived") return "Archived";
    if (st === "declined") return "Declined";
    if (st === "draft") return "Draft";
    if (st === "sent") return "Sent";
    if (!st) return "—";
    return st.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function formatDate(iso) {
    const t = String(iso || "").trim();
    if (!t) return "—";
    const d = t.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "—";
  }

  function formatMoney(amount, currency) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return "—";
    const cur = String(currency || "USD").trim() || "USD";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: cur,
        maximumFractionDigits: 2,
      }).format(n);
    } catch (_err) {
      return `${cur} ${n.toFixed(2)}`;
    }
  }

  function sellerOwnerLabel(quote) {
    const email = String(quote?.seller_email || "").trim();
    if (email) return email;
    if (normStatus(quote?.created_by_role) === "seller") return "Seller";
    return "Owner";
  }

  function projectLabel(quote) {
    const name = String(quote?.project_name || "").trim();
    if (name) return name;
    const title = String(quote?.title || "").trim();
    return title || "—";
  }

  function applyPublishedKpi() {
    const labelEl = $("saKpiSentLabel");
    const valueEl = $("saKpiSent");
    if (labelEl) labelEl.textContent = "Published This Month";
    if (valueEl && publishedThisMonth != null) {
      valueEl.textContent = String(publishedThisMonth);
      valueEl.title = "Quotes published (created) this UTC month — not email sent";
    }
  }

  function installKpiOverwriteGuard() {
    if (kpiObserverInstalled) return;
    const valueEl = $("saKpiSent");
    if (!valueEl) return;
    kpiObserverInstalled = true;
    const observer = new MutationObserver(() => {
      if (valueEl.textContent === "Not available yet" && publishedThisMonth != null) {
        applyPublishedKpi();
      }
    });
    observer.observe(valueEl, { childList: true, characterData: true, subtree: true });
  }

  function setPipelineState(state, message) {
    const loading = $("saQuotePipelineLoading");
    const err = $("saQuotePipelineError");
    const errMsg = $("saQuotePipelineErrorMsg");
    const empty = $("saQuotePipelineEmpty");
    const wrap = $("saQuotePipelineTableWrap");
    if (loading) loading.hidden = state !== "loading";
    if (err) err.hidden = state !== "error";
    if (errMsg && message) errMsg.textContent = message;
    if (empty) empty.hidden = state !== "empty";
    if (wrap) wrap.hidden = state !== "ready";
    if (state === "loading") {
      if (empty) empty.hidden = true;
      if (err) err.hidden = true;
      if (wrap) wrap.hidden = true;
    }
  }

  function renderQuotePipeline(quotes) {
    const body = $("saQuotePipelineBody");
    if (!body) return;

    if (!Array.isArray(quotes) || quotes.length === 0) {
      body.innerHTML = "";
      setPipelineState("empty");
      return;
    }

    body.innerHTML = quotes
      .map((quote) => {
        const estimate = String(quote.quote_number_display || "").trim() || "—";
        const status = formatStatusLabel(quote.status);
        const linked = quote.has_tenant_project ? "Yes" : "No";
        return (
          "<tr>" +
          `<td>${escapeHtml(estimate)}</td>` +
          `<td>${escapeHtml(projectLabel(quote))}</td>` +
          `<td>${escapeHtml(String(quote.client_name || "").trim() || "—")}</td>` +
          `<td>${escapeHtml(status)}</td>` +
          `<td>${escapeHtml(sellerOwnerLabel(quote))}</td>` +
          `<td>${escapeHtml(formatMoney(quote.total, quote.currency))}</td>` +
          `<td>${escapeHtml(formatDate(quote.created_at))}</td>` +
          `<td>${escapeHtml(formatDate(quote.accepted_at))}</td>` +
          `<td>${escapeHtml(linked)}</td>` +
          "</tr>"
        );
      })
      .join("");

    setPipelineState("ready");
  }

  async function loadQuotePipeline() {
    if (!$("saQuotePipelineSection")) return;

    setPipelineState("loading");

    try {
      const response = await fetch(`${API}${LIST_QUERY}`, {
        method: "GET",
        credentials: "include",
      });
      let data = {};
      try {
        data = await response.json();
      } catch (_err) {
        data = {};
      }

      if (response.status === 401 || response.status === 403) {
        setPipelineState("error", "Owner sign-in required to view quote pipeline.");
        return;
      }

      if (!response.ok || data.ok !== true) {
        const msg = String(data.error || "Unable to load quotes.").trim();
        setPipelineState("error", msg);
        return;
      }

      if (data.summary && typeof data.summary.published_this_month === "number") {
        publishedThisMonth = data.summary.published_this_month;
        applyPublishedKpi();
        installKpiOverwriteGuard();
      }

      renderQuotePipeline(data.quotes);
    } catch (err) {
      setPipelineState("error", err?.message || "Unexpected error loading quotes.");
    }
  }

  function boot() {
    if (!$("saQuotePipelineSection")) return;

    const refreshBtn = $("saQuotePipelineRefresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        void loadQuotePipeline();
      });
    }

    void loadQuotePipeline();

    window.setTimeout(applyPublishedKpi, 0);
    window.setTimeout(applyPublishedKpi, 250);
    window.setTimeout(applyPublishedKpi, 1000);
    window.setTimeout(applyPublishedKpi, 2500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
