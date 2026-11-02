// FC Training line end-to-end check. Starts a fake LMS on :3998 and the job desk on :3997 itself.
// Usage: node test/training.js
const assert = require("assert");
const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const KEY = "k".repeat(32), LMS = 3998, PORT = 3997, BASE = `http://localhost:${PORT}`;
const ok = (c, m) => { assert(c, m); console.log("  ✓", m); };
const learners = [
  { id: "L1", name: "Yusuf Butt", phone: "07700 900101", cohort: "1", status: "Active" },
  { id: "L2", name: "Danish Feroz", phone: "07700 900102", cohort: "1" },
  { id: "L3", name: "Other Cohort", phone: "07700 900103", cohort: "2" },
];
const sitejobs = {};
const lms = http.createServer((req, res) => {
  if (req.headers["x-jobdesk-key"] !== KEY) { res.writeHead(401); return res.end("{}"); }
  if (req.method === "GET" && req.url === "/api/jobdesk/learners") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ learners })); }
  let b = ""; req.on("data", c => b += c); req.on("end", () => { sitejobs[decodeURIComponent(req.url.split("/").pop())] = JSON.parse(b); res.writeHead(200); res.end('{"ok":true}'); });
});
let cookie = "";
async function req(method, p, body, useCookie = true) {
  const r = await fetch(BASE + p, { method, redirect: "manual", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(useCookie && cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const hook = (from, msg) => req("POST", "/webhook", { entry: [{ changes: [{ value: { metadata: { phone_number_id: "PIDT" }, messages: [{ from, ...msg }] } }] }] }, false);
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => lms.listen(LMS, r));
  const dataFile = path.join(os.tmpdir(), `jd-training-${Date.now()}.json`);
  const srv = spawn(process.execPath, ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, PORT, OFFICE_PASSWORD: "test", DATA_FILE: dataFile, DATABASE_URL: "",
    LMS_URL: `http://localhost:${LMS}`, LMS_KEY: KEY, TRAINING_WHATSAPP_PHONE_ID: "PIDT", WHATSAPP_TOKEN: "", WHATSAPP_PHONE_ID: "", DIARY_SYNC_URL: "", WHATSAPP_APP_SECRET: "" }, stdio: "inherit" });
  try {
    for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + "/healthz")).ok) break; } catch {} await wait(150); }
    const lr = await fetch(BASE + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=test" });
    cookie = lr.headers.get("set-cookie").split(";")[0];

    let r = await req("GET", "/api/training/all", null, false); ok(r.status === 401, "training API needs the office login");
    r = await req("POST", "/api/training/sync-learners"); ok(r.body.ok && r.body.added === 3, "learners synced from the LMS");
    r = await req("GET", "/api/training/all"); const ls = r.body.tlearners;
    ok(ls.length === 3 && ls.every(l => l.token), "each learner has a personal link");
    const tok = id => ls.find(l => l.id === id).token;

    r = await req("PUT", "/api/training/supervisors/s1", { name: "Sam Super", phone: "07700 900201", gasSafe: "123456" }); ok(r.body.ok, "supervisor added");
    r = await req("POST", "/api/training/jobs", { appliance: "boiler", type: "service", date: "2026-11-10T09:00", address: "14 Cranbrook Rd", postcode: "IG1 4PU", cohort: "1", description: "Combi service", customer: { name: "Mrs Khan", phone: "07700 900301" } });
    ok(r.body.ok && r.body.ref === "FC-0001", "training job logged as FC-0001");
    const jid = r.body.id;
    r = await req("POST", `/api/training/jobs/${jid}/post`); ok(r.body.ok && r.body.results.length === 2 && r.body.simulated, "posted to the 2 learners in cohort 1 only (simulated)");

    r = await req("GET", `/api/t/${tok("L1")}`, null, false);
    ok(r.body.open.length === 1 && !JSON.stringify(r.body.open).includes("Cranbrook") && !JSON.stringify(r.body.open).includes("Khan"), "learner sees the job without address or customer");
    r = await req("GET", `/api/t/${tok("L3")}`, null, false); ok(r.body.open.length === 0, "other cohort doesn't see it");

    const [a, b] = await Promise.all([req("POST", `/api/t/${tok("L1")}/jobs/${jid}/accept`, {}, false), req("POST", `/api/t/${tok("L2")}/jobs/${jid}/accept`, {}, false)]);
    ok([a, b].filter(x => x.status === 200).length === 1, "two learners accept at once – only one gets it");
    const winner = a.status === 200 ? "L1" : "L2", loser = winner === "L1" ? "L2" : "L1";
    r = await req("GET", `/api/t/${tok(winner)}`, null, false);
    ok(r.body.mine[0].status === "accepted" && !JSON.stringify(r.body.mine).includes("Cranbrook"), "winner waits for supervisor, still no address");
    r = await req("POST", `/api/t/${tok(winner)}/jobs/${jid}/done`, { findings: "x" }, false); ok(r.status === 409, "can't mark done before the supervisor is confirmed");

    r = await req("POST", `/api/training/jobs/${jid}/confirm`, { supervisorId: "s1" }); ok(r.body.ok && r.body.sent.length === 2 && r.body.sent.every(x => x.ok), "office confirms supervisor – learner and supervisor messaged");
    r = await req("GET", `/api/t/${tok(winner)}`, null, false);
    ok(r.body.mine[0].address.includes("Cranbrook") && r.body.mine[0].supervisor.gasSafe === "123456", "learner now sees address and supervisor");
    const items = r.body.mine[0].checklistItems; ok(items.length > 5, "boiler service checklist shown");
    r = await req("POST", `/api/t/${tok(loser)}/jobs/${jid}/done`, { findings: "x" }, false); ok(r.status === 409, "other learner can't mark it done");
    const ck = {}; items.forEach((i, n) => ck[i] = n % 2 === 0);
    r = await req("POST", `/api/t/${tok(winner)}/jobs/${jid}/done`, { findings: "Serviced combi, FGA ok", checklist: ck }, false); ok(r.body.ok, "learner marks job done with checklist");
    await wait(300);
    ok(sitejobs[jid] && sitejobs[jid].status === "done" && sitejobs[jid].learnerId === winner && sitejobs[jid].appliance === "boiler", "done job written to the LMS");

    r = await req("GET", "/api/training/all"); const sup = r.body.tsupervisors[0];
    r = await req("POST", `/api/t/${tok(winner)}/jobs/${jid}/signoff`, {}, false); ok(r.status === 403, "learner can't sign off");
    r = await req("POST", `/api/t/${sup.token}/jobs/${jid}/signoff`, {}, false); ok(r.body.ok, "supervisor signs off from their link");
    await wait(300);
    ok(sitejobs[jid].status === "signedoff" && sitejobs[jid].signedOffBy === "Sam Super", "sign-off written to the LMS");
    r = await req("GET", `/api/t/${tok(winner)}`, null, false); ok(r.body.progress.total === 1 && r.body.progress.grid.boiler.service.done === 1, "learner portfolio progress counts it");

    // WhatsApp: button accept on the training number
    r = await req("POST", "/api/training/jobs", { appliance: "cooker", type: "install", postcode: "E7 9AB", cohort: "1" }); const j2 = r.body.id;
    await req("POST", `/api/training/jobs/${j2}/post`);
    await hook("447700900102", { type: "button", button: { payload: `TACCEPT:${j2}` } }); await wait(300);
    r = await req("GET", "/api/training/all");
    ok(r.body.tjobs.find(j => j.id === j2).learner.id === "L2", "learner accepts with the WhatsApp button");
    ok(r.body.outbox.some(o => /put forward/.test(o.summary)), "learner told they're put forward");
    await hook("447700999999", { type: "text", text: { body: "Hi do you do ACS courses?" } }); await wait(300);
    r = await req("GET", "/api/training/all");
    ok(r.body.tinbox.length === 1 && r.body.tinbox[0].text.includes("ACS"), "website enquiry kept for the office, no bot reply");
    ok(!r.body.outbox.some(o => o.to === "447700999999"), "no auto-reply to the enquiry");
    r = await req("GET", "/api/all"); ok(!("tjobs" in r.body) && !r.body.outbox.some(o => o.line === "training"), "maintenance office page unaffected");
    r = await req("POST", `/api/training/jobs/${j2}/reopen`); ok(r.body.ok, "office can take the learner off and re-post");
    console.log("\nAll training checks passed.");
  } finally { srv.kill(); lms.close(); fs.rmSync(dataFile, { force: true }); }
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
