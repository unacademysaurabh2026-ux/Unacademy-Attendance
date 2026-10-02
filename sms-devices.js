// ============================================================
//  sms-devices.js  -  THE ONLY PLACE to edit SMS gateway devices
//  Order matters: device 1 is used first (100 SMS/day), then 2, 3, 4.
//  Used by index.html, scan.html, manual.html and sms-log.html
// ============================================================
window.SMS_DEVICES = [
  { url: "https://sms-proxy.unacademysaurabh2026.workers.dev/", user: "GGPYS2", pass: "saurabh@unacademy", label: "SAURABH" },
  { url: "https://sms-proxy.unacademysaurabh2026.workers.dev/", user: "XY9PLS", pass: "deepak@unacademy", label: "DEEPAK" },
  { url: "https://sms-proxy.unacademysaurabh2026.workers.dev/", user: "QWJN5I", pass: "puneet@unacademy", label: "PUNEET SIR" },
  { url: "https://sms-proxy.unacademysaurabh2026.workers.dev/", user: "FDRELK", pass: "mukul@unacademy", label: "MUKUL SIR" },
];

// ── Device-problem alerts ────────────────────────────────────
// When a phone keeps failing, a red bar + beep always appears on the open pages.
// OPTIONAL: also send an SMS (through a healthy device) to these numbers, e.g. the admin:
window.SMS_ALERT_PHONES = [];            // example: ["9876543210"]
// OPTIONAL: SMS the phone's owner too -> add  ownerPhone: "9876543210"  inside that device's { ... } above.
 
