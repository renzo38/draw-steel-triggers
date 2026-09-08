# Draw Steel — Veilleur de Déclencheurs

Module FoundryVTT qui signale, au joueur concerné et au Directeur, les déclencheurs qui viennent de s'ouvrir : gains de ressource héroïque, actions déclenchées disponibles, conditions appliquées ou levées, jets de sauvegarde en fin de tour.

**Signalement uniquement.** Le module n'écrit jamais sur une fiche de personnage. Il ne dépense rien, n'incrémente rien, ne lance rien. La seule chose qu'il écrit est son propre registre, sur le document de Combat.

---

## Ce qu'il a fallu contourner

Le système `draw-steel` 1.2 n'émet quasiment aucun hook sémantique. La liste complète : `ds.prepare*Data` (préparation de données), `combatTurn`, `combatTurnChange`, `modifyTokenAttribute`, et deux hooks de dépôt sur les fiches. Pas de `ds.damageApplied`, pas de `ds.abilityUsed`, pas de `ds.forcedMovement` — le fichier `ability.mjs` porte d'ailleurs un `// TODO: Add hooks based on discussion with module authors`.

Ce n'est pas une déduction : la page [Hooks du wiki officiel](https://github.com/MetaMorphic-Digital/draw-steel/wiki/Hooks) ne documente que `dropItemSheetData` et les hooks `ds.canRender*`. Vérifié sur le HEAD du 7 septembre 2026.

**Ce n'est pas non plus définitif.** La [FAQ du wiki](https://github.com/MetaMorphic-Digital/draw-steel/wiki/Frequently-Asked-Questions) dit explicitement : *« if possible, we would prefer to provide more general hooks that compatibility modules can hook onto. We are happy to implement feature requests for hooks. »* Les mainteneurs invitent donc les demandes de hooks. Trois suffiraient à supprimer l'essentiel des contournements de ce module : un hook à l'application de dégâts (portant le montant, les types et la source), un à l'usage d'une capacité, et un à l'application de mouvement forcé. Tant qu'ils n'existent pas, la reconstruction ci-dessous tient.

Il n'y a donc rien à écouter. Tout ce que fait `engine/observers.mjs` est de la reconstruction :

- **Dégâts, soins, essoufflé, mourant** — comparaison de l'acteur avant et après la mise à jour, via `preUpdateActor` / `updateActor`. L'Endurance temporaire absorbe en premier, donc c'est la baisse du **total** `value + temporary` qui compte, pas celle de `value` seule.
- **Conditions** — `createActiveEffect` / `deleteActiveEffect`, en lisant `effect.statuses`.
- **Capacités et paliers** — `createChatMessage`, en lisant `message.system.parts`. C'est le seul signal vraiment fiable que le système nous donne. Attention à un piège : le système n'émet une part `abilityResult` que si la capacité a été utilisée **sans cible sélectionnée**. Dès qu'un token est ciblé — la manière normale de jouer — chaque résultat arrive dans une part **`targetResult`**, une par cible, portant les mêmes `abilityUuid` et `tier` plus le `targetUuid`. Le module écoute les deux, et agrège les résultats d'une même capacité pour ne pas produire trois notifications identiques sur une capacité à trois cibles.
- **Naturel 19-20** — extrait des dés du message.
- **Tours et rounds** — `combatStart`, `combatRound`, `combatTurnChange`.

La détection tourne sur **un seul client**, le MJ actif (`game.users.activeGM`). Tous les clients connectés voient le même `updateActor` ; sans cette garde, chaque joueur générerait sa propre copie de chaque événement. Les notifications partent ensuite en socket vers les seuls propriétaires du héros concerné — un joueur ne voit pas les invites d'un autre.

## Les trois niveaux de fiabilité

Le module est explicite sur ce qu'il sait et ce qu'il devine.

**Observé.** Dégâts, soins, franchissements de seuil, conditions, capacités utilisées, paliers obtenus, dépenses de Malice, tours et rounds. Ces événements sont lus dans les données, pas déduits.

**Déduit.** Le mouvement forcé, avant tout. Le wiki officiel est catégorique : *« Forced Movement effects … There is currently no automation for this feature; owners of the appropriate tokens must apply the position changes themselves. »* Le code le confirme — `forced-movement-effect.mjs` n'implémente pas `constructButtons`, contrairement aux effets de dégâts et de conditions qui ont bien `applyEffect` / `applyGain`. Il n'existe donc **aucun événement** « une créature a été mue de force ». Tout ce que le module peut dire, c'est qu'une capacité portant un effet de mouvement forcé vient de se résoudre à tel palier. Il ne saura jamais si la stabilité de la cible l'a annulé. Ces notifications sont marquées d'un liseré pointillé et de la mention « déduit, non observé ». Le réglage *Déduire le mouvement forcé* les coupe entièrement.

Le type de dégâts est dans le même cas : il ne voyage pas sur la mise à jour d'acteur qui l'applique. Le module mémorise le dernier jet de dégâts et l'attache à une baisse d'Endurance survenue dans les six secondes. Quand il n'a rien vu, la liste des types reste **vide** plutôt que fausse — une entrée qui exige un type précis ne se déclenchera pas, tandis qu'une entrée qui demande seulement « ni neutre ni sacré » se déclenchera quand même.

**Hors de portée.** Tout déclencheur qui référence la fiction ou l'intention : « quand un allié que tu vois est ciblé », « quand une créature jugée par toi inflige des dégâts », « si tu as incorporé au moins un élan ». Le champ `AbilityModel.trigger` est un `StringField` — il n'existe aucune représentation machine du déclencheur nulle part dans le système.

## Comment le module résout ça quand même

Puisqu'il ne fait que **signaler**, il peut se déclencher sur un sur-ensemble et laisser l'humain filtrer. Une entrée porte un champ `conditionText` : la partie que le module ne peut pas vérifier, écrite noir sur blanc.

> **Tavik** — +1
> Première fois ce round que tu subis des dégâts : +1 courroux.
> *Uniquement si la créature qui t'a blessé est jugée par toi.*

Cette notification arrive au bon moment, ne se trompe jamais de façon coûteuse, et le joueur tranche en une seconde. C'est ce qui rend le censeur, le voleur d'ombre et le tacticien couvrables malgré des déclencheurs indécidables.

En complément, pour les actions déclenchées, le module lit la prose de `system.trigger` sur les capacités que le héros possède réellement et cherche des mots-clés (en français et en anglais, une table pouvant faire tourner du contenu traduit sur des compendiums anglais). Il ne prévient donc que les héros qui ont effectivement quelque chose à jouer — pas de bruit pour les autres.

## Le choix d'interface

Un fury prend des dégâts presque chaque round, gagne 1d3 en début de tour, et gagne encore en devenant essoufflé. Si chaque événement ouvrait une fenêtre, les joueurs cliqueraient « OK » par réflexe au bout de deux séances et le module deviendrait du bruit qu'on ignore.

Le défaut est donc **adaptatif** : une bulle discrète en haut de l'écran, qui s'efface seule, pour les gains automatiques — le joueur n'a aucune décision à prendre, il doit juste ne pas oublier son compteur. Une fenêtre modale **uniquement** quand il y a un vrai choix avec une fenêtre qui se referme : une action déclenchée disponible, des jets de sauvegarde en fin de tour, un talent tendu qui va encaisser ses dégâts. Ces modales se ferment automatiquement au changement de tour, parce qu'une décision périmée n'a plus rien à faire à l'écran.

Deux autres styles sont disponibles : bulles uniquement, ou journal seul (rien à l'écran). Le journal conserve tout, dans tous les cas.

## Le registre « première fois »

Draw Steel repose énormément sur des fenêtres « la première fois par tour / par round / par rencontre ». Se tromper dans un sens ou dans l'autre est pire que ne rien signaler : un doublon apprend aux joueurs à ignorer le module, un oubli le rend inutile.

Le registre est indexé par `entrée × héros` — deux furies dans le même combat ont chacune sa propre fenêtre. Il est persisté sur les flags du document de Combat, donc il survit à un rechargement du navigateur, et il est purgé des rencontres passées à chaque nouveau combat. Les écritures sont débouncées à deux secondes : un round chargé produit une dizaine d'événements et ferait autant d'écritures.

## Le catalogue

Le contenu est du JSON, pas du code. Quarante-six entrées livrées couvrant les neuf classes, chacune avec sa référence au chapitre source.

| Classe | Ce qui est couvert | Tables à seuil |
| --- | --- | --- |
| Toutes | Gain de début de rencontre et de début de tour, conditions, actions déclenchées détectées sur la prose | — |
| Fury | Férocité sur dégâts, essoufflé, mourant ; Growing Ferocity au seuil 4 : poussée du berserker, glissement du reaver, poussée et mise à terre du kit Vuken, prise du kit Boren | **6 tables** (2 aspects + 4 kits) |
| Null | Discipline sur Malice et sur action principale au contact ; Discipline Mastery au seuil 4 : dégâts subis du metakinetic, prise du cryokinetic | **3 tables** (traditions) |
| Conduit | Les **12 domaines**, gain de piété une fois par rencontre chacun | aucune |
| Censor | Courroux subi et infligé, action déclenchée de Jugement | aucune |
| Elementalist | Essence sur dégâts typés à 10 cases, Ward of Delightful Consequences, interruption de magie persistante | aucune |
| Shadow | Perspicacité sur dégâts avec élans | aucune |
| Tactician | Concentration sur cible marquée, capacité héroïque alliée | aucune |
| Talent | Clarté sur mouvement forcé, dégâts de fin de tour quand tendu | aucune |
| Troubadour | Drame sur héros essoufflé, naturel 19-20, mort d'un héros ; Melodrama sur naturel 2 et sur Malice | aucune |

Les neuf documents de classe ont été lus intégralement. Le tableau « Tables à seuil » est le résultat de cet audit, pas une supposition : **seuls le fury et le null** indexent des bénéfices sur le montant de ressource détenu. Les sept autres classes n'en ont aucune, et une entrée qui en supposerait une serait une invention — un test le vérifie.

L'éditeur est accessible depuis les réglages du module. On peut désactiver n'importe quelle entrée livrée, et ajouter les siennes — une entrée qui reprend un identifiant existant le remplace, ce qui permet de corriger une lecture de règle sans attendre une nouvelle version.

Format d'une entrée :

```json
{
  "id": "fury.ferocity.damaged",
  "label": "Férocité — dégâts subis",
  "reference": "Fury — Ferocity in Combat",
  "event": "damageTaken",
  "audience": { "kind": "subject", "class": "fury" },
  "once": "round",
  "severity": "info",
  "when": [{ "path": "data.amount", "op": "gt", "value": 0 }],
  "message": "Première fois ce round que tu subis des dégâts : +1 férocité.",
  "conditionText": "Ce que le module ne peut pas vérifier lui-même.",
  "gain": "+1"
}
```

`audience.kind` vaut `subject` (celui à qui l'événement est arrivé), `allHeroes`, ou `heroesWithin` avec une `range` en cases. `audience.class` filtre sur le `dsid` de l'objet classe du héros. `once` vaut `turn`, `round`, `encounter`, ou est absent. Les opérateurs de `when` sont `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `includes`, `excludes`, `intersects`, `exists`, `truthy`, `falsy`. Les messages acceptent `{subject}`, `{recipient}`, `{amount}`, `{ability}`, `{condition}`, `{tier}`, et n'importe quel champ de `data`.

## Installation

Manifeste : `https://github.com/henryfane/draw-steel-triggers/releases/latest/download/module.json`

Ou décompresser l'archive dans `Data/modules/draw-steel-triggers/`. Prérequis : Foundry v14, système `draw-steel` 1.2+.

## API

```js
const api = game.modules.get("draw-steel-triggers").api;
api.openPanel();          // journal de session
api.openCatalog();        // éditeur de catalogue
await api.loadCatalog();  // entrées fusionnées
await api.resetLedger();  // rouvre toutes les fenêtres « première fois »
api.ledgerSize();         // diagnostic
```

## Tests

```bash
node test/engine.test.mjs
```

26 tests couvrant le registre (chaque portée de fenêtre, l'isolation entre héros, la survie à un rechargement, la purge), le moteur de correspondance (conditions, opérateurs sur tableaux, résolution d'audience, consommation de fenêtre, entrées désactivées, interpolation) et la conformité du catalogue livré à son propre schéma — y compris le fait que chaque entrée cite sa source et que chaque entrée déduite prévienne le lecteur.

## Limites connues et lectures de règles

- **Fury, essoufflé ou mourant.** Le texte dit « The first time you become winded or are dying in an encounter, you gain 1d3 ferocity ». Lu comme une fenêtre unique, la clause « or are dying » ne servirait jamais à rien, puisqu'on devient toujours essoufflé avant d'être mourant. Le catalogue encode donc **deux** fenêtres distinctes. Si votre table lit ça autrement, désactivez `fury.ferocity.dying`.
- **Growing Ferocity : les seuils sont lus au pic du tour, pas à la valeur courante.** La règle précise que ces bénéfices *« last until the end of your turn, even if a benefit would become unavailable to you because of the amount of ferocity you spend during your turn »*. Un fury qui monte à 5 puis dépense 3 sur la capacité même qui pousse conserve son bénéfice. Le module suit donc `resourcePeakThisTurn`, remis à zéro à chaque début de tour, et non `resourceValue`.
- **Growing Ferocity : six tables, quatre couvertes.** Le fury a une table par aspect (Berserker : première **poussée** du tour ; Reaver : premier **glissement**) *et* une par kit stormwight (Vuken : poussée ou mise à terre ; Boren : première **prise**). Les kits Corven et Raden récompensent le premier **shift** du tour, que Foundry ne distingue pas d'un déplacement ordinaire — non livré. Le module ne connaît pas non plus le kit équipé : les entrées Vuken et Boren se déclenchent pour tout stormwight et nomment le kit requis en condition.
- **Autres tables à seuil non couvertes.** Le null a un Discipline Mastery amélioré aux niveaux 4, 7 et 10, sur le même principe. Rien n'est livré pour lui.
- **Deux familles d'oublis, corrigées le 7 septembre.** La première : les gains conditionnels qui **progressent avec le niveau** (le fury gagne 2 férocité sur dégâts au niveau 4, 3 au niveau 10 ; le voleur d'ombre 2 puis 3 ; le censeur, l'élémentaliste, le tacticien et le talent ont chacun leur palier au niveau 4). Les messages annonçaient les valeurs de niveau 1 ; ils annoncent maintenant la progression, et un test le vérifie. La seconde : les **tables à seuil de ressource**, dont je n'avais vu que celle du fury, et mal. Le null en a trois de plus.
- **Ce qui reste indétectable, classe par classe.** Chronokinetic du null : « la première fois que tu te déplaces d'une case ou plus dans le cadre d'une capacité » — le déplacement lié à une capacité n'est pas distinguable. Corven et Raden du fury : le **shift** n'est pas distinguable d'un déplacement ordinaire. Tacticien : la **marque** n'est pas dans le modèle de données, les deux entrées se déclenchent donc sur tout héros infligeant des dégâts et nomment la condition. Censeur : le statut **jugé** n'y est pas non plus. Troubadour : « la première fois que trois héros ou plus utilisent une capacité sur le même tour » demande un comptage inter-acteurs, et « lorsqu'un héros dépense sa dernière Récupération » n'est pas exposé.
- **Troubadour, trois héros sur le même tour.** « The first time three or more heroes use an ability on the same turn » demande un comptage inter-acteurs sur une fenêtre de tour ; non implémenté en v1.
- **Null, champ nul.** L'aire réelle du Champ Nul (1 aura, agrandie par plusieurs capacités) n'est pas suivie. L'entrée utilise une portée fixe de 3 cases et signale la condition à vérifier.
- **Conduit.** Les domaines ne sont pas lus depuis la fiche : les cinq entrées se déclenchent pour tout conduit à portée et nomment le domaine requis dans leur `conditionText`. Désactivez celles qui ne correspondent pas à votre domaine.
- **Jets de sauvegarde en fin de tour : volontairement absents.** Le système les gère déjà — il invite les propriétaires du combattant à configurer le seuil, propose un bouton pour dépenser un jeton de héros, et délègue au MJ actif quand plusieurs joueurs possèdent l'acteur. Une entrée de plus aurait été une seconde invite pour la même décision, c'est-à-dire exactement la fatigue de notification que le module cherche à éviter. Le champ `data.saveEndsCount` reste calculé et disponible si vous voulez malgré tout écrire votre propre entrée.
- **Ligne d'effet.** Jamais calculée. Les entrées qui en dépendent le disent.
- **Distances.** Chebyshev sur grille carrée (diagonale = 1 case), avec repli sur `canvas.grid.measurePath` sur les autres grilles.

## Structure

```
scripts/
  constants.mjs                 identifiants, types d'événements, portées de fenêtre
  module.mjs                    hooks, socket, routage de présentation, API
  settings.mjs                  réglages et menu du catalogue
  catalog/
    default-catalog.json        les 30 entrées livrées
    catalog-validation.mjs      schéma, sans dépendance Foundry (testé)
    catalog.mjs                 chargement et fusion avec les entrées utilisateur
  engine/
    observers.mjs               hooks Foundry → événements normalisés (seul fichier couplé)
    ledger.mjs                  fenêtres « première fois » (pur, testé)
    matcher.mjs                 conditions et audience (pur, testé)
    dispatcher.mjs              distances, recipients, persistance, diffusion
  apps/
    watch-panel.mjs             journal de session
    decision-dialog.mjs         modale, réservée aux vraies décisions
    catalog-editor.mjs          activation/désactivation et entrées maison
  ui/
    toast.mjs                   bulles non modales
```

## Licence

MIT. Draw Steel est une marque de MCDM Productions ; ce module n'inclut aucun contenu sous licence — seulement des références de chapitre.
