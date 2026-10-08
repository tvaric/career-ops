#!/usr/bin/env node
// notify-telegram.mjs — fork-local (listed in config/local-paths.txt).
// Sends new rows of data/triage.md to Telegram. Remembers what was sent in
// data/notified.txt (one posting URL per line), so each posting is sent once.
//
// Setup: put TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env. Which verdicts are sent:
// `fork.notify.verdicts` in config/profile.yml. Message language: `language.output`.
//
// Usage:
//   node notify-telegram.mjs              # send new rows (verdicts from settings)
//   node notify-telegram.mjs --chat-id    # print your chat id (message the bot first)
//   node notify-telegram.mjs --init       # mark every current row as sent, send nothing
//   node notify-telegram.mjs --dry-run    # print the messages instead of sending
//   node notify-telegram.mjs --test       # send one test message
//   node notify-telegram.mjs --error "…"  # send an error notice (used by daily-run.sh)

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, loadConfig, loadEnv, STRINGS } from './fork-config.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const TRIAGE = join(DATA_ROOT, 'data', 'triage.md');
const SENT = join(DATA_ROOT, 'data', 'notified.txt');
const ICON = { 'Strong Apply': '🟢', Apply: '🔵', 'Low Priority': '🟡' };
const MAX_LEN = 3800; // Telegram limit is 4096 chars per message


export function parseTriage(md) {
  const rows = [];
  for (const line of md.split('\n')) {
    if (!/^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(line)) continue;
    const c = line.split(' | ').map((x) => x.replace(/^\|\s*|\s*\|$/g, '').trim());
    if (c.length < 10) continue;
    const url = (c[9].match(/\((https?:[^)]+)\)/) || [])[1] || '';
    rows.push({ date: c[0], verdict: c[1], score: c[2], parts: c[3], facts: c[4], company: c[5], role: c[6], what: c[7], risks: c[8], url });
  }
  return rows;
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatItem(r, S = STRINGS.en) {
  const risks = r.risks ? r.risks.split(' · ').map((x) => `• ${esc(x)}`).join('\n') : '';
  return [
    `${ICON[r.verdict] || '⚪'} <b>${esc(r.verdict)} · ${esc(r.score)}</b> — <b>${esc(r.company)}</b>`,
    esc(r.role),
    `<i>${esc(r.facts)}</i>`,
    `${S.scoresLine}: ${esc(r.parts)}`,
    esc(r.what),
    risks,
    r.url ? `<a href="${esc(r.url)}">${S.open}</a>` : '',
  ].filter(Boolean).join('\n');
}

export function buildMessages(rows, skipped, S = STRINGS.en) {
  const order = { 'Strong Apply': 0, Apply: 1, 'Low Priority': 2 };
  rows = [...rows].sort((a, b) => (order[a.verdict] - order[b.verdict]) || (Number(b.score) - Number(a.score)));
  const head = `<b>${S.newJobs(rows.length)}</b>${skipped ? ` ${S.filtered(skipped)}` : ''}`;
  const msgs = []; let cur = head;
  for (const r of rows) {
    const item = formatItem(r, S);
    if ((cur + '\n\n' + item).length > MAX_LEN) { msgs.push(cur); cur = item; } else cur += '\n\n' + item;
  }
  msgs.push(cur);
  return msgs;
}

async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Немає TELEGRAM_BOT_TOKEN у .env');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || res.status}`);
  return j.result;
}

async function send(text) {
  const chat_id = process.env.TELEGRAM_CHAT_ID;
  if (!chat_id) throw new Error('Немає TELEGRAM_CHAT_ID у .env (дізнайся: node notify-telegram.mjs --chat-id)');
  await tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true });
}

async function main() {
  loadEnv();
  const cfg = loadConfig();
  const S = STRINGS[cfg.language];
  const SEND_VERDICTS = new Set(cfg.notify.verdicts);
  const args = process.argv.slice(2);
  if (args.includes('--chat-id')) {
    const ups = await tg('getUpdates', {});
    const ids = [...new Set(ups.map((u) => u.message?.chat?.id).filter(Boolean))];
    console.log(ids.length ? `TELEGRAM_CHAT_ID=${ids[ids.length - 1]}` : 'Повідомлень нема. Напиши боту будь-що в Telegram і запусти ще раз.');
    return;
  }
  if (args.includes('--test')) { await send(S.testMsg); console.log('Надіслано.'); return; }
  const ei = args.indexOf('--error');
  if (ei >= 0) { await send(`${S.failMsg}\n<code>${esc(args[ei + 1] || '')}</code>`); return; }

  const rows = existsSync(TRIAGE) ? parseTriage(readFileSync(TRIAGE, 'utf8')) : [];
  const sent = new Set(existsSync(SENT) ? readFileSync(SENT, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : []);
  const seen = new Set();   // triage.md can hold the same URL twice (re-runs); keep the latest row
  const fresh = rows.reverse().filter((r) => r.url && !sent.has(r.url) && !seen.has(r.url) && seen.add(r.url));
  const markSent = (list) => list.length && appendFileSync(SENT, list.map((r) => r.url).join('\n') + '\n');

  if (args.includes('--init')) { markSent(fresh); console.log(`Позначено як надіслані: ${fresh.length}. Далі прийдуть тільки нові.`); return; }

  const toSend = fresh.filter((r) => SEND_VERDICTS.has(r.verdict));
  const skipped = fresh.length - toSend.length;
  if (!toSend.length) { console.log(`Нових для надсилання немає (відсіяно: ${skipped}).`); markSent(fresh); return; }

  const msgs = buildMessages(toSend, skipped, S);
  if (args.includes('--dry-run')) { msgs.forEach((m, i) => console.log(`--- повідомлення ${i + 1} ---\n${m}\n`)); return; }
  for (const m of msgs) await send(m);
  markSent(fresh);
  console.log(`Надіслано вакансій: ${toSend.length} (${msgs.length} повідомл.), відсіяно: ${skipped}.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(`Помилка: ${e.message}`); process.exit(1); });
}
