'use strict';
var util = require('./util');

// OpenLane's actual listing data only appears after its own JavaScript runs
// and calls its internal /findcarv6/search endpoint — unlike the other
// adapters, there's no server-rendered HTML or embedded JSON to fetch
// directly, and the endpoint's request schema isn't public (guessed several
// plausible payloads by hand; none worked). So this adapter uses a real
// headless browser and reads the JSON response the SITE'S OWN page receives,
// rather than trying to call the endpoint itself. Heavier and slower than
// the other adapters — expect noticeably longer searches and higher memory
// use on the host.
//
// OpenLane is a B2B wholesale auction platform, not a consumer marketplace:
// most listings are "estimated price" auctions requiring a trade account to
// bid. Only "Buy Now" listings (IsBuyNow + a real BuyNowPrice) are included
// here, since those are the only ones with an actual fixed purchase price
// comparable to a normal listing.
var chromium;
try { chromium = require('playwright').chromium; } catch (e) { chromium = null; }

var COUNTRY_NAMES = {
  de: 'Germany', ro: 'Romania', fr: 'France', it: 'Italy', es: 'Spain',
  nl: 'Netherlands', be: 'Belgium', pl: 'Poland', at: 'Austria', pt: 'Portugal',
  hu: 'Hungary', cz: 'Czechia', sk: 'Slovakia', hr: 'Croatia', si: 'Slovenia',
  lu: 'Luxembourg', dk: 'Denmark', se: 'Sweden', fi: 'Finland'
};

function buildUrl(filters, brand) {
  return 'https://www.openlane.eu/en/findcar' + (brand ? '?makesModels=' + encodeURIComponent(brand) : '');
}

function mapFuel(v) {
  var t = String(v || '').toLowerCase();
  if (t.indexOf('diesel') > -1) return 'Diesel';
  if (t.indexOf('petrol') > -1 || t.indexOf('gasoline') > -1) return 'Petrol';
  if (t.indexOf('hybrid') > -1) return 'Hybrid';
  if (t.indexOf('electric') > -1) return 'Electric';
  return 'Petrol';
}

function normalise(a) {
  var ci = a.CarIdentification || {};
  var year = 0;
  if (a.DateFirstRegistration) {
    var d = new Date(a.DateFirstRegistration);
    if (!isNaN(d.getTime())) year = d.getFullYear();
  }
  var countryCode = String(a.CarCountryExtended || '').toLowerCase();
  return {
    id: 'openlane:' + (a.AuctionId || a.CarId),
    title: a.CarNameEn || '',
    brand: ci.Make || '',
    model: ci.Model || ci.ModelDisplay || '',
    trim: ci.TrimLine || '',
    year: year,
    price: Number(a.BuyNowPrice) || 0,
    currencyOriginal: 'EUR',
    priceOriginal: Number(a.BuyNowPrice) || 0,
    mileage: Number(a.Mileage) || 0,
    engineSize: Number(a.CylinderCapacity) || 0,
    horsepower: Number(a.Hp) || 0,
    transmission: ci.GearboxGroup === 'Manual' ? 'Manual' : 'Automatic',
    fuelType: mapFuel(ci.FuelGroup),
    features: [],
    // HasTechnicalDamage/IsBroken are explicit negative signals OpenLane does
    // provide — worth using — but their absence still isn't a confirmed
    // accident-free claim, so this never sets accidentFree:true.
    accidentStatus: (a.HasTechnicalDamage || a.IsBroken) ? 'repaired damage' : 'unknown',
    accidentFree: false,
    sourceSite: 'OpenLane.eu',
    url: 'https://www.openlane.eu/en/car/info?auctionId=' + a.AuctionId,
    country: COUNTRY_NAMES[countryCode] || (a.CarCountryExtended || ''),
    sellerType: 'dealer',
    imageUrl: a.ThumbnailUrl || null,
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString()
  };
}

async function search(filters, brand, timeoutMs) {
  if (!chromium) throw new Error('playwright_missing: headless browser not installed');
  var url = buildUrl(filters, brand);
  var browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    var page = await browser.newPage({ userAgent: util.USER_AGENT });
    var captured = null;
    page.on('response', function (res) {
      if (!captured && res.url().indexOf('findcarv6/search') > -1) {
        res.json().then(function (json) { captured = json; }).catch(function () {});
      }
    });
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs || 25000 });
    await page.waitForTimeout(600);
    await page.close();
    if (!captured || !Array.isArray(captured.Auctions)) return [];
    return captured.Auctions
      .filter(function (a) { return a.IsBuyNow && Number(a.BuyNowPrice) > 0; })
      .map(normalise)
      .filter(function (l) { return l.id; });
  } finally {
    await browser.close();
  }
}

module.exports = { site: 'OpenLane.eu', search: search, buildUrl: buildUrl, heavy: true };
