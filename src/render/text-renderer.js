'use strict';

const { createCanvas, isAvailable } = require('./engine');
const { fontString } = require('./fonts');

/**
 * Renders a text-only key (status messages such as "QQ 音乐未在播放").
 *
 * These used to rely on FlexDesigner's own text rendering, but the host font has
 * no CJK glyphs, so Chinese came out as tofu boxes ("QQ □□□□□□"). Drawing the
 * message with our canvas keeps the same font as the lyrics.
 */
const DEFAULTS = {
  backgroundColor: '#000000',
  color: '#FFFFFF',
  secondaryColor: '#D6D6D6',
  paddingHorizontal: 12,
};

function fitFontSize(ctx, family, text, preferred, maxWidth, minScale = 0.55) {
  let size = preferred;
  while (size > preferred * minScale) {
    ctx.font = fontString(size, family);
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 1;
  }
  return Math.max(8, preferred * minScale);
}

/**
 * @param {{lines: Array<{text: string, color?: string, fontSize?: number}>,
 *          width?: number, height?: number, family?: string, options?: object}} input
 * @returns {Buffer|null} PNG buffer, or null when canvas is unavailable.
 */
function renderTextKey(input) {
  const { lines = [], width = 480, height = 60, family = 'sans-serif' } = input;
  const options = { ...DEFAULTS, ...(input.options || {}) };

  if (!isAvailable()) return null;
  const canvas = createCanvas(width, height);
  if (!canvas) return null;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = options.backgroundColor;
  ctx.fillRect(0, 0, width, height);

  const rows = lines.filter((line) => line && line.text);
  if (!rows.length) return canvas.toBuffer('image/png');

  const padding = Number(options.paddingHorizontal) || DEFAULTS.paddingHorizontal;
  const maxWidth = Math.max(20, width - padding * 2);
  const count = rows.length;

  rows.forEach((row, index) => {
    const primary = index === 0;
    const preferred =
      Number(row.fontSize) || (primary ? height * 0.42 : height * 0.3 * (count > 2 ? 0.85 : 1));
    const size = fitFontSize(ctx, family, row.text, preferred, maxWidth);
    ctx.font = fontString(size, family, primary ? 'bold' : '');
    ctx.fillStyle = row.color || (primary ? options.color : options.secondaryColor);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const y = count === 1 ? height / 2 : (height * (index + 0.5)) / count;
    ctx.fillText(row.text, width / 2, y);
  });

  return canvas.toBuffer('image/png');
}

module.exports = { renderTextKey };
