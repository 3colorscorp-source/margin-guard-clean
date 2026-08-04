/**
 * CH-012B — Client signing experience (public portal UI).
 * APIs: contract-sign-public (GET), contract-sign (POST).
 * No session. Token in query only — never stored.
 */
(function () {
  "use strict";

  var NOTICE_LABELS = {
    contract: "Contract",
    payment: "Payment",
    change_order: "Change Order",
    cancellation: "Cancellation",
    warranty: "Warranty",
    limitation_of_liability: "Limitation of Liability",
    permit: "Permits",
    site_conditions: "Site Conditions",
    cleanup: "Cleanup",
    material: "Materials",
    dispute: "Dispute Resolution",
    force_majeure: "Force Majeure",
    governing_law: "Governing Law",
    additional_terms: "Additional Terms",
    contract_notice: "Contract",
    payment_notice: "Payment",
    change_order_notice: "Change Order",
    cancellation_notice: "Cancellation",
    warranty_notice: "Warranty",
    permit_notice: "Permits",
    site_conditions_notice: "Site Conditions",
    cleanup_notice: "Cleanup",
    material_notice: "Materials",
    dispute_notice: "Dispute Resolution",
    force_majeure_notice: "Force Majeure",
    governing_law_notice: "Governing Law",
  };

  function extractApprovedScopeText(rawNotes) {
    if (
      window.MarginGuardContractScope &&
      typeof window.MarginGuardContractScope.resolveContractScope === "function"
    ) {
      return window.MarginGuardContractScope.resolveContractScope({
        scope_of_work: rawNotes,
      });
    }
    var text = String(rawNotes == null ? "" : rawNotes);
    if (!String(text).trim()) {
      return { ok: false, text: "" };
    }
    text = text.replace(/^\uFEFF?\s*Scope of Work(?:\s+Draft)?\s*(?:\r?\n)+/i, "");
    var lines = text.split(/\r?\n/);
    if (lines.length && /^Scope of Work(?:\s+Draft)?\s*$/i.test(String(lines[0] || "").trim())) {
      lines.shift();
      while (lines.length && String(lines[0] || "").trim() === "") lines.shift();
      text = lines.join("\n");
    }
    if (!String(text).trim()) {
      return { ok: false, text: "" };
    }
    return { ok: true, text: text };
  }

  function renderApprovedScope(el, raw) {
    if (!el) return;
    var extracted = extractApprovedScopeText(raw);
    el.style.whiteSpace = "pre-wrap";
    if (extracted.ok) {
      el.textContent = extracted.text;
      return;
    }
    el.textContent =
      "Scope of Work is missing.\n\nThis contract cannot be completed until the approved quote contains a Scope of Work.";
  }

  var state = {
    token: "",
    payload: null,
    method: "typed",
    typedName: "",
    drawnPath: "",
    consent: false,
    busy: false,
    draw: null,
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function text(value) {
    var s = String(value == null ? "" : value).trim();
    return s ? escapeHtml(s) : "—";
  }

  function money(amount, currency) {
    var n = Number(amount);
    if (!Number.isFinite(n)) return "—";
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency || "USD",
      }).format(n);
    } catch (_e) {
      return String(n);
    }
  }

  function formatDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return escapeHtml(String(iso));
    return escapeHtml(
      d.toLocaleString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    );
  }

  function readTokenFromQuery() {
    try {
      return String(new URLSearchParams(window.location.search || "").get("token") || "").trim();
    } catch (_e) {
      return "";
    }
  }

  function branding(snap) {
    var b = (snap.business_settings && snap.business_settings.branding) || {};
    var lp = (snap.business_settings && snap.business_settings.legal_profile) || {};
    return {
      name: b.business_name || lp.legal_business_name || lp.dba_name || "Contractor",
      email: b.business_email || lp.business_email || "",
      phone: b.business_phone || lp.business_phone || "",
      address: b.business_address || "",
      logo: b.logo_url || "",
    };
  }

  function propertyLines(property) {
    if (!property) return "—";
    var parts = [
      property.address_line1,
      property.address_line2,
      [property.city, property.state, property.postal_code].filter(Boolean).join(", "),
    ].filter(Boolean);
    if (!parts.length && property.quote_project_address) parts.push(property.quote_project_address);
    if (!parts.length && property.quote_job_site) parts.push(property.quote_job_site);
    return parts.length ? escapeHtml(parts.join("\n")).replace(/\n/g, "<br>") : "—";
  }

  function renderNotices(legal) {
    var notices = (legal && legal.notices) || {};
    var enabled = (legal && legal.enabled) || {};
    var keys = Object.keys(notices);
    if (!keys.length) keys = Object.keys(NOTICE_LABELS);
    var html = "";
    var any = false;
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (enabled[key] === false) continue;
      var body = notices[key];
      if (body && typeof body === "object") body = body.text || body.body || body.content || "";
      if (body == null || String(body).trim() === "") continue;
      any = true;
      html +=
        '<div class="cs-notice"><strong>' +
        escapeHtml(NOTICE_LABELS[key] || key.replace(/_/g, " ")) +
        '</strong><div class="cs-prose">' +
        escapeHtml(String(body)) +
        "</div></div>";
    }
    return any ? html : '<p class="cs-lead">No legal notices in this package.</p>';
  }

  function renderSchedule(schedule) {
    var items = (schedule && schedule.items) || [];
    if (!items.length) return '<p class="cs-lead">No payment schedule items.</p>';
    var rows = items
      .map(function (item) {
        var amt =
          item.amount != null
            ? item.amount
            : item.percentage != null
              ? item.percentage + "%"
              : "";
        return (
          "<tr><td>" +
          text(item.sequence_number) +
          "</td><td>" +
          text(item.label || item.payment_type) +
          "</td><td>" +
          text(amt) +
          "</td><td>" +
          text(item.due_rule || item.milestone_description || item.fixed_due_date) +
          "</td></tr>"
        );
      })
      .join("");
    return (
      '<table class="cs-table"><thead><tr><th>#</th><th>Item</th><th>Amount</th><th>Due</th></tr></thead><tbody>' +
      rows +
      "</tbody></table>"
    );
  }

  function renderContractSchedule(snap) {
    var cs = (snap && snap.contract_schedule) || {};
    var start =
      cs.estimated_start_date ||
      (snap && snap.quote && snap.quote.start_date) ||
      "";
    var due =
      cs.estimated_completion_date ||
      (snap && snap.quote && snap.quote.due_date) ||
      "";
    function fmt(ymd) {
      var s = String(ymd || "").trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "—";
      try {
        var d = new Date(s + "T12:00:00");
        return d.toLocaleDateString(undefined, { dateStyle: "medium" });
      } catch (_e) {
        return s;
      }
    }
    return (
      '<div class="cs-grid">' +
      '<div class="cs-kv"><span class="k">Estimated Start Date</span><span class="v">' +
      text(fmt(start)) +
      "</span></div>" +
      '<div class="cs-kv"><span class="k">Estimated Completion Date</span><span class="v">' +
      text(fmt(due)) +
      "</span></div></div>"
    );
  }

  function errorCopy(code) {
    var map = {
      invalid_token: {
        title: "Link unavailable",
        message: "This signing link is invalid or no longer available.",
      },
      expired: {
        title: "Link expired",
        message: "This signing link has expired. Please ask the contractor for a new link.",
      },
      revoked: {
        title: "Link revoked",
        message: "This signing link was revoked and can no longer be used.",
      },
      consumed: {
        title: "Already signed",
        message: "This signing link was already used. Your signature may already be on file.",
      },
      signature_already_recorded: {
        title: "Already signed",
        message: "A signature is already recorded for this signing link.",
      },
      envelope_completed: {
        title: "Contract completed",
        message: "This contract has already been fully signed and completed.",
      },
      envelope_cancelled: {
        title: "Contract cancelled",
        message: "This contract was cancelled and is no longer available for signing.",
      },
      envelope_declined: {
        title: "Contract declined",
        message: "This contract was declined and is no longer available for signing.",
      },
      envelope_expired: {
        title: "Contract expired",
        message: "This contract envelope has expired.",
      },
      package_void: {
        title: "Contract unavailable",
        message: "This contract package is void.",
      },
      package_superseded: {
        title: "Updated contract available",
        message: "This contract version was replaced. Ask the contractor for the current link.",
      },
      consent_required: {
        title: "Consent required",
        message: "You must agree to sign electronically before continuing.",
      },
      missing_consent: {
        title: "Consent required",
        message: "You must agree to sign electronically before continuing.",
      },
    };
    return (
      map[code] || {
        title: "Unable to continue",
        message: "This signing link is invalid or unavailable.",
      }
    );
  }

  function showError(title, message) {
    var app = document.getElementById("app");
    app.innerHTML =
      '<div class="cs-error" role="alert">' +
      '<div class="cs-error__icon" aria-hidden="true">!</div>' +
      "<h1>" +
      escapeHtml(title) +
      "</h1>" +
      "<p>" +
      escapeHtml(message) +
      "</p>" +
      "</div>";
    document.title = title;
  }

  function showSuccess(result) {
    var c = (state.payload && state.payload.contract) || {};
    var signer = (result && result.signer) || c.signer || {};
    var signedAt = (signer && signer.signed_at) || new Date().toISOString();
    var method = state.method === "drawn" ? "Drawn" : "Typed";
    var completed =
      result &&
      result.envelope &&
      String(result.envelope.status || "").toLowerCase() === "completed";
    var certHint = completed
      ? "Your contractor can provide the audit certificate and official signed PDF from their workspace."
      : "Additional signers may still need to sign before the contract is fully complete.";

    var app = document.getElementById("app");
    app.innerHTML =
      '<div class="cs-success" id="csSuccess">' +
      '<div class="cs-success__mark" aria-hidden="true">✓</div>' +
      "<h1>Contract signed</h1>" +
      "<p>Thank you. Your electronic signature has been securely recorded.</p>" +
      '<div class="cs-success__panel">' +
      '<div class="cs-kv"><span class="k">Signer</span><span class="v">' +
      text(signer.party_name) +
      "</span></div>" +
      '<div class="cs-kv"><span class="k">Method</span><span class="v">' +
      text(method) +
      "</span></div>" +
      '<div class="cs-kv"><span class="k">Signed</span><span class="v">' +
      formatDate(signedAt) +
      "</span></div>" +
      '<div class="cs-kv"><span class="k">Certificate</span><span class="v">Issued by contractor after completion</span></div>' +
      "<p class=\"cs-lead\" style=\"margin-top:8px\">" +
      escapeHtml(certHint) +
      "</p>" +
      "</div>" +
      '<div class="cs-actions" style="justify-content:center;margin-top:18px">' +
      '<button type="button" class="cs-btn cs-btn--primary" id="btnDownloadPdf">Download Signed PDF</button>' +
      '<button type="button" class="cs-btn no-print" id="btnPrintSuccess">Print confirmation</button>' +
      "</div>" +
      '<p class="cs-lead" style="margin-top:12px">Use Download / Print and choose “Save as PDF” to keep your signed confirmation.</p>' +
      "</div>";

    document.title = "Contract signed";
    document.getElementById("btnDownloadPdf").addEventListener("click", function () {
      window.print();
    });
    document.getElementById("btnPrintSuccess").addEventListener("click", function () {
      window.print();
    });
  }

  function canSubmit() {
    if (!state.consent) return false;
    if (state.method === "typed") return String(state.typedName || "").trim().length > 0;
    return String(state.drawnPath || "").trim().length > 0;
  }

  function updateSubmitState() {
    var btn = document.getElementById("btnSignContract");
    if (btn) btn.disabled = state.busy || !canSubmit();
    var preview = document.getElementById("typedPreview");
    if (preview) {
      var name = String(state.typedName || "").trim();
      preview.textContent = name || "Your signature preview";
      preview.style.opacity = name ? "1" : "0.45";
    }
  }

  function setToast(message, kind) {
    var el = document.getElementById("csToast");
    if (!el) return;
    el.className = "cs-toast" + (kind ? " is-" + kind : "");
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";
  }

  function setupDrawPad(canvas) {
    if (!canvas) return null;
    var ctx = canvas.getContext("2d");
    var drawing = false;
    var points = [];
    var strokes = [];

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#122033";
      redraw();
    }

    function redraw() {
      var rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      for (var s = 0; s < strokes.length; s++) {
        var stroke = strokes[s];
        if (!stroke.length) continue;
        ctx.beginPath();
        ctx.moveTo(stroke[0].x, stroke[0].y);
        for (var i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
        ctx.stroke();
      }
    }

    function pos(ev) {
      var rect = canvas.getBoundingClientRect();
      var src = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
      return { x: src.clientX - rect.left, y: src.clientY - rect.top };
    }

    function start(ev) {
      ev.preventDefault();
      drawing = true;
      points = [pos(ev)];
      strokes.push(points);
    }

    function move(ev) {
      if (!drawing) return;
      ev.preventDefault();
      points.push(pos(ev));
      redraw();
    }

    function end(ev) {
      if (!drawing) return;
      ev.preventDefault();
      drawing = false;
      state.drawnPath = toSvgPath(strokes);
      updateSubmitState();
    }

    function toSvgPath(all) {
      var d = [];
      for (var s = 0; s < all.length; s++) {
        var stroke = all[s];
        if (!stroke.length) continue;
        d.push("M " + stroke[0].x.toFixed(1) + " " + stroke[0].y.toFixed(1));
        for (var i = 1; i < stroke.length; i++) {
          d.push("L " + stroke[i].x.toFixed(1) + " " + stroke[i].y.toFixed(1));
        }
      }
      return d.join(" ");
    }

    canvas.addEventListener("mousedown", start);
    canvas.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
    canvas.addEventListener("touchstart", start, { passive: false });
    canvas.addEventListener("touchmove", move, { passive: false });
    canvas.addEventListener("touchend", end, { passive: false });
    window.addEventListener("resize", resize);
    resize();

    return {
      clear: function () {
        strokes = [];
        points = [];
        state.drawnPath = "";
        redraw();
        updateSubmitState();
      },
      resize: resize,
    };
  }

  function renderPortal(payload) {
    state.payload = payload;
    var c = payload.contract || {};
    var snap = c.snapshot || {};
    var biz = branding(snap);
    var customer = snap.customer || {};
    var project = snap.project || {};
    var property = snap.property || {};
    var price = snap.price || {};
    var scope = snap.scope || {};
    var warranty = snap.warranty || {};
    var terms = snap.terms || {};
    var legal = snap.legal_notices || {};
    var pkg = c.package || {};
    var env = c.envelope || {};
    var signer = c.signer || {};
    var title = (snap.quote && snap.quote.title) || "Service Contract";

    state.typedName = String(signer.party_name || "").trim();
    document.title = biz.name + " — Sign contract";

    var logoHtml = biz.logo
      ? '<img class="cs-logo" alt="" src="' + escapeHtml(biz.logo) + '" />'
      : '<div class="cs-logo cs-logo--fallback" aria-hidden="true">' +
        escapeHtml(String(biz.name || "C").charAt(0).toUpperCase()) +
        "</div>";

    var warrantyText = [];
    if (warranty.duration_value && warranty.duration_unit) {
      warrantyText.push(String(warranty.duration_value) + " " + String(warranty.duration_unit));
    }
    if (warranty.summary) warrantyText.push(String(warranty.summary));

    var app = document.getElementById("app");
    app.innerHTML =
      '<div class="cs-shell">' +
      '<header class="cs-top" id="step-identity">' +
      logoHtml +
      "<div>" +
      '<p class="cs-biz">' +
      text(biz.name) +
      "</p>" +
      '<p class="cs-title">' +
      text(title) +
      "</p>" +
      '<div class="cs-meta">' +
      '<span class="cs-chip">Version ' +
      text(pkg.version) +
      "</span>" +
      '<span class="cs-chip cs-chip--ok">' +
      text(env.status || "Ready to sign") +
      "</span>" +
      '<span class="cs-chip">Signer · ' +
      text(signer.party_name) +
      "</span>" +
      '<span class="cs-chip">' +
      text(signer.email) +
      "</span>" +
      '<span class="cs-chip">Project · ' +
      text(project.name) +
      "</span>" +
      "</div></div></header>" +
      '<div class="cs-steps no-print" role="tablist" aria-label="Signing steps">' +
      '<button type="button" class="cs-step-pill is-active" data-jump="step-identity">1 Identity</button>' +
      '<button type="button" class="cs-step-pill" data-jump="step-contract">2 Contract</button>' +
      '<button type="button" class="cs-step-pill" data-jump="step-esign">3 E-Sign</button>' +
      '<button type="button" class="cs-step-pill" data-jump="step-signature">4 Signature</button>' +
      '<button type="button" class="cs-step-pill" data-jump="step-review">5 Review</button>' +
      "</div>" +
      '<div class="cs-layout">' +
      '<nav class="cs-nav no-print" aria-label="Contract sections">' +
      '<a href="#sec-parties">Parties</a>' +
      '<a href="#sec-scope">Scope</a>' +
      '<a href="#sec-price">Price</a>' +
      '<a href="#sec-schedule">Schedule</a>' +
      '<a href="#sec-warranty">Warranty</a>' +
      '<a href="#sec-terms">Terms</a>' +
      '<a href="#sec-legal">Legal</a>' +
      '<a href="#step-esign">Sign</a>' +
      "</nav>" +
      '<div class="cs-main">' +
      '<section class="cs-card" id="step-contract">' +
      "<h2>Contract</h2>" +
      '<p class="cs-lead">Please review the full agreement before signing.</p>' +
      '<div id="sec-parties">' +
      '<p class="cs-section-label">Customer / Project / Property</p>' +
      '<div class="cs-grid">' +
      '<div class="cs-kv"><span class="k">Customer</span><span class="v">' +
      text(customer.name) +
      "</span></div>" +
      '<div class="cs-kv"><span class="k">Email</span><span class="v">' +
      text(customer.email) +
      "</span></div>" +
      '<div class="cs-kv"><span class="k">Phone</span><span class="v">' +
      text(customer.phone) +
      "</span></div>" +
      '<div class="cs-kv"><span class="k">Project</span><span class="v">' +
      text(project.name) +
      "</span></div>" +
      '<div class="cs-kv" style="grid-column:1/-1"><span class="k">Property</span><span class="v">' +
      propertyLines(property) +
      "</span></div></div></div>" +
      '<div id="sec-scope" style="margin-top:18px">' +
      '<p class="cs-section-label">SCOPE OF WORK</p>' +
      '<div class="cs-prose" id="scopeText" style="white-space:pre-wrap;"></div></div>' +
      '<div id="sec-price" style="margin-top:18px">' +
      '<p class="cs-section-label">Price</p>' +
      '<div class="cs-grid">' +
      '<div class="cs-kv"><span class="k">Contract total</span><span class="v">' +
      escapeHtml(money(price.contract_total, price.currency)) +
      '</span></div>' +
      '<div class="cs-kv"><span class="k">Deposit required</span><span class="v">' +
      escapeHtml(money(price.deposit_required, price.currency)) +
      "</span></div></div></div>" +
      '<div id="sec-contract-schedule" style="margin-top:18px">' +
      '<p class="cs-section-label">Estimated Schedule</p>' +
      renderContractSchedule(snap) +
      "</div>" +
      '<div id="sec-schedule" style="margin-top:18px">' +
      '<p class="cs-section-label">Payment Schedule</p>' +
      renderSchedule(snap.payment_schedule) +
      "</div>" +
      '<div id="sec-warranty" style="margin-top:18px">' +
      '<p class="cs-section-label">Warranty</p>' +
      '<div class="cs-prose" id="warrantyText"></div>' +
      '<div id="warrantyExclusions"></div></div>' +
      '<div id="sec-terms" style="margin-top:18px">' +
      '<p class="cs-section-label">Terms</p>' +
      '<div class="cs-prose" id="termsText"></div></div>' +
      '<div id="sec-legal" style="margin-top:18px">' +
      '<p class="cs-section-label">Legal Notices</p>' +
      '<div id="legalNotices"></div></div>' +
      "</section>" +
      '<section class="cs-card" id="step-esign">' +
      "<h2>Electronic signature consent</h2>" +
      '<p class="cs-lead">Before signing, confirm you agree to use an electronic signature.</p>' +
      '<label class="cs-consent">' +
      '<input type="checkbox" id="consentEsign" />' +
      "<div><strong>I agree to sign this contract electronically.</strong>" +
      "<p>I understand that my electronic signature has the same legal effect as a handwritten signature and creates a binding agreement between the parties under applicable electronic signature laws.</p>" +
      "</div></label></section>" +
      '<section class="cs-card" id="step-signature">' +
      "<h2>Your signature</h2>" +
      '<p class="cs-lead">Choose typed or drawn signature.</p>' +
      '<div class="cs-tabs" role="tablist">' +
      '<button type="button" class="cs-tab is-active" data-method="typed" id="tabTyped">Typed</button>' +
      '<button type="button" class="cs-tab" data-method="drawn" id="tabDrawn">Draw</button>' +
      "</div>" +
      '<div id="paneTyped">' +
      '<div class="cs-field"><label for="typedName">Type your full legal name</label>' +
      '<input id="typedName" autocomplete="name" maxlength="120" /></div>' +
      '<div class="cs-preview" aria-live="polite"><div class="cs-preview__sig" id="typedPreview"></div></div>' +
      "</div>" +
      '<div id="paneDrawn" hidden>' +
      '<div class="cs-canvas-wrap"><canvas id="drawCanvas" width="800" height="180" aria-label="Signature drawing pad"></canvas></div>' +
      '<div class="cs-actions"><button type="button" class="cs-btn" id="btnClearDraw">Clear</button></div>' +
      "</div></section>" +
      '<section class="cs-card" id="step-review">' +
      "<h2>Review</h2>" +
      '<p class="cs-lead">Confirm details before submitting your signature.</p>' +
      '<div class="cs-review">' +
      '<div class="cs-kv"><span class="k">Signer</span><span class="v" id="revSigner"></span></div>' +
      '<div class="cs-kv"><span class="k">Method</span><span class="v" id="revMethod">Typed</span></div>' +
      '<div class="cs-kv"><span class="k">Date</span><span class="v">' +
      formatDate(new Date().toISOString()) +
      "</span></div>" +
      '<div class="cs-kv"><span class="k">Consent</span><span class="v" id="revConsent">Not yet agreed</span></div>' +
      "</div>" +
      '<div class="cs-toast" id="csToast" role="status"></div>' +
      "</section>" +
      '<div class="cs-footer-bar no-print">' +
      '<button type="button" class="cs-btn" id="btnPrint">Print contract</button>' +
      '<button type="button" class="cs-btn cs-btn--primary" id="btnSignContract" disabled>Sign Contract</button>' +
      "</div>" +
      "</div></div></div>";

    renderApprovedScope(document.getElementById("scopeText"), scope.text);
    document.getElementById("warrantyText").textContent = warrantyText.length
      ? warrantyText.join("\n")
      : "—";
    var excl = document.getElementById("warrantyExclusions");
    if (warranty.exclusions) {
      excl.innerHTML =
        '<p class="cs-lead" style="margin-top:8px">Exclusions</p><div class="cs-prose"></div>';
      excl.querySelector(".cs-prose").textContent = String(warranty.exclusions);
    }
    document.getElementById("termsText").textContent = terms.quote_terms
      ? String(terms.quote_terms)
      : "—";
    document.getElementById("legalNotices").innerHTML = renderNotices(legal);

    var typedInput = document.getElementById("typedName");
    typedInput.value = state.typedName;
    document.getElementById("revSigner").textContent = state.typedName || signer.party_name || "—";

    state.draw = setupDrawPad(document.getElementById("drawCanvas"));

    document.querySelectorAll("[data-jump]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-jump");
        var el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        document.querySelectorAll(".cs-step-pill").forEach(function (p) {
          p.classList.toggle("is-active", p === btn);
        });
      });
    });

    document.getElementById("consentEsign").addEventListener("change", function (ev) {
      state.consent = !!ev.target.checked;
      document.getElementById("revConsent").textContent = state.consent
        ? "Agreed to electronic signature"
        : "Not yet agreed";
      updateSubmitState();
    });

    typedInput.addEventListener("input", function (ev) {
      state.typedName = ev.target.value;
      document.getElementById("revSigner").textContent =
        String(state.typedName || "").trim() || signer.party_name || "—";
      updateSubmitState();
    });

    function setMethod(method) {
      state.method = method;
      document.getElementById("tabTyped").classList.toggle("is-active", method === "typed");
      document.getElementById("tabDrawn").classList.toggle("is-active", method === "drawn");
      document.getElementById("paneTyped").hidden = method !== "typed";
      document.getElementById("paneDrawn").hidden = method !== "drawn";
      document.getElementById("revMethod").textContent = method === "drawn" ? "Drawn" : "Typed";
      if (method === "drawn" && state.draw) state.draw.resize();
      updateSubmitState();
    }

    document.getElementById("tabTyped").addEventListener("click", function () {
      setMethod("typed");
    });
    document.getElementById("tabDrawn").addEventListener("click", function () {
      setMethod("drawn");
    });
    document.getElementById("btnClearDraw").addEventListener("click", function () {
      if (state.draw) state.draw.clear();
    });
    document.getElementById("btnPrint").addEventListener("click", function () {
      window.print();
    });
    document.getElementById("btnSignContract").addEventListener("click", submitSignature);

    updateSubmitState();
  }

  async function submitSignature() {
    if (state.busy || !canSubmit()) return;
    setToast("");
    var env = ((state.payload || {}).contract || {}).envelope || {};
    var expected = env.updated_at;
    if (!expected) {
      setToast("Unable to sign right now. Please refresh the page and try again.", "error");
      return;
    }

    var body = {
      signing_token: state.token,
      signature_method: state.method,
      consent_esign: true,
      expected_updated_at: expected,
      signature_payload:
        state.method === "typed"
          ? {
              typed_name: String(state.typedName || "").trim(),
              rendered_name: String(state.typedName || "").trim(),
            }
          : {
              format: "svg_path",
              svg_path: state.drawnPath,
            },
    };

    state.busy = true;
    updateSubmitState();
    setToast("Recording your signature…", "ok");

    try {
      var res = await fetch("/.netlify/functions/contract-sign", {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = {};
      try {
        data = await res.json();
      } catch (_e) {
        data = {};
      }

      if (!res.ok || !data.ok) {
        var copy = errorCopy(data.code);
        if (data.code === "consent_required" || data.code === "missing_consent") {
          setToast(copy.message, "error");
        } else if (
          data.code === "signature_already_recorded" ||
          data.code === "consumed" ||
          data.code === "envelope_completed"
        ) {
          showError(copy.title, data.error || copy.message);
        } else {
          setToast(data.error || copy.message, "error");
        }
        state.busy = false;
        updateSubmitState();
        return;
      }

      showSuccess(data);
    } catch (_err) {
      setToast("Could not submit signature. Check your connection and try again.", "error");
      state.busy = false;
      updateSubmitState();
    }
  }

  async function main() {
    var token = readTokenFromQuery();
    state.token = token;
    if (!token) {
      showError("Missing link", "This signing link is incomplete. Please use the link from your contractor.");
      return;
    }

    var res;
    try {
      res = await fetch(
        "/.netlify/functions/contract-sign-public?token=" + encodeURIComponent(token),
        { method: "GET", credentials: "omit", cache: "no-store" }
      );
    } catch (_e) {
      showError("Unavailable", "Could not load this contract. Try again later.");
      return;
    }

    var data = {};
    try {
      data = await res.json();
    } catch (_e2) {
      data = {};
    }

    if (!res.ok || !data.ok) {
      var copy = errorCopy(data.code);
      showError(copy.title, data.error || copy.message);
      return;
    }

    renderPortal(data);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
