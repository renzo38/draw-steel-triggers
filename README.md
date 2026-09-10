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

Dans Foundry, *Add-on Modules* → *Install Module*, et coller ce manifeste :

```
https://github.com/renzo38/draw-steel-triggers/releases/latest/download/module.json
```

Cette URL ne change jamais : elle résout toujours vers la dernière version publiée, et c'est elle qui permet à Foundry de proposer les mises à jour. Sinon, décompresser l'archive dans `Data/modules/draw-steel-triggers/`.

Prérequis : Foundry v13 ou plus, et le système `draw-steel`. Développé contre la 1.2 mais vérifié compatible 1.1.2 — aucune borne de version n'est déclarée, une borne empêchant purement et simplement l'activation.

## Publier une version

Le manifeste et l'archive sont produits par CI, jamais à la main :

```bash
# 1. Mettre à jour le numéro dans module.json, committer.
git tag v0.2.2
git push origin main --tags
```

Le workflow `.github/workflows/release.yml` lance alors les tests, refuse de publier s'ils échouent, estampille `module.json` avec la version du tag et les URL du dépôt via `tools/stamp-manifest.mjs`, construit `module.zip` avec le contenu à la racine — c'est ce que Foundry attend — et crée la Release avec les deux fichiers en pièces jointes.

Les dossiers `test/` et `.github/` sont exclus de l'archive : ils n'ont rien à faire dans un Foundry qui tourne.

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

69 tests couvrant le registre (chaque portée de fenêtre, l'isolation entre héros, la survie à un rechargement, la purge), le moteur de correspondance (conditions, opérateurs sur tableaux, résolution d'audience, consommation de fenêtre, entrées désactivées, interpolation), la conformité du catalogue livré à son propre schéma — y compris le fait que chaque entrée cite sa source, que chaque entrée déduite prévienne le lecteur et que chaque gain qui progresse avec le niveau annonce sa progression — le fait que chaque bénéfice d'ordre du censeur porte le filtre de sous-classe qui lui évite d'annoncer l'effet d'un autre ordre, et le fait que chaque gabarit Handlebars ne rende qu'un seul élément racine, seule forme acceptée par ApplicationV2.

## Limites connues et lectures de règles

- **Fury, essoufflé ou mourant.** Le texte dit « The first time you become winded or are dying in an encounter, you gain 1d3 ferocity ». Lu comme une fenêtre unique, la clause « or are dying » ne servirait jamais à rien, puisqu'on devient toujours essoufflé avant d'être mourant. Le catalogue encode donc **deux** fenêtres distinctes. Si votre table lit ça autrement, désactivez `fury.ferocity.dying`.
- **Growing Ferocity : les seuils sont lus au pic du tour, pas à la valeur courante.** La règle précise que ces bénéfices *« last until the end of your turn, even if a benefit would become unavailable to you because of the amount of ferocity you spend during your turn »*. Un fury qui monte à 5 puis dépense 3 sur la capacité même qui pousse conserve son bénéfice. Le module suit donc `resourcePeakThisTurn`, remis à zéro à chaque début de tour, et non `resourceValue`.
- **Growing Ferocity : six tables, quatre couvertes.** Le fury a une table par aspect (Berserker : première **poussée** du tour ; Reaver : premier **glissement**) *et* une par kit stormwight (Vuken : poussée ou mise à terre ; Boren : première **prise**). Les kits Corven et Raden récompensent le premier **shift** du tour, que Foundry ne distingue pas d'un déplacement ordinaire — non livré. Le module ne connaît pas non plus le kit équipé : les entrées Vuken et Boren se déclenchent pour tout stormwight et nomment le kit requis en condition.
- **Judgment Order Benefit du censeur : troisième table d'ordre trouvée manquante, le 8 septembre.** Le censeur gagne un bénéfice au premier Jugement de chaque tour, et ce bénéfice **diffère selon l'ordre** : exorciste téléportation vers la cible (2 × Présence, sans ligne d'effet requise), oracle dégâts sacrés (2 × Présence), parangon **traction verticale** (2 × Présence). Aucun des trois n'était couvert. C'est le même piège que Growing Ferocity — une table par sous-classe, des textes typographiquement identiques — et un test verrouille désormais le fait que chaque entrée porte son filtre de sous-classe. La valeur ne progresse pas avec le niveau : la formule reste 2 × Présence, c'est la Présence qui monte (niveaux 4, 7, 10). Les entrées annoncent donc la formule, pas un chiffre.
- **Jugement : le déclencheur, pas l'action.** Les entrées se déclenchent sur l'usage de la capacité Jugement, quelle que soit l'action qui la porte — ce qui couvre gratuitement les quatre façons de l'utiliser en action déclenchée gratuite (Vigilance du saint, Révélateur, Le mal révélé, Démonologue). En contrepartie, elles ne savent pas distinguer un Jugement qui juge d'une des quatre actions déclenchées à 1 courroux, qui utilisent le même bloc de capacité sans juger personne : le `conditionText` porte cette réserve.
- **Identification de la capacité par `dsid`, avec repli sur le nom.** Une entrée qui vise une capacité nommée compare `data.abilityId`, l'identifiant Draw Steel — pas le nom affiché. Quand le pack de contenu ne fixe pas `_dsid`, cet identifiant se replie sur un slug du nom : une fiche française rend « jugement » là où une anglaise rend « judgment ». Les entrées acceptent les deux orthographes. Un contenu maison qui renomme Jugement autrement doit ajouter son orthographe à la clause.
- **Deux entrées de censeur bornées par le niveau.** « Contemple mon œuvre et désespère » (niveau 3) et « Templier » (niveau 10) ne se déclenchent qu'au-delà de leur niveau. La garde échoue fermée : si le niveau n'est pas lisible sur la fiche, ces deux entrées se taisent plutôt que de s'inviter chez un censeur de niveau 1.
- **Marque du tacticien : le bénéfice central manquait, le 8 septembre.** Le module signalait le *gain de concentration* sur « un héros blesse une créature marquée » — première fois par round — et s'arrêtait là. Or le même événement porte aussi le **bénéfice de Marque** : dépenser 1 concentration pour un bénéfice au choix parmi quatre, **sans aucune limite de fréquence**. Codé comme le gain, il se serait tu dès la deuxième frappe du round. C'est un angle mort de méthode, pas de lecture : j'avais encodé la ressource sur un événement sans jamais demander ce qui s'y déclenche d'autre. Un test verrouille désormais l'absence de fenêtre sur cette entrée.
- **`reducedToZero` existe : le rejugement et le remarquage sont couverts.** J'avais d'abord annoncé que « quand une créature jugée tombe à 0 Endurance » n'était pas exposé. C'était faux — l'observateur émet déjà cet événement, seul le domaine Mort du conduit s'en servait. Le censeur et le tacticien ont maintenant leur entrée.
- **Une garde de niveau se pose sur l'audience, pas sur l'événement.** Les clauses `when` s'évaluent contre l'événement ; le niveau est une propriété du **destinataire**. Sur un événement à sujet (`censor.judgment.lookOnMyWork`), `subject.level` fonctionne parce que le censeur *est* le sujet. Sur `encounterStart`, qui porte `subject: null`, la même clause donnerait une entrée morte sans le moindre signal — d'où le filtre d'audience `minLevel`, utilisé par « Hors de position ». Il échoue fermé : un héros dont le niveau n'est pas lisible n'est pas notifié.
- **Un mot-clé ne se filtre que sur un événement qui en porte.** `powerRollResolved` ne transportait pas `keywords`, alors que plusieurs actions déclenchées se déclenchent sur les dégâts et non sur la déclaration (« si tu blesses une créature jugée avec une capacité de corps à corps »). Le champ est désormais présent sur les deux événements, et un test refuse toute entrée qui filtrerait des mots-clés sur un événement qui n'en porte pas.
- **Ce qui reste hors de portée sur « jugé » et « marqué », pour raison de tempo.** Trois actions déclenchées doivent se résoudre **avant** le jet qu'elles modifient : le désavantage du censeur sur un jet d'une créature jugée, sa réduction de puissance, et la redirection *Aiguillonné* du tacticien. Le module ne voit la capacité qu'au moment où son message de chat arrive, c'est-à-dire avec le résultat. *Aiguillonné* est livré malgré tout, avec la réserve écrite dans son texte ; les deux autres ne le sont pas, parce qu'un signal systématiquement en retard apprend surtout à ignorer le module.
- **Talent : les trois actions déclenchées de tradition manquaient, le 8 septembre.** Troisième table par sous-classe du même genre, après les ordres du censeur et les aspects du fury. Chaque tradition a UNE action déclenchée de niveau 1, et les trois n'ont rien à voir : *Boucle de Rétroaction* (télépathie — un ennemi blesse un allié, il encaisse la moitié en psychique), *Encore* (chronopathie — relance d'un jet, utilisable **après** avoir vu le résultat) et *Repousser* (télékinésie — moitié des dégâts, ou réduction d'un mouvement forcé). Les trois sont livrées, filtrées par tradition.
- **« Encore » n'est signalée que sur les paliers 1.** Son déclencheur RAW est « la cible fait un jet de capacité » — c'est-à-dire *chaque jet de la rencontre*. Signaler tous les jets aurait produit exactement la fatigue que le module cherche à éviter, donc l'entrée se limite au moment où la relance sert vraiment. Contrepartie assumée, écrite dans le texte de l'entrée : son autre usage — faire relancer le palier 3 d'un ennemi — n'est pas signalé.
- **Les gardiens du talent.** Seul le gardien Répulsif demande une action déclenchée ; Entropie, Acier et Évanescent s'appliquent seuls. Le gardien équipé n'étant pas lisible dans le modèle de données, l'entrée se déclenche pour tout talent qui subit des dégâts et nomme le gardien requis. À désactiver si votre talent en a pris un autre.
- **Cascading Strain et Psion ne sont pas des entrées.** Les deux se déclenchent au moment exact où le module signale déjà les dégâts de tension de fin de tour. Une entrée de plus aurait été une seconde fenêtre pour la même décision ; les deux échappatoires sont donc écrites dans le `conditionText` de l'entrée existante.
- **Trois déclencheurs du talent volontairement absents.** *Triangulate* (télékinésie, niveau 5) se déclenche sur chaque capacité à distance d'un allié : trop bruyant pour ce que ça rapporte. *Ease Their Fall* dépend des chutes, que le module ne voit pas. *Speed of Thought* se déclenche sur l'usage d'une action déclenchée, que rien n'expose.
- **Le motif universel, trouvé le 8 septembre : chaque classe donne une action déclenchée déterminée par la sous-classe, au niveau 1.** Élémentaliste (une par spécialisation), fury (une par aspect), null (une pour tous), voleur d'ombre (une par collège), tacticien (une par doctrine), talent (une par tradition), troubadour (une par class act), conduit (au choix entre deux). Neuf classes, le même moule — et une seule était couverte avant cette passe, parce qu'on me l'avait signalée nommément. Ce n'est plus une série de trous isolés : c'est une structure du système que le catalogue ignorait.
- **Ces réactions arrivent après les dégâts, et c'est acceptable ici.** La moitié d'entre elles réduisent de moitié des dégâts déjà appliqués (Bouclier d'Inertie, Réflexes Surnaturels, Roulade Défensive, Parade, Peau de Muraille). Le module ne les voit qu'après la baisse d'Endurance. Contrairement au désavantage du censeur, ce décalage est jouable : toute table revient d'un battement sur « attends, je dépense ma réaction », et oublier purement et simplement sa réduction de dégâts est l'erreur la plus fréquente de ces classes. Le signal tardif vaut mieux que pas de signal.
- **Trois actions déclenchées de niveau 1 restent hors de portée.** *Overwatch* du tacticien (« The target moves ») et *Subtle Relocation* de l'élémentaliste dépendent du déplacement, que rien n'expose. *Turnabout Is Fair Play* du troubadour se déclenche sur la présence d'un avantage ou d'un désavantage sur un jet, information absente du message de chat.
- **La table de mots-clés couvrait 8 types d'événements et n'en consultait que 3.** `matchingTriggeredAbilities` n'était appelée que sur `damageTaken`, `turnStart` et `turnEnd` : les mots-clés des cinq autres familles n'ont jamais été atteignables. Pire, le scan portait sur le **sujet** de l'événement, alors que le réacteur est presque toujours quelqu'un d'autre — Parade, Boucle de Rétroaction et Riposte se déclenchent quand un **allié** subit des dégâts. Le scan tourne désormais sur chaque **destinataire** de notification, ce qui rend toutes les clés vivantes et met le rappel devant le joueur qui détient réellement la capacité. La table a été élargie aux formulations réellement employées : « Another creature damages you », « You lose Stamina », « makes an ability roll », « is reduced to 0 Stamina », « The target dies ». Un test confronte 19 déclencheurs cités mot pour mot des neuf documents de classe.
- **Une fenêtre consommée se signale désormais, au lieu de disparaître.** Une entrée qui satisfaisait toutes ses conditions puis se faisait écarter parce que sa fenêtre « première fois ce tour » était déjà prise ne laissait **aucune trace nulle part**. Une entrée qui marche devenait indiscernable d'une entrée cassée — au point de coûter une session de débogage complète sur un fury dont tout était correct. Avec le réglage *Journal de débogage*, la console dit maintenant « correspond, mais fenêtre déjà consommée » avec le nom de l'entrée et du héros.
- **Le registre ne survivait à aucun rechargement — corrigé le 10 septembre.** Ses clés valent `fury.berserker.push::Actor.xxx`, et `setFlag` fait passer la valeur par `expandObject`, qui transforme **toute clé contenant un point** en arborescence. Le flag revenait sous la forme `{ fury: { berserker: … } }` : plus aucune clé ne correspondait, et **chaque fenêtre « première fois ce tour / ce round / cette rencontre » se rouvrait à chaque F5**, sans la moindre erreur. La garantie centrale du module était donc nulle dès qu'un joueur rechargeait sa page. L'état se persiste maintenant comme un **tableau** d'enregistrements, que l'expansion laisse intact ; un registre au format hérité est écarté et le flag nettoyé une fois. Un test rejoue l'expansion de Foundry sur un aller-retour complet.
- **Autres tables à seuil non couvertes.** Le null a un Discipline Mastery amélioré aux niveaux 4, 7 et 10, sur le même principe. Rien n'est livré pour lui.
- **Deux familles d'oublis, corrigées le 7 septembre.** La première : les gains conditionnels qui **progressent avec le niveau** (le fury gagne 2 férocité sur dégâts au niveau 4, 3 au niveau 10 ; le voleur d'ombre 2 puis 3 ; le censeur, l'élémentaliste, le tacticien et le talent ont chacun leur palier au niveau 4). Les messages annonçaient les valeurs de niveau 1 ; ils annoncent maintenant la progression, et un test le vérifie. La seconde : les **tables à seuil de ressource**, dont je n'avais vu que celle du fury, et mal. Le null en a trois de plus.
- **Ce qui reste indétectable, classe par classe.** Chronokinetic du null : « la première fois que tu te déplaces d'une case ou plus dans le cadre d'une capacité » — le déplacement lié à une capacité n'est pas distinguable. Corven et Raden du fury : le **shift** n'est pas distinguable d'un déplacement ordinaire. Tacticien : la **marque** n'est pas dans le modèle de données, les deux entrées se déclenchent donc sur tout héros infligeant des dégâts et nomment la condition. Censeur : le statut **jugé** n'y est pas non plus, et « lorsqu'une créature jugée tombe à 0 Stamina » n'est pas exposé — le rejugement gratuit n'est donc pas signalé. Troubadour : « la première fois que trois héros ou plus utilisent une capacité sur le même tour » demande un comptage inter-acteurs, et « lorsqu'un héros dépense sa dernière Récupération » n'est pas exposé.
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
    default-catalog.json        les 79 entrées livrées
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
