const { EmbedBuilder } = require('discord.js');
const { isOwner } = require('../utils');
const { updateGuild } = require('../database');
const config = require('../config');
const C = config.COLOR;

module.exports = async function handleAdvancedSecurity(command, args, message, settings) {
  const { guild, member } = message;

  if (command === 'antilogger') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const enabled = !settings.antiLogger;
    updateGuild(guild.id, { antiLogger: enabled });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(enabled ? C.GREEN : C.RED)
      .setTitle(`${enabled ? '✅' : '🔴'} Anti-Logger ${enabled ? 'Enabled' : 'Disabled'}`)
      .setDescription('Bot will auto-ban suspicious invite/webhook links')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'spam-threshold') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const num = parseInt(args[0]);
    if (isNaN(num) || num < 2 || num > 20) return message.reply({ embeds: [usage('`%spam-threshold <2-20>`')] });
    updateGuild(guild.id, { spamThreshold: num });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Spam Threshold Updated')
      .setDescription(`Users will be muted after ${num} messages in 4 seconds`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'raid-threshold') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const num = parseInt(args[0]);
    if (isNaN(num) || num < 5 || num > 50) return message.reply({ embeds: [usage('`%raid-threshold <5-50>`')] });
    updateGuild(guild.id, { raidThreshold: num });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Raid Threshold Updated')
      .setDescription(`Server will lockdown when ${num}+ users join in 10 seconds`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'webhook-monitor') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const enabled = !settings.webhookMonitor;
    updateGuild(guild.id, { webhookMonitor: enabled });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(enabled ? C.GREEN : C.RED)
      .setTitle(`${enabled ? '✅' : '🔴'} Webhook Monitor ${enabled ? 'Enabled' : 'Disabled'}`)
      .setDescription('Bot will track and log all webhook activity')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'mass-mention-limit') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const num = parseInt(args[0]);
    if (isNaN(num) || num < 2 || num > 20) return message.reply({ embeds: [usage('`%mass-mention-limit <2-20>`')] });
    updateGuild(guild.id, { massMentionLimit: num });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Mass Mention Limit Updated')
      .setDescription(`Users pinging ${num}+ people will be warned`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'role-create-monitor') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const enabled = !settings.roleCreateMonitor;
    updateGuild(guild.id, { roleCreateMonitor: enabled });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(enabled ? C.GREEN : C.RED)
      .setTitle(`${enabled ? '✅' : '🔴'} Role Creation Monitor ${enabled ? 'Enabled' : 'Disabled'}`)
      .setDescription('Bot will monitor and log role creation/deletion')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'channel-lock-threshold') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const num = parseInt(args[0]);
    if (isNaN(num) || num < 3 || num > 20) return message.reply({ embeds: [usage('`%channel-lock-threshold <3-20>`')] });
    updateGuild(guild.id, { channelLockThreshold: num });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Channel Lock Threshold Updated')
      .setDescription(`Auto-lock all channels when ${num}+ get deleted in 10 seconds`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'botspam-monitor') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const enabled = !settings.botspamMonitor;
    updateGuild(guild.id, { botspamMonitor: enabled });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(enabled ? C.GREEN : C.RED)
      .setTitle(`${enabled ? '✅' : '🔴'} Bot Spam Monitor ${enabled ? 'Enabled' : 'Disabled'}`)
      .setDescription('Bot will track excessive bot usage and spam')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'dm-spam-filter') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const enabled = !settings.dmSpamFilter;
    updateGuild(guild.id, { dmSpamFilter: enabled });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(enabled ? C.GREEN : C.RED)
      .setTitle(`${enabled ? '✅' : '🔴'} DM Spam Filter ${enabled ? 'Enabled' : 'Disabled'}`)
      .setDescription('Bot members with suspicious DM patterns will be warned')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'invite-filter') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const enabled = !settings.inviteFilter;
    updateGuild(guild.id, { inviteFilter: enabled });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(enabled ? C.GREEN : C.RED)
      .setTitle(`${enabled ? '✅' : '🔴'} Invite Filter ${enabled ? 'Enabled' : 'Disabled'}`)
      .setDescription('Bot will delete messages with Discord invites')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }
};

function noPerms() {
  return new EmbedBuilder().setColor(config.COLOR.RED).setTitle('🚫 Access Denied').setDescription('Only owner can use this command.').setFooter({ text: 'WebzHook Guard' }).setTimestamp();
}

function usage(text) {
  return new EmbedBuilder().setColor(config.COLOR.YELLOW).setTitle('⚠️ Usage').setDescription(text).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
}