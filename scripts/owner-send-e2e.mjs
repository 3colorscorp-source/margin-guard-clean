/**
 * One-off E2E: /owner "Enviar cotización" (mocks Netlify functions; no backend).
 * Run: node scripts/owner-send-e2e.mjs
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "..", "public");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function serveFile(res, filePath) {
  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = extname(filePath);
  const type = mime[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(filePath));
}

const server = createServer((req, res) => {
  let pathname = new URL(req.url || "/", "http://local").pathname;
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/owner") pathname = "/owner.html";
  const safe = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDir, safe);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end();
    return;
  }
  serveFile(res, filePath);
});

const PORT = await new Promise((resolve, reject) => {
  server.listen(0, "127.0.0.1", () => {
    resolve(server.address().port);
  });
  server.on("error", reject);
});

const base = `http://127.0.0.1:${PORT}`;

const results = [];

function record(step, ok, detail = "") {
  results.push({ step, ok, detail });
  console.log(`${ok ? "OK" : "FAIL"} — ${step}${detail ? `: ${detail}` : ""}`);
}

const consoleErrors = [];
const pageErrors = [];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => pageErrors.push(String(err.message)));

await page.route("**/.netlify/functions/auth-status**", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      active: true,
      userId: "e2e",
      is_admin: true,
      subscription_status: "active",
    }),
  });
});

let sendQuoteCalls = 0;
await page.route("**/.netlify/functions/send-quote-zapier**", async (route) => {
  sendQuoteCalls += 1;
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true }),
  });
});

try {
  await page.goto(`${base}/owner`, { waitUntil: "networkidle", timeout: 30000 });
  record("1. Abrir /owner (redirect a owner.html)", true);

  await page.waitForSelector("body.auth-ready", { timeout: 15000 });
  record("1b. Auth lista (body.auth-ready)", true);

  const btnCount = await page.locator("#btnSendQuote").count();
  record(
    "1c. Un solo #btnSendQuote",
    btnCount === 1,
    btnCount === 1 ? "" : `encontrados: ${btnCount}`
  );

  await page.click("#btnSendQuote");
  await page.waitForSelector("#sendModal[aria-hidden='false']", { timeout: 5000 });
  const hidden = await page.getAttribute("#sendModal", "aria-hidden");
  const visible = await page.isVisible("#sendModal");
  const subjectVal = (await page.inputValue("#subject"))?.trim() || "";
  const estimateOk = /^Estimate EST-\d+/.test(subjectVal);
  record(
    "2. Click Enviar cotización → modal abierto + openSendModal completó (asunto EST-*)",
    hidden === "false" && visible && estimateOk,
    `aria-hidden=${hidden}, visible=${visible}, subject=${subjectVal.slice(0, 48)}`
  );

  await page.fill("#toEmail", "");
  await page.fill("#salesInitials", "");
  await page.click("#btnSendNow");
  await page.waitForTimeout(200);
  const status1 = (await page.textContent("#sendStatus"))?.trim() || "";
  const errExpected =
    status1.includes("email") && status1.toLowerCase().includes("initials");
  record(
    "3. Validación email + initials vacíos",
    errExpected && (await page.getAttribute("#sendModal", "aria-hidden")) === "false",
    status1.slice(0, 120)
  );

  await page.fill("#toEmail", "cliente@example.com");
  await page.fill("#salesInitials", "AB");
  await page.click("#btnSendNow");
  await page.waitForSelector("#sendModal[aria-hidden='true']", { timeout: 8000 });

  const ariaAfter = await page.getAttribute("#sendModal", "aria-hidden");
  record(
    "4–5. Envío: fetch mock + modal cerrado",
    sendQuoteCalls >= 1 && ariaAfter === "true",
    `sendQuoteCalls=${sendQuoteCalls}, aria-hidden=${ariaAfter}`
  );

  const consoleOk = consoleErrors.length === 0;
  record("5b. Sin errores de consola (tipo error)", consoleOk, consoleErrors.join(" | "));

  const pageOk = pageErrors.length === 0;
  record("5c. Sin pageerror", pageOk, pageErrors.join(" | "));

  record(
    "6. buildEstimateNumber / openSendModal sin excepción",
    estimateOk && sendQuoteCalls >= 1,
    "inferido: asunto con EST-* al abrir + envío mock OK"
  );
} catch (e) {
  record("E2E abortado", false, String(e?.message || e));
} finally {
  await browser.close();
  server.close();
}

console.log("\n--- Resumen ---");
for (const r of results) {
  console.log(`${r.ok ? "OK" : "FAIL"}\t${r.step}`);
}
process.exit(results.some((r) => !r.ok) ? 1 : 0);
