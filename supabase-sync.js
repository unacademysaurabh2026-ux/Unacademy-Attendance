// ============================================================
//  supabase-sync.js  -  Supabase sync for FaceScan (index + scan)
//  Replaces sheets-sync.js. Function names are kept (…ToSheets)
//  so app.js keeps working unchanged.
// ============================================================

const SYNC_DEBOUNCE_MS = 1200;
let _syncDebounceTimer = null;
let _loadPromise = null;
let _bootPromise = Promise.resolve();
let _pushing = false;
const FACES_SINCE_KEY = "sb-faces-since";
const enc = encodeURIComponent;

// ── Status badge ──────────────────────────────────────────────
function showSyncStatus(msg, color = "#0ea5e9") {
  let badge = document.getElementById("sheets-sync-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "sheets-sync-badge";
    badge.style.cssText =
      "position:fixed;bottom:18px;right:18px;z-index:9999;" +
      "padding:8px 16px;border-radius:24px;font-size:12px;font-weight:700;" +
      "color:#fff;box-shadow:0 4px 20px rgba(0,0,0,0.4);" +
      "transition:opacity 0.4s ease;pointer-events:none;font-family:Inter,sans-serif;";
    document.body.appendChild(badge);
  }
  badge.textContent = msg;
  badge.style.background = color;
  badge.style.opacity = "1";
  clearTimeout(badge._hideTimer);
  badge._hideTimer = setTimeout(() => { badge.style.opacity = "0"; }, 3500);
}

const toEmbeddings = descs =>
  (descs || []).map(d => Array.from(d, x => Math.round(Number(x) * 1e5) / 1e5));

// ── Push functions (names kept for app.js) ────────────────────
async function syncStudentToSheets(student) {
  if (!sb.configured) return null;
  try { await sb.upsert("students", [sb.studentToRow(student)]); return { ok: true }; }
  catch (e) { console.error("[Supabase] saveStudent:", e.message); return { ok: false, error: e.message }; }
}

async function syncFaceDataToSheets(student) {
  if (!student.descriptors?.length) return false;
  const embeddings = toEmbeddings(student.descriptors);
  const ts = new Date().toISOString();
  await sb.faceCache.put(student.id, embeddings, ts);   // local copy first
  if (!sb.configured) return false;
  try {
    await sb.upsert("face_data", [{ student_id: student.id, embeddings, updated_on: ts }], "student_id");
    return { ok: true };
  } catch (e) { console.error("[Supabase] saveFaceData:", e.message); return { ok: false, error: e.message }; }
}

async function syncAttendanceToSheets(record) {
  if (!sb.configured) return null;
  try { await sb.upsert("attendance", [sb.attToRow(record)]); return { ok: true }; }
  catch (e) { console.error("[Supabase] saveAttendance:", e.message); return { ok: false, error: e.message }; }
}

// ── Local light-copy writers (no embeddings / photos) ─────────
function saveLightLocal() {
  try {
    const light = state.students.map(s => {
      const { descriptors, descriptor, ...rest } = s;
      return { ...rest, embeddingCount: s.embeddingCount || descriptors?.length || 0 };
    });
    localStorage.setItem(STORAGE_KEYS.students, JSON.stringify(light));
  } catch (_) {}
  try {
    localStorage.setItem(STORAGE_KEYS.attendance,
      JSON.stringify(state.attendances.slice(0, 500).map(a => ({ ...a, scanPhoto: "" }))));
  } catch (_) {}
}

// ── Face embeddings: cache + incremental download ─────────────
async function hydrateFromCache() {
  const cache = await sb.faceCache.getAll();
  let n = 0;
  for (const s of state.students) {
    if (!s.descriptors?.length) {
      const c = cache.get(s.id);
      if (c?.embeddings?.length) {
        s.descriptors = c.embeddings;
        s.embeddingCount = c.embeddings.length;
        n++;
      }
    }
  }
  return n;
}

async function fetchFaceMap(studentRows) {
  const cache = await sb.faceCache.getAll();
  const missing = studentRows.filter(r => (r.embedding_count || 0) > 0 && !cache.has(r.id));
  const since = localStorage.getItem(FACES_SINCE_KEY);
  let q = "select=student_id,embeddings,updated_on&order=updated_on.asc";
  if (!missing.length && since) q += `&updated_on=gt.${enc(since)}`;
  const rows = await sb.selectAll("face_data", q, 100);
  let newest = since || "";
  for (const r of rows) {
    await sb.faceCache.put(r.student_id, r.embeddings, r.updated_on);
    cache.set(r.student_id, { id: r.student_id, embeddings: r.embeddings });
    if (r.updated_on > newest) newest = r.updated_on;
  }
  if (newest) localStorage.setItem(FACES_SINCE_KEY, newest);
  const map = {};
  for (const [id, v] of cache) map[id] = v.embeddings;
  return map;
}

// ── Pull everything ───────────────────────────────────────────
async function loadFromSupabase() {
  if (!sb.configured) { showSyncStatus("Supabase not configured", "#ef4444"); return; }
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    showSyncStatus("Loading from Supabase…", "#6366f1");
    try {
      const [studRows, attRows] = await Promise.all([
        sb.selectAll("students", "select=*&order=registered_on.asc"),
        sb.selectAll("attendance", "select=*&order=ts.desc"),
      ]);
      const faceMap = await fetchFaceMap(studRows);

      // Students
      const local = state.students;
      const serverIds = new Set(studRows.map(r => r.id));
      const merged = studRows.map(r => {
        const s = sb.rowToStudent(r);
        const loc = local.find(l => l.id === s.id);
        const descriptors = faceMap[s.id] || loc?.descriptors || null;
        return {
          ...(loc || {}), ...s,
          embeddingCount: s.embeddingCount || descriptors?.length || 0,
          descriptors, descriptor: loc?.descriptor || null,
          angleData: loc?.angleData || null, facePhoto: "",
        };
      });
      const localOnly = local.filter(l => !serverIds.has(l.id));
      state.students = [...merged, ...localOnly].map(normalizeStudent).filter(Boolean);
      for (const s of state.students) computeAndCacheAvgDescriptor(s);
      saveAvgDescriptors();

      // Attendance: server is truth; keep only local records not yet pushed
      const serverAtt = new Map(attRows.map(r => [r.id, sb.rowToAtt(r)]));
      const localById = new Map(state.attendances.map(a => [a.id, a]));
      const out = [];
      for (const [id, rec] of serverAtt) {
        const loc = localById.get(id);
        const waLocalOnly = loc?.waSent && !rec.waSent;
        out.push({ ...rec, waSent: rec.waSent || !!loc?.waSent, syncState: waLocalOnly ? "local-only" : "synced" });
      }
      for (const a of state.attendances) {
        if (!serverAtt.has(a.id) && a.syncState === "local-only") out.push(a);
      }
      state.attendances = out.map(normalizeAttendance).filter(Boolean)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      saveLightLocal();
      try { updateDashboardStats(); renderStudentsGrid(); renderAttendanceTable(); } catch (_) {}
      showSyncStatus(`✅ ${state.students.length} students · ${state.attendances.length} records`, "#10b981");
    } catch (err) {
      console.error("[Supabase] load:", err);
      showSyncStatus("⚠️ Could not load from Supabase", "#f59e0b");
    } finally { _loadPromise = null; }
  })();
  return _loadPromise;
}
async function loadFromSheets() { return loadFromSupabase(); }   // legacy name used by app.js

// Called by startAttendanceCamera(): make sure every student has face data
async function ensureFacesLoaded() {
  await _bootPromise;
  const needs = () => !state.students.length ||
    state.students.some(s => (s.embeddingCount > 0) && !s.descriptors?.length);
  if (needs()) await loadFromSupabase();
}

// ── Push pending attendance (debounced after saveData) ────────
async function debouncedSheetsPush() {
  if (!sb.configured || _pushing) return;
  const pending = state.attendances.filter(a => a.syncState === "local-only");
  if (!pending.length) return;
  _pushing = true;
  showSyncStatus("Saving to Supabase…", "#6366f1");
  try {
    for (const a of pending) {
      if (!a.punchType) {
        const earlier = state.attendances.filter(r =>
          r.studentId === a.studentId && r.dateKey === a.dateKey &&
          r.id !== a.id && new Date(r.timestamp) < new Date(a.timestamp));
        a.punchType = earlier.length % 2 === 0 ? "punch-in" : "punch-out";
      }
    }
    for (let i = 0; i < pending.length; i += 200) {
      const chunk = pending.slice(i, i + 200);
      await sb.upsert("attendance", chunk.map(sb.attToRow));
      chunk.forEach(a => { a.syncState = "synced"; });
    }
    saveLightLocal();
    showSyncStatus("✅ Saved to Supabase", "#10b981");
  } catch (e) {
    console.error("[Supabase] push:", e.message);
    showSyncStatus("⚠️ Sync failed — will retry", "#f59e0b");
  } finally { _pushing = false; }
}

// ── Full push (manual button) ─────────────────────────────────
async function fullSyncToSheets() {
  if (!sb.configured) { showSyncStatus("Supabase not configured", "#ef4444"); return; }
  showSyncStatus("Syncing everything…", "#6366f1");
  try {
    for (let i = 0; i < state.students.length; i += 200)
      await sb.upsert("students", state.students.slice(i, i + 200).map(sb.studentToRow));
    for (const s of state.students) {
      if (s.descriptors?.length) await syncFaceDataToSheets(s);
    }
    for (let i = 0; i < state.attendances.length; i += 200)
      await sb.upsert("attendance", state.attendances.slice(i, i + 200).map(sb.attToRow));
    state.attendances.forEach(a => { a.syncState = "synced"; });
    showSyncStatus("✅ Full sync complete", "#10b981");
  } catch (e) {
    console.error(e); showSyncStatus("⚠️ Partial sync: " + e.message.slice(0, 60), "#f59e0b");
  }
}

// ── One-time migration from the old Google Sheet ──────────────
async function migrateFromGoogleSheets() {
  const url = window.SUPABASE_CONFIG?.legacySheetsUrl;
  if (!sb.configured) { alert("Fill supabase-config.js first."); return; }
  if (!url) { alert("legacySheetsUrl is not set in supabase-config.js."); return; }
  if (!confirm("Copy all students, face data and attendance from the old Google Sheet into Supabase?\n(Safe to run again; existing rows are updated, not duplicated.)")) return;
  const ask = async action => {
    let lastErr;
    for (let t = 1; t <= 3; t++) {
      try {
        const r = await fetch(`${url}?payload=${enc(JSON.stringify({ action }))}`, { redirect: "follow" });
        const text = await r.text();
        try { return JSON.parse(text); }
        catch (_) {
          const title = (text.match(/<title>(.*?)<\/title>/i) || [])[1] || text.slice(0, 80);
          throw new Error(`Google returned a web page instead of data for "${action}" (${title})`);
        }
      } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 2000)); }
    }
    throw lastErr;
  };
  let faceError = "";
  try {
    showSyncStatus("Reading students…", "#6366f1");
    const st = await ask("getStudents");
    showSyncStatus("Reading attendance…", "#6366f1");
    const at = await ask("getAllAttendance");
    if (!st?.ok || !at?.ok) throw new Error("Google Sheet replied with an error: " + (st?.error || at?.error || "unknown"));
    let fc = null;
    try { showSyncStatus("Reading face data (can take a while)…", "#6366f1"); fc = await ask("getFaceData"); }
    catch (e) { faceError = e.message; }

    const faceRows = (fc?.ok ? fc.faceData : []).map(fd => ({
      student_id: fd.studentId,
      embeddings: toEmbeddings(deserializeLegacyEmbeddings(fd.embeddings)),
      updated_on: new Date().toISOString(),
    })).filter(r => r.embeddings.length);
    const counts = new Map(faceRows.map(r => [r.student_id, r.embeddings.length]));

    const studRows = dedupeBy(st.students.map(s => sb.studentToRow({ ...s, embeddingCount: counts.get(s.id) || Number(s.embeddingCount) || 0 })));
    for (let i = 0; i < studRows.length; i += 200) {
      showSyncStatus(`Students ${Math.min(i + 200, studRows.length)}/${studRows.length}`, "#6366f1");
      await sb.upsert("students", studRows.slice(i, i + 200));
    }
    for (let i = 0; i < faceRows.length; i += 10) {
      showSyncStatus(`Face data ${Math.min(i + 10, faceRows.length)}/${faceRows.length}`, "#6366f1");
      await sb.upsert("face_data", faceRows.slice(i, i + 10), "student_id");
    }
    const attRows = dedupeBy(at.records.map(r => sb.attToRow(normalizeAttendance(r))));
    for (let i = 0; i < attRows.length; i += 500) {
      showSyncStatus(`Attendance ${Math.min(i + 500, attRows.length)}/${attRows.length}`, "#6366f1");
      await sb.upsert("attendance", attRows.slice(i, i + 500));
    }
    localStorage.removeItem(FACES_SINCE_KEY);
    await sb.faceCache.clear();
    await loadFromSupabase();
    alert(`Migration done.\n\nStudents: ${studRows.length}\nFace data: ${faceRows.length}\nAttendance: ${attRows.length}` +
      (faceError ? `\n\n⚠️ Face data could NOT be read:\n${faceError}\nStudents and attendance were copied. Run migration again later, or re-register faces.` : ""));
  } catch (e) {
    console.error(e); showSyncStatus("⚠️ Migration failed", "#ef4444"); alert("Migration failed: " + e.message);
  }
}
function deserializeLegacyEmbeddings(str) {
  if (!str) return [];
  return String(str).split("|").map(p => p.split(",").map(Number)).filter(d => d.length > 10);
}


// Same id twice in one batch makes Postgres reject the upsert; keep the last one
const dedupeBy = (rows, k = "id") => [...new Map(rows.map(r => [r[k], r])).values()];

// ── Import from CSV files (downloaded from the old Google Sheet) ──
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f); f = ""; rows.push(row); row = [];
    } else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ""));
}

const _nk = h => String(h || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const _pick = (o, aliases) => { for (const a of aliases) if (o[a] !== undefined && o[a] !== "") return o[a]; return ""; };

// Parse "a,b,c|a,b,c" into 128-number vectors. Cells may have been split by the
// old sheet (50k char cell limit), so try joining pieces with "" then with "|".
function parseVectors(pieces) {
  const tryJoin = sep => {
    const good = [], bad = [];
    for (const v of pieces.join(sep).split("|")) {
      const nums = v.split(",").map(x => Number(x.trim()));
      (nums.length === 128 && nums.every(Number.isFinite) ? good : bad).push(nums);
    }
    return { good, bad: bad.filter(b => b.length > 1).length };
  };
  const a = tryJoin(""), b = tryJoin("|");
  return (b.good.length - b.bad * 2 > a.good.length - a.bad * 2 ? b : a).good;
}

function readCsvTable(text, fileName) {
  const rows = parseCSV(text);
  if (rows.length < 2) return null;
  const headers = rows[0].map(_nk);
  const objs = rows.slice(1).map(r => {
    const o = {}; headers.forEach((h, i) => { if (h && o[h] === undefined) o[h] = (r[i] ?? "").trim(); });
    o.__cells = r; return o;
  });
  const has = re => headers.some(h => re.test(h));
  let type = "unknown";
  if (headers.some(h => /embedding|descriptor/.test(h) && !/count/.test(h))) type = "faces";
  else if (has(/^(datekey|timestamp|formattedtime|punchtype|matchpercent)$/)) type = "attendance";
  else if (has(/^(name|studentname)$/) && has(/^(roll|rollno|rollnumber)$/)) type = "students";
  return { fileName, type, headers, rows: objs };
}

async function importCsvFiles(fileList) {
  if (!sb.configured) { alert("Fill supabase-config.js first."); return; }
  const files = [...fileList];
  if (!files.length) return;
  try {
    const tables = [];
    for (const f of files) {
      const t = readCsvTable(await f.text(), f.name);
      if (!t) { alert(`"${f.name}" is empty.`); return; }
      if (t.type === "unknown") { alert(`Could not tell what "${f.name}" contains.\nColumns found: ${t.headers.join(", ")}`); return; }
      tables.push(t);
    }
    const byType = ty => tables.filter(t => t.type === ty).flatMap(t => t.rows);

    // Students
    const stuAlias = { id: ["id", "studentid"], uid: ["studentuniqueid", "uniqueid"], name: ["name", "studentname"],
      roll: ["roll", "rollno", "rollnumber"], cls: ["class", "classname"], sp: ["studentphone", "studentmobile", "phone", "mobile"],
      pp: ["parentphone", "parentmobile"], reg: ["registeredon", "registeredat"], upd: ["updatedon", "updatedat"] };
    const students = byType("students").map(r => {
      const s = {
        name: _pick(r, stuAlias.name), roll: _pick(r, stuAlias.roll), class: _pick(r, stuAlias.cls),
        studentPhone: _pick(r, stuAlias.sp), parentPhone: _pick(r, stuAlias.pp),
        registeredOn: _pick(r, stuAlias.reg), updatedOn: _pick(r, stuAlias.upd),
      };
      s.id = _pick(r, stuAlias.id) || buildStudentId(s.class, s.roll);
      s.studentUniqueId = _pick(r, stuAlias.uid) || s.id;
      return s;
    }).filter(s => s.name && s.id);
    const stuDupes = students.length - dedupeBy(students).length;
    const studentsU = dedupeBy(students);

    // Face data (group rows per student; the old sheet may have split big cells)
    const pieces = new Map();
    for (const t of tables.filter(t => t.type === "faces")) {
      const embIdx = t.headers.map((h, i) => /embedding|descriptor|chunk|part/.test(h) && !/count/.test(h) ? i : -1).filter(i => i >= 0);
      for (const r of t.rows) {
        const id = _pick(r, ["studentid", "id"]);
        if (!id) continue;
        const txt = embIdx.map(i => r.__cells[i] ?? "").join("");
        if (!pieces.has(id)) pieces.set(id, []);
        pieces.get(id).push(txt);
      }
    }
    const studentIds = new Set(studentsU.map(s => s.id));
    let faceRows = [], faceBad = [];
    for (const [id, ps] of pieces) {
      const vecs = parseVectors(ps);
      if (!vecs.length) { faceBad.push(id); continue; }
      if (studentIds.size && !studentIds.has(id)) continue;
      faceRows.push({ student_id: id, embeddings: toEmbeddings(vecs), updated_on: new Date().toISOString() });
    }
    const counts = new Map(faceRows.map(r => [r.student_id, r.embeddings.length]));
    studentsU.forEach(s => { s.embeddingCount = counts.get(s.id) || 0; });

    // Attendance
    const attAlias = { id: ["id", "attendanceid", "recordid"], studentId: ["studentid"], studentUniqueId: ["studentuniqueid"],
      name: ["name", "studentname"], roll: ["roll", "rollno"], class: ["class", "classname"], studentPhone: ["studentphone"],
      parentPhone: ["parentphone"], dateKey: ["datekey", "date"], timestamp: ["timestamp", "scannedat"], dateLabel: ["datelabel"],
      timeLabel: ["timelabel"], formattedTime: ["formattedtime"], punchType: ["punchtype"], matchDistance: ["matchdistance"],
      matchPercent: ["matchpercent"], waSent: ["wasent"] };
    const attRows = byType("attendance").map(r => {
      const o = {};
      for (const k in attAlias) o[k] = _pick(r, attAlias[k]);
      o.matchPercent = String(o.matchPercent).replace("%", "");
      o.waSent = /^(true|yes|1)$/i.test(String(o.waSent));
      if (o.matchDistance === "") o.matchDistance = null;
      if (o.matchPercent === "") o.matchPercent = null;
      if (!o.id) delete o.id;
      const n = normalizeAttendance(o);
      return n && sb.attToRow(n);
    }).filter(r => r && r.student_id && r.date_key);
    const attDupes = attRows.length - dedupeBy(attRows).length;
    const attU = dedupeBy(attRows);

    const summary = `Students: ${studentsU.length}${stuDupes ? ` (${stuDupes} duplicate rows merged)` : ""}\nFace data: ${faceRows.length} students (${faceRows.reduce((a, r) => a + r.embeddings.length, 0)} face samples)\nAttendance: ${attU.length}${attDupes ? ` (${attDupes} duplicates merged)` : ""}` +
      (faceBad.length ? `\n\n⚠️ Face data unreadable for ${faceBad.length} student(s): ${faceBad.slice(0, 5).join(", ")}${faceBad.length > 5 ? "…" : ""}` : "");
    if (!confirm(`Import this into Supabase?\n\n${summary}`)) return;

    const stuRows = studentsU.map(sb.studentToRow);
    for (let i = 0; i < stuRows.length; i += 200) {
      showSyncStatus(`Students ${Math.min(i + 200, stuRows.length)}/${stuRows.length}`, "#6366f1");
      await sb.upsert("students", stuRows.slice(i, i + 200));
    }
    for (let i = 0; i < faceRows.length; i += 10) {
      showSyncStatus(`Face data ${Math.min(i + 10, faceRows.length)}/${faceRows.length}`, "#6366f1");
      await sb.upsert("face_data", faceRows.slice(i, i + 10), "student_id");
    }
    for (let i = 0; i < attU.length; i += 500) {
      showSyncStatus(`Attendance ${Math.min(i + 500, attU.length)}/${attU.length}`, "#6366f1");
      await sb.upsert("attendance", attU.slice(i, i + 500));
    }
    localStorage.removeItem(FACES_SINCE_KEY);
    await sb.faceCache.clear();
    await loadFromSupabase();
    alert("CSV import done ✅\n\n" + summary);
  } catch (e) {
    console.error(e); showSyncStatus("⚠️ CSV import failed", "#ef4444"); alert("CSV import failed: " + e.message);
  }
}

// ── Hook into app.js functions ────────────────────────────────
(function patchApp() {
  const wrap = (name, fn) => { const o = window[name]; if (typeof o === "function") window[name] = fn(o); };

  wrap("saveData", orig => function (...a) {
    orig.apply(this, a);
    clearTimeout(_syncDebounceTimer);
    _syncDebounceTimer = setTimeout(() => void debouncedSheetsPush(), SYNC_DEBOUNCE_MS);
  });

  wrap("deleteStudent", orig => function (id) {
    const had = state.students.some(s => s.id === id);
    orig.call(this, id);
    if (had && !state.students.some(s => s.id === id) && sb.configured) {   // not cancelled
      sb.del("students", `id=eq.${enc(id)}`).catch(console.error);
      sb.del("face_data", `student_id=eq.${enc(id)}`).catch(console.error);
      sb.faceCache.remove(id);
    }
  });

  wrap("deleteAttendanceRecord", orig => function (id) {
    const had = state.attendances.some(a => a.id === id);
    orig.call(this, id);
    if (had && !state.attendances.some(a => a.id === id) && sb.configured)
      sb.del("attendance", `id=eq.${enc(id)}`).catch(console.error);
  });

  wrap("markWaSent", orig => function (id) {
    orig.call(this, id);
    if (sb.configured) sb.patch("attendance", `id=eq.${enc(id)}`, { wa_sent: true }).catch(() => {});
  });

  // Edit student: push name/phone changes and any re-scanned face
  wrap("saveEditStudent", orig => function (...a) {
    const id = document.getElementById("edit-student-id")?.value;
    const before = state.students.find(s => s.id === id);
    const beforeDesc = before?.descriptors;
    orig.apply(this, a);
    const s = state.students.find(x => x.id === id);
    if (!s || !sb.configured) return;
    syncStudentToSheets(s).then(() => {
      if (s.descriptors && s.descriptors !== beforeDesc) return syncFaceDataToSheets(s);
    });
  });
})();

// ── Settings buttons ──────────────────────────────────────────
function injectSyncButton() {
  const sec = document.getElementById("section-settings") || document.getElementById("section-home");
  if (!sec || document.getElementById("manual-sync-btn")) return;
  const div = document.createElement("div");
  div.className = "mt-6 p-5 bg-slate-900 border border-slate-700 rounded-3xl";
  div.innerHTML = `
    <div class="text-sm font-semibold text-slate-300 mb-1">🗄️ Supabase Sync</div>
    <div class="text-xs mb-4 ${sb.configured ? "text-emerald-400" : "text-red-400"}">
      ${sb.configured ? "✅ Connected to Supabase" : "⚠️ Not configured — edit supabase-config.js"}
    </div>
    <div class="flex gap-3 flex-wrap">
      <button id="manual-sync-btn" type="button" class="px-5 py-3 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 font-semibold text-sm rounded-2xl">⬆️ Push All</button>
      <button id="load-sheets-btn" type="button" class="px-5 py-3 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-semibold text-sm rounded-2xl">⬇️ Pull</button>
      <button id="migrate-sheets-btn" type="button" class="px-5 py-3 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 font-semibold text-sm rounded-2xl">📥 Migrate from Google Sheets</button>
      <button id="import-csv-btn" type="button" class="px-5 py-3 bg-violet-500/10 hover:bg-violet-500/20 text-violet-400 font-semibold text-sm rounded-2xl">📄 Import from CSV files</button>
      <input id="import-csv-input" type="file" accept=".csv,text/csv" multiple class="hidden" />
    </div>`;
  sec.appendChild(div);
  document.getElementById("manual-sync-btn").onclick   = fullSyncToSheets;
  document.getElementById("load-sheets-btn").onclick   = loadFromSupabase;
  document.getElementById("migrate-sheets-btn").onclick = migrateFromGoogleSheets;
  const inp = document.getElementById("import-csv-input");
  document.getElementById("import-csv-btn").onclick = () => inp.click();
  inp.onchange = async () => { await importCsvFiles(inp.files); inp.value = ""; };
}

// ── Boot (runs after app.js initApp, which registered first) ──
document.addEventListener("DOMContentLoaded", () => {
  injectSyncButton();
  _bootPromise = (async () => {
    try { await hydrateFromCache(); } catch (e) { console.warn(e); }
    updateDashboardStats?.();
  })();
  _bootPromise.then(() => loadFromSupabase());
});
