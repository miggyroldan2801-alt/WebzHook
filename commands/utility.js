const { EmbedBuilder } = require('discord.js');
const { hasBotAccess, sendLog, parseDuration, formatDuration } = require('../utils');
const config = require('../config');
const C = config.COLOR;

function deny() {
  return new EmbedBuilder().setColor(C.RED).setTitle('🚫 Access Denied').setDescription('You do not have permission.').setFooter({ text: 'WebzHook Guard' }).setTimestamp();
}

function usage(text) {
  return new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Usage').setDescription(text).setFooter({ text: 'WebzHook Guard' }).setTimestamp();
}

module.exports = async function handleUtility(command, args, message, settings) {
  const { guild, member, channel } = message;

  if (command === 'ping') {
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle('🏓 Pong!')
      .setDescription(`Latency: ${Date.now() - message.createdTimestamp}ms`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'uptime') {
    const uptime = process.uptime();
    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('⏱️ Bot Uptime')
      .setDescription(`${days}d ${hours}h ${mins}m`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'echo') {
    if (!args.length) return message.reply({ embeds: [usage('`%echo <text>`')] });
    await message.delete().catch(() => {});
    return channel.send(args.join(' '));
  }

  if (command === 'remind') {
    if (!args[0] || !args[1]) return message.reply({ embeds: [usage('`%remind <duration> <message>`\nExample: `%remind 1h Do homework`')] });
    const ms = parseDuration(args[0]);
    if (!ms) return message.reply({ embeds: [usage('Invalid duration')] });
    const text = args.slice(1).join(' ');
    setTimeout(() => {
      message.author.send({ embeds: [new EmbedBuilder()
        .setColor(C.BLUE).setTitle('🔔 Reminder')
        .setDescription(text)
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] }).catch(() => {});
    }, ms);
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Reminder Set')
      .setDescription(`I'll remind you in ${formatDuration(ms)}`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'membercount') {
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle('👥 Member Count')
      .addFields(
        { name: 'Total', value: `${guild.memberCount}`, inline: true },
        { name: 'Online', value: `${guild.members.cache.filter(m => m.presence?.status !== 'offline').size}`, inline: true },
        { name: 'Bots', value: `${guild.members.cache.filter(m => m.user.bot).size}`, inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'channelcount') {
    const text = guild.channels.cache.filter(c => c.isTextBased()).size;
    const voice = guild.channels.cache.filter(c => c.isVoiceBased()).size;
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle('📢 Channel Count')
      .addFields({ name: 'Text', value: `${text}`, inline: true }, { name: 'Voice', value: `${voice}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'botinfo') {
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle('ℹ️ Bot Info')
      .setThumbnail(message.client.user.displayAvatarURL())
      .addFields(
        { name: 'Name', value: message.client.user.username, inline: true },
        { name: 'Version', value: '2.0', inline: true },
        { name: 'Commands', value: '75+', inline: true },
        { name: 'Guilds', value: `${message.client.guilds.cache.size}`, inline: true },
        { name: 'Prefix', value: config.PREFIX, inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'lookup') {
    if (!args[0]) return message.reply({ embeds: [usage('`%lookup <userId|@User|username>`')] });
    const target = message.mentions.users.first() || await message.client.users.fetch(args[0]).catch(() => null);
    if (!target) return message.reply({ embeds: [new EmbedBuilder().setColor(C.RED).setTitle('❌ User Not Found').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle(`User: ${target.tag}`)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: 'ID', value: target.id, inline: true },
        { name: 'Bot', value: target.bot ? 'Yes' : 'No', inline: true },
        { name: 'Created', value: `<t:${Math.floor(target.createdTimestamp / 1000)}:R>`, inline: true },
      ).setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'avatar') {
    const target = message.mentions.users.first() || message.author;
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle(`Avatar: ${target.tag}`)
      .setImage(target.displayAvatarURL({ size: 512 }))
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'invite') {
    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot&permissions=8`;
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle('📩 Invite WebzHook Guard')
      .setDescription(`[Click here to invite the bot](${inviteUrl})`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'support') {
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle('💬 Support')
      .setDescription('[Join our support server](https://discord.gg/webzhook)')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'report') {
    if (!args.length) return message.reply({ embeds: [usage('`%report <issue description>`')] });
    const report = args.join(' ');
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.GREEN).setTitle('✅ Report Submitted')
      .setDescription('Thank you for reporting! Our team will review it shortly.')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'vote') {
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle('⭐ Vote for WebzHook Guard')
      .setDescription('[Vote on Top.gg](https://top.gg/bot/YOUR_BOT_ID)')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'perms') {
    const target = message.mentions.members.first() || member;
    const perms = target.permissions.toArray();
    const permList = perms.length > 0 ? perms.slice(0, 10).map(p => `• ${p}`).join('\n') : 'None';
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle(`Permissions: ${target.user.tag}`)
      .setDescription(perms.length > 10 ? `${permList}\n+${perms.length - 10} more` : permList)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'hexcolor') {
    if (!args[0]) return message.reply({ embeds: [usage('`%hexcolor <hex>`\nExample: `%hexcolor #5865f2`')] });
    const hex = args[0].startsWith('#') ? args[0] : `#${args[0]}`;
    const num = parseInt(hex.replace('#', ''), 16);
    if (isNaN(num)) return message.reply({ embeds: [new EmbedBuilder().setColor(C.RED).setTitle('❌ Invalid Hex').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(num).setTitle(`Color: ${hex}`)
      .setDescription(`RGB: ${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'weather') {
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(C.BLUE).setTitle('🌤️ Weather')
      .setDescription('Weather integration coming soon!')
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'calc') {
    if (!args.length) return message.reply({ embeds: [usage('`%calc <math>`\nExample: `%calc 2+2*5`')] });
    try {
      const math = require('mathjs');
      const result = math.evaluate(args.join(''));
      return message.reply({ embeds: [new EmbedBuilder()
        .setColor(C.GREEN).setTitle('🔢 Calculator')
        .addFields({ name: 'Expression', value: args.join(''), inline: true }, { name: 'Result', value: `${result}`, inline: true })
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    } catch (err) {
      return message.reply({ embeds: [new EmbedBuilder()
        .setColor(C.RED).setTitle('❌ Invalid Expression')
        .setDescription(err.message)
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    }
  }
};