/**
 * StarhubXbot — local-only commands & group automation
 * (no external APIs / paid servers required)
 */

const {
  state,
  updateSettings,
  isGroupJid,
  prettyPhoneFromJid,
  resolveName,
  upsertContact,
  upsertChat,
  persist,
} = require("./state");

function getSelfJid() {
  return state.selfJid;
}

async function replySelf(text) {
  const self = getSelfJid();
  if (!self || !state.sock) return;
  try {
    await state.sock.sendMessage(self, { text });
  } catch (_) {}
}

function uptimeStr() {
  const ms = Date.now() - (state.startedAt || Date.now());
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

const MENU_TEXT = `✦ *StarhubXbot* — command menu

*── Anti-delete ──*
• \`/antidelete on|off\` — all chat types
• \`/antidelete dm|group|community on|off\`
• \`/antidelete self|chat|both\` — where recovered msgs go
• \`/antidelete status\`

*── Auto anti view-once ──*
• \`/autoantiviewonce on|off\` — all types
• \`/autoantiviewonce dm|group|community on|off\`
• \`/autoantiviewonce self|chat|both\` — destination
• \`/autoantiviewonce status\`
• \`/vv\` — *reply* to a view-once to unlock manually

*── Groups ──*
• \`/welcome on|off\` · \`/goodbye on|off\`
• \`/setwelcome <text>\` · \`/setgoodbye <text>\`
• \`/antilink on|off\` · \`/antibadword on|off\`
• \`/tagall\` · \`/hidetag\` · \`/kick\` · \`/promote\` · \`/demote\`
• \`/groupinfo\`

*── Tools ──*
• \`/sticker\` · \`/toimg\` · \`/block\` · \`/unblock\`
• \`/jid\` · \`/bio <text>\`
• \`/ping\` · \`/runtime\` · \`/status\` · \`/menu\`

Public: anyone can send \`/bot\` for a short intro.

_StarhubXbot · web dashboard + WhatsApp_`;

function parseOnOff(s) {
  s = (s || "").toLowerCase();
  if (["on", "true", "1", "yes", "enable"].includes(s)) return true;
  if (["off", "false", "0", "no", "disable"].includes(s)) return false;
  return null;
}

async function handleSelfCommand(text, context = {}) {
  const raw = (text || "").trim();
  if (!raw.startsWith("/")) return false;
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();
  const sock = state.sock;
  const self = getSelfJid();
  if (!sock || !self) return false;
  const sourceMsg = context.m || null;

  const reply = async (t) => {
    try {
      const jid = sourceMsg?.key?.remoteJid || self;
      await sock.sendMessage(jid, { text: t });
    } catch (_) {}
  };

  // ── menu / basic ──
  if (cmd === "/menu" || cmd === "/help" || cmd === "/start") {
    await reply(MENU_TEXT);
    return true;
  }
  if (cmd === "/ping") {
    await reply("🏓 StarhubXbot online.");
    return true;
  }
  if (cmd === "/runtime" || cmd === "/uptime") {
    await reply(`⏱ Runtime: *${uptimeStr()}*`);
    return true;
  }
  if (cmd === "/status") {
    const s = state.settings;
    await reply(
      `*StarhubXbot status*\n` +
        `• WA: ${state.status}\n` +
        `• Runtime: ${uptimeStr()}\n` +
        `• Chats cached: ${state.chats.size}\n` +
        `• Messages cached: ${state.messages.length}\n` +
        `• Anti-delete DM/G/C: ${s.antidelete.dm ? "on" : "off"}/${s.antidelete.group ? "on" : "off"}/${s.antidelete.community ? "on" : "off"}\n` +
        `• Auto anti-view-once: DM ${s.antiViewOnce?.dm !== false ? "on" : "off"} / G ${s.antiViewOnce?.group !== false ? "on" : "off"} / C ${s.antiViewOnce?.community !== false ? "on" : "off"} (${s.viewOnceMode || "self"})\n` +
        `• Welcome/Goodbye: ${s.welcome ? "on" : "off"}/${s.goodbye ? "on" : "off"}\n` +
        `• Antilink/Antibadword: ${s.antilink ? "on" : "off"}/${s.antibadword ? "on" : "off"}`
    );
    return true;
  }

  // ── antidelete ──
  if (cmd === "/antidelete") {
    const a = (parts[1] || "").toLowerCase();
    const b = (parts[2] || "").toLowerCase();
    if (a === "self" || a === "m") {
      updateSettings({ antideleteMode: "self" });
      await reply("✅ Anti-delete copies → *Message Yourself*");
      return true;
    }
    if (a === "chat" || a === "v") {
      updateSettings({ antideleteMode: "chat" });
      await reply("✅ Anti-delete → *dashboard chat only*");
      return true;
    }
    if (a === "both") {
      updateSettings({ antideleteMode: "both" });
      await reply("✅ Anti-delete → *chat + Message Yourself*");
      return true;
    }
    if (a === "status" || !a) {
      const s = state.settings;
      await reply(
        `*Anti-delete*\n` +
          `DM: ${s.antidelete.dm ? "ON" : "OFF"}\n` +
          `Group: ${s.antidelete.group ? "ON" : "OFF"}\n` +
          `Community: ${s.antidelete.community ? "ON" : "OFF"}\n` +
          `Mode: ${s.antideleteMode || "both"}`
      );
      return true;
    }
    if (a === "on") {
      updateSettings({ antidelete: { dm: true, group: true, community: true } });
      await reply("✅ Anti-delete ON for all.");
      return true;
    }
    if (a === "off") {
      updateSettings({ antidelete: { dm: false, group: false, community: false } });
      await reply("✅ Anti-delete OFF for all.");
      return true;
    }
    if (["dm", "group", "community"].includes(a) && (b === "on" || b === "off")) {
      updateSettings({ antidelete: { [a]: b === "on" } });
      await reply(`✅ Anti-delete *${a}* → *${b.toUpperCase()}*`);
      return true;
    }
    await reply("Usage: /antidelete on|off|status|m|v|dm on|group on|community on");
    return true;
  }

  // ── auto anti view-once ──
  if (
    cmd === "/autoantiviewonce" ||
    cmd === "/antiviewonce" ||
    cmd === "/antivo" ||
    cmd === "/antivv"
  ) {
    const a = (parts[1] || "").toLowerCase();
    const b = (parts[2] || "").toLowerCase();
    if (a === "on" || a === "off") {
      const on = a === "on";
      updateSettings({ antiViewOnce: { dm: on, group: on, community: on } });
      await reply(`✅ Auto anti view-once *${a.toUpperCase()}* for DM / group / community`);
      return true;
    }
    if (["dm", "group", "community"].includes(a) && (b === "on" || b === "off")) {
      updateSettings({ antiViewOnce: { [a]: b === "on" } });
      await reply(`✅ Auto anti view-once *${a}* → *${b.toUpperCase()}*`);
      return true;
    }
    if (a === "self" || a === "m") {
      updateSettings({ viewOnceMode: "self" });
      await reply("✅ Unlocked view-once → *Message Yourself*");
      return true;
    }
    if (a === "chat" || a === "v") {
      updateSettings({ viewOnceMode: "chat" });
      await reply("✅ Unlocked view-once → *original chat*");
      return true;
    }
    if (a === "both") {
      updateSettings({ viewOnceMode: "both" });
      await reply("✅ Unlocked view-once → *chat + Message Yourself*");
      return true;
    }
    if (a === "status" || !a) {
      const s = state.settings;
      const av = s.antiViewOnce || {};
      const dest =
        s.viewOnceMode === "chat"
          ? "original chat"
          : s.viewOnceMode === "both"
            ? "chat + Message Yourself"
            : "Message Yourself";
      await reply(
        `*Auto anti view-once*\n` +
          `• DM: ${av.dm !== false ? "ON" : "OFF"}\n` +
          `• Group: ${av.group !== false ? "ON" : "OFF"}\n` +
          `• Community: ${av.community !== false ? "ON" : "OFF"}\n` +
          `• Destination: ${dest}\n` +
          `• Manual: reply with \`/vv\``
      );
      return true;
    }
    await reply(
      "Usage: /autoantiviewonce on|off|status|self|chat|both|dm on|group on|community on"
    );
    return true;
  }

  // ── /vv — reply to view-once to unlock manually (silent to the original sender) ──
  if (cmd === "/vv" || cmd === "/viewonce" || cmd === "/readvo") {
    if (!sourceMsg) {
      // Feedback only to Message Yourself — never to the other party
      try {
        await sock.sendMessage(self, {
          text: "Reply to a view-once message with `/vv` (in that chat), then check Message Yourself / the dashboard.",
        });
      } catch (_) {}
      return true;
    }
    try {
      const { unlockViewOnceFromMessage } = require("./bot");
      // Always unlock once: dashboard + optional Message Yourself.
      // Never re-send unlocked media into the chat with the sender.
      const result = await unlockViewOnceFromMessage(sourceMsg, {
        silent: true,
        toSelf: state.settings.viewOnceMode !== "chat",
      });
      if (result?.deduped) return true;
      const dest =
        state.settings.viewOnceMode === "chat"
          ? "dashboard chat"
          : state.settings.viewOnceMode === "both"
            ? "dashboard + Message Yourself"
            : "Message Yourself";
      try {
        await sock.sendMessage(self, {
          text: `✅ View-once unlocked (${result.kind}) → ${dest}`,
        });
      } catch (_) {}
    } catch (err) {
      try {
        await sock.sendMessage(self, { text: "❌ " + (err.message || err) });
      } catch (_) {}
    }
    return true;
  }

  // ── welcome / goodbye ──
  if (cmd === "/welcome") {
    const v = parseOnOff(parts[1]);
    if (v === null) {
      await reply(`Welcome is *${state.settings.welcome ? "ON" : "OFF"}*\n${state.settings.welcomeMsg}`);
      return true;
    }
    updateSettings({ welcome: v });
    await reply(`✅ Welcome ${v ? "ON" : "OFF"}`);
    return true;
  }
  if (cmd === "/goodbye") {
    const v = parseOnOff(parts[1]);
    if (v === null) {
      await reply(`Goodbye is *${state.settings.goodbye ? "ON" : "OFF"}*\n${state.settings.goodbyeMsg}`);
      return true;
    }
    updateSettings({ goodbye: v });
    await reply(`✅ Goodbye ${v ? "ON" : "OFF"}`);
    return true;
  }
  if (cmd === "/setwelcome") {
    if (!arg) {
      await reply("Usage: /setwelcome Welcome @user to {group}!");
      return true;
    }
    updateSettings({ welcomeMsg: arg });
    await reply("✅ Welcome message saved.");
    return true;
  }
  if (cmd === "/setgoodbye") {
    if (!arg) {
      await reply("Usage: /setgoodbye Goodbye @user");
      return true;
    }
    updateSettings({ goodbyeMsg: arg });
    await reply("✅ Goodbye message saved.");
    return true;
  }

  // ── antilink / antibadword ──
  if (cmd === "/antilink") {
    const v = parseOnOff(parts[1]);
    if (v === null) {
      await reply(`Antilink is *${state.settings.antilink ? "ON" : "OFF"}* (bot must be group admin).`);
      return true;
    }
    updateSettings({ antilink: v });
    await reply(`✅ Antilink ${v ? "ON" : "OFF"}`);
    return true;
  }
  if (cmd === "/antibadword") {
    const v = parseOnOff(parts[1]);
    if (v === null) {
      await reply(`Antibadword is *${state.settings.antibadword ? "ON" : "OFF"}*`);
      return true;
    }
    updateSettings({ antibadword: v });
    await reply(`✅ Antibadword ${v ? "ON" : "OFF"}`);
    return true;
  }
  if (cmd === "/addbadword") {
    if (!arg) {
      await reply("Usage: /addbadword word");
      return true;
    }
    const words = arg.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const set = new Set([...(state.settings.badwords || []), ...words]);
    updateSettings({ badwords: [...set] });
    await reply(`✅ Added: ${words.join(", ")}`);
    return true;
  }
  if (cmd === "/delbadword") {
    if (!arg) {
      await reply("Usage: /delbadword word");
      return true;
    }
    const remove = new Set(arg.toLowerCase().split(/[\s,]+/).filter(Boolean));
    updateSettings({
      badwords: (state.settings.badwords || []).filter((w) => !remove.has(w)),
    });
    await reply(`✅ Removed: ${[...remove].join(", ")}`);
    return true;
  }
  if (cmd === "/listbadword") {
    const list = state.settings.badwords || [];
    await reply(list.length ? `Bad words:\n${list.map((w) => "• " + w).join("\n")}` : "No bad words set.");
    return true;
  }

  // ── bio ──
  if (cmd === "/bio") {
    if (!arg) {
      await reply("Usage: /bio Your new about text");
      return true;
    }
    try {
      await sock.updateProfileStatus(arg);
      await reply("✅ About updated.");
    } catch (e) {
      await reply("Failed: " + e.message);
    }
    return true;
  }

  // ── jid ──
  if (cmd === "/jid") {
    await reply(`Self JID:\n\`\`\`${self}\`\`\``);
    return true;
  }

  // ── block / unblock by number ──
  if (cmd === "/block" || cmd === "/unblock") {
    let target = arg.replace(/[^\d@.]/g, "");
    if (target && !target.includes("@")) target = target + "@s.whatsapp.net";
    if (!target) {
      await reply(`Usage: ${cmd} 2547...`);
      return true;
    }
    try {
      if (cmd === "/block") {
        await sock.updateBlockStatus(target, "block");
        await reply(`✅ Blocked ${target}`);
      } else {
        await sock.updateBlockStatus(target, "unblock");
        await reply(`✅ Unblocked ${target}`);
      }
    } catch (e) {
      await reply("Failed: " + e.message);
    }
    return true;
  }

  // Commands that need a group context (tagall etc.) are handled when
  // sent *inside* a group — see handleGroupCommand.

  return false;
}

/** Commands used inside groups (owner/self messages). */
async function handleGroupCommand(m, text) {
  const raw = (text || "").trim();
  if (!raw.startsWith("/")) return false;
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ").trim();
  const sock = state.sock;
  const chatJid = m.key.remoteJid;
  if (!sock || !isGroupJid(chatJid)) return false;

  // Only the linked account (fromMe) may run admin tools
  if (!m.key.fromMe) return false;

  const reply = async (t) => {
    try {
      await sock.sendMessage(chatJid, { text: t }, { quoted: m });
    } catch (_) {}
  };

  if (cmd === "/groupinfo") {
    try {
      const meta = await sock.groupMetadata(chatJid);
      await reply(
        `*${meta.subject}*\n` +
          `ID: \`${meta.id}\`\n` +
          `Members: ${meta.participants?.length || 0}\n` +
          `Created: ${meta.creation ? new Date(meta.creation * 1000).toLocaleString() : "?"}`
      );
    } catch (e) {
      await reply("Failed: " + e.message);
    }
    return true;
  }

  if (cmd === "/tagall" || cmd === "/hidetag") {
    try {
      const meta = await sock.groupMetadata(chatJid);
      const parts = meta.participants || [];
      const mentions = parts.map((p) => p.id);
      const hide = cmd === "/hidetag";
      const body =
        (arg || "Hello everyone") +
        (hide ? "" : "\n\n" + mentions.map((j) => "@" + j.split("@")[0]).join(" "));
      await sock.sendMessage(chatJid, { text: body, mentions });
    } catch (e) {
      await reply("Failed (need admin?): " + e.message);
    }
    return true;
  }

  if (cmd === "/kick" || cmd === "/promote" || cmd === "/demote") {
    const target =
      m.message?.extendedTextMessage?.contextInfo?.participant ||
      m.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
    if (!target) {
      await reply(`Reply to a user (or @mention) with ${cmd}`);
      return true;
    }
    try {
      if (cmd === "/kick") {
        await sock.groupParticipantsUpdate(chatJid, [target], "remove");
        await reply("✅ Removed.");
      } else if (cmd === "/promote") {
        await sock.groupParticipantsUpdate(chatJid, [target], "promote");
        await reply("✅ Promoted.");
      } else {
        await sock.groupParticipantsUpdate(chatJid, [target], "demote");
        await reply("✅ Demoted.");
      }
    } catch (e) {
      await reply("Failed (bot must be admin): " + e.message);
    }
    return true;
  }

  if (cmd === "/sticker" || cmd === "/s") {
    // Handled in bot.js with media download — signal intent
    return false;
  }

  return false;
}

const LINK_RE = /https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\//i;

async function applyGroupFilters(m, text) {
  const sock = state.sock;
  const chatJid = m.key.remoteJid;
  if (!sock || !isGroupJid(chatJid) || m.key.fromMe) return;

  // antilink
  if (state.settings.antilink && text && LINK_RE.test(text)) {
    try {
      await sock.sendMessage(chatJid, { delete: m.key });
      await sock.sendMessage(chatJid, {
        text: `🔗 Link removed (@${(m.key.participant || "").split("@")[0]})`,
        mentions: m.key.participant ? [m.key.participant] : [],
      });
    } catch (_) {}
    return;
  }

  // antibadword
  if (state.settings.antibadword && text && (state.settings.badwords || []).length) {
    const lower = text.toLowerCase();
    const hit = state.settings.badwords.find((w) => w && lower.includes(w));
    if (hit) {
      try {
        await sock.sendMessage(chatJid, { delete: m.key });
      } catch (_) {}
    }
  }
}

function formatWelcome(template, userJid, groupName) {
  const num = (userJid || "").split("@")[0];
  return String(template || "")
    .replace(/@user/gi, "@" + num)
    .replace(/\{group\}/gi, groupName || "group");
}

function registerGroupHooks(sock) {
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const { id, participants, action } = update;
      if (!id || !participants?.length) return;
      let subject = resolveName(id) || id;
      try {
        const meta = await sock.groupMetadata(id);
        subject = meta.subject || subject;
        upsertChat(id, { name: subject, kind: "group", participantsCount: meta.participants?.length });
      } catch (_) {}

      if (action === "add" && state.settings.welcome) {
        for (const p of participants) {
          const text = formatWelcome(state.settings.welcomeMsg, p, subject);
          await sock.sendMessage(id, { text, mentions: [p] });
        }
      }
      if ((action === "remove" || action === "leave") && state.settings.goodbye) {
        for (const p of participants) {
          const text = formatWelcome(state.settings.goodbyeMsg, p, subject);
          await sock.sendMessage(id, { text, mentions: [p] });
        }
      }
    } catch (_) {}
  });
}

module.exports = {
  MENU_TEXT,
  handleSelfCommand,
  handleGroupCommand,
  applyGroupFilters,
  registerGroupHooks,
  replySelf,
};
