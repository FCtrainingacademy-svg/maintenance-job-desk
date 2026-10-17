// End-to-end check of WhatsApp job intake and group jobs (2 engineers + 1 reserve).
// Starts a fake diary to receive the job pushes. Usage (server on :3999 with a fresh data file):
//   DIARY_SYNC_URL=http://localhost:3998/sync DIARY_SYNC_KEY=k OFFICE_PASSWORD=test PORT=3999 DATA_FILE=/tmp/x.json npm start &
//   BASE=http://localhost:3999 OFFICE_PASSWORD=test node test/intake.js
const assert = require("assert");
const http = require("http");
const BASE = process.env.BASE || "http://localhost:3999";
let cookie = "";
const diaryHits = [];
const fake = http.createServer((req, res) => {
  let b = ""; req.on("data", c => b += c); req.on("end", () => { diaryHits.push({ key: req.headers["x-diary-key"], body: JSON.parse(b || "{}") }); res.setHeader("Content-Type", "application/json"); res.end('{"ok":true}'); });
}).listen(3998);

async function req(method, path, body, useCookie = true) {
  const r = await fetch(BASE + path, { method, redirect: "manual", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(useCookie && cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
const ok = (c, m) => { assert(c, m); console.log("  ✓", m); };
const wait = (ms = 250) => new Promise(r => setTimeout(r, ms));
const hook = (from, msg) => fetch(BASE + "/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from, ...msg }] } }] }] }) }).then(() => wait());
const say = (from, text) => hook(from, { type: "text", text: { body: text } });
const tap = (from, payload) => hook(from, { type: "button", button: { payload, text: "Accept job" } });
async function outbox() { return (await req("GET", "/api/all")).body.outbox; }
async function lastTo(num) { return (await outbox()).find(o => o.to === num); }

const ANIS = "447700900123";
(async () => {
  const r0 = await fetch(BASE + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=" + encodeURIComponent(process.env.OFFICE_PASSWORD) });
  cookie = r0.headers.get("set-cookie").split(";")[0];

  await req("PUT", "/api/docs/settings/business", { bizName: "Test Maintenance Ltd", bizPhone: "020 0000 0000" });
  const tok = k => `tok${k}_` + k.repeat(20);
  const K = { A: "07700 900201", B: "07700 900202", C: "07700 900203", D: "07700 900204" };
  for (const [k, ph] of Object.entries(K)) await req("PUT", `/api/docs/contractors/g${k}`, { name: `${k}l Test${k}`, phone: ph, token: tok(k), active: true, trades: [] });
  await req("PUT", "/api/docs/settings/intake", { senders: [{ name: "Anis", phone: "07700 900123" }],
    groups: [{ id: "g1", name: "Ilford", members: ["gA", "gB", "gC", "gD"], isDefault: true }, { id: "g2", name: "East", members: ["gA"] }] });

  // unknown number is ignored
  await say("447700999999", "Wed 22 Oct 9am, 14 Cranbrook Rd IG1 4PU, combi no hot water");
  ok(!(await lastTo("447700999999")), "messages from numbers not on the list are ignored");

  // missing details
  await say(ANIS, "boiler broken tomorrow");
  ok(/couldn't find the time or postcode/.test((await lastTo(ANIS)).summary), "missing time and postcode are asked for");

  // full job → summary
  await say(ANIS, "Wed 22 Oct 9am, 14 Cranbrook Rd IG1 4PU, combi no hot water E119");
  let m = (await lastTo(ANIS)).summary;
  ok(/IG1 4PU/.test(m) && /Combi no hot water/.test(m) && /Ilford group \(4 contractors\)/.test(m) && /Reply YES/.test(m), "bot replies with what it read and the default group");
  await say(ANIS, "group east");
  ok(/East group \(1 contractor\)/.test((await lastTo(ANIS)).summary), "GROUP changes the group");
  await say(ANIS, "group Ilford");
  let jobs = (await req("GET", "/api/all")).body.jobs;
  ok(!jobs.some(j => j.source && j.source.via === "whatsapp"), "nothing is posted before YES");

  await say(ANIS, "yes");
  jobs = (await req("GET", "/api/all")).body.jobs;
  const job = jobs.find(j => j.source && j.source.via === "whatsapp");
  ok(job && job.dispatch.mode === "group" && job.dispatch.recipients.length === 4 && job.scheduledAt === "2026-10-22T09:00" && job.property.postcode === "IG1 4PU", "YES creates the job for the Ilford group");
  ok(/^Posted ✓ PM-\d{4}/.test((await lastTo(ANIS)).summary), "sender told it's posted");
  const ob = await outbox();
  ok(["447700900201", "447700900202", "447700900203", "447700900204"].every(n => ob.some(o => o.to === n && o.summary.includes(job.ref))), "all 4 group members alerted");
  await wait(300);
  const d0 = diaryHits.find(h => h.body.ref === job.ref);
  ok(d0 && d0.key === "k" && d0.body.date === "2026-10-22" && d0.body.start === "09:00" && /0\/2 engineers/.test(d0.body.title), "job pushed to the diary");
  await say(ANIS, "yes");
  ok(/Nothing waiting/.test((await lastTo(ANIS)).summary), "a second YES doesn't post it twice");

  // board before acceptance: postcode, no address
  let b = (await req("GET", `/api/c/${tok("A")}`, null, false)).body;
  ok(b.board.length === 1 && b.board[0].area === "IG1 4PU" && b.board[0].places === 2 && !JSON.stringify(b.board).includes("Cranbrook"), "contractors see date, postcode and job but not the address");

  // 1st accept – WhatsApp button
  await tap("447700900201", `ACCEPT:${job.id}`);
  ok(/You're on job .* \(1 of 2\)/.test((await lastTo("447700900201")).summary) && /Cranbrook/.test((await lastTo("447700900201")).summary) && /Anis – 07700 900123/.test((await lastTo("447700900201")).summary), "1st accept gets address and sender's contact");
  ok(/accepted \(1\/2\)/.test((await lastTo(ANIS)).summary), "sender told 1/2");
  // 2nd accept – job page
  let r = await req("POST", `/api/c/${tok("B")}/jobs/${job.id}/accept`, {}, false);
  ok(r.status === 200 && r.body.role === "team", "2nd accept on the job page");
  let j = (await req("GET", `/api/docs/jobs/${job.id}`)).body.data;
  ok(j.dispatch.team.length === 2 && j.dispatch.status === "allocated" && j.status === "scheduled", "job filled with 2");
  ok(/is filled ✓/.test((await lastTo(ANIS)).summary), "sender told it's filled");
  b = (await req("GET", `/api/c/${tok("B")}`, null, false)).body;
  ok(b.mine.length === 1 && b.mine[0].contact.name === "Anis" && b.mine[0].property.address === "14 Cranbrook Rd" && b.mine[0].team.length === 1, "engineer page shows address, contact and teammate");
  // 3rd – reserve by text
  await say("447700900203", `yes ${job.ref}`);
  ok(/You're the reserve/.test((await lastTo("447700900203")).summary) && !/Cranbrook/.test((await lastTo("447700900203")).summary), "3rd becomes reserve without the address");
  b = (await req("GET", `/api/c/${tok("C")}`, null, false)).body;
  ok(b.board.length === 1 && b.board[0].iAmReserve && b.mine.length === 0, "reserve sees it as reserve");
  // 4th – full
  await tap("447700900204", `ACCEPT:${job.id}`);
  ok(/is full/.test((await lastTo("447700900204")).summary), "4th is told it's full");
  b = (await req("GET", `/api/c/${tok("D")}`, null, false)).body;
  ok(b.board.length === 0, "full job leaves the others' boards");
  // repeat accept
  await tap("447700900201", `ACCEPT:${job.id}`);
  ok(/already on job/.test((await lastTo("447700900201")).summary), "accepting twice is refused");

  // DROP → reserve moves up
  await say("447700900201", "drop");
  j = (await req("GET", `/api/docs/jobs/${job.id}`)).body.data;
  ok(j.dispatch.team.map(t => t.id).join() === "gB,gC" && !j.dispatch.reserve && j.dispatch.status === "allocated", "DROP: reserve moves up");
  ok(/place has opened/.test((await lastTo("447700900203")).summary) && /Cranbrook/.test((await lastTo("447700900203")).summary), "promoted reserve gets address and contact");
  ok(/moved up/.test((await lastTo(ANIS)).summary), "sender told reserve moved up");
  // office takes one off → no reserve → reopens and re-alerts
  r = await req("POST", `/api/jobs/${job.id}/team-remove`, { kid: "gB" });
  ok(r.status === 200 && r.body.reopened, "office takes someone off; place reopens");
  j = (await req("GET", `/api/docs/jobs/${job.id}`)).body.data;
  ok(j.dispatch.team.length === 1 && j.dispatch.status === "open" && j.status === "new", "job back to 1/2 and open");
  const ob2 = await outbox();
  ok(["447700900201", "447700900202", "447700900204"].every(n => ob2.find(o => o.to === n && /1 place left/.test(o.summary))), "group re-alerted for the open place");
  b = (await req("GET", `/api/c/${tok("D")}`, null, false)).body;
  ok(b.board.length === 1 && b.board[0].places === 1, "open place back on the board");
  await wait(300);
  const last = diaryHits.filter(h => h.body.ref === job.ref).pop();
  ok(/1\/2 engineers \(Cl\)/.test(last.body.title) && /Reserve/.test(last.body.notes) === false, "diary entry kept up to date");

  // withdraw / delete removes it from the diary
  await req("DELETE", `/api/docs/jobs/${job.id}`);
  await wait(300);
  ok(diaryHits.some(h => h.body.ref === job.ref && h.body.delete), "deleting the job removes it from the diary");

  // labelled format + #group
  await say(ANIS, "Date: 24/10\nTime: 10:30\nAddress: 5 Green Lane, Ilford IG3 9XX\nJob: Annual boiler service\n#east");
  ok(/East group/.test((await lastTo(ANIS)).summary) && /5 Green Lane, Ilford, IG3 9XX/.test((await lastTo(ANIS)).summary), "labelled lines and #group work");
  await say(ANIS, "no");
  ok(/Cancelled/.test((await lastTo(ANIS)).summary), "NO cancels");
  console.log("\nAll intake checks passed.");
  fake.close();
})().catch(e => { console.error("FAILED:", e.message); fake.close(); process.exit(1); });
