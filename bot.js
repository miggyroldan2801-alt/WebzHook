// ━━━ 1. REQUIRED MODULES & IMPORTS ━━━
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const db = require('./database'); // Pointing cleanly to database.js

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
  PREFIX: '!' 
};

// ━━━ 3. CORE BOT COMMAND ENGINE HANDLER ━━━
client.on('messageCreate', async (message) => {
  if (message.author.bot || message.webhookId || !message.guild) return;

  // Pull settings configured via your database logic
  const settings = db.getGuild(message.guild.id) || {};

  if (message.content.startsWith(config.PREFIX)) {
    const args = message.content.slice(config.PREFIX.length).trim().split(/\s+/);
    const cmdName = args.shift().toLowerCase();

    // ─── A. CUSTOM EVAL ENGINE ───
    const customCommands = settings.customCommands || [];
    const customCmd = customCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (customCmd) {
      try {
        const wrappedCode = `return (async () => { ${customCmd.code} })();`;
        const fn = new Function('message', 'args', 'guild', 'member', wrappedCode);
        await fn(message, args, message.guild, message.member);
      } catch (err) {
        console.error(`❌ Runtime error inside custom command !${cmdName}:`, err);
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Command Runtime Error')
            .setDescription(`\`\`\`js\n${err.message}\`\`\``)
            .setFooter({ text: 'WebzHook Guard Security System' })
            .setTimestamp()]
        }).catch(() => null);
      }
      return; 
    }

    // ─── B. FUN RESPONSE ENGINE ───
    const funCommands = settings.funCommands || [];
    const funCmd = funCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (funCmd) {
      let response = funCmd.responses[Math.floor(Math.random() * funCmd.responses.length)];
      if (message.author) {
        response = response.replace(/{user}/g, message.author.toString());
      }
      return message.reply(response).catch(() => null);
    }

    // ─── C. KEYWORD AUTO-RESPONSES ───
    const responses = settings.responses || {};
    if (responses[cmdName]) {
      return message.reply(responses[cmdName]).catch(() => null);
    }
  }
});

// ━━━ 4. CONNECT TO DISCORD GATEWAY ━━━
client.once('ready', () => {
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🚀 WebzHook Guard Core Bot Module is ONLINE!`);
  console.log(`🤖 Logged in as: ${client.user.tag}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
});

if (!process.env.DISCORD_TOKEN) {
  console.error("❌ ERROR: Missing DISCORD_TOKEN in environment variables!");
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error("❌ Failed to authenticate with Discord gateway:", err);
});