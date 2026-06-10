require('dotenv').config();
const express = require('express');
const path = require('path');
const axios = require('axios');
const session = require('express-session');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/callback';

// ━━━ INLINE EMBEDDED DATABASE SYSTEM ━━━
const DB_FILE = path.join(__dirname, 'database.json');
let localDatabase = {};

function loadDatabase() {
  try {
    if (fs.existsSync(DB_FILE)) {
      localDatabase = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('⚠️ Error reading database.json storage file:', err);
  }
}

function saveDatabase() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(localDatabase, null, 2));
  } catch (err) {
    console.error('⚠️ Error writing to database.json storage file:', err);
  }
}

function getGuildSettings(guildId) {
  loadDatabase();
  if (!localDatabase[guildId]) {
    localDatabase[guildId] = {
      enabled: true,
      detectionEnabled: true,
      modules: { antiSpam: false, antiRaid: false, antiMassPing: false, antiCaps: false, antiDuplicate: false, antiNuke: false },
      customCommands: [],
      funCommands: [],
      responses: {}
    };
    saveDatabase();
  }
  return localDatabase[guildId];
}

function saveGuildSettings(guildId, settings) {
  localDatabase[guildId] = settings;
  saveDatabase();
}

// Initial Database Initialization Check
loadDatabase();

// MIDDLEWARE
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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

// ━━━ USER & GUILD API ━━━
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
    settings: getGuildSettings(g.id),
  }));
  res.json(enriched);
});

app.get('/api/guild/:guildId', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'Access denied' });
  const settings = getGuildSettings(req.params.guildId);
  res.json({ guild, settings });
});

// ━━━ MODULES API ━━━
app.get('/api/guild/:guildId/modules', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'Access denied' });
  const settings = getGuildSettings(req.params.guildId);
  res.json({
    modules: settings.modules,
    detectionEnabled: settings.detectionEnabled,
    enabled: settings.enabled,
  });
});

app.post('/api/guild/:guildId/module/:moduleName', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const { value } = req.body;
  const settings = getGuildSettings(req.params.guildId);
  if (settings.modules.hasOwnProperty(req.params.moduleName)) {
    settings.modules[req.params.moduleName] = value;
    saveGuildSettings(req.params.guildId, settings);
    res.json({ success: true, modules: settings.modules });
  } else {
    res.status(400).json({ error: 'Invalid module' });
  }
});

// ━━━ CUSTOM COMMANDS API ━━━
app.get('/api/guild/:guildId/custom-commands', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'Access denied' });
  const commands = getGuildSettings(req.params.guildId).customCommands || [];
  res.json(commands);
});

app.post('/api/guild/:guildId/custom-commands', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const { name, code, description } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'Missing fields' });

  const settings = getGuildSettings(req.params.guildId);
  if (!settings.customCommands) settings.customCommands = [];
  
  const command = {
    id: Date.now().toString(),
    name,
    code,
    description: description || '',
    createdAt: new Date().toISOString(),
    enabled: true,
  };
  
  settings.customCommands.push(command);
  saveGuildSettings(req.params.guildId, settings);
  res.json({ success: true, command });
});

app.put('/api/guild/:guildId/custom-commands/:commandId', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const { code, description, enabled } = req.body;
  const settings = getGuildSettings(req.params.guildId);
  const cmd = settings.customCommands.find(c => c.id === req.params.commandId);
  
  if (!cmd) return res.status(404).json({ error: 'Command not found' });
  
  if (code) cmd.code = code;
  if (description !== undefined) cmd.description = description;
  if (enabled !== undefined) cmd.enabled = enabled;
  
  saveGuildSettings(req.params.guildId, settings);
  res.json({ success: true, command: cmd });
});

app.delete('/api/guild/:guildId/custom-commands/:commandId', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const settings = getGuildSettings(req.params.guildId);
  settings.customCommands = settings.customCommands.filter(c => c.id !== req.params.commandId);
  saveGuildSettings(req.params.guildId, settings);
  res.json({ success: true });
});

// ━━━ FUN COMMANDS API ━━━
app.get('/api/guild/:guildId/fun-commands', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'Access denied' });
  const commands = getGuildSettings(req.params.guildId).funCommands || [];
  res.json(commands);
});

app.post('/api/guild/:guildId/fun-commands', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const { name, responses, type } = req.body;
  if (!name || !responses || responses.length === 0) return res.status(400).json({ error: 'Missing fields' });

  const settings = getGuildSettings(req.params.guildId);
  if (!settings.funCommands) settings.funCommands = [];
  
  const command = {
    id: Date.now().toString(),
    name,
    responses,
    type: type || 'random',
    createdAt: new Date().toISOString(),
    enabled: true,
  };
  
  settings.funCommands.push(command);
  saveGuildSettings(req.params.guildId, settings);
  res.json({ success: true, command });
});

app.delete('/api/guild/:guildId/fun-commands/:commandId', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const settings = getGuildSettings(req.params.guildId);
  settings.funCommands = settings.funCommands.filter(c => c.id !== req.params.commandId);
  saveGuildSettings(req.params.guildId, settings);
  res.json({ success: true });
});

// ━━━ RESPONSES API ━━━
app.get('/api/guild/:guildId/responses', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'Access denied' });
  const responses = getGuildSettings(req.params.guildId).responses || {};
  res.json(responses);
});

app.post('/api/guild/:guildId/responses/:trigger', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const { response } = req.body;
  if (!response) return res.status(400).json({ error: 'Missing response' });

  const settings = getGuildSettings(req.params.guildId);
  settings.responses[req.params.trigger] = response;
  saveGuildSettings(req.params.guildId, settings);
  res.json({ success: true, responses: settings.responses });
});

app.delete('/api/guild/:guildId/responses/:trigger', ensureAuth, (req, res) => {
  const guild = req.session.user.guilds.find(g => g.id === req.params.guildId);
  if (!guild || (!guild.owner && !(guild.permissions & 8))) return res.status(403).json({ error: 'Access denied' });

  const settings = getGuildSettings(req.params.guildId);
  delete settings.responses[req.params.trigger];
  saveGuildSettings(req.params.guildId, settings);
  res.json({ success: true, responses: settings.responses });
});

// ━━━ PAGES ━━━
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});
app.get('/guild/:guildId', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'guild-settings.html'));
});

// ━━━ START DASHBOARD SERVER ━━━
app.listen(PORT, () => {
  console.log(`🌐 Dashboard Interface live on port ${PORT}`);
});