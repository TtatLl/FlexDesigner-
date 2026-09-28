'use strict';

const UUID = 'com.flexbar.qqmusicnow';

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

module.exports = { UUID, CID, PROVIDERS, DEFAULT_CONFIG };
