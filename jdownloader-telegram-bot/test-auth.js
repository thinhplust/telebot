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
console.log(`Email: "${email}"`);
console.log(`Password length: ${password.length} chars`);
console.log('');

function createSecret(email, password, domain) {
  return CryptoJS.enc.Hex.stringify(CryptoJS.SHA256(email.toLowerCase() + password + domain.toLowerCase()));
}

function updateToken(tokenHex, updateHex) {
  return CryptoJS.enc.Hex.stringify(CryptoJS.SHA256(CryptoJS.enc.Hex.parse(tokenHex + updateHex)));
}

function sign(keyHex, data) {
  return CryptoJS.enc.Hex.stringify(CryptoJS.HmacSHA256(data, CryptoJS.enc.Hex.parse(keyHex)));
}

function decrypt(data, tokenHex) {
  const iv = CryptoJS.enc.Hex.parse(tokenHex.substring(0, 32));
  const key = CryptoJS.enc.Hex.parse(tokenHex.substring(32, 64));
  const decrypted = CryptoJS.AES.decrypt(data, key, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 });
  return decrypted.toString(CryptoJS.enc.Utf8);
}

function buildSignedUrl(path, params, tokenHex) {
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const signData = `${path}?${queryString}`;
  const signature = sign(tokenHex, signData);
  return `${API_BASE}${path}?${queryString}&signature=${signature}`;
}

async function testAuth() {
  const loginSecret = createSecret(email, password, 'server');
  const deviceSecret = createSecret(email, password, 'device');
  console.log('Login secret (hex):', loginSecret);
  console.log('');

  // Step 1: Connect
  const rid = Date.now();
  const connectUrl = buildSignedUrl('/my/connect', {
    email: email,
    appkey: APP_KEY,
    rid: rid.toString()
  }, loginSecret);
  console.log('Connect URL:', connectUrl);

  try {
    const r = await axios.get(connectUrl);
    const decrypted = decrypt(r.data, loginSecret);
    const data = JSON.parse(decrypted);
    console.log('✅ Connect SUCCESS:', JSON.stringify(data));

    const sessionToken = data.sessiontoken;
    const serverToken = updateToken(loginSecret, sessionToken);
    console.log('Server encryption token:', serverToken);
    console.log('');

    // Step 2: List devices
    const rid2 = Date.now();
    const devicesUrl = buildSignedUrl('/my/listdevices', {
      sessiontoken: sessionToken,
      rid: rid2.toString()
    }, serverToken);
    console.log('List devices URL:', devicesUrl);

    const r2 = await axios.get(devicesUrl);
    const decrypted2 = decrypt(r2.data, serverToken);
    const data2 = JSON.parse(decrypted2);
    console.log('✅ List devices SUCCESS:', JSON.stringify(data2, null, 2));
  } catch (error) {
    if (error.response) {
      console.error('❌ HTTP Error', error.response.status);
      console.error('Response:', JSON.stringify(error.response.data));
    } else {
      console.error('❌ Error:', error.message);
    }
  }
}

testAuth().catch(console.error);
