import 'dotenv/config'
import express from 'express'
import crypto from 'crypto'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { ensureTables, runQuery } from './db.js'

const PORT = process.env.PORT || 4000
const JWT_SECRET = process.env.STACK_SECRET_SERVER_KEY || process.env.JWT_SECRET || 'dev-secret'
const app = express()

// CORS: Allow frontend origin; default to permissive unless ALLOW_ALL_CORS=false
const allowAllCors = process.env.ALLOW_ALL_CORS !== 'false'
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174', 'http://localhost:4173']

// In Vercel, also allow the Vercel deployment URL
if (process.env.VERCEL_URL) {
  allowedOrigins.push(`https://${process.env.VERCEL_URL}`)
}
if (process.env.VERCEL) {
  // Allow all Vercel preview deployments
  allowedOrigins.push(/^https:\/\/.*\.vercel\.app$/)
}

app.use(
  cors({
    origin: allowAllCors
      ? true
      : (origin, callback) => {
          // Allow requests with no origin (mobile apps, Postman, etc.)
          if (!origin) {
            callback(null, true)
            return
          }
          // In development, allow all localhost origins
          if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost:')) {
            callback(null, true)
            return
          }
          // Check exact matches
          if (allowedOrigins.includes(origin)) {
            callback(null, true)
            return
          }
          // Check regex patterns (for Vercel preview URLs)
          const isAllowed = allowedOrigins.some((pattern) => {
            if (pattern instanceof RegExp) {
              return pattern.test(origin)
            }
            return false
          })
          if (isAllowed) {
            callback(null, true)
            return
          }
          callback(new Error('Not allowed by CORS'))
        },
    credentials: true,
  }),
)
app.use(express.json({ limit: '1mb' }))

const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.replace('Bearer ', '') : null
  if (!token) return res.status(401).json({ error: 'Missing token' })
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    req.user = payload
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'des-lab-api' })
})

const insertNeonAuthUser = async (email, name) => {
  try {
    await runQuery(
      `
        INSERT INTO neon_auth.users_sync (id, name, email, created_at, updated_at, raw_json)
        VALUES ($1, $2, $3, now(), now(), jsonb_build_object('email',$3,'name',$2))
        ON CONFLICT (email) DO NOTHING;
      `,
      [crypto.randomUUID(), name, email],
    )
  } catch (error) {
    console.warn('neon_auth.users_sync insert skipped', error.message)
  }
}

// Login (teacher-only). No signup; seed teacher rows manually.
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body ?? {}
    if (!email || !password) return res.status(400).json({ error: 'Missing email or password' })
    const { rows } = await runQuery('SELECT * FROM teachers WHERE email = $1', [email])
    const teacher = rows[0]
    if (!teacher) return res.status(401).json({ error: 'Invalid credentials' })
    const ok = await bcrypt.compare(password, teacher.password_hash)
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' })
    const token = jwt.sign({ sub: teacher.id, email: teacher.email, role: 'teacher' }, JWT_SECRET, {
      expiresIn: '8h',
    })
    res.json({ token, email: teacher.email })
  } catch (error) {
    console.error('Login error', error)
    res.status(500).json({ error: 'Login failed' })
  }
})

// Signup: create teacher + user, return token
app.post('/api/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body ?? {}
    if (!email || !password || !name) return res.status(400).json({ error: 'Missing email, password, or name' })
    const hash = await bcrypt.hash(password, 10)
    await runQuery(
      `INSERT INTO users (email, name, role) VALUES ($1, $2, 'teacher') ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role = 'teacher';`,
      [email, name],
    )
    await runQuery(
      `INSERT INTO teachers (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash;`,
      [email, hash],
    )
    await insertNeonAuthUser(email, name)
    const token = jwt.sign({ sub: email, email, role: 'teacher' }, JWT_SECRET, { expiresIn: '8h' })
    res.json({ token, email })
  } catch (error) {
    console.error('Signup error', error)
    res.status(500).json({ error: 'Signup failed' })
  }
})

// Bulk insert roster rows
app.post('/api/roster/bulk', authMiddleware, async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
    if (!rows.length) return res.status(400).json({ error: 'No rows provided' })

    const insertText = `
      INSERT INTO lab_roster (student_id, name, email, exam_id, version_label)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (student_id, exam_id) DO UPDATE
        SET name = EXCLUDED.name,
            email = COALESCE(EXCLUDED.email, lab_roster.email),
            version_label = EXCLUDED.version_label
      RETURNING *;
    `
    const inserted = []
    for (const r of rows) {
      const values = [r.studentId, r.name, r.email ?? null, r.examId, r.version ?? r.versionLabel ?? 'A']
      const { rows: dbRows } = await runQuery(insertText, values)
      inserted.push(dbRows[0])
    }
    res.json({ count: inserted.length, rows: inserted })
  } catch (error) {
    console.error('Roster bulk error', error)
    res.status(500).json({ error: 'Failed to import roster' })
  }
})

app.get('/api/roster', authMiddleware, async (req, res) => {
  try {
    const examId = req.query.examId
    const { rows } = examId
      ? await runQuery('SELECT * FROM lab_roster WHERE exam_id = $1 ORDER BY name;', [examId])
      : await runQuery('SELECT * FROM lab_roster ORDER BY exam_id, name;')
    res.json(rows)
  } catch (error) {
    console.error('Roster fetch error', error)
    res.status(500).json({ error: 'Failed to fetch roster' })
  }
})

// Upsert a gradebook row
app.post('/api/grades', authMiddleware, async (req, res) => {
  try {
    const row = req.body
    if (!row?.studentId || !row?.examId) return res.status(400).json({ error: 'Missing studentId or examId' })

    const insertText = `
      INSERT INTO lab_gradebook (student_id, name, exam_id, version_label, q_scores, total, diagnosis, letter_grade)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      ON CONFLICT (student_id, exam_id, version_label) DO UPDATE
        SET name = EXCLUDED.name,
            q_scores = EXCLUDED.q_scores,
            total = EXCLUDED.total,
            diagnosis = EXCLUDED.diagnosis,
            letter_grade = EXCLUDED.letter_grade
      RETURNING *;
    `
    const values = [
      row.studentId,
      row.name ?? 'Unknown',
      row.examId,
      row.version ?? row.versionLabel ?? 'A',
      JSON.stringify(row.q_scores ?? row.qScores ?? { q1: row.q1 ?? 0, q2: row.q2 ?? 0, q3: row.q3 ?? 0 }),
      row.total ?? 0,
      row.diagnosis ?? null,
      row.letter_grade ?? null,
    ]
    const { rows: dbRows } = await runQuery(insertText, values)
    res.json(dbRows[0])
  } catch (error) {
    console.error('Grade upsert error', error)
    res.status(500).json({ error: 'Failed to save grade' })
  }
})

app.get('/api/grades', authMiddleware, async (req, res) => {
  try {
    const examId = req.query.examId
    const { rows } = examId
      ? await runQuery('SELECT * FROM lab_gradebook WHERE exam_id = $1 ORDER BY created_at DESC;', [examId])
      : await runQuery('SELECT * FROM lab_gradebook ORDER BY created_at DESC;')
    res.json(rows)
  } catch (error) {
    console.error('Grades fetch error', error)
    res.status(500).json({ error: 'Failed to fetch grades' })
  }
})

// Save a DES run
app.post('/api/runs', authMiddleware, async (req, res) => {
  try {
    const { mode, inputHex, keyHex, outputHex } = req.body ?? {}
    if (!mode || !inputHex || !keyHex || !outputHex) return res.status(400).json({ error: 'Missing run fields' })
    await runQuery(
      `INSERT INTO lab_runs (teacher_email, mode, input_hex, key_hex, output_hex) VALUES ($1,$2,$3,$4,$5);`,
      [req.user?.email ?? 'unknown', mode, inputHex, keyHex, outputHex],
    )
    res.json({ ok: true })
  } catch (error) {
    console.error('Run save error', error)
    res.status(500).json({ error: 'Failed to save run' })
  }
})

// Initialize database tables (run once on startup)
let dbInitialized = false
const initializeDb = async () => {
  if (dbInitialized) return
  try {
    await ensureTables()
    if (process.env.SEED_TEACHER_EMAIL && process.env.SEED_TEACHER_PASSWORD) {
      const hash = await bcrypt.hash(process.env.SEED_TEACHER_PASSWORD, 10)
      await runQuery(
        `INSERT INTO teachers (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING;`,
        [process.env.SEED_TEACHER_EMAIL, hash],
      )
      console.log(`Seeded teacher ${process.env.SEED_TEACHER_EMAIL}`)
    }
    dbInitialized = true
  } catch (error) {
    console.error('Database initialization error', error)
  }
}

// Start server only if not in serverless mode (Vercel sets VERCEL env var)
if (!process.env.VERCEL) {
  const start = async () => {
    try {
      await initializeDb()
      app.listen(PORT, () => {
        console.log(`DES Lab API running on http://localhost:${PORT}`)
      })
    } catch (error) {
      console.error('Failed to start API', error)
      process.exit(1)
    }
  }
  start()
} else {
  // In serverless mode, initialize DB on first request
  app.use(async (req, res, next) => {
    await initializeDb()
    next()
  })
}

export default app
