'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const QQ_APP_PATTERN = /qqmusic|qq音乐/i;
const STALE_MS = 6000;

/**
 * Directories a user can install the helper into without sudo. Homebrew needs
 * admin rights to create /opt/homebrew, so these are the only drop-in spots on
 * a machine that does not have it.
 */
function userBinDirs() {
  let home = '';
  try {
    home = os.homedir();
  } catch {
    home = '';
  }
  if (!home) return [];
  return [path.join(home, 'bin'), path.join(home, '.local', 'bin')];
}

/**
 * GUI-launched apps get a minimal PATH on macOS, so Homebrew binaries
 * (/opt/homebrew/bin, /usr/local/bin) are not discoverable via PATH alone.
 */
const NOW_PLAYING_CLI_CANDIDATES = [
  '/opt/homebrew/bin/nowplaying-cli',
  '/usr/local/bin/nowplaying-cli',
  '/opt/local/bin/nowplaying-cli',
  ...userBinDirs().map((dir) => path.join(dir, 'nowplaying-cli')),
  'nowplaying-cli',
];

function resolveExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* try next */
      }
      continue;
    }
    try {
      const result = spawnSync('/usr/bin/env', ['sh', '-lc', `command -v ${candidate}`], {
        timeout: 3000,
      });
      const found = String(result.stdout || '').trim();
      if (result.status === 0 && found) return found;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Absolute path of the first usable nowplaying-cli, or null. */
function resolveNowPlayingCli() {
  return resolveExecutable(NOW_PLAYING_CLI_CANDIDATES);
}

/**
 * macOS 15 keeps MediaRemote out of the dlopen-able image cache (the framework
 * bundle is only a stub), so the JXA fallback can never bind its symbols and
 * always reports "function not found". Turn that into advice instead of noise.
 */
function explainMediaRemoteFailure(message) {
  if (/is not a function|function not found|bundle could not be loaded/i.test(String(message || ''))) {
    return 'MediaRemote 无法从脚本访问（macOS 15 起框架仅为共享缓存存根），请安装 nowplaying-cli';
  }
  return message;
}

/**
 * macOS now-playing provider.
 *
 * macOS has no public now-playing API. Two paths are supported:
 *  1. `nowplaying-cli` (recommended, `brew install nowplaying-cli`) - reads the
 *     same MediaRemote state the Control Center widget shows.
 *  2. A bundled JXA script that pokes the private MediaRemote framework.
 * When both fail the plugin falls back to the window-title provider.
 */
class MacOsMediaProvider {
  constructor({ logger, scriptPath, cliPath = '', intervalMs = 1000, acceptAnyPlayer = false, debug = false }) {
    this.id = 'macos';
    this.label = 'macOS 媒体中心';
    this.logger = logger;
    this.scriptPath = scriptPath;
    this.cliPath = cliPath;
    this.acceptAnyPlayer = acceptAnyPlayer;
    this.intervalMs = intervalMs;
    this.state = 'idle';
    this.detail = '';
    this.nowPlayingCli = null;
    this.debug = debug;
    this.rawLoggedAt = 0;
    this.timer = null;
    this.sample = null;
    this.sampleAt = 0;
    this.polling = false;
    // QQ Music publishes no playback position (ElapsedTime stays 0), so the
    // lyric cursor is driven by a local clock that is rebased whenever the
    // player actually reports something new.
    this.clock = { key: '', baseMs: 0, baseAt: 0, lastReportedMs: null, rate: 1 };
    this.ownerAppId = '';
    this.ownerCheckedKey = '';
    this.adapter = undefined; // { script, dylib } once resolved
    // Position bookkeeping for the adapter path: the player's anchor
    // (elapsedTime + timestamp) plus the last position seen while playing.
    this.lastAnchor = { elapsed: null, ts: NaN };
    this.lastPlayingPositionMs = null;
    this.adapterTrackKey = '';
  }

  /**
   * Locate the adapter the helper drives (`mediaremote-mini.pl` + dylib).
   * nowplaying-cli itself looks next to the executable and one level up.
   */
  resolveAdapterPaths() {
    if (this.adapter !== undefined) return this.adapter;
    if (!this.nowPlayingCli) {
      this.adapter = null;
      return null;
    }
    const exeDir = path.dirname(this.nowPlayingCli);
    const bases = [exeDir, path.dirname(exeDir)];
    for (const base of bases) {
      const layouts = [
        [
          path.join(base, 'share', 'nowplaying-cli', 'scripts', 'mediaremote-mini.pl'),
          path.join(base, 'lib', 'nowplaying-cli', 'MediaRemoteMini.dylib'),
        ],
        [
          path.join(base, 'scripts', 'mediaremote-mini.pl'),
          path.join(base, 'build', 'mediaremote-mini', 'MediaRemoteMini.dylib'),
        ],
      ];
      for (const [script, dylib] of layouts) {
        if (fs.existsSync(script) && fs.existsSync(dylib)) {
          this.adapter = { script, dylib };
          return this.adapter;
        }
      }
    }
    this.adapter = null;
    return null;
  }

  /**
   * Reads the adapter's raw JSON: the only place the player's `timestamp` shows
   * up. That timestamp is what makes an accurate playback position possible,
   * because QQ Music reports `elapsedTime` as 0 and never updates it.
   *
   *   position = elapsedTime + (now - timestamp) x playbackRate
   */
  async pollAdapter() {
    const adapter = this.resolveAdapterPaths();
    if (!adapter) return null;
    const result = await this.run('/usr/bin/perl', [adapter.script, adapter.dylib], 8000);
    if (!result.stdout) return null;
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;

    const title = typeof payload.title === 'string' ? payload.title : '';
    if (!title) return null;

    const trackKey = `${title}\u0000${payload.artist || ''}\u0000${payload.album || ''}`;
    if (trackKey !== this.adapterTrackKey) {
      this.adapterTrackKey = trackKey;
      this.lastAnchor = { elapsed: null, ts: NaN };
      this.lastPlayingPositionMs = null;
    }

    const rate = Number(payload.playbackRate);
    const elapsedSec = Number(payload.elapsedTime);
    const durationSec = Number(payload.duration);
    const durationMs = Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0;
    const reportedAtMs = Date.parse(payload.timestamp);

    // QQ Music reports playbackRate=1 even after it has paused, so the boolean
    // `playing` field is the authoritative one. Trusting the rate made the
    // plugin think playback continued and it kept scrolling lyrics.
    const playingField = typeof payload.playing === 'boolean' ? payload.playing : null;
    const playing = playingField !== null ? playingField : Number.isFinite(rate) ? rate > 0 : true;

    const anchorChanged =
      elapsedSec !== this.lastAnchor.elapsed || reportedAtMs !== this.lastAnchor.ts;

    let positionMs = 0;
    if (Number.isFinite(elapsedSec)) {
      const anchorMs = Math.round(elapsedSec * 1000);
      const advance = Number.isFinite(rate) ? Math.max(0, rate) : 1;
      if (Number.isFinite(reportedAtMs) && (anchorChanged || playing)) {
        positionMs = anchorMs + (playing ? Math.max(0, Date.now() - reportedAtMs) * advance : 0);
      } else {
        // Paused with an unchanged anchor: hold the position we last saw while
        // playing, instead of snapping back to the stale anchor.
        positionMs = this.lastPlayingPositionMs ?? anchorMs;
      }
    }
    if (durationMs > 0) positionMs = Math.min(positionMs, durationMs);
    if (playing) this.lastPlayingPositionMs = Math.round(positionMs);
    this.lastAnchor = { elapsed: elapsedSec, ts: reportedAtMs };

    const bundle = typeof payload.bundleIdentifier === 'string' ? payload.bundleIdentifier : '';
    this.ownerAppId = bundle;
    this.lastMeta = {
      rate: Number.isFinite(rate) ? rate : null,
      elapsed: Number.isFinite(elapsedSec) ? elapsedSec : null,
      reportedAtMs: Number.isFinite(reportedAtMs) ? reportedAtMs : null,
      playing: typeof payload.playing === 'boolean' ? payload.playing : null,
    };

    return {
      source: 'macos',
      isPlaying: playing,
      title,
      artist: typeof payload.artist === 'string' ? payload.artist : '',
      album: typeof payload.album === 'string' ? payload.album : '',
      durationMs,
      positionMs: Math.round(positionMs),
      positionAtMs: Date.now(),
      appId: bundle || 'nowplaying-cli',
      providerLabel: this.label,
      // Base64 album art straight from the media session: lets the key show a
      // cover on the very first frame of a track.
      artworkData: typeof payload.artworkData === 'string' ? payload.artworkData : '',
    };
  }

  /** Explicit config path wins; otherwise the standard candidate list. */
  locateCli() {
    const explicit = String(this.cliPath || '').trim();
    if (explicit) {
      const resolved = resolveExecutable([explicit]);
      if (resolved) return resolved;
      this.logger?.warn?.(`[NowPlaying] nowplayingPath is not executable: ${explicit}`);
    }
    return resolveNowPlayingCli();
  }

  async start() {
    this.nowPlayingCli = this.locateCli();
    this.detail = this.nowPlayingCli ? `nowplaying-cli (${this.nowPlayingCli})` : 'MediaRemote (JXA)';
    this.logger?.info?.(
      this.nowPlayingCli
        ? `[NowPlaying] using ${this.nowPlayingCli}`
        : '[NowPlaying] nowplaying-cli not found, falling back to MediaRemote (JXA)'
    );
    this.state = 'starting';
    await this.poll();
    this.timer = setInterval(() => void this.poll(), Math.max(500, this.intervalMs));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'stopped';
  }

  status() {
    return { id: this.id, label: this.label, state: this.state, detail: this.detail };
  }

  run(command, args, timeoutMs = 4000) {
    return new Promise((resolve) => {
      let done = false;
      const child = spawn(command, args, { windowsHide: true });
      const chunks = [];
      const errChunks = [];
      const finish = (result) => {
        if (done) return;
        done = true;
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        // Keep whatever the child managed to print: some helpers stream.
        finish({
          ok: false,
          error: 'timeout',
          stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8').trim(),
        });
      }, timeoutMs);
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.stderr.on('data', (chunk) => errChunks.push(chunk));
      child.on('error', (err) => {
        clearTimeout(timer);
        finish({ ok: false, error: err.message });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const stderr = Buffer.concat(errChunks).toString('utf8').trim();
        if (code !== 0) return finish({ ok: false, error: `exit ${code}`, stderr });
        finish({ ok: true, stdout: Buffer.concat(chunks).toString('utf8'), stderr });
      });
    });
  }

  async pollNowPlayingCli() {
    if (!this.nowPlayingCli) return null;
    const keys = ['title', 'artist', 'album', 'duration', 'elapsedTime', 'playbackRate'];
    const result = await this.run(this.nowPlayingCli, ['get', ...keys]);
    if (!result.ok) return null;
    const lines = result.stdout.split('\n').map((line) => line.trim());
    const [title, artist, album, duration, elapsed, rate] = lines;
    if (!title || title.toLowerCase() === 'null') return null;
    const durationSec = Number(duration) || 0;
    const elapsedSec = Number(elapsed);
    const playbackRate = Number(rate);
    const durationMs = Math.round(durationSec * 1000);
    const artistName = artist === 'null' ? '' : artist;
    const albumName = album === 'null' ? '' : album;
    const trackKey = `${title}\u0000${artistName}\u0000${albumName}`;

    // Only QQ Music should drive this plugin; other players would get matched
    // against the wrong lyrics. The owning app is only available through
    // get-raw, so resolve it once per track.
    if (trackKey !== this.ownerCheckedKey) {
      this.ownerCheckedKey = trackKey;
      await this.resolveOwnerApp();
    }
    if (!this.acceptAnyPlayer && this.ownerAppId && !QQ_APP_PATTERN.test(this.ownerAppId)) {
      if (this.debug) this.logger?.info?.(`[NowPlaying][debug] ignoring ${this.ownerAppId}`);
      return null;
    }

    const { positionMs, positionAtMs } = this.advanceClock({
      trackKey,
      reportedMs: Number.isFinite(elapsedSec) ? Math.round(elapsedSec * 1000) : null,
      rate: Number.isFinite(playbackRate) ? playbackRate : this.clock.rate,
      durationMs,
    });

    return {
      source: 'macos',
      isPlaying: Number.isFinite(playbackRate) ? playbackRate > 0 : this.clock.rate > 0,
      title,
      artist: artistName,
      album: albumName,
      durationMs,
      positionMs,
      positionAtMs,
      appId: this.ownerAppId || 'nowplaying-cli',
      providerLabel: this.label,
    };
  }

  /** Bundle id of the app that owns the current media session (cached per track). */
  async resolveOwnerApp() {
    const raw = await this.run(this.nowPlayingCli, ['get-raw'], 8000);
    if (!raw.ok) return;
    try {
      const dict = JSON.parse(raw.stdout);
      const bundle = dict.kMRMediaRemoteNowPlayingInfoClientBundleIdentifier;
      this.ownerAppId = typeof bundle === 'string' ? bundle : '';
    } catch {
      /* keep the previous value */
    }
  }

  /**
   * Debug aid: dump the raw JSON the MediaRemote adapter emits. The CLI only
   * surfaces a mapped subset of fields, so this is the way to see whether the
   * player reports a usable playback position at all.
   */
  async logAdapterRaw() {
    const adapter = this.resolveAdapterPaths();
    if (!adapter) return;
    const result = await this.run('/usr/bin/perl', [adapter.script, adapter.dylib], 8000);
    const text = String(result.stdout || '').replace(/\s+/g, ' ').trim();
    let keys = '';
    try {
      keys = Object.keys(JSON.parse(result.stdout)).join(',');
    } catch {
      /* not json */
    }
    this.logger?.info?.(
      `[NowPlaying][debug] adapter raw (${result.ok ? 'ok' : result.error}) -> ` +
        `keys=[${keys}] ` +
        (text ? text.replace(/"artworkData":"[^"]*"/, '"artworkData":"<omitted>"').slice(0, 500) : '(empty)')
    );
  }

  /**
   * Debug aid: check whether QQ Music's own controls are reachable through the
   * Accessibility API. System media commands are the preferred route, but a
   * player that ignores them (QQ Music + TogglePlayPause) can be driven through
   * its UI instead.
   */
  async probeUi() {
    const helperDir = path.dirname(this.scriptPath || '');
    const probe = path.join(helperDir, 'ui-probe.jxa');
    if (!helperDir || !fs.existsSync(probe)) return;
    const result = await this.run('osascript', ['-l', 'JavaScript', probe], 20000);
    const text = String(result.stdout || result.stderr || result.error || '').trim();
    this.logger?.info?.(`[NowPlaying][debug] ui probe -> ${text.slice(0, 1800) || '(empty)'}`);
  }

  positionAt(now) {
    const { baseMs, baseAt, rate } = this.clock;
    return baseMs + (rate > 0 ? Math.max(0, now - baseAt) : 0);
  }

  /**
   * Advances the local playback clock.
   *
   * A reported position is treated as authoritative only when it *changes*:
   * players that report nothing (QQ Music: always 0) would otherwise reset the
   * cursor to zero on every poll, which is exactly what made the progress bar
   * sit at 0 and the lyrics stick to the first line.
   */
  advanceClock({ trackKey, reportedMs, rate, durationMs }) {
    const now = Date.now();
    const previous = this.clock;
    const trackChanged = trackKey !== previous.key;
    const reportedChanged = reportedMs !== null && reportedMs !== previous.lastReportedMs;

    if (trackChanged) {
      previous.key = trackKey;
      previous.baseMs = reportedMs ?? 0;
      previous.baseAt = now;
    } else if (reportedChanged) {
      // A genuine position arrived - the player seeks, or reports progress.
      previous.baseMs = reportedMs;
      previous.baseAt = now;
    } else if (rate > 0 && previous.rate <= 0) {
      previous.baseAt = now; // resumed from pause
    } else if (rate <= 0 && previous.rate > 0) {
      previous.baseMs = this.positionAt(now); // freeze exactly where it stopped
      previous.baseAt = now;
    }

    previous.lastReportedMs = reportedMs;
    previous.rate = rate;

    let positionMs = this.positionAt(now);
    if (durationMs > 0) positionMs = Math.min(positionMs, durationMs);
    return { positionMs: Math.round(positionMs), positionAtMs: now };
  }

  async pollJxa() {
    const result = await this.run('osascript', ['-l', 'JavaScript', this.scriptPath], 6000);
    if (!result.ok) return null;
    const line = result.stdout.split('\n').filter(Boolean).pop();
    if (!line) return null;

    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      return null;
    }
    if (payload.type !== 'sample' || !payload.session) {
      if (payload.type === 'error') this.detail = explainMediaRemoteFailure(payload.message) || this.detail;
      return null;
    }
    const session = payload.session;
    if (!this.acceptAnyPlayer && session.appId && !QQ_APP_PATTERN.test(session.appId)) return null;
    return {
      source: 'macos',
      isPlaying: String(session.status || '') === 'Playing',
      title: session.title || '',
      artist: session.artist || '',
      album: session.album || '',
      durationMs: Math.max(0, Math.round((session.durationSec || 0) * 1000)),
      positionMs: Math.max(0, Math.round((session.positionSec || 0) * 1000)),
      positionAtMs: Number(payload.ts) || Date.now(),
      appId: session.appId || 'MediaRemote',
      providerLabel: this.label,
    };
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      // The adapter's raw JSON carries the timestamp that makes an accurate
      // position possible; `nowplaying-cli get` and the JXA helper stay as
      // fallbacks for other installs.
      const viaAdapter = await this.pollAdapter();
      const viaCli = viaAdapter ? null : await this.pollNowPlayingCli();
      let sampled = viaAdapter || viaCli || (await this.pollJxa());
      if (sampled && !this.acceptAnyPlayer && sampled.appId && !QQ_APP_PATTERN.test(sampled.appId)) {
        if (this.debug) this.logger?.info?.(`[NowPlaying][debug] ignoring ${sampled.appId}`);
        sampled = null;
      }
      if (sampled) {
        this.sample = sampled;
        this.sampleAt = Date.now();
        this.state = 'ok';
        if (viaAdapter) this.detail = `MediaRemote adapter (${this.nowPlayingCli})`;
        else if (viaCli) this.detail = `nowplaying-cli (${this.nowPlayingCli})`;
        if (this.debug && !this.adapterLogged) {
          this.adapterLogged = true;
          await this.logAdapterRaw();
        }
        if (this.debug && !this.uiProbed) {
          this.uiProbed = true;
          void this.probeUi();
        }
      } else if (this.nowPlayingCli) {
        // Helper present and answering: the machine simply has no session to
        // report, which is not the same as "detection is broken".
        this.state = 'idle';
        this.detail = 'nowplaying-cli 就绪，未检测到播放中的曲目';
      } else if (!this.sample) {
        this.state = 'unavailable';
      }
      await this.logRawSample();
    } catch (err) {
      this.state = 'unavailable';
      this.detail = err.message;
    } finally {
      this.polling = false;
    }
  }

  read() {
    if (!this.sample) return null;
    if (Date.now() - this.sampleAt > STALE_MS) {
      this.state = 'stale';
      return null;
    }
    return this.sample;
  }

  /**
   * Debug aid (config `debug: true`): when nothing is detected, dump what the
   * helper actually sees, so "no track" can be told apart from "no permission".
   */
  async logRawSample() {
    if (!this.debug || !this.nowPlayingCli) return;
    const now = Date.now();
    if (now - this.rawLoggedAt < 10000) return;
    this.rawLoggedAt = now;
    const startedAt = Date.now();
    const raw = await this.run(this.nowPlayingCli, ['get-raw'], 12000);
    const took = Date.now() - startedAt;
    if (this.sample) {
      const meta = this.lastMeta || {};
      const age = meta.reportedAtMs ? Math.round((Date.now() - meta.reportedAtMs) / 1000) : null;
      this.logger?.info?.(
        `[NowPlaying][debug] parsed: playing=${this.sample.isPlaying} pos=${Math.round(this.sample.positionMs / 1000)}s` +
          ` dur=${Math.round(this.sample.durationMs / 1000)}s rate=${meta.rate} elapsed=${meta.elapsed}` +
          ` tsAge=${age}s playing_field=${meta.playing}` +
          ` owner=${this.ownerAppId || '?'} title="${this.sample.title}"`
      );
    }
    if (!raw.ok) {
      this.logger?.info?.(
        `[NowPlaying] nowplaying-cli get-raw failed after ${took}ms: ${raw.error}` +
          (raw.stderr ? ` | stderr: ${raw.stderr.replace(/\s+/g, ' ').slice(0, 200)}` : '')
      );
      return;
    }
    const text = String(raw.stdout || '').replace(/\s+/g, ' ').trim();
    // The artwork is a base64 JPEG; keep the log readable.
    const compact = text.replace(
      /"kMRMediaRemoteNowPlayingInfoArtwork[^"]*" : "[^"]*"/g,
      '"artwork": "<omitted>"'
    );
    this.logger?.info?.(
      `[NowPlaying] nowplaying-cli get-raw (${took}ms) -> ${compact.slice(0, 900) || '(empty)'}` +
        (raw.stderr ? ` | stderr: ${raw.stderr.replace(/\s+/g, ' ').slice(0, 200)}` : '')
    );
  }
}

module.exports = { MacOsMediaProvider, NOW_PLAYING_CLI_CANDIDATES, resolveNowPlayingCli };
