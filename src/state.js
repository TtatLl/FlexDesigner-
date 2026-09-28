'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Where the fallback copy of the key layout lives.
 *
 * The layout snapshot normally sits in `runtime.json` inside the plugin folder,
 * but installing an update replaces that folder - and FlexDesigner does not
 * push `plugin.alive` again until it restarts, so a freshly updated plugin would
 * sit there without any keys to draw into. Keeping a second copy outside the
 * plugin folder makes the device come back on its own after an update.
 */
function userStateDir() {
  if (process.env.QQMUSICNOW_STATE_DIR) return process.env.QQMUSICNOW_STATE_DIR;
  try {
    if (process.platform === 'win32') {
      const base = process.env.LOCALAPPDATA || process.env.APPDATA;
      if (base) return path.join(base, 'QQMusicNow');
    } else if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'QQMusicNow');
    } else {
      const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
      return path.join(base, 'QQMusicNow');
    }
  } catch {
    /* fall through to the temp folder */
  }
  return path.join(os.tmpdir(), 'QQMusicNow');
}

/**
 * Small runtime state file inside the plugin folder. It serves two purposes:
 *
 *  1. Single instance guard - FlexDesigner spawns a fresh process on every
 *     link/restart and does not always stop the previous one; an outdated
 *     process would keep drawing stale frames to the device forever.
 *  2. Key layout snapshot - `plugin.alive` is only pushed when the layout
 *     changes, so a restarted plugin otherwise has no keys to draw into.
 */
class RuntimeState {
  constructor(pluginPath, logger) {
    this.logger = logger;
    this.file = path.join(pluginPath, 'runtime.json');
    this.mirrorFile = path.join(userStateDir(), 'layout.json');
    this.startedAt = Date.now();
  }

  read() {
    try {
      if (!fs.existsSync(this.file)) return null;
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  /** The layout remembered outside the plugin folder (last resort after an update). */
  readMirror() {
    try {
      if (!fs.existsSync(this.mirrorFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.mirrorFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  write(state) {
    try {
      fs.writeFileSync(this.file, JSON.stringify(state), 'utf8');
    } catch (err) {
      this.logger?.warn(`[State] cannot write runtime.json: ${err.message}`);
      return false;
    }
    // Best effort: the mirror must never break the main state file.
    try {
      const previous = this.readMirror();
      const merged = new Map();
      for (const entry of previous?.layout || []) {
        if (entry?.serialNumber) merged.set(entry.serialNumber, entry);
      }
      for (const entry of state.layout || []) {
        if (entry?.serialNumber) merged.set(entry.serialNumber, entry);
      }
      const layout = [...merged.values()].slice(-4);
      fs.mkdirSync(path.dirname(this.mirrorFile), { recursive: true });
      fs.writeFileSync(this.mirrorFile, JSON.stringify({ layout }), 'utf8');
    } catch (err) {
      this.logger?.debug?.(`[State] cannot write layout mirror: ${err.message}`);
    }
    return true;
  }

  /** Claims ownership for this process. Returns the previous state. */
  claim() {
    const previous = this.read();
    this.write({
      ...(previous || {}),
      pid: process.pid,
      startedAt: this.startedAt,
      layout: previous && previous.layout ? previous.layout : undefined,
    });
    return previous;
  }

  /** True when another (newer) plugin process has taken over. */
  isSuperseded() {
    const state = this.read();
    if (!state || !state.pid || state.pid === process.pid) return false;
    // Only a process that started later than us can supersede us; a stale file
    // left behind by a previous run must never block a fresh start.
    return Number(state.startedAt) > this.startedAt;
  }

  saveKeys(deviceKeys) {
    const snapshot = [...deviceKeys.entries()].map(([serialNumber, keys]) => ({
      serialNumber,
      keys: [...keys.values()],
    }));
    if (this.isSuperseded()) return false;
    const previous = this.read() || {};
    this.write({ ...previous, pid: process.pid, startedAt: this.startedAt, layout: snapshot });
    return true;
  }

  loadKeys() {
    const usable = (state) =>
      state && Array.isArray(state.layout)
        ? state.layout.filter((entry) => entry && entry.serialNumber && Array.isArray(entry.keys))
        : [];
    const own = usable(this.read());
    if (own.length) return own;
    return usable(this.readMirror());
  }
}

module.exports = { RuntimeState };
