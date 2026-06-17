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

const C = config.COLOR;
const captchaCodes = new Map();

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

// Export client so server.js can use it to check real guild membership
module.exports = client;

// ─────────────────────────────────────────────────────────────────────────────
//  READY
// ─────────────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} online — ${client.guilds.cache.size} guilds`);
  const statuses = [
    { name: `${client.guilds.cache.size} servers | %help`, type: 3 },
    { name: 'for threats 🛡️', type: 2 },
    { name: 'compromised accounts 👁️', type: 2 },
  ];
  let i = 0;
  const rotate = () => {
    client.user.setActivity(statuses[i].name, { type: statuses[i].type });
    i = (i + 1) % statuses.length;
  };
  rotate();
  setInterval(rotate, 20000);
});

// ─────────────────────────────────────────────────────────────────────────────
//  GUILD JOIN — greet + init DB
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildCreate', async guild => {
  db.getGuild(guild.id); // init defaults
  const ch = guild.channels.cache.find(c =>
    c.isTextBased() && c.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages)
  );
  if (!ch) return;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup_start').setLabel('⚡ Quick Setup').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setLabel('📖 Dashboard').setStyle(ButtonStyle.Link).setURL(process.env.DASHBOARD_URL || 'http://localhost:3000')
  );
  await ch.send({
    embeds: [new EmbedBuilder().setColor(C.BLUE)
      .setTitle('👋 WebzHook Guard has joined!')
      .setThumbnail(client.user.displayAvatarURL())
      .setDescription('The bot starts **disabled** for safety. Click **Quick Setup** or run `%setup` to get started.')
      .addFields(
        { name: '🚀 Getting Started', value: '1. Click **Quick Setup**\n2. Run `%enable`\n3. Run `%help` for commands', inline: true },
        { name: '🛡️ What I Do', value: '• Detect scams & phishing\n• Compromised account protection\n• Anti-raid & anti-nuke\n• 80+ commands', inline: true },
      ).setFooter({ text: 'WebzHook Guard v3.0 — Threat Intelligence Edition' }).setTimestamp()],
    components: [row],
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  MEMBER JOIN — welcome + auto-role + account age gate + new account filter
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  const s   = db.getGuild(member.guild.id);
  const now = Date.now();

  // Anti-Raid
  if (s.enabled && s.detectionEnabled && s.modules.antiRaid) {
    const t     = s.thresholds;
    const joins = spam.trackRaid(member.guild.id, t.raidSeconds * 1000);
    if (joins >= t.raidJoins) {
      for (const [, ch] of member.guild.channels.cache) {
        if (ch.isTextBased())
          await ch.permissionOverwrites.edit(member.guild.roles.everyone, { SendMessages: false }).catch(() => {});
      }
      const e = new EmbedBuilder().setColor(C.RED).setTitle('🚨 RAID DETECTED — Server Locked')
        .setDescription(`**${joins} users** joined within ${t.raidSeconds}s. All channels locked.`)
        .addFields({ name: 'Action Required', value: 'Run `%unlockdown` once the raid is over.' })
        .setFooter({ text: 'WebzHook Guard • Anti-Raid' }).setTimestamp();
      await sendLog(member.guild, e);
      await sendAlert(member.guild, e);
    }
  }

  // New account filter — quarantine accounts under minimum age
  if (s.enabled && s.modules.newAccountFilter) {
    const ageDays = (now - member.user.createdTimestamp) / 86400000;
    const minDays = s.thresholds.minAccountAgeDays || 7;
    if (ageDays < minDays) {
      await applyQuarantine(member, member.guild);
      db.addLog(member.guild.id, { action: 'AUTO_QUARANTINE_NEW_ACCT', userId: member.id, reason: `Account only ${Math.floor(ageDays * 24)}h old` });
      const e = new EmbedBuilder().setColor(C.ORANGE).setTitle('⚠️ New Account Auto-Quarantined')
        .addFields(
          { name: 'User', value: `${member.user.tag} (${member.id})`, inline: true },
          { name: 'Account Age', value: `${Math.floor(ageDays * 24)} hours`, inline: true },
          { name: 'Minimum Required', value: `${minDays} days`, inline: true },
        ).setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: 'WebzHook Guard • Account Age Gate' }).setTimestamp();
      await sendLog(member.guild, e);
      await sendAlert(member.guild, e);
      return; // don't apply auto-role to quarantined members
    }
  }

  // Welcome
  if (s.modules.welcomeSystem && s.welcomeChannelId) {
    const ch = member.guild.channels.cache.get(s.welcomeChannelId);
    if (ch) await ch.send({
      embeds: [new EmbedBuilder().setColor(C.GREEN).setTitle('👋 Welcome!')
        .setDescription(formatMessage(s.welcomeMessage, member))
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: member.guild.name }).setTimestamp()],
    }).catch(() => {});
  }

  // Auto-role
  if (s.modules.autoRole && s.autoRoles?.length) {
    for (const rid of s.autoRoles) {
      const role = member.guild.roles.cache.get(rid);
      if (role) await member.roles.add(role).catch(() => {});
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  MEMBER LEAVE
// ─────────────────────────────────────────────────────────────────────────────
client.on('guildMemberRemove', async member => {
  const s = db.getGuild(member.guild.id);
  if (s.modules.leaveSystem && s.leaveChannelId) {
    const ch = member.guild.channels.cache.get(s.leaveChannelId);
    if (ch) await ch.send({
      embeds: [new EmbedBuilder().setColor(C.ORANGE).setTitle('👋 Member Left')
        .setDescription(formatMessage(s.leaveMessage, member))
        .setThumbnail(member.user.displayAvatarURL())
        .setFooter({ text: member.guild.name }).setTimestamp()],
    }).catch(() => {});
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ROLE GUARD — auto-quarantine if forbidden role received
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
      const reason = forbidden ? `Received forbidden role: ${role.name}` : `Role above max position: ${role.name} (pos ${role.position})`;
      db.addLog(newM.guild.id, { action: 'AUTO_QUARANTINE', userId: newM.id, reason });
      const e = new EmbedBuilder().setColor(C.RED).setTitle('🔒 Auto-Quarantine: Role Violation')
        .setDescription(`**${newM.user.tag}** was automatically quarantined.`)
        .addFields({ name: 'Reason', value: reason })
        .setThumbnail(newM.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
      await sendLog(newM.guild, e);
      await sendAlert(newM.guild, e);
      break;
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ANTI-NUKE
// ─────────────────────────────────────────────────────────────────────────────
async function checkNuke(guild, eventName) {
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
    const count = spam.trackNukeAction(exec.id, guild.id, 12000);
    if (count >= (s.thresholds.nukeActions || 3)) {
      if (member) await member.ban({ reason: 'Anti-Nuke: Mass destructive actions' }).catch(() => {});
      else await guild.members.ban(exec.id, { reason: 'Anti-Nuke: Mass destructive actions' }).catch(() => {});
      db.addLog(guild.id, { action: 'AUTO_BAN_NUKE', userId: exec.id, reason: `Anti-Nuke triggered: ${eventName}` });
      const e = new EmbedBuilder().setColor(C.RED).setTitle('💣 NUKE ATTEMPT STOPPED — User Banned')
        .addFields(
          { name: 'User',    value: `${exec.tag} (${exec.id})`, inline: true },
          { name: 'Trigger', value: eventName,                   inline: true },
          { name: 'Actions', value: `${count} in window`,        inline: true },
        ).setFooter({ text: 'WebzHook Guard • Anti-Nuke' }).setTimestamp();
      await sendLog(guild, e);
      await sendAlert(guild, e);
    }
  } catch { /* silent */ }
}
client.on('channelDelete', ch  => checkNuke(ch.guild,   'Channel Deleted'));
client.on('roleDelete',    r   => checkNuke(r.guild,    'Role Deleted'));
client.on('channelCreate', ch  => checkNuke(ch.guild,   'Channel Spam Create'));
client.on('roleCreate',    r   => checkNuke(r.guild,    'Role Spam Create'));

// ─────────────────────────────────────────────────────────────────────────────
//  ALERT HELPER (separate high-priority channel)
// ─────────────────────────────────────────────────────────────────────────────
async function sendAlert(guild, embed) {
  const s  = db.getGuild(guild.id);
  const id = s.alertChannelId || s.logChannelId;
  if (!id) return;
  const ch = guild.channels.cache.get(id);
  if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
//  THREAT RESPONSE — execute the configured action
// ─────────────────────────────────────────────────────────────────────────────
async function executeThreatResponse(member, guild, threat, reasons) {
  const s      = db.getGuild(guild.id);
  const action = s.compromisedAction || 'quarantine';
  const t      = s.thresholds;

  // Determine action based on score + server config
  let chosen = 'warn';
  if (threat.totalScore >= (t.threatScoreBan || 100) && (action === 'ban' || action === 'quarantine')) {
    chosen = action === 'ban' ? 'ban' : 'quarantine';
  } else if (threat.totalScore >= (t.threatScoreQuarantine || 75)) {
    chosen = action === 'ban' ? 'ban' : 'quarantine';
  } else if (threat.totalScore >= (t.threatScoreMute || 55)) {
    chosen = 'mute';
  } else if (threat.totalScore >= (t.threatScoreWarn || 30)) {
    chosen = 'warn';
  }

  let actionTaken = '';

  try {
    if (chosen === 'ban') {
      if (!member.bannable) { chosen = 'quarantine'; }
      else {
        await member.ban({ reason: `WebzHook Guard: Compromised account detected (score ${threat.totalScore})` });
        actionTaken = '🔨 **Banned**';
        db.addLog(guild.id, { action: 'AUTO_BAN_THREAT', userId: member.id, reason: `Threat score ${threat.totalScore}: ${reasons.slice(0,3).join('; ')}` });
      }
    }
    if (chosen === 'quarantine') {
      await applyQuarantine(member, guild);
      actionTaken = '🔒 **Quarantined**';
      db.addLog(guild.id, { action: 'AUTO_QUARANTINE_THREAT', userId: member.id, reason: `Threat score ${threat.totalScore}` });
    }
    if (chosen === 'mute') {
      await applyMute(member, guild);
      setTimeout(() => removeMute(member, guild), (t.muteDuration || 30) * 1000);
      actionTaken = '🔇 **Muted**';
      db.addLog(guild.id, { action: 'AUTO_MUTE_THREAT', userId: member.id, reason: `Threat score ${threat.totalScore}` });
    }
    if (chosen === 'warn') {
      db.addWarn(guild.id, member.id, `Suspicious behaviour detected (score ${threat.totalScore})`, client.user.id);
      actionTaken = '⚠️ **Warned**';
    }
  } catch { actionTaken = '❌ Action failed (insufficient bot permissions)'; }

  // Build threat report embed
  const scoreBar = buildScoreBar(threat.totalScore);
  const e = new EmbedBuilder()
    .setColor(threat.totalScore >= 75 ? C.RED : threat.totalScore >= 55 ? C.ORANGE : C.YELLOW)
    .setTitle('🚨 Compromised / Scam Account Detected')
    .setDescription(`**${member.user.tag}** has been flagged by WebzHook Guard's Threat Intelligence Engine.`)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: '👤 User',          value: `${member} (${member.id})`,           inline: true },
      { name: '🎯 Action Taken',  value: actionTaken,                           inline: true },
      { name: '📊 Threat Score',  value: `${threat.totalScore}/150\n${scoreBar}`, inline: false },
      { name: '🔍 Detection Reasons', value: reasons.length ? reasons.map(r => `• ${r}`).join('\n') : '• Suspicious pattern match', inline: false },
      { name: '📅 Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
      { name: '📥 Joined Server',   value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
    )
    .setFooter({ text: 'WebzHook Guard • Threat Intelligence Engine' })
    .setTimestamp();

  // Action buttons for mods
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`threat_ban_${member.id}`).setLabel('Ban').setStyle(ButtonStyle.Danger).setEmoji('🔨'),
    new ButtonBuilder().setCustomId(`threat_quar_${member.id}`).setLabel('Quarantine').setStyle(ButtonStyle.Secondary).setEmoji('🔒'),
    new ButtonBuilder().setCustomId(`threat_clear_${member.id}`).setLabel('False Positive').setStyle(ButtonStyle.Success).setEmoji('✅'),
  );

  await sendLog(guild, e);
  // Send to alert channel with buttons
  const alertId = s.alertChannelId || s.logChannelId;
  if (alertId) {
    const ch = guild.channels.cache.get(alertId);
    if (ch) await ch.send({ embeds: [e], components: [row] }).catch(() => {});
  }
}

function buildScoreBar(score) {
  const pct   = Math.min(score / 150, 1);
  const total = 20;
  const filled = Math.round(pct * total);
  const bar   = '█'.repeat(filled) + '░'.repeat(total - filled);
  const color = score >= 100 ? '🔴' : score >= 75 ? '🟠' : score >= 55 ? '🟡' : '🟢';
  return `${color} \`${bar}\` ${score}/150`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MESSAGE CREATE
// ─────────────────────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (!message.guild) return;
  const s = db.getGuild(message.guild.id);

  // ── PREFIX COMMANDS ──────────────────────────────────────────────────────
  if (!message.author.bot && message.content.startsWith(s.prefix || config.PREFIX)) {
    const args    = message.content.slice((s.prefix || config.PREFIX).length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();
    await handleCommand(command, args, message, s);
    return;
  }

  // ── DETECTION ENGINE ────────────────────────────────────────────────────
  if (!s.enabled || !s.detectionEnabled) return;
  if (message.author.bot && !message.webhookId) return;

  // Webhook mass-ping / scam webhook
  if (message.webhookId) {
    const mc = message.mentions.users.size + message.mentions.roles.size;
    const ep = message.mentions.everyone;
    if (mc >= config.MASS_PING_THRESHOLD || ep || message.mentions.roles.size > 0) {
      await message.delete().catch(() => {});
      const wh = await client.fetchWebhook(message.webhookId).catch(() => null);
      if (wh) await wh.delete('WebzHook Guard: Malicious mass-ping webhook').catch(() => {});
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

  // Skip whitelisted, trusted roles, and bot managers
  if (s.whitelist.includes(member.id)) return;
  if (hasBotAccess(member)) return;
  if (s.trustedRoles?.some(rid => member.roles.cache.has(rid))) return;

  const t = s.thresholds;

  // ── BAD WORD FILTER ─────────────────────────────────────────────────────
  if (s.modules.badwordFilter && s.badwords?.length) {
    const lower = message.content.toLowerCase();
    if (s.badwords.some(w => lower.includes(w.toLowerCase()))) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, 'Prohibited word', client.user.id);
      return ephemeralReply(message, warnEmbed('Message Removed', `${message.author}, that word isn't allowed here. (Warning ${warns.length}/5)`));
    }
  }

  // ── INVITE FILTER ───────────────────────────────────────────────────────
  if (s.modules.inviteFilter) {
    if (/(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9]+/i.test(message.content)) {
      await message.delete().catch(() => {});
      return ephemeralReply(message, warnEmbed('Invite Removed', `${message.author}, posting Discord invites is not allowed.`));
    }
  }

  // ── LINK FILTER ─────────────────────────────────────────────────────────
  if (s.modules.linkFilter) {
    if (/https?:\/\/[^\s]+/i.test(message.content) && !member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      await message.delete().catch(() => {});
      return ephemeralReply(message, warnEmbed('Link Removed', `${message.author}, posting links is not allowed.`));
    }
  }

  // ── ANTI-MASS-PING ──────────────────────────────────────────────────────
  if (s.modules.antiMassPing) {
    const mc = message.mentions.users.size + message.mentions.roles.size;
    if (mc >= (t.massPingMentions || 5) || message.mentions.everyone) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, `Mass ping (${mc} mentions)`, client.user.id);
      if (warns.length >= 3) await applyMute(member, message.guild);
      await sendLog(message.guild, new EmbedBuilder().setColor(C.RED).setTitle('🚨 Mass Ping Blocked')
        .addFields({ name: 'User', value: `${message.author}`, inline: true }, { name: 'Mentions', value: `${mc}`, inline: true }, { name: 'Warns', value: `${warns.length}`, inline: true })
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp());
      return ephemeralReply(message, warnEmbed('Mass Ping Blocked', `${message.author}, mass pinging is not allowed. Warning ${warns.length}/5.`));
    }
  }

  // ── ANTI-SPAM ───────────────────────────────────────────────────────────
  if (s.modules.antiSpam) {
    const count = spam.trackSpam(message.author.id, message.guild.id, (t.spamSeconds || 4) * 1000);
    if (count >= (t.spamMessages || 5)) {
      await applyMute(member, message.guild);
      setTimeout(() => removeMute(member, message.guild), (t.muteDuration || 30) * 1000);
      await sendLog(message.guild, new EmbedBuilder().setColor(C.ORANGE).setTitle('🔇 Auto-Mute: Spam')
        .addFields({ name: 'User', value: `${message.author}`, inline: true }, { name: 'Duration', value: `${t.muteDuration || 30}s`, inline: true })
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp());
      return;
    }
  }

  // ── ANTI-DUPLICATE ──────────────────────────────────────────────────────
  if (s.modules.antiDuplicate && message.content.length > 5) {
    const dup = spam.trackDuplicate(message.author.id, message.guild.id, message.content);
    if (dup >= (t.duplicateCount || 4)) {
      await message.delete().catch(() => {});
      const warns = db.addWarn(message.guild.id, message.author.id, 'Repeated duplicate messages', client.user.id);
      return ephemeralReply(message, warnEmbed('Duplicate Spam', `${message.author}, stop repeating the same message. Warning ${warns.length}/5.`));
    }
  }

  // ── ANTI-CAPS ───────────────────────────────────────────────────────────
  if (s.modules.antiCaps && message.content.length >= config.CAPS_MIN_LENGTH) {
    const letters = message.content.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 0) {
      const pct = (message.content.replace(/[^A-Z]/g, '').length / letters.length) * 100;
      if (pct >= (t.capsPercent || 80)) {
        await message.delete().catch(() => {});
        return ephemeralReply(message, warnEmbed('Caps Removed', `${message.author}, please avoid excessive capitals.`));
      }
    }
  }

  // ── AUTO-SLOWMODE ───────────────────────────────────────────────────────
  if (s.modules.slowmodeAuto) {
    const burst = spam.trackSpam(`ch_${message.channelId}`, message.guild.id, 5000);
    if (burst >= 15 && message.channel.rateLimitPerUser === 0) {
      await message.channel.setRateLimitPerUser(s.slowmodeAutoSeconds || 5).catch(() => {});
      setTimeout(() => message.channel.setRateLimitPerUser(0).catch(() => {}), 30000);
    }
  }

  // ── IMAGE SPAM DETECTION ─────────────────────────────────────────────────
  if (s.modules.imageSpamFilter) {
    const isImg = ti.isImageAttachment(message);
    if (isImg) {
      const result = ti.trackImageSpam(message.author.id, message.guild.id);
      if (result.score > 0) {
        // Feed into threat score
        const threat = ti.analyseMessage(message, member);
        if (threat.needsMute || threat.needsQuarantine || threat.isCompromised) {
          await message.delete().catch(() => {});
          await executeThreatResponse(member, message.guild, threat, [...result.reasons, ...threat.reasons]);
          return;
        }
      }
    }
  }

  // ── SCAM / COMPROMISED ACCOUNT DETECTION ─────────────────────────────────
  if (s.modules.scamDetection || s.modules.compromisedAccounts) {
    const threat = ti.analyseMessage(message, member);
    if (threat.sessionScore > 0) {
      // If any threat signals, delete the message immediately
      if (threat.sessionScore >= 15) {
        await message.delete().catch(() => {});
      }
      if (threat.needsWarn || threat.needsMute || threat.needsQuarantine || threat.isCompromised) {
        await executeThreatResponse(member, message.guild, threat, threat.reasons);
        return;
      }
    }
  }

  // ── ACCOUNT AGE GATE — min age to speak ─────────────────────────────────
  if (s.modules.accountAgeGate) {
    const ageDays = (Date.now() - message.author.createdTimestamp) / 86400000;
    const minDays = t.minAccountAgeDays || 7;
    if (ageDays < minDays) {
      await message.delete().catch(() => {});
      return ephemeralReply(message, warnEmbed('Account Too New',
        `${message.author}, your account must be at least **${minDays} days old** to send messages here.\nYour account is **${Math.floor(ageDays * 24)} hours** old.`
      ));
    }
  }

  // ── CUSTOM RESPONSES ────────────────────────────────────────────────────
  if (s.responses && Object.keys(s.responses).length) {
    const lower = message.content.toLowerCase().trim();
    const prefix = (s.prefix || config.PREFIX).toLowerCase();
    for (const [trigger, response] of Object.entries(s.responses)) {
      if (lower === trigger.toLowerCase() || lower === prefix + trigger.toLowerCase()) {
        await message.delete().catch(() => {});
        return ephemeralReply(message, infoEmbed(trigger, response));
      }
    }
  }
});

// Helper: send ephemeral-style reply (auto-deletes after 12s, original deleted)
async function ephemeralReply(message, embed) {
  const m = await message.channel.send({ embeds: [embed] }).catch(() => null);
  if (m) setTimeout(() => m.delete().catch(() => {}), 12000);
}

// ─────────────────────────────────────────────────────────────────────────────
//  INTERACTION HANDLER
// ─────────────────────────────────────────────────────────────────────────────
client.on('interactionCreate', async i => {
  try {
    if      (i.isButton())              await handleButton(i);
    else if (i.isStringSelectMenu())    await handleSelectMenu(i);
    else if (i.isUserSelectMenu())      await handleUserSelect(i);
    else if (i.isRoleSelectMenu())      await handleRoleSelect(i);
    else if (i.isModalSubmit())         await handleModal(i);
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: '❌ Something went wrong.', ephemeral: true };
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
    if (!isOwner(i.member)) return i.reply({ embeds: [errorEmbed('Owner Only')], ephemeral: true });
    await i.deferReply({ ephemeral: true });
    await runSetup(i.guild);
    return i.editReply({ embeds: [successEmbed('Setup Complete!', 'Roles & channels created. Run `%enable` to activate.')] });
  }

  if (i.customId === 'verify_button') {
    if (!s.modules.verification || !s.verifiedRoleId) return i.reply({ embeds: [errorEmbed('Verification Disabled')], ephemeral: true });
    const role = i.guild.roles.cache.get(s.verifiedRoleId);
    if (!role) return i.reply({ embeds: [errorEmbed('Role Missing')], ephemeral: true });
    if (i.member.roles.cache.has(role.id)) return i.reply({ embeds: [infoEmbed('Already Verified', 'You already have access!')], ephemeral: true });
    await i.member.roles.add(role);
    return i.reply({ embeds: [successEmbed('Verified! ✅', 'You now have access to the server. Welcome!')], ephemeral: true });
  }

  if (i.customId === 'verify_captcha') {
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    captchaCodes.set(i.user.id, { code, guildId: i.guild.id, expires: Date.now() + 120000 });
    const modal = new ModalBuilder().setCustomId('captcha_submit').setTitle('Human Verification');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('captcha_code')
        .setLabel(`Type this code: ${code}`)
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

  if (i.customId === 'cancel_action') {
    return i.update({ embeds: [infoEmbed('Cancelled', 'No action was taken.')], components: [] });
  }

  // Threat response buttons (from alert channel)
  if (i.customId.startsWith('threat_ban_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid = i.customId.replace('threat_ban_', '');
    await i.guild.members.ban(uid, { reason: `Manual threat response by ${i.user.tag}` }).catch(() => {});
    db.addLog(i.guild.id, { action: 'MANUAL_BAN_THREAT', userId: uid, modId: i.user.id });
    return i.update({ embeds: [successEmbed('User Banned', `<@${uid}> has been banned.`)], components: [] });
  }

  if (i.customId.startsWith('threat_quar_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid = i.customId.replace('threat_quar_', '');
    const target = i.guild.members.cache.get(uid);
    if (target) await applyQuarantine(target, i.guild);
    db.addLog(i.guild.id, { action: 'MANUAL_QUARANTINE_THREAT', userId: uid, modId: i.user.id });
    return i.update({ embeds: [successEmbed('User Quarantined', `<@${uid}> has been quarantined.`)], components: [] });
  }

  if (i.customId.startsWith('threat_clear_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid = i.customId.replace('threat_clear_', '');
    ti.resetUserScore(uid, i.guild.id);
    const target = i.guild.members.cache.get(uid);
    if (target) {
      const qr = i.guild.roles.cache.find(r => r.name === config.QUARANTINE_ROLE);
      if (qr) await target.roles.remove(qr).catch(() => {});
      await removeMute(target, i.guild);
    }
    return i.update({ embeds: [successEmbed('False Positive Cleared', `<@${uid}>'s threat score has been reset and restrictions removed.`)], components: [] });
  }

  // Help navigation
  if (i.customId.startsWith('help_')) {
    const page = i.customId.replace('help_', '');
    return i.update({ embeds: [buildHelpPage(page)], components: [buildHelpRow(page)] });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SELECT MENUS
// ─────────────────────────────────────────────────────────────────────────────
async function handleSelectMenu(i) {
  if (i.customId === 'help_select') {
    return i.update({ embeds: [buildHelpPage(i.values[0])], components: [buildHelpRow(i.values[0])] });
  }

  if (i.customId.startsWith('warn_action_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid    = i.customId.replace('warn_action_', '');
    const action = i.values[0];
    const target = i.guild.members.cache.get(uid);
    if (!target) return i.update({ embeds: [errorEmbed('User Not Found')], components: [] });
    if (action === 'mute')    { await applyMute(target, i.guild); }
    if (action === 'kick')    { await target.kick('Warned: additional action'); }
    if (action === 'ban')     { await target.ban({ reason: 'Warned: additional action' }); }
    if (action === 'quarantine') { await applyQuarantine(target, i.guild); }
    if (action === 'dismiss') { return i.update({ embeds: [infoEmbed('Dismissed', 'No further action.')], components: [] }); }
    return i.update({ embeds: [successEmbed('Action Taken', `${action} applied to <@${uid}>.`)], components: [] });
  }

  if (i.customId === 'compromised_action_select') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const action = i.values[0];
    db.updateGuild(i.guild.id, { compromisedAction: action });
    return i.update({
      embeds: [successEmbed('Compromised Account Action Updated',
        `When a compromised/scam account is detected, the bot will: **${action.toUpperCase()}** the user.`)],
      components: [],
    });
  }
}

async function handleUserSelect(i) {
  if (i.customId === 'whitelist_add') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const s2 = db.getGuild(i.guild.id);
    for (const uid of i.values) if (!s2.whitelist.includes(uid)) s2.whitelist.push(uid);
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Whitelist Updated', i.values.map(u => `<@${u}>`).join(', ') + ' added.')], ephemeral: true });
  }
  if (i.customId === 'blacklist_add') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const s2 = db.getGuild(i.guild.id);
    for (const uid of i.values) if (!s2.blacklist.includes(uid)) s2.blacklist.push(uid);
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Blacklist Updated', i.values.map(u => `<@${u}>`).join(', ') + ' added.')], ephemeral: true });
  }
}

async function handleRoleSelect(i) {
  if (i.customId === 'autorole_set') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const s2 = db.getGuild(i.guild.id);
    s2.autoRoles = i.values;
    s2.modules.autoRole = true;
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Auto-Role Set', i.values.map(r => `<@&${r}>`).join(', ') + ' assigned to new members.')], ephemeral: true });
  }
  if (i.customId === 'trusted_roles_set') {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const s2 = db.getGuild(i.guild.id);
    s2.trustedRoles = i.values;
    db.saveGuild(i.guild.id, s2);
    return i.reply({ embeds: [successEmbed('Trusted Roles Set', i.values.map(r => `<@&${r}>`).join(', ') + ' are now exempt from threat detection.')], ephemeral: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MODAL HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleModal(i) {
  if (i.customId === 'captcha_submit') {
    const session = captchaCodes.get(i.user.id);
    if (!session || session.guildId !== i.guild.id) return i.reply({ embeds: [errorEmbed('Session Expired', 'Click Verify again.')], ephemeral: true });
    if (Date.now() > session.expires) { captchaCodes.delete(i.user.id); return i.reply({ embeds: [errorEmbed('Code Expired', 'Click Verify again.')], ephemeral: true }); }
    const input = i.fields.getTextInputValue('captcha_code').trim().toUpperCase();
    if (input !== session.code) return i.reply({ embeds: [errorEmbed('Wrong Code', 'Incorrect. Try again.')], ephemeral: true });
    captchaCodes.delete(i.user.id);
    const s2 = db.getGuild(i.guild.id);
    const role = i.guild.roles.cache.get(s2.verifiedRoleId);
    if (role) await i.member.roles.add(role);
    return i.reply({ embeds: [successEmbed('Verified! ✅', 'You now have access to the server.')], ephemeral: true });
  }

  if (i.customId.startsWith('warn_modal_')) {
    if (!hasBotAccess(i.member)) return i.reply({ embeds: [errorEmbed('Access Denied')], ephemeral: true });
    const uid    = i.customId.replace('warn_modal_', '');
    const reason = i.fields.getTextInputValue('warn_reason');
    const warns  = db.addWarn(i.guild.id, uid, reason, i.user.id);
    db.addLog(i.guild.id, { action: 'WARN', userId: uid, modId: i.user.id, reason });
    const target = i.guild.members.cache.get(uid);
    if (warns.length >= 3 && target) await applyMute(target, i.guild);
    if (warns.length >= 5 && target) await target.ban({ reason: `Auto-ban: ${warns.length} warnings` });
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`warn_action_${uid}`).setPlaceholder('Additional action...')
        .addOptions(
          { label: 'Mute',        value: 'mute',        emoji: '🔇' },
          { label: 'Quarantine',  value: 'quarantine',  emoji: '🔒' },
          { label: 'Kick',        value: 'kick',        emoji: '👢' },
          { label: 'Ban',         value: 'ban',         emoji: '🔨' },
          { label: 'Dismiss',     value: 'dismiss',     emoji: '✅' },
        )
    );
    return i.reply({
      embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Warning Issued')
        .addFields({ name: 'User', value: `<@${uid}>`, inline: true }, { name: 'Reason', value: reason, inline: true }, { name: 'Total', value: `${warns.length} warn(s)`, inline: true })
        .setFooter({ text: warns.length >= 5 ? '🔨 Auto-banned' : warns.length >= 3 ? '🔇 Auto-muted' : 'No auto-action' }).setTimestamp()],
      components: [row],
      ephemeral: true,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETUP HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function runSetup(guild) {
  for (const [name, opts] of [
    [config.BOT_ACCESS_ROLE,  { color: 0x5865F2 }],
    [config.QUARANTINE_ROLE,  { color: 0x95A5A6 }],
    [config.MUTE_ROLE,        { color: 0x95A5A6 }],
    [config.VERIFIED_ROLE,    { color: 0x57F287 }],
  ]) {
    const role = await getOrCreateRole(guild, name, { ...opts, reason: 'WebzHook Guard setup' });
    if (name === config.QUARANTINE_ROLE || name === config.MUTE_ROLE) {
      for (const [, ch] of guild.channels.cache) {
        await ch.permissionOverwrites.edit(role, { SendMessages: false, AddReactions: false }).catch(() => {});
      }
    }
  }
  let logCh = guild.channels.cache.find(c => c.name === 'webzhook-logs');
  if (!logCh) logCh = await guild.channels.create({
    name: 'webzhook-logs', type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: guild.members.me,     allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
    ],
    reason: 'WebzHook Guard setup',
  });
  let alertCh = guild.channels.cache.find(c => c.name === 'webzhook-alerts');
  if (!alertCh) alertCh = await guild.channels.create({
    name: 'webzhook-alerts', type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: guild.members.me,     allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
    ],
    reason: 'WebzHook Guard threat alerts',
  }).catch(() => null);
  db.updateGuild(guild.id, { logChannelId: logCh.id, alertChannelId: alertCh?.id || logCh.id, setupDone: true });
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELP SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
function buildHelpPage(page = 'main') {
  const pages = {
    main: () => new EmbedBuilder().setColor(C.BLUE).setTitle('📖 WebzHook Guard — Help')
      .setDescription('Select a category from the dropdown. All responses are ephemeral (only you see them).')
      .addFields(
        { name: '⚙️ Setup',         value: '`%setup` `%enable` `%disable` `%setlog`',    inline: true },
        { name: '🔨 Moderation',    value: '`%ban` `%kick` `%mute` `%warn` `%purge`',    inline: true },
        { name: '🛡️ Security',      value: '`%toggle` `%whitelist` `%quarantine`',        inline: true },
        { name: '🚨 Threat Intel',  value: '`%threatscore` `%scansettings` `%resetuser`', inline: true },
        { name: '🔐 Verification',  value: '`%setupverify` `%setverifymode`',             inline: true },
        { name: '⚡ Utility',       value: '`%userinfo` `%serverinfo` `%ping` `%logs`',   inline: true },
      ).setFooter({ text: 'WebzHook Guard v3.0 • Threat Intelligence Edition' }).setTimestamp(),

    security: () => new EmbedBuilder().setColor(C.ORANGE).setTitle('🛡️ Security Commands')
      .addFields(
        { name: '`%toggle <module>`',        value: 'Enable/disable a module (e.g. `%toggle antiSpam`)' },
        { name: '`%modules`',                value: 'View all modules with a live selector' },
        { name: '`%whitelist @user`',        value: 'Exempt users from all detection' },
        { name: '`%unwhitelist @user`',      value: 'Remove from whitelist' },
        { name: '`%whitelistui`',            value: 'Select users to whitelist via dropdown' },
        { name: '`%blacklist @user`',        value: 'Permanently restrict a user' },
        { name: '`%quarantine @user`',       value: 'Remove all permissions from a user' },
        { name: '`%unquarantine @user`',     value: 'Release from quarantine' },
        { name: '`%setmaxrole <pos>`',       value: 'Auto-quarantine if role above this position assigned' },
        { name: '`%forbiddenrole @role`',    value: 'Auto-quarantine anyone who receives this role' },
        { name: '`%trustedroles`',           value: 'Set roles exempt from threat detection' },
        { name: '`%addbadword <word>`',      value: 'Add a word to the filter' },
        { name: '`%badwords`',               value: 'List all filtered words' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),

    threat: () => new EmbedBuilder().setColor(C.RED).setTitle('🚨 Threat Intelligence Commands')
      .setDescription('WebzHook Guard has a built-in AI-like threat scoring engine that detects compromised accounts, scam campaigns, and phishing attempts.')
      .addFields(
        { name: '`%threatscore @user`',      value: 'View a user\'s current threat score and history' },
        { name: '`%resetuser @user`',        value: 'Clear a user\'s threat score (false positive)' },
        { name: '`%scansettings`',           value: 'View/configure threat detection settings' },
        { name: '`%compromisedaction`',      value: 'Set what happens when a compromised account is detected (warn/mute/quarantine/kick/ban)' },
        { name: '`%scamdomain <domain>`',    value: 'Check if a domain is in the scam list' },
        { name: '`%alertchannel #ch`',       value: 'Set channel for high-priority threat alerts' },
        { name: '`%threatreport`',           value: 'View recent threat events in this server' },
        { name: '`%accountagegate <days>`',  value: 'Block accounts younger than X days from speaking' },
        { name: '🔍 Auto-Detection',         value: '• MrBeast / giveaway scam keywords\n• Phishing domain detection\n• Image spam campaigns\n• Rapid-join attack patterns\n• Mass DM attempt detection\n• Multi-channel identical message spam' },
      ).setFooter({ text: 'WebzHook Guard • Threat Intelligence' }).setTimestamp(),

    moderation: () => new EmbedBuilder().setColor(C.RED).setTitle('🔨 Moderation Commands')
      .addFields(
        { name: '`%ban @user [reason]`',          value: 'Ban with confirmation button' },
        { name: '`%tempban @user <dur> [reason]`', value: 'Temp-ban (10m, 2h, 1d)' },
        { name: '`%unban <userId>`',               value: 'Unban by user ID' },
        { name: '`%kick @user [reason]`',          value: 'Kick a member' },
        { name: '`%mute @user [dur] [reason]`',    value: 'Mute (optional duration)' },
        { name: '`%unmute @user`',                 value: 'Remove mute' },
        { name: '`%warn @user <reason>`',          value: 'Warn + follow-up action selector' },
        { name: '`%warnings @user`',               value: 'View warning history' },
        { name: '`%clearwarns @user`',             value: 'Clear all warnings' },
        { name: '`%purge <1-100>`',                value: 'Bulk delete messages' },
        { name: '`%slowmode <secs>`',              value: 'Set channel slowmode' },
        { name: '`%lock [reason]`',                value: 'Lock current channel' },
        { name: '`%unlock`',                       value: 'Unlock current channel' },
        { name: '`%lockdown`',                     value: 'Lock ALL channels' },
        { name: '`%unlockdown`',                   value: 'Unlock ALL channels' },
        { name: '`%nick @user <name>`',            value: 'Set nickname' },
      ).setFooter({ text: 'All responses are ephemeral — only you see them' }).setTimestamp(),

    utility: () => new EmbedBuilder().setColor(C.TEAL).setTitle('⚡ Utility Commands')
      .addFields(
        { name: '`%ping`',             value: 'Latency check' },
        { name: '`%uptime`',           value: 'Bot uptime' },
        { name: '`%userinfo [@user]`', value: 'Detailed user info card' },
        { name: '`%serverinfo`',       value: 'Server stats' },
        { name: '`%roleinfo @role`',   value: 'Role details' },
        { name: '`%avatar [@user]`',   value: 'Get avatar' },
        { name: '`%membercount`',      value: 'Member breakdown' },
        { name: '`%status`',           value: 'Full bot status & module list' },
        { name: '`%logs`',             value: 'Recent mod action log' },
        { name: '`%addresponse <key> <text>`', value: 'Add auto-response trigger' },
        { name: '`%responses`',        value: 'List all auto-responses' },
        { name: '`%setwelcome <msg>`', value: 'Set welcome message (supports {user} {server} {count})' },
        { name: '`%autorole`',         value: 'Set role(s) auto-assigned on join' },
        { name: '`%invite`',           value: 'Bot invite link' },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp(),
  };
  return (pages[page] || pages.main)();
}

function buildHelpRow(active = 'main') {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('help_select').setPlaceholder('📖 Browse categories...')
      .addOptions(
        { label: 'Overview',          value: 'main',       emoji: '🏠', default: active === 'main' },
        { label: 'Security',          value: 'security',   emoji: '🛡️', default: active === 'security' },
        { label: 'Threat Intel',      value: 'threat',     emoji: '🚨', default: active === 'threat' },
        { label: 'Moderation',        value: 'moderation', emoji: '🔨', default: active === 'moderation' },
        { label: 'Utility',           value: 'utility',    emoji: '⚡', default: active === 'utility' },
      )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  COMMAND HANDLER
// ─────────────────────────────────────────────────────────────────────────────
async function handleCommand(command, args, message, s) {
  const { guild, member, channel } = message;

  // Ephemeral reply helper — deletes the command message and auto-removes reply
  const reply = async (embed, components = [], ttl = 15000) => {
    message.delete().catch(() => {});
    const m = await channel.send({ embeds: [embed], components }).catch(() => null);
    if (m && !components.length) setTimeout(() => m.delete().catch(() => {}), ttl);
    return m;
  };
  const replyPerm = (embed, components = []) => {
    message.delete().catch(() => {});
    return channel.send({ embeds: [embed], components });
  };

  // ── HELP ─────────────────────────────────────────────────────────────────
  if (command === 'help') {
    const page = args[0]?.toLowerCase() || 'main';
    message.delete().catch(() => {});
    return channel.send({ embeds: [buildHelpPage(page)], components: [buildHelpRow(page)] });
  }

  // ── PING ──────────────────────────────────────────────────────────────────
  if (command === 'ping') return reply(infoEmbed('🏓 Pong!', `Latency: **${Date.now() - message.createdTimestamp}ms**\nAPI: **${Math.round(client.ws.ping)}ms**`));

  // ── UPTIME ────────────────────────────────────────────────────────────────
  if (command === 'uptime') return reply(infoEmbed('⏱️ Uptime', formatDuration(process.uptime() * 1000)));

  // ── SETUP ─────────────────────────────────────────────────────────────────
  if (command === 'setup') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only', 'Only the server owner can run setup.'));
    message.delete().catch(() => {});
    const m = await channel.send({ embeds: [infoEmbed('Setting up...', 'Creating roles and channels...')] });
    await runSetup(guild);
    return m.edit({ embeds: [successEmbed('Setup Complete!', 'Roles, channels, and permissions configured.\nRun `%enable` to activate protection.')] });
  }

  if (command === 'enable') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    db.updateGuild(guild.id, { enabled: true, detectionEnabled: true });
    return reply(successEmbed('Bot Enabled 🟢', 'WebzHook Guard is now **active** and protecting this server.'));
  }

  if (command === 'disable') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    db.updateGuild(guild.id, { enabled: false, detectionEnabled: false });
    return reply(warnEmbed('Bot Disabled 🔴', 'All protection has been turned off.'));
  }

  if (command === 'setlog') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const ch2 = message.mentions.channels.first();
    if (!ch2) return reply(errorEmbed('Usage', '`%setlog #channel`'));
    db.updateGuild(guild.id, { logChannelId: ch2.id });
    return reply(successEmbed('Log Channel Set', `Logs → ${ch2}`));
  }

  if (command === 'alertchannel') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const ch2 = message.mentions.channels.first();
    if (!ch2) return reply(errorEmbed('Usage', '`%alertchannel #channel`'));
    db.updateGuild(guild.id, { alertChannelId: ch2.id });
    return reply(successEmbed('Alert Channel Set', `High-priority threat alerts → ${ch2}`));
  }

  if (command === 'setprefix') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    const p = args[0];
    if (!p || p.length > 3) return reply(errorEmbed('Invalid', 'Prefix must be 1–3 characters.'));
    db.updateGuild(guild.id, { prefix: p });
    return reply(successEmbed('Prefix Updated', `New prefix: \`${p}\``));
  }

  // ── MODULES ───────────────────────────────────────────────────────────────
  if (command === 'modules') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const moduleList = Object.entries(s.modules);
    const select = new StringSelectMenuBuilder()
      .setCustomId('modules_select').setPlaceholder('Toggle modules...')
      .setMinValues(0).setMaxValues(moduleList.length)
      .addOptions(moduleList.map(([k, v]) => ({ label: k, value: k, emoji: v ? '✅' : '❌', description: `Currently ${v ? 'enabled' : 'disabled'}`, default: v })));
    message.delete().catch(() => {});
    return channel.send({ embeds: [infoEmbed('Module Manager', 'Select all modules you want **enabled**. All others will be disabled.')], components: [new ActionRowBuilder().addComponents(select)] });
  }

  if (command === 'toggle') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const mod = args[0]?.toLowerCase();
    if (!mod || s.modules[mod] === undefined) return reply(warnEmbed('Usage', `\`%toggle <module>\`\nModules: ${Object.keys(s.modules).join(', ')}`));
    s.modules[mod] = !s.modules[mod];
    db.saveGuild(guild.id, s);
    return reply(successEmbed('Module Toggled', `**${mod}** → **${s.modules[mod] ? 'ON ✅' : 'OFF ❌'}**`));
  }

  // ── THREAT INTELLIGENCE COMMANDS ─────────────────────────────────────────

  if (command === 'threatscore') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%threatscore @user`'));
    const data = ti.getUserScore(target.id, guild.id);
    const signals = ti.getCompromiseSignals(target);
    const scoreBar = buildScoreBar(data.score);
    const recentEvents = data.events?.slice(-5).map(e => `• Score +${e.score}: ${e.reasons.join(', ')}`).join('\n') || '*No events recorded*';
    return reply(new EmbedBuilder().setColor(data.score >= 75 ? C.RED : data.score >= 30 ? C.YELLOW : C.GREEN)
      .setTitle(`🎯 Threat Score — ${target.user.tag}`)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: '📊 Score',          value: `${data.score}/150\n${scoreBar}`,      inline: false },
        { name: '⚠️ Signals',        value: signals.length ? signals.map(s2 => `• [${s2.severity}] ${s2.desc}`).join('\n') : '• No static signals', inline: false },
        { name: '🔍 Recent Events',  value: recentEvents,                           inline: false },
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
    return reply(successEmbed('User Reset', `${target.user.tag}'s threat score has been cleared and all restrictions removed.`));
  }

  if (command === 'compromisedaction') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    message.delete().catch(() => {});
    const select = new StringSelectMenuBuilder()
      .setCustomId('compromised_action_select').setPlaceholder('Choose action for detected compromised accounts...')
      .addOptions(
        { label: 'Warn',        value: 'warn',        emoji: '⚠️',  description: 'Warn the user and notify mods' },
        { label: 'Mute',        value: 'mute',        emoji: '🔇',  description: 'Mute for configured duration' },
        { label: 'Quarantine',  value: 'quarantine',  emoji: '🔒',  description: 'Remove all channel access (recommended)' },
        { label: 'Kick',        value: 'kick',        emoji: '👢',  description: 'Kick from server' },
        { label: 'Ban',         value: 'ban',         emoji: '🔨',  description: 'Permanently ban (strict mode)' },
      );
    return channel.send({
      embeds: [infoEmbed('Compromised Account Action', `Current action: **${s.compromisedAction || 'quarantine'}**\n\nChoose what happens when a scam/compromised account is detected:`)],
      components: [new ActionRowBuilder().addComponents(select)],
    });
  }

  if (command === 'scansettings') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const t = s.thresholds;
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle('🔍 Threat Detection Settings')
      .addFields(
        { name: '🎯 Score Thresholds',    value: `Warn: ${t.threatScoreWarn||30} | Mute: ${t.threatScoreMute||55} | Quarantine: ${t.threatScoreQuarantine||75} | Ban: ${t.threatScoreBan||100}`, inline: false },
        { name: '📷 Image Spam',          value: `Burst: ${t.imageSpamBurst||5} images/30s | Extreme: ${t.imageSpamExtreme||10} images/60s`, inline: false },
        { name: '👤 Account Age Gate',    value: `Minimum age: ${t.minAccountAgeDays||7} days`, inline: false },
        { name: '🚨 Action on Detection', value: `**${s.compromisedAction || 'quarantine'}**`, inline: false },
        { name: '📡 Active Modules',      value: [
          s.modules.scamDetection     ? '✅ Scam Detection'         : '❌ Scam Detection',
          s.modules.compromisedAccounts ? '✅ Compromised Accounts'  : '❌ Compromised Accounts',
          s.modules.imageSpamFilter   ? '✅ Image Spam Filter'      : '❌ Image Spam Filter',
          s.modules.dmSpamWatch       ? '✅ DM Spam Watch'          : '❌ DM Spam Watch',
          s.modules.newAccountFilter  ? '✅ New Account Filter'     : '❌ New Account Filter',
          s.modules.accountAgeGate    ? '✅ Account Age Gate'       : '❌ Account Age Gate',
          s.modules.smartThreatResponse ? '✅ Smart Threat Response' : '❌ Smart Threat Response',
        ].join('\n'), inline: false },
      ).setFooter({ text: 'Use %toggle <module> to enable/disable | %compromisedaction to change action' }).setTimestamp());
  }

  if (command === 'threatreport') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const logs = db.getLogs(guild.id, 20).filter(l => l.action.includes('THREAT') || l.action.includes('NUKE') || l.action.includes('QUARANTINE'));
    if (!logs.length) return reply(infoEmbed('Threat Report', 'No threat events recorded yet.'));
    const list = logs.map(l => `\`${l.action}\` — <@${l.userId}> — <t:${Math.floor(new Date(l.ts).getTime()/1000)}:R>${l.reason ? `\n↳ ${l.reason}` : ''}`).join('\n');
    return reply(new EmbedBuilder().setColor(C.RED).setTitle('🚨 Threat Report').setDescription(list).setFooter({ text: 'WebzHook Guard • Last 20 threat events' }).setTimestamp());
  }

  if (command === 'scamdomain') {
    const domain = args[0]?.toLowerCase();
    if (!domain) return reply(errorEmbed('Usage', '`%scamdomain <domain>`'));
    const found = ti.SCAM_DOMAINS.find(d => domain.includes(d) || d.includes(domain));
    return reply(found
      ? new EmbedBuilder().setColor(C.RED).setTitle('⛔ Scam Domain Confirmed').setDescription(`\`${domain}\` is in the threat database.\nPattern matched: \`${found}\`\nThis domain is associated with phishing, scam giveaways, or Discord exploitation.`).setFooter({ text: 'WebzHook Guard • Threat Intel' }).setTimestamp()
      : new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Domain Not Listed').setDescription(`\`${domain}\` is not in the known scam domain database.\n⚠️ This does not guarantee it is safe.`).setFooter({ text: 'WebzHook Guard • Threat Intel' }).setTimestamp()
    );
  }

  if (command === 'accountagegate') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const days = parseInt(args[0]);
    if (isNaN(days) || days < 0 || days > 365) return reply(errorEmbed('Usage', '`%accountagegate <days>` (0–365, 0 = disable)'));
    const s2 = db.getGuild(guild.id);
    s2.thresholds.minAccountAgeDays = days;
    s2.modules.accountAgeGate = days > 0;
    db.saveGuild(guild.id, s2);
    return reply(days === 0
      ? successEmbed('Account Age Gate Disabled', 'All accounts can now speak regardless of age.')
      : successEmbed('Account Age Gate Set', `Accounts younger than **${days} day(s)** cannot send messages.`)
    );
  }

  // ── MODERATION ───────────────────────────────────────────────────────────

  if (command === 'ban') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%ban @user [reason]`'));
    if (!target.bannable) return reply(errorEmbed('Cannot Ban', 'I cannot ban this user — they may outrank me.'));
    const reason = args.slice(1).join(' ') || 'No reason provided';
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`confirm_ban_${target.id}`).setLabel('Confirm Ban').setStyle(ButtonStyle.Danger).setEmoji('🔨'),
      new ButtonBuilder().setCustomId('cancel_action').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('✖️'),
    );
    return replyPerm(new EmbedBuilder().setColor(C.RED).setTitle('⚠️ Confirm Ban')
      .setDescription(`Ban **${target.user.tag}**?`)
      .addFields({ name: 'Reason', value: reason })
      .setThumbnail(target.user.displayAvatarURL())
      .setFooter({ text: 'This action is permanent' }).setTimestamp(), [row]);
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
    db.addLog(guild.id, { action: 'TEMPBAN', userId: target.id, modId: member.id, reason });
    await sendLog(guild, new EmbedBuilder().setColor(C.RED).setTitle('⏱️ Temp-Ban').addFields({ name: 'User', value: target.user.tag, inline: true }, { name: 'Duration', value: formatDuration(ms), inline: true }, { name: 'Reason', value: reason }).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
    return reply(successEmbed('Temp-Banned', `${target.user.tag} banned for **${formatDuration(ms)}**.`));
  }

  if (command === 'unban') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    if (!args[0]) return reply(errorEmbed('Usage', '`%unban <userId>`'));
    await guild.members.unban(args[0]).catch(() => {});
    return reply(successEmbed('Unbanned', `User \`${args[0]}\` has been unbanned.`));
  }

  if (command === 'kick') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%kick @user [reason]`'));
    if (!target.kickable) return reply(errorEmbed('Cannot Kick'));
    const reason = args.slice(1).join(' ') || 'No reason';
    await target.kick(reason);
    db.addLog(guild.id, { action: 'KICK', userId: target.id, modId: member.id, reason });
    await sendLog(guild, new EmbedBuilder().setColor(C.ORANGE).setTitle('👢 Kicked').addFields({ name: 'User', value: target.user.tag, inline: true }, { name: 'By', value: member.user.tag, inline: true }, { name: 'Reason', value: reason }).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
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
    db.addLog(guild.id, { action: 'MUTE', userId: target.id, modId: member.id, reason });
    return reply(successEmbed('Muted', `${target.user.tag} muted${ms ? ` for **${formatDuration(ms)}**` : ' indefinitely'}.`));
  }

  if (command === 'unmute') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%unmute @user`'));
    await removeMute(target, guild);
    return reply(successEmbed('Unmuted', `${target.user.tag} can now send messages.`));
  }

  if (command === 'warn') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    const reason = args.slice(1).join(' ');
    if (!target || !reason) return reply(errorEmbed('Usage', '`%warn @user <reason>`'));
    const warns = db.addWarn(guild.id, target.id, reason, member.id);
    db.addLog(guild.id, { action: 'WARN', userId: target.id, modId: member.id, reason });
    if (warns.length >= 3) await applyMute(target, guild);
    if (warns.length >= 5) await target.ban({ reason: `Auto-ban: 5 warnings` });
    const actionRow = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`warn_action_${target.id}`).setPlaceholder('Additional action...')
        .addOptions(
          { label: 'Mute',       value: 'mute',       emoji: '🔇' },
          { label: 'Quarantine', value: 'quarantine', emoji: '🔒' },
          { label: 'Kick',       value: 'kick',       emoji: '👢' },
          { label: 'Ban',        value: 'ban',        emoji: '🔨' },
          { label: 'Dismiss',    value: 'dismiss',    emoji: '✅' },
        )
    );
    await sendLog(guild, new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Warn').addFields({ name: 'User', value: target.user.tag, inline: true }, { name: 'Warns', value: `${warns.length}`, inline: true }, { name: 'Reason', value: reason }).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
    message.delete().catch(() => {});
    const m = await channel.send({
      embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Warning Issued')
        .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'Warns', value: `${warns.length}/5`, inline: true }, { name: 'Reason', value: reason })
        .setFooter({ text: warns.length >= 5 ? '🔨 Auto-banned' : warns.length >= 3 ? '🔇 Auto-muted' : 'No auto-action' }).setTimestamp()],
      components: [actionRow],
    });
    setTimeout(() => m.delete().catch(() => {}), 45000);
    return;
  }

  if (command === 'warnings') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first() || member;
    const warns  = db.getWarns(guild.id, target.id);
    const list   = warns.length ? warns.map((w, i) => `**${i+1}.** ${w.reason} — <t:${Math.floor(new Date(w.ts).getTime()/1000)}:R>`).join('\n') : '*No warnings*';
    return reply(new EmbedBuilder().setColor(C.YELLOW).setTitle(`⚠️ ${target.user.username} — Warnings`)
      .setDescription(list).addFields({ name: 'Total', value: `${warns.length}`, inline: true })
      .setThumbnail(target.user.displayAvatarURL()).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'clearwarns') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%clearwarns @user`'));
    db.clearWarns(guild.id, target.id);
    return reply(successEmbed('Warnings Cleared', `All warnings removed for ${target.user.tag}.`));
  }

  if (command === 'purge') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const n = parseInt(args[0]);
    if (isNaN(n) || n < 1 || n > 100) return reply(errorEmbed('Usage', '`%purge <1-100>`'));
    const deleted = await channel.bulkDelete(n + 1, true).catch(() => null); // +1 to include command msg
    const m = await channel.send({ embeds: [successEmbed('Purged', `Deleted **${(deleted?.size || 1) - 1}** messages.`)] });
    setTimeout(() => m.delete().catch(() => {}), 5000);
    return;
  }

  if (command === 'slowmode') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const secs = parseInt(args[0]);
    if (isNaN(secs) || secs < 0 || secs > 21600) return reply(errorEmbed('Usage', '`%slowmode <0-21600>`'));
    await channel.setRateLimitPerUser(secs);
    return reply(successEmbed('Slowmode', secs === 0 ? 'Slowmode disabled.' : `Set to **${secs}s**.`));
  }

  if (command === 'lock') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false });
    return reply(successEmbed('Channel Locked 🔒', `${channel} has been locked.`));
  }

  if (command === 'unlock') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null });
    return reply(successEmbed('Channel Unlocked 🔓', `${channel} is open again.`));
  }

  if (command === 'lockdown') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    let n = 0;
    for (const [, ch2] of guild.channels.cache) {
      if (ch2.isTextBased()) { await ch2.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {}); n++; }
    }
    await sendLog(guild, new EmbedBuilder().setColor(C.RED).setTitle('🚨 Server Lockdown').addFields({ name: 'By', value: member.user.tag, inline: true }, { name: 'Channels', value: `${n}`, inline: true }).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
    return reply(successEmbed('Lockdown Active 🔒', `${n} channels locked. Run \`%unlockdown\` to restore.`));
  }

  if (command === 'unlockdown') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    for (const [, ch2] of guild.channels.cache) {
      if (ch2.isTextBased()) await ch2.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }).catch(() => {});
    }
    return reply(successEmbed('Lockdown Lifted 🔓', 'All channels are unlocked.'));
  }

  if (command === 'nick') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%nick @user <nickname>`'));
    const nick = args.slice(1).join(' ') || null;
    await target.setNickname(nick);
    return reply(successEmbed('Nickname Updated', nick ? `Set to: **${nick}**` : 'Reset to default.'));
  }

  if (command === 'quarantine') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const target = message.mentions.members.first();
    if (!target) return reply(errorEmbed('Usage', '`%quarantine @user`'));
    await applyQuarantine(target, guild);
    db.addLog(guild.id, { action: 'QUARANTINE', userId: target.id, modId: member.id });
    return reply(successEmbed('Quarantined', `${target.user.tag} has been isolated.`));
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
    return reply(successEmbed('Whitelist Updated', users.map(u => `<@${u.id}>`).join(', ') + ' exempt from detection.'));
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
    message.delete().catch(() => {});
    return channel.send({ embeds: [infoEmbed('Whitelist', 'Select users to exempt from all detection:')], components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId('whitelist_add').setPlaceholder('Select users...').setMaxValues(10))] });
  }

  if (command === 'trustedroles') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    message.delete().catch(() => {});
    return channel.send({ embeds: [infoEmbed('Trusted Roles', 'Members with these roles will skip threat detection:')], components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('trusted_roles_set').setPlaceholder('Select trusted roles...').setMaxValues(10))] });
  }

  if (command === 'blacklist') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const users = [...message.mentions.users.values()];
    if (!users.length) return reply(errorEmbed('Usage', '`%blacklist @user`'));
    const s2 = db.getGuild(guild.id);
    for (const u of users) if (!s2.blacklist.includes(u.id)) s2.blacklist.push(u.id);
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Blacklisted', users.map(u => `<@${u.id}>`).join(', ') + ' blacklisted.'));
  }

  if (command === 'setmaxrole') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    const pos = parseInt(args[0]);
    if (isNaN(pos)) return reply(errorEmbed('Usage', '`%setmaxrole <position>`'));
    db.updateGuild(guild.id, { maxRolePosition: pos });
    return reply(successEmbed('Max Role Set', `Auto-quarantine anyone receiving a role above position **${pos}**.`));
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

  if (command === 'addbadword') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const word = args[0]?.toLowerCase();
    if (!word) return reply(errorEmbed('Usage', '`%addbadword <word>`'));
    const s2 = db.getGuild(guild.id);
    if (!s2.badwords.includes(word)) s2.badwords.push(word);
    s2.modules.badwordFilter = true;
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Bad Word Added', `\`${word}\` added. Filter enabled.`));
  }

  if (command === 'badwords') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    return reply(infoEmbed('Bad Word Filter', s.badwords?.length ? s.badwords.map(w => `\`${w}\``).join(', ') : '*None configured*'));
  }

  if (command === 'autorole') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    message.delete().catch(() => {});
    return channel.send({ embeds: [infoEmbed('Auto-Role', 'Select roles to auto-assign to new members:')], components: [new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('autorole_set').setPlaceholder('Select roles...').setMaxValues(5))] });
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
    return reply(successEmbed('Welcome System Updated', `Channel: ${ch2 || 'unchanged'}\nMessage: ${msg2 || 'unchanged'}\nVariables: {user} {username} {server} {count}`));
  }

  if (command === 'addresponse') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const key = args[0]?.toLowerCase();
    const val = args.slice(1).join(' ');
    if (!key || !val) return reply(errorEmbed('Usage', '`%addresponse <key> <response text>`'));
    const s2 = db.getGuild(guild.id);
    s2.responses[key] = val;
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Response Added', `\`%${key}\` → ${val}`));
  }

  if (command === 'delresponse') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const key = args[0]?.toLowerCase();
    if (!key) return reply(errorEmbed('Usage', '`%delresponse <key>`'));
    const s2 = db.getGuild(guild.id);
    delete s2.responses[key];
    db.saveGuild(guild.id, s2);
    return reply(successEmbed('Response Removed', `\`${key}\` deleted.`));
  }

  if (command === 'responses') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const keys = Object.keys(s.responses || {});
    return reply(infoEmbed('Auto Responses', keys.length ? keys.map(k => `\`%${k}\` → ${s.responses[k]}`).join('\n') : '*None configured*'));
  }

  if (command === 'disable-bot') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const ms = parseDuration(args[0]);
    if (!ms) return reply(errorEmbed('Usage', '`%disable-bot <duration>` e.g. `30m`'));
    db.updateGuild(guild.id, { detectionEnabled: false });
    setTimeout(() => db.updateGuild(guild.id, { detectionEnabled: true }), ms);
    return reply(warnEmbed('Detection Paused', `All detection disabled for **${formatDuration(ms)}**. Auto-resumes after.`));
  }

  if (command === 'enable-bot') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    db.updateGuild(guild.id, { detectionEnabled: true });
    return reply(successEmbed('Detection Re-Enabled', 'All modules are active.'));
  }

  // ── INFO COMMANDS ─────────────────────────────────────────────────────────

  if (command === 'userinfo') {
    const target = message.mentions.members.first() || member;
    const warns  = db.getWarns(guild.id, target.id);
    const score  = ti.getUserScore(target.id, guild.id);
    const roles  = target.roles.cache.filter(r => r.name !== '@everyone').map(r => `${r}`).join(', ') || 'None';
    const ageDays = Math.floor((Date.now() - target.user.createdTimestamp) / 86400000);
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle(`👤 ${target.user.tag}`)
      .setThumbnail(target.user.displayAvatarURL())
      .addFields(
        { name: 'ID',               value: target.id,                                                        inline: true },
        { name: 'Account Age',      value: `${ageDays}d`,                                                    inline: true },
        { name: 'Joined Server',    value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`,             inline: true },
        { name: 'Warnings',         value: `${warns.length}`,                                                inline: true },
        { name: 'Threat Score',     value: `${score.score}/150`,                                             inline: true },
        { name: 'Roles',            value: roles.length > 512 ? roles.slice(0, 509) + '...' : roles },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'serverinfo') {
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle(`🏠 ${guild.name}`)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: 'Owner',        value: `<@${guild.ownerId}>`,            inline: true },
        { name: 'Members',      value: `${guild.memberCount}`,            inline: true },
        { name: 'Channels',     value: `${guild.channels.cache.size}`,   inline: true },
        { name: 'Roles',        value: `${guild.roles.cache.size}`,      inline: true },
        { name: 'Boost Level',  value: `${guild.premiumTier}`,           inline: true },
        { name: 'Created',      value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'roleinfo') {
    const role = message.mentions.roles.first();
    if (!role) return reply(errorEmbed('Usage', '`%roleinfo @role`'));
    return reply(new EmbedBuilder().setColor(role.color || C.BLUE).setTitle(`🎭 ${role.name}`)
      .addFields(
        { name: 'ID',          value: role.id,               inline: true },
        { name: 'Color',       value: role.hexColor,         inline: true },
        { name: 'Position',    value: `${role.position}`,    inline: true },
        { name: 'Members',     value: `${role.members.size}`,inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
        { name: 'Hoisted',     value: role.hoist ? 'Yes' : 'No',       inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'avatar') {
    const target = message.mentions.users.first() || message.author;
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle(`🖼️ ${target.username}`)
      .setImage(target.displayAvatarURL({ size: 512 })).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'membercount') {
    const bots   = guild.members.cache.filter(m2 => m2.user.bot).size;
    const humans = guild.memberCount - bots;
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle('👥 Member Count')
      .addFields({ name: 'Total', value: `${guild.memberCount}`, inline: true }, { name: 'Humans', value: `${humans}`, inline: true }, { name: 'Bots', value: `${bots}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'status') {
    const score = buildScoreBar(0);
    return reply(new EmbedBuilder().setColor(s.detectionEnabled ? C.GREEN : C.ORANGE).setTitle('📊 Server Status')
      .addFields(
        { name: 'Bot',               value: s.enabled          ? '🟢 Active'   : '🔴 Disabled', inline: true },
        { name: 'Detection',         value: s.detectionEnabled  ? '🟢 Active'   : '🟡 Paused',  inline: true },
        { name: 'Action on Threat',  value: `**${s.compromisedAction || 'quarantine'}**`,         inline: true },
        { name: '🛡️ Security',       value: [
          `Anti-Spam: ${s.modules.antiSpam      ? '✅' : '❌'}`,
          `Anti-Raid: ${s.modules.antiRaid      ? '✅' : '❌'}`,
          `Anti-Nuke: ${s.modules.antiNuke      ? '✅' : '❌'}`,
          `Anti-Ping: ${s.modules.antiMassPing  ? '✅' : '❌'}`,
        ].join('\n'), inline: true },
        { name: '🚨 Threat Intel',   value: [
          `Scam Detection: ${s.modules.scamDetection      ? '✅' : '❌'}`,
          `Compromised Accts: ${s.modules.compromisedAccounts ? '✅' : '❌'}`,
          `Image Spam: ${s.modules.imageSpamFilter         ? '✅' : '❌'}`,
          `New Account Filter: ${s.modules.newAccountFilter ? '✅' : '❌'}`,
          `Age Gate: ${s.modules.accountAgeGate            ? '✅' : '❌'}`,
        ].join('\n'), inline: true },
        { name: '📡 Other',          value: [
          `Invite Filter: ${s.modules.inviteFilter  ? '✅' : '❌'}`,
          `Link Filter: ${s.modules.linkFilter      ? '✅' : '❌'}`,
          `Bad Words: ${s.modules.badwordFilter     ? '✅' : '❌'}`,
          `Verification: ${s.modules.verification   ? '✅' : '❌'}`,
          `Auto-Role: ${s.modules.autoRole          ? '✅' : '❌'}`,
          `Welcome: ${s.modules.welcomeSystem       ? '✅' : '❌'}`,
        ].join('\n'), inline: true },
        { name: 'Log Channel',   value: s.logChannelId   ? `<#${s.logChannelId}>`   : 'Not set', inline: true },
        { name: 'Alert Channel', value: s.alertChannelId ? `<#${s.alertChannelId}>` : 'Not set', inline: true },
        { name: 'Prefix',        value: `\`${s.prefix || '%'}\``, inline: true },
      ).setFooter({ text: 'WebzHook Guard v3.0 • Threat Intelligence Edition' }).setTimestamp());
  }

  if (command === 'logs') {
    if (!hasBotAccess(member)) return reply(errorEmbed('Access Denied'));
    const logs = db.getLogs(guild.id, 15);
    if (!logs.length) return reply(infoEmbed('Mod Logs', '*No actions logged yet.*'));
    const list = logs.map(l => `\`${l.action}\` — <@${l.userId}>${l.modId ? ` by <@${l.modId}>` : ''} — <t:${Math.floor(new Date(l.ts).getTime()/1000)}:R>${l.reason ? `\n↳ ${l.reason}` : ''}`).join('\n');
    return reply(new EmbedBuilder().setColor(C.BLUE).setTitle('📋 Recent Actions').setDescription(list).setFooter({ text: 'WebzHook Guard' }).setTimestamp());
  }

  if (command === 'setupverify') {
    if (!isOwner(member)) return reply(errorEmbed('Owner Only'));
    message.delete().catch(() => {});
    const m = await channel.send({ embeds: [infoEmbed('Setting up verification...', 'Creating channel and role...')] });
    const verifiedRole = await getOrCreateRole(guild, config.VERIFIED_ROLE, { color: C.GREEN, reason: 'Verification setup' });
    for (const [, ch2] of guild.channels.cache) {
      if (ch2.name !== 'verify') {
        await ch2.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }).catch(() => {});
        await ch2.permissionOverwrites.edit(verifiedRole, { ViewChannel: true }).catch(() => {});
      }
    }
    let verifyCh = guild.channels.cache.find(c2 => c2.name === 'verify');
    if (!verifyCh) verifyCh = await guild.channels.create({
      name: 'verify', type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone, allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.SendMessages] },
        { id: guild.members.me, allow: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel] },
      ],
    });
    const mode = args[0]?.toLowerCase() === 'captcha' ? 'captcha' : 'button';
    const s3   = db.getGuild(guild.id);
    s3.verifyChannelId = verifyCh.id; s3.verifiedRoleId = verifiedRole.id; s3.modules.verification = true;
    db.saveGuild(guild.id, s3);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(mode === 'captcha' ? 'verify_captcha' : 'verify_button').setLabel('✅ Verify Me').setStyle(ButtonStyle.Success)
    );
    await verifyCh.send({
      embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle('🔐 Verification Required').setDescription(s3.verifyMessage).setFooter({ text: 'WebzHook Guard' }).setTimestamp()],
      components: [row],
    });
    return m.edit({ embeds: [successEmbed('Verification Ready', `Mode: **${mode}**\nChannel: ${verifyCh}\nRole: ${verifiedRole}`)] });
  }

  if (command === 'invite') {
    return reply(infoEmbed('📩 Invite Bot', `[Click here to add WebzHook Guard](https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&scope=bot&permissions=8)`));
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
    message.delete().catch(() => {});
    const m = await channel.send({ content: resp.replace(/{user}/g, `<@${member.id}>`), allowedMentions: { users: [member.id] } });
    setTimeout(() => m.delete().catch(() => {}), 20000);
    return;
  }
}

client.login(process.env.DISCORD_TOKEN);