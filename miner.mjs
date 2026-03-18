#!/usr/bin/env node

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

config();
const fetch = (await import('node-fetch')).default;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_URL = (process.env.PEANUT_API_BASE || 'https://wrcenmardnbprfpqhrqe.supabase.co/functions/v1/peanut-mining').trim();
const CONFIG_FILE = path.join(__dirname, 'accounts.json');
const STATE_DIR = path.join(__dirname, 'states');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// ==============================
// CONFIG
// ==============================
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (Array.isArray(data.accounts) && data.accounts.length > 0) return data;
    }
  } catch (err) {
    console.log(`⚠️ Config load error: ${err.message}`);
  }
  const defaultConfig = {
    settings: {
      compute_capability: 'CPU',
      max_vcus: 1000,
      mining_interval_ms: 2000,
      max_consecutive_failures: 10,
      retry_delay_ms: 5000
    },
    accounts: [{
      id: process.env.PEANUT_AGENT_ID || 'agent_1',
      wallet: process.env.PEANUT_WALLET || '',
      private_key: null,
      enabled: true,
      max_vcus_override: null
    }]
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2), 'utf-8');
  console.log(`📝 Default config created at: ${CONFIG_FILE}`);
  return defaultConfig;
}

function saveConfig(config) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8'); return true; }
  catch (err) { console.log(`❌ Config save error: ${err.message}`); return false; }
}

// ==============================
// STATE
// ==============================
function loadState(agentId) {
  const f = path.join(STATE_DIR, `state_${agentId}.json`);
  try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8')); }
  catch {}
  return { registered: false, total_vcus: 0, total_peanut: 0, total_tasks: 0, last_registered_key: null, last_activity: null };
}

function saveState(agentId, state) {
  const f = path.join(STATE_DIR, `state_${agentId}.json`);
  try { state.last_activity = new Date().toISOString(); fs.writeFileSync(f, JSON.stringify(state, null, 2), 'utf-8'); }
  catch (err) { log(`State save error: ${err.message}`, agentId, 'ERROR'); }
}

// ==============================
// LOGGING
// ==============================
function log(msg, agentId = null, level = 'INFO') {
  const ts = new Date().toLocaleString('id-ID', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const prefix = agentId ? `[${agentId}] ` : '';
  console.log(`[${ts}] [${level}] ${prefix}${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ==============================
// CRYPTO
// ==============================
function generateKeypair() {
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubHex = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
    const privHex = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
    const rawPub = pubHex.length >= 64 ? pubHex.slice(-64) : pubHex;
    return { publicKey: rawPub, privateKey: privHex };
  } catch (err) {
    log(`Keypair generation error: ${err.message}`, null, 'ERROR');
    return null;
  }
}

function getPublicKeyFromPrivate(privHex) {
  const privKey = crypto.createPrivateKey({ key: Buffer.from(privHex, 'hex'), format: 'der', type: 'pkcs8' });
  const pubKey = crypto.createPublicKey(privKey);
  const pubHex = pubKey.export({ type: 'spki', format: 'der' }).toString('hex');
  return pubHex.length >= 64 ? pubHex.slice(-64) : pubHex;
}

function signMessage(privHex, message) {
  try {
    const privKey = crypto.createPrivateKey({ key: Buffer.from(privHex, 'hex'), format: 'der', type: 'pkcs8' });
    return crypto.sign(null, Buffer.from(message, 'utf-8'), privKey).toString('hex');
  } catch (err) {
    log(`Sign error: ${err.message}`, null, 'ERROR');
    return null;
  }
}

function solveHashChallenge(payload, difficulty, maxIterations = 10000000) {
  const target = '0'.repeat(difficulty);
  for (let nonce = 0; nonce < maxIterations; nonce++) {
    const hash = crypto.createHash('sha256').update(`${payload}${nonce}`).digest('hex');
    if (hash.startsWith(target)) return { nonce, hash };
  }
  return null;
}

// ==============================
// API — sesuai docs resmi minepeanut.com
// ==============================
async function apiRegister(agentId, publicKey, computeCapability, maxVcus) {
  // Sesuai docs resmi: TIDAK mengirim wallet saat register
  const resp = await fetch(`${BASE_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      public_key: publicKey,
      compute_capability: computeCapability,
      max_vcus: maxVcus
    }),
    signal: AbortSignal.timeout(15000)
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (resp.status === 200) return { success: true, data };
  throw new Error(`Register failed (${resp.status}): ${JSON.stringify(data)}`);
}

async function apiFetchTask() {
  const resp = await fetch(`${BASE_URL}/tasks/current`, {
    method: 'GET',
    signal: AbortSignal.timeout(15000)
  });
  if (resp.status === 200) return await resp.json();
  throw new Error(`Fetch task failed (${resp.status}): ${await resp.text()}`);
}

async function apiSubmit(agentId, taskId, solution, signature, computeTimeMs) {
  const resp = await fetch(`${BASE_URL}/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: agentId,
      task_id: taskId,
      solution: solution,
      signature: signature,
      compute_time_ms: computeTimeMs
    }),
    signal: AbortSignal.timeout(15000)
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (resp.status === 200) return { success: true, data };
  // Duplicate submission = sukses
  if (data?.error && (data.error.toLowerCase().includes('duplicate') || text.toLowerCase().includes('duplicate'))) {
    return { success: true, data: { vcus_credited: 1, peanut_earned: 500, duplicate: true } };
  }
  if (data?.error?.toLowerCase?.()?.includes('not registered')) {
    return { success: false, error: 'AGENT_NOT_REGISTERED', data };
  }
  throw new Error(`Submit failed (${resp.status}): ${JSON.stringify(data)}`);
}

// ==============================
// RETRY HELPER
// ==============================
async function withRetry(fn, maxRetries = 5, baseDelay = 3000, label = '', agentId = null) {
  let lastErr;
  for (let i = 1; i <= maxRetries; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      log(`⚠️ ${label} failed (${i}/${maxRetries}): ${err.message}`, agentId, 'WARN');
      if (i < maxRetries) await sleep(baseDelay * i);
    }
  }
  throw lastErr;
}

// ==============================
// MINER LOOP
// ==============================
async function runAgent(account, config) {
  const agentId = account.id;
  const settings = { ...config.settings };
  const maxVcus = account.max_vcus_override || settings.max_vcus;

  log('='.repeat(50), agentId);
  log(`🚀 Starting agent: ${agentId}`, agentId);
  log(`💳 Wallet: ${account.wallet || 'Not set'}`, agentId);
  log('='.repeat(50), agentId);

  let state = loadState(agentId);

  // Setup keypair
  let privKey = account.private_key && account.private_key.trim() !== '' ? account.private_key : null;
  let pubKey = null;

  if (!privKey) {
    log(`🔑 Generating new ED25519 keypair...`, agentId);
    const kp = generateKeypair();
    if (!kp) { log(`❌ Failed to generate keypair`, agentId, 'ERROR'); return; }
    pubKey = kp.publicKey;
    privKey = kp.privateKey;
    account.private_key = privKey;
    saveConfig(config);
    log(`💾 Keypair saved`, agentId);
  } else {
    try {
      pubKey = getPublicKeyFromPrivate(privKey);
      log(`🔑 Using existing keypair`, agentId);
    } catch (err) {
      log(`❌ Invalid private key, generating new one...`, agentId, 'WARN');
      const kp = generateKeypair();
      if (!kp) { log(`❌ Failed to generate keypair`, agentId, 'ERROR'); return; }
      pubKey = kp.publicKey;
      privKey = kp.privateKey;
      account.private_key = privKey;
      saveConfig(config);
    }
  }

  log(`🔓 Public Key: ${pubKey.slice(0, 32)}...`, agentId);

  // Register agent
  const keyChanged = state.last_registered_key && state.last_registered_key !== pubKey;
  if (!state.registered || keyChanged || process.env.FORCE_REGISTER === 'true') {
    try {
      log(`📡 Registering agent...`, agentId);
      const { data } = await withRetry(
        () => apiRegister(agentId, pubKey, settings.compute_capability, maxVcus),
        5, 3000, 'Register', agentId
      );
      state.registered = true;
      state.last_registered_key = pubKey;
      saveState(agentId, state);
      log(`✅ Registered! Epoch: ${data.epoch_start || data.epoch || 'N/A'}`, agentId);
    } catch (err) {
      log(`❌ Registration failed: ${err.message}`, agentId, 'ERROR');
      log(`⚠️ Continuing anyway — will retry on submit error`, agentId, 'WARN');
    }
  } else {
    log(`✅ Agent already registered`, agentId);
  }

  // Mining loop
  let submitCount = 0;
  let consecutiveFailures = 0;
  let needReRegister = false;

  while (true) {
    // Re-register jika diperlukan
    if (needReRegister) {
      try {
        log(`🔄 Re-registering...`, agentId);
        await withRetry(() => apiRegister(agentId, pubKey, settings.compute_capability, maxVcus), 5, 3000, 'Re-register', agentId);
        state.registered = true;
        state.last_registered_key = pubKey;
        saveState(agentId, state);
        log(`✅ Re-registration successful`, agentId);
        needReRegister = false;
      } catch (err) {
        log(`❌ Re-register failed: ${err.message}`, agentId, 'ERROR');
        await sleep(10000);
        continue;
      }
    }

    try {
      // Fetch task
      const task = await withRetry(() => apiFetchTask(), 3, 3000, 'FetchTask', agentId)
        .catch(() => null);
      if (!task) {
        await sleep(settings.mining_interval_ms);
        consecutiveFailures++;
        continue;
      }

      const difficulty = task.difficulty || 3;
      const payload = task.payload || '';
      log(`🔨 Solving ${task.task_id} (diff=${difficulty})`, agentId);

      // Solve
      const start = Date.now();
      const solution = solveHashChallenge(payload, difficulty);
      if (!solution) { consecutiveFailures++; continue; }
      const computeTime = Date.now() - start;

      // Sign
      const solutionJson = JSON.stringify({ nonce: solution.nonce, hash: solution.hash });
      const signature = signMessage(privKey, `${task.task_id}:${solutionJson}`);
      if (!signature) { consecutiveFailures++; continue; }

      log(`✅ Solved: nonce=${solution.nonce}, hash=${solution.hash.slice(0,16)}..., time=${computeTime}ms`, agentId);

      // Submit
      const result = await withRetry(
        () => apiSubmit(agentId, task.task_id, solutionJson, signature, computeTime),
        3, 3000, 'Submit', agentId
      ).catch(err => ({ success: false, error: err.message }));

      if (result.success) {
        const { vcus_credited = 0, peanut_earned = 0, duplicate = false } = result.data;
        if (duplicate) {
          log(`🔁 Duplicate — counted as success`, agentId);
        } else {
          log(`💰 SUBMITTED! VCUs: +${vcus_credited} | $PEANUT: +${peanut_earned.toLocaleString()}`, agentId);
        }
        state.total_vcus += vcus_credited;
        state.total_peanut += peanut_earned;
        state.total_tasks = (state.total_tasks || 0) + 1;
        saveState(agentId, state);
        submitCount++;
        consecutiveFailures = 0;
        if (submitCount % 10 === 0) {
          log(`📊 Stats: VCUs=${state.total_vcus.toLocaleString()} | $PEANUT=${state.total_peanut.toLocaleString()} | Tasks=${state.total_tasks}`, agentId);
        }
      } else {
        if (result.error === 'AGENT_NOT_REGISTERED') {
          log(`⚠️ Not registered — will re-register`, agentId, 'WARN');
          needReRegister = true;
          state.registered = false;
          saveState(agentId, state);
        } else {
          consecutiveFailures++;
          if (consecutiveFailures >= settings.max_consecutive_failures) {
            consecutiveFailures = 0;
            await sleep(settings.retry_delay_ms);
          }
        }
      }
    } catch (err) {
      log(`❌ Error: ${err.message}`, agentId, 'ERROR');
      consecutiveFailures++;
      await sleep(settings.retry_delay_ms);
    }

    await sleep(settings.mining_interval_ms);
  }
}

// ==============================
// MAIN
// ==============================
async function main() {
  console.log('🥜 $PEANUT Mining Agent');
  console.log('='.repeat(60));

  const config = loadConfig();
  const enabled = config.accounts.filter(a => a.enabled !== false);

  console.log(`📦 Accounts: ${enabled.length}`);
  console.log(`⚙️  Compute: ${config.settings.compute_capability} | Interval: ${config.settings.mining_interval_ms}ms`);
  console.log('='.repeat(60));

  if (enabled.length === 0) {
    console.log('❌ No enabled accounts. Edit accounts.json.');
    return;
  }

  for (const account of enabled) {
    if (!account.wallet || account.wallet.trim() === '') {
      console.log(`⚠️ Skipping "${account.id}" — no wallet set`);
      continue;
    }
    await runAgent(account, config);
  }
}

// Graceful shutdown
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
  process.on(sig, () => { console.log(`\n👋 ${sig} received, shutting down...`); process.exit(0); });
});

main().catch(err => { console.log(`❌ Fatal: ${err.message}`); process.exit(1); });
