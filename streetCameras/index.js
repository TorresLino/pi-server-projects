import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import express from 'express'
import Handlebars from 'handlebars'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const PORT = parseInt(process.env.PORT, 10) || 3000
const OUTPUT_DIR = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : path.join(__dirname, 'timelapses')
const TEMPLATE_PATH = process.env.TEMPLATE_PATH
  ? path.resolve(process.env.TEMPLATE_PATH)
  : path.join(__dirname, 'views', 'dashboard.hbs')
const MEMORY_THRESHOLD_BYTES =
  parseInt(process.env.MEMORY_THRESHOLD_BYTES, 10) || 1024 * 1024 * 1024
const FPS = parseInt(process.env.FPS, 10) || 25
const JITTER_MIN_MS = parseInt(process.env.JITTER_MIN_MS, 10) || 2000
const JITTER_MAX_MS = parseInt(process.env.JITTER_MAX_MS, 10) || 18000

const DEFAULT_CAMERAS = [
  { id: 'loc76', url: 'https://trafficcam.calgary.ca/ss/0/loc76.jpg' },
  { id: 'loc45', url: 'https://trafficcam.calgary.ca/ss/0/loc45.jpg' },
]

function parseCamerasEnv(envVal) {
  if (!envVal) return DEFAULT_CAMERAS
  try {
    const parsed = JSON.parse(envVal)
    if (Array.isArray(parsed) && parsed.length > 0) return parsed
  } catch {
    const pairs = envVal
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const sepIdx = entry.indexOf('=')
        if (sepIdx === -1) return null
        return {
          id: entry.slice(0, sepIdx).trim(),
          url: entry.slice(sepIdx + 1).trim(),
        }
      })
      .filter((item) => item && item.id && item.url)
    if (pairs.length > 0) return pairs
  }
  return DEFAULT_CAMERAS
}

const CAMERAS = parseCamerasEnv(process.env.CAMERAS)

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
}

const dashboardTemplate = Handlebars.compile(fs.readFileSync(TEMPLATE_PATH, 'utf8'))

const workers = new Map()

function getNextOddMinuteDelay() {
  const now = new Date()
  const target = new Date(now.getTime())

  target.setSeconds(0, 0)
  target.setMinutes(target.getMinutes() + 1)

  if (target.getMinutes() % 2 === 0) {
    target.setMinutes(target.getMinutes() + 1)
  }

  const jitterSpan = Math.max(0, JITTER_MAX_MS - JITTER_MIN_MS)
  const jitterMs = Math.floor(Math.random() * jitterSpan) + JITTER_MIN_MS
  target.setTime(target.getTime() + jitterMs)

  return target.getTime() - now.getTime()
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function compileVideo(camId, camDir, framesToEncode, customLabel = null) {
  return new Promise((resolve) => {
    if (!framesToEncode || framesToEncode.length === 0) {
      return resolve(null)
    }

    const timestamp = customLabel || new Date().toISOString().replace(/[:.]/g, '-')
    const outputPath = path.join(camDir, `${camId}_${timestamp}.mp4`)

    console.log(`[${camId}] Encoding ${framesToEncode.length} frames to ${outputPath}...`)

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-r', String(FPS),
      '-i', '-',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '23',
      '-preset', 'fast',
      outputPath,
    ])

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`[${camId}] Video saved successfully: ${outputPath}`)
      } else {
        console.error(`[${camId}] FFmpeg exited with error code ${code}`)
      }

      framesToEncode.length = 0
      if (global.gc) {
        global.gc()
      }

      resolve(outputPath)
    })

    (async () => {
      for (let i = 0; i < framesToEncode.length; i++) {
        const canContinue = ffmpeg.stdin.write(framesToEncode[i].buffer)
        framesToEncode[i] = null

        if (!canContinue) {
          await new Promise((r) => ffmpeg.stdin.once('drain', r))
        }
      }
      ffmpeg.stdin.end()
    })()
  })
}

export function createCameraWorker(cam) {
  const camDir = path.join(OUTPUT_DIR, cam.id)
  if (!fs.existsSync(camDir)) {
    fs.mkdirSync(camDir, { recursive: true })
  }

  const state = {
    id: cam.id,
    url: cam.url,
    frameBuffer: [],
    currentBufferBytes: 0,
    isEncoding: false,
    batchDate: getLocalDateString(),
    lastCaptureTime: null,
    lastCaptureStatus: 'Idle',
    latestJpegBuffer: null,
    timer: null,
  }

  workers.set(cam.id, state)

  const fetchAndBuffer = async () => {
    try {
      const today = getLocalDateString()

      if (today !== state.batchDate && state.frameBuffer.length > 0 && !state.isEncoding) {
        console.log(`[${cam.id}] Midnight cutover reached (${state.batchDate} -> ${today}). Flushing daily video...`)
        state.isEncoding = true
        const oldFrames = state.frameBuffer
        const oldDate = state.batchDate

        state.frameBuffer = []
        state.currentBufferBytes = 0
        state.batchDate = today

        await compileVideo(cam.id, camDir, oldFrames, `day_${oldDate}`)
        state.isEncoding = false
      }

      const response = await fetch(`${cam.url}?t=${Date.now()}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible TimelapseBot/1.0)',
          'Cache-Control': 'no-cache',
        },
      })

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`)
      }

      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      state.latestJpegBuffer = buffer
      state.frameBuffer.push({ buffer, timestamp: Date.now() })
      state.currentBufferBytes += buffer.length
      state.lastCaptureTime = new Date().toISOString()
      state.lastCaptureStatus = 'Success'

      const mbUsed = (state.currentBufferBytes / (1024 * 1024)).toFixed(2)
      console.log(`[${cam.id}] Frame captured (${(buffer.length / 1024).toFixed(1)} KB) | Total RAM: ${mbUsed} MB`)

      if (state.currentBufferBytes >= MEMORY_THRESHOLD_BYTES && !state.isEncoding) {
        console.log(`[${cam.id}] Memory threshold reached. Triggering export...`)
        state.isEncoding = true
        const framesToEncode = state.frameBuffer
        state.frameBuffer = []
        state.currentBufferBytes = 0

        await compileVideo(cam.id, camDir, framesToEncode)
        state.isEncoding = false
      }
    } catch (err) {
      state.lastCaptureStatus = `Error: ${err.message}`
      console.error(`[${cam.id}] Fetch failed:`, err.message)
    }
  }

  const scheduleNext = () => {
    const delayMs = getNextOddMinuteDelay()
    state.timer = setTimeout(async () => {
      await fetchAndBuffer()
      scheduleNext()
    }, delayMs)
  }

  const initialDelay = getNextOddMinuteDelay()
  console.log(`[${cam.id}] First capture scheduled in ${(initialDelay / 1000).toFixed(1)}s`)
  state.timer = setTimeout(async () => {
    await fetchAndBuffer()
    scheduleNext()
  }, initialDelay)

  return state
}

CAMERAS.forEach((cam) => createCameraWorker(cam))

const app = express()

app.use('/timelapses', express.static(OUTPUT_DIR))

app.get('/', (req, res) => {
  const cameras = Array.from(workers.entries()).map(([camId, state]) => {
    const camVideoDir = path.join(OUTPUT_DIR, camId)
    const videos = fs.existsSync(camVideoDir)
      ? fs.readdirSync(camVideoDir).filter((f) => f.endsWith('.mp4')).sort().reverse()
      : []

    return {
      id: camId,
      frameCount: state.frameBuffer.length,
      mbUsed: (state.currentBufferBytes / (1024 * 1024)).toFixed(2),
      lastCaptureStatus: state.lastCaptureStatus,
      lastCaptureFormatted: state.lastCaptureTime
        ? new Date(state.lastCaptureTime).toLocaleTimeString()
        : 'None',
      videos,
    }
  })

  const html = dashboardTemplate({
    cameraCount: CAMERAS.length,
    fps: FPS,
    cameras,
  })

  res.send(html)
})

app.get('/api/latest/:camId', (req, res) => {
  const state = workers.get(req.params.camId)
  if (!state || !state.latestJpegBuffer) {
    return res.status(404).send('No image available yet')
  }
  res.setHeader('Content-Type', 'image/jpeg')
  res.send(state.latestJpegBuffer)
})

app.post('/api/export/:camId', async (req, res) => {
  const state = workers.get(req.params.camId)
  if (!state) {
    return res.status(404).json({ error: 'Camera not found' })
  }
  if (state.isEncoding) {
    return res.status(400).json({ error: 'Already encoding a video for this camera' })
  }
  if (state.frameBuffer.length === 0) {
    return res.status(400).json({ error: 'Buffer is empty, no frames to export' })
  }

  state.isEncoding = true
  const framesToEncode = state.frameBuffer
  state.frameBuffer = []
  state.currentBufferBytes = 0

  const camDir = path.join(OUTPUT_DIR, state.id)
  const outPath = await compileVideo(
    state.id,
    camDir,
    framesToEncode,
    `manual_${new Date().toISOString().replace(/[:.]/g, '-')}`
  )
  state.isEncoding = false

  res.json({ success: true, message: `Video compiled successfully: ${path.basename(outPath)}` })
})

const server = app.listen(PORT, () => {
  console.log(`Timelapse server running at http://localhost:${PORT}`)
})

async function handleShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}. Flushing all buffers to video before exiting...`)

  server.close()
  for (const state of workers.values()) {
    if (state.timer) clearTimeout(state.timer)
  }

  const exportPromises = []
  for (const [camId, state] of workers.entries()) {
    if (state.frameBuffer.length > 0) {
      console.log(`[${camId}] Saving remaining ${state.frameBuffer.length} frames...`)
      const camDir = path.join(OUTPUT_DIR, camId)
      exportPromises.push(
        compileVideo(
          camId,
          camDir,
          state.frameBuffer,
          `shutdown_${new Date().toISOString().replace(/[:.]/g, '-')}`
        )
      )
    }
  }

  await Promise.all(exportPromises)
  console.log('[Shutdown] All videos safely compiled. Exiting.')
  process.exit(0)
}

process.on('SIGINT', () => handleShutdown('SIGINT'))
process.on('SIGTERM', () => handleShutdown('SIGTERM'))

export { app, workers }