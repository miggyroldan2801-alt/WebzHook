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

// MIDDLEWARE
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

// AUTH MIDDLEWARE
async function ensureAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// DISCORD OAUTH
app.get('/auth/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?error=no_code');

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
      guilds: guildsRes.data.filter(g => g.owner || (g.permissions & 8) === 8),
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

// API ROUTES
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
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const { key, value } = req.body;
  const allowedKeys = ['antiSpam', 'antiRaid', 'antiMassPing', 'antiCaps', 'antiDuplicate', 'antiNuke', 'detectionEnabled'];
  if (!allowedKeys.includes(key)) return res.status(400).json({ error: 'Invalid key' });

  const settings = db.getGuild(req.params.guildId);
  settings[key] = value;
  db.saveGuild(req.params.guildId, settings);
  res.json({ success: true, settings });
});

// CUSTOM COMMANDS API
app.get('/api/custom-commands', ensureAuth, (req, res) => {
  const guildId = req.query.guildId;
  if (guildId) {
    const guild = req.session.user.guilds.find(g => g.id === guildId);
    if (!guild) return res.status(403).json({ error: 'Access denied' });
    const commands = db.getGuild(guildId).customCommands || [];
    return res.json(commands);
  }
  res.json([]);
});

app.post('/api/custom-commands', ensureAuth, (req, res) => {
  const { name, response, triggers, guildId } = req.body;
  if (!name || !response) return res.status(400).json({ error: 'Missing fields' });

  if (guildId) {
    const guild = req.session.user.guilds.find(g => g.id === guildId);
    if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

    const settings = db.getGuild(guildId);
    if (!settings.customCommands) settings.customCommands = [];
    settings.customCommands.push({ name, response, triggers: triggers || [], createdAt: new Date().toISOString() });
    db.saveGuild(guildId, settings);
    return res.json({ success: true, command: settings.customCommands[settings.customCommands.length - 1] });
  }

  res.status(400).json({ error: 'GuildId required' });
});

app.delete('/api/custom-commands/:name', ensureAuth, (req, res) => {
  const guildId = req.query.guildId;
  if (!guildId) return res.status(400).json({ error: 'GuildId required' });

  const guild = req.session.user.guilds.find(g => g.id === guildId);
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const settings = db.getGuild(guildId);
  settings.customCommands = (settings.customCommands || []).filter(c => c.name !== req.params.name);
  db.saveGuild(guildId, settings);
  res.json({ success: true });
});

// PAGES
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/guild/:guildId', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'guild-settings.html'));
});

// START
app.listen(PORT, () => console.log(`🌐 Dashboard: http://localhost:${PORT}`));