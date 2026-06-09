const { EmbedBuilder, PermissionsBitField, ChannelType } = require('discord.js');
const { isOwner, getOrCreateRole, applyQuarantine, applyMute } = require('../utils');
const { updateGuild } = require('../database');
const config = require('../config');

module.exports = async function handleSetup(command, args, message, settings) {
  const { guild, member, channel } = message;
  const C = config.COLOR;

  // %setup
  if (command === 'setup') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });

    await message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle('⚙️ WebzHook Guard — Setup Starting')
      .setDescription('Creating all required roles and channels...\nThis may take a moment.')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });

    const results = [];

    try {
      await getOrCreateRole(guild, config.BOT_ACCESS_ROLE, { color: C.BLUE, reason: 'WebzHook Guard setup' });
      results.push('✅ `Bot Manager` role created');
    } catch { results.push('❌ Failed to create `Bot Manager` role'); }

    try {
      const qRole = await getOrCreateRole(guild, config.QUARANTINE_ROLE, { color: C.GREY, reason: 'WebzHook Guard setup' });
      for (const [, ch] of guild.channels.cache) {
        if (ch.isTextBased()) await ch.permissionOverwrites.edit(qRole, { SendMessages: false, AddReactions: false }).catch(() => {});
      }
      results.push('✅ `Quarantined` role created & configured');
    } catch { results.push('❌ Failed to create `Quarantined` role'); }

    try {
      const mRole = await getOrCreateRole(guild, config.MUTE_ROLE, { color: C.GREY, reason: 'WebzHook Guard setup' });
      for (const [, ch] of guild.channels.cache) {
        if (ch.isTextBased()) await ch.permissionOverwrites.edit(mRole, { SendMessages: false }).catch(() => {});
      }
      results.push('✅ `Muted` role created & configured');
    } catch { results.push('❌ Failed to create `Muted` role'); }

    try {
      let logCh = guild.channels.cache.find(c => c.name === 'webzhook-logs');
      if (!logCh) {
        logCh = await guild.channels.create({
          name: 'webzhook-logs',
          type: ChannelType.GuildText,
          permissionOverwrites: [
            { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: guild.members.me, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
          ],
          reason: 'WebzHook Guard log channel',
        });
      }
      updateGuild(guild.id, { logChannelId: logCh.id, setupDone: true });
      results.push(`✅ Log channel created: <#${logCh.id}>`);
    } catch { results.push('❌ Failed to create log channel'); }

    return channel.send({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Setup Complete')
      .setDescription(results.join('\n'))
      .addFields({ name: 'Next Steps', value: '• Run `%enable` to activate the bot\n• Assign `Bot Manager` role to your mods\n• Run `%help` to see all commands' })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %enable
  if (command === 'enable') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    updateGuild(guild.id, { enabled: true, detectionEnabled: true });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Bot Enabled')
      .setDescription('WebzHook Guard is now **active** and protecting this server.')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %disable
  if (command === 'disable') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    updateGuild(guild.id, { enabled: false, detectionEnabled: false });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.RED).setTitle('🔴 Bot Disabled')
      .setDescription('WebzHook Guard has been **disabled** for this server.')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %setlog #channel
  if (command === 'setlog') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply({ embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Usage').setDescription('`%setlog #channel`').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    updateGuild(guild.id, { logChannelId: ch.id });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Log Channel Set')
      .setDescription(`All bot logs will now be sent to ${ch}.`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %setmaxrole <position>
  if (command === 'setmaxrole') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const pos = parseInt(args[0]);
    if (isNaN(pos) || pos < 1) return message.reply({ embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Usage').setDescription('`%setmaxrole <position number>`\nExample: `%setmaxrole 5`').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    updateGuild(guild.id, { maxRolePosition: pos });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Max Role Position Set')
      .setDescription(`Users will be **automatically quarantined** if they assign or receive a role above position **${pos}**.`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %forbiddenrole @role
  if (command === 'forbiddenrole') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const role = message.mentions.roles.first();
    if (!role) return message.reply({ embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Usage').setDescription('`%forbiddenrole @Role`').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    const forbidden = [...(settings.forbiddenRoles || [])];
    if (!forbidden.includes(role.id)) forbidden.push(role.id);
    updateGuild(guild.id, { forbiddenRoles: forbidden });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.ORANGE).setTitle('🚫 Forbidden Role Added')
      .setDescription(`The role **${role.name}** is now forbidden. Anyone who receives it will be auto-quarantined.`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %unforbiddenrole @role
  if (command === 'unforbiddenrole') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const role = message.mentions.roles.first();
    if (!role) return message.reply({ embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Usage').setDescription('`%unforbiddenrole @Role`').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    const forbidden = (settings.forbiddenRoles || []).filter(id => id !== role.id);
    updateGuild(guild.id, { forbiddenRoles: forbidden });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Forbidden Role Removed')
      .setDescription(`**${role.name}** has been removed from the forbidden list.`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // %toggle <feature>
  if (command === 'toggle') {
    if (!isOwner(member)) return message.reply({ embeds: [noPerms()] });
    const features = { antispam: 'antiSpam', antiraid: 'antiRaid', antiping: 'antiMassPing', anticaps: 'antiCaps', antiduplicate: 'antiDuplicate' };
    const feat = args[0]?.toLowerCase();
    if (!feat || !features[feat]) return message.reply({ embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Usage').setDescription('`%toggle <feature>`\nFeatures: `antispam`, `antiraid`, `antiping`, `anticaps`, `antiduplicate`').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    const key = features[feat];
    const newVal = !settings[key];
    updateGuild(guild.id, { [key]: newVal });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(newVal ? C.GREEN : C.RED)
      .setTitle(`${newVal ? '✅ Enabled' : '🔴 Disabled'}: ${feat}`)
      .setDescription(`**${feat}** detection is now **${newVal ? 'ON' : 'OFF'}**.`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }
};

function noPerms() {
  return new EmbedBuilder().setColor(config.COLOR.RED).setTitle('🚫 Access Denied').setDescription('Only the **server owner** can use this command.').setFooter({ text: 'WebzHook Guard' }).setTimestamp();
}