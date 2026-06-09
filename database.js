const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data');
const GUILDS_FILE = path.join(DB_PATH, 'guilds.json');
const WARNS_FILE = path.join(DB_PATH, 'warns.json');

function ensureFiles() {
  if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
  if (!fs.existsSync(GUILDS_FILE)) fs.writeFileSync(GUILDS_FILE, '{}');
  if (!fs.existsSync(WARNS_FILE)) fs.writeFileSync(WARNS_FILE, '{}');
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const DEFAULT_GUILD = {
  enabled: false,
  detectionEnabled: false,
  logChannelId: null,
  whitelist: [],
  maxRolePosition: null,
  forbiddenRoles: [],
  antiRaid: true,
  antiSpam: true,
  antiMassPing: true,
  antiCaps: true,
  antiDuplicate: true,
  antiNuke: true,
  setupDone: false,
  customCommands: [],
  verifyChannelId: null,
  verifiedRoleId: null,
  verifyMode: 'button',
};

function getGuild(guildId) {
  ensureFiles();
  const data = readJSON(GUILDS_FILE);
  if (!data[guildId]) data[guildId] = { ...DEFAULT_GUILD };
  return data[guildId];
}

function saveGuild(guildId, settings) {
  ensureFiles();
  const data = readJSON(GUILDS_FILE);
  data[guildId] = settings;
  writeJSON(GUILDS_FILE, data);
}

function updateGuild(guildId, patch) {
  const settings = getGuild(guildId);
  Object.assign(settings, patch);
  saveGuild(guildId, settings);
  return settings;
}

function getWarns(guildId, userId) {
  ensureFiles();
  const data = readJSON(WARNS_FILE);
  return (data[guildId]?.[userId]) || [];
}

function addWarn(guildId, userId, reason, moderatorId) {
  ensureFiles();
  const data = readJSON(WARNS_FILE);
  if (!data[guildId]) data[guildId] = {};
  if (!data[guildId][userId]) data[guildId][userId] = [];
  const warn = { id: Date.now(), reason, moderatorId, timestamp: new Date().toISOString() };
  data[guildId][userId].push(warn);
  writeJSON(WARNS_FILE, data);
  return data[guildId][userId];
}

function clearWarns(guildId, userId) {
  ensureFiles();
  const data = readJSON(WARNS_FILE);
  if (data[guildId]) delete data[guildId][userId];
  writeJSON(WARNS_FILE, data);
}

module.exports = { getGuild, saveGuild, updateGuild, getWarns, addWarn, clearWarns };