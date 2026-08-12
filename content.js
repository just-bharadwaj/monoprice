// Scanner, marker lifecycle, and tooltip. Never fetches; asks the worker for rates.

(async () => {
  'use strict';

  // Declarative content scripts cannot be modules, so the detector is pulled in
  // dynamically from its extension URL (it is web-accessible for this reason).
  const detect = await import(chrome.runtime.getURL('detect.js'));

  const DEFAULTS = {
    target: 'INR',
    sources: ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'AED', 'SGD', 'INR'],
    enabled: true,
    disabledSites: []
  };

  const MAX_MARKERS = 500;
  const DEBOUNCE_MS = 150;
  const GAP = 8;
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE', 'KBD', 'SAMP',
    'INPUT', 'SELECT', 'OPTION', 'SVG', 'CANVAS', 'IFRAME', 'TITLE'
  ]);

  let settings = { ...DEFAULTS };
  let rateTable = null;
  let processed = new WeakSet();
  let markerCount = 0;
  let observer = null;
  let debounceTimer = 0;

  let tipHost = null;
  let tipCard = null;
  let tipMain = null;
  let tipMeta = null;

  const formatters = new Map();
  function money(value, code) {
    let formatter = formatters.get(code);
    if (!formatter) {
      const locale = (detect.CURRENCIES[code] || {}).locale || 'en-US';
      formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: code });
      formatters.set(code, formatter);
    }
    return formatter.format(value);
  }

  // A sub-unit rate (e.g. 1 INR = $0.0105) needs more digits or it rounds to nothing.
  function rateMoney(value, code) {
    const locale = (detect.CURRENCIES[code] || {}).locale || 'en-US';
    const digits = value < 1 ? 4 : 2;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(value);
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

  function isActive() {
    return settings.enabled && !settings.disabledSites.includes(location.hostname);
  }

  /* ---------- rates ---------- */

  function askForRates(type) {
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

  async function loadRates() {
    const response = await askForRates('getRates');
    rateTable = response && response.ok ? response : null;
  }

  /* ---------- tooltip ---------- */

  async function buildTooltip() {
    const css = await fetch(chrome.runtime.getURL('content.css')).then((r) => r.text()).catch(() => '');
    tipHost = document.createElement('div');
    tipHost.setAttribute('data-monoprice', 'tooltip');
    const set = (property, value) => tipHost.style.setProperty(property, value, 'important');
    set('all', 'initial');
    set('position', 'absolute');
    set('top', '0px');
    set('left', '0px');
    set('display', 'block');
    set('z-index', '2147483647');
    set('pointer-events', 'none');
    set('visibility', 'hidden');

    const shadow = tipHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = css;
    tipCard = document.createElement('div');
    tipCard.className = 'mp-tip';
    tipMain = document.createElement('div');
    tipMain.className = 'mp-tip__main';
    tipMeta = document.createElement('div');
    tipMeta.className = 'mp-tip__meta';
    tipCard.append(tipMain, tipMeta);
    shadow.append(style, tipCard);
    document.body.appendChild(tipHost);
  }

  function fillTooltip(amount, currency) {
    const target = settings.target;
    const rate = rateTable && rateTable.rates ? rateTable.rates[currency] : undefined;
    if (typeof rate !== 'number' || !(rate > 0)) {
      tipMain.textContent = 'Rate unavailable';
      tipMeta.textContent = '';
      tipMeta.hidden = true;
      return;
    }
    // The table is based on the target currency, so `rate` is source units per 1 target.
    tipMain.textContent = money(amount, currency) + ' → ' + money(amount / rate, target);
    tipMeta.hidden = false;
    tipMeta.textContent = '@ ' + rateMoney(1 / rate, target) + ' · ' + ageLabel(rateTable.fetchedAt) +
      (rateTable.offline ? ' (offline)' : '');
  }

  function placeTooltip(rect) {
    const width = tipHost.offsetWidth;
    const height = tipHost.offsetHeight;

    let originX = 0;
    let originY = 0;
    const bodyStyle = getComputedStyle(document.body);
    if (bodyStyle.position !== 'static') {
      const bodyRect = document.body.getBoundingClientRect();
      originX = bodyRect.left + window.scrollX + (parseFloat(bodyStyle.borderLeftWidth) || 0);
      originY = bodyRect.top + window.scrollY + (parseFloat(bodyStyle.borderTopWidth) || 0);
    }

    const maxLeft = document.documentElement.clientWidth - width - GAP;
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(GAP, Math.min(left, Math.max(GAP, maxLeft)));

    let top = rect.top - height - GAP;
    const below = top < GAP;
    if (below) top = rect.bottom + GAP;
    tipCard.classList.toggle('mp-tip--below', below);

    tipHost.style.setProperty('left', left + window.scrollX - originX + 'px', 'important');
    tipHost.style.setProperty('top', top + window.scrollY - originY + 'px', 'important');
  }

  function showTooltip(rect, fill) {
    if (!tipHost) return;
    fill();
    tipHost.style.setProperty('visibility', 'hidden', 'important');
    placeTooltip(rect);
    tipHost.style.setProperty('visibility', 'visible', 'important');
  }

  function hideTooltip() {
    if (tipHost) tipHost.style.setProperty('visibility', 'hidden', 'important');
  }

  /* ---------- scanning ---------- */

  function collectTextNodes(root) {
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (SKIP_TAGS.has(node.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          if (node.isContentEditable) return NodeFilter.FILTER_REJECT;
          if (node.classList && node.classList.contains('mp-marker')) return NodeFilter.FILTER_REJECT;
          if (node.hasAttribute && node.hasAttribute('data-monoprice')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function wrapTextNode(node) {
    if (processed.has(node)) return 0;
    processed.add(node);
    const text = node.nodeValue;
    if (!text || text.length < 2 || !/\d/.test(text)) return 0;
    if (!node.parentElement) return 0;

    const matches = detect.findMatches(text, settings.sources, MAX_MARKERS - markerCount);
    if (matches.length === 0) return 0;
    // Cheap visibility gate, paid only by nodes that actually hold a price.
    if (node.parentElement.getClientRects().length === 0) return 0;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let added = 0;
    for (const match of matches) {
      if (match.currency === settings.target) continue;
      if (match.start < cursor) continue;
      if (match.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
      const marker = document.createElement('span');
      marker.className = 'mp-marker';
      marker.dataset.mpAmount = String(match.amount);
      marker.dataset.mpCurrency = match.currency;
      marker.textContent = match.text;
      fragment.appendChild(marker);
      cursor = match.end;
      added += 1;
    }
    if (added === 0) return 0;
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    for (const child of fragment.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) processed.add(child);
    }
    node.parentNode.replaceChild(fragment, node);
    return added;
  }

  function scan(root) {
    if (!isActive() || markerCount >= MAX_MARKERS) return;
    stopObserving();
    try {
      for (const node of collectTextNodes(root)) {
        if (markerCount >= MAX_MARKERS) break;
        markerCount += wrapTextNode(node);
      }
    } finally {
      startObserving();
    }
  }

  function unwrapAll() {
    stopObserving();
    try {
      for (const marker of document.querySelectorAll('span.mp-marker')) {
        const parent = marker.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(marker.textContent), marker);
        parent.normalize();
      }
    } finally {
      markerCount = 0;
      processed = new WeakSet();
      startObserving();
    }
  }

  /* ---------- observer ---------- */

  function startObserving() {
    if (!isActive() || observer || !document.body) return;
    observer = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => scan(document.body), DEBOUNCE_MS);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function stopObserving() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  /* ---------- events ---------- */

  function markerFrom(event) {
    const node = event.target;
    return node && node.nodeType === Node.ELEMENT_NODE && node.closest ? node.closest('span.mp-marker') : null;
  }

  document.addEventListener('mouseover', (event) => {
    const marker = markerFrom(event);
    if (!marker || !isActive()) return;
    showTooltip(marker.getBoundingClientRect(), () => {
      fillTooltip(Number(marker.dataset.mpAmount), marker.dataset.mpCurrency);
    });
  }, true);

  document.addEventListener('mouseout', (event) => {
    if (markerFrom(event)) hideTooltip();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideTooltip();
  }, true);

  window.addEventListener('scroll', hideTooltip, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'convertSelection') return undefined;
    const selection = window.getSelection();
    const text = message.text || (selection ? selection.toString() : '');
    const found = detect.findMatches(text, settings.sources, 1);

    let rect = null;
    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      rect = selection.getRangeAt(0).getBoundingClientRect();
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const centerX = document.documentElement.clientWidth / 2;
      rect = { left: centerX - 60, right: centerX + 60, top: 80, bottom: 80, width: 120, height: 0 };
    }

    showTooltip(rect, () => {
      if (found.length === 0) {
        tipMain.textContent = 'No price found';
        tipMeta.textContent = '';
        tipMeta.hidden = true;
      } else {
        fillTooltip(found[0].amount, found[0].currency);
      }
    });
    return undefined;
  });

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes.rateCache) {
      await loadRates();
      return;
    }
    if (area !== 'sync') return;
    const previous = settings;
    settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
    hideTooltip();

    if (!isActive()) {
      unwrapAll();
      stopObserving();
      return;
    }
    if (changes.target) await loadRates();
    // Any change to what we look for, or what we convert into, invalidates every marker.
    const rescan = changes.target || changes.sources ||
      (!previous.enabled && settings.enabled) ||
      changes.disabledSites;
    if (rescan) {
      unwrapAll();
      scan(document.body);
    } else {
      startObserving();
    }
  });

  /* ---------- init ---------- */

  settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  await buildTooltip();
  await loadRates();
  if (isActive()) scan(document.body);
})();
