// Reads a job sent in on WhatsApp by the office team, e.g.
//   "Wed 22 Oct 9am, 14 Cranbrook Rd IG1 4PU, combi no hot water E119"
// or labelled lines ("Date: 22/10", "Time: 9am", "Address: ...", "Job: ...").
// Returns { date: "YYYY-MM-DD", time: "HH:MM", address, postcode, description, priority, category, group, missing: [] }.
// Pure function – no I/O – so it is easy to test.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WD = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const WEEKDAY_WORD = /\b(mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)\b\.?/gi;
const PC_FULL = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
const STREET = /\b(road|rd|street|st|avenue|ave|lane|ln|close|cl|drive|dr|way|gardens|gdns|court|ct|crescent|cres|place|pl|grove|gr|terrace|hill|park|square|sq|mews|walk|row|parade|house|flat|unit|apartment|apt|block|estate|towers?)\b/i;

const CATEGORY_WORDS = [
  [/\b(boiler|combi|heating|radiator|rad|thermostat|no hot water|hot water|pressure|e1\d\d|f\d\d|ignition|gas)\b/i, "Heating / boiler"],
  [/\b(cp12|gas safe(ty)?|landlord cert)/i, "Gas safety (CP12)"],
  [/\b(blocked|blockage|drain|sink blocked|unblock)\b/i, "Drainage / blockage"],
  [/\b(leak|leaking|drip|tap|toilet|wc|cistern|shower|pipe|burst|water)\b/i, "Plumbing / leak"],
  [/\b(electric|socket|fuse|trip|tripping|lights?|power|rcd)\b/i, "Electrical"],
  [/\b(roof|gutter|tiles?)\b/i, "Roofing / gutters"],
  [/\b(door|lock|window|hinge|carpentry)\b/i, "Carpentry / doors / locks"],
  [/\b(damp|mould|mold|condensation)\b/i, "Damp & mould"],
  [/\b(oven|cooker|hob|washing machine|fridge|appliance|dishwasher)\b/i, "Appliance"],
];

const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const validDate = (y, m, d) => { const x = new Date(y, m - 1, d); return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? x : null; };
const cut = (s, m) => m ? s.slice(0, m.index) + " " + s.slice(m.index + m[0].length) : s;
const tidy = s => String(s || "").replace(/\s+/g, " ").replace(/\s+([,.])/g, "$1").replace(/^[\s,.;:–—-]+|[\s,.;:–—-]+$/g, "").trim();

function findTime(s) {
  let m = s.match(/\b(?:at\s+|@\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    let h = Number(m[1]) % 12; const mi = Number(m[2] || 0);
    if (m[3].toLowerCase() === "pm") h += 12;
    if (h < 24 && mi < 60) return { time: `${pad(h)}:${pad(mi)}`, m };
  }
  m = s.match(/\b(?:at\s+|@\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  if (m) return { time: `${pad(Number(m[1]))}:${m[2]}`, m };
  m = s.match(/\b(noon|midday)\b/i);
  if (m) return { time: "12:00", m };
  m = s.match(/\b(?:at|@)\s*(\d{1,2})\b(?!\s*(?:\/|-|th|st|nd|rd|[a-z]))/i);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) { const h = Number(m[1]); return { time: `${pad(h < 7 ? h + 12 : h)}:00`, m }; }
  return null;
}

function findDate(s, today) {
  let m = s.match(/\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/);
  if (m) {
    const yy = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : today.getFullYear();
    let d = validDate(yy, Number(m[2]), Number(m[1]));
    if (d && !m[3] && d < addDays(today, 0)) d = validDate(yy + 1, Number(m[2]), Number(m[1]));
    if (d) return { date: d, m };
  }
  const mon = MONTHS.join("|");
  m = s.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${mon})[a-z]*\\.?(?:\\s+(\\d{4}))?\\b`, "i"))
    || s.match(new RegExp(`\\b(${mon})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b`, "i"));
  if (m) {
    const [dd, mn] = /^\d/.test(m[1]) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
    const yy = m[3] ? Number(m[3]) : today.getFullYear();
    let d = validDate(yy, MONTHS.indexOf(mn.toLowerCase().slice(0, 3)) + 1, dd);
    if (d && !m[3] && d < today) d = validDate(yy + 1, d.getMonth() + 1, dd);
    if (d) return { date: d, m };
  }
  m = s.match(/\btoday\b|\btonight\b/i);
  if (m) return { date: today, m };
  m = s.match(/\b(tomorrow|tmrw|tmw|tomoz)\b/i);
  if (m) return { date: addDays(today, 1), m };
  m = s.match(/\b(?:on\s+)?(?:(next|this)\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b\.?/i);
  if (m) {
    const wd = WD.indexOf(m[2].toLowerCase());
    const todayWd = (today.getDay() + 6) % 7;
    let ahead = (wd - todayWd + 7) % 7;
    if (m[1] && m[1].toLowerCase() === "next" && ahead === 0) ahead = 7;
    return { date: addDays(today, ahead), m };
  }
  return null;
}

function guessCategory(text) {
  for (const [re, cat] of CATEGORY_WORDS) if (re.test(text)) return cat;
  return "General repair";
}

// Split the text before a postcode into address and (anything said before the address) description.
function splitBeforePostcode(before) {
  const b = before.trim();
  if (!b) return { address: "", lead: "" };
  const flat = b.search(/\b(flat|unit|apartment|apt|room)\s*\w+/i);
  let start = flat;
  if (start < 0) {
    const re = /\b\d+[a-z]?\s+[a-z]/gi; let m, last = -1;
    while ((m = re.exec(b))) last = m.index;
    start = last;
  }
  if (start <= 0) return { address: b, lead: "" };
  return { address: b.slice(start), lead: b.slice(0, start).replace(/\b(at|@|in|for)\s*$/i, "") };
}

function parseJob(raw, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let text = String(raw || "").replace(/\r/g, "").trim();
  text = text.replace(/^\s*(new\s+job|job|book)\b\s*[:\-–]?\s*/i, "");
  const out = { warning: "", date: "", time: "", address: "", postcode: "", description: "", priority: "routine", category: "", group: "", missing: [] };

  // 1. labelled lines
  const LABELS = [["date", /^(date|day|when)$/], ["time", /^(time|at)$/], ["address", /^(address|addr|property|location)$/],
    ["postcode", /^(postcode|post code|pc)$/], ["description", /^(job|description|desc|details|issue|fault|work|job description|problem)$/], ["group", /^(group|team)$/]];
  const lab = {};
  const lines = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([a-z][a-z ]{1,18}?)\s*[:\-–]\s*(.+)$/i);
    const hit = m && LABELS.find(([, re]) => re.test(m[1].trim().toLowerCase()));
    if (hit) lab[hit[0]] = m[2].trim(); else lines.push(line);
  }
  let rest = lines.join("\n");

  // 2. group: "group Ilford", "#ilford", or a Group: line
  if (lab.group) out.group = lab.group;
  else {
    const g = rest.match(/(?:^|\s)#([\w&'-]{2,30})/) || rest.match(/\bgroup\s*[:\-]?\s*([\w&'-]{2,30}(?:\s[\w&'-]{2,20})?)(?=\s*(?:[,.\n]|$))/i);
    if (g) { out.group = g[1].trim(); rest = cut(rest, g); }
  }

  // 3. time and date
  let t = findTime(lab.time || "") || (lab.date && findTime(lab.date));
  if (!t) { t = findTime(rest); if (t) rest = cut(rest, t.m); }
  if (t) out.time = t.time;
  let d = findDate(lab.date || "", today);
  if (!d) { d = findDate(rest, today); if (d) rest = cut(rest, d.m); }
  if (d) {
    out.date = iso(d.date);
    // "Fri 24 Oct" when the 24th is a Saturday – flag it rather than guess
    const wdm = !lab.date && /\d/.test(d.m[0]) && rest.match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i);
    if (wdm && WD.indexOf(wdm[1].toLowerCase()) !== (d.date.getDay() + 6) % 7)
      out.warning = `${d.date.getDate()} ${MONTHS[d.date.getMonth()].replace(/^./, c => c.toUpperCase())} is a ${d.date.toLocaleDateString("en-GB", { weekday: "long" })}, not ${wdm[0]}.`;
    if (!lab.date) rest = rest.replace(WEEKDAY_WORD, " "); // "Wed 22 Oct" – drop the leftover weekday
  }

  // 4. priority (kept in the description too)
  if (/\b(emergency|out of hours|ooh)\b/i.test(text)) out.priority = "emergency";
  else if (/\b(urgent|asap|today)\b/i.test(text)) out.priority = "urgent";

  // 5. postcode and address
  const descParts = [];
  if (lab.address) {
    const pm = lab.address.match(PC_FULL);
    if (pm) { out.postcode = (pm[1] + " " + pm[2]).toUpperCase(); out.address = tidy(cut(lab.address, pm)); }
    else out.address = tidy(lab.address);
  }
  if (lab.postcode) { const pm = lab.postcode.match(PC_FULL); if (pm) out.postcode = (pm[1] + " " + pm[2]).toUpperCase(); }
  const segs = rest.split(/\n|;/).flatMap(l => l.split(",")).map(s => s.trim()).filter(Boolean);
  const used = new Set();
  if (!out.postcode || !lab.address) {
    const idx = segs.findIndex(s => PC_FULL.test(s));
    if (idx >= 0) {
      const s = segs[idx], pm = s.match(PC_FULL);
      if (!out.postcode) out.postcode = (pm[1] + " " + pm[2]).toUpperCase();
      const before = s.slice(0, pm.index), after = s.slice(pm.index + pm[0].length);
      const sp = splitBeforePostcode(before);
      const addr = sp.address ? [tidy(sp.address)] : [];
      // earlier comma-separated bits that look like an address ("Flat 2, 14 Cranbrook Rd, Ilford IG1 4PU")
      let i = idx - 1;
      if (!sp.lead) {
        while (i >= 0 && addr.length < 4) {
          const p = segs[i];
          const looksAddr = (/\d/.test(p) || STREET.test(p)) && p.length <= 60 && !/\b(no|not|leak|broken|fault|error)\b/i.test(p);
          const townOnly = addr.length && /^[A-Z][a-z]+(\s[A-Z][a-z]+)?$/.test(p);
          if (!(looksAddr || townOnly)) {
            // "leak under sink at Flat 3" – keep the flat/unit with the address
            const fm = p.match(/^(.*?)\b((?:flat|unit|apartment|apt|room)\s*\w+)\s*$/i);
            if (fm && tidy(fm[1])) { addr.unshift(tidy(fm[2])); descParts.push([i, fm[1].replace(/\b(at|@|in)\s*$/i, "")]); used.add(i); }
            break;
          }
          addr.unshift(tidy(p)); used.add(i); i--;
        }
      }
      if (!lab.address) out.address = addr.join(", ");
      used.add(idx);
      if (sp.lead) descParts.push([idx - 0.5, sp.lead]);
      if (tidy(after)) descParts.push([idx + 0.5, after]);
    }
  }
  segs.forEach((s, i) => { if (!used.has(i)) descParts.push([i, s]); });
  out.description = tidy(lab.description || descParts.sort((a, b) => a[0] - b[0]).map(p => tidy(p[1])).filter(Boolean).join(", "));
  out.description = out.description.charAt(0).toUpperCase() + out.description.slice(1);
  out.category = guessCategory(out.description + " " + text);

  if (!out.date) out.missing.push("date");
  if (!out.time) out.missing.push("time");
  if (!out.postcode) out.missing.push("postcode");
  if (!out.description) out.missing.push("job description");
  return out;
}

module.exports = { parseJob, guessCategory };
