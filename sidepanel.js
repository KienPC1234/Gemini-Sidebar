'use strict';

const GEMINI_URL = 'https://gemini.google.com/app';
const FRAME_RULE_COUNT = 3;

/**
 * Gemini renders its phone UI up to ~940 px and switches to the desktop layout at
 * ~980 px (measured). A frame of 940 px is therefore the widest "phone" viewport;
 * when the panel is wider we scale that viewport up so the panel is always filled
 * instead of showing two empty gutters.
 */
const FIT_WIDTH = 940;
/** Mirrors the presets offered in the settings page; anything else falls back to fit. */
const FRAME_PRESETS = new Set([940, 430, 390, 360]);

const frame = document.getElementById('app');
const boot = document.getElementById('boot');
const bar = document.getElementById('bar');
const barFill = document.getElementById('barFill');
const captionText = document.getElementById('captionText');

let frameLimit = FIT_WIDTH;

function normalizeFrameWidth(value) {
  const px = Number(value);
  return FRAME_PRESETS.has(px) ? px : FIT_WIDTH;
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

function applyLayout() {
  const width = document.documentElement.clientWidth;
  const height = document.documentElement.clientHeight;

  frame.style.transform = '';
  frame.style.margin = '0';

  // Narrower than the limit: the frame simply fills the panel.
  if (!frameLimit || width <= frameLimit) {
    frame.style.width = '100%';
    frame.style.height = '100%';
    return;
  }

  if (frameLimit === FIT_WIDTH) {
    // Wide panel: keep a 940 px viewport (phone UI) and scale it to fill.
    const scale = width / frameLimit;
    frame.style.width = `${frameLimit}px`;
    frame.style.height = `${height / scale}px`;
    frame.style.transformOrigin = 'top left';
    frame.style.transform = `scale(${scale})`;
    return;
  }

  // Explicit phone size (430/390/360): centred, with gutters on purpose.
  frame.style.width = `${frameLimit}px`;
  frame.style.height = '100%';
  frame.style.margin = '0 auto';
}

function applyFrameWidth(value) {
  frameLimit = normalizeFrameWidth(value);
  applyLayout();
}

async function loadFrameWidth() {
  try {
    const stored = await chrome.storage.local.get({ frameWidth: FIT_WIDTH });
    frameLimit = normalizeFrameWidth(stored.frameWidth);
  } catch {
    frameLimit = FIT_WIDTH;
  }
  applyLayout();
}

new ResizeObserver(() => applyLayout()).observe(document.documentElement);

/* ------------------------------------------------------------------ */
/* Frame rules (self-healing)                                          */
/* ------------------------------------------------------------------ */

async function countRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return rules.length;
  } catch {
    return -1;
  }
}

async function installFrameRules() {
  try {
    // Never let a stuck message block the panel forever.
    await Promise.race([
      chrome.runtime.sendMessage({ type: 'ensure-rules' }),
      new Promise((resolve) => setTimeout(resolve, 800)),
    ]);
  } catch {
    /* service worker asleep or extension reloading */
  }

  for (let i = 0; i < 10; i++) {
    const count = await countRules();
    if (count < 0) return false; // no DNR access at all: just try to load
    if (count >= FRAME_RULE_COUNT) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* Splash + progress bar                                               */
/* ------------------------------------------------------------------ */

let loaded = false;
let rulesReady = false;
let hidden = false;
let progress = 0;

function paintProgress(value) {
  progress = Math.min(100, Math.max(0, value));
  if (barFill) barFill.style.width = `${progress}%`;
  if (bar) bar.setAttribute('aria-valuenow', String(Math.round(progress)));
}

/** Fake but honest-looking progress: eases quickly, then crawls toward 90%. */
const progressTimer = setInterval(() => {
  if (hidden || progress >= 90) return;
  paintProgress(progress + Math.max(0.8, (90 - progress) * 0.1));
}, 180);

/* Playful captions while waiting — purely decorative (aria-hidden). */
const MESSAGES = [
  'Opening Gemini…',
  'Waking up the model…',
  'Untangling thoughts…',
  'Warming up the pixels…',
  'Almost there…',
];
let messageIndex = 0;
let messageTimer = null;
let slow = false;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function startCaptions() {
  if (reduceMotion.matches || !captionText) return;
  messageTimer = setInterval(() => {
    if (hidden || slow) return;
    messageIndex = (messageIndex + 1) % MESSAGES.length;
    captionText.classList.add('swap');
    setTimeout(() => {
      if (!captionText) return;
      captionText.textContent = MESSAGES[messageIndex];
      captionText.classList.remove('swap');
    }, 170);
  }, 2300);
}

startCaptions();
reduceMotion.addEventListener('change', () => {
  clearInterval(messageTimer);
  messageTimer = null;
  startCaptions();
});

function hideBoot() {
  if (hidden || !boot) return;
  hidden = true;
  clearInterval(progressTimer);
  clearInterval(messageTimer);
  paintProgress(100);
  setTimeout(() => {
    boot.classList.add('hide');
    setTimeout(() => boot.remove(), 240);
  }, 160);
}

function maybeFinishBoot() {
  if (loaded && rulesReady) hideBoot();
}

function nudgeRepaint(el) {
  el.style.transform = 'translateZ(0)';
  requestAnimationFrame(() => {
    el.style.transform = '';
    applyLayout();
  });
}

frame.addEventListener('load', () => {
  loaded = true;
  nudgeRepaint(frame);
  maybeFinishBoot();
});

// Never trap the user behind the splash, whatever happens.
setTimeout(hideBoot, 12000);

// After 7 s, offer a manual escape hatch (blocked frame, dead network, …).
setTimeout(() => {
  if (hidden || !boot) return;
  slow = true;
  boot.classList.add('slow');
}, 7000);

document.getElementById('retry')?.addEventListener('click', () => location.reload());

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

/**
 * Start the frame only after the loading screen has been painted. Starting it from
 * the markup saves ~10 ms, but on Chromium's side-panel surface the cross-origin frame
 * can then claim the compositor before the panel's own content appears, which shows up
 * as a grey panel instead of the splash.
 */
function startNavigation() {
  if (!frame.getAttribute('src')) frame.src = GEMINI_URL;
}

requestAnimationFrame(() => setTimeout(startNavigation, 0));
setTimeout(startNavigation, 150); // fallback when rAF is throttled

/**
 * If the extension is reloaded/updated while this panel is open, its JS context is
 * invalidated and the panel stays as a dead, blank document. Detect that and reload
 * ourselves so the fresh sidepanel.html takes over.
 */
setInterval(() => {
  try {
    if (!chrome.runtime || !chrome.runtime.id) location.reload();
  } catch {
    location.reload();
  }
}, 1500);

/**
 * All we still verify is the DNR rule set: if it was missing when the panel opened,
 * that first navigation was blocked by X-Frame-Options, so install the rules and
 * re-navigate once — with a cache-buster, otherwise Chrome can treat the assignment
 * as a no-op on an error page. The splash stays up until the retry lands.
 */
(async () => {
  loadFrameWidth();

  const initial = await countRules();
  if (initial < 0) {
    rulesReady = true; // no DNR access: nothing we can check
    maybeFinishBoot();
    return;
  }

  if (initial >= FRAME_RULE_COUNT) {
    rulesReady = true;
    maybeFinishBoot();
    return;
  }

  const installed = await installFrameRules();
  rulesReady = true;
  if (!installed) {
    maybeFinishBoot();
    return;
  }

  loaded = false; // ignore the blocked page's load event
  frame.src = `${GEMINI_URL}?r=${Date.now()}`;
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.frameWidth) {
    applyFrameWidth(changes.frameWidth.newValue);
  }
});

/** Right-click the icon → "Reload panel" reaches us here. */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'reload-panel') location.reload();
});
