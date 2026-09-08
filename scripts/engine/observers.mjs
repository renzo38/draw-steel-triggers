/**
 * Foundry hooks → normalized events.
 *
 * This is the only file that knows about Foundry hooks, and the only one that
 * has to cope with the fact that the Draw Steel system emits no semantic events.
 * Everything here is reconstruction: comparing an actor before and after an
 * update, reading the structured parts of a chat message, watching effects come
 * and go.
 *
 * Detection runs on exactly one client — the authoritative GM — because every
 * connected client sees the same `updateActor` hook and we want one event, not
 * one per player.
 */

import { EVENTS, MODULE_ID, SETTINGS } from "../constants.mjs";

/** @type {(event: object) => void} */
let emit = () => {};

/* -------------------------------------------------- */

/**
 * Keywords that suggest a free-text trigger matches an event type.
 *
 * `AbilityModel.trigger` is a plain StringField — there is no machine-readable
 * trigger anywhere in the system — so a hero's triggered abilities can only be
 * surfaced by reading their prose. Both languages are listed because a table may
 * run translated content against English compendia.
 */
/**
 * Message part types that carry a resolved power roll.
 *
 * `abilityResult` appears only when the ability was used with no token targeted;
 * as soon as a target is selected — the normal way to play — the system emits
 * `targetResult` instead, one per target, with the same `abilityUuid` and
 * `tier`. Watching only the first name made every targeted ability invisible.
 */
export const RESULT_PART_TYPES = Object.freeze(["abilityResult", "targetResult"]);

export const TRIGGER_KEYWORDS = Object.freeze({
  [EVENTS.damageTaken]: ["take damage", "takes damage", "damaged by", "subit des dégâts", "subissez des dégâts", "dégâts d'une"],
  [EVENTS.becameWinded]: ["winded", "essouffl"],
  [EVENTS.becameDying]: ["dying", "mourant"],
  [EVENTS.conditionApplied]: ["condition", "is subjected", "est soumis"],
  [EVENTS.abilityUsed]: ["uses an ability", "uses a main action", "utilise une capacité", "utilise une action"],
  [EVENTS.forcedMovementLikely]: ["force moved", "is pushed", "mu de force", "poussé"],
  [EVENTS.turnEnd]: ["ends their turn", "termine son tour", "finit son tour"],
  [EVENTS.turnStart]: ["starts their turn", "commence son tour", "débute son tour"],
});

/* -------------------------------------------------- */
/*  Actor description                                 */
/* -------------------------------------------------- */

/**
 * The Draw Steel identifier of a hero's class, used by catalogue entries.
 * @param {Actor} actor
 * @returns {string|null}
 */
export function classIdOf(actor) {
  if (actor?.type !== "hero") return null;
  const cls = actor.system.class;
  if (!cls) return null;
  return cls.dsid ?? cls.system?.dsid ?? cls.name?.slugify?.({ strict: true }) ?? null;
}

/* -------------------------------------------------- */

/**
 * @param {Actor} actor
 * @returns {string|null}
 */
export function subclassIdOf(actor) {
  const subclass = actor?.items?.find((item) => item.type === "subclass");
  if (!subclass) return null;
  return subclass.dsid ?? subclass.system?.dsid ?? subclass.name?.slugify?.({ strict: true }) ?? null;
}

/* -------------------------------------------------- */

/**
 * Highest heroic resource each hero has held during the current turn.
 *
 * Draw Steel is explicit that Growing Ferocity benefits "last until the end of
 * your turn, even if a benefit would become unavailable to you because of the
 * amount of ferocity you spend during your turn". Reading the resource at the
 * moment a benefit triggers is therefore wrong: a fury who reaches 5 ferocity
 * and then spends 3 on the very ability that pushes still keeps the benefit.
 * Only the peak reached during the turn decides.
 * @type {Map<string, number>}
 */
const resourcePeaks = new Map();

/* -------------------------------------------------- */

/**
 * Compact description of the actor an event is about.
 * @param {Actor} actor
 * @param {TokenDocument} [token]
 * @returns {object}
 */
export function describeSubject(actor, token) {
  const disposition = token
    ? { [-1]: "hostile", 0: "neutral", 1: "friendly", [-2]: "secret" }[token.disposition] ?? "neutral"
    : null;

  const resourceValue = actor.type === "hero" ? actor.system.hero?.primary?.value ?? null : null;
  const peak = resourcePeaks.get(actor.uuid);

  return {
    actorUuid: actor.uuid,
    tokenId: token?.id ?? null,
    name: token?.name ?? actor.name,
    type: actor.type,
    disposition,
    classId: classIdOf(actor),
    subclassId: subclassIdOf(actor),
    // Several resource gains scale with level ("2 ferocity instead of 1" at
    // 4th, "3 instead of 2" at 10th), so entries need the level to be right.
    level: actor.system.level ?? actor.system.class?.system?.level ?? null,
    /** Draw Steel identifier of the equipped kit — stormwight kits carry their own benefit tables. */
    kitId: actor.items?.find?.((item) => item.type === "kit")?.dsid ?? null,
    resourceValue,
    resourceLabel: actor.type === "hero" ? actor.system.hero?.primary?.label ?? "" : "",
    /** Highest value held this turn — the number threshold benefits are read against. */
    resourcePeakThisTurn: Math.max(peak ?? Number.NEGATIVE_INFINITY, resourceValue ?? Number.NEGATIVE_INFINITY),
  };
}

/* -------------------------------------------------- */

/**
 * Triggered abilities on this actor whose prose trigger mentions the event.
 *
 * Deliberately generous: a false positive costs the player one glance, a false
 * negative costs them their reaction.
 * @param {Actor} actor
 * @param {string} eventType
 * @returns {string[]} Ability names.
 */
export function matchingTriggeredAbilities(actor, eventType) {
  const keywords = TRIGGER_KEYWORDS[eventType];
  if (!keywords?.length) return [];

  const names = [];
  for (const item of actor.items) {
    if (item.type !== "ability") continue;
    if (!["triggered", "freeTriggered"].includes(item.system.type)) continue;
    const trigger = (item.system.trigger ?? "").toLowerCase();
    if (!trigger) continue;
    if (keywords.some((keyword) => trigger.includes(keyword))) names.push(item.name);
  }
  return names;
}

/* -------------------------------------------------- */
/*  Recent damage context                             */
/* -------------------------------------------------- */

/**
 * Damage types are not carried on the actor update that applies them, so we
 * remember what was just rolled and attach it to a Stamina drop that follows
 * closely. This is a heuristic, and everything derived from it is flagged
 * `damageTypesInferred` so the UI can hedge.
 * @type {{types: string[], abilityName: string, at: number}|null}
 */
let recentDamage = null;
const RECENT_DAMAGE_WINDOW_MS = 6000;

function rememberDamage(types, abilityName) {
  if (!types?.length) return;
  recentDamage = { types, abilityName, at: Date.now() };
}

function recallDamage() {
  if (!recentDamage) return null;
  if (Date.now() - recentDamage.at > RECENT_DAMAGE_WINDOW_MS) {
    recentDamage = null;
    return null;
  }
  return recentDamage;
}

/* -------------------------------------------------- */
/*  Hook registration                                 */
/* -------------------------------------------------- */

/**
 * Register every observer.
 * @param {(event: object) => void} dispatch  Called with each normalized event.
 */
export function registerObservers(dispatch) {
  emit = dispatch;

  Hooks.on("preUpdateActor", onPreUpdateActor);
  Hooks.on("updateActor", onUpdateActor);
  Hooks.on("createActiveEffect", (effect, options, userId) => onEffectChange(effect, true));
  Hooks.on("deleteActiveEffect", (effect, options, userId) => onEffectChange(effect, false));
  Hooks.on("createChatMessage", onCreateChatMessage);
  Hooks.on("combatStart", onCombatStart);
  Hooks.on("combatRound", onCombatRound);
  Hooks.on("combatTurnChange", onCombatTurnChange);
}

/* -------------------------------------------------- */

/** Whether this client is the one responsible for detection. */
function isAuthority() {
  if (!game.settings.get(MODULE_ID, SETTINGS.enabled)) return false;
  return game.user === game.users.activeGM;
}

/* -------------------------------------------------- */

/**
 * Stash the pre-update values we need to compute deltas.
 * @param {Actor} actor
 * @param {object} changes
 * @param {object} options
 */
function onPreUpdateActor(actor, changes, options) {
  if (!isAuthority()) return;
  const touchesStamina = foundry.utils.hasProperty(changes, "system.stamina");
  const touchesResource = foundry.utils.hasProperty(changes, "system.hero.primary.value");
  if (!touchesStamina && !touchesResource) return;

  options[MODULE_ID] = {
    stamina: actor.system.stamina?.value ?? null,
    temporary: actor.system.stamina?.temporary ?? 0,
    resource: actor.system.hero?.primary?.value ?? null,
  };
}

/* -------------------------------------------------- */

/**
 * Derive damage, healing, winded and dying from a Stamina change.
 * @param {Actor} actor
 * @param {object} changes
 * @param {object} options
 */
function onUpdateActor(actor, changes, options) {
  if (!isAuthority()) return;
  const before = options[MODULE_ID];
  if (!before) return;

  const token = actor.getActiveTokens(false, true)[0] ?? null;
  const subject = describeSubject(actor, token);
  const stamina = actor.system.stamina ?? {};
  const after = stamina.value ?? 0;
  const afterTemp = stamina.temporary ?? 0;
  const windedAt = stamina.winded ?? Math.floor((stamina.max || 0) / 2);

  // Temporary Stamina absorbs damage first, so the real hit is the drop in the
  // combined pool, not in `value` alone.
  if (before.stamina !== null) {
    const poolBefore = before.stamina + (before.temporary ?? 0);
    const poolAfter = after + afterTemp;
    const delta = poolBefore - poolAfter;

    if (delta > 0) {
      const recalled = recallDamage();
      emit({
        type: EVENTS.damageTaken,
        subject,
        origin: { tokenId: token?.id ?? null },
        data: {
          amount: delta,
          // Damage types never travel on the actor update that applies them, so
          // this is whatever was rolled moments ago, or an empty list when we
          // genuinely do not know. Empty is deliberate: an entry that needs a
          // specific type must not fire on a guess, while an entry that only
          // needs "not holy, not untyped" still can.
          damageTypes: recalled?.types ?? [],
          damageTypesInferred: !recalled,
          sourceName: recalled?.abilityName ?? "",
          remaining: after,
          matchingTriggeredAbilities: matchingTriggeredAbilities(actor, EVENTS.damageTaken),
        },
      });
    } else if (delta < 0) {
      emit({ type: EVENTS.healed, subject, origin: { tokenId: token?.id ?? null }, data: { amount: -delta } });
    }

    if (afterTemp > (before.temporary ?? 0)) {
      emit({
        type: EVENTS.temporaryStaminaGained,
        subject,
        origin: { tokenId: token?.id ?? null },
        data: { amount: afterTemp - (before.temporary ?? 0) },
      });
    }

    // Threshold crossings, computed rather than guessed.
    const wasWinded = before.stamina <= windedAt;
    if (!wasWinded && after <= windedAt && after > 0) {
      emit({ type: EVENTS.becameWinded, subject, origin: { tokenId: token?.id ?? null }, data: {} });
    }

    if (before.stamina > 0 && after <= 0) {
      const dead = actor.type === "hero" ? after <= -windedAt : true;
      emit({
        type: actor.type === "hero" ? EVENTS.becameDying : EVENTS.reducedToZero,
        subject,
        origin: { tokenId: token?.id ?? null },
        data: { dead },
      });
    }
  }

  if (before.resource !== null) {
    const now = actor.system.hero?.primary?.value ?? 0;
    if (now !== before.resource) {
      // Record the peak before emitting, so an entry reacting to this event
      // already sees the new high-water mark.
      const peak = resourcePeaks.get(actor.uuid) ?? Number.NEGATIVE_INFINITY;
      if (now > peak) resourcePeaks.set(actor.uuid, now);

      emit({
        type: EVENTS.resourceChanged,
        subject: describeSubject(actor, token),
        origin: { tokenId: token?.id ?? null },
        data: { from: before.resource, to: now, delta: now - before.resource },
      });
    }
  }
}

/* -------------------------------------------------- */

/**
 * @param {ActiveEffect} effect
 * @param {boolean} applied
 */
function onEffectChange(effect, applied) {
  if (!isAuthority()) return;
  const actor = effect.parent;
  if (!(actor instanceof Actor)) return;

  const statuses = [...(effect.statuses ?? [])];
  if (!statuses.length) return;

  const token = actor.getActiveTokens(false, true)[0] ?? null;
  for (const status of statuses) {
    emit({
      type: applied ? EVENTS.conditionApplied : EVENTS.conditionRemoved,
      subject: describeSubject(actor, token),
      origin: { tokenId: token?.id ?? null },
      data: {
        conditionId: status,
        conditionLabel: statusLabel(status),
      },
    });
  }
}

/* -------------------------------------------------- */

/**
 * Localized name of a status.
 *
 * The Draw Steel system re-shapes `CONFIG.statusEffects` into an object keyed by
 * id (`CONFIG.statusEffects[statusId]`) rather than the core array, so both
 * shapes are handled here instead of assuming either.
 * @param {string} statusId
 * @returns {string}
 */
function statusLabel(statusId) {
  const config = CONFIG.statusEffects;
  const entry = Array.isArray(config)
    ? config.find((status) => status.id === statusId)
    : config?.[statusId];
  return game.i18n.localize(entry?.name ?? statusId);
}

/* -------------------------------------------------- */

/**
 * Read the structured parts of a Draw Steel chat message.
 *
 * `message.system.parts` carries `abilityUse` (with `abilityUuid`) and
 * `abilityResult` (with `abilityUuid` and the achieved `tier`), which is the
 * one genuinely reliable signal the system gives us about what just happened.
 * @param {ChatMessage} message
 */
function onCreateChatMessage(message) {
  if (!isAuthority()) return;
  const parts = message.system?.parts;
  if (!parts) return;

  const actor = message.speakerActor ?? ChatMessage.getSpeakerActor(message.speaker);
  if (!actor) return;
  const token = canvas.tokens?.get(message.speaker?.token)?.document
    ?? actor.getActiveTokens(false, true)[0]
    ?? null;
  const subject = describeSubject(actor, token);
  const origin = { tokenId: token?.id ?? null };

  emitNaturalRoll(message, subject, origin);

  // Results are aggregated before being emitted. An ability used against three
  // targets produces three result parts, and firing three identical events
  // would show the player three identical toasts.
  /** @type {Map<string, {ability: Item, tiers: Set<number>, targets: string[]}>} */
  const results = new Map();

  for (const part of parts) {
    const ability = part.ability;
    if (!ability) continue;
    const system = ability.system;

    // The system emits `abilityResult` only when the ability was used with no
    // target selected. As soon as a token is targeted — the normal way to play —
    // each result arrives as a `targetResult` part instead, carrying the same
    // `abilityUuid` and `tier` plus the target. Watching only `abilityResult`
    // meant every targeted ability went unseen.
    if (RESULT_PART_TYPES.includes(part.type)) {
      const entry = results.get(ability.uuid) ?? { ability, tiers: new Set(), targets: [] };
      if (Number.isFinite(part.tier)) entry.tiers.add(part.tier);
      if (part.targetUuid) entry.targets.push(part.targetUuid);
      results.set(ability.uuid, entry);
      continue;
    }

    if (part.type === "abilityUse") {
      emit({
        type: EVENTS.abilityUsed,
        subject,
        origin,
        data: {
          abilityUuid: ability.uuid,
          abilityName: ability.name,
          abilityType: system.type,
          keywords: [...(system.keywords ?? [])],
          resourceCost: system.resource ?? 0,
        },
      });

      // The Director spending Malice is a first-class event for the null.
      if (actor.type === "npc" && (system.resource ?? 0) > 0) {
        emit({
          type: EVENTS.maliceSpent,
          subject,
          origin,
          data: { abilityName: ability.name, amount: system.resource },
        });
      }
    }

  }

  for (const { ability, tiers, targets } of results.values()) {
    emitAbilityResult(ability, [...tiers].sort((a, b) => a - b), targets, subject, origin);
  }
}

/* -------------------------------------------------- */

/**
 * Reduce a set of power roll effects to what actually happened at the achieved
 * tiers.
 *
 * Pure — no Foundry globals — because this is the part that decides whether a
 * push, a grab or a prone was inflicted, and it deserves a test that does not
 * need a browser.
 *
 * @param {Array<{constructor: {TYPE: string}}>} effects  Power roll effects of the ability.
 * @param {number[]} tiers  Every tier achieved in this message.
 * @returns {{damageTypes: string[], movementTypes: string[], appliedConditions: string[], dealtDamage: boolean}}
 */
export function collectTierOutcomes(effects, tiers) {
  const damageTypes = new Set();
  const movementTypes = new Set();
  const appliedConditions = new Set();
  let dealtDamage = false;

  for (const effect of effects) {
    const type = effect?.constructor?.TYPE ?? effect?.type;
    if (!type) continue;
    for (const tier of tiers) {
      const bucket = effect[type]?.[`tier${tier}`];
      if (!bucket) continue;
      if (type === "damage") {
        dealtDamage = true;
        for (const t of bucket.types ?? []) damageTypes.add(t);
      }
      // Push, pull and slide are not interchangeable: the berserker's benefit is
      // on a push specifically, the reaver's on a slide, so the kind has to
      // travel with the event.
      if (type === "forced") for (const m of bucket.movement ?? []) movementTypes.add(m);
      if (type === "applied") for (const c of Object.keys(bucket.effects ?? {})) appliedConditions.add(c);
    }
  }

  return {
    damageTypes: [...damageTypes],
    movementTypes: [...movementTypes],
    appliedConditions: [...appliedConditions],
    dealtDamage,
  };
}

/* -------------------------------------------------- */

/**
 * Emit the aggregated outcome of one ability.
 *
 * Different targets can land on different tiers when edges or banes apply, so
 * every achieved tier is inspected: if any of them carried forced movement, the
 * creature did force someone, and that is what the benefit tables ask about.
 *
 * @param {Item} ability
 * @param {number[]} tiers    Every tier achieved by this ability in this message.
 * @param {string[]} targets  Actor UUIDs of the creatures affected, when known.
 * @param {object} subject
 * @param {object} origin
 */
function emitAbilityResult(ability, tiers, targets, subject, origin) {
  if (!tiers.length) return;
  const system = ability.system;
  const { damageTypes, movementTypes, appliedConditions, dealtDamage } =
    collectTierOutcomes([...(system.power?.effects ?? [])], tiers);

  if (damageTypes.length) rememberDamage(damageTypes, ability.name);

  const targetNames = targets
    .map((uuid) => fromUuidSync(uuid)?.name)
    .filter(Boolean);

  const data = {
    abilityUuid: ability.uuid,
    abilityName: ability.name,
    abilityType: system.type,
    tier: Math.max(...tiers),
    tiers,
    dealtDamage,
    damageTypes,
    movementTypes,
    appliedConditions,
    targetNames,
    targetCount: targets.length,
  };

  emit({ type: EVENTS.powerRollResolved, subject, origin, data });

  if (movementTypes.length && game.settings.get(MODULE_ID, SETTINGS.inferForcedMovement)) {
    // The system does not automate forced movement — `forced-movement-effect`
    // renders text and nothing else — so there is no event to observe. All we
    // can honestly say is that an ability carrying forced movement resolved.
    emit({ type: EVENTS.forcedMovementLikely, subject, origin, inferred: true, data });
  }
}

/* -------------------------------------------------- */

/**
 * Surface a natural 19 or 20 from the message's rolls.
 * @param {ChatMessage} message
 * @param {object} subject
 * @param {object} origin
 */
function emitNaturalRoll(message, subject, origin) {
  // Rolls live on the message itself and, for Draw Steel, also inside each
  // message part — check both rather than betting on one.
  const rolls = [
    ...(message.rolls ?? []),
    ...[...(message.system?.parts ?? [])].flatMap((part) => part.rolls ?? []),
  ];

  let announced = false;
  for (const roll of rolls) {
    const natural = roll?.dice?.[0]?.total;
    if (!Number.isFinite(natural)) continue;
    if (announced) continue;
    announced = true;
    emit({ type: EVENTS.naturalRoll, subject, origin, data: { natural } });
    if (natural >= 19) {
      emit({ type: EVENTS.naturalCritical, subject, origin, data: { natural } });
    }
  }
}

/* -------------------------------------------------- */

/** @param {Combat} combat */
function onCombatStart(combat) {
  if (!isAuthority()) return;
  emit({ type: EVENTS.encounterStart, subject: null, origin: null, data: { round: combat.round } });
}

/* -------------------------------------------------- */

/** @param {Combat} combat */
function onCombatRound(combat) {
  if (!isAuthority()) return;
  emit({ type: EVENTS.roundStart, subject: null, origin: null, data: { round: combat.round } });
}

/* -------------------------------------------------- */

/**
 * @param {Combat} combat
 * @param {object} previous
 * @param {object} current
 */
function onCombatTurnChange(combat, previous, current) {
  if (!isAuthority()) return;

  const ending = combat.combatants.get(previous?.combatantId);
  if (ending?.actor) emitTurnEnd(ending);

  const starting = combat.combatants.get(current?.combatantId);
  if (starting?.actor) emitTurnStart(starting);
}

/* -------------------------------------------------- */

/** @param {Combatant} combatant */
function emitTurnStart(combatant) {
  const actor = combatant.actor;
  const token = combatant.token;
  const cls = actor.system.class;

  // A new turn resets the high-water mark that threshold benefits are read
  // against. The start-of-turn gain itself lands right after and raises it.
  resourcePeaks.set(actor.uuid, actor.system.hero?.primary?.value ?? Number.NEGATIVE_INFINITY);

  emit({
    type: EVENTS.turnStart,
    subject: describeSubject(actor, token),
    origin: { tokenId: token?.id ?? null },
    data: {
      turnGain: cls?.system?.turnGain ?? null,
      resourceLabel: actor.system.hero?.primary?.label ?? "",
      resourceValue: actor.system.hero?.primary?.value ?? null,
      matchingTriggeredAbilities: matchingTriggeredAbilities(actor, EVENTS.turnStart),
    },
  });
}

/* -------------------------------------------------- */

/** @param {Combatant} combatant */
function emitTurnEnd(combatant) {
  const actor = combatant.actor;
  const token = combatant.token;

  // Effects a saving throw can end are the single most-forgotten piece of
  // end-of-turn bookkeeping, so count them precisely rather than reminding blind.
  // `CONFIG.DRAW_STEEL` is the namespace the system's wiki commits to for
  // module authors; `ds.CONFIG` is the same object under the internal global.
  const saveExpiry = CONFIG.DRAW_STEEL?.effectEnds?.save?.expiryEvent;
  const saveEnds = actor.effects.filter((effect) => {
    if (saveExpiry && effect.duration?.expiry === saveExpiry) return true;
    // Pre-1.2 documents kept the marker on the system data instead.
    return (effect.system?.end?.type ?? effect.system?.end) === "save";
  });

  const resourceValue = actor.system.hero?.primary?.value ?? null;

  emit({
    type: EVENTS.turnEnd,
    subject: describeSubject(actor, token),
    origin: { tokenId: token?.id ?? null },
    data: {
      saveEndsCount: saveEnds.length,
      saveEndsLabels: saveEnds.map((effect) => effect.name),
      resourceValue,
      strainDamage: resourceValue !== null && resourceValue < 0 ? Math.abs(resourceValue) : 0,
      matchingTriggeredAbilities: matchingTriggeredAbilities(actor, EVENTS.turnEnd),
    },
  });
}
