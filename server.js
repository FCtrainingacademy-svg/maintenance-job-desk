// Maintenance Job Desk – office desk, contractor job links and WhatsApp dispatch.
// Times typed into the desk are UK wall-clock times, so the server works in UK time too.
process.env.TZ = process.env.TZ || "Europe/London";
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { makeStore, deepMerge, COLLECTIONS, TRAINING_COLLECTIONS } = require("./lib/store");
const auth = require("./lib/auth");
const { makeWhatsApp } = require("./lib/whatsapp");
const { makeDispatch } = require("./lib/dispatch");
const { makeDiarySync } = require("./lib/diary-sync");
const { makeIntake } = require("./lib/intake");
const profile = require("./lib/profile");
const kps = require("./lib/kps");
const { makeMaterials } = require("./lib/materials");
const { makeTraining } = require("./lib/training");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false }));

const store = makeStore();
const wa = makeWhatsApp(store);
const baseUrl = () => (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const dispatch = makeDispatch(store, wa, baseUrl, makeDiarySync);
const diary = makeDiarySync();
const intake = makeIntake(store, wa, dispatch, baseUrl);
const materials = makeMaterials(store, wa, dispatch);
// FC Training Academy's own WhatsApp number (training jobs for learners). Same Meta token unless TRAINING_WHATSAPP_TOKEN is set.
const waT = makeWhatsApp(store, { line: "training", phoneId: () => process.env.TRAINING_WHATSAPP_PHONE_ID, token: () => process.env.TRAINING_WHATSAPP_TOKEN || process.env.WHATSAPP_TOKEN });
const training = makeTraining(store, waT, baseUrl, makeDiarySync);
const PORT = Number(process.env.PORT) || 3000;
const OFFICE_COLS = COLLECTIONS.filter(c => c !== "outbox" && c !== "intake" && !TRAINING_COLLECTIONS.includes(c));
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
  const out = { v: await store.version(), wa: { enabled: wa.enabled() }, diary: { enabled: diary.enabled() }, kps: { enabled: kps.enabled() }, baseUrl: baseUrl(), db: !!process.env.DATABASE_URL };
  for (const c of OFFICE_COLS) out[c] = await store.list(c);
  out.outbox = (await store.list("outbox")).filter(o => o.line !== "training").sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
  res.json(out);
}));
office.get("/version", wrap(async (_req, res) => res.json({ v: await store.version() })));
const colOk = (req, res) => { if (!OFFICE_COLS.includes(req.params.col) || !SAFE_ID.test(req.params.id)) { res.status(400).json({ error: "Bad path" }); return false; } return true; };
office.get("/docs/:col/:id", wrap(async (req, res) => { if (!colOk(req, res)) return; const d = await store.get(req.params.col, req.params.id); res.json({ exists: !!d, data: d }); }));
// Jobs saved in the office also go to the team diary.
const afterJobWrite = async (col, id) => { if (col === "jobs") dispatch.pushDiary(await store.get("jobs", id)); };
office.put("/docs/:col/:id", wrap(async (req, res) => { if (!colOk(req, res)) return; await store.put(req.params.col, req.params.id, req.body || {}); res.json({ ok: true }); afterJobWrite(req.params.col, req.params.id).catch(() => {}); }));
office.patch("/docs/:col/:id", wrap(async (req, res) => {
  if (!colOk(req, res)) return;
  const r = await store.withLock(req.params.col, req.params.id, async cur => cur ? { doc: deepMerge(cur, req.body || {}) } : { missing: true });
  if (r && r.missing) return res.status(404).json({ error: "Not found" });
  res.json({ ok: true });
  afterJobWrite(req.params.col, req.params.id).catch(() => {});
}));
office.delete("/docs/:col/:id", wrap(async (req, res) => {
  if (!colOk(req, res)) return;
  const old = req.params.col === "jobs" ? await store.get("jobs", req.params.id) : null;
  await store.del(req.params.col, req.params.id); res.json({ ok: true });
  if (old && old.ref) diary.remove(old.ref).catch(e => console.error("diary sync", e.message));
}));
office.post("/jobs/:id/notify-post", wrap(async (req, res) => res.json(await dispatch.notifyPost(req.params.id))));
office.post("/jobs/:id/team-remove", wrap(async (req, res) => {
  const r = await dispatch.groupDrop(String(req.body.kid || ""), req.params.id, "office");
  res.status(r.ok ? 200 : 409).json(r.ok ? { ok: true, promoted: r.promoted ? r.promoted.name : "", reopened: !!r.reopened } : { error: r.error });
}));
office.post("/jobs/:id/notify-assigned", wrap(async (req, res) => res.json(await dispatch.notifyAssigned(req.params.id))));
office.post("/jobs/:id/alert", wrap(async (req, res) => {
  const j = await store.get("jobs", req.params.id); if (!j) return res.status(404).json({ error: "Job not found" });
  const ev = String(req.body.event || ""); const txt = String(req.body.text || "").slice(0, 600);
  if (ev === "custom" && !txt.trim()) return res.status(400).json({ error: "Write the update first" });
  const sent = await dispatch.alertParties(j, ev, txt);
  res.json({ sent, simulated: !wa.enabled() });
}));
// K's Plumbing Store: catalogue search, approve & order a job's materials, refresh order status.
office.get("/kps/search", wrap(async (req, res) => { const r = await kps.search(req.query.q); res.status(r.error ? 502 : 200).json(r); }));
office.post("/jobs/:id/kps-order", wrap(async (req, res) => { const r = await materials.placeOrder(req.params.id, req.body || {}); res.status(r.error ? 409 : 200).json(r); }));
office.post("/jobs/:id/kps-refresh", wrap(async (req, res) => { await materials.refresh([req.params.id]); res.json({ ok: true }); }));
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
  const reserveFor = j => j.dispatch && j.dispatch.mode === "group" && j.dispatch.reserve && j.dispatch.reserve.id === c.id && !(j.track || {}).done && ["open", "allocated"].includes(j.dispatch.status);
  const board = jobs.filter(j => dispatch.canTake(j, c) || reserveFor(j))
    .sort((a, b) => String(a.scheduledAt || a.attendBy).localeCompare(String(b.scheduledAt || b.attendBy))).map(j => dispatch.boardView(j, c));
  const mine = jobs.filter(j => dispatch.isMine(j, c)).sort((a, b) => String(b.dispatch.allocatedAt).localeCompare(String(a.dispatch.allocatedAt))).map(j => dispatch.myView(j, c, s));
  res.json({ needsDetails: !c.selfBillAgreed || !c.accountNo, me: { name: c.name, company: c.company || "" }, office: { name: s.bizName || "", phone: s.bizPhone || "" }, board, mine });
}));
const act = fn => wrap(async (req, res) => { const r = await fn(req.contractor, req.params.id, req.body || {}); res.status(r.ok ? 200 : 409).json(r.ok ? { ok: true, role: r.role || "" } : { error: r.error === "QUOTE" ? "This job needs a quote." : r.error }); });
cr.post("/jobs/:id/accept", act((c, id) => dispatch.accept(c, id, "app")));
cr.post("/jobs/:id/quote", act((c, id, b) => dispatch.quote(c, id, b)));
cr.post("/jobs/:id/step", act((c, id, b) => dispatch.step(c, id, b.step, b.eta)));
cr.post("/jobs/:id/eta", act((c, id, b) => dispatch.updateEta(c, id, b.eta)));
cr.post("/jobs/:id/time", act((c, id, b) => dispatch.timeframe(c, id, b.attendBy, b.finishBy)));
cr.post("/jobs/:id/done", act((c, id, b) => dispatch.done(c, id, b.text)));
cr.get("/kps/search", wrap(async (req, res) => { const r = await kps.search(req.query.q); res.status(r.error ? 502 : 200).json(r); }));
cr.post("/jobs/:id/materials", act((c, id, b) => materials.request(c, id, b)));
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
    } else if (!cur.selfBillAgreed) return { error: "Tick the box to accept the self-billing agreement" };
    return { doc };
  });
  if (r.missing) return res.status(404).json({ error: "This link isn't active" });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
}));
app.use("/api/c/:token", cr);

/* ---------- public price list ---------- */
app.get("/prices", (_req, res) => res.sendFile(pub("prices.html")));
app.get("/api/prices", wrap(async (_req, res) => {
  const r = await store.get("settings", "rates"), s = (await store.get("settings", "business")) || {};
  if (!r || !r.publish) return res.status(404).json({ error: "Our price list isn't published yet. Please call the office for a quote." });
  const pick = ({ dayStart, eveStart, nightStart, weekend, bankHoliday, minMins, incMins, callout, trades, services, noAccessFee, collectRate, congestion, congestionFee, parking, priceNote }) =>
    ({ dayStart, eveStart, nightStart, weekend, bankHoliday, minMins, incMins, callout, trades: (trades || []).map(({ name, day, evening, night }) => ({ name, day, evening, night })), services: (services || []).map(({ name, day, evening }) => ({ name, day, evening })), noAccessFee, collectRate, congestion, congestionFee, parking, priceNote });
  res.json({ biz: { name: s.bizName || "", phone: s.bizPhone || "", email: s.bizEmail || "", vatRegistered: !!s.vatRegistered, vatRate: s.vatRate || 20, markup: s.markup != null && s.markup !== "" ? s.markup : 15 }, rates: pick(r) });
}));

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
  if (b.agree !== true) return res.status(400).json({ error: "Tick the box to accept the self-billing agreement" });
  if (!String(b.signedName || "").trim()) return res.status(400).json({ error: "Type your full name to sign the self-billing agreement" });
  const all = await store.list("contractors");
  if (all.some(k => k.phone && wa.intl(k.phone) === wa.intl(f.phone))) return res.status(409).json({ error: "This mobile number is already registered with us. Contact the office if you need a new job link." });
  const id = "app-" + crypto.randomBytes(6).toString("hex");
  const doc = { ...f, id, pending: true, active: false, appliedAt: new Date().toISOString(), consentWhatsApp: true };
  if (b.agree === true && String(b.signedName || "").trim()) Object.assign(doc, { selfBillAgreed: true, selfBillDate: doc.appliedAt.slice(0, 10), selfBillSignedName: String(b.signedName).trim().slice(0, 80), selfBillVersion: profile.AGREEMENT_VERSION });
  await store.put("contractors", id, doc);
  res.json({ ok: true });
}));

/* ---------- FC Training: onsite portfolio jobs for learners ---------- */
app.get("/training", auth.requireOffice, (_req, res) => res.sendFile(pub("training.html")));
const tr = express.Router();
tr.use(auth.requireOffice);
const tres = (res, r) => res.status(r && r.error ? 409 : 200).json(r);
tr.get("/all", wrap(async (_req, res) => {
  const out = { v: await store.version(), wa: { enabled: waT.enabled() }, lms: { enabled: training.lmsOn() }, diary: { enabled: diary.enabled() }, baseUrl: baseUrl(),
    labels: { appliances: training.APPLIANCES, types: training.TYPES, status: training.STATUS }, target: training.TARGET, checklists: training.CHECKLISTS,
    sync: await store.get("settings", "training-sync") };
  for (const c of TRAINING_COLLECTIONS) out[c] = await store.list(c);
  out.tinbox = out.tinbox.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 100);
  out.outbox = (await store.list("outbox")).filter(o => o.line === "training").sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
  res.json(out);
}));
tr.get("/version", wrap(async (_req, res) => res.json({ v: await store.version() })));
tr.post("/sync-learners", wrap(async (_req, res) => tres(res, await training.syncLearners())));
tr.put("/learners/:id", wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.id)) return res.status(400).json({ error: "Bad id" });
  const b = req.body || {}, cur = await store.get("tlearners", req.params.id);
  if (cur && cur.fromLms) { // LMS learners: only the active switch is kept here; edit details in the LMS
    await store.put("tlearners", req.params.id, { ...cur, active: b.active !== false }); return res.json({ ok: true });
  }
  if (!String(b.name || "").trim()) return res.status(400).json({ error: "Add the learner's name" });
  await store.put("tlearners", req.params.id, { ...(cur || {}), name: String(b.name).trim().slice(0, 100), phone: String(b.phone || "").slice(0, 30), cohort: String(b.cohort || "").slice(0, 60),
    active: b.active !== false, token: (cur && cur.token) || training.newToken() });
  res.json({ ok: true });
}));
tr.put("/supervisors/:id", wrap(async (req, res) => {
  if (!SAFE_ID.test(req.params.id)) return res.status(400).json({ error: "Bad id" });
  const b = req.body || {}, cur = await store.get("tsupervisors", req.params.id);
  if (!String(b.name || "").trim() || !String(b.phone || "").trim()) return res.status(400).json({ error: "Add the supervisor's name and mobile" });
  await store.put("tsupervisors", req.params.id, { ...(cur || {}), name: String(b.name).trim().slice(0, 100), phone: String(b.phone).slice(0, 30), gasSafe: String(b.gasSafe || "").slice(0, 20),
    active: b.active !== false, token: (cur && cur.token) || training.newToken() });
  res.json({ ok: true });
}));
tr.post("/jobs", wrap(async (req, res) => tres(res, await training.saveJob(null, req.body || {}))));
tr.put("/jobs/:id", wrap(async (req, res) => tres(res, await training.saveJob(req.params.id, req.body || {}))));
tr.post("/jobs/:id/post", wrap(async (req, res) => tres(res, await training.post(req.params.id))));
tr.post("/jobs/:id/assign", wrap(async (req, res) => tres(res, await training.assign(req.params.id, String((req.body || {}).learnerId || "")))));
tr.post("/jobs/:id/confirm", wrap(async (req, res) => tres(res, await training.confirm(req.params.id, String((req.body || {}).supervisorId || "")))));
tr.post("/jobs/:id/reopen", wrap(async (req, res) => tres(res, await training.reopen(req.params.id))));
tr.post("/jobs/:id/signoff", wrap(async (req, res) => tres(res, await training.signoff(req.params.id, String((req.body || {}).by || "the office").slice(0, 80)))));
tr.post("/jobs/:id/cancel", wrap(async (req, res) => tres(res, await training.cancel(req.params.id))));
tr.post("/jobs/:id/lms", wrap(async (req, res) => { const j = await store.get("tjobs", req.params.id); if (!j) return res.status(404).json({ error: "Job not found" }); await training.pushLms(j); res.json({ ok: true }); }));
tr.delete("/inbox/:id", wrap(async (req, res) => { if (!SAFE_ID.test(req.params.id)) return res.status(400).json({ error: "Bad id" }); await store.del("tinbox", req.params.id); res.json({ ok: true }); }));
app.use("/api/training", tr);

// Learner / supervisor link (no login)
app.get("/t/:token", (_req, res) => res.sendFile(pub("trainee.html")));
const tl = express.Router({ mergeParams: true });
tl.use(wrap(async (req, res, next) => {
  const who = await training.personFor(req.params.token);
  if (!who) return res.status(404).json({ error: "This link isn't active. Ask FC Training Academy for a new one.", code: "badlink" });
  req.who = who; next();
}));
tl.get("/", wrap(async (req, res) => res.json(await training.boardFor(req.who))));
tl.post("/jobs/:id/accept", wrap(async (req, res) => {
  if (req.who.role !== "learner") return res.status(403).json({ error: "Only learners take jobs" });
  const r = await training.accept(req.who.p, req.params.id, "app"); res.status(r.ok ? 200 : 409).json(r.ok ? { ok: true } : { error: r.error });
}));
tl.post("/jobs/:id/done", wrap(async (req, res) => {
  if (req.who.role !== "learner") return res.status(403).json({ error: "Only the learner marks the job done" });
  const r = await training.done(req.who.p, req.params.id, req.body || {}); res.status(r.ok ? 200 : 409).json(r.ok ? { ok: true } : { error: r.error });
}));
tl.post("/jobs/:id/signoff", wrap(async (req, res) => {
  if (req.who.role !== "supervisor") return res.status(403).json({ error: "Only the supervisor signs off" });
  const j = await store.get("tjobs", req.params.id);
  if (!j || !j.supervisor || j.supervisor.id !== req.who.p.id) return res.status(403).json({ error: "You're not the supervisor on this job" });
  const r = await training.signoff(req.params.id, req.who.p.name); res.status(r.ok ? 200 : 409).json(r.ok ? { ok: true } : { error: r.error });
}));
app.use("/api/t/:token", tl);

app.use("/api", office);

/* ---------- WhatsApp webhook ---------- */
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && process.env.WHATSAPP_VERIFY_TOKEN && req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
app.post("/webhook", (req, res) => {
  const secret = process.env.WHATSAPP_APP_SECRET;
  // The FC Training number may sit in a different Meta app, so either app secret is accepted.
  const secrets = [secret, process.env.TRAINING_WHATSAPP_APP_SECRET].filter(Boolean);
  if (secrets.length) {
    const sig = String(req.headers["x-hub-signature-256"] || "");
    const okSig = secrets.some(sec => { const want = "sha256=" + crypto.createHmac("sha256", sec).update(req.rawBody || "").digest("hex"); return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)); });
    if (!okSig) return res.sendStatus(401);
  }
  res.sendStatus(200); // answer Meta straight away, then process
  const msgs = [];
  for (const e of (req.body && req.body.entry) || []) for (const ch of e.changes || []) for (const m of (ch.value && ch.value.messages) || []) msgs.push({ ...m, _pid: ch.value.metadata && ch.value.metadata.phone_number_id });
  (async () => {
    for (const m of msgs) {
      const payload = m.type === "button" ? m.button && m.button.payload : m.type === "interactive" ? m.interactive && m.interactive.button_reply && m.interactive.button_reply.id : null;
      const from = String(m.from || ""), body = m.type === "text" ? m.text && m.text.body
        : (m.type === "image" || m.type === "document" || m.type === "video") ? (m[m.type] && m[m.type].caption) || "" : "";
      try {
        if (training.isTrainingNumber(m._pid)) await training.handleIncoming(from, payload, body, m.type);
        else if (!(await intake.maybeHandle(from, payload, body, m.type))) await dispatch.handleIncoming(from, payload, body);
      } catch (err) { console.error("webhook", err); }
    }
  })();
});

// Check K's Plumbing Store orders that aren't dispatched yet every 10 minutes.
setInterval(() => materials.refresh().catch(e => console.error("kps refresh", e.message)), 10 * 60 * 1000).unref();
// Pull learners from the LMS every hour (and once at start-up) so new starters can get training jobs.
if (training.lmsOn()) { setTimeout(() => training.syncLearners().catch(() => {}), 20000).unref(); setInterval(() => training.syncLearners().catch(e => console.error("lms sync", e.message)), 3600e3).unref(); }
store.init().then(() => app.listen(PORT, () => console.log(`Job desk on :${PORT} (${process.env.DATABASE_URL ? "Postgres" : "local file"} store, WhatsApp ${wa.enabled() ? "live" : "simulated"}, diary sync ${diary.enabled() ? "on" : "off"})`)));
module.exports = app;
