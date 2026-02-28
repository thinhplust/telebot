/**
 * Fshare.vn API Client
 * Gets account information including remaining bandwidth
 *
 * To get your app_key and user_agent:
 * 1. Go to https://www.fshare.vn/developer
 * 2. Create an app to get your app_key
 * 3. Set the app name as your user_agent
 */

const axios = require('axios');

const FSHARE_API = 'https://api2.fshare.vn/api';

class FshareClient {
  constructor(appKey, userAgent) {
    this.token = null;
    this.sessionId = null;
    // Use provided credentials or defaults from env
    this.appKey = appKey || process.env.FSHARE_APP_KEY || 'dMnqMMZMUnN5YpvKENaEhdQQ5jxDqddt';
    this.userAgent = userAgent || process.env.FSHARE_USER_AGENT || 'THINHNdg5';
  }

  /**
   * Login to Fshare
   * @param {string} email
   * @param {string} password
   */
  async login(email, password) {
    try {
      const response = await axios.post(`${FSHARE_API}/user/login`, {
        user_email: email,
        password: password,
        app_key: this.appKey
      }, {
        headers: {
          'User-Agent': this.userAgent,
          'Content-Type': 'application/json'
        }
      });

      const data = response.data;
      if (data.code === 200 && data.token) {
        this.token = data.token;
        this.sessionId = data.session_id;
        return true;
      }
      throw new Error(data.msg || `Login failed (code: ${data.code})`);
    } catch (error) {
      if (error.response) {
        throw new Error(`Fshare login failed: ${JSON.stringify(error.response.data)}`);
      }
      if (error.message) throw error;
      throw new Error('Fshare login failed');
    }
  }

  /**
   * Get account profile information
   */
  async getProfile() {
    if (!this.token) throw new Error('Not logged in to Fshare');

    try {
      const response = await axios.get(`${FSHARE_API}/user/get`, {
        headers: {
          'User-Agent': this.userAgent,
          'Cookie': `session_id=${this.sessionId}`,
          'Token': this.token
        }
      });

      return response.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`Failed to get Fshare profile: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Get auth headers for authenticated requests
   */
  _authHeaders() {
    return {
      'User-Agent': this.userAgent,
      'Cookie': `session_id=${this.sessionId}`,
      'Token': this.token
    };
  }

  /**
   * Extract linkcode from a Fshare folder URL
   * e.g. https://www.fshare.vn/folder/ABCDEF123 → "ABCDEF123"
   * @param {string} url
   * @returns {string|null}
   */
  static extractLinkcode(url) {
    const match = url.match(/fshare\.vn\/(?:folder|file)\/([A-Za-z0-9]+)/);
    return match ? match[1] : null;
  }

  /**
   * List files/folders inside a Fshare folder
   * @param {string} linkcode - folder linkcode (from URL)
   * @param {number} pageIndex - page index (0-based)
   * @param {number} limit - items per page (default 60)
   * @returns {Promise<{items: Array, total: number}>}
   */
  async getFolderContents(linkcode, pageIndex = 0, limit = 60) {
    if (!this.token) throw new Error('Not logged in to Fshare');

    try {
      const response = await axios.get(`${FSHARE_API}/fileops/list`, {
        params: {
          linkcode,
          pageIndex,
          limit
        },
        headers: this._authHeaders()
      });

      const data = response.data;
      // Debug: log raw response to understand structure
      if (pageIndex === 0) {
        console.log(`[Fshare] getFolderContents(${linkcode}) raw:`, JSON.stringify(data).substring(0, 500));
      }

      // API returns { items: [...], total: N } or array directly
      if (Array.isArray(data)) return { items: data, total: data.length };
      return {
        items: data.items || data.data || [],
        total: data.total || data.count || 0
      };
    } catch (error) {
      if (error.response) {
        throw new Error(`Failed to list folder: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
  }

  /**
   * Determine if a Fshare API item is a folder (not a file)
   * Fshare API uses: type=0 for folder, type=1 for file (or mimetype checks)
   * @param {object} item
   * @returns {boolean}
   */
  static isFolder(item) {
    // type: 0 = folder, 1 = file (most common Fshare API convention)
    // Note: API may return type as string "0"/"1" or number 0/1
    const typeNum = parseInt(item.type, 10);
    if (!isNaN(typeNum)) {
      if (typeNum === 0) return true;
      if (typeNum === 1) return false;
    }
    // mimetype checks
    if (item.mimetype === 'folder' || item.mimetype === 'application/x-directory') return true;
    // explicit folder flag
    if (item.folder === true || item.is_folder === true || item.isFolder === true) return true;
    // URL-based detection: if URL contains /folder/ it's a folder
    if (item.url && item.url.includes('/folder/')) return true;
    // If it has no size and has a linkcode that looks like a folder
    if (!item.size && item.linkcode && !item.mimetype) return true;
    return false;
  }

  /**
   * Recursively get ALL files in a folder (handles pagination and subfolders)
   * @param {string} linkcode - folder linkcode
   * @param {number} depth - recursion depth limit (default 5)
   * @returns {Promise<Array>} flat list of file objects
   */
  async getAllFilesInFolder(linkcode, depth = 0) {
    if (depth > 5) {
      console.warn(`[Fshare] Max recursion depth reached for linkcode: ${linkcode}`);
      return [];
    }

    const allFiles = [];
    let pageIndex = 0;
    const limit = 60;

    while (true) {
      const { items, total } = await this.getFolderContents(linkcode, pageIndex, limit);
      if (!items || items.length === 0) break;

      for (const item of items) {
        console.log(`[Fshare] item: name="${item.name}" type=${item.type} mimetype=${item.mimetype} size=${item.size} url=${item.url}`);

        if (FshareClient.isFolder(item)) {
          // It's a subfolder — recurse
          const subLinkcode = item.linkcode || FshareClient.extractLinkcode(item.url || '');
          if (subLinkcode && subLinkcode !== linkcode) {
            console.log(`[Fshare] Recursing into subfolder: ${item.name} (${subLinkcode})`);
            const subFiles = await this.getAllFilesInFolder(subLinkcode, depth + 1);
            allFiles.push(...subFiles);
          }
        } else {
          // It's a file
          allFiles.push(item);
        }
      }

      // Check if there are more pages
      if (items.length < limit) break;
      pageIndex++;
    }

    return allFiles;
  }

  /**
   * Get a direct (VIP) download link for a file
   * @param {string} url - full Fshare file URL
   * @param {string} [password] - file password if protected
   * @returns {Promise<string>} direct download URL
   */
  async getDirectDownloadLink(url, password = '') {
    if (!this.token) throw new Error('Not logged in to Fshare');

    try {
      const response = await axios.post(`${FSHARE_API}/session/download`, {
        url,
        password,
        token: this.token
      }, {
        headers: {
          ...this._authHeaders(),
          'Content-Type': 'application/json'
        }
      });

      const data = response.data;
      if (data.location) return data.location;
      if (data.url) return data.url;
      throw new Error(data.msg || 'No download URL in response');
    } catch (error) {
      if (error.response) {
        throw new Error(`Failed to get download link: ${JSON.stringify(error.response.data)}`);
      }
      throw error;
    }
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
   * Format account type
   * Fshare API may return numeric (0,1,2) or string values
   */
  static formatAccountType(type) {
    // Numeric mapping
    const numericTypes = {
      0: 'Free',
      1: 'VIP',
      2: 'Premium'
    };
    // String mapping (observed from API responses)
    const stringTypes = {
      'free': 'Free',
      'vip': 'VIP',
      'premium': 'Premium',
      'adsl2plus': 'VIP (ADSL2+)',
      'adsl2': 'VIP (ADSL2)',
      'ftth': 'VIP (FTTH)',
      'vip1': 'VIP 1',
      'vip2': 'VIP 2',
      'vip3': 'VIP 3'
    };

    if (type === null || type === undefined) return 'Unknown';
    if (typeof type === 'number') return numericTypes[type] || `Type ${type}`;
    if (typeof type === 'string') {
      return stringTypes[type.toLowerCase()] || type;
    }
    return String(type);
  }
}

module.exports = FshareClient;
