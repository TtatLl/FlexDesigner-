'use strict';

/**
 * Parser for QQ Music QRC (word-by-word) lyrics.
 *
 * The decrypted payload looks like:
 *
 *   <?xml version="1.0" encoding="utf-8"?>
 *   <QrcInfos>
 *     <QrcHeadInfo SaveTime="..." Version="100"/>
 *     <LyricInfo LyricCount="1">
 *       <Lyric_1 LyricType="1" LyricContent="[ti:起风了]
 *   [0,3600]起(0,211)风(211,211)了(422,211)..."/>
 *     </LyricInfo>
 *   </QrcInfos>
 *
 * Body lines are `[lineStartMs,lineDurationMs]` followed by `glyph(offsetMs,durationMs)`
 * pairs where the offsets are relative to the line start.
 */

const XML_ENTITIES = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};

function decodeXmlEntities(text) {
  return String(text || '').replace(/&(lt|gt|quot|apos|amp);/g, (m) => XML_ENTITIES[m] || m);
}

/** Pulls `LyricContent="..."` out of the decrypted QRC document. */
function extractLyricContent(xml) {
  if (!xml) return '';
  const start = xml.indexOf('<Lyric_1');
  const scope = start === -1 ? xml : xml.slice(start);
  const key = 'LyricContent="';
  const keyIndex = scope.indexOf(key);
  if (keyIndex === -1) return '';

  const body = scope.slice(keyIndex + key.length);
  const end = body.indexOf('"');
  const raw = end === -1 ? body : body.slice(0, end);
  return decodeXmlEntities(raw).replace(/\r\n?/g, '\n').trim();
}

const META_LINE = /^\[[a-zA-Z]{2,10}:[^\]]*\]$/;
const BODY_LINE = /^\[(\d+),(\d+)\]\s*(.*)$/;
const GLYPH = /([^()\n]*?)\((\d+),(\d+)\)/g;

/**
 * @returns {{startMs:number,endMs:number,durationMs:number,text:string,
 *            segments:Array<{text:string,startMs:number,endMs:number}>|null}[]}
 */
function parseQrcBody(body) {
  const lines = [];

  for (const rawLine of String(body || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || META_LINE.test(line)) continue;

    const match = line.match(BODY_LINE);
    if (!match) continue;

    const startMs = Number(match[1]);
    const durationMs = Number(match[2]);
    const content = match[3] || '';

    const segments = [];
    let text = '';
    let cursor = 0;
    GLYPH.lastIndex = 0;

    let glyph = GLYPH.exec(content);
    while (glyph) {
      const between = content.slice(cursor, glyph.index);
      const glyphText = `${between}${glyph[1]}`;
      cursor = glyph.index + glyph[0].length;

      if (!glyphText) {
        glyph = GLYPH.exec(content);
        continue;
      }

      const relStart = Number(glyph[2]);
      const glyphDuration = Number(glyph[3]);
      // QRC offsets are line-relative; guard against payloads that use absolute time.
      const absoluteStart = relStart >= startMs && relStart - startMs <= durationMs + 5000
        ? relStart
        : startMs + relStart;

      const segment = {
        text: glyphText,
        startMs: absoluteStart,
        endMs: absoluteStart + Math.max(0, glyphDuration),
      };
      segments.push(segment);
      text += glyphText;
      glyph = GLYPH.exec(content);
    }

    const trailing = content.slice(cursor).replace(/^\s+/, '');
    if (trailing) {
      text += trailing;
      const lastEnd = segments.length ? segments[segments.length - 1].endMs : startMs;
      segments.push({ text: trailing, startMs: lastEnd, endMs: startMs + durationMs });
    }

    const trimmed = text.trim();
    if (!trimmed) continue;

    // Keep segment timing aligned with the trimmed text we actually render.
    if (text !== trimmed) {
      const leading = text.length - text.trimStart().length;
      const trailingCount = text.length - text.trimEnd().length;
      let acc = 0;
      const adjusted = [];
      for (const segment of segments) {
        const segStart = acc;
        acc += segment.text.length;
        const segEnd = acc;
        const from = Math.max(segStart, leading);
        const to = Math.min(segEnd, text.length - trailingCount);
        if (to <= from) continue;
        adjusted.push({ ...segment, text: segment.text.slice(from - segStart, to - segStart) });
      }
      lines.push({
        startMs,
        durationMs,
        endMs: startMs + durationMs,
        text: trimmed,
        segments: adjusted.length ? adjusted : null,
      });
      continue;
    }

    lines.push({
      startMs,
      durationMs,
      endMs: startMs + durationMs,
      text: trimmed,
      segments: segments.length ? segments : null,
    });
  }

  lines.sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < lines.length; i += 1) {
    const next = lines[i + 1];
    if (next && lines[i].endMs > next.startMs) lines[i].endMs = next.startMs;
  }
  return lines;
}

module.exports = { extractLyricContent, parseQrcBody, decodeXmlEntities };
