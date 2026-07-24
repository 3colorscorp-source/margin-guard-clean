/**
 * CH-004A7B — Owner/Admin legal notices workspace.
 * Working draft + confirmed snapshot. GET/POST only.
 * Defaults come from the API (server canonical module). Never auto-confirm.
 */
(() => {
  "use strict";

  const API = "/.netlify/functions/tenant-contract-legal-notices";
  const MAX_LEN = 4000;
  const LEAVE_MSG = "You have unsaved legal notice changes.";

  const NOTICE_FIELDS = [
    {
      key: "contract_notice",
      title: "Contract Notice",
      description:
        "Core contract terms and conditions that apply to customer agreements.",
    },
    {
      key: "payment_notice",
      title: "Payment Notice",
      description:
        "Payment timing, methods, and related payment obligations.",
    },
    {
      key: "change_order_notice",
      title: "Change Order Notice",
      description:
        "How changes to scope, price, or schedule must be documented.",
    },
    {
      key: "cancellation_notice",
      title: "Cancellation Notice",
      description:
        "Cancellation, termination, and related customer/contractor rights.",
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
      description:
        "Permits, inspections, and related compliance responsibilities.",
    },
    {
      key: "site_conditions_notice",
      title: "Site Conditions Notice",
      description:
        "Jobsite access, existing conditions, and disclosure expectations.",
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
      description:
        "Delays or failures caused by events outside either party’s control.",
    },
    {
      key: "governing_law_notice",
      title: "Governing Law",
      description: "Governing law and venue language for this tenant.",
    },
    {
      key: "additional_terms",
      title: "Additional Terms",
      description:
        "Any other standard legal language to include with contracts.",
    },
  ];

  /** @type {Record<string, string>} */
  let defaults = {};
  /** @type {Record<string, string>} */
  let serverTexts = {};
  /** @type {Record<string, boolean>} */
  let serverEnabled = {};
  let expectedUpdatedAt = null;
  let hasUnconfirmedChanges = false;
  let editingKey = null;
  /** @type {{ text: string, enabled: boolean } | null} */
  let editBaseline = null;
  let dirty = false;
  let busy = false;

  function $(id) {
    return document.getElementById(id);
  }

  function trim(value) {
    return String(value ?? "").trim();
  }

  function normalizeForCompare(value) {
    return String(value ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
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

  function statusLabel(readiness) {
    const st = String(readiness?.status || "missing")
      .trim()
      .toLowerCase();
    if (st === "configured") return "Configured ✓";
    if (st === "draft") return "Draft";
    return "Missing";
  }

  function setDirty(next) {
    dirty = !!next;
  }

  function markDirty() {
    setDirty(true);
  }

  function clearDirty() {
    setDirty(false);
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
    if (msg) {
      msg.textContent =
        message ||
        "Owner or admin membership is required to manage legal notices.";
    }
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
    const bulk = $("lnBulkDefaults");
    if (save) save.disabled = busy;
    if (confirm) confirm.disabled = busy;
    if (bulk) bulk.disabled = busy;
    for (const field of NOTICE_FIELDS) {
      const section = document.querySelector(
        `.ln-section[data-field="${field.key}"]`
      );
      if (!section) continue;
      section
        .querySelectorAll("button, input[type='checkbox']")
        .forEach((el) => {
          el.disabled = busy;
        });
    }
  }

  function getTextarea(key) {
    return $(`ln_${key}`);
  }

  function getCheckbox(key) {
    return $(`ln_en_${key}`);
  }

  function updateCounter(key) {
    const textarea = getTextarea(key);
    const counter = $(`ln_count_${key}`);
    if (!textarea || !counter) return;
    const len = String(textarea.value || "").length;
    counter.textContent = `${len} / ${MAX_LEN}`;
    counter.classList.toggle("is-over", len > MAX_LEN);
  }

  function badgeKind(key) {
    const enabled = getCheckbox(key)?.checked !== false;
    const text = String(getTextarea(key)?.value ?? "");
    if (!enabled) return "disabled";
    if (!trim(text)) return "empty";
    const def = defaults[key] || "";
    if (normalizeForCompare(text) === normalizeForCompare(def)) return "default";
    return "customized";
  }

  function badgeLabel(kind) {
    if (kind === "disabled") return "Disabled";
    if (kind === "empty") return "Empty";
    if (kind === "default") return "Default";
    return "Customized";
  }

  function refreshBadge(key) {
    const badge = $(`ln_badge_${key}`);
    if (!badge) return;
    const kind = badgeKind(key);
    badge.className = "ln-badge " + kind;
    badge.textContent = badgeLabel(kind);
  }

  function refreshRestoreButton(key) {
    const btn = $(`ln_restore_${key}`);
    if (!btn) return;
    const text = String(getTextarea(key)?.value ?? "");
    const def = defaults[key] || "";
    const same = normalizeForCompare(text) === normalizeForCompare(def);
    btn.disabled = busy || same || !def;
    btn.title = same
      ? "Already using the Margin Guard starting template"
      : "Restore the Margin Guard starting template";
  }

  function setCardMode(key, editing) {
    const section = document.querySelector(
      `.ln-section[data-field="${key}"]`
    );
    if (!section) return;
    const textarea = getTextarea(key);
    const counter = $(`ln_count_${key}`);
    const btnEdit = $(`ln_edit_${key}`);
    const btnSave = $(`ln_save_${key}`);
    const btnCancel = $(`ln_cancel_${key}`);
    const btnRestore = $(`ln_restore_${key}`);

    section.classList.toggle("is-editing", editing);
    if (textarea) {
      textarea.readOnly = !editing;
      if (editing) {
        try {
          textarea.focus();
          const len = textarea.value.length;
          textarea.setSelectionRange(len, len);
        } catch (_err) {
          /* ignore */
        }
      }
    }
    if (counter) counter.hidden = !editing;
    if (btnEdit) btnEdit.hidden = editing;
    if (btnSave) btnSave.hidden = !editing;
    if (btnCancel) btnCancel.hidden = !editing;
    if (btnRestore) btnRestore.hidden = !editing;
    updateCounter(key);
    refreshBadge(key);
    refreshRestoreButton(key);
  }

  function exitEditMode({ restore }) {
    if (!editingKey) return;
    const key = editingKey;
    if (restore && editBaseline) {
      const ta = getTextarea(key);
      const cb = getCheckbox(key);
      if (ta) ta.value = editBaseline.text;
      if (cb) cb.checked = editBaseline.enabled;
      updateCounter(key);
    }
    editingKey = null;
    editBaseline = null;
    setCardMode(key, false);
    refreshBadge(key);
    refreshRestoreButton(key);
    refreshBulkBar();
  }

  function enterEditMode(key) {
    if (busy) return;
    if (editingKey && editingKey !== key) {
      if (
        editBaseline &&
        (String(getTextarea(editingKey)?.value ?? "") !== editBaseline.text ||
          getCheckbox(editingKey)?.checked !== editBaseline.enabled)
      ) {
        if (
          !window.confirm(
            "You have unsaved edits on another notice. Discard them and edit this one?"
          )
        ) {
          return;
        }
      }
      exitEditMode({ restore: true });
      syncDirtyFromForm();
    }
    editingKey = key;
    editBaseline = {
      text: String(getTextarea(key)?.value ?? ""),
      enabled: getCheckbox(key)?.checked !== false,
    };
    setCardMode(key, true);
  }

  function syncDirtyFromForm() {
    for (const field of NOTICE_FIELDS) {
      const text = String(getTextarea(field.key)?.value ?? "");
      const enabled = getCheckbox(field.key)?.checked !== false;
      const serverText = serverTexts[field.key] ?? "";
      const serverEn =
        serverEnabled[field.key] !== false;
      if (text !== serverText || enabled !== serverEn) {
        setDirty(true);
        return;
      }
    }
    if (editingKey && editBaseline) {
      const text = String(getTextarea(editingKey)?.value ?? "");
      const enabled = getCheckbox(editingKey)?.checked !== false;
      if (text !== editBaseline.text || enabled !== editBaseline.enabled) {
        setDirty(true);
        return;
      }
    }
    setDirty(false);
  }

  function emptyFieldCount() {
    let n = 0;
    for (const field of NOTICE_FIELDS) {
      if (!trim(getTextarea(field.key)?.value)) n += 1;
    }
    return n;
  }

  function refreshBulkBar() {
    const bar = $("lnBulk");
    const btn = $("lnBulkDefaults");
    const hint = $("lnBulkHint");
    if (!bar || !btn || !hint) return;
    const empty = emptyFieldCount();
    if (empty === 0) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    if (empty === NOTICE_FIELDS.length) {
      btn.textContent = "Use Margin Guard Starting Templates";
      hint.textContent =
        "All notice fields are empty. Load Margin Guard starting templates into this draft (you still need to Save Draft or Confirm).";
    } else {
      btn.textContent = "Fill Empty Fields with Defaults";
      hint.textContent =
        "Some notice fields are empty. Fill only empty fields with starting templates (non-empty text is never overwritten).";
    }
  }

  function applyBulkDefaultsLocal() {
    if (busy) return;
    const empty = emptyFieldCount();
    if (empty === 0) return;

    const allEmpty = empty === NOTICE_FIELDS.length;
    const ok = window.confirm(
      allEmpty
        ? "Load Margin Guard starting templates into all empty notice fields? You will still need to Save Draft or Confirm Legal Notices."
        : "Fill empty notice fields with Margin Guard starting templates? Non-empty text will not be changed."
    );
    if (!ok) return;

    if (editingKey) exitEditMode({ restore: true });

    let filled = 0;
    for (const field of NOTICE_FIELDS) {
      const ta = getTextarea(field.key);
      if (!ta) continue;
      if (trim(ta.value)) continue;
      const def = defaults[field.key] || "";
      if (!def) continue;
      ta.value = def;
      updateCounter(field.key);
      refreshBadge(field.key);
      refreshRestoreButton(field.key);
      filled += 1;
    }
    if (filled) {
      markDirty();
      setNotice(
        `Loaded ${filled} starting template${filled === 1 ? "" : "s"} into the draft. Save Draft or Confirm to keep them.`,
        "info"
      );
    }
    refreshBulkBar();
  }

  function buildSections() {
    const root = $("lnSections");
    if (!root) return;
    root.textContent = "";

    for (const field of NOTICE_FIELDS) {
      const section = document.createElement("section");
      section.className = "ln-section";
      section.dataset.field = field.key;

      const head = document.createElement("div");
      head.className = "ln-section-head";

      const title = document.createElement("h3");
      title.textContent = field.title;
      head.appendChild(title);

      const badge = document.createElement("span");
      badge.className = "ln-badge empty";
      badge.id = `ln_badge_${field.key}`;
      badge.textContent = "Empty";
      head.appendChild(badge);
      section.appendChild(head);

      const desc = document.createElement("p");
      desc.className = "ln-desc";
      desc.textContent = field.description;
      section.appendChild(desc);

      const enableRow = document.createElement("label");
      enableRow.className = "ln-enable-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.id = `ln_en_${field.key}`;
      checkbox.checked = true;
      checkbox.addEventListener("change", () => {
        refreshBadge(field.key);
        markDirty();
      });
      enableRow.appendChild(checkbox);
      enableRow.appendChild(
        document.createTextNode("Include this notice in future contracts")
      );
      section.appendChild(enableRow);

      const textarea = document.createElement("textarea");
      textarea.id = `ln_${field.key}`;
      textarea.name = field.key;
      textarea.maxLength = MAX_LEN;
      textarea.spellcheck = true;
      textarea.readOnly = true;
      textarea.setAttribute("aria-label", field.title);
      textarea.addEventListener("input", () => {
        updateCounter(field.key);
        refreshBadge(field.key);
        refreshRestoreButton(field.key);
        markDirty();
      });
      section.appendChild(textarea);

      const counter = document.createElement("div");
      counter.className = "ln-counter";
      counter.id = `ln_count_${field.key}`;
      counter.textContent = `0 / ${MAX_LEN}`;
      counter.hidden = true;
      section.appendChild(counter);

      const actions = document.createElement("div");
      actions.className = "ln-card-actions";

      const btnEdit = document.createElement("button");
      btnEdit.type = "button";
      btnEdit.className = "btn";
      btnEdit.id = `ln_edit_${field.key}`;
      btnEdit.textContent = "Edit";
      btnEdit.addEventListener("click", () => enterEditMode(field.key));
      actions.appendChild(btnEdit);

      const btnSave = document.createElement("button");
      btnSave.type = "button";
      btnSave.className = "btn primary";
      btnSave.id = `ln_save_${field.key}`;
      btnSave.textContent = "Save Changes";
      btnSave.hidden = true;
      btnSave.addEventListener("click", () => {
        void save({ confirm: false, fromCard: field.key });
      });
      actions.appendChild(btnSave);

      const btnCancel = document.createElement("button");
      btnCancel.type = "button";
      btnCancel.className = "btn";
      btnCancel.id = `ln_cancel_${field.key}`;
      btnCancel.textContent = "Cancel";
      btnCancel.hidden = true;
      btnCancel.addEventListener("click", () => {
        exitEditMode({ restore: true });
        syncDirtyFromForm();
        setNotice("", "");
      });
      actions.appendChild(btnCancel);

      const btnRestore = document.createElement("button");
      btnRestore.type = "button";
      btnRestore.className = "btn";
      btnRestore.id = `ln_restore_${field.key}`;
      btnRestore.textContent = "Restore Default";
      btnRestore.hidden = true;
      btnRestore.addEventListener("click", () => {
        const def = defaults[field.key] || "";
        const ta = getTextarea(field.key);
        if (!ta || !def) return;
        if (
          normalizeForCompare(ta.value) === normalizeForCompare(def)
        ) {
          return;
        }
        if (
          !window.confirm(
            "Restore the Margin Guard starting template for this notice?\nYour current text will be replaced after you save."
          )
        ) {
          return;
        }
        ta.value = def;
        updateCounter(field.key);
        refreshBadge(field.key);
        refreshRestoreButton(field.key);
        markDirty();
      });
      actions.appendChild(btnRestore);

      section.appendChild(actions);
      root.appendChild(section);
    }
  }

  function readFormPayload() {
    const notices = {};
    const enabled = {};
    const errors = [];
    for (const field of NOTICE_FIELDS) {
      const el = getTextarea(field.key);
      const raw = el ? String(el.value ?? "") : "";
      if (raw.length > MAX_LEN) {
        errors.push(`${field.title} exceeds ${MAX_LEN} characters`);
      }
      notices[field.key] = raw.trim();
      enabled[`${field.key}_enabled`] =
        getCheckbox(field.key)?.checked !== false;
    }
    return { notices, enabled, errors };
  }

  function fillFormFromNotices(notices) {
    for (const field of NOTICE_FIELDS) {
      const ta = getTextarea(field.key);
      const cb = getCheckbox(field.key);
      const text =
        notices && typeof notices === "object" && !Array.isArray(notices)
          ? String(notices[field.key] ?? "")
          : "";
      const en =
        notices && typeof notices === "object"
          ? notices[`${field.key}_enabled`] !== false
          : true;
      if (ta) ta.value = text;
      if (cb) cb.checked = en;
      serverTexts[field.key] = text;
      serverEnabled[field.key] = en;
      updateCounter(field.key);
      refreshBadge(field.key);
      refreshRestoreButton(field.key);
      setCardMode(field.key, false);
    }
    editingKey = null;
    editBaseline = null;
  }

  function applyServerState(payload) {
    const notices = payload?.notices || null;
    const readiness = payload?.readiness || {
      status: notices ? "draft" : "missing",
    };
    defaults =
      payload?.defaults && typeof payload.defaults === "object"
        ? { ...payload.defaults }
        : {};
    expectedUpdatedAt = notices?.updated_at || null;
    hasUnconfirmedChanges = payload?.has_unconfirmed_changes === true;

    fillFormFromNotices(notices);

    const statusEl = $("lnStatusValue");
    if (statusEl) statusEl.textContent = statusLabel(readiness);

    const updatedEl = $("lnUpdatedAt");
    if (updatedEl) updatedEl.textContent = formatWhen(notices?.updated_at);

    const confirmedEl = $("lnConfirmedAt");
    if (confirmedEl) {
      confirmedEl.textContent = formatWhen(
        notices?.confirmed_at || readiness?.confirmed_at || null
      );
    }

    const unpublished = $("lnUnpublished");
    if (unpublished) {
      unpublished.hidden = !hasUnconfirmedChanges;
    }

    refreshBulkBar();
    clearDirty();
  }

  async function loadNotices() {
    showLoading();
    setNotice("", "");
    let res;
    try {
      res = await fetchJson(API, { method: "GET" });
    } catch (_err) {
      showAccessDenied(
        "Legal notices could not be loaded. Check your connection and try again."
      );
      setNotice("Network error while loading legal notices.", "err");
      return false;
    }

    if (res.status === 401) {
      showAccessDenied("Sign in to manage legal notices.");
      return false;
    }
    if (res.status === 403) {
      showAccessDenied(
        "Owner or admin membership is required to manage legal notices."
      );
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

  async function save({ confirm, fromCard }) {
    if (busy) return;
    setNotice("", "");

    if (confirm === true) {
      if (
        !window.confirm(
          "Publish the current enabled legal notices to future contracts?\nThis will replace the previously confirmed legal notice configuration."
        )
      ) {
        return;
      }
    }

    const { notices, enabled, errors } = readFormPayload();
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
          ...enabled,
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
      showAccessDenied(
        "Owner or admin membership is required to manage legal notices."
      );
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

    if (fromCard) {
      setNotice("Notice changes saved to draft.", "ok");
    } else if (confirm) {
      setNotice("Legal notices confirmed and published to contracts.", "ok");
    } else if (res.data.has_unconfirmed_changes) {
      setNotice(
        "Draft saved. Draft changes have not been published to contracts.",
        "warn"
      );
    } else {
      setNotice("Legal notices draft saved.", "ok");
    }
  }

  function bindGlobalActions() {
    $("lnSaveDraft")?.addEventListener("click", () => {
      if (editingKey) {
        // Keep current edit values; full-record draft save.
      }
      void save({ confirm: false });
    });
    $("lnConfirm")?.addEventListener("click", () => {
      void save({ confirm: true });
    });
    $("lnBulkDefaults")?.addEventListener("click", () => {
      applyBulkDefaultsLocal();
    });
  }

  function bindLeaveGuards() {
    window.addEventListener("beforeunload", (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = LEAVE_MSG;
    });

    document.addEventListener(
      "click",
      (event) => {
        if (!dirty) return;
        const anchor = event.target?.closest?.("a[href]");
        if (!anchor) return;
        const href = anchor.getAttribute("href") || "";
        if (!href || href.startsWith("#") || href.startsWith("javascript:")) {
          return;
        }
        if (anchor.target === "_blank") return;
        if (!window.confirm(LEAVE_MSG + " Leave this page?")) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true
    );
  }

  async function init() {
    buildSections();
    bindGlobalActions();
    bindLeaveGuards();
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
