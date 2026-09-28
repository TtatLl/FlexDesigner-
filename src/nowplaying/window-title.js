'use strict';

const { parseTrackString, looksLikeQqMusic } = require('./text');

const STALE_MS = 8000;

/**
 * Last-resort provider that reads the QQ Music window title through the
 * FlexDesigner SDK (`plugin.getOpenedWindows()`), which works on both Windows
 * and macOS without any extra permission or helper binary.
 *
 * It cannot know the real playback position, so the timeline is estimated from
 * the moment the title changes.
 */
class WindowTitleProvider {
  constructor({
    logger,
    listWindows,
    appNames = ['QQMusic', 'QQ音乐', 'qqmusic'],
    assumePlaying = true,
    pollIntervalMs = 300,
  }) {
    this.id = 'window';
    this.label = '窗口标题';
    this.logger = logger;
    this.listWindows = listWindows;
    this.appNames = appNames.map((name) => String(name).toLowerCase());
    this.assumePlaying = assumePlaying;
    this.pollIntervalMs = Math.max(150, pollIntervalMs);
    this.state = 'idle';
    this.detail = '';
    this.track = null;
    this.startedAt = 0;
    this.updatedAt = 0;
    this.lastError = '';
    this.timer = null;
    this.refreshing = false;
    this.cached = null;
  }

  async start() {
    this.state = 'starting';
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.pollIntervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'stopped';
  }

  status() {
    return {
      id: this.id,
      label: this.label,
      state: this.state,
      detail: this.detail || `${this.pollIntervalMs}ms poll`,
    };
  }

  matchesApp(window) {
    const owner = String(window?.owner?.name || '').toLowerCase();
    const title = String(window?.title || '');
    if (this.appNames.some((name) => owner.includes(name) || owner.includes('qqmusic'))) return true;
    if (/qqmusic/i.test(owner)) return true;
    return looksLikeQqMusic(title) && !!parseTrackString(title).artist;
  }

  scoreWindow(window) {
    const title = String(window?.title || '');
    const parsed = parseTrackString(title);
    let score = 0;
    if (!parsed.title) return -1;
    if (parsed.artist) score += 2;
    if (String(window?.owner?.name || '').toLowerCase().includes('qqmusic')) score += 2;
    if (looksLikeQqMusic(title)) score += 1;
    if (/^(qq\s?音乐|qqmusic)$/i.test(title.trim())) score -= 2;
    return score;
  }

  /**
   * Reads the window list on its own fast interval (independent from the 1s
   * state poll) so switching songs is noticed within a few hundred ms.
   */
  async refresh() {
    if (typeof this.listWindows !== 'function' || this.refreshing) return;
    this.refreshing = true;
    try {
      const windows = (await this.listWindows()) || [];

      // Log the QQ related windows once per change: this shows whether QQ Music
      // exposes a "desktop lyric" window whose title tracks the current line.
      const related = windows
        .filter((window) => window && this.matchesApp(window))
        .map((window) => `${window.owner?.name || '?'}: "${window.title || ''}"`);
      const summary = related.join(' | ');
      if (summary !== this.lastWindowSummary) {
        this.lastWindowSummary = summary;
        this.logger?.info(
          `[Window] ${windows.length} windows, QQ related: ${summary || '(none)'}`
        );
      }

      let best = null;
      let bestScore = 0;
      for (const window of windows) {
        if (!window || !this.matchesApp(window)) continue;
        const score = this.scoreWindow(window);
        if (score > bestScore) {
          bestScore = score;
          best = window;
        }
      }

      if (!best) {
        this.state = 'ok';
        this.detail = 'no QQ Music window';
        this.cached = null;
        return;
      }

      const parsed = parseTrackString(best.title);
      const signature = `${parsed.title}|${parsed.artist}`;
      if (!this.track || this.track.signature !== signature) {
        this.track = { signature, ...parsed };
        this.startedAt = Date.now();
      }
      this.updatedAt = Date.now();
      this.state = 'ok';
      this.detail = best.title.slice(0, 60);
      this.cached = { parsed, appId: best.owner?.name || 'window', title: best.title };
    } catch (err) {
      this.lastError = err.message;
      this.state = 'unavailable';
      this.detail = err.message;
    } finally {
      this.refreshing = false;
    }
  }

  read() {
    if (!this.cached) {
      if (this.track && Date.now() - this.updatedAt > STALE_MS) this.track = null;
      return null;
    }
    return {
      source: 'window',
      isPlaying: this.assumePlaying,
      title: this.cached.parsed.title,
      artist: this.cached.parsed.artist,
      album: '',
      durationMs: 0,
      positionMs: this.assumePlaying ? 0 : Date.now() - this.startedAt,
      positionAtMs: this.startedAt,
      appId: this.cached.appId,
      providerLabel: this.label,
      estimated: true,
    };
  }

  reset() {
    this.startedAt = Date.now();
  }
}

module.exports = { WindowTitleProvider };
