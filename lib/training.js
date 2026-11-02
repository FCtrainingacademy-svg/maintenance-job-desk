// FC Training Academy line: onsite portfolio jobs for learners, on FC's own WhatsApp number.
//   1. Office logs a training job (appliance + job type, date, address) on /training and posts it to a cohort.
//   2. Every learner in that cohort gets a WhatsApp alert from the FC number with Accept / Not for me buttons.
//   3. First learner to accept is put forward; the office confirms a supervising Gas Safe engineer.
//   4. Learner and supervisor both get the address and each other's details.
//   5. Learner ticks the portfolio checklist and says what they did; the supervisor (or office) signs it off.
//   6. Done / signed-off jobs are written back to the learner's record in the LMS (Onsite portfolio jobs).
// No money on these jobs. Learners come from the LMS (LMS_URL + LMS_KEY); without those, add them by hand.
const crypto = require("crypto");

const APPLIANCES = { boiler: "Boiler", cooker: "Cooker" };
const TYPES = { install: "Install", service: "Service", fault: "Fault find", pipework: "Pipework" };
// Portfolio target per learner: for boiler and for cooker, 5 installs, 5 services, 4 fault finds, 1 pipework (30 in all).
const TARGET = { install: 5, service: 5, fault: 4, pipework: 1 };
const PHOTOS = "Photos (before / during / after) uploaded to Ecordia";
const FAULT = ["Customer's description of the fault recorded", "Symptoms / fault codes noted", "Diagnostic steps and readings recorded", "Cause of the fault identified",
  "Repair carried out / part replaced (make, model, part no.)", "Tightness test after repair", "Working pressure checked", "Any unsafe situation dealt with under GIUSP", "Job record completed", PHOTOS];
const PIPEWORK = ["Pipe sizing calculation done", "Route, materials, clipping and sleeving to standard", "Protective equipotential bonding checked", "Tightness test (let-by, stabilise, test) recorded",
  "Purge carried out", "Pipework labelled where needed", PHOTOS];
const CHECKLISTS = {
  boiler: {
    install: ["Pre-installation survey and customer agreement", "Gas supply and pipe sizing checked (meter to appliance)", "Flue route and terminal position to MI / BS 5440", "Condensate route and termination",
      "Tightness test (let-by, stabilise, test) recorded", "Purge carried out", "Gas rate / heat input checked", "Working and operating pressure recorded", "Combustion analysis (FGA) readings recorded",
      "Safety devices checked", "Benchmark / commissioning record completed", "Customer handover and instructions", PHOTOS],
    service: ["Customer-reported issues and visual inspection", "Tightness test recorded", "Working pressure recorded", "Gas rate checked", "Components cleaned / inspected to MI",
      "Combustion analysis (FGA) readings recorded", "Flue integrity and terminal checked", "Safety devices checked", "Service record / Benchmark service section completed", PHOTOS],
    fault: FAULT, pipework: PIPEWORK,
  },
  cooker: {
    install: ["Location and clearances checked to MI", "Stability bracket / chain fitted", "Bayonet and flexible hose fitted (right length, no kinks)", "Tightness test recorded", "Purge carried out",
      "Operating pressure recorded", "Burners lit and flame picture checked", "Flame supervision devices and ignition checked", "Ventilation checked", "Customer instructions given", PHOTOS],
    service: ["Visual inspection and customer-reported issues", "Tightness test recorded", "Operating pressure recorded", "Burners cleaned and flame picture checked", "Flame supervision devices checked",
      "Hose and bayonet condition checked", "Stability bracket checked", "Ventilation checked", "Service record completed", PHOTOS],
    fault: FAULT, pipework: PIPEWORK,
  },
};
const checklistFor = j => ((CHECKLISTS[j.appliance] || {})[j.type]) || [];
const STATUS = { draft: "Not posted", open: "Posted – waiting for a learner", accepted: "Learner accepted – confirm supervisor", confirmed: "Confirmed", done: "Done – to sign off", signedoff: "Signed off", cancelled: "Cancelled" };

const env = process.env;
const T_ALERT = env.TEMPLATE_TRAINING_ALERT || "training_job_alert";
const T_CONFIRMED = env.TEMPLATE_TRAINING_CONFIRMED || "training_job_confirmed";
const nowISO = () => new Date().toISOString();
const firstName = s => String(s || "").trim().split(/\s+/)[0] || "";
const outward = pc => { pc = String(pc || "").trim().toUpperCase(); if (!pc) return ""; const p = pc.split(/\s+/); return p.length > 1 ? p[0] : pc.slice(0, Math.max(2, pc.length - 3)); };
const fmtDT = iso => { if (!iso) return "To be arranged"; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); };
const kind = j => `${APPLIANCES[j.appliance] || ""} ${(TYPES[j.type] || "").toLowerCase()}`.trim();
const addr = j => [j.address, j.postcode].filter(Boolean).join(", ");
const s = (v, n = 300) => String(v == null ? "" : v).trim().slice(0, n);
const logLine = text => ({ at: nowISO(), text });
const sameDay = (a, b) => a && b && String(a).slice(0, 10) === String(b).slice(0, 10);

function makeTraining(store, wa, baseUrl, makeDiarySync) {
  const lmsOn = () => !!(env.LMS_URL && env.LMS_KEY);
  const lms = (p, opt = {}) => fetch(env.LMS_URL.replace(/\/$/, "") + p, { ...opt, headers: { "x-jobdesk-key": env.LMS_KEY, ...(opt.body ? { "Content-Type": "application/json" } : {}) } });
  const linkFor = p => `${baseUrl()}/t/${p.token}`;
  const newToken = () => crypto.randomBytes(18).toString("base64url");
  const diary = makeDiarySync ? makeDiarySync() : null;

  /* ---------- learners ---------- */
  async function syncLearners() {
    if (!lmsOn()) return { error: "The LMS link isn't set up (LMS_URL and LMS_KEY)." };
    let r;
    try { r = await lms("/api/jobdesk/learners"); } catch (e) { return { error: "Couldn't reach the LMS: " + e.message }; }
    if (!r.ok) return { error: `The LMS answered ${r.status}${r.status === 401 ? " – check LMS_KEY matches JOBDESK_KEY on the LMS" : ""}` };
    const list = ((await r.json()) || {}).learners || [];
    const have = new Map((await store.list("tlearners")).map(l => [l.id, l]));
    let added = 0, updated = 0, off = 0;
    for (const l of list) {
      if (!l.id) continue;
      const cur = have.get(l.id);
      const doc = { ...(cur || {}), id: l.id, name: l.name, phone: l.phone, email: l.email, cohort: l.cohort, programme: l.programme, mentor: l.mentor, employer: l.employer,
        fromLms: true, active: true, token: (cur && cur.token) || newToken(), syncedAt: nowISO() };
      await store.put("tlearners", l.id, doc); cur ? updated++ : added++; have.delete(l.id);
    }
    for (const [id, l] of have) if (l.fromLms && l.active !== false) { await store.put("tlearners", id, { ...l, active: false, syncedAt: nowISO() }); off++; }
    await store.put("settings", "training-sync", { at: nowISO(), count: list.length, added, updated, off });
    return { ok: true, count: list.length, added, updated, off };
  }
  // Write a finished job back to the learner's LMS record.
  async function pushLms(j) {
    if (!lmsOn() || !j.learner || !["done", "signedoff"].includes(j.status)) return;
    const body = { learnerId: j.learner.id, ref: j.ref, appliance: j.appliance, type: j.type, date: j.date || (j.doneAt || "").slice(0, 16), postcode: j.postcode,
      supervisor: (j.supervisor || {}).name || "", supervisorGasSafe: (j.supervisor || {}).gasSafe || "", description: j.description, findings: j.findings,
      checklist: checklistFor(j).map(item => ({ item, done: !!(j.checklist || {})[item] })), status: j.status, signedOffBy: j.signedOffBy || "", signedOffAt: j.signedOffAt || "",
      link: /^https:/.test(baseUrl()) ? `${baseUrl()}/training?job=${encodeURIComponent(j.id)}` : "" };
    let res;
    try { const r = await lms("/api/jobdesk/sitejob/" + encodeURIComponent(j.id), { method: "PUT", body: JSON.stringify(body) }); res = r.ok ? { ok: true } : { error: `LMS answered ${r.status}` }; }
    catch (e) { res = { error: e.message }; }
    await store.withLock("tjobs", j.id, async cur => cur ? { doc: { ...cur, lms: { ...res, at: nowISO() } } } : null);
  }
  function pushDiary(j) {
    if (!diary || !j || !j.ref) return;
    const status = j.status === "cancelled" ? "cancelled" : ["done", "signedoff"].includes(j.status) ? "complete" : "scheduled";
    const who = [j.learner && firstName(j.learner.name), j.supervisor && "sup. " + firstName(j.supervisor.name)].filter(Boolean).join(" + ");
    diary.push({ ref: j.ref, status, category: "FC Training", description: `FC Training: ${kind(j)}${who ? " – " + who : ""}`, scheduledAt: j.date,
      property: { address: j.address, postcode: j.postcode }, source: { name: (j.customer || {}).name || "", phone: (j.customer || {}).phone || "" } }, baseUrl() + "/training")
      .catch(e => console.error("diary sync (training)", e.message));
  }

  /* ---------- jobs ---------- */
  async function nextRef() {
    const r = await store.withLock("settings", "training-counter", async cur => ({ doc: { n: ((cur && cur.n) || 0) + 1 } }));
    return "FC-" + String(r.doc.n).padStart(4, "0");
  }
  async function saveJob(id, b) {
    if (!APPLIANCES[b.appliance] || !TYPES[b.type]) return { error: "Choose the appliance and job type" };
    const fields = { appliance: b.appliance, type: b.type, description: s(b.description, 1000), date: s(b.date, 16), address: s(b.address, 200), postcode: s(b.postcode, 10).toUpperCase(),
      access: s(b.access, 500), cohort: s(b.cohort, 60), customer: { name: s((b.customer || {}).name, 100), phone: s((b.customer || {}).phone, 30) } };
    if (!fields.postcode) return { error: "Add the postcode" };
    if (id) {
      const r = await store.withLock("tjobs", id, async cur => cur ? { doc: { ...cur, ...fields, log: (cur.log || []).concat(logLine("Job details edited")) } } : { missing: true });
      if (r.missing) return { error: "Job not found" };
      pushDiary(r.doc); return { ok: true, id };
    }
    id = "t-" + crypto.randomBytes(6).toString("hex");
    const doc = { ...fields, id, ref: await nextRef(), status: "draft", createdAt: nowISO(), log: [logLine("Job logged")] };
    await store.put("tjobs", id, doc);
    return { ok: true, id, ref: doc.ref };
  }
  const learnersFor = async cohort => (await store.list("tlearners")).filter(l => l.active !== false && l.phone && (!cohort || l.cohort === cohort));
  function alert(j, l) {
    return wa.template(l.phone, T_ALERT, [j.ref, kind(j), outward(j.postcode) || "London", fmtDT(j.date), j.description || kind(j), linkFor(l)],
      [`TACCEPT:${j.id}`, `TDECLINE:${j.id}`], `Training job ${j.ref} (${kind(j)}) to ${l.name}`);
  }
  async function post(jobId) {
    const cur = await store.get("tjobs", jobId); if (!cur) return { error: "Job not found" };
    if (!["draft", "open"].includes(cur.status)) return { error: "This job already has a learner." };
    const ls = await learnersFor(cur.cohort);
    if (!ls.length) return { error: cur.cohort ? `No active learners with a phone number in cohort ${cur.cohort}.` : "No active learners with a phone number. Sync learners from the LMS first." };
    const r = await store.withLock("tjobs", jobId, async j => ({ doc: { ...j, status: "open", recipients: ls.map(l => l.id), postedAt: nowISO(),
      log: (j.log || []).concat(logLine(`Posted to ${ls.length} learner${ls.length > 1 ? "s" : ""}${j.cohort ? " (cohort " + j.cohort + ")" : ""}`)) } }));
    const out = [];
    for (const l of ls) out.push({ name: l.name, ...(await alert(r.doc, l)) });
    pushDiary(r.doc);
    return { ok: true, results: out, simulated: !wa.enabled() };
  }
  // First learner to accept is put forward (row lock, so two at once can't both get it).
  async function accept(l, jobId, via) {
    const r = await store.withLock("tjobs", jobId, async j => {
      if (!j) return { error: "That job no longer exists." };
      if (j.status !== "open") return { error: j.learner && j.learner.id === l.id ? `You've already got ${j.ref}.` : `Sorry – ${j.ref} has already been taken.` };
      if (!(j.recipients || []).includes(l.id)) return { error: "This job wasn't sent to you." };
      const clash = (await store.list("tjobs")).find(x => x.id !== j.id && x.learner && x.learner.id === l.id && ["accepted", "confirmed"].includes(x.status) && sameDay(x.date, j.date));
      return { doc: { ...j, status: "accepted", learner: { id: l.id, name: l.name, phone: l.phone, at: nowISO(), via }, clash: clash ? `${l.name} also has ${clash.ref} that day` : "",
        log: (j.log || []).concat(logLine(`${l.name} accepted${via === "whatsapp" ? " on WhatsApp" : ""}`)) } };
    });
    if (r.error) return { ok: false, error: r.error };
    pushDiary(r.doc);
    return { ok: true, doc: r.doc };
  }
  async function assign(jobId, learnerId) {
    const l = await store.get("tlearners", learnerId); if (!l) return { error: "Learner not found" };
    const r = await store.withLock("tjobs", jobId, async j => {
      if (!j) return { missing: true };
      if (["done", "signedoff", "cancelled"].includes(j.status)) return { error: "This job is closed." };
      const keepSup = j.status === "confirmed" && j.supervisor;
      return { doc: { ...j, status: keepSup ? "confirmed" : "accepted", learner: { id: l.id, name: l.name, phone: l.phone, at: nowISO(), via: "office" },
        log: (j.log || []).concat(logLine(`Office put ${l.name} on the job`)) } };
    });
    if (r.missing) return { error: "Job not found" };
    if (r.error) return r;
    if (r.doc.status === "confirmed") await sendConfirmed(r.doc, "learner");
    pushDiary(r.doc);
    return { ok: true };
  }
  // Is the supervisor already on a maintenance job (or another training job) that day?
  async function supervisorClashes(sup, j) {
    const out = [];
    const ks = (await store.list("contractors")).filter(k => k.phone && wa.intl(k.phone) === wa.intl(sup.phone)).map(k => k.id);
    if (ks.length) for (const m of await store.list("jobs")) {
      const d = m.dispatch || {}, on = ks.includes(d.allocatedTo) || (d.team || []).some(t => ks.includes(t.id));
      if (on && !(m.track || {}).done && m.status !== "cancelled" && sameDay(m.scheduledAt || d.contractorAttendBy || m.attendBy, j.date)) out.push(`maintenance job ${m.ref} ${fmtDT(m.scheduledAt || d.contractorAttendBy || m.attendBy)}`);
    }
    for (const t of await store.list("tjobs")) if (t.id !== j.id && t.supervisor && t.supervisor.id === sup.id && t.status === "confirmed" && sameDay(t.date, j.date)) out.push(`training job ${t.ref} ${fmtDT(t.date)}`);
    return out;
  }
  async function confirm(jobId, supId) {
    const sup = await store.get("tsupervisors", supId); if (!sup || sup.active === false) return { error: "Choose a supervisor" };
    const cur = await store.get("tjobs", jobId); if (!cur) return { error: "Job not found" };
    const clashes = await supervisorClashes(sup, cur);
    const r = await store.withLock("tjobs", jobId, async j => {
      if (!j.learner) return { error: "No learner on this job yet." };
      if (!["accepted", "confirmed"].includes(j.status)) return { error: "This job can't be confirmed now." };
      return { doc: { ...j, status: "confirmed", confirmedAt: nowISO(), supervisor: { id: sup.id, name: sup.name, phone: sup.phone, gasSafe: sup.gasSafe || "" },
        log: (j.log || []).concat(logLine(`Confirmed – supervisor ${sup.name}`)) } };
    });
    if (r.error) return r;
    const sent = [await sendConfirmed(r.doc, "learner"), await sendConfirmed(r.doc, "supervisor")];
    pushDiary(r.doc);
    return { ok: true, clashes, sent, simulated: !wa.enabled() };
  }
  async function sendConfirmed(j, who) {
    const L = j.learner || {}, S = j.supervisor || {};
    const person = who === "learner" ? await store.get("tlearners", L.id) : await store.get("tsupervisors", S.id);
    if (!person || !person.phone) return { who, ok: false, error: "No phone number" };
    if (!person.token) { person.token = newToken(); await store.put(who === "learner" ? "tlearners" : "tsupervisors", person.id, person); }
    const other = who === "learner" ? `Your supervisor: ${S.name}${S.phone ? " – " + S.phone : ""}${S.gasSafe ? " (Gas Safe " + S.gasSafe + ")" : ""}`
      : `Learner: ${L.name}${L.phone ? " – " + L.phone : ""}. You're the supervising engineer.`;
    const r = await wa.template(person.phone, T_CONFIRMED, [j.ref, kind(j), addr(j) || "-", fmtDT(j.date), other, linkFor(person)], null, `Training job ${j.ref} confirmed to ${who} ${person.name}`);
    return { who, name: person.name, ...r };
  }
  async function reopen(jobId) {
    const r = await store.withLock("tjobs", jobId, async j => {
      if (!j) return { error: "Job not found" };
      if (!["accepted", "confirmed"].includes(j.status)) return { error: "Only jobs waiting for confirmation or confirmed can be re-opened." };
      return { doc: { ...j, status: "open", learner: null, supervisor: null, confirmedAt: "", clash: "", log: (j.log || []).concat(logLine(`Re-opened – ${j.learner ? j.learner.name + " taken off" : ""}`)) } };
    });
    if (r.error) return r;
    const ls = (await learnersFor(r.doc.cohort)).filter(l => (r.doc.recipients || []).includes(l.id));
    for (const l of ls) await alert(r.doc, l);
    pushDiary(r.doc);
    return { ok: true, realerted: ls.length };
  }
  async function done(l, jobId, b) {
    const findings = s(b.findings, 2000);
    if (!findings) return { ok: false, error: "Say what you did on the job" };
    const r = await store.withLock("tjobs", jobId, async j => {
      if (!j || !j.learner || j.learner.id !== l.id) return { error: "This job isn't yours." };
      if (j.status !== "confirmed") return { error: j.status === "accepted" ? "Wait for the office to confirm your supervisor first." : "This job can't be marked done now." };
      const list = checklistFor(j), ck = {};
      list.forEach(item => { ck[item] = !!(b.checklist || {})[item]; });
      return { doc: { ...j, status: "done", doneAt: nowISO(), findings, checklist: ck, log: (j.log || []).concat(logLine(`${l.name} marked it done (${Object.values(ck).filter(Boolean).length}/${list.length} checklist)`)) } };
    });
    if (r.error) return { ok: false, error: r.error };
    pushLms(r.doc).catch(e => console.error("lms", e.message)); pushDiary(r.doc);
    const S = r.doc.supervisor || {}, sup = S.id && await store.get("tsupervisors", S.id);
    if (sup && sup.phone) wa.text(sup.phone, `${l.name} has marked training job ${r.doc.ref} as done. Please check and sign it off: ${linkFor(sup)}`).catch(() => {});
    return { ok: true };
  }
  async function signoff(jobId, by) {
    const r = await store.withLock("tjobs", jobId, async j => {
      if (!j) return { error: "Job not found" };
      if (j.status !== "done") return { error: "Only jobs the learner has marked done can be signed off." };
      return { doc: { ...j, status: "signedoff", signedOffBy: by, signedOffAt: nowISO(), log: (j.log || []).concat(logLine(`Signed off by ${by}`)) } };
    });
    if (r.error) return { ok: false, error: r.error };
    pushLms(r.doc).catch(e => console.error("lms", e.message)); pushDiary(r.doc);
    const L = r.doc.learner || {}, l = L.id && await store.get("tlearners", L.id);
    if (l && l.phone) wa.text(l.phone, `✅ Training job ${r.doc.ref} (${kind(r.doc)}) has been signed off by ${by}. It's been added to your portfolio record.`).catch(() => {});
    return { ok: true };
  }
  async function cancel(jobId) {
    const r = await store.withLock("tjobs", jobId, async j => j ? { doc: { ...j, status: "cancelled", log: (j.log || []).concat(logLine("Cancelled")) } } : { error: "Job not found" });
    if (r.error) return r;
    pushDiary(r.doc);
    return { ok: true };
  }

  /* ---------- what learners and supervisors see on their link ---------- */
  const publicView = j => ({ id: j.id, ref: j.ref, appliance: j.appliance, type: j.type, kind: kind(j), description: j.description, date: j.date, area: outward(j.postcode) });
  // Address, access and customer details only once the supervisor is confirmed.
  const fullView = (j, role) => { const shown = !["open", "accepted", "draft"].includes(j.status); return { ...publicView(j), status: j.status,
    address: shown ? addr(j) : "", access: shown ? j.access || "" : "", customer: shown ? j.customer || {} : {}, findings: j.findings || "",
    checklistItems: checklistFor(j), checklist: j.checklist || {}, signedOffBy: j.signedOffBy || "", doneAt: j.doneAt || "",
    learner: role === "supervisor" && j.learner ? { name: j.learner.name, phone: j.learner.phone } : null,
    supervisor: j.supervisor ? { name: j.supervisor.name, phone: j.supervisor.phone, gasSafe: j.supervisor.gasSafe } : null }; };
  async function personFor(token) {
    if (!token || token.length < 16) return null;
    const eq = t => t && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
    const l = (await store.list("tlearners")).find(x => eq(x.token)); if (l) return l.active === false ? null : { role: "learner", p: l };
    const sp = (await store.list("tsupervisors")).find(x => eq(x.token)); if (sp) return sp.active === false ? null : { role: "supervisor", p: sp };
    return null;
  }
  function progress(jobs, lid) {
    const mine = jobs.filter(j => j.learner && j.learner.id === lid && ["done", "signedoff"].includes(j.status)), out = {};
    for (const a of Object.keys(APPLIANCES)) { out[a] = {}; for (const t of Object.keys(TYPES)) out[a][t] = { done: mine.filter(j => j.appliance === a && j.type === t).length, target: TARGET[t] }; }
    return { total: mine.length, target: 30, grid: out };
  }
  async function boardFor(who) {
    const jobs = await store.list("tjobs"), byDate = (a, b) => String(a.date || "9").localeCompare(String(b.date || "9"));
    if (who.role === "learner") {
      const l = who.p;
      return { role: "learner", me: { name: l.name, cohort: l.cohort || "" },
        open: jobs.filter(j => j.status === "open" && (j.recipients || []).includes(l.id)).sort(byDate).map(publicView),
        mine: jobs.filter(j => j.learner && j.learner.id === l.id && j.status !== "cancelled").sort(byDate).map(j => fullView(j, "learner")),
        progress: progress(jobs, l.id), labels: { appliances: APPLIANCES, types: TYPES } };
    }
    const sp = who.p;
    return { role: "supervisor", me: { name: sp.name }, open: [],
      mine: jobs.filter(j => j.supervisor && j.supervisor.id === sp.id && ["confirmed", "done", "signedoff"].includes(j.status)).sort(byDate).map(j => fullView(j, "supervisor")),
      labels: { appliances: APPLIANCES, types: TYPES } };
  }

  /* ---------- WhatsApp messages to the FC number ---------- */
  async function handleIncoming(from, payload, body, type) {
    const learners = await store.list("tlearners"), sups = await store.list("tsupervisors");
    const l = learners.find(x => x.active !== false && x.phone && wa.intl(x.phone) === from);
    const sp = !l && sups.find(x => x.active !== false && x.phone && wa.intl(x.phone) === from);
    if (!l && !sp) {
      // Not a learner or supervisor: probably a website enquiry. Keep it for the office, don't auto-reply.
      const id = Date.now() + "-" + crypto.randomBytes(3).toString("hex");
      await store.put("tinbox", id, { at: nowISO(), from, type, text: s(body || (type !== "text" ? `[${type}]` : ""), 2000) });
      return true;
    }
    if (sp) { await wa.text(sp.phone, `Hi ${firstName(sp.name)}, your FC Training supervision jobs are here:\n${linkFor(sp)}`); return true; }
    if (!l.token) { l.token = newToken(); await store.put("tlearners", l.id, l); }
    let action = null, jobId = null;
    if (payload && /^T(ACCEPT|DECLINE):/.test(payload)) [action, jobId] = payload.split(":");
    else {
      const m = String(body || "").trim().match(/^(yes|accept|y|no|decline)\b[\s:#-]*(FC-?\d+)?/i);
      if (m) {
        action = /^(yes|accept|y)$/i.test(m[1]) ? "TACCEPT" : "TDECLINE";
        const jobs = await store.list("tjobs"), ref = m[2] ? m[2].toUpperCase().replace(/^FC-?/, "FC-") : null;
        const pool = jobs.filter(j => j.status === "open" && (j.recipients || []).includes(l.id));
        const j = ref ? jobs.find(x => x.ref === ref) : (pool.length === 1 ? pool[0] : null);
        if (!j && action === "TACCEPT") {
          await wa.text(l.phone, pool.length ? `Which job? Reply YES and the job number, e.g. YES ${pool[0].ref}.\nYour job board: ${linkFor(l)}` : `There are no open training jobs for you right now. Your job board: ${linkFor(l)}`);
          return true;
        }
        jobId = j && j.id;
      }
    }
    if (action === "TACCEPT" && jobId) {
      const r = await accept(l, jobId, "whatsapp");
      await wa.text(l.phone, r.ok ? `👍 Thanks ${firstName(l.name)} – you're put forward for ${r.doc.ref} (${kind(r.doc)}, ${fmtDT(r.doc.date)}).\nThe office will confirm your supervisor, then you'll get the address.\nYour job board: ${linkFor(l)}` : r.error);
      return true;
    }
    if (action === "TDECLINE") { await wa.text(l.phone, "No problem, thanks for letting us know."); return true; }
    await wa.text(l.phone, `Hi ${firstName(l.name)}, your FC Training job board is here:\n${linkFor(l)}\n\nTo take a job you can also reply YES and the job number, e.g. YES FC-0001.`);
    return true;
  }
  const isTrainingNumber = phoneId => !!(env.TRAINING_WHATSAPP_PHONE_ID && String(phoneId) === String(env.TRAINING_WHATSAPP_PHONE_ID));

  return { syncLearners, saveJob, post, accept, assign, confirm, reopen, done, signoff, cancel, personFor, boardFor, handleIncoming, isTrainingNumber, linkFor, newToken, lmsOn, pushLms,
    CHECKLISTS, APPLIANCES, TYPES, TARGET, STATUS };
}

module.exports = { makeTraining, CHECKLISTS, APPLIANCES, TYPES, TARGET };
