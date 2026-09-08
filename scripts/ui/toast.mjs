/**
 * Non-modal notifications.
 *
 * This is the default presentation, and the reason the module stays usable past
 * session three. A fury takes damage nearly every round; if that opened a dialog
 * every time, players would learn to dismiss it without reading. A toast that
 * fades on its own asks for a glance, not a click.
 */

import { MODULE_ID, SETTINGS } from "../constants.mjs";

/** @type {HTMLElement|null} */
let container = null;

/* -------------------------------------------------- */

/** @returns {HTMLElement} */
function ensureContainer() {
  if (container?.isConnected) return container;
  container = document.createElement("div");
  container.id = "dst-toasts";
  container.setAttribute("aria-live", "polite");
  (document.getElementById("interface") ?? document.body).append(container);
  return container;
}

/* -------------------------------------------------- */

/**
 * Show one notification as a toast.
 * @param {object} notification
 */
export function showToast(notification) {
  const host = ensureContainer();
  const duration = game.settings.get(MODULE_ID, SETTINGS.toastDuration) * 1000;

  const element = document.createElement("div");
  element.className = `dst-toast dst-toast--${notification.severity}`;
  if (notification.inferred) element.classList.add("dst-toast--inferred");

  const heading = document.createElement("div");
  heading.className = "dst-toast__head";
  heading.innerHTML = `<span class="dst-toast__who">${foundry.utils.escapeHTML(notification.recipientName)}</span>`;
  if (notification.gain) {
    const gain = document.createElement("span");
    gain.className = "dst-toast__gain";
    gain.textContent = notification.gain;
    heading.append(gain);
  }

  const body = document.createElement("p");
  body.className = "dst-toast__body";
  body.textContent = notification.message;

  element.append(heading, body);

  if (notification.conditionText) {
    const condition = document.createElement("p");
    condition.className = "dst-toast__condition";
    condition.textContent = notification.conditionText;
    element.append(condition);
  }

  if (notification.inferred) {
    const flag = document.createElement("p");
    flag.className = "dst-toast__flag";
    flag.textContent = game.i18n.localize("DST.Toast.Inferred");
    element.append(flag);
  }

  const dismiss = () => {
    element.classList.add("dst-toast--leaving");
    setTimeout(() => element.remove(), 250);
  };

  element.addEventListener("click", dismiss);
  host.prepend(element);

  // Decisions linger; informational gains clear themselves.
  const life = notification.severity === "decision" ? duration * 2.5 : duration;
  setTimeout(dismiss, life);
}

/* -------------------------------------------------- */

/** Remove every toast currently on screen. */
export function clearToasts() {
  container?.replaceChildren();
}
