'use strict';
var searchService = require('./search');
var email = require('./email');

// Matches the frontend's default filters (index.html defaultFilters()) so
// the daily digest reflects the same "reasonable starting point" search.
// Override with DIGEST_FILTERS_JSON (a full filters object as JSON) as a
// Render env var if you want the digest to search something else.
function defaultDigestFilters() {
  var raw = process.env.DIGEST_FILTERS_JSON;
  if (raw) {
    try { return JSON.parse(raw); } catch (e) { /* fall through to default below */ }
  }
  return {
    brands: ['Volkswagen', 'Škoda', 'Kia'],
    model: '',
    priceMin: 14000,
    priceMax: 20000,
    yearMin: 2023,
    engineMax: 2000,
    hpMin: 150,
    mileageMax: '',
    transmission: 'Automatic',
    fuelTypes: [],
    features: [],
    country: 'both',
    accidentFree: true,
    sources: [],
    limit: 200
  };
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function fmtEur(n) { return '€' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
function fmtKm(n) { return n ? Number(n).toLocaleString('en-US') + ' km' : '—'; }

function listingRowHtml(l) {
  return '<tr style="border-bottom:1px solid #eee">' +
    '<td style="padding:8px 10px">' +
      '<a href="' + l.url + '" style="color:#2f9e5b;text-decoration:none;font-weight:600">' + escapeHtml(l.title) + '</a><br>' +
      '<span style="color:#888;font-size:12px">' + escapeHtml(l.sourceSite) + ' · ' + escapeHtml(l.country) + '</span>' +
    '</td>' +
    '<td style="padding:8px 10px;font-family:monospace;white-space:nowrap">' + fmtEur(l.price) + '</td>' +
    '<td style="padding:8px 10px">' + (l.year || '—') + '</td>' +
    '<td style="padding:8px 10px;font-family:monospace;white-space:nowrap">' + fmtKm(l.mileage) + '</td>' +
    '<td style="padding:8px 10px;white-space:nowrap">' + (l.horsepower || '—') + ' hp</td>' +
    '<td style="padding:8px 10px">' + escapeHtml(l.transmission) + '</td>' +
  '</tr>';
}

// Shared by the daily cron digest and the on-demand "email these results"
// endpoint the app's Search page can trigger — same look either way.
function renderListingsEmailHtml(listings, opts) {
  opts = opts || {};
  var limit = opts.limit || 50;
  var top = listings.slice(0, limit);

  var body = top.length
    ? ('<table style="width:100%;border-collapse:collapse;font-size:13px">' +
        '<thead><tr style="text-align:left;border-bottom:2px solid #ddd">' +
          '<th style="padding:8px 10px">Listing</th><th style="padding:8px 10px">Price</th>' +
          '<th style="padding:8px 10px">Year</th><th style="padding:8px 10px">Mileage</th>' +
          '<th style="padding:8px 10px">Power</th><th style="padding:8px 10px">Gearbox</th>' +
        '</tr></thead><tbody>' + top.map(listingRowHtml).join('') + '</tbody></table>')
    : '<p style="color:#666">No listings.</p>';

  return '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;color:#222">' +
    '<h2 style="margin:0 0 4px">' + escapeHtml(opts.heading || 'Find My Car') + '</h2>' +
    '<p style="color:#666;font-size:13px;margin:0 0 16px">' + escapeHtml(opts.summaryLine || (listings.length + ' listings')) + '</p>' +
    body +
    '<p style="color:#999;font-size:11px;margin-top:16px;line-height:1.5">' +
      'Portal search pages don\'t expose accident history or equipment, so neither is verified here — ' +
      'check each listing yourself before trusting it.' +
      (listings.length > limit ? (' Showing ' + limit + ' of ' + listings.length + ' listings, sorted as given.') : '') +
    '</p>' +
  '</div>';
}

async function runDailyDigest() {
  var to = process.env.DIGEST_TO_EMAIL;
  if (!to) throw new Error('DIGEST_TO_EMAIL not set');
  var filters = defaultDigestFilters();
  var result = await searchService.runSearch(filters);
  var matched = result.listings.slice().sort(function (a, b) { return a.price - b.price; });

  var sourcesLine = result.sources.map(function (s) {
    return s.site + ': ' + (s.status === 'error' ? 'failed' : s.count);
  }).join(' · ');
  var html = renderListingsEmailHtml(matched, {
    heading: 'Find My Car — daily digest',
    summaryLine: new Date().toISOString().slice(0, 10) + ' · ' + matched.length + ' matches · ' + sourcesLine,
    limit: 30
  });
  await email.sendEmail({
    to: to,
    subject: 'Find My Car — ' + matched.length + ' match' + (matched.length === 1 ? '' : 'es') + ' today',
    html: html
  });
  return { matchCount: matched.length, sources: result.sources };
}

module.exports = {
  runDailyDigest: runDailyDigest,
  defaultDigestFilters: defaultDigestFilters,
  renderListingsEmailHtml: renderListingsEmailHtml
};
