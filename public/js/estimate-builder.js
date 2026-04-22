(function () {
  const $ = (id) => document.getElementById(id);

  function getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  /** TEMPORARY: remove after confirming public estimate header / tenant name. */
  function isEstimateDebugMode() {
    return getQueryParam("debug") === "1";
  }

  function logEstimateDebug(stage, payload) {
    if (!isEstimateDebugMode()) return;
    console.log(`[mg-estimate-debug] ${stage}`, payload);
  }

  function money(value, currency = "USD") {
    const amount = Number(value || 0);
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency || "USD"
      }).format(amount);
    } catch {
      return `$${amount.toFixed(2)}`;
    }
  }

  function safe(v) {
    return String(v || "").trim();
  }

  /** Skip quote-row placeholder so tenant_branding_* can be used (matches get-public-estimate). */
  function skipHeaderPlaceholderName(value) {
    const t = String(value ?? "").trim();
    if (!t) return "";
    if (/^business$/i.test(t)) return "";
    return t;
  }

  function escapeHtml(v) {
    return String(v || "").replace(/[&<>"']/g, (m) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[m])
    );
  }

  /** Known mailbox hosts / brands — never use as public business title when stored wrongly on the quote row. */
  const MAILBOX_BRAND_TOKENS = new Set([
    "gmail",
    "googlemail",
    "yahoo",
    "ymail",
    "outlook",
    "hotmail",
    "live",
    "msn",
    "icloud",
    "aol",
    "protonmail",
    "proton",
    "zoho",
    "fastmail",
    "gmx",
    "yandex",
    "hey"
  ]);

  function looksLikeEmailAddress(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());
  }

  function looksLikeDomainOnly(s) {
    return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(String(s).trim());
  }

  /**
   * Rejects unsafe title values only: email-shaped strings, mailbox brands, pure domains,
   * or a candidate that is exactly a contact email. Does not reject normal company names.
   */
  function isInvalidBusinessDisplayName(candidate, ctx) {
    const raw = String(candidate || "").trim();
    if (!raw) return true;
    if (raw.includes("@") || looksLikeEmailAddress(raw)) return true;
    const lower = raw.toLowerCase();
    const beFull = String(ctx?.business_email || "").trim().toLowerCase();
    const ceFull = String(ctx?.client_email || "").trim().toLowerCase();
    if (beFull && lower === beFull) return true;
    if (ceFull && lower === ceFull) return true;
    if (MAILBOX_BRAND_TOKENS.has(lower)) return true;
    if (looksLikeDomainOnly(raw)) return true;
    return false;
  }

  /**
   * Multi-tenant public header: quote owner fields first, then tenant branding for that quote's tenant only.
   * Order: quote business_name → quote company_name → tenant branding business_name → tenant branding company_name → "Business".
   * Does not use business_email, client email, domains, or generic contact-derived text as the title.
   */
  function resolvePublicBusinessDisplayName(est) {
    const ctx = {
      business_email: safe(est.business_email),
      client_email: safe(est.client_email)
    };
    const businessName = skipHeaderPlaceholderName(safe(est.business_name));
    const companyName = skipHeaderPlaceholderName(safe(est.company_name));
    const tenantBrandingBusiness = safe(est.tenant_branding_business_name);
    const tenantBrandingCompany = safe(est.tenant_branding_company_name);
    const candidates = [
      businessName,
      companyName,
      tenantBrandingBusiness,
      tenantBrandingCompany
    ];
    let resolved = "Business";
    for (const c of candidates) {
      if (!isInvalidBusinessDisplayName(c, ctx)) {
        resolved = c;
        break;
      }
    }
    return resolved;
  }

  function buildInitialsFromBusinessName(name) {
    const words = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return "B";
    return words
      .map((w) => w.charAt(0))
      .join("")
      .slice(0, 3)
      .toUpperCase();
  }

  /**
   * Public header image URLs (Supabase Storage, CDN). Accepts absolute http(s) and scheme-relative //...
   */
  function safeHttpUrl(url) {
    let s = String(url ?? "").trim();
    if (!s) return "";
    if (s.startsWith("//")) s = `https:${s}`;
    try {
      const u = new URL(s);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
    } catch (_e) {
      if (/^https?:\/\//i.test(s)) return s;
    }
    return "";
  }

  function getPublicFlowStep() {
    const raw = getQueryParam("step");
    const n = parseInt(raw || "1", 10);
    if (!Number.isFinite(n)) return 1;
    return Math.min(4, Math.max(1, n));
  }

  function setPublicFlowNavHref(token) {
    const t = encodeURIComponent(token || "");
    const base = `${window.location.pathname}?token=${t}`;
    const n1 = $("flowNav1");
    const n2 = $("flowNav2");
    const n3 = $("flowNav3");
    const nOpt = $("flowNavOptionalWork");
    if (n1) n1.href = `${base}&step=1`;
    if (n2) n2.href = `${base}&step=2`;
    if (n3) n3.href = `${base}&step=3`;
    if (nOpt) nOpt.href = `${base}&step=4`;
  }

  function applyPublicFlowStep(step) {
    const s1 = $("publicFlowStep1");
    const s2 = $("publicFlowStep2");
    const s3 = $("publicFlowStep3");
    const optWrap = $("publicFlowOptionalWrap");
    const metaEl = $("publicEstimateMeta");
    if (s1) s1.style.display = step === 1 ? "" : "none";
    if (s2) s2.style.display = step === 2 ? "" : "none";
    if (s3) s3.style.display = step === 3 ? "" : "none";
    if (optWrap) optWrap.style.display = step === 4 ? "" : "none";
    if (metaEl && step !== 1) {
      const labels = {
        2: "Step 2 of 3 — exclusions acknowledgment.",
        3: "Step 3 of 3 — additional work & change orders.",
        4: "Optional — request additional work."
      };
      metaEl.textContent = labels[step] || "";
    }
  }

  const FIXED_EXCLUSIONS_FALLBACK = [
    "Only the work specifically described in this written estimate is included in the project scope.",
    "",
    "Any additional work, hidden or unforeseen conditions (including but not limited to substrate deficiencies, structural issues, plumbing, electrical, or site conditions), repairs, upgrades, modifications, or client-requested changes that are not explicitly listed in this estimate are excluded.",
    "",
    "Verbal discussions, assumptions, or informal requests do not constitute approval or inclusion in the scope of work unless documented and approved in writing.",
    "",
    "All changes, additions, or deviations from the original scope require a separate written agreement (change order), including updated pricing and timeline adjustments.",
    "",
    "No additional or extra work will be performed without prior written authorization from the client.",
    "",
    "Such changes may result in adjustments to the total project cost and completion schedule."
  ].join("\n");

  /**
   * Step 2 body must never use quote `notes` (outbound email / message copy from publish).
   * Source order: optional explicit exclusions field on estimate → sanitized `terms` → fixed fallback.
   */
  function sanitizeExclusionsStep2Content(raw) {
    let t = String(raw ?? "").replace(/\r\n/g, "\n");
    t = t
      .replace(/\[PUBLIC_QUOTE_URL\]/gi, "")
      .replace(/\[public_quote_url\]/gi, "")
      .replace(/\[PUBLIC QUOTE URL\]/gi, "");

    const lines = t.split("\n");
    const kept = [];
    for (const line of lines) {
      const s = line.trim();
      if (!s) {
        kept.push("");
        continue;
      }
      if (/^\[PUBLIC_QUOTE_URL\]/i.test(s)) continue;
      if (/^hi\s+/i.test(s)) continue;
      if (/thank you for the opportunity/i.test(s)) continue;
      if (/your project estimate is attached/i.test(s)) continue;
      if (/\bwhen you're ready\b/i.test(s)) continue;
      if (/^thank you,?\s*$/i.test(s)) continue;
      if (/^thanks,?\s*$/i.test(s)) continue;
      if (/^(best|regards|sincerely|warm regards|kind regards|cheers),?\s*$/i.test(s)) continue;
      if (
        /^(gmail|yahoo|yahoo mail|outlook|hotmail|icloud|aol|protonmail|zoho|fastmail)$/i.test(s)
      ) {
        continue;
      }
      if (/sent from my (iphone|ipad|android)/i.test(s)) continue;
      if (/^-+original message-+/i.test(s)) continue;
      if (/^unsubscribe/i.test(s)) continue;
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) continue;
      kept.push(line);
    }

    let out = kept.join("\n");
    out = out.replace(/\n{3,}/g, "\n\n").trim();
    return out;
  }

  function exclusionsStep2BodyLooksLikeEmailScrap(text) {
    const t = String(text || "").trim();
    if (t.length < 28) return true;
    if (/\[PUBLIC_QUOTE_URL\]/i.test(t)) return true;
    if (/^\s*hi\s+[A-Za-z]/.test(t)) return true;
    const ats = t.match(/@/g);
    if (ats && ats.length >= 2) return true;
    if (/view (this )?estimate (at|on|here)/i.test(t)) return true;
    if (/attached (as|below|for your review)/i.test(t)) return true;
    if (/click (here|below|the link)/i.test(t)) return true;
    return false;
  }

  function buildExclusionsDisplayText(next) {
    const explicit =
      safe(next.exclusions_text) ||
      safe(next.exclusionsText) ||
      safe(next.exclusions_acknowledgment_text) ||
      safe(next.exclusionsAcknowledgmentText);

    const termsOnly = safe(next.terms);

    let source = "";
    if (explicit) {
      const exSan = sanitizeExclusionsStep2Content(explicit);
      if (exSan && !exclusionsStep2BodyLooksLikeEmailScrap(exSan)) {
        source = exSan;
      }
    }
    if (!source && termsOnly) {
      const tSan = sanitizeExclusionsStep2Content(termsOnly);
      if (tSan && !exclusionsStep2BodyLooksLikeEmailScrap(tSan)) {
        source = tSan;
      }
    }

    if (!source) {
      return FIXED_EXCLUSIONS_FALLBACK;
    }
    return source;
  }

  function renderPublicExclusionsStep2Attribution(next) {
    const el = $("publicExclusionsBusinessLabel");
    if (!el) return;
    const name = resolvePublicBusinessDisplayName(next);
    if (!name || name === "Business") {
      el.textContent = "";
      el.style.display = "none";
      return;
    }
    el.textContent = `Provided by ${name}`;
    el.style.display = "block";
  }

  function formatPublicAckTime(iso) {
    const s = safe(iso);
    if (!s) return "";
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short"
      }).format(d);
    } catch {
      return s;
    }
  }

  function showFlowPanelNotice(elId, message, type = "info") {
    const box = $(elId);
    if (!box) return;
    if (!message) {
      box.style.display = "none";
      box.textContent = "";
      return;
    }
    box.style.display = "block";
    box.textContent = message;
    box.style.border = "1px solid rgba(255,255,255,.12)";
    box.style.background = "rgba(255,255,255,.04)";
    box.style.color = "#fff";
    if (type === "success") {
      box.style.border = "1px solid rgba(16,185,129,.55)";
      box.style.background = "rgba(16,185,129,.10)";
      box.style.color = "#eafff7";
    }
    if (type === "error") {
      box.style.border = "1px solid rgba(239,68,68,.55)";
      box.style.background = "rgba(239,68,68,.10)";
      box.style.color = "#ffecec";
    }
  }

  async function patchPublicQuoteAck(token, payload) {
    const response = await fetch("/.netlify/functions/patch-public-quote-ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || "Could not save acknowledgment.");
    }
    return data;
  }

  function changeRequestSubmittedStorageKey(tok) {
    return `mg_crq_submitted_${tok || ""}`;
  }

  function updatePublicWorkflowBadges(next) {
    const b1 = $("flowStepBadge1");
    const b2 = $("flowStepBadge2");
    const b3 = $("flowStepBadge3");
    const b4 = $("flowStepBadge4");
    const step1 = safe(next.accepted_at) !== "";
    const step2 =
      safe(next.exclusions_initials) !== "" &&
      safe(next.exclusions_acknowledged_at) !== "";
    const step3 = safe(next.change_order_acknowledged_at) !== "";
    const tok = getQueryParam("token") || "";
    const step4 =
      tok && sessionStorage.getItem(changeRequestSubmittedStorageKey(tok)) === "1";
    if (b1) b1.textContent = step1 ? "✔" : "";
    if (b2) b2.textContent = step2 ? "✔" : "";
    if (b3) b3.textContent = step3 ? "✔" : "";
    if (b4) b4.textContent = step4 ? "✔" : "";
  }

  function setupPublicChangeRequestStep(token, estimateSnapshot) {
    const formWrap = $("publicChangeRequestFormWrap");
    const titleEl = $("publicChangeRequestTitle");
    const descEl = $("publicChangeRequestDescription");
    const areaEl = $("publicChangeRequestArea");
    const timingEl = $("publicChangeRequestTiming");
    const btn = $("btnSubmitChangeRequest");
    const ok = $("publicChangeRequestSuccess");
    const submitted =
      token && sessionStorage.getItem(changeRequestSubmittedStorageKey(token)) === "1";

    if (formWrap) {
      formWrap.style.display = submitted ? "none" : "";
    }
    if (ok) {
      ok.style.display = submitted ? "block" : "none";
    }
    [titleEl, descEl, areaEl, timingEl].forEach((el) => {
      if (el) el.disabled = !!submitted;
    });
    if (btn) {
      btn.disabled = !!submitted;
      btn.textContent = "Submit change order request";
    }

    if (!btn || !token || submitted) {
      return;
    }

    btn.onclick = async () => {
      showFlowPanelNotice("publicChangeRequestFeedback", "", "info");
      const request_title = safe(titleEl?.value);
      const request_description = safe(descEl?.value);
      const request_area = safe(areaEl?.value);
      const preferred_timing = safe(timingEl?.value);

      if (request_title.length < 3) {
        showFlowPanelNotice(
          "publicChangeRequestFeedback",
          "Enter a short title (at least 3 characters).",
          "error"
        );
        return;
      }
      if (request_description.length < 10) {
        showFlowPanelNotice(
          "publicChangeRequestFeedback",
          "Describe the work in more detail (at least 10 characters).",
          "error"
        );
        return;
      }

      btn.disabled = true;
      btn.textContent = "Submitting…";

      try {
        const response = await fetch("/.netlify/functions/submit-public-quote-change-request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            request_title,
            request_description,
            request_area,
            preferred_timing
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data?.ok) {
          throw new Error(data?.error || "Could not submit request.");
        }
        sessionStorage.setItem(changeRequestSubmittedStorageKey(token), "1");
        if (formWrap) formWrap.style.display = "none";
        if (ok) ok.style.display = "block";
        showFlowPanelNotice("publicChangeRequestFeedback", "", "info");
        [titleEl, descEl, areaEl, timingEl].forEach((el) => {
          if (el) el.disabled = true;
        });
        btn.textContent = "Request submitted";
        updatePublicWorkflowBadges(estimateSnapshot || {});
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Submit change order request";
        showFlowPanelNotice(
          "publicChangeRequestFeedback",
          err.message || "Submit failed.",
          "error"
        );
      }
    };
  }

  function setupPublicWorkflow(next) {
    const token = getQueryParam("token") || "";
    if (!$("publicFlowStep1") || !token) {
      return;
    }

    setPublicFlowNavHref(token);
    const step = getPublicFlowStep();
    applyPublicFlowStep(step);

    const exText = $("publicExclusionsText");
    if (exText) {
      exText.textContent = buildExclusionsDisplayText(next);
    }
    renderPublicExclusionsStep2Attribution(next);

    const exAckAt = safe(next.exclusions_acknowledged_at);
    const coAckAt = safe(next.change_order_acknowledged_at);
    const initialsSaved = safe(next.exclusions_initials);

    const exInput = $("publicExclusionsInitials");
    const exBtn = $("btnExclusionsSubmit");
    const exDone = $("publicExclusionsDone");
    const coBtn = $("btnChangeOrderAck");
    const coDone = $("publicChangeOrderDone");

    if (exAckAt && exDone) {
      exDone.style.display = "block";
      const when = formatPublicAckTime(exAckAt);
      exDone.textContent = `Recorded: ${initialsSaved || "—"}${when ? ` · ${when}` : ""}`;
    } else if (exDone) {
      exDone.style.display = "none";
    }

    if (exInput) {
      exInput.disabled = !!exAckAt;
      if (exAckAt && initialsSaved) {
        exInput.value = initialsSaved;
      } else if (!exAckAt) {
        exInput.value = "";
      }
    }
    if (exBtn) {
      exBtn.disabled = !!exAckAt;
      exBtn.onclick = async () => {
        showFlowPanelNotice("publicExclusionsFeedback", "", "info");
        const raw = safe(exInput?.value).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
        if (!raw) {
          showFlowPanelNotice(
            "publicExclusionsFeedback",
            "Enter your initials (letters or numbers).",
            "error"
          );
          return;
        }
        exBtn.disabled = true;
        try {
          await patchPublicQuoteAck(token, {
            action: "exclusions_ack",
            exclusions_initials: raw
          });
          showFlowPanelNotice("publicExclusionsFeedback", "", "info");
          await loadEstimatePublic();
        } catch (err) {
          exBtn.disabled = false;
          showFlowPanelNotice("publicExclusionsFeedback", err.message || "Save failed.", "error");
        }
      };
    }

    if (coAckAt && coDone) {
      coDone.style.display = "block";
      const when = formatPublicAckTime(coAckAt);
      coDone.textContent = when ? `Acknowledged · ${when}` : "Acknowledged.";
    } else if (coDone) {
      coDone.style.display = "none";
    }

    if (coBtn) {
      coBtn.disabled = !!coAckAt;
      coBtn.onclick = async () => {
        showFlowPanelNotice("publicChangeOrderFeedback", "", "info");
        coBtn.disabled = true;
        try {
          await patchPublicQuoteAck(token, { action: "change_order_ack" });
          showFlowPanelNotice("publicChangeOrderFeedback", "", "info");
          await loadEstimatePublic();
        } catch (err) {
          coBtn.disabled = false;
          showFlowPanelNotice(
            "publicChangeOrderFeedback",
            err.message || "Save failed.",
            "error"
          );
        }
      };
    }

    setupPublicChangeRequestStep(token, next);

    updatePublicWorkflowBadges(next);
  }

  function showFeedback(message, type = "info") {
    const box = $("publicEstimateFeedback");
    if (!box) return;

    box.style.display = "block";
    box.textContent = message;

    box.style.border = "1px solid rgba(255,255,255,.12)";
    box.style.background = "rgba(255,255,255,.04)";
    box.style.color = "#fff";

    if (type === "success") {
      box.style.border = "1px solid rgba(16,185,129,.55)";
      box.style.background = "rgba(16,185,129,.10)";
      box.style.color = "#eafff7";
    }

    if (type === "error") {
      box.style.border = "1px solid rgba(239,68,68,.55)";
      box.style.background = "rgba(239,68,68,.10)";
      box.style.color = "#ffecec";
    }

    if (type === "warning") {
      box.style.border = "1px solid rgba(245,158,11,.55)";
      box.style.background = "rgba(245,158,11,.10)";
      box.style.color = "#fff5df";
    }
  }

  function setButtonsDisabled(disabled = true) {
    const approveBtn = $("btnPublicEstimateApprove");
    const declineBtn = $("btnPublicEstimateDecline");

    if (approveBtn) approveBtn.disabled = disabled;
    if (declineBtn) declineBtn.disabled = disabled;
  }

  function hideDecisionButtons() {
    const approveBtn = $("btnPublicEstimateApprove");
    const declineBtn = $("btnPublicEstimateDecline");

    if (approveBtn) approveBtn.style.display = "none";
    if (declineBtn) declineBtn.style.display = "none";
  }

  async function updateEstimateStatus(token, status) {
    const response = await fetch("/.netlify/functions/update-public-estimate-status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ token, status })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || "No se pudo actualizar el estimate.");
    }

    return data;
  }

  async function loadEstimatePublic() {
    if (!$("publicEstimateTitle")) {
      return;
    }

    const token = getQueryParam("token");

    if (!token) {
      document.title = "Estimate";
      renderEstimateNotFound("Falta token en la URL.");
      return;
    }

    try {
      const response = await fetch(
        `/.netlify/functions/get-public-estimate?token=${encodeURIComponent(token)}`,
        { cache: "no-store" }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data?.ok || !data?.estimate) {
        document.title = "Estimate";
        renderEstimateNotFound(
          data?.error || "El token publico no existe en este navegador o en este tenant."
        );
        return;
      }

      if (isEstimateDebugMode() && data.estimate) {
        const e = data.estimate;
        logEstimateDebug("after fetch", {
          "estimate.business_name": safe(e.business_name),
          "estimate.company_name": safe(e.company_name),
          "estimate.tenant_branding_business_name": safe(e.tenant_branding_business_name),
          "estimate.tenant_branding_company_name": safe(e.tenant_branding_company_name),
          "estimate.logo_url": safe(e.logo_url)
        });
      }

      renderEstimatePublic(data.estimate);
    } catch (err) {
      document.title = "Estimate";
      renderEstimateNotFound(err.message || "No se pudo cargar el estimate.");
    }
  }

  function renderEstimateNotFound(message = "Estimate no encontrado.") {
    const container = document.querySelector(".container");
    if (!container) return;

    container.innerHTML = `
      <section class="card" style="margin-top:24px;">
        <div class="card-inner">
          <h2>Estimate no encontrado</h2>
          <p>${message}</p>
        </div>
      </section>
    `;
  }

  function renderAcceptedBlock() {
    let block = $("publicEstimateAcceptedBlock");
    if (block) return;

    const feedback = $("publicEstimateFeedback");
    if (!feedback || !feedback.parentNode) return;

    block = document.createElement("div");
    block.id = "publicEstimateAcceptedBlock";
    block.className = "card";
    block.style.marginTop = "18px";
    block.innerHTML = `
      <div class="card-inner">
        <div style="font-size:14px;letter-spacing:.08em;text-transform:uppercase;opacity:.82;margin-bottom:8px;">
          Approved
        </div>
        <div style="font-size:24px;font-weight:700;line-height:1.2;margin-bottom:8px;">
          ✅ Project approved. Secure your schedule.
        </div>
        <div style="opacity:.9;margin-bottom:12px;">
          Your approval has been received. Complete the deposit to reserve your project start date.
        </div>
        <div style="font-weight:600;margin-bottom:14px;">
          Secure your project start with the required deposit.
        </div>
        <button id="btnBeginProjectInvestment" class="btn btn-primary" type="button">
          Begin Project Investment
        </button>
        <div style="font-size:12px;opacity:.75;margin-top:12px;line-height:1.5;">
          Your deposit reserves your project start date and is applied toward the final invoice.
        </div>
      </div>
    `;

    feedback.parentNode.insertBefore(block, feedback.nextSibling);

    const nextBtn = $("btnBeginProjectInvestment");
    if (nextBtn) {
      nextBtn.onclick = () => {
        showFeedback("Project investment step ready for the next integration.", "success");
      };
    }
  }

  function renderBusinessHeader(next) {
    const titleEl = $("publicEstimateTitle");
    const metaEl = $("publicEstimateMeta");

    const resolvedDisplayName = resolvePublicBusinessDisplayName(next);
    const finalHeaderText = resolvedDisplayName;

    const rawLogo = safe(
      next.logo_url ||
        next.logoUrl ||
        next.public_logo_url ||
        next.publicLogoUrl ||
        ""
    );
    const logoUrlResolved = safeHttpUrl(rawLogo);
    const headerBrandMode = logoUrlResolved ? "image" : "initials";

    if (isEstimateDebugMode()) {
      logEstimateDebug("after resolvePublicBusinessDisplayName", {
        "estimate.business_name": safe(next.business_name),
        "estimate.company_name": safe(next.company_name),
        "estimate.tenant_branding_business_name": safe(next.tenant_branding_business_name),
        "estimate.tenant_branding_company_name": safe(next.tenant_branding_company_name),
        "estimate.logo_url (API raw)": rawLogo,
        logoUrlResolved,
        headerBrandMode,
        resolvedDisplayName,
        finalHeaderText
      });
    }

    const initials = buildInitialsFromBusinessName(resolvedDisplayName);

    const badgePx = "44px";
    const badgeRadius = "14px";
    const badgeCommon = `width:${badgePx};height:${badgePx};min-width:${badgePx};min-height:${badgePx};flex-shrink:0;border-radius:${badgeRadius};box-sizing:border-box;`;
    const initialsBg =
      "background:linear-gradient(155deg,rgba(255,255,255,.16) 0%,rgba(255,255,255,.05) 45%,rgba(12,18,36,.55) 100%);";

    const businessAddress =
      safe(next.business_address) ||
      safe(next.company_address) ||
      "";

    const businessEmail =
      safe(next.business_email) ||
      safe(next.company_email) ||
      "";

    const businessPhone =
      safe(next.business_phone) ||
      safe(next.company_phone) ||
      "";

    const projectLine = safe(next.title || next.project_name || "Public Estimate");

    const logoOrInitials = logoUrlResolved
      ? `<img src="${escapeHtml(logoUrlResolved)}" alt="" width="44" height="44" decoding="async" style="${badgeCommon}object-fit:contain;background:rgba(255,255,255,.06);" />`
      : `<div style="${badgeCommon}${initialsBg}display:flex;align-items:center;justify-content:center;font-weight:800;font-size:14px;letter-spacing:.04em;color:rgba(255,255,255,.95);">${escapeHtml(initials)}</div>`;

    if (titleEl && isEstimateDebugMode()) {
      logEstimateDebug("before #publicEstimateTitle write", {
        "estimate.logo_url (API raw)": rawLogo,
        logoUrlResolved,
        headerBrandMode,
        resolvedDisplayName,
        finalHeaderText
      });
    }

    if (titleEl) {
      titleEl.innerHTML = `
        <div style="display:flex;align-items:flex-start;gap:14px;">
          ${logoOrInitials}
          <div style="flex:1;min-width:0;">
            <div style="font-size:30px;font-weight:800;line-height:1.15;margin-bottom:6px;">
              ${escapeHtml(resolvedDisplayName)}
            </div>
            <div style="font-size:18px;font-weight:700;line-height:1.25;">
              ${escapeHtml(projectLine)}
            </div>
          </div>
        </div>
      `;
    }

    if (isEstimateDebugMode()) {
      const panel = $("mgPublicEstimateDebug");
      if (panel) {
        panel.hidden = false;
        panel.style.display = "block";
        panel.textContent = [
          "— Public estimate header debug (?debug=1) —",
          "",
          "estimate.logo_url (API raw):",
          `  ${rawLogo || "(empty)"}`,
          "",
          "Resolved logo URL (safeHttpUrl, used in <img src>):",
          `  ${logoUrlResolved || "(empty — initials mode)"}`,
          "",
          "Header brand mode:",
          `  ${headerBrandMode}`,
          "",
          "Resolved business_name (API field):",
          `  ${safe(next.business_name)}`,
          "",
          "estimate.company_name:",
          `  ${safe(next.company_name)}`,
          "",
          "tenant_branding_business_name:",
          `  ${safe(next.tenant_branding_business_name)}`,
          "",
          "tenant_branding_company_name:",
          `  ${safe(next.tenant_branding_company_name)}`,
          "",
          "resolvedDisplayName (resolver output):",
          `  ${resolvedDisplayName}`,
          "",
          "final header text (written to #publicEstimateTitle):",
          `  ${finalHeaderText}`
        ].join("\n");
      }
    }

    if (metaEl) {
      const lines = [];

      if (businessAddress) lines.push(escapeHtml(businessAddress));

      const contactLine = [businessEmail, businessPhone].filter(Boolean).join(" • ");
      if (contactLine) lines.push(escapeHtml(contactLine));

      const expLabel =
        safe(next.expiration_date) ||
        safe(next.expirationDate) ||
        safe(next.valid_through) ||
        "sin fecha";
      lines.push(`• Expira ${escapeHtml(expLabel)}`);

      metaEl.innerHTML = lines.map((x) => `<div>${x}</div>`).join("");
    }
  }

  function renderCustomer(next) {
    const name =
      safe(next.client_name) ||
      safe(next.customer_name) ||
      "Cliente";

    const email =
      safe(next.client_email) ||
      safe(next.customer_email) ||
      "";

    const phone =
      safe(next.client_phone) ||
      safe(next.customer_phone) ||
      "";

    const projectAddress =
      safe(next.job_site) ||
      safe(next.project_address) ||
      safe(next.customer_address) ||
      "";

    const wrap = $("publicEstimateCustomer");
    if (!wrap) return;

    wrap.innerHTML = `
      <div style="display:grid;gap:10px;">
        <div>
          <div style="font-size:13px;opacity:.72;text-transform:uppercase;letter-spacing:.06em;">Customer Name</div>
          <div style="font-size:20px;font-weight:700;">${name}</div>
        </div>

        <div>
          <div style="font-size:13px;opacity:.72;text-transform:uppercase;letter-spacing:.06em;">Email</div>
          <div style="font-size:16px;">${email || "-"}</div>
        </div>

        <div>
          <div style="font-size:13px;opacity:.72;text-transform:uppercase;letter-spacing:.06em;">Phone</div>
          <div style="font-size:16px;">${phone || "-"}</div>
        </div>

        <div>
          <div style="font-size:13px;opacity:.72;text-transform:uppercase;letter-spacing:.06em;">Project Address</div>
          <div style="font-size:16px;">${projectAddress || "-"}</div>
        </div>
      </div>
    `;
  }

  function renderMessage(next) {
    const wrap = $("publicEstimateMessage");
    if (!wrap) return;

    wrap.innerHTML = `
      <div style="font-size:22px;font-weight:700;line-height:1.2;">
        Your project is ready.
      </div>
    `;
  }

  function renderTerms(next) {
    const wrap = $("publicEstimateTerms");
    if (!wrap) return;

    const customTerms = safe(next.terms);

    if (customTerms) {
      wrap.textContent = customTerms;
      return;
    }

    wrap.innerHTML = `
      <div style="display:grid;gap:12px;line-height:1.6;">
        <div>
          The required deposit will be applied toward your final invoice.
        </div>
        <div>
          Deposits are non-refundable in the event of project cancellation by the client.
        </div>
      </div>
    `;
  }

  function renderTotals(next) {
    const cur = next.currency;
    const totalNum = Number(next.total);
    const depNum = Number(next.deposit_required);
    const t = Number.isFinite(totalNum) ? totalNum : 0;
    const d = Number.isFinite(depNum) ? depNum : 0;
    const balanceAfter = Math.max(0, t - d);

    if ($("publicEstimateTotal")) {
      $("publicEstimateTotal").textContent = money(next.total, cur);
    }

    if ($("publicEstimateDeposit")) {
      $("publicEstimateDeposit").textContent = money(next.deposit_required, cur);
    }

    if ($("publicEstimateBalanceAfter")) {
      $("publicEstimateBalanceAfter").textContent = money(balanceAfter, cur);
    }
  }

  function renderItems(next) {
    const itemsWrap = $("publicEstimateItems");
    if (!itemsWrap) return;

    const items = Array.isArray(next.items) ? next.items : [];

    if (!items.length) {
      itemsWrap.innerHTML = `<div class="muted">No hay line items todavía.</div>`;
      return;
    }

    itemsWrap.innerHTML = items
      .map((line) => {
        return `
          <div class="line-item" style="display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06);">
            <div>
              <div style="font-weight:600;">${safe(line.name || line.title || "Item")}</div>
              <div class="muted">${safe(line.description || line.item_type || "")} x ${line.qty || 1}</div>
            </div>
            <div style="font-weight:700;">${money(line.line_total || line.amount || 0, next.currency)}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderEstimatePublic(estimate) {
    const next = estimate || {};
    const token = getQueryParam("token") || "";
    const currentStatus = String(next.status || "").toLowerCase();

    const bn = resolvePublicBusinessDisplayName(next);
    const proj = safe(next.title || next.project_name) || "Estimate";
    document.title = `${bn} — ${proj}`;

    renderBusinessHeader(next);
    renderCustomer(next);
    renderTotals(next);
    renderItems(next);
    renderMessage(next);
    renderTerms(next);

    if ($("publicEstimateStatus")) {
      $("publicEstimateStatus").textContent = next.status || "READY_TO_SEND";
    }

    setupPublicWorkflow(next);

    window.__mgPublicEstimateLast = next;
    if (typeof window.__mgOnPublicEstimateRefresh === "function") {
      window.__mgOnPublicEstimateRefresh();
    }

    const approveBtn = $("btnPublicEstimateApprove");
    const declineBtn = $("btnPublicEstimateDecline");

    if (currentStatus === "accepted") {
      hideDecisionButtons();
      renderAcceptedBlock();
      showFeedback("Estimate aprobado correctamente.", "success");
      return;
    }

    if (currentStatus === "declined") {
      hideDecisionButtons();
      showFeedback("Estimate rechazado correctamente.", "warning");
      return;
    }

    if (approveBtn) {
      approveBtn.style.display = "";
      approveBtn.disabled = false;

      approveBtn.onclick = async () => {
        try {
          setButtonsDisabled(true);
          await updateEstimateStatus(token, "accepted");
          await loadEstimatePublic();
        } catch (err) {
          setButtonsDisabled(false);
          showFeedback(err.message || "No se pudo aprobar el estimate.", "error");
        }
      };
    }

    if (declineBtn) {
      declineBtn.style.display = "";
      declineBtn.disabled = false;

      declineBtn.onclick = async () => {
        try {
          setButtonsDisabled(true);
          const result = await updateEstimateStatus(token, "declined");

          if ($("publicEstimateStatus")) {
            $("publicEstimateStatus").textContent = result.status || "declined";
          }

          hideDecisionButtons();
          showFeedback("Estimate rechazado correctamente.", "warning");
        } catch (err) {
          setButtonsDisabled(false);
          showFeedback(err.message || "No se pudo rechazar el estimate.", "error");
        }
      };
    }
  }

  document.addEventListener("DOMContentLoaded", loadEstimatePublic);
})();