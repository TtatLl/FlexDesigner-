'use strict';

const { loadImage } = require('./engine');

const MAX_ENTRIES = 12;
const TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** Small in-memory cache so we do not re-download artwork every second. */
class CoverCache {
  constructor(logger) {
    this.logger = logger;
    this.entries = new Map();
    this.pending = new Map();
    this.failures = new Map();
  }

  async get(url) {
    if (!url) return null;
    const cached = this.entries.get(url);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.image;

    // Remember recent failures so a broken cover URL is not retried on every
    // frame (that used to starve the lyric renderer).
    const failure = this.failures.get(url);
    if (failure && Date.now() - failure < FAILURE_TTL_MS) return null;

    if (this.pending.has(url)) return this.pending.get(url);

    const task = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let response;
        try {
          response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!response.ok) {
          this.failures.set(url, Date.now());
          return null;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const image = await loadImage(buffer);
        if (!image) {
          this.failures.set(url, Date.now());
          return null;
        }
        this.entries.set(url, { at: Date.now(), image });
        this.failures.delete(url);
        if (this.entries.size > MAX_ENTRIES) {
          const oldest = this.entries.keys().next().value;
          this.entries.delete(oldest);
        }
        return image;
      } catch (err) {
        this.failures.set(url, Date.now());
        this.logger?.warn(`[Cover] download failed: ${err.message}`);
        return null;
      } finally {
        this.pending.delete(url);
      }
    })();

    this.pending.set(url, task);
    return task;
  }

  /**
   * Tries each candidate URL in order and returns the first one that decodes.
   * Used because a single QQ Music artwork URL 404s for some releases.
   */
  async getFirst(urls) {
    for (const url of urls) {
      const image = await this.get(url);
      if (image) return { url, image };
    }
    return null;
  }

  /**
   * Stores artwork that came inline with the media session (base64), so the
   * first frame of a track can show a cover without waiting for the metadata
   * lookup and an image download.
   */
  async putInline(key, base64) {
    if (!key || !base64) return null;
    const cached = this.entries.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.image;
    if (this.pending.has(key)) return this.pending.get(key);

    const task = (async () => {
      try {
        const image = await loadImage(Buffer.from(base64, 'base64'));
        if (!image) return null;
        this.entries.set(key, { at: Date.now(), image });
        if (this.entries.size > MAX_ENTRIES) {
          const oldest = this.entries.keys().next().value;
          this.entries.delete(oldest);
        }
        return image;
      } catch {
        return null;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, task);
    return task;
  }

  clear() {
    this.entries.clear();
    this.failures.clear();
  }
}

module.exports = { CoverCache };
