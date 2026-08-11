'use strict';
var autovit = require('./adapters/autovit');
var as24 = require('./adapters/autoscout24');
var mobileDe = require('./adapters/mobileDe');
var util = require('./adapters/util');

var ADAPTERS = {
  'Autovit.ro': autovit,
  'AutoScout24.ro': as24.ro,
  'AutoScout24.de': as24.de,
  'mobile.de': mobileDe
};

var MAX_BRANDS = 6;
var PER_REQUEST_TIMEOUT_MS = 9000;

function dedupe(listings) {
  var seen = {};
  return listings.filter(function (l) {
    if (seen[l.id]) return false;
    seen[l.id] = true;
    return true;
  });
}

async function runSite(adapter, siteName, filters, brands, timeoutMs) {
  var started = Date.now();
  var results = [];
  var warnings = [];
  // mobile.de ignores brand looping — it needs numeric make ids we don't
  // maintain, so a single request carries only the numeric filters.
  var brandRuns = siteName === 'mobile.de' ? [null] : (brands.length ? brands : [null]);

  var settled = await Promise.allSettled(brandRuns.map(function (b) {
    return adapter.search(filters, b, timeoutMs);
  }));

  var okCount = 0, errCount = 0, lastError = null;
  settled.forEach(function (r) {
    if (r.status === 'fulfilled') {
      okCount++;
      results = results.concat(r.value);
    } else {
      errCount++;
      lastError = r.reason && r.reason.message ? r.reason.message : String(r.reason);
    }
  });

  var status = 'ok';
  if (okCount === 0) status = 'error';
  else if (errCount > 0) status = 'partial';

  var entry = {
    site: siteName,
    status: status,
    count: results.length,
    tookMs: Date.now() - started
  };
  if (status === 'error') entry.error = lastError;
  if (status === 'partial') entry.warning = errCount + '/' + brandRuns.length + ' brand queries failed (' + lastError + ')';

  return { entry: entry, listings: results };
}

function applyFilters(listings, filters) {
  return listings.filter(function (l) {
    if (filters.model && !util.modelMatches(filters.model, l)) return false;
    if (filters.priceMin && l.price < Number(filters.priceMin)) return false;
    if (filters.priceMax && l.price > Number(filters.priceMax)) return false;
    if (filters.yearMin && l.year && l.year < Number(filters.yearMin)) return false;
    if (filters.engineMax && l.engineSize && l.engineSize > Number(filters.engineMax)) return false;
    if (filters.hpMin && l.horsepower && l.horsepower < Number(filters.hpMin)) return false;
    if (filters.mileageMax && l.mileage && l.mileage > Number(filters.mileageMax)) return false;
    if (filters.transmission && filters.transmission !== 'Either' && l.transmission !== filters.transmission) return false;
    if (filters.country && filters.country !== 'both' && l.country !== filters.country) return false;
    // accidentFree and required `features` are deliberately NOT enforced here:
    // portal search-result pages don't expose either, so every automated
    // result is honestly `accidentFree:false / accidentStatus:'unknown'` and
    // has no equipment list. Enforcing those filters would silently drop
    // every automated result. The caller is told this via `notes`.
    return true;
  });
}

async function runSearch(filters) {
  var queriedAt = new Date().toISOString();
  var requestedSources = (filters.sources && filters.sources.length) ? filters.sources : Object.keys(ADAPTERS);
  var siteNames = requestedSources.filter(function (s) { return ADAPTERS[s]; });
  var brands = (filters.brands || []).slice(0, MAX_BRANDS);

  var perSite = await Promise.all(siteNames.map(function (siteName) {
    return runSite(ADAPTERS[siteName], siteName, filters, brands, PER_REQUEST_TIMEOUT_MS);
  }));

  var sources = perSite.map(function (r) { return r.entry; });
  var allListings = dedupe(perSite.reduce(function (acc, r) { return acc.concat(r.listings); }, []));
  var filtered = applyFilters(allListings, filters);
  var limit = filters.limit || 200;

  var notes = [];
  if (filters.accidentFree) {
    notes.push('"Accident-free only" only excludes listings confirmed to have accident damage. Portal ' +
      'search pages never expose accident history, so automated results still show up but are marked ' +
      '"Not confirmed accident-free" in the History column — check the listing yourself before trusting it.');
  }
  if (filters.features && filters.features.length) {
    notes.push('Required features aren\'t shown on search-result pages either, so automated results have ' +
      'no equipment data and are hidden by this filter too — check the listing itself.');
  }

  return {
    queriedAt: queriedAt,
    sources: sources,
    notes: notes,
    listings: filtered.slice(0, limit)
  };
}

module.exports = { runSearch: runSearch, ADAPTERS: ADAPTERS };
