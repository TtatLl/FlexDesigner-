#!/usr/bin/env node
'use strict';

/**
 * Measures how long the macOS provider takes to notice that the song changed.
 *
 * It drives a fake MediaRemote adapter (perl script + state file) so the
 * measurement needs no device, no music player and no permissions:
 *
 *   node tools/probe-macos-latency.js
 *
 * Two runs are compared:
 *   base   - the regular sampling cadence
 *   hurry  - the cadence right after a skip press (nowPlaying.hurry())
 *
 * Numbers are the time between "the player published the new track" and
 * "provider.read() reports it", sampled every 10ms.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { MacOsMediaProvider } = require('../src/nowplaying/macos-media');

const SIM_ROOT = process.env.QQSIM_ROOT || path.join(os.tmpdir(), 'qqsim');
const BIN_DIR = path.join(SIM_ROOT, 'bin');
const STATE_FILE = path.join(SIM_ROOT, 'state.json');
const CLI = path.join(BIN_DIR, 'nowplaying-cli');
const ADAPTER = path.join(BIN_DIR, 'share', 'nowplaying-cli', 'scripts', 'mediaremote-mini.pl');
const DYLIB = path.join(BIN_DIR, 'lib', 'nowplaying-cli', 'MediaRemoteMini.dylib');

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function ensureSimulator() {
  fs.mkdirSync(path.dirname(ADAPTER), { recursive: true });
  fs.mkdirSync(path.dirname(DYLIB), { recursive: true });
  if (!fs.existsSync(ADAPTER)) {
    // Kept in sync with the copy this repo ships under /tmp/qqsim when the
    // measurement is run from the project.
    fs.writeFileSync(
      ADAPTER,
      `#!/usr/bin/perl
use strict;
use warnings;
use JSON::PP;
my $state_file = $ENV{QQSIM_STATE} || '${STATE_FILE}';
open(my $fh, '<', $state_file) or exit 0;
local $/;
my $raw = <$fh>;
close($fh);
my $data = eval { decode_json($raw) };
exit 0 unless $data;
my $playing = $data->{playing} ? JSON::PP::true() : JSON::PP::false();
print encode_json({
    title        => $data->{title}        // '',
    artist       => $data->{artist}       // '',
    album        => $data->{album}        // '',
    duration     => $data->{duration}     // 0,
    elapsedTime  => $data->{elapsedTime}  // 0,
    playbackRate => $data->{playbackRate} // 0,
    playing      => $playing,
    timestamp    => $data->{timestamp}    // '',
    # The provider only accepts QQ Music sessions, so the fake adapter has to
    # claim a bundle id; QQ Music's is the default, another one simulates a
    # player that stole the media session.
    bundleIdentifier => $data->{bundleIdentifier} // 'com.tencent.QQMusicMac',
});
`
    );
    fs.chmodSync(ADAPTER, 0o755);
  }
  if (!fs.existsSync(CLI)) fs.writeFileSync(CLI, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(CLI, 0o755);
  if (!fs.existsSync(DYLIB)) fs.writeFileSync(DYLIB, 'placeholder\n');
}

function publish(title, artist) {
  const payload = JSON.stringify({
    title,
    artist,
    album: '专辑',
    duration: 240,
    elapsedTime: 5,
    playbackRate: 1,
    playing: true,
    timestamp: new Date().toISOString(),
  });
  // Rename into place: the adapter reads this file, and a torn read would look
  // like "player reports nothing".
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, payload);
  fs.renameSync(temp, STATE_FILE);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure({ mode, intervalMs }) {
  publish('before', '旧歌手');
  const provider = new MacOsMediaProvider({
    logger,
    scriptPath: path.join(BIN_DIR, '..', 'nowplaying.jxa'),
    cliPath: CLI,
    intervalMs,
  });
  await provider.start();

  // Wait until the provider has the "before" track, so the measurement starts
  // from a known state.
  const ready = Date.now() + 3000;
  while (Date.now() < ready && provider.read()?.title !== 'before') await sleep(20);

  if (mode === 'hurry') provider.hurry({ windowMs: 4000, intervalMs: 200 });
  const publishedAt = Date.now();
  publish('after', '新歌手');

  while (Date.now() - publishedAt < 5000) {
    if (provider.read()?.title === 'after') break;
    await sleep(10);
  }
  const latency = Date.now() - publishedAt;
  const title = provider.read()?.title;
  provider.stop();

  // Let the fast window expire quietly before the next run starts.
  await sleep(mode === 'hurry' ? 200 : 100);
  return { latency, title, interval: provider.currentIntervalMs };
}

async function main() {
  if (process.platform !== 'darwin') {
    console.error('this probe simulates the macOS provider; run it on macOS');
  }
  ensureSimulator();

  const runs = [];
  for (const mode of ['base', 'hurry']) {
    const samples = [];
    for (let i = 0; i < 3; i += 1) {
      samples.push(await measure({ mode, intervalMs: 1000 }));
    }
    const latencies = samples.map((s) => s.latency);
    const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
    runs.push({ mode, latencies, avg, interval: samples[0].interval });
    console.log(
      `${mode.padEnd(6)} sampling=${String(samples[0].interval).padStart(4)}ms  ` +
        `detected after ${latencies.map((l) => `${l}ms`).join(', ')}  avg=${avg}ms`
    );
  }

  const base = runs.find((r) => r.mode === 'base').avg;
  const hurry = runs.find((r) => r.mode === 'hurry').avg;
  console.log(`\nhurry is ${base - hurry}ms faster on average (${base}ms -> ${hurry}ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
