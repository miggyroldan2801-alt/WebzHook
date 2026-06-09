require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const config = require('./config');
const db = require('./database');
const { sendLog, applyQuarantine, applyMute, hasBotAccess } = require('./utils');
const { trackSpam, trackDuplicate, trackRaid } = require('./antispam');

const handleSetup = require('./commands/setup');
const handleModeration = require('./commands/moderation');
const handleHelp = require('./commands/help');
const handleUtility = require('./commands/utility');
const handleAdvancedSecurity = require('./commands/advanced-security');

const C = config.COLOR;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once('ready', () => {
  console.log(`✅ WebzHook Guard online as ${client.user.tag}`);
  client.user.setActivity('Protecting servers | %help', { type: 3 });
});

client.on('guildCreate', async (guild) => {
  db.getGuild(guild.id);
  console.log(`📥 Joined guild: ${guild.name} (${guild.id}) — bot starts disabled.`);

  const ch = guild.channels.cache.find(c =>
    c.isTextBased() && c.permissionsFor(guild.members.me).has(PermissionsBitField.Flags.SendMessages)
  );
  if (ch) {
    await ch.send({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE)
      .setTitle('👋 Thanks for adding WebzHook Guard!')
      .setDescription('The bot is currently **disabled** by default.\nThe server owner must run `%setup` first, then `%enable` to activate protection.')
      .addFields(
        { name: '📋 Getting Started', value: '1. Run `%setup` to create all roles & channels\n2. Run `%enable` to activate the bot\n3. Assign `Bot Manager` role to your moderators\n4. Run `%help` to see all commands' },
        { name: '📖 Full Command List', value: 'Run `%help` anytime' },
      )
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }
});

client.on('guildMemberAdd', async (member) => {
  const settings = db.getGuild(member.guild.id);
  if (!settings.enabled || !settings.detectionEnabled || !settings.antiRaid) return;

  const joinCount = trackRaid(member.guild.id);
  if (joinCount >= config.RAID_JOIN_LIMIT) {
    for (const [, ch] of member.guild.channels.cache) {
      if (ch.isTextBased()) {
        await ch.permissionOverwrites.edit(member.guild.roles.everyone, { SendMessages: false }).catch(() => {});
      }
    }
    const e = new EmbedBuilder().setColor(C.RED).setTitle('🚨 RAID DETECTED — Auto Lockdown')
      .setDescription(`**${joinCount} users** joined within 10 seconds. All channels have been locked.`)
      .addFields({ name: 'Action', value: 'Server locked. Use `%unlockdown` to restore.' })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
    await sendLog(member.guild, e);
  }
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const settings = db.getGuild(newMember.guild.id);
  if (!settings.enabled || !settings.detectionEnabled) return;
  if (hasBotAccess(newMember) || settings.whitelist.includes(newMember.id)) return;

  const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  if (!addedRoles.size) return;

  for (const [, role] of addedRoles) {
    const isForbidden = settings.forbiddenRoles.includes(role.id);
    const isAboveMax = settings.maxRolePosition && role.position > settings.maxRolePosition;

    if (isForbidden || isAboveMax) {
      await applyQuarantine(newMember, newMember.guild);
      const reason = isForbidden
        ? `Received forbidden role: ${role.name}`
        : `Received role above max position (${role.name} @ position ${role.position})`;

      const e = new EmbedBuilder().setColor(C.RED).setTitle('🔒 Auto-Quarantine: Role Violation')
        .setDescription(`**${newMember.user.tag}** was automatically quarantined.`)
        .addFields({ name: 'Reason', value: reason }, { name: 'User', value: `${newMember}`, inline: true })
        .setThumbnail(newMember.user.displayAvatarURL())
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
      await sendLog(newMember.guild, e);
      break;
    }
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild) return;

  const settings = db.getGuild(message.guild.id);

  // COMMANDS
  if (!message.author.bot && message.content.startsWith(config.PREFIX)) {
    const args = message.content.slice(config.PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    const member = message.member;

    await handleHelp(command, args, message, settings);
    await handleSetup(command, args, message, settings);
    await handleModeration(command, args, message, settings);
    await handleUtility(command, args, message, settings);
    await handleAdvancedSecurity(command, args, message, settings);
    return;
  }

  // DETECTION (only if bot is enabled)
  if (!settings.enabled || !settings.detectionEnabled) return;
  if (message.author.bot && !message.webhookId) return;

  const isWhitelisted = settings.whitelist.includes(message.author?.id);

  // WEBHOOK DETECTION
  if (message.webhookId) {
    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    const hasEveryonePing = message.mentions.everyone;
    const isMassPing = mentionCount >= config.MASS_PING_THRESHOLD;
    const isRolePing = config.BLOCK_ROLE_PINGS && (message.mentions.roles.size > 0 || hasEveryonePing);

    if (isMassPing || isRolePing) {
      const reason = isMassPing ? `Webhook mass ping (${mentionCount} mentions)` : hasEveryonePing ? 'Webhook @everyone/@here ping' : 'Webhook role ping';
      await message.delete().catch(() => {});
      const botMember = message.guild.members.me;
      if (!botMember.permissions.has(PermissionsBitField.Flags.ManageWebhooks)) return;
      const webhook = await client.fetchWebhook(message.webhookId).catch(() => null);
      if (webhook) await webhook.delete(`Auto-deleted: ${reason}`).catch(() => {});
      const e = new EmbedBuilder().setColor(C.RED).setTitle('🚨 Malicious Webhook Deleted')
        .addFields(
          { name: 'Reason', value: reason, inline: false },
          { name: 'Webhook', value: webhook?.name || 'Unknown', inline: true },
          { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
        ).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
      await sendLog(message.guild, e);
    }
    return;
  }

  // USER DETECTION (skip whitelisted)
  if (isWhitelisted) return;
  const member = message.member;

  // USER MASS PING
  if (settings.antiMassPing) {
    const mentionCount = message.mentions.users.size + message.mentions.roles.size;
    const hasEveryonePing = message.mentions.everyone;
    if (mentionCount >= config.MENTION_LIMIT_USER || hasEveryonePing) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, `Mass ping (${mentionCount} mentions)`, client.user.id);
      if (warns.length >= 3) await applyMute(member, message.guild);
      const e = new EmbedBuilder().setColor(C.RED).setTitle('🚨 Mass Ping Detected')
        .addFields(
          { name: 'User', value: `${message.author}`, inline: true },
          { name: 'Mentions', value: `${mentionCount}`, inline: true },
          { name: 'Action', value: warns.length >= 3 ? '🔇 User muted' : `⚠️ Warning ${warns.length}/3`, inline: true },
        ).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
      await sendLog(message.guild, e);
      await message.channel.send({ embeds: [new EmbedBuilder().setColor(C.RED).setTitle('🚨 Mass Ping Blocked')
        .setDescription(`${message.author}, mass pinging is not allowed. **Warning ${warns.length}/3.**`)
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] })
        .then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
      return;
    }
  }

  // ANTI-SPAM
  if (settings.antiSpam) {
    const msgCount = trackSpam(message.author.id, message.guild.id);
    if (msgCount >= config.SPAM_MESSAGE_LIMIT) {
      await applyMute(member, message.guild);
      setTimeout(async () => {
        const muteRole = message.guild.roles.cache.find(r => r.name === config.MUTE_ROLE);
        if (muteRole) await member.roles.remove(muteRole).catch(() => {});
      }, 30000);
      const e = new EmbedBuilder().setColor(C.ORANGE).setTitle('🔇 Spam Detected — Auto Muted')
        .addFields({ name: 'User', value: `${message.author}`, inline: true }, { name: 'Messages', value: `${msgCount} in 4s`, inline: true }, { name: 'Mute Duration', value: '30 seconds', inline: true })
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
      await sendLog(message.guild, e);
      return;
    }
  }

  // ANTI-DUPLICATE
  if (settings.antiDuplicate) {
    const dupCount = trackDuplicate(message.author.id, message.guild.id, message.content);
    if (dupCount >= config.DUPLICATE_LIMIT) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, 'Repeated duplicate messages', client.user.id);
      const e = new EmbedBuilder().setColor(C.YELLOW).setTitle('🔁 Duplicate Message Detected')
        .addFields({ name: 'User', value: `${message.author}`, inline: true }, { name: 'Repeated', value: `${dupCount}x`, inline: true }, { name: 'Warning', value: `${warns.length}/3`, inline: true })
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
      await sendLog(message.guild, e);
      return;
    }
  }

  // ANTI-CAPS
  if (settings.antiCaps && message.content.length >= config.CAPS_MIN_LENGTH) {
    const upper = message.content.replace(/[^a-zA-Z]/g, '');
    if (upper.length > 0) {
      const capsPercent = (message.content.replace(/[^A-Z]/g, '').length / upper.length) * 100;
      if (capsPercent >= config.CAPS_PERCENT) {
        await message.delete().catch(() => {});
        await message.channel.send({ embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('🔡 Caps Lock Spam Removed')
          .setDescription(`${message.author}, please avoid excessive caps.`)
          .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] })
          .then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
      }
    }
  }
});

client.login(process.env.DISCORD_TOKEN);