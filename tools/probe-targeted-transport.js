#!/usr/bin/env node
'use strict';

/**
 * Does `MRMediaRemoteSendCommandToApp` really reach QQ Music?
 *
 * macOS sends media keys to whichever app owns the system media session, so a
 * play/pause key aimed at QQ Music hits a browser video instead (2026-10-13
 * log: pause key paused the video, QQ Music kept playing). The private function
 * below is the only way to address a specific app, but its argument shape is
 * undocumented - this probe answers whether it works.
 *
 * Run it like this, with BOTH playing:
 *   1. start the web video
 *   2. start QQ Music
 *   3. node tools/probe-targeted-transport.js pause
 *
 * Then check which one actually paused. Same call with `play` to undo it.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const { resolveNowPlayingCli } = require('../src/nowplaying/macos-media');

const HELPERS = path.join(__dirname, '..', 'com.flexbar.qqmusicnow.plugin', 'helper', 'macos');
const KEY_HELPER = path.join(HELPERS, 'media-key.jxa');
const QQ_BUNDLE_ID = 'com.tencent.QQMusicMac';

const ACTION_CODES = { play: 0, pause: 1, playpause: 2, toggle: 2 };

function readSession() {
  const cli = resolveNowPlayingCli();
  if (!cli) return { error: 'nowplaying-cli not found (install the helper first)' };
  const result = spawnSync(cli, ['get-raw'], { encoding: 'utf8', timeout: 15000 });
  const text = String(result.stdout || '').trim();
  if (!text) return { error: 'nowplaying-cli returned nothing' };
  try {
    const dict = JSON.parse(text);
    const key = (name) => dict[`kMRMediaRemoteNowPlayingInfo${name}`];
    return {
      appId: dict.kMRMediaRemoteNowPlayingInfoClientBundleIdentifier || '(unknown)',
      title: key('Title') || '(none)',
      playing: key('PlaybackRate'),
    };
  } catch (err) {
    return { error: `could not parse get-raw output: ${err.message}` };
  }
}

function describe(session) {
  if (!session || session.error) return `读取失败：${session?.error || 'unknown'}`;
  return `会话属于 ${session.appId} | 曲目 "${session.title}" | rate=${session.playing}`;
}

function send(action, targetApp) {
  const args = ['-l', 'JavaScript', KEY_HELPER, action];
  if (targetApp) args.push(targetApp);
  const result = spawnSync('osascript', args, { encoding: 'utf8', timeout: 15000 });
  const line = String(result.stdout || '').trim().split('\n').pop() || '';
  return { status: result.status, stdout: line, stderr: String(result.stderr || '').trim() };
}

function main() {
  const action = (process.argv[2] || 'pause').toLowerCase();
  if (!(action in ACTION_CODES)) {
    console.error(`usage: node tools/probe-targeted-transport.js [${Object.keys(ACTION_CODES).join('|')}]`);
    process.exit(1);
  }
  if (process.platform !== 'darwin') {
    console.error('this probe is macOS only');
    process.exit(1);
  }

  console.log(`1) 发送前  ${describe(readSession())}`);

  const targeted = send(action, QQ_BUNDLE_ID);
  console.log(`2) 定向发送 ${action} -> ${QQ_BUNDLE_ID}`);
  console.log(`   返回码 ${targeted.status} | ${targeted.stdout || '(no output)'}` +
    (targeted.status !== 0 ? ` | stderr: ${targeted.stderr.slice(0, 200)}` : ''));

  // The player needs a moment before the new state shows up in the session.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  console.log(`3) 发送后  ${describe(readSession())}`);
  console.log('');
  console.log('请判断：暂停/恢复的是 QQ 音乐，还是网页视频？');
  console.log('若 QQ 音乐响应而视频不动，说明定向命令可用，可把它接进插件。');
}

main();
