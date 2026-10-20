'use strict';

const DEFAULTS = {
  mode: 'panel',
  frameWidth: 940,
  panelWidth: 400,
  preload: false,
};

const widthInput = document.getElementById('width');
const widthValue = document.getElementById('widthValue');
const preloadInput = document.getElementById('preload');
const frameWidthInput = document.getElementById('frameWidth');
const windowCard = document.getElementById('windowCard');
const savedToast = document.getElementById('saved');

let toastTimer = null;
function toast() {
  savedToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => savedToast.classList.remove('show'), 1200);
}

const modeInputs = () => Array.from(document.querySelectorAll('input[name="mode"]'));
const currentMode = () => modeInputs().find((i) => i.checked)?.value || 'panel';

function syncWindowCard() {
  windowCard.classList.toggle('dim', currentMode() === 'panel');
}

function clampWidth(value) {
  const min = Number(widthInput.min) || 320;
  const max = Number(widthInput.max) || 640;
  return Math.min(max, Math.max(min, Number(value) || DEFAULTS.panelWidth));
}

/** Only the values the <select> actually offers are valid. */
function normalizeFrameWidth(value) {
  const allowed = new Set(Array.from(frameWidthInput.options, (option) => option.value));
  const raw = String(value);
  return allowed.has(raw) ? raw : String(DEFAULTS.frameWidth);
}

function paintWidth(value) {
  widthValue.textContent = value;
}

async function save() {
  const mode = currentMode();
  const frameWidth = Number(frameWidthInput.value) || DEFAULTS.frameWidth;
  const panelWidth = clampWidth(widthInput.value);
  const preload = preloadInput.checked;

  await chrome.storage.local.set({ mode, frameWidth, panelWidth, preload });
  toast();

  chrome.runtime.sendMessage({ type: 'apply-settings' }).catch(() => {});
}

/** Cached so the side panel can be opened synchronously inside the click gesture. */
let currentWindowId = null;

async function openPanelFromSettings() {
  // sidePanel.open() requires a user gesture: call it first, without awaiting
  // anything beforehand, otherwise Chrome rejects it.
  try {
    const target = currentWindowId != null ? { windowId: currentWindowId } : {};
    await chrome.sidePanel.open(target);
  } catch {
    chrome.runtime.sendMessage({ type: 'open-panel' }).catch(() => {});
  }
}

async function init() {
  const stored = await chrome.storage.local.get(DEFAULTS);

  modeInputs().forEach((input) => {
    input.checked = input.value === stored.mode;
    input.addEventListener('change', () => {
      syncWindowCard();
      save();
    });
  });

  // A stale/legacy value (e.g. the old phoneWidth key) would leave the select blank.
  const frameValue = normalizeFrameWidth(stored.frameWidth);
  frameWidthInput.value = frameValue;
  if (frameValue !== String(stored.frameWidth)) {
    chrome.storage.local.set({ frameWidth: Number(frameValue) }).catch(() => {});
  }
  frameWidthInput.addEventListener('change', save);

  const panelWidth = clampWidth(stored.panelWidth);
  widthInput.value = String(panelWidth);
  paintWidth(panelWidth);
  widthInput.addEventListener('input', () => paintWidth(widthInput.value));
  widthInput.addEventListener('change', save);

  preloadInput.checked = Boolean(stored.preload);
  preloadInput.addEventListener('change', save);

  document.getElementById('openPanel').addEventListener('click', openPanelFromSettings);

  document.getElementById('openWindow').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'open-window' }).catch(() => {});
  });

  document.getElementById('openTab').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://gemini.google.com/app' });
  });

  syncWindowCard();

  chrome.windows
    .getCurrent()
    .then((w) => {
      currentWindowId = w.id;
    })
    .catch(() => {});

  // Keep the page in sync when settings change elsewhere (e.g. dragging the
  // floating window saves its width).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.mode) {
      modeInputs().forEach((input) => (input.checked = input.value === changes.mode.newValue));
      syncWindowCard();
    }
    if (changes.frameWidth) {
      frameWidthInput.value = normalizeFrameWidth(changes.frameWidth.newValue);
    }
    if (changes.panelWidth) {
      const value = clampWidth(changes.panelWidth.newValue);
      widthInput.value = String(value);
      paintWidth(value);
    }
    if (changes.preload) {
      preloadInput.checked = Boolean(changes.preload.newValue);
    }
  });
}

init();
