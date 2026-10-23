"use strict";
/* Pokémon Collection — web app per iPad. Tutti i dati restano sul dispositivo (IndexedDB). */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "—").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
const eur = (c, cur) => c == null ? "—" : new Intl.NumberFormat("it-IT", { style: "currency", currency: cur || "EUR" }).format(c / 100);
const when = s => s ? new Date(s).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "mai";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const AUTO_ADD = 0.75;                 // sotto questa sicurezza il flag non si barra da solo
const MARKET_DELAY = 1100;             // il limite dichiarato per /marketplace/products è 1 chiamata/secondo
const API_DIRECT = "https://api.cardtrader.com/api/v2";

/* ------------------------------------------------------------ impostazioni */
const Settings = {
  defaults: { token: "", proxy: "", condition: "Near Mint", language: "", currency: "EUR" },
  get() { try { return { ...this.defaults, ...JSON.parse(localStorage.getItem("pc_settings") || "{}") }; } catch (e) { return { ...this.defaults }; } },
  set(v) { localStorage.setItem("pc_settings", JSON.stringify({ ...this.get(), ...v })); },
};

/* ---------------------------------------------------------------- database */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("pokecollection", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("expansions", { keyPath: "id" });
        d.createObjectStore("cards", { keyPath: "blueprint_id" }).createIndex("expansion_id", "expansion_id");
        d.createObjectStore("collection", { keyPath: "blueprint_id" });
        d.createObjectStore("history", { keyPath: "id", autoIncrement: true }).createIndex("blueprint_id", "blueprint_id");
        d.createObjectStore("meta", { keyPath: "key" });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  _req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  _s(n, mode = "readonly") { return this.db.transaction(n, mode).objectStore(n); },
  get(n, k) { return this._req(this._s(n).get(k)); },
  getAll(n) { return this._req(this._s(n).getAll()); },
  put(n, v) { return this._req(this._s(n, "readwrite").put(v)); },
  del(n, k) { return this._req(this._s(n, "readwrite").delete(k)); },
  clear(n) { return this._req(this._s(n, "readwrite").clear()); },
  count(n) { return this._req(this._s(n).count()); },
  byIndex(n, i, v) { return this._req(this._s(n).index(i).getAll(v)); },
  putMany(n, arr) {
    return new Promise((res, rej) => {
      const tx = this.db.transaction(n, "readwrite"); const s = tx.objectStore(n);
      arr.forEach(v => s.put(v));
      tx.oncomplete = () => res(); tx.onerror = tx.onabort = () => rej(tx.error);
    });
  },
  async meta(k, def = null) { const r = await this.get("meta", k); return r ? r.value : def; },
  setMeta(k, value) { return this.put("meta", { key: k, value }); },
};

/* ---------------------------------------------------------------- CardTrader */
class CTError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

async function ctGet(path, params = {}) {
  const s = Settings.get();
  if (!s.token) throw new CTError("Manca il token CardTrader: inseriscilo in Impostazioni.", "token");
  const base = (s.proxy ? s.proxy.replace(/\/+$/, "") : API_DIRECT);
  const url = new URL(base + path);
  Object.entries(params).forEach(([k, v]) => v != null && v !== "" && url.searchParams.set(k, v));
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try { r = await fetch(url, { headers: { Authorization: "Bearer " + s.token } }); }
    catch (e) {
      throw new CTError(s.proxy
        ? "Il proxy non risponde: controlla l'indirizzo in Impostazioni e la connessione."
        : "Il browser non riesce a parlare con CardTrader (probabile blocco di sicurezza CORS o nessuna connessione). Configura il proxy gratuito come spiegato nel LEGGIMI.", "network");
    }
    if (r.status === 429) { await sleep(2000 + attempt * 2000); continue; }
    if (r.status === 401) throw new CTError("Token CardTrader non valido (401).", "auth");
    if (!r.ok) throw new CTError("CardTrader ha risposto con errore " + r.status, "http");
    return r.json();
  }
  throw new CTError("CardTrader: troppe richieste, riprova tra poco.", "rate");
}

const first = (o, ...keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== "") return o[k]; return null; };
function normKey(num) {
  if (num == null) return null;
  const s = String(num).trim().toUpperCase().split("/")[0].trim();
  const m = s.match(/^([A-Z]*)0*(\d+)([A-Z]*)$/);
  return m ? m[1] + m[2] + m[3] : (s || null);
}
function parseBlueprint(bp) {
  const fp = (bp.fixed_properties && typeof bp.fixed_properties === "object") ? bp.fixed_properties : {};
  const number = first(fp, "collector_number", "pokemon_number", "number");
  let hp = first(fp, "pokemon_hp", "hp");
  hp = hp != null ? parseInt(String(hp).replace(/\D/g, ""), 10) : null;
  if (Number.isNaN(hp)) hp = null;
  let img = bp.image_url; if (img && typeof img === "object") img = img.url;
  if (img && img.startsWith("/")) img = "https://cardtrader.com" + img;
  return {
    blueprint_id: bp.id, expansion_id: bp.expansion_id, name: bp.name || "", version: bp.version ?? null,
    collector_number: number != null ? String(number) : null, collector_key: normKey(number),
    rarity: first(fp, "pokemon_rarity", "rarity"), card_type: first(fp, "pokemon_type", "pokemon_card_type", "type"),
    hp, image_url: img || null,
  };
}

async function bestPrice(blueprintId) {
  const s = Settings.get();
  const data = await ctGet("/marketplace/products", { blueprint_id: blueprintId, language: s.language || null });
  let list = (data && (data[String(blueprintId)] || data[blueprintId])) || [];
  list = list.filter(p => !p.on_vacation && !p.graded && p.price && p.price.cents);
  if (s.condition) { const c = list.filter(p => (p.properties_hash || {}).condition === s.condition); if (c.length) list = c; }
  if (!list.length) return { cents: null, currency: null, offers: 0 };
  const cur = list.filter(p => p.price.currency === (s.currency || "EUR"));
  const pool = cur.length ? cur : list;
  const cheapest = pool.reduce((a, b) => (b.price.cents < a.price.cents ? b : a));
  return { cents: cheapest.price.cents, currency: cheapest.price.currency, offers: list.length };
}

/* ------------------------------------------------------------ catalogo */
const Cache = { cards: [], exps: new Map(), byKey: new Map(), byName: new Map() };

async function loadCache() {
  const [cards, exps] = await Promise.all([DB.getAll("cards"), DB.getAll("expansions")]);
  Cache.exps = new Map(exps.map(e => [e.id, e]));
  Cache.cards = cards.map(c => ({ id: c.blueprint_id, name: c.name, cn: cleanName(c.name), key: c.collector_key, exp: c.expansion_id }));
  Cache.byKey = new Map(); Cache.byName = new Map();
  for (const c of Cache.cards) {
    if (c.key) { if (!Cache.byKey.has(c.key)) Cache.byKey.set(c.key, []); Cache.byKey.get(c.key).push(c); }
    if (c.cn) { if (!Cache.byName.has(c.cn)) Cache.byName.set(c.cn, []); Cache.byName.get(c.cn).push(c); }
  }
}

async function syncCatalog(onProgress) {
  const games = await ctGet("/games");
  const g = games.find(x => /pok/i.test(x.name || "") || /pok/i.test(x.display_name || ""));
  if (!g) throw new CTError("Gioco Pokémon non trovato su CardTrader.", "nogame");
  const exps = (await ctGet("/expansions")).filter(e => e.game_id === g.id);
  await DB.putMany("expansions", exps.map(e => ({ id: e.id, game_id: e.game_id, code: e.code, name: e.name })));
  let done = new Set((await DB.meta("sync_done", [])) || []);
  if (await DB.meta("sync_complete", true)) { done = new Set(); await DB.setMeta("sync_complete", false); }   // nuovo giro
  let i = 0;
  for (const e of exps) {
    i++;
    onProgress && onProgress(i, exps.length, e.name);
    if (done.has(e.id)) continue;
    const bps = await ctGet("/blueprints/export", { expansion_id: e.id });
    const old = new Map((await DB.byIndex("cards", "expansion_id", e.id)).map(c => [c.blueprint_id, c]));
    const rows = bps.map(bp => {
      bp.expansion_id = bp.expansion_id ?? e.id;
      const p = parseBlueprint(bp), o = old.get(p.blueprint_id);
      if (o) {   // non perdere prezzi e dettagli già raccolti
        p.rarity = p.rarity ?? o.rarity; p.card_type = p.card_type ?? o.card_type; p.hp = p.hp ?? o.hp;
        p.last_price_cents = o.last_price_cents; p.last_price_currency = o.last_price_currency; p.last_price_at = o.last_price_at;
      }
      return p;
    });
    await DB.putMany("cards", rows);
    done.add(e.id); await DB.setMeta("sync_done", [...done]);
  }
  await DB.setMeta("sync_complete", true);
  await DB.setMeta("catalog_synced_at", new Date().toISOString());
  await loadCache();
}

/* -------------------------------------------------------- riconoscimento */
function cleanName(s) { return String(s || "").replace(/\(.*?\)/g, " ").toLowerCase().replace(/[^a-z0-9àèéìòù ]/g, " ").replace(/\s+/g, " ").trim(); }
function lev(a, b) {
  if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
function nameScore(cn, lines) {
  if (!cn) return 0;
  let best = 0;
  for (const l of lines) {
    if (l.length < 3) continue;
    if (l.includes(cn)) { best = Math.max(best, cn.length >= 4 ? 1 : 0.8); continue; }
    const d = lev(cn, l.length > cn.length + 6 ? l.slice(0, cn.length + 3) : l);
    best = Math.max(best, 1 - d / Math.max(cn.length, Math.min(l.length, cn.length + 3)));
  }
  return best;
}

async function identify(ocrText, nameHint, limit = 5) {
  const text = ocrText || "";
  const lines = text.split(/[\r\n]+/).map(cleanName).filter(l => l.length >= 3 && l.length <= 40);
  if (nameHint) lines.unshift(cleanName(nameHint));

  let key = null;
  const up = text.toUpperCase();
  let m = up.match(/\b([A-Z]{0,4}\d{1,3})\s*\/\s*(\d{1,3})\b/);
  if (m) key = normKey(m[1]);
  else if ((m = up.match(/\b(SVP|SWSH|SM|XY|BW|HGSS|DP|SMP)\s*0*(\d{1,3})\b/))) key = normKey(m[1] + m[2]);
  const tokens = new Set(up.match(/[A-Z0-9]{2,6}/g) || []);

  let pool = key ? (Cache.byKey.get(key) || []) : [];
  const keyFound = pool.length > 0;
  const scored = [];
  if (keyFound) {
    for (const c of pool) {
      const ns = nameScore(c.cn, lines);
      const code = (Cache.exps.get(c.exp) || {}).code;
      scored.push([0.65 * ns + 0.25 + (code && tokens.has(code.toUpperCase()) ? 0.10 : 0), c]);
    }
  } else {
    for (const [cn, cs] of Cache.byName) {
      const ns = nameScore(cn, lines);
      if (ns < 0.55) continue;
      for (const c of cs) {
        const code = (Cache.exps.get(c.exp) || {}).code;
        scored.push([0.65 * ns + (code && tokens.has(code.toUpperCase()) ? 0.10 : 0), c]);
      }
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  const out = [];
  for (const [score, c] of scored.slice(0, limit)) {
    const full = await cardFull(c.id);
    full.confidence = Math.round(Math.min(score, 1) * 1000) / 1000;
    out.push(full);
  }
  return out;
}

async function cardFull(id) {
  const c = await DB.get("cards", id); if (!c) return null;
  const e = Cache.exps.get(c.expansion_id) || {};
  const col = await DB.get("collection", id);
  return { ...c, expansion_name: e.name, expansion_code: e.code, owned_qty: col ? col.quantity : null, added_at: col ? col.added_at : null };
}

/* ------------------------------------- raccolta, prezzi, completamento dati */
const TYPE_IT = { Fire: "Fuoco", Water: "Acqua", Grass: "Erba", Lightning: "Lampo", Psychic: "Psico", Fighting: "Lotta", Darkness: "Oscurità", Metal: "Metallo", Dragon: "Drago", Fairy: "Folletto", Colorless: "Incolore", Trainer: "Allenatore", Energy: "Energia" };

async function recordPrice(id, withHistory) {
  const p = await bestPrice(id);
  const now = new Date().toISOString();
  const c = await DB.get("cards", id);
  if (c && p.cents != null) { c.last_price_cents = p.cents; c.last_price_currency = p.currency; c.last_price_at = now; await DB.put("cards", c); }
  if (withHistory) await DB.put("history", { blueprint_id: id, checked_at: now, price_cents: p.cents, currency: p.currency, offers: p.offers });
  return p;
}

async function enrichCard(id) {   // best effort: completa PS/tipo/rarità da pokemontcg.io
  try {
    const c = await DB.get("cards", id);
    if (!c || (c.hp && c.card_type && c.rarity) || !c.collector_key) return;
    const exp = (Cache.exps.get(c.expansion_id) || {}).name || "";
    const name = c.name.replace(/\(.*?\)/g, " ").replace(/"/g, "").trim();
    const r = await fetch("https://api.pokemontcg.io/v2/cards?q=" + encodeURIComponent(`name:"${name}" number:${c.collector_key}`));
    if (!r.ok) return;
    const res = (await r.json()).data || [];
    if (!res.length) return;
    const sim = x => 1 - lev(x.set.name.toLowerCase(), exp.toLowerCase()) / Math.max(x.set.name.length, exp.length, 1);
    const best = res.reduce((a, b) => (sim(b) > sim(a) ? b : a));
    const t = (best.types || [])[0];
    c.card_type = c.card_type ?? (t ? (TYPE_IT[t] || t) : (TYPE_IT[best.supertype] || best.supertype || null));
    c.hp = c.hp ?? (/^\d+$/.test(best.hp || "") ? parseInt(best.hp, 10) : null);
    c.rarity = c.rarity ?? best.rarity ?? null;
    await DB.put("cards", c);
  } catch (e) { /* ignora */ }
}

async function setOwned(id, owned, quantity) {
  const existing = await DB.get("collection", id);
  if (!owned) { await DB.del("collection", id); return cardFull(id); }
  if (!existing) {
    await DB.put("collection", { blueprint_id: id, quantity: Math.max(1, quantity || 1), added_at: new Date().toISOString() });
    // prezzo iniziale nello storico + dettagli mancanti, in background
    (async () => { try { await recordPrice(id, true); } catch (e) { } await enrichCard(id); if ($("#v-coll").classList.contains("on")) renderCollection(); })();
  } else if (quantity) { existing.quantity = Math.max(1, quantity); await DB.put("collection", existing); }
  return cardFull(id);
}

let refreshing = false, cancelRefresh = false;
async function refreshAll() {
  if (refreshing) return;
  const col = await DB.getAll("collection");
  if (!col.length) return alert("La raccolta è vuota.");
  refreshing = true; cancelRefresh = false;
  const box = $("#refreshBox"); box.style.display = "";
  $("#btnRefresh").disabled = true;
  let errors = 0, lastErr = "";
  for (let i = 0; i < col.length; i++) {
    if (cancelRefresh) break;
    box.innerHTML = `<b>Aggiorno i prezzi… ${i + 1}/${col.length}</b><progress max="${col.length}" value="${i}"></progress><button class="btn sec" id="cancelRef" style="margin-top:10px">Interrompi</button>`;
    $("#cancelRef").onclick = () => { cancelRefresh = true; };
    try { await recordPrice(col[i].blueprint_id, true); } catch (e) { errors++; lastErr = e.message; if (e.code === "auth" || e.code === "network" || e.code === "token") break; }
    if (i < col.length - 1) await sleep(MARKET_DELAY);
  }
  if (!errors) await DB.setMeta("prices_updated_at", new Date().toISOString());
  refreshing = false; $("#btnRefresh").disabled = false;
  box.innerHTML = errors ? `<div class="msg err" style="margin:0">Aggiornamento non completato: ${esc(lastErr)}</div>` : cancelRefresh ? "Interrotto." : '<div class="msg ok" style="margin:0">Valori aggiornati.</div>';
  setTimeout(() => { if (!refreshing) box.style.display = "none"; }, errors ? 12000 : 3000);
  renderCollection();
}

/* ------------------------------------------------------------------ viste */
function showTab(t) {
  $$("nav button").forEach(b => b.classList.toggle("on", b.dataset.tab === t));
  $$(".view").forEach(v => v.classList.toggle("on", v.id === "v-" + t));
  if (t === "scan") { startCamera(); renderScanStatus(); } else stopCamera();
  if (t === "coll") renderCollection();
  if (t === "set") renderSettings();
}
$$("nav button").forEach(b => b.onclick = () => showTab(b.dataset.tab));

async function renderScanStatus() {
  const s = Settings.get(); const n = await DB.count("cards"); const out = [];
  if (!s.token || !n) out.push(`<div class="msg warn">${!s.token ? "Prima di iniziare inserisci il token CardTrader" : "Il catalogo è vuoto: scaricalo"} in <b>Impostazioni</b>.</div>`);
  $("#scanStatus").innerHTML = out.join("");
}

/* ---- fotocamera + OCR */
let stream = null, worker = null;
async function startCamera() {
  if (stream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $("#camMsg").innerHTML = '<div class="msg warn">Fotocamera non disponibile qui: usa «Usa una foto».</div>'; return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false });
    const v = $("#video"); v.srcObject = stream; await v.play();
    $("#camMsg").innerHTML = "";
    const fit = () => layoutGuide();
    v.onloadedmetadata = fit; fit(); window.addEventListener("resize", fit);
  } catch (e) {
    stream = null;
    $("#camMsg").innerHTML = '<div class="msg warn">Non riesco ad aprire la fotocamera (hai dato il permesso a Safari?). Puoi comunque usare «Usa una foto».</div>';
  }
}
function stopCamera() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; $("#video").srcObject = null; } }
document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); else if ($("#v-scan").classList.contains("on")) startCamera(); });

const CARD_RATIO = 63 / 88;   // larghezza/altezza di una carta
function guideRect(vw, vh) {   // riquadro (in proporzione del frame) dove sta la carta
  const gh = Math.min(0.92 * vh, 0.92 * vw / CARD_RATIO), gw = gh * CARD_RATIO;
  return { x: (vw - gw) / 2, y: (vh - gh) / 2, w: gw, h: gh };
}
function layoutGuide() {
  const v = $("#video"); const vw = v.videoWidth || 16, vh = v.videoHeight || 9;
  const cam = $("#cam"); cam.style.aspectRatio = vw + " / " + vh; cam.style.maxHeight = "70vh";
  cam.style.width = `min(100%, ${70 * vw / vh}vh)`;
  const g = guideRect(vw, vh), el = $("#guide");
  el.style.left = (100 * g.x / vw) + "%"; el.style.top = (100 * g.y / vh) + "%";
  el.style.width = (100 * g.w / vw) + "%"; el.style.height = (100 * g.h / vh) + "%";
}

function preprocess(src, sx, sy, sw, sh, targetW) {
  const scale = Math.max(0.5, Math.min(2.5, targetW / sw));
  const c = document.createElement("canvas"); c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high"; ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const im = ctx.getImageData(0, 0, c.width, c.height), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g = Math.max(0, Math.min(255, (g - 128) * 1.45 + 128));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}
async function getWorker() {
  if (!worker) worker = await Tesseract.createWorker("eng", 1, { workerPath: "worker.min.js", corePath: "./", langPath: "./", gzip: true, cacheMethod: "none" });
  return worker;
}
async function ocrCanvas(c) { const w = await getWorker(); const { data } = await w.recognize(c); return data.text || ""; }

async function ocrSource(src, w, h, cropToGuide) {
  let x = 0, y = 0, cw = w, ch = h;
  if (cropToGuide) { const g = guideRect(w, h); x = g.x; y = g.y; cw = g.w; ch = g.h; }
  const parts = [];
  parts.push(await ocrCanvas(preprocess(src, x, y, cw, ch * 0.2, 1400)));                  // nome
  parts.push(await ocrCanvas(preprocess(src, x, y + ch * 0.8, cw, ch * 0.2, 1600)));       // numero/collezione
  parts.push(await ocrCanvas(preprocess(src, x, y, cw, ch, 1200)));                        // carta intera
  return parts.join("\n");
}

async function scanAndShow(src, w, h, cropToGuide) {
  $("#result").innerHTML = '<div class="panel spin">⏳ Leggo la carta… (la prima volta ci vuole qualche secondo)</div>';
  try {
    const text = await ocrSource(src, w, h, cropToGuide);
    const cands = await identify(text);
    lastCandidates = cands;
    if (!cands.length) {
      $("#result").innerHTML = '<div class="msg warn">Carta non riconosciuta. Riprova con più luce, tutta la carta nel riquadro, oppure cerca per nome.</div>' +
        `<details><summary>Testo letto</summary><pre>${esc(text)}</pre></details>`;
      return;
    }
    autoAddedId = null;
    await selectCard(cands[0], true);
  } catch (e) { $("#result").innerHTML = `<div class="msg err">Errore: ${esc(e.message)}</div>`; }
}

$("#shoot").onclick = async () => {
  const v = $("#video");
  if (!stream || !v.videoWidth) { $("#camMsg").innerHTML = '<div class="msg warn">Fotocamera non attiva: usa «Usa una foto».</div>'; return; }
  const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext("2d").drawImage(v, 0, 0);
  await scanAndShow(c, c.width, c.height, true);
};
$("#pickPhoto").onclick = () => $("#file").click();
$("#file").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const bmp = await createImageBitmap(f);
  await scanAndShow(bmp, bmp.width, bmp.height, false);
};

/* ---- risultato di scansione */
let current = null, autoAddedId = null, lastCandidates = [];

async function selectCard(card, fromScan) {
  if (autoAddedId && autoAddedId !== card.blueprint_id) { await setOwned(autoAddedId, false); autoAddedId = null; }
  current = card;
  if (fromScan && card.owned_qty == null && (card.confidence ?? 1) >= AUTO_ADD) {
    const conf = card.confidence; current = await setOwned(card.blueprint_id, true); current.confidence = conf; autoAddedId = card.blueprint_id;
  }
  renderResult();
  const id = card.blueprint_id;
  if (Settings.get().token) {
    try {
      const p = await recordPrice(id, current.owned_qty != null);
      if (current && current.blueprint_id === id) { const conf = current.confidence; current = await cardFull(id); current.confidence = conf; renderResult(); }
      if (p.cents == null) $("#result").insertAdjacentHTML("beforeend", '<div class="msg warn">Nessuna offerta in vendita trovata per questa carta.</div>');
    } catch (e) { $("#result").insertAdjacentHTML("beforeend", `<div class="msg warn">Prezzo non aggiornato: ${esc(e.message)}</div>`); }
    await enrichCard(id);
    if (current && current.blueprint_id === id) { const conf = current.confidence; current = await cardFull(id); current.confidence = conf; renderResult(); }
  }
}

function candHtml(x) {
  return `<div class="cand" data-pick="${x.blueprint_id}">${x.image_url ? `<img src="${esc(x.image_url)}" alt="">` : ""}
    <div><div class="t">${esc(x.name)} <span style="color:var(--mut)">#${esc(x.collector_number)}</span></div><div class="s">${esc(x.expansion_name)}</div></div></div>`;
}

function renderResult() {
  const c = current; if (!c) return;
  const owned = c.owned_qty != null, others = lastCandidates.filter(x => x.blueprint_id !== c.blueprint_id);
  const low = c.confidence != null && c.confidence < AUTO_ADD;
  $("#result").innerHTML = `
    <div class="panel">
      <div class="hero">${c.image_url ? `<img src="${esc(c.image_url)}" alt="">` : '<div class="noimg"></div>'}
        <div><div class="name">${esc(c.name)}</div><div class="coll">${esc(c.expansion_name)}</div>
          <div class="grid"><span>Numero</span><span>${esc(c.collector_number)}</span><span>Tipo</span><span>${esc(c.card_type)}</span>
            <span>PS</span><span>${c.hp ?? "—"}</span><span>Rarità</span><span>${esc(c.rarity)}</span></div></div></div>
      <div class="price">${eur(c.last_price_cents, c.last_price_currency)}<small>prezzo minimo in vendita su CardTrader${c.last_price_at ? " · " + esc(when(c.last_price_at)) : ""}</small></div>
      <label class="flag"><input type="checkbox" id="own" ${owned ? "checked" : ""}><span>Ce l'ho nella mia raccolta</span>
        ${owned ? `<span class="qty"><button id="qm">−</button><b>${c.owned_qty}</b><button id="qp">+</button></span>` : ""}</label>
      ${low ? '<div class="msg warn" style="margin:12px 0 0">Non sono sicuro che sia questa: controlla e barra tu il flag, oppure scegli un’altra carta.</div>' : ""}
    </div>
    ${others.length ? `<div class="panel"><b>Forse era un’altra?</b>${others.map(candHtml).join("")}</div>` : ""}`;
  $("#own").onchange = async e => { const k = c.confidence; current = await setOwned(c.blueprint_id, e.target.checked); current.confidence = k; if (!e.target.checked) autoAddedId = null; renderResult(); };
  if (owned) {
    const setQ = async n => { const k = c.confidence; current = n < 1 ? await setOwned(c.blueprint_id, false) : await setOwned(c.blueprint_id, true, n); current.confidence = k; renderResult(); };
    $("#qm").onclick = e => { e.preventDefault(); setQ(c.owned_qty - 1); }; $("#qp").onclick = e => { e.preventDefault(); setQ(c.owned_qty + 1); };
  }
  $$("#result [data-pick]").forEach(el => el.onclick = () => selectCard(lastCandidates.find(k => k.blueprint_id == el.dataset.pick), false));
}

let st; $("#q").oninput = () => { clearTimeout(st); st = setTimeout(doSearch, 300); };
async function doSearch() {
  const q = cleanName($("#q").value); if (q.length < 2) { $("#searchOut").innerHTML = ""; return; }
  const hits = Cache.cards.filter(c => c.cn.includes(q)).slice(0, 20);
  const list = []; for (const h of hits) list.push(await cardFull(h.id));
  lastCandidates = list;
  $("#searchOut").innerHTML = list.map(candHtml).join("") || '<div class="note" style="margin-top:8px">Nessun risultato</div>';
  $$("#searchOut [data-pick]").forEach(el => el.onclick = () => { autoAddedId = null; selectCard(list.find(k => k.blueprint_id == el.dataset.pick), false); window.scrollTo({ top: 0, behavior: "smooth" }); });
}

/* ------------------------------------------------------------- raccolta */
let rows = [], sortKey = "added_at", sortDir = -1;
const COLS = [["image_url", "", false, false], ["name", "Nome", false, false], ["expansion_name", "Collezione", false, true], ["collector_number", "N°", false, false],
  ["card_type", "Tipo", false, true], ["hp", "PS", true, true], ["owned_qty", "Q.tà", true, false], ["last_price_cents", "Valore", true, false], ["delta", "Var.", true, false], ["added_at", "Aggiunta", false, true]];

async function renderCollection() {
  const col = await DB.getAll("collection"); const list = [];
  for (const c of col) {
    const f = await cardFull(c.blueprint_id); if (!f) continue;
    const hist = (await DB.byIndex("history", "blueprint_id", c.blueprint_id)).filter(h => h.price_cents != null).sort((a, b) => a.checked_at < b.checked_at ? -1 : 1);
    f.delta = hist.length && f.last_price_cents ? (f.last_price_cents - hist[0].price_cents) / hist[0].price_cents : null;
    list.push(f);
  }
  rows = list;
  const total = rows.reduce((a, r) => a + (r.last_price_cents || 0) * r.owned_qty, 0);
  $("#total").textContent = eur(total, Settings.get().currency);
  $("#totalInfo").textContent = `${rows.length} carte diverse · ${rows.reduce((a, r) => a + r.owned_qty, 0)} totali · prezzi aggiornati: ${when(await DB.meta("prices_updated_at"))}`;
  $("#collNote").textContent = "I valori cambiano solo quando premi «Aggiorna valore collezione»: ogni aggiornamento aggiunge un punto allo storico di ogni carta.";
  drawTable();
}
function drawTable() {
  const f = cleanName($("#filter").value);
  const l = rows.filter(r => !f || cleanName([r.name, r.expansion_name, r.card_type, r.collector_number].join(" ")).includes(f));
  l.sort((a, b) => { const x = a[sortKey], y = b[sortKey]; if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * sortDir; });
  if (!l.length) { $("#tableWrap").innerHTML = `<div class="empty">${rows.length ? "Nessun risultato." : "Nessuna carta ancora: scansionane una!"}</div>`; return; }
  $("#tableWrap").innerHTML = `<table><thead><tr>${COLS.map(([k, t, n, h]) => `<th class="${n ? "num" : ""} ${h ? "hide-s" : ""}" data-k="${k}">${t}${k === sortKey ? (sortDir > 0 ? " ▲" : " ▼") : ""}</th>`).join("")}</tr></thead><tbody>${
    l.map(r => `<tr data-id="${r.blueprint_id}"><td>${r.image_url ? `<img src="${esc(r.image_url)}" loading="lazy" alt="">` : ""}</td>
      <td><b>${esc(r.name)}</b></td><td class="hide-s">${esc(r.expansion_name)}</td><td>${esc(r.collector_number)}</td><td class="hide-s">${esc(r.card_type)}</td>
      <td class="num hide-s">${r.hp ?? "—"}</td><td class="num">${r.owned_qty}</td><td class="num"><b>${eur(r.last_price_cents, r.last_price_currency)}</b></td>
      <td class="num ${r.delta > 0 ? "up" : r.delta < 0 ? "down" : ""}">${r.delta == null ? "—" : (r.delta > 0 ? "+" : "") + (r.delta * 100).toFixed(1) + "%"}</td>
      <td class="hide-s">${when(r.added_at)}</td></tr>`).join("")}</tbody></table>`;
  $$("#tableWrap th").forEach(th => th.onclick = () => { const k = th.dataset.k; if (!k || k === "image_url") return; sortDir = k === sortKey ? -sortDir : 1; sortKey = k; drawTable(); });
  $$("#tableWrap tbody tr").forEach(tr => tr.onclick = () => openCard(+tr.dataset.id));
}
$("#filter").oninput = drawTable;
$("#btnRefresh").onclick = refreshAll;

function chart(hist) {
  const pts = hist.filter(h => h.price_cents != null);
  if (pts.length < 2) return '<div class="note">Servono almeno due controlli per vedere il grafico.</div>';
  const W = 680, H = 190, P = 40, xs = pts.map(p => +new Date(p.checked_at)), ys = pts.map(p => p.price_cents / 100);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), pad = (y1 - y0) || 1;
  const X = v => P + (W - 2 * P) * (x1 === x0 ? .5 : (v - x0) / (x1 - x0)), Y = v => H - P - (H - 2 * P) * ((v - (y0 - pad * .1)) / (pad * 1.2));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%"><path d="${path}" fill="none" stroke="#ffcb05" stroke-width="2.5"/>
    ${pts.map((p, i) => `<circle cx="${X(xs[i])}" cy="${Y(ys[i])}" r="4" fill="#ffcb05"><title>${eur(p.price_cents, p.currency)} · ${when(p.checked_at)}</title></circle>`).join("")}
    <text x="4" y="${Y(y1) + 4}">${y1.toFixed(2)}€</text><text x="4" y="${Y(y0) + 4}">${y0.toFixed(2)}€</text>
    <text x="${P}" y="${H - 8}">${new Date(x0).toLocaleDateString("it-IT")}</text><text x="${W - P}" y="${H - 8}" text-anchor="end">${new Date(x1).toLocaleDateString("it-IT")}</text></svg>`;
}
async function openCard(id) {
  const c = await cardFull(id);
  const hist = (await DB.byIndex("history", "blueprint_id", id)).sort((a, b) => a.checked_at < b.checked_at ? -1 : 1);
  $("#dlgBody").innerHTML = `<div class="hero">${c.image_url ? `<img src="${esc(c.image_url)}" alt="">` : ""}<div style="flex:1"><div class="name">${esc(c.name)}</div><div class="coll">${esc(c.expansion_name)}</div>
    <div class="kv"><span>Numero</span><span>${esc(c.collector_number)}</span><span>Tipo</span><span>${esc(c.card_type)}</span><span>PS</span><span>${c.hp ?? "—"}</span><span>Rarità</span><span>${esc(c.rarity)}</span>
    <span>Quantità</span><span>${c.owned_qty ?? 0}</span><span>Valore attuale</span><span><b>${eur(c.last_price_cents, c.last_price_currency)}</b></span></div></div></div>
    <h3 style="margin:14px 0 4px">Storico del valore</h3>${chart(hist)}
    <div class="hist">${[...hist].reverse().map(h => `<div><span>${when(h.checked_at)}</span><span>${eur(h.price_cents, h.currency)} · ${h.offers ?? 0} offerte</span></div>`).join("")}</div>
    <div style="margin-top:16px;display:flex;gap:8px;justify-content:space-between"><button class="btn bad" id="rm">Rimuovi dalla raccolta</button><button class="btn sec" id="cl">Chiudi</button></div>`;
  $("#dlg").showModal();
  $("#cl").onclick = () => $("#dlg").close();
  $("#rm").onclick = async () => { if (confirm("Rimuovere questa carta dalla raccolta? Lo storico prezzi resta salvato.")) { await setOwned(id, false); $("#dlg").close(); renderCollection(); } };
}

/* ---------------------------------------------------------- impostazioni */
async function renderSettings() {
  const s = Settings.get();
  $("#sToken").value = s.token; $("#sProxy").value = s.proxy; $("#sCond").value = s.condition; $("#sLang").value = s.language; $("#sCur").value = s.currency;
  const [ne, nc, no, sync] = await Promise.all([DB.count("expansions"), DB.count("cards"), DB.count("collection"), DB.meta("catalog_synced_at")]);
  $("#catInfo").textContent = nc ? `Catalogo: ${ne} collezioni, ${nc.toLocaleString("it-IT")} carte · ultimo aggiornamento ${when(sync)}. Il primo scarico richiede alcuni minuti: tieni l'iPad acceso e l'app aperta.` : "Il catalogo è vuoto. Il primo scarico richiede alcuni minuti: tieni l'iPad acceso e l'app aperta.";
  $("#setStatus").innerHTML = !s.token ? '<div class="msg warn">Inserisci il token CardTrader e premi <b>Salva</b>. Lo trovi nel tuo profilo CardTrader, tra le impostazioni per sviluppatori.</div>' : "";
}
$("#sSave").onclick = () => {
  Settings.set({ token: $("#sToken").value.trim(), proxy: $("#sProxy").value.trim(), condition: $("#sCond").value, language: $("#sLang").value.trim().toLowerCase(), currency: ($("#sCur").value.trim() || "EUR").toUpperCase() });
  $("#sTestOut").innerHTML = '<div class="msg ok">Salvato.</div>'; renderSettings();
};
$("#sTest").onclick = async () => {
  $("#sSave").click(); $("#sTestOut").innerHTML = "Provo…";
  try { const r = await ctGet("/info"); $("#sTestOut").innerHTML = `<div class="msg ok">Collegamento riuscito${r && r.name ? " — " + esc(r.name) : ""}.</div>`; }
  catch (e) { $("#sTestOut").innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
};
let syncing = false;
$("#btnCatalog").onclick = async () => {
  if (syncing) return; syncing = true; $("#btnCatalog").disabled = true;
  const box = $("#catBox");
  try {
    box.innerHTML = "Avvio…";
    await syncCatalog((i, n, name) => { box.innerHTML = `<b>Collezione ${i}/${n}</b> — ${esc(name)}<progress max="${n}" value="${i}"></progress>`; });
    box.innerHTML = '<div class="msg ok">Catalogo aggiornato.</div>';
  } catch (e) { box.innerHTML = `<div class="msg err">${esc(e.message)} Puoi premere di nuovo il pulsante: riparte da dove si era fermato.</div>`; }
  syncing = false; $("#btnCatalog").disabled = false; renderSettings();
};

/* ---- backup */
async function saveFile(name, mime, text) {
  const blob = new Blob([text], { type: mime }), file = new File([blob], name, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === "AbortError") return; } }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$("#bExport").onclick = async () => {
  const col = await DB.getAll("collection"); const cards = [];
  for (const c of col) cards.push(await DB.get("cards", c.blueprint_id));
  const data = { app: "pokecollection", version: 1, exported_at: new Date().toISOString(), expansions: [...new Set(cards.filter(Boolean).map(c => c.expansion_id))].map(id => Cache.exps.get(id)).filter(Boolean), cards: cards.filter(Boolean), collection: col, history: await DB.getAll("history") };
  await saveFile(`pokemon-backup-${new Date().toISOString().slice(0, 10)}.json`, "application/json", JSON.stringify(data));
  $("#bOut").innerHTML = '<div class="msg ok">Backup pronto: salvalo in File o iCloud Drive.</div>';
};
$("#bCsv").onclick = async () => {
  await renderCollection();
  const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const lines = [["Nome", "Collezione", "Numero", "Tipo", "PS", "Rarità", "Quantità", "Valore unitario", "Valuta", "Data prezzo"].map(q).join(";")];
  for (const r of rows) lines.push([r.name, r.expansion_name, r.collector_number, r.card_type, r.hp, r.rarity, r.owned_qty, r.last_price_cents != null ? (r.last_price_cents / 100).toFixed(2).replace(".", ",") : "", r.last_price_currency, r.last_price_at ? r.last_price_at.slice(0, 10) : ""].map(q).join(";"));
  await saveFile("la-mia-raccolta.csv", "text/csv", "﻿" + lines.join("\n"));
};
$("#bImport").onclick = () => $("#bFile").click();
$("#bFile").onchange = async e => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== "pokecollection") throw new Error("Questo file non è un backup di Pokémon Collection.");
    if (!confirm(`Ripristinare ${d.collection.length} carte e ${d.history.length} controlli di prezzo? I dati attuali con lo stesso codice carta verranno sostituiti.`)) return;
    await DB.putMany("expansions", d.expansions || []); await DB.putMany("cards", d.cards || []); await DB.putMany("collection", d.collection || []);
    const ex = await DB.getAll("history"); const seen = new Set(ex.map(h => h.blueprint_id + "|" + h.checked_at));
    await DB.putMany("history", (d.history || []).filter(h => !seen.has(h.blueprint_id + "|" + h.checked_at)).map(h => { const { id, ...rest } = h; return rest; }));
    await loadCache(); $("#bOut").innerHTML = '<div class="msg ok">Backup ripristinato.</div>';
  } catch (err) { $("#bOut").innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
};

/* ------------------------------------------------------------------ avvio */
(async function init() {
  await DB.open();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { }
  await loadCache();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => { });
  if (!Settings.get().token) showTab("set"); else showTab("scan");
  window.App = { DB, Settings, identify, syncCatalog, setOwned, recordPrice, refreshAll, loadCache, cardFull, ctGet, bestPrice, parseBlueprint, normKey, ocrSource, selectCard };
  window.dispatchEvent(new Event("app-ready"));
})();
