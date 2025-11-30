import { Pool } from 'pg'

const connectionString = process.env.DATABASE_URL ?? process.env.VITE_DATABASE_URL

if (!connectionString) {
  console.warn('DATABASE_URL is not set. API server will not be able to reach Neon.')
}

export const pool = new Pool({ connectionString })

export const ensureTables = async () => {
  // Create helper tables tailored for the grading UI (text-friendly exam_id/version)
  await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";')
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lab_roster (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      exam_id TEXT NOT NULL,
      version_label TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, exam_id)
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lab_gradebook (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id TEXT NOT NULL,
      name TEXT NOT NULL,
      exam_id TEXT NOT NULL,
      version_label TEXT NOT NULL,
      q_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
      total NUMERIC(6,2) NOT NULL DEFAULT 0,
      letter_grade TEXT,
      diagnosis TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (student_id, exam_id, version_label)
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lab_runs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      teacher_email TEXT NOT NULL,
      mode TEXT NOT NULL,
      input_hex TEXT NOT NULL,
      key_hex TEXT NOT NULL,
      output_hex TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teachers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
}

export const runQuery = (text, params) => pool.query(text, params)
