// tests/fork/local-tools.test.mjs — fork-local tools: settings, triage scoring, Telegram format, schedule.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

console.log('\nFork — local triage / telegram / schedule');

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass(label);
  else fail(`${label}: got ${a}, expected ${e}`);
}

try {
  const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);
  const fc = await imp('fork-config.mjs');
  const tri = await imp('local-triage.mjs');
  const tg = await imp('notify-telegram.mjs');
  const sch = await imp('schedule.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'fork-cfg-'));
  const prof = join(dir, 'profile.yml');
  writeFileSync(prof, [
    'language:', '  output: en',
    'fork:', '  triage:',
    '    home_city: Lisbon', '    home_country: Portugal',
    '    accepted_remote_countries: [Ukraine]',
    '    salary_floor: { amount: 48000, currency: EUR, period: year }',
    '    fx_to_usd: { EUR: 1.1 }',
    '    core_domains: [b2b_saas]',
    '  schedule:', '    hours: [8, 20]',
  ].join('\n'));
  const cfg = fc.loadConfig(prof);

  eq(cfg.language, 'en', 'language from profile.yml');
  eq(cfg.triage.scores.location.home_city, 20, 'defaults merged under user settings');
  eq(tri.rulesFrom(cfg).floorUsdMonth, 4400, 'salary floor converted to USD/month');
  eq(fc.loadConfig(join(dir, 'missing.yml')).triage.home_city, '', 'no profile → generic defaults');

  const job = (loc) => ({ company: 'C', title: 'T', location: loc, meta: loc, url: 'u' });
  const raw = (o) => JSON.stringify({ seniority: 'senior', employment: 'full_time', role_type: 'product_design', domain_tags: ['b2b_saas'], missing_requirements: [], hard_dq: [], location_type: 'unclear', location_country: '', summary: 's', risks: [], ...o });

  eq(tri.scoreFacts(raw({}), job('Lisbon, Portugal'), cfg).facts.location_type, 'home_city', 'home city detected from listing');
  eq(tri.scoreFacts(raw({ location_type: 'single_country_remote', location_country: 'Portugal' }), job('Remote'), cfg).facts.location_type, 'home_country_remote', 'single-country remote in home country');
  eq(tri.scoreFacts(raw({ location_type: 'single_country_remote', location_country: 'Ukraine' }), job('Remote'), cfg).parts.location, 14, 'accepted remote country scores 14');
  eq(tri.scoreFacts(raw({ location_type: 'single_country_remote', location_country: 'Germany' }), job('Remote'), cfg).parts.location, 7, 'other single-country remote scores 7');
  const onsite = tri.scoreFacts(raw({ location_type: 'onsite_elsewhere' }), job('Madrid'), cfg);
  eq([onsite.score <= 45, onsite.verdict], [true, 'Skip'], 'on-site elsewhere is capped and skipped');
  eq(tri.scoreFacts(raw({ salary: { min: 30000, max: 36000, currency: 'EUR', period: 'year' } }), job('Remote'), cfg).parts.comp, 3, 'pay below floor');
  eq(tri.scoreFacts(raw({ salary: { min: 60000, max: 70000, currency: 'EUR', period: 'year' } }), job('Remote'), cfg).parts.comp, 15, 'pay above floor');
  eq(tri.scoreFacts(raw({ location_type: 'region_remote' }), job('Remote'), cfg).verdict, 'Strong Apply', 'strong apply threshold');
  eq(tri.triageHeader('en').startsWith('# Triage'), true, 'english triage header');

  const md = '| 2026-10-08 | Apply | 70 | 25/25/14/0/6 | facts | Acme | Designer | what | r1 · r2 | [link](https://x.test/1) |';
  const rows = tg.parseTriage(md);
  eq([rows.length, rows[0].company, rows[0].url], [1, 'Acme', 'https://x.test/1'], 'telegram parses triage row');
  eq(tg.buildMessages(rows, 2, fc.STRINGS.en)[0].includes('New jobs: 1'), true, 'telegram message in English');
  eq(tg.formatItem({ ...rows[0], company: '<b>' }, fc.STRINGS.en).includes('&lt;b&gt;'), true, 'telegram escapes HTML');

  const plist = sch.buildPlist({ label: 'x.y', hours: [8, 20], root: '/r' });
  eq([plist.includes('<integer>8</integer>'), plist.includes('<integer>20</integer>'), plist.includes('/r/daily-run.sh')], [true, true, true], 'plist built from settings');
} catch (e) {
  fail(`fork local tools: ${e.stack || e.message}`);
}
