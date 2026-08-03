(() => {
  "use strict";

  const PROJECTS_API = "/.netlify/functions/get-project-control-projects";
  const QUOTE_EDIT_API = "/.netlify/functions/get-tenant-quote-edit";
  const BRANDING_API = "/.netlify/functions/get-tenant-branding";
  const LEGAL_PROFILE_API = "/.netlify/functions/tenant-legal-profile";
  const LEGAL_NOTICES_API = "/.netlify/functions/tenant-contract-legal-notices";
  const CONTRACT_SETUP_API = "/.netlify/functions/project-contract-setup";
  const PAYMENT_SCHEDULE_API = "/.netlify/functions/project-contract-payment-schedule";
  const DEFAULT_CURRENCY = "USD";
  const APPROVED_QUOTE_STATUSES = new Set(["accepted", "approved"]);

  /** Display order for tenant legal notice fields (read-only). */
  const LEGAL_NOTICE_FIELDS = [
    { key: "contract_notice", label: "Contract Notice" },
    { key: "payment_notice", label: "Payment Notice" },
    { key: "change_order_notice", label: "Change Order Notice" },
    { key: "cancellation_notice", label: "Cancellation Notice" },
    { key: "warranty_notice", label: "Warranty Notice" },
    { key: "limitation_of_liability", label: "Limitation of Liability" },
    { key: "permit_notice", label: "Permit Notice" },
    { key: "site_conditions_notice", label: "Site Conditions Notice" },
    { key: "cleanup_notice", label: "Cleanup Notice" },
    { key: "material_notice", label: "Material Notice" },
    { key: "dispute_notice", label: "Dispute Notice" },
    { key: "force_majeure_notice", label: "Force Majeure" },
    { key: "governing_law_notice", label: "Governing Law" },
    { key: "additional_terms", label: "Additional Terms" },
  ];

  /** Browser-memory-only draft edits. Never persist. */
  let sourceSnapshot = null;
  let draftEdits = null;
  const undoStacks = Object.create(null);
  const redoStacks = Object.create(null);
  const revealSecrets = Object.create(null);

  /** Phase 1 sequential Builder workspace (UI only — no persistence). */
  const ARTICLE_FLOW = [
    { id: "art-notice", num: "0", title: "Draft Notice", cta: "continue", label: "Continue" },
    { id: "art-contractor", num: "1", title: "Contractor", cta: "review", label: "Review & Continue" },
    { id: "art-customer", num: "2", title: "Customer", cta: "continue", label: "Continue" },
    { id: "art-property", num: "3", title: "Property", cta: "continue", label: "Continue" },
    { id: "art-quote", num: "4", title: "Quote", cta: "review", label: "Review & Continue" },
    { id: "art-scope", num: "5", title: "Scope", cta: "continue", label: "Continue" },
    { id: "art-price", num: "6", title: "Price", cta: "review", label: "Review & Continue" },
    { id: "art-payment", num: "7", title: "Payment", cta: "continue", label: "Continue" },
    { id: "art-schedule", num: "8", title: "Schedule", cta: "continue", label: "Continue" },
    { id: "art-changes", num: "9", title: "Change Orders", cta: "continue", label: "Continue" },
    { id: "art-warranty", num: "10", title: "Warranty", cta: "continue", label: "Continue" },
    { id: "art-terms", num: "11", title: "Terms", cta: "review", label: "Review & Continue" },
    { id: "art-signatures", num: "12", title: "Signatures", cta: "signatures", label: "Preview Contract" },
  ];

  let activeArticleId = null;
  const visitedArticleIds = new Set();
  let articleBeforePreview = null;
  let suppressUnloadGuard = false;
  /** Baseline for local dirty detection (memory-only; includes init prefill). */
  let draftBaseline = null;

  /**
   * CH-007A — Article Workspace Engine (generic; article-agnostic core).
   * Consumers declare capabilities + optional hooks. Engine owns mode/footer/validation chrome.
   */
  const WS_MODE = Object.freeze({
    PREVIEW: "preview",
    EDIT: "edit",
    SAVING: "saving",
    SAVED: "saved",
  });

  /** @type {Record<string, string>} */
  const articleModes = Object.create(null);
  /** Snapshot of draftEdits when entering Edit (for Cancel restore). */
  let workspaceEditBaseline = null;
  let workspaceBusy = false;
  /** Footer busy label while payment POST is in flight. */
  let workspaceBusyLabel = "Saving…";

  /** CH-007D-P2 — payment schedule local draft (Save Draft / Confirm → existing POST). */
  let paymentDraftItems = [];
  let paymentDraftBaseline = null;
  let paymentDraftKeySeq = 1;
  const PAYMENT_TYPES_ALLOWED = new Set([
    "deposit",
    "start",
    "progress",
    "material",
    "completion",
    "final",
    "custom",
  ]);
  const DUE_RULES_ALLOWED = new Set([
    "on_signature",
    "before_start",
    "on_start",
    "milestone",
    "on_completion",
    "fixed_date",
    "custom",
  ]);

  function defaultWorkspaceCaps(overrides) {
    return {
      supportsPreview: true,
      supportsEdit: false,
      supportsSave: false,
      supportsValidation: false,
      supportsContinue: true,
      supportsExternalSource: false,
      supportsFutureMap: false,
      supportsAttachments: false,
      supportsTimeline: false,
      continueLabel: "Continue",
      editLabel: "Edit",
      saveLabel: "Save",
      doneLabel: "Done",
      cancelLabel: "Cancel",
      externalSourceLabel: "Open Source Record",
      externalSourceHref: null,
      continueAction: "next",
      validate: null,
      onEnterPreview: null,
      onEnterEdit: null,
      onCancelEdit: null,
      onBeforeSave: null,
      onSave: null,
      onAfterSave: null,
      syncEditFromModel: null,
      renderPreviewHook: null,
      renderEditHook: null,
      ...overrides,
    };
  }

  function readinessValidation(status, okMessage, warnMessage, blockMessage) {
    if (status === "available") {
      return { level: "ok", badge: "Ready", message: okMessage || "Looks complete." };
    }
    if (status === "needs_confirmation") {
      return {
        level: "warn",
        badge: "Needs confirmation",
        message: warnMessage || "Review and confirm before signature.",
      };
    }
    return {
      level: "block",
      badge: "Missing",
      message: blockMessage || "Required information is missing.",
      blocking: true,
    };
  }

  /**
   * Workspace capability registry — engine does not hardcode Property/Payment save logic.
   * CH-007B+ consumers enrich hooks (onSave, structured edit) without rewriting the engine.
   */
  const WORKSPACE_REGISTRY = {
    "art-notice": defaultWorkspaceCaps({
      supportsValidation: true,
      continueLabel: "Continue",
      validate: () =>
        readinessValidation(
          overallContractReadiness(sourceSnapshot) === "configured"
            ? "available"
            : "needs_confirmation",
          "Draft notice reviewed.",
          "Contract is still a draft — continue reviewing articles.",
          "Contract readiness is incomplete."
        ),
    }),
    "art-contractor": defaultWorkspaceCaps({
      supportsValidation: true,
      supportsExternalSource: true,
      externalSourceLabel: "Open Legal Profile",
      externalSourceHref: "/business-settings#legal-contract-profile",
      continueLabel: "Review & Continue",
      validate: () => {
        const st = articleReadinessStatus("art-contractor", sourceSnapshot, draftEdits);
        return readinessValidation(
          st,
          "Contractor identity is available.",
          "Contractor details need confirmation.",
          "Complete Legal Profile."
        );
      },
    }),
    "art-customer": defaultWorkspaceCaps({
      supportsValidation: true,
      continueLabel: "Continue",
      validate: () => {
        const st = articleReadinessStatus("art-customer", sourceSnapshot, draftEdits);
        return readinessValidation(
          st,
          "Customer identity is available.",
          "Customer details need review.",
          "Customer name is required."
        );
      },
    }),
    "art-property": defaultWorkspaceCaps({
      supportsEdit: true,
      supportsSave: true,
      supportsValidation: true,
      supportsFutureMap: true,
      continueLabel: "Continue",
      editLabel: "Edit Property",
      saveLabel: "Confirm Property",
      validate: () => validatePropertyWorkspace(),
      syncEditFromModel: () => syncPropertyInputsFromModel(),
      onEnterEdit: () => {
        updatePropertyLiveHint();
      },
      onBeforeSave: () => {
        const check = validatePropertyWorkspace({ forSave: true });
        updatePropertyLiveHint(check);
        renderWorkspaceChrome();
        if (check.blocking) return false;
        return true;
      },
      onSave: async () => {
        await savePropertyWorkspace();
      },
    }),
    "art-quote": defaultWorkspaceCaps({
      supportsValidation: true,
      continueLabel: "Review & Continue",
      validate: () => {
        const st = articleReadinessStatus("art-quote", sourceSnapshot, draftEdits);
        return readinessValidation(
          st,
          "Approved quote is linked.",
          "Quote needs review.",
          "Approved quote is missing."
        );
      },
    }),
    "art-scope": defaultWorkspaceCaps({
      supportsEdit: false,
      supportsSave: false,
      supportsValidation: true,
      continueLabel: "Continue",
      validate: () => {
        const st = articleReadinessStatus("art-scope", sourceSnapshot, draftEdits);
        return readinessValidation(
          st,
          "Scope is present from the approved quote.",
          "Scope should be reviewed against the approved quote.",
          "Scope of work is missing on the approved quote."
        );
      },
    }),
    "art-price": defaultWorkspaceCaps({
      supportsEdit: false,
      supportsSave: false,
      supportsValidation: true,
      continueLabel: "Review & Continue",
      validate: () => {
        const st = articleReadinessStatus("art-price", sourceSnapshot, draftEdits);
        return readinessValidation(
          st,
          "Contract total is set from the approved quote.",
          "Price needs review.",
          "Contract total is missing."
        );
      },
    }),
    "art-payment": defaultWorkspaceCaps({
      supportsEdit: true,
      supportsSave: true,
      supportsValidation: true,
      supportsTimeline: true,
      continueLabel: "Continue",
      editLabel: "Edit Payment Schedule",
      saveLabel: "Save Draft",
      validate: () => validatePaymentWorkspace(),
      syncEditFromModel: () => {
        hydratePaymentDraftFromSource(sourceSnapshot);
        renderPaymentEditGrid();
      },
      onEnterEdit: () => {
        bindPaymentEditHandlersOnce();
        renderPaymentEditGrid();
      },
      onCancelEdit: () => {
        if (paymentDraftBaseline) {
          paymentDraftItems = clonePaymentDraftItems(paymentDraftBaseline);
        } else {
          hydratePaymentDraftFromSource(sourceSnapshot);
        }
      },
      onBeforeSave: () => {
        const check = validatePaymentDraftForSave();
        updatePaymentEditHint(check);
        renderWorkspaceChrome();
        if (check.blocking) return false;
        return true;
      },
      onSave: async () => {
        await savePaymentScheduleDraft(false);
      },
    }),
    "art-schedule": defaultWorkspaceCaps({
      supportsEdit: true,
      supportsSave: false,
      supportsValidation: true,
      continueLabel: "Continue",
      validate: () => {
        const st = articleReadinessStatus("art-schedule", sourceSnapshot, draftEdits);
        return readinessValidation(
          st,
          "Schedule dates are set.",
          "Schedule dates are draft-only.",
          "Schedule dates are not set."
        );
      },
    }),
    "art-changes": defaultWorkspaceCaps({
      continueLabel: "Continue",
    }),
    "art-warranty": defaultWorkspaceCaps({
      supportsEdit: true,
      supportsSave: true,
      supportsValidation: true,
      continueLabel: "Continue",
      editLabel: "Edit Warranty",
      saveLabel: "Confirm Warranty",
      validate: () => validateWarrantyWorkspace(),
      syncEditFromModel: () => syncWarrantyInputsFromModel(),
      onEnterEdit: () => {
        updateWarrantyLiveHint();
      },
      onBeforeSave: () => {
        const check = validateWarrantyWorkspace({ forSave: true });
        updateWarrantyLiveHint(check);
        renderWorkspaceChrome();
        if (check.blocking) return false;
        return true;
      },
      onSave: async () => {
        await saveWarrantyWorkspace();
      },
    }),
    "art-terms": defaultWorkspaceCaps({
      supportsEdit: false,
      supportsSave: false,
      supportsValidation: true,
      supportsExternalSource: true,
      externalSourceLabel: "Open Legal Notices",
      externalSourceHref: "/legal-notices",
      continueLabel: "Review & Continue",
      validate: () => {
        const st = articleReadinessStatus("art-terms", sourceSnapshot, draftEdits);
        return readinessValidation(
          st,
          "Legal notices are confirmed for contracts.",
          "Legal notices still need confirmation in Legal Notices.",
          "Legal notices are missing. Open Legal Notices to confirm."
        );
      },
    }),
    "art-signatures": defaultWorkspaceCaps({
      supportsValidation: true,
      supportsExternalSource: false,
      continueLabel: "Preview Contract",
      continueAction: "previewContract",
      validate: () => {
        const st = articleReadinessStatus("art-signatures", sourceSnapshot, draftEdits);
        return readinessValidation(
          st,
          "Signature method is configured.",
          "Signature setup is deferred to a later phase.",
          "Signature method is not configured yet (later phase)."
        );
      },
    }),
  };

  function getWorkspace(articleId) {
    return WORKSPACE_REGISTRY[articleId] || defaultWorkspaceCaps({ continueLabel: "Continue" });
  }

  function getArticleMode(articleId) {
    if (!articleId) return WS_MODE.PREVIEW;
    return articleModes[articleId] || WS_MODE.PREVIEW;
  }

  function workspaceContext(articleId) {
    return {
      articleId,
      mode: getArticleMode(articleId),
      source: sourceSnapshot,
      edits: draftEdits,
      caps: getWorkspace(articleId),
      el: articleId ? document.getElementById(articleId) : null,
    };
  }

  function runWorkspaceValidation(articleId) {
    const caps = getWorkspace(articleId);
    if (!caps.supportsValidation || typeof caps.validate !== "function") {
      return { level: "ok", badge: "", message: "", blocking: false };
    }
    try {
      const result = caps.validate(workspaceContext(articleId)) || {};
      return {
        level: result.level || "ok",
        badge: result.badge || "",
        message: result.message || "",
        blocking: result.blocking === true,
      };
    } catch (_err) {
      return { level: "warn", badge: "Check", message: "Validation unavailable.", blocking: false };
    }
  }

  function applyWorkspaceModeToDom(articleId, mode) {
    const el = articleId ? document.getElementById(articleId) : null;
    if (!el) return;
    el.setAttribute("data-ws-mode", mode);
    el.classList.toggle("is-ws-saving", mode === WS_MODE.SAVING);
    el.classList.toggle("is-ws-saved", mode === WS_MODE.SAVED);
    el.classList.toggle("is-ws-edit", mode === WS_MODE.EDIT);
    el.classList.toggle("is-ws-preview", mode === WS_MODE.PREVIEW);
  }

  function syncAllWorkspaceModes() {
    document.querySelectorAll("[data-article]").forEach((article) => {
      const mode =
        isPreviewMode() || !activeArticleId || article.id !== activeArticleId
          ? WS_MODE.PREVIEW
          : getArticleMode(article.id);
      applyWorkspaceModeToDom(article.id, mode);
    });
  }

  function setArticleMode(articleId, mode) {
    if (!articleId) return;
    articleModes[articleId] = mode;
    applyWorkspaceModeToDom(articleId, mode);
  }

  async function workspaceEnterPreview(articleId) {
    if (!articleId) return;
    workspaceEditBaseline = null;
    setArticleMode(articleId, WS_MODE.PREVIEW);
    const caps = getWorkspace(articleId);
    if (typeof caps.onEnterPreview === "function") {
      await caps.onEnterPreview(workspaceContext(articleId));
    }
    if (typeof caps.renderPreviewHook === "function") {
      caps.renderPreviewHook(workspaceContext(articleId));
    }
    renderWorkspaceChrome();
  }

  async function workspaceEnterEdit(articleId) {
    if (!articleId || workspaceBusy) return false;
    const caps = getWorkspace(articleId);
    if (!caps.supportsEdit) return false;
    if (articleId === "art-payment" && !paymentScheduleAllowsOwnerEdit()) {
      showError("Payment Schedule", "Confirmed payment schedules are read-only.");
      return false;
    }
    readEditsFromInputs();
    workspaceEditBaseline = draftEdits ? { ...draftEdits } : null;
    if (articleId === "art-payment") {
      paymentDraftBaseline = clonePaymentDraftItems(paymentDraftItems);
    }
    setArticleMode(articleId, WS_MODE.EDIT);
    if (typeof caps.syncEditFromModel === "function") {
      caps.syncEditFromModel(workspaceContext(articleId));
    } else {
      syncInputsFromEdits(draftEdits);
    }
    if (typeof caps.onEnterEdit === "function") {
      await caps.onEnterEdit(workspaceContext(articleId));
    }
    if (typeof caps.renderEditHook === "function") {
      caps.renderEditHook(workspaceContext(articleId));
    }
    const firstInput = document.querySelector(
      `#${CSS.escape(articleId)} [data-ws-edit] input, #${CSS.escape(articleId)} [data-ws-edit] textarea, #${CSS.escape(articleId)} [data-ws-edit] select`
    );
    if (firstInput) {
      try {
        firstInput.focus({ preventScroll: true });
      } catch (_err) {
        firstInput.focus();
      }
    }
    renderWorkspaceChrome();
    return true;
  }

  async function workspaceCancelEdit(articleId) {
    if (!articleId) return;
    const caps = getWorkspace(articleId);
    if (workspaceEditBaseline && draftEdits) {
      Object.assign(draftEdits, workspaceEditBaseline);
      syncInputsFromEdits(draftEdits);
      if (sourceSnapshot) renderDocument(sourceSnapshot, draftEdits);
      updateIndexNavStatus();
    }
    workspaceEditBaseline = null;
    if (typeof caps.onCancelEdit === "function") {
      await caps.onCancelEdit(workspaceContext(articleId));
    }
    await workspaceEnterPreview(articleId);
  }

  async function workspaceDoneEdit(articleId) {
    if (!articleId) return;
    readEditsFromInputs();
    if (sourceSnapshot && draftEdits) {
      renderDocument(sourceSnapshot, draftEdits);
      updateIndexNavStatus();
    }
    workspaceEditBaseline = null;
    await workspaceEnterPreview(articleId);
  }

  async function workspaceSave(articleId) {
    if (!articleId || workspaceBusy) return false;
    const caps = getWorkspace(articleId);
    if (!caps.supportsSave || typeof caps.onSave !== "function") return false;
    readEditsFromInputs();
    if (typeof caps.onBeforeSave === "function") {
      const ok = await caps.onBeforeSave(workspaceContext(articleId));
      if (ok === false) return false;
    }
    workspaceBusy = true;
    workspaceBusyLabel = articleId === "art-payment" ? "Saving Draft…" : "Saving…";
    setArticleMode(articleId, WS_MODE.SAVING);
    renderWorkspaceChrome();
    try {
      await caps.onSave(workspaceContext(articleId));
      workspaceEditBaseline = null;
      paymentDraftBaseline = null;
      setArticleMode(articleId, WS_MODE.SAVED);
      renderWorkspaceChrome();
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (typeof caps.onAfterSave === "function") {
        await caps.onAfterSave(workspaceContext(articleId));
      }
      await workspaceEnterPreview(articleId);
      return true;
    } catch (err) {
      setArticleMode(articleId, WS_MODE.EDIT);
      renderWorkspaceChrome();
      window.alert(err?.message || "Save failed. Changes were not written.");
      return false;
    } finally {
      workspaceBusy = false;
      workspaceBusyLabel = "Saving…";
      renderWorkspaceChrome();
    }
  }

  async function workspaceConfirmPayment() {
    if (workspaceBusy) return false;
    if (!paymentScheduleAllowsOwnerEdit()) {
      window.alert("Confirmed payment schedules are read-only.");
      return false;
    }
    if (getArticleMode("art-payment") !== WS_MODE.EDIT) {
      const entered = await workspaceEnterEdit("art-payment");
      if (!entered) return false;
    }
    readPaymentDraftFromGrid();
    const check = validatePaymentDraftForConfirm();
    updatePaymentEditHint(check);
    if (check.blocking) {
      window.alert(check.message || "Schedule total must equal the contract total before confirmation.");
      renderWorkspaceChrome();
      return false;
    }
    workspaceBusy = true;
    workspaceBusyLabel = "Confirming…";
    setArticleMode("art-payment", WS_MODE.SAVING);
    renderWorkspaceChrome();
    try {
      await savePaymentScheduleDraft(true);
      workspaceEditBaseline = null;
      paymentDraftBaseline = null;
      setArticleMode("art-payment", WS_MODE.SAVED);
      renderWorkspaceChrome();
      await new Promise((resolve) => setTimeout(resolve, 700));
      await workspaceEnterPreview("art-payment");
      return true;
    } catch (err) {
      setArticleMode("art-payment", WS_MODE.EDIT);
      renderWorkspaceChrome();
      window.alert(err?.message || "Confirm failed. Schedule was not confirmed.");
      return false;
    } finally {
      workspaceBusy = false;
      workspaceBusyLabel = "Saving…";
      renderWorkspaceChrome();
    }
  }

  function isWorkspaceEditing() {
    return Boolean(activeArticleId && getArticleMode(activeArticleId) === WS_MODE.EDIT);
  }

  function createFooterButton({ id, label, className, disabled, href, onClick }) {
    if (href) {
      const a = document.createElement("a");
      a.className = className || "btn ghost";
      a.id = id;
      a.href = href;
      a.textContent = label;
      if (disabled) a.setAttribute("aria-disabled", "true");
      return a;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className || "btn ghost";
    btn.id = id;
    btn.textContent = label;
    btn.disabled = Boolean(disabled);
    if (onClick) btn.addEventListener("click", onClick);
    return btn;
  }

  function renderWorkspaceValidation(articleId) {
    const box = $("cbWsValidation");
    if (!box) return;
    if (!articleId || isPreviewMode()) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    const result = runWorkspaceValidation(articleId);
    if (!result.badge && !result.message) {
      box.hidden = true;
      box.textContent = "";
      return;
    }
    box.hidden = false;
    box.className = "cb-ws-validation";
    if (result.level === "warn") box.classList.add("is-warn");
    else if (result.level === "block") box.classList.add("is-block");
    else box.classList.add("is-ok");
    const badge = result.badge
      ? `<span class="cb-ws-badge">${escapeHtml(result.badge)}</span>`
      : "";
    box.innerHTML = `${badge}${escapeHtml(result.message || "")}`;
  }

  function renderWorkspaceFooter() {
    const footer = $("cbStepFooter");
    const actions = $("cbStepFooterActions");
    const hint = $("cbStepHint");
    if (!footer || !actions) return;

    if (isPreviewMode() || !activeArticleId) {
      footer.hidden = true;
      actions.innerHTML = "";
      return;
    }

    footer.hidden = false;
    actions.innerHTML = "";
    const caps = getWorkspace(activeArticleId);
    const mode = getArticleMode(activeArticleId);
    const busy = workspaceBusy || mode === WS_MODE.SAVING || mode === WS_MODE.SAVED;

    actions.appendChild(
      createFooterButton({
        id: "cbStepBack",
        label: "Back",
        className: "btn ghost",
        disabled: busy,
        onClick: () => {
          void handleWorkspaceBack();
        },
      })
    );

    if (mode === WS_MODE.SAVING) {
      actions.appendChild(
        createFooterButton({
          id: "cbStepSaving",
          label: workspaceBusyLabel || "Saving…",
          className: "btn primary",
          disabled: true,
        })
      );
      if (hint) hint.textContent = workspaceBusyLabel || "Saving article changes…";
      return;
    }

    if (mode === WS_MODE.SAVED) {
      actions.appendChild(
        createFooterButton({
          id: "cbStepSaved",
          label: "Saved",
          className: "btn primary",
          disabled: true,
        })
      );
      if (hint) hint.textContent = "Saved — returning to Preview.";
      return;
    }

    if (mode === WS_MODE.EDIT) {
      actions.appendChild(
        createFooterButton({
          id: "cbWsCancel",
          label: caps.cancelLabel || "Cancel",
          className: "btn ghost",
          disabled: busy,
          onClick: () => {
            void workspaceCancelEdit(activeArticleId);
          },
        })
      );
      if (caps.supportsSave) {
        actions.appendChild(
          createFooterButton({
            id: "cbWsSave",
            label: caps.saveLabel || "Save",
            className: "btn primary",
            disabled: busy,
            onClick: () => {
              void workspaceSave(activeArticleId);
            },
          })
        );
        if (activeArticleId === "art-payment" && paymentScheduleAllowsOwnerEdit()) {
          actions.appendChild(
            createFooterButton({
              id: "cbWsConfirmPay",
              label: "Confirm Schedule",
              className: "btn primary",
              disabled: busy,
              onClick: () => {
                void workspaceConfirmPayment();
              },
            })
          );
          if (hint) {
            hint.textContent =
              "Save Draft anytime. Confirm Schedule only when Scheduled equals Contract Total.";
          }
        } else if (hint) {
          hint.textContent = "Save writes this article, then returns to Preview.";
        }
      } else {
        actions.appendChild(
          createFooterButton({
            id: "cbWsDone",
            label: caps.doneLabel || "Done",
            className: "btn primary",
            disabled: busy,
            onClick: () => {
              void workspaceDoneEdit(activeArticleId);
            },
          })
        );
        if (hint) {
          hint.textContent =
            "Local draft only — Done returns to Preview. Nothing is saved to the database yet.";
        }
      }
      return;
    }

    if (caps.supportsEdit && articleAllowsOwnerEdit(activeArticleId)) {
      actions.appendChild(
        createFooterButton({
          id: "cbWsEdit",
          label: caps.editLabel || "Edit",
          className: "btn ghost",
          disabled: busy,
          onClick: () => {
            void workspaceEnterEdit(activeArticleId);
          },
        })
      );
    }

    if (
      activeArticleId === "art-payment" &&
      paymentScheduleAllowsOwnerEdit() &&
      mode === WS_MODE.PREVIEW &&
      !busy
    ) {
      actions.appendChild(
        createFooterButton({
          id: "cbWsConfirmPayPreview",
          label: "Confirm Schedule",
          className: "btn primary",
          disabled: busy,
          onClick: () => {
            void workspaceConfirmPayment();
          },
        })
      );
    }

    if (caps.supportsExternalSource && (activeArticleId === "art-contractor" || activeArticleId === "art-terms")) {
      actions.appendChild(
        createFooterButton({
          id: "cbWsExternal",
          label: caps.externalSourceLabel,
          className: "btn ghost",
          href:
            caps.externalSourceHref ||
            (activeArticleId === "art-terms"
              ? "/legal-notices"
              : "/business-settings#legal-contract-profile"),
        })
      );
    }

    if (caps.supportsContinue) {
      const label =
        activeArticleId === "art-signatures"
          ? "Preview Contract"
          : caps.continueLabel || articleMeta(activeArticleId).label || "Continue";
      actions.appendChild(
        createFooterButton({
          id: "cbStepContinue",
          label,
          className: "btn primary",
          disabled: busy,
          onClick: () => {
            void handleWorkspaceContinue();
          },
        })
      );
    }

    if (hint && mode === WS_MODE.PREVIEW) {
      if (activeArticleId === "art-scope") {
        hint.textContent = "Review only — scope comes from the approved quote.";
      } else if (activeArticleId === "art-price") {
        hint.textContent = "Review only — contract total comes from the approved quote.";
      } else if (activeArticleId === "art-terms") {
        hint.textContent = "Review only — confirm legal notices on the Legal Notices page.";
      } else if (activeArticleId === "art-payment" && !paymentScheduleAllowsOwnerEdit()) {
        hint.textContent = "Payment Schedule is confirmed and read-only.";
      } else if (caps.supportsSave) {
        hint.textContent = "Confirm writes this article. Continue only moves to the next article.";
      } else {
        hint.textContent = "Review this article, then Continue. Continue does not change readiness.";
      }
    }
  }

  function articleAllowsOwnerEdit(articleId) {
    if (articleId === "art-payment") return paymentScheduleAllowsOwnerEdit();
    return true;
  }

  function renderWorkspaceChrome() {
    syncAllWorkspaceModes();
    updateIndexNavStatus();
    renderWorkspaceValidation(activeArticleId);
    renderWorkspaceFooter();
  }

  async function handleWorkspaceBack() {
    if (!activeArticleId || workspaceBusy) return;
    if (isWorkspaceEditing()) {
      if (!window.confirm("Discard edits and leave this article?")) return;
      await workspaceCancelEdit(activeArticleId);
    }
    const idx = articleIndex(activeArticleId);
    if (idx <= 0) {
      setActiveArticle(null, { confirmIfDirty: true, focus: false });
      return;
    }
    const prev = ARTICLE_FLOW[idx - 1];
    if (!prev) return;
    setActiveArticle(prev.id, { confirmIfDirty: true, focus: true });
  }

  async function handleWorkspaceContinue() {
    if (!activeArticleId || workspaceBusy) return;
    if (isWorkspaceEditing()) {
      await workspaceDoneEdit(activeArticleId);
    }
    readEditsFromInputs();
    const caps = getWorkspace(activeArticleId);
    if (caps.continueAction === "previewContract" || activeArticleId === "art-signatures") {
      enterPreviewMode();
      return;
    }
    const idx = articleIndex(activeArticleId);
    const next = ARTICLE_FLOW[idx + 1];
    if (!next) return;
    setActiveArticle(next.id, { confirmIfDirty: false, focus: true });
  }

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

  function setText(id, value) {
    const el = $(id);
    if (!el) return;
    el.textContent = value == null || value === "" ? "—" : String(value);
  }

  function setTextMany(ids, value) {
    for (const id of ids) setText(id, value);
  }

  function finiteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function formatMoney(amount, currency) {
    const n = finiteNumber(amount, NaN);
    if (!Number.isFinite(n)) return "—";
    const cur = String(currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY;
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n);
    } catch (_err) {
      return `${cur} ${n.toFixed(2)}`;
    }
  }

  function formatDate(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s.slice(0, 10);
    try {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d);
    } catch (_err) {
      return s.slice(0, 10);
    }
  }

  function toDateInput(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "";
    return d.toISOString().slice(0, 10);
  }

  function isPlausibleId(raw) {
    const id = String(raw || "").trim();
    if (!id || id.length < 8 || id.length > 80) return false;
    return /^[a-zA-Z0-9_-]+$/.test(id);
  }

  function normStatus(raw) {
    return String(raw || "").trim().toLowerCase();
  }

  function showLoading() {
    $("cbLoading")?.removeAttribute("hidden");
    $("cbError")?.setAttribute("hidden", "");
    $("cbMain")?.setAttribute("hidden", "");
  }

  function showError(title, message) {
    $("cbLoading")?.setAttribute("hidden", "");
    $("cbMain")?.setAttribute("hidden", "");
    const wrap = $("cbError");
    if ($("cbErrorTitle")) $("cbErrorTitle").textContent = title;
    if ($("cbErrorMessage")) $("cbErrorMessage").textContent = message;
    if (wrap) wrap.removeAttribute("hidden");
  }

  function showMain() {
    $("cbLoading")?.setAttribute("hidden", "");
    $("cbError")?.setAttribute("hidden", "");
    $("cbMain")?.removeAttribute("hidden");
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

  async function fetchJson(url) {
    const res = await fetch(url, { method: "GET", credentials: "include" });
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  function quoteLabel(quote) {
    const display = String(quote?.quote_number_display || "").trim();
    if (display) return display;
    const id = String(quote?.id || "").trim();
    if (id.length >= 5) return `Quote …${id.slice(-5)}`;
    return "Not available";
  }

  function resolveContractTotal(project, quote) {
    const sale = finiteNumber(project?.salePrice ?? project?.sale_price, NaN);
    if (Number.isFinite(sale) && sale > 0) return sale;
    const total = finiteNumber(quote?.total, NaN);
    if (Number.isFinite(total) && total > 0) return total;
    return null;
  }

  function initialsFromName(name) {
    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "MG";
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function buildSource(
    project,
    quote,
    branding,
    legalBundle,
    setupBundle,
    scheduleBundle,
    legalNoticesBundle
  ) {
    const currency = String(quote?.currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY;
    const contractTotal = resolveContractTotal(project, quote);
    const address = String(quote?.project_address || quote?.job_site || "").trim();
    const notes = String(quote?.notes || "").trim();
    const terms = String(quote?.terms || "").trim();
    const scope = notes || terms || "";
    const deposit = finiteNumber(quote?.deposit_required, NaN);
    return {
      projectId: String(project.id || "").trim(),
      quoteId: String(quote?.id || project.quoteId || project.quote_id || "").trim(),
      projectName: String(project.projectName || project.project_name || quote?.project_name || "").trim(),
      customerName: String(project.clientName || project.client_name || quote?.client_name || "").trim(),
      customerEmail: String(project.clientEmail || project.client_email || quote?.client_email || "").trim(),
      customerPhone: String(quote?.client_phone || "").trim(),
      quoteNumber: quoteLabel(quote),
      quoteStatus: String(quote?.status || "").trim(),
      acceptedAt: quote?.accepted_at || null,
      contractTotal,
      depositRequired: Number.isFinite(deposit) && deposit > 0 ? deposit : null,
      currency,
      address,
      scope,
      terms,
      exclusions: "",
      startDate: toDateInput(quote?.start_date),
      dueDate: toDateInput(quote?.due_date),
      paymentNotes: "",
      warrantyNotes: "",
      additionalTerms: "",
      branding: {
        businessName: String(branding?.business_name || "").trim(),
        businessPhone: String(branding?.business_phone || "").trim(),
        businessEmail: String(branding?.business_email || "").trim(),
        businessAddress: String(branding?.business_address || "").trim(),
        logoUrl: String(branding?.logo_url || "").trim(),
      },
      legal: legalBundle || {
        available: false,
        loadError: null,
        forbidden: false,
        readiness: null,
        profile: null,
      },
      contractSetup: setupBundle || {
        available: false,
        loadError: null,
        forbidden: false,
        setup: null,
        readiness: null,
      },
      paymentSchedule: scheduleBundle || {
        available: false,
        loadError: null,
        forbidden: false,
        schedule: null,
        items: [],
        readiness: null,
        source: null,
      },
      legalNotices: legalNoticesBundle || {
        available: false,
        loadError: null,
        forbidden: false,
        notices: null,
        readiness: { status: "missing" },
      },
    };
  }

  function formatPropertyLine(setup) {
    if (!setup) return "";
    const line1 = String(setup.property_address_line1 || "").trim();
    const line2 = String(setup.property_address_line2 || "").trim();
    const city = String(setup.property_city || "").trim();
    const state = String(setup.property_state || "").trim();
    const zip = String(setup.property_postal_code || "").trim();
    const cityState = [city, state].filter(Boolean).join(", ");
    const locality = [cityState, zip].filter(Boolean).join(" ");
    return [line1, line2, locality].filter(Boolean).join(", ");
  }

  function formatPropertyLocality(city, state, zip) {
    const cityState = [String(city || "").trim(), String(state || "").trim()]
      .filter(Boolean)
      .join(", ");
    return [cityState, String(zip || "").trim()].filter(Boolean).join(" ");
  }

  function formatPropertyFieldsLine(fields) {
    if (!fields) return "";
    const locality = formatPropertyLocality(fields.city, fields.state, fields.zip);
    return [fields.line1, fields.line2, locality].filter(Boolean).join(", ");
  }

  function readPropertyFieldsFromDom() {
    return {
      line1: String($("cbPropEditLine1")?.value || "").trim(),
      line2: String($("cbPropEditLine2")?.value || "").trim(),
      city: String($("cbPropEditCity")?.value || "").trim(),
      state: String($("cbPropEditState")?.value || "").trim(),
      zip: String($("cbPropEditZip")?.value || "").trim(),
    };
  }

  function propertyFieldsFromSetup(setup) {
    return {
      line1: String(setup?.property_address_line1 || "").trim(),
      line2: String(setup?.property_address_line2 || "").trim(),
      city: String(setup?.property_city || "").trim(),
      state: String(setup?.property_state || "").trim(),
      zip: String(setup?.property_postal_code || "").trim(),
    };
  }

  function propertyFieldsFromEdits(edits) {
    return {
      line1: String(edits?.propLine1 || "").trim(),
      line2: String(edits?.propLine2 || "").trim(),
      city: String(edits?.propCity || "").trim(),
      state: String(edits?.propState || "").trim(),
      zip: String(edits?.propZip || "").trim(),
    };
  }

  function propertyMissingLabels(fields) {
    const missing = [];
    if (!fields.line1) missing.push("Address Line 1");
    if (!fields.city) missing.push("City");
    if (!fields.state) missing.push("State");
    if (!fields.zip) missing.push("ZIP Code");
    return missing;
  }

  function propertyFieldsComplete(fields) {
    return propertyMissingLabels(fields).length === 0;
  }

  function applyPropertyFieldsToEdits(edits, fields) {
    if (!edits || !fields) return;
    edits.propLine1 = fields.line1;
    edits.propLine2 = fields.line2;
    edits.propCity = fields.city;
    edits.propState = fields.state;
    edits.propZip = fields.zip;
    edits.address = formatPropertyFieldsLine(fields);
  }

  function syncPropertyInputsFromModel() {
    const setupFields = propertyFieldsFromSetup(sourceSnapshot?.contractSetup?.setup);
    const editFields = propertyFieldsFromEdits(draftEdits);
    const fields = propertyFieldsComplete(editFields)
      ? editFields
      : propertyFieldsComplete(setupFields)
        ? setupFields
        : {
            line1: editFields.line1 || setupFields.line1 || String(draftEdits?.address || "").trim(),
            line2: editFields.line2 || setupFields.line2,
            city: editFields.city || setupFields.city,
            state: editFields.state || setupFields.state,
            zip: editFields.zip || setupFields.zip,
          };
    if ($("cbPropEditLine1")) $("cbPropEditLine1").value = fields.line1;
    if ($("cbPropEditLine2")) $("cbPropEditLine2").value = fields.line2;
    if ($("cbPropEditCity")) $("cbPropEditCity").value = fields.city;
    if ($("cbPropEditState")) $("cbPropEditState").value = fields.state;
    if ($("cbPropEditZip")) $("cbPropEditZip").value = fields.zip;
    markPropertyFieldValidity(fields);
  }

  function markPropertyFieldValidity(fields) {
    const map = [
      ["cbPropEditLine1", fields.line1],
      ["cbPropEditCity", fields.city],
      ["cbPropEditState", fields.state],
      ["cbPropEditZip", fields.zip],
    ];
    for (const [id, value] of map) {
      const el = $(id);
      if (!el) continue;
      el.classList.toggle("is-invalid", !String(value || "").trim());
    }
    const line2 = $("cbPropEditLine2");
    if (line2) line2.classList.remove("is-invalid");
  }

  function validatePropertyWorkspace(options = {}) {
    const forSave = options.forSave === true;
    if (propertyConfigured(sourceSnapshot?.contractSetup) && !forSave && getArticleMode("art-property") === WS_MODE.PREVIEW) {
      return {
        level: "ok",
        badge: "Confirmed",
        message: "✓ Address complete",
        blocking: false,
      };
    }

    const fields =
      getArticleMode("art-property") === WS_MODE.EDIT || forSave
        ? readPropertyFieldsFromDom()
        : propertyFieldsFromSetup(sourceSnapshot?.contractSetup?.setup);
    const missing = propertyMissingLabels(fields);

    if (!missing.length) {
      if (propertyConfigured(sourceSnapshot?.contractSetup) && !forSave) {
        return {
          level: "ok",
          badge: "Confirmed",
          message: "✓ Address complete",
          blocking: false,
        };
      }
      return {
        level: forSave ? "ok" : "warn",
        badge: forSave ? "Ready" : "Ready to save",
        message: forSave
          ? "✓ Address complete"
          : "Address looks complete — Save to confirm it on the contract.",
        blocking: false,
      };
    }

    if (missing.length === 4 && !fields.line1 && !fields.city && !fields.state && !fields.zip) {
      return {
        level: "block",
        badge: "Missing",
        message: "Add the project address to continue.",
        blocking: true,
      };
    }

    const needs = missing.length === 1 ? missing[0] : missing.slice(0, -1).join(", ") + " and " + missing[missing.length - 1];
    return {
      level: "block",
      badge: "Incomplete",
      message: `Property address still needs ${needs} before it can be confirmed.`,
      blocking: true,
    };
  }

  function updatePropertyLiveHint(result) {
    const hint = $("cbPropLiveHint");
    if (!hint) return;
    const check = result || validatePropertyWorkspace({ forSave: false });
    hint.hidden = false;
    hint.classList.remove("is-ok", "is-warn", "is-block");
    if (check.level === "ok") hint.classList.add("is-ok");
    else if (check.level === "warn") hint.classList.add("is-warn");
    else hint.classList.add("is-block");
    hint.textContent = check.message || "";
    markPropertyFieldValidity(readPropertyFieldsFromDom());
  }

  async function savePropertyWorkspace() {
    if (!sourceSnapshot?.projectId || !sourceSnapshot?.quoteId) {
      throw new Error("Project and quote are required to save the property address.");
    }
    const fields = readPropertyFieldsFromDom();
    const missing = propertyMissingLabels(fields);
    if (missing.length) {
      throw new Error(
        `Property address still needs ${missing.join(", ")} before it can be confirmed.`
      );
    }

    const res = await postJson(CONTRACT_SETUP_API, {
      project_id: sourceSnapshot.projectId,
      quote_id: sourceSnapshot.quoteId,
      property_address_line1: fields.line1,
      property_address_line2: fields.line2,
      property_city: fields.city,
      property_state: fields.state,
      property_postal_code: fields.zip,
      confirm_property_address: true,
    });

    if (!res.ok || res.data?.ok !== true || !res.data.setup) {
      const msg = String(res.data?.error || "").trim();
      throw new Error(msg || "Property address could not be saved.");
    }

    sourceSnapshot.contractSetup = {
      available: true,
      loadError: null,
      forbidden: false,
      setup: res.data.setup,
      readiness: res.data.readiness || null,
    };
    applyPropertyFieldsToEdits(draftEdits, propertyFieldsFromSetup(res.data.setup));
    draftBaseline = cloneEdits({
      ...sourceSnapshot,
      ...draftEdits,
    });
    renderDocument(sourceSnapshot, draftEdits);
    updateIndexNavStatus();
    renderWorkspaceChrome();
  }

  function propertyConfigured(setupBundle) {
    return String(setupBundle?.readiness?.project_address || "").toLowerCase() === "confirmed";
  }

  const WARRANTY_DURATION_UNITS = new Set(["days", "months", "years"]);

  function warrantyFieldsFromSetup(setup) {
    const rawValue = setup?.warranty_duration_value;
    const value =
      rawValue == null || rawValue === ""
        ? ""
        : String(Number(rawValue));
    const unit = String(setup?.warranty_duration_unit || "years").trim().toLowerCase();
    return {
      durationValue: Number.isFinite(Number(value)) ? String(parseInt(value, 10)) : "",
      durationUnit: WARRANTY_DURATION_UNITS.has(unit) ? unit : "years",
      summary: String(setup?.warranty_summary || "").trim(),
      exclusions: String(setup?.warranty_exclusions || "").trim(),
    };
  }

  function warrantyFieldsFromEdits(edits) {
    const unit = String(edits?.warDurationUnit || "years").trim().toLowerCase();
    return {
      durationValue: String(edits?.warDurationValue ?? "").trim(),
      durationUnit: WARRANTY_DURATION_UNITS.has(unit) ? unit : "years",
      summary: String(edits?.warSummary || "").trim(),
      exclusions: String(edits?.warExclusions || "").trim(),
    };
  }

  function readWarrantyFieldsFromDom() {
    const unit = String($("cbWarEditDurationUnit")?.value || "years").trim().toLowerCase();
    return {
      durationValue: String($("cbWarEditDurationValue")?.value || "").trim(),
      durationUnit: WARRANTY_DURATION_UNITS.has(unit) ? unit : "years",
      summary: String($("cbWarEditSummary")?.value || "").trim(),
      exclusions: String($("cbWarEditExclusions")?.value || "").trim(),
    };
  }

  function applyWarrantyFieldsToEdits(edits, fields) {
    if (!edits || !fields) return;
    edits.warDurationValue = fields.durationValue;
    edits.warDurationUnit = fields.durationUnit;
    edits.warSummary = fields.summary;
    edits.warExclusions = fields.exclusions;
  }

  function formatWarrantyDurationTitle(fields) {
    const n = Number(fields?.durationValue);
    const unit = String(fields?.durationUnit || "").toLowerCase();
    if (!Number.isFinite(n) || n < 0 || !WARRANTY_DURATION_UNITS.has(unit)) {
      return "";
    }
    const singular = unit === "days" ? "Day" : unit === "months" ? "Month" : "Year";
    const plural = unit === "days" ? "Days" : unit === "months" ? "Months" : "Years";
    const label = n === 1 ? singular : plural;
    return `${n} ${label} Limited Installation Warranty`;
  }

  function formatWarrantyDurationShort(fields) {
    const n = Number(fields?.durationValue);
    const unit = String(fields?.durationUnit || "").toLowerCase();
    if (!Number.isFinite(n) || !WARRANTY_DURATION_UNITS.has(unit)) return "";
    return `${n} ${unit}`;
  }

  function parseExclusionLines(raw) {
    return String(raw || "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^[\s•\-\*]+/, "").trim())
      .filter(Boolean);
  }

  function warrantyMissingLabels(fields) {
    const missing = [];
    const n = Number(fields.durationValue);
    if (fields.durationValue === "" || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      missing.push("Warranty Duration");
    }
    if (!WARRANTY_DURATION_UNITS.has(String(fields.durationUnit || "").toLowerCase())) {
      missing.push("Duration Unit");
    }
    if (!fields.summary) missing.push("Warranty Summary");
    if (!fields.exclusions) missing.push("Exclusions");
    return missing;
  }

  function warrantyFieldsComplete(fields) {
    return warrantyMissingLabels(fields).length === 0;
  }

  function syncWarrantyInputsFromModel() {
    const setupFields = warrantyFieldsFromSetup(sourceSnapshot?.contractSetup?.setup);
    const editFields = warrantyFieldsFromEdits(draftEdits);
    const fields = warrantyFieldsComplete(editFields)
      ? editFields
      : warrantyFieldsComplete(setupFields)
        ? setupFields
        : {
            durationValue: editFields.durationValue || setupFields.durationValue,
            durationUnit: editFields.durationUnit || setupFields.durationUnit || "years",
            summary: editFields.summary || setupFields.summary,
            exclusions: editFields.exclusions || setupFields.exclusions,
          };
    if ($("cbWarEditDurationValue")) $("cbWarEditDurationValue").value = fields.durationValue;
    if ($("cbWarEditDurationUnit")) $("cbWarEditDurationUnit").value = fields.durationUnit;
    if ($("cbWarEditSummary")) $("cbWarEditSummary").value = fields.summary;
    if ($("cbWarEditExclusions")) $("cbWarEditExclusions").value = fields.exclusions;
    markWarrantyFieldValidity(fields);
  }

  function markWarrantyFieldValidity(fields) {
    const durationOk =
      fields.durationValue !== "" &&
      Number.isFinite(Number(fields.durationValue)) &&
      Number(fields.durationValue) >= 0 &&
      Number.isInteger(Number(fields.durationValue));
    const map = [
      ["cbWarEditDurationValue", durationOk],
      ["cbWarEditDurationUnit", WARRANTY_DURATION_UNITS.has(fields.durationUnit)],
      ["cbWarEditSummary", Boolean(fields.summary)],
      ["cbWarEditExclusions", Boolean(fields.exclusions)],
    ];
    for (const [id, ok] of map) {
      const el = $(id);
      if (!el) continue;
      el.classList.toggle("is-invalid", !ok);
    }
  }

  function validateWarrantyWorkspace(options = {}) {
    const forSave = options.forSave === true;
    if (
      warrantyConfigured(sourceSnapshot?.contractSetup) &&
      !forSave &&
      getArticleMode("art-warranty") === WS_MODE.PREVIEW
    ) {
      return {
        level: "ok",
        badge: "Configured",
        message: "✓ Warranty complete",
        blocking: false,
      };
    }

    const fields =
      getArticleMode("art-warranty") === WS_MODE.EDIT || forSave
        ? readWarrantyFieldsFromDom()
        : warrantyFieldsFromSetup(sourceSnapshot?.contractSetup?.setup);
    const missing = warrantyMissingLabels(fields);

    if (!missing.length) {
      if (warrantyConfigured(sourceSnapshot?.contractSetup) && !forSave) {
        return {
          level: "ok",
          badge: "Configured",
          message: "✓ Warranty complete",
          blocking: false,
        };
      }
      return {
        level: forSave ? "ok" : "warn",
        badge: forSave ? "Ready" : "Ready to save",
        message: forSave
          ? "✓ Warranty complete"
          : "Warranty looks complete — Confirm Warranty to lock it on the contract.",
        blocking: false,
      };
    }

    if (missing.length === 1 && missing[0] === "Warranty Duration") {
      return {
        level: "block",
        badge: "Incomplete",
        message: "Warranty duration is required before this section can be confirmed.",
        blocking: true,
      };
    }

    if (
      !fields.durationValue &&
      !fields.summary &&
      !fields.exclusions
    ) {
      return {
        level: "block",
        badge: "Missing",
        message: "Add warranty duration, summary, and exclusions to continue.",
        blocking: true,
      };
    }

    const needs =
      missing.length === 1
        ? missing[0]
        : missing.slice(0, -1).join(", ") + " and " + missing[missing.length - 1];
    return {
      level: "block",
      badge: "Incomplete",
      message: `Warranty still needs ${needs} before it can be confirmed.`,
      blocking: true,
    };
  }

  function updateWarrantyLiveHint(result) {
    const hint = $("cbWarLiveHint");
    if (!hint) return;
    const check = result || validateWarrantyWorkspace({ forSave: false });
    hint.hidden = false;
    hint.classList.remove("is-ok", "is-warn", "is-block");
    if (check.level === "ok") hint.classList.add("is-ok");
    else if (check.level === "warn") hint.classList.add("is-warn");
    else hint.classList.add("is-block");
    hint.textContent = check.message || "";
    markWarrantyFieldValidity(readWarrantyFieldsFromDom());
  }

  async function saveWarrantyWorkspace() {
    if (!sourceSnapshot?.projectId || !sourceSnapshot?.quoteId) {
      throw new Error("Project and quote are required to save warranty terms.");
    }
    const fields = readWarrantyFieldsFromDom();
    const missing = warrantyMissingLabels(fields);
    if (missing.length) {
      if (missing.length === 1 && missing[0] === "Warranty Duration") {
        throw new Error("Warranty duration is required before this section can be confirmed.");
      }
      throw new Error(`Warranty still needs ${missing.join(", ")} before it can be confirmed.`);
    }

    const res = await postJson(CONTRACT_SETUP_API, {
      project_id: sourceSnapshot.projectId,
      quote_id: sourceSnapshot.quoteId,
      warranty_duration_value: Number(fields.durationValue),
      warranty_duration_unit: fields.durationUnit,
      warranty_summary: fields.summary,
      warranty_exclusions: fields.exclusions,
      confirm_warranty: true,
    });

    if (!res.ok || res.data?.ok !== true || !res.data.setup) {
      const msg = String(res.data?.error || "").trim();
      throw new Error(msg || "Warranty terms could not be saved.");
    }

    sourceSnapshot.contractSetup = {
      available: true,
      loadError: null,
      forbidden: false,
      setup: res.data.setup,
      readiness: res.data.readiness || null,
    };
    applyWarrantyFieldsToEdits(draftEdits, warrantyFieldsFromSetup(res.data.setup));
    draftBaseline = cloneEdits({
      ...sourceSnapshot,
      ...draftEdits,
    });
    renderDocument(sourceSnapshot, draftEdits);
    updateIndexNavStatus();
    renderWorkspaceChrome();
  }

  function warrantyConfigured(setupBundle) {
    return String(setupBundle?.readiness?.warranty || "").toLowerCase() === "configured";
  }

  function paymentConfigured(scheduleBundle) {
    return String(scheduleBundle?.readiness?.status || "").toLowerCase() === "configured";
  }

  /** Confirmed schedules are read-only in the Owner workspace. */
  function paymentScheduleAllowsOwnerEdit() {
    return !paymentConfigured(sourceSnapshot?.paymentSchedule);
  }

  function normalizePaymentItemRole(raw) {
    const role = String(raw == null ? "" : raw).trim().toLowerCase();
    if (role === "applied_payment") return "applied_payment";
    return "future_obligation";
  }

  function moneyToCents(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  function centsToMoneyNumber(cents) {
    return Math.round(Number(cents) || 0) / 100;
  }

  function clonePaymentDraftItems(items) {
    return (Array.isArray(items) ? items : []).map((row) => ({ ...row }));
  }

  function nextPaymentClientId() {
    paymentDraftKeySeq += 1;
    return `tmp_${String(paymentDraftKeySeq).padStart(4, "0")}`;
  }

  function createBlankPaymentDraftRow() {
    return {
      client_id: nextPaymentClientId(),
      sequence_number: paymentDraftItems.length + 1,
      label: "",
      payment_type: "custom",
      amount: 0,
      due_rule: "custom",
      milestone_description: "",
      fixed_due_date: "",
      item_role: "future_obligation",
    };
  }

  function mapScheduleItemToDraft(item, index) {
    return {
      client_id: nextPaymentClientId(),
      sequence_number: Number(item?.sequence_number) || index + 1,
      label: String(item?.label || "").trim(),
      payment_type: normalizePaymentType(item?.payment_type),
      amount: Number(item?.amount) || 0,
      due_rule: normalizeDueRule(item?.due_rule),
      milestone_description: String(item?.milestone_description || "").trim(),
      fixed_due_date: String(item?.fixed_due_date || "").trim().slice(0, 10),
      item_role: normalizePaymentItemRole(item?.item_role),
    };
  }

  function renumberPaymentDraftSequences() {
    paymentDraftItems.forEach((row, i) => {
      row.sequence_number = i + 1;
    });
  }

  function hydratePaymentDraftFromSource(source) {
    const items = Array.isArray(source?.paymentSchedule?.items)
      ? [...source.paymentSchedule.items]
      : [];
    items.sort((a, b) => (Number(a.sequence_number) || 0) - (Number(b.sequence_number) || 0));
    paymentDraftItems = items.map((item, i) => mapScheduleItemToDraft(item, i));
    renumberPaymentDraftSequences();
    paymentDraftBaseline = clonePaymentDraftItems(paymentDraftItems);
  }

  function paymentDraftContractTotal(source) {
    const readiness = source?.paymentSchedule?.readiness || {};
    if (readiness.contract_total != null && Number.isFinite(Number(readiness.contract_total))) {
      return Number(readiness.contract_total);
    }
    if (source?.contractTotal != null && Number.isFinite(Number(source.contractTotal))) {
      return Number(source.contractTotal);
    }
    return null;
  }

  function computePaymentDraftTotals(items, contractTotal) {
    const scheduledCents = (Array.isArray(items) ? items : []).reduce(
      (sum, row) => sum + moneyToCents(row.amount),
      0
    );
    const contractCents = contractTotal == null ? null : moneyToCents(contractTotal);
    const differenceCents = contractCents == null ? null : contractCents - scheduledCents;
    return {
      scheduled: centsToMoneyNumber(scheduledCents),
      scheduledCents,
      contract: contractTotal,
      contractCents,
      difference: differenceCents == null ? null : centsToMoneyNumber(differenceCents),
      differenceCents,
      balanced: differenceCents === 0,
    };
  }

  function findPaymentDraftIndexByClientId(clientId) {
    const id = String(clientId || "");
    return paymentDraftItems.findIndex((row) => String(row.client_id) === id);
  }

  function readPaymentDraftFromGrid() {
    const grid = $("cbPayEditGrid");
    if (!grid) return;
    const rows = Array.from(grid.querySelectorAll("[data-pay-client-id]"));
    const next = [];
    rows.forEach((rowEl, index) => {
      const clientId = rowEl.getAttribute("data-pay-client-id");
      const existing = paymentDraftItems.find((r) => String(r.client_id) === String(clientId)) || {};
      const label = String(rowEl.querySelector("[data-pay-field='label']")?.value || "").trim();
      const amountRaw = String(rowEl.querySelector("[data-pay-field='amount']")?.value || "").trim();
      const amount = amountRaw === "" ? 0 : Number(amountRaw);
      next.push({
        ...existing,
        client_id: clientId || nextPaymentClientId(),
        sequence_number: index + 1,
        label,
        payment_type: normalizePaymentType(
          rowEl.querySelector("[data-pay-field='payment_type']")?.value
        ),
        amount: Number.isFinite(amount) ? amount : 0,
        due_rule: normalizeDueRule(rowEl.querySelector("[data-pay-field='due_rule']")?.value),
        milestone_description: String(
          rowEl.querySelector("[data-pay-field='milestone_description']")?.value || ""
        ).trim(),
        fixed_due_date: String(
          rowEl.querySelector("[data-pay-field='fixed_due_date']")?.value || ""
        )
          .trim()
          .slice(0, 10),
        item_role: normalizePaymentItemRole(
          rowEl.querySelector("[data-pay-field='item_role']")?.value
        ),
      });
    });
    paymentDraftItems = next;
  }

  function normalizePaymentType(raw) {
    const v = String(raw == null ? "" : raw).trim().toLowerCase();
    return PAYMENT_TYPES_ALLOWED.has(v) ? v : "custom";
  }

  function normalizeDueRule(raw) {
    const v = String(raw == null ? "" : raw).trim().toLowerCase();
    return DUE_RULES_ALLOWED.has(v) ? v : "custom";
  }

  function formatPaymentAmountForApi(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return null;
    const rounded = Math.round(n * 100) / 100;
    if (Math.abs(n - rounded) > 1e-9) return null;
    return rounded.toFixed(2);
  }

  function updatePaymentEditTotalsDisplay(source) {
    const currency = source?.currency || DEFAULT_CURRENCY;
    const totals = computePaymentDraftTotals(
      paymentDraftItems,
      paymentDraftContractTotal(source)
    );
    setText(
      "cbPayEditContractTotal",
      totals.contract != null ? formatMoney(totals.contract, currency) : "—"
    );
    setText("cbPayEditScheduled", formatMoney(totals.scheduled, currency));
    const diffEl = $("cbPayEditDifference");
    if (diffEl) {
      diffEl.classList.remove("is-ok", "is-bad");
      if (totals.difference == null) {
        diffEl.textContent = "—";
      } else {
        diffEl.textContent = formatMoney(totals.difference, currency);
        diffEl.classList.add(totals.balanced ? "is-ok" : "is-bad");
      }
    }
  }

  function updatePaymentEditHint(result) {
    const hint = $("cbPayEditHint");
    if (!hint) return;
    const check = result || validatePaymentDraftForSave();
    hint.classList.remove("is-ok", "is-warn", "is-block");
    if (check.level === "ok") hint.classList.add("is-ok");
    else if (check.level === "warn") hint.classList.add("is-warn");
    else hint.classList.add("is-block");
    hint.textContent = check.message || "";
  }

  function validatePaymentWorkspace() {
    if (paymentConfigured(sourceSnapshot?.paymentSchedule)) {
      return readinessValidation("available", "Payment schedule is confirmed.", "", "");
    }
    const totals = computePaymentDraftTotals(
      paymentDraftItems,
      paymentDraftContractTotal(sourceSnapshot)
    );
    if (!paymentDraftItems.length) {
      return readinessValidation("missing", "", "", "Payment schedule is missing.");
    }
    if (totals.balanced) {
      return readinessValidation(
        "needs_confirmation",
        "",
        "Payment schedule totals match — confirm when ready.",
        ""
      );
    }
    return readinessValidation(
      "needs_confirmation",
      "",
      "Payment schedule needs confirmation (total must equal contract price).",
      ""
    );
  }

  function validatePaymentDraftForSave() {
    readPaymentDraftFromGrid();
    for (const row of paymentDraftItems) {
      if (formatPaymentAmountForApi(row.amount) == null) {
        return {
          level: "block",
          blocking: true,
          message: "Each amount must be a non-negative number with up to 2 decimals.",
        };
      }
      if (String(row.label || "").trim().length > 160) {
        return {
          level: "block",
          blocking: true,
          message: "Stage description must be 160 characters or fewer.",
        };
      }
    }
    const totals = computePaymentDraftTotals(
      paymentDraftItems,
      paymentDraftContractTotal(sourceSnapshot)
    );
    if (totals.balanced) {
      return {
        level: "ok",
        blocking: false,
        message: "Balanced — you can Confirm Schedule when ready.",
      };
    }
    return {
      level: "warn",
      blocking: false,
      message: "Draft can be saved while unbalanced. Confirm requires Scheduled = Contract Total.",
    };
  }

  function validatePaymentDraftForConfirm() {
    readPaymentDraftFromGrid();
    if (!paymentDraftItems.length) {
      return {
        level: "block",
        blocking: true,
        message: "Add at least one payment stage before confirming.",
      };
    }
    for (const row of paymentDraftItems) {
      if (!String(row.label || "").trim()) {
        return {
          level: "block",
          blocking: true,
          message: "Every payment needs a description before confirm.",
        };
      }
      if (formatPaymentAmountForApi(row.amount) == null) {
        return {
          level: "block",
          blocking: true,
          message: "Each amount must be a non-negative number with up to 2 decimals.",
        };
      }
    }
    const totals = computePaymentDraftTotals(
      paymentDraftItems,
      paymentDraftContractTotal(sourceSnapshot)
    );
    if (totals.contract == null) {
      return {
        level: "block",
        blocking: true,
        message: "Contract total is unavailable — cannot confirm.",
      };
    }
    if (!totals.balanced) {
      return {
        level: "block",
        blocking: true,
        message: `Scheduled must equal contract total (difference ${formatMoney(
          totals.difference,
          sourceSnapshot?.currency || DEFAULT_CURRENCY
        )}).`,
      };
    }
    return {
      level: "ok",
      blocking: false,
      message: "Ready to confirm — totals match the contract price.",
    };
  }

  function mapPaymentDraftItemsToApiPayload() {
    readPaymentDraftFromGrid();
    renumberPaymentDraftSequences();
    return paymentDraftItems.map((row, index) => {
      const amount = formatPaymentAmountForApi(row.amount);
      const item = {
        sequence_number: index + 1,
        label: String(row.label || "").trim(),
        payment_type: normalizePaymentType(row.payment_type),
        amount,
        due_rule: normalizeDueRule(row.due_rule),
        item_role: normalizePaymentItemRole(row.item_role),
      };
      const milestone = String(row.milestone_description || "").trim();
      if (milestone) item.milestone_description = milestone;
      const fixed = String(row.fixed_due_date || "").trim().slice(0, 10);
      if (fixed) item.fixed_due_date = fixed;
      return item;
    });
  }

  function applyPaymentScheduleResponse(data) {
    sourceSnapshot.paymentSchedule = {
      available: true,
      loadError: null,
      forbidden: false,
      schedule: data.schedule || null,
      items: Array.isArray(data.items) ? data.items : [],
      readiness: data.readiness || null,
      source: data.source || null,
    };
    hydratePaymentDraftFromSource(sourceSnapshot);
    if (draftEdits) {
      draftBaseline = cloneEdits({
        ...sourceSnapshot,
        ...draftEdits,
      });
    }
    renderDocument(sourceSnapshot, draftEdits);
    updateIndexNavStatus();
    renderWorkspaceChrome();
  }

  function isPaymentScheduleVersionConflict(res) {
    return res?.status === 409 || res?.data?.code === "schedule_version_conflict";
  }

  async function reloadPaymentScheduleFromServer() {
    if (!sourceSnapshot?.projectId || !sourceSnapshot?.quoteId) return;
    const qs =
      `project_id=${encodeURIComponent(sourceSnapshot.projectId)}` +
      `&quote_id=${encodeURIComponent(sourceSnapshot.quoteId)}`;
    const res = await fetchJson(`${PAYMENT_SCHEDULE_API}?${qs}`);
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(String(res.data?.error || "Could not reload payment schedule."));
    }
    applyPaymentScheduleResponse(res.data);
  }

  async function offerPaymentScheduleConflictReload(keepMessage) {
    const reload = window.confirm(
      `${keepMessage || "This payment schedule changed in another session."}\n\nReload the latest schedule now?`
    );
    if (reload) await reloadPaymentScheduleFromServer();
  }

  async function savePaymentScheduleDraft(confirmSchedule) {
    if (!sourceSnapshot?.projectId || !sourceSnapshot?.quoteId) {
      throw new Error("Project and quote are required to save the payment schedule.");
    }
    const items = mapPaymentDraftItemsToApiPayload();
    for (const item of items) {
      if (item.amount == null) {
        throw new Error("Each amount must be a non-negative number with up to 2 decimals.");
      }
    }
    const expectedUpdatedAt = sourceSnapshot.paymentSchedule?.schedule?.updated_at || null;
    const body = {
      project_id: sourceSnapshot.projectId,
      quote_id: sourceSnapshot.quoteId,
      items,
      confirm_schedule: confirmSchedule === true,
    };
    if (expectedUpdatedAt) body.expected_updated_at = expectedUpdatedAt;

    const res = await postJson(PAYMENT_SCHEDULE_API, body);
    if (isPaymentScheduleVersionConflict(res)) {
      await offerPaymentScheduleConflictReload(res.data?.error);
      throw new Error(res.data?.error || "Schedule version conflict — reload and retry.");
    }
    if (!res.ok || res.data?.ok !== true) {
      const msg = String(res.data?.error || "").trim();
      throw new Error(msg || "Payment schedule could not be saved.");
    }
    applyPaymentScheduleResponse(res.data);
  }

  function paymentTypeOptionsHtml(selected) {
    return Array.from(PAYMENT_TYPES_ALLOWED)
      .map(
        (t) =>
          `<option value="${escapeHtml(t)}"${t === selected ? " selected" : ""}>${escapeHtml(t)}</option>`
      )
      .join("");
  }

  function paymentRoleOptionsHtml(selected) {
    const roles = [
      ["future_obligation", "Future"],
      ["applied_payment", "Applied"],
    ];
    return roles
      .map(
        ([v, label]) =>
          `<option value="${escapeHtml(v)}"${v === selected ? " selected" : ""}>${escapeHtml(label)}</option>`
      )
      .join("");
  }

  function renderPaymentEditGrid() {
    const grid = $("cbPayEditGrid");
    if (!grid) return;
    updatePaymentEditTotalsDisplay(sourceSnapshot);
    updatePaymentEditHint(validatePaymentDraftForSave());
    if (!paymentDraftItems.length) {
      grid.innerHTML =
        `<p class="cb-pay-edit-hint">No payments yet. Click Add payment to begin.</p>`;
      return;
    }
    grid.innerHTML = paymentDraftItems
      .map((row, index) => {
        const id = escapeHtml(row.client_id);
        return (
          `<div class="cb-pay-edit-row" role="listitem" data-pay-client-id="${id}">` +
          `<div class="cb-pay-edit-row__seq"><label>Seq</label><div>${index + 1}</div></div>` +
          `<div><label>Description</label>` +
          `<input type="text" maxlength="160" data-pay-field="label" value="${escapeHtml(row.label || "")}" /></div>` +
          `<div><label>Type</label>` +
          `<select data-pay-field="payment_type">${paymentTypeOptionsHtml(
            normalizePaymentType(row.payment_type)
          )}</select></div>` +
          `<div><label>Amount</label>` +
          `<input type="number" min="0" step="0.01" data-pay-field="amount" value="${escapeHtml(
            String(Number(row.amount) || 0)
          )}" /></div>` +
          `<div class="cb-pay-edit-row__actions">` +
          `<select data-pay-field="item_role" title="Role">${paymentRoleOptionsHtml(
            normalizePaymentItemRole(row.item_role)
          )}</select>` +
          `<button type="button" class="btn ghost" data-pay-action="up" ${
            index === 0 ? "disabled" : ""
          }>↑</button>` +
          `<button type="button" class="btn ghost" data-pay-action="down" ${
            index === paymentDraftItems.length - 1 ? "disabled" : ""
          }>↓</button>` +
          `<button type="button" class="btn ghost" data-pay-action="insert">Insert</button>` +
          `<button type="button" class="btn ghost" data-pay-action="delete">Delete</button>` +
          `</div>` +
          `<input type="hidden" data-pay-field="due_rule" value="${escapeHtml(
            normalizeDueRule(row.due_rule)
          )}" />` +
          `<input type="hidden" data-pay-field="milestone_description" value="${escapeHtml(
            row.milestone_description || ""
          )}" />` +
          `<input type="hidden" data-pay-field="fixed_due_date" value="${escapeHtml(
            row.fixed_due_date || ""
          )}" />` +
          `</div>`
        );
      })
      .join("");
  }

  function paymentDraftApplyMutation(mutator) {
    readPaymentDraftFromGrid();
    mutator();
    renumberPaymentDraftSequences();
    renderPaymentEditGrid();
  }

  function bindPaymentEditHandlersOnce() {
    const toolbar = $("cbPayEditToolbar");
    const grid = $("cbPayEditGrid");
    if (toolbar && toolbar.dataset.payBound !== "1") {
      toolbar.dataset.payBound = "1";
      toolbar.addEventListener("click", (ev) => {
        const btn = ev.target.closest("#cbPayAddStage");
        if (!btn) return;
        ev.preventDefault();
        paymentDraftApplyMutation(() => {
          paymentDraftItems.push(createBlankPaymentDraftRow());
        });
      });
    }
    if (grid && grid.dataset.payBound !== "1") {
      grid.dataset.payBound = "1";
      grid.addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-pay-action]");
        if (!btn) return;
        ev.preventDefault();
        const rowEl = btn.closest("[data-pay-client-id]");
        const clientId = rowEl?.getAttribute("data-pay-client-id");
        const action = btn.getAttribute("data-pay-action");
        paymentDraftApplyMutation(() => {
          const idx = findPaymentDraftIndexByClientId(clientId);
          if (idx < 0) return;
          if (action === "delete") {
            paymentDraftItems.splice(idx, 1);
          } else if (action === "insert") {
            paymentDraftItems.splice(idx + 1, 0, createBlankPaymentDraftRow());
          } else if (action === "up" && idx > 0) {
            const tmp = paymentDraftItems[idx - 1];
            paymentDraftItems[idx - 1] = paymentDraftItems[idx];
            paymentDraftItems[idx] = tmp;
          } else if (action === "down" && idx < paymentDraftItems.length - 1) {
            const tmp = paymentDraftItems[idx + 1];
            paymentDraftItems[idx + 1] = paymentDraftItems[idx];
            paymentDraftItems[idx] = tmp;
          }
        });
      });
      grid.addEventListener("input", (ev) => {
        if (!ev.target.closest("[data-pay-field]")) return;
        readPaymentDraftFromGrid();
        updatePaymentEditTotalsDisplay(sourceSnapshot);
        updatePaymentEditHint(validatePaymentDraftForSave());
      });
      grid.addEventListener("change", (ev) => {
        if (!ev.target.closest("[data-pay-field]")) return;
        readPaymentDraftFromGrid();
        updatePaymentEditTotalsDisplay(sourceSnapshot);
        updatePaymentEditHint(validatePaymentDraftForSave());
      });
    }
  }

  function signatureConfigured(setupBundle) {
    return String(setupBundle?.readiness?.signature_method || "").toLowerCase() === "configured";
  }

  function isPlainNoticesObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeLegalNoticeText(raw) {
    if (raw == null) return "";
    if (typeof raw !== "string") return "";
    return raw.trim();
  }

  /** Ordered populated notices from the 14 approved fields only. */
  function normalizeLegalNoticesPopulated(notices) {
    if (!isPlainNoticesObject(notices)) return [];
    const rows = [];
    for (const field of LEGAL_NOTICE_FIELDS) {
      const text = normalizeLegalNoticeText(notices[field.key]);
      if (!text) continue;
      rows.push({ label: field.label, text });
    }
    return rows;
  }

  /**
   * Defensive Contract Builder legal status (display + readiness contribution).
   * CH-004A7B: consumes confirmed snapshot (effective_for_contracts) only.
   */
  function resolveLegalNoticesEffective(legalNoticesBundle) {
    const bundle = legalNoticesBundle || {};
    const missingCopy = "No legal notices have been added yet.";
    const draftCopy =
      "Legal notices are still being prepared. Draft changes are not published to contracts.";
    const reviewCopy =
      "Legal notices require review before they can be considered ready.";

    if (bundle.loadError || bundle.forbidden) {
      return {
        effectiveStatus: "missing",
        contribution: "missing",
        label: "Missing",
        hint: missingCopy,
        rows: [],
      };
    }

    const effective = bundle.effective_for_contracts;
    if (
      effective &&
      effective.notices &&
      typeof effective.notices === "object" &&
      !Array.isArray(effective.notices) &&
      effective.enabled &&
      typeof effective.enabled === "object" &&
      !Array.isArray(effective.enabled)
    ) {
      const rows = [];
      for (const field of LEGAL_NOTICE_FIELDS) {
        const enabled = effective.enabled[field.key] === true;
        const text = normalizeLegalNoticeText(effective.notices[field.key]);
        if (!enabled || !text) continue;
        rows.push({ label: field.label, text });
      }
      if (!rows.length) {
        return {
          effectiveStatus: "draft",
          contribution: "draft",
          label: "Draft",
          hint: reviewCopy,
          rows: [],
        };
      }
      return {
        effectiveStatus: "configured",
        contribution: "configured",
        label: "Configured ✓",
        hint: null,
        rows,
      };
    }

    // No usable confirmed snapshot
    const apiStatus = String(bundle.readiness?.status ?? "missing")
      .trim()
      .toLowerCase();
    if (apiStatus === "missing" && !bundle.notices) {
      return {
        effectiveStatus: "missing",
        contribution: "missing",
        label: "Missing",
        hint: missingCopy,
        rows: [],
      };
    }
    return {
      effectiveStatus: "draft",
      contribution: "draft",
      label: "Draft",
      hint: draftCopy,
      rows: [],
    };
  }

  function legalNoticesConfigured(legalNoticesBundle) {
    return resolveLegalNoticesEffective(legalNoticesBundle).contribution === "configured";
  }

  function sectionStatusLabel(configured) {
    return configured ? "Configured" : "Missing";
  }

  function paymentStatusLabel(scheduleBundle) {
    const status = String(scheduleBundle?.readiness?.status || "missing").toLowerCase();
    if (status === "configured") return "Confirmed";
    if (status === "draft") return "Payment schedule awaiting confirmation";
    return "Not yet defined";
  }

  function dueRuleLabel(raw) {
    const key = String(raw || "").trim().toLowerCase();
    const map = {
      on_signature: "Due upon acceptance",
      on_acceptance: "Due upon acceptance",
      before_start: "Due before work begins",
      on_start: "Due at project start",
      milestone: "Due at the configured milestone",
      on_completion: "Due upon completion",
      fixed_date: "Due on a fixed date",
      custom: "Custom payment timing",
      net_7: "Within 7 days",
      net_15: "Within 15 days",
      net_30: "Within 30 days",
    };
    if (!key) return "—";
    if (map[key]) return map[key];
    return "Custom payment timing";
  }

  function paymentTypeLabel(raw) {
    const key = String(raw || "").trim().toLowerCase();
    const map = {
      deposit: "Deposit",
      start: "Project Start",
      progress: "Progress Payment",
      material: "Material",
      completion: "Completion",
      final: "Final Payment",
      custom: "Custom",
    };
    if (!key) return "Stage";
    return map[key] || key;
  }

  function formatPercentDisplay(pct) {
    const n = Number(pct);
    if (!Number.isFinite(n)) return "";
    const rounded = Math.round(n * 100) / 100;
    return `${rounded}%`;
  }

  function safeStagePercent(item, contractTotal) {
    if (item?.percentage != null && Number.isFinite(Number(item.percentage))) {
      return Number(item.percentage);
    }
    const amount = Number(item?.amount);
    const total = Number(contractTotal);
    if (!Number.isFinite(amount) || !Number.isFinite(total) || total <= 0) return null;
    return Math.round((amount / total) * 10000) / 100;
  }

  /**
   * Payment Plan Preview only — format schedule fixed_due_date without timezone shift.
   * Exact YYYY-MM-DD values are formatted from calendar components (never new Date("YYYY-MM-DD")).
   * Timestamps fall back to shared formatDate. Null/empty/malformed never yield "Invalid Date".
   */
  function formatPaymentDateOnly(raw) {
    if (raw == null) return "";
    const s = String(raw).trim();
    if (!s) return "";

    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (dateOnly) {
      const year = Number(dateOnly[1]);
      const month = Number(dateOnly[2]);
      const day = Number(dateOnly[3]);
      if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        !Number.isInteger(day) ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31
      ) {
        return s;
      }
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      // Construct local calendar date from components only (no UTC midnight parse).
      const local = new Date(year, month - 1, day);
      if (
        local.getFullYear() !== year ||
        local.getMonth() !== month - 1 ||
        local.getDate() !== day
      ) {
        return s;
      }
      return `${months[month - 1]} ${day}, ${year}`;
    }

    const viaShared = formatDate(s);
    if (!viaShared || /invalid date/i.test(viaShared)) return s;
    return viaShared;
  }

  function quoteStatusDisplay(raw) {
    const status = String(raw || "").trim().toLowerCase();
    if (!status) return "—";
    if (status === "accepted" || status === "approved") return "Approved";
    return String(raw || "").trim();
  }

  function looksLikeEstimateEmail(text) {
    const t = String(text || "");
    if (!t.trim()) return false;

    // Strong email cues only. "please find/review/see" never triggers alone.
    if (/^(hi\b|hello\b|dear\b|good (morning|afternoon|evening)\b)/im.test(t)) return true;
    if (
      /\b(best regards|kind regards|sincerely|thank you for (your )?interest|looking forward to hearing from you)\b/i.test(
        t
      )
    ) {
      return true;
    }
    if (/\bsubject\s*:/i.test(t) || /\b(sent from|mailto:|unsubscribe)\b/i.test(t)) return true;
    if (/https?:\/\//i.test(t) && /\b(estimate|quote|proposal)\b/i.test(t)) return true;
    return false;
  }

  function looksLikeTechnicalQaLabel(text) {
    const t = String(text || "");
    if (!t.trim()) return false;

    if (/\bCH[-_ ]?004\b/i.test(t)) return true;
    if (/\btechnical draft\b/i.test(t)) return true;
    if (/\bsmoke test\b/i.test(t)) return true;
    if (/\btest stage\b/i.test(t)) return true;
    if (/\btest payment\b/i.test(t)) return true;
    if (/\bQA\s+(technical|smoke|test)\b/i.test(t)) return true;

    // Standalone "QA" only when paired with another technical/test cue.
    if (!/\bQA\b/i.test(t)) return false;
    return /\b(CH[-_ ]?004|technical|smoke|test|draft)\b/i.test(t);
  }

  function undefinedMoneyLabel(scheduleStatus) {
    if (String(scheduleStatus || "").toLowerCase() === "draft") return "Draft payment schedule";
    return "Not yet defined";
  }

  function legalNoticesStatusLabel(legalNoticesBundle) {
    return resolveLegalNoticesEffective(legalNoticesBundle).label;
  }

  function signatureMethodLabel(setupBundle) {
    return signatureConfigured(setupBundle) ? "Configured" : "Missing";
  }

  function signatureRequestLabel(setupBundle) {
    if (!signatureConfigured(setupBundle)) return "—";
    const actual = String(setupBundle?.readiness?.actual_signature_status || "not_requested").toLowerCase();
    if (actual === "not_requested") return "Not Requested";
    return actual || "Not Requested";
  }

  function overallContractReadiness(source) {
    const setup = source?.contractSetup;
    const schedule = source?.paymentSchedule;
    const legalNotices = source?.legalNotices;
    const propOk = propertyConfigured(setup);
    const warOk = warrantyConfigured(setup);
    const payOk = paymentConfigured(schedule);
    const sigOk = signatureConfigured(setup);
    const legalEffective = resolveLegalNoticesEffective(legalNotices);
    const legalOk = legalEffective.contribution === "configured";
    if (propOk && warOk && payOk && sigOk && legalOk) return "configured";

    const propRaw = String(setup?.readiness?.project_address || "missing").toLowerCase();
    const warRaw = String(setup?.readiness?.warranty || "missing").toLowerCase();
    const payRaw = String(schedule?.readiness?.status || "missing").toLowerCase();
    const legalRaw = legalEffective.contribution;
    const anyPartial =
      propRaw === "needs_confirmation" ||
      warRaw === "needs_confirmation" ||
      payRaw === "draft" ||
      legalRaw === "draft" ||
      propOk ||
      warOk ||
      payOk ||
      sigOk ||
      legalOk;
    return anyPartial ? "draft" : "missing";
  }

  function readinessMapStatus(kind, source) {
    if (kind === "property") {
      return propertyConfigured(source.contractSetup) ? "available" : "missing";
    }
    if (kind === "warranty") {
      return warrantyConfigured(source.contractSetup) ? "available" : "missing";
    }
    if (kind === "payment") {
      const st = String(source.paymentSchedule?.readiness?.status || "missing").toLowerCase();
      if (st === "configured") return "available";
      if (st === "draft") return "needs_confirmation";
      return "missing";
    }
    if (kind === "signature") {
      return signatureConfigured(source.contractSetup) ? "available" : "missing";
    }
    if (kind === "legal_notices") {
      const st = resolveLegalNoticesEffective(source.legalNotices).contribution;
      if (st === "configured") return "available";
      if (st === "draft") return "needs_confirmation";
      return "missing";
    }
    return "missing";
  }

  function normalizeLegalProfile(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      legalBusinessName: String(raw.legal_business_name || "").trim(),
      dbaName: String(raw.dba_name || "").trim(),
      entityType: String(raw.entity_type || "").trim(),
      businessAddressLine1: String(raw.business_address_line1 || "").trim(),
      businessAddressLine2: String(raw.business_address_line2 || "").trim(),
      businessCity: String(raw.business_city || "").trim(),
      businessState: String(raw.business_state || "").trim(),
      businessPostalCode: String(raw.business_postal_code || "").trim(),
      mailingSameAsBusiness: raw.mailing_same_as_business !== false,
      mailingAddressLine1: String(raw.mailing_address_line1 || "").trim(),
      mailingAddressLine2: String(raw.mailing_address_line2 || "").trim(),
      mailingCity: String(raw.mailing_city || "").trim(),
      mailingState: String(raw.mailing_state || "").trim(),
      mailingPostalCode: String(raw.mailing_postal_code || "").trim(),
      businessPhone: String(raw.business_phone || "").trim(),
      businessEmail: String(raw.business_email || "").trim(),
      contractorLicenseStatus: String(raw.contractor_license_status || "unknown").trim().toLowerCase() || "unknown",
      contractorLicenseNumber: String(raw.contractor_license_number || "").trim(),
      contractorLicenseClassification: String(raw.contractor_license_classification || "").trim(),
      contractorLicenseState: String(raw.contractor_license_state || "").trim(),
      contractorLicenseExpiration: raw.contractor_license_expiration
        ? String(raw.contractor_license_expiration).slice(0, 10)
        : "",
      bondCompany: String(raw.bond_company || "").trim(),
      bondNumber: String(raw.bond_number || "").trim(),
      generalLiabilityCarrier: String(raw.general_liability_carrier || "").trim(),
      generalLiabilityPolicyNumber: String(raw.general_liability_policy_number || "").trim(),
      workersCompStatus: String(raw.workers_comp_status || "").trim(),
      workersCompCarrier: String(raw.workers_comp_carrier || "").trim(),
      workersCompPolicyNumber: String(raw.workers_comp_policy_number || "").trim(),
      authorizedSignerName: String(raw.authorized_signer_name || "").trim(),
      authorizedSignerTitle: String(raw.authorized_signer_title || "").trim(),
      primaryServiceState: String(raw.primary_service_state || "").trim(),
      timezone: String(raw.timezone || "").trim(),
      defaultContractLanguage: String(raw.default_contract_language || "en").trim().toLowerCase() || "en",
    };
  }

  function formatStructuredAddress(parts) {
    const line1 = [parts.line1, parts.line2].filter(Boolean).join(", ");
    const cityLine = [parts.city, parts.state, parts.zip].filter(Boolean).join(", ");
    return [line1, cityLine].filter(Boolean).join("\n");
  }

  function pickDisplay(legalValue, brandingValue) {
    const legal = String(legalValue || "").trim();
    if (legal) return { text: legal, source: "legal" };
    const brand = String(brandingValue || "").trim();
    if (brand) return { text: brand, source: "branding" };
    return { text: "", source: "missing" };
  }

  function entityTypeLabel(code) {
    const map = {
      sole_proprietor: "Sole Proprietor",
      llc: "LLC",
      corporation: "Corporation",
      partnership: "Partnership",
      other: "Other",
    };
    const key = String(code || "").trim().toLowerCase();
    if (!key) return "";
    return map[key] || code;
  }

  function licenseStatusLabel(status) {
    const map = {
      licensed: "Licensed",
      not_required: "Not required",
      exempt: "Exempt",
      unknown: "Unknown",
    };
    return map[status] || status || "Unknown";
  }

  function languageLabel(code) {
    const map = { en: "English", es: "Spanish", bilingual: "Bilingual" };
    return map[code] || code || "";
  }

  function maskSecret(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    if (s.length <= 4) return "••••";
    return `${"•".repeat(Math.min(8, s.length - 4))}${s.slice(-4)}`;
  }

  function setMaskedField(id, rawValue) {
    const el = $(id);
    if (!el) return;
    const raw = String(rawValue || "").trim();
    if (!raw) {
      el.textContent = "—";
      el.removeAttribute("data-secret");
      return;
    }
    el.setAttribute("data-secret", raw);
    const revealed = Boolean(revealSecrets[id]);
    const shown = revealed ? raw : maskSecret(raw);
    el.innerHTML =
      `<span class="cb-masked">${escapeHtml(shown)}</span>` +
      `<button type="button" class="cb-show-secret" data-reveal="${escapeHtml(id)}">${
        revealed ? "Hide" : "Show"
      }</button>`;
  }

  function legalAddressComplete(profile) {
    if (!profile) return false;
    return Boolean(
      profile.businessAddressLine1 &&
        profile.businessCity &&
        profile.businessState &&
        profile.businessPostalCode
    );
  }

  function licenseCheckStatus(profile) {
    if (!profile) return "missing";
    const st = profile.contractorLicenseStatus;
    if (st === "not_required" || st === "exempt") return "available";
    if (st === "unknown") return "needs_confirmation";
    if (st === "licensed") {
      return profile.contractorLicenseNumber && profile.contractorLicenseState
        ? "available"
        : "missing";
    }
    return "needs_confirmation";
  }

  function insuranceCheckStatus(profile) {
    if (!profile) return "needs_confirmation";
    const has =
      profile.bondCompany ||
      profile.bondNumber ||
      profile.generalLiabilityCarrier ||
      profile.generalLiabilityPolicyNumber ||
      profile.workersCompStatus ||
      profile.workersCompCarrier ||
      profile.workersCompPolicyNumber;
    return has ? "available" : "needs_confirmation";
  }

  function cloneEdits(source) {
    return {
      address: source.address,
      propLine1: source.propLine1 || "",
      propLine2: source.propLine2 || "",
      propCity: source.propCity || "",
      propState: source.propState || "",
      propZip: source.propZip || "",
      warDurationValue: source.warDurationValue || "",
      warDurationUnit: source.warDurationUnit || "years",
      warSummary: source.warSummary || "",
      warExclusions: source.warExclusions || "",
      scope: source.scope,
      exclusions: source.exclusions,
      startDate: source.startDate,
      dueDate: source.dueDate,
      paymentNotes: source.paymentNotes,
      warrantyNotes: source.warrantyNotes,
      additionalTerms: source.additionalTerms || source.terms || "",
    };
  }

  function editsEqual(a, b) {
    if (!a || !b) return a === b;
    const keys = [
      "address",
      "propLine1",
      "propLine2",
      "propCity",
      "propState",
      "propZip",
      "warDurationValue",
      "warDurationUnit",
      "warSummary",
      "warExclusions",
      "scope",
      "exclusions",
      "startDate",
      "dueDate",
      "paymentNotes",
      "warrantyNotes",
      "additionalTerms",
    ];
    return keys.every((k) => String(a[k] || "").trim() === String(b[k] || "").trim());
  }

  function hasLocalDraftChanges() {
    if (!draftEdits || !draftBaseline) return false;
    readEditsFromInputs();
    return !editsEqual(draftEdits, draftBaseline);
  }

  const LOCAL_DRAFT_LEAVE_MSG =
    "You have local draft changes that are not saved to the database. Leave this step anyway?";

  function confirmLeaveLocalDraft(actionLabel) {
    if (!hasLocalDraftChanges()) return true;
    return window.confirm(
      actionLabel
        ? `${LOCAL_DRAFT_LEAVE_MSG}\n\n(${actionLabel})`
        : LOCAL_DRAFT_LEAVE_MSG
    );
  }

  function articleIndex(id) {
    return ARTICLE_FLOW.findIndex((a) => a.id === id);
  }

  function articleMeta(id) {
    return ARTICLE_FLOW.find((a) => a.id === id) || ARTICLE_FLOW[0];
  }

  function isPreviewMode() {
    return Boolean($("cbMain")?.classList.contains("is-preview"));
  }

  /**
   * Nav status from existing source/readiness only.
   * Continue never mutates readiness; visited is UI-only.
   */
  function articleReadinessStatus(articleId, source, edits) {
    if (!source) return "missing";
    const e = edits || draftEdits || {};
    switch (articleId) {
      case "art-notice":
        return "available";
      case "art-contractor": {
        const p = source.legal?.profile;
        if (!p?.legalBusinessName) return "missing";
        if (!legalAddressComplete(p)) return "missing";
        if (!(p.businessPhone || p.businessEmail)) return "missing";
        if (licenseCheckStatus(p) === "missing") return "needs_confirmation";
        if (!(p.authorizedSignerName && p.authorizedSignerTitle)) return "missing";
        if (insuranceCheckStatus(p) === "missing") return "needs_confirmation";
        if (insuranceCheckStatus(p) === "needs_confirmation") return "needs_confirmation";
        return "available";
      }
      case "art-customer":
        return source.customerName ? "available" : "missing";
      case "art-property": {
        const st = readinessMapStatus("property", source);
        if (st === "available") return "available";
        return String(e.address || "").trim() ? "needs_confirmation" : "missing";
      }
      case "art-quote":
        return source.quoteId ? "available" : "missing";
      case "art-scope":
        return String(e.scope || "").trim() ? "available" : "missing";
      case "art-price":
        return source.contractTotal != null && source.contractTotal > 0 ? "available" : "missing";
      case "art-payment":
        return readinessMapStatus("payment", source);
      case "art-schedule":
        return String(e.startDate || "").trim() || String(e.dueDate || "").trim()
          ? "needs_confirmation"
          : "missing";
      case "art-changes":
        return "available";
      case "art-warranty":
        return readinessMapStatus("warranty", source);
      case "art-terms":
        return readinessMapStatus("legal_notices", source);
      case "art-signatures":
        return readinessMapStatus("signature", source);
      default:
        return "missing";
    }
  }

  function navStatusGlyph(status, visited) {
    if (status === "available") return "✓";
    if (status === "needs_confirmation") return "!";
    if (status === "missing") return "○";
    if (!visited) return "○";
    return "○";
  }

  function navStatusAttr(status, visited, isActive) {
    if (isActive) return status;
    if (status === "available" || status === "needs_confirmation" || status === "missing") {
      if (!visited && status === "available") return "unvisited";
      return status;
    }
    return visited ? status : "unvisited";
  }

  function contractHubHref() {
    const params = new URLSearchParams(window.location.search);
    const projectId = String(params.get("project_id") || "").trim();
    const quoteId = String(params.get("quote_id") || "").trim();
    const hub = new URLSearchParams();
    if (isPlausibleId(projectId)) hub.set("project_id", projectId);
    if (isPlausibleId(quoteId)) hub.set("quote_id", quoteId);
    const qs = hub.toString();
    return qs ? `/contract-hub?${qs}` : "/contract-hub";
  }

  function updateIndexNavStatus() {
    const links = document.querySelectorAll("#cbIndexNav a[data-section]");
    links.forEach((link) => {
      const id = link.getAttribute("data-section");
      const statusEl = link.querySelector(".cb-nav-status");
      const isActive = id === activeArticleId;
      link.classList.toggle("is-active", isActive);
      if (!statusEl || !sourceSnapshot) return;
      const status = articleReadinessStatus(id, sourceSnapshot, draftEdits);
      const visited = visitedArticleIds.has(id);
      const attr = navStatusAttr(status, visited, isActive);
      statusEl.setAttribute("data-status", attr);
      statusEl.textContent =
        isActive && status !== "missing" && status !== "needs_confirmation"
          ? "●"
          : navStatusGlyph(status, visited);
      if (isActive && (status === "missing" || status === "needs_confirmation")) {
        statusEl.textContent = navStatusGlyph(status, visited);
      }
      if (isActive && status === "available") statusEl.textContent = "●";
    });
  }

  function updateStepFooter() {
    renderWorkspaceChrome();
  }

  function syncEmptyWorkspace() {
    const main = $("cbMain");
    const empty = $("cbEmptyWorkspace");
    const noArticle = !activeArticleId && !isPreviewMode();
    if (main) main.classList.toggle("cb-no-article", noArticle);
    if (empty) empty.hidden = !noArticle;
  }

  function applyActiveArticle({ focus = true } = {}) {
    const main = $("cbMain");
    if (!main) return;

    document.querySelectorAll("[data-article]").forEach((article) => {
      const on = Boolean(activeArticleId) && article.id === activeArticleId;
      article.classList.toggle("is-active-article", on);
      if (on) article.classList.remove("is-collapsed");
      if (!on) {
        articleModes[article.id] = WS_MODE.PREVIEW;
      }
    });

    if (activeArticleId) {
      visitedArticleIds.add(activeArticleId);
      if (!articleModes[activeArticleId]) {
        articleModes[activeArticleId] = WS_MODE.PREVIEW;
      }
    } else {
      workspaceEditBaseline = null;
    }

    syncEmptyWorkspace();
    renderWorkspaceChrome();

    if (!focus || isPreviewMode() || !activeArticleId) return;
    const active = document.getElementById(activeArticleId);
    const title = active?.querySelector(".cb-article__title");
    if (title) {
      if (!title.hasAttribute("tabindex")) title.setAttribute("tabindex", "-1");
      try {
        title.focus({ preventScroll: true });
      } catch (_err) {
        title.focus();
      }
    }
    const stage = document.querySelector(".cb-stage");
    if (stage) {
      try {
        stage.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (_err2) {
        /* ignore */
      }
    }
  }

  function setActiveArticle(nextId, { confirmIfDirty = true, focus = true } = {}) {
    const normalized = nextId || null;
    if (normalized === activeArticleId) {
      applyActiveArticle({ focus: Boolean(normalized) && focus });
      return true;
    }
    if (normalized != null && !ARTICLE_FLOW.some((a) => a.id === normalized)) return false;

    if (isWorkspaceEditing() && confirmIfDirty) {
      if (!window.confirm("You are editing this article. Discard edits and switch?")) {
        return false;
      }
      if (workspaceEditBaseline && draftEdits) {
        Object.assign(draftEdits, workspaceEditBaseline);
        syncInputsFromEdits(draftEdits);
        if (sourceSnapshot) renderDocument(sourceSnapshot, draftEdits);
      }
      workspaceEditBaseline = null;
      if (activeArticleId) articleModes[activeArticleId] = WS_MODE.PREVIEW;
    } else if (confirmIfDirty && !confirmLeaveLocalDraft(normalized ? "Switch article" : "Close article")) {
      return false;
    }

    if (activeArticleId) articleModes[activeArticleId] = WS_MODE.PREVIEW;
    activeArticleId = normalized;
    if (activeArticleId) articleModes[activeArticleId] = WS_MODE.PREVIEW;
    applyActiveArticle({ focus: Boolean(normalized) && focus });
    return true;
  }

  function enterPreviewMode() {
    const main = $("cbMain");
    if (!main || isPreviewMode()) return;
    if (isWorkspaceEditing()) {
      if (!window.confirm("You are editing an article. Discard edits and open Preview?")) return;
      if (workspaceEditBaseline && draftEdits) {
        Object.assign(draftEdits, workspaceEditBaseline);
        syncInputsFromEdits(draftEdits);
        if (sourceSnapshot) renderDocument(sourceSnapshot, draftEdits);
      }
      workspaceEditBaseline = null;
      if (activeArticleId) articleModes[activeArticleId] = WS_MODE.PREVIEW;
    } else if (!confirmLeaveLocalDraft("Open Preview")) {
      return;
    }
    articleBeforePreview = activeArticleId;
    main.classList.add("is-preview");
    main.classList.remove("cb-no-article");
    document.body.classList.add("cb-customer-preview");
    const btn = $("cbPreviewToggle");
    if (btn) btn.textContent = "Edit";
    const empty = $("cbEmptyWorkspace");
    if (empty) empty.hidden = true;
    syncAllWorkspaceModes();
    updateStepFooter();
  }

  function exitPreviewMode() {
    const main = $("cbMain");
    if (!main || !isPreviewMode()) return;
    main.classList.remove("is-preview");
    document.body.classList.remove("cb-customer-preview");
    const btn = $("cbPreviewToggle");
    if (btn) btn.textContent = "Preview";
    if (articleBeforePreview && ARTICLE_FLOW.some((a) => a.id === articleBeforePreview)) {
      activeArticleId = articleBeforePreview;
    } else {
      activeArticleId = null;
    }
    articleBeforePreview = null;
    applyActiveArticle({ focus: Boolean(activeArticleId) });
  }

  function prepareFullDocumentForPrint() {
    const main = $("cbMain");
    if (main) {
      main.classList.add("is-printing");
      main.classList.remove("cb-no-article");
    }
    const empty = $("cbEmptyWorkspace");
    if (empty) empty.hidden = true;
    document.querySelectorAll("[data-article].is-collapsed").forEach((el) => {
      el.classList.remove("is-collapsed");
    });
  }

  function restoreAfterPrint() {
    const main = $("cbMain");
    if (main) main.classList.remove("is-printing");
    if (!isPreviewMode()) applyActiveArticle({ focus: false });
  }

  function readinessItems(source, edits) {
    const address = String(edits.address || "").trim();
    const scope = String(edits.scope || "").trim();
    const legal = source.legal || {};
    const profile = legal.profile;

    const legalIdentity = profile?.legalBusinessName ? "available" : "missing";
    const bizAddress = legalAddressComplete(profile) ? "available" : "missing";
    const bizContact =
      profile && (profile.businessPhone || profile.businessEmail)
        ? "available"
        : profile
          ? "missing"
          : "missing";
    const signer =
      profile?.authorizedSignerName && profile?.authorizedSignerTitle
        ? "available"
        : "missing";

    const propertyStatus = readinessMapStatus("property", source);
    const warrantyStatus = readinessMapStatus("warranty", source);
    const paymentStatus = readinessMapStatus("payment", source);
    const signatureStatus = readinessMapStatus("signature", source);
    const legalNoticesStatus = readinessMapStatus("legal_notices", source);
    const overall = overallContractReadiness(source);

    return [
      { label: "Approved quote", status: source.quoteId ? "available" : "missing" },
      { label: "Customer identity", status: source.customerName ? "available" : "missing" },
      {
        label: "Contract total",
        status: source.contractTotal != null && source.contractTotal > 0 ? "available" : "missing",
      },
      { label: "Existing scope", status: scope ? "available" : "missing" },
      { label: "Legal business identity", status: legalIdentity },
      { label: "Business address", status: bizAddress },
      { label: "Business contact", status: bizContact },
      { label: "License status", status: licenseCheckStatus(profile) },
      { label: "Authorized signer", status: signer },
      { label: "Insurance / bond information", status: insuranceCheckStatus(profile) },
      {
        label: "Project address",
        status: propertyStatus === "available" ? "available" : address ? "needs_confirmation" : "missing",
      },
      { label: "Payment schedule", status: paymentStatus },
      { label: "State-required legal notices", status: legalNoticesStatus },
      { label: "Warranty terms", status: warrantyStatus },
      { label: "Signature method", status: signatureStatus },
      {
        label: "Contract Builder readiness",
        status:
          overall === "configured"
            ? "available"
            : overall === "draft"
              ? "needs_confirmation"
              : "missing",
      },
    ];
  }

  function statusClass(status) {
    if (status === "available") return "is-available";
    if (status === "needs_confirmation") return "is-needs";
    return "is-missing";
  }

  function statusLabel(status) {
    if (status === "available") return "Available";
    if (status === "needs_confirmation") return "Needs confirmation";
    return "Missing";
  }

  function renderReadiness(source, edits) {
    const items = readinessItems(source, edits);
    const overall = overallContractReadiness(source);
    const list = $("cbReadiness");
    if (list) {
      list.innerHTML = items
        .map((item) => {
          const extra = item.note ? ` (${escapeHtml(item.note)})` : "";
          return (
            `<li><span class="cb-check-status ${statusClass(item.status)}">${escapeHtml(statusLabel(item.status))}</span>` +
            `<span>${escapeHtml(item.label)}${extra}</span></li>`
          );
        })
        .join("");
    }

    const ul = $("cbRequiredList");
    if (ul) {
      ul.innerHTML = items
        .map((item) => {
          const extra = item.note ? ` (${item.note})` : "";
          return `<li>${escapeHtml(item.label)} — ${escapeHtml(statusLabel(item.status))}${escapeHtml(extra)}</li>`;
        })
        .join("");
    }

    const available = items.filter((i) => i.status === "available").length;
    const pct = Math.round((available / items.length) * 100);
    const overallLabel =
      overall === "configured" ? "Configured" : overall === "draft" ? "Draft" : "Missing";
    setText("cbReadyPct", `${overallLabel} · ${pct}%`);

    const missingEl = $("cbMissingList");
    if (missingEl) {
      const missing = items.filter((i) => i.status === "missing");
      missingEl.innerHTML = missing.length
        ? missing.map((i) => `<li><span class="cb-check-status is-missing">Missing</span><span>${escapeHtml(i.label)}${i.note ? ` (${escapeHtml(i.note)})` : ""}</span></li>`).join("")
        : `<li><span class="cb-check-status is-available">Clear</span><span>No critical gaps listed</span></li>`;
    }

    const warnEl = $("cbWarningsList");
    if (warnEl) {
      const warns = items.filter((i) => i.status === "needs_confirmation");
      warnEl.innerHTML = warns.length
        ? warns.map((i) => `<li><span class="cb-check-status is-needs">Confirm</span><span>${escapeHtml(i.label)}</span></li>`).join("")
        : `<li><span class="cb-check-status is-available">Clear</span><span>No confirmation warnings</span></li>`;
    }

    const printReady = pct >= 35;
    const reviewReady = Boolean(source.customerName && source.contractTotal > 0 && source.quoteId);
    const signReady = overall === "configured";

    const setGate = (id, ok) => {
      const el = $(id);
      if (!el) return;
      el.textContent = ok ? "Yes" : "No";
      el.setAttribute("data-ok", ok ? "1" : "0");
    };
    setGate("cbPrintReady", printReady);
    setGate("cbReviewReady", reviewReady);
    setGate("cbSignReady", signReady);

    const next = $("cbNextStep");
    if (next) {
      const profile = source.legal?.profile;
      if (!reviewReady) {
        next.textContent = "Confirm customer and approved total before sharing this draft.";
      } else if (!profile?.legalBusinessName) {
        next.textContent = "Complete Legal & Contract Profile in Business Settings, then continue draft review.";
      } else if (!propertyConfigured(source.contractSetup)) {
        next.textContent = "Confirm the project address in contract setup, then continue draft review.";
      } else if (!paymentConfigured(source.paymentSchedule)) {
        next.textContent = "Confirm the payment schedule so stages exactly total the approved contract price.";
      } else if (!warrantyConfigured(source.contractSetup)) {
        next.textContent = "Confirm warranty terms in contract setup before signature readiness.";
      } else if (!signatureConfigured(source.contractSetup)) {
        next.textContent = "Configure the signature method in contract setup before signature readiness.";
      } else if (!legalNoticesConfigured(source.legalNotices)) {
        const legalSt = resolveLegalNoticesEffective(source.legalNotices).contribution;
        next.textContent =
          legalSt === "draft"
            ? "Confirm tenant legal notices before signature readiness."
            : "Configure and confirm tenant legal notices before signature readiness.";
      } else {
        next.textContent =
          "All required sections are configured. Signature sending is not available from this draft yet.";
      }
    }
  }

  function renderLogo(branding, displayName) {
    const img = $("cbLogoImg");
    const fallback = $("cbLogoFallback");
    const url = String(branding?.logoUrl || "").trim();
    const name = String(displayName || branding?.businessName || "").trim();
    if (img && url) {
      img.src = url;
      img.alt = name ? `${name} logo` : "Business logo";
      img.hidden = false;
      if (fallback) fallback.hidden = true;
    } else {
      if (img) {
        img.removeAttribute("src");
        img.hidden = true;
      }
      if (fallback) {
        fallback.hidden = false;
        fallback.textContent = initialsFromName(name || "MG");
      }
    }
  }

  function renderLegalBanner(legal) {
    const banner = $("cbLegalBanner");
    if (!banner) return;
    if (legal?.forbidden) {
      banner.hidden = false;
      banner.innerHTML =
        `Legal &amp; Contract Profile is unavailable for this account.`;
      return;
    }
    if (legal?.loadError) {
      banner.hidden = false;
      banner.innerHTML =
        `Legal profile could not be loaded right now. Draft review continues with available quote data. ` +
        `<a href="/business-settings#legal-contract-profile">Open Legal Profile</a>`;
      return;
    }
    if (!legal?.profile) {
      banner.hidden = false;
      banner.innerHTML =
        `Legal &amp; Contract Profile not completed. ` +
        `<a href="/business-settings#legal-contract-profile">Complete Legal Profile</a>`;
      return;
    }
    const missing = [];
    const p = legal.profile;
    if (!p.legalBusinessName) missing.push("Legal business name");
    if (!legalAddressComplete(p)) missing.push("Business address");
    if (!p.businessPhone && !p.businessEmail) missing.push("Business contact");
    if (licenseCheckStatus(p) === "missing") missing.push("License details");
    if (!(p.authorizedSignerName && p.authorizedSignerTitle)) missing.push("Authorized signer");
    if (missing.length) {
      banner.hidden = false;
      banner.innerHTML =
        `Legal &amp; Contract Profile needs attention: ${escapeHtml(missing.join(", "))}. ` +
        `<a href="/business-settings#legal-contract-profile">Update Legal Profile</a>`;
      return;
    }
    banner.hidden = true;
    banner.innerHTML = "";
  }

  function renderContractorArticle(source) {
    const b = source.branding || {};
    const legal = source.legal || {};
    const p = legal.profile;

    renderLegalBanner(legal);

    const namePick = pickDisplay(p?.legalBusinessName || p?.dbaName, b.businessName);
    const phonePick = pickDisplay(p?.businessPhone, b.businessPhone);
    const emailPick = pickDisplay(p?.businessEmail, b.businessEmail);
    const structured = p
      ? formatStructuredAddress({
          line1: p.businessAddressLine1,
          line2: p.businessAddressLine2,
          city: p.businessCity,
          state: p.businessState,
          zip: p.businessPostalCode,
        })
      : "";
    const addressPick = pickDisplay(structured, b.businessAddress);

    setText("cbBizName", namePick.text || "—");
    setText("cbLegalName", p?.legalBusinessName || (namePick.source === "branding" ? namePick.text : "") || "—");
    // Branding fallback still supplies the value; do not expose source labels to the customer.

    const dba = p?.dbaName || "";
    setText("cbLegalDba", dba || "—");
    const dbaLine = $("cbBizDba");
    if (dbaLine) {
      if (dba && dba !== namePick.text) {
        dbaLine.hidden = false;
        dbaLine.textContent = `DBA: ${dba}`;
      } else {
        dbaLine.hidden = true;
        dbaLine.textContent = "";
      }
    }

    setText("cbLegalEntity", entityTypeLabel(p?.entityType) || "—");
    setTextMany(["cbBizPhone", "cbBizPhoneBody"], phonePick.text || "—");
    setTextMany(["cbBizEmail", "cbBizEmailBody"], emailPick.text || "—");
    setText("cbBizAddress", addressPick.text ? addressPick.text.replace(/\n/g, ", ") : "—");
    setText("cbBizAddressBody", addressPick.text || "—");

    let mailing = "—";
    if (p) {
      if (p.mailingSameAsBusiness) {
        mailing = addressPick.text ? `${addressPick.text}\n(Same as business)` : "Same as business";
      } else {
        mailing =
          formatStructuredAddress({
            line1: p.mailingAddressLine1,
            line2: p.mailingAddressLine2,
            city: p.mailingCity,
            state: p.mailingState,
            zip: p.mailingPostalCode,
          }) || "—";
      }
    }
    setText("cbMailingAddress", mailing);

    setText("cbLicenseStatus", p ? licenseStatusLabel(p.contractorLicenseStatus) : "—");
    const hideLicenseDetails =
      p &&
      (p.contractorLicenseStatus === "exempt" || p.contractorLicenseStatus === "not_required");
    setText(
      "cbLicenseNumber",
      hideLicenseDetails ? "Not applicable" : p?.contractorLicenseNumber || "—"
    );
    setText(
      "cbLicenseClass",
      hideLicenseDetails ? "Not applicable" : p?.contractorLicenseClassification || "—"
    );
    setText(
      "cbLicenseState",
      hideLicenseDetails ? "Not applicable" : p?.contractorLicenseState || "—"
    );
    setText(
      "cbLicenseExp",
      hideLicenseDetails
        ? "Not applicable"
        : p?.contractorLicenseExpiration
          ? formatDate(p.contractorLicenseExpiration)
          : "—"
    );

    setText("cbBondCompany", p?.bondCompany || "—");
    setMaskedField("cbBondNumber", p?.bondNumber || "");
    setText("cbGlCarrier", p?.generalLiabilityCarrier || "—");
    setMaskedField("cbGlPolicy", p?.generalLiabilityPolicyNumber || "");
    setText("cbWcStatus", p?.workersCompStatus || "—");
    setText("cbWcCarrier", p?.workersCompCarrier || "—");
    setMaskedField("cbWcPolicy", p?.workersCompPolicyNumber || "");

    setText("cbSignerName", p?.authorizedSignerName || "—");
    setText("cbSignerTitle", p?.authorizedSignerTitle || "—");
    setText("cbServiceState", p?.primaryServiceState || "—");
    setText("cbTimezone", p?.timezone || "—");
    setText("cbContractLang", p ? languageLabel(p.defaultContractLanguage) : "—");

    const signerRef = $("cbHeaderSigner");
    if (signerRef) {
      if (p?.authorizedSignerName) {
        signerRef.hidden = false;
        signerRef.textContent = p.authorizedSignerTitle
          ? `Authorized signer: ${p.authorizedSignerName}, ${p.authorizedSignerTitle}`
          : `Authorized signer: ${p.authorizedSignerName}`;
      } else {
        signerRef.hidden = true;
        signerRef.textContent = "";
      }
    }

    renderLogo(b, namePick.text);

    const badges = [];
    const pushBadge = (label, status) => {
      if (status === "available" || status === "not_applicable") return;
      const text =
        status === "needs_confirmation"
          ? `Needs confirmation: ${label}`
          : `Missing: ${label}`;
      badges.push(`<span class="cb-missing">${escapeHtml(text)}</span>`);
    };

    pushBadge("Legal business name", p?.legalBusinessName ? "available" : "missing");
    pushBadge("Business address", legalAddressComplete(p) ? "available" : "missing");
    pushBadge(
      "License",
      (() => {
        const st = licenseCheckStatus(p);
        if (p && (p.contractorLicenseStatus === "exempt" || p.contractorLicenseStatus === "not_required")) {
          return "not_applicable";
        }
        return st;
      })()
    );
    pushBadge(
      "Authorized signer",
      p?.authorizedSignerName && p?.authorizedSignerTitle ? "available" : "missing"
    );
    pushBadge("Insurance / bond", insuranceCheckStatus(p));

    const missingEl = $("cbContractorMissing");
    if (missingEl) {
      missingEl.innerHTML = badges.join(" ");
    }
  }

  function syncInputsFromEdits(edits) {
    if ($("cbPropEditLine1")) $("cbPropEditLine1").value = edits.propLine1 || "";
    if ($("cbPropEditLine2")) $("cbPropEditLine2").value = edits.propLine2 || "";
    if ($("cbPropEditCity")) $("cbPropEditCity").value = edits.propCity || "";
    if ($("cbPropEditState")) $("cbPropEditState").value = edits.propState || "";
    if ($("cbPropEditZip")) $("cbPropEditZip").value = edits.propZip || "";
    if ($("cbWarEditDurationValue")) $("cbWarEditDurationValue").value = edits.warDurationValue || "";
    if ($("cbWarEditDurationUnit")) {
      $("cbWarEditDurationUnit").value = edits.warDurationUnit || "years";
    }
    if ($("cbWarEditSummary")) $("cbWarEditSummary").value = edits.warSummary || "";
    if ($("cbWarEditExclusions")) $("cbWarEditExclusions").value = edits.warExclusions || "";
    if ($("cbEditStart")) $("cbEditStart").value = edits.startDate || "";
    if ($("cbEditDue")) $("cbEditDue").value = edits.dueDate || "";
  }

  function readEditsFromInputs() {
    if (!draftEdits) return;
    // Only pull structured workspace fields while that article is in Edit.
    // Reading hidden Preview-mode inputs can falsely mark the draft dirty.
    if (getArticleMode("art-property") === WS_MODE.EDIT) {
      applyPropertyFieldsToEdits(draftEdits, readPropertyFieldsFromDom());
    }
    if (getArticleMode("art-warranty") === WS_MODE.EDIT) {
      applyWarrantyFieldsToEdits(draftEdits, readWarrantyFieldsFromDom());
    }
    // Scope / Terms are quote / Legal Notices sourced — no local editors.
    if ($("cbEditStart")) draftEdits.startDate = String($("cbEditStart").value || "").trim();
    if ($("cbEditDue")) draftEdits.dueDate = String($("cbEditDue").value || "").trim();
  }

  function pushUndo(id, value) {
    if (!id) return;
    if (!undoStacks[id]) undoStacks[id] = [];
    undoStacks[id].push(String(value ?? ""));
    if (undoStacks[id].length > 40) undoStacks[id].shift();
    redoStacks[id] = [];
  }

  function renderDocument(source, edits) {
    const money = formatMoney(source.contractTotal, source.currency);

    renderContractorArticle(source);

    setText("cbCustomerName", source.customerName || "—");
    setText("cbCoverCustomer", source.customerName || "—");
    setText("cbCustomerEmail", source.customerEmail || "—");
    setText("cbCustomerPhone", source.customerPhone || "—");
    setText("cbProjectName", source.projectName || "—");
    setTextMany(["cbQuoteNumber", "cbQuoteNumberBody"], source.quoteNumber || "—");
    setText("cbCoverDate", formatDate(source.acceptedAt) || formatDate(new Date().toISOString()) || "—");

    const setup = source.contractSetup?.setup || null;
    const propConfigured = propertyConfigured(source.contractSetup);
    let line1 = String(setup?.property_address_line1 || "").trim();
    let line2 = String(setup?.property_address_line2 || "").trim();
    let city = String(setup?.property_city || "").trim();
    let state = String(setup?.property_state || "").trim();
    let zip = String(setup?.property_postal_code || "").trim();
    const livePropertyLine = formatPropertyLine(setup);
    const draftFields = propertyFieldsFromEdits(edits);
    if (!livePropertyLine && (draftFields.line1 || draftFields.city || String(edits.address || "").trim())) {
      if (draftFields.line1 || draftFields.city) {
        line1 = draftFields.line1 || line1;
        line2 = draftFields.line2 || line2;
        city = draftFields.city || city;
        state = draftFields.state || state;
        zip = draftFields.zip || zip;
      } else if (String(edits.address || "").trim()) {
        line1 = String(edits.address || "").trim();
      }
    }
    const locality = formatPropertyLocality(city, state, zip);

    setText("cbPropStatus", sectionStatusLabel(propConfigured));
    setText("cbPropLine1", line1 || "—");
    const line2El = $("cbPropLine2");
    if (line2El) {
      if (line2) {
        line2El.hidden = false;
        line2El.textContent = line2;
      } else {
        line2El.hidden = true;
        line2El.textContent = "—";
      }
    }
    setText("cbPropCity", city || "—");
    setText("cbPropState", state || "—");
    setText("cbPropZip", zip || "—");
    setText("cbPropLocality", locality || "");
    const localityEl = $("cbPropLocality");
    if (localityEl) localityEl.hidden = !locality;

    const badge = $("cbPropConfirmBadge");
    const badgeText = $("cbPropConfirmText");
    const badgeMark = badge?.querySelector?.(".cb-prop-workspace__confirm-mark");
    const visibleAddress = Boolean(line1 || locality || livePropertyLine);
    if (badge) {
      badge.classList.remove("is-confirmed", "is-pending", "is-missing");
      if (propConfigured && livePropertyLine) {
        badge.classList.add("is-confirmed");
        if (badgeMark) badgeMark.textContent = "✓";
        if (badgeText) badgeText.textContent = "Property Address Confirmed";
      } else if (visibleAddress) {
        badge.classList.add("is-pending");
        if (badgeMark) badgeMark.textContent = "!";
        if (badgeText) badgeText.textContent = "Property address needs confirmation";
      } else {
        badge.classList.add("is-missing");
        if (badgeMark) badgeMark.textContent = "○";
        if (badgeText) badgeText.textContent = "Property address not set";
      }
    }

    const propEl = $("cbPropertyDisplay");
    const proposedWrap = $("cbPropProposedWrap");
    const proposedEl = $("cbPropProposed");
    if (propEl) propEl.textContent = livePropertyLine || formatPropertyFieldsLine({ line1, line2, city, state, zip }) || "—";
    if (proposedWrap) proposedWrap.hidden = true;
    if (proposedEl) proposedEl.textContent = "—";

    if (!line1) {
      setText("cbPropLine1", "—");
    }

    setText("cbQuoteStatus", quoteStatusDisplay(source.quoteStatus));
    setText("cbAcceptedAt", formatDate(source.acceptedAt) || "—");
    setText("cbContractTotal", money);

    const scope = String(edits.scope || "").trim();
    const exclusions = String(edits.exclusions || "").trim();
    const scopeEl = $("cbScopeDisplay");
    const scopeWarn = $("cbScopeEmailWarn");
    if (scopeEl) {
      if (scope) {
        scopeEl.textContent = exclusions ? `${scope}\n\nExclusions:\n${exclusions}` : scope;
      } else {
        scopeEl.textContent =
          "A clear description of the work has not been provided yet.";
      }
    }
    if (scopeWarn) {
      const showWarn = Boolean(scope && looksLikeEstimateEmail(scope));
      scopeWarn.hidden = !showWarn;
    }

    setText("cbPriceLine", money);
    setText("cbPayTotalLine", `Contract Total: ${money}`);

    const payStatus = String(source.paymentSchedule?.readiness?.status || "missing").toLowerCase();
    const undefinedLabel = undefinedMoneyLabel(payStatus);

    const depositEl = $("cbSumDeposit");
    if (depositEl) {
      depositEl.textContent =
        source.depositRequired != null
          ? formatMoney(source.depositRequired, source.currency)
          : undefinedLabel;
    }
    setText("cbSumProgress", undefinedLabel);
    setText("cbSumFinal", undefinedLabel);
    setText("cbSumChangeOrders", "Not yet defined");
    setText("cbSumTaxes", "Not yet defined");
    setText(
      "cbSumBalance",
      source.depositRequired != null && source.contractTotal != null
        ? formatMoney(Math.max(0, source.contractTotal - source.depositRequired), source.currency)
        : "Not yet defined"
    );

    renderPaymentScheduleSection(source);
    renderWarrantySection(source, edits);
    renderSignatureSection(source);
    renderLegalNoticesSection(source);

    setText(
      "cbStartDisplay",
      edits.startDate ? formatDate(edits.startDate) : "To be confirmed"
    );
    setText(
      "cbDueDisplay",
      edits.dueDate ? formatDate(edits.dueDate) : "To be confirmed"
    );

    renderReadiness(source, edits);
  }

  function renderLegalNoticesSection(source) {
    const effective = resolveLegalNoticesEffective(source.legalNotices);
    const statusEl = $("cbLegalNoticesStatus");
    if (statusEl) statusEl.textContent = effective.label;

    const hint = $("cbLegalNoticesHint");
    const listEl = $("cbLegalNoticesList");

    if (hint) {
      if (effective.hint) {
        hint.hidden = false;
        hint.innerHTML = `<span class="cb-missing">${escapeHtml(effective.hint)}</span>`;
      } else {
        hint.hidden = true;
        hint.innerHTML = "";
      }
    }

    if (listEl) {
      if (!effective.rows.length) {
        listEl.innerHTML = "";
      } else {
        listEl.innerHTML = effective.rows
          .map(
            (row) =>
              `<div class="cb-field" style="margin-bottom:10px;">` +
              `<span class="k">${escapeHtml(row.label)}</span>` +
              `<div class="v" style="white-space:pre-wrap;">${escapeHtml(row.text)}</div>` +
              `</div>`
          )
          .join("");
      }
    }
  }

  function renderPaymentScheduleSection(source) {
    const bundle = source.paymentSchedule || {};
    const readiness = bundle.readiness || {};
    const status = String(readiness.status || "missing").toLowerCase();
    const currency = source.currency || DEFAULT_CURRENCY;
    const undefinedLabel = undefinedMoneyLabel(status);
    const items = Array.isArray(bundle.items) ? [...bundle.items] : [];
    items.sort((a, b) => (Number(a.sequence_number) || 0) - (Number(b.sequence_number) || 0));

    const contractTotal =
      readiness.contract_total != null && Number.isFinite(Number(readiness.contract_total))
        ? Number(readiness.contract_total)
        : source.contractTotal != null && Number.isFinite(Number(source.contractTotal))
          ? Number(source.contractTotal)
          : null;
    const scheduledTotal =
      readiness.scheduled_total != null && Number.isFinite(Number(readiness.scheduled_total))
        ? Number(readiness.scheduled_total)
        : null;
    const itemCount =
      readiness.item_count != null ? Number(readiness.item_count) : items.length;
    const sumsMatch =
      contractTotal != null &&
      scheduledTotal != null &&
      Math.round(contractTotal * 100) === Math.round(scheduledTotal * 100);

    setText("cbPayTotalLine", `Contract Total: ${formatMoney(contractTotal, currency)}`);
    setText("cbPayScheduleStatus", paymentStatusLabel(bundle));

    const badge = $("cbPayStatusBadge");
    const badgeText = $("cbPayStatusText");
    const badgeMark = badge?.querySelector?.(".cb-pay-workspace__badge-mark");
    const stateNote = $("cbPayStateNote");
    const lead = $("cbPayLead");
    const summary = $("cbPaySummary");
    const timeline = $("cbPayTimeline");
    const empty = $("cbPayEmpty");
    const hubNote = $("cbPayHubNote");
    const sumWarn = $("cbPaySumWarn");
    const qaWarn = $("cbPayQaWarn");

    if (badge) {
      badge.classList.remove("is-configured", "is-draft", "is-missing");
      if (status === "configured") {
        badge.classList.add("is-configured");
        if (badgeMark) badgeMark.textContent = "✓";
        if (badgeText) badgeText.textContent = "Configured";
      } else if (status === "draft") {
        badge.classList.add("is-draft");
        if (badgeMark) badgeMark.textContent = "!";
        if (badgeText) badgeText.textContent = "Draft";
      } else {
        badge.classList.add("is-missing");
        if (badgeMark) badgeMark.textContent = "○";
        if (badgeText) badgeText.textContent = "Not configured";
      }
    }

    if (lead) {
      lead.textContent = "The contractual payment stages agreed for this project.";
    }

    const isUnavailable = Boolean(bundle.loadError || bundle.forbidden);
    const isMissing = status === "missing" || (!bundle.available && !items.length && status !== "draft" && status !== "configured");

    if (stateNote) {
      if (status === "configured") {
        stateNote.textContent =
          "This plan describes when each contractual payment becomes due.";
      } else if (status === "draft") {
        stateNote.textContent =
          "This payment plan has not been confirmed as the final contractual schedule.";
      } else if (isUnavailable) {
        stateNote.textContent = "Payment schedule data is temporarily unavailable.";
      } else {
        stateNote.textContent = "";
      }
    }

    if (hubNote) {
      hubNote.hidden = !(status === "configured" || status === "draft");
    }

    if ((isMissing || isUnavailable) && status !== "draft" && status !== "configured") {
      if (summary) summary.hidden = true;
      if (timeline) {
        timeline.hidden = true;
        timeline.innerHTML = "";
      }
      if (sumWarn) {
        sumWarn.hidden = true;
        sumWarn.textContent = "";
      }
      if (empty) {
        empty.hidden = false;
        const emptyTotal = $("cbPayEmptyTotal");
        if (emptyTotal) {
          if (contractTotal != null) {
            emptyTotal.hidden = false;
            emptyTotal.textContent = `Contract total ${formatMoney(contractTotal, currency)}`;
          } else {
            emptyTotal.hidden = true;
            emptyTotal.textContent = "";
          }
        }
      }
      if (qaWarn) {
        qaWarn.hidden = true;
        qaWarn.textContent = "";
      }
      setText("cbSumProgress", "Not yet defined");
      setText("cbSumFinal", "Not yet defined");
      return;
    }

    if (empty) empty.hidden = true;

    if (summary) {
      summary.hidden = false;
      setText(
        "cbPayContractTotal",
        contractTotal != null ? formatMoney(contractTotal, currency) : "—"
      );
      setText("cbPayStageCount", Number.isFinite(itemCount) ? String(itemCount) : "—");
      if (scheduledTotal != null) {
        const pctOfTotal =
          contractTotal != null && contractTotal > 0
            ? formatPercentDisplay(Math.round((scheduledTotal / contractTotal) * 10000) / 100)
            : "";
        setText(
          "cbPayScheduled",
          pctOfTotal
            ? `${formatMoney(scheduledTotal, currency)} · ${pctOfTotal}`
            : formatMoney(scheduledTotal, currency)
        );
      } else {
        setText("cbPayScheduled", "—");
      }
      const checkEl = $("cbPayPlanCheck");
      if (checkEl) {
        if (sumsMatch) {
          checkEl.textContent = "✓ Matches contract total";
        } else if (contractTotal != null && scheduledTotal != null) {
          checkEl.textContent = "Does not match contract total";
        } else {
          checkEl.textContent = "—";
        }
      }
    }

    if (sumWarn) {
      if (contractTotal != null && scheduledTotal != null && !sumsMatch) {
        sumWarn.hidden = false;
        sumWarn.textContent =
          "Payment stages do not currently equal the contract total.";
      } else {
        sumWarn.hidden = true;
        sumWarn.textContent = "";
      }
    }

    const qaLabels = items.filter((item) => looksLikeTechnicalQaLabel(item.label));
    if (qaWarn) {
      if (qaLabels.length) {
        qaWarn.hidden = false;
        qaWarn.textContent =
          "This payment stage appears to contain test or technical wording and should be replaced before the contract is sent to the customer.";
      } else {
        qaWarn.hidden = true;
        qaWarn.textContent = "";
      }
    }

    if (timeline) {
      if (!items.length) {
        timeline.hidden = false;
        timeline.innerHTML =
          `<p class="cb-pay-workspace__note">No payment stages have been defined yet.</p>`;
      } else {
        timeline.hidden = false;
        timeline.innerHTML = items
          .map((item) => {
            const typeKey = String(item.payment_type || "").toLowerCase();
            const typeLabel = escapeHtml(paymentTypeLabel(typeKey));
            const label = escapeHtml(item.label || paymentTypeLabel(typeKey));
            const amount = formatMoney(item.amount, currency);
            const pct = safeStagePercent(item, contractTotal);
            const pctText = pct != null ? formatPercentDisplay(pct) : "";
            const amountLine = pctText
              ? `${escapeHtml(amount)} · ${escapeHtml(pctText)}`
              : escapeHtml(amount);
            let due = dueRuleLabel(item.due_rule);
            const dueKey = String(item.due_rule || "").toLowerCase();
            if (dueKey === "fixed_date" && item.fixed_due_date) {
              const fixedLabel = formatPaymentDateOnly(item.fixed_due_date);
              due = fixedLabel ? `Due ${fixedLabel}` : "Due on a fixed date";
            } else if (dueKey === "milestone" && item.milestone_description) {
              due = `Due at milestone: ${item.milestone_description}`;
            }
            const metaParts = [];
            if (item.sequence_number != null) metaParts.push(`Stage ${item.sequence_number}`);
            if (typeKey === "custom") metaParts.push("Custom stage");
            if (typeKey === "material") metaParts.push("Material stage");
            const meta = metaParts.length
              ? `<p class="cb-pay-stage__meta">${escapeHtml(metaParts.join(" · "))}</p>`
              : "";
            return (
              `<article class="cb-pay-stage" data-payment-type="${escapeHtml(typeKey)}">` +
              `<div class="cb-pay-stage__body">` +
              `<p class="cb-pay-stage__type">${typeLabel}</p>` +
              `<h4 class="cb-pay-stage__label">${label}</h4>` +
              `<p class="cb-pay-stage__amount">${amountLine}</p>` +
              `<p class="cb-pay-stage__due">${escapeHtml(due)}</p>` +
              meta +
              `</div></article>`
            );
          })
          .join("");
      }
    }

    const depositItem = items.find((i) => String(i.payment_type || "").toLowerCase() === "deposit");
    const finalItem = items.find((i) =>
      ["final", "completion"].includes(String(i.payment_type || "").toLowerCase())
    );
    const progressItems = items.filter((i) =>
      ["progress", "start", "material", "custom"].includes(String(i.payment_type || "").toLowerCase())
    );
    if (depositItem) {
      const depositAmt = formatMoney(depositItem.amount, currency);
      setText(
        "cbSumDeposit",
        status === "draft" ? `${depositAmt} (draft payment schedule)` : depositAmt
      );
    }
    setText(
      "cbSumProgress",
      progressItems.length
        ? (() => {
            const amt = formatMoney(
              progressItems.reduce((sum, i) => sum + finiteNumber(i.amount, 0), 0),
              currency
            );
            return status === "draft" ? `${amt} (draft payment schedule)` : amt;
          })()
        : undefinedLabel
    );
    setText(
      "cbSumFinal",
      finalItem
        ? (() => {
            const amt = formatMoney(finalItem.amount, currency);
            return status === "draft" ? `${amt} (draft payment schedule)` : amt;
          })()
        : undefinedLabel
    );
  }


  function renderWarrantySection(source, edits) {
    const setup = source.contractSetup?.setup || null;
    const configured = warrantyConfigured(source.contractSetup);
    const setupFields = warrantyFieldsFromSetup(setup);
    const editFields = warrantyFieldsFromEdits(edits);
    const fields =
      configured || warrantyFieldsComplete(setupFields)
        ? setupFields
        : warrantyFieldsComplete(editFields)
          ? editFields
          : {
              durationValue: setupFields.durationValue || editFields.durationValue,
              durationUnit: setupFields.durationUnit || editFields.durationUnit || "years",
              summary: setupFields.summary || editFields.summary,
              exclusions: setupFields.exclusions || editFields.exclusions,
            };

    const title =
      formatWarrantyDurationTitle(fields) ||
      (fields.summary ? "Project warranty" : "Warranty terms not set");
    const length = formatWarrantyDurationShort(fields);
    const exclusionLines = parseExclusionLines(fields.exclusions);
    const descriptionParts = [];
    if (fields.summary) descriptionParts.push(fields.summary);
    if (fields.exclusions) descriptionParts.push(`Exclusions:\n${fields.exclusions}`);
    const description = descriptionParts.join("\n\n");

    setText("cbWarrantyStatus", sectionStatusLabel(configured));
    setText("cbWarrantyName", configured || fields.summary ? "Project warranty" : "—");
    setText("cbWarrantyLength", length || "—");
    setText("cbWarrantyDescription", description || "—");
    setText("cbWarrantyTitle", title);
    setText("cbWarrantySummaryPreview", fields.summary || "—");

    const list = $("cbWarrantyExclusionsList");
    if (list) {
      list.innerHTML = "";
      if (!exclusionLines.length) {
        const li = document.createElement("li");
        li.className = "is-empty";
        li.textContent = "No exclusions listed";
        list.appendChild(li);
      } else {
        for (const line of exclusionLines) {
          const li = document.createElement("li");
          li.textContent = line;
          list.appendChild(li);
        }
      }
    }

    const badge = $("cbWarrantyConfirmBadge");
    const badgeText = $("cbWarrantyConfirmText");
    const badgeMark = badge?.querySelector?.(".cb-war-workspace__confirm-mark");
    const hasContent = Boolean(fields.summary || fields.exclusions || fields.durationValue);
    if (badge) {
      badge.classList.remove("is-confirmed", "is-pending", "is-missing");
      if (configured) {
        badge.classList.add("is-confirmed");
        if (badgeMark) badgeMark.textContent = "✓";
        if (badgeText) badgeText.textContent = "Configured";
      } else if (hasContent) {
        badge.classList.add("is-pending");
        if (badgeMark) badgeMark.textContent = "!";
        if (badgeText) badgeText.textContent = "Warranty needs confirmation";
      } else {
        badge.classList.add("is-missing");
        if (badgeMark) badgeMark.textContent = "○";
        if (badgeText) badgeText.textContent = "Warranty not configured";
      }
    }

    if (configured && description) {
      setText("cbWarrantyDisplay", description);
    } else if (description) {
      setText("cbWarrantyDisplay", description);
    } else {
      setText("cbWarrantyDisplay", "Warranty terms have not yet been confirmed.");
    }
  }

  function renderSignatureSection(source) {
    setText("cbSignatureMethodStatus", signatureMethodLabel(source.contractSetup));
    setText("cbSignatureRequestStatus", signatureRequestLabel(source.contractSetup));
  }

  function renderAll() {
    if (!sourceSnapshot || !draftEdits) return;
    syncInputsFromEdits(draftEdits);
    renderDocument(sourceSnapshot, draftEdits);
    updateIndexNavStatus();
    updateStepFooter();
  }

  function wrapSelection(el, before, after) {
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const value = String(el.value || "");
    pushUndo(el.id, value);
    const selected = value.slice(start, end) || "text";
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    el.value = next;
    const cursor = start + before.length + selected.length + after.length;
    el.focus();
    el.setSelectionRange(cursor, cursor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function prefixLines(el, prefixFn) {
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const value = String(el.value || "");
    pushUndo(el.id, value);
    const blockStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const blockEnd = (() => {
      const i = value.indexOf("\n", end);
      return i === -1 ? value.length : i;
    })();
    const block = value.slice(blockStart, blockEnd);
    const lines = block.split("\n");
    const nextBlock = lines.map((line, idx) => prefixFn(line, idx)).join("\n");
    const next = value.slice(0, blockStart) + nextBlock + value.slice(blockEnd);
    el.value = next;
    el.focus();
    el.setSelectionRange(blockStart, blockStart + nextBlock.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function undoField(el) {
    if (!el?.id || !undoStacks[el.id]?.length) return;
    if (!redoStacks[el.id]) redoStacks[el.id] = [];
    redoStacks[el.id].push(String(el.value || ""));
    el.value = undoStacks[el.id].pop();
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function redoField(el) {
    if (!el?.id || !redoStacks[el.id]?.length) return;
    if (!undoStacks[el.id]) undoStacks[el.id] = [];
    undoStacks[el.id].push(String(el.value || ""));
    el.value = redoStacks[el.id].pop();
    el.focus();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function buildToolbar(bar) {
    const targetId = bar.getAttribute("data-target");
    const actions = [
      { label: "B", title: "Bold", run: (el) => wrapSelection(el, "**", "**") },
      { label: "I", title: "Italic", run: (el) => wrapSelection(el, "*", "*") },
      { label: "•", title: "Bullets", run: (el) => prefixLines(el, (line) => (line ? `• ${line.replace(/^([•\-]|\d+\.)\s+/, "")}` : "• ")) },
      {
        label: "1.",
        title: "Numbering",
        run: (el) => prefixLines(el, (line, idx) => `${idx + 1}. ${line.replace(/^([•\-]|\d+\.)\s+/, "")}`),
      },
      { label: "↶", title: "Undo", run: (el) => undoField(el) },
      { label: "↷", title: "Redo", run: (el) => redoField(el) },
    ];
    bar.innerHTML = "";
    for (const action of actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = action.label;
      btn.title = action.title;
      btn.addEventListener("click", () => {
        const el = $(targetId);
        if (!el) return;
        action.run(el);
      });
      bar.appendChild(btn);
    }
  }

  function bindCollapsibleArticles() {
    document.querySelectorAll("[data-article]").forEach((article) => {
      const head = article.querySelector("[data-collapse]");
      if (!head) return;
      head.addEventListener("click", (ev) => {
        // Builder sequential mode: collapse is disabled; Preview/Print show full doc.
        if (!isPreviewMode()) {
          ev.preventDefault();
          return;
        }
        article.classList.toggle("is-collapsed");
      });
    });
  }

  function bindIndexNav() {
    const links = [...document.querySelectorAll("#cbIndexNav a")];
    if (!links.length) return;

    links.forEach((link) => {
      link.addEventListener("click", (ev) => {
        const id = link.getAttribute("data-section");
        if (!id) return;
        ev.preventDefault();
        if (isPreviewMode()) {
          exitPreviewMode();
        }
        setActiveArticle(id, { confirmIfDirty: true, focus: true });
      });
    });
  }

  function bindStepFooter() {
    // CH-007A: footer actions are rendered by the workspace engine (event delegation not required;
    // buttons are recreated with listeners in renderWorkspaceFooter).
  }

  function expandAllArticlesForPrint() {
    prepareFullDocumentForPrint();
  }

  function bindEditors() {
    const ids = [
      "cbPropEditLine1",
      "cbPropEditLine2",
      "cbPropEditCity",
      "cbPropEditState",
      "cbPropEditZip",
      "cbWarEditDurationValue",
      "cbWarEditDurationUnit",
      "cbWarEditSummary",
      "cbWarEditExclusions",
      "cbEditStart",
      "cbEditDue",
    ];
    for (const id of ids) {
      const el = $(id);
      if (!el) continue;
      const eventName = el.tagName === "SELECT" ? "change" : "input";
      el.addEventListener(eventName, () => {
        readEditsFromInputs();
        if (id.startsWith("cbPropEdit")) {
          updatePropertyLiveHint();
          renderWorkspaceChrome();
        } else if (id.startsWith("cbWarEdit")) {
          updateWarrantyLiveHint();
          renderWorkspaceChrome();
        } else if (sourceSnapshot && draftEdits) {
          renderDocument(sourceSnapshot, draftEdits);
          updateIndexNavStatus();
        }
      });
      el.addEventListener("focus", () => {
        if (!undoStacks[id]?.length) pushUndo(id, el.value);
      });
    }

    document.querySelectorAll("[data-rich-toolbar]").forEach(buildToolbar);

    document.getElementById("cbDocument")?.addEventListener("click", (ev) => {
      const btn = ev.target?.closest?.("[data-reveal]");
      if (!btn) return;
      ev.preventDefault();
      const id = btn.getAttribute("data-reveal");
      if (!id) return;
      revealSecrets[id] = !revealSecrets[id];
      if (sourceSnapshot && draftEdits) renderDocument(sourceSnapshot, draftEdits);
    });

    $("cbResetDraft")?.addEventListener("click", () => {
      if (!sourceSnapshot) return;
      if (!confirmLeaveLocalDraft("Reset local draft")) return;
      draftEdits = cloneEdits(sourceSnapshot);
      draftBaseline = cloneEdits(sourceSnapshot);
      renderAll();
      applyActiveArticle({ focus: false });
    });

    $("cbPrintDraft")?.addEventListener("click", () => {
      prepareFullDocumentForPrint();
      window.print();
    });

    $("cbPreviewToggle")?.addEventListener("click", () => {
      if (isPreviewMode()) {
        exitPreviewMode();
      } else {
        enterPreviewMode();
      }
    });

    window.addEventListener("beforeprint", prepareFullDocumentForPrint);
    window.addEventListener("afterprint", restoreAfterPrint);

    window.addEventListener("beforeunload", (ev) => {
      if (suppressUnloadGuard) return;
      if (!hasLocalDraftChanges()) return;
      ev.preventDefault();
      ev.returnValue = "";
    });

    $("cbBackHub")?.addEventListener("click", (ev) => {
      if (!hasLocalDraftChanges()) return;
      if (!confirmLeaveLocalDraft("Leave Contract Builder")) {
        ev.preventDefault();
        return;
      }
      suppressUnloadGuard = true;
    });
  }

  /**
   * Early Owner/Admin fail-closed gate.
   * Uses existing tenant-legal-profile (Owner/Admin membership check) before any
   * project/quote/branding/setup/schedule fetches. No new backend endpoint.
   */
  async function assertOwnerOrAdminAccess() {
    let legalRes;
    try {
      legalRes = await fetchJson(LEGAL_PROFILE_API);
    } catch (_err) {
      return {
        ok: false,
        legalBundle: {
          available: false,
          loadError: "unavailable",
          forbidden: false,
          readiness: null,
          profile: null,
        },
        errorTitle: "Contract Builder",
        errorMessage: "Contract Builder access could not be verified. Try again.",
      };
    }

    if (legalRes.status === 401) {
      return {
        ok: false,
        legalBundle: {
          available: false,
          loadError: null,
          forbidden: false,
          readiness: null,
          profile: null,
        },
        errorTitle: "Contract Builder",
        errorMessage: "Sign in to open Contract Builder.",
      };
    }

    if (legalRes.status === 403) {
      return {
        ok: false,
        legalBundle: {
          available: false,
          loadError: null,
          forbidden: true,
          readiness: null,
          profile: null,
        },
        errorTitle: "Contract Builder",
        errorMessage:
          "Owner or admin membership is required to open Contract Builder.",
      };
    }

    if (!(legalRes.ok && legalRes.data?.ok === true)) {
      return {
        ok: false,
        legalBundle: {
          available: false,
          loadError: "unavailable",
          forbidden: false,
          readiness: null,
          profile: null,
        },
        errorTitle: "Contract Builder",
        errorMessage: "Contract Builder access could not be verified. Try again.",
      };
    }

    return {
      ok: true,
      legalBundle: {
        available: true,
        loadError: null,
        forbidden: false,
        readiness: legalRes.data.readiness || null,
        profile: normalizeLegalProfile(legalRes.data.profile),
      },
    };
  }

  async function init() {
    if (document.body?.dataset?.requiresAuth === "true" && !document.body.classList.contains("auth-ready")) {
      if (window.location.pathname.includes("index.html")) return;
    }

    await waitForAuthReady();
    if (document.body?.dataset?.requiresAuth === "true" && !document.body.classList.contains("auth-ready")) {
      return;
    }

    showLoading();
    bindCollapsibleArticles();
    bindIndexNav();
    bindStepFooter();

    const params = new URLSearchParams(window.location.search);
    const projectId = String(params.get("project_id") || "").trim();
    const quoteIdParam = String(params.get("quote_id") || "").trim();

    const back = $("cbBackHub");
    if (back && isPlausibleId(projectId)) {
      const hubParams = new URLSearchParams({ project_id: projectId });
      if (quoteIdParam) hubParams.set("quote_id", quoteIdParam);
      back.href = `/contract-hub?${hubParams.toString()}`;
    }

    // Early Owner/Admin gate — before projects/quote/branding/setup/schedule.
    const access = await assertOwnerOrAdminAccess();
    if (!access.ok) {
      showError(access.errorTitle, access.errorMessage);
      return;
    }
    const legalBundle = access.legalBundle;

    if (!isPlausibleId(projectId)) {
      showError(
        "Contract Builder",
        "Select an approved project from Contract Hub to open a draft preview."
      );
      return;
    }

    const projectsRes = await fetchJson(PROJECTS_API);
    if (!projectsRes.ok || projectsRes.data?.ok !== true || !Array.isArray(projectsRes.data.projects)) {
      showError(
        "Contract Builder",
        "This project is unavailable or does not belong to the current workspace."
      );
      return;
    }

    const key = projectId.toLowerCase();
    const project = projectsRes.data.projects.find(
      (row) => String(row?.id || "").trim().toLowerCase() === key
    );
    if (!project) {
      showError(
        "Contract Builder",
        "This project is unavailable or does not belong to the current workspace."
      );
      return;
    }

    const quoteId = quoteIdParam || String(project.quoteId || project.quote_id || "").trim();
    if (!isPlausibleId(quoteId)) {
      showError(
        "Contract Builder",
        "An approved quote is required before a contract draft can be prepared."
      );
      return;
    }

    const quoteRes = await fetchJson(
      `${QUOTE_EDIT_API}?quote_id=${encodeURIComponent(quoteId)}`
    );
    if (!quoteRes.ok || quoteRes.data?.ok !== true || !quoteRes.data?.quote) {
      showError(
        "Contract Builder",
        "The approved quote could not be loaded for this project."
      );
      return;
    }

    const quote = quoteRes.data.quote;
    const st = normStatus(quote.status);
    if (st && !APPROVED_QUOTE_STATUSES.has(st)) {
      showError(
        "Contract Builder",
        "Only accepted or approved quotes can open a contract draft preview."
      );
      return;
    }

    const brandingRes = await fetchJson(BRANDING_API);
    const branding =
      brandingRes.ok && brandingRes.data?.ok === true && brandingRes.data.branding
        ? brandingRes.data.branding
        : {};

    const setupQs =
      `project_id=${encodeURIComponent(projectId)}&quote_id=${encodeURIComponent(quoteId)}`;
    const [setupRes, scheduleRes, legalNoticesRes] = await Promise.all([
      fetchJson(`${CONTRACT_SETUP_API}?${setupQs}`),
      fetchJson(`${PAYMENT_SCHEDULE_API}?${setupQs}`),
      fetchJson(LEGAL_NOTICES_API),
    ]);

    if (
      setupRes.status === 403 ||
      scheduleRes.status === 403 ||
      legalNoticesRes.status === 403
    ) {
      showError(
        "Contract Builder",
        "Owner or admin membership is required to open Contract Builder readiness data."
      );
      return;
    }
    if (
      setupRes.status === 401 ||
      scheduleRes.status === 401 ||
      legalNoticesRes.status === 401
    ) {
      showError("Contract Builder", "Sign in to open Contract Builder.");
      return;
    }

    let setupBundle = {
      available: false,
      loadError: null,
      forbidden: false,
      setup: null,
      readiness: null,
    };
    if (setupRes.ok && setupRes.data?.ok === true) {
      setupBundle = {
        available: true,
        loadError: null,
        forbidden: false,
        setup: setupRes.data.setup || null,
        readiness: setupRes.data.readiness || null,
      };
    } else if (setupRes.status !== 404) {
      setupBundle.loadError = "unavailable";
    }

    let scheduleBundle = {
      available: false,
      loadError: null,
      forbidden: false,
      schedule: null,
      items: [],
      readiness: { status: "missing" },
      source: null,
    };
    if (scheduleRes.ok && scheduleRes.data?.ok === true) {
      scheduleBundle = {
        available: true,
        loadError: null,
        forbidden: false,
        schedule: scheduleRes.data.schedule || null,
        items: Array.isArray(scheduleRes.data.items) ? scheduleRes.data.items : [],
        readiness: scheduleRes.data.readiness || { status: "missing" },
        source: scheduleRes.data.source || null,
      };
    } else if (scheduleRes.status !== 404) {
      scheduleBundle.loadError = "unavailable";
      scheduleBundle.readiness = { status: "missing" };
    }

    let legalNoticesBundle = {
      available: false,
      loadError: null,
      forbidden: false,
      notices: null,
      readiness: { status: "missing" },
      effective_for_contracts: null,
      has_unconfirmed_changes: false,
    };
    if (legalNoticesRes.ok && legalNoticesRes.data?.ok === true) {
      legalNoticesBundle = {
        available: true,
        loadError: null,
        forbidden: false,
        notices: legalNoticesRes.data.notices || null,
        readiness: legalNoticesRes.data.readiness || { status: "missing" },
        effective_for_contracts:
          legalNoticesRes.data.effective_for_contracts || null,
        has_unconfirmed_changes:
          legalNoticesRes.data.has_unconfirmed_changes === true,
      };
    } else if (legalNoticesRes.status !== 404) {
      legalNoticesBundle.loadError = "unavailable";
      legalNoticesBundle.readiness = { status: "missing" };
    }

    const contractTotal = resolveContractTotal(project, quote);
    const customerName = String(
      project.clientName || project.client_name || quote.client_name || ""
    ).trim();
    if (!(contractTotal > 0) || !customerName) {
      showError(
        "Contract Builder",
        "A customer name and approved contract total are required before opening a draft preview."
      );
      return;
    }

    sourceSnapshot = buildSource(
      project,
      quote,
      branding,
      legalBundle,
      setupBundle,
      scheduleBundle,
      legalNoticesBundle
    );
    hydratePaymentDraftFromSource(sourceSnapshot);
    draftEdits = cloneEdits(sourceSnapshot);
    const setupFields = propertyFieldsFromSetup(setupBundle.setup);
    if (propertyFieldsComplete(setupFields) || setupFields.line1) {
      applyPropertyFieldsToEdits(draftEdits, setupFields);
    } else {
      const legacy = String(sourceSnapshot.address || "").trim();
      if (legacy) {
        draftEdits.propLine1 = legacy;
        draftEdits.address = legacy;
      }
    }
    const warSetupFields = warrantyFieldsFromSetup(setupBundle.setup);
    if (warrantyFieldsComplete(warSetupFields) || warSetupFields.summary || warSetupFields.durationValue) {
      applyWarrantyFieldsToEdits(draftEdits, warSetupFields);
    }
    draftBaseline = cloneEdits({ ...sourceSnapshot, ...draftEdits });
    activeArticleId = null;
    visitedArticleIds.clear();
    bindEditors();
    renderAll();
    applyActiveArticle({ focus: false });
    showMain();
  }

  document.addEventListener("DOMContentLoaded", () => {
    void init();
  });
})();
