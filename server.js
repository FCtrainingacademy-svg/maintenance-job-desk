// Maintenance Job Desk – office desk, contractor job links and WhatsApp dispatch.
// Times typed into the desk are UK wall-clock times, so the server works in UK time too.
process.env.TZ = process.env.TZ || "Europe/London";
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { makeStore, deepMerge, COLLECTIONS } = require("./lib/store");
const auth = require("./lib/auth");
const { makeWhatsApp } = require("./lib/whatsapp");
const { makeDispatch } = require("./lib/dispatch");
const profile = require("./lib/profile");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));

const store = makeStore();
const wa = makeWhatsApp(store);
const baseUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const dispatch = makeDispatch(store, wa, baseUrl);
const PORT = Number(process.env.PORT) || 3000;
const OFFICE_COLS = COLLECTIONS.filter(c => c !== "outbox");
const SAFE_ID = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;
const pub = f => path.join(__dirname, "public", f);
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: "Something went wrong – try again" }); });

app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "same-origin"); next(); });
app.get("/healthz", (_req, res) => res.send("ok"));
app.use("/static", express.static(path.join(__dirname, "public"), { maxAge: "1h", index: false }));

/* ---------- office login ---------- */
app.get("/login", (req, res) => auth.isOffice(req) ? res.redirect("/") : res.sendFile(pub("login.html")));
app.post("/login", (req, res) => {
  if (auth.throttled(req.ip)) return res.redirect("/login?e=wait");
  if (!process.env.OFFICE_PASSWORD) return res.redirect("/login?e=nopass");
  if (!auth.passwordOk(req.body.password)) return res.redirect("/login?e=bad");
  auth.setSession(res, req.secure);
  res.redirect("/");
});
app.post("/logout", (_req, res) => { auth.clearSession(res); res.redirect("/login"); });
app.get("/", auth.requireOffice, (_req, res) => res.sendFile(pub("office.html")));

/* ---------- office API ---------- */
const office = express.Router();
office.use(auth.requireOffice);
office.get("/all", wrap(async (_req, res) => {
  const out = { v: await store.version(), wa: { enabled: wa.enabled() }, baseUrl: baseUrl(), db: !!process.env.DATABASE_URL };
  for (const c of OFFICE_COLS) out[c] = await store.list(c);
  out.outbox = (await store.list("outbox")).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
  res.json(out);
}));
office.get("/version", wrap(async (_req, res) => res.json({ v: await store.version() })));
const colOk = (req, res) => { if (!OFFICE_COLS.includes(req.params.col) || !SAFE_ID.test(req.params.id)) { res.status(400).json({ error: "Bad path" }); return false; } return true; };
office.get("/docs/:col/:id", wrap(async (req, res) => { if (!colOk(req, res)) return; const d = await store.get(req.params.col, req.params.id); res.json({ exists: !!d, data: d }); }));
office.put("/docs/:col/:id", wrap(async (req, res) => { if (!colOk(req, res)) return; await store.put(req.params.col, req.params.id, req.body || {}); res.json({ ok: true }); }));
office.patch("/docs/:col/:id", wrap(async (req, res) => {
  if (!colOk(req, res)) return;
  const r = await store.withLock(req.params.col, req.params.id, async cur => cur ? { doc: deepMerge(cur, req.body || {}) } : { missing: true });
  if (r && r.missing) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
}));
office.delete("/docs/:col/:id", wrap(async (req, res) => { if (!colOk(req, res)) return; await store.del(req.params.col, req.params.id); res.json({ ok: true }); }));
office.post("/jobs/:id/notify-post", wrap(async (req, res) => res.json(await dispatch.notifyPost(req.params.id))));
office.post("/jobs/:id/notify-assigned", wrap(async (req, res) => res.json(await dispatch.notifyAssigned(req.params.id))));
office.post("/jobs/:id/alert", wrap(async (req, res) => {
  const j = await store.get("jobs", req.params.id); if (!j) return res.status(404).json({ error: "Job not found" });
  const ev = String(req.body.event || ""); const txt = String(req.body.text || "").slice(0, 600);
  if (ev === "custom" && !txt.trim()) return res.status(400).json({ error: "Write the update first" });
  const sent = await dispatch.alertParties(j, ev, txt);
  res.json({ sent, simulated: !wa.enabled() });
}));
office.post("/contractors/:id/rotate", wrap(async (req, res) => {
  const token = crypto.randomBytes(18).toString("base64url");
  const r = await store.withLock("contractors", req.params.id, async cur => cur ? { doc: { ...cur, token } } : { missing: true });
  if (r && r.missing) return res.status(404).json({ error: "Not found" });
  res.json({ token, link: `${baseUrl()}/c/${token}` });
}));
// (mounted after the contractor routes below, so /api/c/... never needs an office login)

/* ---------- contractor link (no login) ---------- */
app.get("/c/:token", (_req, res) => res.sendFile(pub("contractor.html")));
async function contractorFor(token) {
  if (!token || token.length < 16) return null;
  const all = await store.list("contractors");
  const c = all.find(k => k.token && k.token.length === token.length && crypto.timingSafeEqual(Buffer.from(k.token), Buffer.from(token)));
  return c && c.active !== false ? c : null;
}
const cr = express.Router({ mergeParams: true });
cr.use(wrap(async (req, res, next) => {
  const c = await contractorFor(req.params.token);
  if (!c) return res.status(404).json({ error: "This link isn't active. Ask the office for a new one.", code: "badlink" });
  req.contractor = c; next();
}));
cr.get("/", wrap(async (req, res) => {
  const c = req.contractor, jobs = await store.list("jobs"), s = (await store.get("settings", "business")) || {};
  const board = jobs.filter(j => { const d = j.dispatch || {}; return d.status === "open" && !d.allocatedTo && (d.recipients || []).includes(c.id); })
    .sort((a, b) => String(a.attendBy).localeCompare(String(b.attendBy))).map(j => dispatch.boardView(j, c));
  const mine = jobs.filter(j => j.dispatch && j.dispatch.allocatedTo === c.id).sort((a, b) => String(b.dispatch.allocatedAt).localeCompare(String(a.dispatch.allocatedAt))).map(j => dispatch.myView(j, c, s));
  res.json({ needsDetails: !c.selfBillAgreed || !c.accountNo, me: { name: c.name, company: c.company || "" }, office: { name: s.bizName || "", phone: s.bizPhone || "" }, board, mine });
}));
const act = fn => wrap(async (req, res) => { const r = await fn(req.contractor, req.params.id, req.body || {}); res.status(r.ok ? 200 : 409).json(r.ok ? { ok: true } : { error: r.error === "QUOTE" ? "This job needs a quote." : r.error }); });
cr.post("/jobs/:id/accept", act((c, id) => dispatch.accept(c, id, "app")));
cr.post("/jobs/:id/quote", act((c, id, b) => dispatch.quote(c, id, b)));
cr.post("/jobs/:id/step", act((c, id, b) => dispatch.step(c, id, b.step)));
cr.post("/jobs/:id/time", act((c, id, b) => dispatch.timeframe(c, id, b.attendBy, b.finishBy)));
cr.post("/jobs/:id/done", act((c, id, b) => dispatch.done(c, id, b.text)));
cr.post("/jobs/:id/note", act((c, id, b) => dispatch.note(c, id, b.text)));
cr.post("/jobs/:id/handback", act((c, id) => dispatch.handback(c, id)));
cr.get("/profile", wrap(async (req, res) => {
  const s = (await store.get("settings", "business")) || {};
  res.json(profile.profileView(req.contractor, s.bizName));
}));
cr.post("/profile", wrap(async (req, res) => {
  const b = req.body || {}, fields = profile.pickFields(b);
  if ("name" in fields && !fields.name) return res.status(400).json({ error: "Your name can't be blank" });
  if ("phone" in fields && !fields.phone) delete fields.phone; // keep the number the office uses
  const r = await store.withLock("contractors", req.contractor.id, async cur => {
    if (!cur) return { missing: true };
    const doc = { ...cur, ...fields, detailsUpdatedAt: new Date().toISOString() };
    if (b.agree === true) {
      const signed = String(b.signedName || "").trim().slice(0, 80);
      if (!signed) return { error: "Type your full name to accept the agreement" };
      Object.assign(doc, { selfBillAgreed: true, selfBillDate: new Date().toISOString().slice(0, 10), selfBillSignedName: signed, selfBillVersion: profile.AGREEMENT_VERSION });
    }
    return { doc };
  });
  if (r.missing) return res.status(404).json({ error: "This link isn't active" });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
}));
app.use("/api/c/:token", cr);

/* ---------- public contractor sign-up ---------- */
app.get("/join", (_req, res) => res.sendFile(pub("join.html")));
app.get("/api/join/info", wrap(async (_req, res) => {
  const s = (await store.get("settings", "business")) || {};
  res.json({ bizName: s.bizName || "", bizPhone: s.bizPhone || "", categories: profile.CATEGORIES, agreement: profile.agreementText(s.bizName) });
}));
const joinHits = new Map();
app.post("/api/join", wrap(async (req, res) => {
  const now = Date.now(), hits = (joinHits.get(req.ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= 5) return res.status(429).json({ error: "Too many applications from this connection. Try again later or call the office." });
  hits.push(now); joinHits.set(req.ip, hits);
  const b = req.body || {}, f = profile.pickFields(b);
  if (b.website) return res.json({ ok: true }); // hidden honeypot field filled = bot
  if (!f.name || !f.phone) return res.status(400).json({ error: "Add your name and mobile number" });
  if (!b.consent) return res.status(400).json({ error: "Tick the box to agree to receive job messages on WhatsApp" });
  const all = await store.list("contractors");
  if (all.some(k => k.phone && wa.intl(k.phone) === wa.intl(f.phone))) return res.status(409).json({ error: "This mobile number is already registered with us. Contact the office if you need a new job link." });
  const id = "app-" + crypto.randomBytes(6).toString("hex");
  const doc = { ...f, id, pending: true, active: false, appliedAt: new Date().toISOString(), consentWhatsApp: true };
  if (b.agree === true && String(b.signedName || "").trim()) Object.assign(doc, { selfBillAgreed: true, selfBillDate: doc.appliedAt.slice(0, 10), selfBillSignedName: String(b.signedName).trim().slice(0, 80), selfBillVersion: profile.AGREEMENT_VERSION });
  await store.put("contractors", id, doc);
  res.json({ ok: true });
}));

app.use("/api", office);

/* ---------- WhatsApp webhook ---------- */
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && process.env.WHATSAPP_VERIFY_TOKEN && req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
app.post("/webhook", (req, res) => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (secret) {
    const sig = String(req.headers["x-hub-signature-256"] || "");
    const want = "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody || "").digest("hex");
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return res.sendStatus(401);
  }
  res.sendStatus(200); // answer Meta straight away, then process
  const msgs = [];
  for (const e of (req.body && req.body.entry) || []) for (const ch of e.changes || []) for (const m of (ch.value && ch.value.messages) || []) msgs.push(m);
  (async () => {
    for (const m of msgs) {
      const payload = m.type === "button" ? m.button && m.button.payload : m.type === "interactive" ? m.interactive && m.interactive.button_reply && m.interactive.button_reply.id : null;
      await dispatch.handleIncoming(String(m.from || ""), payload, m.type === "text" ? m.text && m.text.body : "").catch(err => console.error("webhook", err));
    }
  })();
});

store.init().then(() => app.listen(PORT, () => console.log(`Job desk on :${PORT} (${process.env.DATABASE_URL ? "Postgres" : "local file"} store, WhatsApp ${wa.enabled() ? "live" : "simulated"})`)));
module.exports = app;
