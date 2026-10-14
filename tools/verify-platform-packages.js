#!/usr/bin/env node
'use strict';

/**
 * Checks that every .flexplugin in dist/ carries the native canvas library for
 * its own platform - and nothing else.
 *
 * This is the failure that motivated the script: built on a Linux CI runner,
 * every package used to contain the Linux skia binding, so the plugin installed
 * on macOS/Windows silently lost its canvas rendering (degraded to text mode).
 *
 *   node tools/verify-platform-packages.js
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DIST = path.join(__dirname, '..', 'dist');
const EXPECTED = {
  'macos.arm64': ['canvas-darwin-arm64'],
  'macos.x64': ['canvas-darwin-x64'],
  'windows.x64': ['canvas-win32-x64-msvc'],
  generic: ['canvas-darwin-arm64', 'canvas-darwin-x64', 'canvas-win32-x64-msvc'],
};

function nativeLibsIn(file) {
  const listing = spawnSync('unzip', ['-l', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error(`unzip failed for ${path.basename(file)}`);
  const found = new Set();
  for (const line of String(listing.stdout).split('\n')) {
    const match = line.match(/@napi-rs\/(canvas-(?:darwin|win32|linux)[A-Za-z0-9_.-]*)\//);
    if (match) found.add(match[1]);
  }
  return [...found].sort();
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error(`dist/ not found - run "node tools/make-platform-packages.js" first`);
    process.exit(1);
  }
  const packages = fs.readdirSync(DIST).filter((name) => name.endsWith('.flexplugin'));
  if (!packages.length) {
    console.error('no .flexplugin in dist/');
    process.exit(1);
  }

  let failures = 0;
  for (const name of packages.sort()) {
    const label = Object.keys(EXPECTED).find((key) => name.includes(`.${key}.`) || name === `com.flexbar.qqmusicnow.${key}.flexplugin`);
    const expected = label ? EXPECTED[label] : null;
    const found = nativeLibsIn(path.join(DIST, name));
    if (!expected) {
      console.log(`?  ${name}: unknown platform label, native libs = ${found.join(', ') || '(none)'}`);
      continue;
    }
    const missing = expected.filter((lib) => !found.includes(lib));
    const extra = found.filter((lib) => !expected.includes(lib));
    const ok = !missing.length && !extra.length;
    if (!ok) failures += 1;
    console.log(
      `${ok ? 'OK ' : 'BAD'} ${name}: ${found.join(', ') || '(none)'}` +
        (missing.length ? ` | 缺少 ${missing.join(', ')}` : '') +
        (extra.length ? ` | 多出 ${extra.join(', ')}` : '')
    );
  }

  if (failures) {
    console.error(`\n${failures} package(s) carry the wrong native library`);
    process.exit(1);
  }
  console.log('\nall packages carry the right native library');
}

main();
