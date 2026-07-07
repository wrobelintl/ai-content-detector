#!/usr/bin/env node
/**
 * preflight.mjs — static QA checks for aicontentdetectorfree.com
 *
 * Dependency-free (Node built-ins only). Run from the repo root:
 *   node tools/preflight.mjs      (or: npm run check)
 *
 * Exists because a one-character corruption (a stripped `||`) once broke the
 * detector's inline JavaScript for ~10 weeks without anyone noticing. Every
 * check here is a promise the deployed site must keep. Exit code 0 = safe to
 * commit/deploy; non-zero = do not ship.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- config ---

const SITE = 'https://aicontentdetectorfree.com';
const ADSENSE_PUB_ID = 'ca-pub-6286935824893984';
const ADSENSE_LOADER =
  `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUB_ID}" crossorigin="anonymous"></script>`;
const ADS_TXT_EXACT = 'google.com, pub-6286935824893984, DIRECT, f08c47fec0942fa0';

// Pages and what each must carry. adsense: expected loader count.
// canonical/description: required on pages that have always had them
// (privacy/terms historically ship without either — adding one would be a
// public content change outside this task's scope).
const PAGES = {
  'index.html':                                { adsense: 1, canonical: `${SITE}/`, description: true },
  'how-accurate-are-ai-detectors.html':        { adsense: 1, canonical: `${SITE}/how-accurate-are-ai-detectors.html`, description: true },
  'why-ai-detectors-give-false-positives.html':{ adsense: 1, canonical: `${SITE}/why-ai-detectors-give-false-positives.html`, description: true },
  'how-to-use-ai-detectors-responsibly.html':  { adsense: 1, canonical: `${SITE}/how-to-use-ai-detectors-responsibly.html`, description: true },
  'privacy.html':                              { adsense: 0, canonical: null, description: false },
  'terms.html':                                { adsense: 0, canonical: null, description: false },
};

const REQUIRED_FILES = [
  ...Object.keys(PAGES), 'sitemap.xml', 'robots.txt', 'ads.txt', '_headers',
  'google88a317686dc65954.html',
];

// External link/script destinations the site is allowed to reference.
const ALLOWED_EXTERNAL_HOSTS = [
  'aicontentdetectorfree.com',
  'www.google.com',                 // privacy: Google Ads settings opt-out link
  'warrenbg.com',                   // footer attribution
  'pagead2.googlesyndication.com',  // AdSense loader (the ONLY allowed script src)
];
const ALLOWED_SCRIPT_SRC_HOSTS = ['pagead2.googlesyndication.com'];

// Phrases that must never appear in public copy. `negatable: true` allows the
// phrase when the nearby context negates it (the site's honest disclaimers
// legitimately say "No AI detector is 100% accurate" / "not definitive proof").
const BANNED_PHRASES = [
  { phrase: '100% accurate',        negatable: true },
  { phrase: 'definitive proof',     negatable: true },
  { phrase: 'proof of ai use',      negatable: false },
  { phrase: 'bypass detector',      negatable: false },
  { phrase: 'bypass detectors',     negatable: false },
  { phrase: 'beat turnitin',        negatable: false },
  { phrase: 'avoid getting caught', negatable: false },
  { phrase: 'undetectable',         negatable: false },
  { phrase: 'guaranteed human',     negatable: false },
];
const NEGATION_TOKENS = ['no ', 'not ', 'never ', "isn't", 'is this', '?'];

// Tracking / capture / monetization patterns that require explicit owner
// approval before they may ever appear.
const FORBIDDEN_PATTERNS = [
  { re: /gtag\(/i,                    why: 'Google Analytics gtag call' },
  { re: /googletagmanager/i,          why: 'Google Tag Manager' },
  { re: /google-analytics\.com/i,     why: 'Google Analytics domain' },
  { re: /<form[\s>]/i,                why: '<form> element (no forms/email capture approved)' },
  { re: /<input[\s>]/i,               why: '<input> element (no forms/email capture approved)' },
  { re: /<ins[\s>]/i,                 why: 'manual ad unit <ins> (only Auto Ads approved)' },
  { re: /data-ad-slot/i,              why: 'manual ad unit slot' },
  { re: /[?&]ref=/i,                  why: 'affiliate-style ?ref= parameter' },
  { re: /affiliate/i,                 why: '"affiliate" reference (none approved for public site)' },
  { re: /utm_/i,                      why: 'utm_ campaign parameter' },
  // Anything that could send visitor text off-device would break the verified
  // "analyzed locally / nothing uploaded" privacy claim:
  { re: /fetch\s*\(/,                 why: 'fetch() call — contradicts local-processing claim' },
  { re: /XMLHttpRequest/,             why: 'XHR — contradicts local-processing claim' },
  { re: /sendBeacon/,                 why: 'sendBeacon — contradicts local-processing claim' },
  { re: /WebSocket/,                  why: 'WebSocket — contradicts local-processing claim' },
];

// The detector contract: index.html must keep this UI + wiring intact.
const DETECTOR_REQUIREMENTS = [
  { needle: '<textarea id="textInput"', why: 'detector textarea' },
  { needle: 'onclick="detectAI()"',     why: 'Detect button trigger' },
  { needle: "onclick=\"loadSample('ai')\"",    why: 'AI sample loader button' },
  { needle: "onclick=\"loadSample('human')\"", why: 'human sample loader button' },
  { needle: 'id="wordCount"',           why: 'word counter element' },
  { needle: 'function detectAI()',      why: 'detectAI function' },
  { needle: 'function clearAll()',      why: 'clearAll function' },
  { needle: 'function loadSample(',     why: 'loadSample function' },
  { needle: 'function updateMeta()',    why: 'updateMeta function' },
  { needle: 'No AI detector is 100% accurate', why: 'honest accuracy disclaimer' },
  { needle: 'analyzed locally in your browser', why: 'local-processing privacy claim' },
];

// ------------------------------------------------------------- machinery ---

const failures = [];
let checksRun = 0;
function check(ok, label, detail = '') {
  checksRun++;
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}
const read = (f) => readFileSync(join(ROOT, f), 'utf8');
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');

// ----------------------------------------------------------------- checks --

// 1. Required files exist
for (const f of REQUIRED_FILES) {
  check(existsSync(join(ROOT, f)), `file exists: ${f}`);
}
if (failures.length) { report(); } // can't scan missing files

// 2. ads.txt byte-exact
check(read('ads.txt').trim() === ADS_TXT_EXACT, 'ads.txt exact content',
  `expected "${ADS_TXT_EXACT}"`);

// 3. Per-page scans (comments stripped so commented-out code can't hide/trip anything)
for (const [file, want] of Object.entries(PAGES)) {
  const raw = read(file);
  const html = stripComments(raw);
  const lower = html.toLowerCase();

  // AdSense loader: exact snippet, exact count, and no other pub id anywhere
  const loaderCount = html.split(ADSENSE_LOADER).length - 1;
  check(loaderCount === want.adsense, `${file}: AdSense loader count`,
    `found ${loaderCount}, expected ${want.adsense}`);
  const pubIds = html.match(/ca-pub-\d+/g) ?? [];
  check(pubIds.every((id) => id === ADSENSE_PUB_ID), `${file}: publisher id unchanged`,
    `found ${[...new Set(pubIds)].join(', ')}`);

  // Exactly one <title>; canonical + meta description where required
  check((html.match(/<title>/g) ?? []).length === 1, `${file}: exactly one <title>`);
  if (want.canonical) {
    const m = html.match(/<link rel="canonical" href="([^"]+)"/g) ?? [];
    check(m.length === 1 && m[0].includes(`"${want.canonical}"`),
      `${file}: canonical is ${want.canonical}`, `found ${m.join(' | ') || 'none'}`);
  }
  if (want.description) {
    check(/<meta name="description" content="[^"]{20,}"/.test(html),
      `${file}: has a meta description`);
  }

  // Internal links resolve; external links on the allowlist
  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
    if (href.startsWith('mailto:')) continue; // contact links (privacy/terms) are fine
    if (/^https?:\/\//.test(href)) {
      const host = new URL(href).hostname;
      check(ALLOWED_EXTERNAL_HOSTS.includes(host),
        `${file}: external link host allowed`, `${host} (${href})`);
    } else {
      const target = href === '/' ? 'index.html' : href.replace(/^\//, '').split(/[?#]/)[0];
      check(existsSync(join(ROOT, target)), `${file}: internal link resolves`, href);
    }
  }

  // Script sources: only the AdSense loader host is allowed
  for (const [, src] of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) {
    const host = new URL(src, SITE).hostname;
    check(ALLOWED_SCRIPT_SRC_HOSTS.includes(host),
      `${file}: script src host allowed`, `${host} (${src})`);
  }

  // Tracking / capture / monetization patterns
  for (const { re, why } of FORBIDDEN_PATTERNS) {
    check(!re.test(html), `${file}: forbidden pattern absent`, why);
  }

  // Banned public claims (with negation allowance for honest disclaimers)
  for (const { phrase, negatable } of BANNED_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      const ctx = lower.slice(Math.max(0, idx - 60), idx + phrase.length + 10);
      const negated = negatable && NEGATION_TOKENS.some((t) => ctx.includes(t));
      check(negated, `${file}: banned phrase absent or negated`, `"${phrase}" @ …${ctx.trim()}…`);
      idx = lower.indexOf(phrase, idx + 1);
    }
  }

  // Inline JavaScript must parse (the exact failure that shipped broken for ~10 weeks)
  const scripts = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).filter((s) => s.trim());
  for (const [i, src] of scripts.entries()) {
    try {
      new vm.Script(src, { filename: `${file}#inline-${i}` });
      check(true, `${file}: inline script ${i} parses`);
    } catch (e) {
      check(false, `${file}: inline script ${i} parses`, e.message);
    }
  }

  // Education pages carry no inline scripts at all (AdSense loader only)
  if (file !== 'index.html') {
    check(scripts.length === 0, `${file}: no inline scripts`, `found ${scripts.length}`);
  }
}

// 4. Detector contract on the homepage
{
  const html = stripComments(read('index.html'));
  for (const { needle, why } of DETECTOR_REQUIREMENTS) {
    check(html.includes(needle), `index.html: detector contract`, why);
  }
  // Every onclick handler calls a function defined in the inline script,
  // and every getElementById target exists in the markup.
  const script = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1]).join('\n');
  for (const [, fn] of html.matchAll(/onclick="(\w+)\(/g)) {
    check(new RegExp(`function ${fn}\\s*\\(`).test(script),
      'index.html: onclick handler defined', `${fn}()`);
  }
  for (const [, id] of script.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) {
    check(html.includes(`id="${id}"`), 'index.html: getElementById target exists', `#${id}`);
  }
}

// 5. Sitemap ↔ filesystem consistency, both directions
{
  const sm = read('sitemap.xml');
  check(sm.includes('<?xml') && sm.includes('<urlset'), 'sitemap.xml: looks like XML');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  for (const loc of locs) {
    check(loc.startsWith(`${SITE}/`), 'sitemap: loc uses canonical domain', loc);
    const path = loc.slice(SITE.length + 1) || 'index.html';
    check(existsSync(join(ROOT, path)), 'sitemap: loc has a local file', loc);
  }
  for (const page of Object.keys(PAGES)) {
    const expected = page === 'index.html' ? `${SITE}/` : `${SITE}/${page}`;
    check(locs.includes(expected), 'sitemap: page is listed', expected);
  }
}

// 6. robots.txt references the sitemap
check(read('robots.txt').includes(`Sitemap: ${SITE}/sitemap.xml`),
  'robots.txt: sitemap reference present');

// ----------------------------------------------------------------- report --

function report() {
  if (failures.length === 0) {
    console.log(`PREFLIGHT PASS — ${checksRun} checks, 0 failures.`);
    process.exit(0);
  }
  console.error(`PREFLIGHT FAIL — ${failures.length} failure(s) of ${checksRun} checks:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('\nDo not commit or deploy until these are fixed.');
  process.exit(1);
}
report();
