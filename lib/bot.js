const fs = require("fs");
const path = require("path");
const readline = require("readline");
const baileys = require("@whiskeysockets/baileys");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  downloadContentFromMessage,
  generateWAMessageFromContent,
  Browsers,
  jidNormalizedUser,
} = baileys;
// Optional helpers (name varies across Baileys versions)
const extractMessageContent =
  baileys.extractMessageContent || baileys.normalizeMessageContent || null;
const getContentType = baileys.getContentType || null;
const { Boom } = require("@hapi/boom");
const pino = require("pino");

const {
  state,
  setStatus,
  addMessage,
  removeMessage,
  markMessageRevoked,
  bus,
  upsertChat,
  setChatArchived,
  isGroupJid,
  prettyPhoneFromJid,
  setAvatar,
  getCachedAvatar,
  knownContactJids,
  upsertContact,
  resolveName,
  addStatusEntry,
  removeStatusEntry,
  deleteChat,
  clearChatMessages,
  isAntideleteEnabled,
  isAntiViewOnceEnabled,
  updateSettings,
  persist,
  registerJidAlias,
  preferPhoneJid,
  normalizeJid,
  isSystemJid,
  isPlaceholderName,
} = require("./state");

const {
  MENU_TEXT,
  handleSelfCommand,
  handleGroupCommand,
  applyGroupFilters,
  registerGroupHooks,
} = require("./commands");

const {
  processAutoViewOnce,
  isViewOnceMessage,
  sendUnlockedToDestinations,
} = require("./antiViewOnce");

const AUTH_FOLDER = "./auth";
const MEDIA_DIR = path.join(__dirname, "..", "data", "media");
const LOGO_PATH = path.join(__dirname, "..", "assets", "logo.png");

const FATAL_CODES = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.multideviceMismatch,
]);

// While still unpaired, these codes usually mean a dead/broken pairing attempt
// (phone said "Couldn't link device", 515 restart, timed-out code, etc.)
const PAIRING_FAIL_CODES = new Set([
  DisconnectReason.timedOut,           // 408
  DisconnectReason.restartRequired,    // 515
  401,
  403,
  405,
  440,
]);

// After this many failed pairing closes, wipe ./auth and start clean
const MAX_PAIRING_FAILURES = 2;

let pairingRequested = false;
let phoneNumberPromise = null;
let reconnectAttempts = 0;
let pairingFailures = 0;

function ensureMediaDir() {
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

/** "#RRGGBB" (or "#AARRGGBB") → ARGB int as used by WhatsApp status colors */
function argbFromHex(hex) {
  if (hex == null) return null;
  const h = String(hex).replace(/^#/, "").trim();
  if (/^[0-9a-fA-F]{6}$/.test(h)) return 0xff000000 + parseInt(h, 16);
  if (/^[0-9a-fA-F]{8}$/.test(h)) return parseInt(h, 16);
  return null;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

/** Unwrap view-once / ephemeral wrappers so we can read the real media */
function unwrapMessage(msg) {
  if (!msg) return msg;
  // Prefer Baileys helper when available (handles all current wrappers)
  try {
    if (extractMessageContent) {
      const extracted = extractMessageContent(msg);
      if (extracted && extracted !== msg) {
        const deeper =
          extracted.viewOnceMessage?.message ||
          extracted.viewOnceMessageV2?.message ||
          extracted.viewOnceMessageV2Extension?.message ||
          extracted.ephemeralMessage?.message ||
          extracted.documentWithCaptionMessage?.message ||
          null;
        return deeper ? unwrapMessage(deeper) : extracted;
      }
    }
  } catch (_) {}
  const inner =
    msg.viewOnceMessage?.message ||
    msg.viewOnceMessageV2?.message ||
    msg.viewOnceMessageV2Extension?.message ||
    msg.ephemeralMessage?.message ||
    msg.documentWithCaptionMessage?.message ||
    null;
  if (inner) return unwrapMessage(inner);
  return msg;
}

function isViewOnce(m) {
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
  const inner = unwrapMessage(msg);
  return !!(
    inner?.imageMessage?.viewOnce ||
    inner?.videoMessage?.viewOnce ||
    inner?.audioMessage?.viewOnce ||
    msg.imageMessage?.viewOnce ||
    msg.videoMessage?.viewOnce ||
    msg.audioMessage?.viewOnce
  );
}

/** Deep-clone message tree and strip every viewOnce flag/wrapper (forward-style unlock). */
function stripViewOnceTree(input) {
  if (!input || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(stripViewOnceTree);
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === "viewOnce") continue;
    if (
      k === "viewOnceMessage" ||
      k === "viewOnceMessageV2" ||
      k === "viewOnceMessageV2Extension"
    ) {
      const inner = v?.message ? stripViewOnceTree(v.message) : null;
      if (inner && typeof inner === "object") Object.assign(out, inner);
      continue;
    }
    out[k] = stripViewOnceTree(v);
  }
  return out;
}

/**
 * Build a plain (non-view-once) downloadable WAMessage for Baileys.
 * Clearing the viewOnce flag avoids some CDN/download edge cases.
 */
function asPlainDownloadable(m) {
  const inner = unwrapMessage(m.message);
  if (!inner) return null;
  const cloneNode = (node) => {
    if (!node || typeof node !== "object") return node;
    const out = { ...node };
    delete out.viewOnce;
    return out;
  };
  let message = null;
  let kind = null;
  if (inner.imageMessage) {
    message = { imageMessage: cloneNode(inner.imageMessage) };
    kind = "image";
  } else if (inner.videoMessage) {
    message = { videoMessage: cloneNode(inner.videoMessage) };
    kind = "video";
  } else if (inner.stickerMessage) {
    message = { stickerMessage: cloneNode(inner.stickerMessage) };
    kind = "sticker";
  } else if (inner.audioMessage) {
    message = { audioMessage: cloneNode(inner.audioMessage) };
    kind = "audio";
  } else if (inner.documentMessage) {
    message = { documentMessage: cloneNode(inner.documentMessage) };
    kind = "document";
  }
  if (!message) return null;
  return { key: m.key, message, kind };
}

function extractText(m) {
  const msg = unwrapMessage(m.message);
  if (!msg) return "";
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage) return msg.imageMessage.caption || "(image)";
  if (msg.videoMessage) return msg.videoMessage.caption || "(video)";
  if (msg.audioMessage) return msg.audioMessage.ptt ? "(voice note)" : "(audio)";
  if (msg.documentMessage) return `(file: ${msg.documentMessage.fileName || "unnamed"})`;
  if (msg.stickerMessage) return "(sticker)";
  if (msg.contactMessage) return `(contact: ${msg.contactMessage.displayName || "unknown"})`;
  if (msg.locationMessage) return "(location)";
  if (msg.reactionMessage) return `(reaction: ${msg.reactionMessage.text || ""})`;
  return "(unsupported message type)";
}

function messageKind(m) {
  const msg = unwrapMessage(m.message);
  if (!msg) return "text";
  if (msg.imageMessage) return "image";
  if (msg.videoMessage) return "video";
  if (msg.stickerMessage) return "sticker";
  if (msg.audioMessage) return "audio";
  if (msg.documentMessage) return "document";
  if (msg.contactMessage) return "contact";
  if (msg.locationMessage) return "location";
  if (msg.reactionMessage) return "reaction";
  return "text";
}

function extractQuoted(m) {
  const msg = unwrapMessage(m.message);
  const ctx =
    msg?.extendedTextMessage?.contextInfo ||
    msg?.imageMessage?.contextInfo ||
    msg?.videoMessage?.contextInfo ||
    msg?.documentMessage?.contextInfo ||
    msg?.stickerMessage?.contextInfo ||
    msg?.audioMessage?.contextInfo;
  if (!ctx || !ctx.stanzaId) return null;
  return {
    id: ctx.stanzaId,
    participant: ctx.participant || null,
    text: ctx.quotedMessage
      ? extractText({ message: ctx.quotedMessage, key: {}, messageTimestamp: 0 })
      : null,
  };
}

function chatDisplayName(jid, chat) {
  return chat?.name || chat?.subject || resolveName(jid) || prettyPhoneFromJid(jid);
}

const groupMetaInFlight = new Set();
function refreshGroupName(sock, jid) {
  if (!isGroupJid(jid) || groupMetaInFlight.has(jid)) return;
  groupMetaInFlight.add(jid);
  sock
    .groupMetadata(jid)
    .then((meta) => {
      upsertChat(jid, {
        name: meta.subject || prettyPhoneFromJid(jid),
        kind: "group",
        participantsCount: Array.isArray(meta.participants) ? meta.participants.length : undefined,
      });
    })
    .catch(() => {})
    .finally(() => groupMetaInFlight.delete(jid));
}

const AVATAR_TTL_MS = 60 * 60 * 1000;
const avatarInFlight = new Set();
async function refreshAvatar(sock, jid) {
  const cached = getCachedAvatar(jid);
  if (cached && Date.now() - cached.fetchedAt < AVATAR_TTL_MS) return cached.url;
  if (avatarInFlight.has(jid)) return cached?.url ?? null;
  avatarInFlight.add(jid);
  try {
    const url = await sock.profilePictureUrl(jid, "image").catch(() => null);
    setAvatar(jid, url);
    return url;
  } finally {
    avatarInFlight.delete(jid);
  }
}

async function wipeAuth() {
  await fs.promises.rm(AUTH_FOLDER, { recursive: true, force: true });
}

/**
 * Stream bytes from a Baileys media node via downloadContentFromMessage.
 * Pass the raw imageMessage/videoMessage object (not the outer WAMessage).
 */
async function bufferFromMediaNode(mediaNode, mediaType) {
  if (!mediaNode || !mediaType) return null;
  // Prefer explicit fields when present (more reliable for view-once CDN paths)
  const payload = {
    mediaKey: mediaNode.mediaKey,
    directPath: mediaNode.directPath,
    url: mediaNode.url,
  };
  if (!payload.mediaKey && !payload.directPath && !payload.url) {
    // Fall back to the whole node
    const stream = await downloadContentFromMessage(mediaNode, mediaType);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    if (!chunks.length) return null;
    return Buffer.concat(chunks);
  }
  const stream = await downloadContentFromMessage(payload, mediaType);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  if (!chunks.length) return null;
  return Buffer.concat(chunks);
}

/**
 * Download media fully to disk so the dashboard can show it as-sent.
 * Works for normal media and view-once photos/videos (no anti-view-once forward).
 */
async function cacheMediaForMessage(m, msgId) {
  let kind = messageKind(m);
  try {
    ensureMediaDir();
    const innerMsg = unwrapMessage(m.message);
    if (!innerMsg) return null;

    // Detect kind from unwrapped node if messageKind missed a wrapper
    if (!["image", "video", "sticker", "audio", "document"].includes(kind)) {
      if (innerMsg.imageMessage) kind = "image";
      else if (innerMsg.videoMessage) kind = "video";
      else if (innerMsg.stickerMessage) kind = "sticker";
      else if (innerMsg.audioMessage) kind = "audio";
      else if (innerMsg.documentMessage) kind = "document";
      else return null;
    }

    const mediaTypeMap = {
      image: "image",
      video: "video",
      sticker: "sticker",
      audio: "audio",
      document: "document",
    };
    const mediaType = mediaTypeMap[kind];
    const mediaNode =
      innerMsg.imageMessage ||
      innerMsg.videoMessage ||
      innerMsg.stickerMessage ||
      innerMsg.audioMessage ||
      innerMsg.documentMessage ||
      null;

    const downloadOpts = {
      logger: pino({ level: "silent" }),
      reuploadRequest: state.sock?.updateMediaMessage,
    };

    let buffer = null;
    let lastErr = null;

    // 1) Stream unwrapped media node (best for view-once)
    if (mediaNode && mediaType) {
      try {
        buffer = await bufferFromMediaNode(mediaNode, mediaType);
      } catch (e) {
        lastErr = e;
      }
    }

    // 2) Plain clone with viewOnce flag stripped
    if (!buffer || !buffer.length) {
      const plain = asPlainDownloadable(m);
      if (plain) {
        if (plain.kind) kind = plain.kind;
        try {
          buffer = await downloadMediaMessage(plain, "buffer", {}, downloadOpts);
        } catch (e) {
          lastErr = e;
        }
        if ((!buffer || !buffer.length) && plain.message) {
          const node =
            plain.message.imageMessage ||
            plain.message.videoMessage ||
            plain.message.stickerMessage ||
            plain.message.audioMessage ||
            plain.message.documentMessage;
          const t = plain.kind || mediaType;
          if (node && t) {
            try {
              buffer = await bufferFromMediaNode(node, t);
            } catch (e) {
              lastErr = e;
            }
          }
        }
      }
    }

    // 3) Original + wrapper shapes
    if (!buffer || !buffer.length) {
      const attempts = [
        { key: m.key, message: innerMsg },
        m,
        m.message?.viewOnceMessage
          ? { key: m.key, message: m.message.viewOnceMessage.message }
          : null,
        m.message?.viewOnceMessageV2
          ? { key: m.key, message: m.message.viewOnceMessageV2.message }
          : null,
        m.message?.viewOnceMessageV2Extension
          ? { key: m.key, message: m.message.viewOnceMessageV2Extension.message }
          : null,
        m.message?.ephemeralMessage
          ? { key: m.key, message: m.message.ephemeralMessage.message }
          : null,
      ].filter(Boolean);

      for (const candidate of attempts) {
        try {
          buffer = await downloadMediaMessage(candidate, "buffer", {}, downloadOpts);
          if (buffer && buffer.length) break;
        } catch (e) {
          lastErr = e;
        }
      }
    }

    // 4) Last resort: ask WA to refresh media URL then retry plain download
    if ((!buffer || !buffer.length) && state.sock?.updateMediaMessage) {
      try {
        const refreshed = await state.sock.updateMediaMessage(m);
        if (refreshed) {
          const plain = asPlainDownloadable(refreshed.message ? refreshed : m);
          if (plain) {
            buffer = await downloadMediaMessage(plain, "buffer", {}, downloadOpts);
          }
        }
      } catch (e) {
        lastErr = e;
      }
    }

    // Fallback: embedded jpegThumbnail (often present on view-once when full CDN fails)
    let usedThumb = false;
    if (!buffer || !buffer.length) {
      const thumb =
        mediaNode?.jpegThumbnail ||
        innerMsg?.imageMessage?.jpegThumbnail ||
        innerMsg?.videoMessage?.jpegThumbnail ||
        null;
      if (thumb && (Buffer.isBuffer(thumb) ? thumb.length : thumb.length)) {
        buffer = Buffer.isBuffer(thumb) ? thumb : Buffer.from(thumb);
        kind = kind === "video" ? "image" : kind || "image"; // show as image preview
        usedThumb = true;
        console.warn(
          `Media full download failed (${msgId}, viewOnce=${isViewOnce(m)}); using jpegThumbnail preview`
        );
      }
    }

    if (!buffer || !buffer.length) {
      // Log structure to help debug view-once payloads
      const topKeys = m.message ? Object.keys(m.message) : [];
      const innerKeys = innerMsg ? Object.keys(innerMsg) : [];
      console.warn(
        `Media download failed (${msgId}, viewOnce=${isViewOnce(m)}, kind=${kind}):`,
        lastErr?.message || "empty buffer",
        `| topKeys=${topKeys.join(",")} innerKeys=${innerKeys.join(",")}`
      );
      return null;
    }

    let mimetype = (mediaNode && mediaNode.mimetype) || "application/octet-stream";
    if (usedThumb) mimetype = "image/jpeg";
    if (kind === "audio" && !mimetype.includes("ogg") && !mimetype.includes("opus") && !mimetype.includes("mpeg")) {
      mimetype = "audio/ogg; codecs=opus";
    }
    if (kind === "video" && !mimetype.includes("mp4") && !mimetype.includes("video")) {
      mimetype = "video/mp4";
    }
    if (kind === "image" && mimetype === "application/octet-stream") {
      mimetype = "image/jpeg";
    }

    const ext =
      mimetype.includes("webp") ? "webp" :
      mimetype.includes("png") ? "png" :
      mimetype.includes("jpeg") || mimetype.includes("jpg") ? "jpg" :
      mimetype.includes("gif") ? "gif" :
      mimetype.includes("mp4") || mimetype.includes("video") ? "mp4" :
      mimetype.includes("ogg") || mimetype.includes("opus") ? "ogg" :
      mimetype.includes("mpeg") || mimetype.includes("mp3") ? "mp3" :
      mimetype.includes("pdf") ? "pdf" :
      mimetype.includes("doc") ? "doc" : "bin";

    const fileName = `${msgId}.${ext}`;
    const filePath = path.join(MEDIA_DIR, fileName);
    await fs.promises.writeFile(filePath, buffer);
    state.mediaCache.set(msgId, {
      filePath,
      mimetype,
      fileName,
      size: buffer.length,
      ptt: !!(innerMsg.audioMessage && innerMsg.audioMessage.ptt),
      thumbOnly: usedThumb,
    });
    console.log(
      `📎 Media saved ${fileName} (${buffer.length} bytes)` +
        (isViewOnce(m) ? " [view-once]" : "") +
        (usedThumb ? " [thumbnail]" : "")
    );
    return {
      fileName,
      mimetype,
      hasLocalMedia: true,
      buffer,
      size: buffer.length,
      ptt: !!(innerMsg.audioMessage && innerMsg.audioMessage.ptt),
      kind,
      thumbOnly: usedThumb,
    };
  } catch (err) {
    console.warn("cacheMediaForMessage:", err.message);
    return null;
  }
}

function buildMessageRecord(m, existingChat, mediaInfo) {
  const chatJid = m.key.remoteJid;
  let participant =
    m.key.participant ||
    m.key.participantPn ||
    m.participant ||
    null;
  if (!participant && !m.key.fromMe && !isGroupJid(chatJid)) {
    participant = chatJid;
  }
  const quoted = extractQuoted(m);
  let kind = messageKind(m);
  if (mediaInfo?.kind) kind = mediaInfo.kind;
  const viewOnce = isViewOnce(m);
  const inner = unwrapMessage(m.message);
  const audioPtt = !!(inner?.audioMessage?.ptt || mediaInfo?.ptt);
  return {
    id: m.key.id,
    chatJid,
    chatName:
      existingChat?.name && existingChat.name !== chatJid ? existingChat.name : undefined,
    senderJid: participant || (m.key.fromMe ? "me" : chatJid),
    senderName:
      m.pushName ||
      resolveName(participant) ||
      resolveName(chatJid) ||
      (m.key.fromMe ? "You" : prettyPhoneFromJid(participant || chatJid)),
    fromMe: !!m.key.fromMe,
    text: extractText(m),
    type: kind,
    timestamp: Number(m.messageTimestamp || Date.now() / 1000) * 1000,
    rawKey: m.key,
    quoted: quoted,
    hasMedia: ["image", "video", "sticker", "audio", "document"].includes(kind),
    hasLocalMedia: !!(mediaInfo && mediaInfo.hasLocalMedia),
    mediaFile: mediaInfo?.fileName || null,
    mediaMime: mediaInfo?.mimetype || null,
    mediaSize: mediaInfo?.size || null,
    viewOnce: viewOnce,
    ptt: audioPtt,
    mediaKey: (() => {
      if (!inner) return null;
      return {
        imageMessage: !!inner.imageMessage,
        videoMessage: !!inner.videoMessage,
        stickerMessage: !!inner.stickerMessage,
        audioMessage: !!inner.audioMessage,
        documentMessage: !!inner.documentMessage,
        fileName: inner.documentMessage?.fileName || null,
        mimetype:
          mediaInfo?.mimetype ||
          inner.imageMessage?.mimetype ||
          inner.videoMessage?.mimetype ||
          inner.stickerMessage?.mimetype ||
          inner.audioMessage?.mimetype ||
          inner.documentMessage?.mimetype ||
          null,
        seconds: inner.videoMessage?.seconds || inner.audioMessage?.seconds || null,
        ptt: audioPtt,
      };
    })(),
  };
}

function getSelfJid() {
  if (state.selfJid) return state.selfJid;
  if (state.sock?.user?.id) {
    state.selfJid = jidNormalizedUser(state.sock.user.id);
    return state.selfJid;
  }
  return null;
}

/* MENU_TEXT moved to lib/commands.js */


async function notifySelfText(text) {
  const self = getSelfJid();
  if (!self || !state.sock) return false;
  try {
    await state.sock.sendMessage(self, { text: String(text || "") });
    return true;
  } catch (err) {
    console.warn("notifySelfText:", err.message);
    return false;
  }
}

async function sendMenuToSelf() {
  const self = getSelfJid();
  if (!self || !state.sock) return;
  try {
    const logoCandidates = [
      path.join(__dirname, "..", "assets", "logo.png"),
      path.join(__dirname, "..", "public", "logo.png"),
    ];
    let logoBuf = null;
    for (const p of logoCandidates) {
      if (fs.existsSync(p)) {
        logoBuf = await fs.promises.readFile(p);
        break;
      }
    }
    if (logoBuf) {
      await state.sock.sendMessage(self, {
        image: logoBuf,
        caption: MENU_TEXT,
        mimetype: "image/png",
      });
    } else {
      await state.sock.sendMessage(self, { text: MENU_TEXT });
    }
    state.menuSent = true;
    persist();
    console.log("📋 Menu sent to Message Yourself.");
  } catch (err) {
    console.warn("Could not send menu to self:", err.message);
  }
}

/** Public bot card — anyone who sends /bot gets this (advertising) */
const BOT_PROMO = `✦ *StarhubXbot*

WhatsApp multi-device companion with a live web dashboard.

• Anti-delete — keep messages others try to erase
• Anti view-once — unlock photos, videos & voice notes
• Groups — welcome, antilink, tagall, admin tools
• Status — post updates
• Web panel — chat, media, settings in the browser

Owner tools: \`/menu\` · \`/status\` · \`/vv\` · \`/antidelete\` · \`/autoantiviewonce\`

_Powered by StarhubXbot_`;

async function sendBotPromo(toJid) {
  if (!state.sock || !toJid) return;
  try {
    const logoCandidates = [
      path.join(__dirname, "..", "assets", "logo.png"),
      path.join(__dirname, "..", "public", "logo.png"),
    ];
    let logoBuf = null;
    for (const p of logoCandidates) {
      if (fs.existsSync(p)) {
        logoBuf = await fs.promises.readFile(p);
        break;
      }
    }
    if (logoBuf) {
      await state.sock.sendMessage(toJid, {
        image: logoBuf,
        caption: BOT_PROMO,
        mimetype: "image/png",
      });
    } else {
      await state.sock.sendMessage(toJid, { text: BOT_PROMO });
    }
  } catch (err) {
    console.warn("sendBotPromo:", err.message);
  }
}

async function setBotProfile() {
  if (!state.sock) return;
  // Update "about" / status text (best-effort)
  try {
    await state.sock.updateProfileStatus("StarhubXbot • online");
  } catch (_) {}
  // Profile picture from logo
  if (fs.existsSync(LOGO_PATH)) {
    try {
      const buf = await fs.promises.readFile(LOGO_PATH);
      await state.sock.updateProfilePicture(getSelfJid() || state.sock.user.id, buf);
      console.log("🖼  Profile picture set from logo.");
    } catch (err) {
      // WhatsApp may rate-limit picture changes
      console.warn("Could not set profile picture:", err.message);
    }
  }
}

// handleSelfCommand lives in lib/commands.js (imported above)


async function startBot(opts = {}) {
  const onOpen = typeof opts.onOpen === "function" ? opts.onOpen : null;
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  // IMPORTANT: pairing-code flow requires a canonical browser label.
  // WhatsApp rejects pairing codes generated with a custom browser name.
  // Keep recent full WA messages so media reupload/download can recover them
  if (!state.rawMsgCache) state.rawMsgCache = new Map();

  const sock = makeWASocket({
    version,
    auth: authState,
    logger: pino({ level: "silent" }),
    syncFullHistory: true,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    getMessage: async (key) => {
      try {
        if (key?.id && state.rawMsgCache?.has(key.id)) {
          return state.rawMsgCache.get(key.id);
        }
        const found = state.messages.find(
          (x) => x.id === key?.id && (!key.remoteJid || x.chatJid === key.remoteJid)
        );
        if (found?.rawMessage) return found.rawMessage;
      } catch (_) {}
      return undefined;
    },
  });
  state.sock = sock;
  registerGroupHooks(sock);

  sock.ev.on("creds.update", saveCreds);

  let latestQr = null;

  async function tryRequestPairingCode() {
    if (!latestQr || authState.creds.registered || pairingRequested || !state.phoneNumber) {
      return;
    }
    pairingRequested = true;
    try {
      const code = await sock.requestPairingCode(state.phoneNumber);
      setStatus("pairing", { pairingCode: code });
      const pretty = String(code).replace(/(.{4})/g, "$1 ").trim();
      console.log("\n\x1b[96m  ╔════════════════════════════════════════╗\x1b[0m");
      console.log("\x1b[96m  ║\x1b[0m     \x1b[1m\x1b[92mPAIRING CODE\x1b[0m                        \x1b[96m║\x1b[0m");
      console.log("\x1b[96m  ║\x1b[0m                                        \x1b[96m║\x1b[0m");
      console.log("\x1b[96m  ║\x1b[0m         \x1b[1m\x1b[97m" + pretty.padEnd(16) + "\x1b[0m              \x1b[96m║\x1b[0m");
      console.log("\x1b[96m  ║\x1b[0m                                        \x1b[96m║\x1b[0m");
      console.log("\x1b[96m  ╚════════════════════════════════════════╝\x1b[0m");
      console.log("\n  \x1b[36mOn your phone:\x1b[0m");
      console.log("  \x1b[2m1.\x1b[0m WhatsApp → Settings → Linked Devices");
      console.log("  \x1b[2m2.\x1b[0m Link a Device → \x1b[1mLink with phone number instead\x1b[0m");
      console.log("  \x1b[2m3.\x1b[0m Enter the code above (do it within ~1 minute)");
      console.log("\n  \x1b[33mIf it says \"Couldn't link device\":\x1b[0m");
      console.log("  \x1b[2m• Use mobile data or home Wi‑Fi (not a VPS/datacenter IP)\x1b[0m");
      console.log("  \x1b[2m• Unlink old devices: Linked Devices → remove unused ones\x1b[0m");
      console.log("  \x1b[2m• Delete ./auth and run again for a fresh code\x1b[0m");
      console.log("  \x1b[2m• Wait 30–60s between attempts (WhatsApp rate-limits)\x1b[0m\n");
    } catch (err) {
      state.lastError = String(err.message || err);
      console.error("Could not request a pairing code:", err.message || err);
      pairingRequested = false;
    }
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !authState.creds.registered) {
      latestQr = qr;
      reconnectAttempts = 0;
      await tryRequestPairingCode();
    }

    if (connection === "close") {
      const boom = new Boom(lastDisconnect?.error);
      const statusCode = boom?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || "unknown";
      const stillPairing = !authState.creds.registered;

      // Hard session death → always wipe
      if (FATAL_CODES.has(statusCode)) {
        console.log(`\x1b[33m  ⚠  Session invalid (${statusCode}). Auto-clearing ./auth…\x1b[0m`);
        setStatus("closed", { lastError: `Session invalid (${statusCode}), resetting` });
        await wipeAuth();
        pairingRequested = false;
        pairingFailures = 0;
        state.pairingCode = null;
        state.phoneNumber = null;
        phoneNumberPromise = null;
        state.menuSent = false;
        setTimeout(startBot, 1500);
        return;
      }

      // Unpaired + failed link (couldn't link device / timeout / 515) → count & auto-reset
      if (stillPairing && (PAIRING_FAIL_CODES.has(statusCode) || pairingRequested)) {
        pairingFailures += 1;
        console.log(
          `\x1b[33m  ⚠  Pairing attempt failed (${statusCode || "?"} — ${reason}). ` +
            `[${pairingFailures}/${MAX_PAIRING_FAILURES}]\x1b[0m`
        );

        if (pairingFailures >= MAX_PAIRING_FAILURES) {
          console.log("\x1b[33m  ⚠  Auto-clearing broken session — requesting a fresh pairing code…\x1b[0m");
          setStatus("closed", { lastError: "Pairing failed, session reset" });
          await wipeAuth();
          pairingRequested = false;
          pairingFailures = 0;
          state.pairingCode = null;
          // keep phone number so user is not asked again
          state.menuSent = false;
          setTimeout(startBot, 2000);
          return;
        }

        // Soft retry: reset pairing flag so a new code can be issued on next qr
        pairingRequested = false;
        state.pairingCode = null;
        const delay = Math.min(3000 * pairingFailures, 15000);
        console.log(`\x1b[2m  … retrying pairing in ${Math.round(delay / 1000)}s\x1b[0m`);
        setStatus("closed", { lastError: `Pairing retry (${statusCode || "unknown"})` });
        setTimeout(startBot, delay);
        return;
      }

      // Already linked — normal reconnect backoff (do NOT wipe auth)
      reconnectAttempts += 1;
      const delay = Math.min(2000 * reconnectAttempts, 30000);
      console.log(`\x1b[2m  … connection closed (${statusCode || "?"} — ${reason}). Retry in ${Math.round(delay / 1000)}s\x1b[0m`);
      setStatus("closed", { lastError: `Closed (${statusCode || "unknown"})` });
      setTimeout(startBot, delay);
    } else if (connection === "open") {
      reconnectAttempts = 0;
      pairingFailures = 0;
      setStatus("open", { pairingCode: null });
      if (sock.user?.id) state.selfJid = jidNormalizedUser(sock.user.id);
      console.log("\x1b[92m  ✓  StarhubXbot linked and connected.\x1b[0m");
      preloadGroupsAndCommunities();
      // Brand + welcome menu (once per session / first link)
      setTimeout(async () => {
        await setBotProfile();
        // Always send styled menu (with logo) to Message Yourself on connect
        await sendMenuToSelf();
        if (state.pendingTunnelUrl) {
          const url = state.pendingTunnelUrl;
          state.pendingTunnelUrl = null;
          await notifySelfText(
            "🌐 *StarhubXbot dashboard (Cloudflare)*\n\n" +
              url +
              "\n\nLogin with the username/password you set at startup."
          );
          console.log("🌐 Tunnel URL sent to Message Yourself");
        }
        if (onOpen) {
          try {
            await onOpen({ sock, selfJid: state.selfJid });
          } catch (e) {
            console.warn("onOpen callback:", e.message);
          }
        }
      }, 2500);
    }
  });

  if (!authState.creds.registered && !state.phoneNumber) {
    setStatus("pairing");
    if (!phoneNumberPromise) {
      phoneNumberPromise = (async () => {
        while (true) {
          const raw = await ask(
            "WhatsApp number (country code, digits only, e.g. 254712345678): "
          );
          const digits = String(raw).replace(/[^\d]/g, "");
          if (digits.length < 10 || digits.length > 15) {
            console.log("\x1b[33m  ⚠  Need 10–15 digits with country code (no + or spaces).\x1b[0m");
            continue;
          }
          state.phoneNumber = digits;
          return digits;
        }
      })();
    }
    await phoneNumberPromise;
    await tryRequestPairingCode();
  }

  sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest, syncType }) => {
    for (const chat of chats || []) {
      if (!chat?.id || isSystemJid(chat.id)) continue;
      const id = preferPhoneJid(chat.id);
      upsertChat(id, {
        name: chatDisplayName(id, chat),
        archived: !!chat.archived || !!chat.archive,
        unreadCount: chat.unreadCount || 0,
        kind: isGroupJid(id) ? "group" : "dm",
        lastTimestamp: chat.conversationTimestamp
          ? Number(chat.conversationTimestamp) * 1000
          : undefined,
      });
      if (isGroupJid(id) && !chat.name && !chat.subject) refreshGroupName(sock, id);
    }
    for (const c of contacts || []) {
      const name = c.name || c.notify || c.verifiedName;
      if (!name) continue;
      if (c.lid && c.id) registerJidAlias(c.lid, c.id);
      if (c.jid && c.id) registerJidAlias(c.jid, c.id);
      if (c.lid && c.jid) registerJidAlias(c.lid, c.jid);
      upsertContact(c.id, { name, notify: c.notify, verifiedName: c.verifiedName });
      if (c.lid && c.lid !== c.id) upsertContact(c.lid, { name });
      if (c.jid && c.jid !== c.id) upsertContact(c.jid, { name });
      // Single chat row only (phone preferred over LID — avoids duplicates)
      const primary = preferPhoneJid(c.jid || c.id || c.lid);
      if (primary) upsertChat(primary, { name });
    }
    for (const m of messages || []) {
      if (!m.message) continue;
      const chatJid = m.key.remoteJid;
      if (!chatJid || chatJid === "status@broadcast") continue;
      if (state.messages.some((x) => x.id === m.key.id && x.chatJid === chatJid)) continue;
      const existing = state.chats.get(chatJid);
      addMessage(buildMessageRecord(m, existing, null));
    }
    console.log(
      `📚 History sync: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages` +
        `${isLatest ? " (final)" : ""}.`
    );
  });

  sock.ev.on("chats.upsert", (chats) => {
    for (const chat of chats) {
      if (!chat?.id || isSystemJid(chat.id)) continue;
      const id = preferPhoneJid(chat.id);
      upsertChat(id, {
        name: chatDisplayName(id, chat),
        archived: !!chat.archived || !!chat.archive,
        kind: isGroupJid(id) ? "group" : "dm",
      });
      if (isGroupJid(id) && !chat.name && !chat.subject) refreshGroupName(sock, id);
    }
  });

  sock.ev.on("chats.update", (updates) => {
    for (const u of updates) {
      if (!u?.id || isSystemJid(u.id)) continue;
      const patch = {};
      if (u.name !== undefined) patch.name = u.name;
      if (u.archived !== undefined) patch.archived = !!u.archived;
      if (u.archive !== undefined) patch.archived = !!u.archive;
      if (u.unreadCount !== undefined) patch.unreadCount = u.unreadCount;
      if (Object.keys(patch).length) upsertChat(preferPhoneJid(u.id), patch);
    }
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    for (const c of contacts) {
      const name = c.name || c.notify || c.verifiedName;
      if (!name) continue;
      if (c.lid && c.id) registerJidAlias(c.lid, c.id);
      if (c.jid && c.id) registerJidAlias(c.jid, c.id);
      if (c.lid && c.jid) registerJidAlias(c.lid, c.jid);
      upsertContact(c.id, { name, notify: c.notify, verifiedName: c.verifiedName });
      if (c.lid && c.lid !== c.id) upsertContact(c.lid, { name });
      if (c.jid && c.jid !== c.id) upsertContact(c.jid, { name });
      // One chat per person — do not create parallel LID + phone rows
      const primary = preferPhoneJid(c.jid || c.id || c.lid);
      if (primary) upsertChat(primary, { name });
    }
  });

  async function preloadGroupsAndCommunities() {
    try {
      const groups = await sock.groupFetchAllParticipating();
      const entries = Object.values(groups);
      for (const g of entries) {
        upsertChat(g.id, {
          name: g.subject || g.id,
          isGroup: true,
          kind: g.isCommunity ? "community" : "group",
          communityId: g.linkedParent || null,
          participantsCount: Array.isArray(g.participants) ? g.participants.length : undefined,
        });
      }
      const communities = entries.filter((g) => g.isCommunity).length;
      console.log(`👥 Preloaded ${entries.length} groups (${communities} communities).`);
    } catch (err) {
      console.warn("⚠️  Could not preload groups:", err.message);
    }
  }

  // ── Anti-delete : keep in chat + forward copy to Message Yourself ──
  async function recoverDeletedMessage(chatJid, id) {
    let msg =
      state.messages.find((m) => m.id === id && m.chatJid === chatJid) ||
      state.messages.find((m) => m.id === id);
    if (!msg) {
      // Still mark if we can resolve chat
      markMessageRevoked(chatJid, id);
      console.log(`🗑 Anti-delete: unknown message id=${id} chat=${chatJid}`);
      return;
    }
    const jid = msg.chatJid || chatJid;
    markMessageRevoked(jid, id);
    console.log(`🗑 Anti-delete: marked revoked id=${id} chat=${jid} type=${msg.type}`);

    const mode = state.settings.antideleteMode || "both"; // self | chat | both
    // "chat" = dashboard only (already marked revoked above)
    if (mode === "chat") return;

    const self = getSelfJid();
    if (!self || !state.sock) return;

    const chatName =
      state.chats.get(jid)?.name ||
      (isGroupJid(jid) ? jid : prettyPhoneFromJid(jid));
    const who = msg.fromMe
      ? "You"
      : msg.senderName || resolveName(msg.senderJid) || msg.senderJid || "?";
    const header =
      `🗑 *Anti-delete*\n` +
      `From: ${who}\n` +
      `Chat: ${chatName}\n` +
      `Time: ${new Date(msg.timestamp || Date.now()).toLocaleString()}`;

    try {
      if (msg.hasLocalMedia && msg.mediaFile) {
        const mediaPath = path.join(MEDIA_DIR, msg.mediaFile);
        if (fs.existsSync(mediaPath)) {
          const buffer = await fs.promises.readFile(mediaPath);
          const kind = msg.type;
          const caption = `${header}\n\n${msg.text && !String(msg.text).startsWith("(") ? msg.text : ""}`.trim();
          if (kind === "image" || kind === "sticker") {
            await state.sock.sendMessage(self, { image: buffer, caption, mimetype: msg.mediaMime || undefined });
            return;
          }
          if (kind === "video") {
            await state.sock.sendMessage(self, { video: buffer, caption, mimetype: msg.mediaMime || undefined });
            return;
          }
          if (kind === "audio") {
            await state.sock.sendMessage(self, {
              audio: buffer,
              mimetype: msg.mediaMime || "audio/ogg; codecs=opus",
              ptt: !!msg.ptt,
            });
            await state.sock.sendMessage(self, { text: header });
            return;
          }
          if (kind === "document") {
            await state.sock.sendMessage(self, {
              document: buffer,
              mimetype: msg.mediaMime || "application/octet-stream",
              fileName: msg.mediaKey?.fileName || "file",
              caption: header,
            });
            return;
          }
        }
      }
      const body =
        (msg.originalText || msg.text) &&
        msg.text !== "(unsupported message type)"
          ? msg.originalText || msg.text
          : `[${msg.type || "message"}]`;
      await state.sock.sendMessage(self, { text: `${header}\n\n${body}` });
    } catch (err) {
      console.warn("Anti-delete forward failed:", err.message);
    }
  }

  function isRevokeProtocol(m) {
    const proto = m.message?.protocolMessage;
    if (!proto) return false;
    const t = proto.type;
    // Baileys / proto: REVOKE = 0
    return t === 0 || t === "REVOKE" || t === "MESSAGE_REVOKE" || Number(t) === 0;
  }

  sock.ev.on("messages.delete", async (item) => {
    try {
      const keys = item.keys || (item.key ? [item.key] : []);
      for (const key of keys) {
        const chatJid = key.remoteJid || item.jid || item.remoteJid;
        const id = key.id;
        if (!id) continue;
        const jid = chatJid || state.messages.find((x) => x.id === id)?.chatJid;
        if (!jid) continue;
        if (isAntideleteEnabled(jid)) {
          await recoverDeletedMessage(jid, id);
        } else {
          removeMessage(jid, id);
        }
      }
    } catch (err) {
      console.warn("messages.delete handler:", err.message);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Accept notify/append; also process unknown types that carry real messages
    if (type && type !== "notify" && type !== "append" && type !== "prepend") {
      // still process if any message has content (some WA builds use other types)
      const anyContent = (messages || []).some((m) => m?.message || m?.key?.isViewOnce);
      if (!anyContent) return;
    }
    for (const m of messages) {
      // Anti-delete via protocol REVOKE 
      if (isRevokeProtocol(m)) {
        const key = m.message.protocolMessage.key;
        if (key?.id) {
          const chatJid = key.remoteJid || m.key.remoteJid;
          console.log(`🗑 REVOKE protocol id=${key.id} chat=${chatJid}`);
          if (chatJid && isAntideleteEnabled(chatJid)) {
            await recoverDeletedMessage(chatJid, key.id);
          } else if (chatJid) {
            removeMessage(chatJid, key.id);
          } else {
            // Try by id only
            await recoverDeletedMessage(m.key.remoteJid, key.id);
          }
        }
        continue;
      }
      // View-once / ciphertext stubs: WhatsApp often withholds full media from
      // linked devices (phone-only by design). Still record a chat row so the
      // dashboard shows a clear placeholder instead of nothing.
      const isVoStub =
        !!m.key?.isViewOnce ||
        m.messageStubParameters?.[0] === "Message absent from node" ||
        String(m.messageStubParameters?.[0] || "").toLowerCase().includes("view_once") ||
        String(m.messageStubType || "").toLowerCase().includes("view");
      if ((!m.message || !Object.keys(m.message).length) && isVoStub) {
        const chatJid = m.key.remoteJid;
        if (chatJid && chatJid !== "status@broadcast") {
          const existing = state.chats.get(chatJid);
          const record = {
            id: m.key.id,
            chatJid,
            chatName: existing?.name,
            senderJid: m.key.participant || (m.key.fromMe ? "me" : chatJid),
            senderName: m.pushName || (m.key.fromMe ? "You" : undefined),
            fromMe: !!m.key.fromMe,
            text: "(view once — open on your phone)",
            type: "viewonce",
            timestamp: Number(m.messageTimestamp || Date.now() / 1000) * 1000,
            rawKey: m.key,
            hasMedia: false,
            hasLocalMedia: false,
            viewOnce: true,
            viewOnceStub: true,
          };
          addMessage(record);
          console.log(
            `👁 View-once stub only (no media on linked device) id=${m.key.id} chat=${chatJid}`
          );
        }
        continue;
      }

      if (!m.message) continue;
      const chatJid = m.key.remoteJid;

      if (chatJid === "status@broadcast") {
        if (m.key.fromMe) {
          addStatusEntry({
            id: m.key.id,
            text: extractText(m),
            type: messageKind(m),
            timestamp: Number(m.messageTimestamp || Date.now() / 1000) * 1000,
            fromMe: true,
            rawKey: m.key,
          });
        } else {
          // Incoming status from a contact: capture media for the dashboard
          // (auto status-react removed by request).
          const senderJid = m.key.participant || null;
          const kind = messageKind(m);
          let mediaInfo = null;
          if (["image", "video", "sticker", "audio", "document"].includes(kind)) {
            mediaInfo = await cacheMediaForMessage(m, m.key.id);
          }
          const senderName =
            m.pushName ||
            resolveName(senderJid) ||
            (senderJid ? prettyPhoneFromJid(senderJid) : "Unknown");
          addStatusEntry({
            id: m.key.id,
            senderJid,
            senderName,
            text: extractText(m),
            type: kind,
            timestamp: Number(m.messageTimestamp || Date.now() / 1000) * 1000,
            fromMe: false,
            viewOnce: isViewOnce(m),
            hasMedia: !!mediaInfo,
            hasLocalMedia: !!mediaInfo,
            mediaFile: mediaInfo?.fileName || null,
            mediaMime: mediaInfo?.mimetype || null,
            rawKey: m.key,
          });
        }
        continue;
      }
      if (!chatJid) continue;

      const self = getSelfJid();
      const t = extractText(m);

      // Cache raw proto so media reupload / getMessage can recover it
      if (m.key?.id && m.message) {
        if (!state.rawMsgCache) state.rawMsgCache = new Map();
        state.rawMsgCache.set(m.key.id, m.message);
        // Bound cache size
        if (state.rawMsgCache.size > 500) {
          const first = state.rawMsgCache.keys().next().value;
          state.rawMsgCache.delete(first);
        }
      }

      // IMPORTANT: download media BEFORE any read/ack so view-once is not expired
      const viewOnce = isViewOnce(m) || isViewOnceMessage(m) || !!m.key?.isViewOnce;
      if (viewOnce) {
        const topKeys = m.message ? Object.keys(m.message) : [];
        console.log(
          `👁 View-once received id=${m.key?.id} from=${m.pushName || m.key?.remoteJid} keys=[${topKeys.join(",")}] antiVO=${isAntiViewOnceEnabled(chatJid)}`
        );
      }
      let mediaInfo = null;
      let kind = messageKind(m);
      const maybeMedia =
        ["image", "video", "sticker", "audio", "document"].includes(kind) || viewOnce;
      if (maybeMedia) {
        mediaInfo = await cacheMediaForMessage(m, m.key.id);
        if (!mediaInfo) {
          for (const delay of [300, 800, 2000]) {
            await new Promise((r) => setTimeout(r, delay));
            mediaInfo = await cacheMediaForMessage(m, m.key.id);
            if (mediaInfo) break;
          }
        }
        if (mediaInfo?.kind) kind = mediaInfo.kind;
      }

      // Public advertise command — anyone can send /bot
      if (!m.key.fromMe && (t === "/bot" || t === "/starhub" || t === "/starhubx")) {
        await sendBotPromo(chatJid);
        continue;
      }

      // Owner commands (Message Yourself or fromMe in any chat)
      // /vv needs full message so quoted view-once can be unlocked
      if (t.startsWith("/") && (chatJid === self || m.key.fromMe)) {
        const handled = await handleSelfCommand(t, { m });
        if (handled) continue;
      }

      // Group admin commands (from linked account)
      if (m.key.fromMe && isGroupJid(chatJid) && t.startsWith("/")) {
        const handled = await handleGroupCommand(m, t);
        if (handled) continue;
      }

      // Antilink / antibadword (groups)
      if (isGroupJid(chatJid) && !m.key.fromMe) {
        await applyGroupFilters(m, t);
      }

      // Autoread AFTER media download (reading can expire view-once)
      if (state.settings.autoread && !m.key.fromMe && !viewOnce) {
        try { await sock.readMessages([m.key]); } catch (_) {}
      }

      const existing = state.chats.get(chatJid);
      const record = buildMessageRecord(m, existing, mediaInfo);
      if (mediaInfo?.kind) {
        record.type = mediaInfo.kind;
        record.hasMedia = true;
        record.hasLocalMedia = true;
        record.mediaFile = mediaInfo.fileName;
        record.mediaMime = mediaInfo.mimetype;
      } else if (viewOnce && record.type === "text") {
        const inner = unwrapMessage(m.message);
        if (inner?.imageMessage) record.type = "image";
        else if (inner?.videoMessage) record.type = "video";
        else if (inner?.audioMessage) record.type = "audio";
        record.hasMedia = ["image", "video", "audio", "sticker", "document"].includes(record.type);
      }
      record.viewOnce = viewOnce || record.viewOnce;
      record.rawMessage = m.message || null;
      addMessage(record);

      // Auto anti-view-once: run the same path as /vv in the background
      // (synthetic reply to this view-once → unlock → Message Yourself + dashboard)
      const looksViewOnce =
        viewOnce ||
        isViewOnceMessage(m) ||
        !!m.key?.isViewOnce ||
        !!m.message?.viewOnceMessage ||
        !!m.message?.viewOnceMessageV2 ||
        !!m.message?.viewOnceMessageV2Extension ||
        !!(
          m.message?.imageMessage?.viewOnce ||
          m.message?.videoMessage?.viewOnce ||
          m.message?.audioMessage?.viewOnce ||
          m.message?.documentMessage?.viewOnce
        );
      // Default ON unless explicitly disabled for this chat type
      const autoVoOn = isAntiViewOnceEnabled(chatJid);
      if (autoVoOn && looksViewOnce && !m.key.fromMe) {
        if (!state._vvDone) state._vvDone = new Set();
        const dedupeKey = `auto|${chatJid}|${m.key.id}`;
        if (!state._vvDone.has(dedupeKey)) {
          state._vvDone.add(dedupeKey);
          setTimeout(() => state._vvDone.delete(dedupeKey), 180000);

          // Ensure full proto is cached so /vv resolver can find it
          if (m.key?.id && m.message) {
            if (!state.rawMsgCache) state.rawMsgCache = new Map();
            state.rawMsgCache.set(m.key.id, m.message);
          }

          const runAutoVv = async () => {
            try {
              const mode = state.settings.viewOnceMode || "self";
              const selfJid = getSelfJid();
              console.log(
                `👁 Auto VO start id=${m.key?.id} mode=${mode} self=${selfJid || "?"} mediaCached=${!!mediaInfo}`
              );

              // 0) If media already in cache (dashboard), send to destinations from disk
              if (mediaInfo?.fileName) {
                try {
                  const fp = path.join(MEDIA_DIR, mediaInfo.fileName);
                  if (fs.existsSync(fp)) {
                    const buffer = await fs.promises.readFile(fp);
                    const k = mediaInfo.kind || kind || "image";
                    const caption =
                      `👁 *Auto anti view-once*\n` +
                      `From: ${record.senderName || m.pushName || "?"}\n` +
                      (existing?.name ? `Chat: ${existing.name}\n` : "");
                    await sendUnlockedToDestinations(sock, buffer, {
                      kind: k,
                      mimetype: mediaInfo.mimetype,
                      ptt: mediaInfo.ptt,
                      fileName: mediaInfo.fileName,
                      caption,
                      selfJid,
                      chatJid,
                      mode,
                    });
                    console.log(`👁 Auto VO via cache → mode=${mode} (${k})`);
                    record.hasLocalMedia = true;
                    record.hasMedia = true;
                    record.viewOnce = true;
                    record.viewOnceStub = false;
                    record.mediaFile = mediaInfo.fileName;
                    record.mediaMime = mediaInfo.mimetype;
                    if (k) record.type = k;
                    bus.emit("message", record);
                    persist();
                    return;
                  }
                } catch (e) {
                  console.warn("Auto VO cache-send:", e.message);
                }
              }

              // 1) Direct unlock (download + send by mode)
              let result = null;
              try {
                result = await processAutoViewOnce(m, sock, {
                  selfJid: mode === "chat" ? null : selfJid,
                  chatName: existing?.name || chatJid,
                  senderName: record.senderName || record.senderJid || m.pushName,
                  mode,
                });
              } catch (e) {
                console.warn("Auto VO direct:", e.message);
              }

              // 2) If direct failed, simulate /vv: reply-to-this-message with quoted payload
              if (!result?.ok && m.message) {
                const syntheticReply = {
                  key: {
                    remoteJid: chatJid,
                    fromMe: true,
                    id: `auto-vv-${m.key.id}`,
                  },
                  message: {
                    extendedTextMessage: {
                      text: "/vv",
                      contextInfo: {
                        stanzaId: m.key.id,
                        participant: m.key.participant || undefined,
                        remoteJid: chatJid,
                        quotedMessage: m.message,
                      },
                    },
                  },
                };
                console.log(`👁 Auto /vv background id=${m.key.id}`);
                const vv = await unlockViewOnceFromMessage(syntheticReply, {
                  toSelf: mode !== "chat",
                  silent: true,
                });
                if (vv?.ok && !vv.deduped) {
                  result = {
                    ok: true,
                    kind: vv.kind,
                    fileName: vv.fileName,
                    mimetype: null,
                  };
                }
              }

              // 3) Last resort: downloadContentFromMessage on any media node
              if (!result?.ok && m.message) {
                try {
                  const inner =
                    m.message.viewOnceMessage?.message ||
                    m.message.viewOnceMessageV2?.message ||
                    m.message.viewOnceMessageV2Extension?.message ||
                    m.message;
                  const node =
                    inner?.imageMessage ||
                    inner?.videoMessage ||
                    inner?.audioMessage ||
                    inner?.documentMessage ||
                    inner?.stickerMessage;
                  const k = inner?.imageMessage
                    ? "image"
                    : inner?.videoMessage
                      ? "video"
                      : inner?.audioMessage
                        ? "audio"
                        : inner?.stickerMessage
                          ? "sticker"
                          : inner?.documentMessage
                            ? "document"
                            : null;
                  if (node && k) {
                    const stream = await downloadContentFromMessage(node, k);
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buffer = Buffer.concat(chunks);
                    if (buffer.length) {
                      ensureMediaDir();
                      const ext =
                        k === "image" ? "jpg" : k === "video" ? "mp4" : k === "audio" ? "ogg" : k === "sticker" ? "webp" : "bin";
                      const fileName = `${m.key.id}.${ext}`;
                      await fs.promises.writeFile(path.join(MEDIA_DIR, fileName), buffer);
                      const self = getSelfJid();
                      if (self && mode !== "chat") {
                        const caption =
                          `👁 *Auto anti view-once*\nFrom: ${record.senderName || m.pushName || "?"}` +
                          (existing?.name ? `\nChat: ${existing.name}` : "");
                        if (k === "image" || k === "sticker") {
                          await sock.sendMessage(self, { image: buffer, caption });
                        } else if (k === "video") {
                          await sock.sendMessage(self, { video: buffer, caption });
                        } else if (k === "audio") {
                          await sock.sendMessage(self, {
                            audio: buffer,
                            mimetype: node.mimetype || "audio/ogg; codecs=opus",
                            ptt: !!node.ptt,
                          });
                          await sock.sendMessage(self, { text: caption });
                        } else {
                          await sock.sendMessage(self, {
                            document: buffer,
                            mimetype: node.mimetype || "application/octet-stream",
                            fileName,
                            caption,
                          });
                        }
                      }
                      result = { ok: true, kind: k, fileName, mimetype: node.mimetype, size: buffer.length };
                    }
                  }
                } catch (e) {
                  console.warn("Auto VO last-resort:", e.message);
                }
              }

              if (result?.ok) {
                record.hasLocalMedia = true;
                record.hasMedia = true;
                if (result.fileName) {
                  record.mediaFile = result.fileName;
                  record.mediaMime = result.mimetype || record.mediaMime;
                  const fp = path.join(MEDIA_DIR, result.fileName);
                  if (fs.existsSync(fp)) {
                    state.mediaCache.set(m.key.id, {
                      filePath: fp,
                      mimetype: result.mimetype || "application/octet-stream",
                      fileName: result.fileName,
                      size: result.size || 0,
                    });
                  }
                }
                if (result.kind) record.type = result.kind;
                record.viewOnce = true;
                record.viewOnceStub = false;
                bus.emit("message", record);
                persist();
                console.log(`👁 Auto /vv done id=${m.key.id} kind=${result.kind || "?"}`);
              } else {
                console.warn(
                  `👁 Auto /vv: could not unlock id=${m.key.id} (WhatsApp often withholds view-once media from linked devices — reply /vv on the phone to the view-once before opening it)`
                );
              }
            } catch (err) {
              console.warn("Auto /vv background:", err.message);
            }
          };

          // Run immediately + retries (media sometimes arrives slightly later)
          runAutoVv().catch((e) => console.warn("Auto /vv:", e.message));
          setTimeout(() => {
            runAutoVv().catch((e) => console.warn("Auto /vv retry:", e.message));
          }, 2000);
          setTimeout(() => {
            runAutoVv().catch((e) => console.warn("Auto /vv retry2:", e.message));
          }, 6000);
        }
      }

      // Always learn names from pushName (fixes "Unknown" in the web UI)
      if (m.pushName && !m.key.fromMe) {
        const who = m.key.participant || chatJid;
        upsertContact(who, { name: m.pushName, notify: m.pushName });
        if (!isGroupJid(chatJid)) {
          upsertChat(chatJid, { name: m.pushName });
        }
      }
      if (!isGroupJid(chatJid) && m.pushName && (!existing || !existing.name || existing.name === chatJid || isPlaceholderName?.(existing.name, chatJid))) {
        upsertChat(chatJid, { name: m.pushName });
        upsertContact(chatJid, { name: m.pushName });
      }
      if (isGroupJid(chatJid) && (!existing || !existing.name || existing.name === chatJid)) {
        refreshGroupName(sock, chatJid);
      }
      if (isGroupJid(chatJid) && m.pushName && m.key.participant) {
        upsertContact(m.key.participant, { name: m.pushName, notify: m.pushName });
      }
    }
  });


}

function toJid(input) {
  if (!input) return input;
  if (input.includes("@")) return input;
  const digits = String(input).replace(/[^\d]/g, "");
  return `${digits}@s.whatsapp.net`;
}

async function sendMessage(to, text, options = {}) {
  if (!state.sock || state.status !== "open") {
    throw new Error("Bot isn't connected yet.");
  }
  const jid = toJid(to);
  if (!state.chats.has(jid)) {
    upsertChat(jid, {
      name: resolveName(jid) || prettyPhoneFromJid(jid),
      kind: "dm",
      lastTimestamp: Date.now(),
    });
  }
  const payload = { text };
  const opts = {};
  if (options.quoted) opts.quoted = options.quoted;
  const sent = await state.sock.sendMessage(jid, payload, opts);
  addMessage({
    id: sent?.key?.id || `local-${Date.now()}`,
    chatJid: jid,
    fromMe: true,
    text,
    type: "text",
    timestamp: Date.now(),
    rawKey: sent?.key || null,
    quoted: options.quoted
      ? {
          id: options.quoted.key?.id,
          participant: options.quoted.key?.participant || null,
          text: options.quotedText || null,
        }
      : null,
    senderJid: "me",
    senderName: "You",
  });
  return sent;
}

async function sendMedia(to, { kind, buffer, mimetype, caption, filename, quoted, ptt, viewOnce }) {
  if (!state.sock || state.status !== "open") {
    throw new Error("Bot isn't connected yet.");
  }
  if (!buffer) throw new Error("No file was received.");
  const jid = toJid(to);
  if (!state.chats.has(jid)) {
    upsertChat(jid, {
      name: resolveName(jid) || prettyPhoneFromJid(jid),
      kind: "dm",
      lastTimestamp: Date.now(),
    });
  }

  const asViewOnce = viewOnce === true || viewOnce === "true";
  // View-once is only valid for image / video / audio (not sticker/document)
  const canViewOnce =
    asViewOnce && (kind === "image" || kind === "video" || kind === "audio" || kind === "ptt" || kind === "voice");

  let content;
  let previewText;
  if (kind === "image") {
    content = {
      image: buffer,
      mimetype: mimetype || "image/jpeg",
      caption: caption || undefined,
      ...(canViewOnce ? { viewOnce: true } : {}),
    };
    previewText = canViewOnce ? "(view-once image)" : caption || "(image)";
  } else if (kind === "video") {
    content = {
      video: buffer,
      mimetype: mimetype || "video/mp4",
      caption: caption || undefined,
      ...(canViewOnce ? { viewOnce: true } : {}),
    };
    previewText = canViewOnce ? "(view-once video)" : caption || "(video)";
  } else if (kind === "audio" || kind === "ptt" || kind === "voice") {
    const isPtt = ptt === true || kind === "ptt" || kind === "voice";
    content = {
      audio: buffer,
      mimetype: mimetype || "audio/ogg; codecs=opus",
      ptt: isPtt,
      ...(canViewOnce ? { viewOnce: true } : {}),
    };
    previewText = canViewOnce
      ? isPtt
        ? "(view-once voice note)"
        : "(view-once audio)"
      : isPtt
        ? "(voice note)"
        : "(audio)";
  } else if (kind === "sticker") {
    if (asViewOnce) {
      throw new Error("View-once is not supported for stickers. Use image or video.");
    }
    let webpBuffer = buffer;
    if (mimetype && !mimetype.includes("webp")) {
      let Sticker;
      try {
        ({ Sticker } = require("wa-sticker-formatter"));
      } catch {
        throw new Error(
          "Sticker conversion isn't installed. Send a .webp file, or run `npm install wa-sticker-formatter`."
        );
      }
      try {
        const sticker = new Sticker(buffer, { quality: 70 });
        webpBuffer = await sticker.toBuffer();
      } catch (err) {
        throw new Error("Couldn't convert to sticker: " + err.message);
      }
    }
    content = { sticker: webpBuffer };
    previewText = "(sticker)";
  } else if (kind === "document") {
    if (asViewOnce) {
      throw new Error("View-once is not supported for documents/zip. Use image, video, or audio.");
    }
    content = {
      document: buffer,
      mimetype: mimetype || "application/octet-stream",
      fileName: filename || "file",
      caption: caption || undefined,
    };
    previewText = `(file: ${filename || "unnamed"})`;
  } else {
    throw new Error(`Unknown media kind: ${kind}`);
  }

  const opts = {};
  if (quoted) opts.quoted = quoted;

  const sent = await state.sock.sendMessage(jid, content, opts);
  const msgId = sent?.key?.id || `local-${Date.now()}`;

  let mediaFile = null;
  let mediaMime = mimetype || null;
  try {
    ensureMediaDir();
    const ext =
      (mimetype || "").includes("webp") ? "webp" :
      (mimetype || "").includes("png") ? "png" :
      (mimetype || "").includes("jpeg") || (mimetype || "").includes("jpg") ? "jpg" :
      (mimetype || "").includes("mp4") ? "mp4" :
      (mimetype || "").includes("ogg") ? "ogg" : "bin";
    mediaFile = `${msgId}.${ext}`;
    await fs.promises.writeFile(
      path.join(MEDIA_DIR, mediaFile),
      kind === "sticker" ? content.sticker : buffer
    );
    state.mediaCache.set(msgId, {
      filePath: path.join(MEDIA_DIR, mediaFile),
      mimetype: mediaMime || "application/octet-stream",
      fileName: mediaFile,
    });
  } catch (_) {}

  addMessage({
    id: msgId,
    chatJid: jid,
    fromMe: true,
    text: previewText,
    type: kind,
    timestamp: Date.now(),
    rawKey: sent?.key || null,
    hasMedia: true,
    hasLocalMedia: !!mediaFile,
    mediaFile,
    mediaMime,
    viewOnce: !!canViewOnce,
    senderJid: "me",
    senderName: "You",
  });
  return sent;
}

async function deleteMessage(chatJid, msgId, forEveryone = true) {
  if (!state.sock || state.status !== "open") {
    throw new Error("Bot isn't connected yet.");
  }
  const msg = state.messages.find((m) => m.id === msgId && m.chatJid === chatJid);
  if (!msg || !msg.rawKey) {
    removeMessage(chatJid, msgId);
    return { ok: true, localOnly: true };
  }
  if (forEveryone && msg.fromMe) {
    await state.sock.sendMessage(chatJid, { delete: msg.rawKey });
  }
  removeMessage(chatJid, msgId);
  return { ok: true };
}

async function deleteStatus(id) {
  if (!state.sock || state.status !== "open") {
    throw new Error("Bot isn't connected yet.");
  }
  const entry = (state.statuses || []).find((status) => status.id === id);
  if (!entry) return { ok: true, localOnly: true, removed: 0 };
  if (entry.rawKey) {
    await state.sock.sendMessage("status@broadcast", { delete: entry.rawKey });
  }
  return { ok: true, removed: removeStatusEntry(id) };
}

async function editMessage(chatJid, msgId, newText) {
  if (!state.sock || state.status !== "open") {
    throw new Error("Bot isn't connected yet.");
  }
  const msg = state.messages.find((m) => m.id === msgId && m.chatJid === chatJid);
  if (!msg || !msg.fromMe || !msg.rawKey) {
    throw new Error("Can only edit your own messages that are still known.");
  }
  await state.sock.sendMessage(chatJid, {
    text: newText,
    edit: msg.rawKey,
  });
  msg.text = newText;
  msg.edited = true;
  return { ok: true };
}

async function forwardMessage(to, chatJid, msgId) {
  if (!state.sock || state.status !== "open") {
    throw new Error("Bot isn't connected yet.");
  }
  const msg = state.messages.find((m) => m.id === msgId && m.chatJid === chatJid);
  if (!msg) throw new Error("Message not found.");
  const jid = toJid(to);
  if (msg.hasLocalMedia && msg.mediaFile) {
    const filePath = path.join(MEDIA_DIR, msg.mediaFile);
    if (fs.existsSync(filePath)) {
      const buffer = await fs.promises.readFile(filePath);
      await sendMedia(jid, {
        kind: msg.type,
        buffer,
        mimetype: msg.mediaMime,
        caption: msg.text && !msg.text.startsWith("(") ? msg.text : undefined,
        filename: msg.mediaKey?.fileName,
      });
      return { ok: true };
    }
  }
  await sendMessage(jid, msg.text || `[Forwarded ${msg.type}]`);
  return { ok: true };
}

async function archiveChat(jid, archived) {
  const chat = state.chats.get(jid);
  if (state.sock && state.status === "open") {
    try {
      const lastMessages = chat?.lastMsgKey
        ? [{ key: chat.lastMsgKey, messageTimestamp: Math.floor((chat.lastTimestamp || Date.now()) / 1000) }]
        : [];
      await state.sock.chatModify({ archive: archived, lastMessages }, jid);
    } catch (err) {}
  }
  return setChatArchived(jid, archived);
}

async function sendStatus({ kind, text, buffer, mimetype, caption, backgroundColor, textColor, font, statusJidList }) {
  if (!state.sock || state.status !== "open") {
    throw new Error("Bot isn't connected yet.");
  }

  const audience =
    Array.isArray(statusJidList) && statusJidList.length ? statusJidList : knownContactJids();
  if (!audience.length) {
    throw new Error("No known contacts yet — let the bot finish syncing, then try again.");
  }

  let sent;
  if (kind === "text") {
    if (!text) throw new Error("Text status requires 'text'.");
    // Text statuses use the ExtendedTextMessage proto fields directly so we can
    // set background color, text color AND font (Baileys only wires bg + font
    // through options, and ignores textColor entirely).
    const ext = { text };
    const bg = argbFromHex(backgroundColor);
    const fg = argbFromHex(textColor);
    if (bg != null) ext.backgroundArgb = bg;
    if (fg != null) ext.textArgb = fg;
    if (font !== undefined && font !== null && !Number.isNaN(Number(font))) ext.font = Number(font);
    const generated = await generateWAMessageFromContent("status@broadcast", { extendedTextMessage: ext }, {
      logger: pino({ level: "silent" }),
      userJid: state.sock.user?.id,
    });
    await state.sock.relayMessage("status@broadcast", generated.message, {
      messageId: generated.key.id,
      statusJidList: audience,
    });
    sent = generated;
  } else {
    let content;
    if (kind === "image") {
      if (!buffer) throw new Error("Image status requires a file.");
      content = { image: buffer, mimetype: mimetype || "image/jpeg", caption: caption || "" };
    } else if (kind === "video") {
      if (!buffer) throw new Error("Video status requires a file.");
      content = { video: buffer, mimetype: mimetype || "video/mp4", caption: caption || "" };
    } else {
      throw new Error(`Unknown status kind: ${kind}`);
    }
    sent = await state.sock.sendMessage("status@broadcast", content, {
      broadcast: true,
      statusJidList: audience,
    });
  }

  addStatusEntry({
    id: sent?.key?.id || `status-${Date.now()}`,
    text: text || caption || `(${kind})`,
    type: kind,
    timestamp: Date.now(),
    fromMe: true,
    rawKey: sent?.key || null,
  });

  return sent;
}

async function getProfile(jid) {
  if (!state.sock || state.status !== "open") {
    return {
      jid,
      name: resolveName(jid) || prettyPhoneFromJid(jid),
      avatar: getCachedAvatar(jid)?.url || null,
    };
  }
  let about = null;
  let name = resolveName(jid) || prettyPhoneFromJid(jid);
  let participants = null;
  try {
    if (isGroupJid(jid)) {
      const meta = await state.sock.groupMetadata(jid);
      name = meta.subject || name;
      participants = (meta.participants || []).map((p) => ({
        jid: p.id,
        admin: p.admin || null,
        name: resolveName(p.id) || prettyPhoneFromJid(p.id),
      }));
    } else {
      try {
        const status = await state.sock.fetchStatus(jid);
        about = status?.status || null;
      } catch (_) {}
    }
  } catch (_) {}
  const avatar = await refreshAvatar(state.sock, jid);
  return { jid, name, about, avatar, participants, isGroup: isGroupJid(jid) };
}

function getMediaPath(msgId) {
  const cached = state.mediaCache.get(msgId);
  if (cached?.filePath && fs.existsSync(cached.filePath)) return cached;
  ensureMediaDir();
  for (const ext of ["jpg", "png", "webp", "mp4", "ogg", "pdf", "bin", "gif"]) {
    const p = path.join(MEDIA_DIR, `${msgId}.${ext}`);
    if (fs.existsSync(p)) {
      const info = { filePath: p, mimetype: guessMime(ext), fileName: `${msgId}.${ext}` };
      state.mediaCache.set(msgId, info);
      return info;
    }
  }
  const msg = state.messages.find((m) => m.id === msgId);
  if (msg?.mediaFile) {
    const p = path.join(MEDIA_DIR, msg.mediaFile);
    if (fs.existsSync(p)) {
      return { filePath: p, mimetype: msg.mediaMime || "application/octet-stream", fileName: msg.mediaFile };
    }
  }
  return null;
}

function guessMime(ext) {
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", mp4: "video/mp4", ogg: "audio/ogg", pdf: "application/pdf",
  };
  return map[ext] || "application/octet-stream";
}


/** Extract contextInfo from any message shape (text, media, buttons, etc.) */
function getContextInfo(m) {
  const msg = m?.message;
  if (!msg) return null;
  const direct =
    msg.extendedTextMessage?.contextInfo ||
    msg.imageMessage?.contextInfo ||
    msg.videoMessage?.contextInfo ||
    msg.audioMessage?.contextInfo ||
    msg.documentMessage?.contextInfo ||
    msg.stickerMessage?.contextInfo ||
    msg.buttonsResponseMessage?.contextInfo ||
    msg.templateButtonReplyMessage?.contextInfo ||
    msg.listResponseMessage?.contextInfo ||
    null;
  if (direct) return direct;
  // Generic: first nested object that carries contextInfo
  for (const v of Object.values(msg)) {
    if (v && typeof v === "object" && v.contextInfo) return v.contextInfo;
  }
  return null;
}

/**
 * Resolve the real view-once payload for /vv.
 * WhatsApp often strips media keys from quotedMessage — so we prefer:
 * 1) rawMsgCache by stanzaId (full message we stored when it arrived)
 * 2) state.messages[id].rawMessage
 * 3) quotedMessage itself
 * 4) already-saved local media file
 */
function resolveViewOnceSource(m) {
  const ctx = getContextInfo(m);
  const chatJid = m.key?.remoteJid;
  const msgId = ctx?.stanzaId || null;
  const quoted = ctx?.quotedMessage || null;

  // Prefer full original message we cached on arrival
  if (msgId && state.rawMsgCache?.has(msgId)) {
    return {
      msgId,
      chatJid,
      participant: ctx?.participant,
      message: state.rawMsgCache.get(msgId),
      source: "rawMsgCache",
    };
  }
  if (msgId) {
    const stored = state.messages.find(
      (x) => x.id === msgId && (!chatJid || x.chatJid === chatJid)
    ) || state.messages.find((x) => x.id === msgId);
    if (stored?.rawMessage) {
      return {
        msgId,
        chatJid: stored.chatJid || chatJid,
        participant: ctx?.participant || stored.senderJid,
        message: stored.rawMessage,
        source: "state.rawMessage",
        stored,
      };
    }
    // Already unlocked to disk?
    if (stored?.hasLocalMedia && stored.mediaFile) {
      return {
        msgId,
        chatJid: stored.chatJid || chatJid,
        participant: stored.senderJid,
        message: null,
        source: "localFile",
        stored,
      };
    }
  }
  if (quoted) {
    return {
      msgId: msgId || `vv-${Date.now()}`,
      chatJid,
      participant: ctx?.participant,
      message: quoted,
      source: "quotedMessage",
    };
  }
  return null;
}

/**
 * Unlock view-once media once.
 * - Always updates the dashboard
 * - Optionally forwards ONE copy to Message Yourself
 * - NEVER sends into the chat with the original sender
 */
async function unlockViewOnceFromMessage(m, { toSelf = true, silent = true } = {}) {
  if (!state.sock || state.status !== "open") {
    throw new Error("Bot isn't connected yet.");
  }

  const resolved = resolveViewOnceSource(m);
  if (!resolved) {
    throw new Error(
      "Reply to a *view-once* photo, video, or voice note, then send /vv (long-press the view-once bubble → Reply)."
    );
  }

  const { msgId, chatJid, participant } = resolved;

  if (!state._vvDone) state._vvDone = new Set();
  const dedupeKey = `${chatJid}|${msgId}`;
  if (state._vvDone.has(dedupeKey)) {
    return { ok: true, kind: "already", fileName: null, deduped: true };
  }
  state._vvDone.add(dedupeKey);
  setTimeout(() => state._vvDone.delete(dedupeKey), 60000);

  console.log(`👁 /vv resolve source=${resolved.source} id=${msgId} chat=${chatJid}`);

  let mediaInfo = null;
  let kind = "image";

  // Path A: already on disk
  if (resolved.source === "localFile" && resolved.stored?.mediaFile) {
    const filePath = path.join(MEDIA_DIR, resolved.stored.mediaFile);
    if (fs.existsSync(filePath)) {
      const buffer = await fs.promises.readFile(filePath);
      mediaInfo = {
        buffer,
        fileName: resolved.stored.mediaFile,
        mimetype: resolved.stored.mediaMime || "application/octet-stream",
        kind: resolved.stored.type || "image",
        ptt: !!resolved.stored.ptt,
      };
      kind = mediaInfo.kind;
    }
  }

  // Path B: download from resolved message proto
  if (!mediaInfo?.buffer && resolved.message) {
    const synthetic = {
      key: {
        remoteJid: chatJid,
        id: msgId,
        fromMe: false,
        participant: participant || undefined,
      },
      message: resolved.message,
    };
    const inner = unwrapMessage(resolved.message);
    const hasMedia = !!(
      inner?.imageMessage ||
      inner?.videoMessage ||
      inner?.audioMessage ||
      inner?.documentMessage ||
      inner?.stickerMessage
    );
    if (!hasMedia) {
      // Log keys to help debug
      const keys = Object.keys(resolved.message || {});
      console.warn(`👁 /vv no media in payload keys=[${keys.join(",")}] source=${resolved.source}`);
      throw new Error(
        "That reply is not view-once media (or WhatsApp stripped the file). Try again without opening the view-once on your phone first."
      );
    }
    mediaInfo = await cacheMediaForMessage(synthetic, msgId);
    if (!mediaInfo?.buffer) {
      // one retry after short delay
      await new Promise((r) => setTimeout(r, 1000));
      mediaInfo = await cacheMediaForMessage(synthetic, msgId);
    }
    kind = mediaInfo?.kind || messageKind(synthetic);
  }

  if (!mediaInfo?.buffer) {
    throw new Error(
      "Could not download view-once media (expired or not available on this linked device). Don't open it on the phone first."
    );
  }

  const caption =
    `👁 *View-once unlocked*\n` +
    `From: ${participant || chatJid || "?"}`;

  if (chatJid && chatJid !== "status@broadcast") {
    const existing =
      state.messages.find((x) => x.id === msgId && x.chatJid === chatJid) ||
      state.messages.find((x) => x.id === msgId);
    if (existing) {
      existing.hasLocalMedia = true;
      existing.hasMedia = true;
      existing.mediaFile = mediaInfo.fileName;
      existing.mediaMime = mediaInfo.mimetype;
      existing.type = kind;
      existing.viewOnce = true;
      existing.viewOnceStub = false;
      persist();
      bus.emit("message", existing);
    } else {
      addMessage({
        id: msgId,
        chatJid,
        fromMe: false,
        text: "",
        type: kind,
        timestamp: Date.now(),
        hasMedia: true,
        hasLocalMedia: true,
        mediaFile: mediaInfo.fileName,
        mediaMime: mediaInfo.mimetype,
        viewOnce: true,
        senderJid: participant || chatJid,
      });
    }
  }

  if (toSelf) {
    const target = getSelfJid();
    if (target) {
      await sendUnlockedMedia(target, mediaInfo, kind, caption);
    }
  }

  return { ok: true, kind, fileName: mediaInfo.fileName };
}

async function sendUnlockedMedia(target, mediaInfo, kind, caption) {
  if (!state.sock || !target || !mediaInfo?.buffer) return;
  if (kind === "image" || kind === "sticker") {
    await state.sock.sendMessage(target, {
      image: mediaInfo.buffer,
      caption,
      mimetype: mediaInfo.mimetype,
    });
  } else if (kind === "video") {
    await state.sock.sendMessage(target, {
      video: mediaInfo.buffer,
      caption,
      mimetype: mediaInfo.mimetype,
    });
  } else if (kind === "audio") {
    await state.sock.sendMessage(target, {
      audio: mediaInfo.buffer,
      mimetype: mediaInfo.mimetype || "audio/ogg; codecs=opus",
      ptt: !!mediaInfo.ptt,
    });
    if (caption) await state.sock.sendMessage(target, { text: caption });
  } else if (kind === "document") {
    await state.sock.sendMessage(target, {
      document: mediaInfo.buffer,
      mimetype: mediaInfo.mimetype || "application/octet-stream",
      fileName: "view-once-file",
      caption,
    });
  }
}



async function updateMyProfile({ name, about } = {}) {
  if (!state.sock || state.status !== "open") throw new Error("Not connected");
  const self = getSelfJid();
  if (about != null && about !== "") {
    try {
      await state.sock.updateProfileStatus(String(about).slice(0, 139));
    } catch (e) {
      console.warn("updateProfileStatus:", e.message);
    }
  }
  if (name != null && name !== "") {
    try {
      // Some Baileys builds expose updateProfileName
      if (typeof state.sock.updateProfileName === "function") {
        await state.sock.updateProfileName(String(name).slice(0, 25));
      }
    } catch (e) {
      console.warn("updateProfileName:", e.message);
    }
  }
  return { ok: true };
}

async function updateMyAvatar(buffer) {
  if (!state.sock || state.status !== "open") throw new Error("Not connected");
  if (!buffer || !buffer.length) throw new Error("Image required");
  await state.sock.updateProfilePicture(getSelfJid() || state.sock.user.id, buffer);
  return { ok: true };
}

async function setPrivacySettings({ readReceipts, status, lastSeen, profile } = {}) {
  if (!state.sock || state.status !== "open") throw new Error("Not connected");
  const sock = state.sock;
  const results = {};
  const map = {
    all: "all",
    contacts: "contacts",
    contact_blacklist: "contact_blacklist",
    none: "none",
    nobody: "none",
  };
  try {
    if (readReceipts === true || readReceipts === "all") {
      if (sock.updateReadReceiptsPrivacy) await sock.updateReadReceiptsPrivacy("all");
      results.readReceipts = "all";
    } else if (readReceipts === false || readReceipts === "none") {
      if (sock.updateReadReceiptsPrivacy) await sock.updateReadReceiptsPrivacy("none");
      results.readReceipts = "none";
    }
  } catch (e) {
    results.readReceiptsError = e.message;
  }
  try {
    if (status && sock.updateStatusPrivacy) {
      await sock.updateStatusPrivacy(map[status] || status);
      results.status = map[status] || status;
    }
  } catch (e) {
    results.statusError = e.message;
  }
  try {
    if (lastSeen && sock.updateLastSeenPrivacy) {
      await sock.updateLastSeenPrivacy(map[lastSeen] || lastSeen);
      results.lastSeen = map[lastSeen] || lastSeen;
    }
  } catch (e) {
    results.lastSeenError = e.message;
  }
  try {
    if (profile && sock.updateProfilePicturePrivacy) {
      await sock.updateProfilePicturePrivacy(map[profile] || profile);
      results.profile = map[profile] || profile;
    }
  } catch (e) {
    results.profileError = e.message;
  }
  return { ok: true, results };
}

async function getMyProfile() {
  const self = getSelfJid();
  if (!self) return { jid: null };
  let about = null;
  try {
    if (state.sock?.fetchStatus) {
      const st = await state.sock.fetchStatus(self);
      about = st?.status || null;
    }
  } catch (_) {}
  let avatar = getCachedAvatar(self)?.url || null;
  try {
    avatar = (await refreshAvatar(state.sock, self)) || avatar;
  } catch (_) {}
  return {
    jid: self,
    name: state.sock?.user?.name || resolveName(self) || prettyPhoneFromJid(self),
    about,
    avatar,
    phone: prettyPhoneFromJid(self),
  };
}


module.exports = {
  startBot,
  sendMessage,
  sendMedia,
  archiveChat,
  sendStatus,
  refreshAvatar,
  deleteMessage,
  deleteStatus,
  editMessage,
  forwardMessage,
  getProfile,
  deleteChat,
  clearChatMessages,
  getMediaPath,
  toJid,
  sendMenuToSelf,
  unlockViewOnceFromMessage,
  notifySelfText,
  updateMyProfile,
  updateMyAvatar,
  setPrivacySettings,
  getMyProfile,
};



