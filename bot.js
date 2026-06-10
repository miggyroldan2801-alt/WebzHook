// ━━━ CUSTOM COMMANDS ━━━
  if (!message.author.bot && message.content.startsWith(config.PREFIX)) {
    const args = message.content.slice(config.PREFIX.length).trim().split(/\s+/);
    const cmdName = args.shift().toLowerCase();
    
    // Custom Commands (JavaScript)
    const customCommands = settings.customCommands || [];
    const customCmd = customCommands.find(c => c.name.toLowerCase() === cmdName && c.enabled !== false);
    
    if (customCmd) {
      try {
        const fn = new Function('message', 'args', 'guild', 'member', customCmd.code);
        await fn(message, args, message.guild, message.member);
      } catch (err) {
        await message.reply({
          embeds: [new EmbedBuilder()
            .setColor(C.RED)
            .setTitle('❌ Command Error')
            .setDescription(`\`\`\`${err.message}\`\`\``)
            .setFooter({ text: 'WebzHook Guard' }).setTimestamp()]
        });
      }
      return;
    }

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