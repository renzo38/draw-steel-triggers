/** Module settings registration. */

import { MODULE_ID, SETTINGS } from "./constants.mjs";
import CatalogEditor from "./apps/catalog-editor.mjs";
import { invalidateCatalog } from "./catalog/catalog.mjs";

export function registerSettings() {
  const register = (key, data) => game.settings.register(MODULE_ID, key, data);

  register(SETTINGS.enabled, {
    name: "DST.Settings.Enabled.Name",
    hint: "DST.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  register(SETTINGS.notifyStyle, {
    name: "DST.Settings.NotifyStyle.Name",
    hint: "DST.Settings.NotifyStyle.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      adaptive: "DST.Settings.NotifyStyle.Adaptive",
      toastOnly: "DST.Settings.NotifyStyle.ToastOnly",
      panelOnly: "DST.Settings.NotifyStyle.PanelOnly",
    },
    default: "adaptive",
  });

  register(SETTINGS.showToDirector, {
    name: "DST.Settings.ShowToDirector.Name",
    hint: "DST.Settings.ShowToDirector.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  register(SETTINGS.toastDuration, {
    name: "DST.Settings.ToastDuration.Name",
    hint: "DST.Settings.ToastDuration.Hint",
    scope: "client",
    config: true,
    type: new foundry.data.fields.NumberField({ min: 3, max: 30, step: 1, initial: 8, nullable: false }),
    default: 8,
  });

  register(SETTINGS.chatArchive, {
    name: "DST.Settings.ChatArchive.Name",
    hint: "DST.Settings.ChatArchive.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      never: "DST.Settings.ChatArchive.Never",
      decisions: "DST.Settings.ChatArchive.Decisions",
      all: "DST.Settings.ChatArchive.All",
    },
    default: "decisions",
  });

  register(SETTINGS.logSize, {
    name: "DST.Settings.LogSize.Name",
    hint: "DST.Settings.LogSize.Hint",
    scope: "client",
    config: true,
    type: new foundry.data.fields.NumberField({ min: 20, max: 500, step: 10, initial: 100, nullable: false }),
    default: 100,
  });

  register(SETTINGS.inferForcedMovement, {
    name: "DST.Settings.InferForcedMovement.Name",
    hint: "DST.Settings.InferForcedMovement.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  register(SETTINGS.userCatalog, {
    scope: "world",
    config: false,
    type: String,
    default: "",
    onChange: () => invalidateCatalog(),
  });

  register(SETTINGS.disabledEntries, {
    scope: "world",
    config: false,
    type: Array,
    default: [],
  });

  register(SETTINGS.debug, {
    name: "DST.Settings.Debug.Name",
    hint: "DST.Settings.Debug.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.registerMenu(MODULE_ID, "catalogEditor", {
    name: "DST.Catalog.MenuName",
    label: "DST.Catalog.MenuLabel",
    hint: "DST.Catalog.MenuHint",
    icon: "fa-solid fa-list-check",
    type: CatalogEditor,
    restricted: true,
  });
}
