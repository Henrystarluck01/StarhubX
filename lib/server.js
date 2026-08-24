const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");

const {
  state,
  bus,
  chatList,
  getCachedAvatar,
  resolveName,
  prettyPhoneFromJid,
  upsertContact,
  upsertChat,
  updateSettings,
  sessionTtlMs,
} = require("./state");
const {
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
  updateMyProfile,
  updateMyAvatar,
  setPrivacySettings,
  getMyProfile,
  notifySelfText,
} = require("./bot");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 64 * 1024 * 1024 } });

const sessions = new Map();
// session length comes from settings.sessionHours via sessionTtlMs()

function createSession(user) {
  const token = crypto.randomBytes(32).toString("hex");
  const ttl = sessionTtlMs();
  sessions.set(token, { user, expires: Date.now() + ttl });
  return token;
}

function validSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return false;
  }
  // Sliding expiry — activity keeps you logged in for sessionHours
  s.expires = Date.now() + sessionTtlMs();
  return true;
}

function sessionCookieHeader(token) {
  const ttl = sessionTtlMs();
  // SameSite=Lax so normal navigation/back does not drop the cookie as easily as Strict
  return `wa_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}`;
}

function authMiddleware(req, res, next) {
  if (req.path === "/login" || req.path === "/api/login" || req.path === "/api/logout" || req.path === "/logo.png") {
    return next();
  }
  const token =
    req.headers["x-session-token"] ||
    (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("wa_session="))
      ?.split("=")[1];

  if (validSession(token)) {
    // Keep browser cookie in sync with sliding server TTL
    res.setHeader("Set-Cookie", sessionCookieHeader(token));
    return next();
  }

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  return res.redirect("/login");
}

function startServer() {
  const app = express();
  const port = process.env.PORT || 3000;

  const adminUser = process.env.ADMIN_USER || "admin";
  const adminPass = process.env.ADMIN_PASS || "change_me";
  if (adminPass === "change_me") {
    console.log("\x1b[33m  ⚠  Default dashboard password — set ADMIN_USER / ADMIN_PASS in .env\x1b[0m");
  }

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));

  app.get("/login", (req, res) => {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith("wa_session="))
      ?.split("=")[1];
    // Chrome can restore the login page from history. If the session is
    // still valid, never show that stale page again.
    if (validSession(token)) return res.redirect("/");
    res.sendFile(path.join(__dirname, "..", "public", "login.html"));
  });

  app.post("/api/login", (req, res) => {
    const { user, pass } = req.body || {};
    if (user === adminUser && pass === adminPass) {
      const token = createSession(user);
      const ttl = sessionTtlMs();
      res.setHeader("Set-Cookie", sessionCookieHeader(token));
      return res.json({ ok: true, token });
    }
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  });

  app.post("/api/logout", (req, res) => {
    const token =
      req.headers["x-session-token"] ||
      (req.headers.cookie || "")
        .split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith("wa_session="))
        ?.split("=")[1];
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", "wa_session=; Path=/; Max-Age=0");
    res.json({ ok: true });
  });

  app.use(authMiddleware);

  app.use(
    express.static(path.join(__dirname, "..", "public"), {
      etag: false,
      lastModified: false,
      setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
    })
  );

  app.get("/api/status", (req, res) => {
    res.json({
      status: state.status,
      pairingCode: state.pairingCode,
      phoneNumber: state.phoneNumber,
      lastError: state.lastError,
    });
  });

  app.get("/api/chats", (req, res) => {
    const { archived, kind } = req.query;
    const archivedFilter = archived === "true" ? true : archived === "false" ? false : undefined;
    res.json(chatList({ archived: archivedFilter, kind }));
  });

  app.post("/api/chats/:jid/archive", async (req, res) => {
    const { jid } = req.params;
    const archived = !!(req.body || {}).archived;
    try {
      const chat = await archiveChat(decodeURIComponent(jid), archived);
      res.json({ ok: true, chat });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.post("/api/chats/:jid/clear", (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    const n = clearChatMessages(jid);
    res.json({ ok: true, cleared: n });
  });

  app.post("/api/chats/:jid/delete", async (req, res) => {
    const jid = decodeURIComponent(req.params.jid);
    try {
      deleteChat(jid);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.get("/api/messages", (req, res) => {
    const chatJid = req.query.chat;
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 5000);
    const before = req.query.before ? Number(req.query.before) : null;
    let messages = state.messages;
    if (chatJid) messages = messages.filter((m) => m.chatJid === chatJid);
    if (before) messages = messages.filter((m) => m.timestamp < before);
    res.json(messages.slice(0, limit));
  });

  app.post("/api/send", async (req, res) => {
    const { to, text, quotedId, quotedChatJid, quotedText } = req.body || {};
    if (!to || !text) {
      return res.status(400).json({ ok: false, error: "Both 'to' and 'text' are required." });
    }
    try {
      let quoted = null;
      if (quotedId && quotedChatJid) {
        const orig = state.messages.find((m) => m.id === quotedId && m.chatJid === quotedChatJid);
        if (orig?.rawKey) {
          quoted = { key: orig.rawKey, message: { conversation: quotedText || orig.text || "" } };
        }
      }
      await sendMessage(to, text, { quoted, quotedText: quotedText || null });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.post("/api/send-media", upload.single("file"), async (req, res) => {
    const { to, kind, caption, quotedId, quotedChatJid, ptt, viewOnce } = req.body || {};
    if (!to || !req.file) {
      return res.status(400).json({ ok: false, error: "'to' and a 'file' are required." });
    }
    try {
      let quoted = null;
      if (quotedId && quotedChatJid) {
        const orig = state.messages.find((m) => m.id === quotedId && m.chatJid === quotedChatJid);
        if (orig?.rawKey) {
          quoted = { key: orig.rawKey, message: { conversation: orig.text || "" } };
        }
      }
      const mime = req.file.mimetype || "";
      let resolvedKind = kind;
      if (!resolvedKind) {
        if (mime.startsWith("video")) resolvedKind = "video";
        else if (mime.startsWith("audio")) resolvedKind = "audio";
        else if (mime.startsWith("image")) resolvedKind = "image";
        else resolvedKind = "document";
      }
      await sendMedia(to, {
        kind: resolvedKind,
        buffer: req.file.buffer,
        mimetype: req.file.mimetype,
        filename: req.file.originalname,
        caption,
        quoted,
        ptt: ptt === true || ptt === "true" || resolvedKind === "ptt" || resolvedKind === "voice",
        viewOnce: viewOnce === true || viewOnce === "true" || viewOnce === "1",
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.post("/api/messages/delete", async (req, res) => {
    const { chatJid, id, forEveryone } = req.body || {};
    if (!chatJid || !id) return res.status(400).json({ ok: false, error: "chatJid and id required" });
    try {
      const result = await deleteMessage(chatJid, id, forEveryone !== false);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.post("/api/messages/edit", async (req, res) => {
    const { chatJid, id, text } = req.body || {};
    if (!chatJid || !id || !text) {
      return res.status(400).json({ ok: false, error: "chatJid, id and text required" });
    }
    try {
      const result = await editMessage(chatJid, id, text);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.post("/api/messages/forward", async (req, res) => {
    const { to, chatJid, id } = req.body || {};
    if (!to || !chatJid || !id) {
      return res.status(400).json({ ok: false, error: "to, chatJid and id required" });
    }
    try {
      const result = await forwardMessage(to, chatJid, id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  // Serve cached media for a message — full file with Range support so videos
  // and voice notes play completely (no "halfway" scrubber / truncated stream).
  app.get("/api/media/:id", (req, res) => {
    const info = getMediaPath(req.params.id);
    if (!info || !info.filePath || !fs.existsSync(info.filePath)) {
      return res.status(404).json({ ok: false, error: "Media not found" });
    }
    let stat;
    try {
      stat = fs.statSync(info.filePath);
    } catch {
      return res.status(404).json({ ok: false, error: "Media not found" });
    }
    const fileSize = stat.size;
    const mime = info.mimetype || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", `inline; filename="${(info.fileName || req.params.id).replace(/"/g, "")}"`);

    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
        return;
      }
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= fileSize) {
        res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
        return;
      }
      end = Math.min(end, fileSize - 1);
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", chunkSize);
      fs.createReadStream(info.filePath, { start, end }).pipe(res);
    } else {
      res.setHeader("Content-Length", fileSize);
      fs.createReadStream(info.filePath).pipe(res);
    }
  });

  app.get("/api/avatar", async (req, res) => {
    const jid = req.query.jid;
    if (!jid) return res.status(400).json({ ok: false, error: "'jid' is required." });
    const cached = getCachedAvatar(jid);
    if (cached && Date.now() - cached.fetchedAt < 60 * 60 * 1000) {
      return res.json({ ok: true, url: cached.url });
    }
    if (!state.sock || state.status !== "open") {
      return res.json({ ok: true, url: cached?.url ?? null });
    }
    try {
      const url = await refreshAvatar(state.sock, jid);
      res.json({ ok: true, url });
    } catch (err) {
      res.json({ ok: true, url: null });
    }
  });

  app.get("/api/profile", async (req, res) => {
    const jid = req.query.jid;
    if (!jid) return res.status(400).json({ ok: false, error: "'jid' is required." });
    try {
      const profile = await getProfile(jid);
      res.json({ ok: true, profile });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  // Save / update a contact display name (local address book)
  app.post("/api/contacts", (req, res) => {
    const { jid, name } = req.body || {};
    if (!jid || !name || !String(name).trim()) {
      return res.status(400).json({ ok: false, error: "jid and name are required" });
    }
    const clean = String(name).trim();
    const j = toJid(jid);
    upsertContact(j, { name: clean });
    upsertChat(j, { name: clean });
    res.json({ ok: true, jid: j, name: clean });
  });

  app.get("/api/statuses", (req, res) => {
    res.json(state.statuses || []);
  });

  app.post("/api/status", upload.single("file"), async (req, res) => {
    const { kind, text, caption, backgroundColor, textColor, font } = req.body || {};
    try {
      await sendStatus({
        kind: kind || (req.file ? (req.file.mimetype.startsWith("video") ? "video" : "image") : "text"),
        text,
        caption,
        backgroundColor,
        textColor,
        font: font !== undefined ? Number(font) : undefined,
        buffer: req.file ? req.file.buffer : undefined,
        mimetype: req.file ? req.file.mimetype : undefined,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.post("/api/statuses/delete", async (req, res) => {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    try {
      const result = await deleteStatus(id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err.message || err) });
    }
  });

  app.get("/api/settings", (req, res) => {
    res.json({ ok: true, settings: state.settings });
  });

  app.post("/api/settings", (req, res) => {
    const { antidelete, viewOnceMode, antiViewOnce, antideleteMode, sessionHours, statusAutoReact, statusReactEmoji } = req.body || {};
    const updated = updateSettings({
      antidelete,
      viewOnceMode,
      antiViewOnce,
      antideleteMode,
      sessionHours,
      statusAutoReact,
      statusReactEmoji,
    });
    res.json({ ok: true, settings: updated });
  });

  app.get("/api/resolve-name", (req, res) => {
    const jid = req.query.jid;
    if (!jid) return res.json({ name: null });
    res.json({ name: resolveName(jid) || prettyPhoneFromJid(jid) });
  });

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    res.write("\n");

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const handlers = {
      message: (msg) => send("message", msg),
      chat: (chat) => send("chat", chat),
      status: (status) => send("status", status),
      avatar: (avatar) => send("avatar", avatar),
      "message-deleted": (d) => send("message-deleted", d),
      "message-revoked": (d) => send("message-revoked", d),
      "chat-cleared": (d) => send("chat-cleared", d),
      "chat-deleted": (d) => send("chat-deleted", d),
      "status-entry": (d) => send("status-entry", d),
      contact: (d) => send("contact", d),
      settings: (d) => send("settings", d),
    };

    for (const [ev, fn] of Object.entries(handlers)) bus.on(ev, fn);

    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      for (const [ev, fn] of Object.entries(handlers)) bus.off(ev, fn);
    });
  });

  app.listen(port, () => {
    console.log("\x1b[92m  ✓  Dashboard ready\x1b[0m  →  \x1b[1mhttp://localhost:" + port + "/login\x1b[0m  (user: " + adminUser + ")");
  });
}

module.exports = { startServer };

