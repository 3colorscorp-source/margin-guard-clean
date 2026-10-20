#!/usr/bin/env node
/**
 * Structured quote location: street, city, state, ZIP.
 * Run: node scripts/test-project-location.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const loc = require("../public/js/project-location");

let passed = 0;
function eq(label, actual, expected) {
  assert.strictEqual(actual, expected, label + " expected " + JSON.stringify(expected) + " got " + JSON.stringify(actual));
  passed += 1;
  console.log("PASS " + label);
}
function ok(label, cond) {
  assert.ok(cond, label);
  passed += 1;
  console.log("PASS " + label);
}

const composed = loc.composeProjectLocation({
  street: "123 Main St",
  city: "Hayward",
  state: "ca",
  zip: "94541",
});
eq("compose complete address", composed, "123 Main St, Hayward, CA 94541");

const parsed = loc.parseCommaProjectAddress(composed);
eq("parse street", parsed.street, "123 Main St");
eq("parse city", parsed.city, "Hayward");
eq("parse state", parsed.state, "CA");
eq("parse zip", parsed.zip, "94541");

const withApt = loc.parseCommaProjectAddress("123 Main St, Apt 2, Hayward, CA 94541-2201");
eq("street may contain a comma", withApt.street, "123 Main St, Apt 2");
eq("city stays after the last comma", withApt.city, "Hayward");
eq("zip+4 stays intact", withApt.zip, "94541-2201");

eq("single location stays in street", loc.partsFromLocation("Downtown").street, "Downtown");
eq("single location has no city", loc.partsFromLocation("Downtown").city, "");
ok(
  "incomplete draft keeps city beside street",
  loc.locationPartsNeedRefresh(
    { street: "123 Main St", city: "Hayward", state: "", zip: "" },
    "123 Main St, Hayward"
  ) === false
);
ok(
  "complete stored address refreshes empty fields",
  loc.locationPartsNeedRefresh(
    { street: "", city: "", state: "", zip: "" },
    composed
  ) === true
);

const fromQuote = loc.propertyPartsFromQuote(
  { project_address: composed, job_site: composed },
  {}
);
eq("quote street fills line 1", fromQuote.address_line1, "123 Main St");
eq("quote city fills city", fromQuote.city, "Hayward");
eq("quote state fills state", fromQuote.state, "CA");
eq("quote zip fills postal code", fromQuote.postal_code, "94541");

const kept = loc.propertyPartsFromQuote(
  { project_address: composed },
  { property_address_line1: "9 Oak Ave", property_city: "Oakland", property_state: "CA", property_postal_code: "94601" }
);
eq("saved setup street wins", kept.address_line1, "9 Oak Ave");
eq("saved setup city wins", kept.city, "Oakland");

const lines = loc.formatPropertyDisplay({
  address_line1: "",
  city: "",
  state: "",
  postal_code: "",
  quote_project_address: composed,
});
eq("signing display street", lines[0], "123 Main St");
eq("signing display locality", lines[1], "Hayward, CA 94541");
ok("signing display is not one blob", lines.join(" | ") !== composed);

const root = path.resolve(__dirname, "..");
const owner = fs.readFileSync(path.join(root, "public/owner.html"), "utf8");
const sales = fs.readFileSync(path.join(root, "public/sales.html"), "utf8");
ok("owner asks for street", owner.includes('id="locationStreet"'));
ok("owner asks for city", owner.includes('id="locationCity"'));
ok("owner asks for state", owner.includes('id="locationState"'));
ok("owner asks for zip", owner.includes('id="locationZip"'));
ok("seller asks for street", sales.includes('id="salesLocationStreet"'));
ok("seller asks for city", sales.includes('id="salesLocationCity"'));
ok("seller asks for state", sales.includes('id="salesLocationState"'));
ok("seller asks for zip", sales.includes('id="salesLocationZip"'));

const pkg = fs.readFileSync(path.join(root, "netlify/functions/_lib/contract-package.js"), "utf8");
ok("contract package uses structured quote location", pkg.includes("propertyPartsFromQuote"));
const portal = fs.readFileSync(path.join(root, "public/js/contract-sign-portal.js"), "utf8");
ok("signing portal formats location parts", portal.includes("formatPropertyDisplay"));
ok("signing portal shows street", portal.includes("Street address"));
ok("signing portal shows city", portal.includes('"City"'));
ok("signing portal shows state", portal.includes('"State"'));
ok("signing portal shows zip", portal.includes("ZIP code"));
const confirm = fs.readFileSync(path.join(root, "public/js/contract-property-confirm.js"), "utf8");
ok("contract builder splits composed quote location", confirm.includes("parseCommaProjectAddress"));

console.log("\n" + passed + " passed");
