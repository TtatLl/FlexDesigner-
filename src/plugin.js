'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { plugin, logger, pluginPath } = require('@eniac/flexdesigner');

const { CID, PROVIDERS } = require('./constants');
const { ConfigManager } = require('./config');
const { RuntimeState } = require('./state');
const { NowPlayingService } = require('./nowplaying');
const { MacAxTrackReader } = require('./nowplaying/macos-ax');
const { LyricsService } = require('./lyrics/service');
const { MediaKeys } = require('./media-keys');
const engine = require('./render/engine');
const { ensureFont } = require('./render/fonts');
const { CoverCache } = require('./render/cover');
const { ArtworkResolver } = require('./render/artwork');
const { fetchSongDetail, warmHosts } = require('./lyrics/qqmusic-api');
const { dominantColor } = require('./render/color');
const { renderLyric } = require('./render/lyric-renderer');
const { renderNowPlaying } = require('./render/nowplaying-renderer');
const { renderTextKey } = require('./render/text-renderer');

const HELPER_DIR = path.join(pluginPath, 'helper');

/**
 * Mirror the log into the OS temp directory.
 *
 * When the plugin runs as an *installed* plugin its own folder lives under
 * FlexDesigner's data directory, which is not always readable (Windows ACLs).
 * The mirror keeps the diagnostics reachable, e.g. by a support engineer or an
 * AI assistant working on the machine.
 */
const LOG_MIRROR = path.join(os.tmpdir(), 'qqmusicnow', 'plugin.log');
const LOG_MIRROR_MAX_BYTES = 4 * 1024 * 1024;

function enableLogMirror() {
  try {
    fs.mkdirSync(path.dirname(LOG_MIRROR), { recursive: true });
  } catch {
    return;
  }
  for (const level of ['info', 'warn', 'error', 'debug']) {
    if (typeof logger[level] !== 'function') continue;
    const original = logger[level].bind(logger);
    logger[level] = (...args) => {
      try {
        if (fs.existsSync(LOG_MIRROR) && fs.statSync(LOG_MIRROR).size > LOG_MIRROR_MAX_BYTES) {
          fs.writeFileSync(LOG_MIRROR, '', 'utf8');
        }
        fs.appendFileSync(
          LOG_MIRROR,
          `${new Date().toISOString()} [${level}] ${args
            .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
            .join(' ')}\n`,
          'utf8'
        );
      } catch {
        /* mirroring must never break the plugin */
      }
      return original(...args);
    };
  }
}

// ---------------------------------------------------------------------------
// Shared services
// ---------------------------------------------------------------------------

const config = new ConfigManager(pluginPath, logger);
const runtimeState = new RuntimeState(pluginPath, logger);
const coverCache = new CoverCache(logger);
const lyricsService = new LyricsService(logger, {
  cacheFile: path.join(pluginPath, 'cache', 'lyrics.json'),
  // Start fetching the cover as soon as the search picks a candidate, so the
  // artwork download overlaps the lyric download instead of queueing after it.
  onMatch: (match) => {
    // Only warm the artwork of the track that is on screen. A lookup that was
    // already in flight when the user skipped ahead must not pull the previous
    // song's cover over the current one.
    const current = nowPlaying.getSnapshot();
    if (current && !matchBelongsToTrack(match, current)) return;
    void artworkResolver.resolve(match).catch(() => {});
  },
});
const mediaKeys = new MediaKeys({ logger, helperDir: HELPER_DIR, config });
const nowPlaying = new NowPlayingService({
  logger,
  config,
  helperDir: HELPER_DIR,
  listWindows: () => plugin.getOpenedWindows(),
});
// macOS only: QQ Music's window shows the new song before its media session
// does, so we can resolve lyrics during that gap.
const axTrackReader =
  process.platform === 'darwin'
    ? new MacAxTrackReader({ logger, scriptPath: path.join(HELPER_DIR, 'macos', 'current-track.jxa') })
    : null;

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/** serialNumber -> Map<uid, key> */
const deviceKeys = new Map();

let pollTimer = null;
let lyricTimer = null;
let tickInProgress = false;
let receivedAlive = false;

let currentTrackSignature = '';
let lyricRequestId = 0;
/** key uid -> last rendered lyric signature */
const lyricSignatures = new Map();

/**
 * After the user presses play/pause the player needs a moment before it reports
 * the new state (QQ Music updates the Windows media session with a delay, and
 * macOS is slower still). During this window the icon follows the press instead
 * of the player, otherwise the state read back is stale and the icon visibly
 * flips: press -> new icon -> old icon -> new icon again.
 */
let pendingPlayback = null;
let lastPlayPauseState = null;

const PLAYBACK_SETTLE_MS = 3000;
const PLAYBACK_GIVE_UP_MS = 700;
const PLAYBACK_GIVE_UP_SAMPLES = 2;

function pendingPlaybackIsActive() {
  if (!pendingPlayback) return false;
  if (Date.now() > pendingPlayback.until) {
    logger.debug('[Plugin] playback state window expired without confirmation');
    pendingPlayback = null;
    return false;
  }
  return true;
}

function clearPendingPlayback(reason) {
  if (!pendingPlayback) return;
  logger.debug(`[Plugin] playback state settled (${reason})`);
  pendingPlayback = null;
}

/**
 * Decides which state a play/pause key should show:
 * the player's reported state, unless we are still waiting for it to catch up
 * with the button the user just pressed.
 */
function resolvePlaybackState(snapshot) {
  if (!pendingPlaybackIsActive()) {
    desiredPlaying = snapshot ? snapshot.isPlaying : desiredPlaying;
    return snapshot ? snapshot.isPlaying : false;
  }

  const pending = pendingPlayback;
  if (snapshot && snapshot.isPlaying === pending.expected) {
    desiredPlaying = snapshot.isPlaying;
    clearPendingPlayback('confirmed');
    return snapshot.isPlaying;
  }

  // The player keeps reporting the old state long after the press: the media
  // key probably did not reach it, so believe the player again.
  const sampleTime = snapshot ? Number(snapshot.positionAtMs) || 0 : 0;
  if (sampleTime > pending.requestedAt + PLAYBACK_GIVE_UP_MS) {
    pending.disagreements += 1;
    if (pending.disagreements >= PLAYBACK_GIVE_UP_SAMPLES) {
      desiredPlaying = snapshot ? snapshot.isPlaying : false;
      clearPendingPlayback('player disagrees');
      return snapshot ? snapshot.isPlaying : false;
    }
  }

  return pending.expected;
}
/**
 * Last playback state the user asked for. Pressing the key toggles this instead
 * of the player's (possibly stale) report, so a burst of presses always
 * alternates and cannot get stuck sending the same command.
 */
let desiredPlaying = null;
let lastNowPlayingSignature = '';
const inlineLogged = new Set();
let lastArtworkInfo = '';
let accentColor = null;
let accentColorSource = '';
let statusMessage = '';
let lastSourceSignature = '';
let diagnostics = { lastPollAt: 0, lastError: '', lyricRequests: 0 };

/**
 * Draw statistics. A Flexbar only shows the newest frame it receives, so if we
 * push frames faster than the transport can drain them the picture drifts
 * further and further behind the music. The measured ack time tells us the
 * real budget we can spend on a frame.
 */
const drawStats = {
  sent: 0,
  skipped: 0,
  failed: 0,
  rttSum: 0,
  rttSamples: 0,
  avgRtt: 0,
  rttMax: 0,
  lastReportAt: Date.now(),
};

// A round trip this slow means the link is busy (FlexDesigner uploading to the
// device, another plugin streaming frames): back off instead of queueing more
// work, otherwise the host's USB task queue overflows and transfers stall.
const SLOW_DRAW_MS = 120;
const LINK_COOLDOWN_MS = 2500;
// How long to wait before retrying a key the host has not activated yet. Long
// enough not to spam a rejected key, short enough that the cover and lyrics
// come back within seconds once FlexDesigner loads the layout.
const NOT_ALIVE_RETRY_MS = 2000;

/** pipeId -> { inFlight, pending, serialNumber, key } */
const drawPipes = new Map();
let lyricNextFrameAt = 0;

function reportDrawStats() {
  if (Date.now() - drawStats.lastReportAt < 10000) return;
  drawStats.lastReportAt = Date.now();
  const keySummary =
    [...deviceKeys.entries()]
      .map(([serial, keys]) => `${serial.slice(-4)}:${[...keys.values()].map((key) => key.cid.split('.').pop()).join('+') || '-'}`)
      .join(' ') || 'none';
  const lyricsState = lyricsService.getState();
  logger.debug(
    `[Draw][pid ${process.pid}] ${(drawStats.sent / 10).toFixed(1)} fps, ${drawStats.skipped} skipped, ` +
      `${drawStats.failed} failed, rtt avg=${drawStats.avgRtt}ms max=${drawStats.rttMax}ms | ` +
      `keys=${keySummary} | lyric timer=${lyricTimer ? 'on' : 'off'} ` +
      `state=${lyricsState.status}/${lyricsState.source}/${lyricsState.lines.length} ` +
      `playing=${nowPlaying.getSnapshot()?.isPlaying ? 'yes' : 'no'}`
  );
  drawStats.sent = 0;
  drawStats.skipped = 0;
  drawStats.failed = 0;
  drawStats.rttMax = 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function truncate(text, max = 40) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function findKeys(cid) {
  const result = [];
  for (const [serialNumber, keys] of deviceKeys) {
    for (const [, key] of keys) {
      if (!cid || key.cid === cid) result.push({ serialNumber, key });
    }
  }
  return result;
}

/**
 * Re-registers the key layout recorded by the previous run. Only used when the
 * host does not push `plugin.alive` after a restart.
 */
function restoreLayoutFromSnapshot() {
  const layout = runtimeState.loadKeys();
  if (!layout.length) {
    logger.warn('[Plugin] no plugin.alive and no layout snapshot - drag a key in FlexDesigner');
    // FlexDesigner only pushes `plugin.alive` when the layout changes or on app
    // start, so a freshly installed plugin can sit there without any keys. Tell
    // the user instead of silently drawing nothing.
    try {
      plugin.showSnackbarMessage(
        'warning',
        'QQMusicNow: 未收到按键布局。请在 FlexDesigner 里把任意一个插件按键拖动一下（松手即可），或重启 FlexDesigner 后重试。',
        12000
      );
    } catch (err) {
      logger.debug(`[Plugin] snackbar unavailable: ${err.message}`);
    }
    return false;
  }

  // The snapshot belongs to the machine it was written on: only restore entries
  // whose device is actually connected now.
  let connectedSerials = null;
  try {
    const devices = plugin.getDeviceStatus();
    if (devices && typeof devices.then === 'function') {
      // Never let a silent host block the restore forever.
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
      const restored = Promise.race([devices, timeout])
        .then((list) => applyLayoutSnapshot(layout, list))
        .catch(() => applyLayoutSnapshot(layout, null));
      // Apply immediately as well if the host is slow, so lyrics still show up.
      setTimeout(() => {
        if (!findKeys(null).length) applyLayoutSnapshot(layout, null);
      }, 3500);
      return restored;
    }
    connectedSerials = new Set((devices || []).map((device) => device.serialNumber));
  } catch {
    connectedSerials = null;
  }
  return applyLayoutSnapshot(layout, connectedSerials ? [...connectedSerials] : null);
}

function applyLayoutSnapshot(layout, devices) {
  const connected = devices ? new Set(devices.map((device) => device.serialNumber)) : null;
  let restored = 0;
  for (const entry of layout) {
    if (connected && !connected.has(entry.serialNumber)) continue;
    if (!deviceKeys.has(entry.serialNumber)) deviceKeys.set(entry.serialNumber, new Map());
    const keys = deviceKeys.get(entry.serialNumber);
    for (const key of entry.keys) {
      if (!key || key.uid === undefined || !key.cid) continue;
      keys.set(key.uid, key);
      restored += 1;
    }
  }

  if (!restored) return false;
  logger.info(
    `[Plugin] restored ${restored} key(s) from the layout snapshot ` +
      `(host did not send plugin.alive after the restart)`
  );
  lyricSignatures.clear();
  lastNowPlayingSignature = '';
  lastSourceSignature = '';
  statusMessage = '';
  void tick();
  return true;
}

/**
 * Learns a key from a `plugin.data` event.
 *
 * FlexDesigner only pushes `plugin.alive` when the layout changes or when the
 * app starts, so a plugin that is (re)started while the app is already running
 * never receives its key list and draws nothing. The host keeps routing presses
 * to the plugin though, so the first interaction is a chance to learn the key:
 * registering it here makes the whole layout come alive on the first press
 * instead of staying blank until the next FlexDesigner restart.
 */
function learnKeyFromInteraction(serialNumber, key) {
  if (!serialNumber || !key || key.uid === undefined || !key.cid) return false;
  const hadKeys = findKeys().length > 0;
  if (!deviceKeys.has(serialNumber)) deviceKeys.set(serialNumber, new Map());
  const keys = deviceKeys.get(serialNumber);
  if (!keys.has(key.uid)) {
    keys.set(key.uid, key);
    runtimeState.saveKeys(deviceKeys);
    logger.info(
      `[Plugin] learned key ${key.cid} from interaction ` +
        `(host sent no plugin.alive for this session)`
    );
  }
  if (!hadKeys) {
    // Nothing was registered a moment ago: treat this like a fresh layout so
    // the lyrics, cover and transport keys all paint immediately.
    lyricSignatures.clear();
    lastNowPlayingSignature = '';
    lastSourceSignature = '';
    statusMessage = '';
    void tick();
  }
  return true;
}

function hasKey(cid) {
  return findKeys(cid).length > 0;
}

function drawImage(serialNumber, key, buffer) {
  if (!buffer) return false;
  maybeDumpFrame(key.cid, buffer);
  key.style = key.style || {};
  key.style.showImage = true;
  key.style.showIcon = false;
  key.style.showTitle = false;
  key.style.image = `data:image/png;base64,${buffer.toString('base64')}`;
  safeDraw(serialNumber, key);
  return true;
}

const frameDumpAt = new Map();

/**
 * Optional: writes the frame that is about to be sent to the device, so the
 * rendered result can be inspected without the hardware. Enable with
 * `{ "debugDump": true }` in the plugin's config.json.
 */
function maybeDumpFrame(cid, buffer) {
  if (config.get('debugDump') !== true) return;
  const last = frameDumpAt.get(cid) || 0;
  if (Date.now() - last < 5000) return;
  frameDumpAt.set(cid, Date.now());
  try {
    const dir = path.join(pluginPath, 'logs', 'frames');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${cid.split('.').pop()}.png`), buffer);
  } catch (err) {
    logger.warn(`[Frames] dump failed: ${err.message}`);
  }
}

function drawText(serialNumber, key, text, { icon } = {}) {
  key.style = key.style || {};
  key.style.showImage = false;
  key.style.showTitle = true;
  if (icon) {
    key.style.showIcon = true;
    key.style.icon = icon;
  } else {
    key.style.showIcon = false;
  }
  key.title = truncate(text, 44);
  safeDraw(serialNumber, key);
}

/**
 * Draws a CJK-capable status message into a key.
 *
 * FlexDesigner's own text rendering has no CJK glyphs, so Chinese messages came
 * out as tofu boxes ("QQ □□□□□□"). Rendering the message with our canvas keeps
 * the same font as the lyrics; host text stays as the last-resort fallback.
 */
function drawStatusKey(serialNumber, key, message, { icon } = {}) {
  const width = key.style?.width || 480;
  const height = 60;
  const data = key.data || {};
  const buffer = renderTextKey({
    lines: [{ text: message, fontSize: Math.round(height * 0.42), color: data.primaryColor || '#FFFFFF' }],
    width,
    height,
    family: ensureFont(logger, config.get('fontFamily')).family,
    options: {
      backgroundColor: data.backgroundColor || '#000000',
      color: data.primaryColor || '#FFFFFF',
      secondaryColor: data.secondaryColor || '#D6D6D6',
    },
  });

  if (buffer) return drawImage(serialNumber, key, buffer);
  drawText(serialNumber, key, message, { icon });
  return false;
}

/**
 * Sends a frame with backpressure: at most one draw per key is in flight and
 * the newest frame always wins. Without this a slow link makes the device show
 * stale frames that lag further behind the longer the song runs - the classic
 * "device is out of sync with the music" symptom.
 */
function safeDraw(serialNumber, key) {
  const pipeId = `${serialNumber}:${key.uid ?? key.cid}`;
  let pipe = drawPipes.get(pipeId);
  if (!pipe) {
    pipe = { inFlight: false, pending: false, failures: 0, notAlive: 0, serialNumber, key };
    drawPipes.set(pipeId, pipe);
  }
  pipe.serialNumber = serialNumber;
  pipe.key = key;

  // A key that FlexDesigner keeps rejecting (e.g. it was removed from the layout
  // while we still had its old uid) is dropped instead of retried forever.
  if (pipe.failures >= 5) return;
  // "Plugin key is not alive" means the host has not activated this key yet -
  // normal right after a FlexDesigner restart, where the layout snapshot paints
  // before `plugin.alive` arrives. Retry slowly instead of spamming the link.
  if (pipe.notAliveUntil && Date.now() < pipe.notAliveUntil) return;

  if (pipe.inFlight) {
    pipe.pending = true;
    drawStats.skipped += 1;
    return;
  }

  pipe.inFlight = true;
  const startedAt = Date.now();
  drawStats.sent += 1;

  let result;
  try {
    result = plugin.draw(serialNumber, key, 'draw');
  } catch (err) {
    pipe.inFlight = false;
    drawStats.failed += 1;
    logger.error(`[Draw] failed: ${err.message}`);
    return;
  }

  const finish = (failed, error) => {
    const rtt = Date.now() - startedAt;
    drawStats.rttSum += rtt;
    drawStats.rttSamples += 1;
    drawStats.avgRtt = Math.round(drawStats.rttSum / drawStats.rttSamples);
    if (rtt > drawStats.rttMax) drawStats.rttMax = rtt;
    // "not alive" is the host saying "this key is not active yet" - it is not
    // link congestion, so it must not put the whole lyric pipeline on cooldown
    // (that would stall the keys that *are* working).
    const notAlive = failed && /not alive/i.test(String(error || ''));
    // Remember the worst recent round trip, not just the average: during an
    // upload the link saturates for a moment while most frames still answer
    // quickly, and the average hides exactly that.
    drawStats.worstRecent = Math.max(rtt, (drawStats.worstRecent || 0) * 0.7);
    if (rtt > SLOW_DRAW_MS || (failed && !notAlive)) {
      drawStats.congestedUntil = Date.now() + LINK_COOLDOWN_MS;
    }
    if (failed) {
      drawStats.failed += 1;
      pipe.pending = false;
      if (notAlive) {
        // The host activates the key as soon as it loads the layout that owns it,
        // and it does not re-send `plugin.alive` after every restart. Treating
        // this as a broken key used to disable the cover and lyric keys for the
        // rest of the session, so they now stay queued for a retry instead.
        pipe.notAlive = (pipe.notAlive || 0) + 1;
        pipe.notAliveUntil = Date.now() + NOT_ALIVE_RETRY_MS;
        if (pipe.notAlive <= 2) {
          logger.info(
            `[Draw] ${key.cid} (uid ${key.uid}) not activated by the host yet - ` +
              `retrying every ${NOT_ALIVE_RETRY_MS / 1000}s`
          );
        }
      } else {
        pipe.failures += 1;
        if (pipe.failures <= 3) {
          logger.warn(`[Draw] ${key.cid} (uid ${key.uid}) rejected: ${error || 'unknown error'}`);
        } else if (pipe.failures === 5) {
          logger.warn(`[Draw] ${key.cid} (uid ${key.uid}) disabled after 5 rejections`);
        }
      }
    }

    pipe.inFlight = false;
    if (pipe.pending) {
      pipe.pending = false;
      safeDraw(pipe.serialNumber, pipe.key);
    }
  };

  if (result && typeof result.then === 'function') {
    result.then(
      () => finish(false),
      (err) => finish(true, err && err.message)
    );
  } else {
    finish(false);
  }
}

function safeSet(serialNumber, key, data) {
  try {
    const result = plugin.set(serialNumber, key, data);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (err) {
    logger.error(`[Plugin] set failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Lyrics + artwork
// ---------------------------------------------------------------------------

async function ensureAccentColor(coverUrl, cover) {
  if (!cover) return null;
  if (accentColorSource === coverUrl && accentColor) return accentColor;
  accentColor = dominantColor(cover);
  accentColorSource = coverUrl || '';
  return accentColor;
}

/** Album artwork for the current track, with host/size/suffix fallbacks. */
const artworkResolver = new ArtworkResolver({ coverCache, logger, fetchSongDetail });

/**
 * True when a lyric match describes the track the player reports right now.
 *
 * Used to keep answers of an older, slower lookup (a QRC timeout can take ten
 * seconds) from touching the screen after the user skipped to another song.
 */
function matchBelongsToTrack(match, track) {
  if (!match || !track) return false;
  const same = (a, b) =>
    String(a || '')
      .trim()
      .toLowerCase() ===
    String(b || '')
      .trim()
      .toLowerCase();
  if (!same(match.title, track.title)) return false;
  const artists = match.artists || [];
  if (!artists.length || !track.artist) return true;
  return artists.some((artist) => same(artist, track.artist)) || same(match.artist, track.artist);
}

async function loadLyricsFor(snapshot, { force = false } = {}) {
  const requestId = ++lyricRequestId;
  diagnostics.lyricRequests += 1;
  lyricSignatures.clear();
  const startedAt = Date.now();

  const state = await lyricsService.resolve(
    {
      title: snapshot.title,
      artist: snapshot.artist,
      album: snapshot.album,
      durationMs: snapshot.durationMs,
    },
    { force }
  );

  if (requestId !== lyricRequestId) return;

  if (state.match) {
    // Warm artwork/accent in the background. Awaiting it here made the lyrics
    // wait for a metadata lookup plus an image download on every track change.
    void (async () => {
      try {
        const artwork = await artworkResolver.resolve(state.match);
        if (requestId !== lyricRequestId) return;
        if (artwork?.image) await ensureAccentColor(artwork.url, artwork.image);
      } catch (err) {
        logger.warn(`[Cover] accent lookup failed: ${err.message}`);
      }
    })();
  }

  logger.info(
    `[Lyric] ${state.status === 'ready' ? 'ready' : state.status} in ${Date.now() - startedAt}ms` +
      ` (${state.source || 'none'}${state.match ? `, ${state.match.title || ''}` : ''})`
  );
  void updateLyricKeys();
}

// ---------------------------------------------------------------------------
// Key renderers
// ---------------------------------------------------------------------------

async function updateNowPlayingKeys(snapshot, positionMs) {
  const targets = findKeys(CID.nowPlaying);
  if (!targets.length) return;

  const coverStartedAt = Date.now();
  const match = lyricsService.getState().match;
  // Prefer artwork that arrived with the media session: it is already in
  // memory, so the first frame of a new track shows the cover immediately
  // instead of waiting for the metadata lookup and an image download.
  const inlineKey = snapshot?.artworkData
    ? `session:${snapshot.title}|${snapshot.artist}`
    : '';
  let cover = inlineKey ? await coverCache.putInline(inlineKey, snapshot.artworkData) : null;
  let coverUrl = cover ? inlineKey : '';
  if (inlineKey && !inlineLogged.has(inlineKey)) {
    inlineLogged.add(inlineKey);
    if (inlineLogged.size > 20) inlineLogged.delete(inlineLogged.values().next().value);
    logger.info(
      `[Cover] media-session artwork ${cover ? `${cover.width}x${cover.height}` : 'undecodable'}` +
        ` (${Math.round(snapshot.artworkData.length / 1024)} KB)` +
        ` ready in ${Date.now() - coverStartedAt}ms`
    );
  } else if (!inlineKey && snapshot?.artworkInfo && snapshot.artworkInfo !== lastArtworkInfo) {
    // The media session had no usable thumbnail: report why (once per state).
    lastArtworkInfo = snapshot.artworkInfo;
    logger.debug(`[Cover] no media-session artwork (${snapshot.artworkInfo})`);
  }
  if (!cover) {
    const artwork = await artworkResolver.resolve(match);
    cover = artwork?.image || null;
    coverUrl = artwork?.url || '';
  }
  const accent = cover ? await ensureAccentColor(coverUrl, cover) : null;

  for (const { serialNumber, key } of targets) {
    const width = key.style?.width || 600;
    const height = 60;
    const options = { ...(key.data || {}), offsetMs: 0 };

    const signature = [
      width,
      snapshot ? snapshot.title : '',
      snapshot ? snapshot.artist : '',
      snapshot ? snapshot.album : '',
      Math.round((positionMs || 0) / 500),
      snapshot?.isPlaying ? '1' : '0',
      coverUrl,
      JSON.stringify(options),
      engine.isAvailable() ? 'c' : 't',
    ].join('|');
    if (signature === lastNowPlayingSignature) continue;
    lastNowPlayingSignature = signature;

    const buffer = renderNowPlaying({
      snapshot,
      options,
      width,
      height,
      cover,
      accentColor: accent,
      family: ensureFont(logger, config.get('fontFamily')).family,
      positionMs,
      idle: !snapshot,
      message: statusMessage || 'QQ 音乐未在播放',
    });

    if (buffer) drawImage(serialNumber, key, buffer);
    else if (!snapshot) drawText(serialNumber, key, statusMessage || 'QQ 音乐未在播放');
    else drawText(serialNumber, key, `${snapshot.title} - ${snapshot.artist}`.trim());
  }
}

async function updateLyricKeys(force = false) {
  const targets = findKeys(CID.lyric);
  if (!targets.length) return;

  const state = lyricsService.getState();
  const snapshot = nowPlaying.getSnapshot();
  const positionMs = nowPlaying.getEstimatedPositionMs();
  const family = ensureFont(logger, config.get('fontFamily')).family;

  // Nothing playable yet: fall back to a text key, but only redraw on change.
  if (state.status !== 'ready' || !state.lines.length) {
    const message =
      state.status === 'loading'
        ? '歌词加载中…'
        : state.status === 'error'
          ? '歌词获取失败'
          : snapshot
            ? '未找到歌词'
            : 'QQ 音乐未在播放';
    if (!force && message === statusMessage) return;
    statusMessage = message;
    logger.debug(`[Lyric] status text: ${message}`);
    for (const { serialNumber, key } of targets) drawStatusKey(serialNumber, key, message);
    return;
  }

  const offsetMs = Number(config.get('offsetMs')) || 0;

  // IMPORTANT: everything above and below runs on a ~30fps timer, so the hot
  // path must stay synchronous. Fetching artwork here used to starve the
  // renderer (and with it the lyric sync) whenever a cover was slow or missing;
  // artwork is now warmed by the 1s state loop and merely read here.
  const pending = [];
  for (const target of targets) {
    const signature = lyricSignature(state, target.key, positionMs, offsetMs, accentColor);
    if (!force && signature === lyricSignatures.get(target.key.uid)) continue;
    pending.push({ ...target, signature });
  }
  if (!pending.length) return;

  // Pace frames by the measured round-trip time so we never queue up frames the
  // device cannot display in time.
  if (!force) {
    const now = Date.now();
    if (now < lyricNextFrameAt) return;
    // Yield the link completely while the host is busy transferring something
    // to the device; the lyric key simply keeps its last frame for a moment.
    if (drawStats.congestedUntil && now < drawStats.congestedUntil) {
      lyricNextFrameAt = now + 500;
      return;
    }
    const budget = Math.max(drawStats.avgRtt, drawStats.worstRecent || 0);
    const baseInterval = Math.round(1000 / Math.max(5, Math.min(30, Number(config.get('lyricFps')) || 30)));
    lyricNextFrameAt = now + Math.max(baseInterval, Math.min(500, Math.round(budget * 1.2)));
  }

  for (const { serialNumber, key, signature } of pending) {
    lyricSignatures.set(key.uid, signature);
    const width = key.style?.width || 480;
    const options = { ...(key.data || {}), offsetMs };
    const position = Math.max(0, positionMs);
    const buffer = renderLyric({
      lyrics: state,
      positionMs: position,
      options,
      width,
      height: 60,
      accentColor,
      family,
    });

    if (buffer) drawImage(serialNumber, key, buffer);
    else {
      const lineIndex = findActiveLine(state.lines, position + offsetMs);
      const current = state.lines[Math.max(0, lineIndex)] || state.lines[0];
      drawText(serialNumber, key, current?.text || '♪');
    }
  }
}

/**
 * Cheap change-detection for a lyric key: only the values that actually alter
 * the rendered pixels.
 */
function lyricSignature(state, key, positionMs, offsetMs, accent) {
  const position = Math.max(0, positionMs) + offsetMs;
  const lineIndex =
    state.status === 'ready' && state.lines.length ? findActiveLine(state.lines, position) : -1;
  const line = lineIndex >= 0 ? state.lines[lineIndex] : null;
  const bucket = Math.round((lineProgress(line, position) || 0) * 250);
  const data = key.data || {};
  return [
    state.status,
    state.source,
    state.lines.length,
    state.match?.songMid || '',
    lineIndex,
    bucket,
    data.showDualLine === false ? 'single' : 'dual',
    data.showTranslation === false ? 'noTrans' : 'trans',
    data.highlightWord === false ? 'noHL' : 'hl',
    data.useDynamicBackground === true ? 'bg' : 'flat',
    key.style?.width || 480,
    accent || '-',
    Math.round(offsetMs),
    engine.isAvailable() ? 'c' : 't',
  ].join('|');
}

function findActiveLine(lines, positionMs) {
  let index = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startMs <= positionMs) index = i;
    else break;
  }
  return index;
}

function lineProgress(line, positionMs) {
  if (!line) return 0;
  const duration = Math.max(1, (line.endMs || line.startMs + 1) - line.startMs);
  return Math.min(1, Math.max(0, (positionMs - line.startMs) / duration));
}

// ---------------------------------------------------------------------------
// Status / control keys
// ---------------------------------------------------------------------------

const PROVIDER_LABELS = {
  smtc: 'SMTC',
  macos: 'macOS',
  window: '窗口',
  manual: '手动',
};

const LYRIC_SOURCE_LABELS = { qrc: 'QRC', lrc: 'LRC', none: '--' };

async function updateControlKeys(snapshot) {
  const isPlaying = resolvePlaybackState(snapshot);
  for (const { serialNumber, key } of findKeys(CID.playPause)) {
    const state = isPlaying ? 1 : 0;
    if (state !== lastPlayPauseState) {
      logger.info(
        `[State] play/pause key -> state ${state} (poll: ${isPlaying ? 'playing' : 'paused'}` +
          `${snapshot ? `, age=${Date.now() - (Number(snapshot.positionAtMs) || 0)}ms` : ', no snapshot'})`
      );
    }
    lastPlayPauseState = state;
    safeSet(serialNumber, key, { state });
  }

  const targets = findKeys(CID.source);
  if (!targets.length) return;

  const status = nowPlaying.status();
  const providerId = status.activeProvider?.id || (config.get('provider') === PROVIDERS.MANUAL ? 'manual' : '--');
  const lyricSource = lyricsService.getState().status === 'ready' ? lyricsService.getState().source : 'none';
  const text = `${PROVIDER_LABELS[providerId] || providerId} · ${LYRIC_SOURCE_LABELS[lyricSource] || lyricSource}`;
  const signature = `${text}|${status.snapshot ? 'playing' : 'idle'}|${engine.isAvailable()}`;
  if (signature === lastSourceSignature) return;
  lastSourceSignature = signature;

  for (const { serialNumber, key } of targets) {
    const lines = [];
    if (key.data?.showProviderName !== false) lines.push(PROVIDER_LABELS[providerId] || providerId);
    if (key.data?.showLyricSource !== false) lines.push(LYRIC_SOURCE_LABELS[lyricSource] || lyricSource);
    // Rendered as an image so Chinese labels ("窗口", "手动") do not turn into
    // tofu boxes in the host's Latin-only font.
    const buffer = renderTextKey({
      lines: lines.length
        ? lines.map((line, index) => ({
            text: line,
            fontSize: Math.round(60 * (index === 0 ? 0.34 : 0.26)),
          }))
        : [{ text: '--' }],
      width: key.style?.width || 240,
      height: 60,
      family: ensureFont(logger, config.get('fontFamily')).family,
      options: { backgroundColor: key.style?.bgColor || '#000000' },
    });
    if (buffer) drawImage(serialNumber, key, buffer);
    else drawText(serialNumber, key, lines.join(' · ') || '--');
  }
}

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

async function tick() {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    if (runtimeState.isSuperseded()) {
      logger.info('[Plugin] a newer plugin instance took over, exiting this one');
      shutdown();
      process.exit(0);
    }

    const snapshot = await nowPlaying.poll();
    diagnostics.lastPollAt = Date.now();
    reportDrawStats();

    if (snapshot) {
      const signature = `${snapshot.title}|${snapshot.artist}|${snapshot.source}`;
      if (signature !== currentTrackSignature) {
        currentTrackSignature = signature;
        accentColor = null;
        accentColorSource = '';
        lastNowPlayingSignature = '';
        logger.info(
          `[NowPlaying] "${snapshot.title} - ${snapshot.artist}" via ${snapshot.providerLabel || snapshot.source}` +
            ` playing=${snapshot.isPlaying}${snapshot.estimated ? ' (position estimated)' : ''}`
        );
        void loadLyricsFor(snapshot);
      }
    } else {
      currentTrackSignature = '';
      // Playback stopped (or QQ Music was closed): drop the lyrics of the last
      // song so the key shows "QQ 音乐未在播放" instead of stale lyrics.
      if (lyricsService.getState().status !== 'idle') {
        lyricsService.reset();
        lyricSignatures.clear();
        lastNowPlayingSignature = '';
        statusMessage = '';
      }
    }

    // Recover automatically from a lookup that failed for external reasons (the
    // search endpoint intermittently answers with nothing): retry the same song
    // after a short pause instead of leaving it without lyrics and artwork.
    const lyricState = lyricsService.getState();
    if (
      snapshot &&
      lyricState.status !== 'ready' &&
      lyricState.transient &&
      Date.now() >= (lyricState.retryAt || 0)
    ) {
      logger.info(
        `[Lyrics] retrying "${snapshot.title}" after a transient failure` +
          ` (previous: ${lyricState.status})`
      );
      lyricSignatures.clear();
      void loadLyricsFor(snapshot);
    }

    const positionMs = nowPlaying.getEstimatedPositionMs();
    await updateNowPlayingKeys(snapshot, positionMs);
    await updateControlKeys(snapshot);
    // Keep the QQ Music API sockets alive so the next track change does not pay
    // a TLS handshake before it can even ask for lyrics.
    if (snapshot?.isPlaying) warmHosts();
    syncLyricTimer();
    if (!lyricTimer) await updateLyricKeys();
  } catch (err) {
    diagnostics.lastError = err.message;
    logger.error(`[Plugin] tick failed: ${err.message}`);
  } finally {
    tickInProgress = false;
  }
}

function syncLyricTimer() {
  const shouldRun =
    hasKey(CID.lyric) &&
    engine.isAvailable() &&
    nowPlaying.getSnapshot()?.isPlaying &&
    lyricsService.getState().status === 'ready';

  if (shouldRun && !lyricTimer) {
    lyricTimer = setInterval(() => {
      void updateLyricKeys();
    }, 33);
    return;
  }
  if (!shouldRun && lyricTimer) {
    clearInterval(lyricTimer);
    lyricTimer = null;
  }
}

function startPollTimer() {
  if (pollTimer) clearInterval(pollTimer);
  const interval = Math.max(500, Number(config.get('pollIntervalMs')) || 1000);
  pollTimer = setInterval(() => {
    void tick();
  }, interval);
  logger.info(`[Plugin] poll interval: ${interval}ms`);
}

// ---------------------------------------------------------------------------
// System integration
// ---------------------------------------------------------------------------

function openExternalUrl(url) {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  } catch (err) {
    logger.error(`[Plugin] failed to open ${url}: ${err.message}`);
    return false;
  }
}

async function probeDetection() {
  const before = nowPlaying.getSnapshot();
  const snapshot = await nowPlaying.poll();
  return {
    ok: !!snapshot,
    snapshot: snapshot
      ? {
          title: snapshot.title,
          artist: snapshot.artist,
          album: snapshot.album,
          isPlaying: snapshot.isPlaying,
          source: snapshot.source,
          positionMs: Math.round(nowPlaying.getEstimatedPositionMs()),
          durationMs: snapshot.durationMs,
          estimated: !!snapshot.estimated,
        }
      : null,
    previous: before ? { title: before.title, artist: before.artist } : null,
    status: nowPlaying.status(),
    platform: process.platform,
    canvas: { available: engine.isAvailable(), error: engine.getLoadError() },
  };
}

async function handleKeyAction(serialNumber, key) {
  if (!key) return;
  const registered = deviceKeys.get(serialNumber);
  const target = (registered && registered.get(key.uid)) || key;

  switch (target.cid) {
    case CID.lyric: {
      target.data = target.data || {};
      const showDualLine = target.data.showDualLine !== false;
      target.data.showDualLine = !showDualLine;
      logger.info(`[Plugin] lyric mode: ${target.data.showDualLine ? 'dual' : 'single'} line`);
      lyricSignatures.clear();
      await updateLyricKeys(true);
      break;
    }
    case CID.source: {
      logger.info('[Plugin] reloading lyrics by user request');
      lyricsService.clearCache();
      const snapshot = nowPlaying.getSnapshot();
      if (snapshot) await loadLyricsFor(snapshot, { force: true });
      lastNowPlayingSignature = '';
      lastSourceSignature = '';
      statusMessage = '';
      await tick();
      break;
    }
    case CID.playPause: {
      const snapshot = nowPlaying.getSnapshot();
      // Toggle the last *requested* state, not the player's (often stale)
      // report: otherwise a second press during the settle window can compute
      // the same target twice and swallow the user's intent.
      const displayed = resolvePlaybackState(snapshot);
      const base = desiredPlaying === null ? displayed : desiredPlaying;
      const expected = !base;
      desiredPlaying = expected;

      // Show the state the user asked for immediately; the media command needs
      // a few hundred milliseconds before the player reflects it.
      pendingPlayback = {
        expected,
        requestedAt: Date.now(),
        until: Date.now() + PLAYBACK_SETTLE_MS,
        disagreements: 0,
      };
      lastPlayPauseState = expected ? 1 : 0;
      logger.info(`[State] play/pause key -> state ${expected ? 1 : 0} (${expected ? 'playing' : 'paused'})`);
      safeSet(serialNumber, target, { state: expected ? 1 : 0 });

      const sendStartedAt = Date.now();
      // macOS: hand the desired state over so QQ Music gets an explicit
      // play/pause (it ignores the system toggle command).
      const ok = await mediaKeys.send('playpause', { expectPlaying: expected });
      logger.info(
        `[Plugin] play/pause pressed (media key sent: ${ok}, ${Date.now() - sendStartedAt}ms)` +
          ` -> expecting ${expected ? 'playing' : 'paused'}`
      );
      await confirmPlaybackState(expected);
      break;
    }
    case CID.previous: {
      const before = currentTrackSignature;
      const previousTitle = nowPlaying.getSnapshot()?.title || '';
      const ok = await mediaKeys.send('previous');
      logger.info(`[Plugin] previous key pressed (media key sent: ${ok})`);
      void prefetchUpcomingTrack(previousTitle);
      await awaitTrackChange(before);
      await tick();
      break;
    }
    case CID.next: {
      const before = currentTrackSignature;
      const previousTitle = nowPlaying.getSnapshot()?.title || '';
      const ok = await mediaKeys.send('next');
      logger.info(`[Plugin] next key pressed (media key sent: ${ok})`);
      void prefetchUpcomingTrack(previousTitle);
      await awaitTrackChange(before);
      await tick();
      break;
    }
    default:
      logger.warn(`[Plugin] unhandled key: ${target.cid}`);
  }
}

/**
 * Starts resolving the lyrics of the song the player's own UI already shows,
 * which is how we hide the media session's ~1s lag on macOS.
 */
async function prefetchUpcomingTrack(previousTitle, budgetMs = 2500) {
  if (!axTrackReader || !previousTitle) return;
  const deadline = Date.now() + budgetMs;
  let first = true;
  while (Date.now() < deadline) {
    // First read straight away: every millisecond here is a millisecond the
    // lyric lookup cannot spend before the media session catches up.
    await sleep(first ? 0 : 120);
    first = false;
    const startedAt = Date.now();
    const track = await axTrackReader.read();
    if (!track || track.title === previousTitle) continue;
    logger.info(
      `[Lyrics] prefetch triggered by player UI: "${track.title} - ${track.artist}"` +
        ` (read in ${Date.now() - startedAt}ms)`
    );
    void lyricsService.prefetch(track);
    return;
  }
}

/**
 * After a skip press, watch the player instead of waiting for the next regular
 * poll: the new track is picked up within a few hundred milliseconds.
 */
async function awaitTrackChange(previousSignature, budgetMs = 2000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    await sleep(250);
    const snapshot = await nowPlaying.poll();
    const signature = snapshot ? `${snapshot.title}|${snapshot.artist}|${snapshot.source}` : '';
    if (signature && signature !== previousSignature) return true;
  }
  return false;
}

/**
 * Waits for the player to catch up with a play/pause press. Polls faster than
 * the regular tick so the pending window closes as soon as the state matches.
 */
async function confirmPlaybackState(expected) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await sleep(200);
    if (!pendingPlayback || pendingPlayback.expected !== expected) return;
    const snapshot = await nowPlaying.poll();
    if (snapshot && snapshot.isPlaying === expected) {
      clearPendingPlayback('confirmed by player');
      await updateControlKeys(snapshot);
      return;
    }
  }
  if (pendingPlayback && pendingPlayback.expected === expected) {
    clearPendingPlayback('poll window ended');
    await tick();
  }
}

// ---------------------------------------------------------------------------
// FlexDesigner events
// ---------------------------------------------------------------------------

plugin.on('plugin.alive', (payload) => {
  const { serialNumber, keys } = payload || {};
  if (!serialNumber || !Array.isArray(keys)) return;
  receivedAlive = true;

  // `plugin.alive` carries the complete key list for the device, so replace it:
  // keeping keys that were removed from the layout only produces failing draws.
  const registered = new Map();
  for (const key of keys) {
    if (key && key.uid !== undefined) registered.set(key.uid, key);
  }
  if (keys.length) deviceKeys.set(serialNumber, registered);
  else deviceKeys.delete(serialNumber);
  drawPipes.clear();

  logger.info(
    `[Plugin] device ${serialNumber} loaded ${keys.length} key(s): ${keys.map((k) => k.cid).join(', ')}`
  );
  lyricSignatures.clear();
  lastNowPlayingSignature = '';
  lastSourceSignature = '';
  statusMessage = '';
  runtimeState.saveKeys(deviceKeys);
  void tick();
});

plugin.on('plugin.data', (payload) => {
  const key = payload?.data?.key;
  const hostState = payload?.data?.state;
  // Self-heal: the host does not re-send `plugin.alive` for a plugin that
  // started after the layout was loaded, but it does keep delivering presses.
  learnKeyFromInteraction(payload?.serialNumber, key);
  if (key && key.cid === CID.playPause) {
    logger.debug(
      `[Plugin] play/pause click from host: state=${hostState} ` +
        `(last sent=${lastPlayPauseState})`
    );
  }
  setImmediate(() => {
    void handleKeyAction(payload?.serialNumber, key).catch((err) => {
      logger.error(`[Plugin] key action failed: ${err.message}`);
    });
  });
  return { status: 'success' };
});

plugin.on('device.status', (devices) => {
  const connected = new Set((devices || []).map((device) => device.serialNumber));
  for (const serialNumber of [...deviceKeys.keys()]) {
    if (!connected.has(serialNumber)) deviceKeys.delete(serialNumber);
  }
  runtimeState.saveKeys(deviceKeys);
  syncLyricTimer();
});

plugin.on('ui.message', async (payload) => {
  const action = payload?.action;
  switch (action) {
    case 'getConfig':
      return {
        config: config.snapshot(),
        platform: process.platform,
        canvas: { available: engine.isAvailable(), error: engine.getLoadError() },
        status: nowPlaying.status(),
        lyrics: {
          status: lyricsService.getState().status,
          source: lyricsService.getState().source,
          lines: lyricsService.getState().lines.length,
          match: lyricsService.getState().match
            ? {
                title: lyricsService.getState().match.title,
                artist: (lyricsService.getState().match.artists || []).join(', '),
                score: Number(lyricsService.getState().match.score?.toFixed(2)),
              }
            : null,
        },
      };

    case 'saveConfig': {
      config.update(payload.data || {});
      logger.info(`[Plugin] config updated: ${JSON.stringify(config.snapshot())}`);
      await nowPlaying.start();
      startPollTimer();
      lastNowPlayingSignature = '';
      lastSourceSignature = '';
      statusMessage = '';
      await tick();
      return { success: true, config: config.snapshot() };
    }

    case 'probe':
      return probeDetection();

    case 'reloadLyrics': {
      lyricsService.clearCache();
      const snapshot = nowPlaying.getSnapshot();
      if (snapshot) await loadLyricsFor(snapshot, { force: true });
      lyricSignatures.clear();
      await updateLyricKeys(true);
      return { success: true, lyrics: lyricsService.getState().status };
    }

    case 'openQqMusic': {
      const url = process.platform === 'darwin' ? 'qqmusic://' : 'qqmusic://';
      const opened = openExternalUrl(url);
      return { success: opened };
    }

    case 'getStatus':
      return { status: nowPlaying.status(), diagnostics };

    default:
      logger.warn(`[Plugin] unknown ui action: ${action}`);
      return { success: false, error: `unknown action ${action}` };
  }
});

plugin.on('system.actwin', () => {
  /* not used */
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function shutdown() {
  if (pollTimer) clearInterval(pollTimer);
  if (lyricTimer) clearInterval(lyricTimer);
  pollTimer = null;
  lyricTimer = null;
  nowPlaying.stop();
  mediaKeys.dispose();
  coverCache.clear();
  lyricsService.clearCache();
  logger.info('[Plugin] resources released');
}

process.on('SIGINT', () => {
  shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  shutdown();
  process.exit(0);
});

async function main() {
  // Take ownership before anything else so a stale runtime.json from an earlier
  // run can never make this process exit on start-up.
  runtimeState.claim();
  enableLogMirror();
  logger.info(
    `[Plugin] QQMusicNow starting on ${process.platform} (canvas: ${engine.isAvailable() ? 'yes' : 'no'})`
  );
  if (!engine.isAvailable()) {
    logger.warn(`[Plugin] canvas unavailable: ${engine.getLoadError() || 'unknown reason'} - text mode`);
  }
  ensureFont(logger, config.get('fontFamily'));
  nowPlaying.setManualSong(config.get('manualSong') || '');
  await nowPlaying.start();
  startPollTimer();
  void tick();

  // FlexDesigner only pushes plugin.alive when the key layout changes, so a
  // restarted plugin can be left without keys. Re-register the last known
  // layout until the host tells us otherwise.
  setTimeout(() => {
    if (!receivedAlive) restoreLayoutFromSnapshot();
  }, 3000);

  // Report which detection paths actually work on this machine, a few seconds
  // after start-up (checks are asynchronous).
  setTimeout(() => {
    const status = nowPlaying.status();
    logger.info(
      `[NowPlaying] provider status: ${(status.providers || [])
        .map((provider) => `${provider.id}=${provider.state}${provider.detail ? `(${provider.detail})` : ''}`)
        .join(', ')}`
    );
  }, 6000);
}

plugin.start();
void main();
