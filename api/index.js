// Vercel serverless function wrapper for Express app
import app from '../server/index.js'

// Vercel serverless function handler
export default async (req, res) => {
  return app(req, res)
}

