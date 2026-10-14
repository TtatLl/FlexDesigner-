'use strict';

const { PROVIDERS } = require('../constants');
const { parseTrackString } = require('./text');
const { SmtcProvider } = require('./windows-smtc');
const { MacOsMediaProvider } = require('./macos-media');
const { WindowTitleProvider } = require('./window-title');

// Keeps the last good snapshot visible while a provider blips out. Windows
// tears down and re-creates the QQ Music media session on every track change
// (measured ~0.6-1s), so a short gap is normal - but a real stop must not keep
// stale lyrics on screen for long.
const HOLD_MS = 2500;

/**
 * Tracks "what is QQ Music playing right now" behind a single interface, with a
 * chain of platform specific providers and a manual fallback.
 */
class NowPlayingService {
  constructor({ logger, config, helperDir, listWindows }) {
    this.logger = logger;
    this.config = config;
    this.helperDir = helperDir;
    this.listWindows = listWindows;

    this.providers = [];
    this.activeProvider = null;
    this.snapshot = null;
    this.snapshotAt = 0;
    this.manual = { title: '', artist: '', startedAt: 0, paused: false };
  }

  buildProviders() {
    const mode = this.config.get('provider');
    const acceptAnyPlayer = this.config.get('acceptAnyPlayer') === true;
    const pollIntervalMs = Number(this.config.get('pollIntervalMs')) || 1000;
    const appNames = this.config.get('windowTitleApps') || ['QQMusic', 'QQ音乐'];

    // The window title is only a last resort: QQ Music keeps showing the
    // previous song in it until the window is repainted, so a stale title would
    // otherwise win during the moment the media session is being re-created.
    const fallbackSetting = this.config.get('enableWindowFallback');
    const windowFallback =
      fallbackSetting === undefined ? process.platform !== 'win32' : fallbackSetting === true;

    const smtc = () =>
      new SmtcProvider({
        logger: this.logger,
        scriptPath: `${this.helperDir}/windows/smtc.ps1`,
        intervalMs: Math.max(500, Math.min(2000, pollIntervalMs)),
        acceptAnyPlayer,
      });
    const macos = () =>
      new MacOsMediaProvider({
        logger: this.logger,
        scriptPath: `${this.helperDir}/macos/nowplaying.jxa`,
        // Optional override for setups where the helper lives somewhere
        // unusual; discoverable locations are tried when this is empty.
        cliPath: this.config.get('nowplayingPath') || '',
        intervalMs: Math.max(500, pollIntervalMs),
        acceptAnyPlayer,
        debug: this.config.get('debug') === true,
      });
    const windowTitle = () =>
      new WindowTitleProvider({
        logger: this.logger,
        listWindows: this.listWindows,
        appNames,
        pollIntervalMs: Number(this.config.get('windowTitlePollMs')) || 300,
      });

    switch (mode) {
      case PROVIDERS.SMTC:
        return [smtc()];
      case PROVIDERS.MACOS:
        return [macos()];
      case PROVIDERS.WINDOW:
        return [windowTitle()];
      case PROVIDERS.MANUAL:
        return [];
      default:
        // Windows: the media session is the only trustworthy source. macOS keeps
        // the window-title provider as a fallback because it has no equivalent.
        if (process.platform === 'win32') return windowFallback ? [smtc(), windowTitle()] : [smtc()];
        if (process.platform === 'darwin') return windowFallback ? [macos(), windowTitle()] : [macos()];
        return [windowTitle()];
    }
  }

  async start() {
    this.stop();
    this.providers = this.buildProviders();
    for (const provider of this.providers) {
      try {
        await provider.start();
      } catch (err) {
        this.logger?.error(`[NowPlaying] provider ${provider.id} failed to start: ${err.message}`);
      }
    }
    this.logger?.info(
      `[NowPlaying] providers: ${this.providers.map((p) => p.id).join(', ') || 'manual'} ` +
        `(platform ${process.platform})`
    );
  }

  restart() {
    void this.start();
  }

  /**
   * Ask every provider to sample faster for a moment. Used right after a skip
   * press so the new track is noticed as soon as the player publishes it,
   * instead of on the next regular poll.
   */
  hurry(options) {
    for (const provider of this.providers) {
      try {
        provider.hurry?.(options);
      } catch (err) {
        this.logger?.debug?.(`[NowPlaying] provider ${provider.id} hurry failed: ${err.message}`);
      }
    }
    return this.poll();
  }

  /**
   * Set while another app owns the system media session. macOS (and Windows
   * SMTC) send media keys to that app, so the plugin must not treat a press as
   * "control QQ Music" while this is non-null.
   */
  foreignSession() {
    for (const provider of this.providers) {
      try {
        const foreign = provider.foreignSession?.();
        if (foreign) return foreign;
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  stop() {
    for (const provider of this.providers) {
      try {
        provider.stop();
      } catch {
        /* ignore */
      }
    }
    this.providers = [];
    this.activeProvider = null;
  }

  setManualSong(value) {
    const parsed = parseTrackString(value);
    this.manual = { title: parsed.title, artist: parsed.artist, startedAt: Date.now(), paused: false };
    return this.manual;
  }

  manualSnapshot() {
    const mode = this.config.get('provider');
    const configured = this.config.get('manualSong') || '';
    const parsed = parseTrackString(configured);
    if (!parsed.title) return null;
    if (this.manual.title !== parsed.title || this.manual.artist !== parsed.artist) {
      this.setManualSong(configured);
    }
    return {
      source: mode === PROVIDERS.MANUAL ? 'manual' : 'manual',
      isPlaying: !this.manual.paused,
      title: this.manual.title,
      artist: this.manual.artist,
      album: '',
      durationMs: 0,
      positionMs: this.manual.paused ? this.manual.pausedAt || 0 : 0,
      positionAtMs: this.manual.paused ? this.manual.pausedAt || Date.now() : this.manual.startedAt,
      appId: 'manual',
      providerLabel: '手动指定',
      estimated: true,
    };
  }

  async poll() {
    for (const provider of this.providers) {
      let snapshot = null;
      try {
        snapshot = await provider.read();
      } catch (err) {
        this.logger?.error(`[NowPlaying] provider ${provider.id} read failed: ${err.message}`);
      }
      if (snapshot && snapshot.title) {
        this.activeProvider = provider;
        this.snapshot = snapshot;
        this.snapshotAt = Date.now();
        return snapshot;
      }
    }

    if (this.config.get('provider') === PROVIDERS.MANUAL) {
      const manual = this.manualSnapshot();
      if (manual) {
        this.activeProvider = null;
        this.snapshot = manual;
        this.snapshotAt = Date.now();
        return manual;
      }
    }

    if (this.snapshot && Date.now() - this.snapshotAt < HOLD_MS) return this.snapshot;

    this.snapshot = null;
    return null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  getEstimatedPositionMs(now = Date.now()) {
    const snapshot = this.snapshot;
    if (!snapshot) return 0;
    const base = Number(snapshot.positionMs) || 0;
    if (!snapshot.isPlaying) return base;
    const elapsed = Math.max(0, now - (Number(snapshot.positionAtMs) || now));
    const position = base + elapsed;
    if (snapshot.durationMs) return Math.min(position, snapshot.durationMs);
    return position;
  }

  /** Short human readable state used by the status key and the config page. */
  status() {
    const providerStatus = this.activeProvider ? this.activeProvider.status() : null;
    return {
      mode: this.config.get('provider'),
      activeProvider: providerStatus,
      providers: this.providers.map((provider) => provider.status()),
      snapshot: this.snapshot
        ? {
            title: this.snapshot.title,
            artist: this.snapshot.artist,
            isPlaying: this.snapshot.isPlaying,
            source: this.snapshot.source,
          }
        : null,
    };
  }
}

module.exports = { NowPlayingService };
