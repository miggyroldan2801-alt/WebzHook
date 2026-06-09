# 🛡️ WebzHook Guard v2.0

A powerful Discord moderation, security, and anti-abuse bot with a complete web dashboard.

## Features

✅ **Moderation** — Ban, kick, mute, warn, purge, slowmode, lockdown  
✅ **Anti-Raid** — Automatic detection and server lockdown  
✅ **Anti-Nuke** — Prevent mass channel/role deletion  
✅ **Anti-Spam** — Auto-mute spammers and duplicate messages  
✅ **Verification** — Button-based and captcha verification  
✅ **Webhooks** — Delete webhooks performing mass pings  
✅ **Logging** — Full audit trail of all actions  
✅ **Web Dashboard** — Manage settings from a sleek interface  
✅ **50+ Commands** — Full moderation toolkit  

## Setup

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to "Bot" tab → "Add Bot"
4. Copy the **Bot Token** and paste into `.env` as `DISCORD_TOKEN`
5. Enable these **Intents**:
   - Server Members Intent
   - Message Content Intent
   - Guild Members Intent

### 2. Set Up OAuth2 (for Dashboard)

1. In Developer Portal, go to "OAuth2" → "General"
2. Copy **Client ID** → `.env` as `DISCORD_CLIENT_ID`
3. Copy **Client Secret** → `.env` as `DISCORD_CLIENT_SECRET`
4. Go to "OAuth2" → "Redirects"
5. Add redirect URI: `http://localhost:3000/auth/callback`

### 3. Environment Variables

Create `.env`:

```env
DISCORD_TOKEN=your_token_here
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_CLIENT_SECRET=your_client_secret_here
DISCORD_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=generate-random-key-here
PORT=3000
```

### 4. Install & Run

```bash
npm install
npm start
```

**Access:** `http://localhost:3000`

## Deployment

See `DEPLOYMENT_GUIDE.md` for Railway deployment instructions.

## Commands

Run `%help` in Discord to see all commands. **75+ total.**

## Support

- `%help` in Discord
- Support server from dashboard
- Check logs in designated channel

---

**WebzHook Guard v2.0** — Enterprise Discord Security