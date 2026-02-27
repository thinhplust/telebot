/**
 * Test MyJDownloader authentication
 * Run: node test-auth.js
 */

require('dotenv').config();
const axios = require('axios');
const CryptoJS = require('crypto-js');

const API_BASE = 'https://api.jdownloader.org';
const APP_KEY = 'jd-telegram-bot';

const email = process.env.JD_EMAIL;
const password = process.env.JD_PASSWORD;

if (!email || !password) {
  console.error('Missing JD_EMAIL or JD_PASSWORD in .env');
  process.exit(1);
}

console.log(`Testing auth for: ${email}`);

// Method 1: Current implementation (hex string keys)
async function testAuth() {
  const loginSecretHex = CryptoJS.enc.Hex.stringify(
    CryptoJS.SHA256(email.toLowerCase() + password + 'server')
  );
  
  console.log('Login secret (hex):', loginSecretHex);

  const rid = Date.now();
  const path = '/my/connect';

  const params = {
    email: email,
    appkey: APP_KEY,
    rid: rid.toString()
  };

  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  const signData = `${path}${rid}`;
  console.log('Sign data:', signData);

  const signature = CryptoJS.HmacSHA256(signData, CryptoJS.enc.Hex.parse(loginSecretHex));
  const signatureHex = CryptoJS.enc.Hex.stringify(signature);
  console.log('Signature:', signatureHex);

  const url = `${API_BASE}${path}?${queryString}&signature=${signatureHex}`;
  console.log('URL:', url);

  try {
    const response = await axios.get(url);
    console.log('✅ SUCCESS:', JSON.stringify(response.data, null, 2));
  } catch (error) {
    if (error.response) {
      console.error('❌ FAILED:', JSON.stringify(error.response.data));
    } else {
      console.error('❌ ERROR:', error.message);
    }
  }
}

testAuth();
