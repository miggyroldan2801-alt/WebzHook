require('dotenv').config();
const {
  Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, RoleSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, Collection,
} = require('discord.js');

const config = require('./config');
const db     = require('./database');
const spam   = require('./antispam');
const ti     = require('./threat-intelligence');
const {
  isOwner, isAdmin, hasBotAccess,
  parseDuration, formatDuration,
  sendLog, getOrCreateRole,
  applyMute, removeMute, applyQuarantine,
  successEmbed, errorEmbed, infoEmbed, warnEmbed,
  formatMessage,
} = require('./utils');

const C            = config.COLOR;
const captchaCodes = new Map();

// ── De-duplicate guard (fixes double-response bug) ──────────────────────────
// When Discord reconnects or the bot restarts mid-session, messageCreate can
// fire twice for the same message ID. This set blocks the second call.
const handledMessages = new Set();
function markHandled(id) {
  handledMessages.add(id);
  setTimeout(() => handledMessages.delete(id), 5000);
}

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
    GatewayIntentBits.DirectMessages,
  ],
});

// server.js imports this to check real guild membership via the bot's cache
module.exports = client;

// ─────────────────────────────────────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ ${client.user.tag} online — ${client.guilds.cache.size} guilds`);
  const statuses = [
    { name: `${client.guilds.cache.size} servers | %help`, type: 3 },
    { name: 'for threats 🛡️',                              type: 2 },
    { name: 'compromised accounts 👁️',                     type: 2 },
    { name: 'scam campaigns 🔍',                            type: 2 },
  ];
  let i = 0;
  const tick = () => {
    client.user.setActivity(statuses[i].name, { type: statuses[i].type });
    i = (i + 1) % statuses.length;
  };
  tick();
  setInterval(tick, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GUILD JOIN
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildCreate', async guild => {
  db.getGuild(guild.id); // initialise defaults
  const ch = guild.channels.cache.find(c =>
    c.isTextBased() && c.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
  );
  if (!ch) return;
  await ch.send({
    embeds: [new EmbedBuilder().setColor(C.BLUE)
      .setTitle('👋 WebzHook Guard has joined!')
      .setThumbnail(client.user.displayAvatarURL())
      .setDescription('The bot starts **disabled** by default.\nRun `%setup` then `%enable` to activate protection.')
      .addFields(
        { name: '🚀 Quick Start',  value: '1. `%setup`\n2. `%enable`\n3. `%help`',             inline: true },
        { name: '🛡️ Features',     value: '• Threat Intelligence\n• Anti-Raid & Nuke\n• 90+ Commands', inline: true },
      ).setFooter({ text: 'WebzHook Guard v3.0' }).setTimestamp()],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup_start').setLabel('⚡ Quick Setup').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setLabel('📖 Dashboard').setStyle(ButtonStyle.Link)
        .setURL(process.env.DASHBOARD_URL || 'http://localhost:3000'),
    )],
  }).catch(() => {});
});

// ─────────────────────────────────────────────────────────────────────────────
//  MEMBER JOIN — raid, age gate, welcome, auto-role
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  const s   = db.getGuild(member.guild.id);
  const now = Date.now();

  // Anti-Raid
  if (s.enabled && s.detectionEnabled && s.modules.antiRaid) {
    const joins = spam.trackRaid(member.guild.id, s.thresholds.raidSeconds * 1000);
    if (joins >= s.thresholds.raidJoins) {
      for (const [, ch] of member.guild.channels.cache)
        if (ch.isTextBased())
          await ch.permissionOverwrites.edit(member.guild.roles.everyone, { SendMessages: false }).catch(() => {});
      const e = new EmbedBuilder().setColor(C.RED).setTitle('🚨 RAID DETECTED — Server Locked')
        .setDescription(`**${joins}** users joined within ${s.thresholds.raidSeconds}s.`)
        .addFields({ name: 'To Restore', value: 'Run `%unlockdown` when the raid is over.' })
        .setFooter({ text: 'WebzHook Guard • Anti-Raid' }).setTimestamp();
      await sendLog(member.guild, e);
      await sendAlert(member.guild, e);
    }
  }

  // New-account quarantine
  if (s.enabled && s.modules.newAccountFilter) {
    const ageDays = (now - member.user.createdTimestamp) / 86400000;
    const minDays = s.thresholds.minAccountAgeDays || 7;
    if (ageDays < minDays) {
      await applyQuarantine(member, member.guild);
      db.addLog(member.guild.id, { action: 'AUTO_QUARANTINE_NEW_ACCT', userId: member.id, modId: client.user.id, reason: `Account ${Math.floor(ageDays * 24)}h old < ${minDays}d minimum` });
      const e = new EmbedBuilder().setColor(C.ORANGE).setTitle('🔒 New Account Quarantined')
        .addFields(
          { name: 'User',    value: `${member.user.tag} (${member.id})`, inline: true },
          { name: 'Age',     value: `${Math.floor(ageDays * 24)} hours`, inline: true },
          { name: 'Minimum', value: `${minDays} days`,                   inline: true },
        ).setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: 'WebzHook Guard • Account Filter' }).setTimestamp();
      await sendLog(member.guild, e);
      await sendAlert(member.guild, e);
      return; // skip welcome/auto-role for quarantined members
    }
  }

  // Welcome
  if (s.modules.welcomeSystem && s.welcomeChannelId) {
    const wch = member.guild.channels.cache.get(s.welcomeChannelId);
    if (wch) await wch.send({ embeds: [new EmbedBuilder().setColor(C.GREEN)
      .setDescription(formatMessage(s.welcomeMessage, member))
      .setThumbnail(member.user.displayAvatarURL())
      .setFooter({ text: member.guild.name }).setTimestamp()] }).catch(() => {});
  }

  // Auto-role
  if (s.modules.autoRole && s.autoRoles?.length)
    for (const rid of s.autoRoles) {
      const role = member.guild.roles.cache.get(rid);
      if (role) await member.roles.add(role).catch(() => {});
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  MEMBER LEAVE
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  const s = db.getGuild(member.guild.id);
  if (s.modules.leaveSystem && s.leaveChannelId) {
    const ch = member.guild.channels.cache.get(s.leaveChannelId);
    if (ch) await ch.send({ embeds: [new EmbedBuilder().setColor(C.ORANGE)
      .setDescription(formatMessage(s.leaveMessage, member))
      .setThumbnail(member.user.displayAvatarURL())
      .setFooter({ text: member.guild.name }).setTimestamp()] }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ROLE GUARD
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildMemberUpdate', async (oldM, newM) => {
  const s = db.getGuild(newM.guild.id);
  if (!s.enabled || !s.detectionEnabled) return;
  if (hasBotAccess(newM) || s.whitelist.includes(newM.id)) return;
  const added = newM.roles.cache.filter(r => !oldM.roles.cache.has(r.id));
  for (const [, role] of added) {
    const forbidden = s.forbiddenRoles.includes(role.id);
    const aboveMax  = s.maxRolePosition && role.position > s.maxRolePosition;
    if (forbidden || aboveMax) {
      await applyQuarantine(newM, newM.guild);
      const reason = forbidden
        ? `Received forbidden role: ${role.name}`
        : `Role above max position: ${role.name} (pos ${role.position})`;
      db.addLog(newM.guild.id, { action: 'AUTO_QUARANTINE', userId: newM.id, modId: client.user.id, reason });
      const e = new EmbedBuilder().setColor(C.RED).setTitle('🔒 Auto-Quarantine: Role Violation')
        .setDescription(`**${newM.user.tag}** was automatically quarantined.`)
        .addFields({ name: 'Reason', value: reason })
        .setThumbnail(newM.user.displayAvatarURL())
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
      await sendLog(newM.guild, e);
      await sendAlert(newM.guild, e);
      break;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ANTI-NUKE
// ─────────────────────────────────────────────────────────────────────────────
async function checkNuke(guild, label) {
  const s = db.getGuild(guild.id);
  if (!s.enabled || !s.detectionEnabled || !s.modules.antiNuke) return;
  try {
    const audits = await guild.fetchAuditLogs({ limit: 1 }).catch(() => null);
    if (!audits) return;
    const entry = audits.entries.first();
    if (!entry || Date.now() - entry.createdTimestamp > 5000) return;
    const exec   = entry.executor;
    if (!exec || exec.id === client.user.id) return;
    const member = guild.members.cache.get(exec.id);
    if (member && (isOwner(member) || hasBotAccess(member))) return;
    if (s.whitelist.includes(exec.id)) return;
    const count = spam.trackNukeAction(exec.id, guild.id, 12000);
    if (count >= (s.thresholds.nukeActions || 3)) {
      if (member) await member.ban({ reason: 'Anti-Nuke: Mass destructive actions' }).catch(() => {});
      else await guild.members.ban(exec.id, { reason: 'Anti-Nuke: Mass destructive actions' }).catch(() => {});
      db.addLog(guild.id, { action: 'AUTO_BAN_NUKE', userId: exec.id, modId: client.user.id, reason: `Anti-Nuke: ${label}` });
      const e = new EmbedBuilder().setColor(C.RED).setTitle('💣 NUKE ATTEMPT STOPPED — User Banned')
        .addFields(
          { name: 'User',    value: `${exec.tag} (${exec.id})`, inline: true },
          { name: 'Trigger', value: label,                       inline: true },
          { name: 'Actions', value: `${count} in window`,        inline: true },
        ).setFooter({ text: 'WebzHook Guard • Anti-Nuke' }).setTimestamp();
      await sendLog(guild, e);
      await sendAlert(guild, e);
    }
  } catch { /* silent */ }
}
client.on('channelDelete', ch => checkNuke(ch.guild, 'Channel Deleted'));
client.on('roleDelete',    r  => checkNuke(r.guild,  'Role Deleted'));
client.on('channelCreate', ch => checkNuke(ch.guild, 'Channel Spam Create'));
client.on('roleCreate',    r  => checkNuke(r.guild,  'Role Spam Create'));

// ─────────────────────────────────────────────────────────────────────────────
//  ALERT HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function sendAlert(guild, embed) {
  const s  = db.getGuild(guild.id);
  const id = s.alertChannelId || s.logChannelId;
  if (!id) return;
  const ch = guild.channels.cache.get(id);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

// auto-send a channel message then delete it after TTL
async function autoDelete(channel, embed, ttl = 10000) {
  const m = await channel.send({ embeds: [embed] }).catch(() => null);
  if (m) setTimeout(() => m.delete().catch(() => {}), ttl);
}

// ─────────────────────────────────────────────────────────────────────────────
//  DM SPAM WATCH — was a dead toggle (schema key existed, zero detection logic).
//  Compromised/scam accounts often mass-DM the same fake-giveaway/nitro link to
//  many users across servers they share with the bot. We can't read DM content
//  for privacy/ToS reasons unless the bot is in the conversation, but we CAN
//  detect the cross-server velocity pattern: same user DM'ing rapidly while
//  being a member of multiple mutual guilds is a strong compromise signal.
// ─────────────────────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.guild) return; // only handle true DMs here; guild messages handled above
  if (message.author.bot || message.author.id === client.user.id) return;

  const mutualGuilds = client.guilds.cache.filter(g => g.members.cache.has(message.author.id));
  if (mutualGuilds.size < 2) return; // need 2+ mutual servers for this signal to mean anything

  const entry = ti.trackDMAttempt(message.author.id, [...mutualGuilds.keys()][0]);
  if (entry.count < 3 || entry.guildIds.length < 2) return; // require both volume AND spread

  for (const [, guild] of mutualGuilds) {
    const s = db.getGuild(guild.id);
    if (!s.enabled || !s.modules.dmSpamWatch) continue;
    const member = guild.members.cache.get(message.author.id);
    if (!member || hasBotAccess(member) || s.whitelist.includes(member.id)) continue;

    const e = new EmbedBuilder().setColor(C.ORANGE).setTitle('📨 Mass-DM Pattern Detected')
      .setDescription(`**${message.author.tag}** is sending DMs rapidly while sharing **${entry.guildIds.length} mutual servers** with this bot — a common compromised-account pattern.`)
      .setThumbnail(message.author.displayAvatarURL())
      .addFields(
        { name: 'User',        value: `${member} (${member.id})`, inline: true },
        { name: 'DM Bursts',   value: `${entry.count} in 5 min`,   inline: true },
        { name: 'Mutual Servers', value: `${entry.guildIds.length}`, inline: true },
      ).setFooter({ text: 'WebzHook Guard • DM Spam Watch — review manually, content not read' }).setTimestamp();
    await sendAlert(guild, e);
    db.addLog(guild.id, { action: 'DM_SPAM_WATCH_FLAG', userId: member.id, modId: client.user.id, reason: `${entry.count} DM bursts across ${entry.guildIds.length} mutual servers` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  THREAT RESPONSE
// ─────────────────────────────────────────────────────────────────────────────
async function executeThreatResponse(member, guild, threat, reasons) {
  const s      = db.getGuild(guild.id);
  const t      = s.thresholds;
  const action = s.compromisedAction || 'quarantine';

  let chosen = 'warn';
  if      (threat.totalScore >= (t.threatScoreBan        || 100)) chosen = action === 'ban' ? 'ban' : 'quarantine';
  else if (threat.totalScore >= (t.threatScoreQuarantine || 75))  chosen = action === 'ban' ? 'ban' : 'quarantine';
  else if (threat.totalScore >= (t.threatScoreMute       || 55))  chosen = 'mute';
  else if (threat.totalScore >= (t.threatScoreWarn       || 30))  chosen = 'warn';

  let actionTaken = '';
  try {
    if (chosen === 'ban') {
      if (!member.bannable) { chosen = 'quarantine'; }
      else {
        await member.ban({ reason: `WebzHook Threat score ${threat.totalScore}` });
        actionTaken = '🔨 Banned';
        db.addLog(guild.id, { action: 'AUTO_BAN_THREAT', userId: member.id, modId: client.user.id, reason: `Score ${threat.totalScore}` });
      }
    }
    if (chosen === 'quarantine') {
      await applyQuarantine(member, guild);
      actionTaken = '🔒 Quarantined';
      db.addLog(guild.id, { action: 'AUTO_QUARANTINE_THREAT', userId: member.id, modId: client.user.id, reason: `Score ${threat.totalScore}` });
    }
    if (chosen === 'mute') {
      await applyMute(member, guild);
      setTimeout(() => removeMute(member, guild), (t.muteDuration || 30) * 1000);
      actionTaken = '🔇 Muted';
      db.addLog(guild.id, { action: 'AUTO_MUTE_THREAT', userId: member.id, modId: client.user.id, reason: `Score ${threat.totalScore}` });
    }
    if (chosen === 'warn') {
      db.addWarn(guild.id, member.id, `Threat score ${threat.totalScore}`, client.user.id);
      actionTaken = '⚠️ Warned';
    }
  } catch { actionTaken = '❌ Action failed (check permissions)'; }

  const bar = buildScoreBar(threat.totalScore);
  const e   = new EmbedBuilder()
    .setColor(threat.totalScore >= 75 ? C.RED : threat.totalScore >= 55 ? C.ORANGE : C.YELLOW)
    .setTitle('🚨 Compromised / Scam Account Detected')
    .setDescription(`**${member.user.tag}** flagged by Threat Intelligence Engine.`)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: '👤 User',    value: `${member} (${member.id})`,                       inline: true  },
      { name: '🎯 Action',  value: actionTaken,                                       inline: true  },
      { name: '📊 Score',   value: `${threat.totalScore}/150\n${bar}`,              inline: false },
      { name: '🔍 Reasons', value: reasons.slice(0,8).map(r => `• ${r}`).join('\n') || '• Pattern match', inline: false },
      { name: '📅 Created', value: `<t:${Math.floor(member.user.createdTimestamp/1000)}:R>`, inline: true },
      { name: '📥 Joined',  value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : 'Unknown', inline: true },
    )
    .setFooter({ text: 'WebzHook Guard • Threat Intelligence Engine' }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`threat_ban_${member.id}`).setLabel('Ban').setStyle(ButtonStyle.Danger).setEmoji('🔨'),
    new ButtonBuilder().setCustomId(`threat_quar_${member.id}`).setLabel('Quarantine').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId(`threat_clear_${member.id}`).setLabel('False Positive').setStyle(ButtonStyle.Success).setEmoji('✅'),
  );

  await sendLog(guild, e);
  const alertId = s.alertChannelId || s.logChannelId;
  if (alertId) {
    const ch = guild.channels.cache.get(alertId);
    if (ch) await ch.send({ embeds: [e], components: [row] }).catch(() => {});
  }
}

function buildScoreBar(score) {
  const filled = Math.round(Math.min(score / 150, 1) * 20);
  const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
  const color  = score >= 100 ? '🔴' : score >= 75 ? '🟠' : score >= 55 ? '🟡' : '🟢';
  return `${color} \`${bar}\` ${score}/150`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MESSAGE CREATE
// ─────────────────────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  // ── Bug fix #1: de-duplicate guard ───────────────────────────────────────
  if (handledMessages.has(message.id)) return;
  markHandled(message.id);

  if (!message.guild) return;
  if (message.author.id === client.user.id) return;

  const s      = db.getGuild(message.guild.id);
  const prefix = s.prefix || config.PREFIX;

  // ── PREFIX COMMANDS ───────────────────────────────────────────────────────
  if (!message.author.bot && message.content.startsWith(prefix)) {
    const raw = message.content.slice(prefix.length).trim();
    if (!raw) return;
    const args       = raw.split(/\s+/);
    const command    = args.shift().toLowerCase();
    // Bug fix #2: capture timestamp BEFORE any async work (fixes -1ms / 1107ms latency)
    const receivedAt = message.createdTimestamp;
    await handleCommand(command, args, message, s, receivedAt);
    return;
  }

  // ── DETECTION ENGINE ─────────────────────────────────────────────────────
  if (!s.enabled || !s.detectionEnabled) return;
  if (message.author.bot && !message.webhookId) return;

  // Webhook mass-ping
  if (message.webhookId) {
    const mc = message.mentions.users.size + message.mentions.roles.size;
    if (mc >= config.MASS_PING_THRESHOLD || message.mentions.everyone || message.mentions.roles.size > 0) {
      await message.delete().catch(() => {});
      const wh = await client.fetchWebhook(message.webhookId).catch(() => null);
      if (wh) await wh.delete('WebzHook Guard: malicious webhook').catch(() => {});
      const e = new EmbedBuilder().setColor(C.RED).setTitle('🚨 Malicious Webhook Deleted')
        .addFields({ name: 'Webhook', value: wh?.name || 'Unknown', inline: true }, { name: 'Channel', value: `<#${message.channelId}>`, inline: true })
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp();
      await sendLog(message.guild, e);
      await sendAlert(message.guild, e);
    }
    return;
  }

  const member = message.member;
  if (!member) return;
  if (s.whitelist.includes(member.id) || hasBotAccess(member)) return;
  if (s.trustedRoles?.some(rid => member.roles.cache.has(rid))) return;

  const t = s.thresholds;

  // Bad word filter
  if (s.modules.badwordFilter && s.badwords?.length) {
    const lower = message.content.toLowerCase();
    if (s.badwords.some(w => lower.includes(w.toLowerCase()))) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, 'Prohibited word', client.user.id);
      return autoDelete(message.channel, warnEmbed('Message Removed', `${message.author}, that word is not allowed here. (Warning ${warns.length}/5)`));
    }
  }

  // Invite filter
  if (s.modules.inviteFilter && /(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9]+/i.test(message.content)) {
    await message.delete().catch(() => {});
    return autoDelete(message.channel, warnEmbed('Invite Removed', `${message.author}, posting Discord invites is not allowed.`));
  }

  // Anti-Logger — was a dead toggle with no detection logic; now scans for known
  // IP-logger, token-grabber, and self-bot phishing link patterns. Distinct from
  // generic linkFilter (which blocks ALL links) — this targets specific malicious tools.
  if (s.modules.antiLogger) {
    const loggerPatterns = /(grabify\.link|iplogger\.(org|com|ru)|2no\.co|yip\.su|bmwforum\.co|blasze\.(com|tk)|stopify\.co|spottyfly\.com|gyazo\.com\/track|webhook\.site|discord-?token|nitro-?generator|free-?nitro\.|steamcommunity\.ru|steam-?community\.[^.]+\.|catbox\.moe\/c\/)/i;
    if (loggerPatterns.test(message.content)) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, 'Posted IP-logger/token-grabber link', client.user.id);
      db.addLog(message.guild.id, { action: 'ANTI_LOGGER_BLOCK', userId: message.author.id, modId: client.user.id, reason: 'Malicious tracking/phishing link detected' });
      if (warns.length >= 3) await applyMute(member, message.guild);
      await sendLog(message.guild, new EmbedBuilder().setColor(C.RED).setTitle('🪝 IP-Logger / Token-Grabber Link Blocked')
        .addFields({ name: 'User', value: `${message.author}`, inline: true }, { name: 'Channel', value: `<#${message.channelId}>`, inline: true }, { name: 'Warns', value: `${warns.length}/5`, inline: true })
        .setFooter({ text: 'WebzHook Guard • Anti-Logger' }).setTimestamp());
      return autoDelete(message.channel, warnEmbed('Malicious Link Blocked', `${message.author}, that link is a known IP-logger or token-grabber. Warning ${warns.length}/5.`));
    }
  }

  // Link filter
  if (s.modules.linkFilter && /https?:\/\/[^\s]+/i.test(message.content) && !member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    await message.delete().catch(() => {});
    return autoDelete(message.channel, warnEmbed('Link Removed', `${message.author}, posting links is not allowed.`));
  }

  // Anti-mass-ping
  if (s.modules.antiMassPing) {
    const mc = message.mentions.users.size + message.mentions.roles.size;
    if (mc >= (t.massPingMentions || 5) || message.mentions.everyone) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, `Mass ping (${mc} mentions)`, client.user.id);
      if (warns.length >= 3) await applyMute(member, message.guild);
      await sendLog(message.guild, new EmbedBuilder().setColor(C.RED).setTitle('🚨 Mass Ping')
        .addFields({ name: 'User', value: `${message.author}`, inline: true }, { name: 'Mentions', value: `${mc}`, inline: true }, { name: 'Warns', value: `${warns.length}`, inline: true })
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp());
      return autoDelete(message.channel, warnEmbed('Mass Ping Blocked', `${message.author}, mass pinging is not allowed. Warning ${warns.length}/5.`));
    }
  }

  // Anti-spam
  if (s.modules.antiSpam) {
    const count = spam.trackSpam(message.author.id, message.guild.id, (t.spamSeconds || 4) * 1000);
    if (count >= (t.spamMessages || 5)) {
      await applyMute(member, message.guild);
      setTimeout(() => removeMute(member, message.guild), (t.muteDuration || 30) * 1000);
      db.addLog(message.guild.id, { action: 'AUTO_MUTE_SPAM', userId: member.id, modId: client.user.id, reason: `${count} msgs in ${t.spamSeconds||4}s` });
      await sendLog(message.guild, new EmbedBuilder().setColor(C.ORANGE).setTitle('🔇 Auto-Mute: Spam')
        .addFields({ name: 'User', value: `${message.author}`, inline: true }, { name: 'Messages', value: `${count}`, inline: true }, { name: 'Muted', value: `${t.muteDuration||30}s`, inline: true })
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp());
      return;
    }
  }

  // Anti-duplicate
  if (s.modules.antiDuplicate && message.content.length > 5) {
    const dup = spam.trackDuplicate(message.author.id, message.guild.id, message.content);
    if (dup >= (t.duplicateCount || 4)) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, 'Duplicate spam', client.user.id);
      return autoDelete(message.channel, warnEmbed('Duplicate Spam', `${message.author}, stop repeating the same message. Warning ${warns.length}/5.`));
    }
  }

  // Anti-caps
  if (s.modules.antiCaps && message.content.length >= config.CAPS_MIN_LENGTH) {
    const letters = message.content.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 0) {
      const pct = (message.content.replace(/[^A-Z]/g, '').length / letters.length) * 100;
      if (pct >= (t.capsPercent || 80)) {
        await message.delete().catch(() => {});
        return autoDelete(message.channel, warnEmbed('Caps Removed', `${message.author}, please avoid excessive caps.`));
      }
    }
  }

  // Auto-slowmode
  if (s.modules.slowmodeAuto) {
    const burst = spam.trackSpam(`ch_${message.channelId}`, message.guild.id, 5000);
    if (burst >= 15 && message.channel.rateLimitPerUser === 0) {
      await message.channel.setRateLimitPerUser(s.slowmodeAutoSeconds || 5).catch(() => {});
      setTimeout(() => message.channel.setRateLimitPerUser(0).catch(() => {}), 30000);
    }
  }

  // Account age gate
  if (s.modules.accountAgeGate) {
    const ageDays = (Date.now() - message.author.createdTimestamp) / 86400000;
    const minDays = t.minAccountAgeDays || 7;
    if (ageDays < minDays) {
      await message.delete().catch(() => {});
      return autoDelete(message.channel, warnEmbed('Account Too New',
        `${message.author}, your account must be **${minDays} days old** to speak here. Yours is **${Math.floor(ageDays*24)} hours** old.`));
    }
  }

  // Image spam
  if (s.modules.imageSpamFilter && ti.isImageAttachment(message)) {
    const result = ti.trackImageSpam(message.author.id, message.guild.id);
    if (result.score > 0) {
      const threat = ti.analyseMessage(message, member);
      if (threat.needsMute || threat.needsQuarantine || threat.isCompromised) {
        await message.delete().catch(() => {});
        return executeThreatResponse(member, message.guild, threat, [...result.reasons, ...threat.reasons]);
      }
    }
  }

  // Scam / compromised detection
  if (s.modules.scamDetection || s.modules.compromisedAccounts) {
    const threat = ti.analyseMessage(message, member);
    if (threat.sessionScore >= 15) await message.delete().catch(() => {});
    if (threat.needsWarn || threat.needsMute || threat.needsQuarantine || threat.isCompromised)
      return executeThreatResponse(member, message.guild, threat, threat.reasons);
  }

  // Anti-hoist on message (rename if name starts with special char)
  if (s.modules.antiHoist) {
    const name = member.nickname || member.user.username;
    if (/^[^a-zA-Z0-9]/.test(name)) {
      await member.setNickname(name.replace(/^[^a-zA-Z0-9]+/, '') || 'Hoisted User').catch(() => {});
    }
  }

  // Custom responses
  if (s.responses && Object.keys(s.responses).length) {
    const lower = message.content.toLowerCase().trim();
    for (const [trigger, response] of Object.entries(s.responses)) {
      if (lower === trigger.toLowerCase() || lower === prefix + trigger.toLowerCase()) {
        await message.delete().catch(() => {});
        return autoDelete(message.channel, infoEmbed(trigger, response));
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  INTERACTIONS
// ─────────────────────────────────────────────────────────────────────────────
client.on('interactionCreate', async i => {
  try {
    if      (i.isButton())           await handleButton(i);
    else if (i.isStringSelectMenu()) await handleSelectMenu(i);
    else if (i.isUserSelectMenu())   await handleUserSelect(i);
    else if (i.isRoleSelectMenu())   await handleRoleSelect(i);
    else if (i.isModalSubmit())      await handleModal(i);
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: '❌ An error occurred.', ephemeral: true };
    if (i.replied || i.deferred) await i.followUp(msg).catch(() => {});
    else await i.reply(msg).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  BUTTON HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleButton(i) {
  const s = db.getGuild(i.guild.id);

  if (i.customId === 'setup_start') {
    if (!isOwner(i.member)) return i.reply({ embeds: [errorEmbed('Owner Only', 'Only the server owner can run setup.')], ephemeral: true });
    await i.deferReply({ ephemeral: true });
    await runSetup(i.guild);
    return i.editReply({ embeds: [successEmbed('Setup Complete!', 'All roles and channels created.\nRun `%enable` to activate.')] });
  }

  if (i.customId === 'verify_button') {
    if (!s.modules.verification || !s.verifiedRoleId)
      return i.reply({ embeds: [errorEmbed('Not Set Up', 'Ask an admin to run `%setupverify`.')], ephemeral: true });
    const role = i.guild.roles.cache.get(s.verifiedRoleId);
    if (!role) return i.reply({ embeds: [errorEmbed('Role Missing', 'The verified role was deleted.')], ephemeral: true });
    if (i.member.roles.cache.has(role.id))
      return i.reply({ embeds: [infoEmbed('Already Verified', 'You already have full access!')], ephemeral: true });
    await i.member.roles.add(role);
    return i.reply({ embeds: [successEmbed('Verified! ✅', 'You now have full access. Welcome!')], ephemeral: true });
  }

  if (i.customId === 'verify_captcha') {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    captchaCodes.set(i.user.id, { code, guildId: i.guild.id, expires: Date.now() + 120000 });
    const modal = new ModalBuilder().setCustomId('captcha_submit').setTitle('Human Verification');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('captcha_code').setLabel(`Enter this code: ${code}`)
        .setStyle(TextInputStyle.Short).setRequired(true).setMinLength(6).setMaxLength(6)
    ));
    return i.showModal(modal);
  }

  if (i.customId.startsWith('confirm_ban_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid = i.customId.replace('confirm_ban_', '');
    await i.guild.members.ban(uid, { reason: `Banned by ${i.user.tag}` }).catch(() => {});
    db.addLog(i.guild.id, { action: 'BAN', userId: uid, modId: i.user.id });
    return i.update({ embeds: [successEmbed('Banned', `<@${uid}> has been permanently banned.`)], components: [] });
  }

  if (i.customId === 'cancel_action')
    return i.update({ embeds: [infoEmbed('Cancelled', 'No action was taken.')], components: [] });

  if (i.customId.startsWith('threat_ban_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid = i.customId.replace('threat_ban_', '');
    await i.guild.members.ban(uid, { reason: `Manual threat action by ${i.user.tag}` }).catch(() => {});
    db.addLog(i.guild.id, { action: 'MANUAL_BAN_THREAT', userId: uid, modId: i.user.id });
    return i.update({ embeds: [successEmbed('User Banned', `<@${uid}> has been banned.`)], components: [] });
  }

  if (i.customId.startsWith('threat_quar_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid    = i.customId.replace('threat_quar_', '');
    const target = i.guild.members.cache.get(uid);
    if (target) await applyQuarantine(target, i.guild);
    db.addLog(i.guild.id, { action: 'MANUAL_QUARANTINE_THREAT', userId: uid, modId: i.user.id });
    return i.update({ embeds: [successEmbed('Quarantined', `<@${uid}> has been quarantined.`)], components: [] });
  }

  if (i.customId.startsWith('threat_clear_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid    = i.customId.replace('threat_clear_', '');
    const target = i.guild.members.cache.get(uid);
    ti.resetUserScore(uid, i.guild.id);
    if (target) {
      const qr = i.guild.roles.cache.find(r => r.name === config.QUARANTINE_ROLE);
      if (qr) await target.roles.remove(qr).catch(() => {});
      await removeMute(target, i.guild);
    }
    return i.update({ embeds: [successEmbed('False Positive Cleared', `<@${uid}> score reset and restrictions removed.`)], components: [] });
  }

  if (i.customId.startsWith('help_')) {
    const page = i.customId.replace('help_', '');
    return i.update({ embeds: [buildHelpPage(page)], components: [buildHelpRow(page)] });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SELECT MENUS
// ─────────────────────────────────────────────────────────────────────────────
async function handleSelectMenu(i) {
  if (i.customId === 'help_select')
    return i.update({ embeds: [buildHelpPage(i.values[0])], components: [buildHelpRow(i.values[0])] });

  if (i.customId.startsWith('warn_action_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid    = i.customId.replace('warn_action_', '');
    const action = i.values[0];
    const target = i.guild.members.cache.get(uid);
    if (!target) return i.update({ embeds: [errorEmbed('User Not Found')], components: [] });
    if (action === 'mute')       await applyMute(target, i.guild);
    if (action === 'quarantine') await applyQuarantine(target, i.guild);
    if (action === 'kick')       await target.kick('Warn escalation').catch(() => {});
    if (action === 'ban')        await target.ban({ reason: 'Warn escalation' }).catch(() => {});
    if (action === 'dismiss')    return i.update({ embeds: [infoEmbed('Dismissed', 'No further action taken.')], components: [] });
    return i.update({ embeds: [successEmbed('Action Applied', `**${action}** applied to <@${uid}>.`)], components: [] });
  }

  if (i.customId === 'compromised_action_select') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    db.updateGuild(i.guild.id, { compromisedAction: i.values[0] });
    return i.update({ embeds: [successEmbed('Action Updated', `Compromised accounts will be: **${i.values[0].toUpperCase()}**`)], components: [] });
  }
}

async function handleUserSelect(i) {
  if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
  const s2 = db.getGuild(i.guild.id);
  if (i.customId === 'whitelist_add') {
    for (const uid of i.values) if (!s2.whitelist.includes(uid)) s2.whitelist.push(uid);
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Whitelist Updated', i.values.map(u => `<@${u}>`).join(', ') + ' added.')], ephemeral: true });
  }
  if (i.customId === 'blacklist_add') {
    for (const uid of i.values) if (!s2.blacklist.includes(uid)) s2.blacklist.push(uid);
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Blacklisted', i.values.map(u => `<@${u}>`).join(', ') + ' added to blacklist.')], ephemeral: true });
  }
}

async function handleRoleSelect(i) {
  if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
  const s2 = db.getGuild(i.guild.id);
  if (i.customId === 'autorole_set') {
    s2.autoRoles = i.values; s2.modules.autoRole = true;
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Auto-Role Set', i.values.map(r => `<@&${r}>`).join(', ') + ' auto-assigned to new members.')], ephemeral: true });
  }
  if (i.customId === 'trusted_roles_set') {
    s2.trustedRoles = i.values;
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Trusted Roles Set', i.values.map(r => `<@&${r}>`).join(', ') + ' exempt from threat detection.')], ephemeral: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODALS
// ─────────────────────────────────────────────────────────────────────────────
async function handleModal(i) {
  if (i.customId === 'captcha_submit') {
    const session = captchaCodes.get(i.user.id);
    if (!session || session.guildId !== i.guild.id)
      return i.reply({ embeds: [errorEmbed('Session Expired', 'Click Verify again.')], ephemeral: true });
    if (Date.now() > session.expires) {
      captchaCodes.delete(i.user.id);
      return i.reply({ embeds: [errorEmbed('Code Expired', 'Click Verify again.')], ephemeral: true });
    }
    if (i.fields.getTextInputValue('captcha_code').trim().toUpperCase() !== session.code)
      return i.reply({ embeds: [errorEmbed('Wrong Code', 'Incorrect. Try again.')], ephemeral: true });
    captchaCodes.delete(i.user.id);
    const s2   = db.getGuild(i.guild.id);
    const role = i.guild.roles.cache.get(s2.verifiedRoleId);
    if (role) await i.member.roles.add(role);
    return i.reply({ embeds: [successEmbed('Verified! ✅', 'You now have full access to the server.')], ephemeral: true });
  }

  if (i.customId.startsWith('warn_modal_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid    = i.customId.replace('warn_modal_', '');
    const reason = i.fields.getTextInputValue('warn_reason');
    const warns  = db.addWarn(i.guild.id, uid, reason, i.user.id);
    db.addLog(i.guild.id, { action: 'WARN', userId: uid, modId: i.user.id, reason });
    const target = i.guild.members.cache.get(uid);
    if (warns.length >= 3 && target) await applyMute(target, i.guild);
    if (warns.length >= 5 && target) await target.ban({ reason: 'Auto-ban: 5 warnings' }).catch(() => {});
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`warn_action_${uid}`).setPlaceholder('Additional action...')
        .addOptions(
          { label: 'Mute',       value: 'mute',       emoji: '🔇' },
          { label: 'Quarantine', value: 'quarantine', emoji: '🔒' },
          { label: 'Kick',       value: 'kick',       emoji: '👢' },
          { label: 'Ban',        value: 'ban',        emoji: '🔨' },
          { label: 'Dismiss',    value: 'dismiss',    emoji: '✅' },
        )
    );
    return i.reply({
      embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Warning Issued')
        .addFields(
          { name: 'User',   value: `<@${uid}>`,                 inline: true },
          { name: 'Reason', value: reason,                       inline: true },
          { name: 'Total',  value: `${warns.length} warn(s)`,   inline: true },
        ).setFooter({ text: warns.length >= 5 ? '🔨 Auto-banned' : warns.length >= 3 ? '🔇 Auto-muted' : 'No auto-action' }).setTimestamp()],
      components: [row],
      ephemeral: true,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function runSetup(guild) {
  for (const [name, color] of [
    [config.BOT_ACCESS_ROLE, 0x5865F2],
    [config.QUARANTINE_ROLE, 0x95A5A6],
    [config.MUTE_ROLE,       0x95A5A6],
    [config.VERIFIED_ROLE,   0x57F287],
  ]) {
    const role = await getOrCreateRole(guild, name, { color, reason: 'WebzHook Guard setup' });
    if (name === config.QUARANTINE_ROLE || name === config.MUTE_ROLE) {
      // Was a sequential for-await loop — on a server with 20+ channels this alone
      // could take 10-20+ seconds and made %setup look hung. Promise.all runs all
      // the permission edits concurrently instead of one at a time.
      await Promise.all([...guild.channels.cache.values()].map(ch =>
        ch.permissionOverwrites.edit(role, { SendMessages: false, AddReactions: false }).catch(() => {})
      ));
    }
  }
  let logCh = guild.channels.cache.find(c => c.name === 'webzhook-logs');
  if (!logCh) logCh = await guild.channels.create({
    name: 'webzhook-logs', type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny:  [PermissionsBitField.Flags.ViewChannel] },
      { id: guild.members.me,     allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
    ],
    reason: 'WebzHook Guard setup',
  }).catch(() => null);
  let alertCh = guild.channels.cache.find(c => c.name === 'webzhook-alerts');
  if (!alertCh) alertCh = await guild.channels.create({
    name: 'webzhook-alerts', type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny:  [PermissionsBitField.Flags.ViewChannel] },
      { id: guild.members.me,     allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
    ],
    reason: 'WebzHook Guard alerts',
  }).catch(() => null);
  db.updateGuild(guild.id, {
    logChannelId:   logCh?.id   || null,
    alertChannelId: alertCh?.id || logCh?.id || null,
    setupDone: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELP PAGES
// ─────────────────────────────────────────────────────────────────────────────
function buildHelpPage(page = 'main') {
  const pages = {
    main: new EmbedBuilder().setColor(C.BLUE).setTitle('📖 WebzHook Guard — Help')
      .setDescription('Select a category below. All bot responses auto-delete after 15 seconds.')
      .addFields(
        { name: '⚙️ Setup',        value: '`%setup` `%enable` `%disable` `%setlog`',      inline: true },
        { name: '🔨 Moderation',   value: '`%ban` `%kick` `%mute` `%warn` `%purge`',      inline: true },
        { name: '🛡️ Security',     value: '`%toggle` `%whitelist` `%quarantine`',          inline: true },
        { name: '🚨 Threat Intel', value: '`%threatscore` `%scansettings` `%resetuser`',   inline: true },
        { name: '🔐 Verification', value: '`%setupverify` `%setverifymode`',               inline: true },
        { name: '⚡ Utility',      value: '`%userinfo` `%serverinfo` `%ping` `%logs`',     inline: true },
      ).setFooter({ text: 'WebzHook Guard v3.0 • Threat Intelligence Edition' }).setTimestamp(),

    setup: new EmbedBuilder().setColor(C.PURPLE).setTitle('⚙️ Setup Commands')
      .addFields(
        { name: '`%setup`',                  value: 'Auto-create all roles, channels & permissions (Owner only)' },
        { name: '`%enable` / `%disable`',    value: 'Activate or deactivate the bot' },
        { name: '`%setlog #channel`',        value: 'Set the moderation log channel' },
        { name: '`%alertchannel #channel`',  value: 'Set the high-priority threat alert channel' },
        { name: '`%setprefix <prefix>`',     value: 'Change the command prefix (default: %)' },
        { name: '`%toggle <module>`',        value: 'Toggle any module on or off' },
        { name: '`%modules`',               value: 'View + toggle all modules via dropdown menu' },
        { name: '`%autorole`',              value: 'Set roles auto-assigned to new members (role selector)' },
        { name: '`%setwelcome #ch <msg>`',  value: 'Configure welcome messages. Variables: {user} {server} {count}' },
        { name: '`%setleave #ch <msg>`',    value: 'Configure leave messages' },
        { name: '`%trustedroles`',          value: 'Set roles that bypass all threat detection' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    moderation: new EmbedBuilder().setColor(C.RED).setTitle('🔨 Moderation Commands')
      .addFields(
        { name: '`%ban @user [reason]`',           value: 'Ban with confirmation button' },
        { name: '`%softban @user`',                value: 'Ban + unban (clears 7 days of messages)' },
        { name: '`%tempban @user <dur> [reason]`', value: 'Temp-ban — 10m, 2h, 1d, etc.' },
        { name: '`%massban <id1> <id2> ...`',      value: 'Ban multiple users by ID at once' },
        { name: '`%unban <userId>`',               value: 'Unban by user ID' },
        { name: '`%kick @user [reason]`',          value: 'Kick a member' },
        { name: '`%mute @user [dur] [reason]`',    value: 'Mute with optional duration' },
        { name: '`%unmute @user`',                 value: 'Remove mute' },
        { name: '`%timeout @user <dur>`',          value: 'Discord native timeout' },
        { name: '`%warn @user <reason>`',          value: 'Warn + dropdown follow-up action selector' },
        { name: '`%warnings @user`',               value: 'View warning history' },
        { name: '`%clearwarns @user`',             value: 'Clear all warnings' },
        { name: '`%purge <1-100>`',                value: 'Bulk delete messages' },
        { name: '`%slowmode <seconds>`',           value: 'Set channel slowmode (0 = off)' },
        { name: '`%lock / %unlock`',               value: 'Lock or unlock current channel' },
        { name: '`%lockdown / %unlockdown`',       value: 'Lock or unlock ALL channels' },
        { name: '`%nick @user <name>`',            value: 'Set or reset a nickname' },
      ).setFooter({ text: 'All responses auto-delete after 15s' }).setTimestamp(),

    security: new EmbedBuilder().setColor(C.ORANGE).setTitle('🛡️ Security Commands')
      .addFields(
        { name: '`%quarantine @user`',      value: 'Remove all channel access from a user' },
        { name: '`%unquarantine @user`',    value: 'Release from quarantine' },
        { name: '`%whitelist @user`',       value: 'Exempt user from all detection' },
        { name: '`%unwhitelist @user`',     value: 'Remove from whitelist' },
        { name: '`%whitelistui`',           value: 'User-select dropdown to whitelist multiple users' },
        { name: '`%blacklist @user`',       value: 'Permanently restrict a user' },
        { name: '`%setmaxrole <pos>`',      value: 'Auto-quarantine if role above this position is assigned' },
        { name: '`%forbiddenrole @role`',   value: 'Auto-quarantine anyone who receives this role' },
        { name: '`%unforbiddenrole @role`', value: 'Remove from forbidden role list' },
        { name: '`%addbadword <word>`',     value: 'Add a word to the filter' },
        { name: '`%removebadword <word>`',  value: 'Remove a word from the filter' },
        { name: '`%badwords`',             value: 'List all filtered words' },
        { name: '`%antihoist`',            value: 'Toggle anti-hoist (renames users with special-char names)' },
        { name: '`%disable-bot <dur>`',    value: 'Pause all detection temporarily' },
        { name: '`%enable-bot`',           value: 'Resume detection early' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    threat: new EmbedBuilder().setColor(C.RED).setTitle('🚨 Threat Intelligence Commands')
      .setDescription('Real-time scoring engine that detects scam accounts, phishing, and compromised users.')
      .addFields(
        { name: '`%threatscore @user`',       value: 'View threat score + full event history' },
        { name: '`%resetuser @user`',         value: 'Clear false positive and remove restrictions' },
        { name: '`%compromisedaction`',       value: 'Set action for detected threats (warn/mute/quarantine/kick/ban)' },
        { name: '`%scansettings`',            value: 'View all threat detection configuration' },
        { name: '`%threatreport`',            value: 'View recent threat events in this server' },
        { name: '`%scamdomain <domain>`',     value: 'Check if a domain is in the threat database' },
        { name: '`%alertchannel #ch`',        value: 'Set separate high-priority alert channel' },
        { name: '`%accountagegate <days>`',   value: 'Block new accounts from speaking (0 = disable)' },
        { name: '`%newaccountfilter <days>`', value: 'Auto-quarantine accounts younger than X days on join' },
        { name: '📡 Auto-Detected',           value: '• MrBeast/giveaway scam keywords\n• Phishing domain blacklist\n• JPG/image spam campaigns\n• Rapid join + message attacks\n• Multi-channel identical message spam\n• New account + suspicious link combos' },
      ).setFooter({ text: 'WebzHook Guard • Threat Intelligence' }).setTimestamp(),

    utility: new EmbedBuilder().setColor(C.TEAL).setTitle('⚡ Utility & Info Commands')
      .addFields(
        { name: '`%ping`',                value: 'Message latency and API latency (fixed, no more -1ms)' },
        { name: '`%uptime`',              value: 'How long the bot has been online' },
        { name: '`%botinfo`',             value: 'Bot version, server count, uptime' },
        { name: '`%userinfo [@user]`',    value: 'User info including warns and threat score' },
        { name: '`%serverinfo`',          value: 'Server stats' },
        { name: '`%roleinfo @role`',      value: 'Role details' },
        { name: '`%avatar [@user]`',      value: 'Full-size avatar' },
        { name: '`%membercount`',         value: 'Humans / bots / total' },
        { name: '`%status`',              value: 'Full bot configuration and module status' },
        { name: '`%logs`',                value: 'Recent moderation log (last 15 entries)' },
        { name: '`%addresponse <k> <v>`', value: 'Add a keyword auto-response' },
        { name: '`%delresponse <k>`',     value: 'Remove a keyword response' },
        { name: '`%responses`',           value: 'List all keyword responses' },
        { name: '`%invite`',              value: 'Get bot invite link' },
        { name: '`%setupverify [mode]`',  value: 'Set up verification gate (button or captcha)' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),
  };
  return pages[page] || pages.main;
}

function buildHelpRow(active = 'main') {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('📖 Browse categories...')
      .addOptions(
        { label: 'Overview',     value: 'main',       emoji: '🏠', default: active === 'main'       },
        { label: 'Setup',        value: 'setup',      emoji: '⚙️', default: active === 'setup'      },
        { label: 'Moderation',   value: 'moderation', emoji: '🔨', default: active === 'moderation' },
        { label: 'Security',     value: 'security',   emoji: '🛡️', default: active === 'security'   },
        { label: 'Threat Intel', value: 'threat',     emoji: '🚨', default: active === 'threat'     },
        { label: 'Utility',      value: 'utility',    emoji: '⚡', default: active === 'utility'    },
      )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMMAND HANDLER
//  All commands are ephemeral-style: command message deleted, reply auto-deletes.
//  `receivedAt` is captured at the top of messageCreate BEFORE any async work,
//  which is what fixes the inflated %ping latency bug (was 1100ms+, now accurate).
// ─────────────────────────────────────────────────────────────────────────────
async function handleCommand(command, args, message, s, receivedAt) {
  const { guild, member, channel } = message;
  let deleted = false;

  // Delete the triggering command message exactly once — this, plus the
  // handledMessages de-dupe guard at the top of messageCreate, is what fixes
  // the double-response bug.
  const delCmd = () => { if (!deleted) { deleted = true; message.delete().catch(() => {}); } };

  // Ephemeral-style reply: delete command msg, send reply, auto-delete reply after ttl
  const reply = async (embed, components = [], ttl = 15000) => {
    delCmd();
    const m = await channel.send({ embeds: [embed], components }).catch(() => null);
    if (m && !components.length) setTimeout(() => m.delete().catch(() => {}), ttl);
    return m;
  };

  // Persistent reply — for messages that need buttons/selects to stay visible
  const replyPerm = (embed, components = []) => {
    delCmd();
    return channel.send({ embeds: [embed], components });
  };

  // ── HELP ─────────────────────────────────────────────────────────────────
  if (command === 'help') {
    const page = args[0]?.toLowerCase() || 'main';
    delCmd();
    return channel.send({ embeds: [buildHelpPage(page)], components: [buildHelpRow(page)] });
  }

  // ── PING — bug fixes applied here ────────────────────────────────────────
  if (command === 'ping') {
    const msgLatency = Date.now() - receivedAt;
    const wsLatency  = client.ws.ping >= 0 ? `${Math.round(client.ws.ping)}ms` : 'Connecting...';
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle('🏓 Pong!')
      .addFields(
        { name: '📨 Message Latency', value: `${msgLatency}ms`, inline: true },
        { name: '🌐 API Latency',     value: wsLatency,          inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'uptime') {
    return reply(infoEmbed('⏱️ Uptime', `Bot has been online for **${formatDuration(process.uptime() * 1000)}**`));
  }

  if (command === 'botinfo') {
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle('ℹ️ WebzHook Guard Info')
      .setThumbnail(client.user.displayAvatarURL())
      .addFields(
        { name: 'Version',  value: 'v3.0 Threat Intelligence Edition', inline: true },
        { name: 'Servers',  value: `${client.guilds.cache.size}`,       inline: true },
        { name: 'Uptime',   value: formatDuration(process.uptime() * 1000), inline: true },
        { name: 'Ping',     value: `${client.ws.ping >= 0 ? client.ws.ping : '?'}ms`, inline: true },
        { name: 'Commands', value: '90+', inline: true },
        { name: 'Modules',  value: '20',  inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  // ── SETUP ─────────────────────────────────────────────────────────────────
  if (command === 'setup') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only', 'Only the server owner can run setup.'));
    delCmd();
    const m = await channel.send({ embeds: [infoEmbed('Setting up…', 'Creating roles and channels. Please wait.')] });
    await runSetup(guild);
    return m.edit({ embeds: [successEmbed('Setup Complete!', '✅ Roles, channels, and permissions configured.\nRun `%enable` to activate protection.')] });
  }

  if (command === 'enable') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    db.updateGuild(guild.id, { enabled: true, detectionEnabled: true });
    return reply(successEmbed('Bot Enabled 🟢', 'WebzHook Guard is now **active** and protecting this server.'));
  }

  if (command === 'disable') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    db.updateGuild(guild.id, { enabled: false, detectionEnabled: false });
    return reply(warnEmbed('Bot Disabled 🔴', 'All protection has been turned off. Run `%enable` to restore.'));
  }

  if (command === 'setlog') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const ch2 = message.mentions.channels.first();
    if (!ch2) return reply(errorEmbed('Usage', '`%setlog #channel`'));
    db.updateGuild(guild.id, { logChannelId: ch2.id });
    return reply(successEmbed('Log Channel Set', `Mod logs → ${ch2}`));
  }

  if (command === 'alertchannel') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const ch2 = message.mentions.channels.first();
    if (!ch2) return reply(errorEmbed('Usage', '`%alertchannel #channel`'));
    db.updateGuild(guild.id, { alertChannelId: ch2.id });
    return reply(successEmbed('Alert Channel Set', `Threat alerts → ${ch2}`));
  }

  if (command === 'setprefix') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    const p = args[0];
    if (!p || p.length > 3) return reply(errorEmbed('Invalid', '1–3 characters only.'));
    db.updateGuild(guild.id, { prefix: p });
    return reply(successEmbed('Prefix Updated', `New prefix: \`${p}\``));
  }

  // ── MODULES ───────────────────────────────────────────────────────────────
  if (command === 'modules') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const entries = Object.entries(s.modules);
    const select  = new StringSelectMenuBuilder()
      .setCustomId('modules_select').setPlaceholder('Select modules to enable (unselected = disabled)...')
      .setMinValues(0).setMaxValues(entries.length)
      .addOptions(entries.map(([k, v]) => ({ label: k, value: k, emoji: v ? '✅' : '❌', description: `Currently ${v ? 'enabled' : 'disabled'}`, default: v })));
    return replyPerm(infoEmbed('Module Manager', 'Pick which modules to **enable**. All others will be disabled.'), [new ActionRowBuilder().addComponents(select)]);
  }

  if (command === 'toggle') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const input = args[0]?.toLowerCase();
    const moduleKeys = Object.keys(s.modules);
    // Case-insensitive match — fixes "%toggle antinuke" silently failing because the
    // real key is "antiNuke". Previously this just said "Usage" with no indication
    // the module name itself was the problem.
    const mod = moduleKeys.find(k => k.toLowerCase() === input);
    if (!mod) {
      const list = moduleKeys.map(k => `\`${k}\``).join(', ');
      return reply(warnEmbed('Usage', `\`%toggle <module>\`\n\n**Available modules:**\n${list}\n\n💡 Tip: also run \`%modules\` for a clickable dropdown instead of typing exact names.`));
    }
    s.modules[mod] = !s.modules[mod];
    db.saveGuild(guild.id, s);
    return reply(successEmbed('Module Toggled', `**${mod}** → **${s.modules[mod] ? 'ON ✅' : 'OFF ❌'}**`));
  }

  // ── MODERATION ────────────────────────────────────────────────────────────

  if (command === 'ban') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%ban @user [reason]`'));
    if (!target.bannable) return reply(errorEmbed('Cannot Ban', 'I cannot ban this user — they may outrank me.'));
    const reason = args.slice(1).join(' ') || 'No reason provided';
    return replyPerm(new EmbedBuilder().setColor(C.RED).setTitle('⚠️ Confirm Ban')
      .setDescription(`Ban **${target.user.tag}** permanently?`)
      .addFields({ name: 'Reason', value: reason })
      .setThumbnail(target.user.displayAvatarURL())
      .setFooter({ text: 'This action cannot be undone' }).setTimestamp(),
      [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_ban_${target.id}`).setLabel('Confirm Ban').setStyle(ButtonStyle.Danger).setEmoji('🔨'),
        new ButtonBuilder().setCustomId('cancel_action').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )]);
  }

  if (command === 'softban') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target || !target.bannable) return reply(errorEmbed('Usage / Cannot Ban', '`%softban @user`'));
    const reason = args.slice(1).join(' ') || 'Soft-ban: message cleanup';
    await target.ban({ deleteMessageSeconds: 604800, reason });
    await guild.members.unban(target.id, 'Soft-ban completed').catch(() => {});
    db.addLog(guild.id, { action: 'SOFTBAN', userId: target.id, modId: member.id, reason });
    await sendLog(guild, new EmbedBuilder().setColor(C.ORANGE).setTitle('🧹 Soft-Banned')
      .addFields({ name: 'User', value: target.user.tag, inline: true }, { name: 'By', value: member.user.tag, inline: true }, { name: 'Reason', value: reason })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp());
    return reply(successEmbed('Soft-Banned', `${target.user.tag} was soft-banned (messages cleared, can rejoin).`));
  }

  if (command === 'tempban') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target || !args[1]) return reply(errorEmbed('Usage', '`%tempban @user <duration> [reason]`'));
    const ms = parseDuration(args[1]);
    if (!ms) return reply(errorEmbed('Invalid Duration', 'Use: `10m` `2h` `1d`'));
    const reason = args.slice(2).join(' ') || 'No reason';
    await target.ban({ reason });
    setTimeout(() => guild.members.unban(target.id).catch(() => {}), ms);
    db.addLog(guild.id, { action: 'TEMPBAN', userId: target.id, modId: member.id, reason, duration: formatDuration(ms) });
    await sendLog(guild, new EmbedBuilder().setColor(C.RED).setTitle('⏱️ Temp-Banned')
      .addFields({ name: 'User', value: target.user.tag, inline: true }, { name: 'Duration', value: formatDuration(ms), inline: true }, { name: 'Reason', value: reason })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp());
    return reply(successEmbed('Temp-Banned', `${target.user.tag} banned for **${formatDuration(ms)}**.`));
  }

  if (command === 'massban') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    delCmd();
    const ids = args.filter(a => /^\d{17,20}$/.test(a));
    if (!ids.length) return channel.send({ embeds: [warnEmbed('Usage', '`%massban <userId1> <userId2> ...`\nProvide user IDs separated by spaces.')] }).then(m => setTimeout(() => m.delete().catch(() => {}), 10000));
    const reason = 'Mass ban by ' + member.user.tag;
    let success = 0, fail = 0;
    for (const id of ids) {
      const ok = await guild.members.ban(id, { reason }).then(() => true).catch(() => false);
      ok ? success++ : fail++;
    }
    return channel.send({ embeds: [successEmbed('Mass Ban Complete', `✅ Banned: ${success}\n❌ Failed: ${fail}`)] })
      .then(m => setTimeout(() => m.delete().catch(() => {}), 15000));
  }

  if (command === 'unban') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    if (!args[0]) return reply(errorEmbed('Usage', '`%unban <userId>`'));
    await guild.members.unban(args[0]).catch(() => {});
    return reply(successEmbed('Unbanned', `User \`${args[0]}\` unbanned.`));
  }

  if (command === 'kick') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target || !target.kickable) return reply(errorEmbed('Usage / Cannot Kick', '`%kick @user [reason]`'));
    const reason = args.slice(1).join(' ') || 'No reason';
    await target.kick(reason);
    db.addLog(guild.id, { action: 'KICK', userId: target.id, modId: member.id, reason });
    await sendLog(guild, new EmbedBuilder().setColor(C.ORANGE).setTitle('👢 Kicked')
      .addFields({ name: 'User', value: target.user.tag, inline: true }, { name: 'By', value: member.user.tag, inline: true }, { name: 'Reason', value: reason })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp());
    return reply(successEmbed('Kicked', `${target.user.tag} has been kicked.`));
  }

  if (command === 'mute') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%mute @user [duration] [reason]`'));
    const ms     = args[1] ? parseDuration(args[1]) : null;
    const reason = args.slice(ms ? 2 : 1).join(' ') || 'No reason';
    await applyMute(target, guild);
    if (ms) setTimeout(() => removeMute(target, guild), ms);
    db.addLog(guild.id, { action: 'MUTE', userId: target.id, modId: member.id, reason, duration: ms ? formatDuration(ms) : 'indefinite' });
    return reply(successEmbed('Muted', `${target.user.tag} muted${ms ? ` for **${formatDuration(ms)}**` : ' indefinitely'}.`));
  }

  if (command === 'unmute') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%unmute @user`'));
    await removeMute(target, guild);
    return reply(successEmbed('Unmuted', `${target.user.tag} can send messages again.`));
  }

  if (command === 'timeout') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target || !args[1]) return reply(errorEmbed('Usage', '`%timeout @user <duration>` e.g. `%timeout @user 10m`'));
    const ms = parseDuration(args[1]);
    if (!ms) return reply(errorEmbed('Invalid Duration', 'Use: `10m` `2h` `1d`'));
    await target.timeout(ms, args.slice(2).join(' ') || 'No reason');
    return reply(successEmbed('Timed Out', `${target.user.tag} timed out for **${formatDuration(ms)}**.`));
  }

  if (command === 'warn') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    const reason = args.slice(1).join(' ');
    if (!target || !reason) return reply(errorEmbed('Usage', '`%warn @user <reason>`'));
    const warns = db.addWarn(guild.id, target.id, reason, member.id);
    db.addLog(guild.id, { action: 'WARN', userId: target.id, modId: member.id, reason });
    if (warns.length >= 3) await applyMute(target, guild);
    if (warns.length >= 5) await target.ban({ reason: 'Auto-ban: 5 warnings' }).catch(() => {});
    await sendLog(guild, new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Warn')
      .addFields({ name: 'User', value: target.user.tag, inline: true }, { name: 'Warns', value: `${warns.length}/5`, inline: true }, { name: 'Reason', value: reason })
      .setFooter({ text: warns.length >= 5 ? '🔨 Auto-banned' : warns.length >= 3 ? '🔇 Auto-muted' : 'No auto-action' }).setTimestamp());
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`warn_action_${target.id}`).setPlaceholder('Additional action...')
        .addOptions(
          { label: 'Mute',       value: 'mute',       emoji: '🔇' },
          { label: 'Quarantine', value: 'quarantine', emoji: '🔒' },
          { label: 'Kick',       value: 'kick',       emoji: '👢' },
          { label: 'Ban',        value: 'ban',        emoji: '🔨' },
          { label: 'Dismiss',    value: 'dismiss',    emoji: '✅' },
        )
    );
    delCmd();
    const m = await channel.send({
      embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Warning Issued')
        .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'Warns', value: `${warns.length}/5`, inline: true }, { name: 'Reason', value: reason })
        .setFooter({ text: warns.length >= 5 ? '🔨 Auto-banned' : warns.length >= 3 ? '🔇 Auto-muted' : 'No auto-action' }).setTimestamp()],
      components: [row],
    });
    setTimeout(() => m.delete().catch(() => {}), 45000);
    return;
  }

  if (command === 'warnings') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first() || member;
    const warns  = db.getWarns(guild.id, target.id);
    const list   = warns.length ? warns.map((w, i) => `**${i+1}.** ${w.reason} — <t:${Math.floor(new Date(w.ts).getTime()/1000)}:R>`).join('\n') : '*No warnings*';
    return reply(new EmbedBuilder().setColor(C.YELLOW).setTitle(`⚠️ Warnings — ${target.user.username}`)
      .setDescription(list).addFields({ name: 'Total', value: `${warns.length}/5`, inline: true })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'clearwarns') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%clearwarns @user`'));
    db.clearWarns(guild.id, target.id);
    return reply(successEmbed('Warnings Cleared', `All warnings removed for **${target.user.tag}**.`));
  }

  if (command === 'purge') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const n = parseInt(args[0]);
    if (isNaN(n) || n < 1 || n > 100) return reply(errorEmbed('Usage', '`%purge <1-100>`'));
    await message.delete().catch(() => {}); deleted = true;
    const deleted2 = await channel.bulkDelete(n, true).catch(() => null);
    const m = await channel.send({ embeds: [successEmbed('Purged', `Deleted **${deleted2?.size ?? 0}** messages.`)] });
    setTimeout(() => m.delete().catch(() => {}), 5000);
    return;
  }

  if (command === 'slowmode') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const secs = parseInt(args[0]);
    if (isNaN(secs) || secs < 0 || secs > 21600) return reply(errorEmbed('Usage', '`%slowmode <0-21600>`'));
    await channel.setRateLimitPerUser(secs);
    return reply(successEmbed('Slowmode', secs === 0 ? 'Slowmode **disabled**.' : `Set to **${secs}s** per message.`));
  }

  if (command === 'lock') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    return reply(successEmbed('Channel Locked 🔒', `${channel} is now locked.`));
  }

  if (command === 'unlock') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    return reply(successEmbed('Channel Unlocked 🔓', `${channel} is now open.`));
  }

  if (command === 'lockdown') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    // Was a sequential for-await loop — this is the direct cause of "lockdown
    // doesn't respond" on servers with more than a handful of channels, since
    // the bot wouldn't reply until every channel was edited one at a time.
    const textChannels = [...guild.channels.cache.values()].filter(ch2 => ch2.isTextBased());
    await Promise.all(textChannels.map(ch2 =>
      ch2.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {})
    ));
    const n = textChannels.length;
    db.addLog(guild.id, { action: 'LOCKDOWN', userId: member.id, modId: member.id });
    await sendLog(guild, new EmbedBuilder().setColor(C.RED).setTitle('🔒 Server Lockdown')
      .addFields({ name: 'By', value: member.user.tag, inline: true }, { name: 'Channels', value: `${n}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp());
    return reply(successEmbed('Lockdown Active 🔒', `${n} channels locked. Use \`%unlockdown\` to restore.`));
  }

  if (command === 'unlockdown') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const textChannels = [...guild.channels.cache.values()].filter(ch2 => ch2.isTextBased());
    await Promise.all(textChannels.map(ch2 =>
      ch2.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {})
    ));
    return reply(successEmbed('Lockdown Lifted 🔓', 'All channels are unlocked.'));
  }

  if (command === 'nick') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%nick @user <new name>` or `%nick @user` to reset'));
    await target.setNickname(args.slice(1).join(' ') || null);
    return reply(successEmbed('Nickname Updated', args[1] ? `Set to: **${args.slice(1).join(' ')}**` : 'Nickname reset.'));
  }

  // ── SECURITY ──────────────────────────────────────────────────────────────

  if (command === 'quarantine') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%quarantine @user`'));
    await applyQuarantine(target, guild);
    db.addLog(guild.id, { action: 'QUARANTINE', userId: target.id, modId: member.id });
    return reply(successEmbed('Quarantined', `${target.user.tag} has been isolated from all channels.`));
  }

  if (command === 'unquarantine') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%unquarantine @user`'));
    const r = guild.roles.cache.find(r2 => r2.name === config.QUARANTINE_ROLE);
    if (r) await target.roles.remove(r);
    return reply(successEmbed('Released', `${target.user.tag} has been released from quarantine.`));
  }

  if (command === 'whitelist') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const users = [...message.mentions.users.values()];
    if (!users.length) return reply(errorEmbed('Usage', '`%whitelist @user`'));
    const s2 = db.getGuild(guild.id);
    for (const u of users) if (!s2.whitelist.includes(u.id)) s2.whitelist.push(u.id);
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Whitelist Updated', users.map(u => `<@${u.id}>`).join(', ') + ' exempt from all detection.'));
  }

  if (command === 'unwhitelist') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const users = [...message.mentions.users.values()];
    const s2    = db.getGuild(guild.id);
    s2.whitelist = s2.whitelist.filter(id => !users.find(u => u.id === id));
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Whitelist Updated', users.map(u => `<@${u.id}>`).join(', ') + ' removed.'));
  }

  if (command === 'whitelistui') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    return replyPerm(infoEmbed('Whitelist', 'Select users to exempt from all detection:'),
      [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('whitelist_add').setPlaceholder('Select users...').setMaxValues(10))]);
  }

  if (command === 'blacklist') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const users = [...message.mentions.users.values()];
    if (!users.length) return reply(errorEmbed('Usage', '`%blacklist @user`'));
    const s2 = db.getGuild(guild.id);
    for (const u of users) if (!s2.blacklist.includes(u.id)) s2.blacklist.push(u.id);
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Blacklisted', users.map(u => `<@${u.id}>`).join(', ') + ' added to blacklist.'));
  }

  if (command === 'trustedroles') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    return replyPerm(infoEmbed('Trusted Roles', 'Members with these roles skip threat detection:'),
      [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('trusted_roles_set').setPlaceholder('Select trusted roles...').setMaxValues(10))]);
  }

  if (command === 'setmaxrole') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    const pos = parseInt(args[0]);
    if (isNaN(pos)) return reply(errorEmbed('Usage', '`%setmaxrole <position number>`'));
    db.updateGuild(guild.id, { maxRolePosition: pos });
    return reply(successEmbed('Max Role Position Set', `Users assigned a role above position **${pos}** will be auto-quarantined.`));
  }

  if (command === 'forbiddenrole') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    const role = message.mentions.roles.first();
    if (!role) return reply(errorEmbed('Usage', '`%forbiddenrole @role`'));
    const s2 = db.getGuild(guild.id);
    if (!s2.forbiddenRoles.includes(role.id)) s2.forbiddenRoles.push(role.id);
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Forbidden Role Added', `Anyone receiving **${role.name}** → auto-quarantine.`));
  }

  if (command === 'unforbiddenrole') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    const role = message.mentions.roles.first();
    const s2   = db.getGuild(guild.id);
    s2.forbiddenRoles = s2.forbiddenRoles.filter(id => id !== role?.id);
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Removed', `**${role?.name}** removed from forbidden list.`));
  }

  if (command === 'addbadword') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const word = args.join(' ').toLowerCase().trim();
    if (!word) return reply(errorEmbed('Usage', '`%addbadword <word>`'));
    const s2 = db.getGuild(guild.id);
    if (!s2.badwords.includes(word)) s2.badwords.push(word);
    s2.modules.badwordFilter = true;
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Word Added', `\`${word}\` added to the filter. Bad word filter enabled.`));
  }

  if (command === 'removebadword') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const word = args.join(' ').toLowerCase().trim();
    const s2   = db.getGuild(guild.id);
    s2.badwords = s2.badwords.filter(w => w !== word);
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Word Removed', `\`${word}\` removed from the filter.`));
  }

  if (command === 'badwords') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    return reply(infoEmbed('Filtered Words', s.badwords?.length ? s.badwords.map(w => `\`${w}\``).join(', ') : '*None configured.*'));
  }

  if (command === 'antihoist') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const s2 = db.getGuild(guild.id);
    s2.modules.antiHoist = !s2.modules.antiHoist;
    db.saveGuild(guild.id, s2);
    if (s2.modules.antiHoist) {
      // Reply immediately, then de-hoist members in the background. On a large
      // server this could be hundreds of members — awaiting them all before
      // replying made the command look stuck for a long time. Promise.all also
      // parallelizes the renames themselves instead of doing them one at a time.
      reply(successEmbed('Anti-Hoist Enabled', 'Members with special-character names are being de-hoisted now (running in the background).'));
      const hoistChars = /^[^a-zA-Z0-9]/;
      const targets = [...guild.members.cache.values()].filter(m2 => hoistChars.test(m2.nickname || m2.user.username));
      Promise.all(targets.map(m2 => {
        const displayName = m2.nickname || m2.user.username;
        return m2.setNickname('! ' + displayName.replace(/^[^a-zA-Z0-9]+/, '')).catch(() => {});
      })).catch(() => {});
      return;
    }
    return reply(successEmbed('Anti-Hoist Disabled', 'Anti-hoist is now off.'));
  }

  if (command === 'disable-bot') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const ms = parseDuration(args[0]);
    if (!ms) return reply(errorEmbed('Usage', '`%disable-bot <duration>` e.g. `30m`'));
    db.updateGuild(guild.id, { detectionEnabled: false });
    setTimeout(() => db.updateGuild(guild.id, { detectionEnabled: true }), ms);
    return reply(warnEmbed('Detection Paused', `Detection disabled for **${formatDuration(ms)}**. Will auto-resume.`));
  }

  if (command === 'enable-bot') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    db.updateGuild(guild.id, { detectionEnabled: true });
    return reply(successEmbed('Detection Re-Enabled', 'All active modules are now running.'));
  }

  // ── THREAT INTELLIGENCE ───────────────────────────────────────────────────

  if (command === 'threatscore') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%threatscore @user`'));
    const data    = ti.getUserScore(target.id, guild.id);
    const signals = ti.getCompromiseSignals(target);
    const recent  = data.events?.slice(-5).map(e => `• +${e.score}: ${e.reasons.join(', ')}`).join('\n') || '*No events recorded*';
    return reply(new EmbedBuilder().setColor(data.score >= 75 ? C.RED : data.score >= 30 ? C.YELLOW : C.GREEN)
      .setTitle(`🎯 Threat Score — ${target.user.tag}`)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: '📊 Score',          value: `${data.score}/150\n${buildScoreBar(data.score)}`, inline: false },
        { name: '⚠️ Static Signals', value: signals.length ? signals.map(s2 => `• [${s2.severity}] ${s2.desc}`).join('\n') : '• None', inline: false },
        { name: '🔍 Recent Events',  value: recent, inline: false },
      ).setFooter({ text: 'WebzHook Guard • Threat Intelligence' }).setTimestamp());
  }

  if (command === 'resetuser') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%resetuser @user`'));
    ti.resetUserScore(target.id, guild.id);
    const qr = guild.roles.cache.find(r => r.name === config.QUARANTINE_ROLE);
    if (qr) await target.roles.remove(qr).catch(() => {});
    await removeMute(target, guild);
    return reply(successEmbed('User Reset', `${target.user.tag}'s threat score cleared and all restrictions removed.`));
  }

  if (command === 'compromisedaction') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const select = new StringSelectMenuBuilder().setCustomId('compromised_action_select')
      .setPlaceholder(`Current: ${s.compromisedAction || 'quarantine'}`)
      .addOptions(
        { label: 'Warn',       value: 'warn',       emoji: '⚠️', description: 'Warn + notify mods' },
        { label: 'Mute',       value: 'mute',       emoji: '🔇', description: 'Mute for configured duration' },
        { label: 'Quarantine', value: 'quarantine', emoji: '🔒', description: 'Remove all channel access (recommended)' },
        { label: 'Kick',       value: 'kick',       emoji: '👢', description: 'Kick from server' },
        { label: 'Ban',        value: 'ban',        emoji: '🔨', description: 'Permanently ban (strict mode)' },
      );
    return replyPerm(infoEmbed('Compromised Account Action', `Currently: **${s.compromisedAction || 'quarantine'}**\nSelect what happens when a scam/compromised account is detected:`),
      [new ActionRowBuilder().addComponents(select)]);
  }

  if (command === 'scansettings') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const t = s.thresholds;
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle('🔍 Threat Detection Settings')
      .addFields(
        { name: '🎯 Score Thresholds', value: `Warn: ${t.threatScoreWarn||30} | Mute: ${t.threatScoreMute||55} | Quarantine: ${t.threatScoreQuarantine||75} | Ban: ${t.threatScoreBan||100}`, inline: false },
        { name: '📷 Image Spam',       value: `Burst: ${t.imageSpamBurst||5} imgs/30s | Extreme: ${t.imageSpamExtreme||10} imgs/60s`, inline: false },
        { name: '👤 Account Gate',     value: `Minimum age to speak: **${t.minAccountAgeDays||7} days**`, inline: false },
        { name: '🚨 Threat Action',    value: `**${s.compromisedAction || 'quarantine'}**`, inline: false },
        { name: '🛡️ Active Modules', value: [
          `Scam Detection: ${s.modules.scamDetection ? '✅' : '❌'}`,
          `Compromised Accts: ${s.modules.compromisedAccounts ? '✅' : '❌'}`,
          `Image Spam: ${s.modules.imageSpamFilter ? '✅' : '❌'}`,
          `New Acct Filter: ${s.modules.newAccountFilter ? '✅' : '❌'}`,
          `Age Gate: ${s.modules.accountAgeGate ? '✅' : '❌'}`,
          `Smart Response: ${s.modules.smartThreatResponse ? '✅' : '❌'}`,
        ].join('\n'), inline: false },
      ).setFooter({ text: 'Use %toggle <module> or %compromisedaction to configure' }).setTimestamp());
  }

  if (command === 'threatreport') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const logs = db.getLogs(guild.id, 25).filter(l =>
      ['AUTO_BAN_THREAT','AUTO_QUARANTINE_THREAT','AUTO_MUTE_THREAT','AUTO_BAN_NUKE','AUTO_QUARANTINE_NEW_ACCT','MANUAL_BAN_THREAT','MANUAL_QUARANTINE_THREAT'].includes(l.action)
    );
    if (!logs.length) return reply(infoEmbed('Threat Report', 'No threat events recorded yet. 🎉'));
    const list = logs.map(l => `\`${l.action}\` — <@${l.userId}> — <t:${Math.floor(new Date(l.ts).getTime()/1000)}:R>${l.reason ? `\n↳ ${l.reason}` : ''}`).join('\n');
    return reply(new EmbedBuilder().setColor(C.RED).setTitle('🚨 Threat Event Report').setDescription(list).setFooter({ text: 'WebzHook Guard • Last 25 threat events' }).setTimestamp());
  }

  if (command === 'scamdomain') {
    const domain = args[0]?.toLowerCase();
    if (!domain) return reply(errorEmbed('Usage', '`%scamdomain <domain>`'));
    const found = ti.SCAM_DOMAINS.find(d => domain.includes(d) || d.includes(domain));
    return reply(found
      ? new EmbedBuilder().setColor(C.RED).setTitle('⛔ Scam Domain Confirmed')
          .setDescription(`\`${domain}\` is in the threat database.\nMatched: \`${found}\`\nThis domain is associated with phishing or scam campaigns.`)
          .setFooter({ text: 'WebzHook Guard • Threat Intel' }).setTimestamp()
      : new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Domain Not Listed')
          .setDescription(`\`${domain}\` is not in the known scam database.\n⚠️ This does not guarantee it is safe.`)
          .setFooter({ text: 'WebzHook Guard • Threat Intel' }).setTimestamp()
    );
  }

  if (command === 'accountagegate') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const days = parseInt(args[0]);
    if (isNaN(days) || days < 0 || days > 365) return reply(errorEmbed('Usage', '`%accountagegate <days>` (0 = disable)'));
    const s2 = db.getGuild(guild.id);
    s2.thresholds.minAccountAgeDays = days;
    s2.modules.accountAgeGate = days > 0;
    db.saveGuild(guild.id, s2);
    return reply(days === 0
      ? successEmbed('Account Age Gate Disabled', 'All accounts can speak regardless of age.')
      : successEmbed('Age Gate Set', `Accounts younger than **${days} day(s)** cannot send messages.`));
  }

  if (command === 'newaccountfilter') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const days = parseInt(args[0]);
    if (isNaN(days) || days < 0) return reply(errorEmbed('Usage', '`%newaccountfilter <days>` (0 = disable)'));
    const s2 = db.getGuild(guild.id);
    s2.thresholds.minAccountAgeDays = days;
    s2.modules.newAccountFilter = days > 0;
    db.saveGuild(guild.id, s2);
    return reply(days === 0
      ? successEmbed('New Account Filter Disabled', 'New accounts will not be auto-quarantined on join.')
      : successEmbed('New Account Filter Set', `Accounts younger than **${days} day(s)** will be auto-quarantined on join.`));
  }

  // ── UTILITY & INFO ────────────────────────────────────────────────────────

  if (command === 'autorole') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    return replyPerm(infoEmbed('Auto-Role', 'Select roles to automatically assign to new members:'),
      [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('autorole_set').setPlaceholder('Select roles...').setMaxValues(5))]);
  }

  if (command === 'setwelcome') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const ch2  = message.mentions.channels.first();
    const msg2 = args.slice(ch2 ? 1 : 0).join(' ');
    const s2   = db.getGuild(guild.id);
    if (ch2) s2.welcomeChannelId = ch2.id;
    if (msg2) s2.welcomeMessage = msg2;
    s2.modules.welcomeSystem = true;
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Welcome System Updated', `Channel: ${ch2 || 'unchanged'}\nMessage: ${msg2 || 'unchanged'}\nVariables: \`{user}\` \`{username}\` \`{server}\` \`{count}\``));
  }

  if (command === 'setleave') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const ch2  = message.mentions.channels.first();
    const msg2 = args.slice(ch2 ? 1 : 0).join(' ');
    const s2   = db.getGuild(guild.id);
    if (ch2) s2.leaveChannelId = ch2.id;
    if (msg2) s2.leaveMessage = msg2;
    s2.modules.leaveSystem = true;
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Leave System Updated', `Channel: ${ch2 || 'unchanged'}\nMessage: ${msg2 || 'unchanged'}`));
  }

  if (command === 'addresponse') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const key = args[0]?.toLowerCase();
    const val = args.slice(1).join(' ');
    if (!key || !val) return reply(errorEmbed('Usage', '`%addresponse <trigger> <response text>`'));
    const s2 = db.getGuild(guild.id);
    s2.responses[key] = val;
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Response Added', `\`%${key}\` → ${val}`));
  }

  if (command === 'delresponse') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const key = args[0]?.toLowerCase();
    if (!key) return reply(errorEmbed('Usage', '`%delresponse <trigger>`'));
    const s2 = db.getGuild(guild.id);
    delete s2.responses[key];
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Response Removed', `\`${key}\` deleted.`));
  }

  if (command === 'responses') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const keys = Object.keys(s.responses || {});
    return reply(infoEmbed('Auto Responses', keys.length ? keys.map(k => `\`%${k}\` → ${s.responses[k]}`).join('\n') : '*None configured.*'));
  }

  if (command === 'userinfo') {
    const target  = message.mentions.members.first() || member;
    const warns   = db.getWarns(guild.id, target.id);
    const score   = ti.getUserScore(target.id, guild.id);
    const roles   = target.roles.cache.filter(r => r.name !== '@everyone').map(r => `${r}`).join(', ') || 'None';
    const ageDays = Math.floor((Date.now() - target.user.createdTimestamp) / 86400000);
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle(`👤 ${target.user.tag}`)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: 'ID',            value: target.id, inline: true },
        { name: 'Account Age',   value: `${ageDays}d`, inline: true },
        { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
        { name: 'Warnings',      value: `${warns.length}/5`, inline: true },
        { name: 'Threat Score',  value: `${score.score}/150`, inline: true },
        { name: 'Bot',           value: target.user.bot ? 'Yes' : 'No', inline: true },
        { name: 'Roles',         value: roles.length > 512 ? roles.slice(0, 509) + '...' : roles },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'serverinfo') {
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle(`🏠 ${guild.name}`)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: 'Owner',       value: `<@${guild.ownerId}>`, inline: true },
        { name: 'Members',     value: `${guild.memberCount}`, inline: true },
        { name: 'Channels',    value: `${guild.channels.cache.size}`, inline: true },
        { name: 'Roles',       value: `${guild.roles.cache.size}`, inline: true },
        { name: 'Boost Level', value: `${guild.premiumTier}`, inline: true },
        { name: 'Created',     value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'roleinfo') {
    const role = message.mentions.roles.first();
    if (!role) return reply(errorEmbed('Usage', '`%roleinfo @role`'));
    return reply(new EmbedBuilder().setColor(role.color || C.BLUE).setTitle(`🎭 ${role.name}`)
      .addFields(
        { name: 'ID',          value: role.id, inline: true },
        { name: 'Color',       value: role.hexColor, inline: true },
        { name: 'Position',    value: `${role.position}`, inline: true },
        { name: 'Members',     value: `${role.members.size}`, inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Hoisted',     value: role.hoist ? 'Yes' : 'No', inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'avatar') {
    const target = message.mentions.users.first() || message.author;
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle(`🖼️ ${target.username}`)
      .setImage(target.displayAvatarURL({ size: 512 })).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'membercount') {
    const bots = guild.members.cache.filter(m2 => m2.user.bot).size;
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle('👥 Member Count')
      .addFields(
        { name: 'Total',  value: `${guild.memberCount}`, inline: true },
        { name: 'Humans', value: `${guild.memberCount - bots}`, inline: true },
        { name: 'Bots',   value: `${bots}`, inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'status') {
    return reply(new EmbedBuilder().setColor(s.detectionEnabled ? C.GREEN : C.ORANGE).setTitle('📊 Server Status')
      .addFields(
        { name: 'Bot',           value: s.enabled ? '🟢 Active' : '🔴 Disabled', inline: true },
        { name: 'Detection',     value: s.detectionEnabled ? '🟢 Active' : '🟡 Paused', inline: true },
        { name: 'Threat Action', value: `**${s.compromisedAction || 'quarantine'}**`, inline: true },
        { name: '🛡️ Core Security', value: [
          `Spam: ${s.modules.antiSpam ? '✅':'❌'}`, `Raid: ${s.modules.antiRaid ? '✅':'❌'}`,
          `Nuke: ${s.modules.antiNuke ? '✅':'❌'}`, `Ping: ${s.modules.antiMassPing ? '✅':'❌'}`,
          `Caps: ${s.modules.antiCaps ? '✅':'❌'}`, `Dupe: ${s.modules.antiDuplicate ? '✅':'❌'}`,
        ].join(' | '), inline: false },
        { name: '🚨 Threat Intel', value: [
          `Scam: ${s.modules.scamDetection ? '✅':'❌'}`, `Compromised: ${s.modules.compromisedAccounts ? '✅':'❌'}`,
          `Image Spam: ${s.modules.imageSpamFilter ? '✅':'❌'}`, `Age Gate: ${s.modules.accountAgeGate ? '✅':'❌'}`,
          `New Acct: ${s.modules.newAccountFilter ? '✅':'❌'}`,
        ].join(' | '), inline: false },
        { name: '📡 Other', value: [
          `Invites: ${s.modules.inviteFilter ? '✅':'❌'}`, `Links: ${s.modules.linkFilter ? '✅':'❌'}`,
          `BadWords: ${s.modules.badwordFilter ? '✅':'❌'}`, `Welcome: ${s.modules.welcomeSystem ? '✅':'❌'}`,
          `Verify: ${s.modules.verification ? '✅':'❌'}`, `AutoRole: ${s.modules.autoRole ? '✅':'❌'}`,
        ].join(' | '), inline: false },
        { name: 'Log Channel',   value: s.logChannelId ? `<#${s.logChannelId}>` : 'Not set', inline: true },
        { name: 'Alert Channel', value: s.alertChannelId ? `<#${s.alertChannelId}>` : 'Not set', inline: true },
        { name: 'Prefix',        value: `\`${s.prefix || '%'}\``, inline: true },
      ).setFooter({ text: 'WebzHook Guard v3.0' }).setTimestamp());
  }

  if (command === 'logs') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const logs = db.getLogs(guild.id, 15);
    if (!logs.length) return reply(infoEmbed('Mod Logs', '*No actions logged yet.*'));
    const list = logs.map(l =>
      `\`${l.action}\` — <@${l.userId}>${l.modId ? ` by <@${l.modId}>` : ''} — <t:${Math.floor(new Date(l.ts).getTime()/1000)}:R>${l.reason ? `\n↳ ${l.reason}` : ''}`
    ).join('\n');
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle('📋 Recent Actions').setDescription(list).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'setupverify') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    delCmd();
    const m = await channel.send({ embeds: [infoEmbed('Setting up verification…', 'Creating channel and role...')] });
    const verifiedRole = await getOrCreateRole(guild, config.VERIFIED_ROLE, { color: C.GREEN, reason: 'Verification setup' });
    // Was a sequential for-await loop doing 2 awaited edits per channel (deny
    // @everyone, allow Verified role) — this is the direct cause of "verification
    // setup takes too long." On a 20-channel server that's 40 sequential API
    // calls before the command could even reply. Now parallelized.
    const gateTargets = [...guild.channels.cache.values()].filter(ch2 => ch2.name !== 'verify');
    await Promise.all(gateTargets.flatMap(ch2 => [
      ch2.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }).catch(() => {}),
      ch2.permissionOverwrites.edit(verifiedRole, { ViewChannel: true }).catch(() => {}),
    ]));
    let verifyCh = guild.channels.cache.find(c2 => c2.name === 'verify');
    if (!verifyCh) verifyCh = await guild.channels.create({
      name: 'verify', type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone, allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.SendMessages] },
        { id: guild.members.me,     allow: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel] },
      ],
    }).catch(() => null);
    const mode = args[0]?.toLowerCase() === 'captcha' ? 'captcha' : 'button';
    const s3   = db.getGuild(guild.id);
    s3.verifyChannelId = verifyCh?.id; s3.verifiedRoleId = verifiedRole.id; s3.modules.verification = true;
    db.saveGuild(guild.id, s3);
    if (verifyCh) await verifyCh.send({
      embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle('🔐 Verification Required').setDescription(s3.verifyMessage || 'Click below to verify yourself.').setFooter({ text: 'WebzHook Guard' }).setTimestamp()],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(mode === 'captcha' ? 'verify_captcha' : 'verify_button').setLabel('✅ Verify Me').setStyle(ButtonStyle.Success)
      )],
    }).catch(() => {});
    return m.edit({ embeds: [successEmbed('Verification Ready! 🔐', `Mode: **${mode}**\nChannel: ${verifyCh}\nRole: ${verifiedRole}`)] });
  }

  if (command === 'invite') {
    return reply(infoEmbed('📩 Invite WebzHook Guard',
      `[Click here to add to your server](https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&scope=bot&permissions=8)`));
  }

  // ── CUSTOM + FUN COMMANDS ─────────────────────────────────────────────────
  const custom = s.customCommands?.find(c2 => c2.name.toLowerCase() === command && c2.enabled !== false);
  if (custom) {
    try {
      const fn = new Function('message', 'args', 'guild', 'member', 'client', custom.code);
      await fn(message, args, guild, member, client);
    } catch (err) {
      return reply(errorEmbed('Command Error', `\`\`\`${err.message.slice(0, 500)}\`\`\``));
    }
    return;
  }

  const fun = s.funCommands?.find(c2 => c2.name.toLowerCase() === command && c2.enabled !== false);
  if (fun) {
    const resp = fun.responses[Math.floor(Math.random() * fun.responses.length)];
    delCmd();
    const m = await channel.send({ content: resp.replace(/{user}/g, `<@${member.id}>`), allowedMentions: { users: [member.id] } });
    setTimeout(() => m.delete().catch(() => {}), 20000);
    return;
  }
}

client.login(process.env.DISCORD_TOKEN);