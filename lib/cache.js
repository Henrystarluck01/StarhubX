/**
 * Lightweight on-disk cache. No DB dependency -- just a JSON file that
 * mirrors the in-memory state (chats + messages), written debounced so
 * a burst of messages doesn't hammer the disk.
 *
 * On startup, load() is called before the bot connects so previously
 * seen chats/messages are available immediately (and archived chats
 * you've already synced once stay visible even before the next sync).
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");
const DEBOUNCE_MS = 1500;

let saveTimer = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.warn("⚠️  Could not read cache file, starting fresh:", err.message);
    return null;
  }
}

function writeNow(snapshot) {
  try {
    ensureDir();
    const tmp = `${CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, CACHE_FILE); // atomic-ish swap, avoids partial writes on crash
  } catch (err) {
    console.warn("⚠️  Could not write cache file:", err.message);
  }
}

/** Schedule a debounced write. `getSnapshot` is called lazily at flush time. */
function scheduleSave(getSnapshot) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow(getSnapshot());
  }, DEBOUNCE_MS);
}

/** Flush immediately (used on graceful shutdown). */
function flushSave(getSnapshot) {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeNow(getSnapshot());
}

module.exports = { load, scheduleSave, flushSave };
