/** Module-wide constants. */

export const MODULE_ID = "draw-steel-triggers";
export const SYSTEM_ID = "draw-steel";
export const SOCKET = `module.${MODULE_ID}`;

export const modulePath = (path) => `modules/${MODULE_ID}/${path}`;

/* -------------------------------------------------- */

/**
 * Normalized event types.
 *
 * The Draw Steel system emits almost no semantic hooks — only data-preparation
 * hooks, `combatTurn`/`combatTurnChange`, and `modifyTokenAttribute`. So none of
 * these come from the system: every one is reconstructed by observing state
 * diffs and chat messages. `engine/observers.mjs` is where that happens, and it
 * is the only file that knows about Foundry hooks.
 */
export const EVENTS = Object.freeze({
  /** A combat encounter began. */
  encounterStart: "encounterStart",
  /** A new combat round began. */
  roundStart: "roundStart",
  /** A combatant's turn began. */
  turnStart: "turnStart",
  /** A combatant's turn ended. */
  turnEnd: "turnEnd",
  /** An actor lost Stamina. */
  damageTaken: "damageTaken",
  /** An actor regained Stamina. */
  healed: "healed",
  /** An actor crossed its winded threshold downward. */
  becameWinded: "becameWinded",
  /** A hero dropped to 0 Stamina or below. */
  becameDying: "becameDying",
  /** A creature was reduced to 0 Stamina. */
  reducedToZero: "reducedToZero",
  /** A condition (status effect) was applied. */
  conditionApplied: "conditionApplied",
  /** A condition was removed. */
  conditionRemoved: "conditionRemoved",
  /** An ability was used (from its chat message). */
  abilityUsed: "abilityUsed",
  /** A power roll resolved at a given tier. */
  powerRollResolved: "powerRollResolved",
  /** A natural 19 or 20 was rolled. */
  naturalCritical: "naturalCritical",
  /**
   * Any natural roll, carrying its value in `data.natural`.
   *
   * The troubadour's Melodrama rewards a natural 2 as readily as Drama rewards
   * a natural 19-20, so the raw value has to be available and not only the
   * critical band.
   */
  naturalRoll: "naturalRoll",
  /** An ability carrying a forced-movement effect resolved. Inferred, not observed. */
  forcedMovementLikely: "forcedMovementLikely",
  /** The Director spent Malice on an ability. */
  maliceSpent: "maliceSpent",
  /** An actor's heroic resource changed. */
  resourceChanged: "resourceChanged",
  /** An actor gained temporary Stamina. */
  temporaryStaminaGained: "temporaryStaminaGained",
});

/* -------------------------------------------------- */

/** How long a "first time" window lasts. */
export const ONCE_SCOPES = Object.freeze(["turn", "round", "encounter"]);

/** How loudly an entry announces itself. */
export const SEVERITIES = Object.freeze(["info", "decision"]);

/** Who gets told. */
export const AUDIENCE_KINDS = Object.freeze(["subject", "allHeroes", "heroesWithin", "director"]);

/* -------------------------------------------------- */

export const SETTINGS = Object.freeze({
  enabled: "enabled",
  notifyStyle: "notifyStyle",
  showToDirector: "showToDirector",
  toastDuration: "toastDuration",
  chatArchive: "chatArchive",
  logSize: "logSize",
  userCatalog: "userCatalog",
  disabledEntries: "disabledEntries",
  inferForcedMovement: "inferForcedMovement",
  ledger: "ledger",
  debug: "debug",
});

/** Flag scope on the Combat document where the "first time" ledger lives. */
export const LEDGER_FLAG = "ledger";
