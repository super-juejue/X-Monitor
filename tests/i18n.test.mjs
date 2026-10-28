/**
 * Translations.
 *
 * Chrome picks a bundle from its UI language, so a missing key in one language
 * silently falls back to English, or worse to the raw key on screen. These
 * tests keep the bundles in step with the code and with each other.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setLocale, formatBig, relativeTime } from '../src/lib/time.js';
import { bundleLocale, t, uiLocale } from '../src/lib/i18n.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const bundle = (locale) => JSON.parse(read(`_locales/${locale}/messages.json`));

const en = bundle('en');
const zh = bundle('zh_CN');
const locales = { en, zh_CN: zh };

test('every language bundle defines the same keys', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('every message is non-empty and declares the values it substitutes', () => {
  for (const [locale, messages] of Object.entries(locales)) {
    for (const [key, entry] of Object.entries(messages)) {
      assert.ok(entry.message.trim(), `${locale}/${key} is empty`);
      const used = [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)]
        .map((m) => m[1].toLowerCase())
        .sort();
      const declared = Object.keys(entry.placeholders || {})
        .map((name) => name.toLowerCase())
        .sort();
      assert.deepEqual(used, declared, `${locale}/${key} declares the wrong placeholders`);
    }
  }
});

test('every key the panel asks for exists', () => {
  const sources = ['src/sidepanel/app.js', 'src/lib/time.js'].map(read).join('\n');
  const used = new Set([...sources.matchAll(/\bt\('([A-Za-z0-9_@]+)'/g)].map((m) => m[1]));
  assert.ok(used.size > 10, 'the scan found the message calls');

  for (const key of used) {
    for (const locale of Object.keys(locales)) {
      assert.ok(locales[locale][key], `${locale} is missing "${key}"`);
    }
  }
});

test('the keys reached through the error map exist too', () => {
  const app = read('src/sidepanel/app.js');
  const block = app.slice(app.indexOf('const REFRESH_ERRORS'), app.indexOf('};', app.indexOf('const REFRESH_ERRORS')));
  const keys = [...block.matchAll(/'([A-Za-z0-9_@]+)'/g)]
    .map((m) => m[1])
    .filter((key) => key.startsWith('refresh'));

  assert.ok(keys.length >= 5, 'the error map was found');
  for (const key of keys) {
    assert.ok(en[key], `en is missing "${key}"`);
    assert.ok(zh[key], `zh_CN is missing "${key}"`);
  }
});

test('the manifest description comes from a bundle', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.default_locale, 'en');
  assert.match(manifest.description, /^__MSG_(\w+)__$/);
  const key = manifest.description.replace(/^__MSG_(\w+)__$/, '$1');
  assert.ok(en[key], `en is missing "${key}"`);
  assert.ok(zh[key], `zh_CN is missing "${key}"`);
});

test('no language is hard-coded into the panel', () => {
  for (const file of ['src/sidepanel/app.js', 'src/sidepanel/index.html', 'manifest.json']) {
    assert.doesNotMatch(read(file), /[\u4e00-\u9fff]/, `${file} still contains Chinese text`);
  }
});

// ---------------------------------------------------------------------------
// Formatting follows the language rather than a fixed locale
// ---------------------------------------------------------------------------

test('relative time reads naturally in English', () => {
  setLocale('en');
  const now = Date.UTC(2026, 9, 28, 12, 0, 0);
  assert.equal(relativeTime(now - 20_000, now), 'just now');
  assert.equal(relativeTime(now - 3 * 60_000, now), '3 min ago');
  assert.equal(relativeTime(now - 5 * 3_600_000, now), '5 h ago');
  assert.equal(relativeTime(now - 30 * 3_600_000, now), 'yesterday');
  assert.equal(relativeTime(now - 4 * 86_400_000, now), '4 d ago');
});

test('the Chinese bundle says the same things in Chinese', () => {
  // Outside Chrome there is no zh_CN bundle to load, so the wording is checked
  // where it lives rather than through the formatter.
  assert.equal(zh.timeNow.message, '刚刚');
  assert.equal(zh.timeMinutes.message, '$COUNT$ 分钟前');
  assert.equal(zh.timeHours.message, '$COUNT$ 小时前');
  assert.equal(zh.timeYesterday.message, '昨天');
  assert.equal(zh.timeDays.message, '$COUNT$ 天前');

  assert.equal(zh.statFollowers.message, '粉丝');
  assert.equal(zh.statFollowing.message, '关注');
  assert.equal(zh.statTweets.message, '帖子');
  assert.match(zh.panelUpdated.message, /^更新于 \$WHEN\$$/);
});

test('dates follow the selected language', () => {
  setLocale('en');
  const old = Date.UTC(2026, 2, 5, 12, 0, 0);
  const now = Date.UTC(2026, 9, 28, 12, 0, 0);
  assert.equal(relativeTime(old, now), 'Mar 5');

  setLocale('zh-CN');
  assert.equal(relativeTime(old, now), '3月5日');
});

test('numbers are grouped the same way in both languages', () => {
  for (const locale of ['en', 'zh-CN']) {
    setLocale(locale);
    assert.equal(formatBig(1284), '1,284');
  }
});

test('very large numbers are compacted in the reader\'s language', () => {
  setLocale('en');
  assert.match(formatBig(12_345_678), /^12\.\dM$/);
  setLocale('zh-CN');
  assert.match(formatBig(12_345_678), /万$/);
});

// ---------------------------------------------------------------------------
// Chrome's own bundle lookup, simulated
// ---------------------------------------------------------------------------

/** Stand-in for chrome.i18n, serving one bundle and resolving "@@ui_locale". */
function withChrome(locale) {
  globalThis.chrome = {
    i18n: {
      getMessage(key, substitutions = []) {
        if (key === '@@ui_locale') return locale.replace('-', '_');
        const entry = locales[locale.replace('-', '_')]?.[key] || locales.en[key];
        if (!entry) return '';
        const list = [].concat(substitutions);
        return entry.message.replace(/\$([A-Za-z0-9_]+)\$/g, (whole, name) => {
          const declared = entry.placeholders?.[name.toLowerCase()];
          if (!declared) return whole;
          return String(list[Number(declared.content.replace('$', '')) - 1] ?? '');
        });
      },
      getUILanguage: () => locale,
    },
  };
}

test('strings come from the bundle Chrome resolves', () => {
  try {
    withChrome('zh-CN');
    assert.equal(t('statFollowers'), '粉丝');
    assert.equal(t('panelUpdated', ['刚刚']), '更新于 刚刚');

    withChrome('en');
    assert.equal(t('statFollowers'), 'Followers');
    assert.equal(t('panelUpdated', ['just now']), 'Updated just now');
  } finally {
    delete globalThis.chrome;
  }
});

test('the reported locale is the one Chrome resolved', () => {
  try {
    withChrome('zh-CN');
    assert.equal(uiLocale(), 'zh-CN');
    withChrome('en');
    assert.equal(uiLocale(), 'en');
  } finally {
    delete globalThis.chrome;
  }
});

test('formatting uses the bundle Chrome would show, not the raw locale', () => {
  try {
    withChrome('zh-CN');
    assert.equal(bundleLocale(), 'zh-CN');
    withChrome('en-GB');
    assert.equal(bundleLocale(), 'en');
    // No bundle for these, so Chrome falls back to English and so does the panel.
    withChrome('fr');
    assert.equal(bundleLocale(), 'en');
    // zh_CN is Simplified; Chrome does not serve it to Traditional locales.
    withChrome('zh-TW');
    assert.equal(bundleLocale(), 'en');
  } finally {
    delete globalThis.chrome;
  }
});
