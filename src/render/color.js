'use strict';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseHex(hex) {
  const text = String(hex || '').trim().replace('#', '');
  const normalized =
    text.length === 3
      ? text
          .split('')
          .map((c) => c + c)
          .join('')
      : text.padEnd(6, '0').slice(0, 6);
  const value = Number.parseInt(normalized, 16);
  if (Number.isNaN(value)) return { r: 0, g: 0, b: 0 };
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

function toHex({ r, g, b }) {
  const part = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function rgba(hex, alpha = 1) {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function mix(hexA, hexB, ratio = 0.5) {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  const t = clamp(ratio, 0, 1);
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  });
}

function darken(hex, amount = 0.6) {
  return mix(hex, '#000000', amount);
}

function lighten(hex, amount = 0.3) {
  return mix(hex, '#FFFFFF', amount);
}

function luminance(hex) {
  const { r, g, b } = parseHex(hex);
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Picks black or white text for a given background. */
function readableTextColor(backgroundHex) {
  return luminance(backgroundHex) > 0.5 ? '#111111' : '#FFFFFF';
}

/**
 * Extracts a representative colour from an album cover by sampling a small
 * downscaled copy and averaging the most saturated pixels.
 */
function dominantColor(image) {
  if (!image) return null;
  const { createCanvas, getCanvas } = require('./engine');
  if (!getCanvas()) return null;

  const size = 24;
  const canvas = createCanvas(size, size);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, size, size);

  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return null;
  }

  let r = 0;
  let g = 0;
  let b = 0;
  let weight = 0;

  for (let i = 0; i < data.length; i += 4) {
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    const alpha = data[i + 3];
    if (alpha < 128) continue;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const brightness = max / 255;
    // Ignore near-black / near-white pixels, weight by saturation.
    if (brightness < 0.12 || brightness > 0.97) continue;
    const w = 0.15 + saturation;
    r += red * w;
    g += green * w;
    b += blue * w;
    weight += w;
  }

  if (!weight) return null;
  return toHex({ r: r / weight, g: g / weight, b: b / weight });
}

module.exports = {
  parseHex,
  toHex,
  rgba,
  mix,
  darken,
  lighten,
  luminance,
  readableTextColor,
  dominantColor,
};
