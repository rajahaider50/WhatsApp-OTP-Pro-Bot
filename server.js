/**
 * WhatsApp OTP Pro Gateway v2.0
 * Multi-Bot WhatsApp Architecture with Pairing Code & QR Support
 * Direct Messenger, API Key Auth, Express REST APIs, Dynamic Settings
 */

import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const APP_NAME = 'OTP Bot Pro'
const VERSION  = '2.0.0'

// ======================= ANSI Colors =======================
const col = {
  g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,
  c: s => `\x1b[36m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`
}

const clock = () => new Date().toTimeString().slice(0,8)
const log   = (...a) => { const s=`${clock()} ${a.join(' ')}`; push('info',s); console.log(col.g(s)) }
const warn  = (...a) => { const s=`${clock()} WARN ${a.join(' ')}`; push('warn',s); console.log(col.y(s)) }

function banner(title, code, hint='') {
  const pad = 44
  const line = '═'.repeat(pad)
  console.log(col.y(`\n╔${line}╗`))
  console.log(col.y(`║  ${title.padEnd(pad-2)}║`))
  console.log(col.y(`╠${line}╣`))
  console.log(col.y(`║  ${col.b(code).padEnd(pad+7)}║`))
  if (hint) console.log(col.y(`║  ${col.dim(hint).padEnd(pad+7)}║`))
  console.log(col.y(`╚${line}╝\n`))
}

// ======================= Paths & Directories =======================
const DATA_DIR     = process.env.DATA_DIR || __dirname
const AUTH_DIR     = path.join(DATA_DIR, 'auth')
const CONFIG_FILE  = path.join(DATA_DIR, 'config.json')
const BOTS_FILE    = path.join(DATA_DIR, 'bots.json')
const APIKEYS_FILE = path.join(DATA_DIR, 'apikeys.json')
const DAILY_FILE   = path.join(DATA_DIR, 'daily.json')
const OTPS_FILE    = path.join(DATA_DIR, 'otps.json')
const LOCK_FILE    = path.join(DATA_DIR, '.lock')
const FIXED_URL    = path.join(DATA_DIR, 'public_url.txt')
const TUNNEL_URL   = path.join(__dirname, '.tunnel_url')

try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
try { fs.mkdirSync(AUTH_DIR, { recursive: true }) } catch {}

function writeCodeFile(name, text) {
  try { fs.writeFileSync(path.join(DATA_DIR, name), text, { mode: 0o600 }) } catch {}
}
function removeCodeFile(name) {
  try { fs.unlinkSync(path.join(DATA_DIR, name)) } catch {}
}

// ======================= In-Memory Logs & Errors =======================
const ring   = []
const errors = []
function push(level, text) {
  ring.push({ t: Date.now(), l: level, m: text })
  if (ring.length > 300) ring.shift()
}

const HINTS = [
  [/rate-overlimit|429/, 'WhatsApp rate limit hit. Wait 10-15 minutes or add another bot.'],
  [/Connection Failure|timed out|ENOTFOUND|EAI_AGAIN/, 'Network / DNS issue. Check your internet or server connection.'],
  [/401|loggedOut|not-authorized/, 'Session logged out from phone. Click "New Pairing Code" from Admin.'],
  [/bot not ready/, 'No linked WhatsApp account is ready. Link a bot from Admin > WhatsApp Bots.'],
  [/restartRequired|515/, 'Normal WhatsApp companion registration handshake. Reconnecting automatically.'],
]
const hintFor = m => (HINTS.find(([re]) => re.test(m)) || [])[1] || ''

function recordError(where, e, src) {
  const msg    = String(e?.message || e).slice(0, 300)
  const source = src || (e?.stack ? e.stack.split('\n')[1]?.trim() : '(runtime)')
  const last   = errors[errors.length - 1]
  if (last && last.msg === msg && last.where === where) {
    last.count++
    last.t = clock()
    return
  }
  errors.push({ t: clock(), where, src: source, msg, hint: hintFor(msg), count: 1 })
  if (errors.length > 100) errors.shift()
  push('error', `[${where}] ${msg}`)
  console.log(col.r(`${clock()} ERROR [${where}] ${msg}`))
}
process.on('unhandledRejection', e => recordError('unhandledRejection', e))
process.on('uncaughtException',  e => recordError('uncaughtException', e))

// ======================= Configuration =======================
const DEFAULT_MSG = `🔐 *Your Verification Code*

┌─────────────────────┐
│      *{OTP}*        │
└─────────────────────┘

⏱ Valid for *{MINUTES} minutes*
🔒 Keep this code private

_Tap code to copy_`

const DEFAULTS = {
  port: 3000,
  signupEnabled: true,
  restrictToAllowed: false,
  allowedNumbers: [],
  warmupSec: 10,
  otpTtlSec: 300,
  cooldownSec: 60,
  maxPerHour: 40,
  ipLimitPerHour: 15,
  dailyLimit: 1000,
  tunnelWatchdog: true,
  message: DEFAULT_MSG
}

let CFG = { ...DEFAULTS }
try { CFG = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } } catch {}
const saveConfig = () => {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CFG, null, 2)) } catch(e) { recordError('config', e) }
}
saveConfig()

const PORT           = Number(process.env.SERVER_PORT || process.env.PORT || CFG.port) || 3000
const HOST           = process.env.HOST || '0.0.0.0'
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '')
const passwordEnabled= ADMIN_PASSWORD.length >= 8
const MAX_ATTEMPTS   = 5

// ======================= Number Normalization =======================
/**
 * Normalizes phone numbers strictly.
 * Pakistani numbers starting with 3 (10 digits) or 03 (11 digits) or 9203 (13 digits)
 * are cleanly mapped to '923XXXXXXXXX' (12 digits, E.164 without leading +).
 */
function normalize(input) {
  let n = String(input || '').replace(/\D/g, '')
  if (n.startsWith('00')) n = n.slice(2)
  if (n.startsWith('920')) n = '92' + n.slice(3)
  else if (n.startsWith('0') && n.length === 11) n = '92' + n.slice(1)
  else if (n.startsWith('3') && n.length === 10) n = '92' + n
  else if (n.length === 10 && !n.startsWith('92')) n = '92' + n
  return n
}

const allowedSet = () => new Set((CFG.allowedNumbers || []).map(normalize))
const mask       = n => n.slice(0, 5) + '*****' + n.slice(-2)
const sleep      = ms => new Promise(r => setTimeout(r, ms))
const rand       = (a, b) => a + Math.random() * (b - a)

// ======================= Process Lock =======================
try {
  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = Number(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (oldPid && oldPid !== process.pid) {
      let isAlive = true
      try { process.kill(oldPid, 0) } catch { isAlive = false }
      if (!isAlive) fs.unlinkSync(LOCK_FILE)
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid))
} catch {}
const cleanLock = () => { try { if (Number(fs.readFileSync(LOCK_FILE, 'utf8')) === process.pid) fs.unlinkSync(LOCK_FILE) } catch {} }
process.on('exit', cleanLock)
process.on('SIGINT',  () => { cleanLock(); process.exit(0) })
process.on('SIGTERM', () => { cleanLock(); process.exit(0) })

// ======================= Tunnel Detection =======================
const currentTunnelUrl = () => {
  for (const f of [FIXED_URL, TUNNEL_URL]) {
    try { const u = fs.readFileSync(f, 'utf8').trim(); if (u && /^https?:\/\//.test(u)) return u } catch {}
  }
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.trim()
  return ''
}
let publicOk = false, publicCheckedAt = 0
async function checkPublic() {
  const u = currentTunnelUrl()
  if (!u) { publicOk = false; return }
  try {
    const res = await fetch(`${u}/health`, { signal: AbortSignal.timeout(5000) })
    publicOk = res.ok
  } catch { publicOk = false }
  publicCheckedAt = Date.now()
}
setInterval(checkPublic, 30_000)
setTimeout(checkPublic, 3_000)

// ======================= API Keys Management =======================
let apiKeys = []
function loadApiKeys() {
  try {
    apiKeys = JSON.parse(fs.readFileSync(APIKEYS_FILE, 'utf8'))
  } catch {
    // Generate default key if none exists
    const defKey = '3ced2f73b6e9c74f4e17c77018f4bde1ea11947af9d0c61e5d883fa9297091a0'
    apiKeys = [{
      id: 'k_primary',
      key: defKey,
      label: 'Default App Key',
      createdAt: Date.now(),
      enabled: true,
      dailyLimit: 0, // unlimited
      usedToday: 0,
      lastUsedDate: ''
    }]
    saveApiKeys()
  }
}
function saveApiKeys() {
  try { fs.writeFileSync(APIKEYS_FILE, JSON.stringify(apiKeys, null, 2)) } catch(e) { recordError('apikeys', e) }
}
loadApiKeys()

function apiKeyAuth(req, res, next) {
  const headerKey = req.headers['x-api-key'] || req.query.api_key
  if (!headerKey) return res.status(401).json({ ok: false, error: 'Missing x-api-key header or api_key query param.' })
  const found = apiKeys.find(k => k.key === headerKey && k.enabled)
  if (!found) return res.status(403).json({ ok: false, error: 'Invalid or disabled API key.' })

  const today = new Date().toISOString().split('T')[0]
  if (found.lastUsedDate !== today) {
    found.usedToday = 0
    found.lastUsedDate = today
  }
  if (found.dailyLimit > 0 && found.usedToday >= found.dailyLimit) {
    return res.status(429).json({ ok: false, error: `Daily limit of ${found.dailyLimit} reached for this API key.` })
  }
  req.apiKey = found
  next()
}

// ======================= Daily Global Counter =======================
let dailyGlobal = { date: '', count: 0 }
try { dailyGlobal = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8')) } catch {}
function checkDailyReset() {
  const today = new Date().toISOString().split('T')[0]
  if (dailyGlobal.date !== today) {
    dailyGlobal = { date: today, count: 0 }
    try { fs.writeFileSync(DAILY_FILE, JSON.stringify(dailyGlobal)) } catch {}
  }
}
checkDailyReset()

// ======================= Global Stats & Tracking =======================
const globalStats = { requested: 0, accepted: 0, delivered: 0, undelivered: 0, failed: 0, verified: 0 }
const sends       = new Map() // msgId -> { to, status, at, botId }
const sentCache   = new Map()
const lateIds     = new Set()
const waiters     = new Map()
const STATUS      = { 1: 'pending', 2: 'server_ack', 3: 'delivered', 4: 'read', 5: 'played' }

function trackMsg(id, st, botId) {
  const r = sends.get(id)
  if (!r) return
  if (st > r.status) {
    r.status = st
    log(`Message ${id.slice(0, 6)} -> ${STATUS[st] || st}`)
  }
  if (st >= 3 && lateIds.has(id)) {
    lateIds.delete(id)
    globalStats.undelivered = Math.max(0, globalStats.undelivered - 1)
    globalStats.delivered++
    const b = bots.get(botId || r.botId)
    if (b) { b.stats.undelivered = Math.max(0, b.stats.undelivered - 1); b.stats.delivered++ }
  }
  if (st >= 3) {
    const w = waiters.get(id)
    if (w) { w(true); waiters.delete(id) }
  }
}

function waitDelivered(id, ms) {
  return new Promise(res => {
    if ((sends.get(id)?.status || 0) >= 3) return res(true)
    waiters.set(id, res)
    setTimeout(() => { waiters.delete(id); res(false) }, ms)
  })
}

function trackDelivery(id, botId) {
  waitDelivered(id, 90_000).then(ok => {
    if (ok) {
      globalStats.delivered++
      const b = bots.get(botId)
      if (b) b.stats.delivered++
      return
    }
    globalStats.undelivered++
    lateIds.add(id)
    const b = bots.get(botId)
    if (b) b.stats.undelivered++
    warn(`No delivery receipt after 90s (msg ${id.slice(0, 6)})`)
  })
}

// ======================= Multi-Bot WhatsApp Architecture =======================
const bots       = new Map() // botId -> botState
let botsConfig   = []

try {
  botsConfig = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'))
} catch {
  const defNumber = process.env.BOT_NUMBER ? normalize(process.env.BOT_NUMBER) : '923495031007'
  botsConfig = [{ id: 'bot0', label: 'Main WhatsApp', enabled: true, botNumber: defNumber }]
  try { fs.writeFileSync(BOTS_FILE, JSON.stringify(botsConfig, null, 2)) } catch {}
}

const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket
const { useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion, fetchLatestBaileysVersion, Browsers } = baileys
const reasonName = c => Object.entries(DisconnectReason).find(([, v]) => v === c)?.[0] || String(c || 'unknown')

function initBotState(cfg) {
  const state = {
    id: cfg.id,
    label: cfg.label || cfg.id,
    enabled: cfg.enabled !== false,
    botNumber: normalize(cfg.botNumber || ''),
    sock: null,
    status: 'idle',
    ready: false,
    lastQr: null,
    pairCode: null,
    lastError: null,
    linkMode: cfg.linkMode || (cfg.botNumber ? 'pair' : 'qr'),
    pairRequested: false,
    lastPairTime: 0,
    reconnectTimer: null,
    freshLink: false,
    openedAt: 0,
    history: [],
    dailySent: { date: '', count: 0 },
    stats: { requested: 0, accepted: 0, delivered: 0, undelivered: 0, failed: 0 },
    chain: Promise.resolve()
  }
  bots.set(cfg.id, state)
  return state
}

function saveBotsConfig() {
  const arr = []
  for (const bot of bots.values()) {
    arr.push({ id: bot.id, label: bot.label, enabled: bot.enabled, botNumber: normalize(bot.botNumber), linkMode: bot.linkMode })
  }
  try { fs.writeFileSync(BOTS_FILE, JSON.stringify(arr, null, 2)) } catch {}
}

async function startBot(botId) {
  const bot = bots.get(botId)
  if (!bot || !bot.enabled) return
  clearTimeout(bot.reconnectTimer)

  if (bot.sock) {
    try { bot.sock.ev.removeAllListeners() } catch {}
    try { bot.sock.end?.(undefined) } catch {}
    bot.sock = null
  }

  const botAuthDir = path.join(AUTH_DIR, botId)
  try { fs.mkdirSync(botAuthDir, { recursive: true }) } catch {}

  const credsFile = path.join(botAuthDir, 'creds.json')
  const isLinked = () => {
    try {
      const c = JSON.parse(fs.readFileSync(credsFile, 'utf8'))
      return !!(c.registered || c.account)
    } catch { return false }
  }

  // Fetch latest WhatsApp Web version to ensure compatibility
  let version = [2, 3000, 1049299156]
  try {
    const vInfo = await fetchLatestWaWebVersion()
    if (vInfo?.version) version = vInfo.version
  } catch {
    try {
      const bInfo = await fetchLatestBaileysVersion()
      if (bInfo?.version) version = bInfo.version
    } catch {}
  }

  // Multi-file auth state without wrapping in caching signal stores during registration
  const { state, saveCreds } = await useMultiFileAuthState(botAuthDir)

  // Use Windows Chrome profile for stable companion pairing
  const s = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: Browsers.windows('Chrome'),
    qrTimeout: 120_000,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    getMessage: async key => sentCache.get(key?.id)
  })

  bot.sock   = s
  bot.status = 'starting'
  log(`Bot ${botId} ("${bot.label}"): initializing connection socket...`)

  // Intercept WebSocket IQ error stanzas (e.g. 429 rate-overlimit on pairing)
  try {
    s.ws?.on?.('CB:iq,type:error', frame => {
      const errTag = Array.isArray(frame?.content) ? frame.content[0] : null
      const errCode = errTag?.attrs?.code
      const errText = errTag?.attrs?.text
      warn(`Bot ${botId} WhatsApp server IQ error: code=${errCode} text=${errText}`)
      if (errCode === '429' || errText === 'rate-overlimit') {
        bot.pairCode = null
        bot.lastError = 'WhatsApp pairing rate limit (429: rate-overlimit). Too many pairing requests for this number. Scan the QR code with phone camera to connect immediately!'
      }
    })
  } catch {}

  s.ev.on('creds.update', async () => {
    try { await saveCreds() } catch(err) { warn(`Bot ${botId} saveCreds:`, err.message) }
  })

  s.ev.on('messages.update', ups => {
    for (const { key, update } of ups) {
      if (key?.fromMe && update?.status != null) trackMsg(key.id, update.status, botId)
    }
  })

  s.ev.on('message-receipt.update', ups => {
    for (const { key, receipt } of ups) {
      if (!key?.fromMe) continue
      if (receipt?.readTimestamp) trackMsg(key.id, 4, botId)
      else if (receipt?.receiptTimestamp) trackMsg(key.id, 3, botId)
    }
  })

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s !== bot.sock) return

    if (qr) {
      bot.status = 'qr'
      bot.ready  = false
      if (!state.creds.registered) bot.freshLink = true
      try { bot.lastQr = await qrcode.toDataURL(qr) } catch {}
      if (bot.linkMode === 'qr') qrcodeTerminal.generate(qr, { small: true })

      // Handle pairing code with 2500ms delay & 60s cooldown to avoid rate-overlimit
      const cleanNum = normalize(bot.botNumber)
      const now = Date.now()
      const canRequestPair = bot.linkMode === 'pair' && 
                             cleanNum && 
                             cleanNum.length >= 10 && 
                             !state.creds.registered && 
                             !bot.pairRequested &&
                             (now - (bot.lastPairTime || 0) > 60000)

      if (canRequestPair) {
        bot.pairRequested = true
        bot.lastPairTime = now
        setTimeout(async () => {
          if (s !== bot.sock || state.creds.registered) return
          try {
            log(`Bot ${botId} ("${bot.label}"): Requesting WhatsApp pairing code for +${cleanNum}...`)
            const code = await s.requestPairingCode(cleanNum)
            if (s === bot.sock && !state.creds.registered) {
              bot.pairCode = code
              bot.lastError = null
              log(`Bot ${botId} PAIRING CODE: ${code}`)
              banner(`PAIRING CODE (${bot.label})`, code, 'WhatsApp > Linked devices > Link with phone number')
              writeCodeFile(`PAIRING-${botId}.txt`, `PAIRING CODE: ${code}\nPhone: +${cleanNum}\nWhatsApp > Linked devices > Link with phone number`)
            }
          } catch(e) {
            const emsg = e?.message || String(e)
            bot.pairRequested = false
            bot.lastError = 'Pairing error: ' + emsg
            recordError('pairing-' + botId, e)
            warn(`Bot ${botId} pairing error:`, emsg)
          }
        }, 2500)
      }
    }

    if (connection === 'open') {
      bot.status = 'open'
      bot.lastQr = null
      bot.pairCode = null
      bot.pairRequested = false
      bot.lastError = null
      bot.openedAt = Date.now()
      bot.history.push({ connectedAt: bot.openedAt, disconnectedAt: null, durationSec: 0, reason: null })
      if (bot.history.length > 20) bot.history.shift()
      removeCodeFile(`PAIRING-${botId}.txt`)

      const wait = bot.freshLink ? CFG.warmupSec : 2
      log(`Bot ${botId} ("${bot.label}"): Connected as ${s.user?.id || '?'} - ready in ${wait}s`)
      setTimeout(() => {
        if (s === bot.sock && bot.status === 'open') {
          bot.ready = true
          bot.freshLink = false
          log(`Bot ${botId} ("${bot.label}"): Ready for messages! 🟢`)
        }
      }, wait * 1000)
    }

    if (connection === 'close') {
      bot.ready = false
      const code = lastDisconnect?.error?.output?.statusCode
      const up = bot.openedAt ? Math.round((Date.now() - bot.openedAt) / 1000) : 0
      const hist = bot.history[bot.history.length - 1]
      if (hist && !hist.disconnectedAt) {
        hist.disconnectedAt = Date.now()
        hist.durationSec = up
        hist.reason = reasonName(code) || String(code || 'unknown')
      }
      bot.openedAt = 0
      const emsg = `${reasonName(code)} (${code}) ${lastDisconnect?.error?.message || ''}`
      warn(`Bot ${botId} connection closed: ${emsg} | was up ${up}s`)

      if (code === DisconnectReason.loggedOut) {
        bot.lastQr = null
        bot.pairCode = null
        bot.pairRequested = false
        try { fs.rmSync(botAuthDir, { recursive: true, force: true }) } catch {}
        bot.status = 'loggedout'
        bot.lastError = `WhatsApp ended session (logged out). Click "New Pairing Code" or "QR Code" to link again.`
        // Do NOT reconnect automatically in a loop when logged out to avoid 429 rate limit spam
      } else if (code === DisconnectReason.connectionReplaced) {
        bot.status = 'closed'
        bot.lastError = 'Active on another client (connectionReplaced).'
        bot.reconnectTimer = setTimeout(() => startBot(botId), 15000)
      } else {
        // Normal restart or reconnect required (e.g. 515 restartRequired after pairing)
        bot.status = 'closed'
        const delay = code === DisconnectReason.restartRequired ? 1000 : 4000
        bot.reconnectTimer = setTimeout(() => startBot(botId), delay)
      }
    }
  })
}

function stopBot(botId) {
  const bot = bots.get(botId)
  if (!bot) return
  clearTimeout(bot.reconnectTimer)
  bot.enabled = false
  if (bot.sock) {
    try { bot.sock.ev.removeAllListeners() } catch {}
    try { bot.sock.end?.(undefined) } catch {}
  }
  bot.sock = null
  bot.status = 'idle'
  bot.ready = false
  bot.lastQr = null
  bot.pairCode = null
  saveBotsConfig()
}

function removeBot(botId) {
  stopBot(botId)
  bots.delete(botId)
  botsConfig = botsConfig.filter(b => b.id !== botId)
  saveBotsConfig()
  try { fs.rmSync(path.join(AUTH_DIR, botId), { recursive: true, force: true }) } catch {}
  log(`Bot ${botId} removed`)
}

function addBot(label, botNumber = '', mode = 'pair') {
  const id = 'bot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)
  const cleanNumber = normalize(botNumber)
  const cfg = { id, label: label || 'WhatsApp Bot', enabled: true, botNumber: cleanNumber, linkMode: cleanNumber ? mode : 'qr' }
  botsConfig.push(cfg)
  initBotState(cfg)
  saveBotsConfig()
  startBot(id).catch(e => recordError('startBot', e))
  log(`Bot ${id} added: "${label}" (${cleanNumber ? '+' + cleanNumber : 'QR Mode'})`)
  return id
}

function getBestBot(preferBotId) {
  if (preferBotId) {
    const b = bots.get(preferBotId)
    if (b?.ready && b.status === 'open') return b
  }
  // Load balancing across all ready bots (lowest sent count today)
  const readyBots = [...bots.values()].filter(b => b.ready && b.status === 'open')
  if (!readyBots.length) return null
  readyBots.sort((a, b) => (a.dailySent?.count || 0) - (b.dailySent?.count || 0))
  return readyBots[0]
}

function anyReady() {
  for (const b of bots.values()) if (b.ready && b.status === 'open') return true
  return false
}

function initBots() {
  for (const cfg of botsConfig) initBotState(cfg)
  for (const bot of bots.values()) {
    if (bot.enabled) startBot(bot.id).catch(e => recordError('startBot-' + bot.id, e))
  }
}

// ======================= Message Queue Dispatcher =======================
function sendText(jid, text, preferBotId) {
  const bot = getBestBot(preferBotId)
  if (!bot) return Promise.reject(new Error('No WhatsApp bot is connected and ready. Link an account from Admin > WhatsApp Bots.'))

  let resolveId, rejectId
  const p = new Promise((res, rej) => { resolveId = res; rejectId = rej })

  bot.chain = bot.chain.then(async () => {
    try {
      if (!bot.ready) throw new Error(`Bot ${bot.label} is not ready`)
      try {
        await bot.sock.sendPresenceUpdate('composing', jid)
        await sleep(rand(800, 1800))
        await bot.sock.sendPresenceUpdate('paused', jid)
      } catch {}

      let m
      try {
        m = await bot.sock.sendMessage(jid, { text })
      } catch(e) {
        warn(`Bot ${bot.id} message send retry:`, e.message)
        await sleep(2000)
        if (!bot.ready) throw e
        m = await bot.sock.sendMessage(jid, { text })
      }

      const id = m?.key?.id
      if (!id) throw new Error('No message id returned from WhatsApp')
      sentCache.set(id, m.message)
      sends.set(id, { to: jid.split('@')[0], status: 1, at: Date.now(), botId: bot.id })
      while (sentCache.size > 500) sentCache.delete(sentCache.keys().next().value)
      while (sends.size > 500)     sends.delete(sends.keys().next().value)
      resolveId({ id, botId: bot.id })
    } catch(err) {
      rejectId(err)
    }
    await sleep(rand(1000, 2500))
  })

  return p
}

// ======================= OTP Store & Rate Limiting =======================
const otps = new Map() // number -> { hash, expires, attempts }
try {
  const d = JSON.parse(fs.readFileSync(OTPS_FILE, 'utf8'))
  for (const [k, v] of Object.entries(d)) if (v.expires > Date.now()) otps.set(k, v)
} catch {}
const persistOtps = () => {
  try {
    const o = {}
    for (const [k, v] of otps.entries()) if (v.expires > Date.now()) o[k] = v
    fs.writeFileSync(OTPS_FILE, JSON.stringify(o))
  } catch {}
}

const lastReq = new Map()
const ipHits  = new Map()
const numHits = new Map()
const lastMsg = new Map()

const hash = val => crypto.createHash('sha256').update(String(val)).digest('hex')

// ======================= Admin Session & Auth =======================
const sessions   = new Map()
const loginFails = []
let adminCode    = null
let lastCodeReq  = 0

const safeEq = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a), bb = Buffer.from(b)
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb)
}

function loginBlocked(ip) {
  const t = Date.now()
  const recent = loginFails.filter(f => f.ip === ip && t - f.t < 600_000)
  return recent.length >= 8
}

function adminAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const t = h.replace(/^Bearer /, '').trim()
  if (t && sessions.has(t) && sessions.get(t) > Date.now()) {
    sessions.set(t, Date.now() + 2 * 3600_000) // extend session
    return next()
  }
  res.status(401).json({ ok: false, error: 'Unauthorized admin session' })
}

// ======================= Express HTTP App =======================
const app = express()
app.set('trust proxy', !!process.env.TRUST_PROXY)
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))

// Universal CORS Middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')))

// Health & Status
app.get('/health', (req, res) => res.json({ status: 'ok', name: APP_NAME, version: VERSION, ready: anyReady() }))
app.get('/api/status', (req, res) => res.json({ name: APP_NAME, ready: anyReady(), botCount: bots.size }))

// ======================= OTP Endpoints =======================
async function handleSendOtp(req, res, isV1 = false) {
  checkDailyReset()
  const rawNumber = req.body?.number
  const preferBotId = req.body?.botId
  if (!rawNumber) return res.status(400).json({ ok: false, error: 'Phone number is required.' })

  const number = normalize(rawNumber)
  if (number.length < 10 || number.length > 15) {
    return res.status(400).json({ ok: false, error: 'Invalid phone number format. Must be a valid mobile number.' })
  }

  if (CFG.restrictToAllowed && !allowedSet().has(number)) {
    return res.status(403).json({ ok: false, error: 'Number not allowed in test mode.' })
  }

  // Rate Limiting
  const now = Date.now()
  const prev = lastReq.get(number) || 0
  if (now - prev < CFG.cooldownSec * 1000) {
    const remain = Math.ceil((CFG.cooldownSec * 1000 - (now - prev)) / 1000)
    return res.status(429).json({ ok: false, error: `Please wait ${remain} seconds before requesting another code.` })
  }

  // Daily global limit
  if (CFG.dailyLimit > 0 && dailyGlobal.count >= CFG.dailyLimit) {
    return res.status(429).json({ ok: false, error: 'Daily gateway OTP limit reached.' })
  }

  // IP rate limiting
  const ip = req.ip
  const ipList = (ipHits.get(ip) || []).filter(t => now - t < 3600_000)
  if (ipList.length >= CFG.ipLimitPerHour) {
    return res.status(429).json({ ok: false, error: 'Hourly IP limit reached.' })
  }
  ipList.push(now)
  ipHits.set(ip, ipList)

  // Hourly number limit
  const numList = (numHits.get(number) || []).filter(t => now - t < 3600_000)
  if (numList.length >= CFG.maxPerHour) {
    return res.status(429).json({ ok: false, error: 'Hourly limit for this phone number reached.' })
  }
  numList.push(now)
  numHits.set(number, numList)

  // Generate 6-digit OTP
  const otp = String(crypto.randomInt(100000, 1000000))
  const ttlMin = Math.round(CFG.otpTtlSec / 60)
  const text = CFG.message.replace(/\{OTP\}/g, otp).replace(/\{MINUTES\}/g, String(ttlMin))
  const jid = number + '@s.whatsapp.net'

  otps.set(number, { hash: hash(otp), expires: now + CFG.otpTtlSec * 1000, attempts: 0 })
  persistOtps()
  lastReq.set(number, now)
  globalStats.requested++

  try {
    const { id: msgId, botId: usedBotId } = await sendText(jid, text, preferBotId)
    globalStats.accepted++

    const usedBot = bots.get(usedBotId)
    if (usedBot) {
      usedBot.stats.accepted++
      const today = new Date().toISOString().split('T')[0]
      if (usedBot.dailySent.date !== today) usedBot.dailySent = { date: today, count: 0 }
      usedBot.dailySent.count++
    }
    dailyGlobal.count++
    try { fs.writeFileSync(DAILY_FILE, JSON.stringify(dailyGlobal)) } catch {}

    if (isV1 && req.apiKey) {
      req.apiKey.usedToday++
      saveApiKeys()
    }

    lastMsg.set(number, msgId)
    log(`OTP sent to ${mask(number)} via ${usedBotId} (msg: ${msgId.slice(0, 6)})`)
    trackDelivery(msgId, usedBotId)
    res.json({ ok: true, number, state: 'sent' })
  } catch(err) {
    otps.delete(number)
    persistOtps()
    globalStats.failed++
    recordError('send-otp', err)
    res.status(500).json({ ok: false, error: 'Could not send WhatsApp OTP: ' + err.message })
  }
}

app.post('/api/send-otp',         (req, res) => handleSendOtp(req, res, false))
app.post('/api/v1/send-otp', apiKeyAuth, (req, res) => handleSendOtp(req, res, true))

// Verify OTP
function handleVerifyOtp(req, res) {
  const number = normalize(req.body?.number)
  const otp    = String(req.body?.otp || '').trim()
  const record = otps.get(number)

  if (!record) return res.status(400).json({ ok: false, error: 'Please request a verification code first.' })
  if (Date.now() > record.expires) {
    otps.delete(number)
    persistOtps()
    return res.status(400).json({ ok: false, error: 'Verification code has expired.' })
  }
  if (++record.attempts > MAX_ATTEMPTS) {
    otps.delete(number)
    persistOtps()
    return res.status(429).json({ ok: false, error: 'Too many incorrect attempts.' })
  }
  if (hash(otp) !== record.hash) {
    persistOtps()
    return res.status(400).json({ ok: false, error: 'Invalid verification code.' })
  }

  otps.delete(number)
  persistOtps()
  globalStats.verified++
  res.json({ ok: true, message: 'Phone number verified successfully!' })
}

app.post('/api/verify-otp',         handleVerifyOtp)
app.post('/api/v1/verify-otp', apiKeyAuth, handleVerifyOtp)
app.get('/api/v1/status', apiKeyAuth, (req, res) => res.json({
  ok: true,
  name: APP_NAME,
  version: VERSION,
  ready: anyReady(),
  bots: [...bots.values()].map(b => ({ id: b.id, label: b.label, ready: b.ready, status: b.status }))
}))

// ======================= Admin APIs =======================
app.post('/api/admin/request-code', (req, res) => {
  if (loginBlocked(req.ip)) return res.status(429).json({ ok: false, error: 'Too many login attempts. Please wait 10 minutes.' })
  if (Date.now() - lastCodeReq < 12_000) return res.status(429).json({ ok: false, error: 'Please wait a few seconds before requesting another code.' })
  lastCodeReq = Date.now()

  if (!adminCode || adminCode.expires < Date.now()) {
    adminCode = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + 5 * 60_000 }
  }
  banner('ADMIN VERIFICATION CODE', adminCode.code, 'Valid for 5 minutes')
  writeCodeFile('ADMIN-CODE.txt', `ADMIN VERIFICATION CODE: ${adminCode.code}\nValid until: ${new Date(adminCode.expires).toISOString()}`)
  res.json({ ok: true })
})

app.post('/api/admin/login', (req, res) => {
  if (loginBlocked(req.ip)) return res.status(429).json({ ok: false, error: 'Too many login attempts. Please wait 10 minutes.' })
  const codeValid = adminCode && adminCode.expires >= Date.now()
  if (!codeValid && !passwordEnabled) return res.status(400).json({ ok: false, error: 'Request a verification code first.' })

  const given = String(req.body?.code || '').trim()
  const ok = (codeValid && safeEq(given, adminCode.code)) || (passwordEnabled && safeEq(given, ADMIN_PASSWORD))
  if (!ok) {
    loginFails.push({ ip: req.ip, t: Date.now() })
    return res.status(400).json({ ok: false, error: 'Incorrect verification code or password.' })
  }

  if (codeValid && safeEq(given, adminCode.code)) {
    adminCode = null
    removeCodeFile('ADMIN-CODE.txt')
  }
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, Date.now() + 3 * 3600_000)
  log(`Admin login successful from IP: ${req.ip}`)
  res.json({ ok: true, token })
})

app.post('/api/admin/logout-session', adminAuth, (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '').trim()
  sessions.delete(token)
  res.json({ ok: true })
})

app.get('/api/admin/state', adminAuth, (req, res) => {
  res.json({
    ok: true,
    name: APP_NAME,
    version: VERSION,
    status: anyReady() ? 'open' : 'idle',
    ready: anyReady(),
    bots: [...bots.values()].map(b => ({
      id: b.id,
      label: b.label,
      status: b.status,
      ready: b.ready,
      botNumber: b.botNumber,
      linkMode: b.linkMode,
      qr: b.lastQr,
      pairCode: b.pairCode,
      lastError: b.lastError,
      uptime: b.openedAt ? Math.round((Date.now() - b.openedAt) / 1000) : 0,
      dailySent: b.dailySent,
      stats: b.stats
    })),
    apiKeys: apiKeys.map(k => ({
      id: k.id,
      label: k.label,
      key: k.key.slice(0, 8) + '...' + k.key.slice(-4),
      dailyLimit: k.dailyLimit,
      usedToday: k.usedToday,
      enabled: k.enabled,
      createdAt: k.createdAt
    })),
    stats: globalStats,
    dailyGlobal,
    settings: { ...CFG },
    recent: [...sends.entries()].slice(-12).reverse().map(([id, r]) => ({
      id: id.slice(0, 8),
      to: mask(r.to),
      status: STATUS[r.status] || String(r.status),
      botId: r.botId,
      ageSec: Math.round((Date.now() - r.at) / 1000)
    })),
    publicUrl: currentTunnelUrl(),
    publicOk,
    port: PORT,
    uptime: Math.round(process.uptime())
  })
})

app.get('/api/admin/console', adminAuth, (req, res) => {
  res.json({ ok: true, logs: ring.slice(-100).map(r => r.m), errors: errors.slice().reverse() })
})
app.post('/api/admin/console/clear', adminAuth, (req, res) => {
  errors.length = 0
  res.json({ ok: true })
})

// Bot Management Endpoints
app.post('/api/admin/bots/add', adminAuth, (req, res) => {
  const label = String(req.body?.label || 'WhatsApp Bot').trim()
  const rawNum = req.body?.botNumber || ''
  const botNumber = normalize(rawNum)
  const mode = req.body?.mode === 'qr' ? 'qr' : 'pair'
  const id = addBot(label, botNumber, mode)
  res.json({ ok: true, id, botNumber, mode })
})

app.post('/api/admin/bots/:id/remove', adminAuth, (req, res) => {
  if (!bots.has(req.params.id)) return res.status(404).json({ ok: false, error: 'Bot not found' })
  removeBot(req.params.id)
  res.json({ ok: true })
})

app.post('/api/admin/bots/:id/new-code', adminAuth, async (req, res) => {
  const bot = bots.get(req.params.id)
  if (!bot) return res.status(404).json({ ok: false, error: 'Bot not found' })

  const mode = req.body?.mode === 'qr' ? 'qr' : 'pair'
  bot.linkMode = mode
  bot.lastError = null
  bot.pairRequested = false
  bot.lastPairTime = 0
  bot.pairCode = null
  bot.lastQr = null

  if (req.body?.botNumber !== undefined) {
    bot.botNumber = normalize(req.body.botNumber)
  }

  const found = botsConfig.find(b => b.id === bot.id)
  if (found) {
    found.botNumber = bot.botNumber
    found.linkMode = bot.linkMode
    if (req.body?.label) found.label = String(req.body.label).trim()
  }
  saveBotsConfig()

  // Wipe auth directory for fresh link
  try { fs.rmSync(path.join(AUTH_DIR, bot.id), { recursive: true, force: true }) } catch {}
  log(`Bot ${bot.id}: Requesting new ${mode} code (Phone: ${bot.botNumber ? '+' + bot.botNumber : 'QR Mode'})`)
  startBot(bot.id).catch(e => recordError('startBot', e))
  res.json({ ok: true, botNumber: bot.botNumber, mode: bot.linkMode })
})

app.post('/api/admin/bots/:id/restart', adminAuth, (req, res) => {
  const bot = bots.get(req.params.id)
  if (!bot) return res.status(404).json({ ok: false, error: 'Bot not found' })
  bot.lastError = null
  if (bot.sock) {
    try { bot.sock.end(new Error('Manual restart requested')) } catch {}
  } else {
    startBot(bot.id).catch(e => recordError('startBot', e))
  }
  res.json({ ok: true })
})

app.post('/api/admin/bots/:id/unlink', adminAuth, async (req, res) => {
  const bot = bots.get(req.params.id)
  if (!bot) return res.status(404).json({ ok: false, error: 'Bot not found' })
  try { if (bot.sock) await Promise.race([bot.sock.logout(), sleep(3000)]) } catch {}
  try { fs.rmSync(path.join(AUTH_DIR, bot.id), { recursive: true, force: true }) } catch {}
  bot.pairRequested = false
  bot.lastPairTime = 0
  bot.pairCode = null
  bot.lastQr = null
  bot.status = 'idle'
  bot.ready = false
  res.json({ ok: true })
})

// Direct Chat Endpoint
app.post('/api/admin/bots/:id/send', adminAuth, async (req, res) => {
  const bot = bots.get(req.params.id)
  if (!bot) return res.status(404).json({ ok: false, error: 'Bot not found' })
  if (!bot.ready || !bot.sock) {
    return res.status(503).json({ ok: false, error: `Bot "${bot.label}" is not connected yet (Status: ${bot.status}).` })
  }

  const rawNumber = req.body?.number
  const message = String(req.body?.message || '').trim()
  if (!rawNumber) return res.status(400).json({ ok: false, error: 'Recipient phone number is required.' })
  const number = normalize(rawNumber)
  if (number.length < 10 || number.length > 15) {
    return res.status(400).json({ ok: false, error: 'Invalid phone number format.' })
  }
  if (!message) return res.status(400).json({ ok: false, error: 'Message content cannot be empty.' })

  try {
    const jid = number + '@s.whatsapp.net'
    const { id: msgId } = await sendText(jid, message, bot.id)
    trackDelivery(msgId, bot.id)
    log(`Direct message sent via Bot ${bot.id} to ${mask(number)} | msg: ${msgId.slice(0, 6)}`)
    res.json({ ok: true, msgId, number, botLabel: bot.label })
  } catch(err) {
    res.status(500).json({ ok: false, error: err.message || 'Failed to send message.' })
  }
})

// API Keys Endpoints
app.get('/api/admin/keys', adminAuth, (req, res) => res.json({ ok: true, keys: apiKeys }))
app.post('/api/admin/keys/generate', adminAuth, (req, res) => {
  const label = String(req.body?.label || 'API Key').trim()
  const dailyLimit = Number(req.body?.dailyLimit) || 0
  const key = crypto.randomBytes(32).toString('hex')
  const newObj = {
    id: 'k_' + Date.now(),
    key,
    label,
    createdAt: Date.now(),
    enabled: true,
    dailyLimit,
    usedToday: 0,
    lastUsedDate: ''
  }
  apiKeys.push(newObj)
  saveApiKeys()
  res.json({ ok: true, key: newObj })
})
app.post('/api/admin/keys/:id/toggle', adminAuth, (req, res) => {
  const k = apiKeys.find(x => x.id === req.params.id)
  if (!k) return res.status(404).json({ ok: false, error: 'Key not found' })
  k.enabled = !k.enabled
  saveApiKeys()
  res.json({ ok: true, enabled: k.enabled })
})
app.post('/api/admin/keys/:id/revoke', adminAuth, (req, res) => {
  apiKeys = apiKeys.filter(x => x.id !== req.params.id)
  saveApiKeys()
  res.json({ ok: true })
})

// Settings Endpoint
app.post('/api/admin/settings', adminAuth, (req, res) => {
  const b = req.body || {}
  const upd = {}
  if ('signupEnabled' in b) upd.signupEnabled = !!b.signupEnabled
  if ('restrictToAllowed' in b) upd.restrictToAllowed = !!b.restrictToAllowed
  if ('allowedNumbers' in b) {
    const raw = Array.isArray(b.allowedNumbers) ? b.allowedNumbers.join('\n') : String(b.allowedNumbers || '')
    upd.allowedNumbers = [...new Set(raw.split(/[\s,]+/).map(normalize).filter(n => n.length >= 10 && n.length <= 15))]
  }
  for (const [k, min, max] of [
    ['otpTtlSec', 60, 1800],
    ['cooldownSec', 30, 600],
    ['maxPerHour', 1, 500],
    ['ipLimitPerHour', 1, 100],
    ['warmupSec', 0, 300],
    ['dailyLimit', 1, 100000]
  ]) {
    if (k in b) {
      const n = Number(b[k])
      if (!Number.isFinite(n) || n < min || n > max) return res.status(400).json({ ok: false, error: `${k} must be between ${min} and ${max}` })
      upd[k] = Math.round(n)
    }
  }
  if ('message' in b) {
    const m = String(b.message)
    if (!m.includes('{OTP}')) return res.status(400).json({ ok: false, error: 'Message must contain {OTP} placeholder.' })
    upd.message = m
  }
  Object.assign(CFG, upd)
  saveConfig()
  log('Gateway settings saved successfully')
  res.json({ ok: true })
})

// ======================= Start HTTP Server =======================
const server = http.createServer(app)
server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`
  console.log(col.g(`\n${'═'.repeat(54)}`))
  console.log(col.b(`  🚀 ${APP_NAME} v${VERSION} Gateway Started`))
  console.log(col.c(`  Local Admin:   ${url}/admin.html`))
  console.log(col.c(`  Demo Bank App: ${url}/app.html`))
  console.log(col.c(`  Health Status: ${url}/health`))
  console.log(col.g(`${'═'.repeat(54)}\n`))
  initBots()
})
