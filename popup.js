import { CURRENCIES, CURRENCY_CODES } from './detect.js';

const DEFAULTS = {
  target: 'INR',
  sources: ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'AED', 'SGD', 'INR'],
  enabled: true,
  disabledSites: []
};

const el = {
  master: document.getElementById('master'),
  target: document.getElementById('target'),
  sources: document.getElementById('sources'),
  host: document.getElementById('host'),
  site: document.getElementById('site'),
  status: document.getElementById('status'),
  dot: document.getElementById('dot'),
  refresh: document.getElementById('refresh')
};

let settings = { ...DEFAULTS };
let hostname = '';

function send(type) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type }, (response) => {
        resolve(chrome.runtime.lastError ? null : response);
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function ageLabel(timestamp) {
  const seconds = Math.max(0, Date.now() - timestamp) / 1000;
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' hr ago';
  return Math.floor(hours / 24) + ' d ago';
}

function tick(target) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M2.5 6.4 4.8 8.7 9.5 3.6');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.8');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  target.appendChild(svg);
}

function buildTargets() {
  for (const code of CURRENCY_CODES) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = code + ' · ' + CURRENCIES[code].name;
    el.target.appendChild(option);
  }
}

function buildSources() {
  for (const code of CURRENCY_CODES) {
    const chip = document.createElement('label');
    chip.className = 'chip';
    chip.dataset.code = code;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = code;
    input.addEventListener('change', onSourcesChange);

    const box = document.createElement('span');
    box.className = 'chip__box';
    tick(box);

    const label = document.createElement('span');
    label.className = 'chip__code';
    label.textContent = code;

    chip.append(input, box, label);
    el.sources.appendChild(chip);
  }
}

function apply() {
  el.master.checked = settings.enabled;
  el.target.value = settings.target;
  for (const input of el.sources.querySelectorAll('input')) {
    input.checked = settings.sources.includes(input.value);
  }
  if (hostname) {
    el.host.textContent = hostname;
    el.site.disabled = false;
    el.site.checked = !settings.disabledSites.includes(hostname);
  } else {
    el.host.textContent = 'Not available on this page';
    el.site.disabled = true;
    el.site.checked = false;
  }
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.sync.set(patch);
}

function onSourcesChange() {
  const sources = [...el.sources.querySelectorAll('input')]
    .filter((input) => input.checked)
    .map((input) => input.value);
  save({ sources });
}

function markMissingRates(rates) {
  for (const chip of el.sources.querySelectorAll('.chip')) {
    const missing = rates ? !(chip.dataset.code in rates) : false;
    if (missing) {
      chip.dataset.norate = '';
      chip.title = 'No rate published for ' + chip.dataset.code;
    } else {
      delete chip.dataset.norate;
      chip.removeAttribute('title');
    }
  }
}

async function updateStatus(response) {
  const rates = response === undefined ? await send('getRates') : response;
  if (!rates || !rates.ok) {
    el.status.textContent = 'Rates unavailable';
    el.dot.dataset.state = 'error';
    markMissingRates(null);
    return;
  }
  el.status.textContent = 'Rates updated ' + ageLabel(rates.fetchedAt) + (rates.offline ? ' (offline)' : '');
  el.dot.dataset.state = rates.offline ? 'stale' : 'live';
  markMissingRates(rates.rates);
}

function wire() {
  el.master.addEventListener('change', () => save({ enabled: el.master.checked }));

  el.target.addEventListener('change', async () => {
    await save({ target: el.target.value });
    el.status.textContent = 'Fetching rates…';
    el.dot.dataset.state = 'stale';
    await updateStatus();
  });

  el.site.addEventListener('change', () => {
    if (!hostname) return;
    const disabledSites = settings.disabledSites.filter((entry) => entry !== hostname);
    if (!el.site.checked) disabledSites.push(hostname);
    save({ disabledSites });
  });

  el.refresh.addEventListener('click', async () => {
    el.refresh.disabled = true;
    el.refresh.dataset.busy = '';
    await updateStatus(await send('refreshRates'));
    delete el.refresh.dataset.busy;
    el.refresh.disabled = false;
  });
}

async function init() {
  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  buildTargets();
  buildSources();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab && tab.url ? tab.url : '');
    hostname = url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : '';
  } catch (err) {
    hostname = '';
  }

  apply();
  wire();
  await updateStatus();
}

init();
