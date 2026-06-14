require('dotenv').config();

// Single process: run bot + web server together
// This avoids Railway's worker vs web process issues

const path = require('path');

console.log('🚀 WebzHook Guard v3.0 starting...');

// Start web server first
require('./server');

// Then start bot
require('./bot');