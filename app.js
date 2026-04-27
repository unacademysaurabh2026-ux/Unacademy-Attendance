// ============================================================
//  FaceScan Attendance  –  100% Local (localStorage only)
//  UPDATED: Bug fixes + new features
// ============================================================

// ─── Storage Keys ────────────────────────────────────────────
const STORAGE_KEYS = {
  settings:     "face-attendance-settings",
  students:     "face-attendance-students",
  attendance:   "face-attendance-log",
  trash:        "face-attendance-trash",
  unidentified: "face-attendance-unidentified",
};

// ─── Defaults ────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  instituteName:  "FaceScan Attendance",
  deviceLabel:    "Institute Device",
  matchThreshold: 0.42,
  minMatchPercent: 40,   // minimum % required — below this = unidentified
  modelUrl:       "https://cdn.jsdelivr.net/gh/vladmandic/face-api/model/",
};

// ─── Registration constants ───────────────────────────────────
const REG_VIDEO_DURATION_MS   = 3000;
const REG_FRAME_INTERVAL_MS   = 90;
const REG_TARGET_EMBEDDINGS   = 10;
const REG_MIN_EMBEDDINGS      = 3;
const REG_MIN_FACE_FRACTION   = 0.08;
const REG_MAX_FACE_FRACTION   = 0.80;
const REG_LAPLACIAN_THRESHOLD = 60;
const REG_CENTER_TOLERANCE    = 0.35;
const REG_DUP_DISTANCE        = 0.08;
const REG_DETECTION_SCORE_MIN = 0.68;

// ─── Angle definitions ───────────────────────────────────────
const ANGLES = [
  { key: "front", label: "😐 Front Face", icon: "😐", instruction: "Look straight at the camera" },
  { key: "left",  label: "← Left Face",  icon: "←",  instruction: "Slowly turn your head to the LEFT" },
  { key: "right", label: "Right Face →", icon: "→",  instruction: "Slowly turn your head to the RIGHT" },
];

// ─── Live attendance constants ────────────────────────────────
const LIVE_RECOGNITION_INTERVAL_MS  = 400;
const LIVE_REQUIRED_STABLE_MATCHES  = 4;
const LIVE_DYNAMIC_THRESHOLD_BOOST  = 0.06;
const LIVE_BLINK_EYE_DIFF_THRESHOLD = 1.8;
const LIVE_MOVEMENT_LANDMARK_DELTA  = 2.5;
const LIVE_LIVENESS_FRAMES_REQUIRED = 3;
const LIVE_MULTI_FACE_MAX           = 4;

// ─── App State ───────────────────────────────────────────────
const state = {
  settings: { ...DEFAULT_SETTINGS },
  students: [],
  attendances: [],
  trash: [],
  unidentified: [],     // Unidentified scan entries

  currentStream: null,
  currentCameraMode: null,
  facingMode: "user",   // "user" = front, "environment" = back

  registerPhoto: null,
  registerDescriptors: null,
  angleData: { front: null, left: null, right: null },
  currentAngleIndex: 0,
  isUpdateMode: false,

  // Upload-from-photo registration
  uploadedAngleFiles: { front: null, left: null, right: null },

  attendancePhoto: null,
  liveMatches: [],
  selectedAttendanceStudentId: null,
  liveCandidateStudentId: null,
  liveCandidateStableCount: 0,
  liveRecognitionTimerId: null,
  liveRecognitionBusy: false,
  lastLandmarks: null,
  livenessFrameCount: 0,
  blinkDetected: false,
  livenessConfirmed: false,

  overlayCtx: null,
  modelsLoaded: false,
  modalRecord: null,

  regCapturing: false,
  regFrameTimerId: null,
  regCollectedDescriptors: [],
  regCollectedPhotos: [],
  regProgress: 0,

  // Attendance scan UI state
  scanLocked: false,
  scanFullscreen: false,
  scanningActive: false,       // true only after "Scan Now" button pressed
};

const dom = {};

document.addEventListener("DOMContentLoaded", initApp);


// ─── Attendance circle size (original) ───────────────────────
(function patchAttendanceCircleSize() {
  if (document.getElementById("attendance-circle-size")) return;
  const s = document.createElement("style");
  s.id = "attendance-circle-size";
  s.textContent = `
    @media (min-width: 641px) and (max-width: 1024px) {
      #attendance-camera-box {
        width:  min(75vw, 480px) !important;
        height: min(75vw, 480px) !important;
      }
    }
    @media (max-width: 640px) {
      #attendance-camera-box {
        width:  min(88vw, 340px) !important;
        height: min(88vw, 340px) !important;
      }
    }
    :fullscreen #attendance-camera-box,
    :-webkit-full-screen #attendance-camera-box {
      width:  min(85vh, 560px) !important;
      height: min(85vh, 560px) !important;
      aspect-ratio: 1 / 1 !important;
    }

  `;
  document.head.appendChild(s);
})();

// ─── Fullscreen rectangle fix ────────────────────────────────
(function injectFullscreenFix() {
  if (document.getElementById("fullscreen-circle-fix")) return;
  const s = document.createElement("style");
  s.id = "fullscreen-circle-fix";
  s.textContent = `
    :fullscreen #attendance-scan-section,
    :-webkit-full-screen #attendance-scan-section {
      background: #020617 !important;
    }
    :fullscreen #attendance-camera-box,
    :-webkit-full-screen #attendance-camera-box {
      box-shadow: 0 0 0 4px rgba(255,255,255,0.2),
                  0 0 60px rgba(255,255,255,0.55),
                  0 0 100px rgba(255,255,255,0.25) !important;
    }
  `;
  document.head.appendChild(s);
})();


// ─── Init ─────────────────────────────────────────────────────
function initApp() {
  assignDom();
  loadData();
  renderStaticLabels();
  updateClock();
  window.setInterval(updateClock, 1000);
  showSection("home");
  setupOverlayCanvas();
  updateDashboardStats();
  renderStudentsGrid();
  renderAttendanceTable();
  // Init unidentified badge after DOM is ready
  setTimeout(updateUnidentifiedBadge, 0);
  // Init auto-backup scheduler
  initAutoBackup();
}

// ─── DOM assignment ───────────────────────────────────────────
function assignDom() {
  dom.sections        = document.querySelectorAll('[id^="section-"]');
  dom.tabs            = document.querySelectorAll('[id^="tab-"]');
  dom.currentTime     = document.getElementById("current-time");
  dom.instituteLabel  = document.getElementById("institute-label");
  dom.deviceLabel     = document.getElementById("device-label");
  dom.totalStudents   = document.getElementById("total-students");
  dom.todayAttendance = document.getElementById("today-attendance");

  dom.registerForm         = document.getElementById("register-form");
  dom.registerVideo        = document.getElementById("register-video");
  dom.registerCanvas       = document.getElementById("register-canvas");
  dom.registerOverlay      = document.getElementById("register-overlay");
  dom.startRegisterButton  = document.getElementById("start-register-btn");
  dom.registerPreview      = document.getElementById("register-preview");
  dom.registerPhotoPreview = document.getElementById("register-photo-preview");
  dom.registerStatus       = document.getElementById("register-status");
  dom.captureAngleBtn      = document.getElementById("capture-angle-btn");

  dom.attendanceVideo         = document.getElementById("attendance-video");
  dom.attendanceCanvas        = document.getElementById("attendance-canvas");
  dom.startAttendanceButton   = document.getElementById("start-attendance-btn");
  dom.captureAttendanceButton = document.getElementById("capture-attendance-btn");
  dom.attendanceStatus        = document.getElementById("attendance-status");
  dom.recognitionResult       = document.getElementById("recognition-result");
  dom.recognitionTitle        = document.getElementById("recognition-title");
  dom.recognitionCopy         = document.getElementById("recognition-copy");
  dom.studentMatchList        = document.getElementById("student-match-list");

  dom.studentsGrid        = document.getElementById("students-grid");
  dom.attendanceTableBody = document.getElementById("attendance-table-body");
  dom.studentsListView    = document.getElementById("students-list-view");
  dom.attendanceListView  = document.getElementById("attendance-list-view");
  dom.showStudentsButton  = document.getElementById("show-students-btn");
  dom.showAttendanceButton= document.getElementById("show-attendance-btn");

  dom.successModal        = document.getElementById("success-modal");
  dom.modalTitle          = document.getElementById("modal-title");
  dom.modalSubtitle       = document.getElementById("modal-subtitle");
  dom.modalDetails        = document.getElementById("modal-details");
  dom.modalWhatsappButton = document.getElementById("modal-whatsapp-btn");

  injectAttendanceOverlay();
}

function injectAttendanceOverlay() {
  const box = document.getElementById("attendance-camera-box");
  if (!box || document.getElementById("attendance-face-overlay")) return;
  const ov = document.createElement("canvas");
  ov.id = "attendance-face-overlay";
  ov.style.cssText =
    "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;border-radius:inherit;";
  box.appendChild(ov);
  dom.faceOverlay = ov;
}

function setupOverlayCanvas() {
  if (!dom.faceOverlay) return;
  const resizeOv = () => {
    if (!dom.faceOverlay) return;
    dom.faceOverlay.width  = dom.faceOverlay.offsetWidth;
    dom.faceOverlay.height = dom.faceOverlay.offsetHeight;
  };
  resizeOv();
  window.addEventListener("resize", resizeOv);
}

// ─── Data (localStorage only) ─────────────────────────────────
function loadData() {
  const config = typeof window.FACESCAN_CONFIG === "object" ? window.FACESCAN_CONFIG : {};
  const saved  = loadJson(STORAGE_KEYS.settings, {});
  state.settings = { ...DEFAULT_SETTINGS, ...config, ...saved };

  const savedStudents     = loadJson(STORAGE_KEYS.students,     []);
  const savedAttendance   = loadJson(STORAGE_KEYS.attendance,   []);
  const savedTrash        = loadJson(STORAGE_KEYS.trash,        []);
  const savedUnidentified = loadJson(STORAGE_KEYS.unidentified, []);
  state.students      = Array.isArray(savedStudents)     ? savedStudents.map(normalizeStudent).filter(Boolean)     : [];
  state.attendances   = Array.isArray(savedAttendance)   ? savedAttendance.map(normalizeAttendance).filter(Boolean) : [];
  state.trash         = Array.isArray(savedTrash)        ? savedTrash : [];
  state.unidentified  = Array.isArray(savedUnidentified) ? savedUnidentified : [];
}

function saveData() {
  try {
    localStorage.setItem(STORAGE_KEYS.settings,     JSON.stringify(state.settings));
    localStorage.setItem(STORAGE_KEYS.students,     JSON.stringify(state.students));
    localStorage.setItem(STORAGE_KEYS.attendance,   JSON.stringify(state.attendances));
    localStorage.setItem(STORAGE_KEYS.trash,        JSON.stringify(state.trash));
    localStorage.setItem(STORAGE_KEYS.unidentified, JSON.stringify(state.unidentified));
    updateDashboardStats();
    renderStudentsGrid();
    renderAttendanceTable();
  } catch (e) {
    console.error("saveData failed:", e);
    // If quota exceeded, try without scanPhoto
    try {
      const attendanceLight = state.attendances.map(a => ({ ...a, scanPhoto: "" }));
      localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(attendanceLight));
      localStorage.setItem(STORAGE_KEYS.students,   JSON.stringify(state.students));
      updateDashboardStats();
      renderStudentsGrid();
      renderAttendanceTable();
    } catch (e2) {
      console.error("saveData fallback also failed:", e2);
    }
  }
}

// ─── UI helpers ───────────────────────────────────────────────
function renderStaticLabels() {
  dom.instituteLabel.textContent = state.settings.instituteName || "Attendance System";
  dom.deviceLabel.textContent    = state.settings.deviceLabel   || "Institute Device";
}

function updateDashboardStats() {
  dom.totalStudents.textContent = String(state.students.length);
  const todayKey   = getLocalDateKey(new Date());
  const todayCount = state.attendances.filter(e => e.dateKey === todayKey).length;
  dom.todayAttendance.innerHTML =
    `${todayCount}<span class="text-base ml-2 font-medium">/${state.students.length}</span>`;
}

function updateClock() {
  dom.currentTime.textContent = new Date().toLocaleTimeString("en-IN", {
    hour: "2-digit", minute: "2-digit",
  });
}

function showSection(section) {
  if (state.scanLocked && section !== "attendance") {
    return; // locked — can't navigate away
  }
  dom.sections.forEach(el => el.classList.add("hidden"));
  document.getElementById(`section-${section}`)?.classList.remove("hidden");
  dom.tabs.forEach(t => t.classList.remove("nav-active"));
  document.getElementById(`tab-${section}`)?.classList.add("nav-active");

  if (section === "attendance") {
    if (!state.students.length) {
      dom.attendanceStatus.textContent = "Register at least one student before attendance scan.";
    } else if (state.currentCameraMode !== "attendance") {
      void startAttendanceCamera();
    }
  } else {
    stopCamera();
    if (section !== "register") resetRegisterCaptureUi();
    if (section !== "attendance") resetAttendanceCaptureUi();
  }
  if (section === "records") showStudentsList();
  if (section === "trash")   renderTrash();
  if (section === "unidentified") renderUnidentifiedList();
}

// ─── Camera core ──────────────────────────────────────────────
async function startCamera(videoElement, mode, facing) {
  stopCamera();
  if (!window.isSecureContext) {
    alert("Camera access requires HTTPS or localhost.");
    return false;
  }
  const facingMode = facing || state.facingMode || "user";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    state.currentStream     = stream;
    state.currentCameraMode = mode;
    state.facingMode        = facingMode;
    videoElement.srcObject  = stream;
    await videoElement.play();
    return true;
  } catch (err) {
    let message = "Camera access failed. ";
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      message += "Permission was denied. Please allow camera access in your browser settings and reload.";
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      message += "No camera found on this device.";
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      message += "Camera is already in use by another application. Close it and try again.";
    } else if (err.name === "OverconstrainedError") {
      // Retry without facingMode constraint
      try {
        const stream2 = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        state.currentStream     = stream2;
        state.currentCameraMode = mode;
        videoElement.srcObject  = stream2;
        await videoElement.play();
        return true;
      } catch (e2) {
        message += "Camera does not support the required resolution.";
      }
    } else {
      message += err.message || "Unknown error.";
    }
    console.error("Camera error:", err.name, err.message);
    alert(message);
    return false;
  }
}

function stopCamera() {
  if (state.regFrameTimerId) {
    clearInterval(state.regFrameTimerId);
    state.regFrameTimerId = null;
  }
  state.regCapturing = false;
  if (state.currentStream) {
    state.currentStream.getTracks().forEach(t => t.stop());
  }
  if (state.liveRecognitionTimerId) {
    clearInterval(state.liveRecognitionTimerId);
    state.liveRecognitionTimerId = null;
  }
  if (_facePreviewTimerId) {
    clearInterval(_facePreviewTimerId);
    _facePreviewTimerId = null;
  }
  state.scanningActive             = false;
  state.currentStream             = null;
  state.currentCameraMode         = null;
  state.liveCandidateStudentId    = null;
  state.liveCandidateStableCount  = 0;
  state.liveRecognitionBusy       = false;
  state.lastLandmarks             = null;
  state.livenessFrameCount        = 0;
  state.blinkDetected             = false;
  state.livenessConfirmed         = false;
  if (dom.registerVideo)   dom.registerVideo.srcObject   = null;
  if (dom.attendanceVideo) dom.attendanceVideo.srcObject = null;
  unfreezeVideoFrame();
  clearOverlayCanvas();
  hideScanNowButton();
  syncAttendanceControls(false);
}

// ─── CAMERA FLIP (front/back toggle) ─────────────────────────
async function flipCamera() {
  const newFacing = state.facingMode === "user" ? "environment" : "user";
  state.facingMode = newFacing;
  if (state.currentCameraMode === "attendance") {
    await startAttendanceCamera();
  } else if (state.currentCameraMode === "register") {
    await startCamera(dom.registerVideo, "register", newFacing);
  }
}

// ─── FULLSCREEN ───────────────────────────────────────────────
function toggleFullscreen() {
  const el = document.getElementById("attendance-scan-section") || document.documentElement;
  if (!document.fullscreenElement) {
    el.requestFullscreen?.() || el.webkitRequestFullscreen?.();
    state.scanFullscreen = true;
  } else {
    document.exitFullscreen?.() || document.webkitExitFullscreen?.();
    state.scanFullscreen = false;
  }
}

// ─── SCAN LOCK ────────────────────────────────────────────────
function toggleScanLock() {
  state.scanLocked = !state.scanLocked;
  const btn = document.getElementById("scan-lock-btn");
  const nav  = document.querySelector(".main-nav");
  if (btn) {
    btn.innerHTML = state.scanLocked ? "🔒" : "🔓";
    btn.title     = state.scanLocked ? "Locked – tap to unlock" : "Tap to lock navigation";
    btn.classList.toggle("bg-red-500/20", state.scanLocked);
    btn.classList.toggle("text-red-400",  state.scanLocked);
  }
  // Hide/show nav tabs when locked
  if (nav) nav.style.pointerEvents = state.scanLocked ? "none" : "";
}

// ─── DUPLICATE CHECK ──────────────────────────────────────────
function checkExistingStudent() {
  const roll      = document.getElementById("roll")?.value.trim();
  const className = document.getElementById("class")?.value.trim();
  const banner    = document.getElementById("already-registered-banner");
  const text      = document.getElementById("already-registered-text");
  const submitBtn = document.getElementById("register-submit-btn");
  if (!roll || !className || !banner) return;
  const studentId = buildStudentId(className, roll);
  const existing  = state.students.find(s => s.id === studentId);
  if (existing && !state.isUpdateMode) {
    banner.classList.remove("hidden");
    if (text) text.textContent =
      `${existing.name} (Roll: ${existing.roll}, ${existing.class}) is already registered on ${formatDate(existing.registeredOn)}.`;
    if (submitBtn) submitBtn.disabled = true;
  } else {
    banner.classList.add("hidden");
    if (submitBtn) submitBtn.disabled = false;
  }
}

function proceedAsUpdate() {
  state.isUpdateMode = true;
  const banner = document.getElementById("already-registered-banner");
  if (banner) banner.classList.add("hidden");
  const submitBtn = document.getElementById("register-submit-btn");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "✏️ Update Student";
  }
  dom.registerStatus.textContent = "Update mode: Re-capture face and save to update this student.";
}

function cancelDuplicateRegistration() {
  state.isUpdateMode = false;
  const banner = document.getElementById("already-registered-banner");
  if (banner) banner.classList.add("hidden");
  dom.registerForm.reset();
  resetAllAngles();
  stopCamera();
  dom.registerOverlay.classList.remove("hidden");
  dom.startRegisterButton.classList.remove("hidden");
}

// ─── MULTI-ANGLE REGISTRATION ─────────────────────────────────
function startRegisterCamera() {
  startCamera(dom.registerVideo, "register").then(started => {
    if (!started) return;
    dom.registerOverlay.classList.add("hidden");
    dom.startRegisterButton.classList.add("hidden");
    updateAngleUI();
    dom.registerStatus.textContent = "Camera ready. Capture each angle one by one.";
  });
}

function updateAngleUI() {
  const idx   = state.currentAngleIndex;
  const angle = ANGLES[idx];
  const pills = document.querySelectorAll(".angle-step-pill");
  pills.forEach((pill, i) => {
    pill.classList.remove(
      "border-sky-500", "bg-sky-500/10", "text-sky-300",
      "border-emerald-500", "bg-emerald-500/10", "text-emerald-300",
      "border-slate-600", "text-slate-500"
    );
    if (i < idx) {
      pill.classList.add("border-emerald-500", "bg-emerald-500/10", "text-emerald-300");
      pill.textContent = ANGLES[i].label.replace(ANGLES[i].icon, "✓");
    } else if (i === idx) {
      pill.classList.add("border-sky-500", "bg-sky-500/10", "text-sky-300");
      pill.textContent = ANGLES[i].label;
    } else {
      pill.classList.add("border-slate-600", "text-slate-500");
      pill.textContent = ANGLES[i].label;
    }
  });
  const instrEl = document.getElementById("angle-instruction");
  if (instrEl) {
    instrEl.textContent = idx < ANGLES.length
      ? `Step ${idx + 1} of 3: ${angle.instruction}`
      : "All angles captured! Fill in details and register.";
  }
  if (dom.captureAngleBtn) {
    if (idx < ANGLES.length) {
      dom.captureAngleBtn.textContent = `📸 Capture ${angle.label}`;
      dom.captureAngleBtn.disabled = false;
    } else {
      dom.captureAngleBtn.textContent = "✅ All Angles Captured";
      dom.captureAngleBtn.disabled = true;
    }
  }
}

async function captureCurrentAngle() {
  if (!dom.registerVideo.srcObject) {
    alert("Please start camera first.");
    return;
  }
  const idx = state.currentAngleIndex;
  if (idx >= ANGLES.length) return;
  const angle = ANGLES[idx];
  dom.registerStatus.textContent = `Scanning ${angle.label}… Hold steady.`;
  if (dom.captureAngleBtn) dom.captureAngleBtn.disabled = true;
  try {
    await ensureModels();
    const { descriptors, bestFrameUrl } = await captureAngleVideo(dom.registerVideo, dom.registerCanvas, angle);
    if (!descriptors || descriptors.length < REG_MIN_EMBEDDINGS) {
      dom.registerStatus.textContent =
        `Only ${descriptors?.length ?? 0} quality frames for ${angle.label} (need ${REG_MIN_EMBEDDINGS}+). Try again.`;
      if (dom.captureAngleBtn) dom.captureAngleBtn.disabled = false;
      return;
    }
    state.angleData[angle.key] = { descriptors, photo: bestFrameUrl };
    const thumb = document.getElementById(`thumb-${angle.key}`);
    if (thumb) {
      thumb.innerHTML = `<img src="${bestFrameUrl}" class="w-full h-full object-cover rounded-2xl" alt="${angle.key}">`;
      thumb.style.borderColor = "#10b981";
      thumb.style.borderStyle = "solid";
    }
    dom.registerStatus.textContent =
      `✅ ${angle.label} captured (${descriptors.length} frames).` +
      (idx + 1 < ANGLES.length ? ` Now capture ${ANGLES[idx + 1].label}.` : " All angles done!");
    state.currentAngleIndex += 1;
    updateAngleUI();
    if (state.currentAngleIndex >= ANGLES.length) {
      mergeAngleDescriptors();
    }
  } catch (err) {
    dom.registerStatus.textContent = err.message;
    if (dom.captureAngleBtn) dom.captureAngleBtn.disabled = false;
  }
}

function mergeAngleDescriptors() {
  const all = [];
  for (const angle of ANGLES) {
    const d = state.angleData[angle.key];
    if (d?.descriptors?.length) all.push(...d.descriptors);
  }
  state.registerDescriptors = all;
  state.registerPhoto = state.angleData.front?.photo || state.angleData.left?.photo || state.angleData.right?.photo;
  if (state.registerPhoto) {
    dom.registerPhotoPreview.src = state.registerPhoto;
    dom.registerPreview.classList.remove("hidden");
  }
  dom.registerStatus.textContent =
    `✅ All 3 angles captured (${all.length} total face samples). Fill details and register.`;
}

async function captureAngleVideo(videoElement, canvasElement) {
  const collected = [];
  const photos    = [];
  const startTime = Date.now();
  return new Promise((resolve) => {
    state.regCapturing = true;
    state.regFrameTimerId = setInterval(async () => {
      const elapsed = Date.now() - startTime;
      if (elapsed >= REG_VIDEO_DURATION_MS || collected.length >= REG_TARGET_EMBEDDINGS || !state.regCapturing) {
        clearInterval(state.regFrameTimerId);
        state.regFrameTimerId = null;
        state.regCapturing = false;
        const final = storeMultipleEmbeddings(collected);
        resolve({ descriptors: final, bestFrameUrl: photos[0] || captureFrameAsDataUrl(videoElement, canvasElement) });
        return;
      }
      const result = await extractBestFrame(videoElement, canvasElement);
      if (result) {
        const { descriptor, dataUrl } = result;
        if (!isDuplicateDescriptor(descriptor, collected)) {
          collected.push(descriptor);
          if (photos.length < 2) photos.push(dataUrl);
        }
      }
    }, REG_FRAME_INTERVAL_MS);
  });
}

async function captureRegisterPhoto() {
  await captureCurrentAngle();
}

function resetAllAngles() {
  state.currentAngleIndex  = 0;
  state.angleData          = { front: null, left: null, right: null };
  state.registerDescriptors= null;
  state.registerPhoto      = null;
  state.regCollectedDescriptors = [];
  state.regCollectedPhotos = [];
  state.isUpdateMode       = false;
  state.uploadedAngleFiles = { front: null, left: null, right: null };
  for (const angle of ANGLES) {
    const thumb = document.getElementById(`thumb-${angle.key}`);
    if (thumb) {
      thumb.innerHTML = `<span style="font-size:1.5rem;color:#475569;">${angle.icon}</span>`;
      thumb.style.borderColor = "";
      thumb.style.borderStyle = "dashed";
    }
  }
  // Reset upload previews
  for (const key of ["front","left","right"]) {
    const up = document.getElementById(`upload-preview-${key}`);
    if (up) up.innerHTML = `<span class="text-2xl">${key === "front" ? "😐" : key === "left" ? "←" : "→"}</span><span class="text-xs text-slate-500 mt-1">Tap to upload</span>`;
  }
  const instrEl = document.getElementById("angle-instruction");
  if (instrEl) instrEl.textContent = "Start camera, then capture each angle one by one.";
  dom.registerPreview.classList.add("hidden");
  dom.registerPhotoPreview.removeAttribute("src");
  const submitBtn = document.getElementById("register-submit-btn");
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = "✅ Register Student";
  }
  updateAngleUI();
  dom.registerStatus.textContent = "Angles reset. Start camera and capture again.";
}

function retakeRegisterPhoto() {
  resetAllAngles();
}

// ─── UPLOAD FROM PHOTO (Register without live camera) ─────────
function triggerPhotoUpload(angleKey) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const dataUrl = await fileToDataUrl(file);
    await processUploadedAngleImage(angleKey, dataUrl);
  };
  input.click();
}

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

async function processUploadedAngleImage(angleKey, dataUrl) {
  dom.registerStatus.textContent = `Processing ${angleKey} image… please wait.`;
  try {
    await ensureModels();
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    const cvs = dom.registerCanvas;
    cvs.width  = img.width;
    cvs.height = img.height;
    const ctx  = cvs.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const _faceapi = typeof faceapi !== "undefined" ? faceapi : window.faceapi;
    const detection = await _faceapi
      .detectSingleFace(img, new _faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!detection) {
      dom.registerStatus.textContent = `No face detected in ${angleKey} image. Please try a clearer photo.`;
      return;
    }
    const descriptor = Array.from(detection.descriptor);
    state.angleData[angleKey] = { descriptors: [descriptor], photo: dataUrl };
    state.uploadedAngleFiles[angleKey] = dataUrl;
    // Update thumbnail
    const thumb = document.getElementById(`thumb-${angleKey}`);
    if (thumb) {
      thumb.innerHTML = `<img src="${dataUrl}" class="w-full h-full object-cover rounded-2xl" alt="${angleKey}">`;
      thumb.style.borderColor = "#10b981";
      thumb.style.borderStyle = "solid";
    }
    // Update upload preview
    const up = document.getElementById(`upload-preview-${angleKey}`);
    if (up) up.innerHTML = `<img src="${dataUrl}" class="w-full h-full object-cover rounded-xl" alt="${angleKey}">`;
    // Check if all done
    const capturedCount = ANGLES.filter(a => state.angleData[a.key]?.descriptors?.length).length;
    dom.registerStatus.textContent = `✅ ${angleKey} photo processed (${capturedCount}/3 angles ready).`;
    if (capturedCount >= 1) {
      // Merge what we have
      const all = [];
      for (const a of ANGLES) {
        if (state.angleData[a.key]?.descriptors) all.push(...state.angleData[a.key].descriptors);
      }
      state.registerDescriptors = all;
      state.registerPhoto = state.angleData.front?.photo || state.angleData.left?.photo || state.angleData.right?.photo;
    }
  } catch (err) {
    dom.registerStatus.textContent = `Error processing ${angleKey} image: ${err.message}`;
  }
}

// ─── Blur detection ───────────────────────────────────────────
function computeLaplacianVariance(ctx, box, vw, vh) {
  try {
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const w = Math.min(vw - x, Math.round(box.width));
    const h = Math.min(vh - y, Math.round(box.height));
    if (w < 20 || h < 20) return 0;
    const imageData = ctx.getImageData(x, y, w, h);
    const d = imageData.data;
    const gray = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }
    let sumSq = 0, count = 0;
    for (let row = 1; row < h - 1; row++) {
      for (let col = 1; col < w - 1; col++) {
        const lap =
          -gray[(row - 1) * w + col] - gray[(row + 1) * w + col] -
          gray[row * w + (col - 1)] - gray[row * w + (col + 1)] +
          4 * gray[row * w + col];
        sumSq += lap * lap;
        count++;
      }
    }
    return count > 0 ? sumSq / count : 0;
  } catch { return 999; }
}

async function extractBestFrame(videoElement, canvasElement) {
  const vw = videoElement.videoWidth  || 640;
  const vh = videoElement.videoHeight || 480;
  canvasElement.width  = vw;
  canvasElement.height = vh;
  const ctx = canvasElement.getContext("2d");
  ctx.drawImage(videoElement, 0, 0, vw, vh);
  const _faceapi = typeof faceapi !== "undefined" ? faceapi : window.faceapi;
  const detection = await _faceapi
    .detectSingleFace(videoElement, new _faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: REG_DETECTION_SCORE_MIN,
    }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return null;
  if ((detection.detection?.score ?? 0) < REG_DETECTION_SCORE_MIN) return null;
  const box      = detection.detection.box;
  const faceArea  = box.width * box.height;
  const frameArea = vw * vh;
  const faceFrac  = faceArea / frameArea;
  if (faceFrac < REG_MIN_FACE_FRACTION || faceFrac > REG_MAX_FACE_FRACTION) return null;
  const faceCenterX = (box.x + box.width  / 2) / vw;
  const faceCenterY = (box.y + box.height / 2) / vh;
  if (Math.abs(faceCenterX - 0.5) > REG_CENTER_TOLERANCE ||
      Math.abs(faceCenterY - 0.5) > REG_CENTER_TOLERANCE + 0.1) return null;
  const sharpness = computeLaplacianVariance(ctx, box, vw, vh);
  if (sharpness < REG_LAPLACIAN_THRESHOLD) return null;
  const descriptor = Array.from(detection.descriptor);
  const dataUrl    = canvasElement.toDataURL("image/jpeg", 0.82);
  return { descriptor, dataUrl };
}

function isDuplicateDescriptor(newDesc, existing, threshold = REG_DUP_DISTANCE) {
  for (const e of existing) {
    if (descriptorDistance(newDesc, e) < threshold) return true;
  }
  return false;
}

function storeMultipleEmbeddings(descriptors) {
  if (!descriptors || !descriptors.length) return null;
  const final = [];
  for (const d of descriptors) {
    if (!isDuplicateDescriptor(d, final, 0.06)) final.push(d);
    if (final.length >= REG_TARGET_EMBEDDINGS) break;
  }
  return final;
}

// ─── Register student save ────────────────────────────────────
async function registerStudent(event) {
  event.preventDefault();
  const hasMinAngles =
    (state.angleData.front?.descriptors?.length >= 1) ||
    (state.registerDescriptors?.length >= REG_MIN_EMBEDDINGS);
  if (!hasMinAngles) {
    alert("Please capture at least the Front face angle (or upload a front photo) before registering.");
    return;
  }
  const name         = document.getElementById("name").value.trim();
  const roll         = document.getElementById("roll").value.trim();
  const className    = document.getElementById("class").value.trim();
  const studentPhone = document.getElementById("student-phone").value.trim();
  const parentPhone  = document.getElementById("parent-phone").value.trim();
  if (!name || !roll || !className || !parentPhone) {
    alert("Please complete all required student details.");
    return;
  }
  const allDescriptors = [];
  for (const angle of ANGLES) {
    const d = state.angleData[angle.key];
    if (d?.descriptors?.length) allDescriptors.push(...d.descriptors);
  }
  if (!allDescriptors.length && state.registerDescriptors?.length) {
    allDescriptors.push(...state.registerDescriptors);
  }
  const bestPhoto = state.registerPhoto ||
    state.angleData.front?.photo ||
    state.angleData.left?.photo ||
    state.angleData.right?.photo;

  if (bestPhoto) {
    autoDownloadPhoto(bestPhoto, roll, name);
  }

  const studentId    = buildStudentId(className, roll);
  const existingStudent = state.students.find(s => s.id === studentId);

  const student = {
    id: studentId,
    name,
    roll,
    class: className,
    studentPhone,
    parentPhone,
    facePhoto: "",
    descriptors: allDescriptors,
    descriptor: averageDescriptors(allDescriptors),
    embeddingCount: allDescriptors.length,
    angleData: {
      front: state.angleData.front ? { count: state.angleData.front.descriptors?.length || 0 } : null,
      left:  state.angleData.left  ? { count: state.angleData.left.descriptors?.length  || 0 } : null,
      right: state.angleData.right ? { count: state.angleData.right.descriptors?.length || 0 } : null,
    },
    registeredOn: existingStudent?.registeredOn || new Date().toISOString(),
    updatedOn: new Date().toISOString(),
  };
  const idx = state.students.findIndex(e => e.id === studentId);
  if (idx === -1) state.students.unshift(student);
  else state.students[idx] = student;
  const submittedAngles = Object.values(state.angleData).filter(Boolean).length;

  // ── FIX #1: Save first, THEN reset UI ────────────────────────
  saveData();

  // Reset form and UI after saving
  dom.registerForm.reset();
  resetAllAngles();
  stopCamera();
  dom.registerOverlay.classList.remove("hidden");
  dom.startRegisterButton.classList.remove("hidden");
  state.isUpdateMode = false;
  dom.registerStatus.textContent =
    `${student.name} registered with ${student.embeddingCount} face embeddings (${submittedAngles}/3 angles).`;
  alert(`${student.name} registered successfully!`);
  showSection("records");
  showStudentsList();
}

// ─── ATTENDANCE SCANNING ──────────────────────────────────────
async function startAttendanceCamera() {
  if (!state.students.length) {
    dom.attendanceStatus.textContent = "Register at least one student before attendance scan.";
    return;
  }
  const started = await startCamera(dom.attendanceVideo, "attendance");
  if (!started) return;

  // Reset scanning state
  state.scanningActive = false;
  state._unknownFaceFirstSeenAt = null;
  state._unknownFaceCaptured    = false;

  dom.recognitionResult.classList.remove("hidden");
  dom.recognitionTitle.textContent = "Loading face recognition…";
  dom.recognitionCopy.textContent  = "Please wait while models load.";
  dom.studentMatchList.innerHTML   = '<div class="text-center text-slate-400 py-8">Preparing…</div>';

  try {
    await ensureModels();
    if (dom.faceOverlay) {
      dom.faceOverlay.width  = dom.faceOverlay.offsetWidth;
      dom.faceOverlay.height = dom.faceOverlay.offsetHeight;
    }
    // Camera is live — show Scan Now button, hide Start Camera button
    showScanNowButton();
    dom.attendanceStatus.textContent = "Camera ready. Press 'Scan Now' to start identification.";
    dom.recognitionTitle.textContent = "Ready";
    dom.recognitionCopy.textContent  = "Press Scan Now to identify a student.";
    // Start a lightweight face-box-only loop (no matching, just overlay drawing)
    beginFacePreviewLoop();
  } catch (err) {
    dom.attendanceStatus.textContent = err.message;
    alert(err.message);
    stopCamera();
    resetAttendanceCaptureUi();
  }
}

// Lightweight loop — just draws face boxes, no matching
let _facePreviewTimerId = null;
async function beginFacePreviewLoop() {
  if (_facePreviewTimerId) clearInterval(_facePreviewTimerId);
  _facePreviewTimerId = setInterval(async () => {
    if (state.scanningActive) return; // handed off to full recognition
    if (state.currentCameraMode !== "attendance" || !dom.attendanceVideo.srcObject) return;
    try {
      const _faceapi = typeof faceapi !== "undefined" ? faceapi : window.faceapi;
      const detections = await _faceapi
        .detectAllFaces(dom.attendanceVideo,
          new _faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 }))
        .withFaceLandmarks();
      clearOverlayCanvas();
      if (detections && detections.length > 0) {
        drawFaceBoxes(detections);
        const nameStrip = document.getElementById("scan-name-strip");
        if (nameStrip) {
          nameStrip.textContent = "👤 Face detected — press Scan Now";
          nameStrip.style.background = "rgba(14,165,233,0.5)";
        }
      } else {
        const nameStrip = document.getElementById("scan-name-strip");
        if (nameStrip) {
          nameStrip.textContent = "";
          nameStrip.style.background = "transparent";
        }
      }
    } catch (_) {}
  }, 500);
}

// ─── Freeze a video frame onto an overlay canvas ─────────────
function freezeVideoFrame(videoEl) {
  // Use a dedicated full-size freeze canvas layered over the video
  let fc = document.getElementById("freeze-frame-canvas");
  if (!fc) {
    fc = document.createElement("canvas");
    fc.id = "freeze-frame-canvas";
    fc.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;" +
      "object-fit:cover;border-radius:inherit;z-index:5;";
    const box = document.getElementById("attendance-camera-box");
    if (box) box.appendChild(fc);
  }
  fc.width  = videoEl.videoWidth  || 640;
  fc.height = videoEl.videoHeight || 480;
  fc.getContext("2d").drawImage(videoEl, 0, 0, fc.width, fc.height);
  fc.style.display = "block";
  return fc;
}

function unfreezeVideoFrame() {
  const fc = document.getElementById("freeze-frame-canvas");
  if (fc) fc.style.display = "none";
}

// ─── Single-shot recognition on frozen frame ─────────────────
async function runFrozenFrameRecognition(frozenCanvas) {
  state.scanningActive          = true;
  state._unknownFaceFirstSeenAt = null;
  state._unknownFaceCaptured    = false;

  try {
    const _faceapi = typeof faceapi !== "undefined" ? faceapi : window.faceapi;
    // Run detection on the frozen canvas (not the live video)
    const detections = await _faceapi
      .detectAllFaces(
        frozenCanvas,
        new _faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (!detections || detections.length === 0) {
      dom.attendanceStatus.textContent = "No face detected. Please try again.";
      playSound("unknown");
      unfreezeVideoFrame();
      state.scanningActive = false;
      setTimeout(resetToScanReady, 800);
      return;
    }

    // Use the largest / primary face
    const faces = detections
      .slice(0, LIVE_MULTI_FACE_MAX)
      .sort((a, b) =>
        b.detection.box.width * b.detection.box.height -
        a.detection.box.width * a.detection.box.height
      );
    const primaryFace  = faces[0];
    const detScore     = primaryFace.detection.score ?? 0.8;
    const dynThreshold = Number(state.settings.matchThreshold) +
      (detScore < 0.7 ? LIVE_DYNAMIC_THRESHOLD_BOOST : 0);
    const descriptor   = Array.from(primaryFace.descriptor);
    const matches      = rankStudentsByMultiEmbedding(descriptor, dynThreshold).slice(0, 5);

    if (!matches.length) {
      dom.attendanceStatus.textContent = "No registered students found.";
      playSound("unknown");
      unfreezeVideoFrame();
      state.scanningActive = false;
      setTimeout(resetToScanReady, 800);
      return;
    }

    const bestMatch      = matches[0];
    const confidentMatch = isSelectableMatch(bestMatch, dynThreshold);

    if (!confidentMatch) {
      // ── Unidentified face ─────────────────────────────────
      playSound("unknown");
      dom.attendanceStatus.textContent =
        "Unregistered or unclear face. Closest: " +
        (bestMatch.student?.name || "unknown") +
        ` (${Math.round(distanceToPercent(bestMatch.distance))}% match)`;
      // Save unidentified entry
      const capturedAt   = new Date().toISOString();
      const imageDataUrl = frozenCanvas.toDataURL("image/jpeg", 0.85);
      saveUnidentifiedEntry(imageDataUrl, capturedAt);
      unfreezeVideoFrame();
      state.scanningActive = false;
      setTimeout(resetToScanReady, 1200);
      return;
    }

    // ── Minimum % guard ──────────────────────────────────────────
    const minPct = Number(state.settings.minMatchPercent ?? 40);
    const matchPctCheck = bestMatch.distance !== null
      ? Math.round(distanceToPercent(bestMatch.distance)) : 0;
    if (matchPctCheck < minPct) {
      playSound("unknown");
      dom.attendanceStatus.textContent =
        `Match too low (${matchPctCheck}% < ${minPct}% min). Closest: ${bestMatch.student?.name || "unknown"}`;
      const capturedAt   = new Date().toISOString();
      const imageDataUrl = frozenCanvas.toDataURL("image/jpeg", 0.85);
      saveUnidentifiedEntry(imageDataUrl, capturedAt);
      unfreezeVideoFrame();
      state.scanningActive = false;
      setTimeout(resetToScanReady, 1200);
      return;
    }

    // ── Confident match → auto-save ───────────────────────────
    const now      = new Date();
    const dateKey  = getLocalDateKey(now);
    const matchInfo = matches.find(m => m.student.id === bestMatch.student.id) || bestMatch;
    const matchPct  = matchInfo.distance !== null
      ? Math.round(distanceToPercent(matchInfo.distance)) : null;

    const record = {
      id:           `ATT-${Date.now()}`,
      studentId:    bestMatch.student.id,
      name:         bestMatch.student.name,
      roll:         bestMatch.student.roll,
      class:        bestMatch.student.class,
      studentPhone: bestMatch.student.studentPhone,
      parentPhone:  bestMatch.student.parentPhone,
      dateKey,
      date:         dateKey,
      timestamp:    now.toISOString(),
      dateLabel:    formatDate(now),
      timeLabel:    formatTime(now),
      formattedTime:formatDateTime(now),
      scanPhoto:    "",
      matchDistance: matchInfo.distance != null && isFinite(matchInfo.distance)
        ? Number(matchInfo.distance.toFixed(4)) : null,
      matchPercent:  matchPct,
      syncState:    "local-only",
      waSent:       false,
    };

    state.attendances.unshift(record);
    saveData();
    playSound("match");

    // Show name strip on frozen frame immediately
    const nameStrip = document.getElementById("scan-name-strip");
    if (nameStrip) {
      nameStrip.textContent = `✅ ${record.name}`;
      nameStrip.style.background = "linear-gradient(90deg,#059669,#0ea5e9)";
    }

    // Show toast, then unfreeze and reset
    showQuickToast(record);

    // Reset state
    state.attendancePhoto             = null;
    state.selectedAttendanceStudentId = null;
    state._pendingAttendanceRecord    = null;
    state.livenessFrameCount          = 0;
    state.blinkDetected               = false;
    state.livenessConfirmed           = false;
    state.lastLandmarks               = null;
    state._lastConfirmedStudentId     = null;

    setTimeout(() => {
      unfreezeVideoFrame();
      state.scanningActive = false;
      resetToScanReady();
    }, 950);

  } catch (err) {
    dom.attendanceStatus.textContent = err.message || "Recognition error.";
    unfreezeVideoFrame();
    state.scanningActive = false;
    setTimeout(resetToScanReady, 800);
  }
}

// Called when user presses "Scan Now" green button
async function activateScan() {
  if (state.currentCameraMode !== "attendance" || !dom.attendanceVideo.srcObject) {
    dom.attendanceStatus.textContent = "Camera not ready. Please wait.";
    return;
  }
  // Stop preview loop
  if (_facePreviewTimerId) { clearInterval(_facePreviewTimerId); _facePreviewTimerId = null; }
  hideScanNowButton();

  // ── Freeze the frame instantly on button press ───────────────
  const frozenCanvas = freezeVideoFrame(dom.attendanceVideo);
  dom.attendanceStatus.textContent = "Identifying…";

  // ── Run recognition on the frozen frame (single shot) ────────
  await runFrozenFrameRecognition(frozenCanvas);
}

function showScanNowButton() {
  dom.startAttendanceButton.classList.add("hidden");
  dom.captureAttendanceButton.classList.add("hidden");
  let btn = document.getElementById("scan-now-btn");
  if (!btn) {
    btn = document.createElement("button");
    btn.id        = "scan-now-btn";
    btn.type      = "button";
    btn.innerHTML = "🔍 Scan Now";
    btn.className =
      "flex-1 bg-emerald-500 hover:bg-emerald-400 active:scale-95 text-white py-4 " +
      "rounded-3xl text-xl font-bold flex items-center justify-center gap-x-2 transition-all w-full";
    btn.onclick = activateScan;
    dom.captureAttendanceButton.parentElement.appendChild(btn);
  }
  btn.style.display = "flex";
}

function hideScanNowButton() {
  const btn = document.getElementById("scan-now-btn");
  if (btn) btn.style.display = "none";
}

function resetToScanReady() {
  // After a scan (success or fail), go back to "Scan Now" state
  state.scanningActive = false;
  if (state.liveRecognitionTimerId) {
    clearInterval(state.liveRecognitionTimerId);
    state.liveRecognitionTimerId = null;
  }
  unfreezeVideoFrame();
  resetLiveRecognitionSelection();
  showScanNowButton();
  clearOverlayCanvas();
  const nameStrip = document.getElementById("scan-name-strip");
  if (nameStrip) { nameStrip.textContent = ""; nameStrip.style.background = "transparent"; }
  dom.attendanceStatus.textContent = "Ready. Press 'Scan Now' for next student.";
  dom.recognitionTitle.textContent = "Ready";
  dom.recognitionCopy.textContent  = "Press Scan Now to identify a student.";
  beginFacePreviewLoop();
}



function syncAttendanceControls(cameraStarted) {
  // Only toggle Start Camera ↔ Confirm buttons
  // scan-now-btn is managed separately by showScanNowButton/hideScanNowButton
  dom.startAttendanceButton.classList.toggle("hidden", cameraStarted);
  dom.captureAttendanceButton.classList.toggle("hidden", !cameraStarted);
}

function setAttendanceConfirmState(enabled, label) {
  dom.captureAttendanceButton.disabled = !enabled;
  dom.captureAttendanceButton.classList.toggle("opacity-60",         !enabled);
  dom.captureAttendanceButton.classList.toggle("cursor-not-allowed", !enabled);
  dom.captureAttendanceButton.innerHTML = label || "✅ Confirm &amp; Save Attendance";
  syncAttendanceControls(true);
}

function beginLiveRecognition() {
  if (state.liveRecognitionTimerId) clearInterval(state.liveRecognitionTimerId);
  state.liveRecognitionTimerId = setInterval(() => void runLiveRecognition(), LIVE_RECOGNITION_INTERVAL_MS);
  void runLiveRecognition();
}

async function runLiveRecognition() {
  if (
    state.liveRecognitionBusy ||
    !state.scanningActive ||                    // ← only run when user pressed Scan Now
    state.currentCameraMode !== "attendance" ||
    !dom.attendanceVideo.srcObject
  ) return;
  state.liveRecognitionBusy = true;
  try {
    const _faceapi = typeof faceapi !== "undefined" ? faceapi : window.faceapi;
    const detections = await _faceapi
      .detectAllFaces(
        dom.attendanceVideo,
        new _faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }),
      )
      .withFaceLandmarks()
      .withFaceDescriptors();
    clearOverlayCanvas();
    if (!detections || detections.length === 0) {
      state.liveMatches = [];
      state._unknownFaceFirstSeenAt = null;
      state._unknownFaceCaptured    = false;
      resetLiveRecognitionSelection();
      renderMatchList([]);
      dom.attendanceStatus.textContent = "Looking for a face. Ask student to face the camera.";
      return;
    }
    const faces = detections
      .slice(0, LIVE_MULTI_FACE_MAX)
      .sort((a, b) =>
        b.detection.box.width * b.detection.box.height -
        a.detection.box.width * a.detection.box.height
      );
    const primaryFace = faces[0];
    drawFaceBoxes(faces);
    const livenessOk   = checkLiveness(primaryFace);
    const detScore     = primaryFace.detection.score ?? 0.8;
    const dynThreshold = Number(state.settings.matchThreshold) +
      (detScore < 0.7 ? LIVE_DYNAMIC_THRESHOLD_BOOST : 0);
    const descriptor  = Array.from(primaryFace.descriptor);
    state.liveMatches = rankStudentsByMultiEmbedding(descriptor, dynThreshold).slice(0, 5);
    if (!state.liveMatches.length) {
      resetLiveRecognitionSelection();
      renderMatchList([]);
      dom.attendanceStatus.textContent = "No registered students found.";
      return;
    }
    const bestMatch      = state.liveMatches[0];
    const confidentMatch = isSelectableMatch(bestMatch, dynThreshold);
    if (!confidentMatch) {
      if (state.liveCandidateStudentId !== "__unknown__") {
        state.liveCandidateStudentId    = "__unknown__";
        state._unknownFaceFirstSeenAt   = Date.now();   // ← record when unknown first appeared
        state._unknownFaceCaptured      = false;         // reset capture flag
        playSound("unknown");
      }
      // After 3 s of continuous unknown face, auto-capture for Unidentified Data
      if (
        !state._unknownFaceCaptured &&
        state._unknownFaceFirstSeenAt &&
        Date.now() - state._unknownFaceFirstSeenAt >= 3000
      ) {
        state._unknownFaceCaptured = true;
        const capturedAt   = new Date().toISOString();
        const imageDataUrl = captureFrameAsDataUrl(dom.attendanceVideo, dom.attendanceCanvas);
        saveUnidentifiedEntry(imageDataUrl, capturedAt);
        // Stop recognition loop, go back to Scan Now state
        setTimeout(resetToScanReady, 800);
        return;
      }
      resetLiveRecognitionSelection();
      state.liveCandidateStudentId = "__unknown__";
      renderMatchList(state.liveMatches.slice(0, 3));
      dom.attendanceStatus.textContent =
        "Unregistered or unclear face. Closest: " +
        (bestMatch.student?.name || "unknown") +
        ` (${Math.round(distanceToPercent(bestMatch.distance))}% match)`;
      return;
    }
    // Face matched — reset unknown timer
    state._unknownFaceFirstSeenAt = null;
    state._unknownFaceCaptured    = false;
    if (!livenessOk) {
      dom.attendanceStatus.textContent =
        `Verifying liveness… ${state.livenessFrameCount}/${LIVE_LIVENESS_FRAMES_REQUIRED} — Please blink or move slightly`;
      renderMatchList(state.liveMatches);
      return;
    }
    if (state.liveCandidateStudentId === bestMatch.student.id) {
      state.liveCandidateStableCount += 1;
    } else {
      state.liveCandidateStudentId   = bestMatch.student.id;
      state.liveCandidateStableCount = 1;
    }
    state.selectedAttendanceStudentId =
      state.liveCandidateStableCount >= LIVE_REQUIRED_STABLE_MATCHES
        ? bestMatch.student.id : null;

    const pct = Math.round(distanceToPercent(bestMatch.distance));
    if (state.selectedAttendanceStudentId && !state._lastConfirmedStudentId) {
      // ── AUTO-SAVE: no confirmation needed ──
      state._lastConfirmedStudentId = bestMatch.student.id;
      // Stop recognition loop immediately
      if (state.liveRecognitionTimerId) {
        clearInterval(state.liveRecognitionTimerId);
        state.liveRecognitionTimerId = null;
      }
      state.liveRecognitionBusy = false;
      // Build and save record instantly
      const now      = new Date();
      const dateKey  = getLocalDateKey(now);
      const matchInfo = state.liveMatches.find(m => m.student.id === bestMatch.student.id);
      const matchPct  = matchInfo && matchInfo.distance !== null
        ? Math.round(distanceToPercent(matchInfo.distance)) : null;
      const record = {
        id:           `ATT-${Date.now()}`,
        studentId:    bestMatch.student.id,
        name:         bestMatch.student.name,
        roll:         bestMatch.student.roll,
        class:        bestMatch.student.class,
        studentPhone: bestMatch.student.studentPhone,
        parentPhone:  bestMatch.student.parentPhone,
        dateKey,
        date:         dateKey,
        timestamp:    now.toISOString(),
        dateLabel:    formatDate(now),
        timeLabel:    formatTime(now),
        formattedTime:formatDateTime(now),
        scanPhoto:    "",
        matchDistance: matchInfo?.distance != null && isFinite(matchInfo.distance)
          ? Number(matchInfo.distance.toFixed(4)) : null,
        matchPercent:  matchPct,
        syncState:    "local-only",
        waSent:       false,
      };
      state.attendances.unshift(record);
      saveData();
      playSound("match");
      showQuickToast(record);
      state.attendancePhoto             = null;
      state.selectedAttendanceStudentId = null;
      state._pendingAttendanceRecord    = null;
      state.livenessFrameCount          = 0;
      state.blinkDetected               = false;
      state.livenessConfirmed           = false;
      state.lastLandmarks               = null;
      state._lastConfirmedStudentId     = null;
      setTimeout(resetToScanReady, 900);
      return;
    }
    state._lastConfirmedStudentId = state.selectedAttendanceStudentId || null;
    if (state.selectedAttendanceStudentId) {
      dom.attendanceStatus.textContent =
        `✅ Identified ${bestMatch.student.name} — ${pct}% match.`;
    } else {
      dom.attendanceStatus.textContent =
        `Confirming ${bestMatch.student.name} (${pct}% match) — Hold still ` +
        `${state.liveCandidateStableCount}/${LIVE_REQUIRED_STABLE_MATCHES}`;
    }
    renderMatchList(state.liveMatches);
    if (faces.length > 1) {
      dom.attendanceStatus.textContent +=
        ` — ⚠ ${faces.length} faces detected, using closest.`;
    }
  } catch (err) {
    dom.attendanceStatus.textContent = err.message;
  } finally {
    state.liveRecognitionBusy = false;
  }
}

function rankStudentsByMultiEmbedding(descriptor, dynThreshold) {
  const threshold = dynThreshold ?? Number(state.settings.matchThreshold);
  const withDescriptors = state.students.filter(s =>
    Array.isArray(s.descriptors) && s.descriptors.length > 0
  );
  const legacyOnly = state.students.filter(s =>
    !Array.isArray(s.descriptors) && Array.isArray(s.descriptor)
  );
  const ranked = [
    ...withDescriptors.map(student => {
      const distances = student.descriptors.map(emb => descriptorDistance(descriptor, emb));
      const minDist   = Math.min(...distances);
      return { student, distance: minDist };
    }),
    ...legacyOnly.map(student => ({
      student,
      distance: descriptorDistance(descriptor, student.descriptor),
    })),
  ].sort((a, b) => a.distance - b.distance);
  const noDescriptor = state.students
    .filter(s => !Array.isArray(s.descriptors) && !Array.isArray(s.descriptor))
    .map(s => ({ student: s, distance: null }));
  return [...ranked, ...noDescriptor];
}

// ─── Liveness Detection ───────────────────────────────────────
function checkLiveness(detection) {
  if (!detection?.landmarks) return true;
  const landmarks = detection.landmarks.positions;
  const centroid  = computeLandmarkCentroid(landmarks);
  if (state.lastLandmarks) {
    const prevCentroid = computeLandmarkCentroid(state.lastLandmarks);
    const movement     = Math.sqrt(
      Math.pow(centroid.x - prevCentroid.x, 2) +
      Math.pow(centroid.y - prevCentroid.y, 2)
    );
    if (movement > LIVE_MOVEMENT_LANDMARK_DELTA) {
      state.livenessFrameCount = Math.min(
        state.livenessFrameCount + 1,
        LIVE_LIVENESS_FRAMES_REQUIRED + 2
      );
    }
  }
  if (!state.blinkDetected && state.lastLandmarks) {
    const earNow  = computeEAR(landmarks);
    const earPrev = computeEAR(state.lastLandmarks);
    if (earPrev > 0.25 && earNow < earPrev / LIVE_BLINK_EYE_DIFF_THRESHOLD) {
      state.blinkDetected      = true;
      state.livenessFrameCount = Math.max(
        state.livenessFrameCount,
        LIVE_LIVENESS_FRAMES_REQUIRED - 1
      );
    }
  }
  state.lastLandmarks     = landmarks;
  state.livenessConfirmed = state.livenessFrameCount >= LIVE_LIVENESS_FRAMES_REQUIRED;
  return state.livenessConfirmed;
}

function computeLandmarkCentroid(positions) {
  const n = positions.length;
  let sx = 0, sy = 0;
  for (const p of positions) { sx += p.x; sy += p.y; }
  return { x: sx / n, y: sy / n };
}

function computeEAR(positions) {
  try {
    const ear = (eye) => {
      const A = dist2d(eye[1], eye[5]);
      const B = dist2d(eye[2], eye[4]);
      const C = dist2d(eye[0], eye[3]);
      return (A + B) / (2.0 * C);
    };
    const leftEye  = positions.slice(36, 42);
    const rightEye = positions.slice(42, 48);
    return (ear(leftEye) + ear(rightEye)) / 2;
  } catch { return 0.3; }
}

function dist2d(a, b) {
  return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
}

// ─── Overlay canvas face boxes ────────────────────────────────
function drawFaceBoxes(faces) {
  if (!dom.faceOverlay) return;
  const ctx = dom.faceOverlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, dom.faceOverlay.width, dom.faceOverlay.height);
  const vw = dom.attendanceVideo.videoWidth  || 640;
  const vh = dom.attendanceVideo.videoHeight || 480;
  const sw = dom.faceOverlay.width  / vw;
  const sh = dom.faceOverlay.height / vh;
  faces.forEach((face, idx) => {
    const box = face.detection.box;
    const x = box.x * sw, y = box.y * sh;
    const w = box.width * sw, h = box.height * sh;
    const color = idx === 0 ? "#0ea5e9" : "#f59e0b";
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.strokeRect(x, y, w, h);
    const cs = 16;
    ctx.lineWidth = 3;
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy], ci) => {
      ctx.beginPath();
      ctx.moveTo(cx + (ci % 2 === 0 ? cs : -cs), cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + (ci < 2 ? cs : -cs));
      ctx.stroke();
    });
    const pct = Math.round((face.detection.score ?? 0) * 100);
    ctx.fillStyle    = color;
    ctx.font         = "bold 12px system-ui";
    ctx.textBaseline = "bottom";
    ctx.fillText(idx === 0 ? `Primary · ${pct}%` : `Face ${idx + 1} · ${pct}%`, x + 4, y - 4);
  });
}

function clearOverlayCanvas() {
  if (!dom.faceOverlay) return;
  const ctx = dom.faceOverlay.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, dom.faceOverlay.width, dom.faceOverlay.height);
}

// ─── Attendance confirm & save ────────────────────────────────
async function captureAttendancePhoto() {
  if (!dom.attendanceVideo.srcObject) {
    alert("Please start camera first.");
    return;
  }
  await runLiveRecognition();
  const student = state.students.find(s => s.id === state.selectedAttendanceStudentId);
  if (!student) {
    alert("No confirmed student yet. Hold the face steady until identification is complete.");
    return;
  }
  state.attendancePhoto = captureFrameAsDataUrl(dom.attendanceVideo, dom.attendanceCanvas);
  const matchInfo = state.liveMatches.find(m => m.student.id === student.id);
  const now       = new Date();
  const dateKey   = getLocalDateKey(now);

  // FIX #2: Allow multiple records per day (removed "alreadyMarked" block)
  // Each scan creates a new record — no duplicate prevention per day

  const matchPct = matchInfo && matchInfo.distance !== null
    ? Math.round(distanceToPercent(matchInfo.distance)) : null;
  const record = {
    id:           `ATT-${Date.now()}`,
    studentId:    student.id,
    name:         student.name,
    roll:         student.roll,
    class:        student.class,
    studentPhone: student.studentPhone,
    parentPhone:  student.parentPhone,
    dateKey,
    date:         dateKey,
    timestamp:    now.toISOString(),
    dateLabel:    formatDate(now),
    timeLabel:    formatTime(now),
    formattedTime:formatDateTime(now),
    scanPhoto:    "",
    matchDistance: matchInfo?.distance != null && isFinite(matchInfo.distance)
      ? Number(matchInfo.distance.toFixed(4)) : null,
    matchPercent:  matchPct,
    syncState:    "local-only",
    waSent:       false,
  };
  // Auto-save without confirmation popup
  state.attendances.unshift(record);
  saveData();
  playSound("match");
  showQuickToast(record);
  state.attendancePhoto = null;
  state.selectedAttendanceStudentId = null;
  state._pendingAttendanceRecord = null;
  state.livenessFrameCount  = 0;
  state.blinkDetected       = false;
  state.livenessConfirmed   = false;
  state.lastLandmarks       = null;
  state._lastConfirmedStudentId = null;
  setTimeout(resetToScanReady, 900);
}

function showAttendanceConfirmPopup(record) {
  state._pendingAttendanceRecord = record;

  let popup = document.getElementById("attendance-confirm-popup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "attendance-confirm-popup";
    popup.style.cssText = [
      "position:fixed","inset:0","z-index:2147483647",
      "display:flex","align-items:center","justify-content:center",
      "background:rgba(0,0,0,0.72)","backdrop-filter:blur(4px)",
    ].join(";");
    // Append to documentElement so it is visible even in fullscreen mode
    document.documentElement.appendChild(popup);
  }

  const pct = record.matchPercent !== null ? `${record.matchPercent}% match` : "";
  popup.innerHTML = `
    <div style="
      background:#0f172a;border:2px solid #0ea5e9;border-radius:24px;
      padding:32px 28px;max-width:340px;width:90%;text-align:center;
      box-shadow:0 25px 60px rgba(14,165,233,0.35);
      animation:modalPop 0.25s ease-out;
    ">
      <div style="font-size:48px;margin-bottom:8px;">🎓</div>
      <div style="font-size:22px;font-weight:700;color:#f1f5f9;margin-bottom:4px;">
        ${escapeHtml(record.name)}
      </div>
      <div style="font-size:13px;color:#94a3b8;margin-bottom:4px;">
        Roll ${escapeHtml(record.roll)} &nbsp;·&nbsp; ${escapeHtml(record.class)}
      </div>
      ${pct ? `<div style="font-size:12px;color:#34d399;margin-bottom:20px;">${pct}</div>` : `<div style="margin-bottom:20px;"></div>`}
      <div style="font-size:15px;color:#cbd5e1;margin-bottom:24px;">
        Mark attendance for <strong style="color:#f1f5f9;">${escapeHtml(record.name)}</strong>?
      </div>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button
          onclick="confirmAttendanceYes()"
          style="
            flex:1;padding:14px;border-radius:14px;border:none;cursor:pointer;
            background:#0ea5e9;color:#fff;font-size:16px;font-weight:700;
            transition:opacity 0.15s;
          "
          onmouseover="this.style.opacity='0.85'"
          onmouseout="this.style.opacity='1'"
        >✅ Yes</button>
        <button
          onclick="confirmAttendanceNo()"
          style="
            flex:1;padding:14px;border-radius:14px;border:none;cursor:pointer;
            background:#1e293b;color:#f87171;font-size:16px;font-weight:700;
            border:2px solid #ef444440;transition:opacity 0.15s;
          "
          onmouseover="this.style.opacity='0.75'"
          onmouseout="this.style.opacity='1'"
        >❌ No</button>
      </div>
    </div>
  `;
  popup.style.display = "flex";
}

function confirmAttendanceYes() {
  const record = state._pendingAttendanceRecord;
  closeAttendanceConfirmPopup();
  if (!record) return;
  state.attendances.unshift(record);
  saveData();
  showSuccessModal(record);
  state.attendancePhoto = null;
  state.selectedAttendanceStudentId = null;
  state._pendingAttendanceRecord = null;
  state.livenessFrameCount  = 0;
  state.blinkDetected       = false;
  state.livenessConfirmed   = false;
  state.lastLandmarks       = null;
  state._lastConfirmedStudentId = null;
  // Return to Scan Now state for next student
  setTimeout(resetToScanReady, 400);
}

function confirmAttendanceNo() {
  closeAttendanceConfirmPopup();
  state._pendingAttendanceRecord = null;
  state.attendancePhoto = null;
  state.selectedAttendanceStudentId = null;
  state._lastConfirmedStudentId = null;
  state.livenessFrameCount  = 0;
  state.blinkDetected       = false;
  state.livenessConfirmed   = false;
  state.lastLandmarks       = null;
  resetToScanReady();
}

function closeAttendanceConfirmPopup() {
  const popup = document.getElementById("attendance-confirm-popup");
  if (popup) popup.style.display = "none";
}

// ─── Match list render ────────────────────────────────────────
function renderMatchList(matches) {
  // FIX #7: In scan section only show name strip, not full match list
  // (handled in HTML — just update the name strip)
  const nameStrip = document.getElementById("scan-name-strip");
  if (nameStrip) {
    if (matches.length && state.selectedAttendanceStudentId) {
      const best = matches[0];
      nameStrip.textContent = `✅ ${best.student.name}`;
      nameStrip.style.background = "linear-gradient(90deg,#059669,#0ea5e9)";
    } else if (matches.length) {
      const best = matches[0];
      const pct  = Math.round(distanceToPercent(best.distance));
      const conf = isSelectableMatch(best, Number(state.settings.matchThreshold));
      if (conf) {
        nameStrip.textContent = `🔍 ${best.student.name} — ${pct}%`;
        nameStrip.style.background = "linear-gradient(90deg,#0369a1,#6366f1)";
      } else {
        nameStrip.textContent = "❓ Unknown face";
        nameStrip.style.background = "rgba(239,68,68,0.5)";
      }
    } else {
      nameStrip.textContent = "";
      nameStrip.style.background = "transparent";
    }
  }

  // Also update confirm button state — hidden in normal flow (auto-save handles it)
  const threshold    = Number(state.settings.matchThreshold);
  const selectedId   = state.selectedAttendanceStudentId;
  if (!matches.length) {
    setAttendanceConfirmState(false, "🔍 Identifying Face…");
    return;
  }
  const bestMatch      = matches[0];
  const confidentMatch = isSelectableMatch(bestMatch, threshold);
  if (!confidentMatch) {
    setAttendanceConfirmState(false, "❌ Face Not Registered");
  } else if (selectedId) {
    // Auto-save triggers before this renders in normal flow; button is fallback only
    setAttendanceConfirmState(false, "🔍 Hold Still…");
  } else {
    setAttendanceConfirmState(false, "🔍 Hold Still…");
  }
}

// ─── Quick flash toast (instant attendance confirmation) ──────
function showQuickToast(record) {
  let toast = document.getElementById("quick-attendance-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "quick-attendance-toast";
    toast.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "pointer-events:none",
    ].join(";");
    document.documentElement.appendChild(toast);
  }
  toast.innerHTML = `
    <div style="
      background:linear-gradient(135deg,#0f172a 0%,#0c2340 100%);
      border:2px solid #10b981;
      border-radius:28px;
      padding:28px 36px;
      max-width:320px;
      width:88vw;
      text-align:center;
      box-shadow:0 0 0 4px rgba(16,185,129,0.15), 0 32px 64px rgba(0,0,0,0.6);
      animation:quickToastIn 0.18s cubic-bezier(0.34,1.56,0.64,1);
    ">
      <div style="font-size:44px;line-height:1;margin-bottom:10px;">✅</div>
      <div style="font-size:24px;font-weight:800;color:#f1f5f9;letter-spacing:-0.02em;margin-bottom:4px;">
        ${escapeHtml(record.name)}
      </div>
      <div style="font-size:13px;color:#94a3b8;margin-bottom:10px;">
        Roll ${escapeHtml(record.roll)} &nbsp;·&nbsp; ${escapeHtml(record.class)}
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:12px;">
        <span style="font-size:13px;color:#34d399;font-weight:700;">Attendance Marked</span>
      </div>
      <div style="font-size:12px;color:#64748b;margin-top:8px;">
        ${escapeHtml(record.timeLabel)} &nbsp;·&nbsp; ${escapeHtml(record.dateLabel)}
      </div>
    </div>
  `;
  toast.style.display = "flex";
  if (!document.getElementById("quick-toast-style")) {
    const s = document.createElement("style");
    s.id = "quick-toast-style";
    s.textContent = `
      @keyframes quickToastIn {
        0%   { opacity:0; transform:scale(0.80) translateY(20px); }
        100% { opacity:1; transform:scale(1)    translateY(0); }
      }
      @keyframes quickToastOut {
        0%   { opacity:1; transform:scale(1)    translateY(0); }
        100% { opacity:0; transform:scale(0.90) translateY(-16px); }
      }
    `;
    document.head.appendChild(s);
  }
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    const inner = toast.querySelector("div");
    if (inner) inner.style.animation = "quickToastOut 0.2s ease-in forwards";
    setTimeout(() => { toast.style.display = "none"; }, 220);
  }, 850);
}

// ─── Success modal ────────────────────────────────────────────
function showSuccessModal(record) {
  state.modalRecord = record;
  dom.modalTitle.innerHTML =
    `✅ Done<br><span class="text-emerald-400">${escapeHtml(record.name)}</span>`;
  dom.modalSubtitle.textContent = `Roll ${record.roll} · ${record.class}`;
  dom.modalDetails.innerHTML = "";
  dom.modalWhatsappButton.classList.remove("hidden");
  dom.successModal.classList.remove("hidden");
  // Auto-hide after 1.5 seconds so next student can scan immediately
  setTimeout(() => hideModal(), 1500);
}

function hideModal() {
  dom.successModal.classList.add("hidden");
  if (state.currentCameraMode === "attendance" && dom.attendanceVideo.srcObject) {
    setTimeout(() => void runLiveRecognition(), 150);
  }
}

function sendWhatsAppMessage() {
  if (!state.modalRecord) return;
  openWhatsappForRecord(state.modalRecord);
  // Mark as sent
  markWaSent(state.modalRecord.id);
  hideModal();
}

function openWhatsappForRecord(record) {
  const phone = normalizeWhatsappNumber(record.parentPhone);
  if (!phone) { alert("Parent mobile number is missing."); return; }
  const message = encodeURIComponent(
    `Dear Parent,\n\nYour ward *${record.name}* (Roll No. ${record.roll}, ${record.class}) has marked attendance today.\n\nTime: ${record.formattedTime}\n\nThank you!\nUnacademy Gwalior`
  );
  window.open(`https://wa.me/${phone}?text=${message}`, "_blank", "noopener,noreferrer");
}

// FIX #4: Mark WhatsApp as sent
function markWaSent(recordId) {
  const idx = state.attendances.findIndex(a => a.id === recordId);
  if (idx !== -1) {
    state.attendances[idx] = { ...state.attendances[idx], waSent: true };
    saveData();
  }
}

// FIX #3: Send WhatsApp to ALL who haven't received it yet
function sendWhatsAppToAll() {
  const today = getLocalDateKey(new Date());
  const pending = state.attendances.filter(a => a.dateKey === today && !a.waSent && a.parentPhone);
  if (!pending.length) {
    alert("No pending WhatsApp messages for today's attendance.");
    return;
  }
  if (!confirm(`Send WhatsApp to ${pending.length} parents for today's attendance?`)) return;
  pending.forEach((record, i) => {
    setTimeout(() => {
      openWhatsappForRecord(record);
      markWaSent(record.id);
    }, i * 800); // stagger to avoid popup blocking
  });
}

// ─── Records UI ───────────────────────────────────────────────
function showStudentsList() {
  dom.studentsListView.classList.remove("hidden");
  dom.attendanceListView.classList.add("hidden");
  dom.showStudentsButton.classList.add("bg-sky-500", "text-white");
  dom.showStudentsButton.classList.remove("bg-slate-800");
  dom.showAttendanceButton.classList.remove("bg-sky-500", "text-white");
  dom.showAttendanceButton.classList.add("bg-slate-800");
  document.getElementById("export-csv-btn")?.classList.add("hidden");
  document.getElementById("export-pdf-btn")?.classList.add("hidden");
  document.getElementById("wa-all-btn")?.classList.add("hidden");
  // Clear search on tab switch
  const searchEl = document.getElementById("student-search-input");
  if (searchEl) searchEl.value = "";
  renderStudentsGrid();
}

function filterStudentsGrid(query) {
  renderStudentsGrid(query);
}

function renderStudentsGrid(searchQuery) {
  const query = (searchQuery ?? document.getElementById("student-search-input")?.value ?? "").trim().toLowerCase();
  dom.studentsGrid.innerHTML = "";
  const noResults = document.getElementById("students-no-results");

  if (!state.students.length) {
    dom.studentsGrid.innerHTML =
      '<div class="col-span-3 text-center py-16 text-slate-400">No students registered yet.<br>Go to Register tab.</div>';
    if (noResults) noResults.classList.add("hidden");
    return;
  }

  const filtered = query
    ? state.students.filter(s => s.name.toLowerCase().includes(query))
    : state.students;

  if (!filtered.length) {
    if (noResults) noResults.classList.remove("hidden");
    return;
  }
  if (noResults) noResults.classList.add("hidden");

  filtered.forEach(student => {
    const card = document.createElement("div");
    card.className =
      "bg-slate-900 border border-slate-700 hover:border-sky-400 rounded-3xl p-5 transition-all";
    const embBadge = student.embeddingCount
      ? `<div class="text-xs text-sky-400 mt-1">🧠 ${student.embeddingCount} face samples</div>` : "";
    const angleInfo = student.angleData
      ? Object.entries(student.angleData)
          .filter(([, v]) => v)
          .map(([k]) => `<span class="inline-block bg-emerald-500/10 text-emerald-400 text-xs px-2 py-0.5 rounded-lg">${k}</span>`)
          .join("")
      : "";
    card.innerHTML = `
      <img src="${escapeHtml(student.facePhoto||"")}"
           class="w-full aspect-square object-cover rounded-3xl mb-4 bg-slate-800"
           alt="${escapeHtml(student.name)}">
      <div class="font-semibold text-lg">${escapeHtml(student.name)}</div>
      <div class="flex justify-between text-sm mt-1 gap-4">
        <span class="text-slate-400">Roll ${escapeHtml(student.roll)}</span>
        <span class="font-medium">${escapeHtml(student.class)}</span>
      </div>
      ${embBadge}
      ${angleInfo ? `<div class="flex gap-1 flex-wrap mt-2">${angleInfo}</div>` : ""}
      <div class="text-xs text-slate-400 mt-4 space-y-1">
        <div>📱 Student: ${escapeHtml(student.studentPhone||"-")}</div>
        <div>👨‍👩‍👧 Parent: ${escapeHtml(student.parentPhone||"-")}</div>
      </div>
      <div class="flex gap-2 mt-4">
        <button type="button"
          class="flex-1 text-xs bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 px-3 py-2 rounded-2xl font-medium transition-colors"
          onclick="openEditModal('${escapeHtml(student.id)}')">
          ✏️ Edit
        </button>
        <button type="button"
          class="flex-1 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 px-3 py-2 rounded-2xl font-medium transition-colors"
          onclick="deleteStudent('${escapeHtml(student.id)}')">
          🗑️ Delete
        </button>
      </div>
    `;
    dom.studentsGrid.appendChild(card);
  });
}

function showAttendanceList() {
  dom.studentsListView.classList.add("hidden");
  dom.attendanceListView.classList.remove("hidden");
  dom.showAttendanceButton.classList.add("bg-sky-500", "text-white");
  dom.showAttendanceButton.classList.remove("bg-slate-800");
  dom.showStudentsButton.classList.remove("bg-sky-500", "text-white");
  dom.showStudentsButton.classList.add("bg-slate-800");
  document.getElementById("export-csv-btn")?.classList.remove("hidden");
  document.getElementById("export-pdf-btn")?.classList.remove("hidden");
  document.getElementById("wa-all-btn")?.classList.remove("hidden");
  renderAttendanceTable();
}

function renderAttendanceTable() {
  dom.attendanceTableBody.innerHTML = "";
  if (!state.attendances.length) {
    dom.attendanceTableBody.innerHTML =
      '<tr><td colspan="7" class="text-center py-12 text-slate-400">No attendance records yet</td></tr>';
    return;
  }
  state.attendances.forEach(record => {
    const row = document.createElement("tr");
    row.className = "border-b border-slate-700 last:border-none hover:bg-slate-800/50";
    const matchLabel = record.matchPercent !== null && record.matchPercent !== undefined
      ? `${record.matchPercent}%` : "";
    // FIX #4: WhatsApp sent status column
    const waStatus = record.waSent
      ? `<span class="text-emerald-400 text-xs font-semibold">✅ Sent</span>`
      : `<span class="text-slate-500 text-xs">Not sent</span>`;
    const profileBadge = record.profileStatus === "deleted"
      ? `<span class="ml-1 text-xs bg-red-500/15 text-red-400 px-2 py-0.5 rounded-lg">Deleted Profile</span>`
      : `<span class="ml-1 text-xs bg-emerald-500/15 text-emerald-400 px-2 py-0.5 rounded-lg">Active</span>`;
    row.innerHTML = `
      <td class="px-4 py-4 text-xs">${escapeHtml(record.formattedTime)}</td>
      <td class="px-4 py-4 font-medium">${escapeHtml(record.name)}${matchLabel ? `<span class="ml-2 text-xs text-emerald-400">${matchLabel}</span>` : ""}</td>
      <td class="px-4 py-4 text-sm">${escapeHtml(record.roll)}</td>
      <td class="px-4 py-4 text-sm">${escapeHtml(record.class)}</td>
      <td class="px-4 py-4">${profileBadge}</td>
      <td class="px-4 py-4 text-center">${waStatus}</td>
      <td class="px-4 py-4 text-right">
        <div class="flex gap-2 justify-end">
          <button type="button"
            class="attendance-wa-btn text-emerald-400 text-xs font-medium px-3 py-2 bg-emerald-400/10 hover:bg-emerald-400/20 rounded-2xl"
            data-record-id="${escapeHtml(record.id)}">
            📤 WA
          </button>
          <button type="button"
            class="attendance-del-btn text-red-400 text-xs font-medium px-3 py-2 bg-red-400/10 hover:bg-red-400/20 rounded-2xl"
            data-record-id="${escapeHtml(record.id)}">
            🗑️
          </button>
        </div>
      </td>
    `;
    row.querySelector(".attendance-wa-btn")?.addEventListener("click", () => {
      const rec = state.attendances.find(e => e.id === record.id);
      if (rec) { openWhatsappForRecord(rec); markWaSent(rec.id); }
    });
    row.querySelector(".attendance-del-btn")?.addEventListener("click", () => {
      deleteAttendanceRecord(record.id);
    });
    dom.attendanceTableBody.appendChild(row);
  });
}

// ─── TRASH / RECYCLE BIN ──────────────────────────────────────
function moveToTrash(type, item) {
  state.trash.unshift({ type, item, deletedAt: new Date().toISOString() });
  if (state.trash.length > 100) state.trash = state.trash.slice(0, 100);
  localStorage.setItem(STORAGE_KEYS.trash, JSON.stringify(state.trash));
}

function renderTrash() {
  const container = document.getElementById("trash-list");
  if (!container) return;
  container.innerHTML = "";
  if (!state.trash.length) {
    container.innerHTML = '<div class="text-center py-16 text-slate-400">🗑️ Recycle bin is empty.</div>';
    return;
  }
  state.trash.forEach((entry, i) => {
    const div = document.createElement("div");
    div.className = "bg-slate-900 border border-slate-700 rounded-2xl p-4 flex items-center justify-between gap-4";
    const label = entry.type === "student"
      ? `👤 ${entry.item.name} (Roll ${entry.item.roll})`
      : `📋 ${entry.item.name} — ${entry.item.formattedTime || entry.item.dateLabel}`;
    div.innerHTML = `
      <div>
        <div class="font-medium">${escapeHtml(label)}</div>
        <div class="text-xs text-slate-400 mt-1">Deleted: ${formatDateTime(entry.deletedAt)}</div>
      </div>
      <div class="flex gap-2">
        <button onclick="restoreTrashItem(${i})"
          class="text-sky-400 text-xs bg-sky-400/10 hover:bg-sky-400/20 px-3 py-2 rounded-xl font-semibold">
          ↩️ Restore
        </button>
      </div>
    `;
    container.appendChild(div);
  });
}

function restoreTrashItem(index) {
  const entry = state.trash[index];
  if (!entry) return;
  if (entry.type === "student") {
    state.students.unshift(entry.item);
  } else if (entry.type === "attendance") {
    state.attendances.unshift(entry.item);
  }
  state.trash.splice(index, 1);
  saveData();
  renderTrash();
  alert("Item restored successfully.");
}

function permanentDeleteTrash(index) {
  if (!confirm("Permanently delete this item? This cannot be undone.")) return;
  state.trash.splice(index, 1);
  localStorage.setItem(STORAGE_KEYS.trash, JSON.stringify(state.trash));
  renderTrash();
}

function clearTrash() {
  if (!confirm("Permanently delete all items in the recycle bin?")) return;
  state.trash = [];
  localStorage.setItem(STORAGE_KEYS.trash, JSON.stringify(state.trash));
  renderTrash();
}

// ─── UNIDENTIFIED SCAN SYSTEM ────────────────────────────────

/**
 * Called automatically after 2 s of continuous unknown face.
 * Saves a new entry with: unique ID, captured image, exact scan time.
 */
function saveUnidentifiedEntry(imageDataUrl, capturedAt) {
  const uid = `UNK-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const entry = {
    id:            uid,
    image:         "",
    capturedAt:    capturedAt,
    dateKey:       getLocalDateKey(new Date(capturedAt)),
    dateLabel:     formatDate(new Date(capturedAt)),
    timeLabel:     formatTime(new Date(capturedAt)),
    formattedTime: formatDateTime(new Date(capturedAt)),
    resolved:      false,
  };
  state.unidentified.unshift(entry);
  if (state.unidentified.length > 200) state.unidentified = state.unidentified.slice(0, 200);
  localStorage.setItem(STORAGE_KEYS.unidentified, JSON.stringify(state.unidentified));
  updateUnidentifiedBadge();

  // ── Play captured sound ──
  playSound("captured");

  // ── Show Done popup ──
  showUnidentifiedCapturedPopup(entry);

  // ── Auto-download image to device ──
  if (imageDataUrl && imageDataUrl.startsWith("data:")) {
    try {
      const a = document.createElement("a");
      a.href     = imageDataUrl;
      a.download = `${uid}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (_) {}
  }

  dom.attendanceStatus.textContent =
    `⚠️ Unknown face captured (${uid}). Saved to Unidentified tab & downloaded.`;
}

function showUnidentifiedCapturedPopup(entry) {
  let popup = document.getElementById("unk-captured-popup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "unk-captured-popup";
    popup.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,0.80);backdrop-filter:blur(6px);";
    document.documentElement.appendChild(popup);
  }

  popup.innerHTML = `
    <div style="
      background:#0f172a;
      border:2px solid #f59e0b;
      border-radius:28px;
      padding:28px 24px 24px;
      max-width:320px;
      width:90%;
      text-align:center;
      box-shadow:0 0 0 4px rgba(245,158,11,0.15), 0 25px 60px rgba(0,0,0,0.6);
      animation:modalPop 0.25s ease-out;
    ">
      <!-- Face photo -->
      <div style="
        width:100px;height:100px;border-radius:50%;overflow:hidden;
        margin:0 auto 16px;border:3px solid #f59e0b;
        background:#1e293b;
      ">
        <img src="${escapeHtml(entry.image)}" alt="Captured face"
          style="width:100%;height:100%;object-fit:cover;"
          onerror="this.parentElement.innerHTML='❓';"
        />
      </div>

      <!-- Done heading -->
      <div style="font-size:26px;font-weight:800;color:#fbbf24;letter-spacing:-0.5px;margin-bottom:4px;">
        📋 Done
      </div>
      <div style="font-size:13px;color:#94a3b8;margin-bottom:14px;">
        Face not identified — image captured &amp; saved
      </div>

      <!-- UID chip -->
      <div style="
        background:#1e293b;border:1px solid #334155;
        border-radius:12px;padding:8px 14px;
        font-family:monospace;font-size:12px;color:#f59e0b;
        word-break:break-all;margin-bottom:8px;
      ">${escapeHtml(entry.id)}</div>

      <!-- Time -->
      <div style="font-size:12px;color:#64748b;margin-bottom:20px;">
        🕐 ${escapeHtml(entry.formattedTime)}
      </div>

      <div style="font-size:12px;color:#475569;margin-bottom:20px;">
        Image downloaded to device. Go to <strong style="color:#f59e0b;">Unidentified</strong> tab to mark attendance.
      </div>

      <!-- Close button -->
      <button
        onclick="document.getElementById('unk-captured-popup').style.display='none';"
        style="
          width:100%;padding:14px;border-radius:16px;border:none;cursor:pointer;
          background:linear-gradient(90deg,#f59e0b,#f97316);
          color:#fff;font-size:16px;font-weight:700;
          transition:opacity 0.15s;
        "
        onmouseover="this.style.opacity='0.85'"
        onmouseout="this.style.opacity='1'"
      >
        ✅ OK, Got It
      </button>
    </div>
  `;
  popup.style.display = "flex";

  // Auto-close after 6 seconds
  setTimeout(() => {
    if (popup.style.display !== "none") popup.style.display = "none";
  }, 6000);
}

function updateUnidentifiedBadge() {
  const pending = state.unidentified.filter(e => !e.resolved).length;
  const badge   = document.getElementById("unidentified-badge");
  if (badge) {
    badge.textContent = pending > 0 ? String(pending) : "";
    badge.style.display = pending > 0 ? "inline-flex" : "none";
  }
  const inlineBadge = document.getElementById("unidentified-badge-inline");
  if (inlineBadge) {
    inlineBadge.textContent  = pending > 0 ? `${pending} pending` : "";
    inlineBadge.style.display = pending > 0 ? "inline" : "none";
  }
}

function renderUnidentifiedList() {
  updateUnidentifiedBadge();
  const container = document.getElementById("unidentified-list");
  if (!container) return;
  container.innerHTML = "";
  const items = state.unidentified;
  if (!items.length) {
    container.innerHTML =
      '<div class="text-center py-16 text-slate-400 text-lg">✅ No unidentified faces. All good!</div>';
    return;
  }

  items.forEach(entry => {
    const card = document.createElement("div");
    card.className = "rounded-3xl overflow-hidden border " +
      (entry.resolved ? "border-emerald-700/40 opacity-70" : "border-amber-500/40");
    card.style.background = "#0f172a";

    // ── Header row (always visible, clickable) ──
    const header = document.createElement("div");
    header.className =
      "flex items-center gap-4 p-4 cursor-pointer select-none hover:bg-slate-800/60 transition-colors";
    header.onclick = () => entry.resolved ? null : toggleUnkPanel(entry.id);

    const dt = new Date(entry.capturedAt);
    header.innerHTML = `
      <div class="flex-shrink-0 relative">
        <img src="${escapeHtml(entry.image)}" alt="face"
          class="w-16 h-16 rounded-2xl object-cover border-2 ${entry.resolved ? 'border-emerald-500' : 'border-amber-500'} bg-slate-800"
          onerror="this.src='';this.style.background='#334155';"
        />
        ${entry.resolved
          ? '<span style="position:absolute;bottom:-4px;right:-4px;font-size:18px;">✅</span>'
          : '<span style="position:absolute;bottom:-4px;right:-4px;font-size:18px;">❓</span>'}
      </div>
      <div class="flex-1 min-w-0">
        <div class="font-bold text-white text-sm truncate">${escapeHtml(entry.id)}</div>
        <div class="text-amber-300 text-xs font-semibold mt-0.5">🕐 ${escapeHtml(entry.formattedTime)}</div>
        ${entry.resolved
          ? `<div class="text-emerald-400 text-xs mt-1">Resolved → ${escapeHtml(entry.resolvedName || "")}</div>`
          : `<div class="text-slate-400 text-xs mt-1">Tap to identify &amp; mark attendance</div>`}
      </div>
      ${!entry.resolved ? `
        <div id="unk-chevron-${escapeHtml(entry.id)}" class="text-slate-500 text-xl transition-transform">▼</div>
      ` : ""}
    `;
    card.appendChild(header);

    // ── Expandable student panel ──
    if (!entry.resolved) {
      const panel = document.createElement("div");
      panel.id        = `unk-panel-${entry.id}`;
      panel.className = "hidden";
      panel.style.cssText = "border-top:1px solid rgba(245,158,11,0.2);";

      // Build student cards
      const studentCards = state.students.map(s => `
        <div class="unk-student-card flex items-center gap-3 p-3 rounded-2xl cursor-pointer border-2 border-transparent hover:border-sky-500 hover:bg-slate-700/60 transition-all"
          data-sid="${escapeHtml(s.id)}"
          onclick="selectUnkStudent('${escapeHtml(entry.id)}','${escapeHtml(s.id)}',this)">
          <div class="w-10 h-10 rounded-xl bg-sky-500/20 flex items-center justify-center text-lg font-bold text-sky-300 flex-shrink-0">
            ${escapeHtml(s.name.charAt(0).toUpperCase())}
          </div>
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-white text-sm truncate">${escapeHtml(s.name)}</div>
            <div class="text-xs text-slate-400">Roll ${escapeHtml(s.roll)} &nbsp;·&nbsp; ${escapeHtml(s.class)}</div>
            ${s.parentPhone ? `<div class="text-xs text-slate-500">📞 ${escapeHtml(s.parentPhone)}</div>` : ""}
          </div>
          <div class="unk-tick text-emerald-400 text-xl hidden">✓</div>
        </div>
      `).join("");

      panel.innerHTML = `
        <div class="p-4">
          <p class="text-sm text-slate-300 font-semibold mb-3">
            👇 Select the student this face belongs to:
          </p>
          <div class="space-y-2 max-h-64 overflow-y-auto pr-1" style="scrollbar-width:thin;">
            ${studentCards.length ? studentCards : '<p class="text-slate-400 text-sm">No students registered yet.</p>'}
          </div>
          <input type="hidden" id="unk-selected-sid-${escapeHtml(entry.id)}" value="" />
          <div class="flex gap-3 mt-4">
            <button type="button"
              onclick="markUnidentifiedAttendance('${escapeHtml(entry.id)}')"
              class="flex-1 bg-sky-500 hover:bg-sky-400 active:scale-95 text-white font-bold py-3 rounded-2xl text-sm transition-all">
              ✅ Mark Attendance
            </button>
            <button type="button"
              onclick="dismissUnidentifiedEntry('${escapeHtml(entry.id)}')"
              class="bg-slate-700 hover:bg-red-900/40 text-red-400 font-bold py-3 px-4 rounded-2xl text-sm transition-all">
              🗑️
            </button>
          </div>
        </div>
      `;
      card.appendChild(panel);
    }

    container.appendChild(card);
  });
}

function toggleUnkPanel(entryId) {
  const panel   = document.getElementById(`unk-panel-${entryId}`);
  const chevron = document.getElementById(`unk-chevron-${entryId}`);
  if (!panel) return;
  const open = panel.classList.toggle("hidden");
  if (chevron) chevron.style.transform = open ? "" : "rotate(180deg)";
}

function selectUnkStudent(entryId, studentId, el) {
  // Deselect all in this panel
  const panel = document.getElementById(`unk-panel-${entryId}`);
  if (panel) {
    panel.querySelectorAll(".unk-student-card").forEach(c => {
      c.classList.remove("border-sky-500", "bg-slate-700/60");
      c.querySelector(".unk-tick")?.classList.add("hidden");
    });
  }
  // Select clicked
  el.classList.add("border-sky-500", "bg-slate-700/60");
  el.querySelector(".unk-tick")?.classList.remove("hidden");
  // Store selection
  const hiddenInput = document.getElementById(`unk-selected-sid-${entryId}`);
  if (hiddenInput) hiddenInput.value = studentId;
}

function markUnidentifiedAttendance(entryId) {
  const entry = state.unidentified.find(e => e.id === entryId);
  if (!entry || entry.resolved) return;

  const hiddenInput = document.getElementById(`unk-selected-sid-${entryId}`);
  const studentId   = hiddenInput?.value;
  if (!studentId) {
    alert("Please tap a student from the list first to select them.");
    return;
  }
  const student = state.students.find(s => s.id === studentId);
  if (!student) { alert("Student not found."); return; }

  // ── Use the ORIGINAL scan time, not new Date() ──
  const punchTime = new Date(entry.capturedAt);
  const dateKey   = getLocalDateKey(punchTime);

  const record = {
    id:            `ATT-UNK-${Date.now()}`,
    studentId:     student.id,
    name:          student.name,
    roll:          student.roll,
    class:         student.class,
    studentPhone:  student.studentPhone,
    parentPhone:   student.parentPhone,
    dateKey,
    date:          dateKey,
    timestamp:     entry.capturedAt,
    dateLabel:     formatDate(punchTime),
    timeLabel:     formatTime(punchTime),
    formattedTime: formatDateTime(punchTime),
    scanPhoto:     entry.image || "",
    matchDistance: null,
    matchPercent:  null,
    syncState:     "local-only",
    waSent:        false,
    markedFrom:    "unidentified",
    unidentifiedId: entryId,
  };

  const idx = state.unidentified.findIndex(e => e.id === entryId);
  if (idx !== -1) {
    state.unidentified[idx] = {
      ...entry,
      resolved:          true,
      resolvedName:      student.name,
      resolvedAt:        new Date().toISOString(),
      resolvedStudentId: student.id,
    };
  }

  state.attendances.unshift(record);
  saveData();
  localStorage.setItem(STORAGE_KEYS.unidentified, JSON.stringify(state.unidentified));
  updateUnidentifiedBadge();
  renderUnidentifiedList();
  showUnidentifiedSuccessPopup(record);
}

function showUnidentifiedSuccessPopup(record) {
  let popup = document.getElementById("unidentified-success-popup");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "unidentified-success-popup";
    popup.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;" +
      "justify-content:center;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);";
    document.documentElement.appendChild(popup);
  }
  popup.innerHTML = `
    <div style="
      background:#0f172a;border:2px solid #10b981;border-radius:24px;
      padding:32px 28px;max-width:340px;width:90%;text-align:center;
      box-shadow:0 25px 60px rgba(16,185,129,0.3);
      animation:modalPop 0.25s ease-out;
    ">
      <div style="font-size:48px;margin-bottom:8px;">✅</div>
      <div style="font-size:20px;font-weight:700;color:#f1f5f9;margin-bottom:4px;">
        Attendance Saved!
      </div>
      <div style="font-size:13px;color:#94a3b8;margin-bottom:2px;">
        ${escapeHtml(record.name)} · Roll ${escapeHtml(record.roll)} · ${escapeHtml(record.class)}
      </div>
      <div style="font-size:12px;color:#fbbf24;font-weight:600;margin-bottom:20px;">
        🕐 Punch time: ${escapeHtml(record.formattedTime)}
      </div>
      <div style="font-size:13px;color:#cbd5e1;margin-bottom:20px;">
        Original scan time used. Not current time.
      </div>
      <div style="display:flex;gap:12px;justify-content:center;">
        <button onclick="sendUnidentifiedWhatsApp('${escapeHtml(record.id)}')"
          style="flex:1;padding:12px;border-radius:14px;border:none;cursor:pointer;
            background:#22c55e;color:#fff;font-size:15px;font-weight:700;">
          💬 WhatsApp
        </button>
        <button onclick="document.getElementById('unidentified-success-popup').style.display='none'"
          style="flex:1;padding:12px;border-radius:14px;border:none;cursor:pointer;
            background:#1e293b;color:#94a3b8;font-size:15px;font-weight:700;">
          Close
        </button>
      </div>
    </div>
  `;
  popup.style.display = "flex";
}

function sendUnidentifiedWhatsApp(recordId) {
  const record = state.attendances.find(r => r.id === recordId);
  if (record) {
    openWhatsappForRecord(record);   // uses record.formattedTime which is the original scan time
    markWaSent(record.id);
  }
  const popup = document.getElementById("unidentified-success-popup");
  if (popup) popup.style.display = "none";
}

function dismissUnidentifiedEntry(entryId) {
  if (!confirm("Dismiss this unidentified entry? It will be removed.")) return;
  state.unidentified = state.unidentified.filter(e => e.id !== entryId);
  localStorage.setItem(STORAGE_KEYS.unidentified, JSON.stringify(state.unidentified));
  updateUnidentifiedBadge();
  renderUnidentifiedList();
}

function clearResolvedUnidentified() {
  if (!confirm("Clear all resolved (green) entries from this list?")) return;
  state.unidentified = state.unidentified.filter(e => !e.resolved);
  localStorage.setItem(STORAGE_KEYS.unidentified, JSON.stringify(state.unidentified));
  updateUnidentifiedBadge();
  renderUnidentifiedList();
}

function deleteStudent(studentId) {
  const student = state.students.find(s => s.id === studentId);
  if (!student) return;
  if (!confirm(`Delete "${student.name}"? Their attendance records will be KEPT with "Deleted Profile" label.`)) return;
  // Move student to trash (not attendance records — keep them)
  moveToTrash("student", student);
  // Mark all their attendance records as "deleted profile" instead of removing
  state.attendances = state.attendances.map(a =>
    a.studentId === studentId
      ? { ...a, profileStatus: "deleted" }
      : a
  );
  state.students = state.students.filter(s => s.id !== studentId);
  saveData();
  renderStudentsGrid();
  renderAttendanceTable();
  updateDashboardStats();
}

// ─── DELETE ATTENDANCE RECORD ─────────────────────────────────
function deleteAttendanceRecord(recordId) {
  const record = state.attendances.find(r => r.id === recordId);
  if (!record) return;
  if (!confirm(`Move attendance record for ${record.name} to recycle bin?`)) return;
  moveToTrash("attendance", record);
  state.attendances = state.attendances.filter(r => r.id !== recordId);
  saveData();
  renderAttendanceTable();
}

// ─── EDIT STUDENT MODAL ───────────────────────────────────────
function openEditModal(studentId) {
  const student = state.students.find(s => s.id === studentId);
  if (!student) return;
  document.getElementById("edit-student-id").value     = student.id;
  document.getElementById("edit-name").value           = student.name;
  document.getElementById("edit-roll").value           = student.roll;
  document.getElementById("edit-class").value          = student.class;
  document.getElementById("edit-student-phone").value  = student.studentPhone || "";
  document.getElementById("edit-parent-phone").value   = student.parentPhone  || "";
  document.getElementById("edit-student-modal").classList.remove("hidden");
}

function closeEditModal() {
  document.getElementById("edit-student-modal").classList.add("hidden");
  stopEditCamera();
  resetEditAngles();
}


// ─── Edit modal: Re-scan face ─────────────────────────────────
const _editAngle = { stream: null, index: 0, angleData: { front: null, left: null, right: null }, descriptors: { front: [], left: [], right: [] } };
const _editAngleDefs = [
  { key: "front", label: "Front Face", instruction: "Look straight at the camera" },
  { key: "left",  label: "Left Face",  instruction: "Slowly turn your head to the LEFT" },
  { key: "right", label: "Right Face →", instruction: "Slowly turn your head to the RIGHT" },
];

function startEditCamera() {
  const video   = document.getElementById("edit-register-video");
  const overlay = document.getElementById("edit-register-overlay");
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: 640, height: 480 } })
    .then(stream => {
      _editAngle.stream = stream;
      video.srcObject = stream;
      if (overlay) overlay.style.display = "none";
      updateEditAngleUI();
    })
    .catch(err => {
      alert("Camera error: " + err.message);
    });
}

function updateEditAngleUI() {
  const idx = _editAngle.index;
  _editAngleDefs.forEach((a, i) => {
    const pill = document.getElementById(`edit-angle-pill-${i}`);
    if (!pill) return;
    if (_editAngle.angleData[a.key]) {
      pill.style.borderColor = "#10b981"; pill.style.color = "#34d399"; pill.style.background = "rgba(16,185,129,0.1)";
    } else if (i === idx) {
      pill.style.borderColor = "#0ea5e9"; pill.style.color = "#38bdf8"; pill.style.background = "rgba(14,165,233,0.1)";
    } else {
      pill.style.borderColor = "#475569"; pill.style.color = "#64748b"; pill.style.background = "";
    }
  });
  const instr = document.getElementById("edit-angle-instruction");
  if (instr && idx < _editAngleDefs.length) instr.textContent = _editAngleDefs[idx].instruction;
  const btn = document.getElementById("edit-capture-angle-btn");
  if (btn && idx < _editAngleDefs.length) btn.textContent = `📸 Capture ${_editAngleDefs[idx].label}`;
  if (idx >= _editAngleDefs.length) {
    const status = document.getElementById("edit-register-status");
    if (status) status.textContent = "✅ All 3 angles captured! Save to update face.";
    if (btn) { btn.textContent = "✅ All Angles Done"; btn.disabled = true; }
  }
}

async function captureEditAngle() {
  const video = document.getElementById("edit-register-video");
  if (!video || !video.srcObject) { alert("Start camera first."); return; }
  const idx = _editAngle.index;
  if (idx >= _editAngleDefs.length) return;
  const angleKey = _editAngleDefs[idx].key;
  const status = document.getElementById("edit-register-status");
  if (status) status.textContent = "Capturing…";
  try {
    const _faceapi = typeof faceapi !== "undefined" ? faceapi : window.faceapi;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const result = await _faceapi
      .detectSingleFace(canvas, new _faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
      .withFaceLandmarks().withFaceDescriptor();
    if (!result) { if (status) status.textContent = "No face detected. Try again."; return; }
    _editAngle.descriptors[angleKey] = [Array.from(result.descriptor)];
    _editAngle.angleData[angleKey] = canvas.toDataURL("image/jpeg", 0.8);
    _editAngle.index++;
    if (status) status.textContent = `✅ ${angleKey} captured!`;
    updateEditAngleUI();
  } catch (err) {
    if (status) status.textContent = "Error: " + err.message;
  }
}

function resetEditAngles() {
  _editAngle.index = 0;
  _editAngle.angleData = { front: null, left: null, right: null };
  _editAngle.descriptors = { front: [], left: [], right: [] };
  const btn = document.getElementById("edit-capture-angle-btn");
  if (btn) { btn.textContent = "📸 Capture Front Face"; btn.disabled = false; }
  updateEditAngleUI();
  const status = document.getElementById("edit-register-status");
  if (status) status.textContent = "";
}

function stopEditCamera() {
  if (_editAngle.stream) {
    _editAngle.stream.getTracks().forEach(t => t.stop());
    _editAngle.stream = null;
  }
}

function saveEditStudent() {
  const id          = document.getElementById("edit-student-id").value;
  const name        = document.getElementById("edit-name").value.trim();
  const roll        = document.getElementById("edit-roll").value.trim();
  const className   = document.getElementById("edit-class").value.trim();
  const studentPhone= document.getElementById("edit-student-phone").value.trim();
  const parentPhone = document.getElementById("edit-parent-phone").value.trim();
  if (!name || !roll || !className || !parentPhone) {
    alert("Name, Roll Number, Class, and Parent Mobile are required.");
    return;
  }
  const idx = state.students.findIndex(s => s.id === id);
  if (idx === -1) { alert("Student not found."); return; }
  // Check if new face was captured
  const allAnglesScanned = _editAngle.angleData.front && _editAngle.angleData.left && _editAngle.angleData.right;
  // Download photo to device, do NOT save base64 to localStorage
  if (allAnglesScanned) {
    autoDownloadPhoto(_editAngle.angleData.front, roll, name);
  }
  const faceUpdate = allAnglesScanned ? {
    facePhoto:      "",
    angleData:      {
      front: { count: _editAngle.descriptors.front.length },
      left:  { count: _editAngle.descriptors.left.length },
      right: { count: _editAngle.descriptors.right.length },
    },
    embeddings:     [
      ..._editAngle.descriptors.front,
      ..._editAngle.descriptors.left,
      ..._editAngle.descriptors.right,
    ],
    embeddingCount: (
      _editAngle.descriptors.front.length +
      _editAngle.descriptors.left.length +
      _editAngle.descriptors.right.length
    ),
  } : {};
  state.students[idx] = {
    ...state.students[idx],
    facePhoto: "",  // always clear any old base64 from memory
    name, roll,
    class: className,
    studentPhone, parentPhone,
    updatedOn: new Date().toISOString(),
    ...faceUpdate,
  };
  state.attendances = state.attendances.map(a =>
    a.studentId === id
      ? { ...a, name, roll, class: className, studentPhone, parentPhone }
      : a
  );
  saveData();
  closeEditModal();
}

// ─── EXPORT CSV ───────────────────────────────────────────────
function exportAttendanceCSV() {
  if (!state.attendances.length) { alert("No attendance records to export."); return; }
  const headers = ["Date", "Time", "Student Name", "Roll No", "Class", "Student Phone", "Parent Phone", "Match %", "WA Sent"];
  const rows = state.attendances.map(r => [
    r.dateLabel    || r.date,
    r.timeLabel    || "",
    r.name, r.roll, r.class,
    r.studentPhone || "",
    r.parentPhone  || "",
    r.matchPercent != null ? `${r.matchPercent}%` : "",
    r.waSent ? "Yes" : "No",
  ]);
  const csvContent = [headers, ...rows]
    .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `attendance_${getLocalDateKey(new Date())}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ─── EXPORT PDF ───────────────────────────────────────────────
function exportAttendancePDF() {
  if (!state.attendances.length) { alert("No attendance records to export."); return; }
  const instituteName = escapeHtml(state.settings.instituteName || "Unacademy Gwalior Branch");
  const exportDate    = formatDateTime(new Date());
  const tableRows = state.attendances.map((r, i) => `
    <tr style="background:${i % 2 === 0 ? "#f8fafc" : "#fff"};">
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.dateLabel || r.date)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.timeLabel || "")}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">${escapeHtml(r.name)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.roll)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(r.class)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#10b981;">${r.matchPercent != null ? r.matchPercent + "%" : "-"}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:${r.waSent?"#10b981":"#94a3b8"};">${r.waSent ? "✅ Sent" : "—"}</td>
    </tr>
  `).join("");
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Attendance Report – ${instituteName}</title>
  <style>body{font-family:'Segoe UI',Arial,sans-serif;color:#1e293b;margin:0;padding:24px;}
  .header{background:linear-gradient(135deg,#0ea5e9,#3b82f6);color:white;border-radius:12px;padding:24px 32px;margin-bottom:24px;}
  .header h1{margin:0 0 4px;font-size:1.8rem;}.header p{margin:0;opacity:0.85;font-size:0.9rem;}
  .meta{display:flex;gap:24px;margin-bottom:20px;font-size:0.88rem;color:#64748b;}
  .meta span{background:#f1f5f9;padding:6px 14px;border-radius:8px;}
  table{width:100%;border-collapse:collapse;font-size:0.88rem;}
  thead tr{background:#0f172a;color:#e2e8f0;}thead th{padding:10px 12px;text-align:left;font-weight:600;}
  tbody tr:hover{background:#f0f9ff!important;}.footer{margin-top:24px;text-align:center;font-size:0.8rem;color:#94a3b8;}
  @media print{body{padding:0;}.no-print{display:none;}}
  </style></head><body>
  <div class="header"><h1>📋 Attendance Report</h1><p>${instituteName}</p></div>
  <div class="meta"><span>📅 Exported: ${exportDate}</span><span>👥 Total Records: ${state.attendances.length}</span><span>🎓 Students: ${state.students.length}</span></div>
  <table><thead><tr><th>Date</th><th>Time</th><th>Student</th><th>Roll No</th><th>Class</th><th>Match %</th><th>WA Sent</th></tr></thead>
  <tbody>${tableRows}</tbody></table>
  <div class="footer">Generated by FaceScan Attendance · ${exportDate}</div>
  <br/><button class="no-print" onclick="window.print()" style="margin:0 auto;display:block;background:#0ea5e9;color:#fff;border:none;padding:12px 28px;border-radius:24px;font-size:1rem;cursor:pointer;font-weight:600;">🖨️ Print / Save as PDF</button>
  </body></html>`;
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const win  = window.open(url, "_blank");
  if (!win) { const a = document.createElement("a"); a.href = url; a.download = `attendance_report_${getLocalDateKey(new Date())}.html`; a.click(); }
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ─── AUTO-DOWNLOAD PHOTO ──────────────────────────────────────
function autoDownloadPhoto(dataUrl, roll, name) {
  try {
    const cleanName = name.trim().replace(/\s+/g, "_");
    const cleanRoll = String(roll).trim().replace(/[^a-zA-Z0-9]/g, "");
    const filename  = `${cleanRoll}_${cleanName}.jpg`;
    const a = document.createElement("a");
    a.href = dataUrl; a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    console.log(`Photo downloaded: ${filename}`);
  } catch (err) { console.warn("Photo auto-download failed:", err); }
}


// ─── Auto Backup Engine ───────────────────────────────────────
const AUTO_BACKUP_KEY = "face-attendance-auto-backup";
let _autoBackupIntervalId = null;
let _autoBackupScheduleId = null;

function loadAutoBackupSettings() {
  try { return JSON.parse(localStorage.getItem(AUTO_BACKUP_KEY) || "{}"); } catch { return {}; }
}
function saveAutoBackupSettings() {
  const cfg = {
    enabled:       document.getElementById("auto-backup-enabled")?.checked || false,
    mode:          document.querySelector("#ab-mode-interval.border-sky-500") ? "interval" : "schedule",
    intervalValue: Number(document.getElementById("ab-interval-value")?.value || 30),
    intervalUnit:  document.getElementById("ab-interval-unit")?.value || "hr",
    times:         getScheduleTimes(),
    typeJson:      document.getElementById("ab-type-json")?.checked !== false,
    typeCsv:       document.getElementById("ab-type-csv")?.checked || false,
  };
  localStorage.setItem(AUTO_BACKUP_KEY, JSON.stringify(cfg));
  rescheduleAutoBackup(cfg);
}

function initAutoBackup() {
  const cfg = loadAutoBackupSettings();
  if (!cfg || Object.keys(cfg).length === 0) return;
  // Restore UI
  const enabledEl = document.getElementById("auto-backup-enabled");
  if (enabledEl) enabledEl.checked = cfg.enabled || false;
  setAutoBackupMode(cfg.mode || "interval", true);
  const iv = document.getElementById("ab-interval-value");
  if (iv) iv.value = cfg.intervalValue || 30;
  const iu = document.getElementById("ab-interval-unit");
  if (iu) iu.value = cfg.intervalUnit || "hr";
  const tj = document.getElementById("ab-type-json");
  if (tj) tj.checked = cfg.typeJson !== false;
  const tc = document.getElementById("ab-type-csv");
  if (tc) tc.checked = cfg.typeCsv || false;
  if (cfg.times && cfg.times.length) {
    cfg.times.forEach(t => addScheduleTime(t));
  }
  if (cfg.enabled) {
    toggleAutoBackup(true, cfg);
  }
  updateLastBackupLabel();
}

function toggleAutoBackup(on, cfg) {
  const opts = document.getElementById("auto-backup-options");
  const lbl  = document.getElementById("auto-backup-status-label");
  if (opts) opts.classList.toggle("opacity-50", !on);
  if (opts) opts.classList.toggle("pointer-events-none", !on);
  if (lbl)  lbl.textContent = on ? "On" : "Off";
  saveAutoBackupSettings();
  if (on) {
    const c = cfg || loadAutoBackupSettings();
    rescheduleAutoBackup(c);
  } else {
    clearAutoBackupTimers();
  }
}

function setAutoBackupMode(mode, silent) {
  const intervalBtn  = document.getElementById("ab-mode-interval");
  const scheduleBtn  = document.getElementById("ab-mode-schedule");
  const intervalSec  = document.getElementById("ab-interval-section");
  const scheduleSec  = document.getElementById("ab-schedule-section");
  const isInterval = mode === "interval";
  if (intervalBtn) {
    intervalBtn.className = `flex-1 text-sm py-2 rounded-2xl border-2 font-semibold ${isInterval ? "border-sky-500 bg-sky-500/10 text-sky-300" : "border-slate-600 text-slate-400"}`;
  }
  if (scheduleBtn) {
    scheduleBtn.className = `flex-1 text-sm py-2 rounded-2xl border-2 font-semibold ${!isInterval ? "border-sky-500 bg-sky-500/10 text-sky-300" : "border-slate-600 text-slate-400"}`;
  }
  if (intervalSec) intervalSec.classList.toggle("hidden", !isInterval);
  if (scheduleSec) scheduleSec.classList.toggle("hidden", isInterval);
  if (!silent) saveAutoBackupSettings();
}

function addScheduleTime(val) {
  const list = document.getElementById("ab-times-list");
  if (!list) return;
  const row = document.createElement("div");
  row.className = "flex items-center gap-2";
  row.innerHTML = `
    <input type="time" value="${val || "08:00"}"
      class="bg-slate-800 border border-slate-700 focus:border-sky-500 rounded-xl px-3 py-2 text-sm outline-none ab-time-input"
      onchange="saveAutoBackupSettings()" />
    <button onclick="this.parentElement.remove();saveAutoBackupSettings()"
      class="text-red-400 text-xs bg-red-400/10 hover:bg-red-400/20 px-2 py-2 rounded-xl">✕</button>
  `;
  list.appendChild(row);
  if (!val) saveAutoBackupSettings();
}

function getScheduleTimes() {
  return Array.from(document.querySelectorAll(".ab-time-input")).map(el => el.value);
}

function clearAutoBackupTimers() {
  if (_autoBackupIntervalId) { clearInterval(_autoBackupIntervalId); _autoBackupIntervalId = null; }
  if (_autoBackupScheduleId) { clearInterval(_autoBackupScheduleId); _autoBackupScheduleId = null; }
}

function rescheduleAutoBackup(cfg) {
  clearAutoBackupTimers();
  if (!cfg.enabled) return;
  if (cfg.mode === "interval") {
    const ms = cfg.intervalUnit === "min"
      ? cfg.intervalValue * 60 * 1000
      : cfg.intervalValue * 60 * 60 * 1000;
    _autoBackupIntervalId = setInterval(() => runAutoBackup(cfg), ms);
  } else {
    // Check every minute if any scheduled time matches now
    _autoBackupScheduleId = setInterval(() => {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      const times = cfg.times || [];
      if (times.includes(hhmm)) runAutoBackup(cfg);
    }, 60 * 1000);
  }
}

function runAutoBackup(cfg) {
  const dateStr = getLocalDateKey(new Date());
  if (cfg.typeJson !== false) {
    const backup = {
      exportedAt: new Date().toISOString(),
      appName: "FaceScan Attendance", version: 2,
      data: {
        settings:   loadJson(STORAGE_KEYS.settings,   {}),
        students:   loadJson(STORAGE_KEYS.students,   []),
        attendance: loadJson(STORAGE_KEYS.attendance, []),
      },
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `auto_backup_${dateStr}_${Date.now()}.json`;
    a.style.display = "none"; document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
  }
  if (cfg.typeCsv) {
    const attendance = loadJson(STORAGE_KEYS.attendance, []);
    if (attendance.length) {
      const headers = ["Date", "Time", "Name", "Roll", "Class", "Match %", "WA Sent"];
      const rows = attendance.map(r => [
        r.dateLabel || r.date, r.timeLabel || "", r.name, r.roll, r.class,
        r.matchPercent != null ? r.matchPercent + "%" : "", r.waSent ? "Yes" : "No",
      ]);
      const csv = [headers, ...rows].map(row => row.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\r\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = `auto_attendance_${dateStr}.csv`;
      a.style.display = "none"; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    }
  }
  localStorage.setItem("face-attendance-last-auto-backup", new Date().toISOString());
  updateLastBackupLabel();
}

function updateLastBackupLabel() {
  const lbl = document.getElementById("ab-last-backup-label");
  if (!lbl) return;
  const ts = localStorage.getItem("face-attendance-last-auto-backup");
  lbl.textContent = ts
    ? "Last auto backup: " + new Date(ts).toLocaleString("en-IN")
    : "Last auto backup: Never";
}

// ─── EXPORT / IMPORT JSON BACKUP ─────────────────────────────
function exportBackup() {
  const backup = {
    exportedAt: new Date().toISOString(),
    appName: "FaceScan Attendance", version: 2,
    data: {
      settings:   loadJson(STORAGE_KEYS.settings,   {}),
      students:   loadJson(STORAGE_KEYS.students,   []),
      attendance: loadJson(STORAGE_KEYS.attendance, []),
    },
  };
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: "application/json;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `facescan_backup_${getLocalDateKey(new Date())}.json`;
  a.style.display = "none";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  alert(`Backup downloaded!\n\nStudents: ${backup.data.students.length}\nAttendance records: ${backup.data.attendance.length}`);
}

function importBackup() {
  const input = document.createElement("input");
  input.type = "file"; input.accept = ".json,application/json";
  input.style.display = "none";
  document.body.appendChild(input);
  input.onchange = (event) => {
    const file = event.target.files?.[0];
    if (!file) { document.body.removeChild(input); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const backup = JSON.parse(e.target.result);
        if (!backup?.data?.students || !backup?.data?.attendance) {
          alert("Invalid backup file."); return;
        }
        const existing = state.students.length;
        if (existing > 0) {
          const exportedOn = backup.exportedAt ? new Date(backup.exportedAt).toLocaleString("en-IN") : "unknown date";
          const ok = confirm(`This will REPLACE your current data!\n\nYour current: ${existing} students\nBackup has: ${backup.data.students.length} students, ${backup.data.attendance.length} records\nBackup date: ${exportedOn}\n\nTap OK to continue.`);
          if (!ok) return;
        }
        if (backup.data.settings && Object.keys(backup.data.settings).length) {
          localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(backup.data.settings));
        }
        localStorage.setItem(STORAGE_KEYS.students,   JSON.stringify(backup.data.students));
        localStorage.setItem(STORAGE_KEYS.attendance, JSON.stringify(backup.data.attendance));
        loadData(); updateDashboardStats(); renderStudentsGrid(); renderAttendanceTable(); renderStaticLabels();
        alert(`Backup restored!\n\nStudents: ${state.students.length}\nAttendance records: ${state.attendances.length}`);
      } catch (err) { alert("Could not read the backup file.\n\nError: " + err.message); }
    };
    reader.readAsText(file);
    document.body.removeChild(input);
  };
  input.click();
}

// ─── Reset / Clear ────────────────────────────────────────────
function clearAllData() {
  if (!confirm("Reset ALL data? This will permanently delete all students and attendance records from this device.")) return;
  Object.values(STORAGE_KEYS).forEach(k => localStorage.removeItem(k));
  state.students             = [];
  state.attendances          = [];
  state.trash                = [];
  state.registerPhoto        = null;
  state.registerDescriptors  = null;
  state.regCollectedDescriptors = [];
  state.regCollectedPhotos   = [];
  state.attendancePhoto      = null;
  state.modalRecord          = null;
  state.isUpdateMode         = false;
  state.angleData            = { front: null, left: null, right: null };
  state.currentAngleIndex    = 0;
  hideModal();
  stopCamera();
  resetRegisterCaptureUi();
  resetAttendanceCaptureUi();
  updateDashboardStats();
  renderStudentsGrid();
  renderAttendanceTable();
  showSection("home");
  alert("All saved data has been cleared.");
}

function resetRegisterCaptureUi(preserveLiveCamera = false) {
  state.registerPhoto       = null;
  state.registerDescriptors = null;
  dom.registerPreview.classList.add("hidden");
  dom.registerPhotoPreview.removeAttribute("src");
  dom.registerStatus.textContent = preserveLiveCamera
    ? "Camera is still live. Press Capture angle buttons when ready."
    : "Start the camera and capture 3 angles: Front → Left → Right.";
  dom.registerOverlay.classList.toggle("hidden",     preserveLiveCamera);
  dom.startRegisterButton.classList.toggle("hidden", preserveLiveCamera);
}

function resetAttendanceCaptureUi() {
  state.attendancePhoto = null;
  resetLiveRecognitionSelection();
  dom.recognitionResult.classList.add("hidden");
  dom.studentMatchList.innerHTML = "";
  dom.attendanceStatus.textContent = "Start the camera to scan a student face.";
  setAttendanceConfirmState(false, "✅ Confirm &amp; Save Attendance");
  syncAttendanceControls(false);
}

function resetLiveRecognitionSelection() {
  state.liveMatches                 = [];
  state.selectedAttendanceStudentId = null;
  state.liveCandidateStudentId      = null;
  state.liveCandidateStableCount    = 0;
  state._lastConfirmedStudentId     = null;
}

// ─── Model loading (lazy, cached) ────────────────────────────
const _modelLoadPromise = { current: null };

async function ensureModels() {
  if (state.modelsLoaded) return;
  if (_modelLoadPromise.current) return _modelLoadPromise.current;
  const _faceapi = typeof faceapi !== "undefined" ? faceapi : window.faceapi;
  if (!_faceapi) {
    throw new Error("Face recognition library did not load. Check your internet connection.");
  }
  _modelLoadPromise.current = (async () => {
    const url = normalizeModelUrl(state.settings.modelUrl);
    await _faceapi.nets.tinyFaceDetector.loadFromUri(url);
    await _faceapi.nets.faceLandmark68Net.loadFromUri(url);
    await _faceapi.nets.faceRecognitionNet.loadFromUri(url);
    state.modelsLoaded = true;
  })();
  return _modelLoadPromise.current;
}

// ─── Face detection helpers ───────────────────────────────────
function captureFrameAsDataUrl(videoElement, canvasElement) {
  canvasElement.width  = videoElement.videoWidth  || 640;
  canvasElement.height = videoElement.videoHeight || 480;
  const ctx = canvasElement.getContext("2d");
  ctx.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
  return canvasElement.toDataURL("image/jpeg", 0.85);
}

// ─── Descriptor math ─────────────────────────────────────────
function averageDescriptors(descriptors) {
  if (!descriptors?.length) return null;
  const len = descriptors[0]?.length || 0;
  if (!len) return null;
  const totals = new Array(len).fill(0);
  descriptors.forEach(d => d.forEach((v, i) => { totals[i] += Number(v); }));
  return totals.map(v => v / descriptors.length);
}

function descriptorDistance(a, b) {
  const left  = Array.from(a);
  const right = Array.from(b);
  if (left.length !== right.length || !left.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < left.length; i++) {
    const d = left[i] - right[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function distanceToPercent(distance) {
  if (distance === null || !isFinite(distance)) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - distance / 0.6) * 100)));
}

function isSelectableMatch(match, threshold) {
  const thr = threshold ?? Number(state.settings.matchThreshold);
  return Boolean(
    match &&
    match.distance !== null &&
    isFinite(match.distance) &&
    match.distance <= thr
  );
}

// ─── Data normalization ───────────────────────────────────────
function normalizeStudent(student) {
  if (!student) return null;
  const deserializeDesc = d => {
    if (!d) return null;
    if (typeof d === "string") return d.split(",").map(Number);
    if (Array.isArray(d)) return d.map(Number);
    return null;
  };
  let descriptors = null;
  if (Array.isArray(student.descriptors) && student.descriptors.length > 0) {
    descriptors = student.descriptors.map(deserializeDesc).filter(Boolean);
  }
  const descriptor = deserializeDesc(student.descriptor);
  return {
    id:           String(student.id || buildStudentId(student.className || student.class, student.roll || student.rollNumber)),
    name:         String(student.name || ""),
    roll:         String(student.roll || student.rollNumber || ""),
    class:        String(student.class || student.className || ""),
    studentPhone: String(student.studentPhone || student.studentMobile || ""),
    parentPhone:  String(student.parentPhone  || student.parentMobile  || ""),
    facePhoto:    "",  // never load base64 photos into memory
    descriptors,
    descriptor,
    embeddingCount: student.embeddingCount || descriptors?.length || (descriptor ? 1 : 0),
    angleData:    student.angleData || null,
    registeredOn: String(student.registeredOn || student.registeredAt || new Date().toISOString()),
    updatedOn:    String(student.updatedOn    || student.updatedAt    || new Date().toISOString()),
  };
}

function normalizeAttendance(record) {
  if (!record) return null;
  const timestamp = record.timestamp || record.scannedAt || new Date().toISOString();
  const date      = new Date(timestamp);
  const stableId  = record.id || record.attendanceId ||
    `ATT-${String(record.studentId || "unknown").replace(/[^a-z0-9]/gi, "")}-${new Date(timestamp).getTime()}`;
  return {
    id:           String(stableId),
    studentId:    String(record.studentId || ""),
    name:         String(record.name      || ""),
    roll:         String(record.roll      || record.rollNumber || ""),
    class:        String(record.class     || record.className  || ""),
    studentPhone: String(record.studentPhone || record.studentMobile || ""),
    parentPhone:  String(record.parentPhone  || record.parentMobile  || ""),
    dateKey:      String(record.dateKey   || record.date       || getLocalDateKey(date)),
    date:         String(record.date      || record.dateKey    || getLocalDateKey(date)),
    timestamp:    String(timestamp),
    dateLabel:    String(record.dateLabel    || formatDate(date)),
    timeLabel:    String(record.timeLabel    || formatTime(date)),
    formattedTime:String(record.formattedTime|| formatDateTime(date)),
    scanPhoto:    "",  // Don't load scan photos to save memory
    matchDistance: record.matchDistance == null ? null : Number(record.matchDistance),
    matchPercent:  record.matchPercent  == null ? null : Number(record.matchPercent),
    syncState:    "local-only",
    waSent:       Boolean(record.waSent),  // FIX #4
  };
}

// ─── Utility ─────────────────────────────────────────────────
function buildStudentId(className, rollNumber) {
  return `${slugify(className)}-${slugify(rollNumber) || Date.now()}`;
}

function normalizeModelUrl(url) {
  const v = url || DEFAULT_SETTINGS.modelUrl;
  return v.endsWith("/") ? v : `${v}/`;
}

function normalizeWhatsappNumber(value) {
  const cleaned = String(value || "").replace(/[^\d+]/g, "");
  if (!cleaned) return "";
  if (cleaned.startsWith("+")) return cleaned.slice(1);
  if (cleaned.length === 10) return `91${cleaned}`;
  return cleaned;
}

function getLocalDateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function formatDate(input) {
  return new Intl.DateTimeFormat("en-IN", { day:"numeric", month:"short", year:"numeric" }).format(new Date(input));
}

function formatTime(input) {
  return new Intl.DateTimeFormat("en-IN", { hour:"2-digit", minute:"2-digit" }).format(new Date(input));
}

function formatDateTime(input) {
  return new Intl.DateTimeFormat("en-IN", {
    day:"numeric", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit",
  }).format(new Date(input));
}

function slugify(value) {
  return String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&",  "&amp;")
    .replaceAll("<",  "&lt;")
    .replaceAll(">",  "&gt;")
    .replaceAll('"',  "&quot;")
    .replaceAll("'",  "&#39;");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Sound feedback ───────────────────────────────────────────
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playSound(type) {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === "suspended") ctx.resume();
    if (type === "match") {
      [[880, 0, 0.12], [1320, 0.13, 0.18]].forEach(([freq, start, end]) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(0.35, ctx.currentTime + start + 0.02);
        gain.gain.linearRampToValueAtTime(0,    ctx.currentTime + end);
        osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + end + 0.01);
      });
    } else if (type === "unknown") {
      [[0, 0.08], [0.12, 0.20]].forEach(([start, end]) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = "square";
        osc.frequency.setValueAtTime(880, ctx.currentTime + start);
        gain.gain.setValueAtTime(0, ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + start + 0.005);
        gain.gain.setValueAtTime(0.25, ctx.currentTime + end - 0.01);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + end);
        osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + end + 0.01);
      });
    } else if (type === "captured") {
      // Three descending tones — clearly "noted/saved" feeling
      [[600, 0, 0.10], [450, 0.12, 0.22], [300, 0.24, 0.38]].forEach(([freq, start, end]) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
        gain.gain.setValueAtTime(0,    ctx.currentTime + start);
        gain.gain.linearRampToValueAtTime(0.30, ctx.currentTime + start + 0.015);
        gain.gain.linearRampToValueAtTime(0,    ctx.currentTime + end);
        osc.start(ctx.currentTime + start); osc.stop(ctx.currentTime + end + 0.01);
      });
    }
  } catch (e) { /* silent */ }
}
