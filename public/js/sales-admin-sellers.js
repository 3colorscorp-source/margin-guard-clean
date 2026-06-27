(() => {
  "use strict";

  const FN = "/.netlify/functions";
  const QUOTES_API = `${FN}/list-tenant-quotes`;
  const PROJECTS_API = `${FN}/get-project-control-projects`;
  const APPROVALS_API = `${FN}/get-sales-approvals`;
  const PAGE_LIMIT = 200;
  const ROW_CAP = 5000;
  const LS_SETTINGS = "mg_settings_v2";
  const DEFAULT_COMMISSION_PCT = 10;
  const DEFAULT_CURRENCY = "USD";

  const BUCKET_OWNER = "__owner_legacy__";
  const BUCKET_SELLER_UNKNOWN = "__seller_unattributed__";

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

  function normRole(raw) {
    return normStatus(raw);
  }

  function normEmail(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase();
  }

  function normQuoteId(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase();
  }

  function finiteMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  function readTenantSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object") return {};
      return parsed;
    } catch (_err) {
      return {};
    }
  }

  function readCommissionPct() {
    const settings = readTenantSettings();
    const n = Number(settings.salesCommissionPct);
    return Number.isFinite(n) ? n : DEFAULT_COMMISSION_PCT;
  }

  function readPrimaryCurrency() {
    const settings = readTenantSettings();
    const cur = String(settings.currency || "").trim();
    return cur || DEFAULT_CURRENCY;
  }

  function formatMoney(amount, currency) {
    const n = finiteMoney(amount);
    const cur = String(currency || readPrimaryCurrency()).trim() || DEFAULT_CURRENCY;
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

  function bucketForQuote(quote) {
    const email = String(quote?.seller_email || "").trim();
    if (email) {
      return { key: normEmail(email), label: email };
    }
    if (normRole(quote?.created_by_role) === "seller") {
      return { key: BUCKET_SELLER_UNKNOWN, label: "Seller (unattributed)" };
    }
    return { key: BUCKET_OWNER, label: "Owner / legacy" };
  }

  function createEmptyBucket(label) {
    return {
      label,
      quotes: 0,
      readyToSend: 0,
      acceptedApproved: 0,
      archived: 0,
      linked: 0,
      deviceQuotes: 0,
      totalQuoted: 0,
      totalsByCurrency: Object.create(null),
      laborSold: 0,
      estCommission: 0,
      linkedProjectIds: new Set(),
      approvalRequests: 0,
      approvalApproved: 0,
      approvalRejected: 0,
    };
  }

  function getOrCreateBucket(map, key, label) {
    if (!map.has(key)) {
      map.set(key, createEmptyBucket(label));
    }
    return map.get(key);
  }

  function addQuotedTotal(bucket, amount, currency) {
    const n = finiteMoney(amount);
    bucket.totalQuoted += n;
    const cur = String(currency || readPrimaryCurrency()).trim() || DEFAULT_CURRENCY;
    bucket.totalsByCurrency[cur] = finiteMoney((bucket.totalsByCurrency[cur] || 0) + n);
  }

  function aggregateQuotes(quotes) {
    const buckets = new Map();
    const quoteIdToBucketKey = new Map();

    for (const quote of quotes) {
      const { key, label } = bucketForQuote(quote);
      const bucket = getOrCreateBucket(buckets, key, label);
      quoteIdToBucketKey.set(normQuoteId(quote.id), key);

      bucket.quotes += 1;
      const st = normStatus(quote.status);
      if (st === "ready_to_send") bucket.readyToSend += 1;
      if (st === "accepted" || st === "approved") bucket.acceptedApproved += 1;
      if (st === "archived") bucket.archived += 1;
      if (quote.has_tenant_project) bucket.linked += 1;
      if (quote.from_device) bucket.deviceQuotes += 1;
      addQuotedTotal(bucket, quote.total, quote.currency);
    }

    return { buckets, quoteIdToBucketKey };
  }

  function enrichWithProjects(buckets, quoteIdToBucketKey, projects, commissionPct) {
    const seenProjectIds = new Set();
    for (const project of projects) {
      const projectId = String(project?.id || "").trim();
      if (!projectId || seenProjectIds.has(projectId)) continue;

      const quoteId = normQuoteId(project?.quoteId ?? project?.quote_id);
      if (!quoteId) continue;

      const bucketKey = quoteIdToBucketKey.get(quoteId);
      if (!bucketKey || !buckets.has(bucketKey)) continue;

      const bucket = buckets.get(bucketKey);
      if (bucket.linkedProjectIds.has(projectId)) continue;
      bucket.linkedProjectIds.add(projectId);
      seenProjectIds.add(projectId);

      const labor = finiteMoney(project.laborBudget ?? project.labor_budget);
      if (labor <= 0) continue;

      bucket.laborSold += labor;
      bucket.estCommission += finiteMoney(labor * (commissionPct / 100));
    }
  }

  function enrichWithApprovals(buckets) {
    for (const bucket of buckets.values()) {
      bucket.approvalRequests = 0;
      bucket.approvalApproved = 0;
      bucket.approvalRejected = 0;
    }
  }

  function applyApprovalRows(buckets, approvals) {
    enrichWithApprovals(buckets);

    for (const row of approvals) {
      const email = String(row?.requested_by_email || "").trim();
      const emailKey = normEmail(email);
      let bucket = null;

      if (email && buckets.has(emailKey)) {
        bucket = buckets.get(emailKey);
      } else if (email) {
        bucket = getOrCreateBucket(buckets, emailKey, email);
      } else {
        continue;
      }

      bucket.approvalRequests += 1;
      const st = normStatus(row?.status);
      if (st === "approved") bucket.approvalApproved += 1;
      if (st === "rejected") bucket.approvalRejected += 1;
    }
  }

  function computeSummary(quotes, buckets, truncated, projectJoinOk) {
    let sellerAttributed = 0;
    let ownerLegacy = 0;
    let linked = 0;
    let totalQuoted = 0;
    let approvalRequests = 0;

    for (const quote of quotes) {
      const { key } = bucketForQuote(quote);
      if (key === BUCKET_OWNER) ownerLegacy += 1;
      else sellerAttributed += 1;
      if (quote.has_tenant_project) linked += 1;
      totalQuoted += finiteMoney(quote.total);
    }

    for (const bucket of buckets.values()) {
      approvalRequests += bucket.approvalRequests;
    }

    return {
      sellerAttributed,
      ownerLegacy,
      linked,
      totalQuoted,
      approvalRequests,
      truncated,
      projectJoinOk,
      hasOwnerLegacy: ownerLegacy > 0,
      hasSellerUnattributed: buckets.has(BUCKET_SELLER_UNKNOWN),
    };
  }

  function sortBucketRows(buckets) {
    const rows = Array.from(buckets.values());
    rows.sort((a, b) => {
      const rank = (row) => {
        if (row.label === "Owner / legacy") return 2;
        if (row.label === "Seller (unattributed)") return 1;
        return 0;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (b.quotes !== a.quotes) return b.quotes - a.quotes;
      return a.label.localeCompare(b.label);
    });
    return rows;
  }

  function formatTotalQuotedCell(bucket, primaryCurrency) {
    const currencies = Object.keys(bucket.totalsByCurrency);
    const primary = finiteMoney(bucket.totalsByCurrency[primaryCurrency] ?? bucket.totalQuoted);
    const formatted = formatMoney(primary, primaryCurrency);
    if (currencies.length > 1) {
      return `${formatted} (mixed)`;
    }
    return formatted;
  }

  function setSectionState(state, message) {
    const loading = $("saSellerStatus");
    const err = $("saSellerError");
    const errMsg = $("saSellerErrorMsg");
    const empty = $("saSellerEmpty");
    const summary = $("saSellerSummary");
    const partial = $("saSellerPartialNote");
    const wrap = $("saSellerTableWrap");

    if (loading) loading.hidden = state !== "loading";
    if (err) err.hidden = state !== "error";
    if (errMsg && message) errMsg.textContent = message;
    if (empty) empty.hidden = state !== "empty";
    if (summary) summary.hidden = state === "loading" || state === "error" || state === "empty";
    if (wrap) wrap.hidden = state !== "ready";
    if (partial) partial.hidden = state !== "ready";
    if (state === "loading") {
      if (empty) empty.hidden = true;
      if (err) err.hidden = true;
      if (summary) summary.hidden = true;
      if (wrap) wrap.hidden = true;
      if (partial) partial.hidden = true;
    }
  }

  function renderPartialNote(summary) {
    const el = $("saSellerPartialNote");
    if (!el) return;

    const notes = [];
    if (summary.truncated) {
      notes.push(`Showing first ${ROW_CAP} published quotes; totals may be incomplete.`);
    }
    if (summary.hasOwnerLegacy) {
      notes.push("Owner / legacy quotes include owner-created and pre-attribution records.");
    }
    if (summary.hasSellerUnattributed) {
      notes.push("Some seller quotes lack seller_email and appear as Seller (unattributed).");
    }
    if (!summary.projectJoinOk) {
      notes.push("Labor sold and estimated commission could not be joined from converted projects.");
    }
    notes.push("Published quotes are counted by created date, not email sent.");

    if (!notes.length) {
      el.hidden = true;
      el.textContent = "";
      return;
    }

    el.hidden = false;
    el.textContent = notes.join(" ");
  }

  function renderSummaryCards(summary, primaryCurrency) {
    const el = $("saSellerSummary");
    if (!el) return;

    const cards = [
      { label: "Seller-attributed quotes", value: String(summary.sellerAttributed) },
      { label: "Owner / legacy quotes", value: String(summary.ownerLegacy) },
      { label: "Linked to project", value: String(summary.linked) },
      { label: "Total quoted", value: formatMoney(summary.totalQuoted, primaryCurrency) },
    ];

    if (summary.approvalRequests > 0) {
      cards.push({ label: "Approval requests", value: String(summary.approvalRequests) });
    }

    el.innerHTML = cards
      .map(
        (card) =>
          `<div class="sa-kpi"><div class="sa-kpi__label">${escapeHtml(card.label)}</div>` +
          `<div class="sa-kpi__value">${escapeHtml(card.value)}</div></div>`
      )
      .join("");
  }

  function renderSellerTable(rows, primaryCurrency, commissionPct) {
    const body = $("saSellerBody");
    if (!body) return;

    body.innerHTML = rows
      .map((row) => {
        const laborCell =
          row.laborSold > 0 ? formatMoney(row.laborSold, primaryCurrency) : "—";
        const commissionCell =
          row.estCommission > 0
            ? formatMoney(row.estCommission, primaryCurrency)
            : row.laborSold > 0
              ? formatMoney(0, primaryCurrency)
              : "—";

        return (
          "<tr>" +
          `<td>${escapeHtml(row.label)}</td>` +
          `<td>${escapeHtml(String(row.quotes))}</td>` +
          `<td>${escapeHtml(String(row.readyToSend))}</td>` +
          `<td>${escapeHtml(String(row.acceptedApproved))}</td>` +
          `<td>${escapeHtml(String(row.archived))}</td>` +
          `<td>${escapeHtml(String(row.linked))}</td>` +
          `<td>${escapeHtml(String(row.deviceQuotes))}</td>` +
          `<td>${escapeHtml(formatTotalQuotedCell(row, primaryCurrency))}</td>` +
          `<td>${escapeHtml(laborCell)}</td>` +
          `<td title="${escapeHtml(`${commissionPct}% of labor budget (estimate only)`)}">${escapeHtml(commissionCell)}</td>` +
          `<td>${escapeHtml(String(row.approvalRequests))}</td>` +
          `<td>${escapeHtml(String(row.approvalApproved))}</td>` +
          `<td>${escapeHtml(String(row.approvalRejected))}</td>` +
          "</tr>"
        );
      })
      .join("");
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
    });
    let data = {};
    try {
      data = await response.json();
    } catch (_err) {
      data = {};
    }
    return { response, data };
  }

  async function fetchAllQuotes() {
    const all = [];
    let offset = 0;
    let truncated = false;

    while (all.length < ROW_CAP) {
      const { response, data } = await fetchJson(
        `${QUOTES_API}?limit=${PAGE_LIMIT}&offset=${offset}&sort=created_at_desc`
      );

      if (response.status === 401 || response.status === 403) {
        return { ok: false, authError: true, quotes: [], truncated: false };
      }
      if (!response.ok || data.ok !== true) {
        return {
          ok: false,
          authError: false,
          error: String(data.error || "Unable to load quotes.").trim(),
          quotes: [],
          truncated: false,
        };
      }

      const batch = Array.isArray(data.quotes) ? data.quotes : [];
      all.push(...batch);

      if (batch.length < PAGE_LIMIT) {
        break;
      }

      offset += PAGE_LIMIT;
      if (all.length >= ROW_CAP) {
        truncated = true;
        break;
      }
    }

    return { ok: true, quotes: all.slice(0, ROW_CAP), truncated };
  }

  async function fetchProjects() {
    const { response, data } = await fetchJson(PROJECTS_API);
    if (!response.ok || data.ok !== true) {
      return { ok: false, projects: [] };
    }
    const projects = Array.isArray(data.projects) ? data.projects : [];
    return { ok: true, projects };
  }

  async function fetchApprovals() {
    const { response, data } = await fetchJson(APPROVALS_API);
    if (!response.ok || data.ok !== true) {
      return { ok: false, approvals: [] };
    }
    const approvals = Array.isArray(data.approvals) ? data.approvals : [];
    return { ok: true, approvals };
  }

  async function loadSellerPerformance() {
    if (!$("saSellerViewWrap") && !$("saSellerBody")) return;

    setSectionState("loading");

    try {
      const quoteResult = await fetchAllQuotes();

      if (quoteResult.authError) {
        setSectionState("error", "Owner sign-in required to view seller performance.");
        return;
      }
      if (!quoteResult.ok) {
        setSectionState("error", quoteResult.error || "Unable to load seller performance.");
        return;
      }

      const quotes = quoteResult.quotes;
      if (!quotes.length) {
        const summaryEl = $("saSellerSummary");
        if (summaryEl) {
          summaryEl.innerHTML = "";
          summaryEl.hidden = true;
        }
        const body = $("saSellerBody");
        if (body) body.innerHTML = "";
        setSectionState("empty");
        return;
      }

      const primaryCurrency = readPrimaryCurrency();
      const commissionPct = readCommissionPct();

      const { buckets, quoteIdToBucketKey } = aggregateQuotes(quotes);

      const [projectResult, approvalResult] = await Promise.all([
        fetchProjects(),
        fetchApprovals(),
      ]);

      if (projectResult.ok) {
        enrichWithProjects(
          buckets,
          quoteIdToBucketKey,
          projectResult.projects,
          commissionPct
        );
      }

      if (approvalResult.ok) {
        applyApprovalRows(buckets, approvalResult.approvals);
      } else {
        enrichWithApprovals(buckets);
      }

      const summary = computeSummary(
        quotes,
        buckets,
        quoteResult.truncated,
        projectResult.ok
      );

      const rows = sortBucketRows(buckets);
      renderSummaryCards(summary, primaryCurrency);
      renderSellerTable(rows, primaryCurrency, commissionPct);
      renderPartialNote(summary);
      setSectionState("ready");
    } catch (err) {
      setSectionState("error", err?.message || "Unexpected error loading seller performance.");
    }
  }

  function boot() {
    if (!$("saSellerViewWrap") && !$("saSellerBody")) return;

    window.__mgSaLoadSellerPerformance = () => {
      void loadSellerPerformance();
    };

    const refreshBtn = $("saSellerRefresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        void loadSellerPerformance();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
