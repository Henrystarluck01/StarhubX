/**
 * Shared state — StarhubXbot
 */

const EventEmitter = require("events");
const cache = require("./cache");

const MAX_MESSAGES = 25000;

const DEFAULT_SETTINGS = {
  antidelete: { dm: true, group: true, community: true },
  antideleteMode: "both", // self | chat | both
  // Auto anti-view-once per chat type (no /vv needed when media arrives)
  antiViewOnce: { dm: true, group: true, community: true },
  viewOnceMode: "self", // self | chat | both
  sessionHours: 168,
  welcome: false,
  goodbye: false,
  welcomeMsg: "Welcome @user to *{group}*!",
  goodbyeMsg: "Goodbye @user.",
  antilink: false,
  antibadword: false,
  badwords: [],
  autoread: false,
  statusAutoReact: false, // disabled — feature removed from UI / runtime
  statusReactEmoji: "👀",
};

const state = {
  sock: null,
  status: "starting",
  pairingCode: null,
  phoneNumber: null,
  lastError: null,
  messages: [],
  chats: new Map(),
  avatars: new Map(),
  contactJids: new Set(),
  contacts: new Map(),
  jidAliases: new Map(), // lid ↔ phone jid
  statuses: [],
  mediaCache: new Map(),
  settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
  selfJid: null,
  menuSent: false,
  startedAt: Date.now(),
};

const bus = new EventEmitter();

(function restore() {
  const snapshot = cache.load();
  if (!snapshot) return;
  if (Array.isArray(snapshot.messages)) state.messages = snapshot.messages.slice(0, MAX_MESSAGES);
  if (Array.isArray(snapshot.chats)) {
    for (const c of snapshot.chats) state.chats.set(c.jid, c);
  }
  if (Array.isArray(snapshot.contacts)) {
    for (const c of snapshot.contacts) state.contacts.set(c.jid, c);
  }
  if (Array.isArray(snapshot.statuses)) {
    state.statuses = snapshot.statuses.slice(0, 200);
  }
  if (snapshot.settings) {
    state.settings = {
      ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      ...snapshot.settings,
      antidelete: {
        dm: snapshot.settings.antidelete?.dm !== false,
        group: snapshot.settings.antidelete?.group !== false,
        community: snapshot.settings.antidelete?.community !== false,
      },
      viewOnceMode:
        snapshot.settings.viewOnceMode === "chat" || snapshot.settings.viewOnceMode === "both"
          ? snapshot.settings.viewOnceMode
          : "self",
      antiViewOnce: (() => {
        const av = snapshot.settings.antiViewOnce;
        if (av && typeof av === "object") {
          return {
            dm: av.dm !== false,
            group: av.group !== false,
            community: av.community !== false,
          };
        }
        // migrate old boolean
        const on = av !== false;
        return { dm: on, group: on, community: on };
      })(),
      antideleteMode:
        snapshot.settings.antideleteMode === "self" ||
        snapshot.settings.antideleteMode === "chat"
          ? snapshot.settings.antideleteMode
          : "both",
      sessionHours: Number(snapshot.settings.sessionHours) > 0
        ? Number(snapshot.settings.sessionHours)
        : DEFAULT_SETTINGS.sessionHours,
      badwords: Array.isArray(snapshot.settings.badwords) ? snapshot.settings.badwords : [],
    };
  }
  if (snapshot.menuSent) state.menuSent = true;
  if (state.chats.size || state.messages.length) {
    console.log(
      `\x1b[36m  ⓘ  Restored ${state.chats.size} chats / ${state.messages.length} messages / ${state.contacts.size} contacts\x1b[0m`
    );
  }
})();

function persist() {
  cache.scheduleSave(() => ({
    chats: [...state.chats.values()],
    messages: state.messages,
    contacts: [...state.contacts.values()],
    statuses: state.statuses,
    settings: state.settings,
    menuSent: state.menuSent,
  }));
}

function isGroupJid(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

/** Skip system / non-conversation JIDs from the chat list */
function isSystemJid(jid) {
  if (!jid || typeof jid !== "string") return true;
  if (jid === "status@broadcast") return true;
  if (jid.endsWith("@broadcast")) return true;
  if (jid.endsWith("@newsletter")) return true;
  if (jid.endsWith("@g.us") && jid.startsWith("0")) return false;
  // Baileys sometimes surfaces bare server ids
  if (jid === "server" || jid === "0" || jid === "undefined") return true;
  return false;
}

/** Normalize user JIDs: strip device suffix (123:xx@s.whatsapp.net → 123@s.whatsapp.net) */
function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return jid;
  if (jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) {
    return jid;
  }
  // user@s.whatsapp.net or user:device@s.whatsapp.net
  if (jid.includes("@s.whatsapp.net")) {
    const user = jid.split("@")[0].split(":")[0];
    return `${user}@s.whatsapp.net`;
  }
  if (jid.endsWith("@lid")) {
    const user = jid.split("@")[0].split(":")[0];
    return `${user}@lid`;
  }
  return jid;
}

/**
 * Prefer phone JID over LID when we know both refer to the same person.
 * Alias map: lid → phone jid (and reverse for lookups).
 */
function preferPhoneJid(jid) {
  if (!jid) return jid;
  const n = normalizeJid(jid);
  if (n.endsWith("@s.whatsapp.net")) return n;
  if (n.endsWith("@lid")) {
    const mapped = state.jidAliases?.get(n);
    if (mapped) return mapped;
  }
  return n;
}

function registerJidAlias(a, b) {
  if (!a || !b || a === b) return;
  if (!state.jidAliases) state.jidAliases = new Map();
  const na = normalizeJid(a);
  const nb = normalizeJid(b);
  // Prefer mapping lid → phone
  if (na.endsWith("@lid") && nb.endsWith("@s.whatsapp.net")) {
    state.jidAliases.set(na, nb);
  } else if (nb.endsWith("@lid") && na.endsWith("@s.whatsapp.net")) {
    state.jidAliases.set(nb, na);
  }
}

function prettyPhoneFromJid(jid) {
  if (typeof jid !== "string") return jid;
  const preferred = preferPhoneJid(jid);
  const use = preferred || jid;
  const digits = use.split("@")[0].split(":")[0];
  // LID numeric ids are not phone numbers — show short label, never bare "Unknown"
  if (use.endsWith("@lid")) {
    const mapped = state.jidAliases?.get(normalizeJid(use));
    if (mapped) {
      const d = mapped.split("@")[0].split(":")[0];
      if (/^\d+$/.test(d)) return `+${d}`;
    }
    return `Contact ${String(digits).slice(-6)}`;
  }
  if (!/^\d+$/.test(digits)) return use;
  return `+${digits}`;
}

function isPlaceholderName(name, jid) {
  if (!name) return true;
  const n = String(name).trim();
  if (!n) return true;
  if (n === jid) return true;
  if (n === "Unknown" || n === "unknown" || n === "undefined" || n === "null") return true;
  if (jid && n === prettyPhoneFromJid(jid) && String(jid).endsWith("@lid")) return true;
  // bare jid user part
  if (jid && n === jid.split("@")[0]) return true;
  return false;
}

function setAvatar(jid, url) {
  state.avatars.set(jid, { url: url || null, fetchedAt: Date.now() });
  bus.emit("avatar", { jid, url: url || null });
}

function getCachedAvatar(jid) {
  return state.avatars.get(jid) || null;
}

function setStatus(status, extra = {}) {
  state.status = status;
  Object.assign(state, extra);
  bus.emit("status", { status, ...extra });
}

function upsertContact(jid, patch = {}) {
  if (!jid) return;
  const existing = state.contacts.get(jid) || { jid };
  const updated = { ...existing, ...patch, jid };
  state.contacts.set(jid, updated);
  if (patch.name || patch.notify || patch.verifiedName) {
    const best = patch.name || patch.notify || patch.verifiedName;
    const chat = state.chats.get(jid);
    if (chat && (!chat.name || chat.name === jid || chat.name === prettyPhoneFromJid(jid))) {
      upsertChat(jid, { name: best });
    } else if (chat && patch.name) {
      upsertChat(jid, { name: patch.name });
    }
  }
  persist();
  bus.emit("contact", updated);
  return updated;
}

function resolveName(jid) {
  if (!jid) return null;
  const candidates = [jid, normalizeJid(jid), preferPhoneJid(jid)];
  // Also try reverse alias (phone → any lid key that maps here is harder; scan contacts)
  for (const id of candidates) {
    if (!id) continue;
    const contact = state.contacts.get(id);
    if (contact) {
      const n = contact.name || contact.notify || contact.verifiedName || null;
      if (n && !isPlaceholderName(n, id)) return n;
    }
  }
  // Scan contacts for matching lid/phone via aliases
  if (state.jidAliases) {
    for (const [lid, phone] of state.jidAliases.entries()) {
      if (phone === preferPhoneJid(jid) || lid === normalizeJid(jid)) {
        for (const id of [lid, phone]) {
          const contact = state.contacts.get(id);
          if (contact) {
            const n = contact.name || contact.notify || contact.verifiedName || null;
            if (n && !isPlaceholderName(n, id)) return n;
          }
        }
      }
    }
  }
  const chat = state.chats.get(preferPhoneJid(jid)) || state.chats.get(jid);
  if (chat?.name && !isPlaceholderName(chat.name, jid)) {
    return chat.name;
  }
  return null;
}

function upsertChat(jid, patch = {}) {
  if (!jid || isSystemJid(jid)) return null;
  // Collapse device variants + prefer phone over LID when aliased
  const preferred = preferPhoneJid(jid);
  const key = preferred;

  // If this was a LID that maps to a phone chat, merge into that chat instead of creating a twin
  if (jid !== key && state.chats.has(key)) {
    // drop orphan LID entry if present
    if (state.chats.has(normalizeJid(jid)) && normalizeJid(jid) !== key) {
      state.chats.delete(normalizeJid(jid));
    }
  }

  const existing = state.chats.get(key) || {
    jid: key,
    name: null,
    lastText: "",
    lastTimestamp: 0,
    archived: false,
    isGroup: isGroupJid(key),
    kind: isGroupJid(key) ? "group" : "dm",
    communityId: null,
    unreadCount: 0,
    lastMsgKey: null,
    participantsCount: undefined,
  };

  if (patch.name && isPlaceholderName(patch.name, key)) {
    delete patch.name;
  }
  if (!patch.name) {
    const resolved = resolveName(key) || resolveName(jid);
    if (resolved && !isPlaceholderName(resolved, key)) patch.name = resolved;
  }

  // Never overwrite a good name with a placeholder
  if (
    patch.name &&
    existing.name &&
    !isPlaceholderName(existing.name, key) &&
    isPlaceholderName(patch.name, key)
  ) {
    delete patch.name;
  }

  const updated = { ...existing, ...patch, jid: key };
  if (!updated.name || isPlaceholderName(updated.name, key)) {
    updated.name = resolveName(key) || prettyPhoneFromJid(key);
  }
  state.chats.set(key, updated);

  // Remove duplicate LID row if we now store under phone jid
  const rawNorm = normalizeJid(jid);
  if (rawNorm !== key && state.chats.has(rawNorm)) {
    const orphan = state.chats.get(rawNorm);
    // merge last activity
    if ((orphan?.lastTimestamp || 0) > (updated.lastTimestamp || 0)) {
      updated.lastTimestamp = orphan.lastTimestamp;
      updated.lastText = orphan.lastText || updated.lastText;
      state.chats.set(key, updated);
    }
    state.chats.delete(rawNorm);
  }

  if (!isGroupJid(key) && !isSystemJid(key) && (key.endsWith("@s.whatsapp.net") || key.endsWith("@lid"))) {
    state.contactJids.add(key);
  }
  persist();
  bus.emit("chat", updated);
  return updated;
}

function knownContactJids() {
  return [...state.contactJids];
}

function chatKindForAntidelete(jid) {
  const chat = state.chats.get(jid);
  if (chat?.kind === "community") return "community";
  if (isGroupJid(jid)) return "group";
  return "dm";
}

function isAntideleteEnabled(jid) {
  const kind = chatKindForAntidelete(jid);
  return !!state.settings.antidelete[kind];
}

function isAntiViewOnceEnabled(jid) {
  const kind = chatKindForAntidelete(jid);
  const av = state.settings.antiViewOnce;
  // Default ON for all chat types when unset / partial
  if (av == null) return true;
  if (typeof av === "boolean") return av;
  if (typeof av === "object") {
    if (av[kind] === false) return false;
    return av[kind] !== false; // true or undefined → on
  }
  return true;
}

function addMessage(msg) {
  if (!msg) return null;
  // Collapse LID / device variants onto one chat id
  if (msg.chatJid) {
    msg.chatJid = preferPhoneJid(msg.chatJid);
  }
  if (isSystemJid(msg.chatJid)) return null;

  if (msg.id) {
    const existingIndex = state.messages.findIndex((m) => m.id === msg.id && m.chatJid === msg.chatJid);
    if (existingIndex !== -1) {
      state.messages[existingIndex] = { ...state.messages[existingIndex], ...msg };
      persist();
      bus.emit("message", state.messages[existingIndex]);
      return state.messages[existingIndex];
    }
  }

  state.messages.unshift(msg);
  if (state.messages.length > MAX_MESSAGES) state.messages.length = MAX_MESSAGES;

  const prev = state.chats.get(msg.chatJid) || {};
  const namePatch =
    msg.chatName && !isPlaceholderName(msg.chatName, msg.chatJid)
      ? msg.chatName
      : prev.name || resolveName(msg.chatJid) || prettyPhoneFromJid(msg.chatJid);
  upsertChat(msg.chatJid, {
    name: namePatch,
    lastText: msg.revoked ? prev.lastText : msg.text,
    lastTimestamp: msg.timestamp,
    lastMsgKey: msg.rawKey || prev.lastMsgKey || null,
    archived: msg.fromMe ? prev.archived || false : false,
  });

  persist();
  bus.emit("message", msg);
  return msg;
}

function removeMessage(chatJid, id) {
  const idx = state.messages.findIndex((m) => m.id === id && m.chatJid === chatJid);
  if (idx === -1) return false;
  state.messages.splice(idx, 1);
  persist();
  bus.emit("message-deleted", { chatJid, id });
  return true;
}

function markMessageRevoked(chatJid, id) {
  // Match by id+jid first; fall back to id only (LID vs PN jid mismatches)
  let idx = state.messages.findIndex((m) => m.id === id && m.chatJid === chatJid);
  if (idx === -1) {
    idx = state.messages.findIndex((m) => m.id === id);
  }
  if (idx === -1) return false;
  const prev = state.messages[idx];
  const updated = {
    ...prev,
    revoked: true,
    revokedAt: Date.now(),
    // Keep original body; UI shows the "deleted" banner on top
    originalText: prev.originalText || prev.text,
  };
  state.messages[idx] = updated;
  // Chat list preview
  const chat = state.chats.get(updated.chatJid);
  if (chat) {
    upsertChat(updated.chatJid, {
      lastText: "🗑 deleted message",
      lastTimestamp: Date.now(),
    });
  }
  persist();
  bus.emit("message", updated);
  bus.emit("message-revoked", { chatJid: updated.chatJid, id: updated.id, message: updated });
  return true;
}

function clearChatMessages(chatJid) {
  const before = state.messages.length;
  state.messages = state.messages.filter((m) => m.chatJid !== chatJid);
  persist();
  bus.emit("chat-cleared", { chatJid });
  return before - state.messages.length;
}

function deleteChat(jid) {
  state.chats.delete(jid);
  clearChatMessages(jid);
  bus.emit("chat-deleted", { jid });
  persist();
}

function setChatArchived(jid, archived) {
  return upsertChat(jid, { archived: !!archived });
}

function chatList({ archived, kind } = {}) {
  // Dedupe by preferred jid (phone over LID)
  const byKey = new Map();
  for (const c of state.chats.values()) {
    if (!c?.jid || isSystemJid(c.jid)) continue;
    const key = preferPhoneJid(c.jid);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...c, jid: key });
      continue;
    }
    // keep richer entry
    const merged = { ...prev, ...c, jid: key };
    if ((c.lastTimestamp || 0) > (prev.lastTimestamp || 0)) {
      merged.lastTimestamp = c.lastTimestamp;
      merged.lastText = c.lastText || prev.lastText;
    }
    if (isPlaceholderName(merged.name, key) && !isPlaceholderName(prev.name, key)) {
      merged.name = prev.name;
    }
    if (isPlaceholderName(merged.name, key) && !isPlaceholderName(c.name, key)) {
      merged.name = c.name;
    }
    byKey.set(key, merged);
  }

  let list = [...byKey.values()];

  // Drop empty unknown DMs with no activity (noise from contact sync / LIDs)
  list = list.filter((c) => {
    if (isGroupJid(c.jid) || c.kind === "group" || c.kind === "community") return true;
    const hasActivity = (c.lastTimestamp || 0) > 0 || !!(c.lastText && String(c.lastText).trim());
    const hasName = c.name && !isPlaceholderName(c.name, c.jid);
    // Keep if named OR has message activity
    if (hasName || hasActivity) return true;
    // Pure @lid shells with no name/activity → hide
    if (String(c.jid).endsWith("@lid")) return false;
    return false;
  });

  if (archived === true) list = list.filter((c) => c.archived);
  if (archived === false) list = list.filter((c) => !c.archived);
  if (kind) list = list.filter((c) => c.kind === kind);

  return list
    .map((c) => {
      const resolved = resolveName(c.jid);
      let name = c.name;
      if (resolved && !isPlaceholderName(resolved, c.jid)) name = resolved;
      if (isPlaceholderName(name, c.jid)) {
        name = prettyPhoneFromJid(c.jid);
        if (name === "Unknown" && String(c.jid).endsWith("@s.whatsapp.net")) {
          name = prettyPhoneFromJid(c.jid);
        }
      }
      return { ...c, name };
    })
    .sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));
}

function addStatusEntry(entry) {
  const existing = state.statuses.findIndex((item) => item.id === entry.id);
  if (existing !== -1) {
    state.statuses[existing] = { ...state.statuses[existing], ...entry };
    persist();
    bus.emit("status-entry", state.statuses[existing]);
    return state.statuses[existing];
  }
  state.statuses.unshift(entry);
  if (state.statuses.length > 200) state.statuses.length = 200;
  persist();
  bus.emit("status-entry", entry);
}

function removeStatusEntry(id) {
  const before = state.statuses.length;
  state.statuses = state.statuses.filter((entry) => entry.id !== id);
  if (before !== state.statuses.length) {
    persist();
    bus.emit("status-entry", { deleted: id });
  }
  return before - state.statuses.length;
}

function updateSettings(patch) {
  if (patch.antidelete) {
    state.settings.antidelete = {
      ...state.settings.antidelete,
      ...patch.antidelete,
    };
  }
  if (
    patch.viewOnceMode === "self" ||
    patch.viewOnceMode === "chat" ||
    patch.viewOnceMode === "both"
  ) {
    state.settings.viewOnceMode = patch.viewOnceMode;
  }
  if (typeof patch.antiViewOnce === "boolean") {
    const on = patch.antiViewOnce;
    state.settings.antiViewOnce = { dm: on, group: on, community: on };
  } else if (patch.antiViewOnce && typeof patch.antiViewOnce === "object") {
    state.settings.antiViewOnce = {
      ...state.settings.antiViewOnce,
      ...patch.antiViewOnce,
    };
  }
  if (
    patch.antideleteMode === "self" ||
    patch.antideleteMode === "chat" ||
    patch.antideleteMode === "both"
  ) {
    state.settings.antideleteMode = patch.antideleteMode;
  }
  if (patch.sessionHours !== undefined) {
    const h = Number(patch.sessionHours);
    if (h > 0 && h <= 24 * 365) state.settings.sessionHours = h;
  }
  for (const key of ["welcome", "goodbye", "antilink", "antibadword", "autoread", "statusAutoReact"]) {
    if (patch[key] !== undefined) state.settings[key] = !!patch[key];
  }
  if (patch.statusReactEmoji !== undefined) {
    const e = String(patch.statusReactEmoji).trim().slice(0, 8);
    if (e) state.settings.statusReactEmoji = e;
  }
  if (patch.welcomeMsg !== undefined) state.settings.welcomeMsg = String(patch.welcomeMsg);
  if (patch.goodbyeMsg !== undefined) state.settings.goodbyeMsg = String(patch.goodbyeMsg);
  if (Array.isArray(patch.badwords)) {
    state.settings.badwords = patch.badwords.map((w) => String(w).toLowerCase().trim()).filter(Boolean);
  }
  persist();
  bus.emit("settings", state.settings);
  return state.settings;
}

function sessionTtlMs() {
  const hours = Number(state.settings.sessionHours) || DEFAULT_SETTINGS.sessionHours;
  return Math.max(1, hours) * 60 * 60 * 1000;
}

module.exports = {
  state,
  bus,
  setStatus,
  addMessage,
  removeMessage,
  markMessageRevoked,
  // message-revoked is emitted from markMessageRevoked via bus
  clearChatMessages,
  normalizeJid,
  preferPhoneJid,
  registerJidAlias,
  isSystemJid,
  isPlaceholderName,
  deleteChat,
  chatList,
  upsertChat,
  setChatArchived,
  isGroupJid,
  persist,
  prettyPhoneFromJid,
  setAvatar,
  getCachedAvatar,
  knownContactJids,
  upsertContact,
  resolveName,
  addStatusEntry,
  removeStatusEntry,
  isAntideleteEnabled,
  isAntiViewOnceEnabled,
  updateSettings,
  sessionTtlMs,
  DEFAULT_SETTINGS,
};

