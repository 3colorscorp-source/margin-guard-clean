/**
 * Behavioral tests for Contract Workflow automatic Certificate → PDF.
 * Isolated mocks. No live contracts, no email, no backend.
 * Run: node scripts/qa-ch013a-autodocs-behavior.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const jsPath = path.join(ROOT, "public/js/signature-workspace.js");
const js = fs.readFileSync(jsPath, "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      console.log("PASS", name);
      passed += 1;
    } catch (err) {
      console.log("FAIL", name, "-", err.message);
      failed += 1;
    }
  };
  return run();
}

function loadAutoDocs() {
  const begin = js.indexOf("/* MG_SW_AUTODOCS_BEGIN */");
  const end = js.indexOf("/* MG_SW_AUTODOCS_END */");
  assert.ok(begin >= 0 && end > begin, "autodocs helpers missing");
  const chunk = js.slice(begin, end + "/* MG_SW_AUTODOCS_END */".length);
  const ctx = {};
  vm.runInNewContext(
    `${chunk}
this.mgSwCreateAutoDocsSession = mgSwCreateAutoDocsSession;
`,
    ctx
  );
  return ctx;
}

function makeStore(seed) {
  const store = {
    cert: seed && seed.cert ? { ...seed.cert } : null,
    pdf: seed && seed.pdf ? { ...seed.pdf } : null,
    posts: [],
    loads: [],
    failCert: Boolean(seed && seed.failCert),
    failPdf: Boolean(seed && seed.failPdf),
    certDelayMs: seed && seed.certDelayMs ? seed.certDelayMs : 0,
  };
  const io = {
    initialCertificates: store.cert ? [store.cert] : [],
    initialPdfs: store.pdf ? [store.pdf] : [],
    createCertificate: async () => {
      store.posts.push("certificate-create");
      if (store.failCert) return { ok: false };
      if (store.certDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, store.certDelayMs));
      }
      if (!store.cert) store.cert = { id: "cert-1", certificate_number: "C-1" };
      return { ok: true, idempotent: store.posts.filter((p) => p === "certificate-create").length > 1 };
    },
    loadCertificates: async () => {
      store.loads.push("certificates");
      return store.cert ? [{ ...store.cert }] : [];
    },
    createPdf: async () => {
      store.posts.push("pdf-create");
      if (store.failPdf) return { ok: false };
      if (!store.pdf) store.pdf = { id: "pdf-1" };
      return { ok: true };
    },
    loadPdfs: async () => {
      store.loads.push("pdfs");
      return store.pdf ? [{ ...store.pdf }] : [];
    },
  };
  return { store, io };
}

const envelope = { id: "env-1", status: "completed" };

async function main() {
  await test("0 syntax signature-workspace.js", () => {
    const r = spawnSync(process.execPath, ["--check", jsPath], { encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  });

  await test("A completed envelope without cert/PDF runs Certificate then PDF once and reaches step 6", async () => {
    const { mgSwCreateAutoDocsSession } = loadAutoDocs();
    const { store, io } = makeStore();
    const session = mgSwCreateAutoDocsSession(io);
    const result = await session.maybePrepare(envelope);
    assert.deepStrictEqual(store.posts, ["certificate-create", "pdf-create"]);
    assert.deepStrictEqual(store.loads, ["certificates", "pdfs"]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.step, 6);
    assert.strictEqual(session.getState().busy, false);
    assert.strictEqual(store.posts.filter((p) => p === "certificate-create").length, 1);
    assert.strictEqual(store.posts.filter((p) => p === "pdf-create").length, 1);
  });

  await test("B existing certificate missing PDF creates only the PDF", async () => {
    const { mgSwCreateAutoDocsSession } = loadAutoDocs();
    const { store, io } = makeStore({ cert: { id: "cert-1" } });
    const session = mgSwCreateAutoDocsSession(io);
    const result = await session.maybePrepare(envelope);
    assert.deepStrictEqual(store.posts, ["pdf-create"]);
    assert.ok(!store.posts.includes("certificate-create"));
    assert.deepStrictEqual(store.loads, ["pdfs"]);
    assert.strictEqual(result.step, 6);
    assert.strictEqual(store.cert.id, "cert-1");
  });

  await test("C existing certificate and PDF make no additional POSTs", async () => {
    const { mgSwCreateAutoDocsSession } = loadAutoDocs();
    const { store, io } = makeStore({
      cert: { id: "cert-1" },
      pdf: { id: "pdf-1" },
    });
    const session = mgSwCreateAutoDocsSession(io);
    const result = await session.maybePrepare(envelope);
    assert.deepStrictEqual(store.posts, []);
    assert.deepStrictEqual(store.loads, []);
    assert.strictEqual(result.reason, "complete");
    assert.strictEqual(result.step, 6);
    assert.strictEqual(result.didWork, false);
  });

  await test("D certificate create failure does not create PDF and is not left busy", async () => {
    const { mgSwCreateAutoDocsSession } = loadAutoDocs();
    const { store, io } = makeStore({ failCert: true });
    const session = mgSwCreateAutoDocsSession(io);
    const result = await session.maybePrepare(envelope);
    assert.deepStrictEqual(store.posts, ["certificate-create"]);
    assert.ok(!store.posts.includes("pdf-create"));
    assert.deepStrictEqual(store.loads, []);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "certificate_failed");
    assert.strictEqual(session.getState().busy, false);
    assert.strictEqual(session.getState().hold, true);
    const blocked = await session.maybePrepare(envelope);
    assert.strictEqual(blocked.reason, "hold");
    assert.deepStrictEqual(store.posts, ["certificate-create"]);
    session.retry();
    assert.strictEqual(session.getState().hold, false);
  });

  await test("E PDF create failure keeps certificate and does not duplicate it", async () => {
    const { mgSwCreateAutoDocsSession } = loadAutoDocs();
    const { store, io } = makeStore({ cert: { id: "cert-1" }, failPdf: true });
    const session = mgSwCreateAutoDocsSession(io);
    const result = await session.maybePrepare(envelope);
    assert.deepStrictEqual(store.posts, ["pdf-create"]);
    assert.ok(!store.posts.includes("certificate-create"));
    assert.strictEqual(store.cert.id, "cert-1");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "pdf_failed");
    assert.strictEqual(session.getState().busy, false);
    assert.strictEqual(session.getState().hold, true);
    session.retry();
    await session.maybePrepare(envelope);
    assert.deepStrictEqual(store.posts, ["pdf-create", "pdf-create"]);
    assert.ok(!store.posts.includes("certificate-create"));
  });

  await test("F repeated render/poll does not start concurrent POSTs", async () => {
    const { mgSwCreateAutoDocsSession } = loadAutoDocs();
    const { store, io } = makeStore({ certDelayMs: 40 });
    const session = mgSwCreateAutoDocsSession(io);
    const first = session.maybePrepare(envelope);
    const second = await session.maybePrepare(envelope);
    assert.strictEqual(second.reason, "busy");
    assert.strictEqual(Array.from(second.posts || []).length, 0);
    await first;
    assert.strictEqual(store.posts.filter((p) => p === "certificate-create").length, 1);
    assert.strictEqual(store.posts.filter((p) => p === "pdf-create").length, 1);
  });

  await test("G reopen resumes idempotently when documents are missing or already present", async () => {
    const { mgSwCreateAutoDocsSession } = loadAutoDocs();
    const missing = makeStore();
    const firstOpen = mgSwCreateAutoDocsSession(missing.io);
    await firstOpen.maybePrepare(envelope);
    assert.deepStrictEqual(missing.store.posts, ["certificate-create", "pdf-create"]);

    const stillMissing = makeStore();
    const reopenMissing = mgSwCreateAutoDocsSession(stillMissing.io);
    const resumed = await reopenMissing.maybePrepare(envelope);
    assert.deepStrictEqual(stillMissing.store.posts, ["certificate-create", "pdf-create"]);
    assert.strictEqual(resumed.step, 6);

    const present = makeStore({
      cert: { id: "cert-1" },
      pdf: { id: "pdf-1" },
    });
    const reopenPresent = mgSwCreateAutoDocsSession(present.io);
    const skipped = await reopenPresent.maybePrepare(envelope);
    assert.deepStrictEqual(present.store.posts, []);
    assert.strictEqual(skipped.reason, "complete");
    assert.strictEqual(skipped.step, 6);
  });

  await test("workspace wires session prepare instead of silent button clicks", () => {
    assert.ok(js.includes("mgSwCreateAutoDocsSession"));
    assert.ok(js.includes("await session.maybePrepare(state.envelope)"));
    assert.ok(js.includes("We could not prepare your documents. You can try again."));
    const autoFn = js.slice(
      js.indexOf("async function runAutoPrepareDocuments"),
      js.indexOf("function computeSendReadiness")
    );
    assert.ok(autoFn.includes("session.maybePrepare"));
    assert.ok(!autoFn.includes("swIssueCertBtn"));
    assert.ok(!autoFn.includes("swGeneratePdfBtn"));
    assert.ok(!autoFn.includes(".click()"));
  });

  console.log("");
  console.log("CH-013A autodocs behavior:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
