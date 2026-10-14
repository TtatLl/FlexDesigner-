'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

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
    this.qqHotkeys = null;
  }

  /**
   * QQ Music's own global shortcuts (play/pause, next, previous).
   *
   * They live in QQ Music's preferences and are the only way to control it while
   * another app owns the system media session. `defaults export` asks cfprefsd
   * for the merged domain (the app does not keep a plain plist in
   * ~/Library/Preferences), then plutil hands each value over as base64 whose
   * NSKeyedArchiver payload contains the key code.
   */
  readQqHotkeys() {
    if (this.qqHotkeys) return this.qqHotkeys;
    const fallback = { playpause: 98, next: 97, previous: 100, source: 'defaults' };
    if (process.platform !== 'darwin') {
      this.qqHotkeys = fallback;
      return this.qqHotkeys;
    }

    const os = require('os');
    const exported = `${os.tmpdir()}/qqmusic-hotkeys.plist`;
    const blob = `${os.tmpdir()}/qqmusic-hotkey-value.plist`;
    const names = { playpause: 'QMGlobalHotkeyPlayOrPause', next: 'QMGlobalHotkeyNext', previous: 'QMGlobalHotkeyPrev' };
    const result = { ...fallback, source: 'qq music preferences' };
    try {
      const dump = spawnSync('/usr/bin/defaults', ['export', 'com.tencent.QQMusicMac', exported], {
        timeout: 5000,
        encoding: 'utf8',
      });
      if (dump.status !== 0) {
        throw new Error(
          `defaults export exit ${dump.status}` +
            (dump.error ? ` (${dump.error.message})` : '') +
            (dump.stderr ? `: ${String(dump.stderr).trim().slice(0, 120)}` : '')
        );
      }
      let found = 0;
      for (const [action, prefName] of Object.entries(names)) {
        // `raw` prints the value as base64; the payload is the NSKeyedArchiver
        // plist itself, so decode it before asking plutil to describe it.
        const raw = spawnSync('/usr/bin/plutil', ['-extract', prefName, 'raw', '-o', '-', exported], {
          timeout: 5000,
          encoding: 'utf8',
        });
        if (raw.status !== 0 || !raw.stdout) continue;
        const decoded = Buffer.from(String(raw.stdout).trim(), 'base64');
        if (!decoded.length) continue;
        fs.writeFileSync(blob, decoded);
        const printed = spawnSync('/usr/bin/plutil', ['-p', blob], { timeout: 5000, encoding: 'utf8' });
        const match = String(printed.stdout || '').match(/"KeyCode"\s*=>\s*(\d+)/);
        if (match) {
          result[action] = Number(match[1]);
          found += 1;
        }
      }
      result.source = found === Object.keys(names).length ? 'qq music preferences' : 'defaults';
    } catch (err) {
      this.logger?.info?.(`[MediaKeys] QQ Music hotkey lookup failed: ${err.message}`);
      result.source = 'defaults';
    }
    if (result.source !== 'qq music preferences') {
      this.logger?.info?.(
        `[MediaKeys] QQ Music hotkeys: using defaults for the missing ones ` +
          `(playpause=${result.playpause} next=${result.next} previous=${result.previous})`
      );
    }
    this.qqHotkeys = result;
    return result;
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
    const targetApp = hint && hint.targetApp ? String(hint.targetApp) : '';
    if (hint && hint.qqHotkey) {
      return this.sendQqHotkey(action, hint);
    }
    if (targetApp) {
      // Addressed at one specific app: never fall back to the global command
      // here, that is exactly the hijack this path exists to avoid.
      return this.sendToApp(action, targetApp, hint);
    }

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
   * macOS only: drive QQ Music through its own global hotkey.
   *
   * The media key always goes to whoever owns the media session, and the private
   * targeted-command API does not reach QQ Music on macOS 15 (measured
   * 2026-10-14). QQ Music's own global shortcut does the job - but sending a
   * keystroke needs the Accessibility permission for whoever runs osascript
   * (FlexDesigner), so failures are reported instead of swallowed.
   */
  sendQqHotkey(action, hint) {
    const helperAction = action === 'toggle' ? 'playpause' : action;
    const hotkeys = this.readQqHotkeys();
    const keyCode = hotkeys[helperAction];
    return new Promise((resolve) => {
      const child = spawn(
        'osascript',
        ['-l', 'JavaScript', `${this.helperDir}/macos/qq-hotkey.jxa`, helperAction, String(keyCode)],
        { windowsHide: true }
      );
      const chunks = [];
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        this.logger?.warn?.(`[MediaKeys] QQ Music hotkey ${helperAction} timed out`);
        finish(false);
      }, 4000);

      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', (err) => {
        clearTimeout(timer);
        this.logger?.warn?.(`[MediaKeys] QQ Music hotkey failed: ${err.message}`);
        finish(false);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8').trim().split('\n').pop() || '';
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
        if (code === 0 && payload && payload.ok) {
          this.logger?.info?.(
            `[MediaKeys] ${helperAction} -> QQ Music hotkey keyCode=${payload.keyCode} (${hotkeys.source})`
          );
          finish(true);
        } else {
          const reason = (payload && payload.error) || `exit ${code}`;
          this.logger?.warn?.(
            `[MediaKeys] QQ Music hotkey ${helperAction} failed: ${reason}` +
              (/not allowed|不允许|-1743|1002/.test(String(reason))
                ? ' - 请在「系统设置 → 隐私与安全性 → 辅助功能」里勾选 FlexDesigner'
                : '')
          );
          finish(false);
        }
      });
    });
  }

  /**
   * One-off startup check: may this process synthesise keystrokes at all?
   *
   * Sends an unused key code, so nothing can be toggled. Without the
   * Accessibility permission System Events answers "not allowed to send
   * keystrokes", and the QQ Music hotkey path can never work - better to say so
   * in the log than to leave the user guessing why a key does nothing.
   */
  probeQqHotkeyPermission() {
    if (process.platform !== 'darwin') return;
    const child = spawn(
      'osascript',
      ['-l', 'JavaScript', `${this.helperDir}/macos/qq-hotkey.jxa`, '--test'],
      { windowsHide: true }
    );
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (err) => {
      this.logger?.warn(`[MediaKeys] hotkey permission probe failed: ${err.message}`);
    });
    child.on('exit', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim().split('\n').pop() || '';
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
      if (payload && payload.ok) {
        const hotkeys = this.readQqHotkeys();
        this.logger?.info(
          '[MediaKeys] QQ Music hotkey permission: ok (System Events can send keys) | ' +
            `playpause=${hotkeys.playpause} next=${hotkeys.next} previous=${hotkeys.previous} (${hotkeys.source})`
        );
      } else {
        this.logger?.warn(
          `[MediaKeys] QQ Music hotkey permission: blocked (${(payload && payload.error) || 'no answer'})` +
            ' - 在「系统设置 → 隐私与安全性 → 辅助功能」里勾选 FlexDesigner 后重启插件'
        );
      }
    });
  }

  /**
   * macOS only: send the command to one app even when another app owns the
   * system media session (private MRMediaRemoteSendCommandToApp, which
   * nowplaying-cli does not expose). QQ Music ignores TogglePlayPause, so an
   * explicit play/pause is sent when the caller knows the wanted state.
   */
  sendToApp(action, targetApp, hint) {
    let helperAction = action;
    if (hint && typeof hint.expectPlaying === 'boolean' && (action === 'playpause' || action === 'toggle')) {
      helperAction = hint.expectPlaying ? 'play' : 'pause';
    }

    return new Promise((resolve) => {
      const child = spawn(
        'osascript',
        ['-l', 'JavaScript', `${this.helperDir}/macos/media-key.jxa`, helperAction, targetApp],
        { windowsHide: true }
      );
      const chunks = [];
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        this.logger?.warn?.(`[MediaKeys] targeted ${helperAction} to ${targetApp} timed out`);
        finish(false);
      }, 4000);

      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', (err) => {
        clearTimeout(timer);
        this.logger?.warn?.(`[MediaKeys] targeted ${helperAction} failed: ${err.message}`);
        finish(false);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8').trim().split('\n').pop() || '';
        let payload = null;
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
        if (code === 0 && payload && payload.ok) {
          this.logger?.info?.(`[MediaKeys] ${helperAction} -> ${targetApp} via ${payload.via}`);
          finish(true);
        } else {
          this.logger?.warn?.(
            `[MediaKeys] targeted ${helperAction} to ${targetApp} failed ` +
              `(${(payload && payload.error) || `exit ${code}`})`
          );
          finish(false);
        }
      });
    });
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
