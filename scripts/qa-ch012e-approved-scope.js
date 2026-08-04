/**
 * CH-012E — superseded by CH-012E.1 canonical scope_of_work.
 * Delegates to qa-ch012e1-canonical-scope.js
 */
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const r = spawnSync(process.execPath, [path.join(__dirname, "qa-ch012e1-canonical-scope.js")], {
  encoding: "utf8",
  stdio: "inherit",
});
process.exit(r.status == null ? 1 : r.status);
