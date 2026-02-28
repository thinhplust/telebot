/**
 * FolderWatcher - Monitor Fshare folders for new files and auto-download
 *
 * Features:
 * - Watch multiple Fshare folder URLs
 * - Persist state to JSON file (survives restarts)
 * - Daily check: only download NEW files not seen before
 * - Get VIP direct download links and add to JDownloader
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'folder-watch-state.json');

class FolderWatcher {
  /**
   * @param {import('./fshare')} fshareClient
   * @param {import('./jdownloader')} jdClient
   * @param {object} config - { fshareEmail, fsharePassword, jdEmail, jdPassword }
   */
  constructor(fshareClient, jdClient, config) {
    this.fshare = fshareClient;
    this.jd = jdClient;
    this.config = config;

    /**
     * State structure:
     * {
     *   folders: {
     *     [folderUrl]: {
     *       url: string,
     *       name: string,           // folder display name
     *       addedAt: ISO string,
     *       lastChecked: ISO string,
     *       downloadedFiles: {
     *         [linkcode]: {
     *           linkcode: string,
     *           name: string,
     *           size: number,
     *           downloadedAt: ISO string
     *         }
     *       }
     *     }
     *   }
     * }
     */
    this.state = { folders: {} };
    this._loadState();
  }

  // ─── State persistence ────────────────────────────────────────────────────

  _loadState() {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        this.state = JSON.parse(raw);
        if (!this.state.folders) this.state.folders = {};
        console.log(`📂 FolderWatcher: loaded ${Object.keys(this.state.folders).length} watched folder(s)`);
      }
    } catch (e) {
      console.error('FolderWatcher: failed to load state:', e.message);
      this.state = { folders: {} };
    }
  }

  _saveState() {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (e) {
      console.error('FolderWatcher: failed to save state:', e.message);
    }
  }

  // ─── Folder management ────────────────────────────────────────────────────

  /**
   * Add a folder to watch list
   * @param {string} url - Fshare folder URL
   * @param {string} [name] - optional display name
   * @returns {{ isNew: boolean, folder: object }}
   */
  addFolder(url, name = '') {
    const normalizedUrl = url.trim().split('?')[0]; // strip query params
    const isNew = !this.state.folders[normalizedUrl];

    if (isNew) {
      this.state.folders[normalizedUrl] = {
        url: normalizedUrl,
        name: name || normalizedUrl,
        addedAt: new Date().toISOString(),
        lastChecked: null,
        downloadedFiles: {}
      };
      this._saveState();
    }

    return { isNew, folder: this.state.folders[normalizedUrl] };
  }

  /**
   * Remove a folder from watch list
   * @param {string} url
   * @returns {boolean} true if removed
   */
  removeFolder(url) {
    const normalizedUrl = url.trim().split('?')[0];
    if (this.state.folders[normalizedUrl]) {
      delete this.state.folders[normalizedUrl];
      this._saveState();
      return true;
    }
    return false;
  }

  /**
   * Reset the downloaded files state for a folder (keeps folder in watch list)
   * Use this to force a full rescan on next check
   * @param {string} url
   * @returns {boolean} true if reset
   */
  resetFolderState(url) {
    const normalizedUrl = url.trim().split('?')[0];
    if (this.state.folders[normalizedUrl]) {
      this.state.folders[normalizedUrl].downloadedFiles = {};
      this.state.folders[normalizedUrl].lastChecked = null;
      this._saveState();
      return true;
    }
    return false;
  }

  /**
   * Get all watched folders
   * @returns {Array}
   */
  getWatchedFolders() {
    return Object.values(this.state.folders);
  }

  /**
   * Get downloaded file count for a folder
   */
  getDownloadedCount(url) {
    const normalizedUrl = url.trim().split('?')[0];
    const folder = this.state.folders[normalizedUrl];
    return folder ? Object.keys(folder.downloadedFiles).length : 0;
  }

  // ─── Core check logic ─────────────────────────────────────────────────────

  /**
   * Ensure Fshare is logged in
   */
  async _ensureFshareLogin() {
    if (!this.fshare.token) {
      await this.fshare.login(this.config.fshareEmail, this.config.fsharePassword);
    }
  }

  /**
   * Ensure JDownloader is connected
   */
  async _ensureJdConnected() {
    if (!this.jd.connected) {
      await this.jd.connect(this.config.jdEmail, this.config.jdPassword);
    }
  }

  /**
   * Check a single folder for new files and download them
   * @param {string} url - folder URL
   * @returns {{ newFiles: Array, errors: Array }}
   */
  async checkFolder(url) {
    const FshareClient = require('./fshare');
    const normalizedUrl = url.trim().split('?')[0];
    const folder = this.state.folders[normalizedUrl];
    if (!folder) throw new Error(`Folder not in watch list: ${url}`);

    const linkcode = FshareClient.extractLinkcode(normalizedUrl);
    if (!linkcode) throw new Error(`Cannot extract linkcode from URL: ${url}`);

    await this._ensureFshareLogin();

    // Get all files in folder
    const allFiles = await this.fshare.getAllFilesInFolder(linkcode);
    console.log(`📂 Folder "${folder.name}": found ${allFiles.length} file(s)`);

    // Update folder name from API if available
    folder.lastChecked = new Date().toISOString();

    const newFiles = [];
    const errors = [];

    for (const file of allFiles) {
      const fileLinkcode = file.linkcode || FshareClient.extractLinkcode(file.url || '');
      if (!fileLinkcode) continue;

      // Safety check: skip if this item is actually a folder (double-check)
      if (FshareClient.isFolder(file)) {
        console.warn(`[FolderWatcher] Skipping folder item: ${file.name} (linkcode: ${fileLinkcode})`);
        continue;
      }

      // Build file URL — must be a /file/ URL, not /folder/
      const fileUrl = file.url && file.url.includes('/file/')
        ? file.url
        : `https://www.fshare.vn/file/${fileLinkcode}`;

      // Extra safety: skip if URL still looks like a folder
      if (fileUrl.includes('/folder/')) {
        console.warn(`[FolderWatcher] Skipping folder URL: ${fileUrl}`);
        continue;
      }

      // Skip already downloaded files
      if (folder.downloadedFiles[fileLinkcode]) continue;

      // This is a new file — get direct download link and add to JDownloader
      try {
        let downloadUrl = fileUrl;

        // Try to get VIP direct link if logged in
        try {
          downloadUrl = await this.fshare.getDirectDownloadLink(fileUrl);
        } catch (e) {
          console.warn(`⚠️ Could not get direct link for ${file.name}, using original URL: ${e.message}`);
          downloadUrl = fileUrl;
        }

        // Add to JDownloader
        await this._ensureJdConnected();
        const JDownloaderClient = require('./jdownloader');
        const devices = await this.jd.listDevices();
        const device = devices.find(d => d.status === 'ONLINE' || d.status === 'UNKNOWN');
        if (!device) throw new Error('No online JDownloader device');

        await this.jd.addLinks(device.id, downloadUrl, file.name || null);

        // Mark as downloaded
        folder.downloadedFiles[fileLinkcode] = {
          linkcode: fileLinkcode,
          name: file.name || fileLinkcode,
          size: file.size || 0,
          url: fileUrl,
          downloadedAt: new Date().toISOString()
        };

        newFiles.push({
          name: file.name || fileLinkcode,
          size: file.size || 0,
          url: fileUrl
        });

        console.log(`✅ Added new file to JD: ${file.name}`);
      } catch (e) {
        console.error(`❌ Failed to add file ${file.name}: ${e.message}`);
        errors.push({ name: file.name || fileLinkcode, error: e.message });
      }
    }

    this._saveState();
    return { newFiles, errors, totalFiles: allFiles.length };
  }

  /**
   * Check ALL watched folders for new files
   * @returns {Array<{ url: string, name: string, newFiles: Array, errors: Array }>}
   */
  async checkAllFolders() {
    const results = [];
    const folders = this.getWatchedFolders();

    for (const folder of folders) {
      try {
        const result = await this.checkFolder(folder.url);
        results.push({
          url: folder.url,
          name: folder.name,
          ...result
        });
      } catch (e) {
        console.error(`❌ Error checking folder "${folder.name}": ${e.message}`);
        results.push({
          url: folder.url,
          name: folder.name,
          newFiles: [],
          errors: [{ error: e.message }],
          totalFiles: 0
        });
      }
    }

    return results;
  }

  /**
   * Start the daily auto-check scheduler
   * @param {string} checkTime - "HH:MM" format (24h), e.g. "06:00"
   * @param {Function} onResult - callback(results) called after each check
   */
  startScheduler(checkTime, onResult) {
    const [hours, minutes] = (checkTime || '06:00').split(':').map(Number);

    const scheduleNext = () => {
      const now = new Date();
      const next = new Date();
      next.setHours(hours, minutes, 0, 0);
      if (next <= now) next.setDate(next.getDate() + 1);

      const delay = next - now;
      console.log(`📅 FolderWatcher: next check at ${next.toLocaleString('vi-VN')} (in ${Math.round(delay / 60000)} min)`);

      setTimeout(async () => {
        console.log('📂 FolderWatcher: running scheduled check...');
        try {
          const results = await this.checkAllFolders();
          if (onResult) await onResult(results);
        } catch (e) {
          console.error('FolderWatcher scheduled check error:', e.message);
        }
        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }
}

module.exports = FolderWatcher;
