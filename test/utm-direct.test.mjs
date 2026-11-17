import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildScript, validateConfig } from '../scripts/build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(join(ROOT, 'src', 'utm-direct.js'), 'utf8');
const CONFIG = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

// Behaviour tests use their own fixed config, so editing config.json on GitHub (new countries,
// pages, another utm value) never breaks them. config.json itself is checked in «валидация config.json».
const TQ = 'my.tradequo.com';
const QUO = 'my.quomarkets.com';
const SIGNUP = 0; // page indexes in TEST_CONFIG
const DEPOSIT = 1;
const TEST_CONFIG = {
  enabled: true,
  sites: {
    [TQ]: {
      enabled: true,
      pages: [
        { name: 'Регистрация', path: '/auth/sign-up', enabled: true, countries: ['ZA', 'BR', 'PH', 'AU'], addParams: { utm_source: 'direct' } },
        { name: 'Депозит', path: '/funds/deposit', enabled: true, countries: ['BR'], addParams: { utm_source: 'dep' } },
      ],
    },
    [QUO]: {
      enabled: true,
      pages: [
        { name: 'Регистрация', path: '/auth/sign-up', enabled: true, countries: ['PH'], addParams: { utm_source: 'quo_site' } },
        { name: 'Депозит', path: '/funds/deposit', enabled: 'test', countries: ['ZA'], addParams: { utm_source: 'quo_dep' } },
      ],
    },
  },
  skipIfParamPrefixes: ['utm_'],
  skipIfParams: [
    'referral', 'ref', 'reg', 'regnew', 'new',
    'gclid', 'gbraid', 'wbraid', 'dclid', 'fbclid', 'msclkid',
    'ttclid', 'twclid', 'li_fat_id', 'yclid', 'tradingview_uid', 'roistat_visit',
  ],
  skipIfLocalStorageKeys: ['IB_CLICK_TOKEN', 'REFERRAL_QUERY_PARAM_NAME'],
  geoTimeoutMs: 2000,
};

const clone = (v) => JSON.parse(JSON.stringify(v));

/** A copy of a config with one site's settings patched. */
const withSite = (host, patch, base = TEST_CONFIG) => {
  const c = clone(base);
  c.sites[host] = { ...c.sites[host], ...patch };
  return c;
};

/** A copy of a config with one page's settings patched. */
const withPage = (host, index, patch, base = TEST_CONFIG) => {
  const c = clone(base);
  c.sites[host].pages[index] = { ...c.sites[host].pages[index], ...patch };
  return c;
};

/** The query string the script appends for addParams, e.g. 'utm_source=direct'. */
const addedQuery = (addParams) =>
  Object.entries(addParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
const Q = addedQuery(TEST_CONFIG.sites[TQ].pages[SIGNUP].addParams);

const SIGN_UP = `https://${TQ}/en/auth/sign-up`;
const QUO_SIGN_UP = `https://${QUO}/en/auth/sign-up`;
const DEPOSIT_QUERY = '?currencyId=73118&transactionCurrencyAlpha=USDT&methodId=161';
const TQ_DEPOSIT = `https://${TQ}/en/funds/deposit${DEPOSIT_QUERY}`;
const QUO_DEPOSIT = `https://${QUO}/en/funds/deposit${DEPOSIT_QUERY}`;

function makeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  };
}

/**
 * Loads the built script into a fake browser and returns the environment.
 * trace: { country, status, delayMs, body } describes the /cdn-cgi/trace response.
 */
function load({
  href = SIGN_UP,
  config = TEST_CONFIG,
  trace = {},
  ngBooted = false,
  local = {},
  session = {},
  onFetch,
} = {}) {
  const calls = { fetch: [], replaceState: [], dispatched: [] };
  const location = { href };
  const history = {
    state: { navigationId: 1 },
    replaceState(state, _title, url) {
      calls.replaceState.push(url);
      this.state = state;
      location.href = new URL(url, location.href).href;
    },
  };
  const window = {
    location,
    history,
    URL,
    Promise,
    AbortController,
    console,
    localStorage: makeStorage(local),
    sessionStorage: makeStorage(session),
    PopStateEvent: class {
      constructor(type, init) {
        this.type = type;
        this.state = init && init.state;
      }
    },
    dispatchEvent(e) {
      calls.dispatched.push(e);
      return true;
    },
    fetch(url, opts) {
      calls.fetch.push(url);
      if (onFetch) onFetch(window);
      const { country = 'ZA', status = 200, delayMs = 0, body } = trace;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => body ?? `fl=1f\nh=my.tradequo.com\nip=1.2.3.4\nloc=${country}\ntls=TLSv1.3\n`,
          });
        }, delayMs);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
    },
  };
  const document = {
    querySelector: (sel) => (sel === '[ng-version]' && ngBooted ? {} : null),
    createEvent: () => ({ initEvent() {} }),
  };
  const script = buildScript(SOURCE, config, 'test');
  const context = vm.createContext({ window, document, URL, setTimeout, clearTimeout });
  vm.runInContext(script, context);
  return { window, document, calls, location, script, context };
}

const urlOf = (env) => env.location.href;

async function assertUntouched(env, reasonPattern) {
  const res = await env.window.tqUtmDirect.ready;
  assert.equal(res.status, 'skipped', JSON.stringify(res));
  if (reasonPattern) assert.match(res.reason, reasonPattern);
  assert.equal(env.calls.replaceState.length, 0);
  assert.equal(env.calls.dispatched.length, 0);
  assert.equal(env.window.dataLayer, undefined);
}

describe('добавляет метку', () => {
  test('посетитель из ZA без меток: utm_source=direct, без popstate до загрузки Angular', async () => {
    const env = load();
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'applied');
    assert.equal(res.page, 'Регистрация');
    assert.equal(urlOf(env), `${SIGN_UP}?${Q}`);
    assert.deepEqual(env.calls.fetch, ['/cdn-cgi/trace']);
    assert.equal(env.calls.dispatched.length, 0);
    assert.deepEqual(clone(env.window.dataLayer), [
      { event: 'utm_direct_applied', utm_direct_country: 'ZA', utm_direct_page: 'Регистрация' },
    ]);
    assert.equal(env.window.sessionStorage.getItem('tqUtmDirect.country'), 'ZA');
  });

  for (const country of TEST_CONFIG.sites[TQ].pages[SIGNUP].countries) {
    test(`страна ${country} из списка страницы`, async () => {
      const env = load({ trace: { country } });
      assert.equal((await env.window.tqUtmDirect.ready).status, 'applied');
      assert.equal(urlOf(env), `${SIGN_UP}?${Q}`);
    });
  }

  test('Angular уже загружен: отправляет popstate с текущим history.state', async () => {
    const env = load({ ngBooted: true });
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.routerNotified, true);
    assert.equal(env.calls.dispatched.length, 1);
    assert.equal(env.calls.dispatched[0].type, 'popstate');
    assert.deepEqual(env.calls.dispatched[0].state, { navigationId: 1 });
  });

  test('сохраняет остальные параметры (без перекодирования) и hash', async () => {
    const env = load({ href: `${SIGN_UP}?wizard_id=5&x=a%20b+c#frag` });
    await env.window.tqUtmDirect.ready;
    assert.equal(urlOf(env), `${SIGN_UP}?wizard_id=5&x=a%20b+c&${Q}#frag`);
    assert.deepEqual(env.calls.replaceState, [`/en/auth/sign-up?wizard_id=5&x=a%20b+c&${Q}#frag`]);
  });

  for (const path of ['/pt/auth/sign-up', '/pt-br/auth/sign-up', '/es_ES/auth/sign-up', '/auth/sign-up', '/en/auth/sign-up/', '/EN/AUTH/SIGN-UP']) {
    test(`подходящий путь ${path}`, async () => {
      const env = load({ href: `https://${TQ}${path}` });
      assert.equal((await env.window.tqUtmDirect.ready).status, 'applied');
    });
  }

  test('несколько параметров в addParams', async () => {
    const config = withPage(TQ, SIGNUP, { addParams: { utm_source: 'direct', utm_medium: 'none' } });
    const env = load({ config });
    await env.window.tqUtmDirect.ready;
    assert.equal(urlOf(env), `${SIGN_UP}?utm_source=direct&utm_medium=none`);
  });

  test('страна из кэша sessionStorage: без запроса trace', async () => {
    const env = load({ session: { 'tqUtmDirect.country': 'BR' } });
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'applied');
    assert.equal(res.country, 'BR');
    assert.equal(env.calls.fetch.length, 0);
  });

  test('принудительная страна для тестов (localStorage tqUtmDirect.forceCountry)', async () => {
    const env = load({ local: { 'tqUtmDirect.forceCountry': 'ph' }, trace: { country: 'US' } });
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'applied');
    assert.equal(res.country, 'PH');
    assert.equal(env.calls.fetch.length, 0);
  });
});

describe('ничего не меняет', () => {
  for (const q of ['utm_source=google', 'utm_medium=cpc', 'UTM_Campaign=x', 'utm_id=1', 'utm_custom=1']) {
    test(`есть ${q}`, async () => {
      const env = load({ href: `${SIGN_UP}?${q}` });
      await assertUntouched(env, /url has param/);
      assert.equal(env.calls.fetch.length, 0);
    });
  }

  for (const p of TEST_CONFIG.skipIfParams) {
    test(`есть ${p}`, async () => {
      const env = load({ href: `${SIGN_UP}?foo=1&${p}=ABC` });
      await assertUntouched(env, /url has param/);
    });
  }

  test('пустое значение referral тоже считается', async () => {
    await assertUntouched(load({ href: `${SIGN_UP}?referral=` }), /url has param/);
  });

  for (const key of TEST_CONFIG.skipIfLocalStorageKeys) {
    test(`партнёр из прошлого визита: localStorage ${key}`, async () => {
      await assertUntouched(load({ local: { [key]: 'PARTNER1' } }), /localStorage/);
    });
  }

  for (const href of [
    `https://${TQ}/en/auth/sign-in`,
    `https://${TQ}/en/auth/sign-up/0199-uuid/123456`,
    `https://${TQ}/en/dashboard`,
    `https://${TQ}/en/funds/withdraw`,
    `https://${TQ}/en/funds/deposit/history`,
    'https://tradequo.com/en/auth/sign-up',
    'https://my.tradequo.com.evil.com/en/auth/sign-up',
  ]) {
    test(`другая страница ${href}`, async () => {
      const env = load({ href });
      await assertUntouched(env);
      assert.equal(env.calls.fetch.length, 0);
    });
  }

  test('страна не из списка', async () => {
    await assertUntouched(load({ trace: { country: 'US' } }), /country not in config/);
  });

  test('trace вернул ошибку', async () => {
    await assertUntouched(load({ trace: { status: 500 } }), /country unknown/);
  });

  test('в trace нет loc', async () => {
    await assertUntouched(load({ trace: { body: 'fl=1\nh=x\n' } }), /country unknown/);
  });

  test('trace не ответил за geoTimeoutMs', async () => {
    const env = load({ config: { ...TEST_CONFIG, geoTimeoutMs: 50 }, trace: { delayMs: 500 } });
    await assertUntouched(env, /timeout/);
  });

  test('enabled: false', async () => {
    const env = load({ config: { ...TEST_CONFIG, enabled: false } });
    await assertUntouched(env, /disabled/);
    assert.equal(env.calls.fetch.length, 0);
  });

  test('URL изменился, пока определялась страна (ушёл на sign-in)', async () => {
    const env = load({
      trace: { delayMs: 20 },
      onFetch: (w) => {
        w.location.href = `https://${TQ}/en/auth/sign-in`;
      },
    });
    await assertUntouched(env, /no page in config/);
  });

  test('ошибка trace не кэшируется: следующий run() пробует снова', async () => {
    const env = load({ trace: { status: 500 } });
    await env.window.tqUtmDirect.ready;
    await env.window.tqUtmDirect.run();
    assert.equal(env.calls.fetch.length, 2);
    assert.equal(env.window.sessionStorage.getItem('tqUtmDirect.country'), null);
  });
});

describe('страницы', () => {
  test('депозит: свои страны и своя метка, параметры депозита сохраняются', async () => {
    const env = load({ href: TQ_DEPOSIT, trace: { country: 'BR' }, ngBooted: true });
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'applied');
    assert.equal(res.page, 'Депозит');
    assert.equal(urlOf(env), `${TQ_DEPOSIT}&utm_source=dep`);
    assert.equal(env.calls.dispatched.length, 1, 'роутер портала должен узнать о новом URL');
    assert.equal(clone(env.window.dataLayer)[0].utm_direct_page, 'Депозит');
  });

  test('депозит: страна из списка регистрации, но не депозита — не трогаем', async () => {
    await assertUntouched(load({ href: TQ_DEPOSIT, trace: { country: 'ZA' } }), /country not in config/);
  });

  test('регистрация: страна из списка депозита, но не регистрации — не трогаем', async () => {
    const config = withPage(TQ, SIGNUP, { countries: ['ZA'] });
    await assertUntouched(load({ config, trace: { country: 'BR' } }), /country not in config/);
  });

  for (const path of ['/funds/deposit', '/pt/funds/deposit', '/en/funds/deposit/', '/EN/FUNDS/DEPOSIT']) {
    test(`депозит: подходящий путь ${path}`, async () => {
      const env = load({ href: `https://${TQ}${path}`, trace: { country: 'BR' } });
      assert.equal((await env.window.tqUtmDirect.ready).status, 'applied');
    });
  }

  test('путь со спецсимволами сравнивается буквально', async () => {
    const config = withPage(TQ, DEPOSIT, { path: '/funds/de.osit' });
    await assertUntouched(load({ config, href: `https://${TQ}/en/funds/deposit`, trace: { country: 'BR' } }), /no page in config/);
  });

  test('страница без стран: ничего не делает и не запрашивает страну', async () => {
    const env = load({ href: TQ_DEPOSIT, config: withPage(TQ, DEPOSIT, { countries: [] }) });
    await assertUntouched(env, /no countries for page: Депозит/);
    assert.equal(env.calls.fetch.length, 0);
  });

  test('страница выключена: ничего не делает, другая страница работает', async () => {
    const config = withPage(TQ, DEPOSIT, { enabled: false });
    const dep = load({ href: TQ_DEPOSIT, config, trace: { country: 'BR' } });
    await assertUntouched(dep, /page disabled: Депозит/);
    assert.equal(dep.calls.fetch.length, 0);

    const signup = load({ config, trace: { country: 'BR' } });
    assert.equal((await signup.window.tqUtmDirect.ready).status, 'applied');
  });

  test('тестовый режим: обычный посетитель — ничего, даже страну не определяем', async () => {
    const env = load({ href: QUO_DEPOSIT, trace: { country: 'ZA' } });
    await assertUntouched(env, /page in test mode: Депозит/);
    assert.equal(env.calls.fetch.length, 0);
  });

  test('тестовый режим: тестировщик с forceCountry из списка — работает', async () => {
    const env = load({ href: QUO_DEPOSIT, local: { 'tqUtmDirect.forceCountry': 'ZA' }, ngBooted: true });
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'applied');
    assert.equal(urlOf(env), `${QUO_DEPOSIT}&utm_source=quo_dep`);
  });

  test('тестовый режим: тестировщик с forceCountry не из списка — ничего', async () => {
    await assertUntouched(load({ href: QUO_DEPOSIT, local: { 'tqUtmDirect.forceCountry': 'US' } }), /country not in config/);
  });

  test('повторный run() на депозите после того, как портал сам переписал URL с меткой — ничего', async () => {
    const env = load({ href: TQ_DEPOSIT, trace: { country: 'BR' }, ngBooted: true });
    await env.window.tqUtmDirect.ready;
    // B2Core merges its own query params into the current URL (queryParamsHandling: "merge").
    env.location.href = `https://${TQ}/en/funds/deposit?currencyId=1&utm_source=dep&methodId=2`;
    const res = await env.window.tqUtmDirect.run();
    assert.equal(res.status, 'skipped');
    assert.equal(env.calls.replaceState.length, 1);
  });
});

describe('несколько сайтов', () => {
  test('у второго сайта свои параметры', async () => {
    const env = load({ href: QUO_SIGN_UP, trace: { country: 'PH' } });
    const res = await env.window.tqUtmDirect.ready;
    assert.equal(res.status, 'applied');
    assert.equal(urlOf(env), `${QUO_SIGN_UP}?utm_source=quo_site`);
  });

  test('у второго сайта свой список стран: ZA есть у tradequo, но не у quomarkets', async () => {
    await assertUntouched(load({ href: QUO_SIGN_UP, trace: { country: 'ZA' } }), /country not in config/);
    const tq = load({ href: SIGN_UP, trace: { country: 'ZA' } });
    assert.equal((await tq.window.tqUtmDirect.ready).status, 'applied');
  });

  test('сайт выключен: ничего не делает, другой сайт работает', async () => {
    const config = withSite(QUO, { enabled: false });
    const quo = load({ href: QUO_SIGN_UP, config, trace: { country: 'PH' } });
    await assertUntouched(quo, /disabled for site/);
    assert.equal(quo.calls.fetch.length, 0);

    const tq = load({ href: SIGN_UP, config, trace: { country: 'PH' } });
    assert.equal((await tq.window.tqUtmDirect.ready).status, 'applied');
  });

  test('сайта нет в config: ничего не делает', async () => {
    const env = load({ href: 'https://my.othersite.com/en/auth/sign-up' });
    await assertUntouched(env, /hostname not in config/);
    assert.equal(env.calls.fetch.length, 0);
  });
});

describe('повторные вызовы', () => {
  test('повторный run() после применения ничего не делает', async () => {
    const env = load({ ngBooted: true });
    await env.window.tqUtmDirect.ready;
    const res = await env.window.tqUtmDirect.run();
    assert.equal(res.status, 'skipped');
    assert.equal(env.calls.replaceState.length, 1);
    assert.equal(env.calls.dispatched.length, 1);
    assert.equal(env.window.dataLayer.length, 1);
  });

  test('одновременные run() делают один запрос trace', async () => {
    const env = load({ trace: { delayMs: 20 } });
    const second = env.window.tqUtmDirect.run();
    const [a, b] = await Promise.all([env.window.tqUtmDirect.ready, second]);
    assert.equal(env.calls.fetch.length, 1);
    assert.deepEqual([a.status, b.status].sort(), ['applied', 'skipped']);
    assert.equal(env.calls.replaceState.length, 1);
  });

  test('скрипт загружен дважды: второй экземпляр не переопределяет первый', async () => {
    const env = load({ href: `https://${TQ}/en/auth/sign-in` });
    const first = env.window.tqUtmDirect;
    vm.runInContext(env.script, env.context);
    assert.equal(env.window.tqUtmDirect, first);
  });

  test('SPA-переход sign-in → sign-up и повторный run() из GTM History Change', async () => {
    const env = load({ href: `https://${TQ}/en/auth/sign-in`, ngBooted: true });
    assert.equal((await env.window.tqUtmDirect.ready).status, 'skipped');
    env.location.href = SIGN_UP;
    const res = await env.window.tqUtmDirect.run();
    assert.equal(res.status, 'applied');
    assert.equal(urlOf(env), `${SIGN_UP}?${Q}`);
    assert.equal(env.calls.dispatched.length, 1);
  });

  test('SPA-переход dashboard → депозит (History Change) ставит метку депозита', async () => {
    const env = load({ href: `https://${TQ}/en/dashboard`, ngBooted: true, trace: { country: 'BR' } });
    assert.equal((await env.window.tqUtmDirect.ready).status, 'skipped');
    env.location.href = TQ_DEPOSIT;
    const res = await env.window.tqUtmDirect.run();
    assert.equal(res.status, 'applied');
    assert.equal(urlOf(env), `${TQ_DEPOSIT}&utm_source=dep`);
  });
});

describe('валидация config.json', () => {
  test('config.json из репозитория валиден', () => {
    assert.deepEqual(validateConfig(CONFIG), []);
  });

  // The real config.json: for each site and page, the built script must do what the config says.
  for (const [host, site] of Object.entries(CONFIG.sites || {})) {
    for (const page of site.pages || []) {
      test(`собранный из config.json скрипт: ${host} «${page.name}»`, async () => {
        const href = `https://${host}/en${page.path}`;
        const env = load({ href, config: CONFIG, trace: { country: page.countries[0] || 'ZA' } });
        const res = await env.window.tqUtmDirect.ready;
        assert.notEqual(res.status, 'error', JSON.stringify(res));
        assert.deepEqual(clone(env.window.tqUtmDirect.config), CONFIG);
        // The first page with this path wins; config validation forbids duplicate paths.
        const shouldApply = CONFIG.enabled && site.enabled && page.enabled === true && page.countries.length > 0;
        if (shouldApply) {
          assert.equal(res.status, 'applied', JSON.stringify(res));
          assert.equal(urlOf(env), `${href}?${addedQuery(page.addParams)}`);
        } else {
          assert.equal(res.status, 'skipped', JSON.stringify(res));
          assert.equal(urlOf(env), href);
        }
      });
    }
  }

  test('тестовый конфиг валиден', () => {
    assert.deepEqual(validateConfig(TEST_CONFIG), []);
  });

  const bad = [
    ['код страны строчными', withPage(TQ, SIGNUP, { countries: ['za'] }), /countries/],
    ['трёхбуквенный код', withPage(TQ, SIGNUP, { countries: ['ZAF'] }), /countries/],
    ['повтор страны', withPage(TQ, SIGNUP, { countries: ['ZA', 'ZA'] }), /дважды/],
    ['countries не список', withPage(TQ, SIGNUP, { countries: 'ZA' }), /countries/],
    ['опечатка в ключе', { ...TEST_CONFIG, sitess: {} }, /неизвестный ключ "sitess"/],
    ['опечатка в ключе страницы', withPage(TQ, SIGNUP, { countrys: ['ZA'] }), /неизвестный ключ "countrys"/],
    ['enabled строкой', { ...TEST_CONFIG, enabled: 'true' }, /enabled/],
    ['enabled сайта строкой', withSite(QUO, { enabled: 'false' }), /enabled/],
    ['enabled страницы — неизвестное слово', withPage(TQ, DEPOSIT, { enabled: 'yes' }), /true, false или "test"/],
    ['пустой addParams', withPage(TQ, SIGNUP, { addParams: {} }), /addParams/],
    ['пустое значение в addParams', withPage(TQ, SIGNUP, { addParams: { utm_source: '' } }), /addParams/],
    ['addParams не попадает под skip', withPage(QUO, SIGNUP, { addParams: { source: 'direct' } }), /срабатывать повторно/],
    ['пустой sites', { ...TEST_CONFIG, sites: {} }, /"sites"/],
    ['пустой pages', withSite(TQ, { pages: [] }), /"pages" должен быть непустым/],
    ['домен с https://', { ...TEST_CONFIG, sites: { 'https://my.tradequo.com': TEST_CONFIG.sites[TQ] } }, /домен/],
    ['домен со слешем', { ...TEST_CONFIG, sites: { 'my.tradequo.com/': TEST_CONFIG.sites[TQ] } }, /домен/],
    ['путь без слеша', withPage(TQ, DEPOSIT, { path: 'funds/deposit' }), /начинаться со слеша/],
    ['путь с параметрами', withPage(TQ, DEPOSIT, { path: '/funds/deposit?currencyId=1' }), /без домена, параметров/],
    ['путь с доменом', withPage(TQ, DEPOSIT, { path: 'https://my.tradequo.com/funds/deposit' }), /слеша|без домена/],
    ['путь с языком', withPage(TQ, DEPOSIT, { path: '/en/funds/deposit' }), /без языка/],
    ['одинаковые пути', withPage(TQ, DEPOSIT, { path: '/Auth/Sign-Up/' }), /уже указан/],
    ['страница без name', withPage(TQ, DEPOSIT, { name: '' }), /"name"/],
    ['старый формат: страны на уровне сайта', withSite(TQ, { countries: ['ZA'] }), /теперь задаётся внутри pages/],
    ['старый формат: pathRegex наверху', { ...TEST_CONFIG, pathRegex: '^/auth' }, /теперь задаётся внутри pages/],
    ['geoTimeoutMs вне диапазона', { ...TEST_CONFIG, geoTimeoutMs: 50000 }, /geoTimeoutMs/],
  ];
  for (const [name, config, pattern] of bad) {
    test(name, () => {
      const errors = validateConfig(config);
      assert.ok(errors.some((e) => pattern.test(e)), errors.join('\n') || 'нет ошибок');
    });
  }

  test('пустой список стран у страницы допустим', () => {
    assert.deepEqual(validateConfig(withPage(QUO, SIGNUP, { countries: [] })), []);
  });

  test('путь, похожий на язык, но не язык (/ib/…), допустим', () => {
    assert.deepEqual(validateConfig(withPage(TQ, DEPOSIT, { path: '/ib/dashboard' })), []);
  });

  test('не хватает ключа', () => {
    const { geoTimeoutMs, ...rest } = TEST_CONFIG;
    assert.ok(validateConfig(rest).some((e) => /geoTimeoutMs/.test(e)));
  });

  test('buildScript вшивает конфиг и версию', () => {
    const out = buildScript(SOURCE, TEST_CONFIG, '2026-01-01.abc1234');
    assert.ok(!out.includes('__CONFIG__'));
    assert.ok(!out.includes('__VERSION__'));
    assert.ok(out.includes('"countries":["ZA","BR","PH","AU"]'));
    assert.ok(out.includes('2026-01-01.abc1234'));
  });
});
