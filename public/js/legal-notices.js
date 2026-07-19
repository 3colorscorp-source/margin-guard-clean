/**
 * CH-004A6 — Owner/Admin legal notices management workspace.
 * GET + POST /.netlify/functions/tenant-contract-legal-notices only.
 * Does not generate legal language or connect Contract Builder writes.
 */
(() => {
  "use strict";

  const API = "/.netlify/functions/tenant-contract-legal-notices";
  /** Client max matches CH-004A4 backend enforcement. */
  const MAX_LEN = 4000;

  const NOTICE_FIELDS = [
    {
      key: "contract_notice",
      title: "Contract Notice",
      description: "Core contract terms and conditions that apply to customer agreements.",
    },
    {
      key: "payment_notice",
      title: "Payment Notice",
      description: "Payment timing, methods, and related payment obligations.",
    },
    {
      key: "change_order_notice",
      title: "Change Order Notice",
      description: "How changes to scope, price, or schedule must be documented.",
    },
    {
      key: "cancellation_notice",
      title: "Cancellation Notice",
      description: "Cancellation, termination, and related customer/contractor rights.",
    },
    {
      key: "warranty_notice",
      title: "Warranty Notice",
      description: "Warranty coverage language and related limitations.",
    },
    {
      key: "limitation_of_liability",
      title: "Limitation of Liability",
      description: "Liability limits and related protective language.",
    },
    {
      key: "permit_notice",
      title: "Permit Notice",
      description: "Permits, inspections, and related compliance responsibilities.",
    },
    {
      key: "site_conditions_notice",
      title: "Site Conditions Notice",
      description: "Jobsite access, existing conditions, and disclosure expectations.",
    },
    {
      key: "cleanup_notice",
      title: "Cleanup Notice",
      description: "Jobsite cleanup and debris-handling expectations.",
    },
    {
      key: "material_notice",
      title: "Material Notice",
      description: "Materials, substitutions, and supply-related terms.",
    },
    {
      key: "dispute_notice",
      title: "Dispute Notice",
      description: "Dispute resolution expectations before escalation.",
    },
    {
      key: "force_majeure_notice",
      title: "Force Majeure",
      description: "Delays or failures caused by events outside either party’s control.",
    },
    {
      key: "governing_law_notice",
      title: "Governing Law",
      description: "Governing law and venue language for this tenant.",
    },
    {
      key: "additional_terms",
      title: "Additional Terms",
      description: "Any other standard legal language to include with contracts.",
    },
  ];

  let expectedUpdatedAt = null;
  let busy = false;

  function $(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value ?? "").trim();
  }

  function waitForAuthReady() {
    return new Promise((resolve) => {
      if (document.body?.classList.contains("auth-ready")) {
        resolve();
        return;
      }
      const timer = setInterval(() => {
        if (document.body?.classList.contains("auth-ready")) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 8000);
    });
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, {
      credentials: "include",
      ...(options || {}),
      headers: {
        ...(options?.body ? { "Content-Type": "application/json" } : {}),
        ...(options?.headers || {}),
      },
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  function formatWhen(raw) {
    const s = trim(raw);
    if (!s) return "—";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(d);
    } catch (_err) {
      return s;
    }
  }

  function statusLabel(readiness, notices) {
    const st = String(readiness?.status || (notices ? "draft" : "missing"))
      .trim()
      .toLowerCase();
    if (st === "configured") return "Configured ✓";
    if (st === "draft") return "Draft";
    return "Missing";
  }

  function setNotice(message, kind) {
    const el = $("lnNotice");
    if (!el) return;
    const text = trim(message);
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      el.className = "ln-notice";
      return;
    }
    el.hidden = false;
    el.textContent = text;
    el.className = "ln-notice " + (kind || "warn");
  }

  function showAccessDenied(message) {
    $("lnLoading")?.setAttribute("hidden", "");
    $("lnWorkspace")?.setAttribute("hidden", "");
    const denied = $("lnAccessDenied");
    if (denied) denied.hidden = false;
    const msg = $("lnAccessDeniedMessage");
    if (msg) msg.textContent = message || "Owner or admin membership is required to manage legal notices.";
  }

  function showWorkspace() {
    $("lnLoading")?.setAttribute("hidden", "");
    $("lnAccessDenied")?.setAttribute("hidden", "");
    const ws = $("lnWorkspace");
    if (ws) ws.hidden = false;
  }

  function showLoading() {
    $("lnAccessDenied")?.setAttribute("hidden", "");
    $("lnWorkspace")?.setAttribute("hidden", "");
    $("lnLoading")?.removeAttribute("hidden");
  }

  function setBusy(next) {
    busy = !!next;
    const save = $("lnSaveDraft");
    const confirm = $("lnConfirm");
    if (save) save.disabled = busy;
    if (confirm) confirm.disabled = busy;
  }

  function buildSections() {
    const root = $("lnSections");
    if (!root) return;
    root.textContent = "";

    for (const field of NOTICE_FIELDS) {
      const section = document.createElement("section");
      section.className = "ln-section";
      section.dataset.field = field.key;

      const title = document.createElement("h3");
      title.textContent = field.title;
      section.appendChild(title);

      const desc = document.createElement("p");
      desc.className = "ln-desc";
      desc.textContent = field.description;
      section.appendChild(desc);

      const textarea = document.createElement("textarea");
      textarea.id = `ln_${field.key}`;
      textarea.name = field.key;
      textarea.maxLength = MAX_LEN;
      textarea.spellcheck = true;
      textarea.setAttribute("aria-label", field.title);
      textarea.addEventListener("input", () => updateCounter(field.key));
      section.appendChild(textarea);

      const counter = document.createElement("div");
      counter.className = "ln-counter";
      counter.id = `ln_count_${field.key}`;
      counter.textContent = `0 / ${MAX_LEN}`;
      section.appendChild(counter);

      root.appendChild(section);
    }
  }

  function updateCounter(key) {
    const textarea = $(`ln_${key}`);
    const counter = $(`ln_count_${key}`);
    if (!textarea || !counter) return;
    const len = String(textarea.value || "").length;
    counter.textContent = `${len} / ${MAX_LEN}`;
    counter.classList.toggle("is-over", len > MAX_LEN);
  }

  function readFormNotices() {
    const notices = {};
    const errors = [];
    for (const field of NOTICE_FIELDS) {
      const el = $(`ln_${field.key}`);
      const raw = el ? String(el.value ?? "") : "";
      const value = raw.trim();
      if (value.length > MAX_LEN) {
        errors.push(`${field.title} exceeds ${MAX_LEN} characters`);
      }
      notices[field.key] = value;
    }
    return { notices, errors };
  }

  function fillForm(notices) {
    for (const field of NOTICE_FIELDS) {
      const el = $(`ln_${field.key}`);
      if (!el) continue;
      const value =
        notices && typeof notices === "object" && !Array.isArray(notices)
          ? String(notices[field.key] ?? "")
          : "";
      el.value = value;
      updateCounter(field.key);
    }
  }

  function applyServerState(payload) {
    const notices = payload?.notices || null;
    const readiness = payload?.readiness || { status: notices ? "draft" : "missing" };
    expectedUpdatedAt = notices?.updated_at || null;
    fillForm(notices);
    const statusEl = $("lnStatusValue");
    if (statusEl) statusEl.textContent = statusLabel(readiness, notices);
    const updatedEl = $("lnUpdatedAt");
    if (updatedEl) updatedEl.textContent = formatWhen(notices?.updated_at);
    const confirmedEl = $("lnConfirmedAt");
    if (confirmedEl) {
      confirmedEl.textContent = formatWhen(
        notices?.confirmed_at || readiness?.confirmed_at || null
      );
    }
  }

  async function loadNotices() {
    showLoading();
    setNotice("", "");
    let res;
    try {
      res = await fetchJson(API, { method: "GET" });
    } catch (_err) {
      showAccessDenied("Legal notices could not be loaded. Check your connection and try again.");
      setNotice("Network error while loading legal notices.", "err");
      return false;
    }

    if (res.status === 401) {
      showAccessDenied("Sign in to manage legal notices.");
      return false;
    }
    if (res.status === 403) {
      showAccessDenied("Owner or admin membership is required to manage legal notices.");
      return false;
    }
    if (!(res.ok && res.data?.ok === true)) {
      const msg =
        res.status === 404
          ? "Legal notices are unavailable right now."
          : res.data?.error || "Legal notices could not be loaded.";
      showAccessDenied(msg);
      setNotice(msg, "err");
      return false;
    }

    applyServerState(res.data);
    showWorkspace();
    return true;
  }

  async function save({ confirm }) {
    if (busy) return;
    setNotice("", "");
    const { notices, errors } = readFormNotices();
    if (errors.length) {
      setNotice(errors[0], "err");
      return;
    }

    setBusy(true);
    let res;
    try {
      res = await fetchJson(API, {
        method: "POST",
        body: JSON.stringify({
          ...notices,
          confirm_notices: confirm === true,
          expected_updated_at: expectedUpdatedAt,
        }),
      });
    } catch (_err) {
      setBusy(false);
      setNotice("Network error while saving legal notices.", "err");
      return;
    }
    setBusy(false);

    if (res.status === 401) {
      showAccessDenied("Sign in to manage legal notices.");
      return;
    }
    if (res.status === 403) {
      showAccessDenied("Owner or admin membership is required to manage legal notices.");
      return;
    }
    if (res.status === 409) {
      setNotice(
        "Someone updated these legal notices. Reload the page before editing again.",
        "warn"
      );
      return;
    }
    if (!(res.ok && res.data?.ok === true)) {
      const msg =
        res.data?.message ||
        res.data?.error ||
        (res.status === 500
          ? "Legal notices are temporarily unavailable."
          : "Legal notices could not be saved.");
      setNotice(String(msg), "err");
      return;
    }

    applyServerState(res.data);
    setNotice(
      confirm
        ? "Legal notices confirmed."
        : "Legal notices draft saved.",
      "ok"
    );
  }

  function bindActions() {
    $("lnSaveDraft")?.addEventListener("click", () => {
      void save({ confirm: false });
    });
    $("lnConfirm")?.addEventListener("click", () => {
      void save({ confirm: true });
    });
  }

  async function init() {
    buildSections();
    bindActions();
    await waitForAuthReady();
    if (
      document.body?.dataset?.requiresAuth === "true" &&
      !document.body.classList.contains("auth-ready")
    ) {
      showAccessDenied("Sign in to manage legal notices.");
      return;
    }
    await loadNotices();
  }

  document.addEventListener("DOMContentLoaded", () => {
    void init();
  });
})();
