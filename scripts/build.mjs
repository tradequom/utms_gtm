#!/usr/bin/env node
// Validates config.json and builds dist/utm-direct.js with the config inlined.
// Usage: node scripts/build.mjs
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const KNOWN_KEYS = ['enabled', 'sites', 'skipIfParamPrefixes', 'skipIfParams', 'skipIfLocalStorageKeys', 'geoTimeoutMs'];
const SITE_KEYS = ['enabled', 'pages'];
const PAGE_KEYS = ['name', 'path', 'enabled', 'countries', 'addParams'];
// Keys of older formats and where they live now.
const MOVED_TOP_KEYS = { countries: 'pages', addParams: 'pages', hostnames: 'sites', pathRegex: 'pages ("path")' };
const MOVED_SITE_KEYS = { countries: 'pages', addParams: 'pages', path: 'pages' };

// A path that starts with a language code ("/en/…", "/pt-br/…"): the script adds the language itself.
const LANG_SEGMENT = /^\/(en|ru|es|pt|de|fr|it|ar|zh|ja|ko|tr|vi|th|id|ms|pl|uk|fa|hi|cs|nl|he|el|ro|hu|sv|bn|ur)([-_][a-z]{2,4})?(\/|$)/i;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function checkStringList(errors, config, key, { allowEmpty = true } = {}) {
  const v = config[key];
  if (!Array.isArray(v)) {
    errors.push(`"${key}" должен быть списком строк, например ["a", "b"]`);
    return;
  }
  if (!allowEmpty && v.length === 0) errors.push(`"${key}" не может быть пустым`);
  v.forEach((item, i) => {
    if (!isNonEmptyString(item)) errors.push(`"${key}"[${i}] должен быть непустой строкой`);
  });
}

function checkKeys(errors, at, obj, known, moved) {
  for (const key of Object.keys(obj)) {
    if (known.includes(key)) continue;
    if (moved && key in moved) errors.push(`${at}: ключ "${key}" теперь задаётся внутри ${moved[key]} (см. README)`);
    else errors.push(`${at}: неизвестный ключ "${key}" (опечатка?). Допустимые: ${known.join(', ')}`);
  }
  for (const key of known) {
    if (!(key in obj)) errors.push(`${at}: не хватает ключа "${key}"`);
  }
}

/** Normalised page path used for duplicate detection: "/Funds/Deposit/" -> "funds/deposit". */
const normPath = (p) => String(p).replace(/^\/+|\/+$/g, '').toLowerCase();

function validatePage(errors, at, page) {
  if (!isPlainObject(page)) {
    errors.push(`${at} должен быть объектом { "name": …, "path": …, "enabled": …, "countries": […], "addParams": {…} }`);
    return;
  }
  checkKeys(errors, at, page, PAGE_KEYS);

  if ('name' in page && !isNonEmptyString(page.name)) errors.push(`${at}."name" должен быть непустой строкой, например "Депозит"`);

  if ('path' in page) {
    const p = page.path;
    if (!isNonEmptyString(p) || !p.startsWith('/')) {
      errors.push(`${at}."path" должен начинаться со слеша, например "/funds/deposit"`);
    } else if (/[?#\s*]/.test(p) || /^https?:/i.test(p)) {
      errors.push(`${at}."path" = ${JSON.stringify(p)}: нужен только путь без домена, параметров (?…) и пробелов, например "/funds/deposit"`);
    } else if (LANG_SEGMENT.test(p)) {
      errors.push(`${at}."path" = ${JSON.stringify(p)}: путь пишется без языка — "/funds/deposit", а не "/en/funds/deposit"; язык подставляется автоматически`);
    }
  }

  if ('enabled' in page && page.enabled !== true && page.enabled !== false && page.enabled !== 'test') {
    errors.push(`${at}."enabled" должен быть true, false или "test"`);
  }

  if ('countries' in page) {
    if (!Array.isArray(page.countries)) {
      errors.push(`${at}."countries" должен быть списком кодов стран, например ["ZA", "BR"] (или [] — ни одной)`);
    } else {
      const seen = new Set();
      page.countries.forEach((c, i) => {
        if (typeof c !== 'string' || !/^[A-Z]{2}$/.test(c)) {
          errors.push(`${at}."countries"[${i}] = ${JSON.stringify(c)}: нужен двухбуквенный код ISO 3166-1 заглавными буквами, например "ZA"`);
        } else if (seen.has(c)) {
          errors.push(`${at}."countries": код ${c} указан дважды`);
        } else {
          seen.add(c);
        }
      });
    }
  }

  if ('addParams' in page) {
    const p = page.addParams;
    if (!isPlainObject(p) || Object.keys(p).length === 0) {
      errors.push(`${at}."addParams" должен быть непустым объектом, например { "utm_source": "direct" }`);
    } else {
      for (const [k, v] of Object.entries(p)) {
        if (!isNonEmptyString(k)) errors.push(`${at}."addParams": пустое имя параметра`);
        if (!isNonEmptyString(v)) errors.push(`${at}."addParams"."${k}" должен быть непустой строкой`);
      }
    }
  }
}

function validateSite(errors, host, site) {
  const at = `"sites"."${host}"`;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    errors.push(`${at}: нужен домен строчными буквами без https:// и слешей, например "my.tradequo.com"`);
  }
  if (!isPlainObject(site)) {
    errors.push(`${at} должен быть объектом { "enabled": …, "pages": [ … ] }`);
    return;
  }
  checkKeys(errors, at, site, SITE_KEYS, MOVED_SITE_KEYS);

  if ('enabled' in site && typeof site.enabled !== 'boolean') {
    errors.push(`${at}."enabled" должен быть true или false (без кавычек)`);
  }

  if ('pages' in site) {
    if (!Array.isArray(site.pages) || site.pages.length === 0) {
      errors.push(`${at}."pages" должен быть непустым списком страниц [ { … }, { … } ]. Чтобы выключить сайт, поставьте "enabled": false`);
    } else {
      const seen = new Map();
      site.pages.forEach((page, i) => {
        const pat = `${at}."pages"[${i}]${isPlainObject(page) && isNonEmptyString(page.name) ? ` («${page.name}»)` : ''}`;
        validatePage(errors, pat, page);
        if (isPlainObject(page) && isNonEmptyString(page.path)) {
          const key = normPath(page.path);
          if (seen.has(key)) errors.push(`${pat}: путь ${page.path} уже указан в странице №${seen.get(key) + 1}`);
          else seen.set(key, i);
        }
      });
    }
  }
}

/** Returns a list of human-readable errors (in Russian); empty when the config is valid. */
export function validateConfig(config) {
  const errors = [];
  if (!isPlainObject(config)) {
    return ['config.json должен быть объектом { ... }'];
  }

  checkKeys(errors, 'config.json', config, KNOWN_KEYS, MOVED_TOP_KEYS);

  if ('enabled' in config && typeof config.enabled !== 'boolean') {
    errors.push('"enabled" должен быть true или false (без кавычек)');
  }

  if ('sites' in config) {
    if (!isPlainObject(config.sites) || Object.keys(config.sites).length === 0) {
      errors.push('"sites" должен быть непустым объектом: { "my.tradequo.com": { … }, … }');
    } else {
      for (const [host, site] of Object.entries(config.sites)) validateSite(errors, host, site);
    }
  }

  if ('skipIfParamPrefixes' in config) checkStringList(errors, config, 'skipIfParamPrefixes');
  if ('skipIfParams' in config) checkStringList(errors, config, 'skipIfParams');
  if ('skipIfLocalStorageKeys' in config) checkStringList(errors, config, 'skipIfLocalStorageKeys');

  if ('geoTimeoutMs' in config) {
    const t = config.geoTimeoutMs;
    if (!Number.isInteger(t) || t < 100 || t > 10000) errors.push('"geoTimeoutMs" должен быть целым числом от 100 до 10000');
  }

  // Every added param must itself trigger a skip, otherwise each run (e.g. on every SPA navigation)
  // would fire again.
  if (errors.length === 0) {
    const params = config.skipIfParams.map((s) => s.toLowerCase());
    const prefixes = config.skipIfParamPrefixes.map((s) => s.toLowerCase());
    for (const [host, site] of Object.entries(config.sites)) {
      site.pages.forEach((page, i) => {
        for (const key of Object.keys(page.addParams)) {
          const k = key.toLowerCase();
          if (!params.includes(k) && !prefixes.some((pre) => k.startsWith(pre))) {
            errors.push(`"sites"."${host}"."pages"[${i}] («${page.name}»): параметр "${key}" из "addParams" должен попадать под "skipIfParams" или "skipIfParamPrefixes", иначе скрипт будет срабатывать повторно`);
          }
        }
      });
    }
  }

  return errors;
}

export function buildScript(source, config, version) {
  const placeholder = '/*__CONFIG__*/ null';
  if (!source.includes(placeholder)) throw new Error(`в src/utm-direct.js не найден плейсхолдер ${placeholder}`);
  return source
    .replace(placeholder, () => JSON.stringify(config))
    .replace(/__VERSION__/g, () => version);
}

function detectVersion() {
  const date = new Date().toISOString().slice(0, 10);
  let sha = (process.env.GITHUB_SHA || '').slice(0, 7);
  if (!sha) {
    try {
      sha = execSync('git rev-parse --short=7 HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      sha = 'local';
    }
  }
  return `${date}.${sha}`;
}

function main() {
  const configPath = join(ROOT, 'config.json');
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`❌ config.json не читается как JSON: ${e.message}`);
    console.error('   Проверьте запятые, кавычки и скобки (например, на https://jsonlint.com).');
    process.exit(1);
  }

  const errors = validateConfig(config);
  if (errors.length) {
    console.error('❌ Ошибки в config.json — сборка остановлена, на сайте осталась прежняя версия:');
    for (const e of errors) console.error(`   • ${e}`);
    process.exit(1);
  }

  const version = detectVersion();
  const source = readFileSync(join(ROOT, 'src', 'utm-direct.js'), 'utf8');
  const script = buildScript(source, config, version);

  const dist = join(ROOT, 'dist');
  // Only the script is published: no listing page and no config.json copy.
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'utm-direct.js'), script);

  // The CI log of a public repository is public: report the version only, not the settings.
  console.log(`✅ Собрано dist/utm-direct.js, версия ${version}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
