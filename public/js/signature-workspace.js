/**
 * CH-012A — Owner Signature Workspace (UI only).
 * Reuses CH-011A–I APIs. No new backend.
 */
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
  const CERTS_API = "/.netlify/functions/contract-certificates";
  const CERT_CREATE_API = "/.netlify/functions/contract-certificate-create";
  const PDFS_API = "/.netlify/functions/contract-signed-pdfs";
  const PDF_CREATE_API = "/.netlify/functions/contract-signed-pdf-create";

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
    busy: false,
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
      blockers.push({ ok: false, text: "Frozen contract version missing" });
    } else if (pst !== "ready" && pst !== "executed") {
      blockers.push({
        ok: false,
        text: `Frozen contract must be Ready (now ${ownerStatusLabel(pst) || "—"})`,
      });
    } else {
      blockers.push({ ok: true, text: `Frozen contract ${ownerStatusLabel(pst)}` });
    }
    if (!signers.length) {
      blockers.push({ ok: false, text: "At least one signer is required" });
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
      return {
        title: "Add Customer Signer",
        body: "Add the customer as a signer before sending the secure signing link.",
        ctaLabel: "Add Customer Signer",
        ctaHref: null,
        ctaAction: "add-signer",
      };
    }
    if (envSt === "draft" && send.ready) {
      return {
        title: "Send For Signature",
        body: "Create a secure signing link for the customer. The secure link will be generated for you to copy and send.",
        ctaLabel: "Send For Signature",
        ctaHref: null,
        ctaAction: "send",
      };
    }
    if (envSt === "sent") {
      const canCopy = hasCopyableLink();
      return {
        title: "Secure Link Ready",
        body: canCopy
          ? "The signing request is prepared. No email has been sent yet. Copy the secure signing link for the customer."
          : "The secure link was generated previously. Explicit link regeneration is not available in this phase.",
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
        sel.innerHTML = `<option value="">No frozen contract versions</option>`;
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
    const editable = envelopeEditable();
    const noPackage = !state.package?.id;
    const noEnvelope = !state.envelope?.id;
    if (addBtn) {
      addBtn.disabled = noPackage || noEnvelope || !editable;
      addBtn.textContent = "Add Customer Signer";
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
    const copyWrap = copyBtn?.parentElement;
    const linkCopy = $("swLinkReadyCopy");
    const noPackage = !state.package?.id;
    const st = String(state.envelope?.status || "").toLowerCase();
    const linkReady = isLinkReady();
    const canCopy = hasCopyableLink();
    if (linkReadyEl) {
      linkReadyEl.hidden = !linkReady;
    }
    if (linkCopy) {
      linkCopy.textContent = canCopy
        ? "The signing request is prepared. No email has been sent yet."
        : "The secure link was generated previously.";
    }
    if (copyBtn) {
      copyBtn.hidden = !canCopy;
      copyBtn.disabled = !canCopy;
    }
    if (copyWrap && copyWrap.classList.contains("sw-actions")) {
      copyWrap.hidden = !canCopy;
    }
    if (sendBtn) {
      if (linkReady && st !== "completed") {
        sendBtn.hidden = true;
      } else {
        sendBtn.hidden = false;
        sendBtn.disabled =
          noPackage || !state.envelope?.id || (!ready && st === "draft");
        sendBtn.textContent = "Send For Signature";
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

  function renderCertificate() {
    const cert = state.certificates[0];
    const completed =
      String(state.envelope?.status || "").toLowerCase() === "completed";
    setText("swCertNumber", cert?.certificate_number || "—");
    setText("swCertIssued", fmtWhen(cert?.issued_at));
    setText("swCertHash", shortHash(cert?.content_hash));
    const issueBtn = $("swIssueCertBtn");
    const viewBtn = $("swViewCertBtn");
    if (issueBtn) {
      issueBtn.disabled = !completed || !state.envelope?.id;
      issueBtn.textContent = cert?.id ? "Refresh Certificate" : "Generate Certificate";
    }
    if (viewBtn) viewBtn.disabled = !cert?.id;
  }

  function renderPdf() {
    const art = state.artifacts[0];
    const completed =
      String(state.envelope?.status || "").toLowerCase() === "completed";
    setText("swPdfStatus", art?.id ? "signed_pdf ready" : "None");
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
        ? "Generate Signed PDF (idempotent)"
        : "Generate Signed PDF";
    }
    if (openBtn) openBtn.disabled = !art?.download_url;
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
    const cert = state.certificates[0];
    const art = state.artifacts[0];
    const lines = [
      `project_id: ${state.project?.id || "—"}`,
      `package_id: ${state.package?.id || "—"}`,
      `envelope_id: ${state.envelope?.id || "—"}`,
      `delivery_status: ${state.delivery?.delivery_status || (isLinkReady() ? "prepared" : "—")}`,
      `invitation_ids: ${(state.delivery?.invitations || [])
        .map((i) => i.invitation_id)
        .filter(Boolean)
        .join(", ") || "—"}`,
      `certificate_id: ${cert?.id || "—"}`,
      `artifact_id: ${art?.id || "—"}`,
      `storage_ref: ${art?.storage_ref || "—"}`,
    ];
    setText("swDevIds", lines.join("\n"));
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
    showMain();
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
      state.envelopes = [];
      state.envelope = null;
      state.signingLink = null;
      state.delivery = null;
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
    state.envelope =
      state.envelopes.find((e) => String(e.id).toLowerCase() === want) ||
      active ||
      completed ||
      state.envelopes[0] ||
      null;
    // Policy A: never reconstruct raw link after reload; clear only on envelope change.
    if (!state.envelope?.id || String(state.envelope.id) !== String(prevEnvelopeId)) {
      if (String(state.envelope?.id || "") !== String(prevEnvelopeId)) {
        state.signingLink = null;
      }
    }
    if (!state.envelope?.id) {
      state.signingLink = null;
      state.delivery = null;
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

  async function loadCertificates(envelopeId) {
    if (!envelopeId) {
      state.certificates = [];
      return;
    }
    const res = await api(
      `${CERTS_API}?envelope_id=${encodeURIComponent(envelopeId)}`
    );
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not load certificates");
    }
    state.certificates = Array.isArray(res.data.certificates)
      ? res.data.certificates
      : [];
  }

  async function loadPdfs(envelopeId) {
    if (!envelopeId) {
      state.artifacts = [];
      return;
    }
    const res = await api(
      `${PDFS_API}?envelope_id=${encodeURIComponent(envelopeId)}`
    );
    if (!res.ok || res.data?.ok !== true) {
      throw new Error(res.data?.error || "Could not load signed PDFs");
    }
    state.artifacts = Array.isArray(res.data.artifacts) ? res.data.artifacts : [];
  }

  async function refreshEnvelopeChain() {
    await loadSigners(state.envelope?.id);
    await loadCertificates(state.envelope?.id);
    await loadPdfs(state.envelope?.id);
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
      toast("Signers are locked after send", "error");
      return;
    }
    const isEdit = !!existing?.id;
    openModal(
      isEdit ? "Edit Signer" : "Add Signer",
      `<div class="field"><label>Role</label>
        <select id="swFormRole">
          <option value="customer">customer</option>
          <option value="owner">owner</option>
          <option value="additional">additional</option>
        </select></div>
       <div class="field"><label>Name</label><input id="swFormName" /></div>
       <div class="field"><label>Email</label><input id="swFormEmail" type="email" /></div>
       <div class="field"><label>Phone</label><input id="swFormPhone" /></div>
       <div class="field"><label>Order</label><input id="swFormOrder" type="number" min="1" value="1" /></div>
       <div class="field"><label>Auth method</label>
        <select id="swFormMethod">
          <option value="email_link">email_link</option>
          <option value="in_app">in_app</option>
        </select></div>`,
      [
        btn("Cancel", "btn ghost", closeModal),
        btn(isEdit ? "Save" : "Create", "btn primary", async () => {
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
    }
  }

  function bindEvents() {
    $("swReloadBtn")?.addEventListener("click", () => {
      const id = $("swProjectSelect")?.value;
      if (id) void loadProjectWorkspace(id);
    });

    $("swProjectSelect")?.addEventListener("change", (ev) => {
      const id = ev.target.value;
      const project = state.projects.find((p) => p.id === id) || null;
      state.project = project;
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
      state.envelope = state.envelopes.find((e) => e.id === id) || null;
      try {
        await refreshEnvelopeChain();
        renderAll();
      } catch (err) {
        toast(err?.message || "Failed to open envelope", "error");
      }
    });

    $("swCreateEnvelopeBtn")?.addEventListener("click", async () => {
      if (!state.package?.id) return;
      try {
        const res = await api(ENVELOPE_CREATE_API, {
          method: "POST",
          body: JSON.stringify({ package_id: state.package.id }),
        });
        if (!res.ok || res.data?.ok !== true) {
          throw new Error(res.data?.error || "Create envelope failed");
        }
        toast("Signing request created", "ok");
        await loadEnvelopes(state.package.id);
        state.envelope = res.data.envelope || state.envelope;
        await refreshEnvelopeChain();
        renderAll();
      } catch (err) {
        toast(err?.message || "Create signing request failed", "error");
      }
    });

    $("swAddSignerBtn")?.addEventListener("click", () => openSignerModal(null));

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

    $("swViewFrozenBtn")?.addEventListener("click", () => {
      const pkg = state.package;
      if (!pkg) {
        toast("No frozen contract version selected", "error");
        return;
      }
      const readiness = pkg.source_readiness
        ? JSON.stringify(pkg.source_readiness, null, 2)
        : "—";
      openModal(
        "Frozen Contract Package",
        `<div class="sw-meta">
          <div class="sw-field"><div class="sw-field__k">Version</div><div class="sw-field__v">v${escapeHtml(pkg.version)}</div></div>
          <div class="sw-field"><div class="sw-field__k">Status</div><div class="sw-field__v">${escapeHtml(pkg.status)}</div></div>
          <div class="sw-field"><div class="sw-field__k">Created</div><div class="sw-field__v">${escapeHtml(fmtWhen(pkg.created_at))}</div></div>
        </div>
        <p class="sub">Content hash (immutable fingerprint of frozen snapshot):</p>
        <pre class="sw-mono">${escapeHtml(pkg.content_hash || "—")}</pre>
        <p class="sub">Source readiness (from package metadata — full snapshot_json is not returned by list API):</p>
        <pre>${escapeHtml(readiness)}</pre>
        <p class="sub">After completion, use Certificate + Signed PDF for the authoritative rendered contract.</p>`,
        [btn("Close", "btn primary", closeModal)]
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
          res.data.idempotent ? "Certificate already issued" : "Certificate issued",
          "ok"
        );
        await loadCertificates(state.envelope.id);
        renderAll();
      } catch (err) {
        toast(err?.message || "Certificate failed", "error");
      }
    });

    $("swViewCertBtn")?.addEventListener("click", () => {
      const cert = state.certificates[0];
      if (!cert) return;
      openModal(
        "Audit Certificate",
        `<div class="sw-meta">
          <div class="sw-field"><div class="sw-field__k">Number</div><div class="sw-field__v">${escapeHtml(cert.certificate_number)}</div></div>
          <div class="sw-field"><div class="sw-field__k">Issued</div><div class="sw-field__v">${escapeHtml(fmtWhen(cert.issued_at))}</div></div>
          <div class="sw-field"><div class="sw-field__k">Status</div><div class="sw-field__v">${escapeHtml(cert.status)}</div></div>
        </div>
        <p class="sub">Verification hash</p>
        <pre class="sw-mono">${escapeHtml(cert.content_hash || "—")}</pre>
        <p class="sub">Certificate JSON (evidence)</p>
        <pre>${escapeHtml(JSON.stringify(cert.certificate_json || {}, null, 2))}</pre>`,
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
          res.data.idempotent ? "Signed PDF already exists" : "Signed PDF generated",
          "ok"
        );
        await loadPdfs(state.envelope.id);
        renderAll();
      } catch (err) {
        toast(err?.message || "PDF generate failed", "error");
      }
    });

    $("swOpenPdfBtn")?.addEventListener("click", () => {
      const url = state.artifacts[0]?.download_url;
      if (!url) {
        toast("No signed URL — generate PDF first", "error");
        return;
      }
      window.open(url, "_blank", "noopener");
    });

    $("swModal")?.addEventListener("click", (ev) => {
      if (ev.target === $("swModal")) closeModal();
    });
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

    const params = new URLSearchParams(window.location.search);
    const projectId = String(params.get("project_id") || "").trim();
    if (projectId) {
      if (sel) sel.value = projectId;
      state.project =
        state.projects.find(
          (p) => String(p.id).toLowerCase() === projectId.toLowerCase()
        ) || null;
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
