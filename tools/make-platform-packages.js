#!/usr/bin/env node
'use strict';

/**
 * Builds platform specific .flexplugin packages.
 *
 * FlexDesigner picks an OS/architecture specific asset when it downloads a
 * plugin (it looks for names like `<name>.<platform>.<arch>.flexplugin`), and a
 * platform package is much smaller than the all-platform one.
 *
 *   node tools/make-platform-packages.js                # uses flexcli from PATH
 *   node tools/make-platform-packages.js --flexcli "node path/to/flexcli/index.js"
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN_NAME = 'com.flexbar.qqmusicnow.plugin';
const PLUGIN_DIR = path.join(ROOT, PLUGIN_NAME);
const SOURCE_MODULES = path.join(ROOT, 'node_modules', '@napi-rs');
const DIST = path.join(ROOT, 'dist');
// Keep the staging area inside the repo: it used to live two levels up, which
// happens to work locally but writes outside the checkout in CI.
const STAGE_ROOT = path.join(ROOT, '.pkg-stage');

const TARGETS = [
  { label: 'macos.arm64', packages: ['canvas', 'canvas-darwin-arm64'], note: 'macOS Apple Silicon' },
  { label: 'macos.x64', packages: ['canvas', 'canvas-darwin-x64'], note: 'macOS Intel' },
  { label: 'windows.x64', packages: ['canvas', 'canvas-win32-x64-msvc'], note: 'Windows x64' },
  {
    label: 'generic',
    packages: ['canvas', 'canvas-darwin-arm64', 'canvas-darwin-x64', 'canvas-win32-x64-msvc'],
    note: 'all platforms',
  },
];

function copyDir(from, to, { skip = [] } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target, { skip });
    else fs.copyFileSync(source, target);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function main() {
  const args = process.argv.slice(2);
  const flexcliIndex = args.indexOf('--flexcli');
  const flexcli = flexcliIndex >= 0 ? args[flexcliIndex + 1] : 'flexcli';
  // --only=<label>[,<label>] limits the run to specific targets, so a Windows
  // build can be produced without touching the macOS packages.
  const onlyArg = args.find((arg) => arg.startsWith('--only='));
  const only = onlyArg
    ? onlyArg
        .slice('--only='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : null;
  const targets = only ? TARGETS.filter((target) => only.includes(target.label)) : TARGETS;
  if (only && !targets.length) {
    console.error(`--only did not match any target (available: ${TARGETS.map((t) => t.label).join(', ')})`);
    process.exit(1);
  }

  if (!fs.existsSync(PLUGIN_DIR)) {
    console.error(`plugin folder missing: ${PLUGIN_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(SOURCE_MODULES)) {
    console.error('node_modules/@napi-rs missing - run `npm install` first');
    process.exit(1);
  }
  fs.mkdirSync(DIST, { recursive: true });

  for (const target of targets) {
    const stageBase = path.join(STAGE_ROOT, target.label);
    const stagePlugin = path.join(stageBase, PLUGIN_NAME);
    fs.rmSync(stageBase, { recursive: true, force: true });
    fs.mkdirSync(stageBase, { recursive: true });

    // copy the plugin without per-machine state
    // `cache` holds per-machine lyric cache, `runtime.json` the process lock and
    // key layout snapshot: neither belongs in a distributed package.
    copyDir(PLUGIN_DIR, stagePlugin, { skip: ['node_modules', 'logs', 'runtime.json', 'cache'] });

    // add only the runtime libraries this platform needs
    for (const packageName of target.packages) {
      const source = path.join(SOURCE_MODULES, packageName);
      if (!fs.existsSync(source)) {
        console.warn(`  ! ${packageName} not installed locally - skipping ${target.label}`);
      }
      copyDir(source, path.join(stagePlugin, 'node_modules', '@napi-rs', packageName));
    }

    const command = flexcli.endsWith('.js') ? process.execPath : flexcli;
    const commandArgs = flexcli.endsWith('.js')
      ? [flexcli, 'plugin', 'pack', '--path', stagePlugin]
      : ['plugin', 'pack', '--path', stagePlugin];
    const result = spawnSync(command, commandArgs, { encoding: 'utf8' });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0 || !fs.existsSync(path.join(stageBase, 'com.flexbar.qqmusicnow.flexplugin'))) {
      console.error(`  pack failed for ${target.label}:\n${output}`);
      continue;
    }

    const built = path.join(stageBase, 'com.flexbar.qqmusicnow.flexplugin');
    const renamed = path.join(DIST, `com.flexbar.qqmusicnow.${target.label}.flexplugin`);
    fs.copyFileSync(built, renamed);
    console.log(
      `  ${target.label.padEnd(12)} ${target.note.padEnd(22)} ` +
        `${(fs.statSync(renamed).size / 1024 / 1024).toFixed(1)} MB  -> ${path.relative(ROOT, renamed)}`
    );
  }

  console.log('\npackages:');
  for (const file of fs.readdirSync(DIST)) {
    const full = path.join(DIST, file);
    console.log(`  ${file}  ${(fs.statSync(full).size / 1024 / 1024).toFixed(1)} MB`);
  }
  console.log(`staging dir: ${STAGE_ROOT}`);
}

main();
