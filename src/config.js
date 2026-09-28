'use strict';

const fs = require('fs');
const path = require('path');

const { DEFAULT_CONFIG } = require('./constants');

/**
 * Persists plugin settings in `<plugin dir>/config.json`.
 * The file lives next to manifest.json and travels with the installed plugin.
 */
class ConfigManager {
  constructor(pluginPath, logger) {
    this.logger = logger;
    this.configPath = path.join(pluginPath, 'config.json');
    this.config = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch (err) {
      this.logger?.error(`[Config] Failed to read config.json: ${err.message}`);
    }
    return {};
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      return true;
    } catch (err) {
      this.logger?.error(`[Config] Failed to write config.json: ${err.message}`);
      return false;
    }
  }

  get(key) {
    const value = this.config[key];
    if (value === undefined || value === null || value === '') return DEFAULT_CONFIG[key];
    return value;
  }

  set(key, value) {
    this.config[key] = value;
  }

  /** Merge a partial settings object and persist it. */
  update(patch) {
    if (!patch || typeof patch !== 'object') return this.snapshot();
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      this.config[key] = value;
    }
    this.save();
    return this.snapshot();
  }

  /** Everything the config page needs, in one object. */
  snapshot() {
    return {
      provider: this.get('provider'),
      offsetMs: this.get('offsetMs'),
      pollIntervalMs: this.get('pollIntervalMs'),
      fontFamily: this.get('fontFamily'),
      manualSong: this.get('manualSong'),
      windowTitleApps: this.get('windowTitleApps'),
      debug: this.get('debug'),
      defaults: DEFAULT_CONFIG,
    };
  }
}

module.exports = { ConfigManager };
