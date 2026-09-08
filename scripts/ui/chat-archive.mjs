/**
 * Optional chat archive.
 *
 * The log panel keeps everything for the session, but it lives behind a button
 * and dies with the browser tab. Chat is the one place every player already
 * knows how to scroll back through, and it survives a reload. Archiving there
 * is therefore the strongest answer to "I missed it and now it's gone".
 *
 * Messages are whispered to the hero's owners and the Directors, never posted
 * publicly: the shared chat log stays readable, and a player is not shown
 * another player's prompts.
 */

import { MODULE_ID, SETTINGS } from "../constants.mjs";

/* -------------------------------------------------- */

/**
 * Whether this notification should be archived, per the world setting.
 * @param {object} notification
 * @returns {boolean}
 */
function shouldArchive(notification) {
  const mode = game.settings.get(MODULE_ID, SETTINGS.chatArchive);
  if (mode === "all") return true;
  if (mode === "decisions") return notification.severity === "decision";
  return false;
}

/* -------------------------------------------------- */

/**
 * Build the whisper recipient list: the hero's owners plus every active
 * Director.
 * @param {object} notification
 * @returns {string[]}
 */
function recipients(notification) {
  const ids = new Set(notification.ownerIds ?? []);
  for (const user of game.users) if (user.isGM) ids.add(user.id);
  return [...ids];
}

/* -------------------------------------------------- */

/**
 * Archive one notification as a whispered chat message.
 *
 * Runs on the authoritative Director's client only — the dispatcher calls this
 * once per notification, so letting every client create its own copy would
 * multiply the message by the number of people connected.
 *
 * @param {object} notification
 * @returns {Promise<void>}
 */
export async function archiveToChat(notification) {
  if (!shouldArchive(notification)) return;

  const parts = [
    `<p class="dst-chat__message">${foundry.utils.escapeHTML(notification.message)}</p>`,
  ];
  if (notification.conditionText) {
    parts.push(`<p class="dst-chat__condition"><i class="fa-solid fa-circle-question"></i> ${foundry.utils.escapeHTML(notification.conditionText)}</p>`);
  }
  if (notification.inferred) {
    parts.push(`<p class="dst-chat__flag"><i class="fa-solid fa-triangle-exclamation"></i> ${game.i18n.localize("DST.Toast.Inferred")}</p>`);
  }
  if (notification.reference) {
    parts.push(`<p class="dst-chat__ref">${foundry.utils.escapeHTML(notification.reference)}</p>`);
  }

  const gain = notification.gain
    ? `<span class="dst-chat__gain">${foundry.utils.escapeHTML(notification.gain)}</span>`
    : "";

  const content = `
    <div class="dst-chat dst-chat--${notification.severity}">
      <header class="dst-chat__head">
        <i class="fa-solid fa-bell"></i>
        <strong>${foundry.utils.escapeHTML(notification.recipientName)}</strong>
        ${gain}
      </header>
      ${parts.join("\n")}
    </div>`;

  try {
    await ChatMessage.create({
      content,
      whisper: recipients(notification),
      flags: { [MODULE_ID]: { entryId: notification.entryId } },
    });
  } catch (error) {
    console.warn(`${MODULE_ID} | archivage dans le chat impossible`, error);
  }
}
