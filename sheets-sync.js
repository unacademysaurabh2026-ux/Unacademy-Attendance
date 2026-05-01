// ============================================================
//  sheets-sync.js  —  Google Sheets sync for FaceScan (v2)
//  - Syncs students, attendance, AND face embeddings
//  - Punch-in / punch-out logic
//  - Loads face data on startup so any device works
//
//  Add AFTER app.js in index.html:
//  <script src="sheets-sync.js" defer></script>
// ============================================================

window.SHEETS_URL = "https://script.google.com/macros/s/AKfycbz0eZexwQj85eAjbAW6aULn2_BMwSs5cE1Fn5W2jOdZxeTxg_S8_GmlaogdTurfe2-ujg/exec";

const SYNC_DEBOUNCE_MS = 1200;
let _syncDebounceTimer = null;

// ─────────────────────────────────────────────────────────────
//  Core fetch helper
// ─────────────────────────────────────────────────────────────
async function sheetsRequest(action, body = {}) {
  const url = window.SHEETS_URL;
  if (!url || url === "PASTE_YOUR_APPS_SCRIPT_URL_HERE") return null;
  try {
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action, ...body }),
    });
    const data = await res.json();
    if (!data.ok) console.error(`[Sheets] ${action}:`, data.error);
    return data;
  } catch (err) {
    console.error(`[Sheets] Network error (${action}):`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  Status badge (bottom-right corner)
// ─────────────────────────────────────────────────────────────
function showSyncStatus(msg, color = "#0ea5e9") {
  let badge = document.getElementById("sheets-sync-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "sheets-sync-badge";
    badge.style.cssText =
      "position:fixed;bottom:18px;right:18px;z-index:9999;" +
      "padding:8px 16px;border-radius:24px;font-size:12px;font-weight:700;" +
      "color:#fff;box-shadow:0 4px 20px rgba(0,0,0,0.4);" +
      "transition:opacity 0.4s ease;pointer-events:none;";
    document.body.appendChild(badge);
  }
  badge.textContent      = msg;
  badge.style.background = color;
  badge.style.opacity    = "1";
  clearTimeout(badge._hideTimer);
  badge._hideTimer = setTimeout(() => { badge.style.opacity = "0"; }, 3500);
}

// ─────────────────────────────────────────────────────────────
//  Embedding serialization helpers
//  Format:  "n1,n2,n3,...|n1,n2,n3,..." (arrays pipe-separated)
// ─────────────────────────────────────────────────────────────
function serializeEmbeddings(descriptors) {
  if (!Array.isArray(descriptors) || !descriptors.length) return "";
  return descriptors.map(d => Array.from(d).join(",")).join("|");
}

function deserializeEmbeddings(str) {
  if (!str) return [];
  return str.split("|").map(part => part.split(",").map(Number)).filter(d => d.length > 0);
}

// ─────────────────────────────────────────────────────────────
//  Punch-in / punch-out logic
//  Rule: first scan of the day = punch-in, second = punch-out,
//        third = punch-in again, etc.
// ─────────────────────────────────────────────────────────────
function determinePunchType(studentId, dateKey) {
  const todayRecords = state.attendances.filter(
    a => a.studentId === studentId && a.dateKey === dateKey
  );
  // Odd count so far (0, 2, 4...) → next is punch-in
  // Even count so far (1, 3, 5...) → next is punch-out
  return todayRecords.length % 2 === 0 ? "punch-in" : "punch-out";
}

// ─────────────────────────────────────────────────────────────
//  Sync individual items
// ─────────────────────────────────────────────────────────────
async function syncStudentToSheets(student) {
  const slim = {
    id:              student.id,
    studentUniqueId: student.studentUniqueId || student.id,
    name:            student.name,
    roll:            student.roll,
    class:           student.class,
    studentPhone:    student.studentPhone,
    parentPhone:     student.parentPhone,
    embeddingCount:  student.embeddingCount,
    registeredOn:    student.registeredOn,
    updatedOn:       student.updatedOn,
  };
  const res = await sheetsRequest("saveStudent", { student: slim });
  return res?.ok ?? false;
}

async function syncFaceDataToSheets(student) {
  if (!student.descriptors?.length) return false;
  const embeddings = serializeEmbeddings(student.descriptors);
  const res = await sheetsRequest("saveFaceData", {
    studentId:       student.id,
    studentUniqueId: student.studentUniqueId || student.id,
    embeddings,
    updatedOn:       student.updatedOn || new Date().toISOString(),
  });
  return res?.ok ?? false;
}

async function syncAttendanceToSheets(record) {
  const slim = { ...record, scanPhoto: "" };
  const res  = await sheetsRequest("saveAttendance", { record: slim });
  return res?.ok ?? false;
}

async function deleteStudentFromSheets(studentId) {
  await sheetsRequest("deleteStudent",  { studentId });
  await sheetsRequest("deleteFaceData", { studentId });
}

async function deleteAttendanceFromSheets(recordId) {
  await sheetsRequest("deleteAttendance", { recordId });
}

// ─────────────────────────────────────────────────────────────
//  Startup: load everything from Sheets
//  - Face embeddings loaded into memory → recognition works offline
// ─────────────────────────────────────────────────────────────
async function loadFromSheets() {
  const url = window.SHEETS_URL;
  if (!url || url === "PASTE_YOUR_APPS_SCRIPT_URL_HERE") return;

  showSyncStatus("📥 Loading from Google Sheets…", "#6366f1");

  try {
    const [studentsRes, attendanceRes, faceRes] = await Promise.all([
      sheetsRequest("getStudents"),
      sheetsRequest("getAllAttendance"),
      sheetsRequest("getFaceData"),
    ]);

    // ── Build face embedding lookup ───────────────────────────
    const faceMap = {};
    if (faceRes?.ok && Array.isArray(faceRes.faceData)) {
      faceRes.faceData.forEach(fd => {
        faceMap[fd.studentId] = deserializeEmbeddings(fd.embeddings);
      });
    }

    // ── Merge students ────────────────────────────────────────
    if (studentsRes?.ok && Array.isArray(studentsRes.students)) {
      const localStudents = state.students;
      const merged = studentsRes.students.map(s => {
        const local       = localStudents.find(l => l.id === s.id);
        const descriptors = faceMap[s.id] || local?.descriptors || null;
        return {
          ...(local || {}),
          id:              s.id,
          studentUniqueId: s.studentUniqueId || s.id,
          name:            s.name,
          roll:            s.roll,
          class:           s.class,
          studentPhone:    s.studentPhone,
          parentPhone:     s.parentPhone,
          embeddingCount:  Number(s.embeddingCount) || descriptors?.length || 0,
          registeredOn:    s.registeredOn || local?.registeredOn,
          updatedOn:       s.updatedOn    || local?.updatedOn,
          descriptors,
          descriptor:      local?.descriptor || (descriptors?.length ? averageDescriptors(descriptors) : null),
          angleData:       local?.angleData  || null,
          facePhoto:       "",
        };
      });
      // Keep any local-only students not yet pushed
      const localOnly = localStudents.filter(l => !studentsRes.students.find(s => s.id === l.id));
      state.students  = [...merged, ...localOnly].map(normalizeStudent).filter(Boolean);
      localStorage.setItem(STORAGE_KEYS.students, JSON.stringify(state.students));
    }

    // ── Merge attendance ──────────────────────────────────────
    if (attendanceRes?.ok && Array.isArray(attendanceRes.records)) {
      const sheetsRecords = attendanceRes.records;
      const localOnly     = state.attendances.filter(
        l => !sheetsRecords.find(s => s.id === l.id)
      );
      state.attendances = [...sheetsRecords, ...localOnly]
        .map(normalizeAttendance).filter(Boolean)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(state.attendances));
    }

    updateDashboardStats();
    renderStudentsGrid();
    renderAttendanceTable();
    showSyncStatus(
      `✅ ${state.students.length} students · ${state.attendances.length} records loaded`,
      "#10b981"
    );

    // Push any local-only attendance up to Sheets
    const unsynced = state.attendances.filter(a => a.syncState === "local-only");
    for (const a of unsynced) {
      const ok = await syncAttendanceToSheets(a);
      if (ok) a.syncState = "synced";
    }
    if (unsynced.length) localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(state.attendances));

  } catch (err) {
    console.error("[Sheets] loadFromSheets error:", err);
    showSyncStatus("⚠️ Sheets load failed — using local data", "#f59e0b");
  }
}

// ─────────────────────────────────────────────────────────────
//  Full push (manual sync button)
// ─────────────────────────────────────────────────────────────
async function fullSyncToSheets() {
  const url = window.SHEETS_URL;
  if (!url || url === "PASTE_YOUR_APPS_SCRIPT_URL_HERE") return;
  showSyncStatus("⏫ Syncing everything to Sheets…", "#6366f1");
  let ok = true;
  for (const s of state.students) {
    const r1 = await syncStudentToSheets(s);
    const r2 = await syncFaceDataToSheets(s);
    if (!r1 || !r2) { ok = false; break; }
  }
  for (const a of state.attendances) {
    const r = await syncAttendanceToSheets(a);
    if (!r) { ok = false; break; }
  }
  showSyncStatus(
    ok ? "✅ Full sync complete" : "⚠️ Partial sync — check console",
    ok ? "#10b981" : "#f59e0b"
  );
}

// ─────────────────────────────────────────────────────────────
//  Debounced push after every saveData()
// ─────────────────────────────────────────────────────────────
async function debouncedSheetsPush() {
  const url = window.SHEETS_URL;
  if (!url || url === "PASTE_YOUR_APPS_SCRIPT_URL_HERE") return;
  showSyncStatus("⏫ Saving to Sheets…", "#6366f1");
  let failed = false;
  for (const a of state.attendances) {
    if (a.syncState === "local-only") {
      const ok = await syncAttendanceToSheets(a);
      if (ok) a.syncState = "synced"; else failed = true;
    }
  }
  if (!failed) localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(state.attendances));
  showSyncStatus(
    failed ? "⚠️ Some records failed to sync" : "✅ Saved to Google Sheets",
    failed ? "#f59e0b" : "#10b981"
  );
}

// ─────────────────────────────────────────────────────────────
//  Patch saveData() — auto-push after every local save
// ─────────────────────────────────────────────────────────────
(function patchSaveData() {
  const _orig = window.saveData || saveData;
  window.saveData = function () {
    _orig.call(this);
    clearTimeout(_syncDebounceTimer);
    _syncDebounceTimer = setTimeout(() => void debouncedSheetsPush(), SYNC_DEBOUNCE_MS);
  };
})();

// ─────────────────────────────────────────────────────────────
//  Patch registerStudent() — sync student + face data after save
// ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    const _origReg = window.registerStudent;
    if (_origReg) {
      window.registerStudent = async function (event) {
        await _origReg.call(this, event);
        const newest = state.students[0];
        if (newest) {
          showSyncStatus("⏫ Syncing student to Sheets…", "#6366f1");
          const r1 = await syncStudentToSheets(newest);
          const r2 = await syncFaceDataToSheets(newest);
          showSyncStatus(
            (r1 && r2) ? "✅ Student + face data synced" : "⚠️ Sync failed — check console",
            (r1 && r2) ? "#10b981" : "#f59e0b"
          );
        }
      };
    }

    // Patch deleteStudent
    const _origDel = window.deleteStudent;
    if (_origDel) {
      window.deleteStudent = async function (studentId) {
        _origDel.call(this, studentId);
        await deleteStudentFromSheets(studentId);
      };
    }

    // Patch deleteAttendanceRecord
    const _origDelAtt = window.deleteAttendanceRecord;
    if (_origDelAtt) {
      window.deleteAttendanceRecord = async function (recordId) {
        _origDelAtt.call(this, recordId);
        await deleteAttendanceFromSheets(recordId);
      };
    }

    // ── Add punchType to every new attendance record ──────────
    // We intercept the record just before it's pushed to Sheets
    const _origSaveAtt = window.saveAttendance;
    if (_origSaveAtt) {
      // saveAttendance is the Sheets function — already has punchType
    }
    // The punchType is added inside debouncedSheetsPush by reading
    // state.attendances — we tag records here instead:
    _injectPunchTypeIntoRecords();

  }, 500);
});

// Add punchType field to attendance records that don't have it yet
function _injectPunchTypeIntoRecords() {
  // Override state.attendances.unshift to tag new records with punchType
  const _origUnshift = Array.prototype.unshift;
  // We watch saveData calls instead — simpler approach:
  // punchType is determined in debouncedSheetsPush before pushing
  const _origDebounced = debouncedSheetsPush;
  window.debouncedSheetsPush = async function () {
    // Tag unsynced records with punchType before pushing
    for (const a of state.attendances) {
      if (a.syncState === "local-only" && !a.punchType) {
        // Find all records for this student on this date BEFORE this one
        const earlier = state.attendances.filter(
          r => r.studentId === a.studentId &&
               r.dateKey   === a.dateKey   &&
               r.id        !== a.id        &&
               new Date(r.timestamp) < new Date(a.timestamp)
        );
        a.punchType = earlier.length % 2 === 0 ? "punch-in" : "punch-out";
      }
    }
    await _origDebounced.call(this);
  };
}

// ─────────────────────────────────────────────────────────────
//  Manual sync button (injected into Settings section)
// ─────────────────────────────────────────────────────────────
function injectSyncButton() {
  const settingsSection = document.getElementById("section-settings");
  if (!settingsSection || document.getElementById("manual-sync-btn")) return;
  const container = document.createElement("div");
  container.className = "mt-6 p-5 bg-slate-900 border border-slate-700 rounded-3xl";
  const u = window.SHEETS_URL;
  const urlStatus = u === "PASTE_YOUR_APPS_SCRIPT_URL_HERE"
    ? "<span class='text-red-400'>⚠️ Sheets URL not set in sheets-sync.js</span>"
    : `<span class='text-emerald-400'>✅ Connected</span>`;
  container.innerHTML = `
    <div class="text-sm font-semibold text-slate-300 mb-1">☁️ Google Sheets Sync</div>
    <div class="text-xs text-slate-400 mb-1">
      Students, face data &amp; attendance auto-sync to Google Sheets.
    </div>
    <div class="text-xs mb-4">${urlStatus}</div>
    <div class="flex gap-3 flex-wrap">
      <button id="manual-sync-btn" type="button"
        class="px-5 py-3 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 font-semibold text-sm rounded-2xl transition-colors">
        ⏫ Push All to Sheets
      </button>
      <button id="load-sheets-btn" type="button"
        class="px-5 py-3 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-semibold text-sm rounded-2xl transition-colors">
        📥 Pull from Sheets
      </button>
    </div>
  `;
  settingsSection.prepend(container);
  document.getElementById("manual-sync-btn").onclick = () => fullSyncToSheets();
  document.getElementById("load-sheets-btn").onclick  = () => loadFromSheets();
}

// ─────────────────────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(async () => {
    injectSyncButton();
    await loadFromSheets();
  }, 900);
});
