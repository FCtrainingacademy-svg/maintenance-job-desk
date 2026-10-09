// Document store: every record is a JSON document in a collection (jobs, contacts,
// contractors, settings, outbox). Postgres in production, a JSON file for local dev.
const fs = require("fs");
const path = require("path");

const COLLECTIONS = ["jobs", "contacts", "contractors", "settings", "outbox"];

function isObj(v) { return v && typeof v === "object" && !Array.isArray(v); }
// Same rules as the old page: nested objects merge, everything else (arrays included) replaces.
function deepMerge(target, patch) {
  const out = isObj(target) ? { ...target } : {};
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObj(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}

class PgStore {
  constructor(url) {
    const { Pool } = require("pg");
    const ssl = /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString: url, ssl, max: 5 });
  }
  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS docs (
      collection text NOT NULL, id text NOT NULL, data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (collection, id))`);
  }
  async list(col) {
    const r = await this.pool.query("SELECT id, data FROM docs WHERE collection=$1", [col]);
    return r.rows.map(x => ({ ...x.data, id: x.id }));
  }
  async get(col, id) {
    const r = await this.pool.query("SELECT data FROM docs WHERE collection=$1 AND id=$2", [col, id]);
    return r.rows[0] ? { ...r.rows[0].data, id } : null;
  }
  async put(col, id, data) {
    await this.pool.query(`INSERT INTO docs (collection,id,data,updated_at) VALUES ($1,$2,$3,now())
      ON CONFLICT (collection,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [col, id, { ...data, id }]);
  }
  async del(col, id) { await this.pool.query("DELETE FROM docs WHERE collection=$1 AND id=$2", [col, id]); }
  async version() {
    const r = await this.pool.query("SELECT coalesce(extract(epoch from max(updated_at))*1000,0)::bigint v, count(*) n FROM docs");
    return `${r.rows[0].v}-${r.rows[0].n}`;
  }
  // Read-modify-write under a row lock. fn(current|null) returns the new doc, or null to leave it.
  async withLock(col, id, fn) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query("SELECT data FROM docs WHERE collection=$1 AND id=$2 FOR UPDATE", [col, id]);
      const cur = r.rows[0] ? { ...r.rows[0].data, id } : null;
      const res = await fn(cur);
      if (res && res.doc) {
        await c.query(`INSERT INTO docs (collection,id,data,updated_at) VALUES ($1,$2,$3,now())
          ON CONFLICT (collection,id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [col, id, { ...res.doc, id }]);
      }
      await c.query("COMMIT");
      return res;
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  }
}

class FileStore {
  constructor(file) { this.file = file; this.data = {}; this.v = 0; this.chain = Promise.resolve(); }
  async init() {
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.data = {}; }
    COLLECTIONS.forEach(c => { this.data[c] = this.data[c] || {}; });
  }
  save() { this.v++; fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1)); }
  async list(col) { return Object.entries(this.data[col] || {}).map(([id, d]) => ({ ...d, id })); }
  async get(col, id) { const d = (this.data[col] || {})[id]; return d ? { ...JSON.parse(JSON.stringify(d)), id } : null; }
  async put(col, id, data) { (this.data[col] = this.data[col] || {})[id] = { ...data, id }; this.save(); }
  async del(col, id) { if (this.data[col]) delete this.data[col][id]; this.save(); }
  async version() { return String(this.v); }
  withLock(col, id, fn) {
    const run = this.chain.then(async () => {
      const res = await fn(await this.get(col, id));
      if (res && res.doc) await this.put(col, id, res.doc);
      return res;
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

function makeStore() {
  return process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL)
    : new FileStore(process.env.DATA_FILE || path.join(__dirname, "..", "data", "dev-db.json"));
}

module.exports = { makeStore, deepMerge, COLLECTIONS };
