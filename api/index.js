// api/index.js — Vercel Serverless Entry Point
// This file is the bridge between Vercel and the Express app.
// It imports the configured Express app and exports it as a
// Vercel-compatible serverless handler.

import { initDb } from '../config/db.js';
import app from '../server.js';

// Initialize DB on cold start (Vercel serverless)
let dbReady = false;
const ensureDb = async () => {
  if (!dbReady) {
    await initDb();
    dbReady = true;
  }
};

export default async function handler(req, res) {
  await ensureDb();
  return app(req, res);
}
