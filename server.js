const express = require('express')
const http = require('http')
const path = require('path')
const WebSocket = require('ws')
const fs = require('fs')
const os = require('os')
const { spawn, spawnSync } = require('child_process')
const multer = require('multer')
const Tar = (() => { try { return require('tar') } catch(e){ return null } })()
const APP_PORT = parseInt(process.env.PORT || '3000', 10)
const VIEWPORT = { width: 1280, height: 800 }
const MAX_FPS = Math.max(5, Math.min(60, parseInt(process.env.MAX_FPS || '15', 10)))
const FRAME_INTERVAL_MS = Math.round(1000 / MAX_FPS)
let jpegQuality = Math.max(10, Math.min(95, parseInt(process.env.JPEG_QUALITY || '60', 10)))
let fetchFunc = null
if (typeof globalThis.fetch === 'function') fetchFunc = globalThis.fetch.bind(globalThis)
else {
  try {
    const nf = require('node-fetch')
    fetchFunc = (nf && nf.default) ? nf.default : nf
  } catch (e) {
    fetchFunc = null
  }
}
function execOk(cmd) {
  try {
    const r = spawnSync(cmd, ['-version'], { timeout: 2000 })
    return r.status === 0
  } catch (e) {
    return false
  }
}
function makeId() {
  return Math.random().toString(36).slice(2, 10)
}
function rimrafSync(p) {
  try {
    if (!fs.existsSync(p)) return
    try { fs.rmSync(p, { recursive: true, force: true }); return } catch (e) {}
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) rimrafSync(path.join(p, f))
      try { fs.rmdirSync(p) } catch (e) {}
    } else fs.unlinkSync(p)
  } catch (e) {}
}
const SESSION_FILE = path.join(__dirname, 'session_state.json')
const userDataDir = process.env.USER_DATA_DIR || path.join(__dirname, 'chrome-profile')
function loadSessionState() {
  try { if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8') || '{}') } catch (e) {}
  return {}
}
function saveSessionState(state) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(state || {}, null, 2), 'utf8') } catch (e) {}
}
let puppeteer
try {
  const puppeteerExtra = require('puppeteer-extra')
  const StealthPlugin = require('puppeteer-extra-plugin-stealth')
  puppeteerExtra.use(StealthPlugin())
  puppeteer = puppeteerExtra
} catch (e) {
  try { puppeteer = require('puppeteer') } catch (err) { console.error('Install dependencies: npm install'); process.exit(1) }
}
let browser = null
let launchOptions = null
let ffmpegProcess = null
let silentAudioInterval = null
let audioAvailable = false

function getUpdateConfigPath(channel) {
  const candidate = path.join(__dirname, channel, 'update_config.json')
  if (fs.existsSync(candidate)) return candidate
  const fallback = path.join(__dirname, 'update_config.json')
  return fallback
}

async function getLatestInfoForChannel(channel) {
  try {
    const cfgPath = getUpdateConfigPath(channel)
    let cfg = { repo: null, currentVersion: null }
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch (e) {}
    const repo = cfg.repo || (channel === 'stable' ? 'Hutlaw/remote-browser-stable' : 'Hutlaw/remote-browser-unstable')
    const apiBase = 'https://api.github.com/repos/' + repo
    const headers = { 'User-Agent': 'remote-browser-updater/1' }
    if (!fetchFunc) return { ok: false, message: 'fetch not available' }
    if (channel === 'stable') {
      const resp = await fetchFunc(apiBase + '/releases/latest', { headers })
      if (!resp.ok) return { ok: false, message: 'release fetch failed', status: resp.status }
      const j = await resp.json()
      const latestVersion = j.tag_name || j.name || j.id || null
      const tarballUrl = j.tarball_url || j.tarball_url || null
      return { ok: true, latestVersion, tarballUrl, name: j.name || null }
    } else {
      const resp = await fetchFunc(apiBase + '/commits?per_page=1', { headers })
      if (!resp.ok) return { ok: false, message: 'commits fetch failed', status: resp.status }
      const arr = await resp.json()
      if (!arr || !arr.length) return { ok: false, message: 'no commits' }
      const sha = arr[0].sha
      const latestVersion = sha
      const tarballUrl = apiBase + '/tarball/' + sha
      return { ok: true, latestVersion, tarballUrl, name: arr[0].commit && arr[0].commit.message ? arr[0].commit.message.split('\n')[0] : null }
    }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
}

async function downloadToFile(url, destPath) {
  return new Promise(async (resolve, reject) => {
    try {
      if (!fetchFunc) return reject(new Error('fetch not available'))
      const resp = await fetchFunc(url, { headers: { 'User-Agent': 'remote-browser-updater/1', 'Accept': 'application/octet-stream' } })
      if (!resp.ok) return reject(new Error('download failed status ' + resp.status))
      const fileStream = fs.createWriteStream(destPath)
      resp.body.pipe(fileStream)
      resp.body.on('error', (err) => { try { fileStream.close() } catch (e) {} reject(err) })
      fileStream.on('finish', () => fileStream.close(() => resolve()))
      fileStream.on('error', (err) => { try { fileStream.close() } catch (e) {} reject(err) })
    } catch (e) { reject(e) }
  })
}

async function applyUpdateFromTarball(tarballPath, tmpDir) {
  try {
    if (Tar) {
      await Tar.x({ file: tarballPath, cwd: tmpDir, gzip: true })
      return true
    } else {
      const sp = spawnSync('tar', ['-xzf', tarballPath, '-C', tmpDir], { timeout: 0 })
      return sp.status === 0
    }
  } catch (e) {
    return false
  }
}

function findFileInExtracted(root, filename) {
  try {
    const stack = [root]
    while (stack.length) {
      const cur = stack.pop()
      const entries = fs.readdirSync(cur)
      for (const e of entries) {
        const full = path.join(cur, e)
        const st = fs.statSync(full)
        if (st.isDirectory()) {
          stack.push(full)
        } else {
          if (e === filename) return full
        }
      }
    }
  } catch (e) {}
  return null
}

function backupAndReplace(src, dest) {
  try {
    if (fs.existsSync(dest)) {
      const bak = dest + '.bak.' + Date.now()
      try { fs.copyFileSync(dest, bak) } catch (e) {}
    }
    const destDir = path.dirname(dest)
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true })
    fs.copyFileSync(src, dest)
    try { fs.chmodSync(dest, 0o644) } catch (e) {}
    return true
  } catch (e) {
    return false
  }
}

function broadcastAll(wsServer, obj) {
  const s = JSON.stringify(obj)
  wsServer.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s) })
}

function startAudioCapture(wsaudio, sendBroadcast) {
  if (ffmpegProcess || silentAudioInterval) return
  if (execOk('ffmpeg')) {
    try {
      ffmpegProcess = spawn('ffmpeg', ['-f', 'pulse', '-i', 'default', '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'], { stdio: ['ignore', 'pipe', 'inherit'] })
      audioAvailable = true
      sendBroadcast({ type: 'audio-available', available: true })
      ffmpegProcess.stdout.on('data', (chunk) => {
        wsaudio.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(chunk) })
      })
      ffmpegProcess.on('close', () => {
        ffmpegProcess = null
        audioAvailable = false
        sendBroadcast({ type: 'audio-available', available: false })
      })
      return
    } catch (e) {}
  }
  audioAvailable = true
  sendBroadcast({ type: 'audio-available', available: true })
  const sampleRate = 48000
  const chunkDurationMs = 100
  const samplesPerChunk = Math.floor(sampleRate * (chunkDurationMs / 1000))
  const buf = Buffer.alloc(samplesPerChunk * 2)
  silentAudioInterval = setInterval(() => {
    try { wsaudio.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(buf) }) } catch (e) {}
  }, chunkDurationMs)
}

function stopAudioCapture(wsaudio, sendBroadcast) {
  try {
    if (ffmpegProcess) { ffmpegProcess.kill('SIGTERM'); ffmpegProcess = null }
  } catch (e) {}
  try { if (silentAudioInterval) clearInterval(silentAudioInterval); silentAudioInterval = null } catch (e) {}
  audioAvailable = false
  sendBroadcast({ type: 'audio-available', available: false })
  try { wsaudio.clients.forEach((c) => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'audio-available', available: false })) }) } catch (e) {}
}

async function restartBrowser() {
  try {
    if (browser) { try { await browser.close() } catch (e) {} browser = null }
    browser = await puppeteer.launch(launchOptions)
    return browser
  } catch (e) { throw e }
}

async function start() {
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true })
  try { fs.chmodSync(userDataDir, 0o700) } catch (e) {}
  const uploadsDir = path.join(userDataDir, 'uploads'); if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
  const downloadsDir = path.join(userDataDir, 'downloads'); if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true })
  const storage = multer.diskStorage({ destination: (req, file, cb) => cb(null, uploadsDir), filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${file.originalname}`) })
  const uploadMw = multer({ storage })
  launchOptions = { args: ['--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-gpu', '--disable-blink-features=AutomationControlled', '--disable-infobars', '--no-default-browser-check', '--disable-extensions', '--start-maximized'], headless: true }
  if (process.env.HEADFUL === '1') launchOptions.headless = false
  if (process.env.NO_SANDBOX === '1' || process.env.FORCE_NO_SANDBOX === '1') launchOptions.args.unshift('--no-sandbox', '--disable-setuid-sandbox')
  if (process.env.CHROME_PATH) launchOptions.executablePath = process.env.CHROME_PATH
  if (userDataDir) launchOptions.userDataDir = userDataDir
  browser = await puppeteer.launch(launchOptions)
  const app = express()
  app.use(express.static(path.join(__dirname, 'public')))
  app.get('/__health', (req, res) => res.json({ ok: true, pid: process.pid, userDataDir }))
  app.post('/upload', uploadMw.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, message: 'no file' })
      const session = Object.values(sessions)[0]
      if (!session || !session.tab) return res.status(404).json({ ok: false, message: 'no active tab' })
      const localPath = req.file.path
      try {
        const handle = await session.tab.page.evaluateHandle(() => {
          const ae = document.activeElement
          if (ae && ae.tagName === 'INPUT' && ae.type === 'file') return ae
          return null
        })
        let elementHandle = null
        try { if (handle && handle.asElement()) elementHandle = handle.asElement() } catch (e) { elementHandle = null }
        if (!elementHandle) {
          const inputs = await session.tab.page.$$('input[type=file]')
          if (inputs && inputs.length) elementHandle = inputs[0]
        }
        if (!elementHandle) return res.status(400).json({ ok: false, message: 'no file input found on the page' })
        await elementHandle.uploadFile(localPath)
        res.json({ ok: true })
      } catch (e) { res.status(500).json({ ok: false, message: String(e) }) }
    } catch (err) { res.status(500).json({ ok: false, message: String(err) }) }
  })
  let downloadTokens = new Map()
  app.get('/download', (req, res) => {
    const token = String(req.query.token || '')
    if (!token) return res.status(400).send('missing token')
    const info = downloadTokens.get(token)
    if (!info) return res.status(404).send('not found')
    const stat = fs.existsSync(info.path) ? fs.statSync(info.path) : null
    if (!stat) return res.status(404).send('file missing')
    res.setHeader('Content-Type', info.mime || 'application/octet-stream')
    res.setHeader('Content-Disposition', `attachment; filename="${info.filename.replace(/"/g, '\\"')}"`)
    const stream = fs.createReadStream(info.path)
    stream.pipe(res)
  })
  app.get('/dev/state', (req, res) => {
    try {
      const st = loadSessionState()
      const stats = { pid: process.pid, userDataDir, appPort: APP_PORT, platform: os.platform(), arch: os.arch(), uptime: process.uptime(), memory: process.memoryUsage(), audioAvailable, sessionState: st, jpegQuality }
      res.json({ ok: true, stats })
    } catch (e) { res.status(500).json({ ok: false, message: String(e) }) }
  })

  app.post('/dev/set-quality', express.json(), (req, res) => {
    try {
      const q = Number(req.body.quality)
      if (!Number.isFinite(q) || q < 10 || q > 95) return res.status(400).json({ ok: false, message: 'quality must be 10-95' })
      jpegQuality = Math.round(q)
      Object.values(sessions).forEach(s => {
        try {
          if (s.tab && s.tab.cdp) {
            stopScreencastForTab(s.tab).catch(()=>{})
            startScreencastForTab(s, s.tab).catch(()=>{})
          }
        } catch (e) {}
      })
      res.json({ ok: true, quality: jpegQuality })
    } catch (e) { res.status(500).json({ ok: false, message: String(e) }) }
  })

  app.get('/dev/version', (req, res) => {
    try {
      const stablePath = getUpdateConfigPath('stable')
      const unstablePath = getUpdateConfigPath('unstable')
      let stable = null, unstable = null
      try { stable = JSON.parse(fs.readFileSync(stablePath, 'utf8')) } catch (e) { stable = null }
      try { unstable = JSON.parse(fs.readFileSync(unstablePath, 'utf8')) } catch (e) { unstable = null }
      res.json({ ok: true, stable, unstable })
    } catch (e) { res.status(500).json({ ok: false, message: String(e) }) }
  })

  app.get('/dev/check-updates', async (req, res) => {
    try {
      const channel = String(req.query.channel || 'stable')
      const info = await getLatestInfoForChannel(channel)
      try {
        const cfgPath = getUpdateConfigPath(channel)
        const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
        cfg.lastChecked = new Date().toISOString()
        if (info.ok) cfg.tarballUrl = info.tarballUrl || cfg.tarballUrl || null
        try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8') } catch (e) {}
      } catch (e) {}
      res.json(info)
    } catch (e) { res.status(500).json({ ok: false, message: String(e) }) }
  })

  app.post('/dev/apply-update', uploadMw.single('file'), async (req, res) => {
    try {
      const body = req.body || {}
      const channel = String(body.channel || 'stable')
      const cfgPath = getUpdateConfigPath(channel)
      const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : { repo: (channel === 'stable' ? 'Hutlaw/remote-browser-stable' : 'Hutlaw/remote-browser-unstable') }
      const repo = cfg.repo
      const useUploaded = !!req.file
      const tmpDir = path.join(os.tmpdir(), `update_${Date.now()}`)
      fs.mkdirSync(tmpDir, { recursive: true })
      let tarballPath = null
      if (useUploaded) {
        tarballPath = req.file.path
      } else {
        const info = await getLatestInfoForChannel(channel)
        if (!info.ok || !info.tarballUrl) { rimrafSync(tmpDir); return res.status(500).json({ ok: false, message: 'failed to get tarball info' }) }
        tarballPath = path.join(tmpDir, 'repo.tar.gz')
        try {
          await downloadToFile(info.tarballUrl, tarballPath)
        } catch (e) {
          rimrafSync(tmpDir)
          return res.status(500).json({ ok: false, message: 'download failed: ' + String(e) })
        }
      }
      const extractedDir = path.join(tmpDir, 'extracted')
      fs.mkdirSync(extractedDir, { recursive: true })
      const okExtract = await applyUpdateFromTarball(tarballPath, extractedDir)
      if (!okExtract) {
        rimrafSync(tmpDir)
        try { if (useUploaded) fs.unlinkSync(tarballPath) } catch (e) {}
        return res.status(500).json({ ok: false, message: 'extraction failed' })
      }
      const entries = fs.readdirSync(extractedDir)
      let rootDir = extractedDir
      if (entries.length === 1) {
        const first = path.join(extractedDir, entries[0])
        try { if (fs.statSync(first).isDirectory()) rootDir = first } catch (e) {}
      }
      const targets = ['server.js', path.join('public','index.html'), 'package.json', 'install-deps.sh']
      const applied = {}
      for (const t of targets) {
        const found = findFileInExtracted(rootDir, path.basename(t))
        if (!found) { applied[t] = false; continue }
        const dest = path.join(__dirname, t)
        const ok = backupAndReplace(found, dest)
        applied[t] = !!ok
      }
      try {
        const now = new Date().toISOString()
        cfg.currentVersion = (await getLatestInfoForChannel(channel)).latestVersion || cfg.currentVersion || null
        cfg.lastApplied = now
        cfg.tarballUrl = cfg.tarballUrl || null
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
      } catch (e) {}
      try { if (!useUploaded) fs.unlinkSync(tarballPath) } catch (e) {}
      rimrafSync(tmpDir)
      return res.json({ ok: true, applied, restartRequired: true, message: 'update applied to files. server process must be restarted to use new code.' })
    } catch (e) { return res.status(500).json({ ok: false, message: String(e) }) }
  })

  const server = http.createServer(app)
  const wss = new WebSocket.Server({ noServer: true })
  const wsaudio = new WebSocket.Server({ noServer: true })
  const sessions = {}
  server.on('upgrade', (request, socket, head) => {
    if (request.url.startsWith('/ws')) wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request) })
    else if (request.url.startsWith('/audio')) wsaudio.handleUpgrade(request, socket, head, (ws) => { wsaudio.emit('connection', ws, request) })
    else socket.destroy()
  })

  async function applyStealthLikeHardening(page) {
    try {
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
      await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36')
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false })
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] })
        window.chrome = window.chrome || { runtime: {} }
      })
    } catch (e) {}
  }

  async function createSingleTab(session, url) {
    const page = await browser.newPage()
    await page.setViewport(VIEWPORT)
    await applyStealthLikeHardening(page)
    const cdp = await page.target().createCDPSession()
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    const tab = { page, cdp, url: url || 'about:blank', lastFrameTs: 0, sendingFrame: false }
    await page.exposeFunction(`__fileInputActivated`, () => {
      try { if (session && session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ type: 'file-request' })) } catch (e) {}
    })
    await page.evaluateOnNewDocument(() => {
      document.addEventListener('click', (e) => {
        try {
          let el = e.target
          while (el) {
            if (el.tagName === 'INPUT' && el.type === 'file') {
              try { window.__fileInputActivated() } catch (e) {}
              break
            }
            el = el.parentElement
          }
        } catch (e) {}
      }, true)
    })
    tab.cdp.on('Page.screencastFrame', async (event) => {
      const now = Date.now()
      await tab.cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId })
      if (!session.tab) return
      if (now - tab.lastFrameTs < FRAME_INTERVAL_MS) return
      if (tab.sendingFrame) return
      tab.lastFrameTs = now
      try {
        const buf = Buffer.from(event.data, 'base64')
        tab.sendingFrame = true
        session.ws.send(buf, { binary: true }, () => { tab.sendingFrame = false })
      } catch (e) { tab.sendingFrame = false }
    })
    session.tab = tab
    if (url) try { await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }) } catch (e) {}
    return tab
  }

  async function startScreencastForTab(session, tab) {
    if (!tab || !tab.cdp) return
    try { await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality: jpegQuality, everyNthFrame: 1 }) } catch (e) {}
  }
  async function stopScreencastForTab(tab) {
    if (!tab || !tab.cdp) return
    try { await tab.cdp.send('Page.stopScreencast') } catch (e) {}
  }

  wss.on('connection', async (ws) => {
    const id = makeId()
    const session = { id, ws, tab: null, lastUserActivityTs: Date.now() }
    sessions[id] = session
    try {
      const saved = loadSessionState()
      const startUrl = saved.url || 'https://www.google.com'
      await createSingleTab(session, startUrl)
      await startScreencastForTab(session, session.tab)
      ws.send(JSON.stringify({ type: 'init', width: VIEWPORT.width, height: VIEWPORT.height, maxFps: MAX_FPS, connId: id, audioAvailable }))
      ws.on('message', async (msg) => {
        session.lastUserActivityTs = Date.now()
        try {
          let text = null
          if (typeof msg === 'string') text = msg
          else if (msg instanceof Buffer) text = msg.toString()
          else if (msg instanceof ArrayBuffer) text = Buffer.from(msg).toString()
          else text = String(msg)
          const data = JSON.parse(text)
          const tab = session.tab
          if (!tab) return
          if (data.type === 'mouse') {
            const x = Math.round(Number(data.x || 0))
            const y = Math.round(Number(data.y || 0))
            if (data.action === 'move') tab.page.mouse.move(x, y).catch(()=>{})
            else if (data.action === 'down') { await tab.page.mouse.move(x, y).catch(()=>{}); await tab.page.mouse.down({ button: data.button || 'left', clickCount: data.clickCount || 1 }) }
            else if (data.action === 'up') { await tab.page.mouse.move(x, y).catch(()=>{}); await tab.page.mouse.up({ button: data.button || 'left', clickCount: data.clickCount || 1 }) }
            else if (data.action === 'click') { await tab.page.mouse.move(x, y).catch(()=>{}); await tab.page.mouse.click(x, y, { button: data.button || 'left', clickCount: data.clickCount || 1 }) }
          } else if (data.type === 'scroll') {
            const dx = Number(data.deltaX || 0)
            const dy = Number(data.deltaY || data.delta || 0)
            const px = Number(data.x || Math.floor(VIEWPORT.width/2))
            const py = Number(data.y || Math.floor(VIEWPORT.height/2))
            try { await tab.page.mouse.wheel({ deltaX: dx, deltaY: dy }) } catch (e) {}
            try { await tab.page.evaluate((a,b,x,y) => {
                const target = document.elementFromPoint(Math.floor(x), Math.floor(y)) || document.scrollingElement || document.body
                target.dispatchEvent(new WheelEvent('wheel', { deltaX: a, deltaY: b, bubbles: true, cancelable: true }))
              }, dx, dy, px, py) } catch (e) {}
            try {
              const pos = await tab.page.evaluate(() => ({scrollX: window.scrollX, scrollY: window.scrollY}))
              const st = loadSessionState()
              st.scrollX = pos.scrollX
              st.scrollY = pos.scrollY
              saveSessionState(st)
            } catch (e) {}
          } else if (data.type === 'keyboard') {
            if (data.action === 'press') await tab.page.keyboard.press(String(data.key || ''), { delay: data.delay || 0 })
            else if (data.action === 'type') await tab.page.keyboard.type(String(data.text || ''), { delay: data.delay || 0 })
            else if (data.action === 'down') await tab.page.keyboard.down(String(data.key))
            else if (data.action === 'up') await tab.page.keyboard.up(String(data.key))
          } else if (data.type === 'navigate') {
            if (typeof data.url === 'string') {
              try { await tab.page.goto(data.url, { waitUntil: 'networkidle2', timeout: 30000 }) } catch (e) {}
              tab.url = data.url
              const st = loadSessionState(); st.url = data.url; st.scrollX = 0; st.scrollY = 0; saveSessionState(st)
              ws.send(JSON.stringify({ type: 'navigated', url: data.url }))
            }
          } else if (data.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })) }
        } catch (err) { try { ws.send(JSON.stringify({ type: 'error', message: String(err) })) } catch (e) {} }
      })
      ws.on('close', async () => {
        try { if (session.tab && session.tab.page) try { await session.tab.page.close() } catch (e) {} delete sessions[id] } catch (e) {}
      })
      ws.on('error', async () => {
        try { if (session.tab && session.tab.page) try { await session.tab.page.close() } catch (e) {} delete sessions[id] } catch (e) {}
      })
    } catch (err) {
      try { ws.send(JSON.stringify({ type: 'error', message: String(err) })) } catch (e) {}
      delete sessions[id]
    }
  })

  wsaudio.on('connection', (ws) => {
    ws.isSource = false
    ws.on('message', (msg) => {
      if (typeof msg === 'string') {
        try { const d = JSON.parse(msg); if (d && d.type === 'source-announce') { ws.isSource = true } } catch (e) {}
        return
      }
      if (msg instanceof Buffer || msg instanceof ArrayBuffer) {
        wsaudio.clients.forEach(c => {
          if (c !== ws && c.readyState === WebSocket.OPEN && !c.isSource) {
            try { c.send(msg) } catch (e) {}
          }
        })
      }
    })
  })

  startAudioCapture(wsaudio, (obj) => broadcastAll(wss, obj))

  server.listen(APP_PORT, '0.0.0.0', () => {
    const addr = server.address()
    console.log(`Server listening on http://${addr.address}:${addr.port}`)
  }).on('error', (err) => { console.error('Failed to bind server:', err); process.exit(1) })

  process.on('SIGINT', async () => {
    try { broadcastAll(wss, { type: 'server-shutdown', message: 'server is shutting down' }) } catch (e) {}
    try { Object.values(sessions).forEach(s => { try { s.ws.send(JSON.stringify({ type: 'warning', message: 'Server shutting down' })) } catch (e) {} }) } catch (e) {}
    try { stopAudioCapture(wsaudio, (obj) => broadcastAll(wss, obj)) } catch (e) {}
    try { if (browser) await browser.close() } catch (e) {}
    setTimeout(() => process.exit(0), 250)
  })
  process.on('SIGTERM', async () => {
    try { broadcastAll(wss, { type: 'server-shutdown', message: 'server is shutting down' }) } catch (e) {}
    try { Object.values(sessions).forEach(s => { try { s.ws.send(JSON.stringify({ type: 'warning', message: 'Server shutting down' })) } catch (e) {} }) } catch (e) {}
    try { stopAudioCapture(wsaudio, (obj) => broadcastAll(wss, obj)) } catch (e) {}
    try { if (browser) await browser.close() } catch (e) {}
    setTimeout(() => process.exit(0), 250)
  })
}
start().catch((err) => { console.error(err); process.exit(1) })
