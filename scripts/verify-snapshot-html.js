const fs = require("fs");
const path = require("path");

const s = fs.readFileSync(path.join(__dirname, "..", "public", "supervisor.html"), "utf8");

if (/<motion\b|<\/motion>/i.test(s)) {
  console.error("FAIL: motion tags found");
  process.exit(1);
}

const start = s.indexOf('id="supSnapshotGrid"');
const end = s.indexOf('id="supSnapshotRiskMeta"');
const chunk = s.slice(start, end + 120);
const opens = (chunk.match(/<div\b/gi) || []).length;
const closesDiv = (chunk.match(/<\/div>/gi) || []).length;

console.log("div opens:", opens, "div closes:", closesDiv, "balanced:", opens === closesDiv);
if (opens !== closesDiv) process.exit(1);
console.log("OK");
