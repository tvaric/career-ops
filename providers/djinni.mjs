import { decodeEntities } from './_html-entities.mjs';
import { htmlToText, DESCRIPTION_CAP } from './_html-to-text.mjs';
import { intInRange } from './_config-utils.mjs';
// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Djinni provider — public RSS feed of djinni.co (Ukrainian tech job board).
// Feed: https://djinni.co/jobs/rss/?primary_keyword=Design[&exp_level=5y]
// Public, no auth. Each <item> carries title, link, pubDate and the full
// description, but NOT the employer or location.
// robots.txt (checked 2026-10-05) does not disallow /jobs/ for User-agent: *.
//
// Measured 2026-10-05: an unknown primary_keyword (e.g. "Product Designer",
// "UI/UX") is silently ignored and the feed returns the generic 100-item feed
// of every profession. Use a real Djinni category name ("Design").
//
// Employer + location live in the posting page's JSON-LD (schema.org
// JobPosting). Reading them costs one request per posting, so it is OPT-IN:
// `fetchDetails: true` (bounded by `detailLimit`, default 25) and skipped while
// verify-portals is probing — same contract as smartrecruiters/vdab.
//
// Target list: `job_boards:`.
//
//   job_boards:
//     - name: "Djinni — Design 5y+"
//       provider: djinni
//       primary_keyword: Design
//       exp_level: 5y           # optional: no_exp | 1y | 2y | 3y | 5y
//       fetchDetails: true      # optional: employer + location from JSON-LD
//       detailLimit: 25

const HOST = 'djinni.co';
const EXP_VALUES = new Set(['no_exp', '1y', '2y', '3y', '5y']);

/** @param {any} entry */
export function buildDjinniFeedUrl(entry) {
  const url = new URL(`https://${HOST}/jobs/rss/`);
  const kw = typeof entry?.primary_keyword === 'string' ? entry.primary_keyword.trim() : '';
  const exp = typeof entry?.exp_level === 'string' ? entry.exp_level.trim() : '';
  if (kw) url.searchParams.set('primary_keyword', kw);
  if (exp && EXP_VALUES.has(exp)) url.searchParams.set('exp_level', exp);
  return url.href;
}

/** @param {string} url */
function assertDjinniUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`djinni: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== HOST) throw new Error(`djinni: untrusted hostname "${parsed.hostname}" - must be ${HOST}`);
  return url;
}

function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function extractText(inner) {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

function tagRaw(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : '';
}

/** Only absolute https links to a djinni.co job posting are accepted. */
function cleanJobUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value.trim());
    if (parsed.hostname.toLowerCase() !== HOST) return '';
    if (!/^\/jobs\/\d+[-\w]*\/?$/.test(parsed.pathname)) return '';
    parsed.protocol = 'https:';
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

/**
 * Parse the Djinni RSS body. Exported for tests.
 * @param {string} xml
 */
export function parseDjinniFeed(xml) {
  if (typeof xml !== 'string') return [];
  const jobs = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];
  for (const item of blocks) {
    const url = cleanJobUrl(extractText(tagRaw(item, 'link')));
    const title = extractText(tagRaw(item, 'title'));
    if (!url || !title) continue;
    const description = htmlToText(tagRaw(item, 'description')).slice(0, DESCRIPTION_CAP);
    /** @type {any} */
    const job = { title, company: '', location: '', url, postedAt: toEpochMs(extractText(tagRaw(item, 'pubDate'))) };
    if (description) job.description = description;
    jobs.push(job);
  }
  return jobs;
}

/**
 * Pull employer + location out of a posting page's schema.org JobPosting.
 * Exported for tests.
 * @param {string} html
 * @returns {{company: string, location: string}}
 */
export function parseDjinniDetail(html) {
  const out = { company: '', location: '' };
  if (typeof html !== 'string') return out;
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    let data;
    try {
      data = JSON.parse(b.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, ''));
    } catch {
      continue;
    }
    if (!data || data['@type'] !== 'JobPosting') continue;
    const org = data.hiringOrganization;
    if (org && typeof org.name === 'string') out.company = org.name.trim();
    const addr = data.applicantLocationRequirements?.address || data.jobLocation?.address || {};
    const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim());
    if (data.jobLocationType === 'TELECOMMUTE') parts.push('Remote');
    out.location = parts.join(', ');
    break;
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'djinni',

  detect(entry) {
    return entry?.provider === 'djinni' ? { url: buildDjinniFeedUrl(entry) } : null;
  },

  async fetch(entry, ctx) {
    const feedUrl = assertDjinniUrl(buildDjinniFeedUrl(entry));
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    const jobs = parseDjinniFeed(text);

    const fetchDetails = entry?.fetchDetails === true;
    const detailLimit = intInRange(entry?.detailLimit, 25, 1, 100);
    const probing = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0;
    if (fetchDetails && !probing) {
      for (const job of jobs.slice(0, detailLimit)) {
        try {
          const html = await ctx.fetchText(assertDjinniUrl(job.url), { redirect: 'error' });
          const { company, location } = parseDjinniDetail(html);
          if (company) job.company = company;
          if (location) job.location = location;
        } catch {
          // A failed detail fetch keeps the list-level job; never drop it.
        }
        if (typeof ctx.sleep === 'function') await ctx.sleep(300);
      }
    }
    return jobs;
  },
};
