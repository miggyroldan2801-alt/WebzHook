const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const config = require('./config');
const db = require('./database');

function embed(color, title, description) {
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description || null)
    .setFooter({ text: 'WebzHook Guard' })
    .setTimestamp();
}

function hasBotAccess(member) {
  const settings = db.getGuild(member.guild.id);
  if (isOwner(member)) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (settings.whitelist.includes(member.id)) return true;
  return member.roles.cache.some(r => r.name === config.BOT_ACCESS_ROLE);
}

function isOwner(member) {
  return member.guild.ownerId === member.id;
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([mhd])$/i);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  return val * { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
}

function formatDuration(ms) {
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !d && !h) parts.push(`${s}s`);
  return parts.join(' ') || '< 1s';
}

async function sendLog(guild, embedData) {
  const settings = db.getGuild(guild.id);
  if (!settings.logChannelId) return;
  const ch = guild.channels.cache.get(settings.logChannelId);
  if (ch) await ch.send({ embeds: [embedData] }).catch(() => {});
}

async function getOrCreateRole(guild, name, options = {}) {
  let role = guild.roles.cache.find(r => r.name === name);
  if (!role) role = await guild.roles.create({ name, ...options });
  return role;
}

async function applyQuarantine(member, guild) {
  const role = await getOrCreateRole(guild, config.QUARANTINE_ROLE, {
    color: config.COLOR.GREY,
    reason: 'WebzHook Guard - Quarantine role',
  });
  for (const [, ch] of guild.channels.cache) {
    if (ch.isTextBased()) {
      await ch.permissionOverwrites.edit(role, {
        SendMessages: false, AddReactions: false, Speak: false,
      }).catch(() => {});
    }
  }
  await member.roles.add(role).catch(() => {});
  return role;
}

async function applyMute(member, guild) {
  const role = await getOrCreateRole(guild, config.MUTE_ROLE, {
    color: config.COLOR.GREY,
    reason: 'WebzHook Guard - Mute role',
  });
  for (const [, ch] of guild.channels.cache) {
    if (ch.isTextBased()) {
      await ch.permissionOverwrites.edit(role, { SendMessages: false }).catch(() => {});
    }
  }
  await member.roles.add(role).catch(() => {});
  return role;
}

module.exports = { embed, hasBotAccess, isOwner, parseDuration, formatDuration, sendLog, getOrCreateRole, applyQuarantine, applyMute };