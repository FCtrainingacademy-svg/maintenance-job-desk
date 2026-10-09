// End-to-end check against a running server (local file store, WhatsApp simulated).
// Usage: BASE=http://localhost:3999 OFFICE_PASSWORD=test node test/e2e.js
const assert = require("assert");
const BASE = process.env.BASE || "http://localhost:3999";
let cookie = "";
async function req(method, path, body, useCookie = true) {
  const r = await fetch(BASE + path, { method, redirect: "manual", headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(useCookie && cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j, headers: r.headers };
}
const ok = (c, m) => { assert(c, m); console.log("  ✓", m); };

(async () => {
  // login
  let r = await req("GET", "/api/all", null, false); ok(r.status === 401, "API refuses without login");
  r = await fetch(BASE + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=wrong" });
  ok(r.headers.get("location") === "/login?e=bad", "wrong password rejected");
  r = await fetch(BASE + "/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "password=" + encodeURIComponent(process.env.OFFICE_PASSWORD) });
  cookie = r.headers.get("set-cookie").split(";")[0]; ok(r.headers.get("location") === "/" && cookie, "office login works");

  // set up
  await req("PUT", "/api/docs/settings/business", { bizName: "Test Maintenance Ltd", bizPhone: "020 0000 0000" });
  const tA = "tokA_" + "x".repeat(20), tB = "tokB_" + "y".repeat(20);
  await req("PUT", "/api/docs/contractors/kA", { name: "Alan Test", phone: "07700 900001", token: tA, active: true, trades: ["Plumbing / leak"] });
  await req("PUT", "/api/docs/contractors/kB", { name: "Bea Test", phone: "07700 900002", token: tB, active: true, trades: [] });
  const job = { ref: "PM-0100", status: "new", priority: "emergency", category: "Plumbing / leak", description: "Leak under sink", attendBy: "2026-10-10T02:00",
    property: { address: "Flat 2, 1 Test Road", postcode: "IG1 1AA", keyInfo: "1234" }, residents: [{ name: "Rita Resident", phone: "07700 900010" }],
    issuer: { name: "Andy Agent", phone: "07700 900020", role: "Letting agent" }, alerts: { residents: true, issuer: true },
    dispatch: { mode: "flat", fee: 80, status: "open", recipients: ["kA", "kB"], postedAt: new Date().toISOString(), allocatedTo: "" }, track: { posted: new Date().toISOString() } };
  await req("PUT", "/api/docs/jobs/j1", job);
  r = await req("POST", "/api/jobs/j1/notify-post");
  ok(r.body.simulated && r.body.results.length === 2 && r.body.results.every(x => x.ok), "job alert queued for both contractors (simulated)");

  // contractor board hides private details
  r = await req("GET", `/api/c/${tA}`, null, false);
  ok(r.body.board.length === 1 && !JSON.stringify(r.body.board).includes("1234") && !JSON.stringify(r.body.board).includes("Rita"), "board shows job without address/key/resident");
  r = await req("GET", `/api/c/bad_${"z".repeat(20)}`, null, false); ok(r.status === 404, "unknown link refused");

  // race: both accept at once – exactly one wins
  const [a, b] = await Promise.all([req("POST", `/api/c/${tA}/jobs/j1/accept`, {}, false), req("POST", `/api/c/${tB}/jobs/j1/accept`, {}, false)]);
  ok([a.status, b.status].sort().join() === "200,409", "two simultaneous accepts: one wins, one told it's taken");
  const winner = a.status === 200 ? tA : tB, loser = winner === tA ? tB : tA;
  r = await req("GET", `/api/c/${winner}`, null, false);
  ok(r.body.mine.length === 1 && r.body.mine[0].property.keyInfo === "1234", "winner now sees full address and key info");
  r = await req("GET", `/api/c/${loser}`, null, false); ok(r.body.board.length === 0 && r.body.mine.length === 0, "loser no longer sees the job");

  // progress
  r = await req("POST", `/api/c/${winner}/jobs/j1/step`, { step: "booked" }, false); ok(r.status === 409, "can't confirm booking before giving a time");
  r = await req("POST", `/api/c/${winner}/jobs/j1/time`, { attendBy: "2026-10-10T01:00", finishBy: "2026-10-10T02:30" }, false); ok(r.status === 200, "timeframe saved");
  r = await req("POST", `/api/c/${loser}/jobs/j1/step`, { step: "onsite" }, false); ok(r.status === 409, "other contractor can't update someone else's job");
  for (const st of ["enroute", "onsite"]) { r = await req("POST", `/api/c/${winner}/jobs/j1/step`, { step: st }, false); assert.strictEqual(r.status, 200); }
  r = await req("POST", `/api/c/${winner}/jobs/j1/done`, { text: "Replaced elbow, tested" }, false); ok(r.status === 200, "marked complete");
  await new Promise(res => setTimeout(res, 300)); // alerts are sent in the background
  r = await req("GET", "/api/docs/jobs/j1");
  const jd = r.body.data;
  ok(jd.status === "complete" && jd.track.done && jd.findings === "Replaced elbow, tested", "office sees status, tracking and findings");
  const events = (jd.alertLog || []).map(e => e.event);
  ok(["accepted", "booked", "enroute", "done"].every(e => events.includes(e)), "resident/agent updates logged for accepted, booked, on the way, complete");
  ok(jd.alertLog.every(e => e.to.some(t => t.kind === "resident") && e.to.some(t => t.kind === "issuer")), "updates went to resident and agent");
  r = await req("POST", "/api/jobs/j1/alert", { event: "custom", text: "Engineer running late" }); ok(r.body.sent.length === 2, "custom update to resident + agent");

  // quote flow
  await req("PUT", "/api/docs/jobs/j2", { ref: "PM-0101", status: "new", priority: "routine", category: "Damp & mould", description: "Mould in bathroom", attendBy: "2026-10-15T10:00", property: { address: "3 Test St", postcode: "E11 2BB" },
    dispatch: { mode: "quote", status: "open", recipients: ["kA", "kB"], postedAt: new Date().toISOString(), allocatedTo: "" } });
  r = await req("POST", `/api/c/${tA}/jobs/j2/accept`, {}, false); ok(r.status === 409, "quote job can't be grabbed with Accept");
  r = await req("POST", `/api/c/${tA}/jobs/j2/quote`, { price: 240, attendBy: "2026-10-13T09:00", finishBy: "2026-10-13T15:00" }, false);
  r = await req("POST", `/api/c/${tB}/jobs/j2/quote`, { price: 210, attendBy: "2026-10-14T09:00" }, false);
  r = await req("GET", "/api/docs/jobs/j2"); ok(Object.keys(r.body.data.quotes).length === 2, "both quotes stored for the office");
  r = await req("GET", `/api/c/${tA}`, null, false); ok(r.body.board[0].myQuote.price === 240 && !JSON.stringify(r.body).includes("210"), "contractor sees own quote only");

  // WhatsApp button reply
  await req("PUT", "/api/docs/jobs/j3", { ref: "PM-0102", status: "new", priority: "urgent", category: "Plumbing / leak", description: "Dripping tap", attendBy: "2026-10-11T10:00", property: { address: "9 Test Ave", postcode: "IG2 7CC" },
    dispatch: { mode: "flat", fee: 60, status: "open", recipients: ["kA", "kB"], postedAt: new Date().toISOString(), allocatedTo: "" } });
  const hook = from => ({ entry: [{ changes: [{ value: { messages: [{ from, type: "button", button: { payload: "ACCEPT:j3", text: "Accept job" } }] } }] }] });
  r = await fetch(BASE + "/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(hook("447700900002")) });
  await new Promise(res => setTimeout(res, 300));
  r = await req("GET", "/api/docs/jobs/j3"); ok(r.body.data.dispatch.allocatedTo === "kB" && r.body.data.dispatch.acceptedVia === "whatsapp", "Accept button on WhatsApp allocates the job");
  // text reply "YES PM-0100" for a job already taken
  await fetch(BASE + "/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "447700900001", type: "text", text: { body: "yes pm-0102" } }] } }] }] }) });
  await new Promise(res => setTimeout(res, 300));
  r = await req("GET", "/api/all"); const last = r.body.outbox[0];
  ok(last.to === "447700900001" && /already been taken/.test(last.summary), "late WhatsApp YES gets 'already taken' reply");

  // hand back
  r = await req("POST", `/api/c/${tB}/jobs/j3/handback`, {}, false); r = await req("GET", "/api/docs/jobs/j3");
  ok(r.body.data.dispatch.status === "open" && !r.body.data.dispatch.allocatedTo, "hand back reopens the job");
  console.log("\nAll checks passed.");
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
