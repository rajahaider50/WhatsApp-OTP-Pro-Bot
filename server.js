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

// ======================= Constants =======================
const APP_NAME = 'OTP Bot Pro'
const VERSION  = '2.0.0'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR  = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname
try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}

const AUTH_DIR    = path.join(DATA_DIR, 'auth')
const DATA_FILE   = path.join(DATA_DIR, 'otps.json')
const LOCK_FILE   = path.join(DATA_DIR, '.lock')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
const BOTS_FILE   = path.join(DATA_DIR, 'bots.json')
const KEYS_FILE   = path.join(DATA_DIR, 'apikeys.json')
const DAILY_FILE  = path.join(DATA_DIR, 'daily.json')
const URL_FILE    = path.join(__dirname, '.public-url')
const FIXED_URL   = path.join(__dirname, '.public-url-fixed')
const TUNNEL_APP  = 'otp-bot-tunnel'
const UNDER_PM2   = process.env.pm_id !== undefined
const CODE_FILES  = process.env.CODE_FILES !== '0'

// Colors
const useColor = (process.stdout.isTTY || process.env.FORCE_COLOR === '1') && !process.env.NO_COLOR
const paint = c => s => useColor ? `\x1b[${c}m${s}\x1b[0m` : String(s)
const col = { g: paint(32), r: paint(31), y: paint(33), c: paint(36), b: paint(1) }

// Suppress Baileys noise
const NOISE = ['Closing session','Opening session','Removing old closed session','Migrating session','Session already closed','Session already open']
for (const m of ['log','info','warn']) {
  const orig = console[m].bind(console)
  console[m] = (...a) => { if (typeof a[0]==='string' && NOISE.some(n=>a[0].startsWith(n))) return; orig(...a) }
}

// ======================= Logging =======================
const ring   = []
const errors = []
const clock  = () => new Date().toLocaleTimeString('en-GB')
const push   = (lvl, msg) => { ring.push({ t: clock(), lvl, msg }); if (ring.length > 200) ring.shift() }
const fmt    = a => a.map(x => typeof x==='string' ? x : JSON.stringify(x)).join(' ')
const log    = (...a) => { const m=fmt(a); push('info',m); console.log(col.c(clock()), m) }
const warn   = (...a) => { const m=fmt(a); push('warn',m); console.log(col.y(clock()+' '+m)) }

const HINTS = [
  [/ECONNABORTED|ECONNRESET|EPIPE/, 'Network dropped. Keep Termux visible (split-screen), turn VPN off.'],
  [/ENOTFOUND|EAI_AGAIN/, 'DNS/internet problem. Check network.'],
  [/ETIMEDOUT|timed.?out/i, 'Connection timed out. Network is weak.'],
  [/EADDRINUSE/, 'Port already in use. Run: pm2 stop all'],
  [/Connection Closed|connectionClosed|Connection Terminated/, 'WhatsApp closed. Reconnecting automatically.'],
  [/rate-overlimit/, 'WhatsApp rate-limited the account. Wait before sending more.'],
  [/401|loggedOut|not-authorized/, 'Session ended. Generate a new pairing code from Admin.'],
  [/bot not ready/, 'No bot is linked or ready. Link from Admin > Bots.'],
  [/Cannot find module|ERR_MODULE_NOT_FOUND/, 'Package missing. Run: npm install'],
]
const hintFor = m => (HINTS.find(([re])=>re.test(m))||[])[1]||''

function srcOf(e) {
  const lines = String(e?.stack||'').split('\n').slice(1)
  const own   = lines.find(l=>l.includes(__dirname)&&!l.includes('node_modules'))||lines[0]||''
  const m     = own.match(/\(?([^()\s]+:\d+:\d+)\)?\s*$/)
  return m ? m[1].replace('file://','').replace(__dirname+'/','') : '(no stack)'
}
function recordError(where, e, src) {
  const msg    = String(e?.message||e).slice(0,300)
  const source = src||srcOf(e)
  const last   = errors[errors.length-1]
  if (last && last.msg===msg && last.where===where) { last.count++; last.t=clock(); return }
  errors.push({ t:clock(), where, src:source, msg, hint:hintFor(msg), count:1 })
  if (errors.length>100) errors.shift()
  push('error',`[${where}] ${source} - ${msg}`)
  console.log(col.r(`${clock()} ERROR [${where}] ${source} - ${msg}`))
}
process.on('unhandledRejection', e => recordError('unhandledRejection', e))
process.on('uncaughtException',  e => recordError('uncaughtException', e))

// ======================= Config =======================
const DEFAULT_MSG = `\uD83D\uDD10 *Your Verification Code*

\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
\u2502      *{OTP}*        \u2502
\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518

\u23F1 Valid for *{MINUTES} minutes*
\uD83D\uDD12 Keep this code private

_Tap code to copy_`

const DEFAULTS = {
  port: 3000,
  signupEnabled: true,
  restrictToAllowed: false,
  allowedNumbers: [],
  warmupSec: 20,
  otpTtlSec: 300,
  cooldownSec: 60,
  maxPerHour: 30,
  ipLimitPerHour: 10,
  dailyLimit: 500,
  tunnelWatchdog: true,
  message: DEFAULT_MSG
}
let CFG = { ...DEFAULTS }
try { CFG = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')) } } catch {}
const saveConfig = () => { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CFG,null,2)) } catch(e) { recordError('config',e) } }
saveConfig()

const PORT           = Number(process.env.SERVER_PORT||process.env.PORT||CFG.port)||3000
const HOST           = process.env.HOST||'0.0.0.0'
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD||'')
const passwordEnabled= ADMIN_PASSWORD.length>=8
const MAX_AUTO_LINK  = Number(process.env.MAX_AUTO_LINK_TRIES)||5
const MAX_ATTEMPTS   = 5

// ======================= Helpers =======================
function normalize(input) {
  let n = String(input||'').replace(/\D/g,'')
  if (n.startsWith('00')) n = n.slice(2)
  if (n.startsWith('920')) n = '92' + n.slice(3)
  else if (n.startsWith('0') && n.length === 11) n = '92' + n.slice(1)
  else if (n.startsWith('3') && n.length === 10) n = '92' + n
  else if (n.length === 10 && !n.startsWith('92')) n = '92' + n
  return n
}
const allowedSet = () => new Set((CFG.allowedNumbers||[]).map(normalize))
const mask = n => n.slice(0,5)+'*****'+n.slice(-2)
const sleep = ms => new Promise(r=>setTimeout(r,ms))
const rand  = (a,b) => a+Math.random()*(b-a)

// ======================= Lock file =======================
function looksLikeOurServer(pid) {
  try { return /server\.js|ProcessContainerFork/.test(fs.readFileSync(`/proc/${pid}/cmdline`,'utf8')) }
  catch { return false }
}
try {
  if (fs.existsSync(LOCK_FILE)) {
    const pid = Number(fs.readFileSync(LOCK_FILE,'utf8'))
    if (pid && pid!==process.pid) {
      let alive=true; try { process.kill(pid,0) } catch { alive=false }
      if (alive && looksLikeOurServer(pid)) {
        console.error(col.r(`ERROR: another instance (PID ${pid}) is running. Stop it: pm2 stop all ; pkill -f server.js`))
        process.exit(1)
      }
    }
  }
  fs.writeFileSync(LOCK_FILE, String(process.pid))
} catch {}
process.on('exit', () => { try { fs.unlinkSync(LOCK_FILE) } catch {} })
for (const s of ['SIGINT','SIGTERM']) process.on(s,()=>process.exit(0))

// ======================= Code files =======================
const writeCodeFile  = (name,text) => { if(CODE_FILES) { try { fs.writeFileSync(path.join(DATA_DIR,name),text+'\n') } catch {} } }
const removeCodeFile = name => { try { fs.unlinkSync(path.join(DATA_DIR,name)) } catch {} }
removeCodeFile('ADMIN-CODE.txt'); removeCodeFile('PAIRING-CODE.txt')

// ======================= Daily limit =======================
let dailyGlobal = { date:'', count:0 }
try { dailyGlobal = JSON.parse(fs.readFileSync(DAILY_FILE,'utf8')) } catch {}
function checkDailyReset() {
  const d = new Date().toISOString().split('T')[0]
  if (dailyGlobal.date!==d) dailyGlobal = { date:d, count:0 }
}
checkDailyReset()
setInterval(() => { checkDailyReset(); try { fs.writeFileSync(DAILY_FILE,JSON.stringify(dailyGlobal)) } catch {} }, 60_000)

// ======================= API Keys =======================
let apiKeys = []
try { apiKeys = JSON.parse(fs.readFileSync(KEYS_FILE,'utf8')) } catch {}
const saveApiKeys = () => { try { fs.writeFileSync(KEYS_FILE,JSON.stringify(apiKeys,null,2)) } catch {} }

function apiKeyAuth(req, res, next) {
  const k = req.headers['x-api-key']||req.query.api_key
  if (!k) return res.status(401).json({ ok:false, error:'API key required (x-api-key header)' })
  const keyObj = apiKeys.find(x=>x.key===k)
  if (!keyObj||!keyObj.enabled) return res.status(401).json({ ok:false, error:'Invalid or disabled API key' })
  const d = new Date().toISOString().split('T')[0]
  if (keyObj.lastUsedDate!==d) { keyObj.usedToday=0; keyObj.lastUsedDate=d }
  if (keyObj.dailyLimit>0 && keyObj.usedToday>=keyObj.dailyLimit)
    return res.status(429).json({ ok:false, error:'API key daily limit reached' })
  req.apiKey = keyObj
  next()
}

// ======================= Stats & Delivery =======================
const globalStats = { requested:0, accepted:0, delivered:0, undelivered:0, failed:0, verified:0 }
const STATUS       = { 0:'ERROR', 1:'PENDING', 2:'SERVER_ACK', 3:'DELIVERED', 4:'READ', 5:'PLAYED' }
const sentCache    = new Map()
const sends        = new Map()
const waiters      = new Map()
const lateIds      = new Set()
const lastMsg      = new Map()

function trackMsg(id, st, botId) {
  const r = sends.get(id)
  if (!r) return
  if (st>r.status) { r.status=st; log(`msg ${id.slice(0,6)} -> ${STATUS[st]||st}`) }
  if (st>=3 && lateIds.has(id)) {
    lateIds.delete(id)
    globalStats.undelivered = Math.max(0,globalStats.undelivered-1)
    globalStats.delivered++
    const b = bots.get(botId||r.botId)
    if (b) { b.stats.undelivered=Math.max(0,b.stats.undelivered-1); b.stats.delivered++ }
  }
  if (st>=3) { const w=waiters.get(id); if(w){w(true);waiters.delete(id)} }
}
function waitDelivered(id, ms) {
  return new Promise(res => {
    if ((sends.get(id)?.status||0)>=3) return res(true)
    waiters.set(id,res)
    setTimeout(()=>{waiters.delete(id);res(false)},ms)
  })
}
function trackDelivery(id, botId) {
  waitDelivered(id,90_000).then(ok=>{
    if (ok) { globalStats.delivered++; const b=bots.get(botId); if(b) b.stats.delivered++; return }
    globalStats.undelivered++; lateIds.add(id)
    const b=bots.get(botId); if(b) b.stats.undelivered++
    warn(`No delivery after 90s (msg ${id.slice(0,6)})`)
  })
}

// ======================= Multi-Bot Architecture =======================
const bots = new Map()
let botsConfig = []
try { botsConfig = JSON.parse(fs.readFileSync(BOTS_FILE,'utf8')) } catch {
  botsConfig = [{ id:'bot0', label:'Main Bot', enabled:true, botNumber: process.env.BOT_NUMBER||'923495031007' }]
  try { fs.writeFileSync(BOTS_FILE,JSON.stringify(botsConfig,null,2)) } catch {}
}

const makeWASocket = baileys.default?.default||baileys.default||baileys.makeWASocket
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys
const ROUTINE = new Set([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.timedOut, DisconnectReason.restartRequired].filter(x=>x!==undefined))
const reasonName = c => Object.entries(DisconnectReason).find(([,v])=>v===c)?.[0]||'unknown'

function initBotState(cfg) {
  const state = {
    id: cfg.id, label: cfg.label||cfg.id, enabled: cfg.enabled!==false,
    botNumber: cfg.botNumber||'',
    sock: null, status: 'idle', ready: false,
    lastQr: null, pairCode: null, lastError: null,
    linkMode: 'pair', pairRequested: false,
    reconnectTimer: null, freshLink: false,
    openedAt: 0, flaps: 0, lastCloseAt: 0, autoLinkTries: 0,
    history: [],
    dailySent: { date:'', count:0 },
    stats: { requested:0, accepted:0, delivered:0, undelivered:0, failed:0 },
    chain: Promise.resolve()
  }
  bots.set(cfg.id, state)
  return state
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

  const botAuth = path.join(AUTH_DIR, botId)
  try { fs.mkdirSync(botAuth,{recursive:true}) } catch {}

  const credsFile = path.join(botAuth,'creds.json')
  const isLinked  = () => {
    try { const c=JSON.parse(fs.readFileSync(credsFile,'utf8')); return !!(c.registered||c.account) }
    catch { return false }
  }

  const linkedAtStart = isLinked()
  if (linkedAtStart) {
    bot.autoLinkTries = 0
  } else {
    bot.autoLinkTries++
    if (bot.autoLinkTries > 15) {
      bot.status = 'idle'
      bot.lastError = 'Linking paused. Open Admin > Bots and press "New Pairing Code".'
      warn(`Bot ${botId}: ${bot.lastError}`)
      return
    }
  }

  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch {}
  const { state, saveCreds } = await useMultiFileAuthState(botAuth)

  // Use macOS Desktop identity which is widely trusted by WhatsApp Personal & Business
  const s = makeWASocket({
    auth: {
      creds: state.creds,
      keys: baileys.makeCacheableSignalKeyStore ? baileys.makeCacheableSignalKeyStore(state.keys, pino({ level:'silent' })) : state.keys
    },
    version,
    logger: pino({ level:'silent' }),
    printQRInTerminal: false,
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    getMessage: async key => sentCache.get(key?.id)
  })

  bot.sock = s
  bot.status = 'starting'
  log(`Bot ${botId} (${bot.label}): starting connection...`)

  s.ev.on('creds.update', async () => {
    try {
      await saveCreds()
    } catch(err) {
      warn(`Bot ${botId} saveCreds:`, err.message)
    }
  })

  s.ev.on('messages.update', ups => {
    for (const { key, update } of ups)
      if (key?.fromMe && update?.status!=null) trackMsg(key.id, update.status, botId)
  })
  s.ev.on('message-receipt.update', ups => {
    for (const { key, receipt } of ups) {
      if (!key?.fromMe) continue
      if (receipt?.readTimestamp)    trackMsg(key.id,4,botId)
      else if (receipt?.receiptTimestamp) trackMsg(key.id,3,botId)
    }
  })

  s.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (s!==bot.sock) return

    if (qr) {
      bot.status='qr'
      bot.ready=false
      if (!state.creds.registered) bot.freshLink=true
      try { bot.lastQr = await qrcode.toDataURL(qr) } catch {}
      if (bot.linkMode==='qr') qrcodeTerminal.generate(qr,{small:true})

      // Generate pairing code once if pairing mode and botNumber provided
      if (bot.linkMode==='pair' && bot.botNumber && !state.creds.registered && !bot.pairRequested) {
        bot.pairRequested = true
        // Give 2 seconds for WebSocket handshake to stabilize before requesting pairing code
        setTimeout(async () => {
          if (bot.sock !== s || state.creds.registered) return
          try {
            const cleanNum = normalize(bot.botNumber)
            log(`Bot ${botId}: requesting pairing code for +${cleanNum}...`)
            bot.pairCode = await s.requestPairingCode(cleanNum)
            log(`Bot ${botId} PAIRING CODE: ${bot.pairCode}`)
            banner(`PAIRING CODE (${bot.label})`, bot.pairCode, 'WhatsApp > Linked devices > Link with phone number')
            writeCodeFile(`PAIRING-${botId}.txt`, `PAIRING CODE: ${bot.pairCode}\nWhatsApp > Linked devices > Link with phone number instead`)
          } catch(e) {
            bot.pairRequested = false
            bot.lastError = 'Pairing code error: ' + (e.message || e)
            recordError('pairing-'+botId, e)
          }
        }, 2000)
      }
    }

    if (connection==='open') {
      bot.status='open'
      bot.lastQr=null
      bot.pairCode=null
      bot.pairRequested=false
      bot.lastError=null
      bot.autoLinkTries=0
      bot.openedAt=Date.now()
      bot.history.push({ connectedAt:bot.openedAt, disconnectedAt:null, durationSec:0, reason:null })
      if (bot.history.length>20) bot.history.shift()
      removeCodeFile(`PAIRING-${botId}.txt`)
      const wait = bot.freshLink ? CFG.warmupSec : 2
      log(`Bot ${botId} (${bot.label}): Connected as ${s.user?.id||'?'} - ready in ${wait}s`)
      setTimeout(()=>{
        if (s===bot.sock && bot.status==='open') {
          bot.ready=true
          bot.freshLink=false
          log(`Bot ${botId} (${bot.label}): Ready for messages! 🟢`)
        }
      }, wait*1000)
    }

    if (connection==='close') {
      bot.ready=false
      const code = lastDisconnect?.error?.output?.statusCode
      const up = bot.openedAt ? Math.round((Date.now()-bot.openedAt)/1000) : 0
      const hist = bot.history[bot.history.length-1]
      if (hist && !hist.disconnectedAt) {
        hist.disconnectedAt=Date.now()
        hist.durationSec=up
        hist.reason = reasonName(code)||String(code||'unknown')
      }
      bot.openedAt=0
      const emsg = `${reasonName(code)} (${code}) ${lastDisconnect?.error?.message||''}`
      warn(`Bot ${botId}: connection closed: ${emsg} | session was up ${up}s`)

      if (code===DisconnectReason.loggedOut) {
        bot.lastQr=null
        bot.pairCode=null
        bot.pairRequested=false
        try { fs.rmSync(botAuth,{recursive:true,force:true}) } catch {}
        bot.status='loggedout'
        bot.lastError=`WhatsApp ended the session (code ${code}). Link again from Admin.`
        bot.reconnectTimer=setTimeout(()=>startBot(botId), 4000)
      } else if (code===DisconnectReason.connectionReplaced) {
        bot.status='closed'
        bot.lastError='Session active on another client (connectionReplaced).'
        bot.reconnectTimer=setTimeout(()=>startBot(botId), 15000)
      } else {
        bot.status='closed'
        bot.flaps = (Date.now()-bot.lastCloseAt<30000) ? bot.flaps+1 : 0
        bot.lastCloseAt=Date.now()
        if (bot.flaps>=4) recordError('whatsapp-'+botId, new Error(`Connection drops repeatedly (${bot.flaps}x). ${emsg}`),'WhatsApp')
        const delay = code===DisconnectReason.restartRequired ? 1000 : Math.min(2000 * (bot.flaps + 1), 25000)
        bot.reconnectTimer=setTimeout(()=>startBot(botId), delay)
      }
    }
  })
}

function stopBot(botId) {
  const bot=bots.get(botId); if(!bot) return
  clearTimeout(bot.reconnectTimer)
  bot.enabled=false
  if (bot.sock) { try { bot.sock.ev.removeAllListeners() } catch {}; try { bot.sock.end?.(undefined) } catch {} }
  bot.sock=null; bot.status='idle'; bot.ready=false; bot.lastQr=null; bot.pairCode=null
  saveBotsConfig()
}

function removeBot(botId) {
  stopBot(botId)
  bots.delete(botId)
  botsConfig=botsConfig.filter(b=>b.id!==botId)
  saveBotsConfig()
  try { fs.rmSync(path.join(AUTH_DIR,botId),{recursive:true,force:true}) } catch {}
  log(`Bot ${botId} removed`)
}

function addBot(label, botNumber='') {
  const id='bot'+Date.now()
  const cleanNumber = normalize(botNumber)
  const cfg={ id, label:label||'New Bot', enabled:true, botNumber:cleanNumber }
  botsConfig.push(cfg)
  const state=initBotState(cfg)
  saveBotsConfig()
  startBot(id)
  log(`Bot ${id} added: "${label}" (${cleanNumber ? '+'+cleanNumber : 'no number'})`)
  return id
}

function saveBotsConfig() {
  const arr=[]
  for (const bot of bots.values()) arr.push({ id:bot.id, label:bot.label, enabled:bot.enabled, botNumber:bot.botNumber })
  try { fs.writeFileSync(BOTS_FILE,JSON.stringify(arr,null,2)) } catch {}
}

function getBestBot(preferredId) {
  if (preferredId) {
    const b=bots.get(preferredId)
    if (b?.ready) return b
  }
  for (const bot of bots.values()) {
    if (bot.ready && bot.status==='open') return bot
  }
  return null
}

// Initialize all bots
function initBots() {
  for (const cfg of botsConfig) initBotState(cfg)
  for (const bot of bots.values()) if (bot.enabled) startBot(bot.id).catch(e=>recordError('startBot-'+bot.id,e))
}

// ======================= Message Queue =======================
function sendText(jid, text, preferBotId) {
  const bot = getBestBot(preferBotId)
  if (!bot) return Promise.reject(new Error('No bot ready. Please link a WhatsApp account from Admin > Bots.'))

  let resolveId, rejectId
  const p = new Promise((a,b)=>{ resolveId=a; rejectId=b })

  bot.chain = bot.chain.then(async () => {
    try {
      if (!bot.ready) throw new Error('bot not ready')
      try {
        await bot.sock.sendPresenceUpdate('composing',jid)
        await sleep(rand(1200,2500))
        await bot.sock.sendPresenceUpdate('paused',jid)
      } catch {}
      let m
      try { m=await bot.sock.sendMessage(jid,{text}) }
      catch(e) {
        warn(`Bot ${bot.id} send retry:`,e.message)
        await sleep(2000)
        if (!bot.ready) throw e
        m=await bot.sock.sendMessage(jid,{text})
      }
      const id=m?.key?.id
      if (!id) throw new Error('no message id returned')
      sentCache.set(id,m.message)
      sends.set(id,{ to:jid.split('@')[0], status:1, at:Date.now(), botId:bot.id })
      while (sentCache.size>300) sentCache.delete(sentCache.keys().next().value)
      while (sends.size>300) sends.delete(sends.keys().next().value)
      resolveId({ id, botId:bot.id })
    } catch(e) { rejectId(e) }
    await sleep(rand(1000,3000))
  })
  return p
}

// ======================= OTP Store =======================
let otps = new Map()
try { otps = new Map(Object.entries(JSON.parse(fs.readFileSync(DATA_FILE,'utf8')))) } catch {}
const persistOtps = () => { try { fs.writeFileSync(DATA_FILE,JSON.stringify(Object.fromEntries(otps))) } catch {} }

const sessions = new Map()
setInterval(() => {
  let ch=false
  for (const [k,v] of otps) if (Date.now()>v.expires+CFG.cooldownSec*1000) { otps.delete(k); ch=true }
  if (ch) persistOtps()
  for (const [t,exp] of sessions) if (exp<Date.now()) sessions.delete(t)
}, 60_000)

// ======================= Rate Limiting =======================
const ipHits  = new Map()
const sendLog = []
const hash    = x => crypto.createHash('sha256').update(x).digest('hex')

function ipAllowed(ip) {
  const t=Date.now(), arr=(ipHits.get(ip)||[]).filter(x=>t-x<3600_000)
  if (arr.length>=CFG.ipLimitPerHour) return false
  arr.push(t); ipHits.set(ip,arr); return true
}
function globalAllowed() {
  const t=Date.now()
  while (sendLog.length && t-sendLog[0]>3600_000) sendLog.shift()
  if (sendLog.length>=CFG.maxPerHour) return false
  sendLog.push(t); return true
}

// ======================= Admin Auth =======================
let adminCode=null, lastCodeReq=0
const loginFails=[]
function loginBlocked(ip) {
  const t=Date.now()
  while (loginFails.length && t-loginFails[0].t>600_000) loginFails.shift()
  return loginFails.length>=30 || loginFails.filter(f=>f.ip===ip).length>=5
}
function adminAuth(req,res,next) {
  const tok=(req.headers.authorization||'').replace(/^Bearer /,'')
  const exp=sessions.get(tok)
  if (!exp||exp<Date.now()) { sessions.delete(tok); return res.status(401).json({ok:false,error:'Login required'}) }
  next()
}
const safeEq = (x,y) => { const a=Buffer.from(String(x)),b=Buffer.from(String(y)); return a.length===b.length && crypto.timingSafeEqual(a,b) }

// ======================= Tunnel / Public URL =======================
function currentTunnelUrl() {
  const env=String(process.env.PUBLIC_URL||'').trim().replace(/\/+$/,'')
  if (env) return env
  try { const f=fs.readFileSync(FIXED_URL,'utf8').trim(); if(f) return f } catch {}
  const home=process.env.HOME||''
  for (const f of [TUNNEL_APP+'-error.log',TUNNEL_APP+'-out.log']) {
    try {
      const t=fs.readFileSync(path.join(home,'.pm2/logs',f),'utf8').slice(-30000)
      const m=t.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)
      if (m) return m[m.length-1]
    } catch {}
  }
  try { return fs.readFileSync(URL_FILE,'utf8').trim() } catch { return '' }
}

let publicOk=null, publicFails=0, publicCheckedAt=0
async function internetOk() {
  try { const r=await fetch('https://www.cloudflare.com/cdn-cgi/trace',{signal:AbortSignal.timeout(8000)}); return r.ok } catch { return false }
}
function restartTunnel(why) {
  if (!UNDER_PM2) return false
  execFile('pm2',['restart',TUNNEL_APP],{timeout:20000},(e,so,se)=>{
    if(e) recordError('tunnel',new Error(String(se||e.message).slice(0,200)),'pm2')
    else log(`Tunnel restarted (${why})`)
  })
  return true
}
async function checkPublic() {
  const url=currentTunnelUrl(); if(!url){publicOk=null;return}
  try { const r=await fetch(url+'/health',{signal:AbortSignal.timeout(10000),headers:{'user-agent':'otp-bot-watchdog'}}); publicOk=r.ok }
  catch { publicOk=false }
  publicCheckedAt=Date.now()
  if (publicOk) { publicFails=0; return }
  publicFails++
  if (CFG.tunnelWatchdog && UNDER_PM2 && publicFails>=5 && await internetOk()) { publicFails=0; restartTunnel('watchdog') }
}
setTimeout(checkPublic,20_000)
setInterval(checkPublic,60_000)

// ======================= Banner =======================
function banner(title,value,note) {
  const w=52, pad=s=>s+' '.repeat(Math.max(0,w-[...s].length))
  console.log(col.g('+'+'-'.repeat(w+2)+'+'))
  console.log(col.g('| ')+col.b(pad(title))+col.g(' |'))
  console.log(col.g('| ')+col.y(pad('   '+value))+col.g(' |'))
  if(note) console.log(col.g('| ')+pad(note)+col.g(' |'))
  console.log(col.g('+'+'-'.repeat(w+2)+'+'))
}

// ======================= Express App =======================
const app = express()
app.disable('x-powered-by')
const trustProxy=(() => { const v=process.env.TRUST_PROXY; if(!v)return 'loopback'; if(v==='true')return true; if(v==='false')return false; return /^\d+$/.test(v)?Number(v):v })()
app.set('trust proxy',trustProxy)
app.use(express.json({limit:'10kb'}))
app.use((req,res,next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  })
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  if (req.path.startsWith('/api/')) res.set('Cache-Control','no-store')
  next()
})
app.use(express.static(path.join(__dirname,'public')))
app.get('/admin', (req,res) => res.redirect('/admin.html'))
app.get('/app', (req,res) => res.redirect('/app.html'))

const anyReady = () => [...bots.values()].some(b=>b.ready)

// Health
app.get('/health', (req,res) => res.json({ok:true,name:APP_NAME,version:VERSION,status:anyReady()?'open':'idle',ready:anyReady(),uptime:Math.round(process.uptime()),bots:[...bots.values()].map(b=>({id:b.id,status:b.status,ready:b.ready}))}))
app.get('/api/status', (req,res) => res.json({name:APP_NAME,status:anyReady()?'open':'idle',ready:anyReady(),signupEnabled:CFG.signupEnabled,adminPassword:passwordEnabled}))

// Client errors
const clientErrHits=new Map()
app.post('/api/client-error',(req,res)=>{
  const t=Date.now(), arr=(clientErrHits.get(req.ip)||[]).filter(x=>t-x<60_000)
  if(arr.length>=20) return res.json({ok:true})
  arr.push(t); clientErrHits.set(req.ip,arr)
  const b=req.body||{}
  recordError('browser:'+String(b.page||'?').slice(0,20), String(b.message||'unknown').slice(0,300), (String(b.source||'').slice(0,120)+(b.line?':'+Number(b.line):''))||'(browser)')
  res.json({ok:true})
})

// ======================= OTP Handler =======================
async function handleSendOtp(req, res, isV1) {
  try {
    globalStats.requested++
    if (!CFG.signupEnabled && !isV1) return res.status(403).json({ok:false,error:'Signup is currently disabled.'})
    if (!anyReady()) return res.status(503).json({ok:false,error:'No bot is online. Please check Admin > Bots.'})
    if (!ipAllowed(req.ip)) return res.status(429).json({ok:false,error:'Too many requests from your IP.'})

    const number=normalize(req.body?.number)
    if (number.length<11||number.length>15) return res.status(400).json({ok:false,error:'Invalid phone number.'})
    if (CFG.restrictToAllowed && !allowedSet().has(number)) return res.status(403).json({ok:false,error:'This number is not on the allowed list.'})

    const prev=otps.get(number)
    const cd=CFG.cooldownSec*1000
    if (prev && Date.now()-prev.sentAt<cd) {
      const w=Math.ceil((cd-(Date.now()-prev.sentAt))/1000)
      return res.status(429).json({ok:false,error:`Please wait ${w}s before requesting again.`,wait:w})
    }
    if (!globalAllowed()) return res.status(429).json({ok:false,error:'Hourly send limit reached.'})

    checkDailyReset()
    if (dailyGlobal.count>=CFG.dailyLimit) return res.status(429).json({ok:false,error:'Daily OTP limit reached. Try again tomorrow.'})

    // Check WhatsApp exists
    const preferBotId=req.body?.botId
    const bot=getBestBot(preferBotId)
    if (!bot) return res.status(503).json({ok:false,error:'No bot ready. Link a WhatsApp account from Admin.'})

    let jid=number+'@s.whatsapp.net'
    try {
      const c=await bot.sock.onWhatsApp(jid)
      if (Array.isArray(c)) {
        const hit=c.find(x=>x.exists)
        if (!hit) return res.status(404).json({ok:false,error:'No WhatsApp account found for this number.'})
        jid=hit.jid
      }
    } catch(e) { warn('onWhatsApp check failed:',e.message) }

    const otp=String(crypto.randomInt(100000,1000000))
    otps.set(number,{hash:hash(otp),expires:Date.now()+CFG.otpTtlSec*1000,attempts:0,sentAt:Date.now()})
    persistOtps()

    const text=CFG.message.replace('{OTP}',otp).replace('{MINUTES}',Math.round(CFG.otpTtlSec/60))
    let msgId, usedBotId
    try {
      const result=await sendText(jid,text,preferBotId)
      msgId=result.id; usedBotId=result.botId
    } catch(e) {
      otps.delete(number); persistOtps()
      globalStats.failed++
      recordError('send-otp',e)
      return res.status(500).json({ok:false,error:'Could not send message. '+e.message})
    }

    globalStats.accepted++
    const usedBot=bots.get(usedBotId)
    if (usedBot) {
      usedBot.stats.accepted++
      const d=new Date().toISOString().split('T')[0]
      if (usedBot.dailySent.date!==d) usedBot.dailySent={date:d,count:0}
      usedBot.dailySent.count++
    }
    dailyGlobal.count++
    try { fs.writeFileSync(DAILY_FILE,JSON.stringify(dailyGlobal)) } catch {}
    if (isV1 && req.apiKey) { req.apiKey.usedToday++; saveApiKeys() }

    lastMsg.set(number,msgId)
    while (lastMsg.size>500) lastMsg.delete(lastMsg.keys().next().value)
    log(`OTP sent -> ${mask(number)} via ${usedBotId} | msg ${msgId.slice(0,6)}`)
    trackDelivery(msgId,usedBotId)
    res.json({ok:true,number,state:'sent'})
  } catch(e) {
    globalStats.failed++
    recordError('send-otp',e)
    res.status(500).json({ok:false,error:'Server error.'})
  }
}

app.post('/api/send-otp',         (req,res)=>handleSendOtp(req,res,false))
app.post('/api/v1/send-otp', apiKeyAuth, (req,res)=>handleSendOtp(req,res,true))

// Delivery status
const deliveryHits=new Map()
app.get('/api/delivery',(req,res)=>{
  const t=Date.now(), arr=(deliveryHits.get(req.ip)||[]).filter(x=>t-x<60_000)
  if(arr.length>=60) return res.status(429).json({ok:false})
  arr.push(t); deliveryHits.set(req.ip,arr)
  const id=lastMsg.get(normalize(req.query.number))
  const r=id&&sends.get(id)
  if(!r) return res.json({ok:true,known:false})
  res.json({ok:true,known:true,status:STATUS[r.status]||String(r.status),delivered:r.status>=3})
})

// Verify OTP
function handleVerify(req,res) {
  const number=normalize(req.body?.number)
  const otp=String(req.body?.otp||'').trim()
  const rec=otps.get(number)
  if (!rec) return res.status(400).json({ok:false,error:'Request a code first.'})
  if (Date.now()>rec.expires) { otps.delete(number); persistOtps(); return res.status(400).json({ok:false,error:'Code expired.'}) }
  if (++rec.attempts>MAX_ATTEMPTS) { otps.delete(number); persistOtps(); return res.status(429).json({ok:false,error:'Too many wrong attempts.'}) }
  if (hash(otp)!==rec.hash) { persistOtps(); return res.status(400).json({ok:false,error:'Wrong code.'}) }
  otps.delete(number); persistOtps(); globalStats.verified++
  res.json({ok:true,message:'Verified successfully'})
}
app.post('/api/verify-otp',         handleVerify)
app.post('/api/v1/verify-otp', apiKeyAuth, handleVerify)
app.get('/api/v1/status', apiKeyAuth, (req,res)=>res.json({name:APP_NAME,ready:anyReady(),bots:[...bots.values()].filter(b=>b.enabled).map(b=>({id:b.id,ready:b.ready,status:b.status}))}))

// ======================= Admin Routes =======================
app.post('/api/admin/request-code',(req,res)=>{
  if (loginBlocked(req.ip)) return res.status(429).json({ok:false,error:'Too many attempts. Wait 10 minutes.'})
  if (Date.now()-lastCodeReq<15_000) return res.status(429).json({ok:false,error:'Wait a few seconds.'})
  lastCodeReq=Date.now()
  if (!adminCode||adminCode.expires<Date.now()) adminCode={code:String(crypto.randomInt(100000,1000000)),expires:Date.now()+5*60_000}
  banner('ADMIN VERIFICATION CODE',adminCode.code,'Valid for 5 minutes')
  writeCodeFile('ADMIN-CODE.txt',`ADMIN VERIFICATION CODE: ${adminCode.code}\nValid until ${new Date(adminCode.expires).toISOString()}`)
  setTimeout(()=>{ if(!adminCode||adminCode.expires<Date.now()) removeCodeFile('ADMIN-CODE.txt') },5*60_000+1000)
  push('warn','Admin code printed in terminal')
  res.json({ok:true})
})

app.post('/api/admin/login',(req,res)=>{
  if (loginBlocked(req.ip)) return res.status(429).json({ok:false,error:'Too many attempts. Wait 10 minutes.'})
  const codeValid=adminCode&&adminCode.expires>=Date.now()
  if (!codeValid&&!passwordEnabled) return res.status(400).json({ok:false,error:'Request a code first.'})
  const given=String(req.body?.code||'').trim()
  const ok=(codeValid&&safeEq(given,adminCode.code))||(passwordEnabled&&safeEq(given,ADMIN_PASSWORD))
  if (!ok) { loginFails.push({ip:req.ip,t:Date.now()}); warn('Admin login: wrong code'); return res.status(400).json({ok:false,error:'Wrong code.'}) }
  if (codeValid&&safeEq(given,adminCode.code)) { adminCode=null; removeCodeFile('ADMIN-CODE.txt') }
  const token=crypto.randomBytes(24).toString('hex')
  sessions.set(token,Date.now()+2*3600_000)
  log('Admin login OK from',req.ip)
  res.json({ok:true,token})
})

app.post('/api/admin/logout-session',adminAuth,(req,res)=>{ sessions.delete((req.headers.authorization||'').replace(/^Bearer /,'')); res.json({ok:true}) })

app.get('/api/admin/state',adminAuth,(req,res)=>{
  res.json({
    ok:true, name:APP_NAME, version:VERSION,
    status: anyReady()?'open':'idle', ready:anyReady(),
    bots: [...bots.values()].map(b=>({
      id:b.id, label:b.label, status:b.status, ready:b.ready,
      botNumber:b.botNumber, me:b.sock?.user?.id||null,
      qr:b.lastQr, pairCode:b.pairCode, lastError:b.lastError,
      uptime: b.openedAt?Math.round((Date.now()-b.openedAt)/1000):0,
      history:b.history, dailySent:b.dailySent, stats:b.stats
    })),
    apiKeys: apiKeys.map(k=>({id:k.id,label:k.label,key:k.key.slice(0,8)+'...',dailyLimit:k.dailyLimit,usedToday:k.usedToday,enabled:k.enabled,createdAt:k.createdAt})),
    stats: globalStats, dailyGlobal,
    settings: {
      signupEnabled:CFG.signupEnabled, restrictToAllowed:CFG.restrictToAllowed,
      allowedNumbers:CFG.allowedNumbers, otpTtlSec:CFG.otpTtlSec, cooldownSec:CFG.cooldownSec,
      maxPerHour:CFG.maxPerHour, ipLimitPerHour:CFG.ipLimitPerHour, warmupSec:CFG.warmupSec,
      tunnelWatchdog:CFG.tunnelWatchdog, message:CFG.message, dailyLimit:CFG.dailyLimit
    },
    recent: [...sends.entries()].slice(-10).reverse().map(([id,r])=>({id:id.slice(0,8),to:mask(r.to),status:STATUS[r.status]||String(r.status),botId:r.botId,ageSec:Math.round((Date.now()-r.at)/1000)})),
    underPm2:UNDER_PM2, customDataDir:DATA_DIR!==__dirname, passwordEnabled,
    publicUrl:currentTunnelUrl(), publicOk, publicCheckedAt, fixedUrl:fs.existsSync(FIXED_URL),
    port:PORT, uptime:Math.round(process.uptime())
  })
})

app.get('/api/admin/console',adminAuth,(req,res)=>res.json({ok:true,logs:ring.slice(-100),errors:errors.slice().reverse()}))
app.post('/api/admin/console/clear',adminAuth,(req,res)=>{ errors.length=0; res.json({ok:true}) })

app.post('/api/admin/settings',adminAuth,(req,res)=>{
  const b=req.body||{}, upd={}
  if('signupEnabled'   in b) upd.signupEnabled   =!!b.signupEnabled
  if('restrictToAllowed' in b) upd.restrictToAllowed=!!b.restrictToAllowed
  if('tunnelWatchdog'  in b) upd.tunnelWatchdog  =!!b.tunnelWatchdog
  if('allowedNumbers'  in b) {
    const raw=Array.isArray(b.allowedNumbers)?b.allowedNumbers.join('\n'):String(b.allowedNumbers||'')
    upd.allowedNumbers=[...new Set(raw.split(/[\s,]+/).map(normalize).filter(n=>n.length>=11&&n.length<=15))]
  }
  for (const [k,min,max] of [['otpTtlSec',60,1800],['cooldownSec',30,600],['maxPerHour',1,500],['ipLimitPerHour',1,100],['warmupSec',0,300],['dailyLimit',1,100000]]) {
    if(k in b){ const n=Number(b[k]); if(!Number.isFinite(n)||n<min||n>max) return res.status(400).json({ok:false,error:`${k} must be between ${min} and ${max}`}); upd[k]=Math.round(n) }
  }
  if('message' in b){ const m=String(b.message); if(!m.includes('{OTP}')||m.length>500) return res.status(400).json({ok:false,error:'Message must contain {OTP} (max 500 chars)'}); upd.message=m }
  Object.assign(CFG,upd); saveConfig()
  log('Settings saved')
  res.json({ok:true})
})

// Bot management
app.get('/api/admin/bots',adminAuth,(req,res)=>res.json({ok:true,bots:[...bots.values()].map(b=>({id:b.id,label:b.label,status:b.status,ready:b.ready,botNumber:b.botNumber}))}))

app.post('/api/admin/bots/add',adminAuth,(req,res)=>{
  const label = String(req.body?.label||'New Bot').trim()
  const rawNum = req.body?.botNumber||''
  const botNumber = normalize(rawNum)
  const id=addBot(label, botNumber)
  res.json({ok:true,id,botNumber})
})

app.post('/api/admin/bots/:id/remove',adminAuth,(req,res)=>{
  if (!bots.has(req.params.id)) return res.status(404).json({ok:false,error:'Bot not found'})
  removeBot(req.params.id)
  res.json({ok:true})
})

app.post('/api/admin/bots/:id/update',adminAuth,(req,res)=>{
  const bot=bots.get(req.params.id)
  if (!bot) return res.status(404).json({ok:false,error:'Bot not found'})
  if (req.body?.label) bot.label = String(req.body.label).trim()
  if (req.body?.botNumber != null) bot.botNumber = normalize(req.body.botNumber)
  const found = botsConfig.find(b=>b.id===bot.id)
  if (found) {
    found.label = bot.label
    found.botNumber = bot.botNumber
  }
  saveBotsConfig()
  res.json({ok:true,bot:{id:bot.id,label:bot.label,botNumber:bot.botNumber}})
})

app.post('/api/admin/bots/:id/new-code',adminAuth,async(req,res)=>{
  const bot=bots.get(req.params.id)
  if (!bot) return res.status(404).json({ok:false,error:'Bot not found'})
  const mode=req.body?.mode==='qr'?'qr':'pair'
  bot.linkMode=mode; bot.autoLinkTries=0; bot.lastError=null; bot.pairRequested=false; bot.pairCode=null; bot.lastQr=null
  // If bot number changed
  if (req.body?.botNumber) {
    bot.botNumber=normalize(req.body.botNumber)
  }
  const found = botsConfig.find(b=>b.id===bot.id)
  if (found) {
    found.botNumber = bot.botNumber
    if (req.body?.label) found.label = String(req.body.label).trim()
  }
  saveBotsConfig()
  // Wipe auth and restart
  try { fs.rmSync(path.join(AUTH_DIR,bot.id),{recursive:true,force:true}) } catch {}
  log(`Bot ${bot.id}: generating new ${mode} code (phone: +${bot.botNumber})`)
  startBot(bot.id).catch(e=>recordError('startBot',e))
  res.json({ok:true,botNumber:bot.botNumber})
})

app.post('/api/admin/bots/:id/unlink',adminAuth,async(req,res)=>{
  const bot=bots.get(req.params.id)
  if (!bot) return res.status(404).json({ok:false,error:'Bot not found'})
  if (!req.body?.confirm) return res.status(409).json({ok:false,needConfirm:true,error:'Bot will be unlinked from WhatsApp.'})
  try { if(bot.sock) await Promise.race([bot.sock.logout(),sleep(5000)]) } catch {}
  try { fs.rmSync(path.join(AUTH_DIR,bot.id),{recursive:true,force:true}) } catch {}
  bot.autoLinkTries=0
  startBot(bot.id).catch(e=>recordError('startBot',e))
  res.json({ok:true})
})

app.post('/api/admin/bots/:id/restart',adminAuth,(req,res)=>{
  const bot=bots.get(req.params.id)
  if (!bot) return res.status(404).json({ok:false,error:'Bot not found'})
  bot.autoLinkTries=0; bot.lastError=null
  if (bot.sock) { try { bot.sock.end(new Error('manual restart')) } catch {} }
  else startBot(bot.id).catch(e=>recordError('startBot',e))
  res.json({ok:true})
})

// Direct Chat / Send custom message from specific bot
app.post('/api/admin/bots/:id/send', adminAuth, async (req, res) => {
  const bot = bots.get(req.params.id)
  if (!bot) return res.status(404).json({ ok: false, error: 'Bot not found' })
  if (!bot.ready || !bot.sock) {
    return res.status(503).json({ ok: false, error: `Bot "${bot.label}" is not connected or ready yet. Status: ${bot.status}` })
  }

  const rawNumber = req.body?.number
  const message = String(req.body?.message || '').trim()

  if (!rawNumber) return res.status(400).json({ ok: false, error: 'Recipient phone number is required.' })
  const number = normalize(rawNumber)
  if (number.length < 11 || number.length > 15) return res.status(400).json({ ok: false, error: 'Invalid phone number format (e.g. 03XXXXXXXXX or 923XXXXXXXXX).' })
  if (!message) return res.status(400).json({ ok: false, error: 'Message text cannot be empty.' })

  try {
    let jid = number + '@s.whatsapp.net'
    try {
      const c = await bot.sock.onWhatsApp(jid)
      if (Array.isArray(c)) {
        const hit = c.find(x => x.exists)
        if (!hit) return res.status(404).json({ ok: false, error: 'No WhatsApp account found for this recipient number.' })
        jid = hit.jid
      }
    } catch(e) {
      warn(`Bot ${bot.id} onWhatsApp check warning:`, e.message)
    }

    const { id: msgId } = await sendText(jid, message, bot.id)
    trackDelivery(msgId, bot.id)
    log(`Direct message sent via Bot ${bot.id} -> ${mask(number)} | msg: ${msgId.slice(0,6)}`)
    res.json({ ok: true, msgId, number, state: 'sent', botId: bot.id, botLabel: bot.label })
  } catch(e) {
    recordError('direct-send-'+bot.id, e)
    res.status(500).json({ ok: false, error: 'Failed to send message: ' + (e.message || e) })
  }
})

app.get('/api/admin/bots/:id/state',adminAuth,(req,res)=>{
  const bot=bots.get(req.params.id)
  if (!bot) return res.status(404).json({ok:false,error:'Bot not found'})
  res.json({ok:true,bot:{id:bot.id,label:bot.label,status:bot.status,ready:bot.ready,botNumber:bot.botNumber,me:bot.sock?.user?.id,qr:bot.lastQr,pairCode:bot.pairCode,lastError:bot.lastError,history:bot.history,stats:bot.stats,dailySent:bot.dailySent}})
})

// API Key management
app.get('/api/admin/keys',adminAuth,(req,res)=>res.json({ok:true,keys:apiKeys}))

app.post('/api/admin/keys/generate',adminAuth,(req,res)=>{
  const k={
    id:'k'+Date.now(),
    key: crypto.randomBytes(32).toString('hex'),
    label: String(req.body?.label||'API Key').slice(0,80),
    createdAt: Date.now(),
    enabled: true,
    dailyLimit: Math.max(0,parseInt(req.body?.dailyLimit)||0),
    usedToday: 0,
    lastUsedDate: ''
  }
  apiKeys.push(k); saveApiKeys()
  log(`API key generated: ${k.label}`)
  res.json({ok:true,key:k.key,id:k.id,label:k.label})
})

app.post('/api/admin/keys/:id/revoke',adminAuth,(req,res)=>{
  apiKeys=apiKeys.filter(k=>k.id!==req.params.id); saveApiKeys()
  res.json({ok:true})
})

app.post('/api/admin/keys/:id/toggle',adminAuth,(req,res)=>{
  const k=apiKeys.find(x=>x.id===req.params.id)
  if (k) { k.enabled=!k.enabled; saveApiKeys() }
  res.json({ok:true,enabled:k?.enabled})
})

app.put('/api/admin/keys/:id',adminAuth,(req,res)=>{
  const k=apiKeys.find(x=>x.id===req.params.id)
  if (k) {
    if (req.body?.label) k.label=String(req.body.label).slice(0,80)
    if ('dailyLimit' in req.body) k.dailyLimit=Math.max(0,parseInt(req.body.dailyLimit)||0)
    saveApiKeys()
  }
  res.json({ok:true})
})

// Tunnel management
app.post('/api/admin/check-public',adminAuth,async(req,res)=>{ await checkPublic(); res.json({ok:true,publicOk,publicUrl:currentTunnelUrl()}) })
app.post('/api/admin/restart-tunnel',adminAuth,(req,res)=>{
  if (!restartTunnel('admin')) return res.status(400).json({ok:false,error:'Not running under pm2.'})
  res.json({ok:true})
})

// Error handler
app.use((e,req,res,next)=>{
  if (e?.type==='entity.parse.failed') return res.status(400).json({ok:false,error:'Invalid JSON.'})
  recordError('express '+req.path,e)
  res.status(500).json({ok:false,error:'Server error.'})
})

// ======================= Start =======================
const server=app.listen(PORT,HOST,()=>{
  console.log('')
  console.log(col.g(col.b(`  ${APP_NAME} v${VERSION}`)))
  log(`Listening on ${HOST}:${PORT} | Node ${process.version} | ${UNDER_PM2?'pm2 mode':'standalone'}`)
  log(`Local:  http://localhost:${PORT}   Admin: /admin.html`)
  log(`Data:   ${DATA_DIR}`)
  log(`Public: ${currentTunnelUrl()||'(not set)'}`)
  log(`Admin login: open /admin.html -> Request Code -> check this console${CODE_FILES?' or ADMIN-CODE.txt':''}${passwordEnabled?' (ADMIN_PASSWORD also works)':''}`)
})
server.on('error',e=>{ recordError('http',e); console.error(col.r(`ERROR: ${e.message}`)); process.exit(1) })

setInterval(()=>log(`Heartbeat: ready=${anyReady()} bots=${[...bots.values()].filter(b=>b.ready).length}/${bots.size} up=${Math.round(process.uptime()/60)}m accepted=${globalStats.accepted} delivered=${globalStats.delivered} today=${dailyGlobal.count}`),10*60_000)

// Start bots
initBots()
