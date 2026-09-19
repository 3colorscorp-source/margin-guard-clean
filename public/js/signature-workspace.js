/**
 * CH-012A — Owner Signature Workspace (UI only).
 * Reuses CH-011A–I APIs. No new backend.
 */
/* MG_SW_STATUS_BEGIN */
function mgSwIsEmailAlreadySent(emailUiStatus) {
  return String(emailUiStatus || "").toLowerCase() === "sent";
}

function mgSwIsEmailDeliveryFailed(emailUiStatus) {
  const st = String(emailUiStatus || "").toLowerCase();
  return st === "failed" || st === "stalled";
}

function mgSwIsEmailDeliveryInFlight(emailUiStatus) {
  const st = String(emailUiStatus || "").toLowerCase();
  return st === "queued" || st === "sending" || st === "accepted_db_pending";
}

function mgSwResolveSigningEmailMessage(emailUiStatus, opts) {
  const canCopy = Boolean(opts && opts.canCopy);
  if (mgSwIsEmailAlreadySent(emailUiStatus)) {
    return "The signing email was sent successfully.";
  }
  if (mgSwIsEmailDeliveryFailed(emailUiStatus)) {
    return "The signing email could not be delivered. Retry sending the email.";
  }
  if (mgSwIsEmailDeliveryInFlight(emailUiStatus)) {
    return "Sending the signing email…";
  }
  return canCopy
    ? "The signing request is prepared. No email has been sent yet. Copy the secure signing link for the customer."
    : "The signing request is prepared. No email has been sent yet.";
}

function mgSwGuidedDeliveryCopy(emailUiStatus, opts) {
  const email =
    String((opts && opts.email) || "").trim() || "the customer";
  if (mgSwIsEmailDeliveryInFlight(emailUiStatus)) {
    return {
      panel: "sending",
      visualStep: 3,
      title: "Sending to Customer",
      now: "Sending the signing link to " + email + "…",
      lead: "Please wait while delivery is confirmed.",
      why: "Please wait while delivery is confirmed.",
      emailProgress: "current",
      claimSent: false,
      primaryCta: null,
      secondaryCta: "Copy Signing Link",
    };
  }
  if (mgSwIsEmailAlreadySent(emailUiStatus)) {
    return {
      panel: "sent",
      visualStep: 3,
      title: "Wait for Customer",
      now: "Signing link sent to " + email + ".",
      lead: "The contract will complete automatically after the customer signs.",
      why: "The contract will complete automatically after the customer signs.",
      emailProgress: "complete",
      claimSent: true,
      primaryCta: null,
      secondaryCta: "Copy Signing Link",
    };
  }
  if (mgSwIsEmailDeliveryFailed(emailUiStatus)) {
    return {
      panel: "failed",
      visualStep: 2,
      title: "Confirm Customer & Send",
      now: "Email delivery needs attention.",
      lead: "Retry sending, or copy the signing link for the customer.",
      why: "Retry sending, or copy the signing link for the customer.",
      emailProgress: "waiting",
      claimSent: false,
      primaryCta: "Retry Sending Email",
      secondaryCta: "Copy Signing Link",
    };
  }
  return {
    panel: "ready",
    visualStep: 2,
    title: "Confirm Customer & Send",
    now: "Confirm the customer’s name and email, then send the signing link.",
    lead: "The customer is not created until you confirm and send.",
    why: "Next: wait for the customer to sign. The contract will complete automatically.",
    emailProgress: "waiting",
    claimSent: false,
    primaryCta: "Confirm Customer & Send",
    secondaryCta: "Copy Signing Link",
  };
}
/* MG_SW_STATUS_END */

/* MG_SW_AUTODOCS_BEGIN */
function mgSwShouldApplyAutoDocsResult(result, currentEnvelopeId) {
  if (!result || result.stale === true) return false;
  if (!result.envelopeId) return false;
  return String(result.envelopeId) === String(currentEnvelopeId || "");
}

function mgSwCreateAutoDocsSession(io) {
  const hooks = io || {};
  const maxAttempts = Number(hooks.maxAttempts) > 0 ? Number(hooks.maxAttempts) : 3;
  const lanes = new Map();
  let generation = 0;
  let currentEnvelopeId = null;

  function liveEnvelopeId() {
    if (typeof hooks.getCurrentEnvelopeId === "function") {
      return String(hooks.getCurrentEnvelopeId() || "");
    }
    return String(currentEnvelopeId || "");
  }

  function getLane(envelopeId) {
    const id = String(envelopeId || "");
    if (!id) return null;
    if (!lanes.has(id)) {
      const seedFromHooks = lanes.size === 0;
      lanes.set(id, {
        busy: false,
        hold: false,
        attempts: 0,
        lastError: null,
        runGeneration: 0,
        certs:
          seedFromHooks && Array.isArray(hooks.initialCertificates)
            ? hooks.initialCertificates.slice()
            : [],
        pdfs:
          seedFromHooks && Array.isArray(hooks.initialPdfs)
            ? hooks.initialPdfs.slice()
            : [],
      });
    }
    return lanes.get(id);
  }

  function snapshotLane(lane, envelopeId) {
    const row = lane || {
      busy: false,
      hold: false,
      attempts: 0,
      lastError: null,
      certs: [],
      pdfs: [],
    };
    return {
      busy: row.busy,
      hold: row.hold,
      attempts: row.attempts,
      lastError: row.lastError,
      generation,
      envelopeId: envelopeId != null ? String(envelopeId || "") : currentEnvelopeId,
      certId: row.certs[0] && row.certs[0].id,
      pdfId: row.pdfs[0] && row.pdfs[0].id,
      step:
        row.certs[0] && row.certs[0].id && row.pdfs[0] && row.pdfs[0].id
          ? 6
          : row.certs[0] && row.certs[0].id
            ? 5
            : 4,
    };
  }

  function isLive(token, envelopeId) {
    return Number(token) === generation && String(envelopeId || "") === liveEnvelopeId();
  }

  function staleResult(envelopeId, token, posts, loads) {
    return {
      ...snapshotLane(getLane(envelopeId), envelopeId),
      ok: true,
      stale: true,
      didWork: false,
      reason: "stale",
      envelopeId: String(envelopeId || ""),
      token,
      posts,
      loads,
      certs: null,
      pdfs: null,
    };
  }

  function resetForEnvelope(envelopeId) {
    const id = String(envelopeId || "");
    if (id && id === currentEnvelopeId) return generation;
    generation += 1;
    currentEnvelopeId = id || null;
    return generation;
  }

  function retry(envelopeId) {
    const lane = getLane(envelopeId || currentEnvelopeId);
    if (!lane) return;
    lane.hold = false;
    lane.lastError = null;
  }

  function hydrate(certs, pdfs, envelopeId) {
    const lane = getLane(envelopeId || currentEnvelopeId);
    if (!lane) return;
    lane.certs = Array.isArray(certs) ? certs.slice() : [];
    lane.pdfs = Array.isArray(pdfs) ? pdfs.slice() : [];
  }

  async function maybePrepare(envelope) {
    const envSt = String((envelope && envelope.status) || "").toLowerCase();
    const envelopeId = String((envelope && envelope.id) || "");
    const posts = [];
    const loads = [];
    if (envSt !== "completed" || !envelopeId) {
      return {
        ok: true,
        stale: false,
        didWork: false,
        reason: "not_completed",
        envelopeId,
        posts,
        loads,
        ...snapshotLane(getLane(envelopeId), envelopeId),
      };
    }
    resetForEnvelope(envelopeId);
    const lane = getLane(envelopeId);
    if (lane.certs[0] && lane.certs[0].id && lane.lastError === "certificate") {
      lane.hold = false;
      lane.lastError = null;
    }
    if (lane.pdfs[0] && lane.pdfs[0].id && lane.lastError === "pdf") {
      lane.hold = false;
      lane.lastError = null;
    }
    if (lane.certs[0] && lane.certs[0].id && lane.pdfs[0] && lane.pdfs[0].id) {
      lane.hold = false;
      return {
        ok: true,
        stale: false,
        didWork: false,
        reason: "complete",
        envelopeId,
        posts,
        loads,
        certs: lane.certs.slice(),
        pdfs: lane.pdfs.slice(),
        ...snapshotLane(lane, envelopeId),
      };
    }
    if (lane.busy) {
      return {
        ok: true,
        stale: false,
        didWork: false,
        reason: "busy",
        envelopeId,
        posts,
        loads,
        ...snapshotLane(lane, envelopeId),
      };
    }
    if (lane.hold) {
      return {
        ok: true,
        stale: false,
        didWork: false,
        reason: "hold",
        envelopeId,
        posts,
        loads,
        ...snapshotLane(lane, envelopeId),
      };
    }
    if (lane.attempts >= maxAttempts) {
      lane.hold = true;
      return {
        ok: true,
        stale: false,
        didWork: false,
        reason: "limit",
        envelopeId,
        posts,
        loads,
        ...snapshotLane(lane, envelopeId),
      };
    }

    const token = (generation += 1);
    lane.busy = true;
    lane.runGeneration = token;
    try {
      if (!(lane.certs[0] && lane.certs[0].id)) {
        lane.attempts += 1;
        posts.push("certificate-create");
        const res = await hooks.createCertificate(envelope);
        if (!isLive(token, envelopeId)) return staleResult(envelopeId, token, posts, loads);
        if (!res || res.ok !== true) {
          lane.lastError = "certificate";
          lane.hold = true;
          return {
            ok: false,
            stale: false,
            didWork: true,
            reason: "certificate_failed",
            envelopeId,
            token,
            posts,
            loads,
            ...snapshotLane(lane, envelopeId),
          };
        }
        loads.push("certificates");
        const certs = (await hooks.loadCertificates(envelope)) || [];
        if (!isLive(token, envelopeId)) return staleResult(envelopeId, token, posts, loads);
        lane.certs = certs;
        if (!(lane.certs[0] && lane.certs[0].id)) {
          lane.lastError = "certificate";
          lane.hold = true;
          return {
            ok: false,
            stale: false,
            didWork: true,
            reason: "certificate_failed",
            envelopeId,
            token,
            posts,
            loads,
            ...snapshotLane(lane, envelopeId),
          };
        }
      }
      if (lane.certs[0] && lane.certs[0].id && !(lane.pdfs[0] && lane.pdfs[0].id)) {
        if (!isLive(token, envelopeId)) return staleResult(envelopeId, token, posts, loads);
        lane.attempts += 1;
        posts.push("pdf-create");
        const res = await hooks.createPdf(envelope);
        if (!isLive(token, envelopeId)) return staleResult(envelopeId, token, posts, loads);
        if (!res || res.ok !== true) {
          lane.lastError = "pdf";
          lane.hold = true;
          return {
            ok: false,
            stale: false,
            didWork: true,
            reason: "pdf_failed",
            envelopeId,
            token,
            posts,
            loads,
            certs: lane.certs.slice(),
            ...snapshotLane(lane, envelopeId),
          };
        }
        loads.push("pdfs");
        const pdfs = (await hooks.loadPdfs(envelope)) || [];
        if (!isLive(token, envelopeId)) return staleResult(envelopeId, token, posts, loads);
        lane.pdfs = pdfs;
        if (!(lane.pdfs[0] && lane.pdfs[0].id)) {
          lane.lastError = "pdf";
          lane.hold = true;
          return {
            ok: false,
            stale: false,
            didWork: true,
            reason: "pdf_failed",
            envelopeId,
            token,
            posts,
            loads,
            certs: lane.certs.slice(),
            ...snapshotLane(lane, envelopeId),
          };
        }
      }
      if (!isLive(token, envelopeId)) return staleResult(envelopeId, token, posts, loads);
      return {
        ok: true,
        stale: false,
        didWork: posts.length > 0,
        reason: "complete",
        envelopeId,
        token,
        posts,
        loads,
        certs: lane.certs.slice(),
        pdfs: lane.pdfs.slice(),
        ...snapshotLane(lane, envelopeId),
      };
    } finally {
      if (lane.runGeneration === token) {
        lane.busy = false;
      }
    }
  }

  return {
    maybePrepare,
    retry,
    hydrate,
    resetForEnvelope,
    isLive,
    getGeneration: () => generation,
    getState: () => snapshotLane(getLane(currentEnvelopeId), currentEnvelopeId),
    getLaneState: (envelopeId) => snapshotLane(getLane(envelopeId), envelopeId),
  };
}
/* MG_SW_AUTODOCS_END */

(() => {
  "use strict";

  const PROJECTS_API = "/.netlify/functions/get-project-control-projects";
  const PACKAGES_API = "/.netlify/functions/contract-packages";
  const ENVELOPES_API = "/.netlify/functions/contract-envelopes";
  const ENVELOPE_CREATE_API = "/.netlify/functions/contract-envelope-create";
  const ENVELOPE_SEND_API = "/.netlify/functions/contract-envelope-send";
  const SIGNERS_API = "/.netlify/functions/contract-signers";
  const SIGNER_CREATE_API = "/.netlify/functions/contract-signer-create";
  const SIGNER_UPDATE_API = "/.netlify/functions/contract-signer-update";
  const SIGNER_DELETE_API = "/.netlify/functions/contract-signer-delete";
  const SIGN_CONTRACTOR_API = "/.netlify/functions/contract-sign-contractor";
  const CERTS_API = "/.netlify/functions/contract-certificates";
  const CERT_CREATE_API = "/.netlify/functions/contract-certificate-create";
  const PDFS_API = "/.netlify/functions/contract-signed-pdfs";
  const PDF_CREATE_API = "/.netlify/functions/contract-signed-pdf-create";
  const EMAIL_QUEUE_API = "/.netlify/functions/contract-invitation-email-queue";

  const ENV_STATUSES = [
    "draft",
    "sent",
    "opened",
    "completed",
    "cancelled",
    "expired",
    "declined",
  ];

  const state = {
    projects: [],
    project: null,
    packages: [],
    package: null,
    envelopes: [],
    envelope: null,
    signers: [],
    certificates: [],
    artifacts: [],
    delivery: null,
    signingLink: null,
    emailDelivery: null,
    emailUiStatus: null, // ready | queued | sending | sent | failed | stalled
    emailAttemptId: null,
    emailBusy: false,
    emailStuck: false,
    emailRecoverable: false,
    emailRecoveredAttemptId: null,
    visualStep: 1,
    visualStepOverride: null,
    busy: false,
    autoDocsBusy: false,
    autoDocAttempts: 0,
    autoDocsEnvelopeId: null,
    autoPreparingDocs: false,
    autoDocsHold: false,
  };

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

  function fmtWhen(value) {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString();
    } catch (_err) {
      return String(value);
    }
  }

  function shortHash(value) {
    const s = String(value || "").trim();
    if (!s) return "—";
    if (s.length <= 20) return s;
    return `${s.slice(0, 12)}…${s.slice(-6)}`;
  }

  function toast(message, kind) {
    const el = $("swToast");
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || "";
    el.classList.toggle("is-error", kind === "error");
    el.classList.toggle("is-ok", kind === "ok");
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

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
    });
    let data = {};
    try {
      data = await res.json();
    } catch (_err) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  }

  function showLoading() {
    $("swLoading")?.removeAttribute("hidden");
    $("swError")?.setAttribute("hidden", "");
    $("swMain")?.setAttribute("hidden", "");
  }

  function showError(title, message) {
    $("swLoading")?.setAttribute("hidden", "");
    $("swMain")?.setAttribute("hidden", "");
    setText("swErrorTitle", title);
    setText("swErrorMessage", message);
    $("swError")?.removeAttribute("hidden");
  }

  function showMain() {
    $("swLoading")?.setAttribute("hidden", "");
    $("swError")?.setAttribute("hidden", "");
    $("swMain")?.removeAttribute("hidden");
  }

  function closeModal() {
    $("swModal")?.setAttribute("hidden", "");
    const body = $("swModalBody");
    const actions = $("swModalActions");
    if (body) body.innerHTML = "";
    if (actions) actions.innerHTML = "";
  }

  function openModal(title, bodyHtml, actionNodes) {
    setText("swModalTitle", title);
    const body = $("swModalBody");
    const actions = $("swModalActions");
    if (body) body.innerHTML = bodyHtml;
    if (actions) {
      actions.innerHTML = "";
      (actionNodes || []).forEach((node) => actions.appendChild(node));
    }
    $("swModal")?.removeAttribute("hidden");
    window.requestAnimationFrame(() => {
      const root = $("swModal");
      const focusable = root?.querySelector(
        "#swModalBody input:not([type=hidden]):not([type=checkbox]), #swModalBody textarea, #swModalBody select, #swModalActions .btn.primary"
      );
      focusable?.focus();
    });
  }

  function btn(label, className, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = className || "btn ghost";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function envelopeEditable() {
    return String(state.envelope?.status || "").toLowerCase() === "draft";
  }

  function isDualSigning() {
    return state.package?.signing_policy?.require_contractor_signature === true;
  }

  function requiredSigner(role) {
    const key = String(role || "").toLowerCase();
    return (state.signers || []).find(
      (s) =>
        String(s.role || "").toLowerCase() === key && s.is_required !== false
    );
  }

  function contractorProposal() {
    const p = state.package?.contractor_proposal || {};
    return {
      party_name: String(p.party_name || "").trim(),
      title: String(p.title || "").trim(),
      email: String(p.email || "").trim(),
    };
  }

  function sendCtaLabel() {
    return isDualSigning() ? "Send to Customer" : "Send For Signature";
  }

  function isContractorSigned() {
    const owner = requiredSigner("owner");
    return Boolean(owner && String(owner.status || "").toLowerCase() === "signed");
  }

  function guidedCustomerEmail() {
    const signer = customerDeliverySigner();
    return String(signer?.email || "").trim();
  }

  async function ensureDraftEnvelope(opts) {
    const silent = Boolean(opts && opts.silent);
    if (state.envelope?.id) return state.envelope;
    if (!state.package?.id) {
      throw new Error("Freeze the contract before starting signatures.");
    }
    const res = await api(ENVELOPE_CREATE_API, {
      method: "POST",
      body: JSON.stringify({ package_id: state.package.id }),
    });
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not start signing");
    }
    if (!silent) toast("Signing request created", "ok");
    await loadEnvelopes(state.package.id);
    state.envelope = res.data.envelope || state.envelope;
    await refreshEnvelopeChain();
    renderAll();
    return state.envelope;
  }

  async function ensureContractorSigner() {
    const existing = requiredSigner("owner");
    if (existing?.id) return existing;
    if (!state.envelope?.id) {
      throw new Error("Start the contract before signing as contractor");
    }
    const proposal = contractorProposal();
    const partyName = proposal.party_name;
    if (!partyName) {
      openConfirmContractorModal();
      return null;
    }
    const res = await api(SIGNER_CREATE_API, {
      method: "POST",
      body: JSON.stringify({
        envelope_id: state.envelope.id,
        role: "owner",
        party_name: partyName,
        email: proposal.email || "",
        phone: "",
        sign_order: 1,
        auth_method: "in_app",
        is_required: true,
      }),
    });
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not confirm contractor");
    }
    await loadSigners(state.envelope.id);
    renderAll();
    return requiredSigner("owner");
  }

  async function continueAfterReview() {
    try {
      await ensureDraftEnvelope({ silent: true });
      if (!isDualSigning()) {
        openConfirmCustomerModal();
        return;
      }
      if (isContractorSigned()) {
        openConfirmCustomerModal();
        return;
      }
      const owner = await ensureContractorSigner();
      if (!owner) return;
      openSignContractorModal();
    } catch (err) {
      toast(err?.message || "Could not continue", "error");
    }
  }

  function showContractorSignSuccess() {
    openModal(
      "Contractor Signature",
      `<p class="sw-modal-success">Contractor signature completed.</p>
       <p class="sw-modal-sub">Next, confirm the customer and send the signing link.</p>`,
      [
        btn("Continue to Customer", "btn primary", () => {
          closeModal();
          openConfirmCustomerModal();
        }),
      ]
    );
  }

  function openConfirmCustomerModal() {
    if (!envelopeEditable() && !requiredSigner("customer")?.id) {
      toast("Customer details are locked after the contract is sent", "error");
      return;
    }
    const existing = requiredSigner("customer");
    const suggestedName = String(
      existing?.party_name ||
        state.project?.clientName ||
        state.project?.client_name ||
        ""
    ).trim();
    const suggestedEmail = String(
      existing?.email || state.project?.clientEmail || state.project?.client_email || ""
    ).trim();
    const canEdit = envelopeEditable();
    openModal(
      "Confirm Customer",
      `<p class="sw-vis-now" id="swCustomerNow">Confirm the customer’s name and email, then send the signing link.</p>
       <p class="sw-modal-sub">The customer is not created until you confirm and send.</p>
       <div class="sw-modal-card">
         <div class="sw-modal-card__title">Customer details</div>
         <div class="field"><label for="swFormName">Customer name</label><input id="swFormName" autocomplete="name" ${canEdit ? "" : "readonly"} /></div>
         <div class="field"><label for="swFormEmail">Customer email</label><input id="swFormEmail" type="email" autocomplete="email" ${canEdit ? "" : "readonly"} /></div>
       </div>`,
      [
        btn("Back", "btn ghost", closeModal),
        btn("Confirm Customer & Send", "btn primary", async () => {
          const name = String($("swFormName")?.value || "").trim();
          const email = String($("swFormEmail")?.value || "").trim();
          if (!name) {
            toast("Enter the customer’s name", "error");
            $("swFormName")?.focus();
            return;
          }
          if (!email) {
            toast("Enter the customer’s email", "error");
            $("swFormEmail")?.focus();
            return;
          }
          try {
            if (isDualSigning() && !isContractorSigned()) {
              throw new Error("Sign as the contractor before sending to the customer.");
            }
            await ensureDraftEnvelope({ silent: true });
            if (canEdit) {
              await saveGuidedCustomerSigner(name, email, existing);
            }
            await prepareSigningLinkIfNeeded();
            closeModal();
            renderAll();
            $("swEmailLinkBtn")?.click();
          } catch (err) {
            toast(err?.message || "Could not send to the customer", "error");
          }
        }),
      ]
    );
    if ($("swFormName")) $("swFormName").value = suggestedName;
    if ($("swFormEmail")) $("swFormEmail").value = suggestedEmail;
  }

  async function saveGuidedCustomerSigner(name, email, existing) {
    const payload = {
      role: "customer",
      party_name: name,
      email,
      phone: existing?.phone || "",
      sign_order: isDualSigning() ? 2 : 1,
      auth_method: "email_link",
      is_required: true,
    };
    let res;
    if (existing?.id) {
      res = await api(SIGNER_UPDATE_API, {
        method: "POST",
        body: JSON.stringify({
          signer_id: existing.id,
          expected_updated_at: existing.updated_at,
          ...payload,
        }),
      });
    } else {
      res = await api(SIGNER_CREATE_API, {
        method: "POST",
        body: JSON.stringify({
          envelope_id: state.envelope.id,
          ...payload,
        }),
      });
    }
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not confirm the customer");
    }
    await loadSigners(state.envelope.id);
    renderAll();
  }

  async function prepareSigningLinkIfNeeded() {
    if (isLinkReady()) return;
    if (!state.envelope?.id) {
      throw new Error("Start the contract before sending");
    }
    const res = await api(ENVELOPE_SEND_API, {
      method: "POST",
      body: JSON.stringify({
        envelope_id: state.envelope.id,
        expected_updated_at: state.envelope.updated_at,
        delivery_mode: "prepared",
      }),
    });
    if (!res.ok || res.data?.ok !== true) {
      const blockers = Array.isArray(res.data?.blockers)
        ? res.data.blockers.map((b) => b.message || b.code).join("; ")
        : "";
      throw new Error(blockers || res.data?.error || "Could not prepare the signing link");
    }
    captureDeliveryLink(res.data.delivery, { fromSendResponse: true });
    await loadEnvelopes(state.package.id);
    if (res.data.envelope) state.envelope = res.data.envelope;
    await refreshEnvelopeChain();
    renderAll();
  }

  function maybeAutoPrepareDocuments(step) {
    if (step < 4 || step > 5) return;
    if (autoDocsSkipRenderKick) return;
    void runAutoPrepareDocuments();
  }

  let autoDocsSession = null;
  let autoDocsSkipRenderKick = false;

  function noteEnvelopeChange(prevId, nextId) {
    if (String(prevId || "") === String(nextId || "")) return;
    getAutoDocsSession().resetForEnvelope(nextId || "");
    state.certificates = [];
    state.artifacts = [];
    state.autoDocsBusy = false;
    state.autoDocsHold = false;
  }

  function getAutoDocsSession() {
    if (autoDocsSession) return autoDocsSession;
    autoDocsSession = mgSwCreateAutoDocsSession({
      getCurrentEnvelopeId: () => String(state.envelope?.id || ""),
      createCertificate: async (envelope) => {
        const res = await api(CERT_CREATE_API, {
          method: "POST",
          body: JSON.stringify({ envelope_id: envelope.id }),
        });
        return { ok: Boolean(res && res.ok && res.data && res.data.ok === true) };
      },
      loadCertificates: async (envelope) => fetchCertificates(envelope && envelope.id),
      createPdf: async (envelope) => {
        const res = await api(PDF_CREATE_API, {
          method: "POST",
          body: JSON.stringify({ envelope_id: envelope.id }),
        });
        return { ok: Boolean(res && res.ok && res.data && res.data.ok === true) };
      },
      loadPdfs: async (envelope) => fetchPdfs(envelope && envelope.id),
    });
    return autoDocsSession;
  }

  async function runAutoPrepareDocuments() {
    const session = getAutoDocsSession();
    const envelope = state.envelope;
    const startedId = String((envelope && envelope.id) || "");
    session.hydrate(state.certificates, state.artifacts, startedId);
    const result = await session.maybePrepare(envelope);
    if (!mgSwShouldApplyAutoDocsResult(result, state.envelope?.id)) {
      return result;
    }
    const st = session.getLaneState(startedId) || session.getState();
    state.autoDocsBusy = st.busy;
    state.autoDocAttempts = st.attempts;
    state.autoDocsHold = st.hold;
    if (Array.isArray(result.certs)) state.certificates = result.certs;
    if (Array.isArray(result.pdfs)) state.artifacts = result.pdfs;
    if (result.reason === "busy" || result.reason === "hold" || result.reason === "not_completed") {
      return result;
    }
    if (result.ok === false) {
      toast("We could not prepare your documents. You can try again.", "error");
    }
    if (result.didWork) {
      autoDocsSkipRenderKick = true;
      try {
        renderAll();
      } finally {
        autoDocsSkipRenderKick = false;
      }
    }
    return result;
  }

  function computeSendReadiness() {
    const blockers = [];
    const env = state.envelope;
    const pkg = state.package;
    const signers = state.signers || [];

    if (!env?.id) {
      blockers.push({ ok: false, text: "No signing request selected" });
      return { ready: false, blockers };
    }
    const est = String(env.status || "").toLowerCase();
    if (est === "sent" || est === "opened" || est === "completed") {
      blockers.push({
        ok: true,
        text: `Signing request already ${ownerStatusLabel(est)}`,
      });
      return { ready: est === "sent" || est === "opened", blockers };
    }
    if (est !== "draft") {
      blockers.push({
        ok: false,
        text: `Signing request must be Draft (now ${ownerStatusLabel(est)})`,
      });
    }
    const pst = String(pkg?.status || "").toLowerCase();
    if (!pkg?.id) {
      blockers.push({ ok: false, text: "Final contract missing" });
    } else if (pst !== "ready" && pst !== "executed") {
      blockers.push({
        ok: false,
        text: `Final contract must be Ready (now ${ownerStatusLabel(pst) || "—"})`,
      });
    } else {
      blockers.push({ ok: true, text: `Final contract ${ownerStatusLabel(pst)}` });
    }
    if (!signers.length) {
      blockers.push({ ok: false, text: "At least one customer is required" });
    }
    if (isDualSigning()) {
      const owner = requiredSigner("owner");
      if (!owner) {
        blockers.push({ ok: false, text: "Contractor signer is required" });
      } else if (String(owner.status || "").toLowerCase() !== "signed") {
        blockers.push({
          ok: false,
          text: "Contractor must sign before sending to the customer",
        });
      } else {
        blockers.push({ ok: true, text: "Contractor signature received" });
      }
      const customer = requiredSigner("customer");
      if (!customer) {
        blockers.push({ ok: false, text: "Customer signer is required" });
      }
    }
    const emails = new Set();
    for (const s of signers) {
      const name = String(s.party_name || "").trim();
      const email = String(s.email || "").trim().toLowerCase();
      const order = Number(s.sign_order) || 0;
      const method = String(s.auth_method || "").toLowerCase();
      const required = s.is_required !== false;
      if (required && !name) {
        blockers.push({ ok: false, text: `Required signer missing name (${s.role})` });
      }
      if (required && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        blockers.push({ ok: false, text: `Required signer needs valid email (${name || s.role})` });
      }
      if (email) {
        if (emails.has(email)) {
          blockers.push({ ok: false, text: `Duplicate signer email: ${email}` });
        }
        emails.add(email);
      }
      if (required && method !== "email_link" && method !== "in_app") {
        blockers.push({ ok: false, text: `Unsupported auth method for ${name || s.role}` });
      }
      if (order < 1) {
        blockers.push({ ok: false, text: `Invalid sign_order for ${name || s.role}` });
      }
    }
    if (signers.length) {
      blockers.push({
        ok: true,
        text: `${signers.length} signer(s) on roster`,
      });
    }
    const hard = blockers.filter((b) => !b.ok);
    return { ready: hard.length === 0 && est === "draft", blockers };
  }

  function builderHref(project) {
    const pid = String(project?.id || "").trim();
    const qid = String(project?.quoteId || project?.quote_id || "").trim();
    if (!pid) return "/contract-builder";
    const params = new URLSearchParams({ project_id: pid });
    if (qid) params.set("quote_id", qid);
    return `/contract-builder?${params.toString()}`;
  }

  function ownerStatusLabel(raw) {
    const st = String(raw || "").toLowerCase();
    if (st === "prepared") return "Secure Link Ready";
    if (st === "executed") return "Fully Signed";
    if (st === "ready") return "Ready";
    if (st === "draft") return "Draft";
    if (st === "sent") return "Secure Link Ready";
    if (st === "opened") return "Waiting for Customer Signature";
    if (st === "completed") return "Completed";
    return raw || "—";
  }

  /**
   * CH-013B Policy A + CH-013A.2.0:
   * Prefer server-built signing_url from Delivery Channel Engine / SigningLinkBuilder.
   * Never reconstruct from hash. Never persist to browser storage.
   * UI does not build signing URLs when the engine supplied signing_url.
   */
  function captureDeliveryLink(delivery, { fromSendResponse = false } = {}) {
    state.delivery = delivery || null;
    if (!fromSendResponse) {
      return;
    }
    const signers = Array.isArray(delivery?.signers) ? delivery.signers : [];
    const withUrl = signers.find((s) => s && s.signing_url);
    if (withUrl?.signing_url) {
      state.signingLink = String(withUrl.signing_url);
      return;
    }
    // No engine URL and no client-side URL construction — Policy A / A.2.0.
    state.signingLink = null;
  }

  function isLinkReady() {
    const st = String(state.envelope?.status || "").toLowerCase();
    return st === "sent" || st === "opened" || Boolean(state.delivery?.link_ready);
  }

  function hasCopyableLink() {
    return Boolean(state.signingLink);
  }

  function primarySigner() {
    const list = Array.isArray(state.signers) ? state.signers.slice() : [];
    list.sort((a, b) => Number(a.sign_order || 0) - Number(b.sign_order || 0));
    return list[0] || null;
  }

  function customerDeliverySigner() {
    return requiredSigner("customer") || primarySigner();
  }

  function emailStatusLabel(status) {
    const st = String(status || "").toLowerCase();
    if (st === "queued" || st === "sending" || st === "accepted_db_pending") {
      return "Sending...";
    }
    if (st === "sent") return "Email sent";
    if (st === "failed" || st === "stalled") return "Email delivery needs attention";
    return "Email Signing Link";
  }

  let emailStatusPollTimer = null;
  const EMAIL_POLL_FAST_MS = 2000;
  const EMAIL_POLL_SLOW_MS = 30000;
  const EMAIL_POLL_FAST_TICKS = 40; // ~80s
  const EMAIL_POLL_SLOW_TICKS = 20; // ~10 more minutes of slow checks

  function stopEmailStatusPoll() {
    if (emailStatusPollTimer) {
      window.clearTimeout(emailStatusPollTimer);
      emailStatusPollTimer = null;
    }
  }

  function applyEmailStatusPayload(data, attemptId) {
    const ui = String(data.ui_status || "").toLowerCase();
    if (
      ui === "queued" ||
      ui === "sending" ||
      ui === "sent" ||
      ui === "failed" ||
      ui === "accepted_db_pending"
    ) {
      state.emailUiStatus = ui;
      const reported = String(data.attempt_id || attemptId || state.emailAttemptId || "");
      state.emailAttemptId =
        reported && reported === state.emailRecoveredAttemptId ? null : reported || null;
    }
    if (data.provider) {
      state.emailDelivery = {
        ...(state.emailDelivery || {}),
        provider: data.provider,
      };
    }
    state.emailStuck = data.stuck === true;
    state.emailRecoverable =
      data.recoverable === true ||
      String(data.error_code || "").toLowerCase() === "upstream_validation_failed";
    return ui;
  }

  /**
   * Delivery truth: never infer "Email sent" from queue HTTP 200.
   * Poll until sent|failed|stuck, with a bounded slow tail — never forever.
   */
  async function pollEmailDeliveryStatus(attemptId, ticksLeft, slowMode) {
    const envId = state.envelope?.id;
    const signer = customerDeliverySigner();
    if (!envId || !signer?.id) return;
    const remaining =
      typeof ticksLeft === "number"
        ? ticksLeft
        : slowMode
          ? EMAIL_POLL_SLOW_TICKS
          : EMAIL_POLL_FAST_TICKS;
    try {
      const qs =
        `status=1` +
        `&envelope_id=${encodeURIComponent(envId)}` +
        `&signer_id=${encodeURIComponent(signer.id)}` +
        (attemptId ? `&attempt_id=${encodeURIComponent(attemptId)}` : "");
      const res = await api(`${EMAIL_QUEUE_API}?${qs}`, { method: "GET" });
      if (res.ok && res.data?.ok) {
        const ui = applyEmailStatusPayload(res.data, attemptId);
        renderSend();
        if (ui === "sent" || ui === "failed") {
          stopEmailStatusPoll();
          return;
        }
        if (res.data.stuck === true) {
          state.emailStuck = true;
          stopEmailStatusPoll();
          renderSend();
          return;
        }
      }
    } catch (_e) {
      /* soft-fail; keep polling */
    }
    if (remaining <= 0) {
      if (!slowMode) {
        // Fast window exhausted — keep a bounded slow poll until server stuck or timeout.
        emailStatusPollTimer = window.setTimeout(() => {
          pollEmailDeliveryStatus(attemptId || state.emailAttemptId, EMAIL_POLL_SLOW_TICKS, true);
        }, EMAIL_POLL_SLOW_MS);
        return;
      }
      // Bounded timeout: treat as stalled so Owner can recover without infinite polling.
      state.emailStuck = true;
      stopEmailStatusPoll();
      renderSend();
      return;
    }
    emailStatusPollTimer = window.setTimeout(() => {
      pollEmailDeliveryStatus(
        attemptId || state.emailAttemptId,
        remaining - 1,
        Boolean(slowMode)
      );
    }, slowMode ? EMAIL_POLL_SLOW_MS : EMAIL_POLL_FAST_MS);
  }

  async function refreshEmailCapability() {
    const envId = state.envelope?.id;
    const signer = customerDeliverySigner();
    if (!envId || !signer?.id) {
      state.emailDelivery = null;
      return null;
    }
    try {
      const qs =
        `envelope_id=${encodeURIComponent(envId)}` +
        `&signer_id=${encodeURIComponent(signer.id)}`;
      const res = await api(`${EMAIL_QUEUE_API}?${qs}`, { method: "GET" });
      if (res.ok && res.data?.ok) {
        state.emailDelivery = res.data.email_delivery || null;
        return state.emailDelivery;
      }
    } catch (_e) {
      /* ignore */
    }
    state.emailDelivery = null;
    return null;
  }

  async function hydrateEmailDeliveryStatus() {
    const envId = state.envelope?.id;
    const signer = customerDeliverySigner();
    if (!envId || !signer?.id) return;
    try {
      const qs =
        `status=1` +
        `&envelope_id=${encodeURIComponent(envId)}` +
        `&signer_id=${encodeURIComponent(signer.id)}` +
        (state.emailAttemptId
          ? `&attempt_id=${encodeURIComponent(state.emailAttemptId)}`
          : "");
      const res = await api(`${EMAIL_QUEUE_API}?${qs}`, { method: "GET" });
      if (res.ok && res.data?.ok && res.data.ui_status) {
        const ui = applyEmailStatusPayload(res.data, state.emailAttemptId);
        if (ui === "queued" || ui === "sending" || ui === "accepted_db_pending") {
          if (res.data.stuck === true) {
            state.emailStuck = true;
            stopEmailStatusPoll();
          } else {
            pollEmailDeliveryStatus(state.emailAttemptId, EMAIL_POLL_FAST_TICKS, false);
          }
        }
      }
    } catch (_e) {
      /* soft-fail */
    }
  }

  function setBlockedReason(id, text) {
    const el = $(id);
    if (!el) return;
    if (!text) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = text;
  }

  function resolveWorkspaceGuidance() {
    const pkg = state.package;
    const env = state.envelope;
    const envSt = String(env?.status || "").toLowerCase();
    const signers = state.signers || [];
    const cert = state.certificates[0];
    const art = state.artifacts[0];
    const send = computeSendReadiness();

    if (!pkg?.id) {
      return {
        title: "Contract setup is not complete.",
        body: "Complete and freeze the contract before adding signers.",
        ctaLabel: "Open Contract Builder",
        ctaHref: builderHref(state.project),
        ctaAction: null,
      };
    }
    if (!env?.id) {
      return {
        title: "Create a Signing Request",
        body: "A frozen contract version is ready. Create a signing request to add the customer signer.",
        ctaLabel: "Create Signing Request",
        ctaHref: null,
        ctaAction: "create-envelope",
      };
    }
    if (envSt === "draft" && !signers.length) {
      if (isDualSigning()) {
        return {
          title: "Confirm Contractor",
          body: "Confirm the contractor from Legal Profile, then sign as contractor before adding the customer.",
          ctaLabel: "Confirm Contractor",
          ctaHref: null,
          ctaAction: "confirm-contractor",
        };
      }
      return {
        title: "Add Customer Signer",
        body: "Add the customer as a signer before sending the secure signing link.",
        ctaLabel: "Add Customer Signer",
        ctaHref: null,
        ctaAction: "add-signer",
      };
    }
    if (envSt === "draft" && isDualSigning()) {
      const owner = requiredSigner("owner");
      if (!owner) {
        return {
          title: "Confirm Contractor",
          body: "Confirm the contractor from Legal Profile. This does not create a signature.",
          ctaLabel: "Confirm Contractor",
          ctaHref: null,
          ctaAction: "confirm-contractor",
        };
      }
      if (String(owner.status || "").toLowerCase() !== "signed") {
        return {
          title: "Sign as Contractor",
          body: "Sign explicitly as contractor. Legal Profile name is identity only — it is not a signature.",
          ctaLabel: "Sign as Contractor",
          ctaHref: null,
          ctaAction: "sign-contractor",
        };
      }
      const customer = requiredSigner("customer");
      if (!customer) {
        return {
          title: "Add Customer Signer",
          body: "Contractor signed. Add the customer, then send the secure signing link.",
          ctaLabel: "Add Customer Signer",
          ctaHref: null,
          ctaAction: "add-signer",
        };
      }
    }
    if (envSt === "draft" && send.ready) {
      return {
        title: sendCtaLabel(),
        body: isDualSigning()
          ? "Contractor signed. Create a secure signing link for the customer."
          : "Create a secure signing link for the customer. The secure link will be generated for you to copy and send.",
        ctaLabel: sendCtaLabel(),
        ctaHref: null,
        ctaAction: "send",
      };
    }
    if (envSt === "sent") {
      const canCopy = hasCopyableLink();
      const emailMsg = mgSwResolveSigningEmailMessage(state.emailUiStatus, {
        canCopy,
      });
      const sent = mgSwIsEmailAlreadySent(state.emailUiStatus);
      const failed = mgSwIsEmailDeliveryFailed(state.emailUiStatus);
      return {
        title: sent
          ? "Signing Email Sent"
          : failed
            ? "Email Delivery Needs Attention"
            : "Secure Link Ready",
        body: emailMsg,
        ctaLabel: canCopy ? "Copy Signing Link" : null,
        ctaHref: null,
        ctaAction: canCopy ? "copy-link" : null,
      };
    }
    if (envSt === "opened") {
      return {
        title: "Waiting for Customer Signature",
        body: "The customer opened the secure signing link. Monitor progress below until signing is complete.",
        ctaLabel: null,
        ctaHref: null,
        ctaAction: null,
      };
    }
    if (envSt === "completed") {
      return {
        title: "Signing complete",
        body: !cert?.id
          ? "Generate the audit certificate, then generate the signed PDF."
          : !art?.id
            ? "Generate the signed PDF for this completed signing request."
            : "Certificate and signed PDF are ready.",
        ctaLabel: !cert?.id
          ? "Generate Certificate"
          : !art?.id
            ? "Generate Signed PDF"
            : null,
        ctaHref: null,
        ctaAction: !cert?.id ? "cert" : !art?.id ? "pdf" : null,
      };
    }
    return {
      title: "Continue signing setup",
      body: "Review the sections below and complete the next required action.",
      ctaLabel: null,
      ctaHref: null,
      ctaAction: null,
    };
  }

  function renderGuidance() {
    const g = resolveWorkspaceGuidance();
    setText("swGuideTitle", g.title);
    setText("swGuideBody", g.body);
    const actions = $("swGuideActions");
    if (!actions) return;
    actions.innerHTML = "";
    if (g.ctaHref) {
      const a = document.createElement("a");
      a.className = "btn primary";
      a.href = g.ctaHref;
      a.textContent = g.ctaLabel || "Continue";
      actions.appendChild(a);
      return;
    }
    if (g.ctaAction && g.ctaLabel) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn primary";
      b.textContent = g.ctaLabel;
      b.addEventListener("click", () => {
        if (g.ctaAction === "create-envelope") $("swCreateEnvelopeBtn")?.click();
        if (g.ctaAction === "add-signer") $("swAddSignerBtn")?.click();
        if (g.ctaAction === "confirm-contractor") openConfirmContractorModal();
        if (g.ctaAction === "sign-contractor") openSignContractorModal();
        if (g.ctaAction === "send") $("swSendBtn")?.click();
        if (g.ctaAction === "copy-link") $("swCopyLinkBtn")?.click();
        if (g.ctaAction === "cert") $("swIssueCertBtn")?.click();
        if (g.ctaAction === "pdf") $("swGeneratePdfBtn")?.click();
      });
      actions.appendChild(b);
    }
  }

  function progressLabel() {
    const signers = state.signers || [];
    if (!signers.length) return "—";
    const signed = signers.filter(
      (s) => String(s.status || "").toLowerCase() === "signed"
    ).length;
    return `${signed}/${signers.length} signed`;
  }

  function renderHeader() {
    const p = state.project || {};
    setText(
      "swHProject",
      String(p.projectName || p.project_name || "").trim() || "—"
    );
    setText(
      "swHCustomer",
      String(p.clientName || p.client_name || "").trim() || "—"
    );
    setText(
      "swHPackage",
      state.package?.version != null ? `v${state.package.version}` : "—"
    );
    setText("swHEnvelope", ownerStatusLabel(state.envelope?.status));
    setText("swHProgress", progressLabel());
    const cert = state.certificates[0];
    setText("swHCert", cert?.certificate_number || "None");
    const art = state.artifacts[0];
    setText("swHPdf", art?.id ? "Ready" : "None");
  }

  function renderPackage() {
    const pkg = state.package;
    setText("swPkgVersion", pkg?.version != null ? `v${pkg.version}` : "—");
    setText("swPkgStatus", ownerStatusLabel(pkg?.status));
    const frozen =
      pkg &&
      (String(pkg.status).toLowerCase() === "ready" ||
        String(pkg.status).toLowerCase() === "executed" ||
        String(pkg.status).toLowerCase() === "superseded");
    setText("swPkgFrozen", frozen ? "Yes" : "No");
    setText("swPkgCreated", fmtWhen(pkg?.created_at));
    setText(
      "swPkgExecuted",
      String(pkg?.status || "").toLowerCase() === "executed"
        ? fmtWhen(pkg?.updated_at)
        : "—"
    );
    setText("swPkgHash", shortHash(pkg?.content_hash));

    const sel = $("swPackageSelect");
    if (sel) {
      const cur = pkg?.id || "";
      sel.innerHTML = (state.packages || [])
        .map((row) => {
          const selected = row.id === cur ? " selected" : "";
          return `<option value="${escapeHtml(row.id)}"${selected}>v${escapeHtml(row.version)} — ${escapeHtml(ownerStatusLabel(row.status))}</option>`;
        })
        .join("");
      if (!state.packages.length) {
        sel.innerHTML = `<option value="">No final contract versions</option>`;
      }
    }
  }

  function renderEnvelope() {
    const env = state.envelope;
    const status = String(env?.status || "").toLowerCase();
    const pills = $("swEnvPills");
    if (pills) {
      pills.innerHTML = ENV_STATUSES.map((s) => {
        let cls = "sw-pill";
        if (s === status) cls += " is-active";
        if (
          ["draft", "sent", "opened", "completed"].indexOf(s) >= 0 &&
          ["draft", "sent", "opened", "completed"].indexOf(status) >
            ["draft", "sent", "opened", "completed"].indexOf(s)
        ) {
          cls += " is-done";
        }
        if (status === "completed" && s === "completed") cls += " is-done";
        return `<span class="${cls}">${escapeHtml(ownerStatusLabel(s))}</span>`;
      }).join("");
    }
    setText("swEnvStatus", ownerStatusLabel(env?.status));
    setText("swEnvCompleted", fmtWhen(env?.completed_at));
    setText("swEnvSent", fmtWhen(env?.sent_at));

    const sel = $("swEnvelopeSelect");
    if (sel) {
      const cur = env?.id || "";
      sel.innerHTML = (state.envelopes || [])
        .map((row) => {
          const selected = row.id === cur ? " selected" : "";
          const label = `${ownerStatusLabel(row.status)} — request ${String(row.id).slice(0, 8)}…`;
          return `<option value="${escapeHtml(row.id)}"${selected}>${escapeHtml(label)}</option>`;
        })
        .join("");
      if (!state.envelopes.length) {
        sel.innerHTML = `<option value="">No signing requests</option>`;
      }
    }
    const createBtn = $("swCreateEnvelopeBtn");
    const noPackage = !state.package?.id;
    const pkgOk =
      state.package?.id &&
      ["ready", "executed"].includes(String(state.package.status || "").toLowerCase());
    if (createBtn) {
      createBtn.disabled = noPackage || !pkgOk;
      createBtn.textContent = "Create Signing Request";
    }
    if (noPackage) {
      setBlockedReason(
        "swCreateEnvelopeReason",
        "Blocked: freeze the contract in Contract Builder first."
      );
    } else if (!pkgOk) {
      setBlockedReason(
        "swCreateEnvelopeReason",
        "Blocked: frozen contract version is not ready."
      );
    } else {
      setBlockedReason("swCreateEnvelopeReason", "");
    }
  }

  function renderSigners() {
    const body = $("swSignersBody");
    const empty = $("swSignersEmpty");
    const addBtn = $("swAddSignerBtn");
    const confirmBtn = $("swConfirmContractorBtn");
    const signBtn = $("swSignContractorBtn");
    const editable = envelopeEditable();
    const noPackage = !state.package?.id;
    const noEnvelope = !state.envelope?.id;
    const dual = isDualSigning();
    const owner = requiredSigner("owner");
    const ownerSigned =
      owner && String(owner.status || "").toLowerCase() === "signed";
    if (addBtn) {
      addBtn.disabled = noPackage || noEnvelope || !editable;
      addBtn.textContent = "Add Customer Signer";
    }
    if (confirmBtn) {
      confirmBtn.hidden = !dual;
      confirmBtn.disabled = noPackage || noEnvelope || !editable;
    }
    if (signBtn) {
      signBtn.hidden = !dual;
      signBtn.disabled =
        noPackage || noEnvelope || !editable || !owner || ownerSigned;
    }
    if (noPackage) {
      setBlockedReason(
        "swAddSignerReason",
        "Blocked: complete and freeze the contract first."
      );
    } else if (noEnvelope) {
      setBlockedReason(
        "swAddSignerReason",
        "Blocked: create a signing request first."
      );
    } else if (!editable) {
      setBlockedReason(
        "swAddSignerReason",
        "Blocked: signers are locked after send."
      );
    } else {
      setBlockedReason("swAddSignerReason", "");
    }

    if (!state.signers.length) {
      if (body) body.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    if (!body) return;
    body.innerHTML = state.signers
      .map((s) => {
        const actions = editable
          ? `<div class="sw-row-actions">
              <button type="button" class="btn ghost" data-sw-edit="${escapeHtml(s.id)}">Edit</button>
              <button type="button" class="btn ghost" data-sw-del="${escapeHtml(s.id)}">Delete</button>
            </div>`
          : `<span class="sw-field__k">Locked</span>`;
        return `<tr>
          <td>${escapeHtml(s.role)}</td>
          <td>${escapeHtml(s.party_name)}</td>
          <td>${escapeHtml(s.email)}</td>
          <td>${escapeHtml(s.sign_order)}</td>
          <td>${escapeHtml(s.auth_method)}</td>
          <td>${escapeHtml(ownerStatusLabel(s.status))}</td>
          <td>${escapeHtml(fmtWhen(s.signed_at))}</td>
          <td>${actions}</td>
        </tr>`;
      })
      .join("");
  }

  function renderSend() {
    const { ready, blockers } = computeSendReadiness();
    setText("swSendReady", ready ? "Yes" : "No");
    const list = $("swSendBlockers");
    if (list) {
      list.innerHTML = blockers
        .map(
          (b) =>
            `<li class="${b.ok ? "is-ok" : ""}">${escapeHtml(b.text)}</li>`
        )
        .join("");
    }
    const sendBtn = $("swSendBtn");
    const linkReadyEl = $("swLinkReady");
    const copyBtn = $("swCopyLinkBtn");
    const emailBtn = $("swEmailLinkBtn");
    const emailRetryBtn = $("swEmailRetryBtn");
    const emailStatusWrap = $("swEmailStatusWrap");
    const emailStatus = $("swEmailStatus");
    const copyWrap = copyBtn?.parentElement;
    const linkCopy = $("swLinkReadyCopy");
    const noPackage = !state.package?.id;
    const st = String(state.envelope?.status || "").toLowerCase();
    const linkReady = isLinkReady();
    const canCopy = hasCopyableLink();
    const signer = customerDeliverySigner();
    const cap = state.emailDelivery;
    const inFlight =
      state.emailUiStatus === "queued" ||
      state.emailUiStatus === "sending" ||
      state.emailUiStatus === "accepted_db_pending";
    // Retry abandons a stalled in-flight attempt. After recover (failed + recoverable),
    // show Email Signing Link again for the fresh Gen N+1 click.
    const showRetry =
      linkReady && Boolean(state.emailAttemptId) && inFlight && state.emailStuck;
    const emailEnabled =
      linkReady &&
      Boolean(signer?.id) &&
      Boolean(signer?.email) &&
      cap &&
      cap.enabled === true &&
      cap.recipient_allowed === true &&
      !state.emailBusy &&
      !showRetry &&
      !(inFlight && !state.emailStuck);
    if (linkReadyEl) {
      linkReadyEl.hidden = !linkReady;
    }
    if (linkCopy) {
      if (!canCopy && !mgSwIsEmailAlreadySent(state.emailUiStatus) && !mgSwIsEmailDeliveryFailed(state.emailUiStatus)) {
        linkCopy.textContent =
          "The secure link was generated previously.";
      } else {
        linkCopy.textContent = mgSwResolveSigningEmailMessage(
          state.emailUiStatus,
          { canCopy }
        );
      }
    }
    if (copyBtn) {
      copyBtn.hidden = !canCopy;
      copyBtn.disabled = !canCopy;
    }
    if (emailBtn) {
      emailBtn.hidden = !linkReady || showRetry;
      emailBtn.disabled = !emailEnabled;
      emailBtn.textContent = emailStatusLabel(
        showRetry ? "ready" : state.emailUiStatus || "ready"
      );
      if (!showRetry && (!state.emailUiStatus || state.emailUiStatus === "ready" || state.emailUiStatus === "failed")) {
        emailBtn.textContent = "Email Signing Link";
      }
    }
    if (emailRetryBtn) {
      emailRetryBtn.hidden = !showRetry;
      emailRetryBtn.disabled = !showRetry || state.emailBusy;
      emailRetryBtn.textContent = "Retry Sending Email";
    }
    if (emailStatusWrap) {
      emailStatusWrap.hidden = !linkReady || !state.emailUiStatus;
    }
    if (emailStatus && state.emailUiStatus) {
      emailStatus.textContent = emailStatusLabel(state.emailUiStatus);
    }
    if (copyWrap && copyWrap.classList.contains("sw-actions")) {
      copyWrap.hidden = !linkReady;
    }
    if (sendBtn) {
      if (linkReady && st !== "completed") {
        sendBtn.hidden = true;
      } else {
        sendBtn.hidden = false;
        sendBtn.disabled =
          noPackage || !state.envelope?.id || (!ready && st === "draft");
        sendBtn.textContent = sendCtaLabel();
      }
    }
    if (noPackage) {
      setBlockedReason(
        "swSendReason",
        "Blocked: freeze the contract before sending."
      );
    } else if (!state.envelope?.id) {
      setBlockedReason(
        "swSendReason",
        "Blocked: create a signing request and add a signer first."
      );
    } else if (!ready && st === "draft") {
      setBlockedReason("swSendReason", "Blocked: fix the items listed above.");
    } else {
      setBlockedReason("swSendReason", "");
    }
    // Keep presentation shell in sync when only send/email status re-renders.
    if (typeof renderVisualWorkflow === "function" && $("swVisWorkflow")) {
      renderVisualWorkflow();
    }
  }

  function renderTimeline() {
    const list = $("swTimeline");
    const empty = $("swTimelineEmpty");
    if (!state.signers.length) {
      if (list) list.innerHTML = "";
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;
    if (!list) return;
    const envSt = String(state.envelope?.status || "").toLowerCase();
    list.innerHTML = state.signers
      .slice()
      .sort((a, b) => (Number(a.sign_order) || 0) - (Number(b.sign_order) || 0))
      .map((s, idx) => {
        const st = String(s.status || "").toLowerCase();
        const signed = st === "signed";
        const opened =
          !signed && (envSt === "opened" || envSt === "sent" || envSt === "completed");
        const pending = !signed;
        let liClass = "is-pending";
        if (signed) liClass = "is-signed";
        else if (opened) liClass = "is-opened";
        const step = (label, on, done) => {
          let cls = "sw-step";
          if (done) cls += " is-done";
          else if (on) cls += " is-on";
          return `<span class="${cls}">${escapeHtml(label)}</span>`;
        };
        return `<li class="${liClass}">
          <strong>Signer ${idx + 1}</strong> — ${escapeHtml(s.party_name || "—")} (${escapeHtml(s.role || "—")})
          <div class="sw-steps">
            ${step("Pending", pending && !opened, false)}
            ${step("Opened", opened && !signed, opened || signed)}
            ${step("Signed", signed, signed)}
          </div>
          <div class="sw-field__k" style="margin-top:4px;">${escapeHtml(fmtWhen(s.signed_at))}</div>
        </li>`;
      })
      .join("");
  }

  function formatCertificateStatus(status) {
    const s = String(status || "").trim();
    if (!s) return "—";
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  function toTenantCertificate(row) {
    if (!row || typeof row !== "object") return null;
    return {
      id: row.id || "",
      certificate_number: row.certificate_number || "",
      issued_at: row.issued_at || null,
      status: row.status || "",
    };
  }

  function renderCertificate() {
    const cert = state.certificates[0];
    const completed =
      String(state.envelope?.status || "").toLowerCase() === "completed";
    setText("swCertNumber", cert?.certificate_number || "—");
    setText("swCertIssued", fmtWhen(cert?.issued_at));
    setText("swCertStatus", formatCertificateStatus(cert?.status));
    const issueBtn = $("swIssueCertBtn");
    const viewBtn = $("swViewCertBtn");
    if (issueBtn) {
      issueBtn.disabled = !completed || !state.envelope?.id;
      issueBtn.textContent = cert?.id ? "Refresh Certificate" : "Create Certificate";
    }
    if (viewBtn) viewBtn.disabled = !cert?.id;
  }

  function renderPdf() {
    const art = state.artifacts[0];
    const completed =
      String(state.envelope?.status || "").toLowerCase() === "completed";
    setText("swPdfStatus", art?.id ? "Ready" : "None");
    setText("swPdfHash", shortHash(art?.sha256));
    setText(
      "swPdfSize",
      art?.file_size != null ? `${art.file_size} bytes` : "—"
    );
    const gen = $("swGeneratePdfBtn");
    const openBtn = $("swOpenPdfBtn");
    const dl = $("swDownloadPdfBtn");
    if (gen) {
      gen.disabled = !completed || !state.envelope?.id;
      gen.textContent = art?.id
        ? "Signed PDF Ready"
        : "Create Signed PDF";
    }
    if (openBtn) {
      openBtn.disabled = !art?.download_url;
      openBtn.textContent = "View Signed Contract";
    }
    if (dl) {
      if (art?.download_url) {
        dl.href = art.download_url;
        dl.removeAttribute("aria-disabled");
        dl.style.pointerEvents = "";
        dl.style.opacity = "";
      } else {
        dl.href = "#";
        dl.setAttribute("aria-disabled", "true");
        dl.style.pointerEvents = "none";
        dl.style.opacity = "0.5";
      }
    }
  }

  function renderDev() {
    /* Tenant Contract Workflow must not render package/signer/envelope IDs. */
  }

  /**
   * CH-013A.31 — presentation-only step mapping from existing workspace state.
   * Does not invent backend states or change handlers.
   */
  function computeVisualStep() {
    const envSt = String(state.envelope?.status || "").toLowerCase();
    const cert = state.certificates[0];
    const art = state.artifacts[0];
    const emailUi = String(state.emailUiStatus || "").toLowerCase();
    const completed = envSt === "completed";
    const emailInFlight = mgSwIsEmailDeliveryInFlight(emailUi);
    const emailSent = mgSwIsEmailAlreadySent(emailUi);
    const emailFailed = mgSwIsEmailDeliveryFailed(emailUi);

    if (completed && cert?.id && art?.id) return 6;
    if (completed && cert?.id) return 5;
    if (completed) return 4;
    if (emailFailed) return 2;
    if (emailSent || emailInFlight) return 3;
    if (envSt === "opened") return 3;
    if (isLinkReady()) return 2;
    if (isDualSigning() && isContractorSigned()) return 2;
    if (!isDualSigning() && state.envelope?.id) return 2;
    return 1;
  }

  function setProgRow(id, mode, labelComplete, labelWaiting, labelCurrent) {
    const li = $(id);
    if (!li) return;
    li.classList.remove("is-complete", "is-current", "is-waiting");
    const mark = li.querySelector(".sw-vis-mark");
    const text = li.querySelector("span:last-child");
    if (mode === "complete") {
      li.classList.add("is-complete");
      if (mark) mark.textContent = "✓";
      if (text) text.textContent = labelComplete;
    } else if (mode === "current") {
      li.classList.add("is-current");
      if (mark) mark.textContent = "●";
      if (text) text.textContent = labelCurrent;
    } else {
      li.classList.add("is-waiting");
      if (mark) mark.textContent = "○";
      if (text) text.textContent = labelWaiting;
    }
  }

  function syncVisAction(visId, sourceId, opts = {}) {
    const vis = $(visId);
    const src = $(sourceId);
    if (!vis || !src) return;
    const forceHidden = opts.forceHidden === true;
    const label = opts.label;
    if (forceHidden) {
      vis.hidden = true;
      return;
    }
    vis.hidden = Boolean(src.hidden);
    if ("disabled" in vis) {
      vis.disabled = Boolean(src.disabled) || Boolean(opts.forceDisabled);
    }
    if (label && "textContent" in vis && vis.tagName === "BUTTON") {
      vis.textContent = label;
    }
    if (vis.tagName === "A" && src.tagName === "A") {
      vis.href = src.getAttribute("href") || "#";
      if (src.getAttribute("aria-disabled") === "true") {
        vis.setAttribute("aria-disabled", "true");
        vis.style.pointerEvents = "none";
        vis.style.opacity = "0.5";
      } else {
        vis.removeAttribute("aria-disabled");
        vis.style.pointerEvents = "";
        vis.style.opacity = "";
      }
    }
  }

  let visualPanelTransitionGen = 0;

  function prefersReducedMotion() {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
  }

  function setVisualPanels(step) {
    const gen = (visualPanelTransitionGen += 1);
    const reduceMotion = prefersReducedMotion();
    document.querySelectorAll("[data-sw-panel]").forEach((panel) => {
      const n = Number(panel.getAttribute("data-sw-panel"));
      const shouldShow = n === step;
      if (shouldShow) {
        panel.classList.remove("sw-vis-step--exit");
        if (panel.hidden) {
          panel.hidden = false;
          if (!reduceMotion) {
            panel.classList.remove("sw-vis-step--enter");
            // Force reflow so enter animation restarts on each reveal.
            void panel.offsetWidth;
            panel.classList.add("sw-vis-step--enter");
          }
        }
        return;
      }
      if (panel.hidden) {
        panel.classList.remove("sw-vis-step--enter", "sw-vis-step--exit");
        return;
      }
      if (reduceMotion) {
        panel.hidden = true;
        panel.classList.remove("sw-vis-step--enter", "sw-vis-step--exit");
        return;
      }
      panel.classList.remove("sw-vis-step--enter");
      panel.classList.add("sw-vis-step--exit");
      window.setTimeout(() => {
        if (gen !== visualPanelTransitionGen) return;
        if (Number(panel.getAttribute("data-sw-panel")) === state.visualStep) return;
        panel.hidden = true;
        panel.classList.remove("sw-vis-step--exit");
      }, 200);
    });
  }

  function renderVisualWorkflow() {
    const active = computeVisualStep();
    if (state.visualStepOverride != null && state.visualStepOverride > active) {
      state.visualStepOverride = null;
    }
    const step =
      state.visualStepOverride != null && state.visualStepOverride <= active
        ? state.visualStepOverride
        : active;
    state.visualStep = step;
    const envSt = String(state.envelope?.status || "").toLowerCase();
    const cert = state.certificates[0];
    const art = state.artifacts[0];
    const signer = customerDeliverySigner();
    const customer =
      String(
        state.project?.clientName ||
          state.project?.client_name ||
          signer?.party_name ||
          ""
      ).trim() || "—";
    const version =
      state.package?.version != null ? `v${state.package.version}` : "—";

    const stepLabels = [
      "",
      "Review & Sign",
      "Confirm Customer",
      mgSwIsEmailDeliveryInFlight(state.emailUiStatus)
        ? "Sending to Customer"
        : "Wait for Customer",
      "Legal Certificate",
      "Signed Documents",
      "Complete",
    ];
    setText(
      "swVisProjectName",
      String(state.project?.projectName || state.project?.project_name || "").trim() ||
        "Contract Workflow"
    );
    setText("swVisProjectSub", "Manage your contract from start to finish.");
    setText("swVisCustomer", customer);
    setText("swVisContractVer", version);
    setText("swVisCurrentStep", stepLabels[active] || "—");
    setText("swVisProgressText", `Step ${active} of 6`);
    setText("swVisJourneyLead", `Step ${active} of 6`);
    const progressBar = $("swVisProgressBar");
    if (progressBar) {
      progressBar.style.width = `${Math.round((active / 6) * 100)}%`;
    }
    setText(
      "swVisOverall",
      active === 6
        ? "Contract Signing Complete"
        : active === 5
          ? art?.id
            ? "Download Signed Contract"
            : "Preparing signed documents"
          : active === 4
            ? "Preparing legal certificate"
            : active === 3
              ? mgSwIsEmailDeliveryInFlight(state.emailUiStatus)
                ? "Sending to Customer"
                : "Waiting for Customer Signature"
              : active === 2
                ? "Confirm Customer & Send"
                : "Review & Sign"
    );

    const railItems = document.querySelectorAll("#swVisRail [data-sw-step]");
    railItems.forEach((item) => {
      const n = Number(item.getAttribute("data-sw-step"));
      item.classList.remove("is-current", "is-complete", "is-upcoming", "is-locked");
      const statusEl = item.querySelector("[data-sw-rail-status]");
      const mark = item.querySelector(".premium-workflow__mark");
      const btn = item.querySelector(".premium-workflow__arrow");
      if (n < active) {
        item.classList.add("is-complete");
        if (n === step) item.classList.add("is-current");
        if (statusEl) statusEl.textContent = n === step ? "Current" : "Complete";
        if (mark) mark.textContent = "✓";
        if (btn) btn.classList.remove("is-locked");
      } else if (n === active) {
        item.classList.add("is-current");
        if (statusEl) statusEl.textContent = "Current";
        if (mark) mark.textContent = active === 6 ? "✓" : "→";
        if (btn) btn.classList.remove("is-locked");
      } else {
        item.classList.add("is-upcoming", "is-locked");
        if (statusEl) statusEl.textContent = "Locked";
        if (mark) mark.textContent = "";
        if (btn) btn.classList.add("is-locked");
      }
    });

    // One active panel (presentation transitions): panel.hidden = i !== step
    setVisualPanels(step);
    // CH-013A.48 — one active workspace: close Step 1 review surfaces when leaving Step 1
    syncReviewSurfacesWithVisualStep(step);

    // Step 1
    setText("swVis1Customer", customer);
    setText("swVis1Version", version);
    setText("swVis1Created", fmtWhen(state.package?.created_at));
    if (isDualSigning()) {
      setText("swVis1Title", "Review & Sign");
      setText(
        "swVis1Now",
        "Start here. Review the contract, then sign as the contractor."
      );
      setText(
        "swVis1Lead",
        "Confirm the final contract looks right before your customer sees it."
      );
      setText(
        "swVis1Next",
        "Next: confirm the customer and send the signing link."
      );
      const cta1 = $("swVisContinueBtn");
      if (cta1) cta1.textContent = "Review & Sign Contract";
    } else {
      setText("swVis1Title", "Review Contract");
      setText(
        "swVis1Now",
        "Start here. Review the contract, then confirm the customer and send the signing link."
      );
      setText(
        "swVis1Lead",
        "Confirm the final contract looks right before your customer sees it."
      );
      setText(
        "swVis1Next",
        "Next: confirm the customer and send the signing link."
      );
      const cta1 = $("swVisContinueBtn");
      if (cta1) cta1.textContent = "Review Contract";
    }

    // Step 2
    setText("swVis2Customer", customer);
    setText("swVis2Email", signer?.email || "—");
    setText(
      "swVis2Expires",
      fmtWhen(state.envelope?.expires_at || state.package?.expires_at)
    );
    const AUTO_DOCS_COPY =
      "Final documents are prepared automatically when Contract Workflow is open.";
    const deliveryCopy = mgSwGuidedDeliveryCopy(state.emailUiStatus, {
      email: guidedCustomerEmail(),
    });

    const sendVis = $("swVisSendContractBtn");
    const retryPrimary = $("swVisRetryPrimaryBtn");
    const emailUiEarly = String(state.emailUiStatus || "").toLowerCase();
    const emailAlreadySent = mgSwIsEmailAlreadySent(emailUiEarly);
    const emailFailed = mgSwIsEmailDeliveryFailed(emailUiEarly);
    const emailInFlight = mgSwIsEmailDeliveryInFlight(emailUiEarly);
    if (sendVis) {
      sendVis.hidden = emailAlreadySent || emailFailed || emailInFlight;
      sendVis.disabled = Boolean(state.emailBusy);
      sendVis.textContent = "Confirm Customer & Send";
    }
    if (retryPrimary) {
      retryPrimary.hidden = !emailFailed;
      retryPrimary.disabled = Boolean(state.emailBusy) || !emailFailed;
      retryPrimary.textContent = "Retry Sending Email";
    }
    syncVisAction("swVisCopyLinkBtn", "swCopyLinkBtn");
    const retryGhost = $("swVisRetryEmailBtn");
    if (retryGhost) retryGhost.hidden = true;
    const emailStatusWrap = $("swVisEmailStatusWrap");
    const emailStatus = $("swVisEmailStatus");
    if (emailStatusWrap) {
      emailStatusWrap.hidden = deliveryCopy.panel === "ready";
    }
    if (emailStatus) {
      emailStatus.textContent = deliveryCopy.lead || "—";
    }
    const helper2 = $("swVis2Helper");
    if (helper2) helper2.hidden = !emailAlreadySent;
    setText("swVis2Title", deliveryCopy.visualStep === 2 ? deliveryCopy.title : "Confirm Customer & Send");
    setText("swVis2Now", deliveryCopy.panel === "failed" ? deliveryCopy.now : "Confirm the customer’s name and email, then send the signing link.");
    setText("swVis2Lead", deliveryCopy.lead);
    setText("swVis2Why", deliveryCopy.why);

    // Step 3 progress
    const emailDone = deliveryCopy.emailProgress === "complete";
    const emailCurrent = deliveryCopy.emailProgress === "current";
    const opened = envSt === "opened" || envSt === "completed";
    const signed = envSt === "completed";
    setText("swVis3Title", deliveryCopy.visualStep === 3 ? deliveryCopy.title : "Wait for Customer");
    setText("swVis3Now", deliveryCopy.now);
    if (deliveryCopy.panel === "sending") {
      setText("swVis3Lead", deliveryCopy.lead);
      setText("swVis3Why", deliveryCopy.why);
    } else if (signed) {
      setText("swVis3Lead", AUTO_DOCS_COPY);
      setText("swVis3Why", AUTO_DOCS_COPY);
    } else if (opened) {
      setText(
        "swVis3Lead",
        "Your customer opened the contract. Wait for them to finish signing."
      );
      setText("swVis3Why", deliveryCopy.why);
    } else {
      setText("swVis3Lead", deliveryCopy.lead);
      setText("swVis3Why", deliveryCopy.why);
    }
    syncVisAction("swVis3CopyLinkBtn", "swCopyLinkBtn");
    setProgRow(
      "swVisProgEmail",
      emailDone ? "complete" : emailCurrent ? "current" : "waiting",
      "Email sent",
      "Send the contract email",
      "Sending email"
    );
    setProgRow(
      "swVisProgOpened",
      opened ? "complete" : emailDone ? "current" : "waiting",
      "Contract opened",
      "Waiting for customer to open",
      "Waiting for customer to open"
    );
    setProgRow(
      "swVisProgSigned",
      signed ? "complete" : opened ? "current" : "waiting",
      "Customer signed",
      "Waiting for customer signature",
      "Waiting for customer signature"
    );

    // Step 4 certificate
    const certReady = Boolean(cert?.id);
    const autoDocsState = autoDocsSession ? autoDocsSession.getState() : { hold: false, attempts: 0 };
    const showCertFallback = !certReady && (state.autoDocsHold || autoDocsState.hold || autoDocsState.attempts >= 3);
    setText("swVis4Title", "Legal Certificate");
    setText(
      "swVis4Now",
      certReady ? "Your legal certificate is ready." : AUTO_DOCS_COPY
    );
    setText(
      "swVis4Lead",
      certReady
        ? "View or download the certificate for your records."
        : "Keep this page open. You do not need to create a certificate."
    );
    setText("swVis4Why", AUTO_DOCS_COPY);
    syncVisAction("swVisIssueCertBtn", "swIssueCertBtn", {
      forceHidden: !showCertFallback,
      label: "Create Certificate",
    });
    syncVisAction("swVisViewCertBtn", "swViewCertBtn", {
      forceDisabled: !certReady,
      label: "View Certificate",
    });
    const dlCert = $("swVisDownloadCertBtn");
    if (dlCert) {
      dlCert.disabled = !certReady;
      dlCert.hidden = false;
    }

    // Step 5 signed PDF
    const pdfReady = Boolean(art?.id);
    const showPdfFallback = !pdfReady && (state.autoDocsHold || autoDocsState.hold || autoDocsState.attempts >= 3);
    setText("swVis5Title", "Signed Documents");
    setText(
      "swVis5Now",
      pdfReady ? "Your signed documents are ready." : AUTO_DOCS_COPY
    );
    setText(
      "swVis5Lead",
      pdfReady
        ? "View or download the signed contract."
        : "Keep this page open. You do not need to create a PDF."
    );
    setText("swVis5Why", "Next: Contract Signing Complete.");
    syncVisAction("swVisGeneratePdfBtn", "swGeneratePdfBtn", {
      forceHidden: !showPdfFallback,
      label: "Create Signed PDF",
    });
    syncVisAction("swVisOpenPdfBtn", "swOpenPdfBtn", {
      forceDisabled: !pdfReady,
      label: "View Signed Contract",
    });
    syncVisAction("swVisDownloadPdfBtn", "swDownloadPdfBtn");

    // Step 6 complete
    const ret = $("swVisReturnProjectBtn");
    if (ret && state.project?.id) {
      ret.href = `/contract-hub?project_id=${encodeURIComponent(state.project.id)}`;
    } else if (ret) {
      ret.href = "/contract-hub";
    }
    syncVisAction("swVisCompleteViewPdfBtn", "swOpenPdfBtn", {
      forceDisabled: !pdfReady,
      label: "View Signed Contract",
    });
    syncVisAction("swVisCompletePdfBtn", "swDownloadPdfBtn");
    const completeCert = $("swVisCompleteCertBtn");
    if (completeCert) completeCert.disabled = !certReady;
    setText("swVis6Title", "Contract Signing Complete");
    const completeWhy = $("swVis6Why");
    if (completeWhy) {
      completeWhy.textContent = isDualSigning()
        ? "Contractor and customer signatures were received and the final documents are ready."
        : "The customer signed the contract and your final documents are ready.";
    }
    const list = $("swVisCompleteList");
    if (list) {
      const items = [];
      const owner = requiredSigner("owner");
      const customer = requiredSigner("customer");
      if (owner && String(owner.status || "").toLowerCase() === "signed") {
        items.push(
          `✓ Contractor signature received (${owner.party_name || "contractor"})`
        );
      }
      if (customer && String(customer.status || "").toLowerCase() === "signed") {
        items.push(
          `✓ Customer signature received (${customer.party_name || "customer"})`
        );
      } else if (!isDualSigning()) {
        items.push("✓ Customer signature received");
      }
      items.push("✓ Legal certificate created");
      items.push("✓ Signed contract created");
      list.innerHTML = items
        .map((text) => `<li>${escapeHtml(text)}</li>`)
        .join("");
    }
    maybeAutoPrepareDocuments(active);
  }

  function renderAll() {
    renderHeader();
    renderPackage();
    renderEnvelope();
    renderSigners();
    renderSend();
    renderTimeline();
    renderCertificate();
    renderPdf();
    renderDev();
    renderGuidance();
    renderVisualWorkflow();
    syncContractReviewNavHints();
    showMain();
  }

  // CH-013A.46 — Contract Review Workspace (presentation only; proxies existing sections)
  const CRW_PANEL_IDS = [
    "swSecPackage",
    "swSecEnvelope",
    "swSecSigners",
    "swSecSend",
    "swSecProgress",
    "swSecCert",
    "swSecPdf",
  ];

  function crwTextReady(id) {
    const t = String($(id)?.textContent || "").trim();
    if (!t || t === "—") return false;
    const low = t.toLowerCase();
    return low !== "none" && low !== "not created";
  }

  function syncContractReviewNavHints() {
    const checks = [
      () => crwTextReady("swPkgStatus") || crwTextReady("swPkgVersion"),
      () => crwTextReady("swEnvStatus"),
      () => ($("swSignersBody")?.children?.length || 0) > 0,
      () => {
        const ready = String($("swSendReady")?.textContent || "").toLowerCase();
        const linkReady = $("swLinkReady");
        return ready.includes("ready") || !!(linkReady && !linkReady.hidden);
      },
      () => ($("swTimeline")?.children?.length || 0) > 0,
      () => crwTextReady("swCertNumber"),
      () => {
        const st = String($("swPdfStatus")?.textContent || "").toLowerCase();
        return st === "ready" || st.includes("signed pdf");
      },
    ];
    document.querySelectorAll("#swCrwNav [data-sw-crw-sec]").forEach((tab) => {
      const n = Number(tab.getAttribute("data-sw-crw-sec"));
      const ready = typeof checks[n - 1] === "function" ? !!checks[n - 1]() : false;
      tab.classList.toggle("is-ready", ready);
    });
  }

  function setContractReviewSection(sectionNum) {
    const n = Math.max(1, Math.min(7, Number(sectionNum) || 1));
    CRW_PANEL_IDS.forEach((id, idx) => {
      const panel = $(id);
      if (!panel) return;
      const active = idx + 1 === n;
      panel.classList.toggle("is-active", active);
      panel.hidden = !active;
      panel.setAttribute("aria-hidden", active ? "false" : "true");
    });
    document.querySelectorAll("#swCrwNav [data-sw-crw-sec]").forEach((tab) => {
      const active = Number(tab.getAttribute("data-sw-crw-sec")) === n;
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    });
    syncContractReviewNavHints();
  }

  function scrollContractReviewWorkspaceIntoView() {
    const shell = $("swContractReviewWorkspace") || $("swAdvancedDetails");
    if (!shell) return;
    const reduceMotion = prefersReducedMotion();
    window.requestAnimationFrame(() => {
      shell.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
    });
  }

  function scrollActiveWorkspaceIntoView() {
    const step = state.visualStep;
    const panel = document.querySelector(`[data-sw-panel="${step}"]`);
    if (!panel || panel.hidden) return;
    const reduceMotion = prefersReducedMotion();
    window.requestAnimationFrame(() => {
      panel.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: "start",
      });
    });
  }

  function openContractReviewWorkspace(sectionNum = 1) {
    const adv = $("swAdvancedDetails");
    if (adv) adv.open = true;
    setContractReviewSection(sectionNum);
    scrollContractReviewWorkspaceIntoView();
  }

  // CH-013A.48 — presentation only: hide Step 1 review surfaces
  let lastVisualStepForReviewSync = null;

  function closeContractReviewWorkspace() {
    const adv = $("swAdvancedDetails");
    if (adv) adv.open = false;
  }

  function closeReviewContractModal() {
    if ($("swModalBody")?.querySelector(".sw-modal-review")) closeModal();
  }

  function closeStep1ReviewSurfaces() {
    closeContractReviewWorkspace();
    closeReviewContractModal();
  }

  function syncReviewSurfacesWithVisualStep(step) {
    const n = Number(step);
    if (!Number.isFinite(n)) return;
    const prev = lastVisualStepForReviewSync;
    if (prev === n) return;
    lastVisualStepForReviewSync = n;
    // Close review workspace/modal whenever leaving for another workflow step.
    if (n !== 1) closeStep1ReviewSurfaces();
  }

  function backToWorkflowFromReview() {
    closeStep1ReviewSurfaces();
    scrollActiveWorkspaceIntoView();
  }

  function bindContractReviewWorkspace() {
    const nav = $("swCrwNav");
    if (!nav) return;
    nav.querySelectorAll("[data-sw-crw-sec]").forEach((tab) => {
      tab.addEventListener("click", () => {
        openContractReviewWorkspace(tab.getAttribute("data-sw-crw-sec"));
      });
    });
    nav.addEventListener("keydown", (ev) => {
      const tabs = Array.from(nav.querySelectorAll("[data-sw-crw-sec]"));
      if (!tabs.length) return;
      const current = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
      let next = current;
      if (ev.key === "ArrowRight" || ev.key === "ArrowDown") next = (current + 1) % tabs.length;
      else if (ev.key === "ArrowLeft" || ev.key === "ArrowUp") next = (current - 1 + tabs.length) % tabs.length;
      else if (ev.key === "Home") next = 0;
      else if (ev.key === "End") next = tabs.length - 1;
      else return;
      ev.preventDefault();
      const target = tabs[next];
      target?.focus();
      openContractReviewWorkspace(target.getAttribute("data-sw-crw-sec"));
    });
    $("swAdvancedDetails")?.addEventListener("toggle", () => {
      const adv = $("swAdvancedDetails");
      if (adv?.open) {
        const active = document.querySelector("#swCrwNav [aria-selected='true']");
        setContractReviewSection(active?.getAttribute("data-sw-crw-sec") || 1);
      }
    });
    $("swCrwBackBtn")?.addEventListener("click", () => {
      backToWorkflowFromReview();
    });
    setContractReviewSection(1);
  }

  async function loadPackages(projectId) {
    const res = await api(`${PACKAGES_API}?project_id=${encodeURIComponent(projectId)}`);
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not load packages");
    }
    state.packages = Array.isArray(res.data.packages) ? res.data.packages : [];
    const params = new URLSearchParams(window.location.search);
    const want = String(params.get("package_id") || "").trim().toLowerCase();
    state.package =
      state.packages.find((p) => String(p.id).toLowerCase() === want) ||
      state.packages[0] ||
      null;
  }

  async function loadEnvelopes(packageId) {
    if (!packageId) {
      noteEnvelopeChange(state.envelope?.id, "");
      state.envelopes = [];
      state.envelope = null;
      state.signingLink = null;
      state.delivery = null;
      state.emailDelivery = null;
      state.emailUiStatus = null;
      return;
    }
    const prevEnvelopeId = state.envelope?.id || null;
    const res = await api(
      `${ENVELOPES_API}?package_id=${encodeURIComponent(packageId)}`
    );
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not load envelopes");
    }
    state.envelopes = Array.isArray(res.data.envelopes) ? res.data.envelopes : [];
    const params = new URLSearchParams(window.location.search);
    const want = String(params.get("envelope_id") || "").trim().toLowerCase();
    const active = state.envelopes.find((e) =>
      ["draft", "sent", "opened"].includes(String(e.status || "").toLowerCase())
    );
    const completed = state.envelopes.find(
      (e) => String(e.status || "").toLowerCase() === "completed"
    );
    const nextEnvelope =
      state.envelopes.find((e) => String(e.id).toLowerCase() === want) ||
      active ||
      completed ||
      state.envelopes[0] ||
      null;
    noteEnvelopeChange(prevEnvelopeId, nextEnvelope?.id);
    state.envelope = nextEnvelope;
    // Policy A: never reconstruct raw link after reload; clear only on envelope change.
    if (!state.envelope?.id || String(state.envelope.id) !== String(prevEnvelopeId)) {
      if (String(state.envelope?.id || "") !== String(prevEnvelopeId)) {
        state.signingLink = null;
        state.emailUiStatus = null;
        state.emailDelivery = null;
      }
    }
    if (!state.envelope?.id) {
      state.signingLink = null;
      state.delivery = null;
      state.emailUiStatus = null;
      state.emailDelivery = null;
    }
  }

  async function loadSigners(envelopeId) {
    if (!envelopeId) {
      state.signers = [];
      return;
    }
    const res = await api(
      `${SIGNERS_API}?envelope_id=${encodeURIComponent(envelopeId)}`
    );
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not load signers");
    }
    state.signers = Array.isArray(res.data.signers) ? res.data.signers : [];
  }

  async function fetchCertificates(envelopeId) {
    if (!envelopeId) return [];
    const res = await api(
      `${CERTS_API}?envelope_id=${encodeURIComponent(envelopeId)}`
    );
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not load certificates");
    }
    return (Array.isArray(res.data.certificates) ? res.data.certificates : [])
      .map(toTenantCertificate)
      .filter(Boolean);
  }

  async function loadCertificates(envelopeId) {
    const requested = String(envelopeId || "");
    if (!requested) {
      if (!state.envelope?.id) state.certificates = [];
      return [];
    }
    const certs = await fetchCertificates(requested);
    if (String(state.envelope?.id || "") !== requested) return certs;
    state.certificates = certs;
    return certs;
  }

  async function fetchPdfs(envelopeId) {
    if (!envelopeId) return [];
    const res = await api(
      `${PDFS_API}?envelope_id=${encodeURIComponent(envelopeId)}`
    );
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not load signed PDFs");
    }
    return Array.isArray(res.data.artifacts) ? res.data.artifacts : [];
  }

  async function loadPdfs(envelopeId) {
    const requested = String(envelopeId || "");
    if (!requested) {
      if (!state.envelope?.id) state.artifacts = [];
      return [];
    }
    const artifacts = await fetchPdfs(requested);
    if (String(state.envelope?.id || "") !== requested) return artifacts;
    state.artifacts = artifacts;
    return artifacts;
  }

  async function refreshEnvelopeChain() {
    await loadSigners(state.envelope?.id);
    await loadCertificates(state.envelope?.id);
    await loadPdfs(state.envelope?.id);
    if (isLinkReady()) {
      await refreshEmailCapability();
      await hydrateEmailDeliveryStatus();
    } else {
      state.emailDelivery = null;
      state.emailUiStatus = null;
      state.emailAttemptId = null;
      state.emailStuck = false;
      state.emailRecoverable = false;
      state.emailRecoveredAttemptId = null;
      stopEmailStatusPoll();
    }
  }

  async function loadProjectWorkspace(projectId) {
    showLoading();
    toast("");
    try {
      await loadPackages(projectId);
      await loadEnvelopes(state.package?.id);
      await refreshEnvelopeChain();
      renderAll();
      const hub = $("swBackHub");
      if (hub && projectId) {
        hub.href = `/contract-hub?project_id=${encodeURIComponent(projectId)}`;
      }
    } catch (err) {
      showError("Contract Signing", err?.message || "Failed to load workspace");
    }
  }

  function openSignerModal(existing) {
    if (!envelopeEditable()) {
      toast("Customer details are locked after the contract is sent", "error");
      return;
    }
    const isEdit = !!existing?.id;
    openModal(
      isEdit ? "Edit Customer" : "Add Customer",
      `<p class="sw-modal-sub">Add the person who will sign this contract.</p>
       <div class="sw-modal-card">
         <div class="sw-modal-card__title">Customer details</div>
         <div class="field"><label>Role</label>
          <select id="swFormRole">
            <option value="customer">Customer</option>
            <option value="owner">Owner</option>
            <option value="additional">Additional signer</option>
          </select></div>
         <div class="field"><label>Name</label><input id="swFormName" /></div>
         <div class="field"><label>Email</label><input id="swFormEmail" type="email" /></div>
         <div class="field"><label>Phone</label><input id="swFormPhone" /></div>
         <div class="field"><label>Sign order</label><input id="swFormOrder" type="number" min="1" value="1" /></div>
         <div class="field"><label>How they sign</label>
          <select id="swFormMethod">
            <option value="email_link">Email link</option>
            <option value="in_app">In app</option>
          </select></div>
       </div>`,
      [
        btn("Cancel", "btn ghost", closeModal),
        btn(isEdit ? "Save" : "Continue", "btn primary", async () => {
          const payload = {
            role: $("swFormRole")?.value,
            party_name: $("swFormName")?.value,
            email: $("swFormEmail")?.value,
            phone: $("swFormPhone")?.value,
            sign_order: Number($("swFormOrder")?.value) || 1,
            auth_method: $("swFormMethod")?.value,
            is_required: true,
          };
          try {
            let res;
            if (isEdit) {
              res = await api(SIGNER_UPDATE_API, {
                method: "POST",
                body: JSON.stringify({
                  signer_id: existing.id,
                  expected_updated_at: existing.updated_at,
                  ...payload,
                }),
              });
            } else {
              res = await api(SIGNER_CREATE_API, {
                method: "POST",
                body: JSON.stringify({
                  envelope_id: state.envelope.id,
                  ...payload,
                }),
              });
            }
            if (!res.ok || res.data?.ok !== true) {
              throw new Error(res.data?.error || "Signer save failed");
            }
            closeModal();
            toast(isEdit ? "Signer updated" : "Signer added", "ok");
            await loadSigners(state.envelope.id);
            renderAll();
          } catch (err) {
            toast(err?.message || "Signer save failed", "error");
          }
        }),
      ]
    );
    if (existing) {
      if ($("swFormRole")) $("swFormRole").value = existing.role || "customer";
      if ($("swFormName")) $("swFormName").value = existing.party_name || "";
      if ($("swFormEmail")) $("swFormEmail").value = existing.email || "";
      if ($("swFormPhone")) $("swFormPhone").value = existing.phone || "";
      if ($("swFormOrder")) $("swFormOrder").value = existing.sign_order || 1;
      if ($("swFormMethod"))
        $("swFormMethod").value = existing.auth_method || "email_link";
    } else if (isDualSigning()) {
      if ($("swFormOrder")) $("swFormOrder").value = 2;
    }
  }

  function openConfirmContractorModal() {
    if (!envelopeEditable()) {
      toast("Contractor details are locked after the contract is sent", "error");
      return;
    }
    const existing = requiredSigner("owner");
    const proposal = contractorProposal();
    openModal(
      existing ? "Confirm Contractor" : "Confirm Contractor",
      `<p class="sw-modal-sub">Proposed from Legal Profile. Confirm the identity — this is not a signature.</p>
       <div class="sw-modal-card">
         <div class="sw-modal-card__title">Contractor details</div>
         <div class="field"><label>Name</label><input id="swFormName" /></div>
         <div class="field"><label>Title</label><input id="swFormTitle" /></div>
         <div class="field"><label>Email</label><input id="swFormEmail" type="email" /></div>
       </div>`,
      [
        btn("Cancel", "btn ghost", closeModal),
        btn("Save Contractor", "btn primary", async () => {
          const payload = {
            role: "owner",
            party_name: $("swFormName")?.value,
            email: $("swFormEmail")?.value,
            phone: "",
            sign_order: 1,
            auth_method: "in_app",
            is_required: true,
          };
          try {
            let res;
            if (existing?.id) {
              res = await api(SIGNER_UPDATE_API, {
                method: "POST",
                body: JSON.stringify({
                  signer_id: existing.id,
                  expected_updated_at: existing.updated_at,
                  ...payload,
                }),
              });
            } else {
              res = await api(SIGNER_CREATE_API, {
                method: "POST",
                body: JSON.stringify({
                  envelope_id: state.envelope.id,
                  ...payload,
                }),
              });
            }
            if (!res.ok || res.data?.ok !== true) {
              throw new Error(res.data?.error || "Contractor save failed");
            }
            closeModal();
            toast("Contractor confirmed. Sign as Contractor next.", "ok");
            await loadSigners(state.envelope.id);
            renderAll();
            openSignContractorModal();
          } catch (err) {
            toast(err?.message || "Contractor save failed", "error");
          }
        }),
      ]
    );
    if ($("swFormName"))
      $("swFormName").value = existing?.party_name || proposal.party_name || "";
    if ($("swFormTitle")) $("swFormTitle").value = proposal.title || "";
    if ($("swFormEmail"))
      $("swFormEmail").value = existing?.email || proposal.email || "";
  }

  function openSignContractorModal() {
    const owner = requiredSigner("owner");
    if (!owner?.id) {
      openConfirmContractorModal();
      return;
    }
    if (String(owner.status || "").toLowerCase() === "signed") {
      toast("Contractor signature already recorded", "ok");
      return;
    }
    openModal(
      "Sign as Contractor",
      `<p class="sw-vis-now">Step 1 of 2: Enter your name and confirm your signature.</p>
       <p class="sw-modal-sub">Type your name to sign. Legal Profile is identity only and is not used as the signature.</p>
       <div class="sw-modal-card">
         <div class="sw-modal-card__title">Explicit contractor signature</div>
         <div class="field"><label for="swContractorTypedName">Typed signature name</label><input id="swContractorTypedName" autocomplete="off" /></div>
         <div class="field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
           <input id="swContractorConsent" type="checkbox" />
           <span>I consent to sign this contract electronically as the contractor.</span>
         </label></div>
       </div>`,
      [
        btn("Cancel", "btn ghost", closeModal),
        btn("Sign as Contractor", "btn primary", async () => {
          const typedName = String($("swContractorTypedName")?.value || "").trim();
          const consent = $("swContractorConsent")?.checked === true;
          if (!typedName) {
            toast("Type your name to sign as contractor", "error");
            return;
          }
          if (!consent) {
            toast("Electronic signature consent is required", "error");
            return;
          }
          try {
            const res = await api(SIGN_CONTRACTOR_API, {
              method: "POST",
              body: JSON.stringify({
                envelope_id: state.envelope.id,
                expected_updated_at: state.envelope.updated_at,
                signature_method: "typed",
                signature_payload: { typed_name: typedName },
                consent_esign: true,
              }),
            });
            if (!res.ok || res.data?.ok !== true) {
              throw new Error(res.data?.error || "Contractor signature failed");
            }
            if (res.data.envelope) state.envelope = { ...state.envelope, ...res.data.envelope };
            await refreshEnvelopeChain();
            renderAll();
            showContractorSignSuccess();
          } catch (err) {
            toast(err?.message || "Contractor signature failed", "error");
          }
        }),
      ]
    );
  }

  function projectDisplayName(p) {
    return (
      String(p?.projectName || p?.project_name || p?.id || "").trim() || "Project"
    );
  }

  function projectCustomerName(p) {
    return String(p?.clientName || p?.client_name || "").trim();
  }

  function isProjectPickerOpen() {
    const menu = $("swProjectPickerMenu");
    return Boolean(menu && !menu.hidden);
  }

  function closeProjectPicker() {
    const menu = $("swProjectPickerMenu");
    const trigger = $("swProjectPickerTrigger");
    if (menu) menu.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    document
      .querySelectorAll(".sw-project-picker__option.is-active")
      .forEach((el) => el.classList.remove("is-active"));
  }

  function syncProjectPickerUi() {
    const sel = $("swProjectSelect");
    const valueEl = $("swProjectPickerValue");
    const list = $("swProjectPickerList");
    if (!sel || !valueEl || !list) return;

    const selectedId = String(sel.value || "").trim();
    if (!selectedId) {
      valueEl.textContent = "Select project…";
    } else {
      const selected =
        state.projects.find(
          (p) => String(p.id).toLowerCase() === selectedId.toLowerCase()
        ) || null;
      valueEl.textContent = selected
        ? projectDisplayName(selected)
        : selectedId;
    }

    if (!Array.isArray(state.projects) || !state.projects.length) {
      list.innerHTML =
        `<div class="sw-project-picker__empty">No projects available.</div>`;
      return;
    }

    list.innerHTML = state.projects
      .map((p) => {
        const id = String(p.id || "");
        const name = projectDisplayName(p);
        const customer = projectCustomerName(p);
        const isSelected =
          selectedId && id.toLowerCase() === selectedId.toLowerCase();
        const meta = customer
          ? `<span class="sw-project-picker__option-meta">Customer: ${escapeHtml(
              customer
            )}</span>`
          : "";
        return `<button type="button" class="sw-project-picker__option${
          isSelected ? " is-selected" : ""
        }" role="option" data-project-id="${escapeHtml(id)}" aria-selected="${
          isSelected ? "true" : "false"
        }">
          <span class="sw-project-picker__option-main">
            <span class="sw-project-picker__option-name">${escapeHtml(name)}</span>
            ${meta}
          </span>
          <span class="sw-project-picker__check" aria-hidden="true">✓</span>
        </button>`;
      })
      .join("");
  }

  function openProjectPicker() {
    const menu = $("swProjectPickerMenu");
    const trigger = $("swProjectPickerTrigger");
    if (!menu || !trigger) return;
    syncProjectPickerUi();
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    const selected =
      menu.querySelector(".sw-project-picker__option.is-selected") ||
      menu.querySelector(".sw-project-picker__option");
    if (selected) {
      selected.classList.add("is-active");
      selected.focus();
    }
  }

  function chooseProjectFromPicker(projectId) {
    const sel = $("swProjectSelect");
    const id = String(projectId || "").trim();
    if (!sel || !id) {
      closeProjectPicker();
      return;
    }
    if (String(sel.value || "") === id) {
      closeProjectPicker();
      syncProjectPickerUi();
      return;
    }
    sel.value = id;
    closeProjectPicker();
    // Preserve existing change-handler path exactly.
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    syncProjectPickerUi();
  }

  function bindProjectPickerPresentation() {
    const picker = $("swProjectPicker");
    const trigger = $("swProjectPickerTrigger");
    const menu = $("swProjectPickerMenu");
    const list = $("swProjectPickerList");
    if (!picker || !trigger || !menu || !list) return;

    trigger.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (isProjectPickerOpen()) closeProjectPicker();
      else openProjectPicker();
    });

    trigger.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        if (!isProjectPickerOpen()) openProjectPicker();
      }
    });

    list.addEventListener("click", (ev) => {
      const opt = ev.target.closest(".sw-project-picker__option");
      if (!opt || !list.contains(opt)) return;
      ev.preventDefault();
      chooseProjectFromPicker(opt.getAttribute("data-project-id"));
    });

    list.addEventListener("keydown", (ev) => {
      const options = Array.from(
        list.querySelectorAll(".sw-project-picker__option")
      );
      if (!options.length) return;
      const active = list.querySelector(".sw-project-picker__option.is-active");
      let idx = Math.max(0, options.indexOf(active));
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        idx = Math.min(options.length - 1, idx + 1);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        idx = Math.max(0, idx - 1);
      } else if (ev.key === "Home") {
        ev.preventDefault();
        idx = 0;
      } else if (ev.key === "End") {
        ev.preventDefault();
        idx = options.length - 1;
      } else if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        const target = options[idx];
        if (target) chooseProjectFromPicker(target.getAttribute("data-project-id"));
        return;
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeProjectPicker();
        trigger.focus();
        return;
      } else {
        return;
      }
      options.forEach((el) => el.classList.remove("is-active"));
      const next = options[idx];
      next.classList.add("is-active");
      next.focus();
    });

    document.addEventListener("click", (ev) => {
      if (!isProjectPickerOpen()) return;
      if (picker.contains(ev.target)) return;
      closeProjectPicker();
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && isProjectPickerOpen()) {
        closeProjectPicker();
        trigger.focus();
      }
    });
  }

  function bindEvents() {
    bindProjectPickerPresentation();

    $("swReloadBtn")?.addEventListener("click", () => {
      const id = $("swProjectSelect")?.value;
      if (id) void loadProjectWorkspace(id);
    });

    $("swProjectSelect")?.addEventListener("change", (ev) => {
      const id = ev.target.value;
      const project = state.projects.find((p) => p.id === id) || null;
      state.project = project;
      syncProjectPickerUi();
      if (!id) {
        showError("Contract Signing", "Select a project to open the Signature Workspace.");
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.set("project_id", id);
      window.history.replaceState({}, "", url.toString());
      void loadProjectWorkspace(id);
    });

    $("swPackageSelect")?.addEventListener("change", async (ev) => {
      const id = ev.target.value;
      state.package = state.packages.find((p) => p.id === id) || null;
      try {
        await loadEnvelopes(state.package?.id);
        await refreshEnvelopeChain();
        renderAll();
      } catch (err) {
        toast(err?.message || "Failed to switch package", "error");
      }
    });

    $("swEnvelopeSelect")?.addEventListener("change", async (ev) => {
      const id = ev.target.value;
      const prevId = state.envelope?.id || null;
      noteEnvelopeChange(prevId, id);
      state.envelope = state.envelopes.find((e) => e.id === id) || null;
      try {
        await refreshEnvelopeChain();
        renderAll();
      } catch (err) {
        toast(err?.message || "Failed to open envelope", "error");
      }
    });

    $("swCreateEnvelopeBtn")?.addEventListener("click", async () => {
      try {
        await ensureDraftEnvelope({ silent: false });
      } catch (err) {
        toast(err?.message || "Create signing request failed", "error");
      }
    });

    $("swAddSignerBtn")?.addEventListener("click", () => openSignerModal(null));
    $("swConfirmContractorBtn")?.addEventListener("click", () =>
      openConfirmContractorModal()
    );
    $("swSignContractorBtn")?.addEventListener("click", () =>
      openSignContractorModal()
    );

    $("swSignersBody")?.addEventListener("click", async (ev) => {
      const editId = ev.target?.getAttribute?.("data-sw-edit");
      const delId = ev.target?.getAttribute?.("data-sw-del");
      if (editId) {
        const row = state.signers.find((s) => s.id === editId);
        if (row) openSignerModal(row);
        return;
      }
      if (delId) {
        const row = state.signers.find((s) => s.id === delId);
        if (!row) return;
        if (!window.confirm(`Delete signer ${row.party_name || row.email}?`)) return;
        try {
          const res = await api(SIGNER_DELETE_API, {
            method: "POST",
            body: JSON.stringify({
              signer_id: row.id,
              expected_updated_at: row.updated_at,
            }),
          });
          if (!res.ok || res.data?.ok !== true) {
            throw new Error(res.data?.error || "Delete failed");
          }
          toast("Signer deleted", "ok");
          await loadSigners(state.envelope.id);
          renderAll();
        } catch (err) {
          toast(err?.message || "Delete failed", "error");
        }
      }
    });

    $("swSendBtn")?.addEventListener("click", async () => {
      if (!state.envelope?.id) return;
      try {
        const res = await api(ENVELOPE_SEND_API, {
          method: "POST",
          body: JSON.stringify({
            envelope_id: state.envelope.id,
            expected_updated_at: state.envelope.updated_at,
            delivery_mode: "prepared",
          }),
        });
        if (!res.ok || res.data?.ok !== true) {
          const blockers = Array.isArray(res.data?.blockers)
            ? res.data.blockers.map((b) => b.message || b.code).join("; ")
            : "";
          throw new Error(
            blockers || res.data?.error || "Send for signature failed"
          );
        }
        captureDeliveryLink(res.data.delivery, { fromSendResponse: true });
        toast(
          res.data.idempotent
            ? hasCopyableLink()
              ? "Secure Link Ready"
              : "Secure Link Ready — the secure link was generated previously"
            : hasCopyableLink()
              ? "Secure Link Ready — the signing request is prepared. No email has been sent yet."
              : "Secure Link Ready — the secure link was generated previously",
          "ok"
        );
        await loadEnvelopes(state.package.id);
        if (res.data.envelope) state.envelope = res.data.envelope;
        await refreshEnvelopeChain();
        renderAll();
      } catch (err) {
        toast(err?.message || "Send failed", "error");
      }
    });

    $("swCopyLinkBtn")?.addEventListener("click", async () => {
      if (!state.signingLink) {
        toast(
          "The secure link was generated previously and is not available to copy in this session.",
          "error"
        );
        return;
      }
      try {
        await navigator.clipboard.writeText(state.signingLink);
        toast("Link copied", "ok");
      } catch (_err) {
        toast("Could not copy link", "error");
      }
    });

    $("swEmailLinkBtn")?.addEventListener("click", async () => {
      const signer = customerDeliverySigner();
      if (!state.envelope?.id || !signer?.id) {
        toast("Signer required before emailing a signing link", "error");
        return;
      }
      if (state.emailBusy) return;
      state.emailBusy = true;
      state.emailStuck = false;
      state.emailRecoverable = false;
      state.emailUiStatus = "queued";
      renderSend();
      try {
        const res = await api(EMAIL_QUEUE_API, {
          method: "POST",
          body: JSON.stringify({
            envelope_id: state.envelope.id,
            signer_id: signer.id,
          }),
        });
        if (!res.ok || res.data?.ok !== true) {
          state.emailUiStatus = "failed";
          throw new Error(
            res.data?.error || "Could not queue signing invitation email"
          );
        }
        // Never accept token/url from response (server must not return them).
        if (res.data.signing_url || res.data.signing_token || res.data.raw_token) {
          state.emailUiStatus = "failed";
          throw new Error("Unexpected secure fields in email queue response");
        }
        // Queue HTTP 200 => Email queued only. Never claim sent from queue success.
        const ui = String(res.data.ui_status || "queued").toLowerCase();
        state.emailUiStatus =
          ui === "sent" ||
          ui === "sending" ||
          ui === "failed" ||
          ui === "queued" ||
          ui === "accepted_db_pending"
            ? ui
            : "queued";
        const newAttemptId = String(res.data.attempt_id || "");
        if (!newAttemptId || newAttemptId === state.emailRecoveredAttemptId) {
          state.emailUiStatus = "failed";
          throw new Error("Email delivery needs attention. Please try again.");
        }
        state.emailAttemptId = newAttemptId;
        state.emailRecoveredAttemptId = null;
        if (res.data.email_delivery) {
          state.emailDelivery = res.data.email_delivery;
        }
        toast(
          state.emailUiStatus === "sent"
            ? "Email sent"
            : state.emailUiStatus === "failed"
              ? "Email delivery needs attention"
              : "Sending...",
          state.emailUiStatus === "failed" ? "error" : "ok"
        );
        if (
          state.emailUiStatus === "queued" ||
          state.emailUiStatus === "sending" ||
          state.emailUiStatus === "accepted_db_pending"
        ) {
          pollEmailDeliveryStatus(state.emailAttemptId, EMAIL_POLL_FAST_TICKS, false);
        }
      } catch (err) {
        state.emailUiStatus = "failed";
        toast(err?.message || "Email delivery failed", "error");
      } finally {
        state.emailBusy = false;
        renderSend();
      }
    });

    $("swEmailRetryBtn")?.addEventListener("click", async () => {
      if (!state.emailAttemptId) {
        toast("Email delivery needs attention", "error");
        return;
      }
      if (state.emailBusy) return;
      state.emailBusy = true;
      renderSend();
      try {
        stopEmailStatusPoll();
        const res = await api(EMAIL_QUEUE_API, {
          method: "POST",
          body: JSON.stringify({
            recover: true,
            attempt_id: state.emailAttemptId,
          }),
        });
        if (!res.ok || res.data?.ok !== true) {
          throw new Error(res.data?.error || "Email delivery needs attention");
        }
        const ui = String(res.data.ui_status || "failed").toLowerCase();
        state.emailUiStatus = ui === "failed" || ui === "sent" ? ui : "failed";
        state.emailStuck = false;
        state.emailRecoverable =
          res.data.recoverable === true ||
          String(res.data.error_code || "").toLowerCase() === "upstream_validation_failed";
        if (state.emailRecoverable) {
          // Abandoned attempt must never be polled or re-sent by the next click.
          state.emailRecoveredAttemptId = String(res.data.attempt_id || state.emailAttemptId || "");
          state.emailAttemptId = null;
        }
        toast(
          state.emailRecoverable
            ? "Email delivery reset. You can send the contract again."
            : res.data.error || "Email delivery reset. You can send the contract again.",
          "ok"
        );
      } catch (err) {
        toast(err?.message || "Retry sending email failed", "error");
      } finally {
        state.emailBusy = false;
        renderSend();
      }
    });

    $("swViewFrozenBtn")?.addEventListener("click", () => {
      const pkg = state.package;
      if (!pkg) {
        toast("No final contract selected", "error");
        return;
      }
      const projectName =
        String(
          state.project?.projectName || state.project?.project_name || ""
        ).trim() || "—";
      const customer =
        String(
          state.project?.clientName ||
            state.project?.client_name ||
            primarySigner()?.party_name ||
            ""
        ).trim() || "—";
      const ready = pkg.source_readiness || {};
      const isConfigured = (value) => {
        const v = String(value || "").toLowerCase();
        return !v || v === "configured" || v === "ready" || v === "complete" || v === "yes";
      };
      // Frozen packages already passed readiness; show business checklist for contractors.
      const included = [
        ["Scope of Work", true],
        ["Project Address", true],
        [
          "Payment Schedule",
          isConfigured(ready.payment_schedule || ready.payment),
        ],
        ["Warranty", isConfigured(ready.warranty)],
        [
          "Signature Method",
          isConfigured(ready.signature_method || ready.signature),
        ],
      ]
        .map(
          ([label, ok]) =>
            `<li>${ok ? "✔" : "○"} ${escapeHtml(label)}</li>`
        )
        .join("");

      openModal(
        "Review Contract",
        `<div class="sw-modal-review">
          <p class="sw-modal-sub">${
            isDualSigning()
              ? "Review the final contract, then continue to sign as the contractor."
              : "Review the final contract, then confirm the customer and send the signing link."
          }</p>
          <div class="sw-modal-review__layout">
            <div class="sw-modal-review__main">
              <div class="sw-modal-card sw-modal-card--info">
                <div class="sw-modal-card__title">Project Information</div>
                <div class="sw-meta">
                  <div class="sw-field"><div class="sw-field__k">Project</div><div class="sw-field__v">${escapeHtml(projectName)}</div></div>
                  <div class="sw-field"><div class="sw-field__k">Customer</div><div class="sw-field__v">${escapeHtml(customer)}</div></div>
                  <div class="sw-field"><div class="sw-field__k">Version</div><div class="sw-field__v">v${escapeHtml(pkg.version)}</div></div>
                  <div class="sw-field"><div class="sw-field__k">Created</div><div class="sw-field__v">${escapeHtml(fmtWhen(pkg.created_at))}</div></div>
                </div>
              </div>
              <div class="sw-modal-card">
                <div class="sw-modal-card__title">Included</div>
                <ul class="sw-modal-list">${included}</ul>
              </div>
            </div>
            <aside class="sw-modal-review__aside">
              <div class="sw-modal-card sw-modal-card--continue">
                <div class="sw-modal-card__title">Before you continue</div>
                <p class="sw-modal-note">${
                  isDualSigning()
                    ? "Next you will sign as the contractor. The customer is not contacted until after your signature."
                    : "Next you will confirm the customer and send the signing link."
                }</p>
              </div>
            </aside>
          </div>
        </div>`,
        [
          btn(
            isDualSigning()
              ? "Continue to Contractor Signature"
              : "Continue to Customer",
            "btn primary",
            () => {
              closeModal();
              void continueAfterReview();
            }
          ),
          btn("Back to Workflow", "btn ghost sw-modal-back", () => {
            backToWorkflowFromReview();
          }),
        ]
      );
    });

    $("swIssueCertBtn")?.addEventListener("click", async () => {
      if (!state.envelope?.id) return;
      try {
        const res = await api(CERT_CREATE_API, {
          method: "POST",
          body: JSON.stringify({ envelope_id: state.envelope.id }),
        });
        if (!res.ok || res.data?.ok !== true) {
          throw new Error(res.data?.error || "Certificate create failed");
        }
        toast(
          state.autoPreparingDocs
            ? "Preparing your documents…"
            : res.data.idempotent
              ? "Certificate already issued"
              : "Certificate issued",
          "ok"
        );
        await loadCertificates(state.envelope.id);
        state.autoDocsBusy = false;
        state.autoPreparingDocs = false;
        renderAll();
      } catch (err) {
        state.autoDocsBusy = false;
        state.autoPreparingDocs = false;
        toast(err?.message || "Certificate failed", "error");
      }
    });

    $("swViewCertBtn")?.addEventListener("click", () => {
      const cert = state.certificates[0];
      if (!cert) return;
      openModal(
        "Legal Certificate",
        `<p class="sw-modal-sub">The signing certificate is ready for your records.</p>
        <div class="sw-modal-card">
          <div class="sw-modal-card__title">Certificate</div>
          <div class="sw-meta">
            <div class="sw-field"><div class="sw-field__k">Number</div><div class="sw-field__v">${escapeHtml(cert.certificate_number)}</div></div>
            <div class="sw-field"><div class="sw-field__k">Issued</div><div class="sw-field__v">${escapeHtml(fmtWhen(cert.issued_at))}</div></div>
            <div class="sw-field"><div class="sw-field__k">Status</div><div class="sw-field__v">${escapeHtml(formatCertificateStatus(cert.status))}</div></div>
          </div>
        </div>`,
        [btn("Close", "btn primary", closeModal)]
      );
    });

    $("swGeneratePdfBtn")?.addEventListener("click", async () => {
      if (!state.envelope?.id) return;
      try {
        if (!state.certificates[0]) {
          const c = await api(CERT_CREATE_API, {
            method: "POST",
            body: JSON.stringify({ envelope_id: state.envelope.id }),
          });
          if (!c.ok || c.data?.ok !== true) {
            throw new Error(c.data?.error || "Certificate required first");
          }
          await loadCertificates(state.envelope.id);
        }
        const res = await api(PDF_CREATE_API, {
          method: "POST",
          body: JSON.stringify({ envelope_id: state.envelope.id }),
        });
        if (!res.ok || res.data?.ok !== true) {
          throw new Error(res.data?.error || "PDF generate failed");
        }
        toast(
          state.autoPreparingDocs
            ? "Preparing your documents…"
            : res.data.idempotent
              ? "Signed PDF already exists"
              : "Signed PDF generated",
          "ok"
        );
        await loadPdfs(state.envelope.id);
        state.autoDocsBusy = false;
        state.autoPreparingDocs = false;
        renderAll();
      } catch (err) {
        state.autoDocsBusy = false;
        state.autoPreparingDocs = false;
        toast(err?.message || "PDF generate failed", "error");
      }
    });

    $("swOpenPdfBtn")?.addEventListener("click", () => {
      const url = state.artifacts[0]?.download_url;
      if (!url) {
        toast("Signed contract is not ready yet", "error");
        return;
      }
      window.open(url, "_blank", "noopener");
    });

    $("swModal")?.addEventListener("click", (ev) => {
      if (ev.target === $("swModal")) closeModal();
    });

    // CH-013A.31 — presentation proxies; always invoke existing controls.
    const proxyClick = (visId, srcId) => {
      $(visId)?.addEventListener("click", (ev) => {
        ev.preventDefault();
        const src = $(srcId);
        if (!src || src.disabled || src.hidden) return;
        src.click();
      });
    };
    proxyClick("swVisCopyLinkBtn", "swCopyLinkBtn");
    proxyClick("swVis3CopyLinkBtn", "swCopyLinkBtn");
    proxyClick("swVisRetryEmailBtn", "swEmailRetryBtn");
    proxyClick("swVisIssueCertBtn", "swIssueCertBtn");
    proxyClick("swVisViewCertBtn", "swViewCertBtn");
    proxyClick("swVisDownloadCertBtn", "swViewCertBtn");
    proxyClick("swVisGeneratePdfBtn", "swGeneratePdfBtn");
    proxyClick("swVisOpenPdfBtn", "swOpenPdfBtn");
    proxyClick("swVisCompleteViewPdfBtn", "swOpenPdfBtn");
    proxyClick("swVisCompleteCertBtn", "swViewCertBtn");

    $("swVisSendContractBtn")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      openConfirmCustomerModal();
    });
    $("swVisRetryPrimaryBtn")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      const retry = $("swEmailRetryBtn");
      const email = $("swEmailLinkBtn");
      if (retry && !retry.hidden && !retry.disabled) retry.click();
      else email?.click();
    });

    $("swVisContinueBtn")?.addEventListener("click", () => {
      const g = resolveWorkspaceGuidance();
      if (g.ctaHref) {
        window.location.href = g.ctaHref;
        return;
      }
      $("swViewFrozenBtn")?.click();
    });

    document.querySelectorAll("#swVisRail [data-sw-goto]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const n = Number(btn.getAttribute("data-sw-goto"));
        const active = computeVisualStep();
        if (!Number.isFinite(n) || n > active) return;
        state.visualStepOverride = n;
        renderVisualWorkflow();
        // Presentation-only: bring the activated workspace into view.
        scrollActiveWorkspaceIntoView();
      });
    });

    bindContractReviewWorkspace();
  }

  async function init() {
    bindEvents();
    await waitForAuthReady();
    if (
      document.body?.dataset?.requiresAuth === "true" &&
      !document.body.classList.contains("auth-ready")
    ) {
      return;
    }

    showLoading();
    const projectsRes = await api(PROJECTS_API);
    if (
      !projectsRes.ok ||
      projectsRes.data?.ok !== true ||
      !Array.isArray(projectsRes.data.projects)
    ) {
      showError("Contract Signing", "Could not load projects for this workspace.");
      return;
    }
    state.projects = projectsRes.data.projects;
    const sel = $("swProjectSelect");
    if (sel) {
      sel.innerHTML =
        `<option value="">Select project…</option>` +
        state.projects
          .map((p) => {
            const label =
              String(p.projectName || p.project_name || p.id || "").trim() ||
              p.id;
            return `<option value="${escapeHtml(p.id)}">${escapeHtml(label)}</option>`;
          })
          .join("");
    }
    syncProjectPickerUi();

    const params = new URLSearchParams(window.location.search);
    const projectId = String(params.get("project_id") || "").trim();
    if (projectId) {
      if (sel) sel.value = projectId;
      state.project =
        state.projects.find(
          (p) => String(p.id).toLowerCase() === projectId.toLowerCase()
        ) || null;
      syncProjectPickerUi();
      if (!state.project) {
        showError(
          "Contract Signing",
          "This project is unavailable or does not belong to the current workspace."
        );
        return;
      }
      await loadProjectWorkspace(projectId);
      return;
    }

    $("swLoading")?.setAttribute("hidden", "");
    showError(
      "Contract Signing",
      "Select a project to open the Signature Workspace, or open from Contract Hub with ?project_id=."
    );
    $("swError")?.removeAttribute("hidden");
  }

  document.addEventListener("DOMContentLoaded", () => {
    void init();
  });
})();
