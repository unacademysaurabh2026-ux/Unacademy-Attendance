// ============================================================
//  sms-service.js  -  ONE way to send + track SMS (all pages)
//  - picks the device via Supabase (shared counter, 100/device/day)
//  - logs every SMS in Supabase table `sms_log`
//  - asks SMS Gate for Sent / Delivered / Failed status + reason
// ============================================================
(function () {
  const LIMIT = 100;
  const enc = encodeURIComponent;
  const devices = () => window.SMS_DEVICES || [];
  const authHeader = d => "Basic " + btoa((d.user || "") + ":" + (d.pass || ""));
  const base = d => d.url.trim().replace(/\/$/, "");
  const nowIso = () => new Date().toISOString();
  const istDay = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const rand = () => Math.random().toString(36).slice(2, 7);

  const cache = { logs: new Map(), byAtt: new Map() };
  const inflight = new Set();
  const listeners = [];
  let notifyTimer = null;
  const ACTIVE = ["queued", "pending", "processed", "sent"];

  function notify() {
    clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => { listeners.forEach(f => { try { f(); } catch (_) {} }); try { checkAlerts(); } catch (_) {} }, 400);
  }
  function remember(log) {
    cache.logs.set(log.id, log);
    if (log.attendance_id) {
      const cur = cache.byAtt.get(log.attendance_id);
      if (!cur || new Date(log.created_at) >= new Date(cur.created_at)) cache.byAtt.set(log.attendance_id, log);
    }
  }
  async function save(log) {
    log.updated_at = nowIso();
    remember(log);
    try { await sb.upsert("sms_log", [log]); } catch (e) { console.warn("[sms_log] save:", e.message); }
    notify();
  }
  async function fail(log, reason, status = "failed") {
    log.status = status; log.failure_reason = reason; log.failed_at = nowIso();
    await save(log); return log;
  }
  function normalizePhone(raw) {
    const p = String(raw || "").replace(/\D/g, "");
    if (p.length === 10) return "+91" + p;
    if (p.length === 11 && p[0] === "0") return "+91" + p.slice(1);
    if (p.length >= 11 && p.length <= 15) return "+" + p;
    return null;
  }

  // ── Send ────────────────────────────────────────────────────
  async function send(o) {
    if (o.attendanceId && o.source === "auto") {
      const prev = cache.byAtt.get(o.attendanceId);
      if (inflight.has(o.attendanceId) || (prev && prev.status !== "failed")) return prev || null;   // never double-send
    }
    if (o.attendanceId) inflight.add(o.attendanceId);
    const phone = normalizePhone(o.phone);
    const log = {
      id: "SMS-" + Date.now() + "-" + rand(),
      attendance_id: o.attendanceId || null, student_id: o.studentId || null,
      student_name: o.name || "", roll: o.roll || "", class: o.class || "",
      phone: phone || String(o.phone || ""), message: o.message || "",
      status: "queued", source: o.source || "auto", created_at: nowIso(),
    };
    if (o.retryOf) log.retry_of = o.retryOf;
    try {
      remember(log);
      if (!sb.configured) return await fail(log, "Supabase not configured");
      if (!o.phone) return await fail(log, "Parent phone number is not saved for this student");
      if (!phone) return await fail(log, "Invalid parent phone number: " + o.phone);
      if (!devices().length) return await fail(log, "No SMS device configured (sms-devices.js)");
      await save(log);

      const baseSkip = o.skipDevices || []; const failedNow = []; let lastErr = ""; let useBreaker = true;
      const breaker = o.source === "alert" ? [] : unhealthyDevices();          // devices failing right now are skipped
      const skipList = () => [...baseSkip, ...failedNow, ...(useBreaker ? breaker : [])];
      for (let attempt = 0; attempt < devices().length + 1; attempt++) {
        let idx;
        try {
          idx = await sb.req("POST", "rpc/claim_sms_slot", { p_devices: devices().length, p_limit: LIMIT, p_skip: skipList() });
        } catch (e) { return await fail(log, "Could not reach database to choose a device: " + e.message.slice(0, 120)); }
        if (idx < 0 && useBreaker && breaker.length) { useBreaker = false; continue; }   // nothing else left: try the flaky device anyway
        if (idx < 0) return await fail(log, lastErr ? "Failed on every device. Last error: " + lastErr
          : (o.skipDevices && o.skipDevices.length ? "No other device available to retry (remaining devices are full)"
          : `All devices reached the daily limit (${LIMIT} each)`));

        const dev = devices()[idx];
        log.device_index = idx; log.device_label = dev.label || ("Device " + (idx + 1));
        try {
          const resp = await fetch(base(dev) + "/3rdparty/v1/messages?skipPhoneValidation=true", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: authHeader(dev) },
            body: JSON.stringify({ textMessage: { text: o.message }, phoneNumbers: [phone] }),
            signal: AbortSignal.timeout(20000),
          });
          const text = await resp.text(); let data = {}; try { data = JSON.parse(text); } catch (_) {}
          if (resp.ok) {
            log.status = String(data.state || "Pending").toLowerCase();
            log.gateway_message_id = data.id || null; log.http_status = resp.status; log.failure_reason = null;
            await save(log);
            try { o.onAccepted && o.onAccepted(log); } catch (_) {}
            [15000, 60000, 180000].forEach(ms => setTimeout(() => refreshStatus(log).catch(() => {}), ms));
            return log;
          }
          // Gateway answered with an error: it did NOT take the SMS -> give the slot back, try next device
          await sb.req("POST", "rpc/release_sms_slot", { p_device: idx }).catch(() => {});
          failedNow.push(idx); log.http_status = resp.status;
          lastErr = `${log.device_label}: HTTP ${resp.status} ${data.message || data.error || text.slice(0, 120)}`;
        } catch (e) {
          if (e.name === "TimeoutError" || e.name === "AbortError") {
            // Unknown outcome: do NOT retry on another device (could send twice), keep the slot counted
            log.failure_reason = `${log.device_label}: no reply from gateway (timeout). The SMS may or may not have been sent.`;
            log.status = "unknown"; await save(log); return log;
          }
          await sb.req("POST", "rpc/release_sms_slot", { p_device: idx }).catch(() => {});
          return await fail(log, `${log.device_label}: network error (${e.message})`);
        }
      }
      return await fail(log, "Failed on every device. Last error: " + lastErr);
    } finally {
      if (o.attendanceId) inflight.delete(o.attendanceId);
      refreshUsage();
    }
  }

  const resend = log => send({
    attendanceId: log.attendance_id, studentId: log.student_id, name: log.student_name, roll: log.roll,
    class: log.class, phone: log.phone, message: log.message, source: "resend",
  });

  // ── Status from SMS Gate ────────────────────────────────────
  const pickTs = (states, name) => {
    const k = Object.keys(states || {}).find(x => x.toLowerCase() === name);
    const d = k ? new Date(states[k]) : null; return d && !isNaN(d) ? d.toISOString() : null;
  };
  async function refreshStatus(log) {
    if (!log.gateway_message_id || log.device_index == null) return log;
    const dev = devices()[log.device_index]; if (!dev) return log;
    const r = await fetch(`${base(dev)}/3rdparty/v1/messages/${enc(log.gateway_message_id)}`, {
      headers: { Authorization: authHeader(dev) }, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { log._chkErr = "HTTP " + r.status; throw new Error("Status check failed: HTTP " + r.status); }
    log._chkErr = null;
    const d = await r.json();
    const st = String(d.state || "").toLowerCase();
    if (!st) return log;
    const prev = log.status;
    const recErr = (d.recipients || []).map(x => x.error).filter(Boolean)[0];
    log.status = st;
    log.sent_at = pickTs(d.states, "sent") || log.sent_at || null;
    log.delivered_at = pickTs(d.states, "delivered") || log.delivered_at || null;
    log.failed_at = pickTs(d.states, "failed") || log.failed_at || null;
    if (st === "failed") log.failure_reason = d.reason || recErr || "Gateway reported failure (no reason given)";
    log.last_checked_at = nowIso();
    await save(log);
    if (st === "failed" && ACTIVE.includes(prev)) autoRetry(log).catch(e => console.warn("[retry]", e.message));
    return log;
  }

  // ── Auto-retry: a SMS that the phone reported as FAILED goes out via the next device ──
  const NO_RETRY = /invalid|not a valid|illegal|unallocated|unknown subscriber/i;   // bad number: another device won't help
  function chainDevices(log) {
    const used = []; let cur = log, guard = 0;
    while (cur && guard++ < 10) { if (cur.device_index != null) used.push(cur.device_index); cur = cur.retry_of ? cache.logs.get(cur.retry_of) : null; }
    return used;
  }
  async function autoRetry(log) {
    if (log.retried) return;
    if (Date.now() - new Date(log.created_at) > 2 * 3600 * 1000) return;     // too old to be useful
    if (NO_RETRY.test(log.failure_reason || "")) return;
    const tried = chainDevices(log);
    if (tried.length >= devices().length) return;                              // every device already tried
    // only ONE browser/page may retry a given SMS (atomic claim in the database)
    let won = false;
    try {
      const r = await sb.req("PATCH", `sms_log?id=eq.${enc(log.id)}&retried=eq.false`, { retried: true }, { Prefer: "return=representation" });
      won = Array.isArray(r) && r.length === 1;
    } catch (e) { return; }
    if (!won) return;
    log.retried = true; notify();
    await send({
      attendanceId: log.attendance_id, studentId: log.student_id, name: log.student_name, roll: log.roll, class: log.class,
      phone: log.phone, message: log.message, source: "retry", retryOf: log.id, skipDevices: tried,
    });
  }
  // The phone reports Sent/Delivered to the server late (20+ min is normal), so only call it stuck after 90 min
  const STUCK_MS = 90 * 60000;
  const isStuck = l => ["queued", "pending", "processed"].includes(l.status) && Date.now() - new Date(l.created_at) > STUCK_MS;
  async function refreshPending(limit = 20) {
    if (!sb.configured) return;
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const due = [...cache.logs.values()].filter(l =>
      ACTIVE.includes(l.status) && l.gateway_message_id && new Date(l.created_at) > cutoff &&
      (!l.last_checked_at || Date.now() - new Date(l.last_checked_at) > 45000)).slice(0, limit);
    for (let i = 0; i < due.length; i += 3)
      await Promise.all(due.slice(i, i + 3).map(l => refreshStatus(l).catch(() => {})));
  }


  // ════════════════════════════════════════════════════════════
  //  Device health: detect a phone that keeps failing / is offline, ALERT the admin
  // ════════════════════════════════════════════════════════════
  const FAIL_STREAK = 3, OFFLINE_MIN = 60, deviceInfo = {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function activeDeviceIndex() {
    const u = window.SMS_USAGE || [];
    for (let i = 0; i < devices().length; i++) if ((u[i] || 0) < LIMIT) return i;
    return -1;
  }
  // one entry per device that has FAIL_STREAK+ bad outcomes in a row (newest first) within windowMs
  function evaluateHealth(windowMs = 3 * 3600000) {
    const out = [], since = Date.now() - windowMs;
    const logs = [...cache.logs.values()].filter(l => l.device_index != null && l.source !== "alert" && new Date(l.created_at) > since)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    devices().forEach((d, i) => {
      let streak = 0, reason = "";
      for (const l of logs.filter(x => x.device_index === i)) {
        if (l.status === "sent" || l.status === "delivered") break;                 // device works -> streak ends
        if (l.status === "failed") {
          if (NO_RETRY.test(l.failure_reason || "")) continue;                      // wrong number is not the phone's fault
          streak++; reason = reason || l.failure_reason || "failed";
        } else if (l.status === "unknown" || isStuck(l)) {
          streak++; reason = reason || (l.status === "unknown" ? "no reply from gateway" : "phone is not picking up SMS");
        }                                                                           // fresh pending = neutral
      }
      if (streak >= FAIL_STREAK) out.push({ key: "failing-" + i, type: "failing", idx: i, label: d.label || ("Device " + (i + 1)), streak, reason });
    });
    return out;
  }
  const unhealthyDevices = () => evaluateHealth(30 * 60000).map(a => a.idx);

  function offlineAlerts() {
    const i = activeDeviceIndex(), d = devices()[i], info = deviceInfo[i];
    if (!d || !info || !info.lastSeen) return [];
    const mins = Math.round((Date.now() - new Date(info.lastSeen)) / 60000);
    return mins > OFFLINE_MIN ? [{ key: "offline-" + i, type: "offline", idx: i, label: d.label, mins }] : [];
  }
  async function refreshDeviceInfo() {
    await Promise.all(devices().map(async (d, i) => {
      try {
        const r = await fetch(base(d) + "/3rdparty/v1/devices", { headers: { Authorization: authHeader(d) }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) return;
        const arr = await r.json();
        const seen = (arr || []).map(x => x.lastSeen).filter(Boolean).sort().pop();
        if (seen) deviceInfo[i] = { lastSeen: seen, name: (arr[0] || {}).name };
      } catch (_) {}
    }));
    checkAlerts(); notify();
  }

  // ── Alert UI: red bar + beep + browser notification (+ optional SMS to admin/owner) ──
  const shown = new Set();
  const snoozed = () => { try { return JSON.parse(localStorage.getItem("sms-alert-snooze") || "{}"); } catch (_) { return {}; } };
  function alertText(a) {
    return a.type === "failing"
      ? `⚠ ${a.label} ke phone se last ${a.streak} SMS fail / atke hue (${a.reason}). Us person ko bolo: phone ON kare, recharge / network / flight mode check kare.`
      : `⚠ ${a.label} (abhi yahi device use ho raha hai) ${a.mins} min se SMS Gate se connect nahi hua — phone band ya internet band ho sakta hai.`;
  }
  function beep() {
    try {
      const c = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.3, 0.6].forEach(t => { const o = c.createOscillator(), g = c.createGain(); o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.15; o.start(c.currentTime + t); o.stop(c.currentTime + t + 0.18); });
    } catch (_) {}
  }
  function renderBar(list) {
    if (typeof document === "undefined" || !document.body) return;
    let bar = document.getElementById("sms-alert-bar");
    if (!list.length) {
      if (bar) { bar.style.display = "none"; document.body.style.paddingTop = ""; }
      document.title = document.title.replace(/^⚠ /, ""); return;
    }
    if (!bar) {
      bar = document.createElement("div"); bar.id = "sms-alert-bar";
      bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;font:600 13px Inter,system-ui,sans-serif;padding:8px 14px;box-shadow:0 4px 16px rgba(0,0,0,.5)";
      document.body.appendChild(bar);
    }
    bar.innerHTML = list.map(a => `<div style="display:flex;gap:10px;align-items:center;justify-content:space-between;margin:2px 0">
        <span>${alertText(a)}</span>
        <span style="white-space:nowrap">
          <a href="sms-log.html" target="_blank" style="color:#fff;text-decoration:underline;margin-right:10px">SMS Log</a>
          <button data-snooze="${a.key}" style="background:rgba(255,255,255,.2);border:0;color:#fff;border-radius:8px;padding:3px 10px;cursor:pointer">Snooze 30 min</button>
        </span></div>`).join("") +
      ((window.Notification && Notification.permission === "default") ? `<div><button id="sms-alert-enable" style="background:none;border:1px solid #fff;color:#fff;border-radius:8px;padding:2px 10px;cursor:pointer;margin-top:4px">🔔 Enable notifications</button></div>` : "");
    bar.style.display = "block"; document.body.style.paddingTop = bar.offsetHeight + "px";
    if (!/^⚠ /.test(document.title)) document.title = "⚠ " + document.title;
    bar.querySelectorAll("[data-snooze]").forEach(b => b.onclick = () => {
      const sn = snoozed(); sn[b.dataset.snooze] = Date.now() + 30 * 60000; localStorage.setItem("sms-alert-snooze", JSON.stringify(sn)); checkAlerts();
    });
    const en = document.getElementById("sms-alert-enable"); if (en) en.onclick = () => Notification.requestPermission().then(checkAlerts);
  }
  async function sendAlertSms(a) {
    const d = devices()[a.idx] || {};
    const jobs = (window.SMS_ALERT_PHONES || []).map(p => ({ phone: p, message: `ALERT: ${a.label} ke phone se SMS nahi ja rahe (${a.reason}). Phone ON / recharge / network check karwao.` }));
    if (d.ownerPhone) jobs.push({ phone: d.ownerPhone, message: `${a.label} ji, aapke phone se attendance SMS nahi ja rahe. Kripya phone ON karein, recharge / network / flight mode check karein.` });
    if (!jobs.length || !sb.configured) return;
    await sleep(Math.random() * 4000);                                   // two open pages should not both send
    const name = "ALERT " + a.label;
    try {
      const r = await sb.req("GET", `sms_log?select=id&source=eq.alert&student_name=eq.${enc(name)}&created_at=gte.${enc(new Date(Date.now() - 3600000).toISOString())}&limit=1`);
      if (r && r.length) return;                                         // already alerted in the last hour
    } catch (_) { return; }
    for (const j of jobs) await send({ name, phone: j.phone, message: j.message, source: "alert", skipDevices: [a.idx] });
  }
  function checkAlerts() {
    const sn = snoozed(), now = Date.now();
    const all = evaluateHealth();      // (lastSeen is NOT used for alerts: it is only refreshed every ~15+ min by the phone)
    const visible = all.filter(a => !(sn[a.key] && sn[a.key] > now));
    const ui = !window.SMS_NO_ALERT_UI;                                  // scan.html (tablet) shows no alerts
    if (ui) renderBar(visible);
    const keys = new Set(all.map(a => a.key));
    for (const k of [...shown]) if (!keys.has(k)) shown.delete(k);       // resolved -> will alert again if it returns
    for (const a of visible) {
      if (shown.has(a.key)) continue;
      shown.add(a.key); if (ui) beep();
      try { if (ui && window.Notification && Notification.permission === "granted") new Notification("⚠ SMS device problem", { body: alertText(a) }); } catch (_) {}
      if (a.type === "failing") sendAlertSms(a).catch(() => {});
    }
  }

  // ── Loading from Supabase ───────────────────────────────────
  async function loadLogs(days = 2) {
    if (!sb.configured) return [];
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = await sb.selectAll("sms_log", `select=*&created_at=gte.${enc(since)}&order=created_at.desc`);
    rows.forEach(remember); notify(); return rows;
  }
  async function refreshUsage() {
    if (!sb.configured) return;
    try {
      const rows = await sb.req("GET", `sms_usage?select=device_index,count&day_key=eq.${istDay()}`);
      const arr = devices().map(() => 0);
      (rows || []).forEach(r => { if (r.device_index < arr.length) arr[r.device_index] = r.count; });
      window.SMS_USAGE = arr;
      if (typeof window.updateSmsUsageDisplay === "function") window.updateSmsUsageDisplay();
      notify();
    } catch (e) { console.warn("[sms_usage]", e.message); }
  }

  window.SmsService = {
    LIMIT, devices, send, resend, refreshStatus, refreshPending, loadLogs, refreshUsage, normalizePhone, istDay,
    latestForAttendance: id => cache.byAtt.get(id) || null,
    isStuck, evaluateHealth, refreshDeviceInfo, deviceInfo: () => deviceInfo, checkAlerts,
    onChange: f => listeners.push(f),
    ingest: remember,
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (!sb.configured) return;
    refreshUsage(); loadLogs(2).then(() => refreshPending());
    setInterval(refreshUsage, 60000);
    setTimeout(refreshDeviceInfo, 3000); setInterval(refreshDeviceInfo, 5 * 60000);
    setInterval(() => { try { checkAlerts(); } catch (_) {} }, 60000);
    setInterval(refreshPending, 90000);
  });
})();
