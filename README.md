<div align="center">

# ⚡ StarHubX Bot

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=24&duration=3000&pause=800&color=00E5FF&center=true&vCenter=true&width=720&lines=WhatsApp+Multi-Device+Companion;Pair+%E2%80%A2+Automate+%E2%80%A2+Moderate+%E2%80%A2+Unlock+Media" alt="typing" />

<br/>

<img src="https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" />
<img src="https://img.shields.io/badge/Baileys-7.x-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" />
<img src="https://img.shields.io/badge/License-Private-8A2BE2?style=for-the-badge" />

<br/><br/>

**🔗 Pair once · 🤖 Run commands · 👁 Unlock view-once · 🛡️ Anti-delete · 👥 Group tools**

</div>

---

## 🚀 Deploy

### Requirements

- **Node.js 18+**
- WhatsApp account (multi-device)
- Prefer a **home / residential network** for the first link (VPS IPs often fail pairing)

### Install

```bash
git clone https://github.com/StarhubX/StarhubX_bot.git
cd StarhubX_bot
npm install
```

### Run

```bash
# Bot only (recommended first link)
node index.js --bot

# Bot + local web dashboard
node index.js --web
```

Or:

```bash
npm start
```

### Pair WhatsApp

1. Choose **`1`** (Bot only) when asked  
2. Enter number: **country code + digits only**  
   Example: `254712345678` (no `+`, no spaces)  
3. Confirm `→ Using number: …`  
4. On phone: **WhatsApp → Linked devices → Link a device → Link with phone number instead**  
5. Enter the **8-digit code** within ~1 minute  

```text
╔════════════════════════════════╗
║     STARHUBX  ·  PAIRING                    ||
║                                                ||
║     Enter code on your phone                 ║
╚════════════════════════════════╝
```

If linking fails:

```bash
rm -rf auth
node index.js --bot
```

> **Tip:** Link on a normal network, then copy the `auth/` folder to a VPS if you host there.

---

## ✨ Functionality

| Area | What it does |
|------|----------------|
| **🔗 Connection** | Pairing-code login, auto-reconnect, session in `auth/` |
| **👁 View-once** | Auto-unlock when media arrives · `/vv` when only a stub is sent |
| **🗑️ Anti-delete** | Saves deleted messages (text / media) to Message Yourself or chat |
| **👋 Welcome** | Welcome / goodbye messages in groups |
| **🔗 Antilink** | Removes or warns on unwanted links |
| **🚫 Antibadword** | Filters configured bad words |
| **👥 Group admin** | Tag, kick, promote, demote |
| **📊 Status** | Runtime, ping, bot status |
| **🖥️ Dashboard** | Optional local web UI (`--web`) |

---

## ⌨️ Commands

Send commands in **Message Yourself** or as the linked account (owner).

### Core

| Command | Description |
|---------|-------------|
| `/menu` | Full command menu |
| `/status` | Connection & settings |
| `/ping` | Latency check |
| `/runtime` | Uptime |

### View-once

| Command | Description |
|---------|-------------|
| `/autoantiviewonce on` | Enable auto unlock |
| `/autoantiviewonce off` | Disable auto unlock |
| `/autoantiviewonce status` | Show current mode |
| `/vv` | Reply to a view-once bubble to unlock manually |

>**Autoshowviewonce still under development , if can help with the baileys issue then i welcome your support `/vv`.

### Anti-delete & groups

| Command | Description |
|---------|-------------|
| `/antidelete` | Toggle anti-delete |
| `/welcome` | Toggle welcome |
| `/setwelcome` | Set welcome text |
| `/goodbye` | Toggle goodbye |
| `/antilink` | Toggle antilink |
| `/antibadword` | Toggle bad-word filter |
| `/tagall` | Mention all members |
| `/hidetag` | Hidden tag (broadcast) |
| `/kick` | Remove member |
| `/promote` | Make admin |
| `/demote` | Remove admin |

Exact flags (`on` / `off` / `status`) follow the menu printed by `/menu`.

---
```gitignore
node_modules/
auth/
data/
.env
*.log
```

---

## ☁️ Optional dashboard tunnel

With `node index.js --web`, then:

```bash
cloudflared tunnel --url http://localhost:PORT
```

Use the port printed in the terminal.

---

<div align="center">

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=18&duration=2500&pause=1000&color=8A2BE2&center=true&vCenter=true&width=560&lines=Deploy+%E2%80%A2+Pair+%E2%80%A2+Command+%E2%80%A2+Automate;Built+with+Baileys+%2B+Node.js" alt="footer" />

<br/>

**⚡ StarHubX** · WhatsApp automation 

</div>

