/**
 * "First time this turn / round / encounter" bookkeeping.
 *
 * Draw Steel leans heavily on once-per-window triggers — the fury's ferocity on
 * taking damage is once per round, the conduit's domain piety once per
 * encounter, the fury's Stormwight surge once per turn. Getting this wrong in
 * either direction is worse than not notifying at all: a duplicate notification
 * teaches players to ignore the module, a missed one defeats its purpose.
 *
 * Pure data structure, no Foundry dependency. Persistence lives elsewhere.
 */

/**
 * @typedef LedgerContext
 * @property {string} encounterId  Identifies the current encounter.
 * @property {number} round        Current combat round.
 * @property {string} turnKey      Identifies the current turn within the encounter.
 */

export default class Ledger {
  /** @type {Record<string, {encounterId: string, round: number, turnKey: string}>} */
  #state;

  /** @type {boolean} */
  #dirty = false;

  /**
   * @param {object} [state]  Previously persisted state.
   */
  constructor(state = {}) {
    this.#state = foundryDeepClone(state);
  }

  /* -------------------------------------------------- */

  /** Whether anything changed since the last {@link flush}. */
  get dirty() {
    return this.#dirty;
  }

  /** The serialisable state. */
  toJSON() {
    return foundryDeepClone(this.#state);
  }

  /** Mark the current state as persisted. */
  flush() {
    this.#dirty = false;
  }

  /* -------------------------------------------------- */

  /**
   * Build the key under which a claim is recorded.
   *
   * The recipient is part of the key on purpose: "the first time each round that
   * you take damage" is per fury, not per table. Two furies each get their own
   * window.
   *
   * @param {string} entryId
   * @param {string} recipientUuid
   * @returns {string}
   */
  static key(entryId, recipientUuid) {
    return `${entryId}::${recipientUuid}`;
  }

  /* -------------------------------------------------- */

  /**
   * Test whether a claim would succeed, without consuming it.
   * @param {string} key
   * @param {"turn"|"round"|"encounter"|null|undefined} scope
   * @param {LedgerContext} context
   * @returns {boolean}
   */
  available(key, scope, context) {
    if (!scope) return true;
    const record = this.#state[key];
    if (!record) return true;
    if (record.encounterId !== context.encounterId) return true;

    switch (scope) {
      case "encounter": return false;
      case "round": return record.round !== context.round;
      case "turn": return record.turnKey !== context.turnKey;
      default: return true;
    }
  }

  /* -------------------------------------------------- */

  /**
   * Consume the window if it is open.
   * @param {string} key
   * @param {"turn"|"round"|"encounter"|null|undefined} scope
   * @param {LedgerContext} context
   * @returns {boolean} True when this is the first occurrence in the window.
   */
  claim(key, scope, context) {
    if (!this.available(key, scope, context)) return false;
    if (scope) {
      this.#state[key] = {
        encounterId: context.encounterId,
        round: context.round,
        turnKey: context.turnKey,
      };
      this.#dirty = true;
    }
    return true;
  }

  /* -------------------------------------------------- */

  /**
   * Drop every record belonging to encounters other than the current one.
   * Called when a combat starts, so the store does not grow without bound.
   * @param {string} encounterId
   */
  pruneToEncounter(encounterId) {
    for (const [key, record] of Object.entries(this.#state)) {
      if (record.encounterId !== encounterId) {
        delete this.#state[key];
        this.#dirty = true;
      }
    }
  }

  /* -------------------------------------------------- */

  /** Forget everything. */
  clear() {
    if (Object.keys(this.#state).length) this.#dirty = true;
    this.#state = {};
  }

  /* -------------------------------------------------- */

  /** Number of records held, for diagnostics. */
  get size() {
    return Object.keys(this.#state).length;
  }
}

/* -------------------------------------------------- */

/**
 * `foundry.utils.deepClone` when running inside Foundry, structured clone
 * otherwise, so this module stays testable in plain Node.
 * @param {object} value
 * @returns {object}
 */
function foundryDeepClone(value) {
  if (globalThis.foundry?.utils?.deepClone) return globalThis.foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value ?? {}));
}
