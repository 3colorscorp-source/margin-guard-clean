"use strict";

const fs = require("fs");
const path = require("path");
const { MAX_MODULE_CHARS } = require("./config");

function uniqueExistingDirs(candidates) {
  const out = [];
  const seen = new Set();
  for (const dir of candidates) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        out.push(resolved);
      }
    } catch (_err) {
      /* skip */
    }
  }
  return out;
}

function knowledgeDirCandidates() {
  return uniqueExistingDirs([
    path.join(process.cwd(), "docs", "margin-guard-support"),
    path.join(__dirname, "..", "..", "..", "..", "docs", "margin-guard-support"),
    path.join(__dirname, "..", "..", "docs", "margin-guard-support"),
    path.join(__dirname, "docs", "margin-guard-support"),
    path.join(__dirname, "..", "docs", "margin-guard-support"),
  ]);
}

function resolveKnowledgeDir() {
  const found = knowledgeDirCandidates();
  return found[0] || "";
}

function loadKnowledgeFile(fileName) {
  const base = path.basename(String(fileName || ""));
  if (!base || !/^[a-z0-9.-]+\.md$/i.test(base)) return "";
  const dir = resolveKnowledgeDir();
  if (!dir) return "";
  const full = path.join(dir, base);
  try {
    const raw = fs.readFileSync(full, "utf8");
    const text = String(raw || "").trim();
    if (!text) return "";
    return text.length > MAX_MODULE_CHARS ? text.slice(0, MAX_MODULE_CHARS) : text;
  } catch (_err) {
    return "";
  }
}

function loadRoutedKnowledge(modules) {
  const list = Array.isArray(modules) ? modules : [];
  const loaded = [];
  for (const mod of list) {
    const content = loadKnowledgeFile(mod.file);
    if (!content) continue;
    loaded.push({
      id: mod.id,
      title: mod.title,
      file: path.basename(mod.file),
      content,
    });
  }
  return loaded;
}

module.exports = {
  knowledgeDirCandidates,
  resolveKnowledgeDir,
  loadKnowledgeFile,
  loadRoutedKnowledge,
};
