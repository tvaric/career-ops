# Fork additions: local triage, Ukrainian job boards, Telegram alerts

This fork of [santifer/career-ops](https://github.com/santifer/career-ops) adds an
unattended pipeline that runs on your own Mac:

1. **Scan** job boards and company career pages (upstream `scan.mjs`, plus two new providers: DOU and Djinni).
2. **Triage** each new posting with a **local** LLM via [Ollama](https://ollama.com) — no cloud model, no API cost.
3. **Notify** you in Telegram about new postings worth a look, with score, facts, risks and a link.
4. **Repeat** on a schedule (macOS launchd), e.g. three times a day.

You read the Telegram message, open the posting, and decide whether to apply.
Nothing is ever submitted on your behalf.

---

## What was added

| File | Purpose |
|---|---|
| `providers/dou.mjs` | [jobs.dou.ua](https://jobs.dou.ua) RSS feed (filter by category, search term, years of experience). |
| `providers/djinni.mjs` | [djinni.co](https://djinni.co) RSS feed; optionally opens each posting to read company and location from its JSON-LD. |
| `local-triage.mjs` | Local-model triage. The model only **extracts facts** (seniority, location type, salary, domain, missing requirements); the **score is computed in code** from your settings, so results are reproducible and explainable. |
| `fork-config.mjs` | Loads settings (`fork:` block in `config/profile.yml`) and defaults; UI strings in English and Ukrainian. |
| `notify-telegram.mjs` | Sends new triage rows to a Telegram bot chat; each posting is sent once. |
| `daily-run.sh` | One full run: start Ollama if needed → scan → triage → Telegram. Sends a Telegram alert if a step fails. |
| `schedule.mjs` | Installs / removes the launchd job that runs `daily-run.sh` at the hours you choose. |
| `config/fork.example.yml` | Example settings block. |
| `modes/_brief.example.md` | Template for `modes/_brief.md`, the short candidate brief the model reads. |
| `tests/providers/dou-djinni.test.mjs`, `tests/fork/local-tools.test.mjs` | Tests (run with `node test-all.mjs`). |

---

## How a posting is scored (0–100)

| Part | Max | Based on |
|---|---|---|
| Level | 25 | seniority (senior/lead score highest; configurable) |
| Domain | 25 | posting's domain tags vs. your `core_domains`, `adjacent_domains`, `weak_domains` |
| Location | 20 | home city, remote in home country, remote in your regions, accepted remote countries, other |
| Pay | 15 | stated salary vs. your `salary_floor` (unknown pay gets a middle score) |
| Must-haves | 15 | minus 5 per hard requirement the model says you lack (judged against `modes/_brief.md`) |

Hard disqualifiers (on-site outside your home city, role types in `dq_role_types`, or criteria in your brief)
cap the score at 45. Verdicts: **Strong Apply** ≥ 80, **Apply** ≥ 65, **Low Priority** ≥ 50, otherwise **Skip**.
All weights and thresholds can be changed in settings.

---

## Where it reads and writes

Everything stays inside the repo folder. All of these paths are gitignored by upstream, so personal data is never committed.

| Path | Read / write | Contents |
|---|---|---|
| `config/profile.yml` | read | your profile + the `fork:` settings block |
| `modes/_brief.md` | read | short candidate brief the model uses to judge missing requirements |
| `portals.yml` | read | which boards and companies to scan |
| `data/pipeline.md` | written by `scan.mjs` | new postings waiting for triage |
| `data/applications.md` | read | your tracker; postings you already applied to are marked, not re-evaluated |
| `data/triage.md` | append | one row per triaged posting |
| `jds/*.txt` | write | cached job-description text |
| `data/notified.txt` | append | URLs already sent to Telegram |
| `data/daily-run.log`, `data/launchd.log` | append | run logs |
| `.env` | read | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| `~/Library/LaunchAgents/com.career-ops.daily.plist` | write (by `schedule.mjs install`) | the schedule |

## What goes over the network

- Job boards and career pages you list in `portals.yml` (plain HTTP fetches; JS-rendered pages through headless Chromium, as upstream).
- `http://localhost:11434` — your local Ollama. The job description and your brief go **only** to this local model.
- `https://api.telegram.org` — the triage summary of new postings, sent to **your** bot chat.

No other service receives your data.

---

## Setup

Requirements: macOS (for the scheduler; the rest runs anywhere Node runs), Node.js 20+, Ollama, about 10 GB free for a 12B model.
Tested on a MacBook Pro M1 with 16 GB RAM and `gemma4:12b`.

1. Install upstream career-ops as usual (`npm install`, `cv.md`, `config/profile.yml`, `portals.yml` — see the main [README](../README.md)).
2. Pull a model: `ollama pull gemma4:12b`.
3. Copy the `fork:` block from [`config/fork.example.yml`](../config/fork.example.yml) into `config/profile.yml` and edit it
   (home city/country, salary floor, domains). Set `language.output` to `en` or `uk`.
4. Write a short brief: `cp modes/_brief.example.md modes/_brief.md` and fill it in — who you are, target roles,
   what you have and have not done, hard disqualifiers. Keep it under ~2K tokens: the model reads it with every posting.
5. Add DOU / Djinni (optional) to `portals.yml` under `job_boards`, e.g.
   ```yaml
   - { name: DOU Design, provider: dou, category: Design, exp: 5plus, enabled: true }
   - { name: Djinni Design, provider: djinni, primary_keyword: Design, exp_level: 5y, fetchDetails: true, enabled: true }
   ```
6. Telegram: create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`), send it any message, then
   ```
   echo 'TELEGRAM_BOT_TOKEN=<token>' >> .env
   node notify-telegram.mjs --chat-id          # prints TELEGRAM_CHAT_ID=...
   echo 'TELEGRAM_CHAT_ID=<id>' >> .env
   node notify-telegram.mjs --test
   ```
7. Try one run by hand: `bash daily-run.sh`, then check `data/triage.md` and `data/daily-run.log`.
8. If `data/triage.md` already has rows you don't want sent: `node notify-telegram.mjs --init`.
9. Schedule it: `node schedule.mjs install` (hours from `fork.schedule.hours`).

If the Mac is asleep at a scheduled time, launchd runs the job when it wakes; if it is off, that run is skipped.

---

## Commands

| What | Command |
|---|---|
| Full run now | `bash daily-run.sh` or `node schedule.mjs run` |
| Triage only, N postings | `node local-triage.mjs --limit N` |
| Triage one posting | `node local-triage.mjs --url <posting-url>` |
| Preview Telegram messages | `node notify-telegram.mjs --dry-run` |
| Schedule status / remove | `node schedule.mjs status` / `node schedule.mjs uninstall` |
| Run log | `tail -30 data/daily-run.log` |
| Tests | `node test-all.mjs --only fork` and `--only dou-djinni` |

---

## Known limitations

- A 12B model sometimes misreads location rules (for example, flags a remote role as on-site). Check the Facts column before skipping a high-value posting.
- Outstaffing agencies are not always tagged as such.
- `browser-extract.mjs` (upstream) does not expand collapsed "View more" sections, e.g. on Welcome to the Jungle, so requirements such as a spoken language can be missed.
- Triage processes at most `limit_per_run` postings per run; a large backlog is worked through over several runs.
