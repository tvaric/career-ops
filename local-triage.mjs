#!/usr/bin/env node
/**
 * local-triage.mjs — fast first-pass triage of pipeline postings with a LOCAL
 * Ollama model. Fork-local file (declared in config/local-paths.txt).
 *
 * Why it exists: ollama-eval.mjs sends the full career-ops evaluation context
 * (~38K tokens). On an M1 / 16 GB Mac a 12B model needs minutes just to read
 * that, and Node's fetch gives up after 300 s. Triage only needs the compact
 * brief (modes/_brief.md, ~2K tokens) + the job description.
 *
 * What it does, per pending posting in data/pipeline.md:
 *   1. gets the JD text: fetch-jd.mjs (Greenhouse/Lever/Ashby/Workday/SmartRecruiters)
 *      or browser-extract.mjs (any other page, headless Chromium); caches it in jds/
 *   2. asks the local model for a JSON verdict (thinking disabled)
 *   3. appends one row to data/triage.md (in profile.yml language.output), skipping URLs already triaged
 * It never edits data/pipeline.md or data/applications.md.
 *
 * Usage:
 *   node local-triage.mjs --limit 3
 *   node local-triage.mjs --url <posting-url>          # one posting
 *   node local-triage.mjs --model qwen3:8b --limit 5
 * Settings: `fork.triage` in config/profile.yml (see config/fork.example.yml) — home location,
 * salary floor, domains, score weights, model. Env OLLAMA_MODEL / OLLAMA_BASE_URL override for one run.
 * The model only extracts facts; the score is computed in code (scoreFacts).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadConfig, STRINGS, DATA_ROOT } from './fork-config.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PATHS = {
  brief: join(DATA_ROOT, 'modes', '_brief.md'),
  pipeline: join(DATA_ROOT, 'data', 'pipeline.md'),
  triage: join(DATA_ROOT, 'data', 'triage.md'),
  tracker: join(DATA_ROOT, 'data', 'applications.md'),
  jds: join(DATA_ROOT, 'jds'),
};

const JD_MAX_CHARS = 12000;

// ── args ────────────────────────────────────────────────────────────
export function parseArgs(argv, cfg = loadConfig()) {
  const t = cfg.triage;
  const opts = {
    limit: t.limit_per_run,
    url: '',
    model: t.model,
    baseUrl: String(t.ollama_url).replace(/\/$/, ''),
    numCtx: t.num_ctx,
    timeoutMs: t.timeout_ms,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') opts.limit = parseInt(argv[++i], 10);
    else if (a === '--url') opts.url = argv[++i] || '';
    else if (a === '--model') opts.model = argv[++i] || opts.model;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  if (!Number.isInteger(opts.limit) || opts.limit < 1) opts.limit = 10;
  return opts;
}

// ── pipeline parsing ────────────────────────────────────────────────
/** Pending lines look like: `- [ ] url | company | title | location | ... | posted: date` */
export function parsePending(md) {
  const out = [];
  let inPending = false;
  for (const line of md.split('\n')) {
    if (/^##\s+Pending/i.test(line)) { inPending = true; continue; }
    if (/^##\s+/.test(line)) { inPending = false; continue; }
    if (!inPending) continue;
    const m = line.match(/^- \[ \]\s+(\S+)(.*)$/);
    if (!m) continue;
    const parts = m[2].split('|').map((s) => s.trim()).filter(Boolean);
    out.push({ url: m[1], company: parts[0] || '', title: parts[1] || '', location: parts[2] || '', meta: parts.slice(2).join(' | ') });
  }
  return out;
}

/** Same URL key the scanner uses for applications.md, minus trailing punctuation. */
export function urlKey(u) {
  return String(u || '').trim().replace(/[;,.]+$/, '').replace(/\/+$/, '').replace(/^http:/, 'https:').toLowerCase();
}

export function appliedUrls(md) {
  const set = new Set();
  for (const m of md.matchAll(/https?:\/\/[^\s|)]+/g)) set.add(urlKey(m[0]));
  return set;
}

/** Earlier tracker rows for the same company: "applied 2026-09-23: Staff Product Designer — status Rejected". */
export function companyHistory(trackerMd, company) {
  const norm = (v) => String(v || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9а-яіїєґ]+/g, '');
  const target = norm(company);
  if (!target || target.length < 3) return [];
  const out = [];
  for (const line of trackerMd.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    const c = line.split('|').map((x) => x.trim());
    // | # | Date | Company | Via | Role | Score | Status | ...
    const name = norm(c[3]);
    if (!name || !(name === target || name.startsWith(target) || target.startsWith(name))) continue;
    out.push(`applied ${c[2]}: ${c[5]} — status ${c[7]}`);
  }
  return out;
}

export function triagedUrls(md) {
  const set = new Set();
  for (const m of md.matchAll(/\((https?:\/\/[^)\s]+)\)/g)) set.add(urlKey(m[1]));
  return set;
}

// ── JD fetching ─────────────────────────────────────────────────────
function slugFor(job) {
  const base = `${job.company}-${job.title}`.toLowerCase().normalize('NFKD');
  return base.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'posting';
}

function fetchJd(url) {
  const api = spawnSync(process.execPath, [join(ROOT, 'fetch-jd.mjs'), url], { encoding: 'utf-8', timeout: 60000 });
  if (api.status === 0 && api.stdout.trim().length > 200) return { text: api.stdout.trim(), via: 'fetch-jd' };
  const br = spawnSync(process.execPath, [join(ROOT, 'browser-extract.mjs'), url, '--mode', 'jd', '--max-chars', String(JD_MAX_CHARS)], { encoding: 'utf-8', timeout: 120000 });
  try {
    const j = JSON.parse(br.stdout);
    if (!j.error && typeof j.text === 'string' && j.text.trim().length > 200) {
      return { text: `${j.title || ''}\n\n${j.text}`.trim(), via: 'browser-extract' };
    }
    return { text: '', via: 'none', error: j.error || 'empty page' };
  } catch {
    return { text: '', via: 'none', error: (br.stderr || 'browser-extract failed').slice(0, 200) };
  }
}

// ── extraction prompt (the model only reports FACTS; code does the scoring) ──
const SENIORITY = ['junior', 'mid', 'senior', 'lead', 'staff', 'principal', 'head', 'unclear'];
const EMPLOYMENT = ['full_time', 'part_time', 'contract', 'freelance', 'unclear'];
// Model-facing location types. Code later turns single_country_remote into
// home_country_remote / accepted_country_remote using the settings.
const LOCATION_TYPES = ['home_city', 'home_country_remote', 'region_remote', 'worldwide_remote', 'single_country_remote', 'onsite_elsewhere', 'unclear'];
const SCORED_LOCATION_TYPES = [...LOCATION_TYPES, 'accepted_country_remote'];
const ROLE_TYPES = ['product_design', 'ui_visual', 'marketing_brand', 'design_system', 'ux_research', 'other'];
const DOMAIN_TAGS = ['b2b_saas', 'enterprise', 'operational_tools', 'data_heavy', 'ai_agents', 'ai_product', 'fintech', 'cybersecurity', 'devtools', 'marketplace', 'healthcare', 'ecommerce', 'consumer', 'adtech', 'creative_tools', 'agency_client_work', 'gaming', 'other'];

export function buildMessages(brief, job, jdText, history = [], cfg = loadConfig()) {
  const t = cfg.triage;
  const lang = STRINGS[cfg.language].summaryLang;
  const city = t.home_city || '(not set)';
  const country = t.home_country || '(not set)';
  const regions = (t.remote_regions || []).join('/') || 'Europe';
  const system = [
    'You extract FACTS from ONE job posting for ONE candidate. You do NOT score. Report only what the posting says; use "unclear" when it does not say.',
    '',
    '=== CANDIDATE BRIEF (use it only to judge which hard requirements he lacks) ===',
    brief.trim(),
    '=== END BRIEF ===',
    '',
    'Return ONLY a JSON object with exactly these keys:',
    `{"seniority": one of ${JSON.stringify(SENIORITY)},`,
    ' "people_management": true if the role manages other designers, else false,',
    `  "employment": one of ${JSON.stringify(EMPLOYMENT)},`,
    `  "location_type": one of ${JSON.stringify(LOCATION_TYPES)},`,
    '  "location_country": "country named in the location requirement, or empty",',
    '  "salary": {"min": number or null, "max": number or null, "currency": "EUR|USD|GBP|... or empty", "period": "year|month|hour or empty"},',
    `  "role_type": one of ${JSON.stringify(ROLE_TYPES)},`,
    `  "domain_tags": array of 1-4 from ${JSON.stringify(DOMAIN_TAGS)},`,
    '  "missing_requirements": array of HARD requirements stated in the posting that the brief shows he clearly lacks (empty if none),',
    '  "hard_dq": array of Hard DQ criteria from the brief that this posting clearly triggers (empty if none),',
    `  "summary": "one sentence in ${lang}: what this role is",`,
    `  "risks": array of short ${lang} sentences: risks/gaps worth knowing}`,
    `location_type guide: "home_city" = office/hybrid/remote tied to ${city}; "home_country_remote" = remote and ${country} is named as allowed;`,
    ` "region_remote" = remote across ${regions}; "worldwide_remote" = remote from anywhere;`,
    ' "single_country_remote" = remote but tied to ONE country (put it in location_country);',
    ` "onsite_elsewhere" = on-site/hybrid in a city other than ${city}, or relocation required.`,
    'Agencies/outstaffing and part-time are NOT hard_dq. If part-time/hourly/freelance, say so in risks.',
    'If "History with this company" lists earlier applications, mention them in risks.',
  ].join('\n');
  const user = [
    `Company: ${job.company}`,
    `Title: ${job.title}`,
    `Listing details (location, salary, posted): ${job.meta || job.location}`,
    `URL: ${job.url}`,
    `History with this company (from his tracker): ${history.length ? history.join('; ') : 'none'}`,
    '',
    'JOB DESCRIPTION:',
    jdText.slice(0, JD_MAX_CHARS),
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// ── deterministic scoring ───────────────────────────────────────────
/** Scoring rules derived from settings (fork.triage in config/profile.yml). */
export function rulesFrom(cfg) {
  const t = cfg.triage;
  const fx = { USD: 1, ...t.fx_to_usd };
  const f = t.salary_floor || {};
  const fRate = fx[String(f.currency || 'USD').toUpperCase()] || 1;
  const fAmount = Number(f.amount) || 0;
  const fPeriod = String(f.period || 'month');
  const floorUsdMonth = Math.round((fPeriod === 'year' ? fAmount / 12 : fPeriod === 'hour' ? fAmount * 160 : fAmount) * fRate);
  return {
    floorUsdMonth,
    fx,
    level: t.scores.level,
    location: t.scores.location,
    domain: t.scores.domain,
    comp: t.scores.comp,
    mustHaves: t.scores.must_haves,
    dqCap: t.scores.dq_cap,
    thresholds: t.thresholds,
    coreDomains: t.core_domains,
    adjacentDomains: t.adjacent_domains,
    weakDomains: t.weak_domains,
    dqRoleTypes: t.dq_role_types,
    homeCity: String(t.home_city || ''),
    homeCountry: String(t.home_country || ''),
    homeAliases: [t.home_country, ...(t.home_country_aliases || [])].filter(Boolean).map((x) => String(x).toLowerCase()),
    acceptedCountries: (t.accepted_remote_countries || []).map((x) => String(x).toLowerCase()),
  };
}

const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

/** Parse "40000-60000 EUR" style salary text from the listing line (code, not model). */
export function salaryFromMeta(meta) {
  const m = String(meta || '').match(/(\d[\d.,]*)\s*[-–]\s*(\d[\d.,]*)\s*(EUR|USD|GBP|€|\$|£)/i);
  if (!m) return null;
  const num = (s) => Number(s.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  const cur = { '€': 'EUR', '$': 'USD', '£': 'GBP' }[m[3]] || m[3].toUpperCase();
  return { min: num(m[1]), max: num(m[2]), currency: cur, period: '' };
}

export function monthlyUsd(sal, rules) {
  if (!sal) return null;
  const top = Number(sal.max ?? sal.min);
  if (!Number.isFinite(top) || top <= 0) return null;
  const rate = rules.fx[String(sal.currency || '').toUpperCase()];
  if (!rate) return null;
  let period = String(sal.period || '').toLowerCase();
  if (!period) period = top > 20000 ? 'year' : top > 300 ? 'month' : 'hour';
  const perMonth = period === 'year' ? top / 12 : period === 'hour' ? top * 160 : top;
  return Math.round(perMonth * rate);
}

export function scoreFacts(raw, job, cfg = loadConfig()) {
  const R = rulesFrom(cfg);
  const S = STRINGS[cfg.language];
  let f;
  try {
    f = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  const facts = {
    seniority: pick(f.seniority, SENIORITY, 'unclear'),
    employment: pick(f.employment, EMPLOYMENT, 'unclear'),
    location_type: pick(f.location_type, LOCATION_TYPES, 'unclear'),
    location_country: String(f.location_country || '').trim(),
    role_type: pick(f.role_type, ROLE_TYPES, 'other'),
    domain_tags: (Array.isArray(f.domain_tags) ? f.domain_tags : []).filter((t) => DOMAIN_TAGS.includes(t)),
    missing: (Array.isArray(f.missing_requirements) ? f.missing_requirements : []).map(String).filter(Boolean),
    hard_dq: (Array.isArray(f.hard_dq) ? f.hard_dq : []).map(String).filter(Boolean),
    people_management: f.people_management === true,
  };
  // Code-side corrections from the listing line (more reliable than the model).
  const loc = `${job.location} ${job.meta || ''}`.toLowerCase();
  if (R.homeCity && loc.includes(R.homeCity.toLowerCase())) facts.location_type = 'home_city';
  if (facts.location_type === 'single_country_remote') {
    const c = facts.location_country.toLowerCase();
    if (c && R.homeAliases.some((a) => c.includes(a))) facts.location_type = 'home_country_remote';
    else if (c && R.acceptedCountries.some((a) => c.includes(a))) facts.location_type = 'accepted_country_remote';
  }

  const parts = {};
  parts.level = R.level[facts.seniority] ?? 0;
  if (facts.role_type === 'ui_visual') parts.level = Math.min(parts.level, 10);
  const tags = facts.domain_tags;
  const hasCore = tags.some((t) => R.coreDomains.includes(t));
  const hasAdj = tags.some((t) => R.adjacentDomains.includes(t));
  const hasWeak = tags.some((t) => R.weakDomains.includes(t));
  parts.domain = hasCore ? (hasWeak ? R.domain.core_with_weak : R.domain.core) : hasAdj ? R.domain.adjacent : hasWeak ? R.domain.weak : R.domain.none;
  parts.location = R.location[facts.location_type] ?? R.location.unclear;

  const sal = (f.salary && (f.salary.max || f.salary.min) ? f.salary : null) || salaryFromMeta(job.meta);
  const usd = monthlyUsd(sal, R);
  parts.comp = usd == null ? R.comp.unknown : usd >= R.floorUsdMonth ? R.comp.above_floor : R.comp.below_floor;
  parts.must_haves = Math.max(0, R.mustHaves.max - R.mustHaves.per_missing * facts.missing.length);

  const dq = [...facts.hard_dq];
  if (facts.location_type === 'onsite_elsewhere') dq.push(S.dqOnsite(R.homeCity));
  if (R.dqRoleTypes.includes(facts.role_type)) dq.push(`role type: ${facts.role_type}`);

  let score = parts.level + parts.domain + parts.location + parts.comp + parts.must_haves;
  if (dq.length) score = Math.min(score, R.dqCap);
  const th = R.thresholds;
  const verdict = score >= th.strong_apply ? 'Strong Apply' : score >= th.apply ? 'Apply' : score >= th.low_priority ? 'Low Priority' : 'Skip';

  const clean = (v) => String(v || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const rawRisks = f.risks ?? f.risks_uk;
  const risks = (Array.isArray(rawRisks) ? rawRisks : [rawRisks]).map(clean).filter(Boolean);
  if (facts.location_type === 'single_country_remote') risks.unshift(S.unknownRemote(R.homeCountry, facts.location_country));
  if (facts.employment !== 'full_time' && facts.employment !== 'unclear') risks.unshift(S.employment(facts.employment));
  if (usd != null) risks.push(S.pay(usd, R.floorUsdMonth));
  if (dq.length) risks.unshift(`DQ: ${dq.join('; ')}`);
  if (facts.missing.length) risks.push(S.missing(facts.missing.join('; ')));

  return {
    verdict,
    score,
    parts,
    facts,
    confidence: '—',
    reason: clean(f.summary ?? f.summary_uk),
    risk: [...new Set(risks)].join(' · '),
  };
}

async function askModel(opts, messages) {
  const res = await fetch(`${opts.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages,
      stream: true,      // headers arrive with the first token (Node fetch 300 s header limit)
      think: false,      // no "Thinking..." phase — faster
      format: 'json',
      options: { temperature: 0, seed: 42, num_ctx: opts.numCtx }, // as repeatable as the model allows
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const decoder = new TextDecoder();
  let buf = '', acc = '', promptTokens = 0;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.error) throw new Error(msg.error);
      if (msg.message?.content) acc += msg.message.content;
      if (msg.done) promptTokens = msg.prompt_eval_count || 0;
    }
  }
  return { text: acc, promptTokens };
}

// ── output ──────────────────────────────────────────────────────────
export function triageHeader(lang) {
  const S = STRINGS[lang];
  return [S.triageTitle, '', S.triageFormula, '', S.triageCols, '|---|---|---|---|---|---|---|---|---|---|'].join('\n');
}

export function formatRow(date, job, r) {
  const cell = (s) => String(s || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const p = r.parts ? `${r.parts.level}/${r.parts.domain}/${r.parts.location}/${r.parts.comp}/${r.parts.must_haves}` : '—';
  const f = r.facts ? `${r.facts.seniority} · ${r.facts.employment} · ${r.facts.location_type}${r.facts.location_country ? ` (${r.facts.location_country})` : ''} · ${r.facts.role_type} · ${r.facts.domain_tags.join(', ')}` : '—';
  return `| ${date} | ${r.verdict} | ${r.score} | ${p} | ${cell(f)} | ${cell(job.company)} | ${cell(job.title)} | ${cell(r.reason)} | ${cell(r.risk)} | [link](${job.url}) |`;
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  const S = STRINGS[cfg.language];
  const opts = parseArgs(process.argv.slice(2), cfg);
  if (opts.help) {
    console.log('Usage: node local-triage.mjs [--limit N] [--url <posting-url>] [--model <ollama-model>]');
    return;
  }
  if (!existsSync(PATHS.brief)) throw new Error('modes/_brief.md not found');
  const brief = readFileSync(PATHS.brief, 'utf-8');

  if (!existsSync(PATHS.triage)) writeFileSync(PATHS.triage, triageHeader(cfg.language) + '\n', 'utf-8');
  const done = triagedUrls(readFileSync(PATHS.triage, 'utf-8'));
  const trackerMd = existsSync(PATHS.tracker) ? readFileSync(PATHS.tracker, 'utf-8') : '';
  const applied = appliedUrls(trackerMd);

  let queue;
  if (opts.url) {
    const all = existsSync(PATHS.pipeline) ? parsePending(readFileSync(PATHS.pipeline, 'utf-8')) : [];
    queue = [all.find((j) => j.url === opts.url) || { url: opts.url, company: '?', title: '?', location: '' }];
  } else {
    if (!existsSync(PATHS.pipeline)) throw new Error('data/pipeline.md not found — run node scan.mjs first');
    queue = parsePending(readFileSync(PATHS.pipeline, 'utf-8')).filter((j) => !done.has(urlKey(j.url))).slice(0, opts.limit);
  }
  if (!queue.length) { console.log('Nothing to triage — every pending posting is already in data/triage.md.'); return; }

  mkdirSync(PATHS.jds, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  console.log(`Model: ${opts.model} · ${queue.length} posting(s)\n`);

  for (const job of queue) {
    const label = `${job.company} — ${job.title}`;
    const t0 = Date.now();
    if (applied.has(urlKey(job.url))) {
      appendFileSync(PATHS.triage, formatRow(today, job, { verdict: S.alreadyApplied, score: '—', reason: S.alreadyAppliedReason, risk: '' }) + '\n', 'utf-8');
      console.log(`↩️  ${label}: already in data/applications.md — not evaluated`);
      continue;
    }
    const jdPath = join(PATHS.jds, `${slugFor(job)}.txt`);
    let jd = existsSync(jdPath) ? { text: readFileSync(jdPath, 'utf-8'), via: 'cache' } : fetchJd(job.url);
    if (!jd.text) {
      console.log(`⚠️  ${label}: JD not retrieved (${jd.error}). Skipped — check the link manually: ${job.url}`);
      continue;
    }
    if (jd.via !== 'cache') writeFileSync(jdPath, jd.text, 'utf-8');

    let result = null, promptTokens = 0;
    try {
      const out = await askModel(opts, buildMessages(brief, job, jd.text, companyHistory(trackerMd, job.company), cfg));
      promptTokens = out.promptTokens;
      result = scoreFacts(out.text, job, cfg);
    } catch (err) {
      console.log(`❌  ${label}: model call failed — ${err.message}`);
      continue;
    }
    if (!result) { console.log(`❌  ${label}: model did not return valid JSON`); continue; }

    appendFileSync(PATHS.triage, formatRow(today, job, result) + '\n', 'utf-8');
    const secs = Math.round((Date.now() - t0) / 1000);
    const p = result.parts;
    console.log(`${result.verdict.padEnd(12)} ${String(result.score).padStart(3)}  ${label}  [level ${p.level}/25 · domain ${p.domain}/25 · location ${p.location}/20 · pay ${p.comp}/15 · must-haves ${p.must_haves}/15]  (${secs}s, JD via ${jd.via}, ${promptTokens} prompt tokens)`);
    console.log(`             ${result.reason}`);
  }
  console.log(`\nSaved to data/triage.md`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => { console.error(`❌  ${err.message}`); process.exit(1); });
}
