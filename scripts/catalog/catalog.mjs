/**
 * Catalogue loading and merging.
 *
 * The shipped catalogue is data, not code, so a Director can correct a rule
 * reading or add a homebrew trigger without touching a .mjs file. User entries
 * are merged over the defaults by id, so overriding a shipped entry is a matter
 * of reusing its id.
 *
 * Schema validation lives in `catalog-validation.mjs`, which has no Foundry
 * dependency and is exercised by the test suite.
 */

import { MODULE_ID, SETTINGS, modulePath } from "../constants.mjs";
import { validateCatalog } from "./catalog-validation.mjs";

export { validateCatalog, validateEntry } from "./catalog-validation.mjs";

/* -------------------------------------------------- */

/** @type {object[]|null} */
let merged = null;

/* -------------------------------------------------- */

/**
 * Load the shipped catalogue, merge the Director's own entries over it, and
 * cache the result.
 * @param {object} [options]
 * @param {boolean} [options.force]  Rebuild even if cached.
 * @returns {Promise<object[]>}
 */
export async function loadCatalog({ force = false } = {}) {
  if (merged && !force) return merged;

  const response = await fetch(modulePath("scripts/catalog/default-catalog.json"));
  const shipped = await response.json();
  const { entries: base, problems: baseProblems } = validateCatalog(shipped);
  if (baseProblems.length) {
    console.error(`${MODULE_ID} | le catalogue livré est invalide`, baseProblems);
  }

  const byId = new Map(base.map((entry) => [entry.id, entry]));

  const raw = game.settings.get(MODULE_ID, SETTINGS.userCatalog);
  if (raw?.trim()) {
    try {
      const { entries: user, problems } = validateCatalog(JSON.parse(raw));
      if (problems.length) {
        ui.notifications.warn(game.i18n.format("DST.Notify.CatalogProblems", { count: problems.length }));
        console.warn(`${MODULE_ID} | catalogue utilisateur`, problems);
      }
      for (const entry of user) byId.set(entry.id, entry);
    } catch (error) {
      ui.notifications.error(game.i18n.localize("DST.Notify.CatalogUnparseable"));
      console.error(`${MODULE_ID} | catalogue utilisateur illisible`, error);
    }
  }

  merged = [...byId.values()];
  return merged;
}

/* -------------------------------------------------- */

/** Drop the cache so the next load rebuilds. */
export function invalidateCatalog() {
  merged = null;
}

/* -------------------------------------------------- */

/**
 * The set of entry ids the Director has switched off.
 * @returns {Set<string>}
 */
export function disabledEntries() {
  const stored = game.settings.get(MODULE_ID, SETTINGS.disabledEntries);
  return new Set(Array.isArray(stored) ? stored : []);
}
