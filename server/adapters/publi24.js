'use strict';
var util = require('./util');

// publi24.ro's own brand-slug taxonomy doesn't match brand names 1:1
// (Volkswagen listings live under /vw/, not /volkswagen/).
var BRAND_SLUG_OVERRIDES = { 'Volkswagen': 'vw' };
function brandSlug(b) {
  return BRAND_SLUG_OVERRIDES[b] || util.brandSlug(b);
}

function buildUrl(filters, brand) {
  var slug = brand ? brandSlug(brand) : '';
  return 'https://www.publi24.ro/anunturi/auto-moto/masini-second-hand/' + (slug ? slug + '/' : '');
}

// publi24 doesn't escape literal control characters (including newlines)
// inside the free-text description field, which JSON forbids unescaped
// inside a string — breaks JSON.parse otherwise.
var CONTROL_CHARS_RE = new RegExp('[\\u0000-\\u001F]', 'g');
function sanitizeJson(text) {
  return text.replace(CONTROL_CHARS_RE, ' ');
}

function extractListItems(html) {
  var re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  var m, out = [];
  while ((m = re.exec(html))) {
    var data;
    try { data = JSON.parse(sanitizeJson(m[1])); } catch (e) { continue; }
    if (data && data['@type'] === 'ItemList' && Array.isArray(data.itemListElement)) {
      out = out.concat(data.itemListElement);
    }
  }
  return out;
}

function normalise(item) {
  var name = String(item.name || '').trim();
  var desc = item.description || '';
  var text = name + ' ' + desc;
  var offers = item.offers || {};
  var price = Number(offers.price) || 0;
  var year = parseInt(item.vehicleModelDate, 10) || 0;
  var engineSize = (item.vehicleEngine && item.vehicleEngine.engineDisplacement)
    ? (parseInt(item.vehicleEngine.engineDisplacement.value, 10) || 0)
    : util.extractEngineSize(text);
  var url = item.url || '';
  if (url && url.indexOf('http') !== 0) url = 'https://www.publi24.ro/' + url.replace(/^\//, '');
  var accidentStatus = util.detectAccidentStatus(text);
  return {
    id: 'publi24:' + url,
    title: name,
    brand: util.detectBrand(text, name),
    model: '',
    trim: '',
    year: year,
    price: price,
    currencyOriginal: offers.priceCurrency || 'EUR',
    priceOriginal: price,
    mileage: util.extractMileage(text),
    engineSize: engineSize,
    horsepower: util.extractHorsepower(text),
    transmission: util.detectTransmission(text) || 'Automatic',
    fuelType: util.detectFuel((item.fuelType || '') + ' ' + text),
    features: [],
    accidentStatus: accidentStatus,
    accidentFree: accidentStatus === 'accident-free',
    sourceSite: 'publi24.ro',
    url: url,
    country: 'Romania',
    sellerType: 'private',
    imageUrl: (item.image && item.image[0] && item.image[0].contentUrl) || null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
}

async function search(filters, brand, timeoutMs) {
  var url = buildUrl(filters, brand);
  var html = await util.fetchHtml(url, timeoutMs);
  var items = extractListItems(html);
  return items.map(normalise).filter(function (l) { return l.url && l.title; });
}

module.exports = { site: 'publi24.ro', search: search, buildUrl: buildUrl };
