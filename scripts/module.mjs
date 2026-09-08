/** Entry point: registration, presentation routing, socket, public API. */

import { MODULE_ID, SETTINGS, SOCKET, SYSTEM_ID } from "./constants.mjs";
import { configureDispatcher, dispatch, ledgerSize, resetLedger, restoreLedger } from "./engine/dispatcher.mjs";
import CatalogEditor from "./apps/catalog-editor.mjs";
import DecisionDialog from "./apps/decision-dialog.mjs";
import WatchPanel from "./apps/watch-panel.mjs";
import { loadCatalog } from "./catalog/catalog.mjs";
import { registerObservers } from "./engine/observers.mjs";
import { registerSettings } from "./settings.mjs";
import { archiveToChat } from "./ui/chat-archive.mjs";
import { showToast } from "./ui/toast.mjs";

/* -------------------------------------------------- */

Hooks.once("init", () => {
  if (game.system.id !== SYSTEM_ID) {
    console.error(`${MODULE_ID} | système « ${game.system.id} » incompatible, module inactif.`);
    return;
  }

  registerSettings();

  configureDispatcher({
    present: (notifications) => {
      routeLocally(notifications, { asDirector: true });
      // Archiving happens here, on the one client that runs detection, so the
      // whisper is created once rather than once per connected player.
      for (const notification of notifications) archiveToChat(notification);
    },
    broadcast: (notifications) => {
      // Send each notification only to the users who own the hero concerned.
      // A player has no business seeing another player's prompts.
      for (const notification of notifications) {
        if (!notification.ownerIds?.length) continue;
        game.socket.emit(SOCKET, { action: "notify", notification, to: notification.ownerIds });
      }
    },
  });

  registerObservers((event) => {
    dispatch(event).catch((error) => console.error(`${MODULE_ID} | échec du traitement`, error));
  });

  game.modules.get(MODULE_ID).api = {
    dispatch,
    loadCatalog,
    resetLedger,
    ledgerSize,
    openPanel: () => WatchPanel.instance.render({ force: true }),
    openCatalog: () => new CatalogEditor().render({ force: true }),
  };
});

/* -------------------------------------------------- */

Hooks.once("ready", async () => {
  if (game.system.id !== SYSTEM_ID) return;

  game.socket.on(SOCKET, (payload) => {
    if (payload?.action !== "notify") return;
    if (!payload.to?.includes(game.user.id)) return;
    routeLocally([payload.notification], { asDirector: false });
  });

  await restoreLedger();
  await loadCatalog().catch((error) => console.error(`${MODULE_ID} | catalogue illisible`, error));
});

/* -------------------------------------------------- */

/** A fresh encounter starts with a clean set of "first time" windows. */
Hooks.on("combatStart", async () => {
  if (game.user !== game.users.activeGM) return;
  await restoreLedger();
});

/* -------------------------------------------------- */

/** Open decisions belong to the turn that raised them. */
Hooks.on("combatTurnChange", () => DecisionDialog.closeAll());
Hooks.on("deleteCombat", () => DecisionDialog.closeAll());

/* -------------------------------------------------- */

/**
 * Present notifications on this client.
 *
 * @param {object[]} notifications
 * @param {object} options
 * @param {boolean} options.asDirector  True when running on the GM's own client.
 */
function routeLocally(notifications, { asDirector }) {
  if (asDirector && !game.settings.get(MODULE_ID, SETTINGS.showToDirector)) {
    // The Director still gets the log, just not the pop-ups.
    WatchPanel.record(notifications);
    return;
  }

  const style = game.settings.get(MODULE_ID, SETTINGS.notifyStyle);
  WatchPanel.record(notifications);
  if (style === "panelOnly") return;

  for (const notification of notifications) {
    if (notification.severity === "decision" && style === "adaptive") {
      DecisionDialog.present(notification);
    } else {
      showToast(notification);
    }
  }
}

/* -------------------------------------------------- */

/** Scene-control button to open the log. */
Hooks.on("getSceneControlButtons", (controls) => {
  const tokens = controls.tokens ?? controls.token;
  if (!tokens?.tools) return;
  tokens.tools[MODULE_ID] = {
    name: MODULE_ID,
    title: "DST.Control.OpenPanel",
    icon: "fa-solid fa-bell",
    button: true,
    visible: true,
    // v13+ sorts tools by `order`; omitting it leaves the button's position to
    // chance, which is a poor property for the one control that makes the log
    // discoverable at all.
    order: 100,
    onChange: () => WatchPanel.instance.render({ force: true }),
  };
});
