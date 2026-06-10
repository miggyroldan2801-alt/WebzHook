// ━━━ CUSTOM, FUN, AND AUTO COMMANDS SYSTEM ━━━
client.on('messageCreate', async (message) => {
  // Ignore messages from bots or webhooks
  if (message.author.bot) return;

  // Make sure it starts with the bot prefix
  if (message.content.startsWith(config.PREFIX)) {
    const args = message.content.slice(config.PREFIX.length).trim().split(/\s+/);
    const cmdName = args.shift().toLowerCase();

    // 1. Custom Commands (JavaScript Execution Engine)
    const customCommands = settings.customCommands || [];
    const customCmd = customCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (customCmd) {
      try {
        const wrappedCode = `return (async () => { ${customCmd.code} })();`;
        const fn = new Function('message', 'args', 'guild', 'member', wrappedCode);
        await fn(message, args, message.guild, message.member);
      } catch (err) {
        console.error(`Runtime error running command !${cmdName}:`, err);
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor('#FF0000')
            .setTitle('❌ Command Error')
            .setDescription(`\`\`\`${err.message}\`\`\``)
            .setFooter({ text: 'WebzHook Guard' }).setTimestamp()]
        }).catch(() => null);
      }
      return;
    }

    // 2. Fun Commands (Random String Array Selector)
    const funCommands = settings.funCommands || [];
    const funCmd = funCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (funCmd) {
      let response = funCmd.responses[Math.floor(Math.random() * funCmd.responses.length)];
      if (message.author) {
        response = response.replace(/{user}/g, message.author.toString());
      }
      return message.reply(response).catch(() => null);
    }

    // 3. Simple Keyword Auto Responses
    const responses = settings.responses || {};
    if (responses[cmdName]) {
      return message.reply(responses[cmdName]).catch(() => null);
    }
  }
});