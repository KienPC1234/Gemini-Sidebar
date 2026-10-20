# Gemini Sidebar

Gemini in Chromium's real side panel, in the **phone layout**, one click away.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → pick this folder
3. Click the Gemini icon (pin it). `Alt+G` also works.

## How it works

- The panel hosts an `<iframe>` of Gemini; `declarativeNetRequest` removes
  `X-Frame-Options` / CSP **only for this extension's frames** (Gemini refuses to be framed).
- Gemini switches to its desktop layout above ~980 px, so the panel keeps a 940 px phone
  viewport and **scales it up** when you widen the panel — no empty gutters, no desktop UI.
- Google blocks sign-in inside frames (401); the extension shows a helper page instead — sign in
  once in a normal tab.

## Settings

- **Display mode** — Side panel (default) or Floating window (popup pinned right).
- **Phone frame** — Fit panel (default) or fixed 430/390/360 px.
- **Floating window width** + **preload** (keeps a minimized Gemini window warm from browser start — fastest first open in both modes, ~150 MB RAM).

## Speed

Warm open ≈ 50–100 ms to Gemini's `load`: the toolbar click is handled by Chrome itself
(`openPanelOnActionClick`), the frame is the only child of the panel, `preconnect` warms Gemini and
the `gstatic` bundle hosts, and a cached splash covers the cold start. First ever open ≈ 2.5 s —
that is Google's payload, not the extension.

## Troubleshooting

- **Blank / grey panel** — a dev reload kills the document that is already open. Close the panel (✕) and click the icon again, or right-click the icon → **Reload panel**. The panel also reloads itself when it notices its extension context died.
- **Stuck on "Still loading…"** — the frame never finished; press **Reload panel** on the splash.
- **Stuck signed out** → sign in in a normal tab, then *I'm signed in — retry*, or use Floating window.
- **`Alt+G` does nothing** → rebind at `chrome://extensions/shortcuts`.
- **Desktop layout appeared** → raise the panel width or pick a phone frame in Settings.

> Console messages like `No ID or name found in config.` or `powerPreference … ignored` come from
> Gemini's own bundle and Chrome's WebGPU on Windows — they appear on gemini.google.com without
> this extension too.

## Files

```
manifest.json      MV3, minimal permissions
background.js      modes, frame rules (DNR), docking, menus, shortcuts
sidepanel.html/js  panel: phone frame + scaling, instant splash
signin.html/js     helper when Google refuses framed sign-in
options.html/js    settings (keyboard + screen-reader friendly)
icons/             16/32/48/128 px
```
