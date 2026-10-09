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

function boardView(j, c) {
  const d = j.dispatch || {}, p = j.property || {};
  return { id: j.id, ref: j.ref, priority: j.priority, category: j.category, description: j.description, area: area(p.postcode), propertyType: p.type || "",
    attendBy: j.attendBy, example: !!j.example, mode: d.mode, fee: d.mode === "flat" ? d.fee : null, respondBy: d.respondBy || "", postedAt: d.postedAt,
    myQuote: (j.quotes || {})[c.id] || null };
}
function myView(j, c, office) {
  const d = j.dispatch || {}, p = j.property || {};
  const notes = Object.values(j.cnotes || {}).filter(n => n.by === c.id || n.by === "office").map(n => ({ at: n.at, who: n.by === c.id ? "You" : "Office", text: n.text }));
  (j.log || []).filter(e => /Allocated|signed off|Taken back/i.test(e.text)).forEach(e => notes.push({ at: e.at, who: "Office", text: e.text }));
  return { id: j.id, ref: j.ref, priority: j.priority, category: j.category, description: j.description, example: !!j.example,
    property: { address: p.address, postcode: p.postcode, type: p.type, access: p.access, keyInfo: p.keyInfo, accessNotes: p.accessNotes, parking: p.parking, stopcock: p.stopcock },
    residents: (j.residents || []).filter(r => r.name || r.phone), materials: (j.materials || []).filter(m => m.item).map(m => ({ item: m.item, qty: m.qty, supplier: m.supplier, state: m.state })),
    attendBy: j.attendBy, agreedPrice: d.agreedPrice, contractorAttendBy: d.contractorAttendBy || "", contractorFinishBy: d.contractorFinishBy || "",
    track: j.track || {}, findings: j.findings || "", notes: notes.sort((a, b) => String(b.at).localeCompare(String(a.at))), officePhone: office.bizPhone || "" };
}

function makeDispatch(store, wa, baseUrl) {
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
  const mine = (j, c) => j.dispatch && j.dispatch.allocatedTo === c.id;

  async function accept(c, jobId, via) {
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
    if (res.ok) alertParties(res.doc, "accepted").catch(() => {});
    return res;
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
    if (res.ok) alertParties(res.doc, "booked").catch(() => {});
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
    if (res.ok) alertParties(res.doc, "done", text).catch(() => {});
    return res;
  }
  async function note(c, jobId, text) {
    text = String(text || "").trim().slice(0, 1000);
    if (!text) return { ok: false, error: "Write a note" };
    return update(jobId, c, j => mine(j, c) ? { doc: { ...j, cnotes: { ...(j.cnotes || {}), ...cnote(c.id, text) } } } : { error: "This job isn't allocated to you." });
  }
  async function handback(c, jobId) {
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
    if (!c) return; // unknown sender – ignore quietly
    let action = null, jobId = null;
    if (payload) { [action, jobId] = String(payload).split(":"); }
    else {
      const m = String(textBody || "").trim().match(/^(yes|accept|no|decline)\b\s*#?\s*(PM-?\d+)?/i);
      if (m) {
        action = /^(yes|accept)$/i.test(m[1]) ? "ACCEPT" : "DECLINE";
        const jobs = await store.list("jobs");
        const ref = m[2] ? m[2].toUpperCase().replace(/^PM-?/, "PM-") : null;
        const open = jobs.filter(j => j.dispatch && j.dispatch.status === "open" && (j.dispatch.recipients || []).includes(c.id));
        const j = ref ? jobs.find(x => x.ref === ref) : (open.length === 1 ? open[0] : null);
        if (!j && action === "ACCEPT") { await wa.text(c.phone, open.length ? `Which job? Reply YES followed by the job number, e.g. YES ${open[0].ref}.\nOr open your job board: ${linkFor(c)}` : `There are no open jobs for you right now. Your job board: ${linkFor(c)}`); return; }
        jobId = j && j.id;
      }
    }
    if (action === "ACCEPT" && jobId) {
      const r = await accept(c, jobId, "whatsapp");
      if (r.ok) {
        const j = r.doc, p = j.property || {};
        await wa.text(c.phone, `✅ Job ${j.ref} is yours.\n📍 ${[p.address, p.postcode].filter(Boolean).join(", ")}\nAttend by ${fmtDT(j.attendBy)}. Fee ${gbp(j.dispatch.agreedPrice)}.\n\nPlease set your attend time and update progress here:\n${linkFor(c)}`);
      } else if (r.error === "QUOTE") {
        await wa.text(c.phone, `This job needs a quote. Send your price and timeframe here:\n${linkFor(c)}`);
      } else await wa.text(c.phone, r.error || "Couldn't accept that job.");
      return;
    }
    if (action === "DECLINE") { await wa.text(c.phone, "No problem, thanks for letting us know."); return; }
    await wa.text(c.phone, `Hi ${firstName(c.name)}, your job board is here:\n${linkFor(c)}\n\nTo take a job you can also reply YES and the job number, e.g. YES PM-0004.`);
  }

  return { boardView, myView, accept, quote, step, timeframe, done, note, handback, notifyPost, notifyAssigned, handleIncoming, alertParties, linkFor };
}

module.exports = { makeDispatch, area, fmtDT };
