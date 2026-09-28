'use strict';

/**
 * Parser for plain LRC (line-level) lyrics, used as a fallback when the
 * word-by-word QRC payload is unavailable for a song.
 */

const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

function parseOffset(text) {
  const match = String(text || '').match(/\[offset:\s*([+-]?\d+)\s*\]/i);
  return match ? Number(match[1]) : 0;
}

function parseLrcBody(body, { offsetMs = 0 } = {}) {
  const lines = [];

  for (const rawLine of String(body || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    TIMESTAMP.lastIndex = 0;
    const stamps = [...line.matchAll(TIMESTAMP)];
    if (!stamps.length) continue;

    const text = line.replace(TIMESTAMP, '').trim();
    if (!text || /^\[[a-z]+:/i.test(text)) continue;

    for (const stamp of stamps) {
      const minutes = Number(stamp[1] || 0);
      const seconds = Number(stamp[2] || 0);
      const fractionRaw = stamp[3] || '0';
      const fraction = Number(fractionRaw) / (fractionRaw.length === 3 ? 1000 : 100);
      lines.push({
        startMs: Math.round((minutes * 60 + seconds + fraction) * 1000) - offsetMs,
        text,
      });
    }
  }

  lines.sort((a, b) => a.startMs - b.startMs);
  return lines.map((line, index) => {
    const next = lines[index + 1];
    return {
      startMs: Math.max(0, line.startMs),
      endMs: next ? next.startMs : line.startMs + 6000,
      durationMs: next ? Math.max(0, next.startMs - line.startMs) : 6000,
      text: line.text,
      segments: null,
    };
  });
}

module.exports = { parseLrcBody, parseOffset };
