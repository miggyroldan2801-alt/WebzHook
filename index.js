// Start both the Discord bot and the web dashboard

require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 WebzHook Guard v2.0');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Start the Discord bot
const botProcess = spawn('node', [path.join(__dirname, 'bot.js')], {
  stdio: 'inherit',
  shell: true,
});

// Start the web server
const serverProcess = spawn('node', [path.join(__dirname, 'server.js')], {
  stdio: 'inherit',
  shell: true,
});

botProcess.on('exit', (code) => {
  console.error('❌ Bot process exited with code', code);
  process.exit(code);
});

serverProcess.on('exit', (code) => {
  console.error('❌ Server process exited with code', code);
  process.exit(code);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  botProcess.kill();
  serverProcess.kill();
  process.exit(0);
});