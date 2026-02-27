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
   */
  static formatAccountType(type) {
    const types = {
      0: 'Free',
      1: 'VIP',
      2: 'Premium'
    };
    return types[type] || `Type ${type}`;
  }
}

module.exports = FshareClient;
