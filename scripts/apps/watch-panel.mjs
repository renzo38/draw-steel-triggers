/**
 * The log. Everything that fired this session, newest first, so a player who
 * looked away can catch up and the Director can audit what the module claimed.
 */

import { MODULE_ID, SETTINGS, modulePath } from "../constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export default class WatchPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {WatchPanel|null} */
  static #instance = null;

  /** @type {object[]} */
  static #log = [];

  /* -------------------------------------------------- */

  /** @inheritdoc */
  static DEFAULT_OPTIONS = {
    id: "dst-watch-panel",
    classes: ["draw-steel", "dst-panel"],
    tag: "div",
    window: { title: "DST.Panel.Title", icon: "fa-solid fa-bell", resizable: true },
    position: { width: 400, height: 520 },
    actions: {
      clear: WatchPanel.#onClear,
      openActor: WatchPanel.#onOpenActor,
    },
  };

  /** @inheritdoc */
  static PARTS = {
    body: { template: modulePath("templates/watch-panel.hbs"), scrollable: [".dst-log"] },
  };

  /* -------------------------------------------------- */

  static get instance() {
    return (WatchPanel.#instance ??= new WatchPanel());
  }

  /* -------------------------------------------------- */

  /**
   * Append notifications to the log and refresh if open.
   * @param {object[]} notifications
   */
  static record(notifications) {
    const limit = game.settings.get(MODULE_ID, SETTINGS.logSize);
    WatchPanel.#log.unshift(...notifications);
    if (WatchPanel.#log.length > limit) WatchPanel.#log.length = limit;
    if (WatchPanel.#instance?.rendered) WatchPanel.#instance.render();
  }

  /* -------------------------------------------------- */

  /** @inheritdoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.entries = WatchPanel.#log.map((notification) => ({
      ...notification,
      time: new Date(notification.timestamp).toLocaleTimeString(game.i18n.lang, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    }));
    context.empty = !context.entries.length;
    return context;
  }

  /* -------------------------------------------------- */

  /** @this {WatchPanel} */
  static async #onClear() {
    WatchPanel.#log = [];
    await this.render();
  }

  /** @this {WatchPanel} */
  static async #onOpenActor(event, target) {
    const actor = await fromUuid(target.dataset.uuid);
    actor?.sheet?.render({ force: true });
  }
}
