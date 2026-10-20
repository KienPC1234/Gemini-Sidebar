'use strict';

const GEMINI_URL = 'https://gemini.google.com/app';

document.getElementById('signin').addEventListener('click', () => {
  chrome.tabs.create({ url: GEMINI_URL, active: true });
});

document.getElementById('retry').addEventListener('click', () => {
  location.replace(GEMINI_URL);
});
