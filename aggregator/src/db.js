'use strict';
const crypto = require('crypto');
const newId = () => crypto.randomBytes(12).toString('hex');

function matches(doc, query) {
  return Object.entries(query || {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.entries(v).every(([op, val]) => {
        if (op === '$in') return val.includes(doc[k]);
        if (op === '$ne') return doc[k] !== val;
        if (op === '$exists') return val ? doc[k] !== undefined : doc[k] === undefined;
        if (op === '$gt') return doc[k] > val;
        if (op === '$gte') return doc[k] >= val;
        if (op === '$lt') return doc[k] < val;
        if (op === '$lte') return doc[k] <= val;
        if (op === '$regex') return new RegExp(val, 'i').test(doc[k] || '');
        return true;
      });
    }
    return doc[k] === v;
  });
}
function applyUpdate(doc, update) {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
  if (update.$push) for (const [k, v] of Object.entries(update.$push)) (doc[k] = doc[k] || []).push(v);
}

class MockCollection {
  constructor(name) { this.name = name; this.docs = []; this.onChange = null; }
  async insertOne(doc) {
    if (!doc._id) doc._id = newId();
    this.docs.push(doc);
    if (this.onChange) this.onChange();
    return { insertedId: doc._id };
  }
  async findOne(query) { return this.docs.find((d) => matches(d, query)) || null; }
  find(query) {
    let out = this.docs.filter((d) => matches(d, query));
    const cur = {
      sort: (s) => { const [[k, dir]] = Object.entries(s); out = out.slice().sort((a, b) => (a[k] > b[k] ? 1 : -1) * dir); return cur; },
      limit: (n) => { out = out.slice(0, n); return cur; },
      toArray: async () => out
    };
    return cur;
  }
  async updateOne(query, update) {
    const d = this.docs.find((x) => matches(x, query));
    if (d) { applyUpdate(d, update); if (this.onChange) this.onChange(); }
    return { matchedCount: d ? 1 : 0 };
  }
  async updateMany(query, update) {
    let n = 0;
    for (const d of this.docs) if (matches(d, query)) { applyUpdate(d, update); n++; }
    if (n && this.onChange) this.onChange();
    return { matchedCount: n };
  }
  async deleteOne(query) {
    const i = this.docs.findIndex((d) => matches(d, query));
    if (i >= 0) { this.docs.splice(i, 1); if (this.onChange) this.onChange(); }
    return { deletedCount: i >= 0 ? 1 : 0 };
  }
  async countDocuments(query) { return this.docs.filter((d) => matches(d, query)).length; }
}

class MockDb {
  constructor(persistPath) {
    this.cols = new Map(); this.mock = true; this.persistPath = persistPath || null; this._saveTimer = null;
    if (this.persistPath) this._load();
  }
  collection(name) {
    if (!this.cols.has(name)) { const c = new MockCollection(name); c.onChange = () => this._scheduleSave(); this.cols.set(name, c); }
    return this.cols.get(name);
  }
  _load() {
    const fs = require('fs');
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      for (const [name, docs] of Object.entries(data)) this.collection(name).docs = docs;
      console.log('[db] loaded local data from ' + this.persistPath);
    } catch (e) { console.warn('[db] could not load ' + this.persistPath + ' (' + e.message + '); starting fresh'); }
  }
  _scheduleSave() { if (!this.persistPath) return; clearTimeout(this._saveTimer); this._saveTimer = setTimeout(() => this._save(), 120); }
  flush() { if (this.persistPath) { clearTimeout(this._saveTimer); this._save(); } }
  _save() {
    const fs = require('fs'), path = require('path');
    try {
      const data = {}; for (const [name, col] of this.cols) data[name] = col.docs;
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmp = this.persistPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.persistPath);
    } catch (e) { console.warn('[db] persist failed: ' + e.message); }
  }
}

function wrapMongo(db, ObjectId) {
  const coerceId = (v) => (typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v)) ? { $in: [v, new ObjectId(v)] } : v;
  const coerceFilter = (q) => { if (!q || typeof q !== 'object') return q; const out = { ...q }; if (typeof out._id === 'string') out._id = coerceId(out._id); return out; };
  const fixDoc = (d) => { if (d && d._id != null) d._id = String(d._id); return d; };
  const wrapCol = (col) => ({
    insertOne: (doc) => col.insertOne(doc),
    findOne: async (q) => fixDoc(await col.findOne(coerceFilter(q))),
    find: (q) => {
      let cur = col.find(coerceFilter(q));
      const chain = {
        sort: (s) => { cur = cur.sort(s); return chain; },
        limit: (n) => { cur = cur.limit(n); return chain; },
        toArray: async () => (await cur.toArray()).map(fixDoc)
      };
      return chain;
    },
    updateOne: (q, u) => col.updateOne(coerceFilter(q), u),
    updateMany: (q, u) => col.updateMany(coerceFilter(q), u),
    deleteOne: (q) => col.deleteOne(coerceFilter(q)),
    countDocuments: (q) => col.countDocuments(coerceFilter(q))
  });
  const cache = new Map();
  return { mock: false, collection(name) { if (!cache.has(name)) cache.set(name, wrapCol(db.collection(name))); return cache.get(name); } };
}

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    try {
      const { MongoClient, ObjectId } = require('mongodb');
      const client = new MongoClient(uri);
      await client.connect();
      const db = client.db(process.env.MONGODB_DB || 'vivacada_aggregator');
      console.log('[db] connected to MongoDB');
      return wrapMongo(db, ObjectId);
    } catch (e) { console.warn('[db] MongoDB unavailable (' + e.message + '); using local-file mock'); }
  } else console.log('[db] MONGODB_URI not set; using local-file mock database');
  const path = require('path');
  const mdb = new MockDb(path.join(__dirname, '..', 'data', 'db.json'));
  const flushAndExit = (code) => { try { mdb.flush(); } catch (_) {} process.exit(code); };
  process.on('SIGINT', () => flushAndExit(130));
  process.on('SIGTERM', () => flushAndExit(143));
  process.on('exit', () => { try { mdb.flush(); } catch (_) {} });
  return mdb;
}

module.exports = { connect, newId };
