// ============================================================
//  sheets-sync.js  —  Google Sheets sync for FaceScan (v3)
//  Uses GET requests with URL params to avoid CORS issues
// ============================================================

window.SHEETS_URL = "PASTE_YOUR_APPS_SCRIPT_URL_HERE";

const SYNC_DEBOUNCE_MS = 1200;
let _syncDebounceTimer = null;

// ─────────────────────────────────────────────────────────────
//  Core fetch helper — uses GET to avoid CORS
// ─────────────────────────────────────────────────────────────
async function sheetsRequest(action, data = {}) {
  const url = window.SHEETS_URL;
  if (!url || url === "PASTE_YOUR_APPS_SCRIPT_URL_HERE") return null;
  try {
    // Encode all data as a single "payload" URL param
    const payload = encodeURIComponent(JSON.stringify({ action, ...data }));
    const res = await fetch(`${url}?payload=${payload}`, {
      method: "GET",
      redirect: "follow",
    });
    const text = await res.text();
    const json = JSON.parse(text);
    if (!json.ok) console.error(`[Sheets] ${action}:`, json.error);
    return json;
  } catch (err) {
    console.error(`[Sheets] Error (${action}):`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  Status badge
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
      "transition:opacity 0.4s ease;pointer-events:none;font-family:Inter,sans-serif;";
    document.body.appendChild(badge);
  }
  badge.textContent      = msg;
  badge.style.background = color;
  badge.style.opacity    = "1";
  clearTimeout(badge._hideTimer);
  badge._hideTimer = setTimeout(() => { badge.style.opacity = "0"; }, 3500);
}

// ─────────────────────────────────────────────────────────────
//  Embedding helpers
// ─────────────────────────────────────────────────────────────
function serializeEmbeddings(descriptors) {
  if (!descriptors || !descriptors.length) return "";
  return descriptors.map(d => {
    // Handle Float32Array, regular Array, or array-like objects
    if (d instanceof Float32Array || ArrayBuffer.isView(d)) return Array.from(d).join(",");
    if (Array.isArray(d)) return d.join(",");
    if (d && typeof d === "object") return Object.values(d).join(",");
    return String(d);
  }).filter(s => s.length > 10).join("|");
}

function deserializeEmbeddings(str) {
  if (!str) return [];
  return str.split("|").map(p => p.split(",").map(Number)).filter(d => d.length > 10);
}

// ─────────────────────────────────────────────────────────────
//  Sync functions
// ─────────────────────────────────────────────────────────────
async function syncStudentToSheets(student) {
  return await sheetsRequest("saveStudent", {
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
  });
}

async function syncFaceDataToSheets(student) {
  if (!student.descriptors?.length) return false;
  const url = window.SHEETS_URL;
  if (!url || url === "PASTE_YOUR_APPS_SCRIPT_URL_HERE") return false;
  try {
    const res = await fetch(url, {
      method: "POST", redirect: "follow",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ action: "saveFaceData", studentId: student.id, studentUniqueId: student.studentUniqueId || student.id, embeddings: serializeEmbeddings(student.descriptors), updatedOn: student.updatedOn || new Date().toISOString() }),
    });
    const json = JSON.parse(await res.text());
    if (!json.ok) console.error("[Sheets] saveFaceData:", json.error);
    return json;
  } catch (err) {
    console.error("[Sheets] saveFaceData error:", err.message);
    return null;
  }
}

async function syncAttendanceToSheets(record) {
  return await sheetsRequest("saveAttendance", {
    id:              record.id,
    studentId:       record.studentId,
    studentUniqueId: record.studentUniqueId || record.studentId,
    name:            record.name,
    roll:            record.roll,
    class:           record.class,
    studentPhone:    record.studentPhone,
    parentPhone:     record.parentPhone,
    dateKey:         record.dateKey,
    date:            record.date,
    timestamp:       record.timestamp,
    dateLabel:       record.dateLabel,
    timeLabel:       record.timeLabel,
    formattedTime:   record.formattedTime,
    punchType:       record.punchType || "punch-in",
    matchDistance:   record.matchDistance,
    matchPercent:    record.matchPercent,
  });
}

// ─────────────────────────────────────────────────────────────
//  Load from Sheets on startup
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

    // Build face map
    const faceMap = {};
    if (faceRes?.ok) {
      faceRes.faceData.forEach(fd => {
        faceMap[fd.studentId] = deserializeEmbeddings(fd.embeddings);
      });
    }

    // Merge students
    if (studentsRes?.ok) {
      const local  = state.students;
      const merged = studentsRes.students.map(s => {
        const loc         = local.find(l => l.id === s.id);
        const descriptors = faceMap[s.id] || loc?.descriptors || null;
        return {
          ...(loc || {}),
          id:              s.id,
          studentUniqueId: s.studentUniqueId || s.id,
          name:            s.name,
          roll:            s.roll,
          class:           s.class,
          studentPhone:    s.studentPhone,
          parentPhone:     s.parentPhone,
          embeddingCount:  Number(s.embeddingCount) || descriptors?.length || 0,
          registeredOn:    s.registeredOn || loc?.registeredOn,
          updatedOn:       s.updatedOn    || loc?.updatedOn,
          descriptors,
          descriptor:      loc?.descriptor || null,
          angleData:       loc?.angleData  || null,
          facePhoto:       "",
        };
      });
      const localOnly = local.filter(l => !studentsRes.students.find(s => s.id === l.id));
      state.students  = [...merged, ...localOnly].map(normalizeStudent).filter(Boolean);
      localStorage.setItem(STORAGE_KEYS.students, JSON.stringify(state.students));
    }

    // Merge attendance
    if (attendanceRes?.ok) {
      const localOnly = state.attendances.filter(
        l => !attendanceRes.records.find(s => s.id === l.id)
      );
      state.attendances = [...attendanceRes.records, ...localOnly]
        .map(normalizeAttendance).filter(Boolean)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(state.attendances));
    }

    updateDashboardStats?.();
    renderStudentsGrid?.();
    renderAttendanceTable?.();
    showSyncStatus(`✅ ${state.students.length} students · ${state.attendances.length} records`, "#10b981");

  } catch (err) {
    console.error("[Sheets] loadFromSheets:", err);
    showSyncStatus("⚠️ Could not load from Sheets", "#f59e0b");
  }
}

// ─────────────────────────────────────────────────────────────
//  Full push (manual)
// ─────────────────────────────────────────────────────────────
async function fullSyncToSheets() {
  showSyncStatus("⏫ Syncing everything…", "#6366f1");
  let ok = true;
  for (const s of state.students) {
    if (!(await syncStudentToSheets(s))) { ok = false; break; }
    if (!(await syncFaceDataToSheets(s))) { ok = false; break; }
  }
  for (const a of state.attendances) {
    if (!(await syncAttendanceToSheets(a))) { ok = false; break; }
  }
  showSyncStatus(ok ? "✅ Full sync complete" : "⚠️ Partial sync", ok ? "#10b981" : "#f59e0b");
}

// ─────────────────────────────────────────────────────────────
//  Debounced push after saveData()
// ─────────────────────────────────────────────────────────────
async function debouncedSheetsPush() {
  if (!window.SHEETS_URL || window.SHEETS_URL === "PASTE_YOUR_APPS_SCRIPT_URL_HERE") return;
  showSyncStatus("⏫ Saving to Sheets…", "#6366f1");
  let failed = false;
  for (const a of state.attendances) {
    if (a.syncState === "local-only") {
      // Determine punch type
      if (!a.punchType) {
        const earlier = state.attendances.filter(
          r => r.studentId === a.studentId &&
               r.dateKey   === a.dateKey   &&
               r.id        !== a.id        &&
               new Date(r.timestamp) < new Date(a.timestamp)
        );
        a.punchType = earlier.length % 2 === 0 ? "punch-in" : "punch-out";
      }
      const res = await syncAttendanceToSheets(a);
      if (res?.ok) a.syncState = "synced"; else failed = true;
    }
  }
  if (!failed) localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(state.attendances));
  showSyncStatus(failed ? "⚠️ Sync failed" : "✅ Saved to Google Sheets", failed ? "#f59e0b" : "#10b981");
}

// ─────────────────────────────────────────────────────────────
//  Patch app functions
// ─────────────────────────────────────────────────────────────
(function patchSaveData() {
  const _orig = window.saveData;
  if (_orig) {
    window.saveData = function () {
      _orig.call(this);
      clearTimeout(_syncDebounceTimer);
      _syncDebounceTimer = setTimeout(() => void debouncedSheetsPush(), SYNC_DEBOUNCE_MS);
    };
  }
})();

document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    // Patch registerStudent
    const _origReg = window.registerStudent;
    if (_origReg) {
      window.registerStudent = async function (e) {
        await _origReg.call(this, e);
        const newest = state.students[0];
        if (newest) {
          showSyncStatus("⏫ Syncing student…", "#6366f1");
          const r1 = await syncStudentToSheets(newest);
          const r2 = await syncFaceDataToSheets(newest);
          showSyncStatus((r1?.ok && r2?.ok) ? "✅ Student synced" : "⚠️ Sync failed", (r1?.ok && r2?.ok) ? "#10b981" : "#f59e0b");
        }
      };
    }
    // Patch deleteStudent
    const _origDel = window.deleteStudent;
    if (_origDel) {
      window.deleteStudent = async function (id) {
        _origDel.call(this, id);
        await sheetsRequest("deleteStudent",  { studentId: id });
        await sheetsRequest("deleteFaceData", { studentId: id });
      };
    }
    // Patch deleteAttendanceRecord
    const _origDelAtt = window.deleteAttendanceRecord;
    if (_origDelAtt) {
      window.deleteAttendanceRecord = async function (id) {
        _origDelAtt.call(this, id);
        await sheetsRequest("deleteAttendance", { recordId: id });
      };
    }
  }, 600);
});

// ─────────────────────────────────────────────────────────────
//  Manual sync buttons in Settings
// ─────────────────────────────────────────────────────────────
function injectSyncButton() {
  const sec = document.getElementById("section-settings");
  if (!sec || document.getElementById("manual-sync-btn")) return;
  const div = document.createElement("div");
  div.className = "mt-6 p-5 bg-slate-900 border border-slate-700 rounded-3xl";
  const u = window.SHEETS_URL;
  div.innerHTML = `
    <div class="text-sm font-semibold text-slate-300 mb-1">☁️ Google Sheets Sync</div>
    <div class="text-xs mb-4 ${u === "PASTE_YOUR_APPS_SCRIPT_URL_HERE" ? "text-red-400" : "text-emerald-400"}">
      ${u === "PASTE_YOUR_APPS_SCRIPT_URL_HERE" ? "⚠️ URL not set" : "✅ Connected to Google Sheets"}
    </div>
    <div class="flex gap-3 flex-wrap">
      <button id="manual-sync-btn" type="button"
        class="px-5 py-3 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 font-semibold text-sm rounded-2xl transition-colors">
        ⏫ Push All to Sheets
      </button>
      <button id="load-sheets-btn" type="button"
        class="px-5 py-3 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-semibold text-sm rounded-2xl transition-colors">
        📥 Pull from Sheets
      </button>
    </div>`;
  sec.prepend(div);
  document.getElementById("manual-sync-btn").onclick = fullSyncToSheets;
  document.getElementById("load-sheets-btn").onclick  = loadFromSheets;
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

// ─────────────────────────────────────────────────────────────
//  Auto WhatsApp — sends to parent automatically after every scan
// ─────────────────────────────────────────────────────────────
function autoSendWhatsApp(record) {
  try {
    const phone = normalizeWhatsappNumber(record.parentPhone);
    if (!phone) return;
    const message = encodeURIComponent(
      `Dear Parent,\n\nYour ward *${record.name}* (Roll No. ${record.roll}, ${record.class}) has marked attendance.\n\nTime: ${record.formattedTime}\n\nThank you!\n${state?.settings?.instituteName || "FaceScan Attendance"}`
    );
    setTimeout(() => {
      window.open(`https://wa.me/${phone}?text=${message}`, "_blank", "noopener,noreferrer");
      const idx = state.attendances.findIndex(a => a.id === record.id);
      if (idx !== -1) {
        state.attendances[idx] = { ...state.attendances[idx], waSent: true };
        saveData();
      }
    }, 1200);
  } catch (err) {
    console.error("[AutoWA] Error:", err.message);
  }
}

// Patch showQuickToast — called immediately after every successful scan
(function patchAutoWA() {
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      const _orig = window.showQuickToast;
      if (!_orig) return;
      window.showQuickToast = function(record) {
        _orig.call(this, record);
        autoSendWhatsApp(record);
      };
    }, 700);
  });
})();

// ─────────────────────────────────────────────────────────────
//  Fix: force immediate UI re-render after WA sent
//  markWaSent() calls saveData() but doesn't re-render the table
// ─────────────────────────────────────────────────────────────
(function patchMarkWaSent() {
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => {
      const _orig = window.markWaSent;
      if (!_orig) return;
      window.markWaSent = function(recordId) {
        _orig.call(this, recordId);
        renderAttendanceTable?.(); // force immediate UI update
      };
    }, 700);
  });
})();
