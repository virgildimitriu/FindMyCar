'use strict';
var util = require('./util');

function buildUrl(host, filters, brand) {
  var p = [];
  if (filters.priceMin) p.push('pricefrom=' + encodeURIComponent(filters.priceMin));
  if (filters.priceMax) p.push('priceto=' + encodeURIComponent(filters.priceMax));
  if (filters.yearMin) p.push('fregfrom=' + encodeURIComponent(filters.yearMin));
  if (filters.hpMin) p.push('powerfrom=' + encodeURIComponent(filters.hpMin), 'powertype=hp');
  if (filters.mileageMax) p.push('kmto=' + encodeURIComponent(filters.mileageMax));
  if (filters.transmission === 'Automatic') p.push('gear=A');
  if (filters.transmission === 'Manual') p.push('gear=M');
  p.push('sort=price', 'desc=0');
  var slug = brand ? util.brandSlug(brand) : '';
  var modelBase = filters.model ? util.modelBase(filters.model) : '';
  var path = slug ? '/lst/' + slug + (modelBase ? '/' + encodeURIComponent(modelBase) : '') : '/lst';
  return 'https://' + host + path + '?' + p.join('&');
}

function mapCountry(code) {
  return code === 'DE' ? 'Germany' : (code === 'RO' ? 'Romania' : (code || ''));
}

function extractHorsepower(vehicleDetails) {
  var e = (vehicleDetails || []).find(function (d) { return d.iconName === 'speedometer'; });
  if (!e) return 0;
  var m = /\b(\d+)\s*(?:cp|ps|hp)/i.exec(e.data || '');
  if (m) return parseInt(m[1], 10);
  var kw = /\b(\d+)\s*kw/i.exec(e.data || '');
  if (kw) return Math.round(parseInt(kw[1], 10) * 1.36);
  return 0;
}

function normalise(l, siteName, host) {
  var v = l.vehicle || {};
  var reg = l.tracking && l.tracking.firstRegistration; // "MM-YYYY"
  var year = 0;
  if (reg && /^\d{2}-\d{4}$/.test(reg)) year = parseInt(reg.split('-')[1], 10);
  var title = [v.make, v.model, v.variant].filter(Boolean).join(' ');
  var url = l.url ? ('https://' + host + (l.url.charAt(0) === '/' ? l.url : '/' + l.url)) : '';
  return {
    id: 'as24:' + (l.id || l.crossReferenceId),
    title: title,
    brand: v.make || '',
    model: v.modelGroup || v.model || '',
    trim: v.variant || '',
    year: year,
    price: l.price ? Number(l.price.priceRaw) || 0 : 0,
    currencyOriginal: 'EUR',
    priceOriginal: l.price ? Number(l.price.priceRaw) || 0 : 0,
    mileage: l.tracking ? util.digits(l.tracking.mileage) : util.digits(v.mileageInKm),
    engineSize: util.digits(v.engineDisplacementInCCM),
    horsepower: extractHorsepower(l.vehicleDetails),
    transmission: util.detectTransmission(v.transmission) || 'Automatic',
    // title carries the variant/trim badge (GTE, 330e, "Recharge", etc.),
    // which is often the only signal that a "hybrid" is actually plug-in —
    // v.fuel alone is just a short tag like "Elektro/Benzin".
    fuelType: util.detectFuel(title + ' ' + (v.fuel || '')),
    features: [],
    // AS24's `isCurrentlyDamaged` flag means "not currently reported damaged",
    // not "verified accident-free history" — the spec requires we never assume
    // accident-free from list data, so this is intentionally left unknown.
    accidentStatus: 'unknown',
    accidentFree: false,
    sourceSite: siteName,
    url: url,
    country: l.location ? mapCountry(l.location.countryCode) : '',
    sellerType: l.seller && l.seller.type === 'Private' ? 'private' : 'dealer',
    imageUrl: (l.images && l.images[0]) || null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
}

async function search(host, siteName, filters, brand, timeoutMs) {
  var url = buildUrl(host, filters, brand);
  var html = await util.fetchHtml(url, timeoutMs);
  var nextData = util.extractJsonScript(html, '__NEXT_DATA__');
  if (!nextData) throw new Error('selector_miss: __NEXT_DATA__ not found');
  var listings = nextData.props && nextData.props.pageProps && nextData.props.pageProps.listings;
  if (!Array.isArray(listings)) return [];
  return listings.map(function (l) { return normalise(l, siteName, host); }).filter(function (l) { return l.id; });
}

module.exports = {
  ro: { site: 'AutoScout24.ro', search: function (filters, brand, t) { return search('www.autoscout24.ro', 'AutoScout24.ro', filters, brand, t); }, buildUrl: function (f, b) { return buildUrl('www.autoscout24.ro', f, b); } },
  de: { site: 'AutoScout24.de', search: function (filters, brand, t) { return search('www.autoscout24.de', 'AutoScout24.de', filters, brand, t); }, buildUrl: function (f, b) { return buildUrl('www.autoscout24.de', f, b); } }
};
