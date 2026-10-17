// Job dispatch rules shared by the contractor web link and WhatsApp replies:
// accept (first wins, under a row lock), quotes, progress steps, timeframe, notes,
// hand-back, and progress alerts to residents and (optionally) the agent/landlord.
const TLABEL = { posted: "Posted", accepted: "Accepted", booked: "Booked in", enroute: "On the way", onsite: "On site", parts: "Awaiting parts", done: "Work complete", signedoff: "Signed off" };
const T2STATUS = { accepted: "scheduled", booked: "scheduled", enroute: "scheduled", onsite: "in_progress", parts: "awaiting_parts", done: "complete" };
const PLABEL = { emergency: "Emergency (out of hours)", urgent: "Urgent – 24 hours", routine: "Routine – 7 days", planned: "Planned / quote" };
const T_UPDATE = process.env.TEMPLATE_JOB_UPDATE || "job_update";

const nowISO = () => new Date().toISOString();
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const gbp = v => "£" + (Number(v) || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDT = iso => { if (!iso) return "—"; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); };
const area = pc => { pc = String(pc || "").trim().toUpperCase(); if (!pc) return ""; const p = pc.split(/\s+/); return p.length > 1 ? p[0] : pc.slice(0, Math.max(2, pc.length - 3)); };
const cnote = (by, text) => ({ [Date.now() + "" + Math.floor(Math.random() * 1000)]: { at: nowISO(), by, text } });
const firstName = s => String(s || "").trim().split(/\s+/)[0] || "";
const isGroup = j => (j.dispatch || {}).mode === "group";
const teamOf = j => (j.dispatch || {}).team || [];
const isReserve = (j, c) => !!((j.dispatch || {}).reserve && j.dispatch.reserve.id === c.id);
// Can this contractor still take this job? Group jobs take 2 engineers, then 1 reserve.
function canTake(j, c) {
  const d = j.dispatch || {};
  if (!(d.recipients || []).includes(c.id)) return false;
  if (isGroup(j)) {
    if (teamOf(j).some(t => t.id === c.id) || isReserve(j, c)) return false;
    return d.status === "open" || (d.status === "allocated" && !d.reserve);
  }
  return d.status === "open" && !d.allocatedTo;
}
const isMine = (j, c) => !!(j.dispatch && (j.dispatch.allocatedTo === c.id || teamOf(j).some(t => t.id === c.id)));
const when = j => fmtDT(j.scheduledAt || j.attendBy);
const addrOf = j => { const p = j.property || {}; return [p.address, p.postcode].filter(Boolean).join(", "); };

function boardView(j, c) {
  const d = j.dispatch || {}, p = j.property || {};
  const g = isGroup(j), slots = d.slots || 2;
  return { id: j.id, ref: j.ref, priority: j.priority, category: j.category, description: j.description, area: g ? String(p.postcode || "").toUpperCase() : area(p.postcode), propertyType: p.type || "",
    attendBy: g ? (j.scheduledAt || j.attendBy) : j.attendBy, example: !!j.example, mode: d.mode, fee: d.mode === "flat" ? d.fee : null, respondBy: d.respondBy || "", postedAt: d.postedAt,
    myQuote: (j.quotes || {})[c.id] || null,
    places: g ? Math.max(0, slots - teamOf(j).length) : null, slots: g ? slots : null, reserveTaken: g ? !!d.reserve : null, iAmReserve: g ? isReserve(j, c) : false };
}
// What a contractor sees about their own self-bill (same maths as the office page).
function payView(p) {
  if (!p) return null;
  const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  const labour = n(p.labour) + (p.extras || []).reduce((a, e) => a + n(e.amount), 0), mats = n(p.materials);
  const cis = Math.round(labour * n(p.cisRate)) / 100, net = labour + mats, vat = p.vatRegistered ? Math.round(net * 20) / 100 : 0;
  return { number: p.number, issuedAt: p.issuedAt, status: p.status, paidAt: p.paidAt || "", paidRef: p.paidRef || "",
    labour, materials: mats, vat, gross: net + vat, cisRate: n(p.cisRate), cis, pay: net + vat - cis, note: p.note || "" };
}
function myView(j, c, office) {
  const d = j.dispatch || {}, p = j.property || {};
  const notes = Object.values(j.cnotes || {}).filter(n => n.by === c.id || n.by === "office").map(n => ({ at: n.at, who: n.by === c.id ? "You" : "Office", text: n.text }));
  (j.log || []).filter(e => /Allocated|signed off|Taken back/i.test(e.text)).forEach(e => notes.push({ at: e.at, who: "Office", text: e.text }));
  return { id: j.id, ref: j.ref, priority: j.priority, category: j.category, description: j.description, example: !!j.example,
    property: { address: p.address, postcode: p.postcode, type: p.type, access: p.access, keyInfo: p.keyInfo, accessNotes: p.accessNotes, parking: p.parking, stopcock: p.stopcock },
    residents: (j.residents || []).filter(r => r.name || r.phone), materials: (j.materials || []).filter(m => m.item).map(m => ({ item: m.item, qty: m.qty, supplier: m.supplier, state: m.state })),
    attendBy: j.attendBy, agreedPrice: d.agreedPrice, contractorAttendBy: d.contractorAttendBy || "", contractorFinishBy: d.contractorFinishBy || "",
    track: j.track || {}, findings: j.findings || "", payment: payView(j.payout), notes: notes.sort((a, b) => String(b.at).localeCompare(String(a.at))), officePhone: office.bizPhone || "",
    contact: j.source && j.source.name ? { name: j.source.name, phone: j.source.phone || "" } : null,
    team: isGroup(j) ? teamOf(j).filter(t => t.id !== c.id).map(t => firstName(t.name)) : [] };
}

function makeDispatch(store, wa, baseUrl, makeDiarySync) {
  const linkFor = c => `${baseUrl()}/c/${c.token}`;
  async function settings() { return (await store.get("settings", "business")) || {}; }

  // ----- alerts to residents / agent / landlord -----
  async function alertParties(job, event, extra) {
    const al = job.alerts || {};
    if (al.residents === false && !al.issuer) return [];
    const k = job.dispatch && job.dispatch.allocatedTo ? await store.get("contractors", job.dispatch.allocatedTo) : null;
    const who = k ? (firstName(k.name) + (k.company ? " from " + k.company : "")) : "our engineer";
    const p = job.property || {};
    const addr = [p.address, p.postcode].filter(Boolean).join(", ");
    const msg = {
      accepted: `${who} has been booked for your repair${job.dispatch && job.dispatch.contractorAttendBy ? " and will attend " + fmtDT(job.dispatch.contractorAttendBy) : ". We'll confirm the visit time shortly"}.`,
      booked: `Your repair is booked: ${who} will attend ${fmtDT(job.dispatch && job.dispatch.contractorAttendBy)}${job.dispatch && job.dispatch.contractorFinishBy ? ", expected to finish " + fmtDT(job.dispatch.contractorFinishBy) : ""}.`,
      enroute: `${who} is on the way to you now.`,
      parts: `${who} needs parts to finish the repair. We'll be in touch to rebook.`,
      done: `The repair has been completed. ${extra ? "Work done: " + extra : ""}`.trim(),
      signedoff: `Job signed off and closed.`,
      custom: extra,
    }[event];
    if (!msg) return [];
    const s = await settings();
    const sent = [];
    const targets = [];
    if (al.residents !== false && event !== "signedoff") (job.residents || []).filter(r => r.phone).forEach(r => targets.push({ name: r.name, phone: r.phone, kind: "resident" }));
    if (al.issuer && job.issuer && job.issuer.phone) targets.push({ name: job.issuer.name, phone: job.issuer.phone, kind: "issuer" });
    for (const t of targets) {
      const r = await wa.template(t.phone, T_UPDATE, [firstName(t.name) || "there", addr || "your property", job.ref, msg, s.bizName || "Maintenance team", s.bizPhone || "-"], null, `Update to ${t.kind} ${t.name || ""} (${job.ref}): ${msg}`);
      sent.push({ kind: t.kind, name: t.name || "", ok: r.ok, simulated: !!r.simulated, error: r.error || "" });
    }
    if (sent.length) {
      await store.withLock("jobs", job.id, async cur => cur ? { doc: { ...cur, alertLog: (cur.alertLog || []).concat([{ at: nowISO(), event, msg, to: sent }]).slice(-40) } } : null);
    }
    return sent;
  }

  // ----- contractor actions -----
  async function update(jobId, c, fn) {
    return store.withLock("jobs", jobId, async cur => {
      if (!cur) return { ok: false, error: "That job no longer exists" };
      const r = fn(cur);
      if (r.error) return { ok: false, error: r.error };
      return { ok: true, doc: r.doc, event: r.event, extra: r.extra };
    });
  }
  const mine = isMine;
  const sync = makeDiarySync ? makeDiarySync() : { push: async () => {} };
  const pushDiary = doc => {
    if (!doc) return;
    (async () => {
      const d = doc.dispatch || {};
      if (d.allocatedTo && !isGroup(doc)) { const k = await store.get("contractors", d.allocatedTo); if (k) doc = { ...doc, _allocatedName: k.name }; }
      await sync.push(doc, baseUrl());
    })().catch(e => console.error("diary sync", e.message));
  };

  async function accept(c, jobId, via) {
    const cur = await store.get("jobs", jobId);
    if (cur && isGroup(cur)) return groupAccept(c, jobId, via);
    const res = await update(jobId, c, j => {
      const d = j.dispatch || {};
      if (d.status !== "open" || d.allocatedTo) return { error: "Sorry – this job has already been taken." };
      if (!(d.recipients || []).includes(c.id)) return { error: "This job wasn't sent to you." };
      if (d.mode === "quote") return { error: "QUOTE" };
      const now = nowISO();
      return { event: "accepted", doc: { ...j, status: "scheduled",
        dispatch: { ...d, status: "allocated", allocatedTo: c.id, allocatedAt: now, acceptedVia: via, agreedPrice: Number(d.fee) || 0 },
        track: { ...(j.track || {}), accepted: now }, cnotes: { ...(j.cnotes || {}), ...cnote(c.id, "Accepted the job" + (via === "whatsapp" ? " on WhatsApp" : "")) } } };
    });
    if (res.ok) { alertParties(res.doc, "accepted").catch(() => {}); pushDiary(res.doc); }
    return res;
  }

  // ----- group jobs: first 2 to accept are on it, the 3rd is reserve -----
  async function groupAccept(c, jobId, via) {
    const res = await update(jobId, c, j => {
      const d = j.dispatch || {}, slots = d.slots || 2;
      if (!(d.recipients || []).includes(c.id)) return { error: "This job wasn't sent to you." };
      if (!["open", "allocated"].includes(d.status)) return { error: `Sorry – job ${j.ref} has been withdrawn.` };
      if ((j.track || {}).done) return { error: `Job ${j.ref} is already finished.` };
      const team = [...(d.team || [])];
      if (team.some(t => t.id === c.id)) return { error: `You're already on job ${j.ref}.` };
      if (isReserve(j, c)) return { error: `You're already the reserve for job ${j.ref}.` };
      const now = nowISO(), entry = { id: c.id, name: c.name || "", phone: c.phone || "", at: now, via };
      let role;
      if (team.length < slots) { team.push(entry); role = "team"; }
      else if (!d.reserve) role = "reserve";
      else return { error: `Sorry – job ${j.ref} is full (${slots} engineers and a reserve).` };
      const full = team.length >= slots;
      const nd = { ...d, team, reserve: role === "reserve" ? entry : (d.reserve || null), allocatedTo: team[0].id, allocatedAt: d.allocatedAt || now,
        acceptedVia: d.acceptedVia || via, status: full ? "allocated" : "open" };
      const doc = { ...j, dispatch: nd, status: full && j.status === "new" ? "scheduled" : j.status,
        track: { ...(j.track || {}), accepted: (j.track || {}).accepted || now },
        cnotes: { ...(j.cnotes || {}), ...cnote(c.id, role === "team" ? `Accepted the job${via === "whatsapp" ? " on WhatsApp" : ""} (${team.length}/${slots})` : "Taken as reserve") } };
      return { doc, extra: role };
    });
    if (!res.ok) return res;
    const j = res.doc, d = j.dispatch, slots = d.slots || 2, names = teamOf(j).map(t => firstName(t.name)).join(" & ");
    const msg = res.extra === "reserve" ? `${j.ref}: ${c.name} is the reserve.`
      : teamOf(j).length >= slots ? `${j.ref} is filled ✓ ${names} ${slots === 2 ? "are both" : "are"} on it (${when(j)}, ${(j.property || {}).postcode || ""}).${d.reserve ? "" : " Waiting for a reserve."}`
      : `${j.ref}: ${c.name} accepted (${teamOf(j).length}/${slots}). Waiting for ${slots - teamOf(j).length} more.`;
    tellSender(j, msg).catch(() => {});
    pushDiary(j);
    return { ...res, role: res.extra };
  }

  // A team member or the reserve drops out (by WhatsApp, their job page, or the office).
  // The reserve moves up; if there's no reserve the place re-opens to the group.
  async function groupDrop(kid, jobId, by) {
    const r = await store.withLock("jobs", jobId, async j => {
      if (!j) return { ok: false, error: "That job no longer exists" };
      const d = j.dispatch || {};
      if (!isGroup(j)) return { ok: false, error: "This isn't a group job." };
      if ((j.track || {}).done) return { ok: false, error: `Job ${j.ref} is already finished.` };
      const slots = d.slots || 2;
      let team = [...(d.team || [])], reserve = d.reserve || null, removed = null, promoted = null, wasReserve = false;
      if (reserve && reserve.id === kid) { removed = reserve; reserve = null; wasReserve = true; }
      else if (team.some(t => t.id === kid)) {
        removed = team.find(t => t.id === kid); team = team.filter(t => t.id !== kid);
        if (reserve) { promoted = { ...reserve, at: nowISO(), promoted: true }; team.push(promoted); reserve = null; }
      } else return { ok: false, error: `You're not on job ${j.ref}.` };
      const full = team.length >= slots;
      const nd = { ...d, team, reserve, allocatedTo: team[0] ? team[0].id : "", status: full ? "allocated" : "open" };
      const who = removed.name || "A contractor";
      const text = by === "office" ? `${who} taken off the job by the office` : (wasReserve ? "Stepped down as reserve" : "Dropped out of the job");
      const doc = { ...j, dispatch: nd, status: !full && j.status === "scheduled" ? "new" : j.status,
        cnotes: { ...(j.cnotes || {}), ...cnote(by === "office" ? "office" : kid, text + (promoted ? ` – ${promoted.name} (reserve) moved up` : "")) } };
      return { ok: true, doc, removed, promoted, wasReserve, reopened: !wasReserve && !promoted };
    });
    if (!r.ok) return r;
    const j = r.doc, slots = (j.dispatch.slots || 2);
    if (r.promoted) {
      const k = await store.get("contractors", r.promoted.id);
      if (k) {
        const t = await wa.text(k.phone, `🔔 A place has opened on job ${j.ref} – you're on it now.\n\n${jobDetails(j, k)}`);
        if (!t.ok || t.error) await wa.template(k.phone, wa.T_ASSIGNED, [j.ref, addrOf(j), when(j), "as agreed", linkFor(k)], null, `Job ${j.ref}: reserve ${k.name} moved up`);
      }
    }
    if (r.reopened) await realert(j);
    const names = teamOf(j).map(t => firstName(t.name)).join(" & ") || "nobody yet";
    tellSender(j, `${j.ref}: ${r.removed.name} ${r.wasReserve ? "is no longer the reserve" : "dropped out"}.` +
      (r.promoted ? ` ${r.promoted.name} (reserve) moved up – team: ${names}.` : r.reopened ? ` No reserve, so the place is open to the group again (${teamOf(j).length}/${slots}).` : "")).catch(() => {});
    pushDiary(j);
    return { ok: true, doc: j, promoted: r.promoted, reopened: r.reopened };
  }

  // Everything an engineer needs once they're on a group job.
  function jobDetails(j, k) {
    const s = j.source || {};
    return [`📅 ${when(j)}`, `📍 ${addrOf(j)}`, `🔧 ${j.description || ""}`,
      s.name ? `Contact: ${s.name}${s.phone ? " – " + s.phone : ""} (sent the job in)` : "",
      `Job page: ${linkFor(k)}`, `Can't make it? Reply DROP ${j.ref}`].filter(Boolean).join("\n");
  }
  async function tellSender(j, text) {
    const s = j.source || {};
    if (!s.phone) return;
    await wa.text(s.phone, text);
  }
  // Send the job alert again to everyone in the group who isn't on it.
  async function realert(j) {
    const d = j.dispatch || {};
    const skip = new Set(teamOf(j).map(t => t.id).concat(d.reserve ? [d.reserve.id] : []));
    const out = [];
    for (const id of d.recipients || []) {
      if (skip.has(id)) continue;
      const c = await store.get("contractors", id); if (!c || c.active === false) continue;
      out.push({ id, name: c.name, ...(await sendGroupAlert(j, c)) });
    }
    return out;
  }
  function sendGroupAlert(j, c) {
    const d = j.dispatch || {}, slots = d.slots || 2, left = Math.max(0, slots - teamOf(j).length);
    const line = left ? `${left === slots ? "First " + slots : left + " place" + (left > 1 ? "s" : "") + " left –"} to accept get${left > 1 ? "" : "s"} the job, then 1 reserve` : "Both places taken – accept to be the reserve";
    return wa.template(c.phone, wa.T_NEW,
      [j.ref, d.groupName ? d.groupName + " group" : (PLABEL[j.priority] || "Job"), j.category || "Maintenance", String((j.property || {}).postcode || "").toUpperCase() || "London", j.description || "", when(j), line, linkFor(c)],
      [`ACCEPT:${j.id}`, `DECLINE:${j.id}`], `Job ${j.ref} (${d.groupName || "group"}) to ${c.name}: ${line}`);
  }
  async function quote(c, jobId, q) {
    const price = Number(q.price);
    if (!(price > 0)) return { ok: false, error: "Enter your price" };
    if (!q.attendBy) return { ok: false, error: "Say when you can attend" };
    return update(jobId, c, j => {
      const d = j.dispatch || {};
      if (d.status !== "open" || d.mode !== "quote" || !(d.recipients || []).includes(c.id)) return { error: "This job isn't taking quotes any more." };
      return { doc: { ...j, quotes: { ...(j.quotes || {}), [c.id]: { price, attendBy: q.attendBy, finishBy: q.finishBy || "", note: String(q.note || "").slice(0, 500), at: nowISO() } },
        cnotes: { ...(j.cnotes || {}), ...cnote(c.id, "Quoted " + gbp(price)) } } };
    });
  }
  async function step(c, jobId, st) {
    if (!["booked", "enroute", "onsite", "parts"].includes(st)) return { ok: false, error: "Unknown step" };
    const res = await update(jobId, c, j => {
      if (!mine(j, c)) return { error: "This job isn't allocated to you." };
      if (st === "booked" && !(j.dispatch || {}).contractorAttendBy) return { error: "Set when you'll attend first." };
      const doc = { ...j, track: { ...(j.track || {}), [st]: nowISO() }, cnotes: { ...(j.cnotes || {}), ...cnote(c.id, TLABEL[st]) } };
      if (T2STATUS[st]) doc.status = T2STATUS[st];
      return { doc, event: st };
    });
    if (res.ok && ["enroute", "parts"].includes(st)) alertParties(res.doc, st).catch(() => {});
    if (res.ok) pushDiary(res.doc);
    return res;
  }
  async function timeframe(c, jobId, a, f) {
    if (!a) return { ok: false, error: "Set when you'll attend" };
    const res = await update(jobId, c, j => {
      if (!mine(j, c)) return { error: "This job isn't allocated to you." };
      const first = !(j.track || {}).booked;
      return { event: "booked", doc: { ...j, scheduledAt: a, dispatch: { ...j.dispatch, contractorAttendBy: a, contractorFinishBy: f || "" },
        track: first ? { ...(j.track || {}), booked: nowISO() } : (j.track || {}),
        cnotes: { ...(j.cnotes || {}), ...cnote(c.id, `Will attend ${fmtDT(a)}${f ? ", finish by " + fmtDT(f) : ""}`) } } };
    });
    if (res.ok) { alertParties(res.doc, "booked").catch(() => {}); pushDiary(res.doc); }
    return res;
  }
  async function done(c, jobId, text) {
    text = String(text || "").trim();
    if (!text) return { ok: false, error: "Say what you did" };
    const res = await update(jobId, c, j => {
      if (!mine(j, c)) return { error: "This job isn't allocated to you." };
      return { event: "done", extra: text, doc: { ...j, status: "complete", completedAt: nowLocal(), findings: text.slice(0, 2000),
        track: { ...(j.track || {}), done: nowISO() }, cnotes: { ...(j.cnotes || {}), ...cnote(c.id, "Work complete: " + text.slice(0, 500)) } } };
    });
    if (res.ok) { alertParties(res.doc, "done", text).catch(() => {}); pushDiary(res.doc); }
    return res;
  }
  async function note(c, jobId, text) {
    text = String(text || "").trim().slice(0, 1000);
    if (!text) return { ok: false, error: "Write a note" };
    return update(jobId, c, j => mine(j, c) ? { doc: { ...j, cnotes: { ...(j.cnotes || {}), ...cnote(c.id, text) } } } : { error: "This job isn't allocated to you." });
  }
  async function handback(c, jobId) {
    const cur = await store.get("jobs", jobId);
    if (cur && isGroup(cur)) return groupDrop(c.id, jobId, "contractor");
    return update(jobId, c, j => {
      if (!mine(j, c)) return { error: "This job isn't allocated to you." };
      if ((j.track || {}).done) return { error: "This job is already complete." };
      const t = { ...(j.track || {}) }; ["accepted", "booked", "enroute", "onsite", "parts"].forEach(k => delete t[k]);
      return { doc: { ...j, status: "new", track: t,
        dispatch: { ...j.dispatch, status: "open", allocatedTo: "", agreedPrice: "", contractorAttendBy: "", contractorFinishBy: "", postedAt: nowISO() },
        cnotes: { ...(j.cnotes || {}), ...cnote(c.id, "Handed the job back") } } };
    });
  }

  // ----- office-triggered messages -----
  async function notifyPost(jobId) {
    const j = await store.get("jobs", jobId); if (!j) return { error: "Job not found" };
    const d = j.dispatch || {}, p = j.property || {};
    if (isGroup(j)) return { results: await realert(j), simulated: !wa.enabled() };
    const out = [];
    for (const id of d.recipients || []) {
      const c = await store.get("contractors", id); if (!c || c.active === false) continue;
      const feeLine = d.mode === "quote" ? "Quote wanted – send your price and timeframe using the link" : `Fixed fee ${gbp(d.fee)} – first to accept gets it`;
      const r = await wa.template(c.phone, wa.T_NEW,
        [j.ref, PLABEL[j.priority] || "", j.category || "Maintenance", area(p.postcode) || "London", j.description || "", fmtDT(j.attendBy), feeLine, linkFor(c)],
        [`ACCEPT:${j.id}`, `DECLINE:${j.id}`], `New job ${j.ref} to ${c.name}: ${feeLine}`);
      out.push({ id, name: c.name, ...r });
    }
    return { results: out, simulated: !wa.enabled() };
  }
  async function notifyAssigned(jobId) {
    const j = await store.get("jobs", jobId); if (!j) return { error: "Job not found" };
    const d = j.dispatch || {}, p = j.property || {};
    const c = d.allocatedTo && await store.get("contractors", d.allocatedTo); if (!c) return { error: "No contractor allocated" };
    const r = await wa.template(c.phone, wa.T_ASSIGNED,
      [j.ref, [p.address, p.postcode].filter(Boolean).join(", "), fmtDT(d.contractorAttendBy || j.attendBy), d.agreedPrice !== "" && d.agreedPrice != null ? gbp(d.agreedPrice) : "as agreed", linkFor(c)],
      null, `Job ${j.ref} allocated to ${c.name}`);
    alertParties(j, "accepted").catch(() => {});
    return { results: [{ id: c.id, name: c.name, ...r }], simulated: !wa.enabled() };
  }

  // ----- WhatsApp replies from contractors -----
  async function handleIncoming(from, payload, textBody) {
    const contractors = await store.list("contractors");
    const c = contractors.find(k => wa.intl(k.phone) === from);
    if (!c) return false; // unknown sender – ignore quietly
    let action = null, jobId = null;
    if (payload) { [action, jobId] = String(payload).split(":"); }
    else {
      const m = String(textBody || "").trim().match(/^(yes|accept|y|no|decline|drop|cancel|cant|can't|cannot)\b[\s:#-]*(PM-?\d+)?/i);
      if (m) {
        const w = m[1].toLowerCase();
        action = ["yes", "accept", "y"].includes(w) ? "ACCEPT" : ["no", "decline"].includes(w) ? "DECLINE" : "DROP";
        const jobs = await store.list("jobs");
        const ref = m[2] ? m[2].toUpperCase().replace(/^PM-?/, "PM-") : null;
        const pool = action === "DROP" ? jobs.filter(j => isGroup(j) && !(j.track || {}).done && (isMine(j, c) || isReserve(j, c))) : jobs.filter(j => canTake(j, c));
        const j = ref ? jobs.find(x => x.ref === ref) : (pool.length === 1 ? pool[0] : null);
        if (!j && action !== "DECLINE") {
          const verb = action === "DROP" ? "DROP" : "YES";
          await wa.text(c.phone, pool.length ? `Which job? Reply ${verb} followed by the job number, e.g. ${verb} ${pool[0].ref}.\nYour job board: ${linkFor(c)}`
            : action === "DROP" ? `You're not on any open group jobs. Your job board: ${linkFor(c)}` : `There are no open jobs for you right now. Your job board: ${linkFor(c)}`);
          return true;
        }
        jobId = j && j.id;
      }
    }
    if (action === "ACCEPT" && jobId) {
      const r = await accept(c, jobId, "whatsapp");
      if (r.ok) {
        const j = r.doc, p = j.property || {};
        if (isGroup(j)) {
          const d = j.dispatch, slots = d.slots || 2;
          if (r.role === "reserve") await wa.text(c.phone, `You're the reserve for job ${j.ref} (${when(j)}, ${p.postcode || ""}).\nIf one of the ${slots} engineers drops out, the job is yours and I'll send you the address and contact.\nCan't be reserve any more? Reply DROP ${j.ref}`);
          else await wa.text(c.phone, `✅ You're on job ${j.ref} (${teamOf(j).findIndex(t => t.id === c.id) + 1} of ${slots}).\n\n${jobDetails(j, c)}`);
        } else await wa.text(c.phone, `✅ Job ${j.ref} is yours.\n📍 ${[p.address, p.postcode].filter(Boolean).join(", ")}\nAttend by ${fmtDT(j.attendBy)}. Fee ${gbp(j.dispatch.agreedPrice)}.\n\nPlease set your attend time and update progress here:\n${linkFor(c)}`);
      } else if (r.error === "QUOTE") {
        await wa.text(c.phone, `This job needs a quote. Send your price and timeframe here:\n${linkFor(c)}`);
      } else await wa.text(c.phone, r.error || "Couldn't accept that job.");
      return true;
    }
    if (action === "DROP" && jobId) {
      const r = await groupDrop(c.id, jobId, "contractor");
      await wa.text(c.phone, r.ok ? `Thanks for letting us know – you're off job ${r.doc.ref}.` : (r.error || "Couldn't do that."));
      return true;
    }
    if (action === "DECLINE") { await wa.text(c.phone, "No problem, thanks for letting us know."); return true; }
    await wa.text(c.phone, `Hi ${firstName(c.name)}, your job board is here:\n${linkFor(c)}\n\nTo take a job you can also reply YES and the job number, e.g. YES PM-0004. To drop out of one, reply DROP and the job number.`);
    return true;
  }

  return { boardView, myView, accept, quote, step, timeframe, done, note, handback, notifyPost, notifyAssigned, handleIncoming, alertParties, linkFor,
    groupDrop, canTake, isMine, pushDiary, tellSender };
}

module.exports = { makeDispatch, area, fmtDT, canTake, isMine, isGroup };
