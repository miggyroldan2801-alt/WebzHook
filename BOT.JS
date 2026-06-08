require('dotenv').config();
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const config = {
  MASS_PING_THRESHOLD: 5,
  BLOCK_ROLE_PINGS: true,
  LOG_CHANNEL_ID: null, // e.g. '1234567890123456789'
};
// ───────────────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
  ],
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`🔍 Mass ping threshold: ${config.MASS_PING_THRESHOLD} mentions`);
  console.log(`🔍 Block role pings: ${config.BLOCK_ROLE_PINGS}`);
});

client.on('messageCreate', async (message) => {
  if (!message.webhookId) return;

  const mentionCount = message.mentions.users.size + message.mentions.roles.size;
  const hasEveryonePing = message.mentions.everyone;

  const isMassPing = mentionCount >= config.MASS_PING_THRESHOLD;
  const isRolePing = config.BLOCK_ROLE_PINGS && (message.mentions.roles.size > 0 || hasEveryonePing);

  if (!isMassPing && !isRolePing) return;

  const reason = isMassPing
    ? `Mass ping detected (${mentionCount} mentions)`
    : hasEveryonePing
    ? '@everyone / @here ping detected from webhook'
    : `Role ping detected from webhook`;

  console.log(`⚠️  [${message.guild.name}] ${reason} — Webhook ID: ${message.webhookId}`);

  try {
    await message.delete();
    console.log(`🗑️  Deleted offending message.`);
  } catch (err) {
    console.error(`❌ Could not delete message:`, err.message);
  }

  try {
    const botMember = message.guild.members.me;
    const hasPerms = botMember.permissions.has(PermissionsBitField.Flags.ManageWebhooks);

    if (!hasPerms) {
      console.warn('⚠️  Bot lacks Manage Webhooks permission — cannot delete webhook.');
      return;
    }

    const webhook = await client.fetchWebhook(message.webhookId).catch(() => null);

    if (!webhook) {
      console.warn('⚠️  Webhook not found (may have already been deleted).');
      return;
    }

    await webhook.delete(`Auto-deleted: ${reason}`);
    console.log(`🔥 Deleted webhook: ${webhook.name} (${webhook.id})`);

    if (config.LOG_CHANNEL_ID) {
      const logChannel = message.guild.channels.cache.get(config.LOG_CHANNEL_ID);
      if (logChannel) {
        await logChannel.send(
          `🚨 **Webhook Auto-Deleted**\n` +
          `**Reason:** ${reason}\n` +
          `**Webhook Name:** ${webhook.name}\n` +
          `**Webhook ID:** ${webhook.id}\n` +
          `**Channel:** <#${message.channelId}>\n` +
          `**Time:** <t:${Math.floor(Date.now() / 1000)}:F>`
        );
      }
    }
  } catch (err) {
    console.error(`❌ Error handling webhook deletion:`, err.message);
  }
});

client.login(process.env.DISCORD_TOKEN)