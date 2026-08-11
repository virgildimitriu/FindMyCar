'use strict';
var http = require('http');
var searchService = require('./search');

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

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, function () {
  console.log('Find My Car search API listening on :' + PORT);
});
