const express = require('express')
const http = require('http')
const path = require('path')
const WebSocket = require('ws')
const fs = require('fs')
const os = require('os')
const { spawn, spawnSync } = require('child_process')
const multer = require('multer')
const APP_PORT = parseInt(process.env.PORT || '3000', 10)
const VIEWPORT = { width: 1280, height: 800 }
const MAX_FPS = Math.max(5, Math.min(60, parseInt(process.env.MAX_FPS || '15', 10)))
const FRAME_INTERVAL_MS = Math.round(1000 / MAX_FPS)
let jpegQuality = Math.max(10, Math.min(95, parseInt(process.env.JPEG_QUALITY || '60', 10)))
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
function ensureModule(name, version) {
  try { return require(name) } catch (e) {
    try {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
      spawnSync(npm, ['install', `${name}@${version}`, '--no-audit', '--no-fund'], { stdio: 'inherit', timeout: 120000 })
      return require(name)
    } catch (e2) { return null }
  }
}
const Archiver = ensureModule('archiver', '5.3.1')
const Tar = ensureModule('tar', '6.1.11')
const Unzipper = ensureModule('unzipper', '0.10.11')
const AdmZip = ensureModule('adm-zip', '0.5.9')
let puppeteer
try {
  const puppeteerExtra = require('puppeteer-extra')
  const StealthPlugin = require('puppeteer-extra-plugin-stealth')
  puppeteerExtra.use(StealthPlugin())
  puppeteer = puppeteerExtra
} catch (e) {
  try { puppeteer = require('puppeteer') } catch (err) { console.error('Install dependencies: npm install'); process.exit(1) }
}
const SESSION_FILE = path.join(__dirname, 'session_state.json')
const userDataDir = process.env.USER_DATA_DIR || path.join(__dirname, 'chrome-profile')
const LOCAL_UPDATE_FILE = path.join(__dirname, 'update_local.json')
function loadSessionState() {
  try { if (fs.existsSync(SESSION_FILE)) return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8') || '{}') } catch (e) {}
  return {}
}
function saveSessionState(state) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(state || {}, null, 2), 'utf8') } catch (e) {}
}
function loadLocalUpdate() {
  try { if (fs.existsSync(LOCAL_UPDATE_FILE)) return JSON.parse(fs.readFileSync(LOCAL_UPDATE_FILE, 'utf8') || '{}') } catch (e) {}
  return { version: 'v2.2.4', channel: 'stable' }
}
function saveLocalUpdate(obj) {
  try { fs.writeFileSync(LOCAL_UPDATE_FILE, JSON.stringify(obj || {}, null, 2), 'utf8') } catch (e) {}
}
let browser = null
let launchOptions = null
let ffmpegProcess = null
let silentAudioInterval = null
let audioAvailable = false
async function restartBrowser() {
  try {
    if (browser) { try { await browser.close() } catch (e) {} browser = null }
    browser = await puppeteer.launch(launchOptions)
    return browser
  } catch (e) {
    throw e
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
const UPDATE_CHANNELS = {
  stable: {
    repoUrl: 'https://github.com/Hutlaw/remote-browser-stable',
    rawBase: 'https://raw.githubusercontent.com/Hutlaw/remote-browser-stable/main'
  },
  unstable: {
    repoUrl: 'https://github.com/Hutlaw/remote-browser-unstable',
    rawBase: 'https://raw.githubusercontent.com/Hutlaw/remote-browser-unstable/main'
  }
}
async function fetchJson(url) {
  try {
    if (typeof fetch !== 'function') {
      const nf = require('node-fetch')
      return nf(url).then(r => r.json())
    } else {
      const r = await fetch(url)
      return await r.json()
    }
  } catch (e) { throw e }
}
async function fetchText(url) {
  try {
    if (typeof fetch !== 'function') {
      const nf = require('node-fetch')
      return nf(url).then(r => r.text())
    } else {
      const r = await fetch(url)
      return await r.text()
    }
  } catch (e) { throw e }
}
async function downloadFileToPath(rawUrl, destPath) {
  try {
    const txt = await fetchText(rawUrl)
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    fs.writeFileSync(destPath, txt, 'utf8')
    return true
  } catch (e) { return false }
}
async function performUpdate(channel, wss) {
  try {
    const info = UPDATE_CHANNELS[channel]
    if (!info) throw new Error('unknown channel')
    const rcfgUrl = `${info.rawBase}/update_config.json`
    const remoteCfg = await fetchJson(rcfgUrl)
    const files = Array.isArray(remoteCfg.files) ? remoteCfg.files : ['server.js','public/index.html','package.json','install-deps.sh']
    const version = remoteCfg.version || 'unknown'
    const tmpDir = path.join(os.tmpdir(), `update_${Date.now()}`)
    fs.mkdirSync(tmpDir, { recursive: true })
    const fetched = []
    for (const f of files) {
      const raw = `${info.rawBase}/${f}`
      const out = path.join(tmpDir, f)
      const ok = await downloadFileToPath(raw, out)
      if (ok) fetched.push({ f, out }) else throw new Error('failed to download ' + f)
    }
    const backupDir = path.join(__dirname, 'backups', `${Date.now()}`)
    fs.mkdirSync(backupDir, { recursive: true })
    for (const item of fetched) {
      const rel = item.f
      const target = path.join(__dirname, rel)
      if (fs.existsSync(target)) {
        const destBk = path.join(backupDir, rel)
        fs.mkdirSync(path.dirname(destBk), { recursive: true })
        fs.renameSync(target, destBk)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(item.out, target)
    }
    saveLocalUpdate({ version, channel })
    broadcastAll(wss, { type: 'update-applied', version, channel })
    setTimeout(() => { process.exit(0) }, 1200)
    return { ok: true, version }
  } catch (e) {
    return { ok: false, message: String(e) }
  }
}
async function start() {
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true })
  try { fs.chmodSync(userDataDir, 0o700) } catch (e) {}
  const uploadsDir = path.join(userDataDir, 'uploads')
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
  const downloadsDir = path.join(userDataDir, 'downloads')
  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true })
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2,8)}-${file.originalname}`)
  })
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
      const localUpd = loadLocalUpdate()
      const stats = { pid: process.pid, userDataDir, appPort: APP_PORT, platform: os.platform(), arch: os.arch(), uptime: process.uptime(), memory: process.memoryUsage(), audioAvailable, sessionState: st, jpegQuality, localUpdate: localUpd }
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
  app.get('/dev/check-updates', async (req, res) => {
    try {
      const channel = String(req.query.channel || 'stable')
      const info = UPDATE_CHANNELS[channel]
      if (!info) return res.status(400).json({ ok: false, message: 'unknown channel' })
      const rcfgUrl = `${info.rawBase}/update_config.json`
      let remoteCfg = null
      try { remoteCfg = await fetchJson(rcfgUrl) } catch (e) { return res.status(500).json({ ok: false, message: 'failed to fetch remote config: ' + String(e) }) }
      const remoteVersion = remoteCfg.version || 'unknown'
      const local = loadLocalUpdate()
      const hasUpdate = remoteVersion !== (local.version || '')
      return res.json({ ok: true, channel, remoteVersion, localVersion: local.version || '', hasUpdate, files: remoteCfg.files || [] })
    } catch (e) { res.status(500).json({ ok: false, message: String(e) }) }
  })
  app.post('/dev/download-update', express.json(), async (req, res) => {
    try {
      const channel = String(req.body.channel || 'stable')
      const info = UPDATE_CHANNELS[channel]
      if (!info) return res.status(400).json({ ok: false, message: 'unknown channel' })
      const result = await performUpdate(channel, wss)
      if (result.ok) return res.json({ ok: true, version: result.version })
      else return res.status(500).json({ ok: false, message: result.message })
    } catch (e) { res.status(500).json({ ok: false, message: String(e) }) }
  })
  app.get('/dev/export', (req, res) => {
    try {
      const wantFull = String(req.query.full || '0') === '1'
      const includeSession = fs.existsSync(SESSION_FILE)
      const includeProfile = fs.existsSync(userDataDir)
      if (!includeSession && !includeProfile) return res.status(404).send('nothing to export')
      const filename = wantFull ? 'exported_profile_full.tar.gz' : 'exported_profile_min.tar.gz'
      res.setHeader('Content-Type', 'application/octet-stream')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      broadcastAll(wss, { type: 'export-start', filename, wantFull })
      if (Archiver) {
        const archive = Archiver('tar', { gzip: true, gzipOptions: { level: 9 } })
        archive.on('warning', () => {})
        archive.on('error', () => {})
        archive.on('progress', (progress) => { try { broadcastAll(wss, { type: 'export-progress', processedBytes: progress.fsBytes || 0, entries: { processed: progress.entries.processed || 0 } }) } catch (e) {} })
        archive.on('end', () => { broadcastAll(wss, { type: 'export-complete' }) })
        archive.pipe(res)
        if (includeSession) archive.file(SESSION_FILE, { name: path.posix.join('session_state', path.basename(SESSION_FILE)) })
        if (includeProfile && wantFull) archive.directory(userDataDir, 'profile')
        else if (includeProfile) {
          const minimal = [
            path.join(userDataDir, 'Default', 'Bookmarks'),
            path.join(userDataDir, 'Default', 'Preferences'),
            path.join(userDataDir, 'Default', 'Cookies'),
            path.join(userDataDir, 'Extensions')
          ]
          for (const p of minimal) {
            try {
              if (fs.existsSync(p)) {
                const stat = fs.statSync(p)
                if (stat.isDirectory()) archive.directory(p, path.posix.join('profile', path.relative(userDataDir, p)))
                else archive.file(p, { name: path.posix.join('profile', path.relative(userDataDir, p)) })
              }
            } catch (e) {}
          }
        }
        archive.finalize().catch(() => {})
        return
      }
      if (Tar) {
        const items = []
        if (includeSession) items.push(path.relative(__dirname, SESSION_FILE))
        if (includeProfile) {
          if (wantFull) items.push(path.relative(__dirname, userDataDir))
          else {
            const minimal = [
              path.join(userDataDir, 'Default', 'Bookmarks'),
              path.join(userDataDir, 'Default', 'Preferences'),
              path.join(userDataDir, 'Default', 'Cookies'),
              path.join(userDataDir, 'Extensions')
            ]
            for (const p of minimal) if (fs.existsSync(p)) items.push(path.relative(__dirname, p))
          }
        }
        if (!items.length) return res.status(404).send('nothing to export')
        const tarStream = Tar.c({ gzip: true, cwd: __dirname }, items)
        tarStream.on('close', () => broadcastAll(wss, { type: 'export-complete' }))
        tarStream.pipe(res)
        return
      }
      res.status(500).send('No archiver available')
    } catch (e) { try { if (!res.headersSent) res.status(500).send(String(e)) } catch (ee) {} }
  })
  app.post('/dev/import', uploadMw.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ ok: false, message: 'no file uploaded' })
      const uploadedPath = req.file.path
      const tmpDir = path.join(os.tmpdir(), `import_${Date.now()}`)
      fs.mkdirSync(tmpDir, { recursive: true })
      broadcastAll(wss, { type: 'import-start', name: req.file.originalname })
      let extracted = false
      let entriesCount = 0
      const lower = uploadedPath.toLowerCase()
      try {
        if ((lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) && Tar) {
          await Tar.x({ file: uploadedPath, cwd: tmpDir, gzip: true, onentry: (entry) => { entriesCount++; broadcastAll(wss, { type: 'import-progress', entriesProcessed: entriesCount, name: entry.path }) } })
          extracted = true
        } else if ((lower.endsWith('.zip') || lower.endsWith('.jar')) && Unzipper) {
          await new Promise((resolve, reject) => {
            const stream = fs.createReadStream(uploadedPath).pipe(Unzipper.Parse())
            stream.on('entry', (entry) => {
              entriesCount++
              broadcastAll(wss, { type: 'import-progress', entriesProcessed: entriesCount, name: entry.path })
              const filePath = path.join(tmpDir, entry.path)
              if (entry.type === 'Directory') {
                fs.mkdirSync(filePath, { recursive: true })
                entry.autodrain()
              } else {
                const dir = path.dirname(filePath)
                fs.mkdirSync(dir, { recursive: true })
                entry.pipe(fs.createWriteStream(filePath))
              }
            })
            stream.on('close', resolve)
            stream.on('error', reject)
          })
          extracted = true
        } else if (AdmZip) {
          const zip = new AdmZip(uploadedPath)
          const zipEntries = zip.getEntries()
          for (const ze of zipEntries) { entriesCount++; broadcastAll(wss, { type: 'import-progress', entriesProcessed: entriesCount, name: ze.entryName }) }
          zip.extractAllTo(tmpDir, true)
          extracted = true
        } else {
          const sp = spawnSync('tar', ['-xzf', uploadedPath, '-C', tmpDir], { timeout: 0 })
          if (sp.status === 0) extracted = true
        }
      } catch (e) {
        rimrafSync(tmpDir)
        try { fs.unlinkSync(uploadedPath) } catch (e2) {}
        broadcastAll(wss, { type: 'import-error', message: String(e) })
        return res.status(500).json({ ok: false, message: 'extraction failed: ' + String(e) })
      }
      if (!extracted) {
        rimrafSync(tmpDir)
        try { fs.unlinkSync(uploadedPath) } catch (e) {}
        broadcastAll(wss, { type: 'import-error', message: 'no extraction method available' })
        return res.status(500).json({ ok: false, message: 'no extraction method available' })
      }
      broadcastAll(wss, { type: 'import-extracted', entries: entriesCount })
      try { if (browser) { try { await browser.close() } catch (e) {} browser = null } } catch (e) {}
      let extractedProfileRoot = null
      const candidate = path.join(tmpDir, 'profile')
      if (fs.existsSync(candidate)) extractedProfileRoot = candidate
      if (!extractedProfileRoot) {
        const walk = (base) => {
          const stack = [base]
          while (stack.length) {
            const cur = stack.pop()
            try {
              const entries = fs.readdirSync(cur)
              for (const e of entries) {
                const full = path.join(cur, e)
                try {
                  const st = fs.statSync(full)
                  if (st.isDirectory()) {
                    const inner = fs.readdirSync(full)
                    if (inner.includes('Default') || inner.includes('Bookmarks') || inner.includes('Preferences')) return full
                    stack.push(full)
                  }
                } catch (ee) {}
              }
            } catch (e) {}
          }
          return null
        }
        extractedProfileRoot = walk(tmpDir)
      }
      if (extractedProfileRoot && fs.existsSync(extractedProfileRoot)) {
        try { rimrafSync(userDataDir) } catch (e) {}
        try { fs.renameSync(extractedProfileRoot, userDataDir) } catch (e) {
          try {
            const copyRecursive = (src, dest) => {
              const stat = fs.statSync(src)
              if (stat.isDirectory()) {
                if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true })
                for (const f of fs.readdirSync(src)) copyRecursive(path.join(src, f), path.join(dest, f))
              } else {
                const dir = path.dirname(dest)
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
                fs.copyFileSync(src, dest)
              }
            }
            copyRecursive(extractedProfileRoot, userDataDir)
          } catch (err) {}
        }
      }
      const possibleSessionFiles = []
      const walkFiles = (base) => {
        const stack = [base]
        while (stack.length) {
          const cur = stack.pop()
          try {
            const entries = fs.readdirSync(cur)
            for (const e of entries) {
              const full = path.join(cur, e)
              try {
                const st = fs.statSync(full)
                if (st.isDirectory()) stack.push(full)
                else if (e.toLowerCase() === 'session_state.json') possibleSessionFiles.push(full)
              } catch (ee) {}
            }
          } catch (e) {}
        }
      }
      walkFiles(tmpDir)
      let applied = { profile: false, session: false }
      if (fs.existsSync(userDataDir)) applied.profile = true
      if (possibleSessionFiles.length) {
        try { fs.copyFileSync(possibleSessionFiles[0], SESSION_FILE); applied.session = true } catch (e) {}
      }
      try { fs.unlinkSync(uploadedPath) } catch (e) {}
      rimrafSync(tmpDir)
      try { browser = await puppeteer.launch(launchOptions) } catch (e) {
        broadcastAll(wss, { type: 'import-finish', ok: true, message: 'import applied but browser restart failed. Restart server manually.', applied })
        return res.json({ ok: true, message: 'import applied but browser restart failed. Restart server manually.', applied })
      }
      broadcastAll(wss, { type: 'import-finish', ok: true, message: 'import applied and browser restarted', applied })
      return res.json({ ok: true, message: 'import applied and browser restarted', applied })
    } catch (e) { res.status(500).json({ ok: false, message: String(e) }) }
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
    page.on('response', async (response) => {
      try {
        const headers = response.headers()
        const cd = headers['content-disposition'] || headers['Content-Disposition']
        if (!cd || !/attachment/i.test(cd)) return
        const method = response.request().method()
        if (method !== 'GET') return
        const buffer = await response.buffer()
        const size = buffer.length
        if (size < 1024) return
        const mime = headers['content-type'] || 'application/octet-stream'
        if (mime && String(mime).startsWith('image/')) return
        let filename = 'download'
        const m1 = String(cd).match(/filename\*=UTF-8''([^;]+)/)
        const m2 = String(cd).match(/filename="?([^";]+)"?/)
        if (m1) filename = decodeURIComponent(m1[1])
        else if (m2) filename = m2[1]
        const safeName = filename.replace(/[^a-zA-Z0-9._-]/g,'_')
        const id = makeId()
        const localPath = path.join(downloadsDir, `${Date.now()}-${id}-${safeName}`)
        fs.writeFileSync(localPath, buffer)
        const token = id
        downloadTokens.set(token, { path: localPath, filename, mime, size, savedAt: Date.now() })
      } catch (e) {}
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
  wsaudio.on('connection', (ws) => {})
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
