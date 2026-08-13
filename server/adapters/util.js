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

// Distinguishes a plug-in hybrid (needs external charging from an outlet)
// from a regular/self-charging hybrid (charges itself via the engine and
// regenerative braking while driving) — both would otherwise just say
// "hybrid". Covers common textual markers plus a few manufacturer badges
// that specifically mean plug-in (VW/Audi "GTE"/"TFSI e", Volvo "Recharge").
function detectFuel(text) {
  var t = String(text || '').toLowerCase();
  var isPlugIn = /plug-?in|phev|priz[aă]|încărcare externă|incarcare externa|rechargeable|\bgte\b|tfsi ?e|\brecharge\b/.test(t);
  if (/electric|elektro/.test(t) && !/hybrid|hibrid/.test(t)) return 'Electric';
  if (/hybrid|hibrid/.test(t)) return isPlugIn ? 'Plug-in Hybrid' : 'Hybrid';
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

/* Generic-classifieds sites (publi24.ro, OLX.ro) don't expose brand/mileage/
   horsepower/accident-history as separate fields — only free title+description
   text, same shape as a pasted listing. Mirrors the frontend's paste parser
   (index.html parsePaste()) so both sides read text the same way. */
var BRANDS = ['Audi', 'BMW', 'Citroën', 'Cupra', 'Dacia', 'Fiat', 'Ford', 'Honda', 'Hyundai', 'Kia',
  'Mazda', 'Mercedes-Benz', 'Nissan', 'Opel', 'Peugeot', 'Renault', 'Seat', 'Škoda', 'Suzuki',
  'Toyota', 'Volkswagen', 'Volvo'];

// \b BEFORE the digit group is load-bearing: without it, a number regex can
// match the tail of a LARGER unrelated number sitting right next to the unit
// text — e.g. "Capacitate cilindrică: 1422  CP: 75" would otherwise read the
// last 3 digits of the 1422cc engine size as "422 CP" (a real bug found via
// live data: a 2004 VW Polo 1.4 TDI came back showing 422 hp). Digits are
// \w characters, so \b never occurs mid-run of a longer number — this forces
// the match to start at the true beginning of a number.
var NUM_PATTERN = '\\b(\\d{1,3}(?:[.,\\s]\\d{3})+|\\d{4,7}|\\d{1,3})';
function extractMileage(text) {
  var m = String(text || '').toLowerCase().match(new RegExp(NUM_PATTERN + '\\s*(?:km|kilometri|kilometer)'));
  if (!m) return 0;
  var v = parseInt(m[1].replace(/[.,\s]/g, ''), 10);
  return (v && v < 900000) ? v : 0;
}
function extractHorsepower(text) {
  var t = String(text || '').toLowerCase();
  // Some sites use "LABEL: value" field listings (e.g. "CP: 75 KW: 55")
  // instead of natural phrasing ("75 CP"). Checked first and with priority
  // over kW, or "75 KW" from that string would otherwise get matched as the
  // NUMBER-then-unit pattern below — misreading the CP field's value as if
  // it were the (different, adjacent) kW figure and multiplying it by 1.36
  // (confirmed live: turned a real 75 CP into a bogus 102).
  var cpLabeled = t.match(/\bcp\s*:?\s*(\d{2,3})\b/) || t.match(/\bhp\s*:?\s*(\d{2,3})\b/) ||
    t.match(/\bps\s*:?\s*(\d{2,3})\b/);
  if (cpLabeled) return parseInt(cpLabeled[1], 10);
  var m = t.match(/\b(\d{2,3})\s*(?:cp|hp|ps|bhp)\b/);
  if (m) return parseInt(m[1], 10);
  var kwLabeled = t.match(/\bkw\s*:?\s*(\d{2,3})\b/);
  if (kwLabeled) return Math.round(parseInt(kwLabeled[1], 10) * 1.36);
  var kw = t.match(/\b(\d{2,3})\s*kw\b/);
  if (kw) return Math.round(parseInt(kw[1], 10) * 1.36);
  return 0;
}
function extractEngineSize(text) {
  var t = String(text || '').toLowerCase();
  var m = t.match(new RegExp(NUM_PATTERN + '\\s*(?:cm3|cm³|ccm|cc\\b)'));
  if (m) {
    var v = parseInt(m[1].replace(/[.,\s]/g, ''), 10);
    if (v > 600 && v < 8000) return v;
  }
  var litres = t.match(/\b([123][.,]\d)\s*(?:l\b|tdi|tsi|tfsi|dci|crdi|hdi)/);
  if (litres) return Math.round(parseFloat(litres[1].replace(',', '.')) * 1000);
  return 0;
}
function detectAccidentStatus(text) {
  var t = String(text || '').toLowerCase();
  if (/f[aă]r[aă] accident|unfallfrei|accident.free|neaccidentat|nu a fost accidentat/.test(t)) return 'accident-free';
  if (/accidentat|unfallschaden|repaired damage|daune reparate/.test(t)) return 'repaired damage';
  return 'unknown';
}

/* Used against a listing DETAIL page's own equipment list (Romanian labels
   from Autovit, German equipment IDs from AutoScout24) — same patterns the
   frontend paste-import parser uses on pasted listing text, so a feature
   found this way means the same thing as one found by pasting. Mirrors
   index.html's featMap; keep the two in sync if either changes. */
var FEATURE_PATTERNS = {
  rearCamera: /camer[aă] (?:video )?(?:spate|marsarier)|r[uü]ckfahrkamera|\brfk\b|rear.?view camera|reversing camera|area view/,
  parkingSensors: /senzori (?:de )?parcare|parksensor|pdc|parking sensors|einparkhilfe sensoren/,
  cruiseControl: /tempomat|cruise control|adaptive cruise|acc\b|pilot automat/,
  heatedSeats: /scaune? (?:încălzite|incalzite)|sitzheizung|heated seats/,
  navigation: /naviga(?:tie|ție)|navigation|navi\b/,
  carplay: /carplay|android auto/,
  frontCamera: /camer[aă] 360|360.?(?:grade|°)|surround view|area view 360/,
  blindSpot: /unghi mort|blind spot|totwinkel/,
  laneAssist: /lane assist|men(?:t|ț)inere (?:pe )?banda|spurhalte|lane control/,
  ledMatrix: /matrix|led faruri|faruri led|led.?scheinwerfer|full led/,
  panoramicRoof: /panoramic|panorama|trapa/,
  towbar: /c[aâ]rlig|anh[aä]ngerkupplung|towbar/,
  // Specific compound phrases only — bare "piele"/"leather" also matches a
  // leather STEERING WHEEL or gearshifter (separate equipment entirely),
  // which isn't the same as leather seats/upholstery (confirmed live: a car
  // with fabric seats but a leather steering wheel got mistagged).
  leatherSeats: /tapi[țt]erie (?:din )?piele|piele (?:naturala|natural[aă])?[, ]*tapi[țt]erie|leather (?:seats|upholstery)|leder(?:sitz|ausstattung|polster)/,
  electricSeats: /scaune? electric|elektrische sitze|power seats/,
  heatedWheel: /volan (?:încălzit|incalzit)|lenkradheizung|heated steering|steering wheel heated/,
  keyless: /keyless|acces f[aă]r[aă] cheie|schl[uü]ssellos/,
  dualClimate: /clima(?:tronic)? (?:bi|dual|2).?zon|dual.?zone|2.zonen/,
  powerTailgate: /haion electric|elektrische heckklappe|power tailgate/,
  awd: /4motion|4x4|quattro|awd|allrad|4wd/,
  headUp: /head.?up/,
  trafficSign: /recunoa(?:s|ș)tere (?:indicatoare|semne)|verkehrszeichen|traffic sign/,
  parkAssist: /asisten(?:t|ț)[aă] (?:la )?parcare|park assist|einparkhilfe automatisch|autonomous parking/
};
function detectFeatures(text) {
  var t = String(text || '').toLowerCase();
  return Object.keys(FEATURE_PATTERNS).filter(function (k) { return FEATURE_PATTERNS[k].test(t); });
}
// Picks the brand that appears EARLIEST in the text, not the first one in
// BRANDS array order — a plain .find() would tag a BMW listing as "Audi" the
// moment "Audi" happens to appear anywhere later in a free-text description
// (a dealer's other stock, a comparison, etc). Title is checked first and
// wins over the description if both mention a brand.
function earliestBrand(t) {
  var best = null, bestIdx = Infinity;
  BRANDS.forEach(function (b) {
    var idx = t.indexOf(b.toLowerCase());
    if (idx === -1 && b === 'Volkswagen') { var m1 = /\bvw\b/.exec(t); idx = m1 ? m1.index : -1; }
    if (idx === -1 && b === 'Škoda') { var m2 = /skoda/.exec(t); idx = m2 ? m2.index : -1; }
    if (idx === -1 && b === 'Mercedes-Benz') { var m3 = /mercedes/.exec(t); idx = m3 ? m3.index : -1; }
    if (idx > -1 && idx < bestIdx) { bestIdx = idx; best = b; }
  });
  return best;
}
function detectBrand(text, title) {
  var t = String(title || '').toLowerCase();
  var full = String(text || '').toLowerCase();
  return earliestBrand(t) || earliestBrand(full) || '';
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
  modelMatches: modelMatches,
  BRANDS: BRANDS,
  extractMileage: extractMileage,
  extractHorsepower: extractHorsepower,
  extractEngineSize: extractEngineSize,
  detectAccidentStatus: detectAccidentStatus,
  detectFeatures: detectFeatures,
  detectBrand: detectBrand
};
