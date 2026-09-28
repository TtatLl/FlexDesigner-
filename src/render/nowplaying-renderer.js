'use strict';

const { createCanvas, isAvailable } = require('./engine');
const { fontString } = require('./fonts');
const { rgba, darken } = require('./color');
const { roundRect, ellipsize, drawImageContain, formatTime } = require('./draw');

const DEFAULTS = {
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

function drawIdle(ctx, { width, height, color, family, message }) {
  ctx.fillStyle = color;
  ctx.font = fontString(Math.min(18, height * 0.36), family);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}

/** Renders the now-playing key: cover art, metadata and progress bar. */
function renderNowPlaying(options) {
  const {
    snapshot,
    width = 600,
    height = 60,
    cover = null,
    accentColor = null,
    family = 'sans-serif',
    message = 'QQ 音乐未在播放',
    idle = false,
    positionMs = 0,
  } = options;
  const opts = { ...DEFAULTS, ...(options.options || {}) };

  if (!isAvailable()) return null;
  const canvas = createCanvas(width, height);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');

  if (idle || !snapshot) {
    ctx.fillStyle = opts.backgroundColor;
    ctx.fillRect(0, 0, width, height);
    drawIdle(ctx, {
      width,
      height,
      color: opts.secondaryTextColor,
      family,
      message,
    });
    return canvas.toBuffer('image/png');
  }

  if (opts.useDynamicBackground && accentColor) {
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, darken(accentColor, 0.4));
    gradient.addColorStop(1, darken(accentColor, 0.82));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.fillStyle = opts.backgroundColor;
    ctx.fillRect(0, 0, width, height);
  }

  // Vertical metrics are proportional to the key height so the same code can
  // render a 60px device key and a 152px store banner identically.
  const padding = Math.round(height * 0.133);
  const titleBaseline = padding + Math.round(height * 0.267);
  const secondaryBaseline = padding + Math.round(height * 0.517);
  const titleFont = Math.max(11, Math.round(height * 0.267));
  const secondaryFont = Math.max(9, Math.round(height * 0.2));
  const coverSize = height - padding * 2;
  let textX = padding;

  if (opts.showCover !== false) {
    ctx.save();
    roundRect(ctx, padding, padding, coverSize, coverSize, 6);
    ctx.clip();
    ctx.fillStyle = rgba('#FFFFFF', 0.08);
    ctx.fillRect(padding, padding, coverSize, coverSize);
    if (cover) {
      drawImageContain(ctx, cover, padding, padding, coverSize, coverSize);
    } else {
      ctx.fillStyle = rgba(opts.secondaryTextColor, 0.7);
      ctx.font = fontString(coverSize * 0.5, family);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♪', padding + coverSize / 2, padding + coverSize / 2);
    }
    ctx.restore();
    textX = padding + coverSize + Math.round(height * 0.167);
  }

  const rightPadding = width - padding;
  const elapsed = positionMs || snapshot.positionMs || 0;
  const timeText =
    opts.showTime !== false
      ? `${formatTime(elapsed)} / ${snapshot.durationMs ? formatTime(snapshot.durationMs) : '--:--'}`
      : '';

  ctx.font = fontString(secondaryFont, family);
  const timeWidth = timeText ? ctx.measureText(timeText).width : 0;
  const textRight = rightPadding - (timeText ? timeWidth + Math.round(height * 0.2) : 0);

  const title = snapshot.title || '';
  const secondary = [snapshot.artist, opts.showAlbum !== false ? snapshot.album : '']
    .filter(Boolean)
    .join('  ·  ');

  if (opts.showTitle !== false && title) {
    ctx.font = fontString(titleFont, family, 'bold');
    ctx.fillStyle = opts.primaryTextColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(ellipsize(ctx, title, Math.max(20, textRight - textX)), textX, titleBaseline);
  }

  if (secondary) {
    ctx.font = fontString(secondaryFont, family);
    ctx.fillStyle = opts.secondaryTextColor;
    ctx.textAlign = 'left';
    ctx.fillText(ellipsize(ctx, secondary, Math.max(20, textRight - textX)), textX, secondaryBaseline);
  }

  if (timeText) {
    ctx.font = fontString(secondaryFont, family);
    ctx.fillStyle = opts.secondaryTextColor;
    ctx.textAlign = 'right';
    ctx.fillText(timeText, rightPadding, secondaryBaseline);
  }

  if (opts.showProgress !== false) {
    const barHeight = Math.max(3, Math.round(height * 0.067));
    // Anchored to the very bottom so it never crowds the text rows.
    const barY = height - barHeight - Math.max(1, Math.round(height * 0.017));
    const barWidth = Math.max(20, rightPadding - textX);
    const ratio = snapshot.durationMs
      ? Math.min(1, Math.max(0, elapsed / snapshot.durationMs))
      : 0;

    ctx.fillStyle = opts.progressBgColor;
    roundRect(ctx, textX, barY, barWidth, barHeight, barHeight / 2);
    ctx.fill();

    if (ratio > 0) {
      ctx.fillStyle = opts.progressFillColor;
      roundRect(ctx, textX, barY, Math.max(barHeight, barWidth * ratio), barHeight, barHeight / 2);
      ctx.fill();
    }
  }

  return canvas.toBuffer('image/png');
}

module.exports = { renderNowPlaying, DEFAULTS };
