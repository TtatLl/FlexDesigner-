'use strict';

const { coverCandidates } = require('../lyrics/qqmusic-api');

/**
 * Resolves album artwork for the matched track.
 *
 * QQ Music's search results contain many look-alike releases (DJ versions, live
 * recordings, karaoke covers) that carry **no album id**, and a few albums only
 * exist on certain CDN hosts or with a size suffix. A single hard coded URL
 * therefore leaves those albums without artwork, so we:
 *
 *   1. try every host/size/suffix candidate for the matched album,
 *   2. fall back to the canonical album of the song (looked up by song mid),
 *   3. keep the winning picture cached per album.
 */
class ArtworkResolver {
  constructor({ coverCache, logger, fetchSongDetail }) {
    this.coverCache = coverCache;
    this.logger = logger;
    this.fetchSongDetail = fetchSongDetail;
    this.state = { key: '', url: '', image: null, resolved: false };
  }

  reset() {
    this.state = { key: '', url: '', image: null, resolved: false };
  }

  /** How long to wait before trying a failed album again (log spam guard). */
  static RETRY_AFTER_MS = 20000;

  async resolve(match) {
    if (!match) return null;
    const key = `${match.songMid || ''}|${match.albumMid || ''}`;
    const retryDue = !this.state.retryAt || Date.now() >= this.state.retryAt;
    if (this.state.key === key && this.state.resolved && !retryDue) return this.state;
    // The lyrics hook and the now-playing renderer can ask for the same album
    // within a few milliseconds; share one lookup instead of running it twice.
    if (this.inflight && this.inflight.key === key) return this.inflight.promise;

    const promise = this.lookup(key, match);
    this.inflight = { key, promise };
    try {
      return await promise;
    } finally {
      if (this.inflight && this.inflight.promise === promise) this.inflight = null;
    }
  }

  async lookup(key, match) {
    this.state = { key, url: '', image: null, resolved: true, retryAt: 0 };

    let albumMid = match.albumMid || '';
    let found = albumMid ? await this.coverCache.getFirst(coverCandidates(albumMid)) : null;

    if (!found && match.songMid && typeof this.fetchSongDetail === 'function') {
      // The search hit may be a version without album info - ask for the song
      // itself, which returns the canonical album id.
      try {
        const detail = await this.fetchSongDetail(match.songMid);
        if (detail?.albumMid && detail.albumMid !== albumMid) {
          albumMid = detail.albumMid;
          found = await this.coverCache.getFirst(coverCandidates(albumMid));
          if (found) {
            this.logger?.info(`[Cover] resolved via song detail: album ${albumMid}`);
          }
        }
      } catch (err) {
        this.logger?.warn(`[Cover] song detail lookup failed: ${err.message}`);
      }
    }

    if (found) {
      this.state.url = found.url;
      this.state.image = found.image;
      // Resolved for good: never retry (or re-log) until the track changes.
      this.state.retryAt = Number.MAX_SAFE_INTEGER;
      this.logger?.info(
        `[Cover] "${match.title || ''}" album ${albumMid || '(none)'}` +
          (match.albumName ? ` "${match.albumName}"` : '') +
          ` -> ${found.url} ` +
          `(${found.image.width}x${found.image.height})`
      );
    } else {
      // Retry later (the URL cache holds the failures for a minute), but do not
      // re-log the same failure every second.
      this.state.retryAt = Date.now() + ArtworkResolver.RETRY_AFTER_MS;
      if (!this.loggedKeys) this.loggedKeys = new Set();
      if (!this.loggedKeys.has(key)) {
        this.loggedKeys.add(key);
        this.logger?.warn(
          `[Cover] no artwork for "${match.title || ''}" ` +
            `(album ${albumMid || '(none)'}, song ${match.songMid || '(none)'})`
        );
      }
    }
    return this.state;
  }
}

module.exports = { ArtworkResolver };
