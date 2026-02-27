/**
 * Test MyJDownloader authentication - detailed debug
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

console.log('=== MyJDownloader Auth Debug ===');
console.log(`Email: ${email}`);
console.log(`Password length: ${password.length} chars`);
console.log('');

async function testAuth() {
  // Step 1: Compute login secret
  const rawData = email.toLowerCase() + password + 'server';
  console.log('Raw secret data:', rawData);
  
  const loginSecretWordArray = CryptoJS.SHA256(rawData);
  const loginSecretHex = CryptoJS.enc.Hex.stringify(loginSecretWordArray);
  console.log('Login secret (hex):', loginSecretHex);
  console.log('Login secret length:', loginSecretHex.length, '(should be 64)');
  console.log('');

  // Step 2: Build request
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

  // Step 3: Compute signature
  const signData = `${path}${rid}`;
  console.log('Sign data:', signData);
  
  const signature = CryptoJS.HmacSHA256(signData, CryptoJS.enc.Hex.parse(loginSecretHex));
  const signatureHex = CryptoJS.enc.Hex.stringify(signature);
  console.log('Signature:', signatureHex);
  console.log('');

  const url = `${API_BASE}${path}?${queryString}&signature=${signatureHex}`;
  console.log('Full URL:', url);
  console.log('');

  try {
    console.log('Sending request...');
    const response = await axios.get(url);
    console.log('✅ SUCCESS! Response:');
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    if (error.response) {
      console.error('❌ HTTP Error', error.response.status);
      console.error('Response:', JSON.stringify(error.response.data));
    } else {
      console.error('❌ Network Error:', error.message);
    }
  }
}

testAuth().catch(console.error);
