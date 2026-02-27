/**
 * Telegram Bot for JDownloader
 * Controls JDownloader via MyJDownloader API
 */

const TelegramBot = require('node-telegram-bot-api');
const JDownloaderClient = require('./jdownloader');

class JDownloaderTelegramBot {
  constructor(config) {
    this.config = config;
    this.bot = new TelegramBot(config.telegramToken, { polling: true });
    this.jd = new JDownloaderClient();
    this.deviceCache = [];
    this.deviceCacheTime = 0;
    this.CACHE_TTL = 60000; // 1 minute cache

    this._setupCommands();
    this._setupErrorHandling();
  }

  /**
   * Check if user is authorized
   */
  _isAuthorized(chatId) {
    if (!this.config.allowedUsers || this.config.allowedUsers.length === 0) {
      return true; // No restriction if not configured
    }
    return this.config.allowedUsers.includes(chatId.toString());
  }

  /**
   * Ensure JDownloader is connected
   */
  async _ensureConnected() {
    if (!this.jd.connected) {
      await this.jd.connect(this.config.jdEmail, this.config.jdPassword);
    }
  }

  /**
   * Get devices with caching
   */
  async _getDevices() {
    const now = Date.now();
    if (this.deviceCache.length > 0 && (now - this.deviceCacheTime) < this.CACHE_TTL) {
      return this.deviceCache;
    }

    await this._ensureConnected();
    const devices = await this.jd.listDevices();
    this.deviceCache = devices;
    this.deviceCacheTime = now;
    return devices;
  }

  /**
   * Get the default device (first online or available device)
   */
  async _getDefaultDevice() {
    const devices = await this._getDevices();
    // Accept ONLINE or UNKNOWN status (UNKNOWN means JD is connected but status not yet determined)
    const available = devices.filter(d => d.status === 'ONLINE' || d.status === 'UNKNOWN');
    if (available.length === 0) {
      throw new Error('No online JDownloader devices found.');
    }
    return available[0];
  }

  /**
   * Send a message safely
   */
  async _send(chatId, text, options = {}) {
    try {
      return await this.bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        ...options
      });
    } catch (error) {
      console.error('Failed to send message:', error.message);
    }
  }

  /**
   * Handle errors and send user-friendly messages
   */
  async _handleError(chatId, error) {
    console.error('Error:', error);
    let msg = '❌ <b>Error:</b> ';

    if (error.message.includes('Not connected')) {
      msg += 'Not connected to MyJDownloader. Check your credentials.';
    } else if (error.message.includes('No online')) {
      msg += 'No online JDownloader devices found. Make sure JDownloader is running.';
    } else if (error.message.includes('Login failed')) {
      msg += 'Login failed. Check your MyJDownloader email and password.';
      this.jd.connected = false;
    } else {
      msg += error.message;
    }

    await this._send(chatId, msg);
  }

  /**
   * Setup all bot commands
   */
  _setupCommands() {
    // /start - Welcome message
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) {
        return this._send(chatId, '⛔ You are not authorized to use this bot.');
      }

      const welcome = `
🤖 <b>JDownloader Telegram Bot</b>

Control your JDownloader remotely via Telegram!

<b>📥 Download Commands:</b>
/add <code>&lt;url&gt;</code> - Add download link(s)
/downloads - Show download list
/start_dl - Start all downloads
/stop_dl - Stop all downloads
/pause_dl - Pause downloads
/resume_dl - Resume downloads
/speed - Show current download speed
/state - Show download state
/cleanup - Remove finished downloads

<b>🔗 Link Grabber:</b>
/grabber - Show link grabber list
/grab_start - Move grabber links to downloads
/grab_clear - Clear link grabber

<b>📱 Device Commands:</b>
/devices - List connected devices
/select <code>&lt;device_id&gt;</code> - Select active device

<b>ℹ️ Info Commands:</b>
/status - Full status overview
/help - Show this help message
      `.trim();

      await this._send(chatId, welcome);
    });

    // /help
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;
      this.bot.emit('text', { ...msg, text: '/start' });
    });

    // /devices - List all devices
    this.bot.onText(/\/devices/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) {
        return this._send(chatId, '⛔ Unauthorized');
      }

      try {
        await this._send(chatId, '🔍 Fetching devices...');
        this.deviceCacheTime = 0; // Force refresh
        const devices = await this._getDevices();

        if (devices.length === 0) {
          return this._send(chatId, '📱 No devices found. Make sure JDownloader is running and connected to MyJDownloader.');
        }

        let text = '📱 <b>Connected Devices:</b>\n\n';
        devices.forEach((device, i) => {
          const statusEmoji = device.status === 'ONLINE' ? '🟢' : '🔴';
          text += `${statusEmoji} <b>${i + 1}. ${device.name}</b>\n`;
          text += `   ID: <code>${device.id}</code>\n`;
          text += `   Status: ${device.status}\n`;
          text += `   Type: ${device.type || 'Unknown'}\n\n`;
        });

        await this._send(chatId, text);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /add <url> - Add download link
    this.bot.onText(/\/add (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) {
        return this._send(chatId, '⛔ Unauthorized');
      }

      const links = match[1].trim();
      if (!links) {
        return this._send(chatId, '❌ Please provide a URL.\nUsage: /add <code>&lt;url&gt;</code>');
      }

      try {
        await this._send(chatId, '⏳ Adding link(s) to JDownloader...');
        const device = await this._getDefaultDevice();
        await this.jd.addLinks(device.id, links);

        const urlCount = links.split(/\s+/).filter(u => u.startsWith('http')).length || 1;
        await this._send(chatId, `✅ Successfully added <b>${urlCount}</b> link(s) to JDownloader!\n\nDevice: <code>${device.name}</code>`);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /downloads - Show download list
    this.bot.onText(/\/downloads/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        await this._send(chatId, '⏳ Fetching downloads...');
        const device = await this._getDefaultDevice();
        const packages = await this.jd.getDownloads(device.id);

        if (!packages || packages.length === 0) {
          return this._send(chatId, '📭 Download list is empty.');
        }

        let text = `📥 <b>Downloads</b> (${packages.length} package${packages.length !== 1 ? 's' : ''}):\n\n`;

        packages.slice(0, 10).forEach((pkg, i) => {
          const progress = pkg.bytesTotal > 0
            ? Math.round((pkg.bytesLoaded / pkg.bytesTotal) * 100)
            : 0;

          const progressBar = this._makeProgressBar(progress);
          const statusEmoji = pkg.finished ? '✅' : pkg.running ? '⬇️' : '⏸️';

          text += `${statusEmoji} <b>${this._escapeHtml(pkg.name || 'Unknown')}</b>\n`;
          text += `   ${progressBar} ${progress}%\n`;

          if (pkg.bytesTotal > 0) {
            text += `   ${JDownloaderClient.formatBytes(pkg.bytesLoaded)} / ${JDownloaderClient.formatBytes(pkg.bytesTotal)}\n`;
          }

          if (pkg.speed > 0) {
            text += `   Speed: ${JDownloaderClient.formatSpeed(pkg.speed)}\n`;
          }

          if (pkg.eta > 0 && !pkg.finished) {
            text += `   ETA: ${JDownloaderClient.formatETA(pkg.eta)}\n`;
          }

          if (pkg.status) {
            text += `   Status: ${pkg.status}\n`;
          }

          text += '\n';
        });

        if (packages.length > 10) {
          text += `<i>... and ${packages.length - 10} more packages</i>`;
        }

        await this._send(chatId, text);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /start_dl - Start downloads
    this.bot.onText(/\/start_dl/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        const device = await this._getDefaultDevice();
        await this.jd.startDownloads(device.id);
        await this._send(chatId, '▶️ Downloads <b>started</b>!');
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /stop_dl - Stop downloads
    this.bot.onText(/\/stop_dl/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        const device = await this._getDefaultDevice();
        await this.jd.stopDownloads(device.id);
        await this._send(chatId, '⏹️ Downloads <b>stopped</b>!');
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /pause_dl - Pause downloads
    this.bot.onText(/\/pause_dl/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        const device = await this._getDefaultDevice();
        await this.jd.pauseDownloads(device.id, true);
        await this._send(chatId, '⏸️ Downloads <b>paused</b>!');
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /resume_dl - Resume downloads
    this.bot.onText(/\/resume_dl/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        const device = await this._getDefaultDevice();
        await this.jd.pauseDownloads(device.id, false);
        await this._send(chatId, '▶️ Downloads <b>resumed</b>!');
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /speed - Show download speed
    this.bot.onText(/\/speed/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        const device = await this._getDefaultDevice();
        const speed = await this.jd.getDownloadSpeed(device.id);
        const formatted = JDownloaderClient.formatSpeed(speed || 0);
        await this._send(chatId, `⚡ Current download speed: <b>${formatted}</b>`);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /state - Show download state
    this.bot.onText(/\/state/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        const device = await this._getDefaultDevice();
        const state = await this.jd.getDownloadState(device.id);
        const stateEmoji = {
          'RUNNING': '▶️',
          'STOPPED': '⏹️',
          'PAUSE': '⏸️',
          'IDLE': '💤'
        };
        const emoji = stateEmoji[state] || '❓';
        await this._send(chatId, `${emoji} Download state: <b>${state || 'Unknown'}</b>`);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /cleanup - Remove finished downloads
    this.bot.onText(/\/cleanup/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        const device = await this._getDefaultDevice();
        await this.jd.cleanupFinished(device.id);
        await this._send(chatId, '🧹 Finished downloads <b>cleaned up</b>!');
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /grabber - Show link grabber list
    this.bot.onText(/\/grabber/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        await this._send(chatId, '⏳ Fetching link grabber...');
        const device = await this._getDefaultDevice();
        const packages = await this.jd.getLinkGrabberList(device.id);

        if (!packages || packages.length === 0) {
          return this._send(chatId, '📭 Link grabber is empty.');
        }

        let text = `🔗 <b>Link Grabber</b> (${packages.length} package${packages.length !== 1 ? 's' : ''}):\n\n`;

        packages.slice(0, 10).forEach((pkg) => {
          const onlineEmoji = pkg.availableOnlineCount > 0 ? '🟢' : '🔴';
          text += `${onlineEmoji} <b>${this._escapeHtml(pkg.name || 'Unknown')}</b>\n`;
          text += `   Links: ${pkg.childCount || 0} (Online: ${pkg.availableOnlineCount || 0})\n`;

          if (pkg.bytesTotal > 0) {
            text += `   Size: ${JDownloaderClient.formatBytes(pkg.bytesTotal)}\n`;
          }

          if (pkg.hosts && pkg.hosts.length > 0) {
            text += `   Hosts: ${pkg.hosts.slice(0, 3).join(', ')}\n`;
          }

          text += '\n';
        });

        if (packages.length > 10) {
          text += `<i>... and ${packages.length - 10} more packages</i>`;
        }

        await this._send(chatId, text);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /grab_start - Move grabber to downloads
    this.bot.onText(/\/grab_start/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        const device = await this._getDefaultDevice();
        await this.jd.startLinkGrabber(device.id);
        await this._send(chatId, '✅ Link grabber items moved to <b>download list</b>!');
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /grab_clear - Clear link grabber
    this.bot.onText(/\/grab_clear/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        const device = await this._getDefaultDevice();
        await this.jd.clearLinkGrabber(device.id);
        await this._send(chatId, '🗑️ Link grabber <b>cleared</b>!');
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /status - Full status overview
    this.bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        await this._send(chatId, '⏳ Fetching status...');
        const device = await this._getDefaultDevice();

        const [state, speed, downloads, grabber] = await Promise.allSettled([
          this.jd.getDownloadState(device.id),
          this.jd.getDownloadSpeed(device.id),
          this.jd.getDownloads(device.id),
          this.jd.getLinkGrabberList(device.id)
        ]);

        const stateVal = state.status === 'fulfilled' ? state.value : 'Unknown';
        const speedVal = speed.status === 'fulfilled' ? speed.value : 0;
        const downloadsVal = downloads.status === 'fulfilled' ? (downloads.value || []) : [];
        const grabberVal = grabber.status === 'fulfilled' ? (grabber.value || []) : [];

        const stateEmoji = {
          'RUNNING': '▶️',
          'STOPPED': '⏹️',
          'PAUSE': '⏸️',
          'IDLE': '💤'
        };

        const activeDownloads = downloadsVal.filter(d => d.running && !d.finished);
        const finishedDownloads = downloadsVal.filter(d => d.finished);

        let totalBytes = 0;
        let loadedBytes = 0;
        downloadsVal.forEach(d => {
          totalBytes += d.bytesTotal || 0;
          loadedBytes += d.bytesLoaded || 0;
        });

        let text = `📊 <b>JDownloader Status</b>\n`;
        text += `Device: <code>${device.name}</code>\n\n`;

        text += `${stateEmoji[stateVal] || '❓'} State: <b>${stateVal}</b>\n`;
        text += `⚡ Speed: <b>${JDownloaderClient.formatSpeed(speedVal)}</b>\n\n`;

        text += `📥 <b>Downloads:</b>\n`;
        text += `   Total packages: ${downloadsVal.length}\n`;
        text += `   Active: ${activeDownloads.length}\n`;
        text += `   Finished: ${finishedDownloads.length}\n`;

        if (totalBytes > 0) {
          const progress = Math.round((loadedBytes / totalBytes) * 100);
          text += `   Progress: ${this._makeProgressBar(progress)} ${progress}%\n`;
          text += `   Size: ${JDownloaderClient.formatBytes(loadedBytes)} / ${JDownloaderClient.formatBytes(totalBytes)}\n`;
        }

        text += `\n🔗 <b>Link Grabber:</b>\n`;
        text += `   Packages: ${grabberVal.length}\n`;

        await this._send(chatId, text);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // Handle plain URLs sent to the bot (auto-add)
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;
      if (msg.text && msg.text.startsWith('/')) return; // Skip commands

      // Check if message contains URLs
      const urlRegex = /(https?:\/\/[^\s]+)/g;
      const urls = msg.text ? msg.text.match(urlRegex) : null;

      if (urls && urls.length > 0) {
        try {
          await this._send(chatId, `🔍 Detected ${urls.length} URL(s). Adding to JDownloader...`);
          const device = await this._getDefaultDevice();
          await this.jd.addLinks(device.id, urls.join('\n'));
          await this._send(chatId, `✅ Added <b>${urls.length}</b> link(s) to JDownloader!\nDevice: <code>${device.name}</code>`);
        } catch (error) {
          await this._handleError(chatId, error);
        }
      }
    });
  }

  /**
   * Setup error handling
   */
  _setupErrorHandling() {
    this.bot.on('polling_error', (error) => {
      console.error('Polling error:', error.message);
      if (error.message.includes('401')) {
        console.error('Invalid Telegram bot token!');
        process.exit(1);
      }
    });

    this.bot.on('error', (error) => {
      console.error('Bot error:', error.message);
    });

    process.on('SIGINT', async () => {
      console.log('\nShutting down...');
      await this.jd.disconnect();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\nShutting down...');
      await this.jd.disconnect();
      process.exit(0);
    });
  }

  /**
   * Create a text progress bar
   */
  _makeProgressBar(percent, length = 10) {
    const filled = Math.round((percent / 100) * length);
    const empty = length - filled;
    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }

  /**
   * Escape HTML special characters
   */
  _escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Start the bot
   */
  async start() {
    console.log('🤖 JDownloader Telegram Bot starting...');

    try {
      // Test Telegram connection
      const me = await this.bot.getMe();
      console.log(`✅ Telegram bot connected: @${me.username}`);

      // Test JDownloader connection
      console.log('🔌 Connecting to MyJDownloader...');
      await this.jd.connect(this.config.jdEmail, this.config.jdPassword);
      console.log('✅ Connected to MyJDownloader!');

      // List devices
      const devices = await this.jd.listDevices();
      const online = devices.filter(d => d.status === 'ONLINE' || d.status === 'UNKNOWN');
      console.log(`📱 Found ${devices.length} device(s), ${online.length} available`);

      if (online.length > 0) {
        console.log(`   Active device: ${online[0].name} (${online[0].status})`);
      } else {
        console.log('   ⚠️  No devices available. Make sure JDownloader is running.');
      }

      console.log('\n🚀 Bot is running! Press Ctrl+C to stop.\n');
    } catch (error) {
      console.error('❌ Startup error:', error.message);
      if (error.message.includes('Login failed') || error.message.includes('UNAUTHORIZED')) {
        console.error('Check your MyJDownloader credentials in .env file');
        process.exit(1);
      }
      // Don't exit for device listing errors - bot can still run
      console.log('⚠️  Continuing anyway - bot will retry on first command.\n');
    }
  }
}

module.exports = JDownloaderTelegramBot;
