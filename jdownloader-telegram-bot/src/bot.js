/**
 * Telegram Bot for JDownloader
 * Controls JDownloader via MyJDownloader API
 */

const TelegramBot = require('node-telegram-bot-api');
const JDownloaderClient = require('./jdownloader');
const FshareClient = require('./fshare');
const FolderWatcher = require('./folder-watcher');

class JDownloaderTelegramBot {
  constructor(config) {
    this.config = config;
    this.bot = new TelegramBot(config.telegramToken, { polling: true });
    this.jd = new JDownloaderClient();
    this.deviceCache = [];
    this.deviceCacheTime = 0;
    this.CACHE_TTL = 60000; // 1 minute cache

    // Track known finished packages to avoid duplicate notifications
    this.knownFinishedPackages = new Set();
    // Track known failed packages to avoid duplicate error notifications
    this.knownFailedPackages = new Set();
    // Store chat IDs that have interacted with the bot (for notifications)
    this.activeChatIds = new Set();
    // Load allowed users as active chat IDs if configured
    if (config.allowedUsers && config.allowedUsers.length > 0) {
      config.allowedUsers.forEach(id => this.activeChatIds.add(id));
    }
    // Daily summary stats
    this.dailyStats = { completed: 0, failed: 0, totalBytes: 0, date: new Date().toDateString() };
    // Fshare client (use configured app key and user agent)
    this.fshare = new FshareClient(config.fshareAppKey, config.fshareUserAgent);
    // Folder watcher (monitors Fshare folders for new files)
    this.folderWatcher = new FolderWatcher(this.fshare, this.jd, {
      fshareEmail: config.fshareEmail,
      fsharePassword: config.fsharePassword,
      jdEmail: config.jdEmail,
      jdPassword: config.jdPassword
    });

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
    // Track all authorized users who interact with the bot
    this.bot.on('message', (msg) => {
      if (msg.chat && msg.chat.id && this._isAuthorized(msg.chat.id)) {
        this.activeChatIds.add(msg.chat.id.toString());
      }
    });

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

<b>📊 Info &amp; Reports:</b>
/status - Full status overview
/fshare - Check Fshare.vn account balance
/report - Send daily summary now
/help - Show this help message

<b>📂 Fshare Folder Watch:</b>
/watch_folder <code>&lt;url&gt;</code> - Watch folder for new files
/watched_folders - List watched folders
/unwatch_folder <code>&lt;url&gt;</code> - Stop watching a folder
/check_folders - Check all folders now

<b>💡 Tip:</b> Just paste any URL (fshare.vn, etc.) to auto-add!
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

    // /fshare - Check Fshare.vn account info
    this.bot.onText(/\/fshare/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      if (!this.config.fshareEmail || !this.config.fsharePassword) {
        return this._send(chatId, '⚠️ Fshare credentials not configured.\nAdd <code>FSHARE_EMAIL</code> and <code>FSHARE_PASSWORD</code> to your .env file.');
      }

      try {
        await this._send(chatId, '⏳ Fetching Fshare account info...');
        await this.fshare.login(this.config.fshareEmail, this.config.fsharePassword);
        const profile = await this.fshare.getProfile();

        // Log raw profile for debugging
        console.log('Fshare profile raw:', JSON.stringify(profile, null, 2));

        const user = profile.data || profile;

        // Bandwidth fields: try multiple possible field names from Fshare API
        const bandwidth = user.bandwidth || user.bandwidth_total || user.total_bandwidth || 0;
        const usedBandwidth = user.used_bandwidth || user.bandwidth_used || user.used || 0;
        const remainingBandwidth = user.remain_bandwidth || user.bandwidth_remain || (bandwidth - usedBandwidth) || 0;

        const accountType = FshareClient.formatAccountType(user.account_type);

        // expire_date may be timestamp (seconds) or ISO string
        let expireDate = 'N/A';
        if (user.expire_date) {
          const ts = typeof user.expire_date === 'number'
            ? (user.expire_date > 1e10 ? user.expire_date : user.expire_date * 1000)
            : Date.parse(user.expire_date);
          if (!isNaN(ts)) expireDate = new Date(ts).toLocaleDateString('vi-VN');
        }

        let text = `🔗 <b>Fshare.vn Account</b>\n\n`;
        text += `👤 Email: <code>${this._escapeHtml(user.email || this.config.fshareEmail)}</code>\n`;
        text += `🏷️ Account: <b>${accountType}</b>\n`;
        if (expireDate !== 'N/A') {
          text += `📅 Expires: <b>${expireDate}</b>\n`;
        }
        text += `\n📊 <b>Bandwidth:</b>\n`;
        if (bandwidth > 0) {
          const usedPercent = Math.round((usedBandwidth / bandwidth) * 100);
          text += `   Total: ${FshareClient.formatBytes(bandwidth)}\n`;
          text += `   Used: ${FshareClient.formatBytes(usedBandwidth)} (${usedPercent}%)\n`;
          text += `   Remaining: <b>${FshareClient.formatBytes(remainingBandwidth)}</b>\n`;
          text += `   ${this._makeProgressBar(usedPercent)} ${usedPercent}%\n`;
        } else if (remainingBandwidth > 0) {
          text += `   Remaining: <b>${FshareClient.formatBytes(remainingBandwidth)}</b>\n`;
        } else {
          text += `   Unlimited or not available\n`;
        }

        await this._send(chatId, text);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /watch_folder <url> [name] - Watch a Fshare folder for new files
    this.bot.onText(/\/watch_folder(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      if (!this.config.fshareEmail || !this.config.fsharePassword) {
        return this._send(chatId, '⚠️ Fshare credentials not configured.\nAdd <code>FSHARE_EMAIL</code> and <code>FSHARE_PASSWORD</code> to your .env file.');
      }

      const args = match[1] ? match[1].trim() : '';
      if (!args) {
        return this._send(chatId, '❌ Usage: /watch_folder <code>&lt;fshare_folder_url&gt;</code> [optional name]\n\nExample:\n<code>/watch_folder https://www.fshare.vn/folder/ABCDEF123 My Movies</code>');
      }

      // First token is URL, rest is optional name
      const parts = args.split(/\s+/);
      const url = parts[0];
      const name = parts.slice(1).join(' ') || '';

      if (!url.includes('fshare.vn/folder/')) {
        return this._send(chatId, '❌ Please provide a valid Fshare <b>folder</b> URL.\nExample: <code>https://www.fshare.vn/folder/ABCDEF123</code>');
      }

      try {
        await this._send(chatId, '⏳ Adding folder to watch list and scanning for files...');

        const { isNew, folder } = this.folderWatcher.addFolder(url, name);

        if (!isNew) {
          const count = this.folderWatcher.getDownloadedCount(url);
          return this._send(chatId, `ℹ️ Folder already in watch list.\n📁 <b>${this._escapeHtml(folder.name)}</b>\n📊 ${count} file(s) already downloaded.`);
        }

        // Do an immediate first scan
        const result = await this.folderWatcher.checkFolder(url);

        let text = `✅ <b>Folder added to watch list!</b>\n\n`;
        text += `📁 <b>${this._escapeHtml(folder.name || url)}</b>\n`;
        text += `🔗 <code>${this._escapeHtml(url)}</code>\n\n`;
        text += `📊 Found <b>${result.totalFiles}</b> file(s) total\n`;

        if (result.newFiles.length > 0) {
          text += `⬇️ Added <b>${result.newFiles.length}</b> new file(s) to JDownloader:\n`;
          result.newFiles.slice(0, 5).forEach((f, i) => {
            text += `  ${i + 1}. ${this._escapeHtml(f.name)}`;
            if (f.size > 0) text += ` (${JDownloaderClient.formatBytes(f.size)})`;
            text += '\n';
          });
          if (result.newFiles.length > 5) text += `  <i>... and ${result.newFiles.length - 5} more</i>\n`;
        } else {
          text += `📭 No new files to download (all already queued or folder is empty)\n`;
        }

        if (result.errors.length > 0) {
          text += `\n⚠️ ${result.errors.length} error(s) occurred during scan.`;
        }

        text += `\n\n🔄 Bot will check daily for new files automatically.`;
        await this._send(chatId, text);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /watched_folders - List all watched folders
    this.bot.onText(/\/watched_folders/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      const folders = this.folderWatcher.getWatchedFolders();

      if (folders.length === 0) {
        return this._send(chatId, '📭 No folders being watched.\n\nUse /watch_folder <code>&lt;url&gt;</code> to add one.');
      }

      let text = `📂 <b>Watched Fshare Folders</b> (${folders.length}):\n\n`;
      folders.forEach((folder, i) => {
        const count = Object.keys(folder.downloadedFiles).length;
        const lastChecked = folder.lastChecked
          ? new Date(folder.lastChecked).toLocaleString('vi-VN')
          : 'Never';
        text += `${i + 1}. 📁 <b>${this._escapeHtml(folder.name)}</b>\n`;
        text += `   🔗 <code>${this._escapeHtml(folder.url)}</code>\n`;
        text += `   📊 Downloaded: ${count} file(s)\n`;
        text += `   🕐 Last checked: ${lastChecked}\n\n`;
      });

      text += `\nUse /check_folders to scan now, or /unwatch_folder &lt;url&gt; to remove.`;
      await this._send(chatId, text);
    });

    // /unwatch_folder <url> - Remove a folder from watch list
    this.bot.onText(/\/unwatch_folder(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      const url = match[1] ? match[1].trim() : '';
      if (!url) {
        return this._send(chatId, '❌ Usage: /unwatch_folder <code>&lt;fshare_folder_url&gt;</code>');
      }

      const removed = this.folderWatcher.removeFolder(url);
      if (removed) {
        await this._send(chatId, `✅ Removed folder from watch list:\n<code>${this._escapeHtml(url)}</code>`);
      } else {
        await this._send(chatId, `❌ Folder not found in watch list:\n<code>${this._escapeHtml(url)}</code>\n\nUse /watched_folders to see the list.`);
      }
    });

    // /check_folders - Manually trigger a check of all watched folders
    this.bot.onText(/\/check_folders/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      if (!this.config.fshareEmail || !this.config.fsharePassword) {
        return this._send(chatId, '⚠️ Fshare credentials not configured.');
      }

      const folders = this.folderWatcher.getWatchedFolders();
      if (folders.length === 0) {
        return this._send(chatId, '📭 No folders being watched. Use /watch_folder to add one.');
      }

      try {
        await this._send(chatId, `⏳ Checking ${folders.length} folder(s) for new files...`);
        const results = await this.folderWatcher.checkAllFolders();

        let text = `📂 <b>Folder Check Results</b>\n\n`;
        let totalNew = 0;

        results.forEach(r => {
          const newCount = r.newFiles ? r.newFiles.length : 0;
          totalNew += newCount;
          const statusEmoji = r.errors && r.errors.length > 0 ? '⚠️' : (newCount > 0 ? '🆕' : '✅');
          text += `${statusEmoji} <b>${this._escapeHtml(r.name)}</b>\n`;
          if (newCount > 0) {
            text += `   ⬇️ ${newCount} new file(s) added to JDownloader\n`;
            r.newFiles.slice(0, 3).forEach(f => {
              text += `   • ${this._escapeHtml(f.name)}\n`;
            });
            if (newCount > 3) text += `   <i>... and ${newCount - 3} more</i>\n`;
          } else if (r.errors && r.errors.length > 0) {
            text += `   ❌ Error: ${this._escapeHtml(r.errors[0].error)}\n`;
          } else {
            text += `   ✅ No new files\n`;
          }
          text += '\n';
        });

        text += `\n📊 Total new files added: <b>${totalNew}</b>`;
        await this._send(chatId, text);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /rescan_folder <url> - Reset downloaded state and rescan a folder
    this.bot.onText(/\/rescan_folder(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      if (!this.config.fshareEmail || !this.config.fsharePassword) {
        return this._send(chatId, '⚠️ Fshare credentials not configured.');
      }

      const url = match[1] ? match[1].trim() : '';
      if (!url) {
        return this._send(chatId, '❌ Usage: /rescan_folder <code>&lt;fshare_folder_url&gt;</code>\n\nThis will reset the downloaded file history and rescan the folder from scratch.');
      }

      try {
        // Reset the folder's downloaded files state
        const reset = this.folderWatcher.resetFolderState(url);
        if (!reset) {
          return this._send(chatId, `❌ Folder not in watch list: <code>${this._escapeHtml(url)}</code>\n\nUse /watch_folder to add it first.`);
        }

        await this._send(chatId, `🔄 Reset folder state. Rescanning...\n<code>${this._escapeHtml(url)}</code>`);

        const result = await this.folderWatcher.checkFolder(url);

        let text = `✅ <b>Rescan complete!</b>\n\n`;
        text += `📊 Found <b>${result.totalFiles}</b> file(s) total\n`;

        if (result.newFiles.length > 0) {
          text += `⬇️ Added <b>${result.newFiles.length}</b> file(s) to JDownloader:\n`;
          result.newFiles.slice(0, 10).forEach((f, i) => {
            text += `  ${i + 1}. ${this._escapeHtml(f.name)}`;
            if (f.size > 0) text += ` (${JDownloaderClient.formatBytes(f.size)})`;
            text += '\n';
          });
          if (result.newFiles.length > 10) text += `  <i>... and ${result.newFiles.length - 10} more</i>\n`;
        } else {
          text += `📭 No files found (folder may be empty or all items are subfolders)\n`;
        }

        if (result.errors.length > 0) {
          text += `\n⚠️ ${result.errors.length} error(s) occurred.`;
        }

        await this._send(chatId, text);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /folder_debug <url> - Show raw Fshare API response for debugging
    this.bot.onText(/\/folder_debug(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      if (!this.config.fshareEmail || !this.config.fsharePassword) {
        return this._send(chatId, '⚠️ Fshare credentials not configured.');
      }

      const url = match[1] ? match[1].trim() : '';
      if (!url) {
        return this._send(chatId, '❌ Usage: /folder_debug <code>&lt;fshare_folder_url&gt;</code>');
      }

      try {
        await this._send(chatId, '⏳ Fetching raw folder data...');
        await this.fshare.login(this.config.fshareEmail, this.config.fsharePassword);

        const linkcode = FshareClient.extractLinkcode(url);
        if (!linkcode) return this._send(chatId, '❌ Cannot extract linkcode from URL');

        const { items } = await this.fshare.getFolderContents(linkcode, 0, 10);

        let text = `🔍 <b>Folder Debug</b>\n`;
        text += `Linkcode: <code>${linkcode}</code>\n`;
        text += `Items found: ${items.length}\n\n`;

        items.forEach((item, i) => {
          text += `<b>${i + 1}. ${this._escapeHtml(item.name || 'N/A')}</b>\n`;
          text += `   type: <code>${item.type}</code>\n`;
          text += `   mimetype: <code>${item.mimetype || 'N/A'}</code>\n`;
          text += `   size: <code>${item.size || 0}</code>\n`;
          text += `   url: <code>${this._escapeHtml((item.url || '').substring(0, 60))}</code>\n`;
          text += `   linkcode: <code>${item.linkcode || 'N/A'}</code>\n`;
          text += `   isFolder: <code>${FshareClient.isFolder(item)}</code>\n\n`;
        });

        await this._send(chatId, text);
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // /report - Send daily summary now
    this.bot.onText(/\/report/, async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;

      try {
        await this._send(chatId, '📊 Generating report...');
        await this._sendDailySummary();
      } catch (error) {
        await this._handleError(chatId, error);
      }
    });

    // Handle plain URLs sent to the bot (auto-add)
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      if (!this._isAuthorized(chatId)) return;
      if (msg.text && msg.text.startsWith('/')) return; // Skip commands

      // Extract URLs from message text and Telegram entities
      const urls = this._extractUrls(msg);

      if (urls && urls.length > 0) {
        try {
          const urlList = urls.join('\n');
          const isFshare = urls.some(u => u.includes('fshare.vn'));
          const label = isFshare ? '🔗 Fshare' : '🔍 URL';
          await this._send(chatId, `${label} Detected ${urls.length} link(s). Adding to JDownloader...`);
          const device = await this._getDefaultDevice();
          await this.jd.addLinks(device.id, urlList);
          await this._send(chatId, `✅ Added <b>${urls.length}</b> link(s) to JDownloader!\nDevice: <code>${device.name}</code>\n\n${urls.map(u => `• <code>${this._escapeHtml(u)}</code>`).join('\n')}`);
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
   * Extract all URLs from a Telegram message (text + entities)
   */
  _extractUrls(msg) {
    const urlSet = new Set();

    // Extract from text using regex
    if (msg.text) {
      const urlRegex = /(https?:\/\/[^\s<>'"]+)/g;
      const matches = msg.text.match(urlRegex);
      if (matches) matches.forEach(u => urlSet.add(u.replace(/[.,;!?]+$/, '')));
    }

    // Extract from Telegram entities (url and text_link types)
    if (msg.entities && msg.text) {
      for (const entity of msg.entities) {
        if (entity.type === 'url') {
          const url = msg.text.substring(entity.offset, entity.offset + entity.length);
          urlSet.add(url);
        } else if (entity.type === 'text_link' && entity.url) {
          urlSet.add(entity.url);
        }
      }
    }

    // Extract from caption (for photo/video messages with caption)
    if (msg.caption) {
      const urlRegex = /(https?:\/\/[^\s<>'"]+)/g;
      const matches = msg.caption.match(urlRegex);
      if (matches) matches.forEach(u => urlSet.add(u.replace(/[.,;!?]+$/, '')));
    }

    if (msg.caption_entities) {
      for (const entity of msg.caption_entities) {
        if (entity.type === 'url' && msg.caption) {
          const url = msg.caption.substring(entity.offset, entity.offset + entity.length);
          urlSet.add(url);
        } else if (entity.type === 'text_link' && entity.url) {
          urlSet.add(entity.url);
        }
      }
    }

    return Array.from(urlSet).filter(u => u.startsWith('http'));
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
   * Monitor downloads and notify when completed, then remove from list (keep files)
   */
  async _startDownloadMonitor() {
    const POLL_INTERVAL = 30000; // Check every 30 seconds
    let initialized = false;

    const check = async () => {
      try {
        if (!this.jd.connected) return;

        const device = await this._getDefaultDevice();
        const packages = await this.jd.getDownloads(device.id);

        if (!packages || packages.length === 0) {
          initialized = true;
          return;
        }

        // On first run: mark all currently finished packages as known
        // (don't notify about downloads that were already finished before bot started)
        if (!initialized) {
          for (const pkg of packages) {
            if (pkg.finished) {
              const pkgId = pkg.uuid || pkg.name;
              this.knownFinishedPackages.add(pkgId);
            }
          }
          initialized = true;
          console.log(`📡 Monitor initialized: ${this.knownFinishedPackages.size} existing finished package(s) noted`);
          return;
        }

        const newlyFinished = [];
        const newlyFailed = [];

        for (const pkg of packages) {
          const pkgId = pkg.uuid || pkg.name;

          // Check for newly completed downloads
          if (pkg.finished && !this.knownFinishedPackages.has(pkgId)) {
            newlyFinished.push(pkg);
            this.knownFinishedPackages.add(pkgId);
          }

          // Check for failed downloads (status contains error keywords)
          const isFailed = pkg.status && (
            pkg.status.toLowerCase().includes('error') ||
            pkg.status.toLowerCase().includes('failed') ||
            pkg.status.toLowerCase().includes('lỗi') ||
            pkg.status === 'Error'
          );
          if (isFailed && !pkg.finished && !this.knownFailedPackages.has(pkgId)) {
            newlyFailed.push(pkg);
            this.knownFailedPackages.add(pkgId);
          }
        }

        // Handle newly completed downloads
        if (newlyFinished.length > 0) {
          // Update daily stats
          const today = new Date().toDateString();
          if (this.dailyStats.date !== today) {
            this.dailyStats = { completed: 0, failed: 0, totalBytes: 0, date: today };
          }
          this.dailyStats.completed += newlyFinished.length;
          this.dailyStats.totalBytes += newlyFinished.reduce((sum, p) => sum + (p.bytesTotal || 0), 0);

          // Build notification message
          let msg = `✅ <b>${newlyFinished.length} download(s) completed!</b>\n\n`;
          newlyFinished.forEach((pkg, i) => {
            msg += `${i + 1}. 📁 <b>${this._escapeHtml(pkg.name || 'Unknown')}</b>\n`;
            if (pkg.bytesTotal > 0) {
              msg += `   Size: ${JDownloaderClient.formatBytes(pkg.bytesTotal)}\n`;
            }
            if (pkg.saveTo) {
              msg += `   Saved to: <code>${this._escapeHtml(pkg.saveTo)}</code>\n`;
            }
            msg += '\n';
          });

          // Remove newly finished packages from list (keep files)
          const uuidsToRemove = newlyFinished.map(p => p.uuid).filter(Boolean);
          let removed = false;
          if (uuidsToRemove.length > 0) {
            try {
              await this.jd.removePackages(device.id, uuidsToRemove);
              removed = true;
              console.log(`✅ Removed ${uuidsToRemove.length} finished package(s) from list (files kept)`);
            } catch (e) {
              console.error('Failed to remove finished downloads:', e.message);
              try {
                await this.jd.cleanupFinished(device.id);
                removed = true;
              } catch (e2) {
                console.error('Fallback cleanup also failed:', e2.message);
              }
            }
          }

          msg += removed
            ? '✅ Removed from download list (files kept on disk)'
            : '⚠️ Could not remove from list automatically — use /cleanup';

          // Notify all active chat IDs
          for (const chatId of this.activeChatIds) {
            await this._send(chatId, msg);
          }
        }

        // Handle failed downloads
        if (newlyFailed.length > 0) {
          // Update daily stats
          const today = new Date().toDateString();
          if (this.dailyStats.date !== today) {
            this.dailyStats = { completed: 0, failed: 0, totalBytes: 0, date: today };
          }
          this.dailyStats.failed += newlyFailed.length;

          let errMsg = `❌ <b>${newlyFailed.length} download(s) failed!</b>\n\n`;
          newlyFailed.forEach((pkg, i) => {
            errMsg += `${i + 1}. 📁 <b>${this._escapeHtml(pkg.name || 'Unknown')}</b>\n`;
            if (pkg.status) {
              errMsg += `   Status: <code>${this._escapeHtml(pkg.status)}</code>\n`;
            }
            errMsg += '\n';
          });
          errMsg += '💡 Use /downloads to see details or /retry to retry failed downloads.';

          for (const chatId of this.activeChatIds) {
            await this._send(chatId, errMsg);
          }
        }
      } catch (e) {
        // Silently ignore monitor errors (device offline, etc.)
        if (e.message && !e.message.includes('No online')) {
          console.error('Download monitor error:', e.message);
        }
      }
    };

    // Start polling
    setInterval(check, POLL_INTERVAL);
    // Run first check immediately to initialize known packages
    setTimeout(check, 5000);
    console.log(`📡 Download monitor started (checking every ${POLL_INTERVAL / 1000}s)`);
  }

  /**
   * Send daily summary report
   */
  async _sendDailySummary() {
    if (this.activeChatIds.size === 0) return;

    const today = new Date().toLocaleDateString('vi-VN', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    let msg = `📊 <b>Báo cáo hàng ngày</b>\n`;
    msg += `📅 ${today}\n\n`;

    if (this.dailyStats.completed === 0 && this.dailyStats.failed === 0) {
      msg += `📭 Không có hoạt động tải xuống nào hôm nay.`;
    } else {
      msg += `✅ Hoàn thành: <b>${this.dailyStats.completed}</b> file\n`;
      msg += `❌ Thất bại: <b>${this.dailyStats.failed}</b> file\n`;
      if (this.dailyStats.totalBytes > 0) {
        msg += `💾 Tổng dung lượng: <b>${JDownloaderClient.formatBytes(this.dailyStats.totalBytes)}</b>\n`;
      }
    }

    // Get current download queue status
    try {
      const device = await this._getDefaultDevice();
      const packages = await this.jd.getDownloads(device.id);
      const active = (packages || []).filter(p => !p.finished);
      if (active.length > 0) {
        msg += `\n⏳ Đang chờ/tải: <b>${active.length}</b> file`;
      }
    } catch (e) {
      // Ignore
    }

    for (const chatId of this.activeChatIds) {
      await this._send(chatId, msg);
    }

    // Reset daily stats
    this.dailyStats = { completed: 0, failed: 0, totalBytes: 0, date: new Date().toDateString() };
    console.log('📊 Daily summary sent');
  }

  /**
   * Schedule daily report
   */
  _scheduleDailyReport() {
    const reportTime = this.config.dailyReportTime || '08:00';
    const [hours, minutes] = reportTime.split(':').map(Number);

    const scheduleNext = () => {
      const now = new Date();
      const next = new Date();
      next.setHours(hours, minutes, 0, 0);

      // If the time has already passed today, schedule for tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      const delay = next - now;
      console.log(`📅 Daily report scheduled for ${next.toLocaleString('vi-VN')} (in ${Math.round(delay / 60000)} minutes)`);

      setTimeout(async () => {
        await this._sendDailySummary();
        scheduleNext(); // Schedule next day
      }, delay);
    };

    scheduleNext();
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

      // Start download completion monitor
      this._startDownloadMonitor();

      // Schedule daily report
      if (this.config.dailyReportTime) {
        this._scheduleDailyReport();
      }

      // Start folder watcher scheduler (if Fshare credentials configured)
      if (this.config.fshareEmail && this.config.fsharePassword) {
        this._startFolderWatcherScheduler();
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
      // Still start the monitor even if initial device listing failed
      this._startDownloadMonitor();
      if (this.config.dailyReportTime) {
        this._scheduleDailyReport();
      }
      if (this.config.fshareEmail && this.config.fsharePassword) {
        this._startFolderWatcherScheduler();
      }
    }
  }

  /**
   * Start the folder watcher daily scheduler
   */
  _startFolderWatcherScheduler() {
    const folders = this.folderWatcher.getWatchedFolders();
    if (folders.length === 0) {
      console.log('📂 FolderWatcher: no folders to watch (use /watch_folder to add)');
    } else {
      console.log(`📂 FolderWatcher: watching ${folders.length} folder(s)`);
    }

    // Use DAILY_REPORT_TIME or default to 06:00 for folder checks
    const checkTime = this.config.folderCheckTime || this.config.dailyReportTime || '06:00';

    this.folderWatcher.startScheduler(checkTime, async (results) => {
      const totalNew = results.reduce((sum, r) => sum + (r.newFiles ? r.newFiles.length : 0), 0);

      if (totalNew === 0 && results.every(r => !r.errors || r.errors.length === 0)) {
        console.log('📂 FolderWatcher: no new files found');
        return;
      }

      // Build notification message
      let msg = `📂 <b>Folder Watch Update</b>\n\n`;

      results.forEach(r => {
        if (r.newFiles && r.newFiles.length > 0) {
          msg += `📁 <b>${this._escapeHtml(r.name)}</b>\n`;
          msg += `   ⬇️ ${r.newFiles.length} new file(s) added to JDownloader:\n`;
          r.newFiles.slice(0, 5).forEach(f => {
            msg += `   • ${this._escapeHtml(f.name)}`;
            if (f.size > 0) msg += ` (${JDownloaderClient.formatBytes(f.size)})`;
            msg += '\n';
          });
          if (r.newFiles.length > 5) msg += `   <i>... and ${r.newFiles.length - 5} more</i>\n`;
          msg += '\n';
        }
      });

      if (totalNew > 0) {
        msg += `📊 Total: <b>${totalNew}</b> new file(s) added to JDownloader`;
      }

      for (const chatId of this.activeChatIds) {
        await this._send(chatId, msg);
      }
    });
  }
}

module.exports = JDownloaderTelegramBot;
