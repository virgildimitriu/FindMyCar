'use strict';

// Approximate RON->EUR rate for display purposes only (Autovit.ro occasionally
// lists in RON). Not a live BNR feed — good enough for a personal search tool,
// not for anything financial.
var RON_PER_EUR = 5.07;

var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FindMyCarPersonalSearch/1.0 ' +
  '(personal-use search aggregator; contact: ' + (process.env.CONTACT_EMAIL || 'owner') + ')';

function brandSlug(b) {
  return String(b).toLowerCase()
    .replace(/š/g, 's').replace(/ë/g, 'e').replace(/ç/g, 'c')
    .replace(/é|è/g, 'e').replace(/\s+/g, '-');
}

async function fetchHtml(url, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 10000);
  try {
    var res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8,de;q=0.7'
      }
    });
    if (!res.ok) {
      var err = new Error('HTTP ' + res.status);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractJsonScript(html, id) {
  var re = new RegExp('<script id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>');
  var m = re.exec(html);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function toEurPrice(amount, currency) {
  var units = Number(amount) || 0;
  if (currency === 'RON') {
    return { price: Math.round(units / RON_PER_EUR), currencyOriginal: 'RON', priceOriginal: units };
  }
  return { price: units, currencyOriginal: currency || 'EUR', priceOriginal: units };
}

function detectTransmission(text) {
  var t = String(text || '').toLowerCase();
  if (/automat|dsg|s.tronic|tiptronic|dct|automată|automatik/.test(t)) return 'Automatic';
  if (/manual|manuală|schaltgetriebe/.test(t)) return 'Manual';
  return null;
}

function detectFuel(text) {
  var t = String(text || '').toLowerCase();
  if (/electric|elektro/.test(t) && !/hybrid|hibrid/.test(t)) return 'Electric';
  if (/hybrid|hibrid/.test(t)) return 'Hybrid';
  if (/diesel|motorina|motorină/.test(t)) return 'Diesel';
  if (/benzina|benzină|petrol|benzin/.test(t)) return 'Petrol';
  return 'Petrol';
}

function digits(text) {
  var m = String(text || '').match(/[\d]+/g);
  if (!m) return 0;
  return parseInt(m.join(''), 10) || 0;
}

/* Generation numbers (Golf 8 / Golf VIII / Golf Mk8) don't share one spelling
   across sites, and a portal's own "model" field usually drops the
   generation entirely. Normalise roman numerals and "mk" prefixes to plain
   digits so free-text model queries can match listing text either way. */
var ROMAN_TO_ARABIC = {
  viii: '8', vii: '7', vi: '6', iv: '4', iii: '3', ii: '2',
  xii: '12', xi: '11', ix: '9', x: '10', v: '5', i: '1'
};
function normalizeModelText(s) {
  return String(s || '').toLowerCase()
    .replace(/\bmk\.?\s*/g, '')
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/\b(viii|vii|vi|iv|iii|ii|xii|xi|ix|x|v|i)\b/g, function (m) { return ROMAN_TO_ARABIC[m]; })
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
// Strip a trailing generation token for use in a portal's OWN model filter/path
// (which expects its controlled vocabulary, e.g. "golf" — sending it "golf 8"
// verbatim would likely break that query). The generation is matched
// separately, after fetching, via modelMatches().
function modelBase(s) {
  return normalizeModelText(s).replace(/\s+\d+$/, '').trim();
}
function modelMatches(query, listing) {
  if (!query) return true;
  var nq = normalizeModelText(query);
  if (!nq) return true;
  var hay = normalizeModelText([listing.model, listing.trim, listing.title].filter(Boolean).join(' '));
  return hay.indexOf(nq) > -1;
}

module.exports = {
  RON_PER_EUR: RON_PER_EUR,
  USER_AGENT: USER_AGENT,
  brandSlug: brandSlug,
  fetchHtml: fetchHtml,
  extractJsonScript: extractJsonScript,
  toEurPrice: toEurPrice,
  detectTransmission: detectTransmission,
  detectFuel: detectFuel,
  digits: digits,
  normalizeModelText: normalizeModelText,
  modelBase: modelBase,
  modelMatches: modelMatches
};
