(function () {
  const $ = (id) => document.getElementById(id);

  function getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
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
    if (!$("publicEstimateFeedback")) {
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

    const businessName =
      safe(next.business_name) ||
      safe(next.company_name) ||
      safe(next.businessName) ||
      "\u2014";

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

    if (titleEl) {
      titleEl.innerHTML = `
        <div style="font-size:30px;font-weight:800;line-height:1.15;margin-bottom:6px;">
          ${businessName}
        </div>
        <div style="font-size:18px;font-weight:700;line-height:1.25;">
          ${safe(next.title || next.project_name || "Public Estimate")}
        </div>
      `;
    }

    if (metaEl) {
      const lines = [];

      if (businessAddress) lines.push(businessAddress);

      const contactLine = [businessEmail, businessPhone].filter(Boolean).join(" • ");
      if (contactLine) lines.push(contactLine);

      const expLabel =
        safe(next.expiration_date) ||
        safe(next.expirationDate) ||
        safe(next.valid_through) ||
        "sin fecha";
      lines.push(`• Expira ${expLabel}`);

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

    const bn =
      safe(next.business_name) ||
      safe(next.company_name) ||
      safe(next.businessName) ||
      "";
    const proj = safe(next.title || next.project_name) || "Estimate";
    document.title = bn ? `${bn} — ${proj}` : proj;

    renderBusinessHeader(next);
    renderCustomer(next);
    renderTotals(next);
    renderItems(next);
    renderMessage(next);
    renderTerms(next);

    if ($("publicEstimateStatus")) {
      $("publicEstimateStatus").textContent = next.status || "READY_TO_SEND";
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
          const result = await updateEstimateStatus(token, "accepted");

          if ($("publicEstimateStatus")) {
            $("publicEstimateStatus").textContent = result.status || "accepted";
          }

          hideDecisionButtons();
          renderAcceptedBlock();
          showFeedback("Estimate aprobado correctamente.", "success");
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