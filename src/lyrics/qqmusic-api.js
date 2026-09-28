'use strict';

/**
 * Minimal QQ Music web API client.
 *
 * - search:     u.y.qq.com/cgi-bin/musicu.fcg (DoSearchForQQMusicDesktop)
 * - QRC lyrics: c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg  (encrypted, needs qrc-decoder)
 * - LRC lyrics: c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg (plain text fallback)
 * - cover art:  y.qq.com/music/photo_new/T002R300x300M000<albumMid>.jpg
 */

const { decryptQrc } = require('qrc-decoder');

const { extractLyricContent, parseQrcBody } = require('./qrc-parser');
const { parseLrcBody, parseOffset } = require('./lrc-parser');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.132 Safari/537.36';
// QQ Music's search endpoint answers with code 2001 (risk control, empty result
// set) when no cookie is sent, so mirror what the official desktop client does.
const COOKIE =
  'os=pc;osver=Microsoft-Windows-10-Professional-build-16299.125-64bit;' +
  'appver=2.0.3.131777;channel=netease;__remember_me=true';
const DEFAULT_TIMEOUT_MS = 8000;

async function request(url, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://c.y.qq.com/',
        Cookie: COOKIE,
        ...(rest.headers || {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Like request(), but bounds the long tail.
 *
 * The lyric endpoint normally answers in 70-200 ms, yet occasionally stalls for
 * several seconds (measured 3.5-6.5 s spikes); a stalled request that is aborted
 * and retried almost always comes back immediately, so the worst case a user can
 * see is roughly one timeout instead of an unbounded wait.
 */
async function requestWithRetry(url, options = {}, { attempts = 2, timeoutMs = 4500 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request(url, { ...options, timeoutMs });
    } catch (err) {
      lastError = err;
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  }
  throw lastError || new Error('request failed');
}

/**
 * Opens the TLS connection to the lyric host while the search request runs.
 *
 * The search goes to u.y.qq.com but the lyric download to c.y.qq.com, so
 * without this every track change pays two TLS handshakes back to back.
 * Failures are irrelevant - this is only a warm-up.
 */
function warmLyricHost() {
  void fetch('https://c.y.qq.com/', {
    method: 'HEAD',
    headers: { 'User-Agent': USER_AGENT, Referer: 'https://y.qq.com/' },
  }).catch(() => {});
}

const WARM_HOSTS = ['https://u.y.qq.com/', 'https://c.y.qq.com/'];
let lastWarmAt = 0;

/**
 * Keeps the search and lyric connections alive while music is playing.
 *
 * Node's HTTP agent drops idle sockets after a few seconds, so without this
 * every track change pays the TLS handshake again (~150-250 ms each).
 * Throttled because it is only a keep-alive.
 */
function warmHosts(minIntervalMs = 15000) {
  const now = Date.now();
  if (now - lastWarmAt < minIntervalMs) return;
  lastWarmAt = now;
  for (const url of WARM_HOSTS) {
    void fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': USER_AGENT, Referer: 'https://y.qq.com/' },
    }).catch(() => {});
  }
}

function tagText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i');
  const match = String(xml || '').match(re);
  return match ? match[1].trim() : '';
}

function normalizeArtistList(item) {
  const singers = item.singer || item.singers || item.artist || [];
  if (Array.isArray(singers)) {
    // Entries are objects ({ name }) in the main API and plain strings in the
    // smart-box fallback.
    return singers
      .map((s) => (typeof s === 'string' ? s : s?.name))
      .filter(Boolean)
      .flatMap((name) => String(name).split(/[/、]/))
      .map((name) => name.trim())
      .filter(Boolean);
  }
  return String(singers || '').split(/[/、,&]/).map((s) => s.trim()).filter(Boolean);
}

function normalizeSong(item) {
  if (!item || typeof item !== 'object') return null;
  const songMid = item.songmid || item.mid || item.songMid || '';
  const songId = Number(item.songid || item.id || item.songId || 0);
  const title = item.songname || item.title || item.name || '';
  if (!songMid || !songId || !title) return null;

  const album = item.album || {};
  const albumMid = item.albummid || album.mid || item.albumMid || '';
  const interval = Number(item.interval || album.interval || 0);

  return {
    songMid,
    songId,
    title,
    albumName: item.albumname || album.name || item.albumName || '',
    albumMid,
    artists: normalizeArtistList(item),
    durationMs: interval > 0 ? interval * 1000 : 0,
    coverUrl: coverUrl(albumMid),
  };
}

function coverUrl(albumMid, size = 300) {
  if (!albumMid) return '';
  return `https://y.qq.com/music/photo_new/T002R${size}x${size}M000${albumMid}.jpg`;
}

/**
 * Cover art candidates for an album mid, most likely first.
 *
 * QQ Music serves the same artwork from several host/size combinations and a
 * few albums only exist with a `_2` suffix or on the gtimg CDN, so a single
 * hard coded URL leaves those albums without artwork.
 */
function coverCandidates(albumMid) {
  if (!albumMid) return [];
  const urls = [];
  const push = (host, size, suffix = '') => {
    const url = `https://${host}/music/photo_new/T002R${size}x${size}M000${albumMid}${suffix}.jpg`;
    if (!urls.includes(url)) urls.push(url);
  };
  push('y.qq.com', 300);
  push('y.qq.com', 500);
  push('y.gtimg.cn', 300);
  push('y.qq.com', 300, '_2');
  push('y.qq.com', 500, '_2');
  push('y.gtimg.cn', 500);
  return urls;
}

async function searchSongsViaMusicu(query, pageSize) {
  const response = await request('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
    body: JSON.stringify({
      req_1: {
        method: 'DoSearchForQQMusicDesktop',
        module: 'music.search.SearchCgiService',
        param: { num_per_page: String(pageSize), page_num: '1', query, search_type: 0 },
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  const body = payload?.req_1?.data?.body || {};
  const list = body.song?.list || body.item_song?.list || body.list || [];
  return { list, code: payload?.req_1?.code };
}

/** Full metadata for one song mid (also used by the smart-box fallback). */
async function fetchSongDetail(songMid) {
  if (!songMid) return null;
  const params = new URLSearchParams({
    songmid: songMid,
    platform: 'yqq',
    format: 'json',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    needNewCode: '0',
  });
  const response = await request(
    `https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?${params.toString()}`,
    { headers: { Referer: 'https://y.qq.com/' } }
  );
  const payload = await response.json().catch(() => null);
  const item = payload?.data?.[0];
  if (!item) return null;
  return normalizeSong({
    songmid: item.mid || songMid,
    songid: item.id,
    songname: item.title || item.name,
    album: item.album,
    albummid: item.album?.mid,
    singer: item.singer,
    interval: item.interval,
  });
}

/** Smart-box suggestions, used when the main search endpoint is rate limited. */
async function searchSongsViaSmartBox(query, limit) {
  const response = await request(
    `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=${encodeURIComponent(query)}&format=json`,
    { headers: { Referer: 'https://y.qq.com/' } }
  );
  const payload = await response.json().catch(() => null);
  const items = payload?.data?.song?.itemlist || [];

  const songs = [];
  for (const item of items.slice(0, Math.max(3, Math.min(limit, 6)))) {
    const direct = normalizeSong({
      songmid: item.mid,
      songid: item.id,
      songname: item.name,
      singer: typeof item.singer === 'string' ? item.singer.split(/[/、,]/) : item.singer,
    });
    const detail = direct && direct.songId ? direct : await fetchSongDetail(item.mid).catch(() => null);
    const song = detail || direct;
    if (song) songs.push(song);
  }
  return songs;
}

function normalizeSearchList(list) {
  const seen = new Set();
  const songs = [];
  for (const item of list) {
    const song = normalizeSong(item);
    if (!song || seen.has(song.songMid)) continue;
    seen.add(song.songMid);
    songs.push(song);
  }
  return songs;
}

/**
 * Song search. Returns normalized candidates ordered by QQ Music relevance.
 *
 * QQ's endpoints intermittently answer with an empty result set (observed both
 * as HTTP 200 + code 2001 and as a plain empty list, for a query that works a
 * minute later). A single empty answer must therefore not be treated as "this
 * song does not exist", so the two endpoints are tried back to back and the
 * main one gets one more chance after a short pause.
 */
async function searchSongs(query, { limit = 10 } = {}) {
  const pageSize = Math.max(1, Math.min(20, limit));

  const viaMusicu = async () => {
    try {
      const { list, code } = await searchSongsViaMusicu(query, pageSize);
      if (!list.length) return { songs: [], code };
      return { songs: normalizeSearchList(list), code };
    } catch (err) {
      return { songs: [], code: 'error', error: err.message };
    }
  };

  const viaSmartBox = async () => {
    try {
      return { songs: await searchSongsViaSmartBox(query, pageSize), code: 'smartbox' };
    } catch (err) {
      return { songs: [], code: 'smartbox-error', error: err.message };
    }
  };

  const first = await viaMusicu();
  if (first.songs.length) return first.songs;

  // Different endpoint, different chance: the smart box answers even while the
  // search service is refusing.
  const second = await viaSmartBox();
  if (second.songs.length) return second.songs;

  await new Promise((resolve) => setTimeout(resolve, 400));
  const third = await viaMusicu();
  if (third.songs.length) return third.songs;

  // Nothing usable: report why so a transient failure is visible in the log.
  lastSearchDiagnostics = {
    query,
    musicuCode: first.code,
    musicuError: first.error || third.error || null,
    smartBoxCode: second.code,
  };
  return [];
}

let lastSearchDiagnostics = null;

function getLastSearchDiagnostics() {
  return lastSearchDiagnostics;
}

/** Raw encrypted lyric bundle for a numeric song id. */
async function fetchLyricBundle(songId) {
  const response = await requestWithRetry('https://c.y.qq.com/qqmusic/fcgi-bin/lyric_download.fcg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      version: '15',
      miniversion: '82',
      lrctype: '4',
      musicid: String(songId),
    }).toString(),
  });
  const xml = await response.text();
  return {
    content: tagText(xml, 'content'),
    translation: tagText(xml, 'contentts'),
    romanization: tagText(xml, 'contentroma'),
  };
}

/** Plain (unencrypted) LRC + translation for a song mid. */
async function fetchPlainLyric(songMid) {
  const params = new URLSearchParams({
    songmid: songMid,
    format: 'json',
    nobase64: '1',
    g_tk: '5381',
    loginUin: '0',
    hostUin: '0',
    inCharset: 'utf8',
    outCharset: 'utf-8',
    notice: '0',
    platform: 'yqq.json',
    needNewCode: '0',
  });
  const response = await requestWithRetry(
    `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?${params.toString()}`,
    { headers: { Referer: 'https://y.qq.com/portal/player.html' } }
  );
  const payload = await response.json().catch(() => null);
  if (!payload || (payload.retcode !== 0 && payload.code !== 0)) return null;

  const lyric = typeof payload.lyric === 'string' ? payload.lyric : '';
  const trans = typeof payload.trans === 'string' ? payload.trans : '';
  if (!lyric) return null;

  const offsetMs = parseOffset(lyric);
  return {
    lines: parseLrcBody(lyric, { offsetMs }),
    translationLines: trans ? parseLrcBody(trans, { offsetMs }) : [],
  };
}

/**
 * Word-by-word QRC lyrics. Returns null when the song has no QRC payload.
 */
async function fetchQrcLyric(songId) {
  const bundle = await fetchLyricBundle(songId);
  if (!bundle.content) return null;

  const main = parseLyricPayload(bundle.content);
  if (!main.lines.length) return null;

  return {
    lines: main.lines,
    translationLines: bundle.translation ? safeParseLines(bundle.translation) : [],
    romanizationLines: bundle.romanization ? safeParseLines(bundle.romanization) : [],
  };
}

/** QRC payloads are encrypted hex, but some songs come back as plain text. */
function looksEncrypted(payload) {
  const clean = String(payload || '').replace(/\s+/g, '');
  return clean.length > 100 && clean.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(clean);
}

/**
 * Parses any QQ Music lyric payload: encrypted QRC hex, QRC XML, plain LRC or
 * bare text (instrumental notices and credit listings arrive unencrypted).
 */
function parseLyricPayload(payload) {
  const text = String(payload || '').trim();
  if (!text) return { lines: [] };

  if (text.includes('<QrcInfos') || text.includes('LyricContent=')) {
    return { lines: parseQrcBody(extractLyricContent(text) || text) };
  }

  if (looksEncrypted(text)) {
    let decrypted;
    try {
      decrypted = decryptQrc(text);
    } catch (err) {
      throw new Error(`QRC decrypt failed: ${err && err.message ? err.message : 'unreadable payload'}`);
    }
    return parseLyricPayload(decrypted);
  }

  const lrcLines = parseLrcBody(text);
  if (lrcLines.length) return { lines: lrcLines };

  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter(Boolean);
  if (!rows.length) return { lines: [] };

  // No timing information at all: rotate through the lines so the bar shows
  // something useful (e.g. "此歌曲为没有填词的纯音乐").
  const perLine = 4000;
  return {
    lines: rows.map((row, index) => ({
      startMs: index * perLine,
      endMs: (index + 1) * perLine,
      durationMs: perLine,
      text: row,
      segments: null,
    })),
  };
}

function safeParseLines(payload) {
  try {
    return parseLyricPayload(payload).lines;
  } catch {
    return [];
  }
}

/** Merge translation / romanization into lyric lines by nearest timestamp. */
function attachSecondaryLines(lines, secondary, { toleranceMs = 400, field = 'translation' } = {}) {
  if (!lines.length || !secondary || !secondary.length) return lines;
  const used = new Set();

  for (const line of lines) {
    let best = null;
    let bestDelta = Infinity;
    for (let i = 0; i < secondary.length; i += 1) {
      if (used.has(i)) continue;
      const delta = Math.abs(secondary[i].startMs - line.startMs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    }
    if (best !== null && bestDelta <= toleranceMs) {
      used.add(best);
      line[field] = secondary[best].text;
    }
  }
  return lines;
}

module.exports = {
  searchSongs,
  fetchSongDetail,
  fetchQrcLyric,
  fetchPlainLyric,
  fetchLyricBundle,
  coverUrl,
  coverCandidates,
  attachSecondaryLines,
  normalizeSong,
  parseLyricPayload,
  warmLyricHost,
  warmHosts,
  getLastSearchDiagnostics,
};
