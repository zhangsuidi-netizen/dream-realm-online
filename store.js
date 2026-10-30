'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');
const DEFAULT_DB = () => ({
  meta: { version: 1, notice: 'Selamat datang di Dream Realm. Semua chip hanya virtual dan gratis.' },
  users: [], sessions: [], history: []
});
function ensureDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB(), null, 2), { mode: 0o600 });
}
function readDb() {
  ensureDb();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    return { ...DEFAULT_DB(), ...parsed, meta: { ...DEFAULT_DB().meta, ...(parsed.meta || {}) } };
  } catch (err) {
    throw new Error(`Database tidak dapat dibaca (${err.message}). Hentikan server dan pulihkan backup data/db.json.bak.`);
  }
}
function writeDb(db) {
  ensureDb();
  const temp = `${DB_PATH}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  if (fs.existsSync(DB_PATH)) fs.copyFileSync(DB_PATH, `${DB_PATH}.bak`);
  fs.renameSync(temp, DB_PATH);
}
function mutateDb(fn) {
  const db = readDb();
  const result = fn(db);
  writeDb(db);
  return result;
}
module.exports = { readDb, writeDb, mutateDb, DB_PATH };
