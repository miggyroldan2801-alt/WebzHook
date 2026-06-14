require('dotenv').config();
const {
  Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelSelectMenuBuilder, ComponentType, Collection,
  ChannelType, Events, SlashCommandBuilder,
} = require('discord.js');

const config = require('./config');
const db     = require('./database');
const spam   = require('./antispam');
const {
  isOwner, isAdmin, hasBotAccess,
  parseDuration, formatDuration,
  sendLog, getOrCreateRole,
  applyMute, removeMute, applyQuarantine,
  successEmbed, errorEmbed, infoEmbed, warnEmbed,
  formatMessage,
} = require('./utils');

const C = config.COLOR;

// ─────────────────────────────────────────────────────────────────────────────
//  CLIENT
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// Cooldown map
const cooldowns = new Collection();

// ─────────────────────────────────────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} online — ${client.guilds.cache.size} guilds`);
  const statuses = [
    { name: 'servers | %help', type: 3 },
    { name: `${client.guilds.cache.size} servers`, type: 3 },
    { name: 'for threats 🛡️', type: 2 },
  ];
  let i = 0;
  client.user.setActivity(statuses[0].name, { type: statuses[0].type });
  setInterval(() => {
    i = (i + 1) % statuses.length;
    client.user.setActivity(statuses[i].name, { type: statuses[i].type });
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GUILD JOIN
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildCreate', async guild => {
  db.getGuild(guild.id);
  const ch = guild.channels.cache.find(c =>
    c.isTextBased() && c.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
  );
  if (!ch) return;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup_start').setLabel('⚡ Quick Setup').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel('📖 Documentation').setStyle(ButtonStyle.Link).setURL('https://github.com')
  );

  await ch.send({
    embeds: [new EmbedBuilder().setColor(C.BLUE)
      .setTitle('👋 Thanks for adding WebzHook Guard!')
      .setThumbnail(client.user.displayAvatarURL())
      .setDescription('The bot starts **disabled** for safety. Click Quick Setup to configure everything automatically, or run `%setup` manually.')
      .addFields(
        { name: '🚀 Quick Start', value: '1. Click **Quick Setup** below\n2. Run `%enable` to activate\n3. Run `%help` to see all commands', inline: true },
        { name: '🛡️ Features', value: '• Anti-Spam & Anti-Raid\n• Anti-Nuke Protection\n• Verification System\n• 75+ Commands', inline: true },
      ).setFooter({ text: 'WebzHook Guard v3.0' }).setTimestamp()],
    components: [row],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  MEMBER JOIN — welcome + auto-role + raid detection
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  const s = db.getGuild(member.guild.id);

  // Anti-Raid
  if (s.enabled && s.detectionEnabled && s.modules.antiRaid) {
    const t = s.thresholds;
    const joinCount = spam.trackRaid(member.guild.id, t.raidSeconds * 1000);
    if (joinCount >= t.raidJoins) {
      for (const [, ch] of member.guild.channels.cache) {
        if (ch.isTextBased())
          await ch.permissionOverwrites.edit(member.guild.roles.everyone, { SendMessages: false }).catch(() => {});
      }
      const e = new EmbedBuilder().setColor(C.RED).setTitle('🚨 RAID DETECTED — Server Locked')
        .setDescription(`**${joinCount} users** joined within ${t.raidSeconds}s. All channels locked.`)
        .addFields({ name: 'Unlock', value: '`%unlockdown` to restore access' })
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
      await sendLog(member.guild, e);
    }
  }

  // Welcome
  if (s.modules.welcomeSystem && s.welcomeChannelId) {
    const ch = member.guild.channels.cache.get(s.welcomeChannelId);
    if (ch) {
      const msg = formatMessage(s.welcomeMessage, member);
      const embed = new EmbedBuilder().setColor(C.GREEN)
        .setTitle('👋 Welcome!')
        .setDescription(msg)
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: member.guild.name }).setTimestamp();
      await ch.send({ embeds: [embed] }).catch(() => {});
    }
  }

  // Auto-role
  if (s.modules.autoRole && s.autoRoles.length > 0) {
    for (const roleId of s.autoRoles) {
      const role = member.guild.roles.cache.get(roleId);
      if (role) await member.roles.add(role).catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  MEMBER LEAVE — leave message
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  const s = db.getGuild(member.guild.id);
  if (s.modules.leaveSystem && s.leaveChannelId) {
    const ch = member.guild.channels.cache.get(s.leaveChannelId);
    if (ch) {
      const msg = formatMessage(s.leaveMessage, member);
      await ch.send({ embeds: [new EmbedBuilder().setColor(C.ORANGE)
        .setTitle('👋 Member Left').setDescription(msg)
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: member.guild.name }).setTimestamp()] }).catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ROLE HIERARCHY GUARD
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildMemberUpdate', async (oldM, newM) => {
  const s = db.getGuild(newM.guild.id);
  if (!s.enabled || !s.detectionEnabled) return;
  if (hasBotAccess(newM) || s.whitelist.includes(newM.id)) return;

  const added = newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id));
  for (const [, role] of added) {
    const forbidden  = s.forbiddenRoles.includes(role.id);
    const aboveMax   = s.maxRolePosition && role.position > s.maxRolePosition;
    if (forbidden || aboveMax) {
      await applyQuarantine(newM, newM.guild);
      const reason = forbidden ? `Received forbidden role: ${role.name}` : `Role above max position: ${role.name}`;
      db.addLog(newM.guild.id, { action:'AUTO_QUARANTINE', userId: newM.id, reason });
      await sendLog(newM.guild, new EmbedBuilder().setColor(C.RED).setTitle('🔒 Auto-Quarantine')
        .setDescription(`**${newM.user.tag}** quarantined.`)
        .addFields({ name:'Reason', value: reason })
        .setThumbnail(newM.user.displayAvatarURL()).setFooter({ text:'WebzHook Guard' }).setTimestamp());
      break;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ANTI-NUKE — channel/role delete audit
// ─────────────────────────────────────────────────────────────────────────────
async function handleNukeEvent(guild, eventName) {
  const s = db.getGuild(guild.id);
  if (!s.enabled || !s.detectionEnabled || !s.modules.antiNuke) return;
  try {
    const audits = await guild.fetchAuditLogs({ limit: 1 }).catch(() => null);
    if (!audits) return;
    const entry = audits.entries.first();
    if (!entry || Date.now() - entry.createdTimestamp > 5000) return;
    const exec = entry.executor;
    if (!exec || exec.id === client.user.id) return;
    const member = guild.members.cache.get(exec.id);
    if (member && (isOwner(member) || hasBotAccess(member))) return;
    if (s.whitelist.includes(exec.id)) return;

    const count = spam.trackNukeAction(exec.id, guild.id, s.thresholds.nukeActions * 3000);
    if (count >= (s.thresholds.nukeActions || 3)) {
      if (member) await member.ban({ reason: 'Anti-Nuke: Mass destructive actions' }).catch(() => {});
      else await guild.members.ban(exec.id, { reason: 'Anti-Nuke: Mass destructive actions' }).catch(() => {});
      db.addLog(guild.id, { action: 'AUTO_BAN', userId: exec.id, reason: `Anti-Nuke: ${eventName}` });
      await sendLog(guild, new EmbedBuilder().setColor(C.RED).setTitle('💣 NUKE ATTEMPT — User Banned')
        .addFields(
          { name: 'User', value: `${exec.tag} (${exec.id})`, inline: true },
          { name: 'Trigger', value: eventName, inline: true },
          { name: 'Actions', value: `${count} in window`, inline: true },
        ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
    }
  } catch (err) { /* silent */ }
}

client.on('channelDelete', ch => handleNukeEvent(ch.guild, 'Channel Delete'));
client.on('roleDelete',    r  => handleNukeEvent(r.guild,  'Role Delete'));
client.on('channelCreate', ch => handleNukeEvent(ch.guild, 'Channel Create Spam'));

// ─────────────────────────────────────────────────────────────────────────────
//  MESSAGE CREATE — detection + prefix commands
// ─────────────────────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (!message.guild) return;
  const s = db.getGuild(message.guild.id);

  // ── PREFIX COMMANDS ───────────────────────────────────────────────────────
  if (!message.author.bot && message.content.startsWith(config.PREFIX)) {
    const args    = message.content.slice(config.PREFIX.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    await handleCommand(command, args, message, s);
    return;
  }

  // ── DETECTION ─────────────────────────────────────────────────────────────
  if (!s.enabled || !s.detectionEnabled) return;
  if (message.author.bot && !message.webhookId) return;

  // Webhook detection
  if (message.webhookId) {
    const mc = message.mentions.users.size + message.mentions.roles.size;
    const ep = message.mentions.everyone;
    if (mc >= config.MASS_PING_THRESHOLD || ep || (config.BLOCK_ROLE_PINGS && message.mentions.roles.size > 0)) {
      await message.delete().catch(() => {});
      const wh = await client.fetchWebhook(message.webhookId).catch(() => null);
      if (wh) await wh.delete('Anti-webhook mass ping').catch(() => {});
      await sendLog(message.guild, new EmbedBuilder().setColor(C.RED).setTitle('🚨 Malicious Webhook Deleted')
        .addFields({ name:'Webhook', value: wh?.name||'Unknown', inline:true }, { name:'Channel', value:`<#${message.channelId}>`, inline:true })
        .setFooter({ text:'WebzHook Guard' }).setTimestamp());
    }
    return;
  }

  const member = message.member;
  if (!member) return;
  if (s.whitelist.includes(member.id)) return;
  const t = s.thresholds;

  // Bad word filter
  if (s.modules.badwordFilter && s.badwords.length > 0) {
    const lower = message.content.toLowerCase();
    if (s.badwords.some(w => lower.includes(w.toLowerCase()))) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, 'Prohibited word used', client.user.id);
      await message.channel.send({ embeds: [warnEmbed('Message Removed', `${message.author}, that word is not allowed here. (Warning ${warns.length})`)], })
        .then(m => setTimeout(() => m.delete().catch(()=>{}), 6000));
      return;
    }
  }

  // Invite filter
  if (s.modules.inviteFilter) {
    const inviteRegex = /(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9]+/i;
    if (inviteRegex.test(message.content)) {
      await message.delete().catch(() => {});
      await message.channel.send({ embeds: [warnEmbed('Invite Removed', `${message.author}, posting Discord invites is not allowed.`)] })
        .then(m => setTimeout(() => m.delete().catch(()=>{}), 5000));
      return;
    }
  }

  // Link filter
  if (s.modules.linkFilter) {
    const urlRegex = /https?:\/\/[^\s]+/gi;
    if (urlRegex.test(message.content) && !member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      await message.delete().catch(() => {});
      await message.channel.send({ embeds: [warnEmbed('Link Removed', `${message.author}, posting links is not allowed.`)] })
        .then(m => setTimeout(() => m.delete().catch(()=>{}), 5000));
      return;
    }
  }

  // Anti-mass ping
  if (s.modules.antiMassPing) {
    const mc = message.mentions.users.size + message.mentions.roles.size;
    if (mc >= (t.massPingMentions||5) || message.mentions.everyone) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, `Mass ping (${mc} mentions)`, client.user.id);
      if (warns.length >= 3) { await applyMute(member, message.guild); }
      await sendLog(message.guild, new EmbedBuilder().setColor(C.RED).setTitle('🚨 Mass Ping')
        .addFields({ name:'User', value:`${message.author}`, inline:true }, { name:'Mentions', value:`${mc}`, inline:true }, { name:'Warns', value:`${warns.length}`, inline:true })
        .setFooter({ text:'WebzHook Guard' }).setTimestamp());
      return;
    }
  }

  // Anti-spam
  if (s.modules.antiSpam) {
    const count = spam.trackSpam(message.author.id, message.guild.id, (t.spamSeconds||4)*1000);
    if (count >= (t.spamMessages||5)) {
      await applyMute(member, message.guild);
      setTimeout(() => removeMute(member, message.guild), (t.muteDuration||30)*1000);
      await sendLog(message.guild, new EmbedBuilder().setColor(C.ORANGE).setTitle('🔇 Auto-Mute: Spam')
        .addFields({ name:'User', value:`${message.author}`, inline:true }, { name:'Duration', value:`${t.muteDuration||30}s`, inline:true })
        .setFooter({ text:'WebzHook Guard' }).setTimestamp());
      return;
    }
  }

  // Anti-duplicate
  if (s.modules.antiDuplicate) {
    const dup = spam.trackDuplicate(message.author.id, message.guild.id, message.content);
    if (dup >= (t.duplicateCount||4)) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, 'Duplicate message spam', client.user.id);
      await sendLog(message.guild, new EmbedBuilder().setColor(C.YELLOW).setTitle('🔁 Duplicate Spam')
        .addFields({ name:'User', value:`${message.author}`, inline:true }, { name:'Count', value:`${dup}x`, inline:true }, { name:'Warns', value:`${warns.length}`, inline:true })
        .setFooter({ text:'WebzHook Guard' }).setTimestamp());
      return;
    }
  }

  // Anti-caps
  if (s.modules.antiCaps && message.content.length >= config.CAPS_MIN_LENGTH) {
    const letters = message.content.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 0) {
      const pct = (message.content.replace(/[^A-Z]/g,'').length / letters.length) * 100;
      if (pct >= (t.capsPercent||80)) {
        await message.delete().catch(() => {});
        await message.channel.send({ embeds: [warnEmbed('Caps Removed', `${message.author}, please don't use excessive caps.`)] })
          .then(m => setTimeout(() => m.delete().catch(()=>{}), 5000));
        return;
      }
    }
  }

  // Auto-slowmode (if a channel has too many messages)
  if (s.modules.slowmodeAuto) {
    const count2 = spam.trackSpam(`ch_${message.channelId}`, message.guild.id, 5000);
    if (count2 >= 15 && message.channel.rateLimitPerUser === 0) {
      await message.channel.setRateLimitPerUser(s.slowmodeAutoSeconds || 5).catch(() => {});
      setTimeout(() => message.channel.setRateLimitPerUser(0).catch(()=>{}), 30000);
    }
  }

  // Custom responses (auto-reply to keywords in message content)
  if (s.responses && Object.keys(s.responses).length > 0) {
    const lower = message.content.toLowerCase().trim();
    for (const [trigger, response] of Object.entries(s.responses)) {
      if (lower === trigger.toLowerCase() || lower.startsWith(config.PREFIX + trigger.toLowerCase())) {
        await message.reply({ content: response, allowedMentions: { repliedUser: false } });
        return;
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  INTERACTIONS — buttons, selects, modals
// ─────────────────────────────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isButton())            await handleButton(interaction);
    else if (interaction.isStringSelectMenu()) await handleSelect(interaction);
    else if (interaction.isUserSelectMenu())   await handleUserSelect(interaction);
    else if (interaction.isRoleSelectMenu())   await handleRoleSelect(interaction);
    else if (interaction.isModalSubmit())      await handleModal(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const reply = { content: '❌ An error occurred.', ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(()=>{});
    else await interaction.reply(reply).catch(()=>{});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  BUTTON HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleButton(i) {
  const s = db.getGuild(i.guild.id);

  // ── Quick setup
  if (i.customId === 'setup_start') {
    if (!isOwner(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied', 'Only the server owner can run setup.')], ephemeral: true });
    await i.deferReply({ ephemeral: true });
    await runSetup(i.guild);
    return i.editReply({ embeds: [successEmbed('Setup Complete!', 'All roles and channels have been created. Run `%enable` to activate the bot.')] });
  }

  // ── Verify (button mode)
  if (i.customId === 'verify_button') {
    if (!s.modules.verification || !s.verifiedRoleId) return i.reply({ embeds: [errorEmbed('Verification Disabled', 'Ask an admin to set up verification.')], ephemeral: true });
    const role = i.guild.roles.cache.get(s.verifiedRoleId);
    if (!role) return i.reply({ embeds: [errorEmbed('Role Missing', 'The verified role no longer exists.')], ephemeral: true });
    if (i.member.roles.cache.has(role.id)) return i.reply({ embeds: [infoEmbed('Already Verified', 'You are already verified!')], ephemeral: true });
    await i.member.roles.add(role);
    return i.reply({ embeds: [successEmbed('Verified!', 'Welcome! You now have access to the server.')], ephemeral: true });
  }

  // ── Verify (captcha mode) — show modal
  if (i.customId === 'verify_captcha') {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    captchaCodes.set(i.user.id, { code, guildId: i.guild.id, expires: Date.now() + 120000 });
    const modal = new ModalBuilder().setCustomId('captcha_submit').setTitle('Verification Captcha');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('captcha_code')
        .setLabel(`Enter this code: ${code}`)
        .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(6).setMaxLength(6)
    ));
    return i.showModal(modal);
  }

  // ── Moderation confirmation buttons
  if (i.customId.startsWith('confirm_ban_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const userId = i.customId.replace('confirm_ban_', '');
    await i.guild.members.ban(userId, { reason: `Banned by ${i.user.tag}` }).catch(() => {});
    await i.update({ embeds: [successEmbed('User Banned', `<@${userId}> has been permanently banned.`)], components: [] });
    db.addLog(i.guild.id, { action:'BAN', userId, modId: i.user.id });
    return;
  }

  if (i.customId === 'cancel_action') {
    return i.update({ embeds: [infoEmbed('Action Cancelled', 'No action was taken.')], components: [] });
  }

  // ── Help navigation
  if (i.customId.startsWith('help_')) {
    const page = i.customId.replace('help_', '');
    return i.update({ embeds: [buildHelpPage(page)], components: [buildHelpComponents(page)] });
  }

  // ── Module toggles from setup wizard
  if (i.customId.startsWith('toggle_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const mod = i.customId.replace('toggle_', '');
    const s2  = db.getGuild(i.guild.id);
    s2.modules[mod] = !s2.modules[mod];
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Module Updated', `**${mod}** is now **${s2.modules[mod] ? 'enabled' : 'disabled'}**.`)], ephemeral: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SELECT MENU HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
async function handleSelect(i) {
  // Help page select
  if (i.customId === 'help_select') {
    const page = i.values[0];
    return i.update({ embeds: [buildHelpPage(page)], components: [buildHelpComponents(page)] });
  }

  // Warn action select
  if (i.customId.startsWith('warn_action_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const userId = i.customId.replace('warn_action_', '');
    const action = i.values[0];
    const member = i.guild.members.cache.get(userId);
    if (!member) return i.reply({ embeds: [errorEmbed('User Not Found')], ephemeral: true });

    if (action === 'mute')    { await applyMute(member, i.guild); return i.update({ embeds: [successEmbed('User Muted', `<@${userId}> has been muted.`)], components: [] }); }
    if (action === 'kick')    { await member.kick('Warned user kicked'); return i.update({ embeds: [successEmbed('User Kicked')], components: [] }); }
    if (action === 'ban')     { await member.ban({ reason: 'Warned user banned' }); return i.update({ embeds: [successEmbed('User Banned')], components: [] }); }
    if (action === 'dismiss') { return i.update({ embeds: [infoEmbed('Dismissed', 'No additional action taken.')], components: [] }); }
  }

  // Module bulk enable/disable
  if (i.customId === 'modules_select') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const s2 = db.getGuild(i.guild.id);
    const selected = i.values;
    for (const key of Object.keys(s2.modules)) s2.modules[key] = false;
    for (const mod of selected) s2.modules[mod] = true;
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Modules Updated', `Enabled: ${selected.map(m => `\`${m}\``).join(', ') || 'none'}`)], ephemeral: true });
  }
}

async function handleUserSelect(i) {
  if (i.customId === 'whitelist_add') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const s2 = db.getGuild(i.guild.id);
    for (const u of i.values) { if (!s2.whitelist.includes(u)) s2.whitelist.push(u); }
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Whitelist Updated', i.values.map(u => `<@${u}>`).join(', ') + ' added.')], ephemeral: true });
  }
}

async function handleRoleSelect(i) {
  if (i.customId === 'autorole_set') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const s2 = db.getGuild(i.guild.id);
    s2.autoRoles = i.values;
    s2.modules.autoRole = true;
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Auto-Role Set', i.values.map(r => `<@&${r}>`).join(', ') + ' will be given to new members.')], ephemeral: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODAL HANDLER
// ─────────────────────────────────────────────────────────────────────────────
const captchaCodes = new Map();

async function handleModal(i) {
  // Captcha
  if (i.customId === 'captcha_submit') {
    const session = captchaCodes.get(i.user.id);
    if (!session || session.guildId !== i.guild.id) return i.reply({ embeds: [errorEmbed('Session Expired', 'Click Verify again to get a new code.')], ephemeral: true });
    if (Date.now() > session.expires) {
      captchaCodes.delete(i.user.id);
      return i.reply({ embeds: [errorEmbed('Code Expired', 'Your code expired. Click Verify again.')], ephemeral: true });
    }
    const input = i.fields.getTextInputValue('captcha_code').trim().toUpperCase();
    if (input !== session.code) return i.reply({ embeds: [errorEmbed('Wrong Code', 'Incorrect code. Try again.')], ephemeral: true });
    captchaCodes.delete(i.user.id);
    const s2 = db.getGuild(i.guild.id);
    const role = i.guild.roles.cache.get(s2.verifiedRoleId);
    if (role) await i.member.roles.add(role);
    return i.reply({ embeds: [successEmbed('Verified!', 'You now have access to the server.')], ephemeral: true });
  }

  // Custom command create modal
  if (i.customId === 'custom_cmd_modal') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const name     = i.fields.getTextInputValue('cmd_name').toLowerCase().trim();
    const response = i.fields.getTextInputValue('cmd_response');
    const s2 = db.getGuild(i.guild.id);
    s2.responses[name] = response;
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Command Created', `\`%${name}\` now responds with: ${response}`)], ephemeral: true });
  }

  // Warn reason modal
  if (i.customId.startsWith('warn_modal_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const userId = i.customId.replace('warn_modal_', '');
    const reason = i.fields.getTextInputValue('warn_reason');
    const warns  = db.addWarn(i.guild.id, userId, reason, i.user.id);
    db.addLog(i.guild.id, { action:'WARN', userId, modId: i.user.id, reason });

    const target = i.guild.members.cache.get(userId);
    if (warns.length >= 3 && target) await applyMute(target, i.guild);
    if (warns.length >= 5 && target) await target.ban({ reason: `Auto-ban: ${warns.length} warnings` });

    // Offer further action
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`warn_action_${userId}`).setPlaceholder('Take additional action...')
        .addOptions(
          { label: 'Mute',    value: 'mute',    emoji: '🔇', description: 'Mute the user now' },
          { label: 'Kick',    value: 'kick',    emoji: '👢', description: 'Kick the user now' },
          { label: 'Ban',     value: 'ban',     emoji: '🔨', description: 'Ban the user now' },
          { label: 'Dismiss', value: 'dismiss', emoji: '✅', description: 'No further action' },
        )
    );
    return i.reply({
      embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Warning Issued')
        .addFields(
          { name:'User', value:`<@${userId}>`, inline:true },
          { name:'Reason', value:reason, inline:true },
          { name:'Total Warns', value:`${warns.length}`, inline:true },
          { name:'Auto-Actions', value: warns.length>=5 ? '🔨 Auto-banned' : warns.length>=3 ? '🔇 Auto-muted' : 'None', inline:true },
        ).setFooter({ text:'WebzHook Guard' }).setTimestamp()],
      components: [row],
      ephemeral: true,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function runSetup(guild) {
  const steps = [];
  try {
    await getOrCreateRole(guild, config.BOT_ACCESS_ROLE, { color: C.BLUE, reason: 'WebzHook Guard setup' });
    steps.push('✅ Bot Manager role');
  } catch { steps.push('❌ Bot Manager role'); }

  try {
    const qr = await getOrCreateRole(guild, config.QUARANTINE_ROLE, { color: C.GREY, reason: 'WebzHook Guard setup' });
    for (const [, ch] of guild.channels.cache) {
      await ch.permissionOverwrites.edit(qr, { SendMessages: false, AddReactions: false, ViewChannel: false }).catch(() => {});
    }
    steps.push('✅ Quarantine role');
  } catch { steps.push('❌ Quarantine role'); }

  try {
    const mr = await getOrCreateRole(guild, config.MUTE_ROLE, { color: C.GREY, reason: 'WebzHook Guard setup' });
    for (const [, ch] of guild.channels.cache) {
      if (ch.isTextBased()) await ch.permissionOverwrites.edit(mr, { SendMessages: false }).catch(() => {});
    }
    steps.push('✅ Mute role');
  } catch { steps.push('❌ Mute role'); }

  try {
    let logCh = guild.channels.cache.find(c => c.name === 'webzhook-logs');
    if (!logCh) logCh = await guild.channels.create({
      name: 'webzhook-logs', type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        { id: guild.members.me,     allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      ],
      reason: 'WebzHook Guard logs',
    });
    db.updateGuild(guild.id, { logChannelId: logCh.id, setupDone: true });
    steps.push('✅ Log channel');
  } catch { steps.push('❌ Log channel'); }

  return steps;
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELP SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
function buildHelpPage(page) {
  const pages = {
    main: new EmbedBuilder().setColor(C.BLUE).setTitle('📖 WebzHook Guard — Commands')
      .setDescription('Select a category from the dropdown below.')
      .addFields(
        { name: '⚙️ Setup',       value: '`%setup` `%enable` `%disable` `%setlog`', inline: true },
        { name: '🔨 Moderation',  value: '`%ban` `%kick` `%mute` `%warn` `%purge`', inline: true },
        { name: '🛡️ Security',    value: '`%toggle` `%whitelist` `%quarantine`',     inline: true },
        { name: '🔐 Verify',      value: '`%setupverify` `%setverifymode`',           inline: true },
        { name: '⚡ Utility',     value: '`%userinfo` `%serverinfo` `%ping`',         inline: true },
        { name: '📊 Info',        value: '`%status` `%warnings` `%logs`',             inline: true },
      ).setFooter({ text: 'Prefix: % — Responses are ephemeral' }).setTimestamp(),

    setup: new EmbedBuilder().setColor(C.PURPLE).setTitle('⚙️ Setup Commands')
      .addFields(
        { name: '`%setup`',              value: 'Auto-create all roles & channels (Owner)' },
        { name: '`%enable`',             value: 'Activate the bot (Owner)' },
        { name: '`%disable`',            value: 'Deactivate the bot (Owner)' },
        { name: '`%setlog #channel`',    value: 'Set the log channel' },
        { name: '`%setprefix <prefix>`', value: 'Change the command prefix' },
        { name: '`%toggle <module>`',    value: 'Toggle a module on/off' },
        { name: '`%modules`',            value: 'View all modules with a selector UI' },
        { name: '`%autorole @role`',     value: 'Set auto-role for new members' },
        { name: '`%welcome`',            value: 'Configure welcome messages' },
        { name: '`%setwelcome <msg>`',   value: 'Set welcome message' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    moderation: new EmbedBuilder().setColor(C.RED).setTitle('🔨 Moderation Commands')
      .addFields(
        { name: '`%ban @user [reason]`',          value: 'Permanently ban' },
        { name: '`%tempban @user <dur> [reason]`', value: 'Temp-ban (10m, 2h, 1d)' },
        { name: '`%unban <userId>`',               value: 'Unban by ID' },
        { name: '`%kick @user [reason]`',          value: 'Kick a member' },
        { name: '`%mute @user [dur] [reason]`',    value: 'Mute a member' },
        { name: '`%unmute @user`',                 value: 'Unmute a member' },
        { name: '`%warn @user <reason>`',          value: 'Warn (modal + action selector)' },
        { name: '`%warnings @user`',               value: 'View warnings' },
        { name: '`%clearwarns @user`',             value: 'Clear all warnings' },
        { name: '`%purge <1-100>`',                value: 'Bulk delete messages' },
        { name: '`%slowmode <seconds>`',           value: 'Set slowmode (0 = off)' },
        { name: '`%lock [reason]`',                value: 'Lock current channel' },
        { name: '`%unlock`',                       value: 'Unlock current channel' },
        { name: '`%lockdown`',                     value: 'Lock ALL channels' },
        { name: '`%unlockdown`',                   value: 'Unlock ALL channels' },
        { name: '`%nick @user <name>`',            value: 'Set nickname' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    security: new EmbedBuilder().setColor(C.ORANGE).setTitle('🛡️ Security Commands')
      .addFields(
        { name: '`%quarantine @user`',      value: 'Quarantine a user (remove all perms)' },
        { name: '`%unquarantine @user`',    value: 'Release from quarantine' },
        { name: '`%whitelist @user`',       value: 'Whitelist users (skip detection)' },
        { name: '`%unwhitelist @user`',     value: 'Remove from whitelist' },
        { name: '`%whitelistui`',           value: 'User-select dropdown whitelist' },
        { name: '`%blacklist @user`',       value: 'Permanently restrict a user' },
        { name: '`%setmaxrole <pos>`',      value: 'Set max role position' },
        { name: '`%forbiddenrole @role`',   value: 'Add forbidden role (auto-quarantine)' },
        { name: '`%unforbiddenrole @role`', value: 'Remove forbidden role' },
        { name: '`%addbadword <word>`',     value: 'Add word to filter' },
        { name: '`%removebadword <word>`',  value: 'Remove word from filter' },
        { name: '`%badwords`',              value: 'List all filtered words' },
        { name: '`%disable-bot <dur>`',     value: 'Temporarily pause detection' },
        { name: '`%enable-bot`',            value: 'Re-enable detection' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    utility: new EmbedBuilder().setColor(C.TEAL).setTitle('⚡ Utility Commands')
      .addFields(
        { name: '`%ping`',            value: 'Bot latency' },
        { name: '`%uptime`',          value: 'Bot uptime' },
        { name: '`%userinfo [@user]`', value: 'User information card' },
        { name: '`%serverinfo`',      value: 'Server information card' },
        { name: '`%roleinfo @role`',  value: 'Role information' },
        { name: '`%avatar [@user]`',  value: 'Get user avatar' },
        { name: '`%membercount`',     value: 'Server member count' },
        { name: '`%status`',          value: 'Bot settings & status' },
        { name: '`%logs`',            value: 'View recent mod actions' },
        { name: '`%warnings @user`',  value: 'View user warnings' },
        { name: '`%addresponse`',     value: 'Add a custom auto-response (modal)' },
        { name: '`%delresponse <key>`', value: 'Remove a custom response' },
        { name: '`%responses`',       value: 'List all custom responses' },
        { name: '`%invite`',          value: 'Get bot invite link' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),
  };
  return pages[page] || pages.main;
}

function buildHelpComponents(active = 'main') {
  const select = new StringSelectMenuBuilder()
    .setCustomId('help_select').setPlaceholder('📖 Browse categories...')
    .addOptions(
      { label: 'Overview',    value: 'main',       emoji: '🏠', default: active==='main' },
      { label: 'Setup',       value: 'setup',      emoji: '⚙️', default: active==='setup' },
      { label: 'Moderation',  value: 'moderation', emoji: '🔨', default: active==='moderation' },
      { label: 'Security',    value: 'security',   emoji: '🛡️', default: active==='security' },
      { label: 'Utility',     value: 'utility',    emoji: '⚡', default: active==='utility' },
    );
  return new ActionRowBuilder().addComponents(select);
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMMAND HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleCommand(command, args, message, s) {
  const { guild, member, channel } = message;
  const ephReply = (embed, comps = []) => {
    // Delete command message for cleanliness, reply with ephemeral feel
    message.delete().catch(() => {});
    return channel.send({ embeds: [embed], components: comps })
      .then(m => {
        if (!comps.length) setTimeout(() => m.delete().catch(() => {}), 12000);
      });
  };

  // ── HELP ────────────────────────────────────────────────────────────────
  if (command === 'help') {
    const page = args[0]?.toLowerCase() || 'main';
    message.delete().catch(() => {});
    return channel.send({ embeds: [buildHelpPage(page)], components: [buildHelpComponents(page)] });
  }

  // ── PING ────────────────────────────────────────────────────────────────
  if (command === 'ping') {
    return ephReply(infoEmbed('Pong! 🏓', `Latency: **${Date.now() - message.createdTimestamp}ms**\nAPI: **${Math.round(client.ws.ping)}ms**`));
  }

  // ── UPTIME ──────────────────────────────────────────────────────────────
  if (command === 'uptime') {
    return ephReply(infoEmbed('⏱️ Uptime', formatDuration(process.uptime() * 1000)));
  }

  // ── SETUP ───────────────────────────────────────────────────────────────
  if (command === 'setup') {
    if (!isOwner(member)) return ephReply(errorEmbed('Access Denied', 'Owner only.'));
    message.delete().catch(() => {});
    const msg = await channel.send({ embeds: [infoEmbed('Setting up...', 'Creating roles and channels...')] });
    const steps = await runSetup(guild);
    return msg.edit({ embeds: [new EmbedBuilder().setColor(C.GREEN).setTitle('⚙️ Setup Complete')
      .setDescription(steps.join('\n'))
      .addFields({ name: 'Next', value: 'Run `%enable` to activate the bot.' })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  // ── ENABLE / DISABLE ────────────────────────────────────────────────────
  if (command === 'enable') {
    if (!isOwner(member)) return ephReply(errorEmbed('Access Denied', 'Owner only.'));
    db.updateGuild(guild.id, { enabled: true, detectionEnabled: true });
    return ephReply(successEmbed('Bot Enabled', 'WebzHook Guard is now **active** and protecting this server.'));
  }

  if (command === 'disable') {
    if (!isOwner(member)) return ephReply(errorEmbed('Access Denied', 'Owner only.'));
    db.updateGuild(guild.id, { enabled: false, detectionEnabled: false });
    return ephReply(warnEmbed('Bot Disabled', 'Protection has been turned off.'));
  }

  // ── SETLOG ──────────────────────────────────────────────────────────────
  if (command === 'setlog') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const ch2 = message.mentions.channels.first();
    if (!ch2) return ephReply(errorEmbed('Usage', '`%setlog #channel`'));
    db.updateGuild(guild.id, { logChannelId: ch2.id });
    return ephReply(successEmbed('Log Channel Set', `Logs will be sent to ${ch2}.`));
  }

  // ── SETPREFIX ───────────────────────────────────────────────────────────
  if (command === 'setprefix') {
    if (!isOwner(member)) return ephReply(errorEmbed('Access Denied', 'Owner only.'));
    const p = args[0];
    if (!p || p.length > 3) return ephReply(errorEmbed('Invalid Prefix', 'Must be 1–3 characters.'));
    db.updateGuild(guild.id, { prefix: p });
    config.PREFIX = p;
    return ephReply(successEmbed('Prefix Updated', `New prefix: \`${p}\``));
  }

  // ── MODULES ─────────────────────────────────────────────────────────────
  if (command === 'modules') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const moduleList = Object.entries(s.modules);
    const select = new StringSelectMenuBuilder()
      .setCustomId('modules_select').setPlaceholder('Select modules to ENABLE (all others will be disabled)...')
      .setMinValues(0).setMaxValues(moduleList.length)
      .addOptions(moduleList.map(([k, v]) => ({
        label: k, value: k,
        emoji: v ? '✅' : '❌',
        description: `Currently ${v ? 'enabled' : 'disabled'}`,
        default: v,
      })));
    message.delete().catch(() => {});
    return channel.send({
      embeds: [infoEmbed('Module Manager', 'Select which modules to enable. Unselected modules will be **disabled**.')],
      components: [new ActionRowBuilder().addComponents(select)],
    });
  }

  // ── TOGGLE ──────────────────────────────────────────────────────────────
  if (command === 'toggle') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const mod = args[0]?.toLowerCase();
    if (!mod || s.modules[mod] === undefined) {
      const list = Object.keys(s.modules).join(', ');
      return ephReply(warnEmbed('Usage', `\`%toggle <module>\`\nAvailable: ${list}`));
    }
    s.modules[mod] = !s.modules[mod];
    db.saveGuild(guild.id, s);
    return ephReply(successEmbed('Module Toggled', `**${mod}** is now **${s.modules[mod] ? 'ON ✅' : 'OFF ❌'}**`));
  }

  // ── BAN ─────────────────────────────────────────────────────────────────
  if (command === 'ban') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return ephReply(errorEmbed('Usage', '`%ban @user [reason]`'));
    if (!target.bannable) return ephReply(errorEmbed('Cannot Ban', 'I cannot ban this user.'));
    const reason = args.slice(1).join(' ') || 'No reason provided';

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`confirm_ban_${target.id}`).setLabel('✅ Confirm Ban').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('cancel_action').setLabel('❌ Cancel').setStyle(ButtonStyle.Secondary)
    );
    message.delete().catch(() => {});
    return channel.send({
      embeds: [new EmbedBuilder().setColor(C.RED).setTitle('⚠️ Confirm Ban')
        .addFields({ name:'User', value:`${target}`, inline:true }, { name:'Reason', value:reason, inline:true })
        .setFooter({ text: 'This will take effect immediately' })],
      components: [row],
    });
  }

  // ── TEMPBAN ─────────────────────────────────────────────────────────────
  if (command === 'tempban') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target || !args[1]) return ephReply(errorEmbed('Usage', '`%tempban @user <duration> [reason]`'));
    const ms = parseDuration(args[1]);
    if (!ms) return ephReply(errorEmbed('Invalid Duration', 'Use: `10m`, `2h`, `1d`'));
    const reason = args.slice(2).join(' ') || 'No reason provided';
    await target.ban({ reason });
    setTimeout(() => guild.members.unban(target.id).catch(() => {}), ms);
    db.addLog(guild.id, { action:'TEMPBAN', userId:target.id, modId:member.id, reason, duration:ms });
    await sendLog(guild, new EmbedBuilder().setColor(C.RED).setTitle('⏱️ Temp-Ban')
      .addFields({ name:'User', value:`${target.user.tag}`, inline:true }, { name:'Duration', value:formatDuration(ms), inline:true }, { name:'By', value:`${member.user.tag}`, inline:true }, { name:'Reason', value:reason })
      .setFooter({ text:'WebzHook Guard' }).setTimestamp());
    return ephReply(successEmbed('Temp-Banned', `${target.user.tag} banned for ${formatDuration(ms)}.`));
  }

  // ── UNBAN ───────────────────────────────────────────────────────────────
  if (command === 'unban') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const uid = args[0];
    if (!uid) return ephReply(errorEmbed('Usage', '`%unban <userId>`'));
    await guild.members.unban(uid).catch(() => {});
    return ephReply(successEmbed('Unbanned', `User \`${uid}\` has been unbanned.`));
  }

  // ── KICK ────────────────────────────────────────────────────────────────
  if (command === 'kick') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return ephReply(errorEmbed('Usage', '`%kick @user [reason]`'));
    if (!target.kickable) return ephReply(errorEmbed('Cannot Kick'));
    const reason = args.slice(1).join(' ') || 'No reason provided';
    await target.kick(reason);
    db.addLog(guild.id, { action:'KICK', userId:target.id, modId:member.id, reason });
    await sendLog(guild, new EmbedBuilder().setColor(C.ORANGE).setTitle('👢 Kick')
      .addFields({ name:'User', value:`${target.user.tag}`, inline:true }, { name:'By', value:`${member.user.tag}`, inline:true }, { name:'Reason', value:reason })
      .setFooter({ text:'WebzHook Guard' }).setTimestamp());
    return ephReply(successEmbed('Kicked', `${target.user.tag} has been kicked. Reason: ${reason}`));
  }

  // ── MUTE ────────────────────────────────────────────────────────────────
  if (command === 'mute') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return ephReply(errorEmbed('Usage', '`%mute @user [duration] [reason]`'));
    const ms     = args[1] ? parseDuration(args[1]) : null;
    const reason = args.slice(ms?2:1).join(' ') || 'No reason provided';
    await applyMute(target, guild);
    if (ms) setTimeout(() => removeMute(target, guild), ms);
    db.addLog(guild.id, { action:'MUTE', userId:target.id, modId:member.id, reason });
    await sendLog(guild, new EmbedBuilder().setColor(C.ORANGE).setTitle('🔇 Mute')
      .addFields({ name:'User', value:`${target.user.tag}`, inline:true }, { name:'Duration', value: ms ? formatDuration(ms) : 'Indefinite', inline:true }, { name:'By', value:`${member.user.tag}`, inline:true }, { name:'Reason', value:reason })
      .setFooter({ text:'WebzHook Guard' }).setTimestamp());
    return ephReply(successEmbed('Muted', `${target.user.tag} muted${ms ? ` for ${formatDuration(ms)}` : ' indefinitely'}.`));
  }

  // ── UNMUTE ──────────────────────────────────────────────────────────────
  if (command === 'unmute') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return ephReply(errorEmbed('Usage', '`%unmute @user`'));
    await removeMute(target, guild);
    return ephReply(successEmbed('Unmuted', `${target.user.tag} has been unmuted.`));
  }

  // ── WARN ────────────────────────────────────────────────────────────────
  if (command === 'warn') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return ephReply(errorEmbed('Usage', '`%warn @user <reason>`'));
    message.delete().catch(() => {});

    // Show modal for reason input
    const modal = new ModalBuilder().setCustomId(`warn_modal_${target.id}`).setTitle(`Warn ${target.user.username}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('warn_reason').setLabel('Reason').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
    ));
    // Can't show modal from non-interaction, so do it inline
    const reason = args.slice(1).join(' ');
    if (!reason) {
      return channel.send({ embeds: [errorEmbed('Reason Required', 'Use: `%warn @user <reason>`')] })
        .then(m => setTimeout(() => m.delete().catch(()=>{}), 8000));
    }
    const warns = db.addWarn(guild.id, target.id, reason, member.id);
    db.addLog(guild.id, { action:'WARN', userId:target.id, modId:member.id, reason });
    if (warns.length >= 3) await applyMute(target, guild);
    if (warns.length >= 5) await target.ban({ reason: `Auto-ban: ${warns.length} warnings` });

    const actionRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`warn_action_${target.id}`).setPlaceholder('Additional action...')
        .addOptions(
          { label:'Mute',    value:'mute',    emoji:'🔇' },
          { label:'Kick',    value:'kick',    emoji:'👢' },
          { label:'Ban',     value:'ban',     emoji:'🔨' },
          { label:'Dismiss', value:'dismiss', emoji:'✅' },
        )
    );
    await sendLog(guild, new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Warn')
      .addFields({ name:'User', value:`${target.user.tag}`, inline:true }, { name:'Warns', value:`${warns.length}`, inline:true }, { name:'By', value:`${member.user.tag}`, inline:true }, { name:'Reason', value:reason })
      .setFooter({ text:'WebzHook Guard' }).setTimestamp());
    return channel.send({
      embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Warning Issued')
        .addFields({ name:'User', value:`${target}`, inline:true }, { name:'Total Warns', value:`${warns.length}`, inline:true }, { name:'Reason', value:reason })
        .setFooter({ text:'WebzHook Guard' }).setTimestamp()],
      components: [actionRow],
    }).then(m => setTimeout(() => m.delete().catch(()=>{}), 30000));
  }

  // ── WARNINGS ────────────────────────────────────────────────────────────
  if (command === 'warnings') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first() || member;
    const warns  = db.getWarns(guild.id, target.id);
    const list   = warns.length ? warns.map((w,i) => `**${i+1}.** ${w.reason} — <t:${Math.floor(new Date(w.ts).getTime()/1000)}:R>`).join('\n') : '*No warnings*';
    return ephReply(new EmbedBuilder().setColor(C.YELLOW).setTitle(`⚠️ Warnings — ${target.user.username}`)
      .setDescription(list).addFields({ name:'Total', value:`${warns.length}`, inline:true })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text:'WebzHook Guard' }).setTimestamp());
  }

  // ── CLEARWARNS ──────────────────────────────────────────────────────────
  if (command === 'clearwarns') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return ephReply(errorEmbed('Usage', '`%clearwarns @user`'));
    db.clearWarns(guild.id, target.id);
    db.addLog(guild.id, { action:'CLEAR_WARNS', userId:target.id, modId:member.id });
    return ephReply(successEmbed('Warnings Cleared', `All warnings for ${target.user.tag} removed.`));
  }

  // ── PURGE ───────────────────────────────────────────────────────────────
  if (command === 'purge') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const n = parseInt(args[0]);
    if (isNaN(n) || n < 1 || n > 100) return ephReply(errorEmbed('Usage', '`%purge <1-100>`'));
    const deleted = await channel.bulkDelete(n, true).catch(() => null);
    const e = successEmbed('Purged', `Deleted ${deleted?.size ?? 0} messages.`);
    return channel.send({ embeds: [e] }).then(m => setTimeout(() => m.delete().catch(()=>{}), 5000));
  }

  // ── SLOWMODE ────────────────────────────────────────────────────────────
  if (command === 'slowmode') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const secs = parseInt(args[0]);
    if (isNaN(secs) || secs < 0 || secs > 21600) return ephReply(errorEmbed('Usage', '`%slowmode <0-21600>`'));
    await channel.setRateLimitPerUser(secs);
    return ephReply(successEmbed('Slowmode', secs === 0 ? 'Slowmode disabled.' : `Slowmode set to **${secs}s**.`));
  }

  // ── LOCK / UNLOCK ───────────────────────────────────────────────────────
  if (command === 'lock') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    return ephReply(successEmbed('Channel Locked', `${channel} has been locked.`));
  }

  if (command === 'unlock') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    return ephReply(successEmbed('Channel Unlocked', `${channel} has been unlocked.`));
  }

  if (command === 'lockdown') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    let n = 0;
    for (const [, ch2] of guild.channels.cache) {
      if (ch2.isTextBased()) { await ch2.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(()=>{}); n++; }
    }
    await sendLog(guild, new EmbedBuilder().setColor(C.RED).setTitle('🔒 Server Lockdown')
      .addFields({ name:'By', value:`${member.user.tag}`, inline:true }, { name:'Channels', value:`${n}`, inline:true })
      .setFooter({ text:'WebzHook Guard' }).setTimestamp());
    return ephReply(successEmbed('Lockdown Active', `${n} channels locked. Run \`%unlockdown\` to restore.`));
  }

  if (command === 'unlockdown') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    for (const [, ch2] of guild.channels.cache) {
      if (ch2.isTextBased()) await ch2.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(()=>{});
    }
    return ephReply(successEmbed('Lockdown Lifted', 'All channels have been unlocked.'));
  }

  // ── NICK ────────────────────────────────────────────────────────────────
  if (command === 'nick') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return ephReply(errorEmbed('Usage', '`%nick @user <nickname>`'));
    const nick = args.slice(1).join(' ') || null;
    await target.setNickname(nick);
    return ephReply(successEmbed('Nickname Updated', nick ? `Set to: **${nick}**` : 'Nickname reset.'));
  }

  // ── QUARANTINE / UNQUARANTINE ───────────────────────────────────────────
  if (command === 'quarantine') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return ephReply(errorEmbed('Usage', '`%quarantine @user`'));
    await applyQuarantine(target, guild);
    db.addLog(guild.id, { action:'QUARANTINE', userId:target.id, modId:member.id });
    return ephReply(successEmbed('Quarantined', `${target.user.tag} has been isolated.`));
  }

  if (command === 'unquarantine') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return ephReply(errorEmbed('Usage', '`%unquarantine @user`'));
    const r = guild.roles.cache.find(r2 => r2.name === config.QUARANTINE_ROLE);
    if (r) await target.roles.remove(r);
    return ephReply(successEmbed('Released', `${target.user.tag} is no longer quarantined.`));
  }

  // ── WHITELIST ───────────────────────────────────────────────────────────
  if (command === 'whitelist') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const mentioned = [...message.mentions.users.values()];
    if (!mentioned.length) return ephReply(errorEmbed('Usage', '`%whitelist @user`'));
    const s2 = db.getGuild(guild.id);
    for (const u of mentioned) if (!s2.whitelist.includes(u.id)) s2.whitelist.push(u.id);
    db.saveGuild(guild.id, s2);
    return ephReply(successEmbed('Whitelist Updated', mentioned.map(u=>`<@${u.id}>`).join(', ') + ' are now exempt from detection.'));
  }

  if (command === 'unwhitelist') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const mentioned = [...message.mentions.users.values()];
    const s2 = db.getGuild(guild.id);
    s2.whitelist = s2.whitelist.filter(id => !mentioned.find(u => u.id === id));
    db.saveGuild(guild.id, s2);
    return ephReply(successEmbed('Whitelist Updated', mentioned.map(u=>`<@${u.id}>`).join(', ') + ' removed from whitelist.'));
  }

  if (command === 'whitelistui') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const sel = new UserSelectMenuBuilder().setCustomId('whitelist_add').setPlaceholder('Select users to whitelist...').setMaxValues(10);
    message.delete().catch(() => {});
    return channel.send({ embeds: [infoEmbed('Whitelist', 'Select users to add to the whitelist.')], components: [new ActionRowBuilder().addComponents(sel)] });
  }

  // ── BADWORDS ────────────────────────────────────────────────────────────
  if (command === 'addbadword') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const word = args[0]?.toLowerCase();
    if (!word) return ephReply(errorEmbed('Usage', '`%addbadword <word>`'));
    const s2 = db.getGuild(guild.id);
    if (!s2.badwords.includes(word)) { s2.badwords.push(word); s2.modules.badwordFilter = true; }
    db.saveGuild(guild.id, s2);
    return ephReply(successEmbed('Word Added', `\`${word}\` added to the filter. Bad word filter enabled.`));
  }

  if (command === 'removebadword') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const word = args[0]?.toLowerCase();
    const s2   = db.getGuild(guild.id);
    s2.badwords = s2.badwords.filter(w => w !== word);
    db.saveGuild(guild.id, s2);
    return ephReply(successEmbed('Word Removed', `\`${word}\` removed from the filter.`));
  }

  if (command === 'badwords') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    return ephReply(infoEmbed('Filtered Words', s.badwords.length ? s.badwords.map(w => `\`${w}\``).join(', ') : '*None configured*'));
  }

  // ── AUTOROLE ────────────────────────────────────────────────────────────
  if (command === 'autorole') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    message.delete().catch(() => {});
    const sel = new RoleSelectMenuBuilder().setCustomId('autorole_set').setPlaceholder('Select roles to auto-assign...').setMaxValues(5);
    return channel.send({ embeds: [infoEmbed('Auto-Role Setup', 'Select roles to give to all new members.')], components: [new ActionRowBuilder().addComponents(sel)] });
  }

  // ── WELCOME ─────────────────────────────────────────────────────────────
  if (command === 'welcome') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const s2 = db.getGuild(guild.id);
    return ephReply(infoEmbed('Welcome Config',
      `**Status:** ${s2.modules.welcomeSystem ? '✅ Enabled' : '❌ Disabled'}\n**Channel:** ${s2.welcomeChannelId ? `<#${s2.welcomeChannelId}>` : 'Not set'}\n**Message:** ${s2.welcomeMessage}\n\nVariables: \`{user}\` \`{username}\` \`{server}\` \`{count}\``
    ));
  }

  if (command === 'setwelcome') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const ch2 = message.mentions.channels.first();
    const msg2 = args.slice(ch2 ? 1 : 0).join(' ');
    const s2   = db.getGuild(guild.id);
    if (ch2) s2.welcomeChannelId = ch2.id;
    if (msg2) s2.welcomeMessage = msg2;
    s2.modules.welcomeSystem = true;
    db.saveGuild(guild.id, s2);
    return ephReply(successEmbed('Welcome Updated', `Channel: ${ch2||'unchanged'}\nMessage: ${msg2||'unchanged'}`));
  }

  // ── CUSTOM RESPONSES ────────────────────────────────────────────────────
  if (command === 'addresponse') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    message.delete().catch(() => {});
    const modal = new ModalBuilder().setCustomId('custom_cmd_modal').setTitle('Add Custom Response');
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cmd_name').setLabel('Trigger word / command name').setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cmd_response').setLabel('Response text').setStyle(TextInputStyle.Paragraph).setRequired(true))
    );
    // Can't show modal from non-interaction; handle inline
    const key      = args[0]?.toLowerCase();
    const response = args.slice(1).join(' ');
    if (!key || !response) return channel.send({ embeds: [errorEmbed('Usage', '`%addresponse <key> <response text>`')] })
      .then(m => setTimeout(() => m.delete().catch(()=>{}), 8000));
    const s2 = db.getGuild(guild.id);
    s2.responses[key] = response;
    db.saveGuild(guild.id, s2);
    return channel.send({ embeds: [successEmbed('Response Added', `\`%${key}\` → ${response}`)] })
      .then(m => setTimeout(() => m.delete().catch(()=>{}), 8000));
  }

  if (command === 'delresponse') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const key = args[0]?.toLowerCase();
    if (!key) return ephReply(errorEmbed('Usage', '`%delresponse <key>`'));
    const s2 = db.getGuild(guild.id);
    delete s2.responses[key];
    db.saveGuild(guild.id, s2);
    return ephReply(successEmbed('Response Removed', `\`${key}\` has been deleted.`));
  }

  if (command === 'responses') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const keys = Object.keys(s.responses);
    return ephReply(infoEmbed('Custom Responses', keys.length ? keys.map(k => `\`%${k}\` → ${s.responses[k]}`).join('\n') : '*None configured*'));
  }

  // ── SETMAXROLE ──────────────────────────────────────────────────────────
  if (command === 'setmaxrole') {
    if (!isOwner(member)) return ephReply(errorEmbed('Access Denied', 'Owner only.'));
    const pos = parseInt(args[0]);
    if (isNaN(pos)) return ephReply(errorEmbed('Usage', '`%setmaxrole <position number>`'));
    db.updateGuild(guild.id, { maxRolePosition: pos });
    return ephReply(successEmbed('Max Role Set', `Users receiving roles above position **${pos}** will be auto-quarantined.`));
  }

  // ── FORBIDDENROLE ───────────────────────────────────────────────────────
  if (command === 'forbiddenrole') {
    if (!isOwner(member)) return ephReply(errorEmbed('Access Denied', 'Owner only.'));
    const role = message.mentions.roles.first();
    if (!role) return ephReply(errorEmbed('Usage', '`%forbiddenrole @role`'));
    const s2 = db.getGuild(guild.id);
    if (!s2.forbiddenRoles.includes(role.id)) s2.forbiddenRoles.push(role.id);
    db.saveGuild(guild.id, s2);
    return ephReply(successEmbed('Forbidden Role Added', `Anyone receiving **${role.name}** will be auto-quarantined.`));
  }

  if (command === 'unforbiddenrole') {
    if (!isOwner(member)) return ephReply(errorEmbed('Access Denied', 'Owner only.'));
    const role = message.mentions.roles.first();
    const s2   = db.getGuild(guild.id);
    s2.forbiddenRoles = s2.forbiddenRoles.filter(id => id !== role?.id);
    db.saveGuild(guild.id, s2);
    return ephReply(successEmbed('Removed', `**${role?.name}** removed from forbidden list.`));
  }

  // ── DISABLE-BOT / ENABLE-BOT ────────────────────────────────────────────
  if (command === 'disable-bot') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const ms = parseDuration(args[0]);
    if (!ms) return ephReply(errorEmbed('Usage', '`%disable-bot <duration>` e.g. `30m`'));
    db.updateGuild(guild.id, { detectionEnabled: false });
    setTimeout(() => db.updateGuild(guild.id, { detectionEnabled: true }), ms);
    return ephReply(warnEmbed('Detection Paused', `Detection disabled for **${formatDuration(ms)}**. Auto-resumes after.`));
  }

  if (command === 'enable-bot') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    db.updateGuild(guild.id, { detectionEnabled: true });
    return ephReply(successEmbed('Detection Enabled', 'All detection modules are now active.'));
  }

  // ── INFO COMMANDS ────────────────────────────────────────────────────────
  if (command === 'userinfo') {
    const target = message.mentions.members.first() || member;
    const warns  = db.getWarns(guild.id, target.id);
    const roles  = target.roles.cache.filter(r=>r.name!=='@everyone').map(r=>`${r}`).join(', ') || 'None';
    return ephReply(new EmbedBuilder().setColor(C.BLUE).setTitle(`👤 ${target.user.username}`)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name:'ID',              value: target.id,                                                     inline:true  },
        { name:'Joined Server',   value:`<t:${Math.floor(target.joinedTimestamp/1000)}:R>`,             inline:true  },
        { name:'Account Created', value:`<t:${Math.floor(target.user.createdTimestamp/1000)}:R>`,       inline:true  },
        { name:'Warnings',        value:`${warns.length}`,                                              inline:true  },
        { name:'Roles',           value: roles.length>1024 ? roles.slice(0,1020)+'...' : roles  },
      ).setFooter({ text:'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'serverinfo') {
    return ephReply(new EmbedBuilder().setColor(C.BLUE).setTitle(`🏠 ${guild.name}`)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name:'Owner',      value:`<@${guild.ownerId}>`,  inline:true },
        { name:'Members',    value:`${guild.memberCount}`, inline:true },
        { name:'Channels',   value:`${guild.channels.cache.size}`, inline:true },
        { name:'Roles',      value:`${guild.roles.cache.size}`,    inline:true },
        { name:'Boost Level',value:`${guild.premiumTier}`,         inline:true },
        { name:'Created',    value:`<t:${Math.floor(guild.createdTimestamp/1000)}:R>`, inline:true },
      ).setFooter({ text:'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'roleinfo') {
    const role = message.mentions.roles.first();
    if (!role) return ephReply(errorEmbed('Usage', '`%roleinfo @role`'));
    return ephReply(new EmbedBuilder().setColor(role.color||C.BLUE).setTitle(`🎭 ${role.name}`)
      .addFields(
        { name:'ID',          value: role.id,                inline:true },
        { name:'Color',       value: role.hexColor,          inline:true },
        { name:'Position',    value:`${role.position}`,      inline:true },
        { name:'Members',     value:`${role.members.size}`,  inline:true },
        { name:'Mentionable', value: role.mentionable?'Yes':'No', inline:true },
        { name:'Hoisted',     value: role.hoist?'Yes':'No',       inline:true },
      ).setFooter({ text:'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'avatar') {
    const target = message.mentions.users.first() || message.author;
    return ephReply(new EmbedBuilder().setColor(C.BLUE).setTitle(`🖼️ ${target.username}'s Avatar`)
      .setImage(target.displayAvatarURL({ size:512 })).setFooter({ text:'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'membercount') {
    const bots   = guild.members.cache.filter(m2=>m2.user.bot).size;
    const humans = guild.memberCount - bots;
    return ephReply(new EmbedBuilder().setColor(C.BLUE).setTitle('👥 Member Count')
      .addFields({ name:'Total', value:`${guild.memberCount}`, inline:true }, { name:'Humans', value:`${humans}`, inline:true }, { name:'Bots', value:`${bots}`, inline:true })
      .setFooter({ text:'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'status') {
    return ephReply(new EmbedBuilder().setColor(s.detectionEnabled ? C.GREEN : C.ORANGE).setTitle('📊 Server Status')
      .addFields(
        { name:'Bot',        value: s.enabled         ? '🟢 Active'   : '🔴 Disabled',   inline:true },
        { name:'Detection',  value: s.detectionEnabled? '🟢 Active'   : '🟡 Paused',     inline:true },
        { name:'Anti-Spam',  value: s.modules.antiSpam     ? '✅':'❌', inline:true },
        { name:'Anti-Raid',  value: s.modules.antiRaid     ? '✅':'❌', inline:true },
        { name:'Anti-Ping',  value: s.modules.antiMassPing ? '✅':'❌', inline:true },
        { name:'Anti-Nuke',  value: s.modules.antiNuke     ? '✅':'❌', inline:true },
        { name:'Anti-Caps',  value: s.modules.antiCaps     ? '✅':'❌', inline:true },
        { name:'Anti-Dup',   value: s.modules.antiDuplicate? '✅':'❌', inline:true },
        { name:'Invite Filter',value: s.modules.inviteFilter ? '✅':'❌', inline:true },
        { name:'Link Filter',  value: s.modules.linkFilter   ? '✅':'❌', inline:true },
        { name:'Bad Words',    value: s.modules.badwordFilter ? '✅':'❌', inline:true },
        { name:'Auto-Role',    value: s.modules.autoRole      ? '✅':'❌', inline:true },
        { name:'Welcome',      value: s.modules.welcomeSystem  ? '✅':'❌', inline:true },
        { name:'Verification', value: s.modules.verification   ? '✅':'❌', inline:true },
        { name:'Log Channel',  value: s.logChannelId ? `<#${s.logChannelId}>` : 'Not set', inline:true },
        { name:'Prefix',       value:`\`${s.prefix || '%'}\``, inline:true },
      ).setFooter({ text:'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'logs') {
    if (!hasBotAccess(member)) return ephReply(errorEmbed('Access Denied'));
    const logs = db.getLogs(guild.id, 15);
    if (!logs.length) return ephReply(infoEmbed('Mod Logs', '*No actions logged yet.*'));
    const list = logs.map(l => `\`${l.action}\` — <@${l.userId}> by <@${l.modId}> — <t:${Math.floor(new Date(l.ts).getTime()/1000)}:R>${l.reason ? `\n  ↳ ${l.reason}` : ''}`).join('\n');
    return ephReply(new EmbedBuilder().setColor(C.BLUE).setTitle('📋 Recent Mod Actions')
      .setDescription(list).setFooter({ text:'WebzHook Guard' }).setTimestamp());
  }

  // ── SETUPVERIFY ─────────────────────────────────────────────────────────
  if (command === 'setupverify') {
    if (!isOwner(member)) return ephReply(errorEmbed('Access Denied', 'Owner only.'));
    message.delete().catch(() => {});
    const msg2 = await channel.send({ embeds: [infoEmbed('Setting up verification...', 'Please wait.')] });

    const verifiedRole = await getOrCreateRole(guild, config.VERIFIED_ROLE, { color: C.GREEN, reason: 'Verification setup' });
    for (const [, ch2] of guild.channels.cache) {
      if (ch2.name !== 'verify') {
        await ch2.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }).catch(()=>{});
        await ch2.permissionOverwrites.edit(verifiedRole, { ViewChannel: true }).catch(()=>{});
      }
    }
    let verifyCh = guild.channels.cache.find(c2 => c2.name === 'verify');
    if (!verifyCh) verifyCh = await guild.channels.create({
      name:'verify', type:ChannelType.GuildText,
      permissionOverwrites:[
        { id:guild.roles.everyone, allow:[PermissionsBitField.Flags.ViewChannel], deny:[PermissionsBitField.Flags.SendMessages] },
        { id:guild.members.me,     allow:[PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel] },
        { id:verifiedRole,         deny:[PermissionsBitField.Flags.ViewChannel] },
      ]
    });
    db.updateGuild(guild.id, { verifyChannelId:verifyCh.id, verifiedRoleId:verifiedRole.id, 'modules.verification':true });
    const s3 = db.getGuild(guild.id);
    s3.modules.verification = true;
    db.saveGuild(guild.id, s3);

    const mode  = args[0]?.toLowerCase() === 'captcha' ? 'captcha' : 'button';
    const row   = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(mode === 'captcha' ? 'verify_captcha' : 'verify_button')
        .setLabel('✅ Verify Me').setStyle(ButtonStyle.Success)
    );
    await verifyCh.send({
      embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle('🔐 Verification Required')
        .setDescription(s3.verifyMessage || 'Click the button below to verify.')
        .setFooter({ text:'WebzHook Guard' }).setTimestamp()],
      components: [row],
    });
    return msg2.edit({ embeds: [successEmbed('Verification Setup', `Mode: **${mode}**\nVerify channel: ${verifyCh}\nVerified role: ${verifiedRole}`)] });
  }

  // ── INVITE ──────────────────────────────────────────────────────────────
  if (command === 'invite') {
    return ephReply(infoEmbed('📩 Invite Bot', `[Click here to invite WebzHook Guard](https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&scope=bot&permissions=8)`));
  }

  // ── CUSTOM COMMANDS + FUN COMMANDS ──────────────────────────────────────
  const custom = s.customCommands?.find(c2 => c2.name.toLowerCase() === command && c2.enabled !== false);
  if (custom) {
    try {
      const fn = new Function('message','args','guild','member', custom.code);
      await fn(message, args, guild, member);
    } catch (err) {
      return ephReply(errorEmbed('Command Error', `\`\`\`${err.message}\`\`\``));
    }
    return;
  }

  const fun = s.funCommands?.find(c2 => c2.name.toLowerCase() === command && c2.enabled !== false);
  if (fun) {
    const resp = fun.responses[Math.floor(Math.random() * fun.responses.length)];
    message.delete().catch(() => {});
    return channel.send({ content: resp.replace(/{user}/g, `<@${member.id}>`), allowedMentions: { users: [member.id] } })
      .then(m => setTimeout(() => m.delete().catch(()=>{}), 15000));
  }
}

client.login(process.env.DISCORD_TOKEN);