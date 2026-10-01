// ============================================================
//  supabase-client.js  -  tiny Supabase REST client (no SDK)
//  Shared by index.html, scan.html and manual.html
// ============================================================
(function () {
  const CFG = window.SUPABASE_CONFIG || {};
  const BASE = (CFG.url || "").replace(/\/$/, "");
  const configured = !!BASE && !BASE.includes("YOUR-PROJECT") &&
                     !!CFG.anonKey && !CFG.anonKey.startsWith("YOUR_");

  function headers(extra) {
    const h = { apikey: CFG.anonKey, "Content-Type": "application/json" };
    // Old anon keys are JWTs (start with "eyJ") and go in Authorization too.
    // New publishable keys (sb_publishable_...) are NOT JWTs: apikey header only.
    if (CFG.anonKey.startsWith("eyJ")) h.Authorization = "Bearer " + CFG.anonKey;
    return Object.assign(h, extra || {});
  }

  async function req(method, path, body, extraHeaders, timeoutMs = 30000) {
    if (!configured) throw new Error("Supabase not configured (edit supabase-config.js)");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(BASE + "/rest/v1/" + path, {
        method,
        headers: headers(extraHeaders),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`${method} ${path.split("?")[0]} -> ${res.status} ${t.slice(0, 200)}`);
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(timer); }
  }

  // Read every row (PostgREST returns max 1000 per request, so page through)
  async function selectAll(table, query, pageSize = 1000) {
    const out = [];
    for (let offset = 0; ; offset += pageSize) {
      const rows = await req("GET", `${table}?${query}&limit=${pageSize}&offset=${offset}`);
      out.push(...rows);
      if (rows.length < pageSize) break;
    }
    return out;
  }

  const upsert = (table, rows, onConflict = "id") =>
    req("POST", `${table}?on_conflict=${onConflict}`, rows,
        { Prefer: "resolution=merge-duplicates,return=minimal" });
  const patch = (table, filter, obj) =>
    req("PATCH", `${table}?${filter}`, obj, { Prefer: "return=minimal" });
  const del = (table, filter) =>
    req("DELETE", `${table}?${filter}`, undefined, { Prefer: "return=minimal" });

  // ── Row <-> app object mapping ──────────────────────────────
  const iso = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
  const num = v => (v === "" || v == null || !isFinite(Number(v))) ? null : Number(v);

  function studentToRow(s) {
    return {
      id: String(s.id),
      student_unique_id: s.studentUniqueId || s.id,
      name: s.name || "",
      roll: s.roll || "",
      class: s.class || "",
      student_phone: s.studentPhone || "",
      parent_phone: s.parentPhone || "",
      embedding_count: Number(s.embeddingCount) || 0,
      registered_on: iso(s.registeredOn),
      updated_on: iso(s.updatedOn) || new Date().toISOString(),
    };
  }
  const rowToStudent = r => ({
    id: r.id, studentUniqueId: r.student_unique_id || r.id,
    name: r.name, roll: r.roll, class: r.class,
    studentPhone: r.student_phone || "", parentPhone: r.parent_phone || "",
    embeddingCount: r.embedding_count || 0,
    registeredOn: r.registered_on, updatedOn: r.updated_on,
  });
  function attToRow(a) {
    return {
      id: String(a.id),
      student_id: a.studentId || null,
      student_unique_id: a.studentUniqueId || a.studentId || null,
      name: a.name || "", roll: a.roll || "", class: a.class || "",
      student_phone: a.studentPhone || "", parent_phone: a.parentPhone || "",
      date_key: a.dateKey || a.date,
      date_label: a.dateLabel || "", time_label: a.timeLabel || "",
      formatted_time: a.formattedTime || "",
      ts: iso(a.timestamp) || new Date().toISOString(),
      punch_type: a.punchType || null,
      match_distance: num(a.matchDistance), match_percent: num(a.matchPercent),
      wa_sent: !!a.waSent,
    };
  }
  const rowToAtt = r => ({
    id: r.id, studentId: r.student_id || "", studentUniqueId: r.student_unique_id || "",
    name: r.name, roll: r.roll, class: r.class,
    studentPhone: r.student_phone || "", parentPhone: r.parent_phone || "",
    dateKey: r.date_key, date: r.date_key, timestamp: r.ts,
    dateLabel: r.date_label, timeLabel: r.time_label, formattedTime: r.formatted_time,
    punchType: r.punch_type || undefined,
    matchDistance: r.match_distance, matchPercent: r.match_percent,
    waSent: !!r.wa_sent,
  });

  // ── Face embedding cache (IndexedDB: big quota, survives reloads) ─
  // This is what makes scan.html work: embeddings are not kept in
  // localStorage (too small), so every page reads them from here.
  let _dbp = null;
  function db() {
    if (_dbp) return _dbp;
    _dbp = new Promise((resolve, reject) => {
      const o = indexedDB.open("facescan-cache", 1);
      o.onupgradeneeded = () => o.result.createObjectStore("faces", { keyPath: "id" });
      o.onsuccess = () => resolve(o.result);
      o.onerror = () => reject(o.error);
    });
    return _dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction("faces", mode);
      const r = fn(t.objectStore("faces"));
      t.oncomplete = () => resolve(r && r.result);
      t.onerror = () => reject(t.error);
    });
  }
  const faceCache = {
    async getAll() {
      try {
        const rows = (await tx("readonly", s => s.getAll())) || [];
        return new Map(rows.map(r => [r.id, r]));
      } catch (_) { return new Map(); }
    },
    async put(id, embeddings, updatedOn) {
      try { await tx("readwrite", s => s.put({ id, embeddings, updatedOn: updatedOn || new Date().toISOString() })); } catch (_) {}
    },
    async remove(id) { try { await tx("readwrite", s => s.delete(id)); } catch (_) {} },
    async clear()    { try { await tx("readwrite", s => s.clear()); } catch (_) {} },
  };

  window.sb = { configured, req, selectAll, upsert, patch, del,
                studentToRow, rowToStudent, attToRow, rowToAtt, faceCache };
})();
