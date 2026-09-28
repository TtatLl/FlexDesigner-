#!/usr/bin/env node
'use strict';

/**
 * Copies the runtime native dependency (@napi-rs/canvas) into the plugin folder
 * before packing, so the generated .flexplugin is self-contained on machines
 * that do not run `npm install`.
 *
 *   node tools/prepare-pack.js            # current platform only
 *   node tools/prepare-pack.js --all      # every platform (bigger package)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'com.flexbar.qqmusicnow.plugin');
const SOURCE_MODULES = path.join(ROOT, 'node_modules');
const TARGET_MODULES = path.join(PLUGIN_DIR, 'node_modules');

const all = process.argv.includes('--all');
const PLATFORM_LABELS = {
  'canvas-win32-x64-msvc': 'Windows x64',
  'canvas-win32-arm64-msvc': 'Windows arm64',
  'canvas-darwin-x64': 'macOS Intel',
  'canvas-darwin-arm64': 'macOS Apple Silicon',
  'canvas-linux-x64-gnu': 'Linux x64',
  'canvas-linux-arm64-gnu': 'Linux arm64',
};
const PLATFORM_PACKAGES = [
  'canvas-win32-x64-msvc',
  'canvas-win32-arm64-msvc',
  'canvas-darwin-x64',
  'canvas-darwin-arm64',
  'canvas-linux-x64-gnu',
  'canvas-linux-arm64-gnu',
];

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else {
      try {
        fs.copyFileSync(source, target);
      } catch (err) {
        // The plugin may be running and holding native files (e.g. icudtl.dat)
        // open; keep the copy that is already in place.
        console.warn(`    ! skipped ${entry.name}: ${err.code || err.message}`);
      }
    }
  }
}

function copyPackage(name) {
  const from = path.join(SOURCE_MODULES, name);
  if (!fs.existsSync(from)) return false;
  copyDir(from, path.join(TARGET_MODULES, name));
  const size = fs
    .readdirSync(path.join(TARGET_MODULES, name))
    .length;
  console.log(`  + ${name} (${size} entries)`);
  return true;
}

function main() {
  if (!fs.existsSync(SOURCE_MODULES)) {
    console.error('node_modules not found - run `npm install` first.');
    process.exit(1);
  }
  if (!fs.existsSync(PLUGIN_DIR)) {
    console.error(`plugin folder not found: ${PLUGIN_DIR}`);
    process.exit(1);
  }

  console.log(`copying runtime dependencies into ${path.relative(ROOT, TARGET_MODULES)}`);

  // runtime.json (process lock + layout snapshot) stays as it is: the plugin
  // ignores snapshots for devices that are not connected, so a package built on
  // one machine is harmless on another.
  let copied = copyPackage('@napi-rs/canvas');
  if (!copied) console.warn('  ! @napi-rs/canvas missing - the packed plugin will fall back to text mode');

  const platformDir = path.join(SOURCE_MODULES, '@napi-rs');
  const installed = fs.existsSync(platformDir) ? fs.readdirSync(platformDir) : [];
  const wanted = all
    ? PLATFORM_PACKAGES
    : installed.filter((name) => PLATFORM_PACKAGES.includes(name));

  const bundled = [];
  const missing = [];
  for (const name of wanted) {
    const ok = copyPackage(path.join('@napi-rs', name));
    (ok ? bundled : missing).push(PLATFORM_LABELS[name] || name);
  }

  // Anything already copied by an earlier run counts as bundled too.
  for (const name of installed) {
    if (!PLATFORM_PACKAGES.includes(name)) continue;
    const label = PLATFORM_LABELS[name] || name;
    if (fs.existsSync(path.join(TARGET_MODULES, '@napi-rs', name)) && !bundled.includes(label)) {
      bundled.push(label);
    }
  }

  console.log(`platforms in package: ${bundled.join(', ') || '(none)'}`);
  if (all && missing.length) {
    console.warn(
      `  ! not available locally, run \`npm install @napi-rs/${missing
        .map((label) => Object.keys(PLATFORM_LABELS).find((key) => PLATFORM_LABELS[key] === label))
        .join(' @napi-rs/')}\` first if you need them: ${missing.join(', ')}`
    );
  }

  const totalBytes = (() => {
    let sum = 0;
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else sum += fs.statSync(full).size;
      }
    };
    walk(TARGET_MODULES);
    return sum;
  })();
  console.log(`done - bundled runtime deps: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
}

main();
