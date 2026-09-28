'use strict';

const { spawn } = require('child_process');

/**
 * Cross-platform media transport control.
 *
 * QQ Music reacts to the system media keys on both platforms, which means we do
 * not need to automate its window (no focus stealing, no accessibility hacks).
 *
 * Windows: a long-lived PowerShell helper receives actions on stdin so button
 *          presses stay instant.
 * macOS:   `nowplaying-cli` is preferred because it carries the MediaRemote
 *          adapter that macOS 15+ needs; the JXA helper stays as a fallback for
 *          older systems. A user supplied command override always wins.
 */

/** nowplaying-cli spells the transport actions differently. */
const CLI_ACTIONS = {
  play: 'play',
  pause: 'pause',
  playpause: 'togglePlayPause',
  toggle: 'togglePlayPause',
  stop: 'pause',
  next: 'next',
  previous: 'previous',
  prev: 'previous',
};

class MediaKeys {
  constructor({ logger, helperDir, config }) {
    this.logger = logger;
    this.helperDir = helperDir;
    this.config = config;
    this.server = null;
    this.warned = false;
  }

  start() {
    if (process.platform !== 'win32' || this.server) return;
    try {
      this.server = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          `${this.helperDir}/windows/media-key.ps1`,
          '-Server',
        ],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] }
      );
      this.server.on('exit', () => {
        this.server = null;
      });
      this.server.on('error', (err) => {
        this.logger?.error(`[MediaKeys] helper failed: ${err.message}`);
        this.server = null;
      });
    } catch (err) {
      this.logger?.error(`[MediaKeys] unable to start helper: ${err.message}`);
      this.server = null;
    }
  }

  customCommand(action) {
    const commands = this.config.get('customCommands');
    if (!commands || typeof commands !== 'object') return null;
    const command = commands[action];
    return typeof command === 'string' && command.trim() ? command.trim() : null;
  }

  async runCustom(command) {
    return new Promise((resolve) => {
      const child =
        process.platform === 'win32'
          ? spawn('cmd.exe', ['/c', command], { windowsHide: true, stdio: 'ignore' })
          : spawn('/bin/sh', ['-lc', command], { windowsHide: true, stdio: 'ignore' });
      child.on('error', (err) => {
        this.logger?.error(`[MediaKeys] custom command failed: ${err.message}`);
        resolve(false);
      });
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  async sendMacAction(action, hint) {
    const viaCli = await this.sendViaNowPlayingCli(action, hint);
    if (viaCli) return true;

    const result = await new Promise((resolve) => {
      const child = spawn(
        'osascript',
        ['-l', 'JavaScript', `${this.helperDir}/macos/media-key.jxa`, action],
        { windowsHide: true }
      );
      const chunks = [];
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('exit', (code) => {
        if (code !== 0) return resolve({ ok: false, error: `osascript exit ${code}` });
        const text = Buffer.concat(chunks).toString('utf8').trim().split('\n').pop() || '';
        try {
          resolve(JSON.parse(text));
        } catch {
          resolve({ ok: false, error: 'unparsable helper output' });
        }
      });
    });
    if (!result.ok && !this.warned) {
      this.warned = true;
      this.logger?.warn(
        `[MediaKeys] macOS media control failed (${result.error}). ` +
          'Consider installing nowplaying-cli or configuring customCommands.'
      );
    }
    return result.ok;
  }

  /**
   * macOS 15 keeps MediaRemote out of the dlopen-able image, so the JXA helper
   * silently does nothing there. nowplaying-cli ships the adapter that actually
   * reaches the media daemon, so prefer it whenever it is installed.
   */
  async sendViaNowPlayingCli(action, hint) {
    // QQ Music ignores TogglePlayPause but honours explicit play/pause, so when
    // the caller knows which state it wants, ask for that state directly.
    let command = CLI_ACTIONS[action];
    if (hint && typeof hint.expectPlaying === 'boolean') {
      if (action === 'playpause' || action === 'toggle') {
        command = hint.expectPlaying ? 'play' : 'pause';
      }
    }
    if (!command) return false;
    if (this.cliPath === undefined) {
      try {
        // Required lazily: this resolver is only meaningful on macOS.
        const { resolveNowPlayingCli } = require('./nowplaying/macos-media');
        this.cliPath = resolveNowPlayingCli();
      } catch (err) {
        this.logger?.warn?.(`[MediaKeys] nowplaying-cli lookup unavailable: ${err.message}`);
        this.cliPath = null;
      }
    }
    if (!this.cliPath) return false;

    // Deliberately not awaited: nowplaying-cli needs ~600 ms to load the
    // MediaRemote framework before it can send the command, and making the key
    // wait that long was what made the icon jump around. The plugin shows the
    // requested state immediately and confirms it against the player.
    const child = spawn(this.cliPath, [command], { windowsHide: true, stdio: 'ignore' });
    child.on('error', (err) => {
      this.logger?.warn?.(`[MediaKeys] nowplaying-cli failed: ${err.message}`);
      this.cliPath = null;
    });
    child.on('exit', (code) => {
      if (code !== 0) this.logger?.warn?.(`[MediaKeys] ${command} exited with ${code}`);
    });
    return true;
  }


  async send(action, hint) {
    const custom = this.customCommand(action);
    if (custom) return this.runCustom(custom);

    if (process.platform === 'win32') {
      this.start();
      if (this.server && this.server.stdin.writable) {
        this.server.stdin.write(`${action}\n`);
        return true;
      }
      return new Promise((resolve) => {
        const child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            `${this.helperDir}/windows/media-key.ps1`,
            '-Key',
            action,
          ],
          { windowsHide: true, stdio: 'ignore' }
        );
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
      });
    }

    if (process.platform === 'darwin') return this.sendMacAction(action, hint);

    this.logger?.warn('[MediaKeys] media keys are not supported on this platform');
    return false;
  }

  dispose() {
    if (this.server) {
      try {
        this.server.stdin.end();
        this.server.kill();
      } catch {
        /* ignore */
      }
      this.server = null;
    }
  }
}

module.exports = { MediaKeys };
