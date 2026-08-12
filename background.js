// Service worker: the only place that touches the network.

const API = 'https://api.frankfurter.dev/v1/latest';
const CACHE_KEY = 'rateCache';
const MAX_AGE_MS = 15 * 60 * 1000;
const ALARM = 'monoprice-refresh';
const MENU_ID = 'monoprice-convert';

export const DEFAULTS = {
  target: 'INR',
  sources: ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'AED', 'SGD', 'INR'],
  enabled: true,
  disabledSites: []
};

let inFlight = null;

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function fetchRates(base) {
  const response = await fetch(`${API}?base=${encodeURIComponent(base)}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const data = await response.json();
  if (!data || !data.rates) throw new Error('Malformed rate payload');
  // Include the base itself so same-currency lookups resolve to 1.
  return { base, rates: { ...data.rates, [base]: 1 }, fetchedAt: Date.now() };
}

async function getRates(force = false) {
  const { target } = await getSettings();
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const cached = stored[CACHE_KEY];
  const usable = cached && cached.base === target;

  if (!force && usable && Date.now() - cached.fetchedAt < MAX_AGE_MS) {
    return { ok: true, ...cached, offline: false };
  }

  if (!inFlight) {
    inFlight = fetchRates(target).finally(() => { inFlight = null; });
  }

  try {
    const fresh = await inFlight;
    await chrome.storage.local.set({ [CACHE_KEY]: fresh });
    return { ok: true, ...fresh, offline: false };
  } catch (err) {
    // Stale data beats no data, but only if it is for the currency being asked about.
    if (usable) return { ok: true, ...cached, offline: true };
    return { ok: false };
  }
}

function registerMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Convert with MonoPrice',
      contexts: ['selection']
    });
  });
}

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: 15 });
}

chrome.runtime.onInstalled.addListener(() => {
  registerMenu();
  ensureAlarm();
  getRates(true);
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  getRates(true);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) getRates(true);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || typeof tab.id !== 'number') return;
  chrome.tabs.sendMessage(
    tab.id,
    { type: 'convertSelection', text: info.selectionText || '' },
    () => void chrome.runtime.lastError
  );
});

// A new target currency means the whole cached table is for the wrong base.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.target) getRates(true);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return undefined;
  if (message.type === 'getRates') {
    getRates(false).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message.type === 'refreshRates') {
    getRates(true).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  return undefined;
});
