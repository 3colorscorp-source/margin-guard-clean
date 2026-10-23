#!/usr/bin/env node
/**
 * Project Control shows each project's money to the owner, without the crew marker.
 * Run: node scripts/test-project-control-finances.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public/project-control.html"), "utf8");

let passed = 0;
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

const parts = html.split("<script>");
const inline = parts[parts.length - 1].split("</script>")[0];
new Function(inline);

const noteFn = inline.slice(inline.indexOf("function ownerFieldNote"), inline.indexOf("function ownerNoteCell"));
const sandbox = { result: null };
vm.runInNewContext(
  noteFn +
    "\nresult = ownerFieldNote('Day 2 — Demolition of walls\\n[[mg-crew:v1]]' + JSON.stringify([{role:'pro',name:''},{role:'assistant',name:''}]));",
  sandbox
);

ok("the project detail leads with finances", html.includes('id="pccMoneyBoard"') && html.includes("Project finances"));
ok("each project row has a finances column", html.includes("<th>Finances</th>") && html.includes("financeListCell(row.finance)"));
ok("the board uses the financial detail the page already loads", html.includes("row.finance = financeFromDetail(data.detail)"));
ok("work report notes hide the crew marker", html.includes("function ownerFieldNote") && html.includes("ownerNoteCell(r.note)"));
ok("the raw crew trailer is not printed in the history", !html.includes("esc(r.note || '')"));
ok(
  "a day 2 note stays readable",
  sandbox.result &&
    sandbox.result.text === "Day 2 — Demolition of walls" &&
    sandbox.result.crew === "1 Pro · 1 Assistant"
);

console.log("\n" + passed + " passed");
