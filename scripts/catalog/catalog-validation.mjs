/**
 * Catalogue schema validation.
 *
 * Kept separate from `catalog.mjs` — and free of any Foundry dependency — so the
 * shipped catalogue can be validated in CI without a browser. A malformed entry
 * that silently never fires is the worst failure mode this module has, because
 * nothing looks broken.
 */

import { AUDIENCE_KINDS, EVENTS, ONCE_SCOPES, SEVERITIES } from "../constants.mjs";
import { OPERATORS } from "../engine/matcher.mjs";

/* -------------------------------------------------- */

/**
 * Validate one catalogue entry.
 * @param {object} entry
 * @param {number} [index]
 * @returns {string[]} Problems found; empty when the entry is sound.
 */
export function validateEntry(entry, index = 0) {
  const problems = [];
  const where = entry?.id ? `« ${entry.id} »` : `entrée #${index + 1}`;

  if (!entry || typeof entry !== "object") return [`${where} : ce n'est pas un objet.`];
  if (!entry.id || typeof entry.id !== "string") problems.push(`${where} : champ « id » manquant.`);
  if (!entry.message || typeof entry.message !== "string") problems.push(`${where} : champ « message » manquant.`);

  if (!Object.values(EVENTS).includes(entry.event)) {
    problems.push(`${where} : événement inconnu « ${entry.event} ».`);
  }

  if (entry.once !== undefined && entry.once !== null && !ONCE_SCOPES.includes(entry.once)) {
    problems.push(`${where} : portée « once » invalide « ${entry.once} ». Attendu : ${ONCE_SCOPES.join(", ")}.`);
  }

  if (entry.severity !== undefined && !SEVERITIES.includes(entry.severity)) {
    problems.push(`${where} : sévérité invalide « ${entry.severity} ».`);
  }

  const audience = entry.audience;
  if (audience !== undefined) {
    if (!AUDIENCE_KINDS.includes(audience.kind)) {
      problems.push(`${where} : audience inconnue « ${audience.kind} ».`);
    }
    if (audience.kind === "heroesWithin" && !Number.isFinite(audience.range)) {
      problems.push(`${where} : audience « heroesWithin » sans portée numérique.`);
    }
  }

  for (const [i, clause] of (entry.when ?? []).entries()) {
    if (!clause?.path || typeof clause.path !== "string") {
      problems.push(`${where} : clause ${i + 1} sans chemin.`);
    }
    if (!OPERATORS[clause?.op]) {
      problems.push(`${where} : clause ${i + 1}, opérateur inconnu « ${clause?.op} ».`);
    }
  }

  return problems;
}

/* -------------------------------------------------- */

/**
 * Validate a whole catalogue document.
 * @param {object} document
 * @returns {{ entries: object[], problems: string[] }}
 */
export function validateCatalog(document) {
  const problems = [];
  const entries = [];

  if (!document || typeof document !== "object") {
    return { entries: [], problems: ["Le catalogue n'est pas un objet JSON."] };
  }
  if (!Array.isArray(document.entries)) {
    return { entries: [], problems: ["Le catalogue n'a pas de tableau « entries »."] };
  }

  const seen = new Set();
  for (const [index, entry] of document.entries.entries()) {
    const entryProblems = validateEntry(entry, index);
    if (entry?.id) {
      if (seen.has(entry.id)) entryProblems.push(`« ${entry.id} » : identifiant en double.`);
      seen.add(entry.id);
    }
    if (entryProblems.length) problems.push(...entryProblems);
    else entries.push(entry);
  }

  return { entries, problems };
}
