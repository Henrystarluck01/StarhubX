# StarhubXbot

Local WhatsApp multi-device companion (Baileys) — **no external feature servers**.

## Run

```bash
cp .env.example .env
node index.js          # menu: bot only / bot + web
# or: node index.js --bot | --web
```

## Features (all local)

| Feature | How |
|--------|-----|
| Anti-delete | Auto-keep deleted msgs; `/antidelete on\|off\|m\|v\|status` |
| Anti view-once | Save view-once media to disk + dashboard; modes **self** / **chat** |
| Full media | Images, videos, voice notes, docs downloaded fully then displayed |
| Welcome / goodbye | `/welcome on` · `/setwelcome Hi @user — {group}` |
| Antilink | `/antilink on` (bot must be group admin) |
| Antibadword | `/addbadword x` · `/antibadword on` |
| Group tools | `/tagall` `/hidetag` `/kick` `/promote` `/demote` `/groupinfo` (in group, as you) |
| Block | `/block 2547...` |
| Bio | `/bio text` |
| Status / ping | `/status` `/ping` `/runtime` |
| Web dashboard | Chats, media, settings, session length |

Send `/menu` to **Message Yourself** after linking.

## Not included (need external APIs)

YouTube/TikTok downloaders, AI image gen, sports APIs, cloud AI chats — those require third-party servers/keys  (third-party services). This bot stays fully local.
