'use strict';
var util = require('./util');

// lajumate.ro embeds full structured listing data in __NEXT_DATA__
// (props.pageProps.adsServer), same category as Autovit/AutoScout24 — no
// CSS scraping needed. Horsepower and transmission aren't structured fields
// here though (only year/fuel/body/brand/model/km/engine_size are), so
// those are mined from the title text like the paste-import parser does.
// No accident-history field either — 'condition' only means used vs new.

function buildUrl(filters, brand) {
  var slug = brand ? util.brandSlug(brand) : '';
  return 'https://lajumate.ro/anunturi/auto-moto-si-ambarcatiuni/autoturisme' + (slug ? '/' + slug : '');
}

function fieldValue(fields, name) {
  var f = (fields || []).find(function (x) { return x.name === name; });
  return f ? f.value : null;
}

function normalise(ad) {
  var fields = ad.ad_fields || [];
  var title = ad.title || '';
  var text = title + ' ' + (ad.description || '');
  var accidentStatus = util.detectAccidentStatus(text);
  var brandField = fieldValue(fields, 'auto_brand');
  var price = Math.round(Number(ad.price) || 0);
  var priceInfo = util.toEurPrice(price, (ad.currency || 'eur').toUpperCase());
  return {
    id: 'lajumate:' + ad.id,
    title: title.trim(),
    brand: brandField || util.detectBrand(text, title),
    model: fieldValue(fields, 'auto_model') || '',
    trim: '',
    year: parseInt(fieldValue(fields, 'year'), 10) || 0,
    price: priceInfo.price,
    currencyOriginal: priceInfo.currencyOriginal,
    priceOriginal: priceInfo.priceOriginal,
    mileage: parseInt(fieldValue(fields, 'km'), 10) || 0,
    engineSize: parseInt(fieldValue(fields, 'engine_size'), 10) || util.extractEngineSize(text),
    horsepower: util.extractHorsepower(text),
    transmission: util.detectTransmission(text) || 'Automatic',
    fuelType: util.detectFuel((fieldValue(fields, 'fuel') || '') + ' ' + text),
    features: [],
    accidentStatus: accidentStatus,
    accidentFree: accidentStatus === 'accident-free',
    sourceSite: 'lajumate.ro',
    url: ad.slug ? ('https://lajumate.ro/ad/' + ad.slug + '-' + ad.id) : '',
    country: 'Romania',
    sellerType: 'private',
    imageUrl: ad.mainImage ? ('https://api-preprod.lajumate.ro/opt-image/' + ad.mainImage.path) : null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
}

async function search(filters, brand, timeoutMs) {
  var url = buildUrl(filters, brand);
  var html = await util.fetchHtml(url, timeoutMs);
  var nextData = util.extractJsonScript(html, '__NEXT_DATA__');
  if (!nextData) throw new Error('selector_miss: __NEXT_DATA__ not found');
  var ads = nextData.props && nextData.props.pageProps && nextData.props.pageProps.adsServer;
  if (!Array.isArray(ads)) return [];
  return ads.map(normalise).filter(function (l) { return l.url && l.title; });
}

module.exports = { site: 'lajumate.ro', search: search, buildUrl: buildUrl };
