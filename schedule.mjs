#!/usr/bin/env node
// schedule.mjs — fork-local. Runs daily-run.sh on a schedule via macOS launchd.
// Hours come from `fork.schedule.hours` in config/profile.yml (default 9, 14, 19).
//
// Usage (macOS):
//   node schedule.mjs install     # write ~/Library/LaunchAgents/<label>.plist and load it
//   node schedule.mjs uninstall   # unload and remove it
//   node schedule.mjs status      # show whether it is loaded
//   node schedule.mjs run         # start one run now (same as the scheduled one)
//   node schedule.mjs print       # print the plist without installing

import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, DATA_ROOT, loadConfig } from './fork-config.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function buildPlist({ label, hours, root, dataRoot = root }) {
  const times = hours.map((h) => `    <dict><key>Hour</key><integer>${Number(h)}</integer><key>Minute</key><integer>0</integer></dict>`).join('\n');
  const log = esc(join(dataRoot, 'data', 'launchd.log'));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(label)}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>${esc(join(root, 'daily-run.sh'))}</string></array>
  <key>StartCalendarInterval</key>
  <array>
${times}
  </array>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function main() {
  const cmd = process.argv[2] || 'status';
  const { schedule } = loadConfig();
  const label = schedule.label;
  const hours = (schedule.hours || []).filter((h) => Number.isInteger(Number(h)) && h >= 0 && h <= 23);
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const domain = `gui/${userInfo().uid}`;
  const plist = buildPlist({ label, hours, root: ROOT, dataRoot: DATA_ROOT });

  if (cmd === 'print') { process.stdout.write(plist); return; }
  if (process.platform !== 'darwin') { console.error('launchd is macOS-only. On Linux use cron: run daily-run.sh at the hours you want.'); process.exit(1); }

  if (cmd === 'install') {
    if (!hours.length) { console.error('No valid hours in fork.schedule.hours'); process.exit(1); }
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    launchctl('bootout', `${domain}/${label}`); // reinstall cleanly if already loaded
    writeFileSync(plistPath, plist);
    const r = launchctl('bootstrap', domain, plistPath);
    if (!r.ok) { console.error(`launchctl bootstrap failed: ${r.out}`); process.exit(1); }
    console.log(`Installed ${label}: runs daily at ${hours.map((h) => `${h}:00`).join(', ')}\nPlist: ${plistPath}`);
  } else if (cmd === 'uninstall') {
    launchctl('bootout', `${domain}/${label}`);
    if (existsSync(plistPath)) unlinkSync(plistPath);
    console.log(`Removed ${label}.`);
  } else if (cmd === 'run') {
    const r = launchctl('kickstart', `${domain}/${label}`);
    console.log(r.ok ? 'Started. Log: data/daily-run.log' : `Not installed? ${r.out}`);
  } else {
    const r = launchctl('print', `${domain}/${label}`);
    console.log(r.ok ? r.out.split('\n').slice(0, 6).join('\n') : `${label} is not installed.`);
  }
}

if (isMainModule(import.meta.url)) main();
