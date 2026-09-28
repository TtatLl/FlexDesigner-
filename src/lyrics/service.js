'use strict';

const fs = require('fs');
const path = require('path');

const {
  searchSongs,
  fetchQrcLyric,
  fetchPlainLyric,
  attachSecondaryLines,
  warmLyricHost,
  getLastSearchDiagnostics,
} = require('./qqmusic-api');

const MIN_MATCH_SCORE = 0.55;
const MIN_TITLE_SCORE = 0.6;
const CACHE_LIMIT = 60;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 10 * 60 * 1000;
// A "no lyrics" answer that came from a *failed lookup* (the search endpoint
// answered with nothing at all, or threw) must not be trusted for ten minutes:
// the same query usually works seconds later. Retry those quickly.
const TRANSIENT_TTL_MS = 60 * 1000;
/** How long to wait before retrying a lookup that failed for external reasons. */
const TRANSIENT_RETRY_MS = 15000;
// Some tracks answer with a word-by-word payload that is empty or a two-line
// placeholder (studio "三人游" is one). Anything below this is not worth
// showing, so the line-by-line payload is used instead.
const MIN_QRC_LINES = 4;
// Bumped whenever the matching rules change. Song "放" (我是土豆) showed the
// lyrics of "放 (加速版)" because both normalise to the same cache key, so the
// version text is part of the key now and older entries are ignored.
const CACHE_KEY_PREFIX = 'v2|';

/** Lines that actually carry text (QQ sometimes ships empty placeholders). */
function countSingableLines(lines) {
  return (lines || []).filter((line) => String(line?.text || '').trim()).length;
}

/**
 * Word-by-word payloads are normally as long as the line-by-line ones, but a
 * few tracks answer with a stub (studio "三人游" returned 2 lines where the LRC
 * has 46). A song averages roughly one lyric line per 20 seconds, so anything
 * far below that is treated as incomplete and checked against the LRC.
 */
function qrcLooksComplete(qrcLines, durationMs) {
  if (qrcLines < MIN_QRC_LINES) return false;
  const durationSec = Number(durationMs) / 1000;
  if (!Number.isFinite(durationSec) || durationSec < 60) return true;
  return qrcLines >= durationSec / 20;
}

/** Normalizes a song title / artist for fuzzy comparison. */
function normalizeText(text) {
  return String(text || '')
    .replace(/[（(\[【〔「『《〈][^）)\]】〕」』》〉]*[）)\]】〕」』》〉]/g, ' ')
    .replace(/\b(feat|ft|featuring|with)\.?\b/gi, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Markers that make a release a *different recording* of the same song: sped
 * up, slowed down, DJ edit, karaoke, live. Their lyrics carry that
 * arrangement's own timings, so pairing them with the studio track makes the
 * words drift ahead (or behind) even though the text is identical.
 */
const VERSION_MARKERS = [
  '加速',
  '降速',
  '慢速',
  '变速',
  'sped',
  'slowed',
  'speed',
  'dj',
  'remix',
  '混音',
  '重混',
  '伴奏',
  '纯音乐',
  'instrumental',
  'karaoke',
  'live',
  '现场',
  '演唱会',
  '清唱',
  'acoustic',
  '翻唱',
  'cover',
  '女声',
  '男声',
  '童声',
  '合唱',
  '对唱',
  '抖音',
  '剪辑',
  '片段',
  'demo',
  'nightcore',
  '八音盒',
  '钢琴',
  '吉他',
  '释怀',
  '新版',
  '重制',
  'remaster',
  '周年',
  '纪念',
];

/** Everything inside brackets of a raw title: "放 (加速版)" -> "加速版". */
function versionText(title) {
  const matches = String(title || '').match(/[（(\[【〔「『《〈][^）)\]】〕」』》〉]*[）)\]】〕」』》〉]/g);
  if (!matches) return '';
  return matches
    .map((part) => part.replace(/[（(\[【〔「『《〈）)\]】〕」』》〉]/g, ' '))
    .join(' ')
    .trim()
    .toLowerCase();
}

function hasVersionMarker(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return false;
  return VERSION_MARKERS.some((marker) => value.includes(marker));
}

/**
 * 1 when the candidate is the same recording, 0 when it is another arrangement
 * of the same song. The plain title score cannot tell them apart: stripping the
 * brackets turns "放" and "放 (加速版)" into the same string.
 */
function versionScore(playerTitle, candidateTitle) {
  const playerVersion = versionText(playerTitle);
  const candidateVersion = versionText(candidateTitle);
  if (playerVersion === candidateVersion) return 1;
  if (!candidateVersion) return 0.5;
  if (!playerVersion) return hasVersionMarker(candidateVersion) ? 0 : 0.5;
  return 0.25;
}

/** Like `normalizeText` but keeps the version text, for cache keys. */
function versionAwareKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\b(feat|ft|featuring|with)\.?\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return new Set(normalizeText(text).split(' ').filter(Boolean));
}

/** Dice coefficient over character bigrams — tolerant to small title changes. */
function similarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    return 0.75 + 0.2 * ratio;
  }

  const bigrams = (value) => {
    const set = new Map();
    for (let i = 0; i < value.length - 1; i += 1) {
      const gram = value.slice(i, i + 2);
      set.set(gram, (set.get(gram) || 0) + 1);
    }
    return set;
  };

  const aGrams = bigrams(left);
  const bGrams = bigrams(right);
  let overlap = 0;
  let aTotal = 0;
  let bTotal = 0;
  for (const count of aGrams.values()) aTotal += count;
  for (const count of bGrams.values()) bTotal += count;
  for (const [gram, count] of aGrams) {
    const other = bGrams.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  if (!aTotal || !bTotal) return 0;
  return (2 * overlap) / (aTotal + bTotal);
}

function artistScore(playerArtists, candidateArtists) {
  const playerTokens = new Set();
  for (const artist of playerArtists) {
    for (const token of tokens(artist)) playerTokens.add(token);
  }
  if (!playerTokens.size) return 0.5;

  let best = 0;
  for (const candidate of candidateArtists) {
    const candidateTokens = tokens(candidate);
    if (!candidateTokens.size) continue;
    let overlap = 0;
    for (const token of playerTokens) if (candidateTokens.has(token)) overlap += 1;
    best = Math.max(best, overlap / Math.max(playerTokens.size, candidateTokens.size));
    best = Math.max(best, similarity(candidate, [...playerArtists].join(' ')));
  }
  return Math.min(1, best);
}

function durationScore(playerDurationMs, candidateDurationMs) {
  if (!playerDurationMs || !candidateDurationMs) return 0.5;
  const delta = Math.abs(playerDurationMs - candidateDurationMs);
  return Math.max(0, 1 - delta / 8000);
}

/**
 * Album-title score.
 *
 * The same song is often on several releases (single, album, compilation) with
 * *different cover art* but identical title, artist and length. The media
 * session knows which album is playing, so a candidate from that album wins.
 * 0.5 means "no opinion" (the player or the candidate has no album name): it
 * must never outvote the title/artist signals, only break their ties.
 */
function albumScore(playerAlbum, candidateAlbum) {
  const player = normalizeText(playerAlbum);
  const candidate = normalizeText(candidateAlbum);
  if (!player || !candidate) return 0.5;
  if (player === candidate) return 1;
  if (player.includes(candidate) || candidate.includes(player)) return 0.9;
  return 0;
}

/** Scores a search candidate against the track reported by the player. */
function scoreCandidate(player, candidate) {
  const title = similarity(player.title, candidate.title);
  const artist = artistScore(player.artists || [], candidate.artists || []);
  const duration = durationScore(player.durationMs, candidate.durationMs);
  const version = versionScore(player.title, candidate.title);
  const album = albumScore(player.album, candidate.albumName);
  // Prefer releases that carry album info: they resolve artwork, and they are
  // usually the canonical release rather than a DJ/live/karaoke re-upload.
  const artworkBonus = candidate.albumMid ? 0.04 : 0;
  const score = Math.min(
    1,
    0.46 * title +
      0.26 * artist +
      0.13 * duration +
      0.07 * version +
      0.08 * album +
      artworkBonus
  );
  return { score, title, artist, duration, version, album, artworkBonus };
}

/**
 * Resolves lyrics for the currently playing track:
 * search QQ Music -> score candidates -> QRC (word level) -> LRC fallback.
 */
class LyricsService {
  constructor(logger, { cacheFile = '', onMatch = null } = {}) {
    this.logger = logger;
    this.cache = new Map();
    this.cacheFile = cacheFile;
    // Called as soon as a candidate is chosen, before the lyric download runs:
    // lets the caller start artwork resolution in parallel instead of waiting
    // for the whole lyric pipeline to finish.
    this.onMatch = onMatch;
    this.saveTimer = null;
    // Monotonic id of the newest `resolve()` call. A lookup can take ten
    // seconds (QRC timeout + LRC fallback), and the user often skips to the next
    // song long before that: without this guard the old answer lands on screen
    // and replaces the cover and lyrics of the song that is playing now.
    this.requestSeq = 0;
    this.state = { status: 'idle', source: 'none', lines: [], match: null, error: null };
    this.loadDiskCache();
  }

  /**
   * Lyrics survive a restart: replaying a song (or pressing previous) then costs
   * no network round trip at all.
   */
  loadDiskCache() {
    if (!this.cacheFile) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return;
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        // Entries written before the cache key learned about version tags can
        // hold the wrong release (e.g. the sped-up lyrics of "放").
        if (!key.startsWith(CACHE_KEY_PREFIX)) continue;
        if (!entry || typeof entry.at !== 'number' || !entry.state) continue;
        const ttl = entry.state.status === 'ready' ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
        if (now - entry.at > ttl) continue;
        // Drop entries cached before the short-QRC fallback existed: they hold
        // the two-line placeholder that made those songs look frozen.
        if (
          entry.state.status === 'ready' &&
          entry.state.source === 'qrc' &&
          countSingableLines(entry.state.lines) < MIN_QRC_LINES
        ) {
          continue;
        }
        // Drop cached "nothing found" answers that carry no match: those are the
        // ones a transient search failure produces, and they would otherwise hide
        // a perfectly good song for ten minutes after a restart.
        if (entry.state.status !== 'ready' && !entry.state.match) continue;
        this.cache.set(key, entry);
      }
      if (this.cache.size) {
        this.logger?.info?.(`[Lyrics] restored ${this.cache.size} cached track(s)`);
      }
    } catch {
      /* no cache yet */
    }
  }

  scheduleDiskSave() {
    if (!this.cacheFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
        // Merge instead of overwrite: a plugin restart can briefly leave two
        // instances running, and the older one would otherwise clobber the
        // newer cache with its smaller map.
        const merged = {};
        try {
          const existing = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
          if (existing && typeof existing === 'object') {
            for (const [key, value] of Object.entries(existing)) {
              // Drop keys from an older matching rule set instead of carrying
              // their possibly wrong release forward forever.
              if (key.startsWith(CACHE_KEY_PREFIX)) merged[key] = value;
            }
          }
        } catch {
          /* no cache yet */
        }
        for (const [key, entry] of this.cache) {
          const previous = merged[key];
          if (!previous || (entry.at || 0) >= (previous.at || 0)) merged[key] = entry;
        }
        const keys = Object.keys(merged);
        if (keys.length > CACHE_LIMIT) {
          keys.sort((a, b) => (merged[a].at || 0) - (merged[b].at || 0));
          for (const stale of keys.slice(0, keys.length - CACHE_LIMIT)) delete merged[stale];
        }
        fs.writeFileSync(this.cacheFile, JSON.stringify(merged), 'utf8');
      } catch (err) {
        this.logger?.warn?.(`[Lyrics] cache write failed: ${err.message}`);
      }
    }, 1500);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  getState() {
    return this.state;
  }

  /**
   * Drops the current lyrics (but keeps the lookup cache) - used when playback
   * stops, so the lyric key can show the idle message instead of the last song.
   */
  reset() {
    this.state = { status: 'idle', source: 'none', lines: [], match: null, error: null };
    return this.state;
  }

  clearCache() {
    this.cache.clear();
    // Deliberately memory-only: this is also called on shutdown, and wiping the
    // on-disk cache there would defeat its whole purpose.
  }

  /**
   * Resolves lyrics for a track without touching the visible state.
   *
   * Used when the player's own UI already shows the next song but the media
   * session has not caught up yet: by the time the track change is detected the
   * lyrics are already cached, so nothing has to wait for the network.
   */
  async prefetch(track) {
    const title = String(track?.title || '').trim();
    if (!title) return;
    const artists = track.artists && track.artists.length ? track.artists : [track.artist].filter(Boolean);
    const key = this.cacheKey({ title, artist: artists.join(' ') });
    if (this.readCache(key)) return;
    try {
      const result = await this.lookupCoalesced({
        title,
        artists,
        durationMs: Number(track?.durationMs) || 0,
      }, key);
      this.writeCache(key, result);
      this.logger?.info?.(
        `[Lyrics] prefetched "${title}" -> ${result.status}` +
          (result.source && result.source !== 'none' ? ` (${result.source}, ${result.lines.length} lines)` : '')
      );
    } catch (err) {
      this.logger?.debug?.(`[Lyrics] prefetch failed for "${title}": ${err.message}`);
    }
  }

  cacheKey(track) {
    return `${CACHE_KEY_PREFIX}${versionAwareKey(track.title)}|${normalizeText(track.artist)}`;
  }

  /**
   * True when a cached answer was resolved from a *different arrangement* of
   * the song that is playing (the lyrics of a sped-up release do not line up
   * with the studio track). Only the first answer is rejected: if the search
   * keeps returning that same release, re-querying every poll would burn the
   * API for nothing, so the second read accepts it.
   */
  isVersionMismatch(player, cached) {
    const matchTitle = cached?.match?.title;
    if (!matchTitle) return false;
    if (versionScore(player.title, matchTitle) >= 1) return false;
    const key = this.cacheKey({ title: player.title, artist: (player.artists || []).join(' ') });
    this.versionRetried = this.versionRetried || new Set();
    if (this.versionRetried.has(key)) return false;
    this.versionRetried.add(key);
    this.logger?.info?.(
      `[Lyrics] cached match "${matchTitle}" is a different version of ` +
        `"${player.title}" - resolving again`
    );
    return true;
  }

  /**
   * Runs a lookup at most once per track at a time.
   *
   * The UI-based prefetch and the regular track change often ask for the same
   * song within a few hundred milliseconds of each other; sharing the in-flight
   * promise means one network round trip instead of two, and the lyrics land as
   * soon as the first of them finishes.
   */
  lookupCoalesced(player, key) {
    this.pending = this.pending || new Map();
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const task = this.lookup(player);
    this.pending.set(key, task);
    task
      .catch(() => {})
      .finally(() => {
        if (this.pending.get(key) === task) this.pending.delete(key);
      });
    return task;
  }

  readCache(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const ttl =
      entry.state.status === 'ready'
        ? CACHE_TTL_MS
        : entry.state.transient
          ? TRANSIENT_TTL_MS
          : NEGATIVE_TTL_MS;
    if (Date.now() - entry.at > ttl) {
      this.cache.delete(key);
      return null;
    }
    return entry.state;
  }

  writeCache(key, state) {
    this.cache.set(key, { at: Date.now(), state });
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    this.scheduleDiskSave();
  }

  /**
   * @param {{title:string, artist:string, artists?:string[], album?:string, durationMs?:number}} track
   * @param {{force?:boolean}} options
   */
  async resolve(track, { force = false } = {}) {
    const seq = ++this.requestSeq;
    const artists = track.artists && track.artists.length ? track.artists : [track.artist].filter(Boolean);
    const player = {
      title: track.title || '',
      artists,
      durationMs: Number(track.durationMs) || 0,
      // The media session knows which release is playing; the same song is
      // often on a single, an album and a compilation with different artwork.
      album: track.album || '',
    };

    if (!player.title) {
      this.state = { status: 'idle', source: 'none', lines: [], match: null, error: null };
      return this.state;
    }

    const key = this.cacheKey({ title: player.title, artist: artists.join(' ') });
    if (!force) {
      const cached = this.readCache(key);
      if (cached && this.isVersionMismatch(player, cached)) {
        // Answer belongs to another arrangement of the same title: drop it and
        // look the track up again instead of showing drifting lyrics.
        this.cache.delete(key);
      } else if (cached) {
        this.state = cached;
        return cached;
      }
    }

    this.state = { status: 'loading', source: 'none', lines: [], match: null, error: null };

    try {
      const result = await this.lookupCoalesced(player, key);
      // A transient failure is not cached (and carries a retry time) so the next
      // poll can pick the song up as soon as the search service answers again.
      const nextState = result.transient
        ? { ...result, retryAt: Date.now() + TRANSIENT_RETRY_MS }
        : result;
      if (!result.transient) this.writeCache(key, nextState);
      if (seq !== this.requestSeq) {
        // The track changed while this lookup was in flight: keep the answer for
        // when the user comes back to it, but never let it replace what is on
        // screen now.
        this.logger?.debug?.(
          `[Lyrics] dropped stale answer for "${player.title}" (${result.status}) - ` +
            'another track is playing'
        );
        return this.state;
      }
      this.state = nextState;
      if (result.status === 'ready') {
        this.logger?.info(
          `[Lyrics] ${result.source.toUpperCase()} matched "${result.match.title}" ` +
            `[${(result.match.artists || []).join(', ')}] score=${result.match.score.toFixed(2)} ` +
            `for "${player.title} - ${player.artists.join(', ')}" (${result.lines.length} lines)` +
            (player.album ? ` [album "${player.album}" -> "${result.match.albumName || ''}"]` : '')
        );
      } else {
        this.logger?.info(
          `[Lyrics] No lyrics for "${player.title} - ${player.artists.join(', ')}" (status: ${result.status})`
        );
      }
      // Return the stored state so callers see the transient retry marker too.
      return this.state;
    } catch (err) {
      this.logger?.error(`[Lyrics] Lookup failed: ${err.message}`);
      if (seq !== this.requestSeq) return this.state;
      this.state = {
        status: 'error',
        source: 'none',
        lines: [],
        match: null,
        error: err.message,
        transient: true,
        retryAt: Date.now() + TRANSIENT_RETRY_MS,
      };
      return this.state;
    }
  }

  async lookup(player) {
    const queries = [`${player.title} ${player.artists.join(' ')}`.trim()];
    // "失重前幸福 艾薇 Ivy" only returns the single, but the album release (a
    // different cover for the same recording) shows up once the album name is
    // part of the query. It runs only when needed, see the early break below.
    if (player.album) {
      queries.push(`${player.title} ${player.artists.join(' ')} ${player.album}`.trim());
    }
    queries.push(player.title);

    // A candidate from another album is not "good enough": the player told us
    // which release is playing, so keep looking for it.
    const albumSettled = (scoring) => !player.album || scoring.album >= 0.9;

    let best = null;
    let bestAny = null;
    let sawCandidates = 0;
    let searchMs = 0;
    // Handshake with the lyric host in the background while the search runs.
    warmLyricHost();
    const tried = new Set();
    for (const query of queries) {
      if (!query || tried.has(query)) continue;
      tried.add(query);
      const searchStarted = Date.now();
      const candidates = await searchSongs(query, { limit: 10 });
      searchMs += Date.now() - searchStarted;
      sawCandidates += candidates.length;
      for (const candidate of candidates) {
        const scoring = scoreCandidate(player, candidate);
        if (!bestAny || scoring.score > bestAny.scoring.score) bestAny = { candidate, scoring };
        if (scoring.title < MIN_TITLE_SCORE || scoring.score < MIN_MATCH_SCORE) continue;
        if (!best || scoring.score > best.scoring.score) best = { candidate, scoring };
      }
      this.logger?.debug?.(
        `[Lyrics] search "${query}" -> ${candidates.length} candidates` +
          (best ? `, best=${best.scoring.score.toFixed(2)}` : ', no match')
      );
      if (best && best.scoring.score >= 0.8 && albumSettled(best.scoring)) break;
    }

    if (!best) {
      // Keep the closest candidate so artwork can still be shown even when no
      // version passes the lyric-match threshold.
      const fallbackMatch = bestAny
        ? { ...bestAny.candidate, score: bestAny.scoring.score, scores: bestAny.scoring, artworkOnly: true }
        : null;
      // Nothing at all came back: the search service refused us (it does that
      // intermittently) rather than the song being absent. Retry soon instead of
      // showing "no lyrics" for the next ten minutes.
      const transient = sawCandidates === 0;
      if (transient) {
        this.logger?.warn(
          `[Lyrics] search returned nothing for "${player.title} - ${player.artists.join(', ')}" ` +
            `(${JSON.stringify(getLastSearchDiagnostics())}) - will retry in 60s`
        );
      }
      return { status: 'missing', source: 'none', lines: [], match: fallbackMatch, error: null, transient };
    }

    const match = {
      ...best.candidate,
      score: best.scoring.score,
      scores: best.scoring,
    };

    try {
      if (typeof this.onMatch === 'function') this.onMatch(match);
    } catch (err) {
      this.logger?.debug?.(`[Lyrics] onMatch hook failed: ${err.message}`);
    }

    const lyricStarted = Date.now();
    const qrc = await fetchQrcLyric(match.songId).catch((err) => {
      this.logger?.warn(`[Lyrics] QRC unavailable for ${match.songId}: ${err.message}`);
      return null;
    });

    const qrcLines = countSingableLines(qrc?.lines);
    const qrcComplete = qrcLooksComplete(qrcLines, player.durationMs);
    if (qrc && qrcComplete) {
      this.logger?.info?.(
        `[Lyrics] timing: search=${searchMs}ms lyric=${Date.now() - lyricStarted}ms (qrc)`
      );
      attachSecondaryLines(qrc.lines, qrc.translationLines, { field: 'translation' });
      attachSecondaryLines(qrc.lines, qrc.romanizationLines, { field: 'romanization' });
      return { status: 'ready', source: 'qrc', lines: qrc.lines, match, error: null };
    }
    if (qrcLines) {
      this.logger?.info?.(
        `[Lyrics] QRC for "${match.title}" has only ${qrcLines} usable line(s) - checking LRC`
      );
    }

    const lrc = await fetchPlainLyric(match.songMid).catch((err) => {
      this.logger?.warn(`[Lyrics] LRC unavailable for ${match.songMid}: ${err.message}`);
      return null;
    });

    const lrcLines = countSingableLines(lrc?.lines);
    // Only replace the word-by-word payload when the line-by-line one is
    // genuinely richer; never trade down.
    if (lrc && lrc.lines.length && (lrcLines > qrcLines || !qrcLines)) {
      this.logger?.info?.(
        `[Lyrics] timing: search=${searchMs}ms lyric=${Date.now() - lyricStarted}ms (lrc)`
      );
      attachSecondaryLines(lrc.lines, lrc.translationLines, { field: 'translation' });
      return { status: 'ready', source: 'lrc', lines: lrc.lines, match, error: null };
    }

    if (qrc && qrc.lines.length) {
      // The LRC was no better: keep the short word-by-word sheet.
      attachSecondaryLines(qrc.lines, qrc.translationLines, { field: 'translation' });
      attachSecondaryLines(qrc.lines, qrc.romanizationLines, { field: 'romanization' });
      return { status: 'ready', source: 'qrc', lines: qrc.lines, match, error: null };
    }

    return { status: 'missing', source: 'none', lines: [], match, error: null };
  }
}

module.exports = {
  LyricsService,
  normalizeText,
  similarity,
  scoreCandidate,
  versionScore,
  versionText,
  albumScore,
  MIN_MATCH_SCORE,
};
