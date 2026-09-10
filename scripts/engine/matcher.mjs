/**
 * Catalogue matching: normalized event + catalogue entries → notifications.
 *
 * Pure. Everything Foundry-shaped is passed in already resolved, which keeps
 * this file testable and keeps the "what counts as a trigger" logic in one
 * readable place.
 */

import Ledger from "./ledger.mjs";

/* -------------------------------------------------- */

/** Comparison operators usable in a catalogue entry's `when` clause. */
export const OPERATORS = Object.freeze({
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  /** The value at `path` is one of `value`. */
  in: (a, b) => Array.isArray(b) && b.includes(a),
  notIn: (a, b) => Array.isArray(b) && !b.includes(a),
  /** The array at `path` contains `value`. */
  includes: (a, b) => Array.isArray(a) && a.includes(b),
  /** The array at `path` shares no member with `value`. */
  excludes: (a, b) => Array.isArray(a) && Array.isArray(b) && !a.some((x) => b.includes(x)),
  /** The array at `path` shares at least one member with `value`. */
  intersects: (a, b) => Array.isArray(a) && Array.isArray(b) && a.some((x) => b.includes(x)),
  exists: (a) => a !== undefined && a !== null,
  truthy: (a) => !!a,
  falsy: (a) => !a,
});

/* -------------------------------------------------- */

/**
 * Read a dotted path out of an object without throwing.
 * @param {object} object
 * @param {string} path
 * @returns {*}
 */
export function readPath(object, path) {
  return path.split(".").reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), object);
}

/* -------------------------------------------------- */

/**
 * Evaluate an entry's `when` clauses against an event. All clauses must pass.
 * @param {Array<{path: string, op: string, value?: *}>} clauses
 * @param {object} event
 * @returns {boolean}
 */
export function evaluateConditions(clauses, event) {
  if (!clauses?.length) return true;
  return clauses.every((clause) => {
    const operator = OPERATORS[clause.op];
    if (!operator) return false;
    return operator(readPath(event, clause.path), clause.value);
  });
}

/* -------------------------------------------------- */

/**
 * @typedef Recipient
 * @property {string} actorUuid
 * @property {string} name
 * @property {string|null} classId      Draw Steel identifier of the hero's class.
 * @property {string|null} subclassId
 * @property {number|null} level
 * @property {string[]} ownerIds        User ids who own this actor.
 * @property {number} distance          Squares from the event's origin token; Infinity when unknown.
 * @property {boolean} isSubject        Whether this hero is the one the event happened to.
 */

/**
 * Work out who an entry should notify.
 * @param {object} entry
 * @param {Recipient[]} heroes
 * @returns {Recipient[]}
 */
export function resolveAudience(entry, heroes) {
  const audience = entry.audience ?? { kind: "subject" };
  let pool;

  switch (audience.kind) {
    case "subject":
      pool = heroes.filter((h) => h.isSubject);
      break;
    case "allHeroes":
      pool = [...heroes];
      break;
    case "heroesWithin":
      pool = heroes.filter((h) => h.distance <= (audience.range ?? 10));
      break;
    case "director":
      // Handled by the dispatcher, which always includes the Director; no hero
      // recipient is produced here.
      return [];
    default:
      pool = [];
  }

  if (audience.class) pool = pool.filter((h) => h.classId === audience.class);
  if (audience.subclass) pool = pool.filter((h) => h.subclassId === audience.subclass);
  if (audience.excludeSubject) pool = pool.filter((h) => !h.isSubject);
  // A feature gained at a given level. Fails closed: a hero whose level can't
  // be read is left out rather than prompted for something they may not have.
  if (Number.isFinite(audience.minLevel)) {
    pool = pool.filter((h) => Number.isFinite(h.level) && h.level >= audience.minLevel);
  }

  return pool;
}

/* -------------------------------------------------- */

/**
 * @typedef Notification
 * @property {string} entryId
 * @property {string} label
 * @property {string} message
 * @property {string} [conditionText]  Human-verifiable precondition the module cannot check itself.
 * @property {string} [gain]           What the player should award themselves, for display only.
 * @property {string} severity         "info" or "decision".
 * @property {string} recipientUuid
 * @property {string} recipientName
 * @property {string[]} ownerIds
 * @property {string} reference
 * @property {string} eventType
 * @property {boolean} inferred
 */

/**
 * Match one event against the catalogue.
 *
 * @param {object[]} entries        Catalogue entries.
 * @param {object} event            Normalized event.
 * @param {Recipient[]} heroes      Candidate recipients, with distances resolved.
 * @param {Ledger} ledger
 * @param {import("./ledger.mjs").LedgerContext} context
 * @param {object} [options]
 * @param {Set<string>} [options.disabled]  Entry ids the Director switched off.
 * @returns {Notification[]}
 */
export function matchEvent(entries, event, heroes, ledger, context, { disabled, onSuppressed } = {}) {
  const notifications = [];

  for (const entry of entries) {
    if (entry.event !== event.type) continue;
    if (disabled?.has(entry.id)) continue;
    if (!evaluateConditions(entry.when, event)) continue;

    for (const recipient of resolveAudience(entry, heroes)) {
      const key = Ledger.key(entry.id, recipient.actorUuid);
      if (!ledger.claim(key, entry.once, context)) {
        // An entry that matched everything and was then dropped because its
        // "first time this turn" window was already spent used to vanish without
        // a trace, which makes a working entry indistinguishable from a broken
        // one — the exact confusion that cost a debugging session. Report it so
        // the debug log can say "suppressed", not nothing.
        onSuppressed?.({ entryId: entry.id, recipientName: recipient.name, scope: entry.once });
        continue;
      }

      notifications.push({
        entryId: entry.id,
        label: entry.label,
        message: interpolate(entry.message, event, recipient),
        conditionText: entry.conditionText ? interpolate(entry.conditionText, event, recipient) : undefined,
        gain: entry.gain,
        severity: entry.severity ?? "info",
        recipientUuid: recipient.actorUuid,
        recipientName: recipient.name,
        ownerIds: recipient.ownerIds,
        reference: entry.reference ?? "",
        eventType: event.type,
        inferred: !!entry.inferred || !!event.inferred,
      });
    }
  }

  return notifications;
}

/* -------------------------------------------------- */

/**
 * Substitute `{subject}`, `{recipient}`, `{amount}`, `{ability}`, `{condition}`
 * and `{tier}` into a message.
 * @param {string} template
 * @param {object} event
 * @param {Recipient} recipient
 * @returns {string}
 */
export function interpolate(template, event, recipient) {
  if (!template) return "";
  const values = {
    subject: event.subject?.name ?? "?",
    recipient: recipient?.name ?? "?",
    amount: event.data?.amount ?? "",
    ability: event.data?.abilityName ?? "",
    condition: event.data?.conditionLabel ?? event.data?.conditionId ?? "",
    tier: event.data?.tier ?? "",
    source: event.data?.sourceName ?? "",
  };
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (key in values) return String(values[key]);
    // Anything else falls through to the event payload, so catalogue entries can
    // surface observer-computed fields without this file knowing about them.
    const fromData = event.data?.[key];
    if (fromData === undefined || fromData === null) return match;
    return Array.isArray(fromData) ? fromData.join(", ") : String(fromData);
  });
}
