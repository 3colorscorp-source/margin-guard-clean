(function () {
  const LS_KEY = "mg_estimate_builder_draft_v1";

  function $(id) {
    return document.getElementById(id);
  }

  function money(amount) {
    const n = Number(amount || 0);
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
    } catch {
      return `$${n.toFixed(2)}`;
    }
  }

  function persistDraftPayload(payload) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch (_e) {}
    if (typeof window.__mgScheduleTenantSnapshotSync === "function") {
      window.__mgScheduleTenantSnapshotSync();
    }
  }

  function readDraft() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : { items: [] };
    } catch (_e) {
      return { items: [] };
    }
  }

  function recalcTotals() {
    const rows = [...document.querySelectorAll("#estimateItemsBody tr")];
    let sub = 0;
    rows.forEach((tr) => {
      const qty = Number(tr.querySelector('[data-k="qty"]')?.value || 0);
      const price = Number(tr.querySelector('[data-k="unit"]')?.value || 0);
      const disc = Number(tr.querySelector('[data-k="disc"]')?.value || 0);
      const tax = Number(tr.querySelector('[data-k="tax"]')?.value || 0);
      const line = qty * price * (1 - Math.min(Math.max(disc, 0), 100) / 100);
      const taxAmt = line * (Math.max(tax, 0) / 100);
      const tot = line + taxAmt;
      sub += tot;
      const totCell = tr.querySelector("[data-k=\"linetotal\"]");
      if (totCell) totCell.textContent = money(tot);
    });
    const dep = Number($("estimateDepositRequired")?.value || 0);
    if ($("estimateSubtotal")) $("estimateSubtotal").textContent = money(sub);
    if ($("estimateDiscountTotal")) $("estimateDiscountTotal").textContent = money(0);
    if ($("estimateTaxTotal")) $("estimateTaxTotal").textContent = money(0);
    if ($("estimateDepositSummary")) $("estimateDepositSummary").textContent = money(dep);
    if ($("estimateTotal")) $("estimateTotal").textContent = money(sub + dep);
  }

  function addRow(typeLabel) {
    const body = $("estimateItemsBody");
    if (!body) return;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${typeLabel}</td>
      <td><input data-k="name" type="text" style="width:120px" /></td>
      <td><input data-k="desc" type="text" style="width:140px" /></td>
      <td><input data-k="qty" type="number" step="0.01" value="1" style="width:56px" /></td>
      <td><input data-k="unitname" type="text" value="ea" style="width:48px" /></td>
      <td><input data-k="unit" type="number" step="0.01" value="0" style="width:72px" /></td>
      <td><input data-k="disc" type="number" step="0.01" value="0" style="width:48px" /></td>
      <td><input data-k="tax" type="number" step="0.01" value="0" style="width:48px" /></td>
      <td><input data-k="taxable" type="checkbox" checked /></td>
      <td data-k="linetotal">$0.00</td>
      <td><button type="button" class="btn danger rm-row">X</button></td>
    `;
    body.appendChild(tr);
    tr.querySelectorAll("input").forEach((inp) => {
      inp.addEventListener("input", recalcTotals);
      inp.addEventListener("change", recalcTotals);
    });
    const rm = tr.querySelector(".rm-row");
    if (rm) {
      rm.addEventListener("click", () => {
        tr.remove();
        recalcTotals();
      });
    }
    recalcTotals();
  }

  function collectDraft() {
    const items = [...document.querySelectorAll("#estimateItemsBody tr")].map((tr) => ({
      type: String(tr.cells[0]?.textContent || "").trim(),
      name: tr.querySelector('[data-k="name"]')?.value || "",
      desc: tr.querySelector('[data-k="desc"]')?.value || "",
      qty: tr.querySelector('[data-k="qty"]')?.value || "1",
      unit: tr.querySelector('[data-k="unit"]')?.value || "0",
      disc: tr.querySelector('[data-k="disc"]')?.value || "0",
      tax: tr.querySelector('[data-k="tax"]')?.value || "0"
    }));
    return {
      estimateNumber: $("estimateNumber")?.value || "",
      issueDate: $("estimateIssueDate")?.value || "",
      expirationDate: $("estimateExpirationDate")?.value || "",
      projectName: $("estimateProjectName")?.value || "",
      message: $("estimateMessage")?.value || "",
      deposit: $("estimateDepositRequired")?.value || "",
      items
    };
  }

  function applyDraft(d) {
    if (!d || !Array.isArray(d.items) || !d.items.length) return;
    const body = $("estimateItemsBody");
    if (!body) return;
    body.innerHTML = "";
    d.items.forEach((it) => {
      const label = it.type === "material" ? "material" : it.type === "custom" ? "custom" : "service";
      addRow(label);
      const last = body.querySelector("tr:last-child");
      if (!last) return;
      const set = (sel, val) => {
        const el = last.querySelector(sel);
        if (el && val != null) el.value = val;
      };
      set('[data-k="name"]', it.name);
      set('[data-k="desc"]', it.desc);
      set('[data-k="qty"]', it.qty);
      set('[data-k="unit"]', it.unit);
      set('[data-k="disc"]', it.disc);
      set('[data-k="tax"]', it.tax);
    });
    if ($("estimateNumber") && d.estimateNumber) $("estimateNumber").value = d.estimateNumber;
    if ($("estimateIssueDate") && d.issueDate) $("estimateIssueDate").value = d.issueDate;
    if ($("estimateExpirationDate") && d.expirationDate) $("estimateExpirationDate").value = d.expirationDate;
    if ($("estimateProjectName") && d.projectName) $("estimateProjectName").value = d.projectName;
    if ($("estimateMessage") && d.message) $("estimateMessage").value = d.message;
    if ($("estimateDepositRequired") && d.deposit != null && d.deposit !== "") {
      $("estimateDepositRequired").value = d.deposit;
    }
    recalcTotals();
  }

  function previewDraft() {
    const d = collectDraft();
    const text = JSON.stringify(d, null, 2);
    window.alert(text.length > 1800 ? `${text.slice(0, 1800)}…` : text);
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (!$("estimateItemsBody")) return;

    $("btnEstimateAddService")?.addEventListener("click", () => addRow("service"));
    $("btnEstimateAddMaterial")?.addEventListener("click", () => addRow("material"));
    $("btnEstimateAddCustom")?.addEventListener("click", () => addRow("custom"));

    $("btnEstimateSaveDraft")?.addEventListener("click", () => {
      persistDraftPayload(collectDraft());
      window.alert("Borrador guardado (localStorage + snapshot del tenant si esta activo).");
    });

    $("btnEstimateDuplicate")?.addEventListener("click", () => {
      const n = $("estimateNumber");
      if (n) n.value = `${n.value || "EST"}-COPY`;
      window.alert("Numero ajustado; revisa y usa Guardar borrador.");
    });

    $("btnEstimatePreview")?.addEventListener("click", previewDraft);
    $("btnEstimatePreviewInline")?.addEventListener("click", previewDraft);

    $("btnEstimateOpenPublic")?.addEventListener("click", () => {
      try {
        const sales = JSON.parse(localStorage.getItem("mg_sales_v2") || "{}");
        const url = sales.publicQuoteUrl || "";
        if (url) window.open(url, "_blank", "noopener");
        else window.alert("Aun no hay link publico. Publica y envia desde Vendedor (Sales).");
      } catch (_e) {
        window.alert("Abre Sales para generar el link publico.");
      }
    });

    $("btnEstimateSend")?.addEventListener("click", () => {
      window.location.href = "/sales";
    });

    $("btnEstimateCancel")?.addEventListener("click", () => {
      if (!window.confirm("Vaciar lineas del estimate en esta pantalla?")) return;
      $("estimateItemsBody").innerHTML = "";
      recalcTotals();
    });

    const saved = readDraft();
    if (saved.items?.length) applyDraft(saved);
  });
})();
