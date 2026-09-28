'use strict';

const { HelperProcess } = require('./helper-process');

const QQ_APP_PATTERN = /qqmusic|qq音乐|tencent\.qqmusic/i;
const STALE_MS = 6000;

/**
 * Windows now-playing provider backed by the System Media Transport Controls
 * (the same source the Windows volume overlay uses). QQ Music publishes its
 * playback state there, including an accurate position.
 */
class SmtcProvider {
  constructor({ logger, scriptPath, intervalMs = 800, acceptAnyPlayer = false }) {
    this.id = 'smtc';
    this.label = 'Windows 媒体会话';
    this.logger = logger;
    this.acceptAnyPlayer = acceptAnyPlayer;
    // QQ Music updates its media session within a few hundred milliseconds of a
    // skip, so sampling faster than the generic 1s cuts the perceived switch
    // delay without any extra network work. (Only the Windows helper polls
    // faster; there is no Windows-side behaviour change elsewhere.)
    this.intervalMs = Math.max(300, Math.min(500, Number(intervalMs) || 400));
    this.state = 'idle';
    this.detail = '';

    this.helper = new HelperProcess({
      logger,
      name: 'smtc',
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        '-IntervalMs',
        String(this.intervalMs),
      ],
    });
  }

  start() {
    this.state = 'starting';
    this.logger?.info(`[SMTC] sampling every ${this.intervalMs}ms`);
    this.helper.start();
  }

  stop() {
    this.helper.stop();
    this.state = 'stopped';
  }

  status() {
    return { id: this.id, label: this.label, state: this.state, detail: this.detail };
  }

  pickSession(sessions) {
    if (!Array.isArray(sessions) || !sessions.length) return null;
    const qq = sessions.find((session) => QQ_APP_PATTERN.test(session.appId || ''));
    if (qq) return qq;
    if (!this.acceptAnyPlayer) return null;
    return sessions.find((session) => session.title) || null;
  }

  read() {
    const message = this.helper.lastSample;
    if (!message) {
      if (this.helper.lastError) {
        this.state = 'unavailable';
        this.detail = this.helper.lastError;
      }
      return null;
    }
    if (Date.now() - this.helper.lastSampleAt > STALE_MS) {
      this.state = 'stale';
      this.detail = 'no recent sample';
      return null;
    }

    const sessions = Array.isArray(message.sessions)
      ? message.sessions
      : message.sessions
        ? [message.sessions]
        : message.session
          ? [message.session]
          : [];

    // Log every session once so we can tell whether QQ Music publishes to
    // Windows at all (and under which app id).
    const sessionSummary = sessions
      .map(
        (item) =>
          `${item.appId || '?'}${item.title ? ` "${item.title}"` : ''}` +
          // The album identifies which release is playing, which is what tells
          // two editions of the same song (and their different covers) apart.
          (item.albumTitle ? ` (album "${item.albumTitle}")` : '')
      )
      .join(' | ');
    if (sessionSummary !== this.lastSessionSummary) {
      this.lastSessionSummary = sessionSummary;
      this.logger?.info(`[SMTC] sessions: ${sessionSummary || '(none)'}`);
    }

    const session = this.pickSession(sessions);
    if (!session || !session.title) {
      this.state = 'ok';
      this.detail = 'no QQ Music session';
      return null;
    }

    this.state = 'ok';
    this.detail = session.appId || 'smtc';
    const status = String(session.status || '');
    return {
      source: 'smtc',
      isPlaying: status === 'Playing',
      title: session.title || '',
      artist: session.artist || '',
      album: session.albumTitle || '',
      durationMs: Math.max(0, Math.round((session.durationSec || 0) * 1000)),
      positionMs: Math.max(0, Math.round((session.positionSec || 0) * 1000)),
      positionAtMs: Number(message.ts) || Date.now(),
      appId: session.appId || '',
      // Album art handed over by the media session itself: lets the first frame
      // of a new track show a cover without any lookup or download.
      artworkData: session.artworkData || null,
      artworkInfo: session.artworkInfo || '',
      providerLabel: this.label,
    };
  }
}

module.exports = { SmtcProvider, QQ_APP_PATTERN };
