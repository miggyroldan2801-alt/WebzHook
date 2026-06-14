const { EmbedBuilder, PermissionsBitField, ChannelType } = require('discord.js');
const config = require('./config');
const db     = require('./database');

const C = config.COLOR;

// ── Permission checks ────────────────────────────────────────────────────────
function isOwner(member)    { return member.guild.ownerId === member.id; }
function isAdmin(member)    { return member.permissions.has(PermissionsBitField.Flags.Administrator); }
function hasBotAccess(member) {
  if (isOwner(member) || isAdmin(member)) return true;
  const s = db.getGuild(member.guild.id);
  if (s.whitelist.includes(member.id)) return true;
  return member.roles.cache.some(r => r.name === config.BOT_ACCESS_ROLE);
}

// ── Duration helpers ─────────────────────────────────────────────────────────
function parseDuration(str) {
  if (!str) return null;
  const m = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!m) return null;
  return parseInt(m[1]) * { s:1000, m:60000, h:3600000, d:86400000 }[m[2].toLowerCase()];
}
function formatDuration(ms) {
  const d = Math.floor(ms/86400000), h = Math.floor((ms%86400000)/3600000),
        m = Math.floor((ms%3600000)/60000), s = Math.floor((ms%60000)/1000);
  return [d&&`${d}d`, h&&`${h}h`, m&&`${m}m`, s&&`${s}s`].filter(Boolean).join(' ') || '0s';
}

// ── Logging ──────────────────────────────────────────────────────────────────
async function sendLog(guild, embed) {
  const s = db.getGuild(guild.id);
  if (!s.logChannelId) return;
  const ch = guild.channels.cache.get(s.logChannelId);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

// ── Role helpers ─────────────────────────────────────────────────────────────
async function getOrCreateRole(guild, name, opts = {}) {
  return guild.roles.cache.find(r => r.name === name)
    || await guild.roles.create({ name, ...opts });
}

// ── Mute / Quarantine ────────────────────────────────────────────────────────
async function applyMute(member, guild) {
  const role = await getOrCreateRole(guild, config.MUTE_ROLE, { color: C.GREY, reason: 'WebzHook Guard mute role' });
  for (const [, ch] of guild.channels.cache) {
    if (ch.isTextBased()) await ch.permissionOverwrites.edit(role, { SendMessages: false }).catch(() => {});
  }
  await member.roles.add(role).catch(() => {});
  return role;
}

async function removeMute(member, guild) {
  const role = guild.roles.cache.find(r => r.name === config.MUTE_ROLE);
  if (role) await member.roles.remove(role).catch(() => {});
}

async function applyQuarantine(member, guild) {
  const role = await getOrCreateRole(guild, config.QUARANTINE_ROLE, { color: C.GREY, reason: 'WebzHook Guard quarantine role' });
  for (const [, ch] of guild.channels.cache) {
    await ch.permissionOverwrites.edit(role, {
      SendMessages: false, AddReactions: false, Speak: false, ViewChannel: false
    }).catch(() => {});
  }
  await member.roles.add(role).catch(() => {});
  return role;
}

// ── Embed builders ───────────────────────────────────────────────────────────
function successEmbed(title, desc) {
  return new EmbedBuilder().setColor(C.GREEN).setTitle(`✅ ${title}`)
    .setDescription(desc||null).setFooter({text:'WebzHook Guard'}).setTimestamp();
}
function errorEmbed(title, desc) {
  return new EmbedBuilder().setColor(C.RED).setTitle(`❌ ${title}`)
    .setDescription(desc||null).setFooter({text:'WebzHook Guard'}).setTimestamp();
}
function infoEmbed(title, desc) {
  return new EmbedBuilder().setColor(C.BLUE).setTitle(`ℹ️ ${title}`)
    .setDescription(desc||null).setFooter({text:'WebzHook Guard'}).setTimestamp();
}
function warnEmbed(title, desc) {
  return new EmbedBuilder().setColor(C.YELLOW).setTitle(`⚠️ ${title}`)
    .setDescription(desc||null).setFooter({text:'WebzHook Guard'}).setTimestamp();
}

// ── Welcome/Leave message formatter ─────────────────────────────────────────
function formatMessage(template, member) {
  return template
    .replace(/{user}/g,   `<@${member.id}>`)
    .replace(/{username}/g, member.user.username)
    .replace(/{server}/g, member.guild.name)
    .replace(/{count}/g,  member.guild.memberCount)
    .replace(/{id}/g,     member.id);
}

module.exports = {
  isOwner, isAdmin, hasBotAccess,
  parseDuration, formatDuration,
  sendLog,
  getOrCreateRole,
  applyMute, removeMute, applyQuarantine,
  successEmbed, errorEmbed, infoEmbed, warnEmbed,
  formatMessage,
};