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
    return Math.min(3, Math.max(1, n));
  }

  function setPublicFlowNavHref(token) {
    const t = encodeURIComponent(token || "");
    const base = `${window.location.pathname}?token=${t}`;
    const n1 = $("flowNav1");
    const n2 = $("flowNav2");
    const n3 = $("flowNav3");
    if (n1) n1.href = `${base}&step=1`;
    if (n2) n2.href = `${base}&step=2`;
    if (n3) n3.href = `${base}&step=3`;
  }

  function applyPublicFlowStep(step) {
    const s1 = $("publicFlowStep1");
    const s2 = $("publicFlowStep2");
    const s3 = $("publicFlowStep3");
    const metaEl = $("publicEstimateMeta");
    if (s1) s1.style.display = step === 1 ? "" : "none";
    if (s2) s2.style.display = step === 2 ? "" : "none";
    if (s3) s3.style.display = step === 3 ? "" : "none";
    if (metaEl && step !== 1) {
      const labels = {
        2: "Step 2 of 3 — exclusions acknowledgment.",
        3: "Step 3 of 3 — additional work & change orders."
      };
      metaEl.textContent = labels[step] || "";
    }
  }

  function buildExclusionsDisplayText(next) {
    const notes = safe(next.notes);
    const terms = safe(next.terms);
    const parts = [];
    if (notes) {
      parts.push(`Project notes\n\n${notes}`);
    }
    if (terms) {
      parts.push(`Terms & conditions\n\n${terms}`);
    }
    if (!parts.length) {
      return (
        "Your written estimate defines what is included in the scope. " +
        "Work or materials not listed in the estimate are excluded unless added through a written change order."
      );
    }
    return parts.join("\n\n—\n\n");
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

  function updatePublicWorkflowBadges(next) {
    const b1 = $("flowStepBadge1");
    const b2 = $("flowStepBadge2");
    const b3 = $("flowStepBadge3");
    const step1 = safe(next.accepted_at) !== "";
    const step2 =
      safe(next.exclusions_initials) !== "" &&
      safe(next.exclusions_acknowledged_at) !== "";
    const step3 = safe(next.change_order_acknowledged_at) !== "";
    if (b1) b1.textContent = step1 ? "✔" : "";
    if (b2) b2.textContent = step2 ? "✔" : "";
    if (b3) b3.textContent = step3 ? "✔" : "";
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
        `/.netlify/functions/get-public-estimate?token=${encodeURIComponent(token)}`
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