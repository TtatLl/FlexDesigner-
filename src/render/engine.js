'use strict';

/**
 * Thin wrapper around @napi-rs/canvas.
 *
 * The native canvas module is an optional capability: if the host cannot
 * resolve it we degrade to plain text keys instead of crashing the plugin.
 */

let canvasModule = null;
let resolved = false;
let canvasLoadError = null;

function getCanvas() {
  if (!resolved) {
    resolved = true;
    try {
      // eslint-disable-next-line global-require
      canvasModule = require('@napi-rs/canvas');
    } catch (err) {
      canvasLoadError = err;
      canvasModule = null;
    }
  }
  return canvasModule;
}

function isAvailable() {
  return !!getCanvas();
}

function getLoadError() {
  return canvasLoadError ? canvasLoadError.message : null;
}

function createCanvas(width, height) {
  const mod = getCanvas();
  if (!mod) return null;
  const canvas = mod.createCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  return canvas;
}

async function loadImage(buffer) {
  const mod = getCanvas();
  if (!mod || !buffer) return null;
  try {
    return await mod.loadImage(buffer);
  } catch {
    return null;
  }
}

function toPngBuffer(canvas) {
  return canvas.toBuffer('image/png');
}

module.exports = { getCanvas, isAvailable, getLoadError, createCanvas, loadImage, toPngBuffer };
