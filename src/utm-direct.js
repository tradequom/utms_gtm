/*! tq-utm-direct __VERSION__ */
// Adds UTM params from config.json (per site and page) to the page URL for visitors from the
// page's countries who arrived without UTM / referral / click ids.
(function (w, d) {
  'use strict';

  var NS = 'tqUtmDirect';
  var VERSION = '__VERSION__';
  // Replaced with the contents of config.json by scripts/build.mjs.
  var CONFIG = /*__CONFIG__*/ null;

  var FORCE_COUNTRY_KEY = NS + '.forceCountry'; // localStorage, for testing; also unlocks "test" pages
  var DEBUG_KEY = NS + '.debug'; // localStorage, '1' enables console logs
  var COUNTRY_CACHE_KEY = NS + '.country'; // sessionStorage
  var TRACE_URL = '/cdn-cgi/trace';
  // Optional language prefix of B2Core URLs: /en/, /pt/, /pt-br/, /es_ES/...
  var LANG_PREFIX = '^/(?:[a-z]{2}(?:[-_][a-z]{2,4})?/)?';

  if (!CONFIG) return;

  // Loaded twice (e.g. the loader ran before the first copy finished): reuse the first copy.
  if (w[NS] && typeof w[NS].run === 'function') {
    w[NS].run();
    return;
  }

  var countryPromise = null;

  function storageGet(name, key) {
    try {
      var s = w[name];
      return s ? s.getItem(key) : null;
    } catch (e) {
      return null;
    }
  }

  function storageSet(name, key, value) {
    try {
      var s = w[name];
      if (s) s.setItem(key, value);
    } catch (e) {
      /* storage blocked: ignore */
    }
  }

  function log() {
    if (storageGet('localStorage', DEBUG_KEY) !== '1' || !w.console) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[' + NS + ']');
    w.console.log.apply(w.console, args);
  }

  function toLowerList(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) out.push(String(list[i]).toLowerCase());
    return out;
  }

  /** "/funds/deposit" -> matches /funds/deposit, /en/funds/deposit, /pt-br/funds/deposit/ (any case). */
  function pathMatcher(path) {
    var p = String(path).replace(/^\/+|\/+$/g, '');
    var escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(LANG_PREFIX + escaped + '/?$', 'i');
  }

  // Per-site settings, keyed by lower-case hostname; each site has a list of pages.
  var sites = {};
  var siteNames = Object.keys(CONFIG.sites || {});
  for (var i = 0; i < siteNames.length; i++) {
    var site = CONFIG.sites[siteNames[i]] || {};
    var pages = [];
    for (var j = 0; j < (site.pages || []).length; j++) {
      var page = site.pages[j] || {};
      var countries = [];
      for (var k = 0; k < (page.countries || []).length; k++) countries.push(String(page.countries[k]).toUpperCase());
      pages.push({
        name: page.name || page.path,
        enabled: page.enabled === 'test' ? 'test' : page.enabled !== false,
        matcher: pathMatcher(page.path),
        countries: countries,
        addParams: page.addParams || {}
      });
    }
    sites[siteNames[i].toLowerCase()] = { enabled: site.enabled !== false, pages: pages };
  }

  var cfg = {
    enabled: CONFIG.enabled !== false,
    skipIfParamPrefixes: toLowerList(CONFIG.skipIfParamPrefixes),
    skipIfParams: toLowerList(CONFIG.skipIfParams),
    skipIfLocalStorageKeys: CONFIG.skipIfLocalStorageKeys || [],
    geoTimeoutMs: CONFIG.geoTimeoutMs || 2000
  };

  /**
   * Finds the page settings for a URL. Returns { page } when the params may be added
   * (country permitting), or { reason } when this URL must be left alone.
   */
  function match(href) {
    var url = new URL(href);
    var host = url.hostname.toLowerCase();

    if (!cfg.enabled) return { reason: 'disabled in config' };
    var site = Object.prototype.hasOwnProperty.call(sites, host) ? sites[host] : null;
    if (!site) return { reason: 'hostname not in config: ' + host };
    if (!site.enabled) return { reason: 'disabled for site ' + host };

    var page = null;
    for (var i = 0; i < site.pages.length; i++) {
      if (site.pages[i].matcher.test(url.pathname)) {
        page = site.pages[i];
        break;
      }
    }
    if (!page) return { reason: 'no page in config for path ' + url.pathname };
    if (!page.enabled) return { reason: 'page disabled: ' + page.name };
    if (page.enabled === 'test' && !storageGet('localStorage', FORCE_COUNTRY_KEY)) {
      return { reason: 'page in test mode: ' + page.name };
    }
    if (!page.countries.length) return { reason: 'no countries for page: ' + page.name };

    var reason = null;
    url.searchParams.forEach(function (value, key) {
      if (reason) return;
      var k = key.toLowerCase();
      if (cfg.skipIfParams.indexOf(k) !== -1) {
        reason = 'url has param ' + key;
        return;
      }
      for (var i = 0; i < cfg.skipIfParamPrefixes.length; i++) {
        if (k.indexOf(cfg.skipIfParamPrefixes[i]) === 0) {
          reason = 'url has param ' + key;
          return;
        }
      }
    });
    if (reason) return { reason: reason };

    for (var j = 0; j < cfg.skipIfLocalStorageKeys.length; j++) {
      if (storageGet('localStorage', cfg.skipIfLocalStorageKeys[j])) {
        return { reason: 'localStorage has ' + cfg.skipIfLocalStorageKeys[j] };
      }
    }
    return { page: page };
  }

  function fetchCountry() {
    return new Promise(function (resolve, reject) {
      var controller = typeof w.AbortController === 'function' ? new w.AbortController() : null;
      var timer = setTimeout(function () {
        if (controller) controller.abort();
        reject(new Error('geo timeout ' + cfg.geoTimeoutMs + 'ms'));
      }, cfg.geoTimeoutMs);

      w.fetch(TRACE_URL, { credentials: 'omit', cache: 'no-store', signal: controller ? controller.signal : undefined })
        .then(function (res) {
          if (!res.ok) throw new Error('geo http ' + res.status);
          return res.text();
        })
        .then(function (text) {
          clearTimeout(timer);
          var m = /(?:^|\n)loc=([A-Za-z0-9]{2})\s*(?:\n|$)/.exec(text);
          if (!m) throw new Error('geo: no loc in trace');
          resolve(m[1].toUpperCase());
        })
        .catch(function (err) {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  function getCountry() {
    var forced = storageGet('localStorage', FORCE_COUNTRY_KEY);
    if (forced) return Promise.resolve(String(forced).toUpperCase());

    var cached = storageGet('sessionStorage', COUNTRY_CACHE_KEY);
    if (cached) return Promise.resolve(cached);

    if (!countryPromise) {
      countryPromise = fetchCountry().then(
        function (country) {
          storageSet('sessionStorage', COUNTRY_CACHE_KEY, country);
          return country;
        },
        function (err) {
          countryPromise = null; // allow a retry on the next run()
          throw err;
        }
      );
    }
    return countryPromise;
  }

  /** Appends only the missing params, leaving the existing query string untouched. */
  function buildUrl(href, addParams) {
    var url = new URL(href);
    var search = url.search;
    var keys = Object.keys(addParams);
    for (var i = 0; i < keys.length; i++) {
      if (url.searchParams.has(keys[i])) continue;
      search += (search ? '&' : '?') + encodeURIComponent(keys[i]) + '=' + encodeURIComponent(addParams[keys[i]]);
    }
    return url.pathname + search + url.hash;
  }

  function notifyRouter() {
    // Angular has already read the URL: a popstate makes its router read it again (no reload),
    // so the app keeps the params when it later rewrites the URL itself.
    if (!d.querySelector('[ng-version]')) return false;
    var event;
    try {
      event = new w.PopStateEvent('popstate', { state: w.history.state });
    } catch (e) {
      event = d.createEvent('Event');
      event.initEvent('popstate', false, false);
    }
    w.dispatchEvent(event);
    return true;
  }

  function apply(country) {
    var m = match(w.location.href); // the URL may have changed while the country was loading
    if (m.reason) return { status: 'skipped', reason: m.reason, country: country };
    if (m.page.countries.indexOf(country) === -1) {
      return { status: 'skipped', reason: 'country not in config', country: country, page: m.page.name };
    }

    var newUrl = buildUrl(w.location.href, m.page.addParams);
    w.history.replaceState(w.history.state, '', newUrl);
    var routerNotified = notifyRouter();

    w.dataLayer = w.dataLayer || [];
    w.dataLayer.push({ event: 'utm_direct_applied', utm_direct_country: country, utm_direct_page: m.page.name });

    log('applied', { page: m.page.name, country: country, url: newUrl, routerNotified: routerNotified });
    return { status: 'applied', country: country, page: m.page.name, url: newUrl, routerNotified: routerNotified };
  }

  function run() {
    try {
      if (!w.fetch || !w.URL || !w.history || !w.history.replaceState || !w.Promise) {
        return Promise.resolve({ status: 'skipped', reason: 'browser not supported' });
      }

      var m = match(w.location.href);
      if (m.reason) {
        log('skip:', m.reason);
        return Promise.resolve({ status: 'skipped', reason: m.reason });
      }

      return getCountry().then(
        function (country) {
          try {
            var result = apply(country);
            if (result.status === 'skipped') log('skip:', result.reason, country);
            return result;
          } catch (e) {
            log('error', e);
            return { status: 'error', error: String(e) };
          }
        },
        function (err) {
          log('skip: country unknown', err);
          return { status: 'skipped', reason: 'country unknown: ' + (err && err.message) };
        }
      );
    } catch (e) {
      log('error', e);
      return Promise.resolve({ status: 'error', error: String(e) });
    }
  }

  w[NS] = { version: VERSION, config: CONFIG, run: run, ready: null };
  w[NS].ready = run();
})(window, document);
