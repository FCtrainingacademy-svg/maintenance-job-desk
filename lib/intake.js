// Jobs sent in on WhatsApp by the office team (approved numbers only).
//   1. Someone on the approved list messages the job number, e.g. "Wed 22 Oct 9am, 14 Cranbrook Rd IG1 4PU, combi no hot water"
//   2. The bot reads it and replies with what it understood + which contractor group it will go to
//   3. They reply YES → the job is created, posted to that group (each member gets the alert), and put in the diary
// Settings live in settings/intake: { senders: [{name, phone}], groups: [{id, name, members: [contractorId], isDefault}] }
const crypto = require("crypto");
const { parseJob } = require("./parse-job");

const PENDING_HOURS = 3;
const SLOTS = 2;

const pad = n => String(n).padStart(2, "0");
const nowLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const fmtWhen = (date, time) => {
  const d = new Date(`${date}T${time || "00:00"}`);
  if (isNaN(d)) return `${date} ${time}`;
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) + (time ? `, ${time}` : "");
};
const EXAMPLE = "Wed 22 Oct 9am, 14 Cranbrook Rd IG1 4PU, combi no hot water";
const HELP = [
  "Send a job like this:",
  EXAMPLE,
  "",
  "It needs a date, time, postcode and what the job is. Add the address before the postcode if you have it.",
  "To pick a group add: group Ilford (or #ilford).",
  "",
  "I'll check it with you, then reply YES to post it, NO to cancel, or GROUP <name> to change the group.",
  "GROUPS lists the groups.",
].join("\n");

function makeIntake(store, wa, dispatch, baseUrl) {
  async function config() {
    const c = (await store.get("settings", "intake")) || {};
    return { senders: c.senders || [], groups: (c.groups || []).filter(g => g && g.name) };
  }
  const senderFor = (cfg, from) => cfg.senders.find(s => s.phone && s.active !== false && wa.intl(s.phone) === from);

  function pickGroup(cfg, wanted) {
    if (wanted) {
      const w = wanted.toLowerCase().replace(/\s+group$/, "").trim();
      return cfg.groups.find(g => g.name.toLowerCase() === w) || cfg.groups.find(g => g.name.toLowerCase().startsWith(w))
        || cfg.groups.find(g => g.name.toLowerCase().includes(w)) || null;
    }
    return cfg.groups.find(g => g.isDefault) || (cfg.groups.length === 1 ? cfg.groups[0] : null);
  }
  async function members(group) {
    const out = [];
    for (const id of group.members || []) { const k = await store.get("contractors", id); if (k && k.active !== false && k.phone) out.push(k); }
    return out;
  }
  const groupList = cfg => cfg.groups.length ? cfg.groups.map(g => `• ${g.name}${g.isDefault ? " (default)" : ""} – ${(g.members || []).length} contractor${(g.members || []).length === 1 ? "" : "s"}`).join("\n") : "No groups set up yet.";

  async function summary(draft, group, n) {
    const lines = ["New job – check it before I post it:", "",
      `📅 ${fmtWhen(draft.date, draft.time)}`, `📍 ${[draft.address, draft.postcode].filter(Boolean).join(", ")}`, `🔧 ${draft.description}`,
      `👥 ${group.name} group (${n} contractor${n === 1 ? "" : "s"})`];
    if (draft.priority !== "routine") lines.push(`⚠️ Marked ${draft.priority}`);
    const today = nowLocal().slice(0, 10);
    if (draft.date < today) lines.push("", "⚠️ That date has already passed – send it again if it's wrong.");
    if (draft.warning) lines.push("", `⚠️ ${draft.warning} I've used the date – send it again if that's wrong.`);
    if (!draft.address) lines.push("", "No street address given – engineers will only get the postcode. Send it again with the address if you have it.");
    lines.push("", `Reply YES to post it to the group, NO to cancel, or GROUP <name> to send it to a different group.`);
    return lines.join("\n");
  }

  async function nextRef() {
    const r = await store.withLock("settings", "counters", async cur => {
      let max = Number((cur && cur.pm) || 0);
      for (const j of await store.list("jobs")) { const m = String(j.ref || "").match(/^PM-(\d+)$/); if (m) max = Math.max(max, Number(m[1])); }
      return { doc: { ...(cur || {}), pm: max + 1 }, n: max + 1 };
    });
    return "PM-" + String(r.n).padStart(4, "0");
  }

  async function createJob(draft, group, sender, from) {
    const ks = await members(group);
    const now = new Date().toISOString(), at = `${draft.date}T${draft.time}`;
    const id = "wa-" + crypto.randomBytes(6).toString("hex");
    const job = {
      id, ref: await nextRef(), status: "new", priority: draft.priority, category: draft.category, description: draft.description,
      reportedAt: nowLocal(), attendBy: at, scheduledAt: at,
      property: { address: draft.address, postcode: draft.postcode }, residents: [], issuer: {}, billSame: true,
      materials: [], labour: [], callout: 0, pricing: { mode: "rate", band: "auto", extras: {} },
      alerts: { residents: false, issuer: false },
      source: { via: "whatsapp", name: sender.name || "", phone: sender.phone || "", from, text: draft.text || "", at: now },
      dispatch: { mode: "group", slots: SLOTS, status: "open", groupId: group.id, groupName: group.name, recipients: ks.map(k => k.id),
        team: [], reserve: null, allocatedTo: "", postedAt: now },
      track: { posted: now },
      log: [{ at: now, text: `Sent in on WhatsApp by ${sender.name || "+" + from} and posted to the ${group.name} group (${ks.length})` }],
      createdAt: now, updatedAt: now,
    };
    await store.put("jobs", id, job);
    return job;
  }

  // Returns true when the message was an office job message and has been answered.
  async function maybeHandle(from, payload, text) {
    if (payload) return false; // button taps are contractor replies
    const cfg = await config();
    const sender = senderFor(cfg, from);
    if (!sender) return false;
    const t = String(text || "").trim();
    if (!t) return true;
    const contractor = (await store.list("contractors")).find(k => wa.intl(k.phone) === from);
    const pending = await store.get("intake", from);
    const live = pending && Date.now() - new Date(pending.at).getTime() < PENDING_HOURS * 3600e3 ? pending : null;
    // Someone who is both office and contractor replying to a job alert ("YES PM-0012", "DROP PM-0012")
    if (contractor && /^(yes|accept|y|no|decline|drop|cancel|cant|can't|cannot)\b[\s:#-]*PM-?\d+/i.test(t)) return false;
    if (contractor && !live && /^(yes|accept|y|no|decline|drop)\W*$/i.test(t)) return false;

    if (/^(help|\?|how)\W*$/i.test(t)) { await wa.text(from, HELP); return true; }
    if (/^groups?\W*$/i.test(t)) { await wa.text(from, "Groups:\n" + groupList(cfg)); return true; }
    if (/^(no|n|cancel|stop|discard)\W*$/i.test(t)) {
      if (pending) await store.del("intake", from);
      await wa.text(from, live ? "Cancelled – nothing was posted." : "Nothing waiting to post.");
      return true;
    }
    const gm = t.match(/^(?:group|#)\s*([^\d\n]{2,40})$/i);
    if (gm && live) {
      const g = pickGroup(cfg, gm[1]);
      if (!g) { await wa.text(from, `No group called "${gm[1]}".\n${groupList(cfg)}`); return true; }
      const n = (await members(g)).length;
      await store.put("intake", from, { ...live, groupId: g.id, at: new Date().toISOString() });
      await wa.text(from, await summary(live.draft, g, n));
      return true;
    }
    if (/^(y|yes|ok|okay|post|post it|confirm|send|send it|go|👍)\W*$/iu.test(t)) {
      if (!live) { await wa.text(from, "Nothing waiting to post. Send the job details first, e.g.\n" + EXAMPLE); return true; }
      const g = cfg.groups.find(x => x.id === live.groupId);
      if (!g) { await wa.text(from, "That group has been removed. Reply GROUP <name> to pick another.\n" + groupList(cfg)); return true; }
      const job = await createJob(live.draft, g, sender, from);
      await store.del("intake", from);
      const r = await dispatch.notifyPost(job.id);
      dispatch.pushDiary(job);
      const n = (r.results || []).length;
      await wa.text(from, `Posted ✓ ${job.ref} to the ${g.name} group (${n} contractor${n === 1 ? "" : "s"}).\nThe first ${SLOTS} to accept get it and the next one is reserve. I'll message you as they accept.\nIt's in the diary and the job desk: ${baseUrl()}/`);
      return true;
    }

    // Otherwise: a new job
    const draft = parseJob(t, new Date());
    if (draft.missing.length) {
      await wa.text(from, `I couldn't find the ${draft.missing.join(", ").replace(/, ([^,]*)$/, " or $1")} in that.\n\nSend it like this:\n${EXAMPLE}\n\nReply HELP for more.`);
      return true;
    }
    if (!cfg.groups.length) { await wa.text(from, "There are no contractor groups set up yet. Add them in the job desk under Settings → WhatsApp job intake, then send the job again."); return true; }
    const g = pickGroup(cfg, draft.group);
    if (!g) {
      await wa.text(from, draft.group ? `No group called "${draft.group}".\n${groupList(cfg)}\n\nSend the job again with the right group.` : `Which group should this go to? Send the job again with "group <name>".\n${groupList(cfg)}`);
      return true;
    }
    const n = (await members(g)).length;
    if (!n) { await wa.text(from, `The ${g.name} group has no contractors with a mobile number yet. Add them in the job desk under Settings → WhatsApp job intake.`); return true; }
    await store.put("intake", from, { draft: { ...draft, text: t.slice(0, 1000) }, groupId: g.id, at: new Date().toISOString(), sender: sender.name || "" });
    await wa.text(from, await summary(draft, g, n));
    return true;
  }

  return { maybeHandle, config, HELP };
}

module.exports = { makeIntake };
