// ━━━ 1. REQUIRED MODULES & IMPORTS ━━━
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// ━━━ 2. DISCORD BOT CLIENT INITIALIZATION ━━━
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const config = {
  PREFIX: '!' // Default prefix
};

// Global sync object for dashboard data
let settings = {
  enabled: true,
  modules: {
    antiSpam: false,
    antiRaid: false,
    antiMassPing: false,
    antiCaps: false,
    antiDuplicate: false,
    antiNuke: false
  },
  customCommands: [],
  funCommands: [],
  responses: {}
};

// Load existing settings if file exists
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
if (fs.existsSync(SETTINGS_PATH)) {
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (err) {
    console.error('Error loading settings.json:', err);
  }
}

// Function to save dashboard changes
function saveSettings() {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ━━━ 3. INTEGRATED EXPRESS DASHBOARD WEB SERVER ━━━
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve Frontend Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/guild/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guild-settings.html')));

// Mock API endpoints for dashboard data syncing
app.get('/api/user', (req, res) => {
  res.json({ id: '12345678', username: 'Developer', avatar: 'abcdef' });
});

app.get('/api/guilds', (req, res) => {
  // Returns list of guilds the bot is in
  const guilds = client.guilds.cache.map(g => ({
    id: g.id,
    name: g.name,
    icon: g.icon,
    owner: true
  }));
  res.json(guilds);
});

app.get('/api/guild/:id', (req, res) => {
  const guild = client.guilds.cache.get(req.params.id);
  res.json({
    guild: guild ? { id: guild.id, name: guild.name, icon: guild.icon } : { id: req.params.id, name: 'Server Config' },
    settings: settings
  });
});

// Update security modules state toggle
app.post('/api/guild/:id/module/:moduleName', (req, res) => {
  const { moduleName } = req.params;
  const { value } = req.body;
  if (settings.modules.hasOwnProperty(moduleName)) {
    settings.modules[moduleName] = value;
    saveSettings();
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Invalid module name' });
});

// Manage custom script actions
app.get('/api/guild/:id/custom-commands', (req, res) => res.json(settings.customCommands));
app.post('/api/guild/:id/custom-commands', (req, res) => {
  const { name, code, description } = req.body;
  const newCmd = { id: Date.now().toString(), name, code, description, enabled: true };
  settings.customCommands.push(newCmd);
  saveSettings();
  res.json(newCmd);
});
app.delete('/api/guild/:id/custom-commands/:cmdId', (req, res) => {
  settings.customCommands = settings.customCommands.filter(c => c.id !== req.params.cmdId);
  saveSettings();
  res.json({ success: true });
});

// Manage fun commands arrays
app.get('/api/guild/:id/fun-commands', (req, res) => res.json(settings.funCommands));
app.post('/api/guild/:id/fun-commands', (req, res) => {
  const { name, responses } = req.body;
  const newFun = { id: Date.now().toString(), name, responses, enabled: true };
  settings.funCommands.push(newFun);
  saveSettings();
  res.json(newFun);
});
app.delete('/api/guild/:id/fun-commands/:funId', (req, res) => {
  settings.funCommands = settings.funCommands.filter(f => f.id !== req.params.funId);
  saveSettings();
  res.json({ success: true });
});

// Manage static keyword auto-replies
app.get('/api/guild/:id/responses', (req, res) => res.json(settings.responses));
app.post('/api/guild/:id/responses/:trigger', (req, res) => {
  settings.responses[req.params.trigger] = req.body.response;
  saveSettings();
  res.json({ success: true });
});
app.delete('/api/guild/:id/responses/:trigger', (req, res) => {
  delete settings.responses[req.params.trigger];
  saveSettings();
  res.json({ success: true });
});

// Start Express Web Server
app.listen(PORT, () => {
  console.log(`🌐 Integrated Dashboard Web Interface is running on port ${PORT}`);
});

// ━━━ 4. CORE BOT COMMAND ENGINE HANDLER ━━━
client.on('messageCreate', async (message) => {
  if (message.author.bot || message.webhookId) return;

  if (message.content.startsWith(config.PREFIX)) {
    const args = message.content.slice(config.PREFIX.length).trim().split(/\s+/);
    const cmdName = args.shift().toLowerCase();

    // A. Custom Dashboard Code Evaluation
    const customCommands = settings.customCommands || [];
    const customCmd = customCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (customCmd) {
      try {
        const wrappedCode = `return (async () => { ${customCmd.code} })();`;
        const fn = new Function('message', 'args', 'guild', 'member', wrappedCode);
        await fn(message, args, message.guild, message.member);
      } catch (err) {
        console.error(`Runtime error running command !${cmdName}:`, err);
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Command Runtime Error')
            .setDescription(`\`\`\`js\n${err.message}\`\`\``)]
        }).catch(() => null);
      }
      return;
    }

    // B. Fun Commands Selection
    const funCommands = settings.funCommands || [];
    const funCmd = funCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (funCmd) {
      let response = funCmd.responses[Math.floor(Math.random() * funCmd.responses.length)];
      response = response.replace(/{user}/g, message.author.toString());
      return message.reply(response).catch(() => null);
    }

    // C. Static Keyword Response Matching
    const responses = settings.responses || {};
    if (responses[cmdName]) {
      return message.reply(responses[cmdName]).catch(() => null);
    }
  }
});

// ━━━ 5. DISCORD CONNECTION HANDSHAKE ━━━
client.once('ready', () => {
  console.log(`🚀 Bot Connection established! System running as: ${client.user.tag}`);
});

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ ERROR: Missing DISCORD_TOKEN in environment variables!");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("❌ Failed to login to Discord Gateway:", err);
});