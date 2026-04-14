'use strict';

/**
 * storage.js — GCS persistence for apbot learnings.
 *
 * When GCS_BUCKET is set, learnings are stored in Google Cloud Storage
 * and survive container restarts / redeployments. Falls back to local
 * filesystem when GCS is not configured (local dev).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LOCAL_PATH = path.join(DATA_DIR, 'apbot-learnings.json');
const GCS_KEY = 'apbot-learnings.json';

let _bucket = null;
let _gcsAvailable = null;

function getBucket() {
  if (_gcsAvailable === false) return null;

  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) {
    _gcsAvailable = false;
    return null;
  }

  if (_bucket) return _bucket;

  try {
    const { Storage } = require('@google-cloud/storage');
    // On Cloud Run, credentials come from the service account automatically
    const storage = new Storage();
    _bucket = storage.bucket(bucketName);
    _gcsAvailable = true;
    console.log(`[apbot/storage] Using GCS bucket: ${bucketName}`);
    return _bucket;
  } catch (err) {
    console.error('[apbot/storage] GCS init failed, using local fs:', err.message);
    _gcsAvailable = false;
    return null;
  }
}

/**
 * Load learnings array from GCS (or local fs fallback).
 */
async function loadLearnings() {
  const bucket = getBucket();

  if (bucket) {
    try {
      const file = bucket.file(GCS_KEY);
      const [exists] = await file.exists();
      if (!exists) return [];
      const [contents] = await file.download();
      return JSON.parse(contents.toString('utf8'));
    } catch (err) {
      console.error('[apbot/storage] GCS read failed, falling back to local:', err.message);
    }
  }

  // Local fallback
  try {
    return JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Save learnings array to GCS (and local fs as backup).
 */
async function saveLearnings(learnings) {
  const data = JSON.stringify(learnings, null, 2);

  // Always write local copy as backup
  try {
    fs.writeFileSync(LOCAL_PATH, data);
  } catch {}

  const bucket = getBucket();
  if (bucket) {
    try {
      await bucket.file(GCS_KEY).save(data, {
        contentType: 'application/json',
        resumable: false,
      });
      console.log(`[apbot/storage] Saved ${learnings.length} learnings to GCS`);
    } catch (err) {
      console.error('[apbot/storage] GCS write failed:', err.message);
    }
  }
}

module.exports = { loadLearnings, saveLearnings };
