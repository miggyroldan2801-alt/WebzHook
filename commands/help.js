const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const C = config.COLOR;

module.exports = async function handleHelp(command, args, message, settings) {
  if (command !== 'help') return;

  const page = args[0]?.toLowerCase() || 'main';

  const pages = {
    main: new EmbedBuilder().setColor(C.BLUE).setTitle('📖 WebzHook Guard — Help')
      .setDescription('A powerful moderation & security bot. Use `%help <category>` for details.')
      .addFields(
        { name: '⚙️ `%help setup`', value: 'Setup, enable/disable, log channel, toggles', inline: true },
        { name: '🔨 `%help moderation`', value: 'Ban, kick, mute, warn, purge, lock', inline: true },
        { name: '🛡️ `%help detection`', value: 'Anti-spam, anti-raid, ping detection', inline: true },
        { name: '📋 `%help whitelist`', value: 'Whitelist & forbidden role management', inline: true },
        { name: '🔍 `%help info`', value: 'User, server, role info commands', inline: true },
        { name: '⏱️ `%help disable`', value: 'Temporarily disable detection', inline: true },
      )
      .setFooter({ text: 'WebzHook Guard • Prefix: %' }).setTimestamp(),

    setup: new EmbedBuilder().setColor(C.PURPLE).setTitle('⚙️ Setup Commands')
      .addFields(
        { name: '`%setup`', value: 'Auto-creates all roles, channels & permissions *(Owner only)*' },
        { name: '`%enable`', value: 'Enable the bot for this server *(Owner only)*' },
        { name: '`%disable`', value: 'Disable the bot for this server *(Owner only)*' },
        { name: '`%setlog #channel`', value: 'Set the log channel *(Owner only)*' },
        { name: '`%setmaxrole <position>`', value: 'Set max role position. Anyone assigned above it gets quarantined *(Owner only)*' },
        { name: '`%forbiddenrole @Role`', value: 'Add a forbidden role — auto-quarantine if assigned *(Owner only)*' },
        { name: '`%unforbiddenrole @Role`', value: 'Remove a role from the forbidden list *(Owner only)*' },
        { name: '`%toggle <feature>`', value: 'Toggle: `antispam` `antiraid` `antiping` `anticaps` `antiduplicate` *(Owner only)*' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    moderation: new EmbedBuilder().setColor(C.RED).setTitle('🔨 Moderation Commands')
      .addFields(
        { name: '`%ban @User [reason]`', value: 'Permanently ban a member' },
        { name: '`%tempban @User <duration> [reason]`', value: 'Temporarily ban. e.g. `%tempban @User 1d Raiding`' },
        { name: '`%unban <userId>`', value: 'Unban a user by their ID' },
        { name: '`%kick @User [reason]`', value: 'Kick a member' },
        { name: '`%mute @User [duration] [reason]`', value: 'Mute a member' },
        { name: '`%unmute @User`', value: 'Unmute a member' },
        { name: '`%warn @User <reason>`', value: 'Warn a member (auto-mute at 3, auto-ban at 5)' },
        { name: '`%warnings @User`', value: 'View warnings for a member' },
        { name: '`%clearwarns @User`', value: 'Clear all warnings for a member' },
        { name: '`%purge <1-100>`', value: 'Bulk delete messages' },
        { name: '`%slowmode <seconds>`', value: 'Set slowmode (0 to disable)' },
        { name: '`%lock [reason]`', value: 'Lock current channel' },
        { name: '`%unlock`', value: 'Unlock current channel' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    detection: new EmbedBuilder().setColor(C.ORANGE).setTitle('🛡️ Detection & Auto-Mod')
      .setDescription('These run automatically when the bot is enabled.')
      .addFields(
        { name: '🔗 Webhook Mass Ping', value: 'Auto-deletes webhooks that mass ping or use @everyone/@here' },
        { name: '👤 User Mass Ping', value: 'Warns/mutes users who ping 5+ people in one message' },
        { name: '💬 Anti-Spam', value: 'Mutes users sending 5+ messages in 4s' },
        { name: '🔁 Anti-Duplicate', value: 'Warns users repeating the same message 4+ times' },
        { name: '🔡 Anti-Caps', value: 'Deletes messages that are 80%+ caps' },
        { name: '🚨 Anti-Raid', value: 'Triggers lockdown when 10+ users join within 10s' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    whitelist: new EmbedBuilder().setColor(C.BLUE).setTitle('📋 Whitelist Commands')
      .addFields(
        { name: '`%whitelist @User @User`', value: 'Exempt users from all detection' },
        { name: '`%unwhitelist @User`', value: 'Remove users from whitelist' },
        { name: '`%whitelistview`', value: 'View all whitelisted users' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    info: new EmbedBuilder().setColor(C.BLUE).setTitle('🔍 Info Commands')
      .addFields(
        { name: '`%userinfo [@User]`', value: 'View info about a user (or yourself)' },
        { name: '`%serverinfo`', value: 'View server information' },
        { name: '`%roleinfo @Role`', value: 'View information about a role' },
        { name: '`%status`', value: 'View current bot settings & detection status' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    disable: new EmbedBuilder().setColor(C.ORANGE).setTitle('⏱️ Disable Detection Commands')
      .addFields(
        { name: '`%disable-bot <duration>`', value: 'Temporarily disable detection\nExample: `%disable-bot 30m`, `%disable-bot 2h`, `%disable-bot 1d`' },
        { name: '`%enable-bot`', value: 'Re-enable detection early' },
        { name: '`%status`', value: 'Check if detection is currently active' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),
  };

  const embed = pages[page] || pages.main;
  await message.reply({ embeds: [embed] });
};