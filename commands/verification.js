const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType } = require('discord.js');
const { isOwner, hasBotAccess, getOrCreateRole } = require('../utils');
const { getGuild, updateGuild } = require('../database');
const config = require('../config');
const C = config.COLOR;

const captchaSessions = new Map();

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

module.exports = async function handleVerification(command, args, message, settings) {
  const { guild, member } = message;

  if (command === 'setupverify') {
    if (!isOwner(member)) return message.reply({ embeds: [deny()] });

    const verifiedRole = await getOrCreateRole(guild, 'Verified', {
      color: C.GREEN, reason: 'WebzHook Guard verification setup'
    });

    for (const [, ch] of guild.channels.cache) {
      await ch.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false }).catch(() => {});
      await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: true }).catch(() => {});
    }

    let verifyCh = guild.channels.cache.find(c => c.name === 'verify');
    if (!verifyCh) {
      verifyCh = await guild.channels.create({
        name: 'verify',
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: guild.roles.everyone, allow: [PermissionsBitField.Flags.ViewChannel], deny: [PermissionsBitField.Flags.SendMessages] },
          { id: guild.members.me, allow: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ViewChannel] },
          { id: verifiedRole, deny: [PermissionsBitField.Flags.ViewChannel] },
        ],
        reason: 'WebzHook Guard verification channel',
      });
    }

    updateGuild(guild.id, { verifyChannelId: verifyCh.id, verifiedRoleId: verifiedRole.id, verifyMode: 'button' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('verify_start').setLabel('✅ Verify Me').setStyle(ButtonStyle.Success)
    );
    await verifyCh.send({
      embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle('🔐 Verification Required')
        .setDescription('Click the button below to verify yourself and gain access to the server.')
        .setFooter({ text: 'WebzHook Guard • Verification' }).setTimestamp()],
      components: [row],
    });

    return message.reply({ embeds: [new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Verification Setup Complete')
      .setDescription(`Verify channel: ${verifyCh}\nVerified role: ${verifiedRole}\nAll channels are now gated behind verification.`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'setverifymode') {
    if (!isOwner(member)) return message.reply({ embeds: [deny()] });
    const mode = args[0]?.toLowerCase();
    if (!['button', 'captcha'].includes(mode)) {
      return message.reply({ embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Usage')
        .setDescription('`%setverifymode button` — simple button click\n`%setverifymode captcha` — code-based captcha')
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    }
    updateGuild(guild.id, { verifyMode: mode });
    return message.reply({ embeds: [new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Verify Mode Updated')
      .setDescription(`Verification mode set to **${mode}**.`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }

  if (command === 'unverify') {
    if (!hasBotAccess(member)) return message.reply({ embeds: [deny()] });
    const target = message.mentions.members.first();
    if (!target) return message.reply({ embeds: [new EmbedBuilder().setColor(C.YELLOW).setTitle('⚠️ Usage').setDescription('`%unverify @User`').setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
    const verifiedRole = guild.roles.cache.get(settings.verifiedRoleId);
    if (verifiedRole) await target.roles.remove(verifiedRole).catch(() => {});
    return message.reply({ embeds: [new EmbedBuilder().setColor(C.ORANGE).setTitle('🔓 User Unverified')
      .addFields({ name: 'User', value: `${target}`, inline: true }, { name: 'By', value: `${member}`, inline: true })
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] });
  }
};

module.exports.handleVerifyInteraction = async function(interaction) {
  if (!interaction.isButton()) return;
  const settings = getGuild(interaction.guild.id);
  if (!settings.enabled) return;

  if (interaction.customId === 'verify_start') {
    if (settings.verifyMode === 'button') {
      const role = interaction.guild.roles.cache.get(settings.verifiedRoleId);
      if (role) await interaction.member.roles.add(role).catch(() => {});
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Verified!')
        .setDescription('You now have access to the server. Welcome!')
        .setFooter({ text: 'WebzHook Guard' }).setTimestamp()], ephemeral: true });
    }

    if (settings.verifyMode === 'captcha') {
      const code = generateCode();
      captchaSessions.set(interaction.user.id, { code, guildId: interaction.guild.id, expires: Date.now() + 120000 });
      return interaction.reply({ embeds: [new EmbedBuilder().setColor(C.BLUE).setTitle('🔐 Captcha Verification')
        .setDescription(`Please type the following code in this channel to verify:\n\n**\`${code}\`**\n\nYou have **2 minutes** to complete this.`)
        .setFooter({ text: 'WebzHook Guard • Captcha' }).setTimestamp()], ephemeral: true });
    }
  }
};

module.exports.handleCaptchaMessage = async function(message, settings) {
  if (message.author.bot) return;
  const session = captchaSessions.get(message.author.id);
  if (!session || session.guildId !== message.guild.id) return;
  if (message.channel.id !== settings.verifyChannelId) return;

  await message.delete().catch(() => {});

  if (Date.now() > session.expires) {
    captchaSessions.delete(message.author.id);
    return message.channel.send({ embeds: [new EmbedBuilder().setColor(C.RED).setTitle('⏱️ Captcha Expired')
      .setDescription(`${message.author}, your captcha expired. Click Verify again.`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] })
      .then(m => setTimeout(() => m.delete().catch(() => {}), 6000));
  }

  if (message.content.trim().toUpperCase() === session.code) {
    captchaSessions.delete(message.author.id);
    const role = message.guild.roles.cache.get(settings.verifiedRoleId);
    if (role) await message.member.roles.add(role).catch(() => {});
    return message.channel.send({ embeds: [new EmbedBuilder().setColor(C.GREEN).setTitle('✅ Verified!')
      .setDescription(`${message.author} has been verified and now has access to the server!`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] })
      .then(m => setTimeout(() => m.delete().catch(() => {}), 8000));
  } else {
    return message.channel.send({ embeds: [new EmbedBuilder().setColor(C.RED).setTitle('❌ Wrong Code')
      .setDescription(`${message.author}, that code is incorrect. Try again.`)
      .setFooter({ text: 'WebzHook Guard' }).setTimestamp()] })
      .then(m => setTimeout(() => m.delete().catch(() => {}), 5000));
  }
};

function deny() {
  return new EmbedBuilder().setColor(C.RED).setTitle('🚫 Access Denied').setDescription('You do not have permission to use this command.').setFooter({ text: 'WebzHook Guard' }).setTimestamp();
}