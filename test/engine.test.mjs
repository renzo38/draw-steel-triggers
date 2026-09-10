/**
 * Engine tests, runnable with `node test/engine.test.mjs`.
 *
 * Covers the ledger (the part that decides whether a notification fires at all),
 * the matcher, and the shipped catalogue's conformance to its own schema.
 * observers.mjs and dispatcher.mjs are excluded: they are the Foundry-coupled
 * layer, and nothing in them decides correctness on its own.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import Ledger from "../scripts/engine/ledger.mjs";
import { RESULT_PART_TYPES, TRIGGER_KEYWORDS, collectTierOutcomes } from "../scripts/engine/observers.mjs";
import { runTemplateTests } from "./templates.test.mjs";
import { evaluateConditions, interpolate, matchEvent, readPath, resolveAudience } from "../scripts/engine/matcher.mjs";
import { validateCatalog, validateEntry } from "../scripts/catalog/catalog-validation.mjs";
import { EVENTS } from "../scripts/constants.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The catalogue as actually shipped — several tests run real entries against synthetic events. */
const shipped = JSON.parse(readFileSync(join(here, "../scripts/catalog/default-catalog.json"), "utf8"));

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
};

/* -------------------------------------------------- */

const ctx = (overrides = {}) => ({ encounterId: "c1", round: 1, turnKey: "1:0", ...overrides });

const hero = (name, overrides = {}) => ({
  actorUuid: `Actor.${name}`,
  name,
  classId: "fury",
  subclassId: null,
  ownerIds: ["u1"],
  distance: 0,
  isSubject: false,
  ...overrides,
});

/* -------------------------------------------------- */

console.log("\nLedger — fenêtres « première fois »");

test("a null scope always fires", () => {
  const ledger = new Ledger();
  for (let i = 0; i < 5; i++) assert.equal(ledger.claim("k", null, ctx()), true);
});

test("an encounter window fires once and stays shut across rounds", () => {
  const ledger = new Ledger();
  assert.equal(ledger.claim("k", "encounter", ctx({ round: 1 })), true);
  assert.equal(ledger.claim("k", "encounter", ctx({ round: 1 })), false);
  assert.equal(ledger.claim("k", "encounter", ctx({ round: 7 })), false);
});

test("a round window reopens on the next round", () => {
  const ledger = new Ledger();
  assert.equal(ledger.claim("k", "round", ctx({ round: 1 })), true);
  assert.equal(ledger.claim("k", "round", ctx({ round: 1 })), false);
  assert.equal(ledger.claim("k", "round", ctx({ round: 2 })), true);
});

test("a turn window reopens on the next turn of the same round", () => {
  const ledger = new Ledger();
  assert.equal(ledger.claim("k", "turn", ctx({ turnKey: "1:0" })), true);
  assert.equal(ledger.claim("k", "turn", ctx({ turnKey: "1:0" })), false);
  assert.equal(ledger.claim("k", "turn", ctx({ turnKey: "1:1" })), true);
});

test("a new encounter reopens every window", () => {
  const ledger = new Ledger();
  ledger.claim("k", "encounter", ctx({ encounterId: "c1" }));
  assert.equal(ledger.claim("k", "encounter", ctx({ encounterId: "c2" })), true);
});

test("two heroes each get their own window", () => {
  const ledger = new Ledger();
  const a = Ledger.key("fury.ferocity.damaged", "Actor.Tavik");
  const b = Ledger.key("fury.ferocity.damaged", "Actor.Gorek");
  assert.equal(ledger.claim(a, "round", ctx()), true);
  assert.equal(ledger.claim(b, "round", ctx()), true, "the second fury lost their window to the first");
  assert.equal(ledger.claim(a, "round", ctx()), false);
});

test("available() does not consume the window", () => {
  const ledger = new Ledger();
  assert.equal(ledger.available("k", "round", ctx()), true);
  assert.equal(ledger.available("k", "round", ctx()), true);
  assert.equal(ledger.claim("k", "round", ctx()), true);
  assert.equal(ledger.available("k", "round", ctx()), false);
});

test("state round-trips through serialisation", () => {
  const ledger = new Ledger();
  ledger.claim("k", "round", ctx());
  const revived = new Ledger(ledger.toJSON());
  assert.equal(revived.claim("k", "round", ctx()), false, "a reload lost the window");
});

test("l'état persisté survit à l'expansion des clés pointées par Foundry", () => {
  // LE bug du 10 septembre. `setFlag` fait passer la valeur par `expandObject`,
  // qui transforme toute clé contenant un point en arborescence. Les clés du
  // registre valent « fury.berserker.push::Actor.xxx » : le flag revenait sous la
  // forme { fury: { berserker: … } }, plus aucune clé ne correspondait, et chaque
  // fenêtre « première fois » se rouvrait à chaque rechargement. Silencieusement.
  const expandObject = (obj) => {
    const out = {};
    for (let [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object" && !Array.isArray(v)) v = expandObject(v);
      let node = out;
      const path = k.split(".");
      while (path.length > 1) node = node[path.shift()] ??= {};
      node[path[0]] = v;
    }
    return out;
  };

  const ledger = new Ledger();
  const key = Ledger.key("fury.berserker.push", "Actor.Tavik");
  assert.equal(ledger.claim(key, "turn", ctx()), true);

  const throughFoundry = expandObject(ledger.toJSON());
  assert.ok(Array.isArray(throughFoundry.records), "l'expansion a éclaté la structure");

  const revived = new Ledger(throughFoundry);
  assert.equal(revived.claim(key, "turn", ctx()), false,
    "la fenêtre s'est rouverte après un aller-retour par un flag Foundry");
});

test("un registre hérité au format éclaté est écarté plutôt que mal lu", () => {
  const corrupt = { fury: { berserker: { "push::Actor": { Tavik: { turnKey: "1:0" } } } } };
  const ledger = new Ledger(corrupt);
  assert.equal(ledger.size, 0);
  assert.equal(ledger.claim(Ledger.key("fury.berserker.push", "Actor.Tavik"), "turn", ctx()), true);
});

test("pruning drops records from other encounters only", () => {
  const ledger = new Ledger();
  ledger.claim("old", "encounter", ctx({ encounterId: "c0" }));
  ledger.claim("new", "encounter", ctx({ encounterId: "c1" }));
  ledger.pruneToEncounter("c1");
  assert.equal(ledger.size, 1);
  assert.equal(ledger.available("new", "encounter", ctx({ encounterId: "c1" })), false);
});

/* -------------------------------------------------- */

console.log("\nMatcher — conditions et audience");

test("readPath survives missing branches", () => {
  assert.equal(readPath({ a: { b: 1 } }, "a.b"), 1);
  assert.equal(readPath({}, "a.b.c"), undefined);
});

test("all clauses must pass", () => {
  const event = { data: { amount: 5, damageTypes: ["fire"] } };
  assert.equal(evaluateConditions([{ path: "data.amount", op: "gt", value: 0 }], event), true);
  assert.equal(evaluateConditions([
    { path: "data.amount", op: "gt", value: 0 },
    { path: "data.amount", op: "gt", value: 99 },
  ], event), false);
});

test("intersects and excludes read arrays the right way round", () => {
  const event = { data: { damageTypes: ["fire", "holy"] } };
  assert.equal(evaluateConditions([{ path: "data.damageTypes", op: "intersects", value: ["fire"] }], event), true);
  assert.equal(evaluateConditions([{ path: "data.damageTypes", op: "excludes", value: ["untyped", "holy"] }], event), false);
  const plain = { data: { damageTypes: ["cold"] } };
  assert.equal(evaluateConditions([{ path: "data.damageTypes", op: "excludes", value: ["untyped", "holy"] }], plain), true);
});

test("an unknown operator fails closed", () => {
  assert.equal(evaluateConditions([{ path: "data.amount", op: "nope", value: 1 }], { data: { amount: 1 } }), false);
});

test("audience 'subject' picks only the actor the event happened to", () => {
  const heroes = [hero("Tavik", { isSubject: true }), hero("Gorek")];
  assert.deepEqual(resolveAudience({ audience: { kind: "subject" } }, heroes).map((h) => h.name), ["Tavik"]);
});

test("audience 'heroesWithin' respects range", () => {
  const heroes = [hero("Tavik", { distance: 3 }), hero("Gorek", { distance: 14 })];
  const within = resolveAudience({ audience: { kind: "heroesWithin", range: 10 } }, heroes);
  assert.deepEqual(within.map((h) => h.name), ["Tavik"]);
});

test("a class filter excludes other classes", () => {
  const heroes = [hero("Tavik", { classId: "fury" }), hero("Za", { classId: "talent" })];
  const filtered = resolveAudience({ audience: { kind: "allHeroes", class: "talent" } }, heroes);
  assert.deepEqual(filtered.map((h) => h.name), ["Za"]);
});

test("excludeSubject removes the actor the event happened to", () => {
  const heroes = [hero("Tavik", { isSubject: true, distance: 0 }), hero("Gorek", { distance: 4 })];
  const filtered = resolveAudience(
    { audience: { kind: "heroesWithin", range: 10, excludeSubject: true } }, heroes,
  );
  assert.deepEqual(filtered.map((h) => h.name), ["Gorek"]);
});

test("matchEvent consumes the window so a repeat is silent", () => {
  const entries = [{
    id: "fury.ferocity.damaged",
    label: "Férocité",
    event: "damageTaken",
    audience: { kind: "subject", class: "fury" },
    once: "round",
    message: "+1 férocité",
  }];
  const event = { type: "damageTaken", subject: { actorUuid: "Actor.Tavik" }, data: { amount: 4 } };
  const heroes = [hero("Tavik", { isSubject: true })];
  const ledger = new Ledger();

  assert.equal(matchEvent(entries, event, heroes, ledger, ctx()).length, 1);
  assert.equal(matchEvent(entries, event, heroes, ledger, ctx()).length, 0, "fired twice in one round");
  assert.equal(matchEvent(entries, event, heroes, ledger, ctx({ round: 2 })).length, 1);
});

test("une fenêtre déjà consommée est signalée, pas avalée en silence", () => {
  // Trouvé le 10 septembre en débogage : deux entrées sur le MÊME événement
  // produisaient des bulles, une troisième non — parce que sa fenêtre « une fois
  // par tour » était déjà prise. Rien nulle part ne le disait, ce qui rend une
  // entrée qui marche indiscernable d'une entrée cassée.
  const entries = [{
    id: "fury.berserker.push",
    label: "Poussée",
    event: "forcedMovementLikely",
    audience: { kind: "subject", class: "fury" },
    once: "turn",
    message: "+1 élan",
  }];
  const event = { type: "forcedMovementLikely", subject: {}, data: {} };
  const heroes = [hero("Tavik", { isSubject: true, classId: "fury" })];
  const ledger = new Ledger();
  const suppressed = [];
  const opts = { onSuppressed: (info) => suppressed.push(info) };

  assert.equal(matchEvent(entries, event, heroes, ledger, ctx(), opts).length, 1);
  assert.deepEqual(suppressed, [], "rien ne doit être signalé au premier passage");

  assert.equal(matchEvent(entries, event, heroes, ledger, ctx(), opts).length, 0);
  assert.deepEqual(suppressed, [{ entryId: "fury.berserker.push", recipientName: "Tavik", scope: "turn" }]);
});

test("a disabled entry never fires", () => {
  const entries = [{ id: "x", event: "damageTaken", message: "m", audience: { kind: "subject" } }];
  const event = { type: "damageTaken", subject: { actorUuid: "Actor.Tavik" }, data: {} };
  const heroes = [hero("Tavik", { isSubject: true })];
  const result = matchEvent(entries, event, heroes, new Ledger(), ctx(), { disabled: new Set(["x"]) });
  assert.equal(result.length, 0);
});

test("interpolation reaches both named values and raw event data", () => {
  const event = { subject: { name: "Tavik" }, data: { amount: 7, matchingTriggeredAbilities: ["Riposte", "Esquive"] } };
  const recipient = hero("Gorek");
  assert.equal(interpolate("{subject} subit {amount}", event, recipient), "Tavik subit 7");
  assert.equal(interpolate("{matchingTriggeredAbilities}", event, recipient), "Riposte, Esquive");
  assert.equal(interpolate("{inconnu}", event, recipient), "{inconnu}");
});

/* -------------------------------------------------- */

console.log("\nGrowing Ferocity — seuils et types de mouvement");

/**
 * Run the shipped catalogue against a synthetic event, as the dispatcher would.
 * @param {object} event
 * @param {object} recipient
 * @param {Ledger} [ledger]
 */
const fire = (event, recipient, ledger = new Ledger(), context = ctx()) =>
  matchEvent(shipped.entries, event, [recipient], ledger, context).map((n) => n.entryId);

/**
 * Growing Ferocity ids only.
 *
 * The same forced-movement event legitimately also matches an aspect's level-1
 * triggered action (Lines of Force, for the berserker). Asserting on the whole
 * match list made these tests fail the moment an unrelated — and correct —
 * entry was added, which is a test bug, not a catalogue bug.
 */
const fireGrowing = (...args) =>
  fire(...args).filter((id) => /\.(push|slide|grab|prone)$/.test(id));

const pushEvent = (peak, movementTypes = ["push"]) => ({
  type: "forcedMovementLikely",
  subject: { actorUuid: "Actor.Tavik", name: "Tavik", resourcePeakThisTurn: peak },
  data: { movementTypes, abilityName: "Back!" },
  inferred: true,
});

test("le bénéfice à 4 de férocité ne se déclenche pas en dessous du seuil", () => {
  const berserker = hero("Tavik", { isSubject: true, subclassId: "berserker" });
  assert.deepEqual(fireGrowing(pushEvent(3), berserker), []);
});

test("il se déclenche à 4 pile", () => {
  const berserker = hero("Tavik", { isSubject: true, subclassId: "berserker" });
  assert.deepEqual(fireGrowing(pushEvent(4), berserker), ["fury.berserker.push"]);
});

test("le pic du tour compte, pas la valeur courante après dépense", () => {
  // Le fury monte à 5, dépense 3 sur la capacité qui pousse, retombe à 2 :
  // la règle conserve le bénéfice jusqu'à la fin du tour.
  const berserker = hero("Tavik", { isSubject: true, subclassId: "berserker" });
  const event = pushEvent(5);
  event.subject.resourceValue = 2;
  assert.deepEqual(fireGrowing(event, berserker), ["fury.berserker.push"]);
});

test("le berserker ne gagne rien sur un simple glissement", () => {
  const berserker = hero("Tavik", { isSubject: true, subclassId: "berserker" });
  assert.deepEqual(fireGrowing(pushEvent(6, ["slide"]), berserker), []);
});

test("le reaver compte le glissement, pas la poussée (table Reaver)", () => {
  const reaver = hero("Tavik", { isSubject: true, subclassId: "reaver" });
  assert.deepEqual(fireGrowing(pushEvent(6, ["slide"]), reaver), ["fury.reaver.slide"]);
});

test("un aspect ne déclenche pas la table d'un autre", () => {
  const reaver = hero("Tavik", { isSubject: true, subclassId: "reaver" });
  // Une poussée nourrit le berserker et le vuken, jamais le reaver, dont la
  // table récompense le glissement.
  assert.deepEqual(fireGrowing(pushEvent(10), reaver), []);
});

test("la mise à terre relève du kit Vuken, donc du stormwight", () => {
  const reaver = hero("Tavik", { isSubject: true, subclassId: "stormwight" });
  const event = {
    type: "powerRollResolved",
    subject: { actorUuid: "Actor.Tavik", name: "Tavik", resourcePeakThisTurn: 4 },
    data: { appliedConditions: ["prone"], dealtDamage: false, abilityName: "Impaled!", tier: 3 },
  };
  assert.ok(fire(event, reaver).includes("fury.stormwight.vuken.prone"));
});

test("le bénéfice ne se déclenche qu'une fois par tour, et repart au tour suivant", () => {
  const berserker = hero("Tavik", { isSubject: true, subclassId: "berserker" });
  const ledger = new Ledger();
  assert.deepEqual(fireGrowing(pushEvent(4), berserker, ledger, ctx({ turnKey: "1:0" })), ["fury.berserker.push"]);
  assert.deepEqual(fireGrowing(pushEvent(4), berserker, ledger, ctx({ turnKey: "1:0" })), []);
  assert.deepEqual(fireGrowing(pushEvent(4), berserker, ledger, ctx({ turnKey: "1:1" })), ["fury.berserker.push"]);
  // Lignes de Force, elle, n'a aucune fenêtre : elle reste disponible au second
  // mouvement forcé du même tour. C'est la distinction que le registre existe
  // pour porter.
  assert.ok(
    fire(pushEvent(4), berserker, ledger, ctx({ turnKey: "1:0" })).includes("fury.berserker.linesOfForce"),
  );
});

/* -------------------------------------------------- */

console.log("\nLecture des messages de capacité");

/** La manœuvre Knockback telle que le système la stocke réellement. */
const knockbackEffects = [{
  constructor: { TYPE: "forced" },
  forced: {
    tier1: { movement: ["push"], distance: "1" },
    tier2: { movement: ["push"], distance: "2" },
    tier3: { movement: ["push"], distance: "3" },
  },
}];

test("les deux noms de part de résultat sont écoutés", () => {
  // `abilityResult` n'apparaît que sans cible sélectionnée ; dès qu'un token est
  // ciblé, le système émet `targetResult`. N'écouter que le premier rendait
  // invisible toute capacité jouée normalement.
  assert.ok(RESULT_PART_TYPES.includes("abilityResult"));
  assert.ok(RESULT_PART_TYPES.includes("targetResult"));
});

test("un Knockback au palier 3 est bien lu comme une poussée", () => {
  const out = collectTierOutcomes(knockbackEffects, [3]);
  assert.deepEqual(out.movementTypes, ["push"]);
  assert.equal(out.dealtDamage, false);
});

test("plusieurs cibles à des paliers différents fusionnent sans doublon", () => {
  const out = collectTierOutcomes(knockbackEffects, [1, 2, 3]);
  assert.deepEqual(out.movementTypes, ["push"], "le type de mouvement a été dupliqué");
});

test("dégâts, conditions et mouvement sont distingués", () => {
  const effects = [
    { constructor: { TYPE: "damage" }, damage: { tier2: { types: ["fire"] } } },
    { constructor: { TYPE: "applied" }, applied: { tier2: { effects: { prone: {}, grabbed: {} } } } },
    { constructor: { TYPE: "forced" }, forced: { tier2: { movement: ["slide"] } } },
  ];
  const out = collectTierOutcomes(effects, [2]);
  assert.equal(out.dealtDamage, true);
  assert.deepEqual(out.damageTypes, ["fire"]);
  assert.deepEqual(out.movementTypes, ["slide"]);
  assert.deepEqual(out.appliedConditions.sort(), ["grabbed", "prone"]);
});

test("un palier non atteint n'apporte rien", () => {
  const out = collectTierOutcomes(
    [{ constructor: { TYPE: "forced" }, forced: { tier3: { movement: ["push"] } } }],
    [1],
  );
  assert.deepEqual(out.movementTypes, []);
});

/* -------------------------------------------------- */

console.log("\nCouverture par classe (audit du 7 septembre)");

test("les douze domaines du conduit sont couverts", () => {
  // Le document en liste douze ; une extraction par recherche n'en avait rendu que sept.
  const expected = [
    "creation", "death", "fate.ally", "fate.enemy", "knowledge", "life",
    "love", "nature", "protection", "storm", "sun", "trickery", "war",
  ];
  const present = new Set(
    shipped.entries.map((e) => e.id).filter((id) => id.startsWith("conduit.piety."))
      .map((id) => id.replace("conduit.piety.", "")),
  );
  for (const key of expected) assert.ok(present.has(key), `domaine « ${key} » absent`);
});

test("les trois ordres du censeur ont leur bénéfice de Jugement", () => {
  // Trouvé manquant le 8 septembre : le Judgment Order Benefit n'était couvert
  // pour aucun ordre. Chaque ordre a un bénéfice DIFFÉRENT — exorciste
  // téléportation, oracle dégâts, parangon traction verticale — donc une entrée
  // sans filtre de sous-classe annoncerait le mauvais effet à deux censeurs sur
  // trois. C'est exactement l'erreur commise sur Growing Ferocity.
  const expected = {
    exorcist: /téléporter/i,
    oracle: /dégâts sacrés/i,
    paragon: /traction verticale/i,
  };
  for (const [order, shape] of Object.entries(expected)) {
    const entry = shipped.entries.find((e) => e.id === `censor.judgment.order.${order}`);
    assert.ok(entry, `bénéfice d'ordre « ${order} » absent`);
    assert.equal(entry.audience.subclass, order, `« ${order} » sans filtre de sous-classe`);
    assert.equal(entry.once, "turn", `« ${order} » devrait être limité au premier Jugement du tour`);
    assert.ok(shape.test(entry.message), `« ${order} » n'annonce pas le bon bénéfice`);
  }
});

test("un bénéfice d'ordre ne se déclenche pas pour un autre ordre", () => {
  const paragon = shipped.entries.find((e) => e.id === "censor.judgment.order.paragon");
  const event = {
    type: "abilityUsed",
    subject: { classId: "censor", subclassId: "oracle" },
    data: { abilityId: "judgment" },
  };
  const heroes = [
    { actorUuid: "A", name: "Oracle", classId: "censor", subclassId: "oracle", ownerIds: [], distance: 0, isSubject: true },
  ];
  assert.equal(resolveAudience(paragon, heroes, event).length, 0);
});

test("les entrées de Jugement acceptent le nom traduit de la capacité", () => {
  // `dsid` se replie sur un slug du nom quand le pack de contenu ne fixe pas
  // « _dsid » : une fiche française rend « jugement », une anglaise « judgment ».
  // Ne reconnaître qu'une seule des deux ferait taire la moitié des tables.
  const ids = ["censor.judgment.order.paragon", "censor.judgment.lookOnMyWork"];
  for (const id of ids) {
    const entry = shipped.entries.find((e) => e.id === id);
    const clause = (entry.when ?? []).find((c) => c.path === "data.abilityId");
    assert.ok(clause, `« ${id} » ne filtre pas sur l'identifiant de capacité`);
    for (const spelling of ["judgment", "jugement"]) {
      assert.ok(clause.value.includes(spelling), `« ${id} » ignore « ${spelling} »`);
    }
  }
});

test("toute garde de niveau passe par l'audience, jamais par une clause", () => {
  // Deux façons d'exprimer la même chose, dont une qui casse en silence sur les
  // événements sans sujet, est un piège. `minLevel` est la seule retenue.
  const expected = {
    "censor.judgment.lookOnMyWork": 3,
    "censor.judgment.templar": 10,
    "tactician.outOfPosition": 3,
    "talent.mindRecovery": 4,
  };
  for (const [id, level] of Object.entries(expected)) {
    const entry = shipped.entries.find((e) => e.id === id);
    assert.ok(entry, `« ${id} » absent`);
    assert.equal(entry.audience.minLevel, level, `« ${id} » : mauvaise garde de niveau`);
  }
  for (const entry of shipped.entries) {
    assert.ok(
      !(entry.when ?? []).some((c) => c.path === "subject.level"),
      `« ${entry.id} » borne le niveau dans « when » au lieu de l'audience`,
    );
  }
});

test("les trois traditions du talent ont leur action déclenchée de niveau 1", () => {
  // Troisième table par sous-classe du même genre, après les ordres du censeur et
  // les aspects du fury : chaque tradition a UNE action déclenchée de niveau 1,
  // et les trois font des choses sans rapport.
  const expected = {
    telepathy: "talent.telepathy.feedbackLoop",
    chronopathy: "talent.chronopathy.again",
    telekinesis: "talent.telekinesis.repel",
  };
  for (const [tradition, id] of Object.entries(expected)) {
    const entry = shipped.entries.find((e) => e.id === id);
    assert.ok(entry, `« ${id} » absent`);
    assert.equal(entry.audience.subclass, tradition, `« ${id} » sans filtre de tradition`);
    assert.equal(entry.severity, "decision");
  }
});

test("les dégâts de tension annoncent leurs deux échappatoires de haut niveau", () => {
  const entry = shipped.entries.find((e) => e.id === "talent.strained.endOfTurn");
  assert.match(entry.conditionText, /Cascading Strain/);
  assert.match(entry.conditionText, /Psion/);
});

test("le bénéfice de Marque du tacticien n'est pas limité par tour ni par round", () => {
  // Le gain de concentration est « la première fois par round » ; le bénéfice de
  // Marque, lui, se redéclenche à CHAQUE instance de dégâts. Coder le second
  // comme le premier ferait taire le module dès la deuxième frappe du round —
  // exactement l'inverse de ce qu'un tacticien attend.
  const gain = shipped.entries.find((e) => e.id === "tactician.focus.markedDamaged");
  const benefit = shipped.entries.find((e) => e.id === "tactician.mark.benefit");
  assert.equal(gain.once, "round");
  assert.equal(benefit.once, undefined, "le bénéfice de Marque ne doit porter aucune fenêtre");
  assert.equal(benefit.severity, "decision");
});

test("un ennemi qui blesse une cible marquée ne donne pas de concentration", () => {
  // « you or any ally damages a creature marked by you » : le sujet doit être un
  // héros. Sans cette garde, un monstre frappant une créature marquée déclenchait
  // le gain.
  for (const id of ["tactician.focus.markedDamaged", "tactician.mark.benefit"]) {
    const entry = shipped.entries.find((e) => e.id === id);
    const clause = (entry.when ?? []).find((c) => c.path === "subject.type");
    assert.ok(clause, `« ${id} » ne vérifie pas que le sujet est un héros`);
    assert.equal(clause.value, "hero");
  }
});

test("une garde de niveau sur un événement sans sujet passe par l'audience", () => {
  // `encounterStart` porte subject: null. Une clause « subject.level » ne s'y
  // évaluerait jamais — l'entrée serait morte sans que rien ne le signale.
  const entry = shipped.entries.find((e) => e.id === "tactician.outOfPosition");
  assert.equal(entry.event, "encounterStart");
  assert.equal(entry.audience.minLevel, 3);
  assert.ok(
    !(entry.when ?? []).some((c) => c.path.startsWith("subject.")),
    "aucune clause ne doit dépendre du sujet sur un événement sans sujet",
  );
});

test("le filtre minLevel écarte les héros trop bas et ceux sans niveau lisible", () => {
  const entry = { audience: { kind: "allHeroes", class: "tactician", minLevel: 3 } };
  const heroes = [
    { actorUuid: "A", name: "Novice", classId: "tactician", level: 2, ownerIds: [], distance: 0, isSubject: false },
    { actorUuid: "B", name: "Vétéran", classId: "tactician", level: 3, ownerIds: [], distance: 0, isSubject: false },
    { actorUuid: "C", name: "Illisible", classId: "tactician", level: null, ownerIds: [], distance: 0, isSubject: false },
  ];
  assert.deepEqual(resolveAudience(entry, heroes).map((h) => h.name), ["Vétéran"]);
});

test("les déclencheurs sur cible à 0 Endurance sont couverts pour les deux classes", () => {
  // L'événement `reducedToZero` existe : le rejugement du censeur et le
  // remarquage du tacticien sont donc détectables, contrairement à ce que
  // j'avais d'abord annoncé.
  for (const id of ["censor.judgment.rejudge", "tactician.mark.remark"]) {
    const entry = shipped.entries.find((e) => e.id === id);
    assert.ok(entry, `« ${id} » absent`);
    assert.equal(entry.event, "reducedToZero");
    assert.equal(entry.severity, "decision");
  }
});

test("les entrées qui filtrent sur un mot-clé visent un événement qui en porte", () => {
  // `powerRollResolved` ne transportait pas `keywords` : une entrée filtrant sur
  // « melee » ne se serait jamais déclenchée, sans erreur ni trace.
  const carriers = new Set(["abilityUsed", "powerRollResolved", "forcedMovementLikely"]);
  for (const entry of shipped.entries) {
    if (!(entry.when ?? []).some((c) => c.path === "data.keywords")) continue;
    assert.ok(carriers.has(entry.event), `« ${entry.id} » filtre des mots-clés sur « ${entry.event} », qui n'en porte pas`);
  }
});

test("seuls le fury et le null portent des entrées à seuil de ressource", () => {
  // Les sept autres classes n'ont aucune table de seuil : une entrée qui en
  // suppose une serait une invention.
  const thresholdEntries = shipped.entries.filter(
    (e) => (e.when ?? []).some((c) => c.path === "subject.resourcePeakThisTurn"),
  );
  assert.ok(thresholdEntries.length > 0);
  for (const entry of thresholdEntries) {
    assert.ok(
      ["fury", "null"].includes(entry.audience?.class),
      `« ${entry.id} » suppose un seuil pour la classe ${entry.audience?.class}`,
    );
  }
});

test("chaque gain qui progresse avec le niveau l'annonce dans son message", () => {
  // Les valeurs de niveau 1 écrites en dur étaient la seconde famille d'oublis.
  const scaling = [
    "fury.ferocity.damaged", "censor.wrath.damagedJudged", "shadow.insight.surge",
    "tactician.focus.markedDamaged", "talent.clarity.forcedMovement",
    "elementalist.essence.damage", "null.discipline.nullField",
  ];
  for (const id of scaling) {
    const entry = shipped.entries.find((e) => e.id === id);
    assert.ok(entry, `entrée « ${id} » absente`);
    assert.ok(
      /niveau \d+\+/.test(entry.message),
      `« ${id} » n'annonce pas sa progression par niveau`,
    );
  }
});

test("le naturel 2 du troubadour se distingue du naturel 19-20", () => {
  const troubadour = hero("Za", { isSubject: false, classId: "troubadour" });
  const melodrama = { type: "naturalRoll", subject: { actorUuid: "Actor.X", name: "Gorek" }, data: { natural: 2 } };
  const drama = { type: "naturalCritical", subject: { actorUuid: "Actor.X", name: "Gorek" }, data: { natural: 20 } };
  assert.deepEqual(fire(melodrama, troubadour), ["troubadour.melodrama.natural2"]);
  assert.deepEqual(fire(drama, troubadour), ["troubadour.drama.natural"]);
});

test("un naturel 5 ne déclenche rien", () => {
  const troubadour = hero("Za", { classId: "troubadour" });
  const event = { type: "naturalRoll", subject: { actorUuid: "Actor.X", name: "Gorek" }, data: { natural: 5 } };
  assert.deepEqual(fire(event, troubadour), []);
});

test("la maîtrise du null respecte la tradition et le seuil", () => {
  const event = (peak) => ({
    type: "damageTaken",
    subject: { actorUuid: "Actor.Za", name: "Za", resourcePeakThisTurn: peak },
    data: { amount: 5, damageTypes: [], matchingTriggeredAbilities: [] },
  });
  const meta = hero("Za", { isSubject: true, classId: "null", subclassId: "metakinetic" });
  const chrono = hero("Za", { isSubject: true, classId: "null", subclassId: "chronokinetic" });
  assert.ok(fire(event(4), meta).includes("null.metakinetic.damaged"));
  assert.ok(!fire(event(3), meta).includes("null.metakinetic.damaged"), "déclenché sous le seuil");
  assert.ok(!fire(event(9), chrono).includes("null.metakinetic.damaged"), "table d'une autre tradition");
});

/* -------------------------------------------------- */

/* -------------------------------------------------- */

console.log("\nTable de mots-clés — capacités déclenchées choisies");

/** Le scan de prose, reproduit sans Foundry. */
const scan = (trigger, eventType) =>
  (TRIGGER_KEYWORDS[eventType] ?? []).some((k) => trigger.toLowerCase().includes(k));

test("les formulations réelles des neuf classes sont reconnues", () => {
  // Chaque ligne est un déclencheur cité mot pour mot dans un document de classe.
  // Avant l'audit du 8 septembre, la moitié n'était couverte par aucun mot-clé :
  // la capacité restait invisible pour son propre porteur.
  const cases = [
    ["You take damage.", "damageTaken"],                                   // Unearthly Reflexes, Inertial Shield
    ["Another creature damages you.", "damageTaken"],                      // Defensive Roll
    ["A creature deals damage to the target.", "damageTaken"],             // Parry
    ["The target deals damage to an ally.", "damageTaken"],                // Feedback Loop
    ["The target takes damage from a melee strike.", "damageTaken"],       // Riposte
    ["You lose Stamina and are not dying.", "damageTaken"],                // Furious Change
    ["The target makes an ability roll.", "powerRollResolved"],            // Again, Turnabout Is Fair Play
    ["A creature judged by you makes a power roll.", "powerRollResolved"], // Judgment (bane)
    ["The target is reduced to 0 Stamina.", "reducedToZero"],              // Mark, Judgment
    ["You reduce a creature to 0 Stamina with a strike.", "reducedToZero"],// Death Strike
    ["The target dies.", "reducedToZero"],                                 // Word of Final Redemption
    ["An enemy targets you with a strike.", "abilityUsed"],                // Clever Trick
    ["The target uses a main action.", "abilityUsed"],                     // Judgment
    ["The target is force moved.", "forcedMovementLikely"],                // Lines of Force
    ["The target force moves a creature or object.", "forcedMovementLikely"], // Explosive Assistance
    ["Another hero ends their turn.", "turnEnd"],                          // Hesitation Is Weakness
    ["An enemy within 10 squares starts their turn.", "turnStart"],        // Prescient Grace
    ["The target becomes winded.", "becameWinded"],                        // Finish Them!
    ["Whenever a hero spends their last Recovery.", "healed"],             // Melodrama
  ];
  for (const [trigger, eventType] of cases) {
    assert.ok(scan(trigger, eventType), `« ${trigger} » n'est reconnu par aucun mot-clé de ${eventType}`);
  }
});

test("chaque type d'événement de la table est un événement réel", () => {
  // Une clé mal orthographiée produirait une liste de mots-clés que rien ne
  // consulte jamais — panne muette.
  for (const key of Object.keys(TRIGGER_KEYWORDS)) {
    assert.ok(Object.values(EVENTS).includes(key), `« ${key} » n'est pas un type d'événement`);
  }
});

console.log("\nCatalogue livré");

test("the shipped catalogue validates without a single problem", () => {
  const { entries, problems } = validateCatalog(shipped);
  assert.deepEqual(problems, [], `problèmes : ${problems.join(" | ")}`);
  assert.ok(entries.length >= 25, `seulement ${entries.length} entrées`);
});

test("every entry carries a rules reference", () => {
  for (const entry of shipped.entries) {
    assert.ok(entry.reference, `« ${entry.id} » n'indique pas sa source`);
  }
});

test("every inferred entry warns the reader", () => {
  for (const entry of shipped.entries) {
    if (!entry.inferred) continue;
    assert.ok(
      entry.conditionText || entry.message.includes("?"),
      `« ${entry.id} » est déduit mais ne prévient pas l'utilisateur`,
    );
  }
});

test("the nine classes are covered", () => {
  const classes = new Set(
    shipped.entries.map((entry) => entry.audience?.class).filter(Boolean),
  );
  for (const expected of ["censor", "conduit", "elementalist", "fury", "null", "shadow", "tactician", "talent", "troubadour"]) {
    assert.ok(classes.has(expected), `aucune entrée pour « ${expected} »`);
  }
});

test("a malformed entry is rejected with a readable reason", () => {
  const problems = validateEntry({ id: "bad", event: "nope", message: "m" });
  assert.ok(problems.some((p) => p.includes("événement inconnu")), problems.join(" | "));
});

test("duplicate ids are caught", () => {
  const { problems } = validateCatalog({
    entries: [
      { id: "dup", event: "damageTaken", message: "a" },
      { id: "dup", event: "damageTaken", message: "b" },
    ],
  });
  assert.ok(problems.some((p) => p.includes("double")), problems.join(" | "));
});

/* -------------------------------------------------- */

passed += runTemplateTests();

console.log(`\n${passed} tests passed${process.exitCode ? " (with failures above)" : ""}.\n`);
