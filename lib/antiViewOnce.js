/**
 * Auto anti-view-once (CypherX-style algorithm, plain Baileys — no extra packages).
 *
 * Flow:
 * 1. Detect viewOnceMessage / V2 / V2Extension OR media.viewOnce / key.isViewOnce
 * 2. Unwrap → download bytes with downloadContentFromMessage (then downloadMediaMessage)
 * 3. Save to disk for the web dashboard
 * 4. Send ONE unlocked copy to Message Yourself (never back to the original chat)
 */

const fs = require("fs");
const path = require("path");
const baileys = require("@whiskeysockets/baileys");
const {
  downloadContentFromMessage,
  downloadMediaMessage,
} = baileys;

const MEDIA_DIR = path.join(__dirname, "..", "data", "media");

function ensureMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/** True if this WAMessage is (or wraps) view-once media */
function isViewOnceMessage(m) {
  if (!m) return false;
  if (m.key?.isViewOnce) return true;
  const msg = m.message;
  if (!msg) return false;
  if (
    msg.viewOnceMessage ||
    msg.viewOnceMessageV2 ||
    msg.viewOnceMessageV2Extension
  ) {
    return true;
  }
  const node =
    msg.imageMessage ||
    msg.videoMessage ||
    msg.audioMessage ||
    msg.documentMessage ||
    msg.stickerMessage;
  return !!(node && node.viewOnce);
}

/**
 * Unwrap to the inner media object: { type, media, mimetype, ptt }
 * type = image | video | audio | document | sticker
 */
function extractViewOnceMedia(m) {
  let content = m.message;
  if (!content) return null;

  // Walk common wrappers
  for (let i = 0; i < 5; i++) {
    if (content.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
      continue;
    }
    if (content.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
      continue;
    }
    if (content.viewOnceMessageV2Extension?.message) {
      content = content.viewOnceMessageV2Extension.message;
      continue;
    }
    if (content.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
      continue;
    }
    if (content.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }

  if (content.imageMessage) {
    return {
      type: "image",
      media: content.imageMessage,
      mimetype: content.imageMessage.mimetype || "image/jpeg",
      ptt: false,
      caption: content.imageMessage.caption || "",
    };
  }
  if (content.videoMessage) {
    return {
      type: "video",
      media: content.videoMessage,
      mimetype: content.videoMessage.mimetype || "video/mp4",
      ptt: false,
      caption: content.videoMessage.caption || "",
    };
  }
  if (content.audioMessage) {
    return {
      type: "audio",
      media: content.audioMessage,
      mimetype: content.audioMessage.mimetype || "audio/ogg; codecs=opus",
      ptt: !!content.audioMessage.ptt,
      caption: "",
    };
  }
  if (content.stickerMessage) {
    return {
      type: "sticker",
      media: content.stickerMessage,
      mimetype: content.stickerMessage.mimetype || "image/webp",
      ptt: false,
      caption: "",
    };
  }
  if (content.documentMessage) {
    return {
      type: "document",
      media: content.documentMessage,
      mimetype: content.documentMessage.mimetype || "application/octet-stream",
      ptt: false,
      caption: content.documentMessage.caption || "",
      fileName: content.documentMessage.fileName || "file",
    };
  }
  return null;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Download view-once media bytes (CypherX-style: stream first, then full message).
 */
async function downloadViewOnceBuffer(m, extracted, sock) {
  const { type, media } = extracted;
  let lastErr = null;

  // 1) downloadContentFromMessage on the media node (most reliable for view-once)
  try {
    const stream = await downloadContentFromMessage(media, type);
    const buf = await streamToBuffer(stream);
    if (buf && buf.length) return buf;
  } catch (e) {
    lastErr = e;
  }

  // 2) Plain message clone without viewOnce flag
  try {
    const plainMedia = { ...media };
    delete plainMedia.viewOnce;
    const plainMsg = {
      key: m.key,
      message: { [`${type}Message`]: plainMedia },
    };
    const buf = await downloadMediaMessage(
      plainMsg,
      "buffer",
      {},
      {
        reuploadRequest: sock?.updateMediaMessage,
      }
    );
    if (buf && buf.length) return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  } catch (e) {
    lastErr = e;
  }

  // 3) Original message as-is
  try {
    const buf = await downloadMediaMessage(
      m,
      "buffer",
      {},
      {
        reuploadRequest: sock?.updateMediaMessage,
      }
    );
    if (buf && buf.length) return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  } catch (e) {
    lastErr = e;
  }

  // 4) Embedded thumbnail only (preview)
  const thumb = media.jpegThumbnail;
  if (thumb && (Buffer.isBuffer(thumb) ? thumb.length : thumb.length)) {
    return Buffer.isBuffer(thumb) ? thumb : Buffer.from(thumb);
  }

  if (lastErr) throw lastErr;
  throw new Error("empty buffer");
}

function extFor(mimetype, type) {
  const m = (mimetype || "").toLowerCase();
  if (m.includes("webp")) return "webp";
  if (m.includes("png")) return "png";
  if (m.includes("gif")) return "gif";
  if (m.includes("mp4") || m.includes("video")) return "mp4";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("pdf")) return "pdf";
  if (type === "image") return "jpg";
  if (type === "video") return "mp4";
  if (type === "audio") return "ogg";
  if (type === "sticker") return "webp";
  return "bin";
}

/**
 * Full auto pipeline:
 * @returns {{ ok, kind, fileName, mimetype, buffer, size } | null}
 */
async function processAutoViewOnce(m, sock, { selfJid, chatName, senderName, mode } = {}) {
  if (!m || !sock) return null;
  if (m.key?.fromMe) return null;
  if (!isViewOnceMessage(m)) return null;

  const extracted = extractViewOnceMedia(m);
  if (!extracted) {
    console.warn(
      `👁 Auto VO: detected view-once but no media node id=${m.key?.id}`
    );
    return null;
  }

  const msgId = m.key?.id || `vo-${Date.now()}`;
  console.log(
    `👁 Auto VO: unlocking id=${msgId} type=${extracted.type} from=${senderName || m.pushName || "?"}`
  );

  let buffer;
  try {
    buffer = await downloadViewOnceBuffer(m, extracted, sock);
  } catch (err) {
    console.warn(`👁 Auto VO download failed id=${msgId}:`, err.message);
    return null;
  }
  if (!buffer || !buffer.length) {
    console.warn(`👁 Auto VO empty buffer id=${msgId}`);
    return null;
  }

  ensureMediaDir();
  const mimetype = extracted.mimetype;
  const kind = extracted.type === "sticker" ? "sticker" : extracted.type;
  const ext = extFor(mimetype, kind);
  const fileName = `${msgId}.${ext}`;
  const filePath = path.join(MEDIA_DIR, fileName);
  await fs.promises.writeFile(filePath, buffer);
  console.log(`👁 Auto VO saved ${fileName} (${buffer.length} bytes)`);

  const caption =
    `👁 *Auto anti view-once*\n` +
    `From: ${senderName || m.pushName || "?"}\n` +
    (chatName ? `Chat: ${chatName}\n` : "") +
    (extracted.caption ? `\n${extracted.caption}` : "");

  // Destination: self | chat | both (chatJid from original message)
  const destMode = mode || "self";
  const originalChat = m.key?.remoteJid || null;
  const targets = [];
  if (destMode === "chat" || destMode === "both") {
    if (originalChat) targets.push({ jid: originalChat, label: "chat" });
  }
  if (destMode === "self" || destMode === "both" || !destMode) {
    if (selfJid) targets.push({ jid: selfJid, label: "self" });
  }
  // Fallback if nothing selected
  if (!targets.length && selfJid) targets.push({ jid: selfJid, label: "self" });

  for (const t of targets) {
    try {
      if (kind === "image" || kind === "sticker") {
        await sock.sendMessage(t.jid, { image: buffer, caption, mimetype });
      } else if (kind === "video") {
        await sock.sendMessage(t.jid, { video: buffer, caption, mimetype });
      } else if (kind === "audio") {
        await sock.sendMessage(t.jid, {
          audio: buffer,
          mimetype,
          ptt: extracted.ptt,
        });
        await sock.sendMessage(t.jid, { text: caption });
      } else if (kind === "document") {
        await sock.sendMessage(t.jid, {
          document: buffer,
          mimetype,
          fileName: extracted.fileName || fileName,
          caption,
        });
      }
      console.log(`👁 Auto VO → ${t.label} (${kind})`);
    } catch (err) {
      console.warn(`👁 Auto VO send to ${t.label} failed:`, err.message);
    }
  }

  return {
    ok: true,
    kind,
    fileName,
    mimetype,
    buffer,
    size: buffer.length,
    ptt: extracted.ptt,
  };
}

/**
 * Send an already-cached unlocked buffer to destinations (self / chat / both).
 */
async function sendUnlockedToDestinations(sock, buffer, {
  kind,
  mimetype,
  ptt,
  fileName,
  caption,
  selfJid,
  chatJid,
  mode = "self",
}) {
  if (!sock || !buffer?.length) return false;
  const targets = [];
  if ((mode === "chat" || mode === "both") && chatJid) {
    targets.push(chatJid);
  }
  if ((mode === "self" || mode === "both" || !mode) && selfJid) {
    targets.push(selfJid);
  }
  if (!targets.length && selfJid) targets.push(selfJid);
  let ok = false;
  for (const jid of targets) {
    try {
      if (kind === "image" || kind === "sticker") {
        await sock.sendMessage(jid, { image: buffer, caption, mimetype });
      } else if (kind === "video") {
        await sock.sendMessage(jid, { video: buffer, caption, mimetype });
      } else if (kind === "audio") {
        await sock.sendMessage(jid, {
          audio: buffer,
          mimetype: mimetype || "audio/ogg; codecs=opus",
          ptt: !!ptt,
        });
        if (caption) await sock.sendMessage(jid, { text: caption });
      } else {
        await sock.sendMessage(jid, {
          document: buffer,
          mimetype: mimetype || "application/octet-stream",
          fileName: fileName || "file",
          caption,
        });
      }
      ok = true;
    } catch (e) {
      console.warn("sendUnlockedToDestinations:", e.message);
    }
  }
  return ok;
}

module.exports = {
  isViewOnceMessage,
  extractViewOnceMedia,
  processAutoViewOnce,
  downloadViewOnceBuffer,
  sendUnlockedToDestinations,
};
