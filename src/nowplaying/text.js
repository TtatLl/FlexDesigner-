'use strict';

/**
 * Helpers shared by the now-playing providers: turning whatever string a
 * platform gives us ("Song - Artist", "Artist – Song", ...) into a track.
 */

const SEPARATORS = [' - ', ' – ', ' — ', ' | ', ' · ', '-', '–'];

const NOISE = [
  /[\[(【（]\s*(官方|伴奏|纯音乐|instrumental|official|mv|hd|hq|live|lyrics?|动态歌词)\s*[\])】）]/gi,
  /\s*[-–—|]\s*(QQ音乐|QQMusic|网易云音乐|酷狗音乐|Spotify)\s*$/i,
];

function cleanTitle(value) {
  let text = String(value || '').trim();
  for (const pattern of NOISE) text = text.replace(pattern, ' ');
  return text.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Parses a window title such as "起风了 - 买辣椒也用券" into {title, artist}.
 * When no separator is present the whole string is treated as the title.
 */
function parseTrackString(value) {
  const raw = cleanTitle(value);
  if (!raw) return { title: '', artist: '' };

  for (const separator of SEPARATORS) {
    const index = raw.indexOf(separator);
    if (index <= 0) continue;
    const left = raw.slice(0, index).trim();
    const right = raw.slice(index + separator.length).trim();
    if (!left || !right) continue;
    return { title: left, artist: right };
  }

  return { title: raw, artist: '' };
}

/** True when a window title looks like a QQ Music window. */
function looksLikeQqMusic(text) {
  return /qq\s?音乐|qqmusic/i.test(String(text || ''));
}

module.exports = { parseTrackString, cleanTitle, looksLikeQqMusic };
