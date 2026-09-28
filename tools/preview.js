#!/usr/bin/env node
'use strict';

/**
 * Renders the key layouts to PNG files under ./preview so the design can be
 * checked without a Flexbar device:
 *
 *   npm run preview
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'preview');

const engine = require(path.join(ROOT, 'src', 'render', 'engine.js'));
const { ensureFont } = require(path.join(ROOT, 'src', 'render', 'fonts.js'));
const { renderLyric } = require(path.join(ROOT, 'src', 'render', 'lyric-renderer.js'));
const { renderNowPlaying } = require(path.join(ROOT, 'src', 'render', 'nowplaying-renderer.js'));
const { dominantColor } = require(path.join(ROOT, 'src', 'render', 'color.js'));

const SAMPLE_LINES = [
  { startMs: 0, endMs: 4200, durationMs: 4200, text: '这一路上走走停停', translation: null, segments: null },
  {
    startMs: 4200,
    endMs: 8600,
    durationMs: 4400,
    text: '顺着少年漂流的痕迹',
    translation: 'following the traces of the drifting youth',
    segments: [
      { text: '顺', startMs: 4200, endMs: 4600 },
      { text: '着', startMs: 4600, endMs: 5000 },
      { text: '少', startMs: 5000, endMs: 5400 },
      { text: '年', startMs: 5400, endMs: 5800 },
      { text: '漂', startMs: 5800, endMs: 6200 },
      { text: '流', startMs: 6200, endMs: 6600 },
      { text: '的', startMs: 6600, endMs: 7000 },
      { text: '痕', startMs: 7000, endMs: 7400 },
      { text: '迹', startMs: 7400, endMs: 7800 },
    ],
  },
  { startMs: 8600, endMs: 12800, durationMs: 4200, text: '迈出车站的前一刻', translation: null, segments: null },
];

function makeCover() {
  const canvas = engine.createCanvas(300, 300);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 300, 300);
  gradient.addColorStop(0, '#1f3b73');
  gradient.addColorStop(0.5, '#31C27C');
  gradient.addColorStop(1, '#f2c14e');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 300, 300);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = 'bold 120px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('♪', 150, 150);
  return engine.loadImage(canvas.toBuffer('image/png'));
}

async function main() {
  if (!engine.isAvailable()) {
    console.error(`canvas unavailable: ${engine.getLoadError()}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const family = ensureFont({ info: () => {}, warn: console.warn }).family;
  const cover = await makeCover();
  const accentColor = dominantColor(cover);

  const snapshot = {
    source: 'smtc',
    isPlaying: true,
    title: '起风了 (旧版)',
    artist: '买辣椒也用券',
    album: '起风了',
    durationMs: 312000,
    positionMs: 0,
    positionAtMs: Date.now(),
  };

  const nowPlaying = renderNowPlaying({
    snapshot: { ...snapshot, positionMs: 96000 },
    options: {
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
    },
    width: 600,
    height: 60,
    cover,
    accentColor,
    family,
    positionMs: 96000,
  });
  fs.writeFileSync(path.join(OUT_DIR, 'nowplaying.png'), nowPlaying);

  const lyricOptions = {
    showDualLine: true,
    showTranslation: true,
    highlightWord: true,
    backgroundColor: '#000000',
    primaryColor: '#FFFFFF',
    highlightColor: '#31C27C',
    secondaryColor: '#9E9E9E',
    primaryAlign: 'center',
    primaryFontSize: 22,
    singleLineFontSize: 28,
    primaryPaddingTop: 5,
    secondaryFontSize: 17,
    secondaryPaddingTop: 35,
    paddingHorizontal: 10,
    offsetMs: 0,
  };

  const lyricStates = [
    { name: 'lyric-dual-early', positionMs: 5200, options: lyricOptions },
    { name: 'lyric-dual-mid', positionMs: 6600, options: lyricOptions },
    { name: 'lyric-dual-late', positionMs: 7600, options: lyricOptions },
    {
      name: 'lyric-single',
      positionMs: 6600,
      options: { ...lyricOptions, showDualLine: false },
    },
    {
      name: 'lyric-dynamic-bg',
      positionMs: 6600,
      options: { ...lyricOptions, useDynamicBackground: true, backgroundColor: '#101010' },
    },
  ];

  for (const state of lyricStates) {
    const buffer = renderLyric({
      lyrics: { status: 'ready', source: 'qrc', lines: SAMPLE_LINES },
      positionMs: state.positionMs,
      options: state.options,
      width: 480,
      height: 60,
      accentColor,
      family,
    });
    fs.writeFileSync(path.join(OUT_DIR, `${state.name}.png`), buffer);
  }

  const sheet = await buildContactSheet(path.join(OUT_DIR, 'nowplaying.png'), lyricStates.map((s) => path.join(OUT_DIR, `${s.name}.png`)));
  if (sheet) fs.writeFileSync(path.join(OUT_DIR, 'preview.png'), sheet);

  console.log(`wrote previews to ${OUT_DIR}`);
}

async function buildContactSheet(nowPlayingPath, lyricPaths) {
  const images = [];
  for (const file of [nowPlayingPath, ...lyricPaths]) {
    images.push(await engine.loadImage(fs.readFileSync(file)));
  }
  const width = 640;
  const rowHeight = 74;
  const canvas = engine.createCanvas(width, rowHeight * images.length + 8);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#151515';
  ctx.fillRect(0, 0, width, canvas.height);
  images.forEach((image, index) => {
    ctx.drawImage(image, 8, index * rowHeight + 8);
  });
  return canvas.toBuffer('image/png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
