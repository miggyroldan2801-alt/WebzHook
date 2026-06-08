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
   - Guild Messages

### 2. Set Up OAuth2 (for Dashboard)

1. In Developer Portal, go to "OAuth2" → "General"
2. Copy **Client ID** → `.env` as `DISCORD_CLIENT_ID`
3. Copy **Client Secret** → `.env` as `DISCORD_CLIENT_SECRET`
4. Go to "OAuth2" → "Redirects"
5. Add redirect URI:
   - Local: `http://localhost:3000/auth/callback`
   - Production: `https://yourdomain.com/auth/callback`

### 3. Environment Variables

Copy `.env.example` to `.env` and fill in:

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

**Local access:** `http://localhost:3000`  
**Dashboard:** `http://localhost:3000/dashboard`

## Deployment on Railway

### Step 1: Push to GitHub

```bash
git add .
git commit -m "add: web dashboard"
git push
```

### Step 2: Deploy on Railway

1. Go to [Railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub"
3. Select your repo
4. In **Variables** tab, add:
   - `DISCORD_TOKEN` — Your bot token
   - `DISCORD_CLIENT_ID` — OAuth Client ID
   - `DISCORD_CLIENT_SECRET` — OAuth Client Secret
   - `DISCORD_REDIRECT_URI` — `https://your-railway-domain.up.railway.app/auth/callback`
   - `SESSION_SECRET` — Random secure key
   - `PORT` — 3000 (or let Railway set it)

### Step 3: Configure Bot Invite

Replace `YOUR_CLIENT_ID` in `public/index.html`:

```html
<a href="https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=8">
```

## First Time Setup in Discord

1. Run `%setup` in any channel → Creates roles & log channel
2. Run `%enable` → Activates the bot
3. Assign "Bot Manager" role to your moderators
4. Run `%help` to see all commands

## Commands

### 🔨 Moderation
- `%ban @user [reason]`
- `%kick @user [reason]`
- `%mute @user [duration]`
- `%warn @user <reason>`
- `%purge <1-100>`

### 🛡️ Security
- `%quarantine @user`
- `%lockdown [reason]`
- `%lock` / `%unlock`
- `%slowmode <seconds>`

### 📋 Settings
- `%setup` — Auto-create roles & channels
- `%enable` / `%disable` — Toggle bot
- `%setlog #channel` — Set log channel
- `%toggle <feature>` — Toggle anti-spam, anti-raid, etc.

### 📖 Info
- `%help` — Show all commands
- `%userinfo [@user]`
- `%serverinfo`
- `%status`

## Configuration

Edit `config.js` to customize:

```javascript
MASS_PING_THRESHOLD: 5,        // mentions to trigger
SPAM_MESSAGE_LIMIT: 5,         // messages before mute
RAID_JOIN_LIMIT: 10,           // joins = raid
CAPS_PERCENT: 80,              // % caps to block
```

## Support

For issues or questions:
- Run `%help` in Discord
- Check logs in your log channel
- Review `.env` variables

---

**WebzHook Guard** — Secure your Discord community with confidence.