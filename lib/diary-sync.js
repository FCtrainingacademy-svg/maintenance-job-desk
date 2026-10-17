// Puts job desk jobs into the team diary at ksplumbingstore.co.uk/diary, so the diary
// (and everyone's Outlook / phone calendar feed from it) shows them without typing them twice.
// Needs DIARY_SYNC_URL (e.g. https://ksplumbingstore.co.uk/api/bot/diary-sync) and DIARY_SYNC_KEY
// (the same value as DIARY_SYNC_KEY on the website). Without them nothing is sent.
const env = process.env;
const enabled = () => !!(env.DIARY_SYNC_URL && env.DIARY_SYNC_KEY);
const firstName = s => String(s || "").trim().split(/\s+/)[0] || "";

const TYPE = { "Heating / boiler": "Repair / breakdown", "Gas safety (CP12)": "Gas safety (CP12)", "Plumbing / leak": "Repair / breakdown", "Drainage / blockage": "Repair / breakdown" };
const STATUS = { new: "booked", scheduled: "booked", in_progress: "progress", awaiting_parts: "progress", complete: "done", invoiced: "invoiced", paid: "invoiced" };

// What the diary should show for a job (null = nothing to show).
function diaryEntry(j, officeUrl) {
  const when = j.scheduledAt || (j.dispatch && j.dispatch.contractorAttendBy) || j.attendBy || "";
  const p = j.property || {}, d = j.dispatch || {}, s = j.source || {};
  if (j.example || !j.ref) return null;
  if (j.status === "cancelled" || d.status === "withdrawn") return { ref: j.ref, delete: true };
  if (!/^\d{4}-\d{2}-\d{2}/.test(when)) return null;
  let who = "";
  if (d.mode === "group") {
    const team = (d.team || []).map(t => firstName(t.name)), slots = d.slots || 2;
    who = team.length >= slots ? team.join(" & ") : `${team.length}/${slots} engineers` + (team.length ? ` (${team.join(", ")})` : "");
  } else if (d.allocatedTo && j._allocatedName) who = j._allocatedName;
  const title = [j.ref, j.description || j.category || "Maintenance job"].join(" ") + (who ? ` – ${who}` : "");
  const notes = [
    j.category && "Category: " + j.category,
    d.mode === "group" && d.groupName && "Group: " + d.groupName,
    d.mode === "group" && (d.team || []).length && "On it: " + d.team.map(t => t.name + (t.phone ? " " + t.phone : "")).join(", "),
    d.mode === "group" && d.reserve && "Reserve: " + d.reserve.name + (d.reserve.phone ? " " + d.reserve.phone : ""),
    s.name && "Sent in by: " + s.name,
    "Managed in the job desk" + (officeUrl ? " – " + officeUrl : "") + ". Changes made here are overwritten by the job desk.",
  ].filter(Boolean).join("\n");
  return { ref: j.ref, title: title.slice(0, 160), type: TYPE[j.category] || "Other", status: STATUS[j.status] || "booked",
    customer: s.name || (j.issuer && (j.issuer.company || j.issuer.name)) || "", phone: s.phone || (j.issuer && j.issuer.phone) || "",
    address: [p.address, p.postcode].filter(Boolean).join(", "), date: when.slice(0, 10), start: when.length >= 16 ? when.slice(11, 16) : "",
    hours: 1, notes };
}

function makeDiarySync() {
  async function send(body) {
    const r = await fetch(env.DIARY_SYNC_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-Diary-Key": env.DIARY_SYNC_KEY }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`diary answered ${r.status}`);
    return r.json().catch(() => ({}));
  }
  async function push(job, base) {
    if (!enabled()) return { skipped: true };
    const e = diaryEntry(job, base ? base + "/" : "");
    if (!e) return { skipped: true };
    return send(e);
  }
  async function remove(ref) { if (enabled() && ref) return send({ ref, delete: true }); return { skipped: true }; }
  return { push, remove, enabled };
}

module.exports = { makeDiarySync, diaryEntry };
