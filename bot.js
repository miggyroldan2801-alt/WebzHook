// ━━━ CUSTOM COMMANDS ━━━
  if (!message.author.bot && message.content.startsWith(config.PREFIX)) {
    const args = message.content.slice(config.PREFIX.length).trim().split(/\s+/);
    const cmdName = args.shift().toLowerCase();
    
    // ━━━ CUSTOM COMMANDS ━━━
// NOTICE: Added 'async' right here before (message) so the 'await' keywords inside work perfectly!
client.on('messageCreate', async (message) => {
  if (!message.author.bot && message.content.startsWith(config.PREFIX)) {
    const args = message.content.slice(config.PREFIX.length).trim().split(/\s+/);
    const cmdName = args.shift().toLowerCase();
    
    // Custom Commands (JavaScript)
    const customCommands = settings.customCommands || [];
    const customCmd = customCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (customCmd) {
      try {
        // We wrap the code cleanly to make sure it handles custom async functions safely
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

    // Fun Commands (Random Responses)
    const funCommands = settings.funCommands || [];
    const funCmd = funCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (funCmd) {
      let response = funCmd.responses[Math.floor(Math.random() * funCmd.responses.length)];
      if (message.author) {
        response = response.replace(/{user}/g, message.author.toString());
      }
      return message.reply(response).catch(() => null);
    }

    // Auto Responses
    const responses = settings.responses || {};
    if (responses[cmdName]) {
      return message.reply(responses[cmdName]).catch(() => null);
    }
  }
});

    // Fun Commands (Random Responses)
    const funCommands = settings.funCommands || [];
    const funCmd = funCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (funCmd) {
      const response = funCmd.responses[Math.floor(Math.random() * funCmd.responses.length)];
      return message.reply(response);
    }

    // Auto Responses
    const responses = settings.responses || {};
    if (responses[cmdName]) {
      return message.reply(responses[cmdName]);
    }
  }