const fs   = require('fs');
const path = require('path');

const DB_PATH    = path.join(__dirname, 'data');
const GUILDS_F   = path.join(DB_PATH, 'guilds.json');
const WARNS_F    = path.join(DB_PATH, 'warns.json');
const LOGS_F     = path.join(DB_PATH, 'logs.json');

function ensure() {
  if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, { recursive: true });
  if (!fs.existsSync(GUILDS_F)) fs.writeFileSync(GUILDS_F, '{}');
  if (!fs.existsSync(WARNS_F))  fs.writeFileSync(WARNS_F,  '{}');
  if (!fs.existsSync(LOGS_F))   fs.writeFileSync(LOGS_F,   '{}');
}

const read  = f => { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return {}; } };
const write = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2));

const DEFAULTS = {
  enabled: false,
  detectionEnabled: false,
  logChannelId: null,
  whitelist: [],
  blacklist: [],
  maxRolePosition: null,
  forbiddenRoles: [],
  setupDone: false,
  prefix: '%',
  // Verification
  verifyChannelId: null,
  verifiedRoleId: null,
  verifyMode: 'button',
  verifyMessage: 'Click the button below to verify yourself.',
  // Custom content
  customCommands: [],
  funCommands: [],
  responses: {},
  autoRoles: [],
  // Welcome / Leave
  welcomeChannelId: null,
  welcomeMessage: 'Welcome {user} to **{server}**! You are member #{count}.',
  leaveChannelId: null,
  leaveMessage: '{user} has left the server.',
  // Modules (all toggleable)
  modules: {
    antiSpam:       true,
    antiRaid:       true,
    antiMassPing:   true,
    antiCaps:       true,
    antiDuplicate:  true,
    antiNuke:       true,
    antiLogger:     false,
    inviteFilter:   false,
    welcomeSystem:  false,
    leaveSystem:    false,
    autoRole:       false,
    verification:   false,
    slowmodeAuto:   false,
    linkFilter:     false,
    badwordFilter:  false,
  },
  // Configurable thresholds
  thresholds: {
    spamMessages:     5,
    spamSeconds:      4,
    raidJoins:       10,
    raidSeconds:     10,
    massPingMentions: 5,
    capsPercent:     80,
    duplicateCount:   4,
    nukeActions:      3,
    muteDuration:    30,
  },
  badwords: [],
  slowmodeAutoSeconds: 5,
};

function getGuild(id) {
  ensure();
  const all = read(GUILDS_F);
  if (!all[id]) all[id] = JSON.parse(JSON.stringify(DEFAULTS));
  const g = all[id];
  // Deep-merge missing keys
  for (const k of Object.keys(DEFAULTS)) {
    if (g[k] === undefined) g[k] = JSON.parse(JSON.stringify(DEFAULTS[k]));
  }
  for (const k of Object.keys(DEFAULTS.modules))     { if (g.modules[k]    === undefined) g.modules[k]     = DEFAULTS.modules[k];     }
  for (const k of Object.keys(DEFAULTS.thresholds))  { if (g.thresholds[k] === undefined) g.thresholds[k]  = DEFAULTS.thresholds[k];  }
  write(GUILDS_F, all);
  return g;
}

function saveGuild(id, s) {
  ensure();
  const all = read(GUILDS_F);
  all[id] = s;
  write(GUILDS_F, all);
}

function updateGuild(id, patch) {
  const s = getGuild(id);
  Object.assign(s, patch);
  saveGuild(id, s);
  return s;
}

// Warnings
function getWarns(gid, uid)                { ensure(); return read(WARNS_F)[gid]?.[uid] || []; }
function addWarn(gid, uid, reason, modId)  {
  ensure();
  const all = read(WARNS_F);
  if (!all[gid]) all[gid] = {};
  if (!all[gid][uid]) all[gid][uid] = [];
  all[gid][uid].push({ id: Date.now(), reason, modId, ts: new Date().toISOString() });
  write(WARNS_F, all);
  return all[gid][uid];
}
function clearWarns(gid, uid) {
  ensure();
  const all = read(WARNS_F);
  if (all[gid]) delete all[gid][uid];
  write(WARNS_F, all);
}

// Mod action logs
function addLog(gid, entry) {
  ensure();
  const all = read(LOGS_F);
  if (!all[gid]) all[gid] = [];
  all[gid].unshift({ ...entry, ts: new Date().toISOString() });
  if (all[gid].length > 200) all[gid] = all[gid].slice(0, 200);
  write(LOGS_F, all);
}
function getLogs(gid, limit = 50) {
  ensure();
  return (read(LOGS_F)[gid] || []).slice(0, limit);
}

module.exports = { getGuild, saveGuild, updateGuild, getWarns, addWarn, clearWarns, addLog, getLogs };