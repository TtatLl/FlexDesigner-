'use strict';

const { createCanvas, isAvailable } = require('./engine');
const { fontString } = require('./fonts');
const { rgba, darken } = require('./color');

const DEFAULTS = {
  showDualLine: true,
  showTranslation: true,
  highlightWord: true,
  useDynamicBackground: false,
  backgroundColor: '#1A1A1A',
  primaryAlign: 'center',
  primaryFontSize: 22,
  singleLineFontSize: 28,
  primaryColor: '#FFFFFF',
  highlightColor: '#31C27C',
  primaryPaddingTop: 5,
  secondaryAlign: 'center',
  secondaryFontSize: 17,
  secondaryColor: '#D6D6D6',
  secondaryPaddingTop: 35,
  paddingHorizontal: 10,
};

/** Index of the line that should be highlighted at the given position. */
function findLineIndex(lines, positionMs) {
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startMs <= positionMs) index = i;
    else break;
  }
  return index;
}

/** How much of the current line has already been sung (0..1). */
function lineProgress(line, positionMs) {
  if (!line) return 0;
  const duration = Math.max(1, (line.endMs || line.startMs + 1) - line.startMs);
  return Math.min(1, Math.max(0, (positionMs - line.startMs) / duration));
}

function measure(ctx, text, family, size, weight) {
  ctx.font = fontString(size, family, weight);
  return ctx.measureText(String(text || '')).width;
}

/** Width of the sung part of a line, using per-glyph timings when available. */
function sungWidth(ctx, line, positionMs, family, size) {
  if (!line) return 0;
  if (Array.isArray(line.segments) && line.segments.length) {
    let width = 0;
    for (const segment of line.segments) {
      const segmentWidth = measure(ctx, segment.text, family, size);
      if (positionMs >= segment.endMs) {
        width += segmentWidth;
      } else if (positionMs > segment.startMs) {
        const ratio = (positionMs - segment.startMs) / Math.max(1, segment.endMs - segment.startMs);
        width += segmentWidth * ratio;
        break;
      } else {
        break;
      }
    }
    return width;
  }
  const total = measure(ctx, line.text, family, size);
  return total * lineProgress(line, positionMs);
}

function fitFontSize(ctx, family, text, preferredSize, maxWidth, minScale = 0.62) {
  let size = preferredSize;
  while (size > preferredSize * minScale) {
    if (measure(ctx, text, family, size) <= maxWidth) return size;
    size -= 1;
  }
  return Math.max(8, preferredSize * minScale);
}

function drawLine(ctx, line, positionMs, options) {
  const {
    text,
    align,
    fontSize,
    color,
    highlightColor,
    baseline,
    highlight,
    family,
    width,
    paddingHorizontal,
  } = options;

  if (!text) return;

  const available = Math.max(20, width - paddingHorizontal * 2);
  const size = fitFontSize(ctx, family, text, fontSize, available);
  const total = measure(ctx, text, family, size, '');

  let x;
  if (align === 'left') x = paddingHorizontal;
  else if (align === 'right') x = width - paddingHorizontal - total;
  else x = (width - total) / 2;

  ctx.font = fontString(size, family);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.fillText(text, x, baseline);

  if (!highlight) return;
  const progressWidth = Math.min(total, sungWidth(ctx, line, positionMs, family, size));
  if (progressWidth <= 0) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x - 1, baseline - size * 1.4, progressWidth + 1, size * 2);
  ctx.clip();
  ctx.fillStyle = highlightColor;
  ctx.fillText(text, x, baseline);
  ctx.restore();
}

/** Renders the lyric key. Returns a PNG buffer, or null without canvas support. */
function renderLyric(options) {
  const {
    lyrics,
    positionMs,
    width = 480,
    height = 60,
    accentColor = null,
    family = 'sans-serif',
  } = options;
  const opts = { ...DEFAULTS, ...(options.options || {}) };

  if (!isAvailable()) return null;
  const canvas = createCanvas(width, height);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');

  if (opts.useDynamicBackground && accentColor) {
    ctx.fillStyle = darken(accentColor, 0.62);
    ctx.fillRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, rgba(accentColor, 0.45));
    gradient.addColorStop(1, rgba(accentColor, 0.12));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.fillStyle = opts.backgroundColor;
    ctx.fillRect(0, 0, width, height);
  }

  const lines = (lyrics && lyrics.lines) || [];
  const offset = Number(opts.offsetMs || 0);
  const index = findLineIndex(lines, positionMs + offset);
  const current = index >= 0 ? lines[index] : lines[0] || null;
  const next = index >= 0 ? lines[index + 1] : lines[1];

  if (!current) {
    ctx.fillStyle = opts.secondaryColor;
    ctx.font = fontString(opts.secondaryFontSize, family);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♪', width / 2, height / 2);
    return canvas.toBuffer('image/png');
  }

  const sung = index >= 0 ? positionMs + offset : -Infinity;
  const paddingHorizontal = Number(opts.paddingHorizontal) || DEFAULTS.paddingHorizontal;

  if (opts.showDualLine !== false) {
    const primarySize = Number(opts.primaryFontSize) || DEFAULTS.primaryFontSize;
    const primaryTop = Number(opts.primaryPaddingTop ?? DEFAULTS.primaryPaddingTop);
    drawLine(ctx, current, sung, {
      text: current.text,
      align: opts.primaryAlign,
      fontSize: primarySize,
      color: opts.primaryColor,
      highlightColor: opts.highlightColor,
      baseline: primaryTop + primarySize,
      highlight: opts.highlightWord !== false && index >= 0,
      family,
      width,
      paddingHorizontal,
    });

    const secondarySize = Number(opts.secondaryFontSize) || DEFAULTS.secondaryFontSize;
    const secondaryText =
      opts.showTranslation !== false && current.translation
        ? current.translation
        : (next && next.text) || '';

    if (secondaryText) {
      drawLine(ctx, null, sung, {
        text: secondaryText,
        align: opts.secondaryAlign,
        fontSize: secondarySize,
        color: opts.secondaryColor,
        baseline:
          Number(opts.secondaryPaddingTop ?? DEFAULTS.secondaryPaddingTop) + secondarySize,
        highlight: false,
        family,
        width,
        paddingHorizontal,
      });
    }
  } else {
    const singleSize = Number(opts.singleLineFontSize) || DEFAULTS.singleLineFontSize;
    const baseline = Math.min(
      height - 4,
      height / 2 + singleSize * 0.36 + Number(opts.primaryPaddingTop || 0) * 0.4
    );
    drawLine(ctx, current, sung, {
      text: current.text,
      align: opts.primaryAlign,
      fontSize: singleSize,
      color: opts.primaryColor,
      highlightColor: opts.highlightColor,
      baseline,
      highlight: opts.highlightWord !== false && index >= 0,
      family,
      width,
      paddingHorizontal,
    });
  }

  return canvas.toBuffer('image/png');
}

module.exports = { renderLyric, findLineIndex, lineProgress, DEFAULTS };
