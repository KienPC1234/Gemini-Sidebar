'use strict';

/**
 * Gemini Sidebar — background service worker.
 *
 * Two modes:
 *  - "panel" (default): Chromium's real side panel hosting an iframe of Gemini.
 *    gemini.google.com sends "X-Frame-Options: DENY", so we strip that header (and
 *    the CSP that carries frame-ancestors) with declarativeNetRequest.
 *  - "window": a frameless popup pinned to the right edge.
 *
 * Rule of thumb: anything that opens the panel must call sidePanel.open() in the
 * SAME task as the user gesture. No await before it, ever.
 */

const GEMINI_URL = 'https://gemini.google.com/app';
const PANEL_PATH = 'sidepanel.html';
const WIN_KEY = 'panelWindowId';

const MIN_WIDTH = 320;
const MAX_WIDTH = 900;

const DEFAULTS = {
  mode: 'panel',
  panelWidth: 400,
  preload: false,
};

const MENU = {
  panel: 'open-panel',
  window: 'open-window',
  tab: 'open-tab',
  options: 'open-options',
};

/** Kept in memory so click handlers can branch without awaiting storage. */
let cachedMode = DEFAULTS.mode;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const round = (n) => Math.round(Number(n) || 0);

/** Serialize window operations so a fast double click cannot create two panels. */
let queue = Promise.resolve();
function serial(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  cachedMode = stored.mode === 'window' ? 'window' : 'panel';
  return {
    mode: cachedMode,
    panelWidth: clamp(round(stored.panelWidth) || DEFAULTS.panelWidth, MIN_WIDTH, MAX_WIDTH),
    preload: Boolean(stored.preload),
  };
}

async function getWindowId() {
  const stored = await chrome.storage.session.get(WIN_KEY);
  const id = stored && stored[WIN_KEY];
  return typeof id === 'number' ? id : null;
}

const setWindowId = (id) => chrome.storage.session.set({ [WIN_KEY]: id });
const clearWindowId = () => chrome.storage.session.remove(WIN_KEY);

/* ------------------------------------------------------------------ */
/* Frame rules (the side panel trick)                                  */
/* ------------------------------------------------------------------ */

const FRAME_RULE_IDS = [1, 2, 3];

/** Origins Gemini needs while living inside our iframe. */
const FRAME_DOMAINS = [
  'gemini.google.com',
  'accounts.google.com',
  'consent.google.com',
  'ogs.google.com',
  'www.google.com',
];

/**
 * Registered as DYNAMIC rules instead of a static ruleset on purpose:
 * dynamic rules support `initiatorDomains`, so only frames started by this panel
 * (or by Gemini itself) get their headers relaxed. A static ruleset would also
 * strip protections from Google One Tap / reCAPTCHA iframes on any website.
 */
async function installFrameRules() {
  const base = {
    initiatorDomains: [chrome.runtime.id, 'gemini.google.com'],
    resourceTypes: ['sub_frame'],
  };

  const rules = [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
        ],
      },
      condition: { ...base, requestDomains: FRAME_DOMAINS },
    },
    {
      id: 2,
      priority: 2,
      action: { type: 'redirect', redirect: { extensionPath: '/signin.html' } },
      condition: { ...base, urlFilter: '||accounts.google.com/ServiceLogin' },
    },
    {
      id: 3,
      priority: 2,
      action: { type: 'redirect', redirect: { extensionPath: '/signin.html' } },
      condition: { ...base, urlFilter: '||accounts.google.com/v3/signin' },
    },
  ];

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: FRAME_RULE_IDS,
      addRules: rules,
    });
  } catch (err) {
    console.error('frame rules failed:', err);
  }
}

/**
 * Dynamic rules persist, but a dev reload of the extension does not fire
 * onInstalled, so verify them on every service worker wake. Read-only unless
 * something is missing.
 */
async function ensureFrameRules() {
  try {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    if (rules.length >= FRAME_RULE_IDS.length) return true;
  } catch {
    /* fall through and try to install */
  }
  await installFrameRules();
  return true;
}

ensureFrameRules().catch(() => {});

/* ------------------------------------------------------------------ */
/* Window helpers                                                      */
/* ------------------------------------------------------------------ */

/** Work area (taskbar excluded) of the display that contains the current window. */
async function screenWorkArea() {
  try {
    const displays = await chrome.system.display.getInfo();
    if (!displays || !displays.length) return null;

    let target = displays.find((d) => d.isPrimary) || displays[0];

    try {
      const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (last && typeof last.left === 'number' && typeof last.width === 'number') {
        const cx = last.left + last.width / 2;
        const cy = last.top + last.height / 2;
        const hit = displays.find((d) => {
          const a = d.workArea;
          return cx >= a.left && cx <= a.left + a.width && cy >= a.top && cy <= a.top + a.height;
        });
        if (hit) target = hit;
      }
    } catch {
      /* no normal window — keep the primary display */
    }

    return target.workArea;
  } catch {
    return null;
  }
}

async function dockBounds(width) {
  const area = await screenWorkArea();

  if (!area) {
    const fallback = { width: clamp(round(width), MIN_WIDTH, MAX_WIDTH) };
    try {
      const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      fallback.left = last.left + Math.max(0, last.width - fallback.width);
      fallback.top = last.top;
      fallback.height = last.height;
    } catch {
      /* let Chrome place it */
    }
    return fallback;
  }

  const w = clamp(round(width), MIN_WIDTH, Math.min(MAX_WIDTH, area.width));
  return {
    left: round(area.left + area.width - w),
    top: round(area.top),
    width: w,
    height: round(area.height),
  };
}

/* ------------------------------------------------------------------ */
/* Side panel mode (default)                                           */
/* ------------------------------------------------------------------ */

/**
 * Runs on every service worker wake, so the toolbar click keeps working even after
 * a dev reload (which does not fire onInstalled). Read-only when already correct.
 */
async function applyMode() {
  const settings = await getSettings();
  const want = settings.mode === 'panel';

  try {
    const current = await chrome.sidePanel.getPanelBehavior().catch(() => null);
    if (!current || current.openPanelOnActionClick !== want) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: want });
    }
  } catch (err) {
    console.warn('sidePanel setup failed:', err);
  }
}

applyMode().catch(() => {});

/**
 * Opens the panel. MUST be called synchronously inside a user gesture handler:
 * any await before it invalidates the gesture in a service worker.
 *
 * @param {number|undefined} windowId
 * @returns {Promise<boolean>}
 */
function openSidePanelNow(windowId) {
  const options = typeof windowId === 'number' ? { windowId } : {};

  return chrome.sidePanel.open(options).then(
    () => true,
    (err) => {
      console.warn('sidePanel.open failed:', err);
      // Last resort so the user still gets Gemini somewhere.
      serial(showWindowPanel).catch(() => {});
      return false;
    },
  );
}

/** Message/context paths without a gesture: try, then fall back to a window. */
async function openSidePanelAsync() {
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
    await chrome.sidePanel.open(win ? { windowId: win.id } : {});
    return true;
  } catch (err) {
    console.warn('sidePanel.open failed:', err);
    await showWindowPanel().catch(() => {});
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Floating window mode                                                */
/* ------------------------------------------------------------------ */

async function showWindowPanel() {
  const settings = await getSettings();
  const existingId = await getWindowId();

  if (existingId !== null) {
    const win = await chrome.windows.get(existingId).catch(() => null);

    if (win) {
      // Panel still alive: just bring it back, never reload.
      if (win.state === 'minimized') {
        await chrome.windows.update(win.id, { state: 'normal' }).catch(() => {});
      }
      const bounds = await dockBounds(settings.panelWidth);
      await chrome.windows
        .update(win.id, { ...bounds, state: 'normal', focused: true })
        .catch(() => {});
      return win;
    }

    await clearWindowId();
  }

  const bounds = await dockBounds(settings.panelWidth);
  const win = await chrome.windows.create({
    url: GEMINI_URL,
    type: 'popup',
    focused: true,
    ...bounds,
  });

  if (win && win.id != null) await setWindowId(win.id);
  return win;
}

async function toggleWindowPanel() {
  const id = await getWindowId();
  if (id !== null) {
    const win = await chrome.windows.get(id).catch(() => null);
    if (win && win.focused) {
      await chrome.windows.remove(id).catch(() => {});
      return;
    }
  }
  await showWindowPanel();
}

/**
 * Keeps a minimized Gemini window alive from browser start. It warms the HTTP cache,
 * the cookie jar and the connection pool for *both* modes: the side panel still fetches
 * its HTML (Gemini sends no-store) but every byte of JS/CSS comes from cache.
 */
async function preloadPanel() {
  const settings = await getSettings();
  if (!settings.preload) return;

  const id = await getWindowId();
  if (id !== null && (await chrome.windows.get(id).catch(() => null))) return;

  const bounds = await dockBounds(settings.panelWidth);
  try {
    // NB: windows.create() rejects state:'minimized' when bounds are supplied
    // ("Invalid value for state"), so create docked and minimize right after.
    const win = await chrome.windows.create({
      url: GEMINI_URL,
      type: 'popup',
      focused: false,
      ...bounds,
    });
    if (win && win.id != null) {
      await setWindowId(win.id);
      const minimized = await chrome.windows
        .update(win.id, { state: 'minimized' })
        .then(() => true)
        .catch(() => false);

      // Never leave a surprise window on screen at browser start.
      if (!minimized) await chrome.windows.remove(win.id).catch(() => {});
    }
  } catch {
    // No visible fallback: a window popping up at browser start is worse than
    // simply loading on the next click.
  }
}

const openInTab = () => chrome.tabs.create({ url: GEMINI_URL });
const openOptions = () => chrome.runtime.openOptionsPage();

/* ------------------------------------------------------------------ */
/* Toolbar context menu                                                */
/* ------------------------------------------------------------------ */

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU.panel, title: 'Open side panel', contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU.window, title: 'Open floating window', contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU.tab, title: 'Open in a new tab', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'sep', type: 'separator', contexts: ['action'] });
    chrome.contextMenus.create({ id: MENU.options, title: 'Settings…', contexts: ['action'] });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU.panel) {
    // Synchronous: the menu click is the user gesture.
    openSidePanelNow(tab && tab.windowId);
  } else if (info.menuItemId === MENU.window) {
    serial(showWindowPanel).catch(() => {});
  } else if (info.menuItemId === MENU.tab) {
    openInTab();
  } else if (info.menuItemId === MENU.options) {
    openOptions();
  }
});

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

chrome.action.onClicked.addListener((tab) => {
  // Only fires when openPanelOnActionClick is off (or not set yet).
  if (cachedMode === 'window') {
    serial(toggleWindowPanel).catch(() => {});
    return;
  }

  openSidePanelNow(tab && tab.windowId);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-window') serial(showWindowPanel).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
  installFrameRules();
  // Manifest already declares side_panel.default_path; this only pins it once.
  chrome.sidePanel.setOptions({ path: PANEL_PATH, enabled: true }).catch(() => {});
  applyMode().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  setupMenus();
  installFrameRules();
  applyMode().catch(() => {});
  setTimeout(() => serial(preloadPanel).catch(() => {}), 4000);
});

chrome.windows.onRemoved.addListener((windowId) => {
  serial(async () => {
    if ((await getWindowId()) === windowId) await clearWindowId();
  }).catch(() => {});
});

/* Remember the width when the user drags the floating window. */
let widthTimer = null;
chrome.windows.onBoundsChanged.addListener((win) => {
  if (!win || win.type !== 'popup' || win.state !== 'normal') return;

  const width = win.width;
  const id = win.id;
  clearTimeout(widthTimer);

  widthTimer = setTimeout(() => {
    if (!width || width < MIN_WIDTH) return;
    serial(async () => {
      if ((await getWindowId()) !== id) return;
      const current = await chrome.storage.local.get(DEFAULTS);
      if (Math.abs(round(current.panelWidth) - width) < 8) return;
      await chrome.storage.local.set({ panelWidth: width });
    }).catch(() => {});
  }, 600);
});

/* Settings changed from the options page, and the panel asking for its rules. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'apply-settings') {
    applyMode().catch(() => {});
    serial(async () => {
      const settings = await getSettings();
      const id = await getWindowId();
      if (id === null) return;

      const win = await chrome.windows.get(id).catch(() => null);
      if (!win || win.state === 'minimized') return;

      const bounds = await dockBounds(settings.panelWidth);
      await chrome.windows.update(id, bounds).catch(() => {});
    }).catch(() => {});
  }

  if (msg.type === 'ensure-rules') {
    // Must answer only after the rules are live, otherwise the panel would start
    // navigating too early and land on a blocked frame (blank page).
    ensureFrameRules()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'open-panel') openSidePanelAsync();
  if (msg.type === 'open-window') serial(showWindowPanel).catch(() => {});
});
