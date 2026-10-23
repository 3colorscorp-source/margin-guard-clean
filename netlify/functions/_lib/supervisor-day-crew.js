"use strict";

const CREW_MARKER = "\n[[mg-crew:v1]]";
const MAX_CREW = 16;

function sanitizeSupervisorCrew(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const type = String(row.role || row.type || row.worker_type || "")
      .trim()
      .toLowerCase();
    let role = "";
    if (type === "helper" || type === "assistant" || type === "asistente") role = "assistant";
    else if (type === "pro" || type === "installer") role = "pro";
    if (!role) continue;
    const name = String(row.name || "")
      .trim()
      .slice(0, 80);
    out.push({ role, name });
    if (out.length >= MAX_CREW) break;
  }
  return out;
}

function splitCrewFromNote(note) {
  const raw = String(note || "");
  const idx = raw.lastIndexOf(CREW_MARKER);
  if (idx < 0) return { note: raw.trim(), crew: [] };
  const head = raw.slice(0, idx).trim();
  let crew = [];
  try {
    crew = sanitizeSupervisorCrew(JSON.parse(raw.slice(idx + CREW_MARKER.length).trim()));
  } catch (_err) {
    crew = [];
  }
  return { note: head, crew };
}

function appendCrewTrailer(note, crew) {
  const clean = splitCrewFromNote(note).note;
  const people = sanitizeSupervisorCrew(crew);
  if (!people.length) return clean;
  return `${clean}${CREW_MARKER}${JSON.stringify(people)}`;
}

function crewFromStoredRow(row) {
  const split = splitCrewFromNote(row && row.note);
  const fromColumn = sanitizeSupervisorCrew(row && row.crew);
  return {
    note: split.note,
    crew: fromColumn.length ? fromColumn : split.crew,
  };
}

module.exports = {
  CREW_MARKER,
  appendCrewTrailer,
  crewFromStoredRow,
  sanitizeSupervisorCrew,
  splitCrewFromNote,
};
