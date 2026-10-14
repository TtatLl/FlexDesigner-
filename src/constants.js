'use strict';

const UUID = 'com.flexbar.qqmusicnow';

/**
 * Bundle id QQ Music reports to the macOS media session. Used to address
 * transport commands straight at QQ Music (`MRMediaRemoteSendCommandToApp`),
 * because the plain media key goes to whichever app owns the session - which is
 * a browser video whenever the user is watching one.
 */
const MACOS_QQ_BUNDLE_ID = 'com.tencent.QQMusicMac';

const CID = {
  nowPlaying: `${UUID}.nowplaying`,
  lyric: `${UUID}.lyric`,
  playPause: `${UUID}.playpause`,
  previous: `${UUID}.previous`,
  next: `${UUID}.next`,
  source: `${UUID}.source`,
};

const PROVIDERS = {
  AUTO: 'auto',
  SMTC: 'smtc',
  MACOS: 'macos',
  WINDOW: 'window',
  MANUAL: 'manual',
};

const DEFAULT_CONFIG = {
  provider: PROVIDERS.AUTO,
  offsetMs: 0,
  pollIntervalMs: 1000,
  windowTitlePollMs: 300,
  fontFamily: '',
  manualSong: '',
  windowTitleApps: ['QQMusic', 'QQ音乐', 'qqmusic'],
  debug: false,
};

module.exports = { UUID, CID, PROVIDERS, DEFAULT_CONFIG, MACOS_QQ_BUNDLE_ID };
