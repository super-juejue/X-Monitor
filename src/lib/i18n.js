/**
 * Localized strings.
 *
 * Chrome picks the message bundle from its own UI language, so the panel
 * follows Chrome with no language switch of its own. The fallback table below
 * only covers code that can run outside the extension (the node tests), which
 * still gets readable English instead of a key.
 */

const FALLBACK = {
  timeNow: 'just now',
  timeMinutes: '$1 min ago',
  timeHours: '$1 h ago',
  timeYesterday: 'yesterday',
  timeDays: '$1 d ago',
};

function hasI18n() {
  return typeof chrome !== 'undefined' && Boolean(chrome.i18n && chrome.i18n.getMessage);
}

/** Message for `key`, with `substitutions` filling $1, $2, … */
export function t(key, substitutions = []) {
  if (hasI18n()) {
    const message = chrome.i18n.getMessage(key, substitutions);
    if (message) return message;
  }
  const fallback = FALLBACK[key];
  if (!fallback) return key;
  const list = [].concat(substitutions);
  return fallback.replace(/\$(\d+)/g, (_, index) => String(list[Number(index) - 1] ?? ''));
}

/** The locale Chrome actually resolved, in BCP-47 form ("zh_CN" -> "zh-CN"). */
export function uiLocale() {
  try {
    if (hasI18n()) {
      const resolved = chrome.i18n.getMessage('@@ui_locale');
      if (typeof resolved === 'string' && resolved) return resolved.replace(/_/g, '-');
      const language = chrome.i18n.getUILanguage();
      if (typeof language === 'string' && language) return language;
    }
  } catch {
    // Fall through to English.
  }
  return 'en';
}

/**
 * The language the panel is actually rendered in. Chrome falls back to
 * default_locale for any language without a bundle, so formatting has to make
 * the same choice; otherwise a French Chrome would show English labels next to
 * French dates.
 *
 * zh_CN is Simplified, so Traditional locales get English from Chrome rather
 * than being shown Simplified text, and this mirrors that.
 */
export function bundleLocale() {
  const locale = uiLocale().toLowerCase();
  if (/^zh-(tw|hk|mo)$/.test(locale) || locale.includes('hant')) return 'en';
  return locale === 'zh' || locale.startsWith('zh-') ? 'zh-CN' : 'en';
}
