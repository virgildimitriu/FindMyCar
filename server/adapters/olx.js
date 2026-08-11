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

// OLX rejects a plain fetch() — HTTP 403 within ~200ms even with a full
// realistic browser header set, which looks like an edge/WAF-level block
// rather than a fingerprint check. A real headless browser is the next thing
// to try: it still runs on this same server/IP, so it won't help if the
// block is purely IP-based, but it will if OLX is instead keying off the
// absence of real JS execution / TLS fingerprint. Reuses the working
// Playwright config from the (abandoned) OpenLane adapter — channel
// pinned, browsers installed into node_modules via PLAYWRIGHT_BROWSERS_PATH.
var chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = null; }

async function fetchHtmlViaBrowser(url, timeoutMs) {
  if (!chromium) throw new Error('playwright_missing: headless browser not installed');
  var browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    // Deliberately not overriding userAgent — Chromium's own default is more
    // internally consistent (matches its real TLS/JS fingerprint) than a
    // hand-crafted one would be.
    var page = await browser.newPage({ locale: 'ro-RO' });
    var res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs || 20000 });
    if (!res || !res.ok()) {
      var err = new Error('HTTP ' + (res ? res.status() : 'no_response'));
      throw err;
    }
    await page.waitForSelector('[data-cy="l-card"]', { timeout: 8000 }).catch(function () {});
    return await page.content();
  } finally {
    await browser.close();
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
  var html = await fetchHtmlViaBrowser(url, timeoutMs);
  var cards = extractCards(html);
  if (!cards.length) throw new Error('selector_miss: no l-card blocks found');
  return cards.map(normalise).filter(function (l) { return l && l.url && l.title; });
}

module.exports = { site: 'OLX.ro', search: search, buildUrl: buildUrl, heavy: true };
