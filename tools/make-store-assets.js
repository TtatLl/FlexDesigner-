#!/usr/bin/env node
'use strict';

/**
 * Renders the store listing images (gallery) for FlexGate.
 *
 * FlexGate asks for 1-3 images; the reference plugins use 3000x152 strips, i.e.
 * the Flexbar bar at banner resolution. The renderers scale proportionally, so
 * the same code path is used here as on the device.
 *
 *   node tools/make-store-assets.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'store');
const WIDTH = 3000;
const HEIGHT = 152;

const engine = require(path.join(ROOT, 'src', 'render', 'engine.js'));
const { ensureFont } = require(path.join(ROOT, 'src', 'render', 'fonts.js'));
const { renderLyric } = require(path.join(ROOT, 'src', 'render', 'lyric-renderer.js'));
const { renderNowPlaying } = require(path.join(ROOT, 'src', 'render', 'nowplaying-renderer.js'));
const { dominantColor } = require(path.join(ROOT, 'src', 'render', 'color.js'));
const api = require(path.join(ROOT, 'src', 'lyrics', 'qqmusic-api.js'));

const logger = { info: () => {}, warn: (msg) => console.warn(msg) };

async function loadRealCover(songMid) {
  const urls = api.coverCandidates(songMid);
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) continue;
      const image = await engine.loadImage(Buffer.from(await response.arrayBuffer()));
      if (image) return { image, url };
    } catch {
      /* try next */
    }
  }
  return null;
}

async function main() {
  if (!engine.isAvailable()) {
    console.error(`canvas unavailable: ${engine.getLoadError()}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const family = ensureFont(logger).family;

  // Use a real song so the store images match what users will see.
  const songs = await api.searchSongs('起风了 买辣椒也用券', { limit: 3 });
  const song = songs[0];
  const cover = song ? await loadRealCover(song.albumMid) : null;
  const accent = cover ? dominantColor(cover.image) : null;
  const qrc = song ? await api.fetchQrcLyric(song.songId).catch(() => null) : null;
  const lyrics = qrc || { lines: [] };

  // A second, foreign-language song for the lyric images: it has a translation
  // line, which is what the lyric key looks like for most non-Chinese tracks.
  const lyricSongs = await api.searchSongs('打上花火 DAOKO', { limit: 3 });
  const lyricSong = lyricSongs[0];
  const lyricQrc = lyricSong ? await api.fetchQrcLyric(lyricSong.songId).catch(() => null) : null;
  const lyricCover = lyricSong ? await loadRealCover(lyricSong.albumMid) : null;
  const lyricAccent = lyricCover ? dominantColor(lyricCover.image) : accent;
  if (lyricQrc) {
    api.attachSecondaryLines(lyricQrc.lines, lyricQrc.translationLines, { field: 'translation' });
  }
  const lyricSet = lyricQrc || lyrics;
  console.log(
    `now playing: ${song ? `${song.title} - ${song.artists.join(',')}` : '(none)'} (${lyrics.lines.length} lines, cover ${cover ? 'ok' : 'missing'})\n` +
      `lyrics: ${lyricSong ? `${lyricSong.title} - ${lyricSong.artists.join(',')}` : '(none)'} ` +
      `(${lyricSet.lines.length} lines, translations: ${lyricSet.lines.filter((line) => line.translation).length})`
  );

  const nowPlayingOptions = {
    showCover: true,
    showTitle: true,
    showArtist: true,
    showAlbum: true,
    showProgress: true,
    showTime: true,
    useDynamicBackground: true,
    backgroundColor: '#000000',
    primaryTextColor: '#FFFFFF',
    secondaryTextColor: '#D6D6D6',
    progressFillColor: '#31C27C',
    progressBgColor: '#404040',
  };

  const scale = HEIGHT / 60; // both renderers are authored for a 60px bar
  const lyricOptions = {
    showDualLine: true,
    showTranslation: true,
    highlightWord: true,
    useDynamicBackground: false,
    backgroundColor: '#000000',
    primaryColor: '#FFFFFF',
    highlightColor: '#31C27C',
    secondaryColor: '#9E9E9E',
    primaryAlign: 'center',
    // Keep the same proportions as the 60px device layout:
    // primary baseline = 5 + 22, secondary baseline = 35 + 17.
    primaryFontSize: Math.round(22 * scale),
    singleLineFontSize: Math.round(28 * scale),
    primaryPaddingTop: Math.round(5 * scale),
    secondaryFontSize: Math.round(17 * scale),
    secondaryPaddingTop: Math.round(35 * scale),
    paddingHorizontal: Math.round(40 * scale),
    offsetMs: 0,
  };

  const snapshot = {
    source: 'smtc',
    isPlaying: true,
    title: song ? song.title : '起风了 (旧版)',
    artist: song ? song.artists.join('/') : '买辣椒也用券',
    album: song ? song.albumName : '起风了',
    durationMs: song ? song.durationMs : 312000,
    positionMs: 96000,
    positionAtMs: Date.now(),
  };

  // 1. now playing bar
  fs.writeFileSync(
    path.join(OUT_DIR, 'gallery-1-nowplaying.png'),
    renderNowPlaying({
      snapshot,
      options: nowPlayingOptions,
      width: WIDTH,
      height: HEIGHT,
      cover: cover ? cover.image : null,
      accentColor: accent,
      family,
      positionMs: snapshot.positionMs,
    })
  );

  // 2. lyric bar with the word highlight mid-line. Skip the credit/heading lines
  // QQ puts at the start of the payload.
  const midLine =
    lyricSet.lines.find(
      (line) =>
        line.translation &&
        line.segments &&
        line.segments.length > 3 &&
        !/[:：]/.test(line.text) &&
        !/\s-\s/.test(line.text)
    ) ||
    lyricSet.lines.find(
      (line) =>
        line.segments && line.segments.length > 3 && !/[:：]/.test(line.text) && !/\s-\s/.test(line.text)
    ) ||
    lyricSet.lines[6] ||
    null;
  if (midLine) {
    console.log(`lyric frame line: "${midLine.text}"${midLine.translation ? ` / "${midLine.translation}"` : ''}`);
  }
  const midPosition = midLine ? midLine.startMs + (midLine.endMs - midLine.startMs) * 0.45 : 30000;
  fs.writeFileSync(
    path.join(OUT_DIR, 'gallery-2-lyric.png'),
    renderLyric({
      lyrics: lyricSet,
      positionMs: midPosition,
      options: lyricOptions,
      width: WIDTH,
      height: HEIGHT,
      accentColor: lyricAccent,
      family,
    })
  );

  // 3. translation / dynamic background variant
  fs.writeFileSync(
    path.join(OUT_DIR, 'gallery-3-translation.png'),
    renderLyric({
      lyrics: lyricSet,
      positionMs: midPosition,
      options: { ...lyricOptions, useDynamicBackground: true, backgroundColor: '#101010' },
      width: WIDTH,
      height: HEIGHT,
      accentColor: lyricAccent,
      family,
    })
  );

  console.log(`wrote 3 store images to ${OUT_DIR} (${WIDTH}x${HEIGHT})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
