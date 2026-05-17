const fs = require("fs");
const path = require("path");

const sup = path.join(__dirname, "..", "public", "supervisor.html");
const blockPath = path.join(__dirname, "_snapshot-block.html");

const block = fs.readFileSync(blockPath, "utf8");
let s = fs.readFileSync(sup, "utf8");

const t = "div";
const markerLf = `            <${t} class="sep"></${t}>\n\n            <${t} class="field">\n              <label>Labor plan</label>`;
const markerCrlf = markerLf.replace(/\n/g, "\r\n");

if (s.includes("supSnapshotGrid")) {
  console.log("snapshot block already present");
} else if (!s.includes(markerLf) && !s.includes(markerCrlf)) {
  console.error("insert marker not found");
  process.exit(1);
} else {
  const insert =
    block.trimStart().replace(/\n/g, s.includes("\r\n") ? "\r\n" : "\n") +
    (s.includes("\r\n") ? "\r\n\r\n" : "\n\n") +
    `            <${t} class="field">${s.includes("\r\n") ? "\r\n" : "\n"}              <label>Labor plan</label>`;
  s = s.replace(s.includes(markerCrlf) ? markerCrlf : markerLf, insert);
  fs.writeFileSync(sup, s);
  console.log("inserted snapshot block");
}

if (/<motion\b|<\/motion>/i.test(s)) {
  console.error("invalid motion tags remain in supervisor.html");
  process.exit(1);
}

console.log("ok: no motion tags in supervisor.html");
