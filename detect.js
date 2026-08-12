// Price patterns and number normalization. Edit currencies and regex shapes here only.

// `group`/`decimal` describe the currency's own convention, used to break ties on
// ambiguous strings like "1,299" where the separator could mean either thing.
export const CURRENCIES = {
  USD: { name: 'US Dollar', symbols: ['US$', '$'], locale: 'en-US', group: ',', decimal: '.' },
  EUR: { name: 'Euro', symbols: ['€'], locale: 'de-DE', group: '.', decimal: ',' },
  GBP: { name: 'British Pound', symbols: ['£'], locale: 'en-GB', group: ',', decimal: '.' },
  JPY: { name: 'Japanese Yen', symbols: ['¥'], locale: 'ja-JP', group: ',', decimal: '.' },
  CAD: { name: 'Canadian Dollar', symbols: ['CA$', 'C$'], locale: 'en-CA', group: ',', decimal: '.' },
  AUD: { name: 'Australian Dollar', symbols: ['AU$', 'A$'], locale: 'en-AU', group: ',', decimal: '.' },
  AED: { name: 'UAE Dirham', symbols: ['د.إ'], locale: 'ar-AE', group: ',', decimal: '.' },
  SGD: { name: 'Singapore Dollar', symbols: ['SG$', 'S$'], locale: 'en-SG', group: ',', decimal: '.' },
  INR: { name: 'Indian Rupee', symbols: ['₹', 'Rs.', 'Rs'], locale: 'en-IN', group: ',', decimal: '.' }
};

export const CURRENCY_CODES = Object.keys(CURRENCIES);

const SPACE = '[ \\u00a0\\u202f\\u2009\\u2007]';
// 1-3 leading digits, then 2- or 3-digit groups (2 covers Indian lakh grouping),
// then an optional 1-2 digit decimal tail. Falls back to a plain run of digits.
const NUMBER = `(?:\\d{1,3}(?:[.,\\u00a0\\u202f ]\\d{2,3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)`;

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest-first so "CA$" wins over "$" and "US$" is never split.
function symbolAlternation(codes) {
  const symbols = [];
  for (const code of codes) {
    const entry = CURRENCIES[code];
    if (entry) symbols.push(...entry.symbols);
  }
  return symbols
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
}

// Which currency a matched symbol or code belongs to. Bare "$" resolves to USD;
// the other dollar currencies are only detected via their prefixed forms.
function currencyForToken(token, codes) {
  const upper = token.toUpperCase();
  if (CURRENCIES[upper] && codes.includes(upper)) return upper;
  let best = null;
  for (const code of codes) {
    for (const symbol of CURRENCIES[code].symbols) {
      if (symbol.toUpperCase() === upper && (!best || symbol.length > best.length)) {
        best = { code, length: symbol.length };
      }
    }
  }
  return best ? best.code : null;
}

export function buildPattern(codes) {
  const active = codes.filter((code) => CURRENCIES[code]);
  if (active.length === 0) return null;
  const sym = symbolAlternation(active);
  const code = active.map(escapeRe).join('|');
  return new RegExp(
    [
      `(?<symBefore>${sym})${SPACE}?(?<numAfter>${NUMBER})`,
      `(?<numBefore>${NUMBER})${SPACE}?(?<symAfter>${sym})`,
      `\\b(?<codeBefore>${code})${SPACE}?(?<numAfterCode>${NUMBER})`,
      `(?<numBeforeCode>${NUMBER})${SPACE}?(?<codeAfter>${code})\\b`
    ].join('|'),
    'gu'
  );
}

// Decide which separator is the decimal point, then strip the rest.
export function normalizeNumber(raw, code) {
  const convention = CURRENCIES[code] || CURRENCIES.USD;
  const cleaned = raw.replace(/[     ]/g, '');
  const lastDot = cleaned.lastIndexOf('.');
  const lastComma = cleaned.lastIndexOf(',');

  let decimalAt = -1;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes last is the decimal point.
    decimalAt = Math.max(lastDot, lastComma);
  } else if (lastDot !== -1 || lastComma !== -1) {
    const only = lastDot !== -1 ? '.' : ',';
    const at = lastDot !== -1 ? lastDot : lastComma;
    const occurrences = cleaned.split(only).length - 1;
    const tail = cleaned.length - at - 1;
    if (occurrences > 1) decimalAt = -1;            // repeated => grouping
    else if (tail === 3) decimalAt = only === convention.decimal ? at : -1;
    else if (tail === 1 || tail === 2) decimalAt = at;
    else decimalAt = -1;
  }

  const digitsOnly = decimalAt === -1
    ? cleaned.replace(/[.,]/g, '')
    : cleaned.slice(0, decimalAt).replace(/[.,]/g, '') + '.' + cleaned.slice(decimalAt + 1);

  const value = Number.parseFloat(digitsOnly);
  return Number.isFinite(value) ? value : null;
}

// Rejects things that merely look numeric: percentages, versions, ranges, times.
function hasRejectingContext(text, start, end) {
  const before = text.slice(Math.max(0, start - 2), start);
  const after = text.slice(end, end + 2);
  if (/^\s*%/.test(after)) return true;                 // 50 %
  if (/^[.,]?\d/.test(after)) return true;              // spills into 1.2.3
  if (/^[/:-]\d/.test(after)) return true;              // 12/24, 10:30, ranges
  if (/\d[.,]?$/.test(before)) return true;             // continues a longer number
  if (/[\w#]$/.test(before) && !/[\s(]$/.test(before)) return true;  // SKU-4999, #4999
  return false;
}

export function findMatches(text, codes, limit = Infinity) {
  const pattern = buildPattern(codes);
  if (!pattern) return [];
  const results = [];
  for (const match of text.matchAll(pattern)) {
    if (results.length >= limit) break;
    const groups = match.groups;
    const token = groups.symBefore || groups.symAfter || groups.codeBefore || groups.codeAfter;
    const raw = groups.numAfter || groups.numBefore || groups.numAfterCode || groups.numBeforeCode;
    const currency = currencyForToken(token, codes);
    if (!currency || !raw) continue;

    const start = match.index;
    const end = start + match[0].length;
    if (hasRejectingContext(text, start, end)) continue;

    const amount = normalizeNumber(raw, currency);
    if (amount === null || amount <= 0 || amount >= 1e12) continue;

    results.push({ start, end, text: match[0], amount, currency });
  }
  return results;
}
