"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Principled BSDF defaults, shown for settings a material doesn't set
const BSDF_DEFAULTS = {
  "Base Color": [0.8, 0.8, 0.8, 1.0],
  "Metallic": 0.0,
  "Roughness": 0.5,
  "IOR": 1.5,
  "Transmission Weight": 0.0,
  "Alpha": 1.0,
  "Emission Color": [1.0, 1.0, 1.0, 1.0],
  "Emission Strength": 0.0,
};

// [key, kind, min, max, step]
const FIELDS = [
  ["Base Color", "color"],
  ["Metallic", "slider", 0, 1, 0.01],
  ["Roughness", "slider", 0, 1, 0.01],
  ["IOR", "number", 1, 5, 0.01],
  ["Transmission Weight", "slider", 0, 1, 0.01],
  ["Alpha", "slider", 0, 1, 0.01],
  ["Emission Color", "color"],
  ["Emission Strength", "slider", 0, 50, 0.5],
];

const NO_MATERIAL_LOOK = { css: "rgb(200,200,200)", opacity: 1, glow: 0 };
const GHOST_COLOR = "rgb(125,133,144)";
const HIGHLIGHT_COLOR = "rgb(255,213,74)";

const state = {
  doc: null,              // GDS summary from the server
  maskSize: 2048,
  masks: new Map(),       // "layer/datatype" -> {canvas, alpha}
  maskGen: 0,             // bumped to drop mask loads for a previous file/size
  comp: null,             // offscreen canvas with every layer stacked and tinted
  tints: new Map(),
  detail: null,           // sharper masks for the zoomed-in area (see updateDetail)
  detailGen: 0,
  detailAbort: null,
  cropMode: false,        // dragging on the canvas draws the crop region
  cropStats: null,        // per-layer counts inside the crop, from the server
  project: emptyProject(),
  selected: null,         // uid of the selected layer
  solo: null,             // uid of the only layer drawn, if any
  hoverRow: null,         // uid of the row under the mouse (highlighted on canvas)
  view: { scale: 1, tx: 0, ty: 0, fitted: false },
  presets: { builtin: {}, user: {}, addon: [] },
  files: { gds: [], yaml: [], projects: [] },
  opts: { glow: true, ghost: true, bg: "#0a0b0d", cropOnly: false, camera: true, sun: true, stackMode: "schematic" },
  renderInfo: null,       // build_gds_scene.py settings and the Blender in use, from the server
  runs: [],               // Blender runs, newest first
  runLogs: new Map(),     // run name -> {lines, next}
  viewRun: null,          // run shown in the Render tab
  ui: { pane: "layout", split: false, stackWidth: null },  // per browser, not per project
  projectPath: null,      // project file this session saves to
  savedGds: null,         // the GDS link from the opened project file
  gdsPath: null,          // GDS path in the project folder (null if uploaded)
  dirty: false,           // changes since the project file was saved
  unexported: false,      // changes since the YAML files were written
  history: { past: [], future: [], current: null },
};
let nextUid = 1;

const PROJECT_EXT = ".gds2blend.json";
const AUTOSAVE_KEY = "gds2blend.autosave";
const HISTORY_LIMIT = 100;

function emptyProject() {
  return {
    stack: { name: "", description: "", def_color: "" },
    scheme: { name: "", description: "" },
    share_materials: false,
    materials: {},
    layers: [],
    crop: null,           // {x, y, w, h} in µm: CROP_REGION in build_gds_scene.py
    render: {},           // build_gds_scene.py settings changed from the script's values
  };
}

const $ = (id) => document.getElementById(id);
const gdsKey = (l) => `${l.index}/${l.type}`;
const layerByUid = (uid) => state.project.layers.find((l) => l.uid === uid);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const fmt = (n) => Number(n).toLocaleString();

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

// ---------------------------------------------------------------------------
// Change tracking: unsaved marker, crash-recovery copy, undo history
// ---------------------------------------------------------------------------

let settleTimer = null;

// Call after every edit. Rapid edits (a slider drag, typing a name) settle
// into one undo step and one autosave half a second after they stop.
function markDirty() {
  state.dirty = state.unexported = true;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 500);
  renderProjectBar();
}

function settle() {
  clearTimeout(settleTimer);
  settleTimer = null;
  commitHistory();
  autosave();
}

const snapshot = () => JSON.stringify(state.project);

function commitHistory() {
  const h = state.history;
  const now = snapshot();
  if (now === h.current) return;
  if (h.current !== null) {
    h.past.push(h.current);
    if (h.past.length > HISTORY_LIMIT) h.past.shift();
  }
  h.current = now;
  h.future = [];
  renderProjectBar();
}

function resetHistory() {
  clearTimeout(settleTimer);
  settleTimer = null;
  state.history = { past: [], future: [], current: snapshot() };
  renderProjectBar();
}

function undoRedo(redo) {
  if (settleTimer) settle();  // an edit still settling counts as its own step
  const h = state.history;
  const from = redo ? h.future : h.past;
  const to = redo ? h.past : h.future;
  if (!from.length) return;
  to.push(h.current);
  h.current = from.pop();
  state.project = JSON.parse(h.current);
  if (!layerByUid(state.selected)) state.selected = null;
  if (!layerByUid(state.solo)) state.solo = null;
  state.dirty = state.unexported = true;
  renderAll();
  autosave();
}

function autosave() {
  if (!state.dirty || recoveryPending) return;
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
      savedAt: Date.now(), projectPath: state.projectPath, data: projectFileData(),
    }));
  } catch (err) { /* storage full or blocked: recovery just isn't available */ }
}

function clearAutosave() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch (err) { /* ignore */ }
}

function renderProjectBar() {
  const name = state.projectPath ? state.projectPath.split("/").pop() : "Untitled project";
  $("project-name").textContent = name;
  $("project-name").title = state.projectPath || "Not saved yet";
  $("dirty-dot").hidden = !state.dirty;
  document.title = `${state.dirty ? "● " : ""}${name} · gds2blend`;
  $("undo-btn").disabled = !state.history.past.length && !settleTimer;
  $("redo-btn").disabled = !state.history.future.length;
}

function notice(content, { kind = "", actions = [], dismissible = true } = {}) {
  const bar = $("notice");
  bar.className = `notice ${kind}`;
  bar.replaceChildren(el("div", {}, ...[content].flat()), el("span", { class: "spacer" }),
    ...actions.map(([label, fn]) => el("button", { type: "button", onclick: () => { hideNotice(); fn(); } }, label)),
    ...(dismissible ? [el("button", { type: "button", title: "Dismiss", onclick: hideNotice }, "✕")] : []));
  bar.hidden = false;
}

function hideNotice() { $("notice").hidden = true; }

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
  return data;
}

const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function status(text, kind = "") {
  const s = $("status");
  s.textContent = text;
  s.title = text;
  s.className = `status ${kind}`;
}

// ---------------------------------------------------------------------------
// Colors: Blender stores linear RGB, the screen wants sRGB
// ---------------------------------------------------------------------------

const lin2srgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

function linToHex(rgb) {
  return "#" + rgb.slice(0, 3)
    .map((c) => Math.round(255 * lin2srgb(clamp01(c))).toString(16).padStart(2, "0")).join("");
}

function hexToLin(hex) {
  return [1, 3, 5].map((i) => +srgb2lin(parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4));
}

const matValue = (m, key) => (key in m ? m[key] : BSDF_DEFAULTS[key]);

// A rough 2D stand-in for how a material renders: emission pulls the color
// toward the emission color, transmission and alpha make it see-through.
function materialLook(m) {
  if (!m) return NO_MATERIAL_LOOK;
  const base = matValue(m, "Base Color");
  const strength = Number(matValue(m, "Emission Strength")) || 0;
  let lin = base.slice(0, 3);
  if (strength > 0) {
    const ec = matValue(m, "Emission Color");
    const t = 1 - Math.exp(-strength / 8);
    lin = lin.map((c, i) => c * (1 - t) + ec[i] * t);
  }
  const rgb = lin.map((c) => Math.round(255 * lin2srgb(clamp01(c))));
  // The add-on copies Base Color's 4th value into Alpha when Alpha isn't set
  const alpha = "Alpha" in m ? m.Alpha : (base[3] ?? 1);
  const transmission = Number(matValue(m, "Transmission Weight")) || 0;
  return {
    css: `rgb(${rgb.join(",")})`,
    opacity: clamp01(alpha * (1 - 0.6 * transmission)),
    glow: Math.min(1, strength / 20),
  };
}

// Swatch with a highlight that gets sharper for smooth metals, so materials
// with the same color still look different in the list
function swatchStyle(m) {
  if (!m) return "";
  const look = materialLook(m);
  const rough = Number(matValue(m, "Roughness"));
  const metal = Number(matValue(m, "Metallic"));
  const hl = (0.12 + 0.5 * (1 - rough) * (0.4 + 0.6 * metal)).toFixed(2);
  const spread = Math.round(35 + 40 * rough);
  return `background: radial-gradient(circle at 30% 25%, rgba(255,255,255,${hl}), transparent ${spread}%), ${look.css};` +
    `opacity: ${Math.max(0.35, look.opacity)}`;
}

// ---------------------------------------------------------------------------
// Loading a GDS and its layer masks
// ---------------------------------------------------------------------------

// gdsPath: where the file lives in the project folder, or null for uploads
// (a project can't reopen those by itself). Returns the summary, or null.
async function openGds(request, label, gdsPath) {
  status(`Reading ${label}…`, "busy");
  try {
    const doc = await request;
    const switched = gdsPath !== state.gdsPath;
    state.gdsPath = gdsPath;
    if (gdsPath) $("gds-select").value = gdsPath;
    const added = setDoc(doc);
    // New rows join the current undo step rather than becoming one: undoing
    // them would only bring them back the next time the file opens
    if (added.length) state.history.current = snapshot();
    if (added.length || switched) {
      state.dirty = true;
      renderProjectBar();
      autosave();
    }
    return doc;
  } catch (err) {
    status(err.message, "error");
    return null;
  }
}

function setDoc(doc) {
  state.doc = doc;
  state.masks.clear();
  state.tints.clear();
  state.comp = null;
  clearDetail();
  state.view.fitted = false;
  const added = addMissingGdsLayers();
  $("empty").hidden = true;
  renderAll();
  loadMasks();
  return added;
}

// Every GDS layer gets a row; ones the stack doesn't mention start unchecked.
// Returns the rows it added.
function addMissingGdsLayers() {
  if (!state.doc) return [];
  const known = new Set(state.project.layers.map(gdsKey));
  const top = state.project.layers.filter((l) => l.include)
    .reduce((t, l) => Math.max(t, (+l.z || 0) + (+l.height || 0)), 0);
  const added = [];
  for (const g of state.doc.layers) {
    const key = `${g.layer}/${g.datatype}`;
    if (known.has(key)) continue;
    const layer = {
      uid: nextUid++, name: `L${g.layer}_${g.datatype}`, index: g.layer, type: g.datatype,
      z: top, height: 0.3, material: null, include: false, extra: {},
    };
    state.project.layers.push(layer);
    added.push(layer);
  }
  return added;
}

async function loadMasks() {
  const doc = state.doc;
  if (!doc) return;
  const gen = ++state.maskGen;
  const size = state.maskSize;
  let done = 0;
  const total = doc.layers.length;
  status(`Drawing layers 0/${total}…`, "busy");

  const results = await Promise.allSettled(doc.layers.map(async (g) => {
    const img = new Image();
    img.src = `/api/gds/${doc.id}/mask/${g.layer}/${g.datatype}.png?size=${size}`;
    await img.decode();
    if (gen !== state.maskGen) return;

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    // Keep just the alpha channel for "which layer is under the mouse"
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const alpha = new Uint8Array(canvas.width * canvas.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
    state.masks.set(`${g.layer}/${g.datatype}`, { canvas, alpha });

    done++;
    status(`Drawing layers ${done}/${total}…`, "busy");
    scheduleComposite();
  }));

  if (gen !== state.maskGen) return;
  const failed = results.filter((r) => r.status === "rejected").length;
  const [x0, y0, x1, y1] = doc.bbox;
  if (failed) {
    status(`${failed} of ${total} layers couldn't be drawn. Try reopening the file.`, "error");
  } else {
    status(`${doc.name} · ${total} layers · ${fmt(Math.round(x1 - x0))} × ${fmt(Math.round(y1 - y0))} µm`);
  }
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

// Bottom of the stack first; the solo layer is drawn even if it's unchecked
function drawOrder() {
  return state.project.layers
    .filter((l) => (state.solo ? l.uid === state.solo : l.include) && state.masks.has(gdsKey(l)))
    .sort((a, b) => (+a.z || 0) - (+b.z || 0) || a.index - b.index || a.type - b.type);
}

function ghostKeys() {
  if (!state.opts.ghost || state.solo) return [];
  const used = new Set(state.project.layers.filter((l) => l.include).map(gdsKey));
  return [...state.masks.keys()].filter((k) => !used.has(k));
}

function tint(key, css, cache) {
  const id = `${key}|${css}`;
  let canvas = state.tints.get(id);
  if (!canvas) {
    const mask = state.masks.get(key).canvas;
    canvas = document.createElement("canvas");
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  cache.set(id, canvas);
  return canvas;
}

let compositePending = false;
function scheduleComposite() {
  if (compositePending) return;
  compositePending = true;
  requestAnimationFrame(() => {
    compositePending = false;
    composite();
  });
}

// Glow blur radius in whole-chip mask pixels
const baseGlowRadius = () => Math.max(2, state.comp.width / 350);

function composite() {
  const first = state.masks.values().next().value;
  if (!first) return draw();
  const { width: w, height: h } = first.canvas;
  if (!state.comp) state.comp = document.createElement("canvas");
  const comp = state.comp;
  if (comp.width !== w || comp.height !== h) { comp.width = w; comp.height = h; }

  const tints = new Map();  // only tints used this frame survive
  paintLayers(comp, (key, css) => tint(key, css, tints), baseGlowRadius());

  // Keep the highlight tints too, so hovering rows doesn't rebuild them
  for (const [id, c] of state.tints) if (id.endsWith(HIGHLIGHT_COLOR)) tints.set(id, c);
  state.tints = tints;
  if (!state.view.fitted) fitView();
  compositeDetail();
  draw();
}

// Stack the drawn layers onto a canvas, bottom first. tintOf(key, css) gives
// that layer's mask filled with a color.
function paintLayers(comp, tintOf, glowRadius) {
  const { width: w, height: h } = comp;
  const ctx = comp.getContext("2d");
  const canFilter = "filter" in ctx;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = state.opts.bg;
  ctx.fillRect(0, 0, w, h);

  for (const layer of drawOrder()) {
    const look = materialLook(state.project.materials[layer.material]);
    const img = tintOf(gdsKey(layer), look.css);
    ctx.globalAlpha = look.opacity;
    ctx.drawImage(img, 0, 0);
    if (state.opts.glow && look.glow > 0 && canFilter) {
      ctx.globalCompositeOperation = "lighter";
      for (const [r, a] of [[glowRadius, 0.8], [glowRadius * 4, 0.5]]) {
        ctx.filter = `blur(${r}px)`;
        ctx.globalAlpha = a * look.glow;
        ctx.drawImage(img, 0, 0);
      }
      ctx.filter = "none";
      ctx.globalCompositeOperation = "source-over";
    }
  }
  ctx.globalAlpha = 0.35;
  for (const key of ghostKeys()) ctx.drawImage(tintOf(key, GHOST_COLOR), 0, 0);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Sharp zoom: when the view is zoomed in past the whole-chip masks, the
// server draws the visible area again at screen resolution
// ---------------------------------------------------------------------------

const DETAIL_MIN_GAIN = 1.25;     // fetch detail once a mask pixel covers this many screen pixels
const DETAIL_MAX_PIXELS = 6e6;    // per layer; the server caps each side at 4096
const DETAIL_MARGIN = 0.25;       // extra area fetched on each side, so small pans don't refetch
let detailTimer = null;

// Layout µm per whole-chip mask pixel, and conversions between the two
function umPerPx() {
  const [x0, y0, x1, y1] = state.doc.bbox;
  return Math.max(x1 - x0, y1 - y0) / state.maskSize;
}
const maskToUm = (mx, my) => [state.doc.bbox[0] + mx * umPerPx(), state.doc.bbox[3] - my * umPerPx()];
const umToMask = (x, y) => [(x - state.doc.bbox[0]) / umPerPx(), (state.doc.bbox[3] - y) / umPerPx()];

// Mask pixel under a mouse event (fractional)
function eventToMask(ev) {
  const rect = $("view").getBoundingClientRect();
  const { scale, tx, ty } = state.view;
  return [(ev.clientX - rect.left - tx) / scale, (ev.clientY - rect.top - ty) / scale];
}

// Largest zoom: about 1 nm per screen pixel
const maxScale = () => Math.max(64, state.doc ? umPerPx() / 0.001 : 64);

function clearDetail() {
  clearTimeout(detailTimer);
  state.detailGen++;
  state.detailAbort?.abort();
  state.detail = null;
  $("detail-badge").hidden = true;
}

function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(updateDetail, 250);
}

// Layers the preview draws right now
const neededKeys = () => [...new Set([...drawOrder().map(gdsKey), ...ghostKeys()])];

async function updateDetail() {
  const doc = state.doc;
  if (!doc || !state.comp) return;
  const canvas = $("view");
  const { scale, tx, ty } = state.view;
  const want = (window.devicePixelRatio || 1) * scale;  // device pixels per mask pixel
  if (want < DETAIL_MIN_GAIN) {
    if (state.detail) { clearDetail(); draw(); }
    return;
  }
  const { width: W, height: H } = state.comp;
  const vis = [Math.max(0, -tx / scale), Math.max(0, -ty / scale),
    Math.min(W, (canvas.clientWidth - tx) / scale), Math.min(H, (canvas.clientHeight - ty) / scale)];
  if (vis[0] >= vis[2] || vis[1] >= vis[3]) return;

  const keys = neededKeys();
  let d = state.detail;
  const covers = d && d.rect[0] <= vis[0] && d.rect[1] <= vis[1] && d.rect[2] >= vis[2] && d.rect[3] >= vis[3] &&
    d.want >= want * 0.8 && d.want <= want * 2;
  let fetchKeys = keys;
  if (covers) {
    fetchKeys = keys.filter((k) => !d.masks.has(k));
    if (!fetchKeys.length) {
      if (d.stale) { compositeDetail(); draw(); }
      return;
    }
  } else {
    // Visible area plus a margin, at screen resolution or as close as the size cap allows
    const mw = (vis[2] - vis[0]) * DETAIL_MARGIN, mh = (vis[3] - vis[1]) * DETAIL_MARGIN;
    const r0 = [Math.max(0, vis[0] - mw), Math.max(0, vis[1] - mh)];
    const rw = Math.min(W, vis[2] + mw) - r0[0], rh = Math.min(H, vis[3] + mh) - r0[1];
    const res = Math.min(want, Math.sqrt(DETAIL_MAX_PIXELS / (rw * rh)), 4096 / rw, 4096 / rh);
    if (res < 1.05) return;  // no sharper than what's on screen already
    const w = Math.max(1, Math.round(rw * res)), h = Math.max(1, Math.round(rh * res));
    d = { rect: [r0[0], r0[1], r0[0] + w / res, r0[1] + h / res], res, want, w, h,
      masks: new Map(), comp: null, stale: true, hl: null };
  }

  const gen = ++state.detailGen;
  state.detailAbort?.abort();
  const abort = state.detailAbort = new AbortController();
  $("detail-badge").hidden = false;
  const [x, y] = maskToUm(d.rect[0], d.rect[1]);
  const upp = umPerPx() / d.res;
  const masks = new Map();
  try {
    await Promise.all(fetchKeys.map(async (key) => {
      const [l, dt] = key.split("/");
      const res = await fetch(`/api/gds/${doc.id}/region/${l}/${dt}.png?x=${x}&y=${y}&upp=${upp}&w=${d.w}&h=${d.h}`,
        { signal: abort.signal });
      if (!res.ok) throw new Error(`${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const c = el("canvas", { width: d.w, height: d.h });
      c.getContext("2d", { willReadFrequently: true }).drawImage(bmp, 0, 0);
      bmp.close();
      masks.set(key, c);
    }));
  } catch (err) {
    if (gen === state.detailGen) $("detail-badge").hidden = true;
    return;  // aborted by a newer view, or the server failed: the whole-chip preview still shows
  }
  if (gen !== state.detailGen || doc !== state.doc) return;
  $("detail-badge").hidden = true;
  for (const [k, c] of masks) d.masks.set(k, c);
  state.detail = d;
  compositeDetail();
  draw();
}

// A reusable canvas for tinting detail masks one at a time
const scratch = document.createElement("canvas");
function tintInto(target, mask, css) {
  if (target.width !== mask.width || target.height !== mask.height) {
    target.width = mask.width;
    target.height = mask.height;
  }
  const ctx = target.getContext("2d");
  ctx.globalCompositeOperation = "copy";
  ctx.drawImage(mask, 0, 0);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.globalCompositeOperation = "source-over";
  return target;
}

function compositeDetail() {
  const d = state.detail;
  if (!d) return;
  if (!neededKeys().every((k) => d.masks.has(k))) {
    // A layer was switched on that the detail doesn't have yet
    d.stale = true;
    scheduleDetail();
    return;
  }
  d.comp ||= el("canvas", { width: d.w, height: d.h });
  // Same glow size on the layout as the whole-chip preview, within reason
  paintLayers(d.comp, (key, css) => tintInto(scratch, d.masks.get(key), css),
    Math.min(32, baseGlowRadius() * d.res));
  d.stale = false;
  d.hl = null;
}

function draw() {
  const canvas = $("view");
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!state.comp) return;

  const { scale, tx, ty } = state.view;
  const crop = state.project.crop && state.doc ? cropScreenRect() : null;
  // Positions are worked out here rather than with a canvas transform, which
  // loses precision at deep zoom
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.save();
  if (crop && state.opts.cropOnly) {
    ctx.beginPath();
    ctx.rect(crop.x, crop.y, crop.w, crop.h);
    ctx.clip();
  }
  const { width: W, height: H } = state.comp;
  // Crisp pixels when zoomed in past 1:1, smooth when zoomed out
  ctx.imageSmoothingEnabled = dpr * scale < 1;
  ctx.drawImage(state.comp, tx, ty, W * scale, H * scale);
  const hover = state.hoverRow && layerByUid(state.hoverRow);
  const hoverKey = hover && gdsKey(hover);
  if (hover && state.masks.has(hoverKey)) {
    ctx.globalAlpha = 0.6;
    ctx.drawImage(tint(hoverKey, HIGHLIGHT_COLOR, state.tints), tx, ty, W * scale, H * scale);
    ctx.globalAlpha = 1;
  }

  const d = state.detail;
  if (d && !d.stale) {
    const [dx, dy] = [d.rect[0] * scale + tx, d.rect[1] * scale + ty];
    const [dw, dh] = [(d.rect[2] - d.rect[0]) * scale, (d.rect[3] - d.rect[1]) * scale];
    ctx.imageSmoothingEnabled = dpr * scale < d.res;
    ctx.drawImage(d.comp, dx, dy, dw, dh);
    if (hover && d.masks.has(hoverKey)) {
      if (d.hl?.key !== hoverKey) {
        d.hl = { key: hoverKey, canvas: tintInto(el("canvas"), d.masks.get(hoverKey), HIGHLIGHT_COLOR) };
      }
      ctx.globalAlpha = 0.6;
      ctx.drawImage(d.hl.canvas, dx, dy, dw, dh);
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  if (crop) drawCrop(ctx, crop, canvas.clientWidth, canvas.clientHeight);
  drawCameraFrame(ctx);
  drawSun(ctx);
}

function fitView() {
  if (!state.comp) return;
  const canvas = $("view");
  const { width: w, height: h } = state.comp;
  const scale = 0.95 * Math.min(canvas.clientWidth / w, canvas.clientHeight / h);
  state.view = {
    scale, fitted: true,
    tx: (canvas.clientWidth - w * scale) / 2,
    ty: (canvas.clientHeight - h * scale) / 2,
  };
  draw();
  scheduleDetail();
}

// Frame a rectangle given in mask pixels
function zoomToRect(x0, y0, x1, y1) {
  const canvas = $("view");
  const scale = Math.min(maxScale(),
    0.9 * Math.min(canvas.clientWidth / (x1 - x0), canvas.clientHeight / (y1 - y0)));
  state.view = {
    scale, fitted: false,
    tx: canvas.clientWidth / 2 - scale * (x0 + x1) / 2,
    ty: canvas.clientHeight / 2 - scale * (y0 + y1) / 2,
  };
  draw();
  scheduleDetail();
}

// Mask pixel and layout coordinates (µm) under a mouse event
function pointerInfo(ev) {
  if (!state.comp || !state.doc) return null;
  const [mx, my] = eventToMask(ev);
  const { width: w, height: h } = state.comp;
  if (mx < 0 || my < 0 || mx >= w || my >= h) return null;

  const [x, y] = maskToUm(mx, my);
  const info = { x, y, layer: null, ghost: null };
  const d = state.detail;
  let hit;
  if (d && !d.stale && mx >= d.rect[0] && my >= d.rect[1] && mx < d.rect[2] && my < d.rect[3]) {
    const dx = Math.floor((mx - d.rect[0]) * d.res), dy = Math.floor((my - d.rect[1]) * d.res);
    hit = (key) => d.masks.get(key)?.getContext("2d", { willReadFrequently: true })
      .getImageData(dx, dy, 1, 1).data[3] > 0;
  } else {
    const px = Math.floor(mx), py = Math.floor(my);
    hit = (key) => state.masks.get(key).alpha[py * w + px] > 0;
  }
  info.layer = drawOrder().reverse().find((l) => hit(gdsKey(l))) || null;
  if (!info.layer) info.ghost = ghostKeys().find(hit) || null;
  return info;
}

function bindCanvas() {
  const canvas = $("view");
  let drag = null;
  let spaceDown = false;  // Space-drag pans while the crop tool is on

  canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    if (!state.comp) return;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const v = state.view;
    const scale = Math.min(maxScale(), Math.max(0.02, v.scale * Math.exp(-ev.deltaY * 0.0015)));
    const f = scale / v.scale;
    state.view = { scale, fitted: false, tx: mx - (mx - v.tx) * f, ty: my - (my - v.ty) * f };
    draw();
    scheduleDetail();
  }, { passive: false });

  canvas.addEventListener("pointerdown", (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    if (!state.cropMode && ev.button === 0 && sunHandleAt(ev)) {
      drag = { sun: true, moved: false };
      canvas.style.cursor = "grabbing";
      return;
    }
    if (state.cropMode && !spaceDown && ev.button === 0 && state.doc) {
      const handle = cropHandleAt(ev);
      drag = { crop: handle || "new", start: eventToUm(ev), orig: state.project.crop, moved: false };
      return;
    }
    drag = { x: ev.clientX, y: ev.clientY, moved: false };
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (drag?.sun) {
      drag.moved = true;
      dragSun(ev);
      return;
    }
    if (drag?.crop) {
      drag.moved = true;
      const crop = dragCrop(drag, eventToUm(ev), !ev.altKey);
      if (crop) {
        state.project.crop = crop;
        markDirty();
        renderCropPanel();
        draw();
      }
      return;
    }
    if (drag) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (drag.moved || Math.abs(dx) + Math.abs(dy) > 3) {
        drag.moved = true;
        canvas.classList.add("dragging");
        state.view.tx += dx;
        state.view.ty += dy;
        state.view.fitted = false;
        drag.x = ev.clientX;
        drag.y = ev.clientY;
        draw();
      }
      return;
    }
    canvas.style.cursor = state.cropMode && !spaceDown ? CROP_CURSORS[cropHandleAt(ev)] || "crosshair" :
      sunHandleAt(ev) ? "grab" : "";
    const info = pointerInfo(ev);
    let text = "";
    if (info) {
      // Enough decimals to tell neighbouring screen pixels apart
      const digits = Math.min(4, Math.max(1, Math.ceil(-Math.log10(umPerPx() / state.view.scale))));
      text = `x ${info.x.toFixed(digits)}  y ${info.y.toFixed(digits)} µm`;
      if (info.layer) text += `  ·  ${info.layer.name} (${gdsKey(info.layer)})`;
      else if (info.ghost) text += `  ·  ${info.ghost} (not in stack)`;
    }
    $("readout").textContent = text;
  });
  canvas.addEventListener("pointerup", (ev) => {
    canvas.classList.remove("dragging");
    const done = drag;
    drag = null;
    if (!done) return;
    if (done.sun) {
      canvas.style.cursor = "grab";
      if (done.moved && settleTimer) settle();  // one undo step per drag
      return;
    }
    if (done.crop) {
      if (done.moved && settleTimer) settle();  // each drag is one undo step
      return;
    }
    if (done.moved) return scheduleDetail();
    if (state.cropMode) return;
    // Clicking a shape selects its layer
    const info = pointerInfo(ev);
    const layer = info && (info.layer ||
      (info.ghost && state.project.layers.find((l) => gdsKey(l) === info.ghost)));
    if (layer) selectLayer(layer.uid, true);
  });
  canvas.addEventListener("pointerleave", () => { $("readout").textContent = ""; });
  canvas.addEventListener("dblclick", () => { if (!state.cropMode) fitView(); });
  new ResizeObserver(() => {
    if (state.view.fitted) fitView();
    else { draw(); scheduleDetail(); }
  }).observe($("canvas-wrap"));

  const typing = (t) => t.matches?.("input, select, textarea");
  document.addEventListener("keydown", (ev) => {
    if (!state.cropMode || typing(ev.target) || document.querySelector("dialog[open]")) return;
    if (ev.key === "Escape") setCropMode(false);
    if (ev.key === " ") {
      ev.preventDefault();
      if (ev.target.matches?.("button")) ev.target.blur();  // or Space would press it
      if (!spaceDown) { spaceDown = true; canvas.style.cursor = "grab"; }
    }
  });
  document.addEventListener("keyup", (ev) => {
    if (ev.key === " ") { spaceDown = false; canvas.style.cursor = ""; }
  });
}

// ---------------------------------------------------------------------------
// Crop region (CROP_REGION in build_gds_scene.py): x, y of the lower-left
// corner plus width and height, in layout µm. The add-on imports only that
// rectangle and moves its lower-left corner to Blender's origin.
// ---------------------------------------------------------------------------

const CROP_CURSORS = {
  move: "move", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
  nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
};

function eventToUm(ev) {
  const [mx, my] = eventToMask(ev);
  return maskToUm(mx, my);
}

// Crop rectangle in screen (CSS) pixels
function cropScreenRect() {
  const { x, y, w, h } = state.project.crop;
  const { scale, tx, ty } = state.view;
  const [mx0, my0] = umToMask(x, y + h);
  const [mx1, my1] = umToMask(x + w, y);
  return { x: mx0 * scale + tx, y: my0 * scale + ty, w: (mx1 - mx0) * scale, h: (my1 - my0) * scale };
}

// Which part of the crop is under the mouse: a corner or edge ("nw", "e", …),
// "move" for the inside, or null
function cropHandleAt(ev) {
  if (!state.project.crop || !state.doc) return null;
  const r = cropScreenRect();
  const bounds = $("view").getBoundingClientRect();
  const px = ev.clientX - bounds.left, py = ev.clientY - bounds.top;
  const near = 6;
  if (px < r.x - near || px > r.x + r.w + near || py < r.y - near || py > r.y + r.h + near) return null;
  const v = Math.abs(py - r.y) <= near ? "n" : Math.abs(py - (r.y + r.h)) <= near ? "s" : "";
  const h = Math.abs(px - r.x) <= near ? "w" : Math.abs(px - (r.x + r.w)) <= near ? "e" : "";
  return v + h || "move";
}

// Grid the crop snaps to: a round number of µm about 5 screen pixels or more
function cropSnapStep() {
  const umPerScreenPx = umPerPx() / state.view.scale;
  const target = umPerScreenPx * 5;
  const p = Math.pow(10, Math.floor(Math.log10(target)));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= target);
}

const roundUm = (v) => Math.round(v * 1000) / 1000;

// The crop while dragging, worked out from where the drag started so it
// never drifts. Returns null while a new crop is still too small.
function dragCrop(drag, [px, py], snapOn) {
  const step = snapOn ? cropSnapStep() : 0.001;
  const snap = (v) => roundUm(Math.round(v / step) * step);
  let l, r, b, t;
  if (drag.crop === "new" || !drag.orig) {
    [l, r] = [snap(drag.start[0]), snap(px)].sort((a, c) => a - c);
    [b, t] = [snap(drag.start[1]), snap(py)].sort((a, c) => a - c);
    if (r - l < minCrop() || t - b < minCrop()) return null;
    return { x: l, y: b, w: roundUm(r - l), h: roundUm(t - b) };
  }
  const o = drag.orig;
  [l, r, b, t] = [o.x, o.x + o.w, o.y, o.y + o.h];
  if (drag.crop === "move") {
    l = snap(o.x + px - drag.start[0]);
    b = snap(o.y + py - drag.start[1]);
    return { x: l, y: b, w: o.w, h: o.h };
  }
  if (drag.crop.includes("w")) l = snap(px);
  if (drag.crop.includes("e")) r = snap(px);
  if (drag.crop.includes("s")) b = snap(py);
  if (drag.crop.includes("n")) t = snap(py);
  [l, r] = [l, r].sort((a, c) => a - c);
  [b, t] = [b, t].sort((a, c) => a - c);
  const min = minCrop();
  return { x: roundUm(l), y: roundUm(b), w: roundUm(Math.max(min, r - l)), h: roundUm(Math.max(min, t - b)) };
}

function drawCrop(ctx, r, cw, ch) {
  if (!state.opts.cropOnly) {
    // Dim everything outside the crop
    ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
    ctx.beginPath();
    ctx.rect(0, 0, cw, ch);
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.fill("evenodd");
  }
  ctx.strokeStyle = "#5b9dff";
  ctx.lineWidth = 1.5;
  ctx.setLineDash(state.cropMode ? [] : [6, 4]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  if (state.cropMode) {
    ctx.fillStyle = "#5b9dff";
    for (const fx of [0, 0.5, 1]) {
      for (const fy of [0, 0.5, 1]) {
        if (fx === 0.5 && fy === 0.5) continue;
        ctx.fillRect(r.x + fx * r.w - 4, r.y + fy * r.h - 4, 8, 8);
      }
    }
  }
  const { w, h } = state.project.crop;
  const label = `${fmtUm(w)} × ${fmtUm(h)} µm`;
  ctx.font = "12px ui-monospace, Menlo, monospace";
  const tw = ctx.measureText(label).width;
  // Above the box, unless the view tools are in the way; then below it
  const ly = r.y > 70 ? r.y - 20 : r.y + r.h + 20 < ch ? r.y + r.h + 3 : r.y + 4;
  ctx.fillStyle = "rgba(18, 20, 24, 0.85)";
  ctx.fillRect(r.x, ly, tw + 10, 17);
  ctx.fillStyle = "#e3e6ea";
  ctx.fillText(label, r.x + 5, ly + 12.5);
}

const fmtUm = (v) => Number(roundUm(v)).toLocaleString(undefined, { maximumFractionDigits: 3 });
// Python float literal: always has a decimal point
const pyFloat = (v) => { const t = String(roundUm(v)); return /[.e]/.test(t) ? t : `${t}.0`; };
const cropLine = (c) => `CROP_REGION = (${[c.x, c.y, c.w, c.h].map(pyFloat).join(", ")})`;

function setCropMode(on) {
  state.cropMode = on;
  for (const id of ["crop-btn", "crop-draw"]) $(id).classList.toggle("on", on);
  $("crop-hint").hidden = !on;
  $("view").style.cursor = "";
  if (on) $("crop-section").open = true;
  draw();
}

function setCrop(crop) {
  state.project.crop = crop;
  markDirty();
  renderCropPanel();
  renderLayerList();
  draw();
}

function zoomToCrop() {
  const c = state.project.crop;
  if (!c || !state.doc) return;
  const [x0, y0] = umToMask(c.x, c.y + c.h);
  const [x1, y1] = umToMask(c.x + c.w, c.y);
  zoomToRect(x0, y0, x1, y1);
}

const CROP_FIELDS = [["crop-x", "x"], ["crop-y", "y"], ["crop-w", "w"], ["crop-h", "h"]];

function renderCropPanel() {
  const c = state.project.crop;
  for (const [id, key] of CROP_FIELDS) {
    // Leave the field being typed in alone
    if (document.activeElement !== $(id)) $(id).value = c ? roundUm(c[key]) : "";
  }
  $("crop-summary").textContent = c ? `${fmtUm(c.w)} × ${fmtUm(c.h)} µm` : "whole chip";
  $("crop-line").textContent = c ? cropLine(c) : "CROP_REGION = None";
  for (const id of ["crop-zoom", "crop-clear"]) $(id).disabled = !c;
  $("crop-draw").disabled = $("crop-btn").disabled = !state.doc;
  updateCropStats();
}

// Counts inside the crop come from the server; fetched when the crop or the
// GDS changes, then shown in the layer rows
let cropStatsTimer = null;
let cropStatsFor = null;
function updateCropStats() {
  const c = state.project.crop;
  const key = c && state.doc ? `${state.doc.id}|${c.x}|${c.y}|${c.w}|${c.h}` : null;
  if (key === cropStatsFor) return renderCropTotals();
  cropStatsFor = key;
  state.cropStats = null;
  clearTimeout(cropStatsTimer);
  renderCropTotals();
  if (!key) return;
  cropStatsTimer = setTimeout(async () => {
    $("crop-totals").textContent = "Counting shapes in the crop…";
    try {
      const { layers } = await post(`/api/gds/${state.doc.id}/crop-stats`, c);
      if (cropStatsFor !== key) return;
      state.cropStats = new Map(layers.map((g) => [`${g.layer}/${g.datatype}`, g]));
    } catch (err) {
      if (cropStatsFor === key) $("crop-totals").textContent = `Couldn't count shapes: ${err.message}`;
      return;
    }
    renderLayerList();
    renderCropTotals();
  }, 400);
}

function renderCropTotals() {
  const box = $("crop-totals");
  if (!state.project.crop || !state.doc) return box.replaceChildren();
  if (!state.cropStats) return;
  const included = state.project.layers.filter((l) => l.include && state.cropStats.has(gdsKey(l)));
  const stats = included.map((l) => state.cropStats.get(gdsKey(l)));
  const polys = stats.reduce((n, g) => n + g.polygons, 0);
  const verts = stats.reduce((n, g) => n + g.vertices, 0);
  const warn = included.filter((l) => state.cropStats.get(gdsKey(l)).vertex_warning);
  const unmerged = included.filter((l) => !state.cropStats.get(gdsKey(l)).merged);
  box.replaceChildren(...[
    el("div", {}, `Checked layers inside the crop: ${fmt(polys)} shapes, ${fmt(verts)} vertices.`),
    warn.length ? el("div", { class: "warn" },
      `⚠ ${warn.map((l) => l.name).join(", ")}: shapes over 1000 vertices after cropping.`) : null,
    unmerged.length ? el("div", {},
      `${unmerged.map((l) => l.name).join(", ")}: too many shapes to merge here, so counts are before the add-on merges touching shapes.`) : null,
  ].filter(Boolean));
}

// ---------------------------------------------------------------------------
// Layer list
// ---------------------------------------------------------------------------

function sortedLayers() {
  // Included layers top of stack first, then the unused ones by GDS number
  return [...state.project.layers].sort((a, b) =>
    (b.include - a.include) ||
    (a.include ? (+b.z || 0) - (+a.z || 0) : 0) ||
    a.index - b.index || a.type - b.type);
}

function materialOptions(selected) {
  const opts = [el("option", { value: "" }, "— no material —")];
  const names = Object.keys(state.project.materials);
  if (names.length) {
    opts.push(el("optgroup", { label: "Materials" },
      ...names.map((n) => el("option", { value: n, selected: n === selected }, n))));
  }
  const presetOpts = (kind) => Object.keys(state.presets[kind])
    .map((p) => el("option", { value: `${kind}:${p}` }, p));
  opts.push(el("optgroup", { label: "New from preset" }, ...presetOpts("builtin")));
  if (Object.keys(state.presets.user).length) {
    opts.push(el("optgroup", { label: "My presets" }, ...presetOpts("user")));
  }
  opts.push(el("optgroup", { label: "More" },
    el("option", { value: "browse:" }, "Browse all presets…"),
    el("option", { value: "new:" }, "Blank material")));
  return opts;
}

function renderLayerList() {
  const list = $("layer-list");
  list.replaceChildren();
  if (!state.project.layers.length) {
    list.append(el("div", { class: "hint", style: "padding: 8px 12px" },
      "Open a GDS or OASIS file, or import YAML files, to list layers."));
    return;
  }
  const stats = new Map((state.doc?.layers || []).map((g) => [`${g.layer}/${g.datatype}`, g]));

  for (const layer of sortedLayers()) {
    const g = stats.get(gdsKey(layer));
    const mat = state.project.materials[layer.material];
    const row = el("div", {
      class: `layer${layer.uid === state.selected ? " selected" : ""}${layer.include ? "" : " excluded"}`,
      "data-uid": layer.uid,
      onclick: (ev) => { if (!ev.target.closest("input, select, button")) selectLayer(layer.uid); },
      onmouseenter: () => { state.hoverRow = layer.uid; draw(); },
      onmouseleave: () => { state.hoverRow = null; draw(); },
    });

    const include = el("input", {
      type: "checkbox", checked: layer.include, title: "Include in the YAML files",
      onchange: () => { layer.include = include.checked; markDirty(); refreshLayers(); },
    });
    const swatch = el("div", { class: `swatch${mat ? "" : " none"}`, style: swatchStyle(mat) });
    const name = el("input", {
      class: "name", value: layer.name, spellcheck: "false",
      onfocus: () => selectLayer(layer.uid, false, false),
      oninput: () => { layer.name = name.value; markDirty(); renderStack(); renderMaterialUsers(); },
      onchange: () => {
        if (!layer.include && name.value.trim()) { layer.include = true; refreshLayers(); }
      },
    });
    const matSel = el("select", {
      class: "mat", title: "Material",
      onchange: () => assignMaterial(layer, matSel.value),
    }, ...materialOptions(layer.material));
    const solo = el("button", {
      class: `solo${state.solo === layer.uid ? " on" : ""}`, title: "Show only this layer",
      onclick: () => { state.solo = state.solo === layer.uid ? null : layer.uid; refreshLayers(); },
    }, "◉");

    const num = (key, label) => {
      const input = el("input", {
        type: "number", step: "any", value: layer[key], title: `${label} (µm, before Z_SCALE)`,
        onfocus: () => selectLayer(layer.uid, false, false),
        oninput: () => {
          layer[key] = input.value === "" ? null : Number(input.value);
          markDirty(); renderStack(); scheduleComposite();
        },
        // Re-sort once editing is done, not while typing
        onchange: () => renderLayerList(),
      });
      return [label, input];
    };

    let info;
    if (!state.doc) info = null;
    else if (!g) info = el("span", { class: "missing" }, "not in this GDS");
    else {
      // With a crop set, count what the add-on will import from inside it
      const c = state.project.crop && state.cropStats?.get(gdsKey(layer));
      const shown = c || g;
      info = el("span", {}, c ? `${fmt(c.polygons)} of ${fmt(g.polygons)} polys in crop` : `${fmt(g.polygons)} polys`);
      if (shown.vertex_warning && !(splitsPolygons() && !c)) {
        info = [info, el("span", {
          class: "warn",
          title: c ? "After cropping (which merges touching shapes), this layer has polygons this big. Polygons this big make the Blender import slow or crash."
            : "Polygons this big make the Blender import slow or crash. Turn on \"Split polygons\" in the Render settings, or re-save the GDS in KLayout with a lower max vertex count.",
        }, `⚠ max ${fmt(shown.max_vertices)} pts`)];
      }
    }

    row.append(include, swatch, name, matSel, solo,
      el("div", { class: "meta-line" },
        el("span", { class: "gds", title: "GDS layer/datatype" }, gdsKey(layer)),
        ...num("z", "z"), ...num("height", "h"), ...[info].flat()));
    list.append(row);
  }
}

function selectLayer(uid, scrollIntoView = false, rerenderList = true) {
  if (state.selected === uid) return;
  state.selected = uid;
  if (rerenderList) renderLayerList();
  else {
    for (const row of document.querySelectorAll(".layer")) {
      row.classList.toggle("selected", +row.dataset.uid === uid);
    }
  }
  if (scrollIntoView) {
    document.querySelector(`.layer[data-uid="${uid}"]`)?.scrollIntoView({ block: "nearest" });
  }
  renderMaterialEditor();
  renderStack();
}

// Refresh everything that depends on layers (not the material editor fields,
// so it doesn't steal focus while you type)
function refreshLayers() {
  renderLayerList();
  renderRenderSettings();  // the hide-layers list
  renderStack();
  renderMaterialUsers();
  scheduleComposite();
}

function refreshSwatches() {
  for (const row of document.querySelectorAll(".layer")) {
    const layer = layerByUid(+row.dataset.uid);
    const sw = row.querySelector(".swatch");
    const mat = state.project.materials[layer.material];
    sw.className = `swatch${mat ? "" : " none"}`;
    sw.style.cssText = swatchStyle(mat);
  }
  const head = document.querySelector(".mat-head .swatch");
  const layer = layerByUid(state.selected);
  if (head && layer) head.style.cssText = swatchStyle(state.project.materials[layer.material]);
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function uniqueMaterialName(base) {
  const clean = base.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "Material";
  let name = clean, n = 2;
  while (name in state.project.materials) name = `${clean}_${n++}`;
  return name;
}

function addMaterial(baseName, props) {
  const name = uniqueMaterialName(baseName);
  state.project.materials[name] = structuredClone(props);
  return name;
}

function assignMaterial(layer, value) {
  // Option values are a material name, or "<kind>:<preset>" for the extras.
  // The editor keeps ":" out of material names it creates or renames.
  const colon = value.indexOf(":");
  const kind = colon < 0 ? null : value.slice(0, colon);
  const rest = value.slice(colon + 1);
  if (kind === "browse") {
    selectLayer(layer.uid);
    renderLayerList();  // puts the dropdown back on the current material
    openPresetBrowser();
    return;
  }
  if (kind === "builtin" || kind === "user") {
    value = addMaterial(rest, state.presets[kind][rest]);
  } else if (value === "new:") {
    const name = uniqueMaterialName(layer.name || "Material");
    state.project.materials[name] = structuredClone(BSDF_DEFAULTS);
    state.project.materials[name]["Emission Strength"] = 0;
    value = name;
  }
  layer.material = value || null;
  if (layer.material) layer.include = true;
  markDirty();
  state.selected = layer.uid;
  refreshLayers();
  renderMaterialEditor();
}

function materialUsers(name) {
  return state.project.layers.filter((l) => l.material === name);
}

function renderMaterialUsers() {
  const layer = layerByUid(state.selected);
  const users = layer?.material ? materialUsers(layer.material) : [];
  $("mat-users").textContent = users.length > 1
    ? `shared by ${users.map((l) => l.name || gdsKey(l)).join(", ")}` : "";
}

function renderMaterialEditor() {
  const box = $("mat-editor");
  box.replaceChildren();
  renderMaterialUsers();
  const layer = layerByUid(state.selected);
  if (!layer) {
    box.append(el("div", { class: "empty-msg" }, "Select a layer to edit its material."));
    return;
  }
  const matName = layer.material;
  const mat = state.project.materials[matName];
  if (!mat) {
    box.append(el("div", { class: "empty-msg" },
      `${layer.name || gdsKey(layer)} has no material. Pick one from its dropdown, or start from a preset.`));
    return;
  }

  const changed = () => { markDirty(); refreshSwatches(); renderStack(); scheduleComposite(); };

  const nameInput = el("input", {
    value: matName, spellcheck: "false", title: "Material name",
    onchange: () => {
      const next = nameInput.value.trim();
      if (!next || next === matName) { nameInput.value = matName; return; }
      if (next.includes(":")) {
        status("Material names can't contain \":\".", "error");
        nameInput.value = matName;
        return;
      }
      if (next in state.project.materials) {
        status(`A material named ${next} already exists.`, "error");
        nameInput.value = matName;
        return;
      }
      // Rebuild the map so the renamed material keeps its position
      state.project.materials = Object.fromEntries(Object.entries(state.project.materials)
        .map(([k, v]) => [k === matName ? next : k, v]));
      for (const l of materialUsers(matName)) l.material = next;
      markDirty();
      refreshLayers();
      renderMaterialEditor();
    },
  });
  box.append(el("div", { class: "mat-head" },
    el("div", { class: "swatch", style: swatchStyle(mat) }), nameInput));

  for (const [key, kind, min, max, step] of FIELDS) {
    const row = el("div", { class: `field${key in mat ? "" : " dim"}`,
      title: key in mat ? "" : "Not set in this material; showing Blender's default" });
    const set = (value) => { mat[key] = value; row.classList.remove("dim"); row.title = ""; changed(); };
    row.append(el("span", {}, key));

    if (kind === "color") {
      const value = matValue(mat, key);
      const picker = el("input", { type: "color", value: linToHex(value) });
      const text = el("input", { type: "text", value: value.join(", "), spellcheck: "false",
        title: "Linear RGBA, as written to the YAML" });
      picker.addEventListener("input", () => {
        const next = [...hexToLin(picker.value), matValue(mat, key)[3] ?? 1];
        text.value = next.join(", ");
        set(next);
      });
      text.addEventListener("change", () => {
        const nums = text.value.split(/[\s,]+/).filter(Boolean).map(Number);
        if ((nums.length !== 3 && nums.length !== 4) || nums.some((n) => !Number.isFinite(n))) {
          text.value = matValue(mat, key).join(", ");
          return;
        }
        if (nums.length === 3) nums.push(1);
        picker.value = linToHex(nums);
        set(nums);
      });
      row.append(el("div", { class: "color-row" }, picker, text));
    } else {
      const value = matValue(mat, key);
      const number = el("input", { type: "number", min, step, value });
      if (kind === "slider") {
        const range = el("input", { type: "range", min, max, step, value });
        range.addEventListener("input", () => { number.value = range.value; set(Number(range.value)); });
        number.addEventListener("input", () => {
          if (number.value === "") return;
          range.value = number.value;
          set(Number(number.value));
        });
        row.append(range, number);
      } else {
        number.addEventListener("input", () => { if (number.value !== "") set(Number(number.value)); });
        row.append(el("span"), number);
      }
    }
    box.append(row);
  }

  const extra = Object.keys(mat).filter((k) => !(k in BSDF_DEFAULTS));
  if (extra.length) {
    box.append(el("div", { class: "extra-keys" },
      `Also kept as is: ${extra.join(", ")}`));
  }
  if (!Number(matValue(mat, "Emission Strength"))) {
    box.append(el("div", { class: "hint" }, "Emission is left out of the YAML while its strength is 0."));
  }

  const actions = el("div", { class: "mat-actions" });
  const saveForm = el("div", { class: "save-preset", hidden: true });
  actions.append(el("button", {
    type: "button", title: "Keep this material in My presets, for other projects too",
    onclick: () => {
      saveForm.hidden = !saveForm.hidden;
      if (!saveForm.hidden) renderSavePresetForm(saveForm, mat, matName);
    },
  }, "Save as preset…"));
  if (materialUsers(matName).length > 1) {
    actions.append(el("button", {
      type: "button", title: "Give this layer its own copy to edit separately",
      onclick: () => {
        const copy = uniqueMaterialName(layer.name || matName);
        state.project.materials[copy] = structuredClone(mat);
        layer.material = copy;
        markDirty();
        refreshLayers();
        renderMaterialEditor();
      },
    }, "Make a copy for this layer"));
  }
  const unused = Object.keys(state.project.materials).filter((m) => !materialUsers(m).length);
  if (unused.length) {
    actions.append(el("button", {
      type: "button", title: unused.join(", "),
      onclick: () => {
        for (const m of unused) delete state.project.materials[m];
        markDirty();
        refreshLayers();
        renderMaterialEditor();
      },
    }, `Remove ${unused.length} unused material${unused.length > 1 ? "s" : ""}`));
  }
  box.append(actions, saveForm);
}

function renderSavePresetForm(form, mat, defaultName) {
  const input = el("input", { value: defaultName, spellcheck: "false", placeholder: "Preset name" });
  const msg = el("span", { class: "hint" });
  const save = async (overwrite) => {
    const name = input.value.trim();
    try {
      const res = await post("/api/presets/user", { name, material: mat, overwrite });
      if (res.exists) {
        msg.replaceChildren(`"${name}" exists. `,
          el("button", { type: "button", onclick: () => save(true) }, "Replace"));
        return;
      }
      state.presets.user = res.user;
      form.replaceChildren(el("span", { class: "hint" }, `Saved "${name}" to My presets.`));
      renderLayerList();
    } catch (err) {
      msg.textContent = err.message;
    }
  };
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") save(false); });
  form.replaceChildren(input, el("button", { type: "button", onclick: () => save(false) }, "Save"), msg);
  input.select();
}

// ---------------------------------------------------------------------------
// Preset browser
// ---------------------------------------------------------------------------

function presetGroups() {
  return [
    { group: "My presets", kind: "user", presets: state.presets.user, open: true },
    { group: "Built-in", kind: "builtin", presets: state.presets.builtin, open: true },
    ...state.presets.addon.map((g) => ({ ...g, kind: "addon", open: false })),
  ];
}

function openPresetBrowser() {
  showMsgs($("presets-msgs"), []);
  $("presets-search").value = "";
  $("mats-from-file").value = "";
  renderPresetBrowser();
  $("presets-dlg").showModal();
  $("presets-search").focus();
}

function renderPresetBrowser() {
  const layer = layerByUid(state.selected);
  $("presets-target").textContent = layer
    ? `Click a preset to use it for ${layer.name || gdsKey(layer)}.`
    : "Click a preset to add it to this project's materials.";
  const query = $("presets-search").value.trim().toLowerCase();
  const body = $("presets-body");
  body.replaceChildren();

  for (const g of presetGroups()) {
    const names = Object.keys(g.presets).filter((n) =>
      !query || n.toLowerCase().includes(query) || g.group.toLowerCase().includes(query));
    if (!names.length && !(g.kind === "user" && !query)) continue;
    const grid = el("div", { class: "preset-grid" });
    if (!names.length) {
      grid.append(el("div", { class: "hint" }, "None yet. Use \"Save as preset…\" in the material editor."));
    }
    for (const name of names) grid.append(presetCard(g, name));
    body.append(el("details", { class: "preset-group", open: g.open || !!query },
      el("summary", {}, g.group, el("span", { class: "hint" }, `${names.length}`)), grid));
  }
  if (!body.children.length) body.append(el("div", { class: "hint" }, "No presets match."));
  if (!state.presets.addon.length && !query) {
    body.append(el("div", { class: "hint" },
      "The BlenderGDS add-on's color schemes weren't found, so only these presets are listed."));
  }
}

function presetCard(group, name) {
  const props = group.presets[name];
  const card = el("div", { class: "preset-card", title: `${group.group} / ${name}` },
    el("div", { class: "swatch", style: swatchStyle(props) }),
    el("span", { class: "label" }, name));
  card.addEventListener("click", (ev) => {
    // Not while the card is being renamed or asking to confirm a delete
    if (card.dataset.editing || ev.target.closest("button, input")) return;
    usePreset(name, props);
  });
  if (group.kind === "user") {
    card.append(
      el("button", { type: "button", class: "icon", title: "Rename", onclick: () => renamePresetInline(card, name) }, "✎"),
      el("button", { type: "button", class: "icon", title: "Delete", onclick: () => confirmDeletePreset(card, name) }, "✕"));
  }
  return card;
}

function usePreset(name, props) {
  const matName = addMaterial(name, props);
  const layer = layerByUid(state.selected);
  if (layer) {
    layer.material = matName;
    layer.include = true;
  }
  markDirty();
  refreshLayers();
  renderMaterialEditor();
  $("presets-dlg").close();
  status(layer ? `${layer.name} now uses ${matName}.` : `Added material ${matName}.`);
}

function renamePresetInline(card, name) {
  const input = el("input", { value: name, spellcheck: "false" });
  card.dataset.editing = "1";
  card.querySelector(".label").replaceWith(input);
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    if (commit && next && next !== name) {
      try {
        state.presets.user = (await post("/api/presets/user/rename", { old: name, new: next })).user;
        renderLayerList();
      } catch (err) {
        showMsgs($("presets-msgs"), [["error", err.message]]);
      }
    }
    renderPresetBrowser();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
}

function confirmDeletePreset(card, name) {
  card.dataset.editing = "1";
  card.replaceChildren(el("span", { class: "confirm label" }, `Delete "${name}"?`),
    el("button", {
      type: "button", class: "icon",
      onclick: async () => {
        try {
          state.presets.user = (await api(`/api/presets/user?name=${encodeURIComponent(name)}`,
            { method: "DELETE" })).user;
          renderLayerList();
        } catch (err) {
          showMsgs($("presets-msgs"), [["error", err.message]]);
        }
        renderPresetBrowser();
      },
    }, "Delete"),
    el("button", { type: "button", class: "icon", onclick: renderPresetBrowser }, "Keep"));
}

async function addMaterialsFromColors() {
  const file = $("mats-from-file").files[0];
  const body = file ? { text: await file.text() } : { path: $("mats-from-select").value };
  try {
    const { materials } = await post("/api/colors/materials", body);
    // Skip materials this project already has with identical settings
    const have = new Set(Object.values(state.project.materials).map((m) => JSON.stringify(m)));
    const added = [];
    let skipped = 0;
    for (const [name, props] of Object.entries(materials)) {
      if (have.has(JSON.stringify(props))) skipped++;
      else added.push(addMaterial(name, props));
    }
    const note = skipped ? ` Skipped ${skipped} already in this project.` : "";
    if (!added.length) {
      showMsgs($("presets-msgs"), [["warn", `Nothing new: every material in that file is already in this project.`]]);
      return;
    }
    markDirty();
    refreshLayers();
    renderMaterialEditor();
    showMsgs($("presets-msgs"), [["ok", `Added ${added.length} materials: ${added.join(", ")}. Pick them from any layer's dropdown.${note}`]]);
  } catch (err) {
    showMsgs($("presets-msgs"), [["error", err.message]]);
  }
}

// ---------------------------------------------------------------------------
// Side view of the stack
// ---------------------------------------------------------------------------

// Process-style cross-section: layers stacked by z, bottom of the stack at
// the bottom. "Schematic" gives every z interval the same height so thin
// layers stay readable; "to scale" sizes them by thickness.
function renderStack() {
  const svg = $("stack-svg");
  const W = $("stack-scroll").clientWidth;
  const avail = $("stack-scroll").clientHeight;
  svg.replaceChildren();
  const ns = "http://www.w3.org/2000/svg";
  const add = (tag, attrs, text, parent = svg) => {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text != null) node.textContent = text;
    parent.append(node);
    return node;
  };
  const layers = state.project.layers.filter((l) => l.include && l.z !== null && l.height !== null &&
    Number.isFinite(+l.z) && Number.isFinite(+l.height) && +l.height > 0);
  if (!layers.length || W < 60) {
    svg.setAttribute("height", 0);
    $("stack-empty").hidden = false;
    return;
  }
  $("stack-empty").hidden = true;

  const key = (v) => Math.round(v * 1e9) / 1e9;
  const bounds = new Set();
  for (const l of layers) { bounds.add(key(+l.z)); bounds.add(key(+l.z + +l.height)); }
  const baseZ = renderValue("ADD_ON_SCENE_SETUP") !== false ? renderValue("CHIP_BASE_Z") : null;
  const showBase = Number.isFinite(baseZ) && baseZ <= Math.min(...bounds);
  if (showBase) bounds.add(key(baseZ));
  const zs = [...bounds].sort((a, b) => a - b);

  // Height of each interval between neighbouring boundaries, bottom first
  const intervals = zs.slice(0, -1).map((z0, i) => {
    const z1 = zs[i + 1];
    return { z0, z1, filled: layers.some((l) => +l.z <= z0 && +l.z + +l.height >= z1) };
  });
  const top = 24, baseBar = showBase ? 16 : 0, bottom = 8 + baseBar;
  const room = Math.max(120, avail - top - bottom);
  if (state.opts.stackMode === "scale") {
    const total = zs[zs.length - 1] - zs[0] || 1;
    for (const iv of intervals) iv.h = Math.max(4, room * (iv.z1 - iv.z0) / total);
  } else {
    const units = intervals.reduce((n, iv) => n + (iv.filled ? 1 : 0.5), 0);
    const unit = Math.min(64, Math.max(28, room / units));
    for (const iv of intervals) iv.h = unit * (iv.filled ? 1 : 0.5);
  }
  const yOf = new Map();
  let y = top + intervals.reduce((n, iv) => n + iv.h, 0);
  yOf.set(zs[0], y);
  intervals.forEach((iv) => { y -= iv.h; yOf.set(iv.z1, y); });
  const H = yOf.get(zs[0]) + bottom;
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const axis = 46, x0 = axis + 4, barW = W - x0 - 8;
  // z labels at each boundary, skipping ones that would overlap
  let lastLabel = Infinity;
  for (const z of zs) {
    const yy = yOf.get(z);
    add("line", { x1: x0, x2: x0 + barW, y1: yy, y2: yy, class: "grid" });
    if (lastLabel - yy >= 12 || z === zs[0]) {
      add("text", { x: axis - 2, y: yy + 4, "text-anchor": "end", class: "zlabel" }, `${+z.toFixed(3)}`);
      lastLabel = yy;
    }
  }
  add("text", { x: axis - 2, y: 11, "text-anchor": "end", class: "zlabel" }, "z (µm)");

  // A layer inside the z range of a thicker one is drawn inset on top of it;
  // layers sharing z at the same depth sit side by side
  const span = (l) => [+l.z, +l.z + +l.height];
  const depth = new Map(layers.map((l) => [l.uid, layers.filter((m) => m !== l &&
    span(m)[0] <= span(l)[0] && span(m)[1] >= span(l)[1] && +m.height > +l.height).length]));
  const overlaps = (a, b) => span(a)[0] < span(b)[1] && span(b)[0] < span(a)[1];
  const lane = new Map(), lanes = new Map();
  const order = [...layers].sort((a, b) => depth.get(a.uid) - depth.get(b.uid) || +a.z - +b.z || a.index - b.index);
  for (const l of order) {
    const peers = order.filter((m) => lane.has(m.uid) && depth.get(m.uid) === depth.get(l.uid) && overlaps(m, l));
    let n = 0;
    while (peers.some((m) => lane.get(m.uid) === n)) n++;
    lane.set(l.uid, n);
  }
  for (const l of order) {
    const peers = order.filter((m) => depth.get(m.uid) === depth.get(l.uid) && overlaps(m, l));
    lanes.set(l.uid, Math.max(...peers.map((m) => lane.get(m.uid))) + 1);
  }

  const hidden = new Set(renderValue("HIDE_LAYERS") || []);
  for (const l of order) {
    const d = depth.get(l.uid);
    const inner = barW * Math.max(0.4, 1 - 0.18 * d);
    const xStart = x0 + (barW - inner) / 2;
    const w = inner / lanes.get(l.uid);
    const x = xStart + lane.get(l.uid) * w;
    const yTop = yOf.get(key(+l.z + +l.height)), yBot = yOf.get(key(+l.z));
    const look = materialLook(state.project.materials[l.material]);
    const selected = l.uid === state.selected;
    const g = add("g", { class: `band${hidden.has(l.name) ? " hidden-layer" : ""}`, "data-uid": l.uid });
    add("rect", {
      x: x + 1, y: yTop + 1, width: Math.max(2, w - 2), height: Math.max(2, yBot - yTop - 2), rx: 3,
      fill: look.css, "fill-opacity": Math.max(0.55, look.opacity),
      stroke: selected ? "#5b9dff" : "rgba(255,255,255,.18)", "stroke-width": selected ? 2 : 1,
    }, null, g);
    add("title", {}, `${l.name} (${gdsKey(l)}): z ${+l.z} → ${+(+l.z + +l.height).toFixed(4)} µm, ` +
      `h ${+l.height}${hidden.has(l.name) ? " · hidden in the render" : ""}`, g);
    const bandH = yBot - yTop;
    if (bandH >= 14) {
      const dark = luminance(look.css) > 0.3;  // dark text on light layers
      const label = add("text", {
        x: x + w / 2, y: yTop + bandH / 2 + (bandH >= 30 ? -2 : 4), "text-anchor": "middle",
        class: `band-label${dark ? " dark" : ""}`,
      }, l.name, g);
      fitText(label, w - 8);
      if (bandH >= 30) {
        const sub = add("text", { x: x + w / 2, y: yTop + bandH / 2 + 11, "text-anchor": "middle",
          class: `band-sub${dark ? " dark" : ""}` }, `h ${+l.height} µm`, g);
        fitText(sub, w - 8);
      }
    }
    g.addEventListener("click", () => selectLayer(l.uid, true));
    g.addEventListener("mouseenter", () => { state.hoverRow = l.uid; draw(); });
    g.addEventListener("mouseleave", () => { state.hoverRow = null; draw(); });
  }

  if (showBase) {
    const yb = yOf.get(key(baseZ));
    add("rect", { x: x0, y: yb, width: barW, height: baseBar - 4, class: "chip-base" });
    add("text", { x: x0 + barW / 2, y: yb + baseBar - 7, "text-anchor": "middle", class: "base-label" }, "ChipBase");
  }
}

function fitText(node, width) {
  while (node.getComputedTextLength() > width && node.textContent.length > 2) {
    node.textContent = node.textContent.slice(0, -2) + "…";
  }
  if (node.getComputedTextLength() > width) node.textContent = "";
}

// Relative luminance of an "rgb(r,g,b)" color, 0 to 1
function luminance(css) {
  const [r, g, b] = css.match(/\d+/g).map((v) => srgb2lin(+v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ---------------------------------------------------------------------------
// Render settings: the SETTINGS of build_gds_scene.py. The script's values
// are the defaults; the project stores only the ones changed here.
// ---------------------------------------------------------------------------

// [script setting, label, kind, extra]
const RENDER_GROUPS = [
  ["Import", [
    ["UNIT_SCALE", "Unit scale", "number"],
    ["Z_SCALE", "Z scale", "number"],
    ["MERGE_LAYERS", "Merge overlapping shapes", "bool"],
    ["MAX_POLYGON_VERTICES", "Split polygons to max vertices", "optnumber", 50],
    ["ADD_ON_SCENE_SETUP", "Add-on scene setup", "bool"],
    ["CHIP_BASE_Z", "Move chip base to z (µm)", "optnumber", -0.05],
    ["HIDE_LAYERS", "Hide layers", "layers"],
  ]],
  ["Camera", [
    ["REFRAME_CAMERA", "Frame the chip", "bool"],
    ["CAMERA_TILT_DEG", "Tilt (°)", "number"],
    ["CAMERA_DISTANCE", "Distance (× chip size)", "number"],
    ["CAMERA_LENS_MM", "Lens (mm)", "number"],
  ]],
  ["Sun", [
    ["ADJUST_SUN", "Set the sun", "bool"],
    ["SUN_STRENGTH", "Strength (W/m²)", "number"],
    ["SUN_AZIMUTH_DEG", "Azimuth (° from +y, clockwise)", "number"],
    ["SUN_ELEVATION_DEG", "Elevation (° above horizon)", "number"],
    ["SUN_ANGLE_DEG", "Shadow softness (°)", "number"],
  ]],
  ["Lighting", [
    ["ADD_SOFTBOX", "Reflection softbox", "bool"],
    ["SOFTBOX_STRENGTH", "Softbox strength", "number"],
    ["SOFTBOX_SIZE", "Softbox size (× chip size)", "number"],
  ]],
  ["Glow", [
    ["ADD_GLARE", "Glow around bright pixels", "bool"],
    ["GLARE_TYPE", "Glow type", "select", ["BLOOM", "FOG_GLOW", "STREAKS", "GHOSTS", "SIMPLE_STAR"]],
    ["GLARE_THRESHOLD", "Glow threshold", "number"],
    ["GLARE_STRENGTH", "Glow strength", "number"],
  ]],
  ["Output", [
    ["RESOLUTION", "Resolution (px)", "resolution"],
    ["CYCLES_SAMPLES", "Samples", "int"],
    ["TRANSPARENT_BACKGROUND", "Transparent background", "bool"],
  ]],
];

const scriptSetting = (key) => state.renderInfo?.settings[key];
// The script splits large polygons before importing unless MERGE_LAYERS joins
// them again (cropping does too, but crop stats already count merged shapes)
const splitsPolygons = () => !!renderValue("MAX_POLYGON_VERTICES") && !renderValue("MERGE_LAYERS");

function renderValue(key) {
  const r = state.project.render || {};
  return key in r ? r[key] : scriptSetting(key)?.value;
}

function setRenderValue(key, value) {
  state.project.render ||= {};
  const same = JSON.stringify(value) === JSON.stringify(scriptSetting(key)?.value);
  if (same) delete state.project.render[key];
  else state.project.render[key] = value;
  markDirty();
  renderStack();
  draw();  // camera framing
  if (key === "MAX_POLYGON_VERTICES" || key === "MERGE_LAYERS") renderLayerList();  // vertex warnings
  for (const row of document.querySelectorAll(`.rs-field[data-key="${key}"]`)) {
    row.classList.toggle("changed", !same);
  }
  $("rs-reset").disabled = !Object.keys(state.project.render).length;
}

// Smallest crop the add-on accepts: 0.1 Blender units, in µm
function minCrop() {
  const scale = Number(renderValue("UNIT_SCALE")) || 1e-6;
  return 0.1 * scale / 1e-6;
}

function renderRenderSettings() {
  const box = $("rs-fields");
  box.replaceChildren();
  if (!state.renderInfo) {
    box.append(el("p", { class: "hint" }, "build_gds_scene.py couldn't be read, so there's nothing to set."));
    return;
  }
  const changed = state.project.render || {};
  const included = state.project.layers.filter((l) => l.include).map((l) => l.name);
  for (const [group, fields] of RENDER_GROUPS) {
    const present = fields.filter(([key]) => scriptSetting(key));
    if (!present.length) continue;
    const section = el("fieldset", { class: "rs-group" }, el("legend", {}, group));
    for (const [key, label, kind, extra] of present) {
      const value = renderValue(key);
      const row = el("div", {
        class: `rs-field${key in changed ? " changed" : ""}`, "data-key": key,
        title: `${key}: ${scriptSetting(key).help || ""}`,
      });
      const num = (v, onSet, int = false) => {
        const input = el("input", { type: "number", step: int ? "1" : "any", value: v ?? "" });
        input.addEventListener("input", () => {
          const n = int ? parseInt(input.value, 10) : parseFloat(input.value);
          if (Number.isFinite(n)) onSet(n);
        });
        return input;
      };
      if (kind === "bool") {
        const cb = el("input", { type: "checkbox", checked: !!value });
        cb.addEventListener("change", () => setRenderValue(key, cb.checked));
        row.append(el("label", { class: "inline" }, cb, label));
      } else if (kind === "number" || kind === "int") {
        row.append(el("span", {}, label), num(value, (n) => setRenderValue(key, n), kind === "int"));
      } else if (kind === "optnumber") {
        const on = Number.isFinite(value);
        const cb = el("input", { type: "checkbox", checked: on });
        const input = num(on ? value : extra, (n) => { if (cb.checked) setRenderValue(key, n); });
        input.disabled = !on;
        cb.addEventListener("change", () => {
          input.disabled = !cb.checked;
          setRenderValue(key, cb.checked ? parseFloat(input.value) || extra : null);
        });
        row.append(el("label", { class: "inline" }, cb, label), input);
      } else if (kind === "select") {
        const options = extra.includes(value) ? extra : [value, ...extra];
        const sel = el("select", {}, ...options.map((o) => el("option", { value: o, selected: o === value }, o)));
        sel.addEventListener("change", () => setRenderValue(key, sel.value));
        row.append(el("span", {}, label), sel);
      } else if (kind === "resolution") {
        const [w, h] = value || [1920, 1080];
        const wi = num(w, (n) => setRenderValue(key, [n, renderValue(key)[1]]), true);
        const hi = num(h, (n) => setRenderValue(key, [renderValue(key)[0], n]), true);
        row.append(el("span", {}, label), el("span", { class: "res" }, wi, "×", hi));
      } else if (kind === "layers") {
        const hidden = new Set(value || []);
        row.classList.add("wide");
        row.append(el("span", {}, label));
        const list = el("div", { class: "rs-layers" });
        if (!included.length) list.append(el("span", { class: "hint" }, "No checked layers"));
        for (const name of included) {
          const cb = el("input", { type: "checkbox", checked: hidden.has(name) });
          cb.addEventListener("change", () => {
            const now = new Set((renderValue(key) || []).filter((n) => included.includes(n)));
            if (cb.checked) now.add(name); else now.delete(name);
            setRenderValue(key, [...now]);
          });
          list.append(el("label", { class: "inline" }, cb, name));
        }
        row.append(list);
      }
      section.append(row);
    }
    box.append(section);
  }
  $("rs-reset").disabled = !Object.keys(changed).length;
}

// The settings sent with a run: every setting the panel shows
function runSettings() {
  const included = new Set(state.project.layers.filter((l) => l.include).map((l) => l.name));
  const out = {};
  for (const [, fields] of RENDER_GROUPS) {
    for (const [key] of fields) {
      if (!scriptSetting(key)) continue;
      let v = renderValue(key);
      if (key === "HIDE_LAYERS") v = (v || []).filter((n) => included.has(n));
      out[key] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Camera framing on the layout: what a straight-down camera placed the way
// build_gds_scene.py places it (REFRAME_CAMERA) will see
// ---------------------------------------------------------------------------

// Layout area the imported, visible layers cover (µm): what the script frames
function sceneRegion() {
  if (!state.doc) return null;
  const hidden = new Set(renderValue("HIDE_LAYERS") || []);
  const boxes = new Map(state.doc.layers.map((g) => [`${g.layer}/${g.datatype}`, g.bbox]));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const c = state.project.crop;
  for (const l of state.project.layers) {
    const b = boxes.get(gdsKey(l));
    if (!l.include || hidden.has(l.name) || !b) continue;
    let [a0, b0, a1, b1] = b;
    if (c) [a0, b0, a1, b1] = [Math.max(a0, c.x), Math.max(b0, c.y), Math.min(a1, c.x + c.w), Math.min(b1, c.y + c.h)];
    if (a0 >= a1 || b0 >= b1) continue;
    x0 = Math.min(x0, a0); y0 = Math.min(y0, b0); x1 = Math.max(x1, a1); y1 = Math.max(y1, b1);
  }
  return x0 < x1 ? { x0, y0, x1, y1 } : null;
}

function cameraFrame() {
  if (!state.renderInfo || !renderValue("REFRAME_CAMERA")) return null;
  const region = sceneRegion();
  if (!region) return null;
  const { x0, y0, x1, y1 } = region;
  const size = Math.max(x1 - x0, y1 - y0);
  const dist = size * (Number(renderValue("CAMERA_DISTANCE")) || 2);
  const lens = Number(renderValue("CAMERA_LENS_MM")) || 50;
  const [rw, rh] = renderValue("RESOLUTION") || [1920, 1080];
  // Blender's default 36 mm sensor spans the longer side of the image
  const long = dist * 36 / lens;
  const [w, h] = rw >= rh ? [long, long * rh / rw] : [long * rw / rh, long];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h, tilt: Number(renderValue("CAMERA_TILT_DEG")) || 0 };
}

function drawCameraFrame(ctx) {
  const f = state.opts.camera && cameraFrame();
  if (!f) return;
  const { scale, tx, ty } = state.view;
  const [mx0, my0] = umToMask(f.x, f.y + f.h);
  const [mx1, my1] = umToMask(f.x + f.w, f.y);
  const r = { x: mx0 * scale + tx, y: my0 * scale + ty, w: (mx1 - mx0) * scale, h: (my1 - my0) * scale };
  ctx.strokeStyle = "#f0a640";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([10, 5]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  const label = f.tilt ? `Camera at 0° tilt (yours is ${f.tilt}°)` : "Camera";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
  const tw = ctx.measureText(label).width;
  const ly = Math.max(4, r.y + r.h + 4);
  ctx.fillStyle = "rgba(18, 20, 24, 0.85)";
  ctx.fillRect(r.x + r.w - tw - 10, ly, tw + 10, 17);
  ctx.fillStyle = "#f0a640";
  ctx.fillText(label, r.x + r.w - tw - 5, ly + 12.5);
}

// ---------------------------------------------------------------------------
// Sun marker on the layout: a dial centered on the scene. The center is the
// sun straight overhead, the dashed circle is the horizon, and the direction
// is the azimuth. Dragging the marker sets both.
// ---------------------------------------------------------------------------

function sunDial() {
  if (!state.opts.sun || !state.renderInfo || !scriptSetting("SUN_AZIMUTH_DEG") || !renderValue("ADJUST_SUN")) return null;
  const region = sceneRegion();
  if (!region) return null;
  const { scale, tx, ty } = state.view;
  const [mx, my] = umToMask((region.x0 + region.x1) / 2, (region.y0 + region.y1) / 2);
  const canvas = $("view");
  const radius = Math.min(260, Math.max(80, 0.3 * Math.min(canvas.clientWidth, canvas.clientHeight)));
  const az = (Number(renderValue("SUN_AZIMUTH_DEG")) || 0) * Math.PI / 180;
  const el = Math.min(90, Math.max(0, Number(renderValue("SUN_ELEVATION_DEG")) || 0)) * Math.PI / 180;
  const cx = mx * scale + tx, cy = my * scale + ty;
  // Layout +y is screen up
  return { cx, cy, radius, sx: cx + radius * Math.cos(el) * Math.sin(az), sy: cy - radius * Math.cos(el) * Math.cos(az) };
}

function drawSun(ctx) {
  const d = sunDial();
  if (!d) return;
  ctx.save();
  ctx.strokeStyle = "rgba(255, 213, 74, 0.35)";
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.arc(d.cx, d.cy, d.radius, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(d.cx - 5, d.cy); ctx.lineTo(d.cx + 5, d.cy);
  ctx.moveTo(d.cx, d.cy - 5); ctx.lineTo(d.cx, d.cy + 5);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255, 213, 74, 0.8)";
  ctx.beginPath();
  ctx.moveTo(d.cx, d.cy);
  ctx.lineTo(d.sx, d.sy);
  ctx.stroke();
  // Sun: disc with rays
  ctx.fillStyle = "#ffd54a";
  ctx.strokeStyle = "#ffd54a";
  ctx.lineWidth = 2;
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(d.sx + 11 * Math.cos(a), d.sy + 11 * Math.sin(a));
    ctx.lineTo(d.sx + 16 * Math.cos(a), d.sy + 16 * Math.sin(a));
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(d.sx, d.sy, 8, 0, 2 * Math.PI);
  ctx.fill();
  const label = `Sun ${Math.round(renderValue("SUN_AZIMUTH_DEG"))}° · ${Math.round(renderValue("SUN_ELEVATION_DEG"))}° up`;
  ctx.font = "12px -apple-system, BlinkMacSystemFont, sans-serif";
  const tw = ctx.measureText(label).width;
  ctx.fillStyle = "rgba(18, 20, 24, 0.85)";
  ctx.fillRect(d.sx + 18, d.sy - 9, tw + 10, 17);
  ctx.fillStyle = "#ffd54a";
  ctx.fillText(label, d.sx + 23, d.sy + 4);
  ctx.restore();
}

function sunHandleAt(ev) {
  const d = sunDial();
  if (!d) return false;
  const rect = $("view").getBoundingClientRect();
  return Math.hypot(ev.clientX - rect.left - d.sx, ev.clientY - rect.top - d.sy) <= 14;
}

// Azimuth and elevation from a point on the dial
function dragSun(ev) {
  const d = sunDial();
  if (!d) return;
  const rect = $("view").getBoundingClientRect();
  const dx = ev.clientX - rect.left - d.cx, dy = ev.clientY - rect.top - d.cy;
  const r = Math.min(d.radius, Math.hypot(dx, dy));
  const az = Math.round(((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360);
  const el = Math.round(Math.acos(r / d.radius) * 180 / Math.PI);
  for (const [key, value] of [["SUN_AZIMUTH_DEG", az], ["SUN_ELEVATION_DEG", el]]) {
    if (renderValue(key) === value) continue;
    setRenderValue(key, value);
    const input = document.querySelector(`.rs-field[data-key="${key}"] input`);
    if (input) input.value = value;
  }
}

// ---------------------------------------------------------------------------
// Runs: build / render in Blender, one at a time on the server
// ---------------------------------------------------------------------------

const RUN_MODES = { build: "Build", quick: "Quick render", final: "Final render" };
const runActive = (r) => r.status === "queued" || r.status === "running";
let pollTimer = null;

function preflight() {
  const errors = [], warnings = [];
  const info = state.renderInfo;
  if (!info) errors.push("build_gds_scene.py couldn't be read.");
  else if (!info.blender) errors.push("Blender wasn't found. Install it in /Applications, or start the server with BLENDER set to its executable.");
  else if (!info.addon) warnings.push("The BlenderGDS add-on wasn't found in Blender's extensions folder. The build fails without it.");
  if (!state.doc) errors.push("Open a GDS file first.");
  else if (!state.gdsPath) errors.push("This GDS was uploaded. Copy it into the project folder and open it from there, so Blender can read it.");
  const included = state.project.layers.filter((l) => l.include);
  if (!included.length) errors.push("No layers are checked.");
  const c = state.project.crop;
  if (c && state.doc) {
    const [x0, y0, x1, y1] = state.doc.bbox;
    if (c.x >= x1 || c.y >= y1 || c.x + c.w <= x0 || c.y + c.h <= y0) errors.push("The crop region is entirely outside the chip.");
    const min = minCrop();
    if (c.w < min || c.h < min) {
      errors.push(`At UNIT_SCALE ${renderValue("UNIT_SCALE")}, the crop must be at least ${fmtUm(min)} µm wide and high.`);
    }
  }
  const hidden = new Set(renderValue("HIDE_LAYERS") || []);
  const stats = new Map((state.doc?.layers || []).map((g) => [`${g.layer}/${g.datatype}`, g]));
  for (const l of included) {
    if (hidden.has(l.name)) continue;
    const s = (c && state.cropStats?.get(gdsKey(l))) || stats.get(gdsKey(l));
    if (s?.vertex_warning && !(splitsPolygons() && !c)) {
      warnings.push(`${l.name} has polygons with up to ${fmt(s.max_vertices)} vertices${c ? " after cropping" : ""}. The import may be very slow or run out of memory.`);
    }
  }
  return { errors, warnings };
}

function confirmRun(mode, warnings) {
  const dlg = $("run-dlg");
  $("run-dlg-title").textContent = `${RUN_MODES[mode]} anyway?`;
  $("run-dlg-list").replaceChildren(...warnings.map((w) => el("div", { class: "msg warn" }, w)));
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "go"), { once: true });
  });
}

async function startRun(mode) {
  if (settleTimer) settle();
  const { errors, warnings } = preflight();
  showMsgs($("run-msgs"), errors.map((e) => ["error", e]));
  if (errors.length) return;
  if (warnings.length && !(await confirmRun(mode, warnings))) return;
  try {
    const res = await post("/api/render/run", {
      project: projectPayload(), settings: runSettings(), mode, gds_path: state.gdsPath,
      reimport: $("run-reimport").checked,
    });
    if (res.errors.length) return showMsgs($("run-msgs"), res.errors.map((e) => ["error", e]));
    $("run-reimport").checked = false;  // one run imports again; later ones reuse that
    state.runs.unshift(res.run);
    state.viewRun = res.run.name;
    setPane("render");
    renderRuns();
    pollRuns();
  } catch (err) {
    showMsgs($("run-msgs"), [["error", err.message]]);
  }
}

async function loadRuns() {
  try {
    state.runs = (await api("/api/render/runs")).runs;
  } catch (err) {
    state.runs = [];
  }
  state.viewRun ||= state.runs[0]?.name || null;
  renderRuns();
  if (state.runs.some(runActive)) pollRuns();
}

// Fetch a run's status and new log lines
async function refreshRun(name) {
  const log = state.runLogs.get(name) || { lines: [], next: 0 };
  const res = await api(`/api/render/runs/${encodeURIComponent(name)}?since=${log.next}`);
  log.lines.push(...res.lines);
  log.next = res.next;
  state.runLogs.set(name, log);
  const i = state.runs.findIndex((r) => r.name === name);
  if (i >= 0) state.runs[i] = res.run;
  return res.run;
}

async function pollRuns() {
  clearTimeout(pollTimer);
  try {
    for (const r of state.runs.filter(runActive)) await refreshRun(r.name);
  } catch (err) { /* server busy or restarting: try again next tick */ }
  renderRuns();
  if (state.runs.some(runActive)) pollTimer = setTimeout(pollRuns, 700);
}

async function viewRun(name) {
  state.viewRun = name;
  renderRuns();
  if (!state.runLogs.has(name)) {
    try { await refreshRun(name); } catch (err) { /* shown as missing log */ }
    renderRunDetail();
  }
}

function renderRuns() {
  renderRunStrip();
  renderRunDetail();
  const active = state.runs.find((r) => r.status === "running") || state.runs.find(runActive);
  $("render-tab").textContent = active
    ? `Render · ${active.status === "queued" ? "waiting" : `${Math.round(active.progress * 100)}%`}`
    : "Render";
  $("render-tab").classList.toggle("busy", !!active);
}

function runTime(r) {
  const d = r.created ? new Date(r.created) : null;
  return d ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : r.name;
}

function renderRunStrip() {
  const strip = $("run-strip");
  if (!state.runs.length) {
    strip.replaceChildren(el("div", { class: "hint strip-empty" }, "Runs appear here. Each one is kept in its own folder under renders/."));
    return;
  }
  strip.replaceChildren(...state.runs.map((r) => {
    const thumb = r.image
      ? el("img", { src: `/api/render/runs/${encodeURIComponent(r.name)}/thumb.jpg?v=${r.finished || ""}`, alt: "" })
      : el("div", { class: "thumb-text" }, r.mode === "build" && r.status === "done" ? ".blend" :
        r.status === "failed" ? "✕" : r.status === "cancelled" ? "—" : "…");
    const card = el("button", {
      type: "button", class: `run-card ${r.status}${r.name === state.viewRun ? " selected" : ""}`,
      title: `${r.name}: ${r.phase}`, onclick: () => viewRun(r.name),
    }, el("div", { class: "thumb" }, thumb),
    el("div", { class: "run-label" }, el("b", {}, RUN_MODES[r.mode] || r.mode), el("span", {}, runTime(r))),
    runActive(r) ? el("div", { class: "bar" }, el("span", { style: `width:${Math.round(r.progress * 100)}%` })) :
      r.status !== "done" ? el("div", { class: `run-status ${r.status}` }, r.status) : null);
    return card;
  }));
}

function renderRunDetail() {
  const r = state.runs.find((x) => x.name === state.viewRun);
  const img = $("render-img");
  $("render-empty").hidden = !!(r && r.image);
  $("run-detail").hidden = !r;
  if (!r) {
    img.hidden = true;
    $("run-log").textContent = "";
    $("log-title").textContent = "";
    return;
  }
  // Image: only reload when a different one is shown
  const src = r.image ? `/api/render/runs/${encodeURIComponent(r.name)}/render.png?v=${r.finished || ""}` : "";
  if (img.dataset.src !== src) {
    img.dataset.src = src;
    img.hidden = !src;
    if (src) {
      img.onload = () => fitRenderView();
      img.src = src;
    } else img.removeAttribute("src");
  }
  if (!r.image) {
    $("render-empty").querySelector("p").textContent =
      runActive(r) ? `${r.phase}…` : r.status === "done" ? "Built the .blend (no render for this run)." :
        r.status === "cancelled" ? "Cancelled." : `Failed: ${r.error || "see the log below"}`;
  }

  const bits = [RUN_MODES[r.mode] || r.mode, runTime(r)];
  const info = r.info || {};
  if (r.mode !== "build" && info.resolution) bits.push(`${info.resolution.join("×")} px`, `${info.samples} samples`);
  if (info.crop) bits.push(`crop ${fmtUm(info.crop.w)} × ${fmtUm(info.crop.h)} µm`);
  if (info.reused_import !== undefined) bits.push(info.reused_import ? "reused earlier import" : "imported layout");
  if (r.started && r.finished) bits.push(`took ${durationText((new Date(r.finished) - new Date(r.started)) / 1000)}`);
  $("run-summary").textContent = bits.join(" · ");
  $("run-phase").textContent = runActive(r) ? r.phase : r.status === "failed" ? `Failed: ${r.error || ""}` : "";
  $("run-phase").className = `run-phase${r.status === "failed" ? " error" : ""}`;
  $("run-bar").hidden = !runActive(r);
  $("run-bar").firstElementChild.style.width = `${Math.round(r.progress * 100)}%`;
  $("run-cancel").hidden = !runActive(r);
  $("run-open").disabled = !r.blend || runActive(r);
  $("run-use").disabled = !info.settings;
  showMsgs($("run-warnings"), (r.warnings || []).map((w) => ["warn", w]));

  const log = state.runLogs.get(r.name);
  const pre = $("run-log");
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  pre.textContent = log ? log.lines.join("\n") : "";
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  $("log-title").textContent = r.name;
}

function durationText(sec) {
  if (sec < 60) return `${Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m} min ${Math.round(sec % 60)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Bring a run's settings and crop back into the project
function useRunSettings() {
  const r = state.runs.find((x) => x.name === state.viewRun);
  if (!r?.info?.settings) return;
  state.project.render = {};
  for (const [key, value] of Object.entries(r.info.settings)) {
    if (JSON.stringify(value) !== JSON.stringify(scriptSetting(key)?.value)) state.project.render[key] = value;
  }
  state.project.crop = r.info.crop || null;
  markDirty();
  renderAll();
  status(`Using the settings from ${r.name}.`);
}

// Render image viewer: zoom and pan with CSS transforms
const rview = { scale: 1, tx: 0, ty: 0 };

function applyRenderView() {
  const img = $("render-img");
  img.style.transform = `translate(${rview.tx}px, ${rview.ty}px) scale(${rview.scale})`;
  img.classList.toggle("pixelated", rview.scale * (window.devicePixelRatio || 1) > 2);
}

function fitRenderView() {
  const img = $("render-img"), box = $("render-view");
  if (!img.naturalWidth || !box.clientWidth) return;
  const scale = Math.min(1, 0.96 * Math.min(box.clientWidth / img.naturalWidth, box.clientHeight / img.naturalHeight));
  Object.assign(rview, { scale, tx: (box.clientWidth - img.naturalWidth * scale) / 2, ty: (box.clientHeight - img.naturalHeight * scale) / 2 });
  applyRenderView();
}

function bindRenderView() {
  const box = $("render-view");
  let drag = null;
  box.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const rect = box.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    const scale = Math.min(32, Math.max(0.05, rview.scale * Math.exp(-ev.deltaY * 0.0015)));
    const f = scale / rview.scale;
    Object.assign(rview, { scale, tx: mx - (mx - rview.tx) * f, ty: my - (my - rview.ty) * f });
    applyRenderView();
  }, { passive: false });
  box.addEventListener("pointerdown", (ev) => {
    drag = { x: ev.clientX, y: ev.clientY };
    box.setPointerCapture(ev.pointerId);
    box.classList.add("dragging");
  });
  box.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    rview.tx += ev.clientX - drag.x;
    rview.ty += ev.clientY - drag.y;
    drag = { x: ev.clientX, y: ev.clientY };
    applyRenderView();
  });
  box.addEventListener("pointerup", () => { drag = null; box.classList.remove("dragging"); });
  box.addEventListener("dblclick", fitRenderView);
  new ResizeObserver(fitRenderView).observe(box);
}

// ---------------------------------------------------------------------------
// Viewer tabs (Layout / Render, or both side by side) and the stack column
// ---------------------------------------------------------------------------

const VIEW_KEY = "gds2blend.view";

function setPane(pane, split = state.ui.split) {
  state.ui.pane = pane;
  state.ui.split = split;
  $("layout-pane").hidden = !split && pane !== "layout";
  $("render-pane").hidden = !split && pane !== "render";
  if (split !== $("panes").classList.contains("split")) {
    // Side by side leaves little room, so the settings start collapsed there
    $("render-settings").hidden = split;
    $("rs-toggle").classList.toggle("on", !split);
  }
  $("panes").classList.toggle("split", split);
  for (const t of document.querySelectorAll(".vtab")) t.classList.toggle("active", split || t.dataset.pane === pane);
  $("split-toggle").checked = split;
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(state.ui)); } catch (err) { /* ignore */ }
}

function bindStackColumn() {
  const col = $("stack-col");
  const handle = $("stack-resizer");
  if (state.ui.stackWidth) col.style.width = `${state.ui.stackWidth}px`;
  let start = null;
  handle.addEventListener("pointerdown", (ev) => {
    start = { x: ev.clientX, w: col.offsetWidth };
    handle.setPointerCapture(ev.pointerId);
  });
  handle.addEventListener("pointermove", (ev) => {
    if (!start) return;
    col.style.width = `${Math.min(520, Math.max(160, start.w + ev.clientX - start.x))}px`;
  });
  handle.addEventListener("pointerup", () => {
    if (!start) return;
    start = null;
    state.ui.stackWidth = col.offsetWidth;
    setPane(state.ui.pane);
  });
  for (const mode of ["schematic", "scale"]) {
    $(`stack-${mode}`).addEventListener("click", () => {
      state.opts.stackMode = mode;
      $("stack-schematic").classList.toggle("on", mode === "schematic");
      $("stack-scale").classList.toggle("on", mode === "scale");
      renderStack();
    });
  }
  new ResizeObserver(renderStack).observe($("stack-scroll"));
}

// ---------------------------------------------------------------------------
// Stack / scheme metadata
// ---------------------------------------------------------------------------

const META_INPUTS = [
  ["stack-name", "stack", "name"], ["stack-defcolor", "stack", "def_color"],
  ["stack-desc", "stack", "description"],
  ["scheme-name", "scheme", "name"], ["scheme-desc", "scheme", "description"],
];

function renderMeta() {
  for (const [id, group, key] of META_INPUTS) $(id).value = state.project[group][key] || "";
}

function renderAll() {
  renderMeta();
  renderCropPanel();
  renderRenderSettings();
  renderLayerList();
  renderMaterialEditor();
  renderStack();
  scheduleComposite();
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

// Replace the whole project (import, open, restore). Starts a fresh undo history.
function applyProject(project, { dirty = false } = {}) {
  project.crop ??= null;
  project.render ??= {};
  state.project = project;
  for (const l of project.layers) l.uid = nextUid++;
  state.selected = null;
  state.solo = null;
  addMissingGdsLayers();
  state.dirty = dirty;
  state.unexported = false;
  resetHistory();
  renderAll();
}

// ---------------------------------------------------------------------------
// Project files
// ---------------------------------------------------------------------------

function projectFileData() {
  const gds = state.doc
    ? { path: state.gdsPath, name: state.doc.name, sha1: state.doc.id }
    : state.savedGds;  // keep the link even if the GDS couldn't be opened
  return {
    version: 1,
    gds: gds || null,
    ...projectPayload(),
    export: { layers_path: $("out-layers").value.trim(), colors_path: $("out-colors").value.trim() },
    view: { ...state.opts, mask_size: state.maskSize },
  };
}

async function loadProjectData(data, path, { dirty = false } = {}) {
  const project = {
    stack: { name: "", description: "", def_color: "", ...data.stack },
    scheme: { name: "", description: "", ...data.scheme },
    share_materials: !!data.share_materials,
    materials: data.materials || {},
    layers: (data.layers || []).map((l) => ({ extra: {}, ...l })),
    crop: data.crop || null,
    render: data.render || {},
  };
  state.projectPath = path;
  state.savedGds = data.gds || null;
  if (data.export) {
    $("out-layers").value = data.export.layers_path || "custom_layers.yaml";
    $("out-colors").value = data.export.colors_path || "custom_colors.yaml";
  }
  if (data.view) {
    for (const key of ["bg", "glow", "ghost", "cropOnly", "camera", "sun", "stackMode"]) {
      if (key in data.view) state.opts[key] = data.view[key];
    }
    $("opt-camera").checked = state.opts.camera;
    $("opt-sun").checked = state.opts.sun;
    $("stack-schematic").classList.toggle("on", state.opts.stackMode !== "scale");
    $("stack-scale").classList.toggle("on", state.opts.stackMode === "scale");
    $("opt-bg").value = state.opts.bg;
    $("opt-glow").checked = state.opts.glow;
    $("opt-ghost").checked = state.opts.ghost;
    $("opt-croponly").checked = state.opts.cropOnly;
    if ([1024, 2048, 4096].includes(data.view.mask_size)) {
      state.maskSize = data.view.mask_size;
      $("mask-size").value = String(state.maskSize);
    }
  }

  // Drop the previous layout first, so its rows don't leak into this project
  state.doc = null;
  state.gdsPath = data.gds?.path || null;
  state.masks.clear();
  state.tints.clear();
  state.comp = null;
  clearDetail();
  state.maskGen++;
  $("empty").hidden = false;
  hideNotice();
  applyProject(project, { dirty });
  draw();

  if (data.gds?.path) {
    const before = new Set(project.layers.map(gdsKey));
    const doc = await openGds(post("/api/gds/open", { path: data.gds.path }), data.gds.path, data.gds.path);
    if (!doc) {
      notice(`Couldn't open ${data.gds.path}, the GDS this project was made with. Open or upload it to see the preview.`, { kind: "error" });
    } else if (data.gds.sha1 && doc.id !== data.gds.sha1) {
      const inDoc = new Set(doc.layers.map((g) => `${g.layer}/${g.datatype}`));
      const added = [...inDoc].filter((k) => !before.has(k));
      const missing = project.layers.filter((l) => !inDoc.has(gdsKey(l)));
      const details = [];
      if (added.length) details.push(`New layers (added unchecked): ${added.join(", ")}`);
      if (missing.length) details.push(`No longer in the file: ${missing.map((l) => `${l.name} (${gdsKey(l)})`).join(", ")}`);
      if (!details.length) details.push("Same layers as before; your settings all still apply.");
      notice([`${data.gds.path} has changed since this project was saved.`,
        el("ul", {}, ...details.map((d) => el("li", {}, d)))]);
    }
  } else if (data.gds?.name) {
    notice(`This project was made with an uploaded file, ${data.gds.name}. Upload it again to see the preview.`);
  }
}

async function openProject(path) {
  try {
    const { data } = await api(`/api/project/load?path=${encodeURIComponent(path)}`);
    await loadProjectData(data, path);
    clearAutosave();
    status(`Opened ${path}.`);
    return true;
  } catch (err) {
    showMsgs($("open-msgs"), [["error", err.message]]);
    return false;
  }
}

// Returns {exists: true} without writing when the file exists and overwrite is off
async function saveProject(path, overwrite) {
  if (settleTimer) settle();
  const res = await post("/api/project/save", { path, data: projectFileData(), overwrite });
  if (res.exists) return res;
  state.projectPath = res.path;
  state.dirty = false;
  clearAutosave();
  renderProjectBar();
  status(`Saved ${res.path}.`);
  api("/api/files").then((f) => { state.files = f; fillFileSelects(); });
  return res;
}

function defaultProjectPath() {
  if (state.projectPath) return state.projectPath;
  if (state.gdsPath) return state.gdsPath.replace(/\.[^./]+$/, "") + PROJECT_EXT;
  return `project${PROJECT_EXT}`;
}

function openSaveAs() {
  showMsgs($("saveas-msgs"), []);
  $("saveas-path").value = defaultProjectPath();
  $("saveas-dlg").showModal();
  $("saveas-path").select();
}

async function runSaveAs(overwrite) {
  let path = $("saveas-path").value.trim();
  if (!path) return;
  if (!path.toLowerCase().endsWith(PROJECT_EXT)) path += PROJECT_EXT;
  try {
    const res = await saveProject(path, overwrite || path === state.projectPath);
    if (res.exists) {
      showMsgs($("saveas-msgs"), [["warn", `${res.path} already exists.`,
        el("button", { type: "button", onclick: () => runSaveAs(true) }, "Overwrite")]]);
      return;
    }
    $("saveas-dlg").close();
  } catch (err) {
    showMsgs($("saveas-msgs"), [["error", err.message]]);
  }
}

async function saveCurrent() {
  if (!state.projectPath) return openSaveAs();
  try {
    await saveProject(state.projectPath, true);
  } catch (err) {
    status(`Couldn't save: ${err.message}`, "error");
  }
}

async function openProjectDialog() {
  try {
    state.files = await api("/api/files");
    fillFileSelects();
  } catch (err) { /* keep the list we have */ }
  const select = $("open-select");
  select.replaceChildren(...state.files.projects.map((f) =>
    el("option", { value: f, selected: f === state.projectPath }, f)));
  $("open-go").disabled = !state.files.projects.length;
  const msgs = [];
  if (!state.files.projects.length) {
    msgs.push(["warn", `No ${PROJECT_EXT} files in the project folder yet. Use Save as… to make one.`]);
  } else if (state.dirty) {
    msgs.push(["warn", "You have unsaved changes. Opening another project discards them."]);
  }
  showMsgs($("open-msgs"), msgs);
  $("open-dlg").showModal();
}

// Offer to bring back work from a session that ended without saving.
// Autosave stays paused until you choose, so it can't overwrite that copy.
let recoveryPending = false;

function offerRecovery() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) || "null"); } catch (err) { saved = null; }
  if (!saved?.data) return;
  recoveryPending = true;
  const when = new Date(saved.savedAt).toLocaleString();
  const what = saved.projectPath || (saved.data.gds?.name ? `untitled project for ${saved.data.gds.name}` : "untitled project");
  notice(`Found unsaved changes to ${what} from ${when}.`, {
    actions: [
      ["Restore", async () => {
        recoveryPending = false;
        await loadProjectData(saved.data, saved.projectPath || null, { dirty: true });
        autosave();
        status("Restored your unsaved changes.");
      }],
      ["Discard", () => { recoveryPending = false; clearAutosave(); autosave(); }],
    ],
    dismissible: false,
  });
}

// What the server needs: the project without UI-only fields
function projectPayload() {
  return {
    ...state.project,
    layers: state.project.layers.map(({ uid, ...rest }) => rest),
  };
}

function fillFileSelects() {
  const fill = (select, files, preferred) => {
    select.replaceChildren(...files.map((f) => el("option", { value: f, selected: f === preferred }, f)));
  };
  fill($("gds-select"), state.files.gds, state.gdsPath || state.files.gds[0]);
  $("gds-open").disabled = !state.files.gds.length;
  if (!state.files.gds.length) $("gds-select").append(el("option", { value: "" }, "no .gds or .oas in project"));
  fill($("in-layers"), state.files.yaml, "custom_layers.yaml");
  fill($("in-colors"), state.files.yaml, "custom_colors.yaml");
  fill($("mats-from-select"), state.files.yaml, "custom_colors.yaml");
}

function showMsgs(box, list) {
  box.replaceChildren(...list.map(([kind, text, ...extra]) =>
    el("div", { class: `msg ${kind}` }, text, ...extra)));
}

async function runImport() {
  const body = {};
  for (const kind of ["layers", "colors"]) {
    const file = $(`in-${kind}-file`).files[0];
    if (file) body[`${kind}_text`] = await file.text();
    else body[`${kind}_path`] = $(`in-${kind}`).value;
  }
  try {
    const { project, warnings } = await post("/api/import", body);
    // Not part of the YAML files
    project.crop = state.project.crop;
    project.render = state.project.render;
    applyProject(project, { dirty: true });
    if (warnings.length) {
      showMsgs($("import-msgs"), [["ok", "Imported, with warnings:"],
        ...warnings.map((w) => ["warn", w])]);
    } else {
      $("import-dlg").close();
    }
    status(`Imported ${project.layers.length} layers and ${Object.keys(project.materials).length} materials.`);
  } catch (err) {
    showMsgs($("import-msgs"), [["error", err.message]]);
  }
}

let exportTab = "layers";
let lastExport = null;

async function refreshExport() {
  const preview = $("export-preview");
  try {
    lastExport = await post("/api/export", { project: projectPayload() });
  } catch (err) {
    showMsgs($("export-msgs"), [["error", err.message]]);
    return;
  }
  const msgs = [
    ...lastExport.errors.map((e) => ["error", e]),
    ...lastExport.warnings.map((w) => ["warn", w]),
  ];
  if (state.project.crop) {
    const line = cropLine(state.project.crop);
    msgs.push(["info", "The crop region isn't part of these files. Set it in build_gds_scene.py: ",
      el("code", {}, line), copyButton(line)]);
  }
  showMsgs($("export-msgs"), msgs);
  const ok = !lastExport.errors.length;
  $("write-btn").disabled = $("download-btn").disabled = !ok;
  preview.textContent = ok ? lastExport[`${exportTab}_yaml`] : "Fix the errors above to see the files.";
}

async function writeFiles(overwrite) {
  const box = $("export-msgs");
  try {
    const res = await post("/api/export", {
      project: projectPayload(), write: true, overwrite,
      layers_path: $("out-layers").value.trim(), colors_path: $("out-colors").value.trim(),
    });
    if (res.errors.length) return refreshExport();
    if (res.exists.length) {
      showMsgs(box, [["warn", `${res.exists.join(" and ")} already exist${res.exists.length > 1 ? "" : "s"}.`,
        el("button", { type: "button", onclick: () => writeFiles(true) }, "Overwrite")]]);
      return;
    }
    state.unexported = false;
    showMsgs(box, [["ok", `Wrote ${res.written.join(" and ")}. build_gds_scene.py reads them via CUSTOM_LAYER_STACK / CUSTOM_COLOR_FILE.`],
      ...res.warnings.map((w) => ["warn", w])]);
    api("/api/files").then((f) => { state.files = f; fillFileSelects(); });
  } catch (err) {
    showMsgs(box, [["error", err.message]]);
  }
}

async function copyText(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
  } catch (err) {
    btn.textContent = "Couldn't copy";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 1500);
}

function copyButton(text) {
  const btn = el("button", { type: "button", onclick: () => copyText(btn, text) }, "Copy");
  return btn;
}

function download(name, text) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type: "text/yaml" })), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function bindUI() {
  bindCanvas();

  $("gds-open").addEventListener("click", () => {
    const path = $("gds-select").value;
    if (path) openGds(post("/api/gds/open", { path }), path, path);
  });
  $("gds-upload").addEventListener("change", (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    openGds(api("/api/gds/upload", { method: "POST", body: form }), file.name, null);
    ev.target.value = "";
  });
  $("mask-size").addEventListener("change", (ev) => {
    const prev = state.maskSize;
    state.maskSize = +ev.target.value;
    if (!state.doc) return;
    // Masks change pixel size; rescale so the chip stays where it was on screen
    state.view.scale *= prev / state.maskSize;
    clearDetail();
    state.masks.clear();
    state.tints.clear();
    loadMasks();
  });

  $("opt-glow").addEventListener("change", (ev) => { state.opts.glow = ev.target.checked; scheduleComposite(); });
  $("opt-ghost").addEventListener("change", (ev) => { state.opts.ghost = ev.target.checked; scheduleComposite(); });
  $("opt-bg").addEventListener("input", (ev) => { state.opts.bg = ev.target.value; scheduleComposite(); });
  $("fit-btn").addEventListener("click", fitView);

  // Crop region
  for (const id of ["crop-btn", "crop-draw"]) {
    $(id).addEventListener("click", () => setCropMode(!state.cropMode));
  }
  $("crop-zoom").addEventListener("click", zoomToCrop);
  $("crop-clear").addEventListener("click", () => setCrop(null));
  $("opt-croponly").addEventListener("change", (ev) => { state.opts.cropOnly = ev.target.checked; draw(); });
  $("crop-copy").addEventListener("click", (ev) => copyText(ev.currentTarget, $("crop-line").textContent));
  for (const [id] of CROP_FIELDS) {
    $(id).addEventListener("change", () => {
      const v = Object.fromEntries(CROP_FIELDS.map(([fid, key]) => [key, parseFloat($(fid).value)]));
      if (Object.values(v).some((n) => !Number.isFinite(n))) return;  // wait until all four are filled in
      if (v.w < minCrop() || v.h < minCrop()) {
        status(`At this UNIT_SCALE the crop must be at least ${fmtUm(minCrop())} µm wide and high.`, "error");
        return renderCropPanel();
      }
      setCrop({ x: roundUm(v.x), y: roundUm(v.y), w: roundUm(v.w), h: roundUm(v.h) });
    });
  }

  for (const [id, group, key] of META_INPUTS) {
    $(id).addEventListener("input", (ev) => { state.project[group][key] = ev.target.value; markDirty(); });
  }

  $("import-btn").addEventListener("click", () => {
    showMsgs($("import-msgs"), []);
    $("in-layers-file").value = $("in-colors-file").value = "";
    $("import-dlg").showModal();
  });
  $("import-go").addEventListener("click", runImport);

  $("export-btn").addEventListener("click", () => {
    $("share-mats").checked = !!state.project.share_materials;
    $("export-preview").textContent = "";
    $("export-dlg").showModal();
    refreshExport();
  });
  $("share-mats").addEventListener("change", (ev) => {
    state.project.share_materials = ev.target.checked;
    markDirty();
    refreshExport();
  });
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      exportTab = tab.dataset.tab;
      for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
      if (lastExport && !lastExport.errors.length) $("export-preview").textContent = lastExport[`${exportTab}_yaml`];
    });
  }
  $("write-btn").addEventListener("click", () => writeFiles(false));
  $("download-btn").addEventListener("click", () => {
    if (!lastExport || lastExport.errors.length) return;
    const base = (p) => p.split("/").pop();
    download(base($("out-layers").value.trim() || "custom_layers.yaml"), lastExport.layers_yaml);
    download(base($("out-colors").value.trim() || "custom_colors.yaml"), lastExport.colors_yaml);
  });

  window.addEventListener("beforeunload", (ev) => {
    // Exported YAML or the autosaved copy already hold the work otherwise
    if (state.dirty && state.unexported) { ev.preventDefault(); ev.returnValue = ""; }
  });

  // Project files
  $("proj-open").addEventListener("click", openProjectDialog);
  $("open-go").addEventListener("click", async () => {
    if (await openProject($("open-select").value)) $("open-dlg").close();
  });
  $("proj-save").addEventListener("click", saveCurrent);
  $("proj-saveas").addEventListener("click", openSaveAs);
  $("saveas-go").addEventListener("click", () => runSaveAs(false));
  $("saveas-path").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); runSaveAs(false); }
  });
  for (const id of ["out-layers", "out-colors"]) $(id).addEventListener("change", markDirty);

  // Undo / redo
  $("undo-btn").addEventListener("click", () => undoRedo(false));
  $("redo-btn").addEventListener("click", () => undoRedo(true));
  document.addEventListener("keydown", (ev) => {
    if (!(ev.metaKey || ev.ctrlKey) || ev.altKey) return;
    const key = ev.key.toLowerCase();
    if (key === "s") {
      ev.preventDefault();
      if (!document.querySelector("dialog[open]")) saveCurrent();
      return;
    }
    if (key !== "z" && key !== "y") return;
    // Text fields keep the browser's own undo for what you're typing
    const t = ev.target;
    if (t.matches?.("input:not([type]), input[type=text], input[type=search], textarea")) return;
    if (document.querySelector("dialog[open]")) return;
    ev.preventDefault();
    undoRedo(key === "y" || ev.shiftKey);
  });

  // Viewer tabs, stack column, render panel
  for (const t of document.querySelectorAll(".vtab")) {
    t.addEventListener("click", () => setPane(t.dataset.pane, false));
  }
  $("split-toggle").addEventListener("change", (ev) => setPane(state.ui.pane, ev.target.checked));
  bindStackColumn();
  bindRenderView();
  $("opt-camera").addEventListener("change", (ev) => { state.opts.camera = ev.target.checked; draw(); });
  $("opt-sun").addEventListener("change", (ev) => { state.opts.sun = ev.target.checked; draw(); });
  for (const mode of Object.keys(RUN_MODES)) $(`run-${mode}`).addEventListener("click", () => startRun(mode));
  $("run-cancel").addEventListener("click", async () => {
    try { await post(`/api/render/runs/${encodeURIComponent(state.viewRun)}/cancel`, {}); } catch (err) { status(err.message, "error"); }
    pollRuns();
  });
  $("run-open").addEventListener("click", async () => {
    try {
      await post(`/api/render/runs/${encodeURIComponent(state.viewRun)}/open`, {});
      status("Opening the .blend in Blender…");
    } catch (err) { status(err.message, "error"); }
  });
  $("run-use").addEventListener("click", useRunSettings);
  $("rs-reset").addEventListener("click", () => {
    state.project.render = {};
    markDirty();
    renderAll();
  });
  $("rs-toggle").addEventListener("click", () => {
    const panel = $("render-settings");
    panel.hidden = !panel.hidden;
    $("rs-toggle").classList.toggle("on", !panel.hidden);
  });

  // Preset browser
  $("presets-search").addEventListener("input", renderPresetBrowser);
  $("mats-from-go").addEventListener("click", addMaterialsFromColors);
}

async function init() {
  try { Object.assign(state.ui, JSON.parse(localStorage.getItem(VIEW_KEY) || "{}")); } catch (err) { /* defaults */ }
  bindUI();
  setPane(state.ui.pane, state.ui.split);
  renderAll();
  try {
    [state.presets, state.files] = await Promise.all([api("/api/presets"), api("/api/files")]);
  } catch (err) {
    status(`Can't reach the server: ${err.message}`, "error");
    return;
  }
  try {
    state.renderInfo = await api("/api/render/info");
    renderLayerList();  // vertex warnings depend on MAX_POLYGON_VERTICES
  } catch (err) {
    showMsgs($("run-msgs"), [["error", `Can't build from the UI: ${err.message}`]]);
  }
  loadRuns();
  fillFileSelects();
  resetHistory();

  // Start from the project's current config files, if there are any
  const yamls = new Set(state.files.yaml);
  if (yamls.has("custom_layers.yaml") && yamls.has("custom_colors.yaml")) {
    try {
      const { project } = await post("/api/import",
        { layers_path: "custom_layers.yaml", colors_path: "custom_colors.yaml" });
      applyProject(project);
      status("Loaded custom_layers.yaml and custom_colors.yaml. Open a GDS file to preview.");
    } catch (err) {
      status(`Couldn't read the existing YAML files: ${err.message}`, "error");
    }
  } else {
    renderAll();
    status("Open a GDS file to start.");
  }
  offerRecovery();
}

init();
