'use strict';

const fs = require('fs');

const { getCanvas } = require('./engine');

const ALIAS = 'QQMusicNowCJK';

const CANDIDATES = {
  win32: [
    'C:/Windows/Fonts/msyh.ttc',
    'C:/Windows/Fonts/msyhbd.ttc',
    'C:/Windows/Fonts/simhei.ttf',
    'C:/Windows/Fonts/simsun.ttc',
    'C:/Windows/Fonts/Deng.ttf',
  ],
  darwin: [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
  ],
  linux: [
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  ],
};

let registered = null;

/**
 * Registers the first available CJK font file with the canvas global font set.
 * Falls back to the platform default family when nothing is found.
 */
function ensureFont(logger, overrideFamily) {
  if (overrideFamily && overrideFamily.trim()) {
    return { family: overrideFamily.trim(), source: 'config' };
  }
  if (registered) return registered;

  const mod = getCanvas();
  const paths = [...(CANDIDATES[process.platform] || []), ...(CANDIDATES.linux || [])];

  for (const fontPath of paths) {
    try {
      if (!fs.existsSync(fontPath)) continue;
      if (mod && mod.GlobalFonts && typeof mod.GlobalFonts.registerFromPath === 'function') {
        mod.GlobalFonts.registerFromPath(fontPath, ALIAS);
      }
      registered = { family: ALIAS, source: fontPath };
      logger?.info(`[Fonts] using ${fontPath}`);
      return registered;
    } catch (err) {
      logger?.warn(`[Fonts] failed to register ${fontPath}: ${err.message}`);
    }
  }

  registered = { family: 'sans-serif', source: 'default' };
  logger?.warn('[Fonts] no CJK font file found, relying on system default');
  return registered;
}

function fontString(size, family, weight = '') {
  const parts = [weight, `${Math.round(size)}px`, `"${family}"`, 'sans-serif'].filter(Boolean);
  return parts.join(' ');
}

module.exports = { ensureFont, fontString, FONT_ALIAS: ALIAS };
