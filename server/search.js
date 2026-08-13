'use strict';
var autovit = require('./adapters/autovit');
var as24 = require('./adapters/autoscout24');
var mobileDe = require('./adapters/mobileDe');
var publi24 = require('./adapters/publi24');
var olx = require('./adapters/olx');
var lajumate = require('./adapters/lajumate');
var util = require('./adapters/util');

// OpenLane.eu was attempted via a headless browser (Playwright) but dropped:
// its data only exists after the site's own JS runs, which needed a real
// browser to fetch server-side — after fixing three separate Render
// deploy/runtime issues it launched successfully but returned 0 results,
// likely a cookie-consent modal blocking the real request in headless mode.
//
// OLX.ro tried three things in a row: a plain fetch (HTTP 403), a plain
// fetch with realistic browser headers (still 403), and a real headless
// Chromium instance (HTTP 405 instead — still blocked, just differently).
// That a genuine browser fingerprint got rejected too points at an
// edge/WAF-level block on Render's IP range rather than anything
// client-side-fixable, so it's back to a cheap plain fetch that fails fast
// and honestly, rather than paying for a browser launch that fails anyway.
//
// Both are deep-link-only now, same as mobile.de.
var ADAPTERS = {
  'Autovit.ro': autovit,
  'AutoScout24.ro': as24.ro,
  'AutoScout24.de': as24.de,
  'mobile.de': mobileDe,
  'publi24.ro': publi24,
  'OLX.ro': olx,
  'lajumate.ro': lajumate
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
    if ((filters.fuelTypes || []).length && filters.fuelTypes.indexOf(l.fuelType) === -1) return false;
    if (filters.country && filters.country !== 'both' && l.country !== filters.country) return false;
    // accidentFree and required `features` are deliberately NOT enforced here:
    // portal search-result pages don't expose either, so every automated
    // result is honestly `accidentFree:false / accidentStatus:'unknown'` and
    // has no equipment list. Enforcing those filters would silently drop
    // every automated result. The caller is told this via `notes`.
    return true;
  });
}

// After the list-page results are filtered down to what's actually going to
// be shown, fetch each listing's own detail page for real equipment +
// accident-history data — bounded per site (not per search) since each one
// is a full extra HTTP request, and only for adapters that support it
// (Autovit.ro, AutoScout24.ro/.de currently). Best-effort: a failed detail
// fetch just leaves that listing as accidentStatus:'unknown' like before,
// never blocks the response.
var DETAIL_ENRICH_PER_SITE = 10;
var DETAIL_TIMEOUT_MS = 7000;
async function enrichWithDetails(listings) {
  var perSiteCount = {};
  var toEnrich = listings.filter(function (l) {
    var adapter = ADAPTERS[l.sourceSite];
    if (!adapter || typeof adapter.fetchDetail !== 'function') return false;
    perSiteCount[l.sourceSite] = perSiteCount[l.sourceSite] || 0;
    if (perSiteCount[l.sourceSite] >= DETAIL_ENRICH_PER_SITE) return false;
    perSiteCount[l.sourceSite]++;
    return true;
  });
  await Promise.allSettled(toEnrich.map(function (l) {
    var adapter = ADAPTERS[l.sourceSite];
    return adapter.fetchDetail(l.url, DETAIL_TIMEOUT_MS).then(function (detail) {
      if (detail) {
        l.features = detail.features;
        l.accidentStatus = detail.accidentStatus;
        l.accidentFree = detail.accidentStatus === 'accident-free';
      }
    });
  }));
  return toEnrich.length;
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
  var limited = filtered.slice(0, limit);
  var enrichedCount = await enrichWithDetails(limited);

  var notes = [];
  if (enrichedCount > 0) {
    notes.push('Equipment and accident-history data was fetched from the listing\'s own detail page for ' +
      enrichedCount + ' result(s) (Autovit.ro, AutoScout24.ro/.de, up to ' + DETAIL_ENRICH_PER_SITE +
      ' per site) — those are real, seller-declared values. Other results still show "—" because their ' +
      'source site\'s search page doesn\'t expose that data and wasn\'t enriched this time.');
  }
  if (filters.accidentFree) {
    notes.push('"Accident-free only" only excludes listings confirmed to have accident damage. Most portal ' +
      'search pages never expose accident history, so unenriched automated results still show up but are ' +
      'marked "Not confirmed accident-free" in the History column — check the listing yourself before trusting it.');
  }
  if (filters.features && filters.features.length) {
    notes.push('Required features aren\'t shown on most search-result pages either, so unenriched automated ' +
      'results have no equipment data and are hidden by this filter too — check the listing itself.');
  }
  if (siteNames.indexOf('OLX.ro') > -1 && siteNames.indexOf('Autovit.ro') > -1) {
    notes.push('Some OLX.ro car listings are cross-posted from Autovit.ro, so the same car can appear twice ' +
      '— once from each site — since they use different listing IDs.');
  }

  return {
    queriedAt: queriedAt,
    sources: sources,
    notes: notes,
    listings: limited
  };
}

module.exports = { runSearch: runSearch, ADAPTERS: ADAPTERS };
