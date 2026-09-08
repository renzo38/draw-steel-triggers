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
import { RESULT_PART_TYPES, collectTierOutcomes } from "../scripts/engine/observers.mjs";
import { runTemplateTests } from "./templates.test.mjs";
import { evaluateConditions, interpolate, matchEvent, readPath, resolveAudience } from "../scripts/engine/matcher.mjs";
import { validateCatalog, validateEntry } from "../scripts/catalog/catalog-validation.mjs";

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

const pushEvent = (peak, movementTypes = ["push"]) => ({
  type: "forcedMovementLikely",
  subject: { actorUuid: "Actor.Tavik", name: "Tavik", resourcePeakThisTurn: peak },
  data: { movementTypes, abilityName: "Back!" },
  inferred: true,
});

test("le bénéfice à 4 de férocité ne se déclenche pas en dessous du seuil", () => {
  const berserker = hero("Tavik", { isSubject: true, subclassId: "berserker" });
  assert.deepEqual(fire(pushEvent(3), berserker), []);
});

test("il se déclenche à 4 pile", () => {
  const berserker = hero("Tavik", { isSubject: true, subclassId: "berserker" });
  assert.deepEqual(fire(pushEvent(4), berserker), ["fury.berserker.push"]);
});

test("le pic du tour compte, pas la valeur courante après dépense", () => {
  // Le fury monte à 5, dépense 3 sur la capacité qui pousse, retombe à 2 :
  // la règle conserve le bénéfice jusqu'à la fin du tour.
  const berserker = hero("Tavik", { isSubject: true, subclassId: "berserker" });
  const event = pushEvent(5);
  event.subject.resourceValue = 2;
  assert.deepEqual(fire(event, berserker), ["fury.berserker.push"]);
});

test("le berserker ne gagne rien sur un simple glissement", () => {
  const berserker = hero("Tavik", { isSubject: true, subclassId: "berserker" });
  assert.deepEqual(fire(pushEvent(6, ["slide"]), berserker), []);
});

test("le reaver compte le glissement, pas la poussée (table Reaver)", () => {
  const reaver = hero("Tavik", { isSubject: true, subclassId: "reaver" });
  assert.deepEqual(fire(pushEvent(6, ["slide"]), reaver), ["fury.reaver.slide"]);
});

test("un aspect ne déclenche pas la table d'un autre", () => {
  const reaver = hero("Tavik", { isSubject: true, subclassId: "reaver" });
  // Une poussée nourrit le berserker et le vuken, jamais le reaver, dont la
  // table récompense le glissement.
  assert.deepEqual(fire(pushEvent(10), reaver), []);
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
  assert.deepEqual(fire(pushEvent(4), berserker, ledger, ctx({ turnKey: "1:0" })), ["fury.berserker.push"]);
  assert.deepEqual(fire(pushEvent(4), berserker, ledger, ctx({ turnKey: "1:0" })), []);
  assert.deepEqual(fire(pushEvent(4), berserker, ledger, ctx({ turnKey: "1:1" })), ["fury.berserker.push"]);
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
