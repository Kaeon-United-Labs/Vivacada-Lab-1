'use strict';
const crypto = require('crypto');
const newId = () => crypto.randomBytes(12).toString('hex');

// This app never falls back to disk or an in-memory mock, even for local
// development — MOCK_MODE (payment + proctoring only) is the demo path here,
// not a fake database. Multi-instance job claiming requires a real shared
// store from the start, so there's no single-process code path to fall back to.
async function connect() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('[ai-testing-app] MONGODB_URI is required — this app has no local-disk fallback.');
    process.exit(1);
  }
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'vivacada_ai_testing');
  console.log('[ai-testing-app] connected to MongoDB');
  return db;
}

module.exports = { connect, newId };
