/**
 * Non-modal notifications.
 *
 * This is the default presentation, and the reason the module stays usable past
 * session three. A fury takes damage nearly every round; if that opened a dialog
 * every time, players would learn to dismiss it without reading. A toast that
 * fades on its own asks for a glance, not a click.
 *
 * The counterpart to fading is that a missed toast must never be a lost one:
 * hovering pauses the countdown, clicking opens the full log, and the archive
 * setting can mirror everything into chat.
 */

import { MODULE_ID, SETTINGS } from "../constants.mjs";
import WatchPanel from "../apps/watch-panel.mjs";

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
  element.title = game.i18n.localize("DST.Toast.ClickHint");

  const heading = document.createElement("div");
  heading.className = "dst-toast__head";

  const who = document.createElement("span");
  who.className = "dst-toast__who";
  who.textContent = notification.recipientName;
  heading.append(who);

  if (notification.gain) {
    const gain = document.createElement("span");
    gain.className = "dst-toast__gain";
    gain.textContent = notification.gain;
    heading.append(gain);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "dst-toast__close";
  close.innerHTML = '<i class="fa-solid fa-xmark"></i>';
  close.setAttribute("aria-label", game.i18n.localize("DST.Toast.Dismiss"));
  heading.append(close);

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

  /* ---------- dismissal, with a pausable countdown ---------- */

  let timer = null;
  let dismissed = false;

  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    element.classList.add("dst-toast--leaving");
    setTimeout(() => element.remove(), 250);
  };

  // Decisions linger; informational gains clear themselves sooner.
  const life = notification.severity === "decision" ? duration * 2.5 : duration;
  const start = () => {
    clearTimeout(timer);
    timer = setTimeout(dismiss, life);
  };

  // The most common way to lose a notification is for it to fade while you are
  // reading it. Hovering stops the clock; leaving restarts it in full.
  element.addEventListener("mouseenter", () => {
    clearTimeout(timer);
    element.classList.add("dst-toast--held");
  });
  element.addEventListener("mouseleave", () => {
    element.classList.remove("dst-toast--held");
    start();
  });

  close.addEventListener("click", (event) => {
    event.stopPropagation();
    dismiss();
  });

  // Clicking the toast itself opens the log rather than merely closing it: if
  // you noticed this one, you may well have missed the previous one.
  element.addEventListener("click", () => {
    WatchPanel.instance.render({ force: true });
    dismiss();
  });

  host.prepend(element);
  start();
}

/* -------------------------------------------------- */

/** Remove every toast currently on screen. */
export function clearToasts() {
  container?.replaceChildren();
}
