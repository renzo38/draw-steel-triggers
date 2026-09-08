/**
 * Catalogue editor: switch shipped entries off, and add your own.
 *
 * The point of shipping the catalogue as JSON is that a Director can correct a
 * rule reading or encode a homebrew trigger without waiting for a module
 * release. Entries are merged by id, so reusing a shipped id overrides it.
 */

import { MODULE_ID, SETTINGS, modulePath } from "../constants.mjs";
import { disabledEntries, invalidateCatalog, loadCatalog, validateCatalog } from "../catalog/catalog.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export default class CatalogEditor extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @inheritdoc */
  static DEFAULT_OPTIONS = {
    id: "dst-catalog-editor",
    classes: ["draw-steel", "dst-catalog"],
    tag: "form",
    window: { title: "DST.Catalog.Title", icon: "fa-solid fa-list-check", resizable: true },
    position: { width: 620, height: 660 },
    form: { handler: CatalogEditor.#onSubmit, closeOnSubmit: false },
    actions: {
      toggleEntry: CatalogEditor.#onToggleEntry,
      validate: CatalogEditor.#onValidate,
      exportDefaults: CatalogEditor.#onExportDefaults,
    },
  };

  /** @inheritdoc */
  static PARTS = {
    body: { template: modulePath("templates/catalog-editor.hbs"), scrollable: [".dst-catalog__list"] },
  };

  /* -------------------------------------------------- */

  /** @inheritdoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const disabled = disabledEntries();
    const entries = await loadCatalog({ force: true });

    context.entries = entries
      .map((entry) => ({
        id: entry.id,
        label: entry.label ?? entry.id,
        event: entry.event,
        once: entry.once ?? "—",
        severity: entry.severity ?? "info",
        reference: entry.reference ?? "",
        enabled: !disabled.has(entry.id),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    context.userCatalog = game.settings.get(MODULE_ID, SETTINGS.userCatalog);
    return context;
  }

  /* -------------------------------------------------- */

  /**
   * @this {CatalogEditor}
   * @param {SubmitEvent} event
   * @param {HTMLFormElement} form
   * @param {object} formData
   */
  static async #onSubmit(event, form, formData) {
    const raw = formData.object.userCatalog ?? "";
    if (raw.trim()) {
      try {
        const { problems } = validateCatalog(JSON.parse(raw));
        if (problems.length) {
          ui.notifications.error(problems[0]);
          return;
        }
      } catch (error) {
        ui.notifications.error(game.i18n.localize("DST.Notify.CatalogUnparseable"));
        return;
      }
    }
    await game.settings.set(MODULE_ID, SETTINGS.userCatalog, raw);
    invalidateCatalog();
    ui.notifications.info(game.i18n.localize("DST.Notify.CatalogSaved"));
    await this.render();
  }

  /* -------------------------------------------------- */

  /** @this {CatalogEditor} */
  static async #onToggleEntry(event, target) {
    const id = target.dataset.entryId;
    const disabled = disabledEntries();
    if (disabled.has(id)) disabled.delete(id);
    else disabled.add(id);
    await game.settings.set(MODULE_ID, SETTINGS.disabledEntries, [...disabled]);
    await this.render();
  }

  /* -------------------------------------------------- */

  /** @this {CatalogEditor} */
  static async #onValidate() {
    const textarea = this.element.querySelector("[name='userCatalog']");
    const raw = textarea?.value ?? "";
    if (!raw.trim()) return ui.notifications.info(game.i18n.localize("DST.Notify.CatalogEmpty"));
    try {
      const { entries, problems } = validateCatalog(JSON.parse(raw));
      if (problems.length) {
        console.warn(`${MODULE_ID} | catalogue utilisateur`, problems);
        ui.notifications.warn(game.i18n.format("DST.Notify.CatalogProblems", { count: problems.length }));
      } else {
        ui.notifications.info(game.i18n.format("DST.Notify.CatalogValid", { count: entries.length }));
      }
    } catch (error) {
      ui.notifications.error(game.i18n.localize("DST.Notify.CatalogUnparseable"));
    }
  }

  /* -------------------------------------------------- */

  /** Copy the shipped catalogue to the clipboard as a starting point. */
  static async #onExportDefaults() {
    const response = await fetch(modulePath("scripts/catalog/default-catalog.json"));
    const text = await response.text();
    await game.clipboard.copyPlainText(text);
    ui.notifications.info(game.i18n.localize("DST.Notify.CatalogCopied"));
  }
}
