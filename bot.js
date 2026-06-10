// ━━━ 1. REQUIRED MODULES & IMPORTS ━━━
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();

// Require your existing database file to sync configuration data
const db = require('./database'); 

// ━━━ 2. DISCORD BOT CLIENT INITIALIZATION ━━━
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const config = {
  PREFIX: '!' // Default bot prefix
};

// ━━━ 3. CORE BOT COMMAND ENGINE HANDLER ━━━
client.on('messageCreate', async (message) => {
  // Defensive guard against bot loops or webhook triggers
  if (message.author.bot || message.webhookId) return;

  // Ensure this command is happening in a server guild
  if (!message.guild) return;

  // Pull the fresh, current settings from your existing database module
  const settings = db.getGuild(message.guild.id) || {};

  // Prefix check
  if (message.content.startsWith(config.PREFIX)) {
    const args = message.content.slice(config.PREFIX.length).trim().split(/\s+/);
    const cmdName = args.shift().toLowerCase();

    // ─── A. CUSTOM JAVASCRIPT COMMAND EVALUATION ENGINE ───
    const customCommands = settings.customCommands || [];
    const customCmd = customCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (customCmd) {
      try {
        // Enforce safe async compilation so custom execution code doesn't freeze the process
        const wrappedCode = `return (async () => { ${customCmd.code} })();`;
        const fn = new Function('message', 'args', 'guild', 'member', wrappedCode);
        await fn(message, args, message.guild, message.member);
      } catch (err) {
        console.error(`❌ Runtime execution error inside custom command !${cmdName}:`, err);
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Command Runtime Error')
            .setDescription(`\`\`\`js\n${err.message}\`\`\``)
            .setFooter({ text: 'WebzHook Guard Security System' })
            .setTimestamp()]
        }).catch(() => null);
      }
      return; // Stop processing further commands once matched
    }

    // ─── B. FUN COMMAND REPLIES (ARRAY RANDOMIZER) ───
    const funCommands = settings.funCommands || [];
    const funCmd = funCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (funCmd) {
      let response = funCmd.responses[Math.floor(Math.random() * funCmd.responses.length)];
      if (message.author) {
        response = response.replace(/{user}/g, message.author.toString());
      }
      return message.reply(response).catch(() => null);
    }

    // ─── C. KEYWORD AUTO-RESPONSES MATCHING ───
    const responses = settings.responses || {};
    if (responses[cmdName]) {
      return message.reply(responses[cmdName]).catch(() => null);
    }
  }
});

// ━━━ 4. DISCORD CONNECTION HANDSHAKE ━━━
client.once('ready', () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🚀 WebzHook Guard v2.0 is ONLINE!`);
  console.log(`🤖 Logged in as: ${client.user.tag}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ ERROR: Missing DISCORD_TOKEN in environment variables!");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("❌ Failed to authenticate connection stream with Discord gateway:", err);
});