/**
 * JDownloader Telegram Bot - Entry Point
 */

require('dotenv').config();
const JDownloaderTelegramBot = require('./src/bot');

// Validate required environment variables
const required = ['TELEGRAM_BOT_TOKEN', 'JD_EMAIL', 'JD_PASSWORD'];
const missing = required.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('❌ Missing required environment variables:');
  missing.forEach(key => console.error(`   - ${key}`));
  console.error('\nPlease copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

// Parse allowed users (comma-separated chat IDs)
const allowedUsers = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(',').map(id => id.trim()).filter(Boolean)
  : [];

const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  jdEmail: process.env.JD_EMAIL,
  jdPassword: process.env.JD_PASSWORD,
  allowedUsers: allowedUsers
};

const bot = new JDownloaderTelegramBot(config);
bot.start();
