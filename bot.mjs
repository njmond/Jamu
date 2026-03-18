import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STATE_DIR = path.join(__dirname, 'states');
const CONFIG_FILE = path.join(__dirname, 'accounts.json');
const NOTIFY_INTERVAL_MS = parseInt(process.env.NOTIFY_INTERVAL_MS || '1800000');
const TASK_NOTIFY_EVERY = parseInt(process.env.TASK_NOTIFY_EVERY || '50');

if (!TOKEN || !CHAT_ID) {
  console.error('❌ Set TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID di environment variables');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
const fetch = (await import('node-fetch')).default;
const sessions = {};

bot.setMyCommands([
  { command: 'start',         description: '🏠 Menu utama' },
  { command: 'stats',         description: '📊 Lihat earnings semua akun' },
  { command: 'status',        description: '✅ Cek apakah miner aktif' },
  { command: 'notify',        description: '🔔 Kirim update stats sekarang' },
  { command: 'addaccount',    description: '➕ Tambah akun baru' },
  { command: 'listaccounts',  description: '📋 Lihat semua akun' },
  { command: 'removeaccount', description: '❌ Hapus akun' },
  { command: 'getkey',        description: '🔑 Ambil private key agent' },
  { command: 'setcompute',    description: '⚙️ Ganti CPU/GPU' },
  { command: 'setinterval',   description: '⏱️ Ganti mining interval' },
  { command: 'help',          description: '❓ Bantuan' },
]).then(() => console.log('✅ Bot commands registered'));

// ==============================
// HELPERS
// ==============================
function isAuthorized(msg) { return msg.chat.id.toString() === CHAT_ID.toString(); }

function escape(text) { return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&'); }

function sendMd(text, options = {}) {
  return bot.sendMessage(CHAT_ID, text, { parse_mode: 'MarkdownV2', ...options })
    .catch(err => console.error('Send error:', err.message));
}

function sendPlain(text) {
  return bot.sendMessage(CHAT_ID, text)
    .catch(err => console.error('Send plain error:', err.message));
}

function loadConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); }
  catch {}
  return { settings: { compute_capability: 'CPU', max_vcus: 1000, mining_interval_ms: 2000, max_consecutive_failures: 10, retry_delay_ms: 5000 }, accounts: [] };
}

function saveConfig(config) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8'); }

function getAllStates() {
  try {
    if (!fs.existsSync(STATE_DIR)) return [];
    return fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json')).map(file => {
      const state = JSON.parse(fs.readFileSync(path.join(STATE_DIR, file), 'utf-8'));
      return { id: file.replace('state_', '').replace('.json', ''), ...state };
    });
  } catch { return []; }
}

function formatStats(states) {
  if (states.length === 0) return '❌ Belum ada data\\. Miner belum berjalan\\.';
  let text = '📊 *Mining Stats*\n';
  text += `🕐 ${escape(new Date().toLocaleString('id-ID'))}\n`;
  text += '━━━━━━━━━━━━━━━━━━\n\n';
  let tP = 0, tV = 0, tT = 0;
  states.forEach(s => {
    const p = s.total_peanut || 0, v = s.total_vcus || 0, t = s.total_tasks || 0;
    const last = s.last_activity ? escape(new Date(s.last_activity).toLocaleString('id-ID')) : 'N/A';
    tP += p; tV += v; tT += t;
    text += `👤 *${escape(s.id)}*\n`;
    text += `💰 \\$PEANUT: \`${escape(p.toLocaleString())}\`\n`;
    text += `⚡ VCUs: \`${escape(v.toLocaleString())}\`\n`;
    text += `✅ Tasks: \`${escape(t.toLocaleString())}\`\n`;
    text += `🕐 Last: ${last}\n\n`;
  });
  if (states.length > 1) {
    text += '━━━━━━━━━━━━━━━━━━\n';
    text += `📦 *Total ${states.length} Akun*\n`;
    text += `💰 \\$PEANUT: \`${escape(tP.toLocaleString())}\`\n`;
    text += `⚡ VCUs: \`${escape(tV.toLocaleString())}\`\n`;
    text += `✅ Tasks: \`${escape(tT.toLocaleString())}\`\n`;
  }
  return text;
}

// ==============================
// COMMANDS
// ==============================
bot.onText(/\/start/, msg => {
  if (!isAuthorized(msg)) return;
  sendMd(
    '🥜 *\\$PEANUT Miner Bot*\n\n' +
    '*Mining*\n/stats \\- Lihat earnings\n/status \\- Cek miner\n/notify \\- Update manual\n\n' +
    '*Akun*\n/addaccount \\- Tambah akun\n/listaccounts \\- Lihat akun\n/removeaccount \\- Hapus akun\n/getkey \\- Ambil private key\n\n' +
    '*Settings*\n/setcompute \\- Ganti CPU\\/GPU\n/setinterval \\- Ganti interval'
  );
});

bot.onText(/\/stats/, msg => {
  if (!isAuthorized(msg)) return;
  sendMd(formatStats(getAllStates()));
});

bot.onText(/\/status/, msg => {
  if (!isAuthorized(msg)) return;
  const states = getAllStates();
  if (states.length === 0) return sendMd('❌ Tidak ada data\\. Miner belum jalan\\.');
  let text = '🔍 *Status Miner*\n\n';
  const now = Date.now();
  states.forEach(s => {
    const diff = Math.floor((now - new Date(s.last_activity || 0).getTime()) / 60000);
    const icon = diff <= 5 ? '🟢' : diff <= 30 ? '🟡' : '🔴';
    const label = diff <= 5 ? 'Aktif' : diff <= 30 ? `Lambat \\(${diff}m\\)` : `Mati \\(${diff}m\\)`;
    text += `${icon} *${escape(s.id)}*: ${label}\n`;
  });
  sendMd(text);
});

bot.onText(/\/notify/, msg => {
  if (!isAuthorized(msg)) return;
  sendMd(formatStats(getAllStates()));
});

bot.onText(/\/help/, msg => {
  if (!isAuthorized(msg)) return;
  sendMd(
    '❓ *Help*\n\n' +
    '/stats \\- Earnings\n/status \\- Status miner\n/notify \\- Update manual\n' +
    '/addaccount \\- Tambah akun\n/listaccounts \\- Lihat akun\n/removeaccount \\- Hapus akun\n' +
    '/getkey \\- Ambil private key agent\n/setcompute \\- Ganti CPU\\/GPU\n/setinterval \\- Ganti interval'
  );
});

bot.onText(/\/addaccount/, msg => {
  if (!isAuthorized(msg)) return;
  sessions[CHAT_ID] = { step: 'add_id' };
  sendMd('➕ *Tambah Akun*\n\nKirim *ID agent* \\(contoh: `yoyok2`\\)\n\n_/cancel untuk batal_');
});

bot.onText(/\/listaccounts/, msg => {
  if (!isAuthorized(msg)) return;
  const config = loadConfig();
  if (!config.accounts.length) return sendMd('📋 Belum ada akun\\. Gunakan /addaccount\\.');
  let text = '📋 *Daftar Akun*\n\n';
  config.accounts.forEach((acc, i) => {
    const sf = path.join(STATE_DIR, `state_${acc.id}.json`);
    const state = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf-8')) : {};
    const w = acc.wallet ? `${acc.wallet.slice(0,8)}\\.\\.\\. ${acc.wallet.slice(-6)}` : 'Belum diset';
    text += `${i+1}\\. ${acc.enabled !== false ? '✅' : '❌'} *${escape(acc.id)}*\n`;
    text += `   💳 \`${w}\`\n`;
    text += `   💰 \\$PEANUT: ${escape((state.total_peanut||0).toLocaleString())}\n\n`;
  });
  sendMd(text);
});

bot.onText(/\/removeaccount/, msg => {
  if (!isAuthorized(msg)) return;
  const config = loadConfig();
  if (!config.accounts.length) return sendMd('❌ Tidak ada akun\\.');
  sessions[CHAT_ID] = { step: 'remove' };
  let text = '❌ *Hapus Akun*\n\nKirim ID akun:\n\n';
  config.accounts.forEach((a, i) => { text += `${i+1}\\. \`${escape(a.id)}\`\n`; });
  text += '\n_/cancel untuk batal_';
  sendMd(text);
});

// /getkey — plain text agar private key tidak error
bot.onText(/\/getkey/, msg => {
  if (!isAuthorized(msg)) return;
  const config = loadConfig();
  if (!config.accounts.length) return sendPlain('❌ Belum ada akun.');
  let found = false;
  config.accounts.forEach(acc => {
    if (acc.private_key && acc.private_key.trim() !== '') {
      found = true;
      sendPlain(
        `🔑 Private Key Agent — ${acc.id}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `⚠️  INI BUKAN private key wallet kamu\n` +
        `✅ Aman disimpan di Railway Variables\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `Railway > Variables > New Variable:\n\n` +
        `Name:\nPEANUT_PRIVATE_KEY_${acc.id}\n\n` +
        `Value (salin semua):\n${acc.private_key}`
      );
    }
  });
  if (!found) sendPlain('⏳ Keypair belum ada. Tunggu miner jalan lalu coba /getkey lagi.');
});

bot.onText(/\/setcompute/, msg => {
  if (!isAuthorized(msg)) return;
  const config = loadConfig();
  bot.sendMessage(CHAT_ID,
    `⚙️ *Compute Capability*\n\nSaat ini: \`${escape(config.settings.compute_capability)}\`\nPilih:`,
    { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: [[{ text: '🖥️ CPU', callback_data: 'set_CPU' }, { text: '🎮 GPU', callback_data: 'set_GPU' }]] } }
  );
});

bot.onText(/\/setinterval/, msg => {
  if (!isAuthorized(msg)) return;
  const config = loadConfig();
  sessions[CHAT_ID] = { step: 'set_interval' };
  sendMd(`⏱️ *Mining Interval*\n\nSaat ini: \`${escape(config.settings.mining_interval_ms.toString())}ms\`\n\nKirim nilai baru \\(min 1000\\):\n_/cancel untuk batal_`);
});

bot.on('callback_query', async query => {
  if (query.message.chat.id.toString() !== CHAT_ID.toString()) return;
  if (query.data.startsWith('set_')) {
    const value = query.data.replace('set_', '');
    const config = loadConfig();
    config.settings.compute_capability = value;
    saveConfig(config);
    bot.answerCallbackQuery(query.id, { text: `Diset ke ${value}` });
    sendMd(`✅ Compute diubah ke \`${escape(value)}\`\n_Restart miner agar berlaku_`);
  }
});

// ==============================
// SESSION HANDLER
// ==============================
bot.on('message', async msg => {
  if (!isAuthorized(msg)) return;
  if (!msg.text || msg.text.startsWith('/')) return;
  const session = sessions[CHAT_ID];
  if (!session) return;
  const text = msg.text.trim();

  if (text === '/cancel') { delete sessions[CHAT_ID]; return sendMd('↩️ Dibatalkan\\.'); }

  if (session.step === 'add_id') {
    sessions[CHAT_ID] = { step: 'add_wallet', id: text };
    return sendMd(`✅ ID: \`${escape(text)}\`\n\nKirim *wallet address*:\n_/cancel untuk batal_`);
  }

  if (session.step === 'add_wallet') {
    const config = loadConfig();
    if (config.accounts.find(a => a.id === session.id)) {
      delete sessions[CHAT_ID];
      return sendMd(`❌ ID \`${escape(session.id)}\` sudah ada\\.`);
    }
    config.accounts.push({ id: session.id, wallet: text, private_key: null, enabled: true, max_vcus_override: null });
    saveConfig(config);
    delete sessions[CHAT_ID];
    return sendMd(`✅ *Akun ditambahkan\\!*\n\n🆔 \`${escape(session.id)}\`\n💳 \`${escape(text.slice(0,8))}\\.\\.\\.\`\n\n_Restart miner agar aktif_`);
  }

  if (session.step === 'remove') {
    const config = loadConfig();
    const idx = config.accounts.findIndex(a => a.id === text);
    if (idx === -1) return sendMd(`❌ \`${escape(text)}\` tidak ditemukan\\. Coba lagi atau /cancel`);
    config.accounts.splice(idx, 1);
    saveConfig(config);
    delete sessions[CHAT_ID];
    return sendMd(`✅ Akun \`${escape(text)}\` dihapus\\.`);
  }

  if (session.step === 'set_interval') {
    const val = parseInt(text);
    if (isNaN(val) || val < 1000) return sendMd('❌ Minimal `1000`ms\\. Coba lagi:');
    const config = loadConfig();
    config.settings.mining_interval_ms = val;
    saveConfig(config);
    delete sessions[CHAT_ID];
    return sendMd(`✅ Interval diubah ke \`${escape(val.toString())}ms\`\n_Restart miner agar berlaku_`);
  }
});

// ==============================
// AUTO NOTIFIKASI
// ==============================
let lastCounts = {};

setInterval(() => {
  const states = getAllStates();
  if (states.length > 0) sendMd(formatStats(states));
}, NOTIFY_INTERVAL_MS);

setInterval(() => {
  const states = getAllStates();
  let changed = false;
  states.forEach(s => {
    const prev = lastCounts[s.id] || 0;
    const curr = s.total_tasks || 0;
    if (curr - prev >= TASK_NOTIFY_EVERY) { changed = true; lastCounts[s.id] = curr; }
  });
  if (changed) sendMd(`🎯 *Milestone\\!*\n\n${formatStats(getAllStates()).replace('📊 *Mining Stats*\n', '')}`);
}, 60000);

// Startup
bot.sendMessage(CHAT_ID,
  '🥜 *\\$PEANUT Miner Bot aktif\\!*\n\n' +
  `🔔 Auto notif: *${escape((NOTIFY_INTERVAL_MS/60000).toString())} menit*\n` +
  `📊 Milestone: *${escape(TASK_NOTIFY_EVERY.toString())} tasks*\n\n` +
  'Ketik /start untuk menu',
  { parse_mode: 'MarkdownV2' }
).catch(err => console.error('Startup error:', err.message));

console.log('🤖 Telegram bot started');
