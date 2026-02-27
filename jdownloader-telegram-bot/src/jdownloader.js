/**
 * MyJDownloader API Client
 * Based on https://my.jdownloader.org/developers/
 * 
 * Uses the MyJDownloader REST API with HMAC-SHA256 authentication
 */

const axios = require('axios');
const CryptoJS = require('crypto-js');

const API_BASE = 'https://api.jdownloader.org';
const APP_KEY = 'jd-telegram-bot';

class JDownloaderClient {
  constructor() {
    this.sessionToken = null;
    this.regainToken = null;
    this.serverEncryptionToken = null;
    this.deviceEncryptionToken = null;
    this.deviceId = null;
    this.email = null;
    this.password = null;
    this.connected = false;
  }

  /**
   * Create login secret from email + password + domain
   * Returns hex string (64 chars = 32 bytes)
   */
  _createSecret(email, password, domain) {
    const data = email.toLowerCase() + password + domain.toLowerCase();
    return CryptoJS.enc.Hex.stringify(CryptoJS.SHA256(data));
  }

  /**
   * Update encryption token: SHA256(currentToken_bytes + update_bytes)
   * Per MyJDownloader API: new_token = SHA256(old_token + session_token)
   * @param {string} tokenHex - current token as hex string
   * @param {string} updateHex - session/regain token as hex string
   * @returns {string} new token as hex string
   */
  _updateToken(tokenHex, updateHex) {
    return CryptoJS.enc.Hex.stringify(
      CryptoJS.SHA256(CryptoJS.enc.Hex.parse(tokenHex + updateHex))
    );
  }

  /**
   * Sign a request: HMAC-SHA256(data, key_bytes)
   * @param {string} keyHex - key as hex string
   * @param {string} data - string to sign
   * @returns {string} signature as hex string
   */
  _sign(keyHex, data) {
    return CryptoJS.enc.Hex.stringify(
      CryptoJS.HmacSHA256(data, CryptoJS.enc.Hex.parse(keyHex))
    );
  }

  /**
   * Encrypt data using AES-128-CBC
   * IV = first 16 bytes of token, Key = last 16 bytes of token
   * @param {string} data - plaintext string
   * @param {string} tokenHex - 64-char hex string (32 bytes)
   * @returns {string} base64-encoded ciphertext
   */
  _encrypt(data, tokenHex) {
    const iv = CryptoJS.enc.Hex.parse(tokenHex.substring(0, 32));
    const key = CryptoJS.enc.Hex.parse(tokenHex.substring(32, 64));
    const encrypted = CryptoJS.AES.encrypt(data, key, {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7
    });
    return encrypted.toString();
  }

  /**
   * Decrypt data using AES-128-CBC
   * IV = first 16 bytes of token, Key = last 16 bytes of token
   * @param {string} data - base64-encoded ciphertext
   * @param {string} tokenHex - 64-char hex string (32 bytes)
   * @returns {string} decrypted plaintext
   */
  _decrypt(data, tokenHex) {
    const iv = CryptoJS.enc.Hex.parse(tokenHex.substring(0, 32));
    const key = CryptoJS.enc.Hex.parse(tokenHex.substring(32, 64));
    const decrypted = CryptoJS.AES.decrypt(data, key, {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7
    });
    return decrypted.toString(CryptoJS.enc.Utf8);
  }

  /**
   * Build a signed server API URL
   * Per API docs: signature = HMAC-SHA256(path?queryString, encryptionToken)
   */
  _buildSignedUrl(path, params, tokenHex) {
    const queryString = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const signData = `${path}?${queryString}`;
    const signature = this._sign(tokenHex, signData);
    return `${API_BASE}${path}?${queryString}&signature=${signature}`;
  }

  /**
   * Connect and authenticate with MyJDownloader
   */
  async connect(email, password) {
    this.email = email;
    this.password = password;

    // Compute secrets (hex strings, 64 chars = 32 bytes each)
    const loginSecret = this._createSecret(email, password, 'server');
    const deviceSecret = this._createSecret(email, password, 'device');

    const rid = Date.now();
    const url = this._buildSignedUrl('/my/connect', {
      email: email,
      appkey: APP_KEY,
      rid: rid.toString()
    }, loginSecret);

    try {
      const response = await axios.get(url);

      // Response is AES-encrypted with the login secret
      const decryptedStr = this._decrypt(response.data, loginSecret);
      const data = JSON.parse(decryptedStr);

      if (data.error) {
        throw new Error(`Login failed: ${data.error}`);
      }

      this.sessionToken = data.sessiontoken;
      this.regainToken = data.regaintoken;

      // Update encryption tokens: SHA256(secret + sessionToken)
      this.serverEncryptionToken = this._updateToken(loginSecret, this.sessionToken);
      this.deviceEncryptionToken = this._updateToken(deviceSecret, this.sessionToken);

      this.connected = true;
      return true;
    } catch (error) {
      if (error.response) {
        throw new Error(`Login failed: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Disconnect from MyJDownloader
   */
  async disconnect() {
    if (!this.connected) return;

    const rid = Date.now();
    const url = this._buildSignedUrl('/my/disconnect', {
      sessiontoken: this.sessionToken,
      rid: rid.toString()
    }, this.serverEncryptionToken);

    try {
      await axios.get(url);
    } catch (e) {
      // Ignore disconnect errors
    }

    this.connected = false;
    this.sessionToken = null;
  }

  /**
   * List all connected JDownloader devices
   */
  async listDevices() {
    if (!this.connected) throw new Error('Not connected. Call connect() first.');

    const rid = Date.now();
    const url = this._buildSignedUrl('/my/listdevices', {
      sessiontoken: this.sessionToken,
      rid: rid.toString()
    }, this.serverEncryptionToken);

    try {
      const response = await axios.get(url);
      // Response is AES-encrypted with the server encryption token
      const decryptedStr = this._decrypt(response.data, this.serverEncryptionToken);
      const data = JSON.parse(decryptedStr);
      return data.list || [];
    } catch (error) {
      throw new Error(`Failed to list devices: ${error.message}`);
    }
  }

  /**
   * Call a device-specific API method
   */
  async callDevice(deviceId, interfaceName, methodName, params = []) {
    if (!this.connected) throw new Error('Not connected. Call connect() first.');

    const rid = Date.now();
    const path = `/t_${encodeURIComponent(this.sessionToken)}_${encodeURIComponent(deviceId)}/${interfaceName}/${methodName}`;

    const requestBody = JSON.stringify({
      url: `/${interfaceName}/${methodName}`,
      params: params.map(p => JSON.stringify(p)),
      rid: rid,
      apiVer: 1
    });

    const encryptedBody = this._encrypt(requestBody, this.deviceEncryptionToken);

    const signData = path + rid + encryptedBody;
    const signature = this._sign(this.deviceEncryptionToken, signData);

    try {
      const response = await axios.post(
        `${API_BASE}${path}`,
        encryptedBody,
        {
          headers: {
            'Content-Type': 'application/aesjson-jd; charset=utf-8',
            'signature': signature
          }
        }
      );

      const decrypted = this._decrypt(response.data, this.deviceEncryptionToken);
      const result = JSON.parse(decrypted);

      // Update device encryption token after each call
      this.deviceEncryptionToken = this._updateToken(
        this.deviceEncryptionToken,
        result.rid.toString(16).padStart(2, '0')
      );

      return result.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`Device API call failed: ${JSON.stringify(error.response.data)}`);
      }
      throw new Error(`Device API call failed: ${error.message}`);
    }
  }

  /**
   * Add download links to JDownloader
   */
  async addLinks(deviceId, links, packageName = null, downloadPath = null) {
    const params = {
      links: Array.isArray(links) ? links.join('\n') : links,
      autostart: true,
      packageName: packageName || '',
      destinationFolder: downloadPath || '',
      overwritePackagizerRules: false
    };

    return await this.callDevice(deviceId, 'linkgrabberv2', 'addLinks', [params]);
  }

  /**
   * Get download list
   */
  async getDownloads(deviceId) {
    return await this.callDevice(deviceId, 'downloadsV2', 'queryPackages', [{
      bytesLoaded: true,
      bytesTotal: true,
      comment: false,
      enabled: true,
      eta: true,
      priority: false,
      finished: true,
      running: true,
      speed: true,
      status: true,
      childCount: true,
      hosts: true,
      saveTo: true,
      maxResults: -1,
      startAt: 0
    }]);
  }

  /**
   * Get download links (files within packages)
   */
  async getDownloadLinks(deviceId, packageUUIDs = null) {
    const query = {
      bytesLoaded: true,
      bytesTotal: true,
      comment: false,
      enabled: true,
      eta: true,
      priority: false,
      finished: true,
      running: true,
      speed: true,
      status: true,
      host: true,
      packageUUIDs: packageUUIDs || [],
      maxResults: -1,
      startAt: 0
    };

    return await this.callDevice(deviceId, 'downloadsV2', 'queryLinks', [query]);
  }

  /**
   * Start all downloads
   */
  async startDownloads(deviceId) {
    return await this.callDevice(deviceId, 'downloadcontroller', 'start', []);
  }

  /**
   * Stop all downloads
   */
  async stopDownloads(deviceId) {
    return await this.callDevice(deviceId, 'downloadcontroller', 'stop', []);
  }

  /**
   * Pause downloads
   */
  async pauseDownloads(deviceId, pause = true) {
    return await this.callDevice(deviceId, 'downloadcontroller', 'pause', [pause]);
  }

  /**
   * Get download controller state
   */
  async getDownloadState(deviceId) {
    return await this.callDevice(deviceId, 'downloadcontroller', 'getCurrentState', []);
  }

  /**
   * Get download speed
   */
  async getDownloadSpeed(deviceId) {
    return await this.callDevice(deviceId, 'downloadcontroller', 'getSpeedInBps', []);
  }

  /**
   * Remove packages from download list
   */
  async removePackages(deviceId, packageUUIDs) {
    return await this.callDevice(deviceId, 'downloadsV2', 'removeLinks', [packageUUIDs, []]);
  }

  /**
   * Clean up finished downloads
   */
  async cleanupFinished(deviceId) {
    return await this.callDevice(deviceId, 'downloadsV2', 'cleanup', [
      'DELETE_FINISHED_LINKS_AND_EMPTY_PACKAGES',
      'REMOVE_LINKS_AND_DELETE_FILES',
      'ALL'
    ]);
  }

  /**
   * Get link grabber list
   */
  async getLinkGrabberList(deviceId) {
    return await this.callDevice(deviceId, 'linkgrabberv2', 'queryPackages', [{
      bytesTotal: true,
      comment: false,
      enabled: true,
      hosts: true,
      childCount: true,
      saveTo: true,
      availableOnlineCount: true,
      availableOfflineCount: true,
      availableUnknownCount: true,
      maxResults: -1,
      startAt: 0
    }]);
  }

  /**
   * Move link grabber items to download list
   */
  async startLinkGrabber(deviceId) {
    return await this.callDevice(deviceId, 'linkgrabberv2', 'moveToDownloadlist', [[], []]);
  }

  /**
   * Clear link grabber
   */
  async clearLinkGrabber(deviceId) {
    return await this.callDevice(deviceId, 'linkgrabberv2', 'clearList', []);
  }

  /**
   * Get JDownloader system info
   */
  async getSystemInfo(deviceId) {
    return await this.callDevice(deviceId, 'system', 'getStorageInfos', [{ special: true }]);
  }

  /**
   * Reconnect JDownloader
   */
  async reconnect(deviceId) {
    return await this.callDevice(deviceId, 'reconnect', 'doReconnect', []);
  }

  /**
   * Format bytes to human readable
   */
  static formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
  }

  /**
   * Format speed to human readable
   */
  static formatSpeed(bps) {
    return `${JDownloaderClient.formatBytes(bps)}/s`;
  }

  /**
   * Format ETA to human readable
   */
  static formatETA(seconds) {
    if (!seconds || seconds <= 0) return 'Unknown';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
}

module.exports = JDownloaderClient;
