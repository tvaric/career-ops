// fork-config.mjs — settings for the fork-local tools (local-triage, notify-telegram, schedule).
// Personal values live in config/profile.yml (gitignored) under the `fork:` key and in .env.
// Everything here is a generic default; see config/fork.example.yml for the full block.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url)); // code (scripts)
export const DATA_ROOT = getCareerOpsRoot();                   // user layer (config, data, .env)

export const DEFAULTS = {
  language: 'en', // taken from profile.yml → language.output
  triage: {
    model: 'gemma4:12b',
    ollama_url: 'http://localhost:11434',
    num_ctx: 8192,
    timeout_ms: 600000,
    limit_per_run: 10,
    home_city: '',
    home_country: '',
    home_country_aliases: [],
    remote_regions: ['Europe', 'EMEA', 'EU'],
    accepted_remote_countries: [],
    salary_floor: { amount: 0, currency: 'USD', period: 'month' },
    fx_to_usd: { USD: 1, EUR: 1.12, GBP: 1.33 },
    core_domains: ['b2b_saas', 'enterprise'],
    adjacent_domains: [],
    weak_domains: [],
    dq_role_types: ['marketing_brand'],
    scores: {
      level: { senior: 25, lead: 25, staff: 15, unclear: 15, principal: 5, head: 5, mid: 5, junior: 0 },
      location: {
        home_city: 20, home_country_remote: 20, region_remote: 14, accepted_country_remote: 14,
        worldwide_remote: 14, single_country_remote: 7, onsite_elsewhere: 0, unclear: 10,
      },
      domain: { core: 25, core_with_weak: 18, adjacent: 15, weak: 8, none: 12 },
      comp: { above_floor: 15, unknown: 10, below_floor: 3 },
      must_haves: { max: 15, per_missing: 5 },
      dq_cap: 45,
    },
    thresholds: { strong_apply: 80, apply: 65, low_priority: 50 },
  },
  notify: {
    verdicts: ['Strong Apply', 'Apply', 'Low Priority'],
  },
  schedule: {
    hours: [9, 14, 19],
    label: 'com.career-ops.daily',
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function merge(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(base?.[k]) ? merge(base[k], v) : v;
  return out;
}

export function loadConfig(profilePath = join(DATA_ROOT, 'config', 'profile.yml')) {
  let profile = {};
  if (existsSync(profilePath)) profile = yaml.load(readFileSync(profilePath, 'utf8')) || {};
  const cfg = merge(DEFAULTS, profile.fork || {});
  cfg.language = String(profile.language?.output || cfg.language || 'en').toLowerCase().startsWith('uk') ? 'uk' : 'en';
  // Env overrides for one-off runs
  if (process.env.OLLAMA_MODEL) cfg.triage.model = process.env.OLLAMA_MODEL;
  if (process.env.OLLAMA_BASE_URL) cfg.triage.ollama_url = process.env.OLLAMA_BASE_URL;
  return cfg;
}

export function loadEnv(path = join(DATA_ROOT, '.env')) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ── user-facing strings (triage.md, Telegram) ──
export const STRINGS = {
  en: {
    triageTitle: '# Triage — local model (facts) + rules in code (score)',
    triageFormula: 'Score = level/25 + domain/25 + location/20 + pay/15 + must-haves/15. Settings: `fork.triage` in config/profile.yml.',
    triageCols: '| Date | Verdict | Score | Lvl/Dom/Loc/Pay/Req | Facts | Company | Role | What it is | Risks | Link |',
    alreadyApplied: 'Already applied',
    alreadyAppliedReason: 'URL is already in data/applications.md',
    summaryLang: 'English',
    unknownRemote: (home, c) => `UNKNOWN: whether working from ${home || 'your country'} is allowed (remote tied to: ${c || '?'})`,
    employment: (e) => `Employment: ${e}`,
    pay: (usd, floor) => `Pay ≈ $${usd}/month (floor $${floor})`,
    missing: (m) => `Missing: ${m}`,
    dqOnsite: (home) => `on-site/relocation outside ${home || 'home location'}`,
    newJobs: (n) => `New jobs: ${n}`,
    filtered: (n) => `(${n} more filtered out: Skip / already applied)`,
    scoresLine: 'Score parts (lvl/dom/loc/pay/req)',
    open: 'Open posting',
    testMsg: '✅ career-ops: test message. Notifications work.',
    failMsg: '⚠️ career-ops: run failed',
  },
  uk: {
    triageTitle: '# Triage — локальна модель (факти) + правила в коді (бал)',
    triageFormula: 'Бал = рівень/25 + домен/25 + локація/20 + ЗП/15 + вимоги/15. Налаштування: `fork.triage` у config/profile.yml.',
    triageCols: '| Дата | Вердикт | Бал | Рів/Дом/Лок/ЗП/Вим | Факти | Компанія | Роль | Що це | Ризики | Посилання |',
    alreadyApplied: 'Вже подавався',
    alreadyAppliedReason: 'URL уже є в data/applications.md',
    summaryLang: 'Ukrainian',
    unknownRemote: (home, c) => `НЕВІДОМО: чи можна працювати з країни ${home || '?'} (remote прив'язаний до: ${c || '?'})`,
    employment: (e) => `Зайнятість: ${e}`,
    pay: (usd, floor) => `ЗП ≈ $${usd}/міс (поріг $${floor})`,
    missing: (m) => `Бракує: ${m}`,
    dqOnsite: (home) => `on-site/релокація поза ${home || 'домашньою локацією'}`,
    newJobs: (n) => `Нові вакансії: ${n}`,
    filtered: (n) => `(ще ${n} відсіяно: Skip / вже подавався)`,
    scoresLine: 'Бали (рів/дом/лок/ЗП/вим)',
    open: 'Відкрити вакансію',
    testMsg: '✅ career-ops: тестове повідомлення. Сповіщення працюють.',
    failMsg: '⚠️ career-ops: запуск не вдався',
  },
};
