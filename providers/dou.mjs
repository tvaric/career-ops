import { decodeEntities } from './_html-entities.mjs';
import { htmlToText, DESCRIPTION_CAP } from './_html-to-text.mjs';
// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// DOU.ua provider — public RSS feed of jobs.dou.ua (Ukrainian tech job board).
// Feed: https://jobs.dou.ua/vacancies/feeds/?category=Design[&exp=5plus][&search=...]
// Public, no auth, no pagination (the feed returns the 25 newest matches), and
// every <item> carries the full description, so description is filled for free.
// robots.txt (checked 2026-10-05) does not disallow /vacancies/feeds/ for User-agent: *.
//
// Target list: `job_boards:`. Wire in with an explicit provider id:
//
//   job_boards:
//     - name: "DOU — Design 5+"
//       provider: dou
//       category: Design      # optional, DOU category name
//       exp: 5plus            # optional: 0-1 | 1-3 | 3-5 | 5plus
//       search: ""            # optional free-text search
//
// Item title shape: "<Role> в <Company>, <City>, <City>, віддалено".
// The query string is rebuilt from known keys on a pinned host — entry values
// are never used as a URL, so a portals.yml typo cannot redirect the request.

const HOST = 'jobs.dou.ua';
const FEED_PATH = '/vacancies/feeds/';
const EXP_VALUES = new Set(['0-1', '1-3', '3-5', '5plus']);

/** @param {any} entry */
export function buildDouFeedUrl(entry) {
  const url = new URL(`https://${HOST}${FEED_PATH}`);
  const category = typeof entry?.category === 'string' ? entry.category.trim() : '';
  const search = typeof entry?.search === 'string' ? entry.search.trim() : '';
  const exp = typeof entry?.exp === 'string' ? entry.exp.trim() : '';
  if (category) url.searchParams.set('category', category);
  if (search) url.searchParams.set('search', search);
  if (exp && EXP_VALUES.has(exp)) url.searchParams.set('exp', exp);
  return url.href;
}

/** @param {string} url */
function assertDouUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`dou: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== HOST) throw new Error(`dou: untrusted hostname "${parsed.hostname}" - must be ${HOST}`);
  return url;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// DOU double-encodes entities in <title> ("&amp;amp;" → "&amp;" → "&"), so
// decode twice; a second pass over already-plain text is a no-op.
function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return decodeEntities(cdata[1]).trim();
  return decodeEntities(decodeEntities(inner)).trim();
}

// Legal-form suffixes that follow a comma inside a company name ("Launch Labs, Inc").
const COMPANY_SUFFIX_RE = /^(inc\.?|llc|ltd\.?|gmbh|s\.?l\.?|s\.?a\.?|corp\.?|co\.?|plc|oy|ab|bv|ag|тов|ФОП)$/i;

function tagRaw(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

/** Strip DOU's utm tracking so the posting URL is stable as a dedup key. */
function cleanUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' || (host !== HOST && !host.endsWith('.dou.ua'))) return '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

/**
 * Split "<Role> в <Company>, <loc>, <loc>" — the LAST " в " separates role
 * from the rest (roles themselves rarely contain " в ", company names may
 * contain commas only in rare cases, so the first comma ends the company).
 * Salary fragments like "$2500–3500" are dropped from the location.
 * @param {string} raw
 */
export function splitDouTitle(raw) {
  const text = raw.replace(/ /g, ' ').trim();
  const idx = text.lastIndexOf(' в ');
  if (idx <= 0) return { title: text, company: '', location: '' };
  const title = text.slice(0, idx).trim();
  const rest = text.slice(idx + 3).trim();
  const parts = rest.split(',').map((p) => p.trim()).filter(Boolean);
  let company = parts.shift() || '';
  while (parts.length && COMPANY_SUFFIX_RE.test(parts[0])) company += `, ${parts.shift()}`;
  const location = parts.filter((p) => !/[$€]|\d{3,}/.test(p)).join(', ');
  return { title, company, location };
}

/**
 * Parse the DOU RSS body. Exported for tests.
 * @param {string} xml
 */
export function parseDouFeed(xml) {
  if (typeof xml !== 'string') return [];
  const jobs = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  for (const item of blocks) {
    const url = cleanUrl(extractText(tagRaw(item, 'link')));
    const rawTitle = extractText(tagRaw(item, 'title'));
    if (!url || !rawTitle) continue;
    const { title, company, location } = splitDouTitle(rawTitle);
    if (!title) continue;
    const description = htmlToText(tagRaw(item, 'description')).slice(0, DESCRIPTION_CAP);
    /** @type {any} */
    const job = { title, company, location, url, postedAt: toEpochMs(extractText(tagRaw(item, 'pubDate'))) };
    if (description) job.description = description;
    jobs.push(job);
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'dou',

  detect(entry) {
    return entry?.provider === 'dou' ? { url: buildDouFeedUrl(entry) } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = assertDouUrl(buildDouFeedUrl(entry));
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    return parseDouFeed(text);
  },
};
