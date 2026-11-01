// Job materials from K's Plumbing Store: engineers request parts from their job link, the office
// approves and orders them in one go, and order status (paid / dispatched) is pulled back onto the job.
const crypto = require("crypto");
const kps = require("./kps");

const KPS_NAME = "K's Plumbing Store";
const SHOP = "285-291 Wanstead Park Road, Ilford IG1 3TR";
const isKps = m => /k'?s plumbing/i.test(m.supplier || "") && m.code;
const nowISO = () => new Date().toISOString();
const firstName = s => String(s || "").trim().split(/\s+/)[0] || "";
const fmtDT = iso => { if (!iso) return ""; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); };
const cnote = (by, text) => ({ [Date.now() + "" + Math.floor(Math.random() * 1000)]: { at: nowISO(), by, text } });
const DONE = ["dispatched", "cancelled"];
const SLABEL = { awaiting_payment: "Awaiting payment", paid: "Paid – being packed", dispatched: "Dispatched", cancelled: "Cancelled" };

function makeMaterials(store, wa, dispatch) {
  async function engineersOf(j) {
    const d = j.dispatch || {};
    if (d.team && d.team.length) return d.team.map(t => ({ id: t.id, name: t.name, phone: t.phone }));
    if (d.allocatedTo) { const k = await store.get("contractors", d.allocatedTo); return k ? [{ id: k.id, name: k.name, phone: k.phone }] : []; }
    return [];
  }
  const tell = async (people, text) => { for (const p of people) if (p.phone) await wa.text(p.phone, text).catch(() => {}); };

  // Engineer adds a part they need (from the KPS catalogue, or a free-text item). Office approves later.
  async function request(c, jobId, b) {
    const qty = Math.max(1, Math.min(999, Math.round(Number(b.qty) || 1)));
    const name = String(b.name || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!name) return { ok: false, error: "Say what part you need" };
    let line = { mid: "m" + crypto.randomBytes(6).toString("hex"), item: name, qty, unit: "", supplier: "", state: "requested", requestedBy: c.name || "", requestedAt: nowISO() };
    if (b.code) {
      const hit = (await kps.search(b.code)).results || [];
      const p = hit.find(x => x.code === String(b.code));
      if (p) line = { ...line, item: p.name, code: p.code, unit: p.price, supplier: KPS_NAME };
    }
    const r = await store.withLock("jobs", jobId, async j => {
      if (!j) return { error: "That job no longer exists" };
      if (!dispatch.isMine(j, c)) return { error: "This job isn't allocated to you." };
      if ((j.track || {}).done) return { error: "This job is already complete." };
      return { doc: { ...j, materials: (j.materials || []).concat([line]), cnotes: { ...(j.cnotes || {}), ...cnote(c.id, `Requested parts: ${qty} × ${line.item}`) } } };
    });
    if (r.error) return { ok: false, error: r.error };
    const j = r.doc, s = j.source || {};
    if (s.from) wa.text(s.from, `🔧 ${firstName(c.name)} needs parts for ${j.ref}: ${qty} × ${line.item}. Approve and order them in the job desk.`).catch(() => {});
    return { ok: true };
  }

  // Office: approve and order every KPS line that's waiting (To order / Requested) as one store order.
  async function placeOrder(jobId, opts = {}) {
    const j = await store.get("jobs", jobId);
    if (!j) return { error: "Job not found" };
    const pick = (j.materials || []).map((m, i) => ({ m, i })).filter(({ m }) => isKps(m) && ["need", "requested"].includes(m.state || "need") && Number(m.qty) > 0);
    if (!pick.length) return { error: "Nothing to order – add parts from the K's Plumbing Store search first." };
    const method = ["collect", "property", "engineer"].includes(opts.method) ? opts.method : "collect";
    const p = j.property || {}, eng = await engineersOf(j);
    const address = method === "property" ? [p.address, p.postcode].filter(Boolean).join(", ") : method === "engineer" ? String(opts.address || "").trim() : "";
    if (method === "engineer" && !address) return { error: "Type the engineer's delivery address" };
    if (method === "property" && !address) return { error: "The job has no address yet" };
    const lines = pick.map(({ m }) => ({ code: m.code, qty: Math.round(Number(m.qty)) }));
    const key = j.id + "-" + crypto.createHash("sha1").update(JSON.stringify(lines) + "|" + (j.kpsOrders || []).length).digest("hex").slice(0, 12);
    const contact = eng.map(e => `${e.name}${e.phone ? " " + e.phone : ""}`).join(", ");
    const r = await kps.order({ key, jobRef: j.ref, lines, notes: String(opts.notes || "").slice(0, 400),
      delivery: { method, address, contact, neededBy: fmtDT(j.scheduledAt || (j.dispatch || {}).contractorAttendBy || j.attendBy) } });
    if (r.error) return { error: r.error };
    const price = Object.fromEntries((r.lines || []).map(l => [l.code, l.price]));
    const rec = { ref: r.ref, status: r.status, total: r.total, payUrl: r.payUrl || "", at: nowISO(), method, address: method === "collect" ? SHOP : address,
      lines: pick.map(({ m }) => ({ code: m.code, item: m.item, qty: Number(m.qty), price: price[m.code] != null ? price[m.code] : m.unit })) };
    const idx = new Set(pick.map(x => x.i)), mids = new Set(pick.map(x => x.m.mid).filter(Boolean));
    const how = { collect: "collect from the shop, " + SHOP, property: "delivered to the job address", engineer: "delivered to " + address }[method];
    await store.withLock("jobs", jobId, async cur => {
      if (!cur) return null;
      const mats = (cur.materials || []).map((m, i) => (m.mid ? mids.has(m.mid) : idx.has(i)) && isKps(m) && ["need", "requested"].includes(m.state || "need") ? { ...m, state: "ordered", order: r.ref, unit: price[m.code] != null ? price[m.code] : m.unit } : m);
      const orders = (cur.kpsOrders || []).filter(o => o.ref !== r.ref).concat([rec]);
      return { doc: { ...cur, materials: mats, kpsOrders: orders, log: (cur.log || []).concat([{ at: nowISO(), text: `Materials ordered from K's Plumbing Store: ${r.ref} (£${Number(r.total).toFixed(2)}) – ${how}` }]) } };
    });
    if (!r.repeat) await tell(eng, `📦 Parts for ${j.ref} are ordered from K's Plumbing Store (${r.ref}) – ${how}.\n${rec.lines.map(l => `• ${l.qty} × ${l.item}`).join("\n")}`);
    return { ok: true, order: rec, repeat: !!r.repeat };
  }

  // Pull order status from the store. Engineers are told when parts are dispatched.
  async function refresh(jobIds) {
    const jobs = (await store.list("jobs")).filter(j => (!jobIds || jobIds.includes(j.id)) && (j.kpsOrders || []).some(o => !DONE.includes(o.status)));
    if (!jobs.length || !kps.enabled()) return 0;
    const refs = [...new Set(jobs.flatMap(j => j.kpsOrders.filter(o => !DONE.includes(o.status)).map(o => o.ref)))];
    const r = await kps.statuses(refs);
    if (r.error) return 0;
    const by = Object.fromEntries((r.orders || []).map(o => [o.ref, o]));
    let changed = 0;
    for (const j of jobs) {
      const moved = [];
      await store.withLock("jobs", j.id, async cur => {
        if (!cur) return null;
        let diff = false;
        const orders = (cur.kpsOrders || []).map(o => {
          const n = by[o.ref]; if (!n || (n.status === o.status && (n.payUrl || "") === (o.payUrl || ""))) return o;
          diff = true; if (n.status !== o.status) moved.push({ ...o, status: n.status });
          return { ...o, status: n.status, payUrl: n.payUrl || o.payUrl || "", paidAt: n.paidAt || "", dispatchedAt: n.dispatchedAt || "" };
        });
        if (!diff) return null;
        const log = moved.map(o => ({ at: nowISO(), text: `K's Plumbing Store order ${o.ref}: ${SLABEL[o.status] || o.status}` }));
        return { doc: { ...cur, kpsOrders: orders, log: (cur.log || []).concat(log) } };
      });
      if (moved.length) {
        changed++;
        const eng = await engineersOf(j);
        for (const o of moved) if (o.status === "dispatched")
          await tell(eng, `🚚 Parts for ${j.ref} (${o.ref}) have been dispatched${o.method === "collect" ? " – ready to collect from the shop, " + SHOP : ""}.`);
      }
    }
    return changed;
  }

  return { request, placeOrder, refresh, SLABEL };
}

module.exports = { makeMaterials, KPS_NAME, SHOP };
