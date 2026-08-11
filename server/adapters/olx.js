'use strict';
var util = require('./util');

// OLX.ro has no embedded JSON like Autovit/AutoScout24/publi24 — listings are
// server-rendered as plain HTML cards keyed by data-cy="l-card" /
// data-testid="card-title-link"/"ad-price". More fragile than the other
// adapters (per the handoff spec's own warning: selectors change without
// notice) since it depends on exact markup rather than a data payload.
// Some OLX car listings are cross-posted from Autovit.ro (same corporate
// group) — their href points straight at autovit.ro, so a car can show up
// twice (once via each adapter) since the two use different id namespaces.

function buildUrl(filters, brand) {
  var slug = brand ? util.brandSlug(brand) : '';
  return 'https://www.olx.ro/auto-masini-moto-ambarcatiuni/autoturisme/' + (slug ? slug + '/' : '');
}

// OLX blocks this adapter no matter what's asked of it — HTTP 403 to a
// plain fetch (even with a full realistic browser header set), and HTTP 405
// to an actual headless Chromium instance with a real JS/TLS fingerprint.
// Both fail fast-ish and consistently, which points at an edge/WAF block on
// Render's IP range rather than anything about the request itself — no
// client-side fix reaches that. Left as a plain fetch (cheap, fails in
// ~200-400ms) rather than paying for a browser launch that fails anyway;
// same honest-failure treatment as mobile.de.
async function fetchHtmlBrowserLike(url, timeoutMs) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 10000);
  try {
    var res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ro-RO,ro;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
        'Upgrade-Insecure-Requests': '1'
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

function extractCards(html) {
  var starts = [];
  var re = /<div data-cy="l-card"[^>]*\sid="(\d+)"/g;
  var m;
  while ((m = re.exec(html))) starts.push({ id: m[1], idx: m.index });
  var cards = [];
  for (var i = 0; i < starts.length; i++) {
    var end = (i + 1 < starts.length) ? starts[i + 1].idx : Math.min(html.length, starts[i].idx + 12000);
    cards.push({ id: starts[i].id, html: html.slice(starts[i].idx, end) });
  }
  return cards;
}

// Only the anchor's OPENING tag is used — its rendered inner content nests a
// <style data-emotion=...> tag before the visible text, which breaks a naive
// "text up to the next <" match. The real title lives in aria-label instead.
function extractAnchor(html, testid) {
  var re = new RegExp('<a\\s+[^>]*data-testid="' + testid + '"[^>]*>');
  var m = re.exec(html);
  if (!m) return null;
  var tag = m[0];
  var hrefM = /href="([^"]*)"/.exec(tag);
  var ariaM = /aria-label="([^"]*)"/.exec(tag);
  var href = hrefM ? hrefM[1] : '';
  if (href && href.indexOf('http') !== 0) href = 'https://www.olx.ro' + href;
  return { text: ariaM ? ariaM[1] : '', href: href };
}

function extractText(html, testid) {
  var re = new RegExp('data-testid="' + testid + '"[^>]*>([^<]*)<');
  var m = re.exec(html);
  return m ? m[1].trim() : '';
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractPrice(priceText) {
  var amount = util.digits(priceText);
  var t = priceText.toLowerCase();
  return util.toEurPrice(amount, (t.indexOf('lei') > -1 || t.indexOf('ron') > -1) ? 'RON' : 'EUR');
}

function normalise(card) {
  var anchor = extractAnchor(card.html, 'card-title-link');
  if (!anchor || !anchor.href) return null;
  var priceText = extractText(card.html, 'ad-price');
  var price = extractPrice(priceText);
  var plain = stripTags(card.html);
  // "Reactualizat la <date>" (last-refreshed date) contains a real 4-digit
  // year too and sits right after the title/price block — cut it off before
  // hunting for the car's year, or a listing with no year in its title picks
  // up this year instead.
  var refreshIdx = plain.toLowerCase().indexOf('reactualizat');
  var yearSearchText = refreshIdx > -1 ? plain.slice(0, refreshIdx) : plain;
  var yearMatch = (anchor.text + ' ' + yearSearchText).match(/\b(19[89]\d|20[0-4]\d)\b/);
  var text = anchor.text + ' ' + plain;
  var accidentStatus = util.detectAccidentStatus(text);
  return {
    id: 'olx:' + card.id,
    title: anchor.text,
    brand: util.detectBrand(text, anchor.text),
    model: '',
    trim: '',
    year: yearMatch ? parseInt(yearMatch[1], 10) : 0,
    price: price.price,
    currencyOriginal: price.currencyOriginal,
    priceOriginal: price.priceOriginal,
    mileage: util.extractMileage(plain),
    engineSize: util.extractEngineSize(text),
    horsepower: util.extractHorsepower(text),
    transmission: util.detectTransmission(text) || 'Automatic',
    fuelType: util.detectFuel(text),
    features: [],
    accidentStatus: accidentStatus,
    accidentFree: accidentStatus === 'accident-free',
    sourceSite: 'OLX.ro',
    url: anchor.href,
    country: 'Romania',
    sellerType: 'private',
    imageUrl: null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
}

async function search(filters, brand, timeoutMs) {
  var url = buildUrl(filters, brand);
  var html = await fetchHtmlBrowserLike(url, timeoutMs);
  var cards = extractCards(html);
  if (!cards.length) throw new Error('selector_miss: no l-card blocks found');
  return cards.map(normalise).filter(function (l) { return l && l.url && l.title; });
}

module.exports = { site: 'OLX.ro', search: search, buildUrl: buildUrl };
