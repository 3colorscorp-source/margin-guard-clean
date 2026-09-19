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
this.mgSwShouldApplyAutoDocsResult = mgSwShouldApplyAutoDocsResult;
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
    pdfDelayMs: seed && seed.pdfDelayMs ? seed.pdfDelayMs : 0,
    certGate: seed && seed.certGate ? seed.certGate : null,
    pdfGate: seed && seed.pdfGate ? seed.pdfGate : null,
  };
  const io = {
    initialCertificates: store.cert ? [store.cert] : [],
    initialPdfs: store.pdf ? [store.pdf] : [],
    createCertificate: async () => {
      store.posts.push("certificate-create");
      if (store.failCert) return { ok: false };
      if (store.certGate) await store.certGate.promise;
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
      if (store.pdfGate) await store.pdfGate.promise;
      if (store.pdfDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, store.pdfDelayMs));
      }
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

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function applyWorkspace(ws, result, apply) {
  if (!apply.mgSwShouldApplyAutoDocsResult(result, ws.envelope && ws.envelope.id)) {
    return false;
  }
  if (Array.isArray(result.certs)) ws.certificates = result.certs;
  if (Array.isArray(result.pdfs)) ws.artifacts = result.pdfs;
  if (result.ok === false) {
    ws.toasts.push("We could not prepare your documents. You can try again.");
  }
  if (result.didWork) ws.rendered = true;
  ws.visualStep =
    ws.certificates[0] && ws.certificates[0].id && ws.artifacts[0] && ws.artifacts[0].id
      ? 6
      : ws.certificates[0] && ws.certificates[0].id
        ? 5
        : 4;
  return true;
}

function makeEnvelopeBackend() {
  const rows = new Map();
  function lane(id) {
    const key = String(id || "");
    if (!rows.has(key)) {
      rows.set(key, { cert: null, pdf: null, posts: [], loads: [], certGate: null, pdfGate: null });
    }
    return rows.get(key);
  }
  return {
    lane,
    io(getCurrentEnvelopeId) {
      return {
        getCurrentEnvelopeId,
        createCertificate: async (envelope) => {
          const row = lane(envelope.id);
          row.posts.push("certificate-create");
          if (row.certGate) await row.certGate.promise;
          if (!row.cert) row.cert = { id: `cert-${envelope.id}` };
          return { ok: true };
        },
        loadCertificates: async (envelope) => {
          const row = lane(envelope.id);
          row.loads.push("certificates");
          return row.cert ? [{ ...row.cert }] : [];
        },
        createPdf: async (envelope) => {
          const row = lane(envelope.id);
          row.posts.push("pdf-create");
          if (row.pdfGate) await row.pdfGate.promise;
          if (!row.pdf) row.pdf = { id: `pdf-${envelope.id}` };
          return { ok: true };
        },
        loadPdfs: async (envelope) => {
          const row = lane(envelope.id);
          row.loads.push("pdfs");
          return row.pdf ? [{ ...row.pdf }] : [];
        },
      };
    },
  };
}

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
    assert.ok(js.includes("mgSwShouldApplyAutoDocsResult"));
    assert.ok(js.includes("session.maybePrepare(envelope)"));
    assert.ok(js.includes("We could not prepare your documents. You can try again."));
    assert.ok(js.includes("loadCertificates: async (envelope) => fetchCertificates"));
    assert.ok(js.includes("loadPdfs: async (envelope) => fetchPdfs"));
    const autoFn = js.slice(
      js.indexOf("async function runAutoPrepareDocuments"),
      js.indexOf("function computeSendReadiness")
    );
    assert.ok(autoFn.includes("session.maybePrepare"));
    assert.ok(autoFn.includes("mgSwShouldApplyAutoDocsResult"));
    assert.ok(!autoFn.includes("swIssueCertBtn"));
    assert.ok(!autoFn.includes("swGeneratePdfBtn"));
    assert.ok(!autoFn.includes(".click()"));
    assert.ok(!autoFn.includes("await loadCertificates"));
    assert.ok(!autoFn.includes("await loadPdfs"));
  });

  await test("H switch envelope during Certificate Create ignores A and lets B run", async () => {
    const { mgSwCreateAutoDocsSession, mgSwShouldApplyAutoDocsResult } = loadAutoDocs();
    const backend = makeEnvelopeBackend();
    const envA = { id: "env-A", status: "completed" };
    const envB = { id: "env-B", status: "completed" };
    let current = "env-A";
    const session = mgSwCreateAutoDocsSession(backend.io(() => current));
    backend.lane("env-A").certGate = deferred();

    const wsB = {
      envelope: envB,
      certificates: [],
      artifacts: [],
      toasts: [],
      rendered: false,
      visualStep: 4,
    };

    const aPromise = session.maybePrepare(envA);
    await Promise.resolve();
    assert.strictEqual(session.getLaneState("env-A").busy, true);

    current = "env-B";
    const genAfterSwitch = session.resetForEnvelope("env-B");
    assert.ok(genAfterSwitch > 0);
    assert.strictEqual(session.getLaneState("env-A").busy, true, "reset must not free A's in-flight chain");
    assert.strictEqual(session.getLaneState("env-B").busy, false);

    const bPromise = session.maybePrepare(envB);
    const bBusy = await session.maybePrepare(envB);
    assert.strictEqual(bBusy.reason, "busy");

    backend.lane("env-A").certGate.resolve();
    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
    assert.strictEqual(aResult.stale, true);
    assert.strictEqual(aResult.reason, "stale");
    assert.ok(!backend.lane("env-A").posts.includes("pdf-create"));
    assert.ok(!backend.lane("env-A").loads.includes("certificates"));
    assert.ok(!session.getLaneState("env-A").certId);
    assert.notStrictEqual(session.getLaneState("env-B").certId, "cert-env-A");
    assert.notStrictEqual(session.getLaneState("env-B").pdfId, "pdf-env-A");
    assert.strictEqual(applyWorkspace(wsB, aResult, { mgSwShouldApplyAutoDocsResult }), false);
    assert.deepStrictEqual(wsB.certificates, []);
    assert.deepStrictEqual(wsB.artifacts, []);
    assert.deepStrictEqual(wsB.toasts, []);
    assert.strictEqual(wsB.rendered, false);
    assert.strictEqual(wsB.visualStep, 4);

    assert.strictEqual(bResult.stale, false);
    assert.strictEqual(bResult.step, 6);
    assert.deepStrictEqual(backend.lane("env-B").posts, ["certificate-create", "pdf-create"]);
    assert.ok(applyWorkspace(wsB, bResult, { mgSwShouldApplyAutoDocsResult }));
    assert.strictEqual(wsB.certificates[0].id, "cert-env-B");
    assert.strictEqual(wsB.artifacts[0].id, "pdf-env-B");
    assert.strictEqual(wsB.visualStep, 6);
    assert.ok(!String(wsB.certificates[0].id).includes("env-A"));
    assert.ok(!String(wsB.artifacts[0].id).includes("env-A"));

    current = "env-A";
    session.resetForEnvelope("env-A");
    session.hydrate(
      backend.lane("env-A").cert ? [backend.lane("env-A").cert] : [],
      backend.lane("env-A").pdf ? [backend.lane("env-A").pdf] : [],
      "env-A"
    );
    const resumed = await session.maybePrepare(envA);
    assert.strictEqual(resumed.stale, false);
    assert.strictEqual(resumed.step, 6);
    assert.ok(backend.lane("env-A").posts.filter((p) => p === "certificate-create").length >= 1);
    assert.ok(backend.lane("env-A").posts.includes("pdf-create"));
    assert.strictEqual(backend.lane("env-A").posts.filter((p) => p === "pdf-create").length, 1);
  });

  await test("H switch envelope during PDF Create ignores A and lets B run", async () => {
    const { mgSwCreateAutoDocsSession, mgSwShouldApplyAutoDocsResult } = loadAutoDocs();
    const backend = makeEnvelopeBackend();
    const envA = { id: "env-A", status: "completed" };
    const envB = { id: "env-B", status: "completed" };
    let current = "env-A";
    const session = mgSwCreateAutoDocsSession(backend.io(() => current));
    backend.lane("env-A").cert = { id: "cert-env-A" };
    backend.lane("env-A").pdfGate = deferred();
    session.hydrate([{ id: "cert-env-A" }], [], "env-A");

    const wsB = {
      envelope: envB,
      certificates: [],
      artifacts: [],
      toasts: [],
      rendered: false,
      visualStep: 4,
    };

    const aPromise = session.maybePrepare(envA);
    await Promise.resolve();
    assert.ok(backend.lane("env-A").posts.includes("pdf-create"));
    assert.strictEqual(session.getLaneState("env-A").busy, true);

    current = "env-B";
    session.resetForEnvelope("env-B");
    assert.strictEqual(session.getLaneState("env-A").busy, true, "reset must not free A's PDF chain");

    const bPromise = session.maybePrepare(envB);
    const bBusy = await session.maybePrepare(envB);
    assert.strictEqual(bBusy.reason, "busy");

    backend.lane("env-A").pdfGate.resolve();
    const [aResult, bResult] = await Promise.all([aPromise, bPromise]);
    assert.strictEqual(aResult.stale, true);
    assert.ok(!backend.lane("env-A").loads.includes("pdfs"));
    assert.ok(!session.getLaneState("env-A").pdfId);
    assert.notStrictEqual(session.getLaneState("env-B").certId, "cert-env-A");
    assert.notStrictEqual(session.getLaneState("env-B").pdfId, "pdf-env-A");
    assert.strictEqual(applyWorkspace(wsB, aResult, { mgSwShouldApplyAutoDocsResult }), false);
    assert.deepStrictEqual(wsB.certificates, []);
    assert.deepStrictEqual(wsB.artifacts, []);
    assert.deepStrictEqual(wsB.toasts, []);
    assert.strictEqual(wsB.visualStep, 4);

    assert.strictEqual(bResult.step, 6);
    assert.deepStrictEqual(backend.lane("env-B").posts, ["certificate-create", "pdf-create"]);
    assert.ok(applyWorkspace(wsB, bResult, { mgSwShouldApplyAutoDocsResult }));
    assert.strictEqual(wsB.certificates[0].id, "cert-env-B");
    assert.strictEqual(wsB.artifacts[0].id, "pdf-env-B");
    assert.strictEqual(wsB.visualStep, 6);

    current = "env-A";
    session.resetForEnvelope("env-A");
    session.hydrate([{ id: "cert-env-A" }], [], "env-A");
    const resumed = await session.maybePrepare(envA);
    assert.strictEqual(resumed.step, 6);
    assert.strictEqual(backend.lane("env-A").posts.filter((p) => p === "pdf-create").length, 2);
    assert.ok(!backend.lane("env-A").posts.includes("certificate-create"));
  });

  console.log("");
  console.log("CH-013A autodocs behavior:", passed, "passed,", failed, "failed");
  process.exit(failed === 0 ? 0 : 1);
}

main();
