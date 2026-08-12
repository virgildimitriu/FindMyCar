'use strict';
var http = require('http');
var url = require('url');
var searchService = require('./search');
var digest = require('./digest');
var email = require('./email');

var PORT = process.env.PORT || 8787;

function withCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', function () {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

var server = http.createServer(function (req, res) {
  withCors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    return sendJson(res, 200, { ok: true, sites: Object.keys(searchService.ADAPTERS) });
  }

  if (req.method === 'POST' && req.url === '/api/search') {
    readBody(req).then(function (filters) {
      return searchService.runSearch(filters || {});
    }).then(function (result) {
      sendJson(res, 200, result);
    }).catch(function (err) {
      sendJson(res, 400, { error: err.message || 'search failed' });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/send-email') {
    // On-demand "email these results" from the app itself — same shared
    // secret as the digest trigger, since this also sends a real email to
    // an address the CALLER chooses and the API has no other auth.
    readBody(req).then(function (body) {
      var secret = process.env.DIGEST_TRIGGER_SECRET;
      if (!secret || body.secret !== secret) {
        var authErr = new Error('missing or invalid secret'); authErr.status = 401; throw authErr;
      }
      var to = String(body.to || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        var toErr = new Error('invalid "to" address'); toErr.status = 400; throw toErr;
      }
      var listings = Array.isArray(body.listings) ? body.listings.slice(0, 200) : [];
      var html = digest.renderListingsEmailHtml(listings, {
        heading: body.heading || 'Find My Car — your search',
        summaryLine: body.summaryLine || (listings.length + ' listings'),
        limit: 50
      });
      return email.sendEmail({
        to: to,
        subject: body.subject || (listings.length + ' cars from Find My Car'),
        html: html
      });
    }).then(function () {
      sendJson(res, 200, { ok: true });
    }).catch(function (err) {
      sendJson(res, err.status || 400, { error: err.message || 'send failed' });
    });
    return;
  }

  var parsed = url.parse(req.url, true);
  if (req.method === 'GET' && parsed.pathname === '/api/digest/run-now') {
    // Manual trigger for testing the daily digest without waiting for the
    // schedule. Gated behind a shared secret — this endpoint sends a real
    // email on every call, and the API otherwise has no auth at all.
    var secret = process.env.DIGEST_TRIGGER_SECRET;
    if (!secret || parsed.query.secret !== secret) {
      return sendJson(res, 401, { error: 'missing or invalid secret' });
    }
    digest.runDailyDigest().then(function (r) {
      sendJson(res, 200, { ok: true, result: r });
    }).catch(function (err) {
      sendJson(res, 500, { error: err.message || 'digest failed' });
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, function () {
  console.log('Find My Car search API listening on :' + PORT);
});

// --- Daily digest scheduler ---
// No node-cron dependency — just a setTimeout to the next occurrence of the
// configured UTC hour/minute, then a 24h interval after that. Only runs if
// both DIGEST_TO_EMAIL and RESEND_API_KEY are set, so it's a no-op unless
// explicitly configured.
function msUntilNextUtc(hourUtc, minuteUtc) {
  var now = new Date();
  var next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, minuteUtc, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

if (process.env.DIGEST_TO_EMAIL && process.env.RESEND_API_KEY) {
  var hourUtc = process.env.DIGEST_HOUR_UTC != null ? parseInt(process.env.DIGEST_HOUR_UTC, 10) : 5;
  var minuteUtc = process.env.DIGEST_MINUTE_UTC != null ? parseInt(process.env.DIGEST_MINUTE_UTC, 10) : 0;
  var runAndReschedule = function () {
    digest.runDailyDigest()
      .then(function (r) { console.log('daily digest sent: ' + r.matchCount + ' matches'); })
      .catch(function (e) { console.error('daily digest failed: ' + e.message); });
    setTimeout(runAndReschedule, 24 * 60 * 60 * 1000);
  };
  setTimeout(runAndReschedule, msUntilNextUtc(hourUtc, minuteUtc));
  console.log('Daily digest scheduled for ' + hourUtc + ':' + (minuteUtc < 10 ? '0' : '') + minuteUtc + ' UTC');
} else {
  console.log('Daily digest disabled (set DIGEST_TO_EMAIL and RESEND_API_KEY to enable)');
}
