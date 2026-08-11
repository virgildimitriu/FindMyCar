'use strict';
var util = require('./util');

// mobile.de sits behind bot-detection that a plain HTTP fetch cannot pass
// (confirmed by hand: a bare request gets served a JS challenge page, not
// results). We deliberately do not attempt to defeat that — this adapter
// exists so the health/status contract stays honest ("mobile.de: blocked")
// instead of silently returning nothing. See resources/search-service-spec.md §6.

function buildUrl(filters) {
  var p = ['isSearchRequest=true', 'scopeId=C'];
  if (filters.priceMin) p.push('minPrice=' + encodeURIComponent(filters.priceMin));
  if (filters.priceMax) p.push('maxPrice=' + encodeURIComponent(filters.priceMax));
  if (filters.yearMin) p.push('minFirstRegistrationDate=' + encodeURIComponent(filters.yearMin) + '-01-01');
  if (filters.hpMin) p.push('minPowerAsArray=HP', 'minPower=' + encodeURIComponent(filters.hpMin));
  if (filters.mileageMax) p.push('maxMileage=' + encodeURIComponent(filters.mileageMax));
  if (filters.transmission === 'Automatic') p.push('transmissions=AUTOMATIC_GEAR');
  if (filters.transmission === 'Manual') p.push('transmissions=MANUAL_GEAR');
  return 'https://suchen.mobile.de/fahrzeuge/search.html?' + p.join('&');
}

async function search(filters, brand, timeoutMs) {
  var url = buildUrl(filters);
  var html = await util.fetchHtml(url, timeoutMs);
  if (/window\.__?px|Verifying you are human|Powered and protected by/i.test(html)) {
    throw new Error('bot_protection: mobile.de blocked this request');
  }
  var nextData = util.extractJsonScript(html, '__NEXT_DATA__');
  if (!nextData) throw new Error('selector_miss: unrecognised page (likely bot protection)');
  return [];
}

module.exports = { site: 'mobile.de', search: search, buildUrl: buildUrl };
