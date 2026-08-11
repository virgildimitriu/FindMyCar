'use strict';
var util = require('./util');

var COUNTRY = 'Romania';

function buildUrl(filters, brand) {
  var p = [];
  if (filters.priceMin) p.push('search%5Bfilter_float_price%3Afrom%5D=' + encodeURIComponent(filters.priceMin));
  if (filters.priceMax) p.push('search%5Bfilter_float_price%3Ato%5D=' + encodeURIComponent(filters.priceMax));
  if (filters.yearMin) p.push('search%5Bfilter_float_year%3Afrom%5D=' + encodeURIComponent(filters.yearMin));
  if (filters.hpMin) p.push('search%5Bfilter_float_engine_power%3Afrom%5D=' + encodeURIComponent(filters.hpMin));
  if (filters.engineMax) p.push('search%5Bfilter_float_engine_capacity%3Ato%5D=' + encodeURIComponent(filters.engineMax));
  if (filters.transmission === 'Automatic') p.push('search%5Bfilter_enum_gearbox%5D=automatic');
  if (filters.transmission === 'Manual') p.push('search%5Bfilter_enum_gearbox%5D=manual');
  if (filters.model) p.push('search%5Bfilter_enum_model%5D=' + encodeURIComponent(filters.model));
  var slug = brand ? util.brandSlug(brand) : '';
  return 'https://www.autovit.ro/autoturisme' + (slug ? '/' + slug : '') +
    (p.length ? '?' + p.join('&') : '');
}

function findAdvertSearch(nextData) {
  var urql = nextData && nextData.props && nextData.props.pageProps && nextData.props.pageProps.urqlState;
  if (!urql) return null;
  var keys = Object.keys(urql);
  for (var i = 0; i < keys.length; i++) {
    var entry = urql[keys[i]];
    if (!entry || !entry.data) continue;
    var parsed;
    try { parsed = JSON.parse(entry.data); } catch (e) { continue; }
    if (parsed && parsed.advertSearch && Array.isArray(parsed.advertSearch.edges)) {
      return parsed.advertSearch;
    }
  }
  return null;
}

function paramValue(params, key) {
  var p = (params || []).find(function (x) { return x.key === key; });
  return p ? p.value : null;
}

function normalise(node) {
  var price = util.toEurPrice(node.price && node.price.amount ? node.price.amount.units : 0,
    node.price && node.price.amount ? node.price.amount.currencyCode : 'EUR');
  var params = node.parameters || [];
  var transmission = util.detectTransmission(node.title) || 'Automatic';
  return {
    id: 'autovit:' + node.id,
    title: node.title || '',
    brand: paramValue(params, 'make') ? capitalise(paramValue(params, 'make')) : '',
    model: paramValue(params, 'model') ? capitalise(paramValue(params, 'model')) : '',
    trim: '',
    year: parseInt(paramValue(params, 'year'), 10) || 0,
    price: price.price,
    currencyOriginal: price.currencyOriginal,
    priceOriginal: price.priceOriginal,
    mileage: parseInt(paramValue(params, 'mileage'), 10) || 0,
    engineSize: parseInt(paramValue(params, 'engine_capacity'), 10) || 0,
    horsepower: parseInt(paramValue(params, 'engine_power'), 10) || 0,
    transmission: transmission,
    fuelType: mapFuel(paramValue(params, 'fuel_type')),
    features: [],
    accidentStatus: 'unknown',
    accidentFree: false,
    sourceSite: 'Autovit.ro',
    url: node.url || '',
    country: COUNTRY,
    sellerType: node.seller && node.seller.__typename === 'PrivateSeller' ? 'private' : 'dealer',
    imageUrl: node.thumbnail ? (node.thumbnail.x2 || node.thumbnail.x1) : null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
}

function capitalise(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function mapFuel(v) {
  var t = String(v || '').toLowerCase();
  if (t.indexOf('petrol') > -1 || t.indexOf('benz') > -1) return 'Petrol';
  if (t.indexOf('diesel') > -1) return 'Diesel';
  if (t.indexOf('hybrid') > -1) return 'Hybrid';
  if (t.indexOf('electric') > -1) return 'Electric';
  return 'Petrol';
}

async function search(filters, brand, timeoutMs) {
  var url = buildUrl(filters, brand);
  var html = await util.fetchHtml(url, timeoutMs);
  var nextData = util.extractJsonScript(html, '__NEXT_DATA__');
  if (!nextData) throw new Error('selector_miss: __NEXT_DATA__ not found');
  var advertSearch = findAdvertSearch(nextData);
  if (!advertSearch) return [];
  return advertSearch.edges.map(function (e) { return normalise(e.node); }).filter(function (l) { return l.id; });
}

module.exports = { site: 'Autovit.ro', search: search, buildUrl: buildUrl };
