/**
 * Event → notification dispatch.
 *
 * Runs on the authoritative GM only. Resolves who could be notified, matches
 * the catalogue, consumes the "first time" windows, persists the ledger, and
 * broadcasts the result to the players concerned.
 */

import { LEDGER_FLAG, MODULE_ID, SETTINGS } from "../constants.mjs";
import { classIdOf, matchingTriggeredAbilities, subclassIdOf } from "./observers.mjs";
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
    // Needed by the `minLevel` audience filter: a level gate on an event with
    // no subject (encounter start) can only be applied per recipient.
    level: actor.system.level ?? actor.system.class?.system?.level ?? null,
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
 * Names of the recipient's own triggered abilities whose prose trigger matches
 * this event type. Deliberately generous: a false positive costs one glance, a
 * false negative costs the player their reaction.
 * @param {string} recipientUuid
 * @param {string} eventType
 * @returns {string[]}
 */
function ownTriggeredAbilities(recipientUuid, eventType) {
  // `fromUuidSync` throws on uuids it cannot resolve synchronously, and it was
  // sitting outside the guard: a single unresolvable recipient would abort the
  // whole dispatch, losing every notification in the batch rather than one
  // prose hint. This enrichment is a nicety; it must never cost a prompt.
  try {
    const actor = fromUuidSync(recipientUuid);
    return actor ? matchingTriggeredAbilities(actor, eventType) : [];
  } catch {
    return [];
  }
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

  const debug = game.settings.get(MODULE_ID, SETTINGS.debug);
  const notifications = matchEvent(entries, event, heroes, ledger, context, {
    disabled: disabledEntries(),
    onSuppressed: debug
      ? ({ entryId, recipientName, scope }) =>
        console.debug(`${MODULE_ID} | « ${entryId} » correspond pour ${recipientName}, mais sa fenêtre « ${scope} » est déjà consommée`)
      : undefined,
  });
  if (!notifications.length) return schedulePersist();

  // The prose scan belongs here, not in the observer. `matchingTriggeredAbilities`
  // answers "which of THIS actor's triggered abilities react to this event", and
  // the actor who reacts is almost never the subject: Parry, Feedback Loop and
  // Riposte all fire when an ALLY takes damage. Scanning the subject in the
  // observer meant the whole family was invisible, and it also meant the keyword
  // table was only ever consulted for three of its event types. Running it per
  // recipient makes every key live and puts the reminder in front of the player
  // who actually holds the ability.
  const stamped = notifications.map((notification) => {
    const own = ownTriggeredAbilities(notification.recipientUuid, event.type);
    return {
      ...notification,
      // Appended to the message rather than carried in a field of its own: a
      // field nothing renders is data that silently does nothing, and this
      // reminder is only worth computing if the player reads it.
      message: own.length
        ? `${notification.message} — tu as une action déclenchée qui répond à ça : ${own.join(", ")}.`
        : notification.message,
      ownAbilities: own,
      id: foundry.utils.randomID(),
      timestamp: Date.now(),
    };
  });

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

  // Older builds wrote claim keys straight into the flag, and Foundry expanded
  // their dots into a nested tree. That debris never matches a key again and
  // would sit in the combat forever, so clear the flag once before the first
  // write in the current shape.
  const legacy = Object.keys(stored).some((key) => key !== "records");
  if (legacy && combat) {
    try {
      await combat.unsetFlag(MODULE_ID, LEDGER_FLAG);
      console.info(`${MODULE_ID} | registre hérité illisible (clés éclatées par Foundry) — remis à zéro`);
    } catch (error) {
      console.warn(`${MODULE_ID} | impossible de nettoyer le registre hérité`, error);
    }
  }
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
