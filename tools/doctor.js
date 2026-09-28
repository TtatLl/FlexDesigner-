#!/usr/bin/env node
'use strict';

/**
 * Environment diagnostics. Run `npm run doctor` on the machine that runs
 * FlexDesigner when the plugin does not pick up QQ Music playback:
 *
 *   node tools/doctor.js ["song title - artist"] [--lyrics]
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(ROOT, 'com.flexbar.qqmusicnow.plugin');
const HELPER_DIR = path.join(PLUGIN_DIR, 'helper');

const args = process.argv.slice(2);
const withLyrics = args.includes('--lyrics');
const query = args.find((arg) => !arg.startsWith('--')) || '起风了 买辣椒也用券';

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function check(label, ok, detail = '') {
  console.log(`${ok ? '  [ok]  ' : '  [!!]  '}${label}${detail ? ` - ${detail}` : ''}`);
}

async function main() {
  console.log('QQMusicNow doctor');
  console.log(`platform: ${process.platform} ${process.arch}`);
  console.log(`node: ${process.version}`);

  section('Files');
  for (const relative of ['manifest.json', 'config.json', 'entry backend/plugin.cjs (build output)']) {
    const isBackend = relative.startsWith('entry');
    const target = isBackend ? path.join(PLUGIN_DIR, 'backend', 'plugin.cjs') : path.join(PLUGIN_DIR, relative);
    check(relative, fs.existsSync(target));
  }
  for (const helper of ['windows/smtc.ps1', 'windows/media-key.ps1', 'macos/nowplaying.jxa', 'macos/media-key.jxa']) {
    check(`helper/${helper}`, fs.existsSync(path.join(HELPER_DIR, helper)));
  }

  section('Renderer');
  const engine = require(path.join(ROOT, 'src', 'render', 'engine.js'));
  check('@napi-rs/canvas', engine.isAvailable(), engine.getLoadError() || '');
  if (engine.isAvailable()) {
    const { ensureFont } = require(path.join(ROOT, 'src', 'render', 'fonts.js'));
    const font = ensureFont({ info: () => {}, warn: () => {} });
    check('CJK font', true, `${font.family} (${font.source})`);
  } else {
    console.log('        without canvas the plugin still works, but lyric/now-playing keys fall back to plain text.');
  }

  section('QQ Music API');
  let api = null;
  try {
    api = require(path.join(ROOT, 'src', 'lyrics', 'qqmusic-api.js'));
  } catch (err) {
    check('dependencies installed', false, err.message);
    console.log('        run `npm install` in the project folder first.');
  }
  try {
    if (!api) throw new Error('skipped (dependencies missing)');
    const started = Date.now();
    const songs = await api.searchSongs(query, { limit: 3 });
    check('search', songs.length > 0, `${songs.length} result(s) in ${Date.now() - started}ms`);
    if (songs[0]) {
      console.log(`        ${songs[0].title} - ${songs[0].artists.join(', ')}`);
    }
    if (withLyrics && songs[0]) {
      const qrc = await api.fetchQrcLyric(songs[0].songId);
      check('QRC lyrics', !!(qrc && qrc.lines.length), qrc ? `${qrc.lines.length} lines` : 'no payload');
      const lrc = await api.fetchPlainLyric(songs[0].songMid);
      check('LRC fallback', !!(lrc && lrc.lines.length), lrc ? `${lrc.lines.length} lines` : 'no payload');
    }
  } catch (err) {
    check('search', false, err.message);
  }

  section('Now playing detection');
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HELPER_DIR, 'windows', 'smtc.ps1'), '-Once'],
      { encoding: 'utf8', timeout: 20000 }
    );
    if (result.error) check('SMTC helper', false, result.error.message);
    else {
      const lines = String(result.stdout || '').split('\n').filter(Boolean);
      const last = lines[lines.length - 1] || '';
      let payload = null;
      try {
        payload = JSON.parse(last);
      } catch {
        /* ignore */
      }
      if (payload && payload.type === 'sample') {
        const sessions = payload.sessions || [];
        const qq = sessions.find((s) => /qqmusic|qq音乐/i.test(s.appId || ''));
        check('SMTC available', true, `${sessions.length} session(s)`);
        check('QQ Music session', !!qq, qq ? `${qq.title} - ${qq.artist} (${qq.status})` : 'start playback in QQ Music and retry');
      } else {
        check('SMTC available', false, payload?.message || result.stderr || 'no output');
        console.log('        tip: media sessions need a normal desktop session; they are absent on server/VM machines.');
      }
    }
  } else if (process.platform === 'darwin') {
    const { resolveNowPlayingCli } = require('../src/nowplaying/macos-media');
    const cli = resolveNowPlayingCli();
    let cliUsable = false;
    if (!cli) {
      check('nowplaying-cli', false, 'not found - install it into ~/bin, /opt/homebrew/bin or /usr/local/bin');
      console.log('        macOS 15+ cannot expose MediaRemote to scripts, so this helper is required.');
    } else {
      const probe = spawnSync(cli, ['get', 'title', 'artist'], { encoding: 'utf8', timeout: 8000 });
      const [title, artist] = String(probe.stdout || '').trim().split('\n');
      cliUsable = probe.status === 0 && !!title && title !== 'null';
      check(
        'nowplaying-cli',
        cliUsable,
        cliUsable
          ? `${cli} -> ${title}${artist && artist !== 'null' ? ` - ${artist}` : ''}`
          : `${cli} - installed, but no track reported (start playback in QQ Music)`
      );
    }
    // The JXA fallback cannot work on macOS 15+; only probe it when the CLI is
    // unavailable, so a healthy setup is not reported as broken.
    if (!cliUsable) {
      const jxa = spawnSync('osascript', ['-l', 'JavaScript', path.join(HELPER_DIR, 'macos', 'nowplaying.jxa')], {
        encoding: 'utf8',
        timeout: 15000,
      });
      const last = String(jxa.stdout || '').trim().split('\n').pop() || '';
      let payload = null;
      try {
        payload = JSON.parse(last);
      } catch {
        /* ignore */
      }
      if (payload && payload.type === 'sample') {
        check('MediaRemote (JXA)', true, `${payload.session.title} - ${payload.session.artist}`);
      } else {
        check('MediaRemote (JXA)', false, payload?.message || jxa.stderr || 'no output');
        console.log('        MediaRemote is not reachable from JXA on macOS 15+; the plugin falls back to');
        console.log('        the window-title provider and manual mode, which need no helper.');
      }
    }
  } else {
    console.log('  [--]  unsupported platform for now-playing detection; use window-title or manual mode.');
  }

  section('Window title fallback');
  console.log('  The window-title provider reads titles through FlexDesigner (plugin.getOpenedWindows()),');
  console.log('  so it can only be exercised inside the running plugin.');

  console.log('\nDone. Report the output above when opening an issue.');
}

main().catch((err) => {
  console.error('doctor failed:', err);
  process.exit(1);
});
