const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { hasBotAccess, isOwner, parseDuration, formatDuration, sendLog, applyQuarantine, applyMute } = require('../utils');
const { getWarns, addWarn, clearWarns, updateGuild } = require('../database');
const config = require('../config');
const C = config.COLOR;

function noPerms() {
  return new EmbedBuilder().setColor(C.RED).setTitle('🚫 Access Denied').setDescription('You do not have permission to use this command.').setFooter({ text: 'WebzHook Guard' }).setTimestamp();
}
function usage(text) {
  return new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Invalid Usage').setDescription(text).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
}

module.exports = async function handleModeration(command, args, message, settings) {
  const { guild, member, channel } = message;

  // %kick @user [reason]
  if (command === 'kick') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [usage('`%kick @User [reason]`')] });
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!target.kickable) return message.reply({ embeds: [new EmbedBuilder().setColor(C.RED).setTitle('❌ Cannot Kick').setDescription('I cannot kick this user — they may have a higher role than me.').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    await target.kick(reason);
    const e = new EmbedBuilder().setColor(C.ORANGE).setTitle('👢 Member Kicked')
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'Moderator', value: `${member}`, inline: true }, { name: 'Reason', value: reason })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %ban @user [reason]
  if (command === 'ban') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [usage('`%ban @User [reason]`')] });
    const reason = args.slice(1).join(' ') || 'No reason provided';
    if (!target.bannable) return message.reply({ embeds: [new EmbedBuilder().setColor(C.RED).setTitle('❌ Cannot Ban').setDescription('I cannot ban this user.').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    await target.ban({ reason });
    const e = new EmbedBuilder().setColor(C.RED).setTitle('🔨 Member Banned')
      .addFields({ name: 'User', value: `${target.user.tag}`, inline: true }, { name: 'Moderator', value: `${member}`, inline: true }, { name: 'Reason', value: reason })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %tempban @user <duration> [reason]
  if (command === 'tempban') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target || !args[1]) return message.reply({ embeds: [usage('`%tempban @User <duration> [reason]`\nExample: `%tempban @User 1d Spamming`')] });
    const ms = parseDuration(args[1]);
    if (!ms) return message.reply({ embeds: [usage('Invalid duration. Use `10m`, `2h`, `1d`.')] });
    const reason = args.slice(2).join(' ') || 'No reason provided';
    if (!target.bannable) return message.reply({ embeds: [new EmbedBuilder().setColor(C.RED).setTitle('❌ Cannot Ban').setDescription('I cannot ban this user.').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    await target.ban({ reason });
    setTimeout(async () => {
      await guild.members.unban(target.id, 'Tempban expired').catch(() => {});
    }, ms);
    const e = new EmbedBuilder().setColor(C.RED).setTitle('⏱️ Member Temp-Banned')
      .addFields({ name: 'User', value: `${target.user.tag}`, inline: true }, { name: 'Duration', value: formatDuration(ms), inline: true }, { name: 'Moderator', value: `${member}`, inline: true }, { name: 'Reason', value: reason })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %unban <userId>
  if (command === 'unban') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const userId = args[0];
    if (!userId) return message.reply({ embeds: [usage('`%unban <userId>`')] });
    await guild.members.unban(userId, `Unbanned by ${member.user.tag}`).catch(() => {});
    const e = new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Member Unbanned')
      .addFields({ name: 'User ID', value: userId, inline: true }, { name: 'Moderator', value: `${member}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %mute @user [duration] [reason]
  if (command === 'mute') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [usage('`%mute @User [duration] [reason]`')] });
    const dur = args[1] ? parseDuration(args[1]) : null;
    const reason = args.slice(dur ? 2 : 1).join(' ') || 'No reason provided';
    await applyMute(target, guild);
    if (dur) setTimeout(async () => {
      const muteRole = guild.roles.cache.find(r => r.name === config.MUTE_ROLE);
      if (muteRole) await target.roles.remove(muteRole).catch(() => {});
    }, dur);
    const e = new EmbedBuilder().setColor(C.ORANGE).setTitle('🔇 Member Muted')
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'Duration', value: dur ? formatDuration(dur) : 'Indefinite', inline: true }, { name: 'Moderator', value: `${member}`, inline: true }, { name: 'Reason', value: reason })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %unmute @user
  if (command === 'unmute') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [usage('`%unmute @User`')] });
    const muteRole = guild.roles.cache.find(r => r.name === config.MUTE_ROLE);
    if (muteRole) await target.roles.remove(muteRole).catch(() => {});
    const e = new EmbedBuilder().setColor(C.GREEN).setTitle('🔊 Member Unmuted')
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'Moderator', value: `${member}`, inline: true })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %warn @user <reason>
  if (command === 'warn') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target || args.length < 2) return message.reply({ embeds: [usage('`%warn @User <reason>`')] });
    const reason = args.slice(1).join(' ');
    const warns = addWarn(guild.id, target.id, reason, member.id);
    const e = new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Member Warned')
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'Total Warnings', value: `${warns.length}`, inline: true }, { name: 'Moderator', value: `${member}`, inline: true }, { name: 'Reason', value: reason })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
    if (warns.length >= 3 && warns.length < 5) await applyMute(target, guild);
    if (warns.length >= 5) await target.ban({ reason: 'Auto-ban: 5+ warnings' }).catch(() => {});
  }

  // %warnings @user
  if (command === 'warnings') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [usage('`%warnings @User`')] });
    const warns = getWarns(guild.id, target.id);
    const warnList = warns.length ? warns.map((w, i) => `**${i + 1}.** ${w.reason} — <t:${Math.floor(new Date(w.timestamp).getTime() / 1000)}:R>`).join('\n') : 'No warnings.';
    await message.reply({ embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle(`⚠️ Warnings — ${target.user.tag}`)
      .setDescription(warnList).addFields({ name: 'Total', value: `${warns.length}`, inline: true })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %clearwarns @user
  if (command === 'clearwarns') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [usage('`%clearwarns @User`')] });
    clearWarns(guild.id, target.id);
    const e = new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Warnings Cleared')
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'Moderator', value: `${member}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %quarantine @user
  if (command === 'quarantine') {
    if (!isOwner(member) && !hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [usage('`%quarantine @User`')] });
    await applyQuarantine(target, guild);
    const e = new EmbedBuilder().setColor(C.RED).setTitle('🔒 Member Quarantined')
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'By', value: `${member}`, inline: true }, { name: 'To Release', value: '`%unquarantine @User`' })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %unquarantine @user
  if (command === 'unquarantine') {
    if (!isOwner(member) && !hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [usage('`%unquarantine @User`')] });
    const qRole = guild.roles.cache.find(r => r.name === config.QUARANTINE_ROLE);
    if (qRole) await target.roles.remove(qRole).catch(() => {});
    const e = new EmbedBuilder().setColor(C.GREEN).setTitle('🔓 Member Released from Quarantine')
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'By', value: `${member}`, inline: true })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %purge <amount>
  if (command === 'purge') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const amount = parseInt(args[0]);
    if (isNaN(amount) || amount < 1 || amount > 100) return message.reply({ embeds: [usage('`%purge <1-100>`')] });
    const deleted = await channel.bulkDelete(amount, true).catch(() => null);
    const e = new EmbedBuilder().setColor(C.BLUE).setTitle('🗑️ Messages Purged')
      .addFields({ name: 'Deleted', value: `${deleted?.size ?? 0} messages`, inline: true }, { name: 'Moderator', value: `${member}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    const reply = await channel.send({ embeds: [e] });
    setTimeout(() => reply.delete().catch(() => {}), 5000);
    await sendLog(guild, e);
  }

  // %slowmode <seconds>
  if (command === 'slowmode') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const secs = parseInt(args[0]);
    if (isNaN(secs) || secs < 0 || secs > 21600) return message.reply({ embeds: [usage('`%slowmode <seconds>` (0 to disable, max 21600)')] });
    await channel.setRateLimitPerUser(secs);
    const e = new EmbedBuilder().setColor(C.BLUE).setTitle('🐢 Slowmode Updated')
      .setDescription(secs === 0 ? 'Slowmode has been **disabled**.' : `Slowmode set to **${secs} seconds**.`)
      .addFields({ name: 'Channel', value: `${channel}`, inline: true }, { name: 'Set By', value: `${member}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %lock [reason]
  if (command === 'lock') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const reason = args.join(' ') || 'No reason provided';
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    const e = new EmbedBuilder().setColor(C.RED).setTitle('🔒 Channel Locked')
      .addFields({ name: 'Channel', value: `${channel}`, inline: true }, { name: 'By', value: `${member}`, inline: true }, { name: 'Reason', value: reason })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %unlock
  if (command === 'unlock') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    const e = new EmbedBuilder().setColor(C.GREEN).setTitle('🔓 Channel Unlocked')
      .addFields({ name: 'Channel', value: `${channel}`, inline: true }, { name: 'By', value: `${member}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %lockdown [reason]
  if (command === 'lockdown') {
    if (!isOwner(member) && !hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const reason = args.join(' ') || 'Emergency lockdown';
    let count = 0;
    for (const [, ch] of guild.channels.cache) {
      if (ch.isTextBased()) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
        count++;
      }
    }
    const e = new EmbedBuilder().setColor(C.RED).setTitle('🚨 Server Lockdown Activated')
      .setDescription(`**${count} channels** have been locked.`)
      .addFields({ name: 'By', value: `${member}`, inline: true }, { name: 'Reason', value: reason })
      .setFooter({ text: 'WebzHook Guard • Use %unlockdown to restore' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %unlockdown
  if (command === 'unlockdown') {
    if (!isOwner(member) && !hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    for (const [, ch] of guild.channels.cache) {
      if (ch.isTextBased()) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {});
      }
    }
    const e = new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Server Lockdown Lifted')
      .addFields({ name: 'By', value: `${member}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %nick @user <nickname>
  if (command === 'nick') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [usage('`%nick @User <nickname>`')] });
    const nick = args.slice(1).join(' ') || null;
    await target.setNickname(nick);
    await message.reply({ embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle('✏️ Nickname Updated')
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'New Nick', value: nick || '*(reset)*', inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %userinfo @user
  if (command === 'userinfo') {
    const target = message.mentions.members.first() || member;
    const roles = target.roles.cache.filter(r => r.name !== '@everyone').map(r => `${r}`).join(', ') || 'None';
    const warns = getWarns(guild.id, target.id);
    await message.reply({ embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle(`👤 User Info — ${target.user.tag}`)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: 'ID', value: target.id, inline: true },
        { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Account Created', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Warnings', value: `${warns.length}`, inline: true },
        { name: 'Roles', value: roles.length > 1024 ? roles.slice(0, 1020) + '...' : roles },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %serverinfo
  if (command === 'serverinfo') {
    await message.reply({ embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle(`🏠 Server Info — ${guild.name}`)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
        { name: 'Members', value: `${guild.memberCount}`, inline: true },
        { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
        { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
        { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Boost Level', value: `${guild.premiumTier}`, inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %roleinfo @role
  if (command === 'roleinfo') {
    const role = message.mentions.roles.first();
    if (!role) return message.reply({ embeds: [usage('`%roleinfo @Role`')] });
    await message.reply({ embeds: [new EmbedBuilder().setColor(role.color || C.BLUE).setTitle(`🎭 Role Info — ${role.name}`)
      .addFields(
        { name: 'ID', value: role.id, inline: true },
        { name: 'Color', value: role.hexColor, inline: true },
        { name: 'Position', value: `${role.position}`, inline: true },
        { name: 'Members', value: `${role.members.size}`, inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Hoisted', value: role.hoist ? 'Yes' : 'No', inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %whitelist @user ...
  if (command === 'whitelist') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const mentioned = message.mentions.users;
    if (!mentioned.size) return message.reply({ embeds: [usage('`%whitelist @User1 @User2`')] });
    const wl = [...new Set([...settings.whitelist, ...mentioned.map(u => u.id)])];
    updateGuild(guild.id, { whitelist: wl });
    await message.reply({ embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle('📋 Whitelist Updated')
      .setDescription('The following users are now **exempt** from detection:')
      .addFields({ name: 'Added', value: mentioned.map(u => `<@${u.id}>`).join(', ') })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %unwhitelist @user
  if (command === 'unwhitelist') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const mentioned = message.mentions.users;
    if (!mentioned.size) return message.reply({ embeds: [usage('`%unwhitelist @User`')] });
    const wl = settings.whitelist.filter(id => !mentioned.has(id));
    updateGuild(guild.id, { whitelist: wl });
    await message.reply({ embeds: [new EmbedBuilder().setColor(C.ORANGE).setTitle('📋 Whitelist Updated')
      .addFields({ name: 'Removed', value: mentioned.map(u => `<@${u.id}>`).join(', ') })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %whitelistview
  if (command === 'whitelistview') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const wl = settings.whitelist.length ? settings.whitelist.map(id => `<@${id}>`).join(', ') : 'No users whitelisted.';
    await message.reply({ embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle('📋 Whitelist')
      .setDescription(wl).setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %disable-bot <duration>
  if (command === 'disable-bot') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    const ms = parseDuration(args[0] || '');
    if (!ms) return message.reply({ embeds: [usage('`%disable-bot <duration>` — e.g. `%disable-bot 30m`')] });
    updateGuild(guild.id, { detectionEnabled: false });
    setTimeout(() => updateGuild(guild.id, { detectionEnabled: true }), ms);
    const re = Math.floor((Date.now() + ms) / 1000);
    const e = new EmbedBuilder().setColor(C.ORANGE).setTitle('⚠️ Detection Temporarily Disabled')
      .addFields({ name: 'Disabled By', value: `${member}`, inline: true }, { name: 'Duration', value: formatDuration(ms), inline: true }, { name: 'Re-enables', value: `<t:${re}:F>`, inline: false }, { name: '🔔 Note', value: 'Any Bot Manager can run `%enable-bot` to restore early.' })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %enable-bot
  if (command === 'enable-bot') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [noPerms()] });
    updateGuild(guild.id, { detectionEnabled: true });
    const e = new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Detection Re-Enabled')
      .addFields({ name: 'By', value: `${member}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await message.reply({ embeds: [e] });
    await sendLog(guild, e);
  }

  // %status
  if (command === 'status') {
    const wl = settings.whitelist.length ? settings.whitelist.map(id => `<@${id}>`).join(', ') : 'None';
    const forbidden = settings.forbiddenRoles.length ? settings.forbiddenRoles.map(id => `<@&${id}>`).join(', ') : 'None';
    await message.reply({ embeds: [new EmbedBuilder()
      .setColor(settings.detectionEnabled ? C.GREEN : C.ORANGE)
      .setTitle('📊 WebzHook Guard — Server Status')
      .addFields(
        { name: 'Bot Status', value: settings.enabled ? '🟢 Enabled' : '🔴 Disabled', inline: true },
        { name: 'Detection', value: settings.detectionEnabled ? '🟢 Active' : '🔴 Disabled', inline: true },
        { name: 'Anti-Spam', value: settings.antiSpam ? '✅' : '❌', inline: true },
        { name: 'Anti-Raid', value: settings.antiRaid ? '✅' : '❌', inline: true },
        { name: 'Anti-Mass-Ping', value: settings.antiMassPing ? '✅' : '❌', inline: true },
        { name: 'Anti-Caps', value: settings.antiCaps ? '✅' : '❌', inline: true },
        { name: 'Max Role Position', value: settings.maxRolePosition ? `Position ${settings.maxRolePosition}` : 'Not set', inline: true },
        { name: 'Log Channel', value: settings.logChannelId ? `<#${settings.logChannelId}>` : 'Not set', inline: true },
        { name: 'Whitelisted Users', value: wl },
        { name: 'Forbidden Roles', value: forbidden },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }
};