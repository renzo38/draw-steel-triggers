/**
 * Event → notification dispatch.
 *
 * Runs on the authoritative GM only. Resolves who could be notified, matches
 * the catalogue, consumes the "first time" windows, persists the ledger, and
 * broadcasts the result to the players concerned.
 */

import { LEDGER_FLAG, MODULE_ID, SETTINGS } from "../constants.mjs";
import { classIdOf, subclassIdOf } from "./observers.mjs";
import { disabledEntries, loadCatalog } from "../catalog/catalog.mjs";
import Ledger from "./ledger.mjs";
import { matchEvent } from "./matcher.mjs";

/* -------------------------------------------------- */

/** @type {Ledger} */
let ledger = new Ledger();

/** @type {number|null} */
let persistTimer = null;

/** Callback that presents notifications locally. Set by module.mjs. */
let present = () => {};

/** Callback that broadcasts notifications to other clients. Set by module.mjs. */
let broadcast = () => {};

/* -------------------------------------------------- */

/**
 * @param {object} handlers
 * @param {(notifications: object[]) => void} handlers.present
 * @param {(notifications: object[]) => void} handlers.broadcast
 */
export function configureDispatcher({ present: presenter, broadcast: broadcaster }) {
  present = presenter;
  broadcast = broadcaster;
}

/* -------------------------------------------------- */
/*  Distance                                          */
/* -------------------------------------------------- */

/**
 * Chebyshev distance in squares between two tokens' nearest occupied squares.
 * Draw Steel counts a diagonal as one square.
 * @param {TokenDocument} a
 * @param {TokenDocument} b
 * @returns {number}
 */
function squaresBetween(a, b) {
  if (!a || !b) return Infinity;
  if (a.id === b.id) return 0;
  if (!canvas.grid?.isSquare) {
    const measured = canvas.grid?.measurePath?.([a.object?.center ?? a, b.object?.center ?? b]);
    if (!measured) return Infinity;
    return measured.spaces ?? Math.round(measured.distance / (canvas.scene?.grid.distance || 1));
  }
  const size = canvas.grid.size;
  const box = (token) => {
    const c0 = Math.round(token.x / size);
    const r0 = Math.round(token.y / size);
    return { c0, r0, c1: c0 + Math.max(1, Math.round(token.width)) - 1, r1: r0 + Math.max(1, Math.round(token.height)) - 1 };
  };
  const fa = box(a);
  const fb = box(b);
  return Math.max(
    Math.max(0, fb.c0 - fa.c1, fa.c0 - fb.c1),
    Math.max(0, fb.r0 - fa.r1, fa.r0 - fb.r1),
  );
}

/* -------------------------------------------------- */

/**
 * Every hero who could receive a notification, with their distance to the
 * event's origin.
 * @param {object} event
 * @returns {import("./matcher.mjs").Recipient[]}
 */
function candidateHeroes(event) {
  const combat = game.combat;
  const originToken = event.origin?.tokenId ? canvas.tokens?.get(event.origin.tokenId)?.document : null;

  const actors = new Map();
  if (combat) {
    for (const combatant of combat.combatants) {
      const actor = combatant.actor;
      if (actor?.type === "hero") actors.set(actor.uuid, { actor, token: combatant.token });
    }
  } else {
    for (const actor of game.actors) {
      if (actor.type !== "hero" || !actor.hasPlayerOwner) continue;
      actors.set(actor.uuid, { actor, token: actor.getActiveTokens(false, true)[0] ?? null });
    }
  }

  return [...actors.values()].map(({ actor, token }) => ({
    actorUuid: actor.uuid,
    name: token?.name ?? actor.name,
    classId: classIdOf(actor),
    subclassId: subclassIdOf(actor),
    ownerIds: game.users.filter((user) => actor.testUserPermission(user, "OWNER") && !user.isGM).map((u) => u.id),
    distance: originToken ? squaresBetween(originToken, token) : Infinity,
    isSubject: event.subject?.actorUuid === actor.uuid,
  }));
}

/* -------------------------------------------------- */

/**
 * The window-tracking context for the current moment.
 * @returns {import("./ledger.mjs").LedgerContext}
 */
function ledgerContext() {
  const combat = game.combat;
  return {
    encounterId: combat?.id ?? "no-combat",
    round: combat?.round ?? 0,
    turnKey: `${combat?.round ?? 0}:${combat?.turn ?? 0}`,
  };
}

/* -------------------------------------------------- */

/**
 * Handle one normalized event.
 * @param {object} event
 * @returns {Promise<void>}
 */
export async function dispatch(event) {
  if (game.settings.get(MODULE_ID, SETTINGS.debug)) {
    console.debug(`${MODULE_ID} | événement`, event);
  }

  const entries = await loadCatalog();
  const context = ledgerContext();
  const heroes = candidateHeroes(event);

  const notifications = matchEvent(entries, event, heroes, ledger, context, { disabled: disabledEntries() });
  if (!notifications.length) return schedulePersist();

  const stamped = notifications.map((notification) => ({
    ...notification,
    id: foundry.utils.randomID(),
    timestamp: Date.now(),
  }));

  present(stamped);
  broadcast(stamped);
  schedulePersist();
}

/* -------------------------------------------------- */
/*  Ledger persistence                                */
/* -------------------------------------------------- */

/**
 * Load the ledger belonging to the active combat. Called when a combat starts
 * or when the module initialises mid-encounter.
 * @returns {Promise<void>}
 */
export async function restoreLedger() {
  const combat = game.combat;
  const stored = combat?.getFlag(MODULE_ID, LEDGER_FLAG) ?? {};
  ledger = new Ledger(stored);
  ledger.pruneToEncounter(combat?.id ?? "no-combat");
}

/* -------------------------------------------------- */

/** Discard everything and start a fresh encounter ledger. */
export async function resetLedger() {
  ledger.clear();
  await persistNow();
}

/* -------------------------------------------------- */

/**
 * Persistence is debounced: a busy round can produce a dozen events, and each
 * one would otherwise be a document write.
 */
function schedulePersist() {
  if (!ledger.dirty) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistNow(), 2000);
}

/* -------------------------------------------------- */

/** @returns {Promise<void>} */
async function persistNow() {
  persistTimer = null;
  const combat = game.combat;
  if (!combat || !ledger.dirty) return;
  try {
    await combat.setFlag(MODULE_ID, LEDGER_FLAG, ledger.toJSON());
    ledger.flush();
  } catch (error) {
    console.warn(`${MODULE_ID} | impossible d'enregistrer le registre`, error);
  }
}

/* -------------------------------------------------- */

/** Exposed for diagnostics. */
export function ledgerSize() {
  return ledger.size;
}
