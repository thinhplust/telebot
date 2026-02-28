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
  allowedUsers: allowedUsers,
  // Optional Fshare credentials
  fshareEmail: process.env.FSHARE_EMAIL || null,
  fsharePassword: process.env.FSHARE_PASSWORD || null,
  fshareAppKey: process.env.FSHARE_APP_KEY || null,
  fshareUserAgent: process.env.FSHARE_USER_AGENT || null,
  // Daily report time (e.g. "08:00")
  dailyReportTime: process.env.DAILY_REPORT_TIME || null,
  // Folder check time (e.g. "06:00")
  folderCheckTime: process.env.FOLDER_CHECK_TIME || null,
  // Max file size in bytes for folder watcher (default 30 GB)
  maxFileSizeBytes: process.env.MAX_FILE_SIZE_GB
    ? (parseFloat(process.env.MAX_FILE_SIZE_GB) * 1024 * 1024 * 1024)
    : (30 * 1024 * 1024 * 1024)
};

const bot = new JDownloaderTelegramBot(config);
bot.start();
