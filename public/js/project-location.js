/**
 * Structured project location for quotes and contract property fields.
 * A complete address is stored as "street, city, ST ZIP" so existing
 * project_address text can be split back into its own fields.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MarginGuardProjectLocation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function trim(value) {
    return String(value == null ? "" : value).trim();
  }

  function composeProjectLocation(parts) {
    var src = parts || {};
    var street = trim(src.street || src.line1).slice(0, 160);
    var city = trim(src.city).slice(0, 80);
    var state = trim(src.state).toUpperCase().slice(0, 2);
    var zip = trim(src.zip || src.postal_code).slice(0, 10);
    var composed = "";
    if (street && city && /^[A-Z]{2}$/.test(state) && /^\d{5}(?:-\d{4})?$/.test(zip)) {
      composed = street + ", " + city + ", " + state + " " + zip;
    } else {
      var locality = [state, zip].filter(Boolean).join(" ");
      composed = [street, city, locality].filter(Boolean).join(", ");
    }
    return composed.slice(0, 255);
  }

  function parseCommaProjectAddress(raw) {
    var value = trim(raw);
    if (!value) return null;
    var zipState = value.match(/,\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (!zipState) return null;
    var head = value.slice(0, zipState.index).trim();
    var comma = head.lastIndexOf(",");
    if (comma <= 0) return null;
    var street = head.slice(0, comma).trim();
    var city = head.slice(comma + 1).trim();
    if (!street || !city) return null;
    return {
      street: street,
      city: city,
      state: zipState[1].toUpperCase(),
      zip: zipState[2],
    };
  }

  function partsFromLocation(raw) {
    var parsed = parseCommaProjectAddress(raw);
    if (parsed) return parsed;
    var street = trim(raw).slice(0, 160);
    return { street: street, city: "", state: "", zip: "" };
  }

  function locationPartsNeedRefresh(currentParts, storedLocation) {
    var stored = trim(storedLocation);
    if (parseCommaProjectAddress(stored)) return true;
    return composeProjectLocation(currentParts) !== stored;
  }

  function propertyPartsFromQuote(quote, setup) {
    var parsed = parseCommaProjectAddress(
      (quote && (quote.project_address || quote.job_site)) || ""
    );
    var row = setup || {};
    return {
      address_line1: trim(row.property_address_line1) || (parsed ? parsed.street : ""),
      address_line2: trim(row.property_address_line2),
      city: trim(row.property_city) || (parsed ? parsed.city : ""),
      state: trim(row.property_state) || (parsed ? parsed.state : ""),
      postal_code: trim(row.property_postal_code) || (parsed ? parsed.zip : ""),
    };
  }

  function formatPropertyDisplay(property) {
    var src = property || {};
    var line1 = trim(src.address_line1);
    var line2 = trim(src.address_line2);
    var city = trim(src.city);
    var state = trim(src.state);
    var zip = trim(src.postal_code || src.zip);
    if (!line1 && !line2 && !city && !state && !zip) {
      var parsed = parseCommaProjectAddress(src.quote_project_address || src.quote_job_site || "");
      if (parsed) {
        line1 = parsed.street;
        city = parsed.city;
        state = parsed.state;
        zip = parsed.zip;
      } else {
        line1 = trim(src.quote_project_address || src.quote_job_site);
      }
    }
    var cityState = [city, state].filter(Boolean).join(", ");
    var locality = [cityState, zip].filter(Boolean).join(" ");
    return [line1, line2, locality].filter(Boolean);
  }

  return {
    composeProjectLocation: composeProjectLocation,
    parseCommaProjectAddress: parseCommaProjectAddress,
    partsFromLocation: partsFromLocation,
    locationPartsNeedRefresh: locationPartsNeedRefresh,
    propertyPartsFromQuote: propertyPartsFromQuote,
    formatPropertyDisplay: formatPropertyDisplay,
  };
});
