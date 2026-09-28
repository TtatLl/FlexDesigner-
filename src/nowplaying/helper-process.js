'use strict';

const { spawn } = require('child_process');

/**
 * Runs a long-lived helper (PowerShell / osascript / any executable) that prints
 * one JSON object per line and keeps the newest sample in memory.
 *
 * Helpers are expected to emit objects shaped like:
 *   { type: 'sample', ts, session: { title, artist, album, positionSec, durationSec, status, appId } }
 *   { type: 'idle', ts }
 *   { type: 'error', message }
 */
class HelperProcess {
  constructor({ logger, command, args, name, restartDelayMs = 3000, maxRestarts = 5 }) {
    this.logger = logger;
    this.command = command;
    this.args = args;
    this.name = name;
    this.restartDelayMs = restartDelayMs;
    this.maxRestarts = maxRestarts;

    this.child = null;
    this.buffer = '';
    this.restarts = 0;
    this.stopped = false;
    this.lastSample = null;
    this.lastMessage = null;
    this.lastError = null;
    this.lastSampleAt = 0;
    this.onSample = null;
  }

  start() {
    if (this.child || this.stopped) return;

    try {
      this.child = spawn(this.command, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.lastError = err.message;
      this.logger?.error(`[${this.name}] spawn failed: ${err.message}`);
      this.scheduleRestart();
      return;
    }

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (!text) return;
      this.lastError = text;
      this.logger?.debug?.(`[${this.name}] ${text}`);
    });

    this.child.on('error', (err) => {
      this.lastError = err.message;
      this.logger?.error(`[${this.name}] process error: ${err.message}`);
    });

    this.child.on('exit', (code) => {
      this.child = null;
      if (this.stopped) return;
      this.logger?.warn(`[${this.name}] helper exited with code ${code}`);
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.stopped) return;
    if (this.restarts >= this.maxRestarts) {
      this.logger?.error(`[${this.name}] giving up after ${this.restarts} restarts`);
      return;
    }
    this.restarts += 1;
    setTimeout(() => this.start(), this.restartDelayMs);
  }

  consume(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > 1024 * 1024) this.buffer = '';
  }

  handleLine(line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      this.logger?.debug?.(`[${this.name}] ${line}`);
      return;
    }

    this.lastMessage = payload;
    if (payload.type === 'error') {
      this.lastError = payload.message || 'unknown helper error';
      return;
    }
    if (payload.type === 'sample') {
      this.restarts = 0;
      this.lastSample = payload;
      this.lastSampleAt = Date.now();
    }
    if (this.onSample) this.onSample(payload);
  }

  write(line) {
    if (this.child && this.child.stdin.writable) this.child.stdin.write(`${line}\n`);
  }

  isAlive() {
    return !!this.child;
  }

  stop() {
    this.stopped = true;
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
      this.child = null;
    }
  }
}

module.exports = { HelperProcess };
