const { EmbedBuilder } = require('discord.js');
const { getGuild } = require('../database');
const config = require('../config');

const nukeTracker = new Map();

function trackNukeAction(userId, guildId, type) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  if (!nukeTracker.has(key)) nukeTracker.set(key, { actions: [] });
  const entry = nukeTracker.get(key);
  entry.actions = entry.actions.filter(a => now - a.time < 10000);
  entry.actions.push({ type, time: now });
  return entry.actions.length;
}

module.exports = { trackNukeAction };

module.exports.handleAntiNuke = async function(client, guild, executorId, actionType) {
  const settings = getGuild(guild.id);
  if (!settings.enabled || !settings.detectionEnabled || !settings.antiNuke) return;
  if (settings.whitelist.includes(executorId)) return;
  if (guild.ownerId === executorId) return;

  const count = trackNukeAction(executorId, guild.id, actionType);
  if (count < 3) return;

  const member = guild.members.cache.get(executorId);
  if (!member) {
    await guild.members.ban(executorId, { reason: 'Anti-Nuke: Mass destructive actions detected' }).catch(() => {});
  } else {
    await member.ban({ reason: 'Anti-Nuke: Mass destructive actions detected' }).catch(() => {});
  }

  const e = new EmbedBuilder().setColor(config.COLOR.RED).setTitle('🚨 NUKE ATTEMPT DETECTED — User Banned')
    .setDescription(`A user performed **${count} destructive actions** within 10 seconds and has been automatically banned.`)
    .addFields(
      { name: 'Executor', value: `<@${executorId}> (${executorId})`, inline: true },
      { name: 'Action Type', value: actionType, inline: true },
      { name: 'Actions in Window', value: `${count}`, inline: true },
    ).setFooter({ text: 'WebzHook Guard • Anti-Nuke' }).setTimestamp();
};