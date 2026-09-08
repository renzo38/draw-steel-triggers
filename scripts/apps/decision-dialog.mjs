/**
 * The modal, reserved for the only case that earns it: a window is open, the
 * player has a real choice, and it closes when the turn moves on.
 *
 * It acknowledges and dismisses. It never applies anything — the module does
 * not write to character sheets.
 */

import { MODULE_ID, modulePath } from "../constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export default class DecisionDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {Map<string, DecisionDialog>} */
  static #open = new Map();

  /** @type {object} */
  #notification;

  /* -------------------------------------------------- */

  /** @param {object} notification */
  constructor(notification, options = {}) {
    super(options);
    this.#notification = notification;
  }

  /* -------------------------------------------------- */

  /** @inheritdoc */
  static DEFAULT_OPTIONS = {
    classes: ["draw-steel", "dst-decision"],
    tag: "div",
    window: { title: "DST.Decision.Title", icon: "fa-solid fa-bell", resizable: false },
    position: { width: 380 },
    actions: {
      acknowledge: DecisionDialog.#onAcknowledge,
      openActor: DecisionDialog.#onOpenActor,
    },
  };

  /** @inheritdoc */
  static PARTS = {
    body: { template: modulePath("templates/decision-dialog.hbs") },
  };

  /* -------------------------------------------------- */

  /** @inheritdoc */
  get id() {
    return `dst-decision-${this.#notification.id}`;
  }

  /* -------------------------------------------------- */

  /**
   * Show a decision, unless an identical one is already on screen for this
   * recipient — a player who has not answered the first prompt does not need a
   * second copy of it.
   * @param {object} notification
   */
  static present(notification) {
    const dedupeKey = `${notification.entryId}::${notification.recipientUuid}`;
    if (DecisionDialog.#open.has(dedupeKey)) return;
    const dialog = new DecisionDialog(notification);
    DecisionDialog.#open.set(dedupeKey, dialog);
    dialog.render({ force: true });
  }

  /* -------------------------------------------------- */

  /** Close every open decision, e.g. when the turn advances. */
  static closeAll() {
    for (const dialog of [...DecisionDialog.#open.values()]) dialog.close();
  }

  /* -------------------------------------------------- */

  /** @inheritdoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.notification = this.#notification;
    return context;
  }

  /* -------------------------------------------------- */

  /** @this {DecisionDialog} */
  static #onAcknowledge() {
    this.close();
  }

  /** @this {DecisionDialog} */
  static async #onOpenActor() {
    const actor = await fromUuid(this.#notification.recipientUuid);
    actor?.sheet?.render({ force: true });
  }

  /* -------------------------------------------------- */

  /** @inheritdoc */
  async close(options) {
    const dedupeKey = `${this.#notification.entryId}::${this.#notification.recipientUuid}`;
    DecisionDialog.#open.delete(dedupeKey);
    return super.close(options);
  }
}
