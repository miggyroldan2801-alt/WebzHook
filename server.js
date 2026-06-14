require('dotenv').config();
const express = require('express');
const path    = require('path');
const axios   = require('axios');
const session = require('express-session');
const db      = require('./database');

const app  = express();
const PORT = process.env.PORT || 3000;
const CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI  = process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'webzhook-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, secure: false },
}));

// ── Auth guard ───────────────────────────────────────────────────────────────
const auth = (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
const guildAuth = (req, res, next) => {
  const guild = req.session.user?.guilds?.find(g => g.id === req.params.guildId);
  if (!guild) return res.status(403).json({ error: 'Forbidden' });
  const isAdmin = guild.owner || (guild.permissions & 8) === 8 || (guild.permissions & 32) === 32;
  if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });
  req.guild = guild;
  next();
};

// ── OAuth ────────────────────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  if (!req.query.code) return res.redirect('/?error=no_code');
  try {
    const tok = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code', code: req.query.code, redirect_uri: REDIRECT_URI,
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const [userRes, guildsRes] = await Promise.all([
      axios.get('https://discord.com/api/users/@me',        { headers: { Authorization: `Bearer ${tok.data.access_token}` } }),
      axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${tok.data.access_token}` } }),
    ]);

    req.session.user = {
      id:            userRes.data.id,
      username:      userRes.data.username,
      globalName:    userRes.data.global_name || userRes.data.username,
      avatar:        userRes.data.avatar,
      discriminator: userRes.data.discriminator,
      guilds: guildsRes.data.filter(g => g.owner || (g.permissions & 8) === 8 || (g.permissions & 32) === 32),
    };
    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

// ── API — User ───────────────────────────────────────────────────────────────
app.get('/api/me', auth, (req, res) => res.json(req.session.user));

app.get('/api/guilds', auth, (req, res) => {
  const guilds = req.session.user.guilds.map(g => ({
    id: g.id, name: g.name, icon: g.icon, owner: g.owner,
    botPresent: true, // assume bot is in all listed guilds (they come from dashboard)
    settings: db.getGuild(g.id),
  }));
  res.json(guilds);
});

// ── API — Guild settings ─────────────────────────────────────────────────────
app.get('/api/guilds/:guildId', auth, guildAuth, (req, res) => {
  res.json({ guild: req.guild, settings: db.getGuild(req.params.guildId) });
});

app.patch('/api/guilds/:guildId/settings', auth, guildAuth, (req, res) => {
  const s = db.getGuild(req.params.guildId);
  const allowed = ['enabled','detectionEnabled','logChannelId','welcomeChannelId','welcomeMessage',
    'leaveChannelId','leaveMessage','verifyMode','verifyMessage','prefix',
    'maxRolePosition','autoRoles','badwords'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) s[key] = req.body[key];
  }
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true, settings: s });
});

// ── API — Modules ─────────────────────────────────────────────────────────────
app.get('/api/guilds/:guildId/modules', auth, guildAuth, (req, res) => {
  res.json(db.getGuild(req.params.guildId).modules);
});

app.patch('/api/guilds/:guildId/modules', auth, guildAuth, (req, res) => {
  const s = db.getGuild(req.params.guildId);
  for (const [k, v] of Object.entries(req.body)) {
    if (s.modules.hasOwnProperty(k)) s.modules[k] = !!v;
  }
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true, modules: s.modules });
});

app.patch('/api/guilds/:guildId/thresholds', auth, guildAuth, (req, res) => {
  const s = db.getGuild(req.params.guildId);
  for (const [k, v] of Object.entries(req.body)) {
    if (s.thresholds.hasOwnProperty(k)) s.thresholds[k] = Number(v);
  }
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true, thresholds: s.thresholds });
});

// ── API — Custom commands ────────────────────────────────────────────────────
app.get('/api/guilds/:guildId/commands', auth, guildAuth, (req, res) => {
  res.json(db.getGuild(req.params.guildId).customCommands || []);
});

app.post('/api/guilds/:guildId/commands', auth, guildAuth, (req, res) => {
  const { name, code, description } = req.body;
  if (!name || !code) return res.status(400).json({ error: 'name and code required' });
  const s = db.getGuild(req.params.guildId);
  const cmd = { id: Date.now().toString(), name, code, description: description||'', enabled: true, createdAt: new Date().toISOString() };
  s.customCommands.push(cmd);
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true, command: cmd });
});

app.put('/api/guilds/:guildId/commands/:cmdId', auth, guildAuth, (req, res) => {
  const s   = db.getGuild(req.params.guildId);
  const idx = s.customCommands.findIndex(c => c.id === req.params.cmdId);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  s.customCommands[idx] = { ...s.customCommands[idx], ...req.body };
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true, command: s.customCommands[idx] });
});

app.delete('/api/guilds/:guildId/commands/:cmdId', auth, guildAuth, (req, res) => {
  const s = db.getGuild(req.params.guildId);
  s.customCommands = s.customCommands.filter(c => c.id !== req.params.cmdId);
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true });
});

// ── API — Fun commands ────────────────────────────────────────────────────────
app.get('/api/guilds/:guildId/fun', auth, guildAuth, (req, res) => {
  res.json(db.getGuild(req.params.guildId).funCommands || []);
});

app.post('/api/guilds/:guildId/fun', auth, guildAuth, (req, res) => {
  const { name, responses } = req.body;
  if (!name || !responses?.length) return res.status(400).json({ error: 'name and responses required' });
  const s = db.getGuild(req.params.guildId);
  const cmd = { id: Date.now().toString(), name, responses, enabled: true, createdAt: new Date().toISOString() };
  s.funCommands.push(cmd);
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true, command: cmd });
});

app.delete('/api/guilds/:guildId/fun/:cmdId', auth, guildAuth, (req, res) => {
  const s = db.getGuild(req.params.guildId);
  s.funCommands = s.funCommands.filter(c => c.id !== req.params.cmdId);
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true });
});

// ── API — Responses ───────────────────────────────────────────────────────────
app.get('/api/guilds/:guildId/responses', auth, guildAuth, (req, res) => {
  res.json(db.getGuild(req.params.guildId).responses || {});
});

app.put('/api/guilds/:guildId/responses', auth, guildAuth, (req, res) => {
  const { trigger, response } = req.body;
  if (!trigger || !response) return res.status(400).json({ error: 'trigger and response required' });
  const s = db.getGuild(req.params.guildId);
  s.responses[trigger.toLowerCase()] = response;
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true, responses: s.responses });
});

app.delete('/api/guilds/:guildId/responses/:trigger', auth, guildAuth, (req, res) => {
  const s = db.getGuild(req.params.guildId);
  delete s.responses[req.params.trigger];
  db.saveGuild(req.params.guildId, s);
  res.json({ success: true });
});

// ── API — Logs & Warns ───────────────────────────────────────────────────────
app.get('/api/guilds/:guildId/logs', auth, guildAuth, (req, res) => {
  res.json(db.getLogs(req.params.guildId, 50));
});

app.get('/api/guilds/:guildId/warns/:userId', auth, guildAuth, (req, res) => {
  res.json(db.getWarns(req.params.guildId, req.params.userId));
});

// ── Pages ────────────────────────────────────────────────────────────────────
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard',  (req, res) => { if (!req.session.user) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/guild/:id',  (req, res) => { if (!req.session.user) return res.redirect('/'); res.sendFile(path.join(__dirname, 'public', 'guild.html')); });
app.get('*',           (req, res) => res.redirect('/'));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Dashboard running on port ${PORT}`));