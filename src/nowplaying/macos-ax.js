'use strict';

const { spawn } = require('child_process');

/**
 * Reads the track QQ Music currently shows in its own window (macOS only).
 *
 * QQ Music updates its UI the instant a song changes but its media session -
 * the source the plugin normally uses - lags by about a second. This reader
 * closes that gap: the plugin can start resolving lyrics during the lag so they
 * are ready as soon as the media session catches up.
 */
class MacAxTrackReader {
  constructor({ logger, scriptPath, timeoutMs = 3000 }) {
    this.logger = logger;
    this.scriptPath = scriptPath;
    this.timeoutMs = timeoutMs;
    this.busy = false;
    this.lastFailureAt = 0;
    this.lastFailureReason = '';
  }

  /** @returns {Promise<{title:string,artist:string}|null>} */
  read() {
    if (!this.scriptPath || this.busy) return Promise.resolve(null);
    this.busy = true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.busy = false;
        resolve(value);
      };

      const child = spawn('osascript', ['-l', 'JavaScript', this.scriptPath], { windowsHide: true });
      const chunks = [];
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        finish(null);
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) return finish(null);
        const line = Buffer.concat(chunks).toString('utf8').trim().split('\n').pop() || '';
        let payload = null;
        try {
          payload = JSON.parse(line);
        } catch {
          payload = null;
        }
        if (payload && payload.ok && payload.title) {
          return finish({ title: payload.title, artist: payload.artist || '' });
        }
        this.noteFailure(
          (payload && payload.error) || (line ? 'unparsable helper output' : 'empty helper output')
        );
        finish(null);
      });
    });
  }

  /**
   * The prefetch path fails silently by design (it runs while the user is
   * switching tracks), which made "为什么要等一秒" impossible to diagnose from
   * the log. Surface the reason, rate limited to once a minute.
   */
  noteFailure(reason) {
    const now = Date.now();
    if (now - this.lastFailureAt < 60000) return;
    this.lastFailureAt = now;
    this.lastFailureReason = reason;
    this.logger?.info?.(
      `[Ax] 读播放器窗口失败（${reason}）：切歌预取跳过，请在「系统设置 → 隐私与安全性 → 辅助功能」里勾选 FlexDesigner`
    );
  }
}

module.exports = { MacAxTrackReader };
