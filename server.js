require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const db = require('./database');
const config = require('./config');

const app = express();
const PORT = process.env.PORT || 3000;

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/callback';

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
}));

// ─── AUTH MIDDLEWARE ────────────────────────────────────────────────────────
async function ensureAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── DISCORD OAUTH ROUTES ───────────────────────────────────────────────────

app.get('/auth/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/');

  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', {
      client_id: DISCORD_CLIENT_ID,
      client_secret: DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: DISCORD_REDIRECT_URI,
    });

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });

    const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
    });

    req.session.user = {
      id: userRes.data.id,
      username: userRes.data.username,
      avatar: userRes.data.avatar,
      discriminator: userRes.data.discriminator,
      guilds: guildsRes.data,
      accessToken: tokenRes.data.access_token,
    };

    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ─── API ROUTES ─────────────────────────────────────────────────────────────

app.get('/api/user', ensureAuth, (req, res) => {
  res.json(req.session.user);
});

app.get('/api/guilds', ensureAuth, (req, res) => {
  const userGuilds = req.session.user.guilds;
  const enriched = userGuilds.map(g => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    owner: g.owner,
    settings: db.getGuild(g.id),
  }));
  res.json(enriched);
});

app.get('/api/guild/:guildId', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'Access denied' });
  res.json({ guild, settings: db.getGuild(req.params.guildId) });
});

app.post('/api/guild/:guildId/settings', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || !guild.owner) return res.status(403).json({ error: 'Only server owner can change settings' });

  const { key, value } = req.body;
  const allowedKeys = ['antiSpam', 'antiRaid', 'antiMassPing', 'antiCaps', 'antiDuplicate', 'antiNuke', 'detectionEnabled'];
  if (!allowedKeys.includes(key)) return res.status(400).json({ error: 'Invalid key' });

  const settings = db.getGuild(req.params.guildId);
  settings[key] = value;
  db.saveGuild(req.params.guildId, settings);
  res.json({ success: true, settings });
});

app.get('/api/guild/:guildId/logs', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || !guild.owner) return res.status(403).json({ error: 'Access denied' });

  // Return last 50 actions from memory (in production, store in DB)
  res.json({ logs: [] }); // Placeholder for now
});

app.post('/api/invite', (req, res) => {
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&scope=bot&permissions=8`;
  res.json({ inviteUrl });
});

// ─── PAGE ROUTES ────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/guild/:guildId', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'guild-settings.html'));
});

// ─── START SERVER ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`🌐 Dashboard running on http://localhost:${PORT}`);
});