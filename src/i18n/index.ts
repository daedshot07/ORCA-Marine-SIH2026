/**
 * Language selection. No library, no runtime translation, no network.
 *
 * Every string is a literal written at build time and shipped in the bundle,
 * so switching language works in airplane mode like everything else here.
 *
 * NO LLM AT RUNTIME, which is this project's first non-negotiable constraint.
 * Nothing here generates or paraphrases anything: `t()` is a lookup in a frozen
 * table, and a key with no entry for the chosen language falls back to English
 * rather than being invented. See the review warning in strings.ts about who
 * wrote those tables in the first place.
 */

import { STRINGS, type Key, type LanguageCode } from "./strings.ts";

export type { Key, LanguageCode };

export interface Language {
  code: LanguageCode;
  /** The language's name in that language, which is how a chooser must read. */
  endonym: string;
  /** Whether a native speaker has signed off on this table. */
  reviewed: boolean;
}

/**
 * The languages on offer, in the order a coastal user would look for them.
 *
 * Malayalam and Tamil first because those are the two coasts this bundle
 * covers. English last of the four, not first, because it is the language of
 * the people who built this rather than of the people using it.
 */
export const LANGUAGES: readonly Language[] = [
  { code: "ml", endonym: "മലയാളം", reviewed: false },
  { code: "ta", endonym: "தமிழ்", reviewed: false },
  { code: "hi", endonym: "हिन्दी", reviewed: false },
  { code: "en", endonym: "English", reviewed: true },
];

const STORAGE_KEY = "orca.lang";
const FALLBACK: LanguageCode = "en";

let current: LanguageCode = FALLBACK;
const listeners = new Set<() => void>();

function supported(code: string): code is LanguageCode {
  return LANGUAGES.some((l) => l.code === code);
}

/**
 * Work out which language to start in.
 *
 * A stored choice always wins: someone who picked Tamil on a phone whose OS is
 * in English meant it. Otherwise the browser's preference list is consulted in
 * order, and English is the floor.
 */
export function detectLanguage(): LanguageCode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null && supported(saved)) return saved;
  } catch {
    // Private browsing. Fall through to the browser's own preference.
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = String(tag).toLowerCase().split("-")[0]!;
    if (supported(base)) return base;
  }
  return FALLBACK;
}

export function getLanguage(): LanguageCode {
  return current;
}

export function setLanguage(code: LanguageCode): void {
  if (!supported(code) || code === current) return;
  current = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    // Remembering the choice is a convenience; losing it must not stop the
    // app from being readable right now.
  }
  document.documentElement.lang = code;
  for (const listener of listeners) listener();
}

/** Re-render when the language changes. Returns an unsubscribe. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initLanguage(): void {
  current = detectLanguage();
  document.documentElement.lang = current;
}

/**
 * Look up a string.
 *
 * `vars` are substituted into {name} placeholders. THE NUMBERS ARE NOT
 * TRANSLATED and never pass through this table: they arrive already formatted
 * by src/compute/format.ts and are dropped into the sentence, so no
 * translation can change a distance, a percentage or a bearing. A table entry
 * can only ever change the words around them.
 */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const table = STRINGS[current] ?? STRINGS[FALLBACK];
  const text = table[key] ?? STRINGS[FALLBACK][key] ?? key;
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole);
}

/** True when the current language's table has not been checked by a speaker. */
export function currentIsUnreviewed(): boolean {
  const lang = LANGUAGES.find((l) => l.code === current);
  return lang !== undefined && !lang.reviewed;
}
