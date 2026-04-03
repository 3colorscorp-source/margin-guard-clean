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

  function cleanPublicMessage(message = "") {
    return String(message || "")
      .replace(/\[PUBLIC_QUOTE_URL\]/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
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
    const token = getQueryParam("token");

    if (!token) {
      renderEstimateNotFound("Falta token en la URL.");
      return;
    }

    try {
      const response = await fetch(
        `/.netlify/functions/get-public-estimate?token=${encodeURIComponent(token)}`
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data?.ok || !data?.estimate) {
        renderEstimateNotFound(
          data?.error || "El token publico no existe en este navegador o en este tenant."
        );
        return;
      }

      renderEstimatePublic(data.estimate);
    } catch (err) {
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
          ✅ Project approved. Let’s get to work.
        </div>
        <div style="opacity:.9;margin-bottom:14px;">
          We’ve received your approval and your project can now move to the next step.
        </div>
        <div style="font-weight:600;margin-bottom:14px;">
          Next Step: Move forward with your project investment.
        </div>
        <button id="btnBeginProjectInvestment" class="btn btn-primary" type="button">
          Begin Project Investment
        </button>
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

  function renderEstimatePublic(estimate) {
    const next = estimate || {};
    const token = getQueryParam("token") || "";

    if ($("publicEstimateTitle")) {
      $("publicEstimateTitle").textContent =
        next.title || next.project_name || "Public Estimate";
    }

    if ($("publicEstimateMeta")) {
      $("publicEstimateMeta").textContent =
        `• Expira ${next.expiration_date || "sin fecha"}`;
    }

    if ($("publicEstimateStatus")) {
      $("publicEstimateStatus").textContent = next.status || "READY_TO_SEND";
    }

    if ($("publicEstimateCustomerName")) {
      $("publicEstimateCustomerName").textContent =
        next.client_name || "Cliente";
    }

    if ($("publicEstimateCustomerEmail")) {
      $("publicEstimateCustomerEmail").textContent =
        next.client_email || "";
    }

    if ($("publicEstimateTotal")) {
      $("publicEstimateTotal").textContent =
        money(next.total, next.currency);
    }

    if ($("publicEstimateDeposit")) {
      $("publicEstimateDeposit").textContent =
        money(next.deposit_required, next.currency);
    }

    const itemsWrap = $("publicEstimateItems");
    if (itemsWrap) {
      const items = Array.isArray(next.items) ? next.items : [];

      if (!items.length) {
        itemsWrap.innerHTML = `<div class="muted">No hay line items todavía.</div>`;
      } else {
        itemsWrap.innerHTML = items
          .map((line) => {
            return `
              <div class="line-item" style="display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.06);">
                <div>
                  <div style="font-weight:600;">${line.name || line.title || "Item"}</div>
                  <div class="muted">${line.description || line.item_type || ""} x ${line.qty || 1}</div>
                </div>
                <div style="font-weight:700;">${money(line.line_total || line.amount || 0, next.currency)}</div>
              </div>
            `;
          })
          .join("");
      }
    }

    if ($("publicEstimateMessage")) {
      const cleaned = cleanPublicMessage(next.notes || next.message || "");
      $("publicEstimateMessage").textContent = cleaned || "Your project is ready.";
    }

    if ($("publicEstimateTerms")) {
      $("publicEstimateTerms").textContent =
        next.terms || "Sin terminos específicos.";
    }

    const approveBtn = $("btnPublicEstimateApprove");
    const declineBtn = $("btnPublicEstimateDecline");
    const currentStatus = String(next.status || "").toLowerCase();

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