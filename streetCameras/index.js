import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import Handlebars from 'handlebars';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT, 10) || 3000;
const OUTPUT_DIR = process.env.OUTPUT_DIR
  ? path.resolve(process.env.OUTPUT_DIR)
  : path.join(__dirname, 'timelapses');
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'cameras.db');
const TEMPLATE_PATH = process.env.TEMPLATE_PATH
  ? path.resolve(process.env.TEMPLATE_PATH)
  : path.join(__dirname, 'dashboard.hbs');
const MEMORY_THRESHOLD_BYTES =
  parseInt(process.env.MEMORY_THRESHOLD_BYTES, 10) || 1024 * 1024 * 1024;
const FPS = parseInt(process.env.FPS, 10) || 25;
const JITTER_MIN_MS = parseInt(process.env.JITTER_MIN_MS, 10) || 2000;
const JITTER_MAX_MS = parseInt(process.env.JITTER_MAX_MS, 10) || 18000;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS cameras (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const dashboardTemplate = Handlebars.compile(fs.readFileSync(TEMPLATE_PATH, 'utf8'));

const workers = new Map();

function getNextOddMinuteDelay() {
  const now = new Date();
  const target = new Date(now.getTime());

  target.setSeconds(0, 0);
  target.setMinutes(target.getMinutes() + 1);

  if (target.getMinutes() % 2 === 0) {
    target.setMinutes(target.getMinutes() + 1);
  }

  const jitterSpan = Math.max(0, JITTER_MAX_MS - JITTER_MIN_MS);
  const jitterMs = Math.floor(Math.random() * jitterSpan) + JITTER_MIN_MS;
  target.setTime(target.getTime() + jitterMs);

  return target.getTime() - now.getTime();
}

function getLocalDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function compileVideo(camId, camDir, framesToEncode, customLabel = null) {
  return new Promise((resolve) => {
    if (!framesToEncode || framesToEncode.length === 0) {
      return resolve(null);
    }

    const timestamp = customLabel || new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = path.join(camDir, `${camId}_${timestamp}.mp4`);

    console.log(`[${camId}] Encoding ${framesToEncode.length} frames to ${outputPath}...`);

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
    ]);

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`[${camId}] Video saved successfully: ${outputPath}`);
      } else {
        console.error(`[${camId}] FFmpeg exited with error code ${code}`);
      }

      framesToEncode.length = 0;
      if (global.gc) {
        global.gc();
      }

      resolve(outputPath);
    });

    (async () => {
      for (let i = 0; i < framesToEncode.length; i++) {
        const canContinue = ffmpeg.stdin.write(framesToEncode[i].buffer);
        framesToEncode[i] = null;

        if (!canContinue) {
          await new Promise((r) => ffmpeg.stdin.once('drain', r));
        }
      }
      ffmpeg.stdin.end();
    })();
  });
}

function stopWorkerTimer(state) {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

export function createCameraWorker(cam) {
  const existing = workers.get(cam.id);
  if (existing) {
    existing.url = cam.url;
    existing.enabled = Boolean(cam.enabled);
    if (existing.enabled && !existing.timer) {
      scheduleWorker(existing);
    } else if (!existing.enabled) {
      stopWorkerTimer(existing);
      existing.lastCaptureStatus = 'Paused';
    }
    return existing;
  }

  const camDir = path.join(OUTPUT_DIR, cam.id);
  fs.mkdirSync(camDir, { recursive: true });

  const state = {
    id: cam.id,
    url: cam.url,
    enabled: Boolean(cam.enabled),
    frameBuffer: [],
    currentBufferBytes: 0,
    isEncoding: false,
    batchDate: getLocalDateString(),
    lastCaptureTime: null,
    lastCaptureStatus: cam.enabled ? 'Idle' : 'Paused',
    latestJpegBuffer: null,
    timer: null,
  };

  workers.set(cam.id, state);

  if (state.enabled) {
    scheduleWorker(state, true);
  }

  return state;
}

function scheduleWorker(state, isInitial = false) {
  stopWorkerTimer(state);
  if (!state.enabled) return;

  const delayMs = getNextOddMinuteDelay();
  if (isInitial) {
    console.log(`[${state.id}] First capture scheduled in ${(delayMs / 1000).toFixed(1)}s`);
  }

  state.timer = setTimeout(async () => {
    if (!state.enabled || !workers.has(state.id)) return;
    await fetchAndBuffer(state);
    if (state.enabled && workers.has(state.id)) {
      scheduleWorker(state, false);
    }
  }, delayMs);
}

async function fetchAndBuffer(state) {
  const camDir = path.join(OUTPUT_DIR, state.id);
  fs.mkdirSync(camDir, { recursive: true });

  try {
    const today = getLocalDateString();

    if (today !== state.batchDate && state.frameBuffer.length > 0 && !state.isEncoding) {
      console.log(`[${state.id}] Midnight cutover reached (${state.batchDate} -> ${today}). Flushing daily video...`);
      state.isEncoding = true;
      const oldFrames = state.frameBuffer;
      const oldDate = state.batchDate;

      state.frameBuffer = [];
      state.currentBufferBytes = 0;
      state.batchDate = today;

      await compileVideo(state.id, camDir, oldFrames, `day_${oldDate}`);
      state.isEncoding = false;
    }

    const response = await fetch(`${state.url}?t=${Date.now()}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TimelapseBot/1.0)',
        'Cache-Control': 'no-cache',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    state.latestJpegBuffer = buffer;
    state.frameBuffer.push({ buffer, timestamp: Date.now() });
    state.currentBufferBytes += buffer.length;
    state.lastCaptureTime = new Date().toISOString();
    state.lastCaptureStatus = 'Success';

    const mbUsed = (state.currentBufferBytes / (1024 * 1024)).toFixed(2);
    console.log(`[${state.id}] Frame captured (${(buffer.length / 1024).toFixed(1)} KB) | Total RAM: ${mbUsed} MB`);

    if (state.currentBufferBytes >= MEMORY_THRESHOLD_BYTES && !state.isEncoding) {
      console.log(`[${state.id}] Memory threshold reached. Triggering export...`);
      state.isEncoding = true;
      const framesToEncode = state.frameBuffer;
      state.frameBuffer = [];
      state.currentBufferBytes = 0;

      await compileVideo(state.id, camDir, framesToEncode);
      state.isEncoding = false;
    }
  } catch (err) {
    state.lastCaptureStatus = `Error: ${err.message}`;
    console.error(`[${state.id}] Fetch failed:`, err.message);
  }
}

function syncWorkersFromDb() {
  const rows = db.prepare('SELECT id, url, enabled FROM cameras ORDER BY created_at ASC, id ASC').all();
  const activeIds = new Set(rows.map((r) => r.id));

  for (const [camId, state] of workers.entries()) {
    if (!activeIds.has(camId)) {
      stopWorkerTimer(state);
      workers.delete(camId);
    }
  }

  for (const row of rows) {
    createCameraWorker(row);
  }

  return rows;
}

function restartWorkersFromDb() {
  for (const state of workers.values()) {
    stopWorkerTimer(state);
  }
  workers.clear();
  return syncWorkersFromDb();
}

syncWorkersFromDb();

const app = express();
app.use(express.json());
app.use('/timelapses', express.static(OUTPUT_DIR));

app.get('/', (req, res) => {
  const rows = db.prepare('SELECT id, url, enabled FROM cameras ORDER BY created_at ASC, id ASC').all();
  const cameras = rows.map((row) => {
    const state = workers.get(row.id) || {
      frameBuffer: [],
      currentBufferBytes: 0,
      lastCaptureStatus: row.enabled ? 'Idle' : 'Paused',
      lastCaptureTime: null,
    };
    const camVideoDir = path.join(OUTPUT_DIR, row.id);
    const videos = fs.existsSync(camVideoDir)
      ? fs.readdirSync(camVideoDir).filter((f) => f.endsWith('.mp4')).sort().reverse()
      : [];

    return {
      id: row.id,
      url: row.url,
      enabled: Boolean(row.enabled),
      frameCount: state.frameBuffer.length,
      mbUsed: (state.currentBufferBytes / (1024 * 1024)).toFixed(2),
      lastCaptureStatus: state.lastCaptureStatus,
      lastCaptureFormatted: state.lastCaptureTime
        ? new Date(state.lastCaptureTime).toLocaleTimeString()
        : 'None',
      videos,
    };
  });

  const html = dashboardTemplate({
    cameraCount: cameras.length,
    fps: FPS,
    dbPath: DB_PATH,
    cameras,
  });

  res.send(html);
});

app.post('/api/workers/restart', (req, res) => {
  const rows = restartWorkersFromDb();
  res.json({
    success: true,
    cameraCount: rows.length,
    message: `Restarted workers and reloaded ${rows.length} camera(s) from SQLite`,
  });
});

app.get('/api/cameras', (req, res) => {
  const rows = db.prepare('SELECT id, url, enabled, created_at, updated_at FROM cameras ORDER BY created_at ASC, id ASC').all();
  res.json(rows.map((r) => ({ ...r, enabled: Boolean(r.enabled) })));
});

app.post('/api/cameras', (req, res) => {
  const id = String(req.body?.id || '').trim();
  const url = String(req.body?.url || '').trim();

  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'Valid camera ID (letters, numbers, _, -) is required' });
  }
  if (!url || !/^https?:\/\/.+/i.test(url)) {
    return res.status(400).json({ error: 'Valid HTTP/HTTPS camera URL is required' });
  }

  const exists = db.prepare('SELECT id FROM cameras WHERE id = ?').get(id);
  if (exists) {
    return res.status(409).json({ error: `Camera "${id}" already exists` });
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO cameras (id, url, enabled, created_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
  `).run(id, url, now, now);

  syncWorkersFromDb();
  res.status(201).json({ success: true, message: `Added camera ${id}` });
});

app.put('/api/cameras/:camId', (req, res) => {
  const camId = req.params.camId;
  const url = String(req.body?.url || '').trim();

  if (!url || !/^https?:\/\/.+/i.test(url)) {
    return res.status(400).json({ error: 'Valid HTTP/HTTPS camera URL is required' });
  }

  const existing = db.prepare('SELECT id FROM cameras WHERE id = ?').get(camId);
  if (!existing) {
    return res.status(404).json({ error: 'Camera not found' });
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE cameras SET url = ?, updated_at = ? WHERE id = ?').run(url, now, camId);

  syncWorkersFromDb();
  res.json({ success: true, message: `Updated URL for ${camId}` });
});

app.patch('/api/cameras/:camId', (req, res) => {
  const camId = req.params.camId;
  const existing = db.prepare('SELECT id, enabled FROM cameras WHERE id = ?').get(camId);
  if (!existing) {
    return res.status(404).json({ error: 'Camera not found' });
  }

  const nextEnabled = typeof req.body?.enabled === 'boolean'
    ? (req.body.enabled ? 1 : 0)
    : (existing.enabled ? 0 : 1);

  const now = new Date().toISOString();
  db.prepare('UPDATE cameras SET enabled = ?, updated_at = ? WHERE id = ?').run(nextEnabled, now, camId);

  syncWorkersFromDb();
  res.json({
    success: true,
    enabled: Boolean(nextEnabled),
    message: `${nextEnabled ? 'Resumed' : 'Paused'} camera ${camId}`,
  });
});

app.delete('/api/cameras/:camId', (req, res) => {
  const camId = req.params.camId;
  const result = db.prepare('DELETE FROM cameras WHERE id = ?').run(camId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'Camera not found' });
  }

  syncWorkersFromDb();
  res.json({ success: true, message: `Deleted camera ${camId}` });
});

app.get('/api/latest/:camId', (req, res) => {
  const state = workers.get(req.params.camId);
  if (!state || !state.latestJpegBuffer) {
    return res.status(404).send('No image available yet');
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.send(state.latestJpegBuffer);
});

app.post('/api/export/:camId', async (req, res) => {
  const state = workers.get(req.params.camId);
  if (!state) {
    return res.status(404).json({ error: 'Camera not found' });
  }
  if (state.isEncoding) {
    return res.status(400).json({ error: 'Already encoding a video for this camera' });
  }
  if (state.frameBuffer.length === 0) {
    return res.status(400).json({ error: 'Buffer is empty, no frames to export' });
  }

  state.isEncoding = true;
  const framesToEncode = state.frameBuffer;
  state.frameBuffer = [];
  state.currentBufferBytes = 0;

  const camDir = path.join(OUTPUT_DIR, state.id);
  const outPath = await compileVideo(
    state.id,
    camDir,
    framesToEncode,
    `manual_${new Date().toISOString().replace(/[:.]/g, '-')}`
  );
  state.isEncoding = false;

  res.json({ success: true, message: `Video compiled successfully: ${path.basename(outPath)}` });
});

const server = app.listen(PORT, () => {
  console.log(`Timelapse server running at http://localhost:${PORT}`);
});

async function handleShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}. Flushing all buffers to video before exiting...`);

  server.close();
  for (const state of workers.values()) {
    stopWorkerTimer(state);
  }

  const exportPromises = [];
  for (const [camId, state] of workers.entries()) {
    if (state.frameBuffer.length > 0) {
      console.log(`[${camId}] Saving remaining ${state.frameBuffer.length} frames...`);
      const camDir = path.join(OUTPUT_DIR, camId);
      exportPromises.push(
        compileVideo(
          camId,
          camDir,
          state.frameBuffer,
          `shutdown_${new Date().toISOString().replace(/[:.]/g, '-')}`
        )
      );
    }
  }

  await Promise.all(exportPromises);
  db.close();
  console.log('[Shutdown] All videos safely compiled. Exiting.');
  process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

export { app, db, workers, syncWorkersFromDb, restartWorkersFromDb };