import express from 'express'
import pino from 'pino'
import qrcode from 'qrcode'
import qrcodeTerminal from 'qrcode-terminal'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import * as baileys from '@whiskeysockets/baileys'

const APP_NAME = 'OTP Bot Server'
const VERSION = '1.3.0'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Everything that must survive restarts lives in DATA_DIR (default: the app folder).
// On a hosting panel with a persistent volume, set the DATA_DIR environment variable to that path.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
const AUTH_DIR = path.join(DATA_DIR, 'auth')
const BACKUP_DIR = path.join(DATA_DIR, 'auth_backups')
const DATA_FILE = path.join(DATA_DIR, 'otps.json')
const LOCK_FILE = path.join(DATA_DIR, '.lock')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const UNDER_PM2 = process.env.pm_id !== undefined   // true on Termux/VPS (pm2), false on a hosting panel
const CODE_FILES = process.env.CODE_FILES !== '0'   // also save admin/pairing codes to a file (fallback if the console is flaky)
const URL_FILE = path.join(__dirname, '.public-url')
const FIXED_URL_FILE = path.join(__dirname, '.public-url-fixed')
const TUNNEL_APP = 'otp-bot-tunnel'

// Colors only on a real terminal (hosting-panel consoles often show raw escape codes). FORCE_COLOR=1 forces them.
const useColor = (process.stdout.isTTY || process.env.FORCE_COLOR === '1') && !process.env.NO_COLOR
const paint = code => s => useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s)
const col = { g: paint(32), r: paint(31), y: paint(33), c: paint(36), b: paint(1) }

// Code files: shown in the panel's Files tab when the live console is not available
const writeCodeFile = (name, text) => { if (CODE_FILES) { try { fs.writeFileSync(path.join(DATA_DIR, name), text + '\n') } catch {} } }
const removeCodeFile = name => { try { fs.unlinkSync(path.join(DATA_DIR, name)) } catch {} }
removeCodeFile('ADMIN-CODE.txt'); removeCodeFile('PAIRING-CODE.txt')

// Silence libsignal session dumps (they also print key material)
const NOISE = ['Closing session', 'Opening session', 'Removing old closed session', 'Migrating session', 'Session already closed', 'Session already open']
for (const m of ['log', 'info', 'warn']) {
  const orig = console[m].bind(console)
  console[m] = (...a) => { if (typeof a[0] === 'string' && NOISE.some(n => a[0].startsWith(n))) return; orig(...a) }
}

// ======================= Logs and error console =======================
const ring = []     // live log
const errors = []   // error console: which file, what problem
const clock = () => new Date().toLocaleTimeString('en-GB')
const push = (lvl, msg) => { ring.push({ t: clock(), lvl, msg }); if (ring.length > 150) ring.shift() }
const fmt = a => a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')
const log = (...a) => { const m = fmt(a); push('info', m); console.log(col.c(clock()), m) }
const warn = (...a) => { const m = fmt(a); push('warn', m); console.log(col.y(clock() + ' ' + m)) }

const HINTS = [
  [/ECONNABORTED|ECONNRESET|EPIPE/, 'Android/network dropped the connection. Keep Termux visible (split-screen), turn VPN off, avoid Wi-Fi/mobile-data switching.'],
  [/ENOTFOUND|EAI_AGAIN/, 'DNS / internet problem. Check the phone network.'],
  [/ETIMEDOUT|timed? ?out/i, 'Connection timed out. Network is weak or blocked.'],
  [/EADDRINUSE/, 'Port already in use. Run: pm2 stop all'],
  [/Connection Closed|connectionClosed|Connection Terminated/, 'WhatsApp connection closed. It reconnects automatically (Android may be killing background network).'],
  [/rate-overlimit/, 'WhatsApp rate-limited the account. Wait a while before sending more.'],
  [/401|loggedOut|not-authorized/, 'WhatsApp ended the session or linking failed. Generate a new code from the admin panel.'],
  [/bot not ready/, 'Bot is not linked or not ready. Link it from the admin panel.'],
  [/Cannot find module|ERR_MODULE_NOT_FOUND/, 'A package is missing. Run: npm install'],
  [/tunnel/i, 'Public tunnel problem. Run: bash manage.sh tunnel  (new link) or use a fixed link (see GUIDE.md).']
]
const hintFor = m => (HINTS.find(([re]) => re.test(m)) || [])[1] || ''

function srcOf(e) {
  const lines = String(e?.stack || '').split('\n').slice(1)
  const own = lines.find(l => l.includes(__dirname) && !l.includes('node_modules')) || lines[0] || ''
  const m = own.match(/\(?([^()\s]+:\d+:\d+)\)?\s*$/)
  return m ? m[1].replace('file://', '').replace(__dirname + '/', '') : '(no stack)'
}
function recordError(where, e, src) {
  const msg = String(e?.message || e).slice(0, 300)
  const source = src || srcOf(e)
  const last = errors[errors.length - 1]
  if (last && last.msg === msg && last.where === where) { last.count++; last.t = clock(); return }
  errors.push({ t: clock(), where, src: source, msg, hint: hintFor(msg), count: 1 })
  if (errors.length > 100) errors.shift()
  push('error', `[${where}] ${source} - ${msg}`)
  console.log(col.r(`${clock()} ERROR [${where}] ${source} - ${msg}`))
}
process.on('unhandledRejection', e => recordError('unhandledRejection', e))
process.on('uncaughtException', e => recordError('uncaughtException', e))

// ======================= Config =======================
const DEFAULTS = {
  port: 3000,
  botNumber: String(process.env.BOT_NUMBER || '923495031007'),
  signupEnabled: true,
  restrictToAllowed: false,
  allowedNumbers: [],
  warmupSec: 20,
  otpTtlSec: 300,
  cooldownSec: 60,
  maxPerHour: 30,
  ipLimitPerHour: 10,
  tunnelWatchdog: true,
  message: 'Your verification code is *{OTP}*.\nIt is valid for {MINUTES} minutes. Do not share it with anyone.'
}
let CFG = { ...DEFAULTS }
try { CFG = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } } catch {}
// Migration: old configs may hold a non-English message; reset it to the English default
if (/[\u0600-\u06FF]/.test(String(CFG.message))) CFG.message = DEFAULTS.message
const saveConfig = () => { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CFG, null, 2)) } catch (e) { recordError('config', e) } }
saveConfig()
const PORT = Number(process.env.SERVER_PORT || process.env.PORT || CFG.port) || 3000
const HOST = process.env.HOST || '0.0.0.0'
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '')   // optional extra admin login (min 8 chars)
const passwordEnabled = ADMIN_PASSWORD.length >= 8
const MAX_AUTO_LINK = Number(process.env.MAX_AUTO_LINK_TRIES) || 5
const MAX_ATTEMPTS = 5

function normalize(input) {
  let n = String(input || '').replace(/\D/g, '')
  if (n.startsWith('00')) n = n.slice(2)
  if (n.startsWith('0') && n.length === 11) n = '92' + n.slice(1)
  if (n.startsWith('920')) n = '92' + n.slice(3)
  return n
}
const allowedSet = () => new Set((CFG.allowedNumbers || []).map(normalize))
const botDigits = () => normalize(CFG.botNumber)
const mask = n => n.slice(0, 5) + '*****' + n.slice(-2)

// ======================= Single instance lock =======================
function looksLikeOurServer(pid) {
  try { return /server\.js|ProcessContainerFork/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')) }
  catch { return false } // cannot verify (container / other OS): treat the lock as stale
}
try {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'))
    if (pid && pid !== process.pid) {
      let alive = true
      try { process.kill(pid, 0) } catch { alive = false }
      if (alive && looksLikeOurServer(pid)) {
        console.error(col.r(`ERROR: another instance (PID ${pid}) is running. Stop it with: pm2 stop all ; pkill -f server.js   (if it still fails: rm .lock)`))
        process.exit(1)
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid))
} catch {}
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE) } catch {}; removeCodeFile('ADMIN-CODE.txt') })
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0))

// ======================= Session safety =======================
const credsFile = path.join(AUTH_DIR, 'creds.json')
const credsBackup = path.join(AUTH_DIR, 'creds.backup.json')

// A half-finished pairing is NOT a linked session
function isLinked() {
  try { const c = JSON.parse(fs.readFileSync(credsFile, 'utf8')); return !!(c.registered || c.account) }
  catch { return false }
}
function restoreCredsIfBroken() {
  try { JSON.parse(fs.readFileSync(credsFile, 'utf8')) }
  catch { if (fs.existsSync(credsBackup)) { fs.copyFileSync(credsBackup, credsFile); log('Restored creds.json from backup') } }
}
function archiveAuth() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    fs.renameSync(AUTH_DIR, path.join(BACKUP_DIR, 'auth-' + Date.now()))
    for (const d of fs.readdirSync(BACKUP_DIR).sort().slice(0, -3)) fs.rmSync(path.join(BACKUP_DIR, d), { recursive: true, force: true })
  } catch (e) { recordError('archiveAuth', e) }
}
const wipeAuth = () => { try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch {} }

// ======================= WhatsApp connection =======================
const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys

let sock = null
let status = 'starting' // starting | qr | open | closed | loggedout
let ready = false
let lastQr = null
let pairCode = null
let lastError = null
let linkMode = 'pair'   // pair | qr
let reconnectTimer = null
let freshLink = false
let openedAt = 0
let flaps = 0, lastCloseAt = 0
let autoLinkTries = 0

// Routine drops (normal on phone networks) are counted, not reported as errors
const ROUTINE = new Set([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.timedOut, DisconnectReason.restartRequired].filter(x => x !== undefined))
const reconnects = []
const reconnects24h = () => { const t = Date.now(); while (reconnects.length && t - reconnects[0] > 86400_000) reconnects.shift(); return reconnects.length }
const reasonName = c => Object.entries(DisconnectReason).find(([, v]) => v === c)?.[0] || 'unknown'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const rand = (a, b) => a + Math.random() * (b - a)

// ---- Message tracking ----
const STATUS = { 0: 'ERROR', 1: 'PENDING', 2: 'SERVER_ACK', 3: 'DELIVERED', 4: 'READ', 5: 'PLAYED' }
const sentCache = new Map()
const sends = new Map()
const waiters = new Map()
const stats = { requested: 0, accepted: 0, delivered: 0, undelivered: 0, failed: 0, verified: 0 }
let undeliveredRun = 0
let deliveryWarn = null

function track(id, st) {
  const r = sends.get(id)
  if (!r) return
  if (st > r.status) { r.status = st; log(`msg ${id.slice(0, 6)} -> ${STATUS[st] || st}`) }
  if (st >= 3 && lateIds.has(id)) { lateIds.delete(id); stats.undelivered = Math.max(0, stats.undelivered - 1); stats.delivered++ }
  if (st >= 3) { const w = waiters.get(id); if (w) { w(true); waiters.delete(id) } }
}
function waitDelivered(id, ms) {
  return new Promise(res => {
    if ((sends.get(id)?.status || 0) >= 3) return res(true)
    waiters.set(id, res)
    setTimeout(() => { waiters.delete(id); res(false) }, ms)
  })
}

const lastMsg = new Map()   // number -> last message id
const lateIds = new Set()   // ids counted as undelivered that may still deliver later
function trackDelivery(id) {
  waitDelivered(id, 90_000).then(ok => {
    if (ok) { stats.delivered++; undeliveredRun = 0; deliveryWarn = null; return }
    stats.undelivered++; undeliveredRun++; lateIds.add(id)
    warn(`No delivery confirmation after 90s (msg ${id.slice(0, 6)}). The recipient phone may be offline.`)
    if (undeliveredRun >= 3) deliveryWarn = 'Several messages were not confirmed as delivered. The bot number may be restricted, or recipients are offline.'
  })
}

function scheduleReconnect(ms) {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => startSock().catch(e => { recordError('startSock', e); scheduleReconnect(10000) }), ms)
}

function banner(title, value, note) {
  const w = 52, pad = s => s + ' '.repeat(Math.max(0, w - [...s].length))
  console.log(col.g('+' + '-'.repeat(w + 2) + '+'))
  console.log(col.g('| ') + col.b(pad(title)) + col.g(' |'))
  console.log(col.g('| ') + col.y(pad('   ' + value)) + col.g(' |'))
  if (note) console.log(col.g('| ') + pad(note) + col.g(' |'))
  console.log(col.g('+' + '-'.repeat(w + 2) + '+'))
}

async function startSock() {
  if (sock) { try { sock.ev.removeAllListeners(); sock.end?.(undefined) } catch {} }
  restoreCredsIfBroken()
  if (!isLinked()) wipeAuth() // never reuse a half-finished pairing (avoids 401)
  const linkedAtStart = isLinked()
  if (linkedAtStart) autoLinkTries = 0
  else {
    // Do not request pairing codes forever (WhatsApp rate-limits repeated link attempts)
    autoLinkTries++
    if (autoLinkTries > MAX_AUTO_LINK) {
      sock = null; ready = false; status = 'idle'; lastQr = null; pairCode = null
      lastError = `Linking paused after ${MAX_AUTO_LINK} tries (protects the number from WhatsApp limits). Open Admin and press "New pairing code", or restart the app.`
      warn(lastError)
      return
    }
  }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch {}

  const s = makeWASocket({
    auth: state, version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 30_000,
    connectTimeoutMs: 60_000,
    getMessage: async key => sentCache.get(key?.id)
  })
  sock = s
  let pairRequested = false

  s.ev.on('creds.update', async () => {
    try { await saveCreds(); JSON.parse(fs.readFileSync(credsFile, 'utf8')); fs.copyFileSync(credsFile, credsBackup) } catch {}
  })
  s.ev.on('messages.update', ups => { for (const { key, update } of ups) if (key?.fromMe && update?.status != null) track(key.id, update.status) })
  s.ev.on('message-receipt.update', ups => {
    for (const { key, receipt } of ups) {
      if (!key?.fromMe) continue
      if (receipt?.readTimestamp) track(key.id, 4)
      else if (receipt?.receiptTimestamp) track(key.id, 3)
    }
  })

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s !== sock) return

    if (qr) {
      status = 'qr'; ready = false
      if (!state.creds.registered) freshLink = true
      lastQr = await qrcode.toDataURL(qr)
      if (linkMode === 'qr') qrcodeTerminal.generate(qr, { small: true })
      if (linkMode === 'pair' && botDigits() && !state.creds.registered && !pairRequested) {
        pairRequested = true
        try {
          pairCode = await s.requestPairingCode(botDigits())
          log('PAIRING CODE:', pairCode)
          writeCodeFile('PAIRING-CODE.txt', `PAIRING CODE: ${pairCode}\nWhatsApp > Linked devices > Link a device > Link with phone number instead`)
          banner('PAIRING CODE', pairCode, 'WhatsApp > Linked devices > Link with phone number')
        } catch (e) { pairRequested = false; recordError('pairing', e) }
      }
    }

    if (connection === 'open') {
      status = 'open'; lastQr = null; pairCode = null; lastError = null
      removeCodeFile('PAIRING-CODE.txt')
      openedAt = Date.now()
      const wait = freshLink ? CFG.warmupSec : 2
      log(`Connected as ${s.user?.id || '?'} - ready in ${wait}s${freshLink ? ' (new link, warm-up)' : ''}`)
      setTimeout(() => { if (s === sock && status === 'open') { ready = true; freshLink = false; log('Ready') } }, wait * 1000)
    }

    if (connection === 'close') {
      ready = false
      const code = lastDisconnect?.error?.output?.statusCode
      const up = openedAt ? Math.round((Date.now() - openedAt) / 1000) : 0
      openedAt = 0
      const emsg = `${reasonName(code)} (${code}) ${lastDisconnect?.error?.message || ''}`
      warn(`Disconnected: ${emsg} | connection lasted ${up}s - reconnecting`)
      if (ROUTINE.has(code)) { if (code !== DisconnectReason.restartRequired) reconnects.push(Date.now()) }
      else recordError('whatsapp', new Error(emsg), 'WhatsApp connection')

      if (code === DisconnectReason.loggedOut) {
        lastQr = null; pairCode = null
        if (linkedAtStart) {
          status = 'loggedout'
          lastError = `WhatsApp ended the session (code ${code}). Link again from the admin panel.`
          archiveAuth()
        } else {
          status = 'closed'
          lastError = 'Connection dropped during linking. Keep Termux visible (split-screen) and press New code.'
        }
        scheduleReconnect(3000)
      } else if (code === DisconnectReason.connectionReplaced) {
        status = 'closed'
        lastError = 'This session is running somewhere else too (connectionReplaced).'
        scheduleReconnect(15000)
      } else {
        status = 'closed'
        flaps = (Date.now() - lastCloseAt < 30000) ? flaps + 1 : 0
        lastCloseAt = Date.now()
        if (flaps >= 4) recordError('whatsapp', new Error(`Connection keeps dropping (${flaps} times in a row). ${emsg}`), 'WhatsApp connection')
        scheduleReconnect(code === DisconnectReason.restartRequired ? 500 : Math.min(1000 * 2 ** flaps, 30000))
      }
    }
  })
}

// Unlink the current session (or wipe a half-finished one) and start a fresh link
async function unlinkAndRestart() {
  ready = false
  autoLinkTries = 0
  removeCodeFile('PAIRING-CODE.txt')
  const old = sock
  if (old) {
    try { old.ev.removeAllListeners() } catch {}
    try { if (isLinked()) await Promise.race([old.logout(), sleep(5000)]) } catch (e) { warn('logout:', e.message) }
    try { old.end?.(undefined) } catch {}
  }
  wipeAuth()
  status = 'starting'; pairCode = null; lastQr = null; lastError = null
  scheduleReconnect(500)
}

async function waitReady(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (ready && sock) return true; await sleep(500) }
  return false
}

// ======================= Message queue =======================
let chain = Promise.resolve()
function sendText(jid, text) {
  let resolveId, rejectId
  const idP = new Promise((a, b) => { resolveId = a; rejectId = b })
  chain = chain.then(async () => {
    try {
      if (!(await waitReady(20000))) throw new Error('bot not ready')
      try {
        await sock.sendPresenceUpdate('composing', jid)
        await sleep(rand(1500, 3500))
        await sock.sendPresenceUpdate('paused', jid)
      } catch {}
      let m
      try { m = await sock.sendMessage(jid, { text }) }
      catch (e) {
        warn('send retry:', e.message)
        if (!(await waitReady(20000))) throw e
        m = await sock.sendMessage(jid, { text })
      }
      const id = m?.key?.id
      if (!id) throw new Error('no message id')
      sentCache.set(id, m.message)
      sends.set(id, { to: jid.split('@')[0], status: 1, at: Date.now() })
      for (const map of [sentCache, sends]) while (map.size > 300) map.delete(map.keys().next().value)
      resolveId(id)
    } catch (e) { rejectId(e); return }
    await sleep(rand(2000, 5000))
  })
  return idP
}

// ======================= OTP store and limits =======================
let otps = new Map()
try { otps = new Map(Object.entries(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')))) } catch {}
const persist = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(Object.fromEntries(otps))) } catch {} }
const sessions = new Map()
setInterval(() => {
  let ch = false
  for (const [k, v] of otps) if (Date.now() > v.expires + CFG.cooldownSec * 1000) { otps.delete(k); ch = true }
  if (ch) persist()
  for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t)
}, 60_000)

const ipHits = new Map(), sendLog = []
const hash = x => crypto.createHash('sha256').update(x).digest('hex')
function ipAllowed(ip) {
  const t = Date.now()
  const arr = (ipHits.get(ip) || []).filter(x => t - x < 3600_000)
  if (arr.length >= CFG.ipLimitPerHour) return false
  arr.push(t); ipHits.set(ip, arr); return true
}
function globalAllowed() {
  const t = Date.now()
  while (sendLog.length && t - sendLog[0] > 3600_000) sendLog.shift()
  if (sendLog.length >= CFG.maxPerHour) return false
  sendLog.push(t); return true
}

// ======================= Admin login (code is printed in the terminal) =======================
let adminCode = null // {code, expires}
let lastCodeReq = 0
const loginFails = []
function loginBlocked(ip) {
  const t = Date.now()
  while (loginFails.length && t - loginFails[0].t > 600_000) loginFails.shift()
  return loginFails.length >= 30 || loginFails.filter(f => f.ip === ip).length >= 5
}
function adminAuth(req, res, next) {
  const tok = (req.headers.authorization || '').replace(/^Bearer /, '')
  const exp = sessions.get(tok)
  if (!exp || exp < Date.now()) { sessions.delete(tok); return res.status(401).json({ ok: false, error: 'Login required' }) }
  next()
}

// ======================= Public link (tunnel) helpers =======================
function currentTunnelUrl() {
  const envUrl = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '')
  if (envUrl) return envUrl
  try { const f = fs.readFileSync(FIXED_URL_FILE, 'utf8').trim(); if (f) return f } catch {}
  const home = process.env.HOME || ''
  for (const f of [TUNNEL_APP + '-error.log', TUNNEL_APP + '-out.log']) {
    try {
      const t = fs.readFileSync(path.join(home, '.pm2/logs', f), 'utf8').slice(-30000)
      const m = t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)
      if (m) return m[m.length - 1]
    } catch {}
  }
  try { return fs.readFileSync(URL_FILE, 'utf8').trim() } catch { return '' }
}

let publicOk = null, publicFails = 0, publicCheckedAt = 0
async function internetOk() {
  try { const r = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) }); return r.ok } catch { return false }
}
function restartTunnel(why) {
  if (!UNDER_PM2) { warn('Tunnel restart works only under pm2 (Termux/VPS). On a hosting panel there is no tunnel to restart.'); return false }
  execFile('pm2', ['restart', TUNNEL_APP], { timeout: 20000 }, (e, so, se) => {
    if (e) recordError('tunnel restart', new Error(String(se || e.message).slice(0, 200)), 'pm2 restart ' + TUNNEL_APP)
    else log(`Public tunnel restarted (${why}). A quick-tunnel link changes after restart - see Admin > Links.`)
  })
  return true
}
async function checkPublic() {
  const url = currentTunnelUrl()
  if (!url) { publicOk = null; return }
  try {
    const r = await fetch(url + '/health', { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'otp-bot-watchdog' } })
    publicOk = r.ok
  } catch { publicOk = false }
  publicCheckedAt = Date.now()
  if (publicOk) { publicFails = 0; return }
  publicFails++
  warn(`Public link check failed (${publicFails}/5): ${url}`)
  // Restart the tunnel only when the phone itself has internet but the public link stays dead
  if (CFG.tunnelWatchdog && UNDER_PM2 && publicFails >= 5 && await internetOk()) { publicFails = 0; restartTunnel('watchdog') }
}
setTimeout(checkPublic, 20_000)
setInterval(checkPublic, 60_000)

// ======================= Web server =======================
const app = express()
app.disable('x-powered-by')
// Behind a hosting panel's reverse proxy set TRUST_PROXY=1 so each visitor gets their own IP for the rate limits
const trustProxy = (() => { const v = process.env.TRUST_PROXY; if (!v) return 'loopback'; if (v === 'true') return true; if (v === 'false') return false; return /^\d+$/.test(v) ? Number(v) : v })()
app.set('trust proxy', trustProxy)
app.use(express.json({ limit: '10kb' }))
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store')
  next()
})
app.use(express.static(path.join(__dirname, 'public')))
app.get('/admin', (req, res) => res.redirect('/admin.html'))

app.get('/health', (req, res) => res.json({ ok: true, name: APP_NAME, version: VERSION, status, ready, uptime: Math.round(process.uptime()) }))
app.get('/api/status', (req, res) => res.json({ name: APP_NAME, status, ready, signupEnabled: CFG.signupEnabled, adminPassword: passwordEnabled }))

// Browser errors (signup/admin page problems show up in the error console)
const clientErrHits = new Map()
app.post('/api/client-error', (req, res) => {
  const t = Date.now()
  const arr = (clientErrHits.get(req.ip) || []).filter(x => t - x < 60_000)
  if (arr.length >= 20) return res.json({ ok: true })
  arr.push(t); clientErrHits.set(req.ip, arr)
  const b = req.body || {}
  const where = 'browser:' + String(b.page || '?').slice(0, 20)
  const src = (String(b.source || '').slice(0, 120) + (b.line ? ':' + Number(b.line) : '')) || '(browser)'
  recordError(where, String(b.message || 'unknown').slice(0, 300), src)
  res.json({ ok: true })
})

// ---- Signup API ----
app.post('/api/send-otp', async (req, res) => {
  try {
    stats.requested++
    if (!CFG.signupEnabled) return res.status(403).json({ ok: false, error: 'Signup is currently disabled.' })
    if (!(await waitReady(15000))) return res.status(503).json({ ok: false, error: 'Bot is not linked or not ready. Try again shortly.' })
    if (!ipAllowed(req.ip)) return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' })

    const number = normalize(req.body.number)
    if (number.length < 11 || number.length > 15) return res.status(400).json({ ok: false, error: 'Invalid number.' })
    if (CFG.restrictToAllowed && !allowedSet().has(number)) return res.status(403).json({ ok: false, error: 'This number is not on the test list.' })

    const prev = otps.get(number)
    const cd = CFG.cooldownSec * 1000
    if (prev && Date.now() - prev.sentAt < cd) {
      const w = Math.ceil((cd - (Date.now() - prev.sentAt)) / 1000)
      return res.status(429).json({ ok: false, error: `Please wait ${w}s before requesting another code.`, wait: w })
    }
    if (!globalAllowed()) return res.status(429).json({ ok: false, error: 'Hourly limit reached.' })

    let jid = number + '@s.whatsapp.net'
    let c
    try { c = await sock.onWhatsApp(jid) } catch (e) { warn('onWhatsApp failed:', e.message) }
    if (Array.isArray(c)) {
      // Baileys only returns numbers that exist; an empty list means no WhatsApp on this number
      const hit = c.find(x => x.exists)
      if (!hit) return res.status(404).json({ ok: false, error: 'No WhatsApp account found on this number. Check the number.' })
      jid = hit.jid
    }

    const otp = String(crypto.randomInt(100000, 1000000))
    otps.set(number, { hash: hash(otp), expires: Date.now() + CFG.otpTtlSec * 1000, attempts: 0, sentAt: Date.now() })
    persist()
    const text = CFG.message.replace('{OTP}', otp).replace('{MINUTES}', Math.round(CFG.otpTtlSec / 60))

    let msgId
    try { msgId = await sendText(jid, text) } catch (e) { otps.delete(number); persist(); throw e }
    stats.accepted++
    lastMsg.set(number, msgId)
    while (lastMsg.size > 500) lastMsg.delete(lastMsg.keys().next().value)
    log('Server accepted message ->', mask(number), '| id:', msgId.slice(0, 6))
    trackDelivery(msgId)
    // Respond right away; the page polls /api/delivery (long-held requests break on mobile networks and tunnels)
    res.json({ ok: true, number, state: 'sent' })
  } catch (e) {
    stats.failed++
    recordError('send-otp', e)
    res.status(500).json({ ok: false, error: 'Could not send the message.' })
  }
})

const deliveryHits = new Map()
app.get('/api/delivery', (req, res) => {
  const t = Date.now()
  const arr = (deliveryHits.get(req.ip) || []).filter(x => t - x < 60_000)
  if (arr.length >= 60) return res.status(429).json({ ok: false })
  arr.push(t); deliveryHits.set(req.ip, arr)
  const id = lastMsg.get(normalize(req.query.number))
  const r = id && sends.get(id)
  if (!r) return res.json({ ok: true, known: false })
  res.json({ ok: true, known: true, status: STATUS[r.status] || String(r.status), delivered: r.status >= 3 })
})

app.post('/api/verify-otp', (req, res) => {
  const number = normalize(req.body.number)
  const otp = String(req.body.otp || '').trim()
  const rec = otps.get(number)
  if (!rec) return res.status(400).json({ ok: false, error: 'Request a code first.' })
  if (Date.now() > rec.expires) { otps.delete(number); persist(); return res.status(400).json({ ok: false, error: 'Code expired.' }) }
  if (++rec.attempts > MAX_ATTEMPTS) { otps.delete(number); persist(); return res.status(429).json({ ok: false, error: 'Too many wrong attempts.' }) }
  if (hash(otp) !== rec.hash) { persist(); return res.status(400).json({ ok: false, error: 'Wrong code.' }) }
  otps.delete(number); persist(); stats.verified++
  res.json({ ok: true, message: 'Account created successfully' })
})

// ---- Admin API ----
app.post('/api/admin/request-code', (req, res) => {
  if (loginBlocked(req.ip)) return res.status(429).json({ ok: false, error: 'Too many wrong attempts. Try again in 10 minutes.' })
  if (Date.now() - lastCodeReq < 15_000) return res.status(429).json({ ok: false, error: 'Wait a few seconds and try again.' })
  lastCodeReq = Date.now()
  if (!adminCode || adminCode.expires < Date.now()) adminCode = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + 5 * 60_000 }
  banner('ADMIN VERIFICATION CODE', adminCode.code, 'Valid for 5 minutes')
  writeCodeFile('ADMIN-CODE.txt', `ADMIN VERIFICATION CODE: ${adminCode.code}\nValid until ${new Date(adminCode.expires).toISOString()}`)
  setTimeout(() => { if (!adminCode || adminCode.expires < Date.now()) removeCodeFile('ADMIN-CODE.txt') }, 5 * 60_000 + 1000)
  push('warn', 'Admin verification code printed in the terminal')
  res.json({ ok: true })
})

const safeEq = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b) }
app.post('/api/admin/login', (req, res) => {
  if (loginBlocked(req.ip)) return res.status(429).json({ ok: false, error: 'Too many wrong attempts. Try again in 10 minutes.' })
  const codeValid = adminCode && adminCode.expires >= Date.now()
  if (!codeValid && !passwordEnabled) return res.status(400).json({ ok: false, error: 'Request a code first (no valid code, or it expired).' })
  const given = String(req.body.code || '').trim()
  const ok = (codeValid && safeEq(given, adminCode.code)) || (passwordEnabled && safeEq(given, ADMIN_PASSWORD))
  if (!ok) {
    loginFails.push({ ip: req.ip, t: Date.now() })
    warn('Admin login: wrong code')
    return res.status(400).json({ ok: false, error: 'Wrong code.' })
  }
  if (codeValid && safeEq(given, adminCode.code)) { adminCode = null; removeCodeFile('ADMIN-CODE.txt') }
  const token = crypto.randomBytes(24).toString('hex')
  sessions.set(token, Date.now() + 2 * 3600_000)
  log('Admin login OK')
  res.json({ ok: true, token })
})

app.post('/api/admin/logout-session', adminAuth, (req, res) => {
  sessions.delete((req.headers.authorization || '').replace(/^Bearer /, ''))
  res.json({ ok: true })
})

app.get('/api/admin/state', adminAuth, (req, res) => {
  res.json({
    ok: true, name: APP_NAME, version: VERSION, status, ready, linked: isLinked(), linkMode,
    botNumber: botDigits(), me: sock?.user?.id || null,
    qr: lastQr, pairCode, lastError: lastError || deliveryWarn,
    uptime: Math.round(process.uptime()), port: PORT, stats,
    underPm2: UNDER_PM2, customDataDir: DATA_DIR !== __dirname, passwordEnabled,
    reconnects24h: reconnects24h(), connUptime: openedAt ? Math.round((Date.now() - openedAt) / 1000) : 0,
    publicUrl: currentTunnelUrl(), publicOk, publicCheckedAt, fixedUrl: fs.existsSync(FIXED_URL_FILE),
    settings: {
      signupEnabled: CFG.signupEnabled, restrictToAllowed: CFG.restrictToAllowed,
      allowedNumbers: CFG.allowedNumbers, otpTtlSec: CFG.otpTtlSec, cooldownSec: CFG.cooldownSec,
      maxPerHour: CFG.maxPerHour, ipLimitPerHour: CFG.ipLimitPerHour, warmupSec: CFG.warmupSec,
      tunnelWatchdog: CFG.tunnelWatchdog, message: CFG.message
    },
    recent: [...sends.entries()].slice(-10).reverse().map(([id, r]) => ({
      id: id.slice(0, 8), to: mask(r.to), status: STATUS[r.status] || String(r.status), ageSec: Math.round((Date.now() - r.at) / 1000)
    }))
  })
})

app.get('/api/admin/console', adminAuth, (req, res) => res.json({ ok: true, logs: ring.slice(-80), errors: errors.slice().reverse() }))
app.post('/api/admin/console/clear', adminAuth, (req, res) => { errors.length = 0; res.json({ ok: true }) })

app.post('/api/admin/new-code', adminAuth, async (req, res) => {
  const mode = req.body.mode === 'qr' ? 'qr' : 'pair'
  if (isLinked() && !req.body.confirm) return res.status(409).json({ ok: false, needConfirm: true, error: 'The bot is already linked. Generating a new code will remove the current link.' })
  linkMode = mode
  log(`Generating new ${mode === 'qr' ? 'QR' : 'pairing code + QR'}`)
  await unlinkAndRestart()
  res.json({ ok: true })
})

app.post('/api/admin/set-number', adminAuth, async (req, res) => {
  const n = normalize(req.body.number)
  if (n.length < 11 || n.length > 15) return res.status(400).json({ ok: false, error: 'Invalid number (example: 03XXXXXXXXX or 923XXXXXXXXX).' })
  if (isLinked() && !req.body.confirm) return res.status(409).json({ ok: false, needConfirm: true, error: 'The bot is linked. Changing the number will remove the current link.' })
  CFG.botNumber = n; saveConfig()
  linkMode = req.body.mode === 'qr' ? 'qr' : 'pair'
  log('Bot number changed:', mask(n))
  await unlinkAndRestart()
  res.json({ ok: true, botNumber: n })
})

app.post('/api/admin/unlink', adminAuth, async (req, res) => {
  if (!req.body.confirm) return res.status(409).json({ ok: false, needConfirm: true, error: 'The bot will be unlinked from WhatsApp.' })
  log('Bot unlinked')
  await unlinkAndRestart()
  res.json({ ok: true })
})

app.post('/api/admin/restart', adminAuth, (req, res) => {
  log('Manual reconnect')
  autoLinkTries = 0
  if (sock) { try { sock.end(new Error('manual restart')) } catch {} } else scheduleReconnect(200)
  res.json({ ok: true })
})

app.post('/api/admin/check-public', adminAuth, async (req, res) => {
  await checkPublic()
  res.json({ ok: true, publicOk, publicUrl: currentTunnelUrl() })
})
app.post('/api/admin/restart-tunnel', adminAuth, (req, res) => {
  if (!restartTunnel('admin')) return res.status(400).json({ ok: false, error: 'Not running under pm2 (hosting-panel mode): there is no tunnel to restart.' })
  res.json({ ok: true })
})

app.post('/api/admin/settings', adminAuth, (req, res) => {
  const b = req.body || {}
  const upd = {}
  if ('signupEnabled' in b) upd.signupEnabled = !!b.signupEnabled
  if ('restrictToAllowed' in b) upd.restrictToAllowed = !!b.restrictToAllowed
  if ('tunnelWatchdog' in b) upd.tunnelWatchdog = !!b.tunnelWatchdog
  if ('allowedNumbers' in b) {
    const raw = Array.isArray(b.allowedNumbers) ? b.allowedNumbers.join('\n') : String(b.allowedNumbers || '')
    upd.allowedNumbers = [...new Set(raw.split(/[\s,]+/).map(normalize).filter(n => n.length >= 11 && n.length <= 15))]
  }
  for (const [k, min, max] of [['otpTtlSec', 60, 1800], ['cooldownSec', 30, 600], ['maxPerHour', 1, 500], ['ipLimitPerHour', 1, 100], ['warmupSec', 0, 300]]) {
    if (k in b) {
      const n = Number(b[k])
      if (!Number.isFinite(n) || n < min || n > max) return res.status(400).json({ ok: false, error: `${k} must be between ${min} and ${max}` })
      upd[k] = Math.round(n)
    }
  }
  if ('message' in b) {
    const m = String(b.message)
    if (!m.includes('{OTP}') || m.length > 400) return res.status(400).json({ ok: false, error: 'Message must contain {OTP} (max 400 characters).' })
    upd.message = m
  }
  Object.assign(CFG, upd); saveConfig()
  log('Settings saved')
  res.json({ ok: true })
})

// Error handler (bad JSON or any other failure)
app.use((e, req, res, next) => {
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: 'Invalid data format.' })
  recordError('express ' + req.path, e)
  res.status(500).json({ ok: false, error: 'Server error.' })
})

const server = app.listen(PORT, HOST, () => {
  console.log('')
  console.log(col.g(col.b(`  ${APP_NAME} v${VERSION}`)))
  log(`Listening on ${HOST}:${PORT} | Node ${process.version} | mode: ${UNDER_PM2 ? 'pm2 (Termux/VPS)' : 'hosting panel / standalone'}`)
  log(`Local:  http://localhost:${PORT}   Admin: /admin.html`)
  log(`Data folder: ${DATA_DIR}`)
  log(`Public link: ${currentTunnelUrl() || '(not set - on a hosting panel set the PUBLIC_URL variable, see GUIDE.md)'}`)
  log(`Admin login: open /admin.html and press "Request code". The code is printed in THIS console${CODE_FILES ? ' and saved in ADMIN-CODE.txt' : ''}${passwordEnabled ? ' (ADMIN_PASSWORD also works)' : ''}.`)
  log(`Bot number: ${mask(botDigits())}`)
})
setInterval(() => log(`Heartbeat: status=${status} ready=${ready} server-up=${Math.round(process.uptime() / 60)}m connection-up=${openedAt ? Math.round((Date.now() - openedAt) / 60000) : 0}m reconnects24h=${reconnects24h()} accepted=${stats.accepted} delivered=${stats.delivered}`), 10 * 60_000)
server.on('error', e => {
  recordError('http server', e)
  console.error(col.r(`ERROR: server could not start: ${e.message}`))
  process.exit(1)
})

startSock().catch(e => { recordError('startSock', e); scheduleReconnect(10000) })
