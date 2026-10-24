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
  defaults: { token: "", proxy: "", condition: "Near Mint", language: "", currency: "EUR", ptcgBase: "https://api.pokemontcg.io/v2" },
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


// CardTrader a volte avvolge gli elenchi in un oggetto (es. {"array":[...]}): li rendiamo sempre array.
function asList(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === "object") {
    if (Array.isArray(x.array)) return x.array;
    const v = Object.values(x).find(Array.isArray);
    if (v) return v;
  }
  throw new CTError("Risposta inattesa da CardTrader (formato non riconosciuto).", "format");
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
const Cache = { cards: [], exps: new Map(), byKey: new Map(), byName: new Map(), setNums: new Map(), totals: new Set() };

async function loadCache() {
  const [cards, exps] = await Promise.all([DB.getAll("cards"), DB.getAll("expansions")]);
  Cache.exps = new Map(exps.map(e => [e.id, e]));
  Cache.cards = cards.map(c => ({ id: c.blueprint_id, name: c.name, cn: cleanName(c.name), key: c.collector_key, exp: c.expansion_id }));
  Cache.byKey = new Map(); Cache.byName = new Map(); Cache.setNums = new Map();
  Cache.totals = new Set(exps.map(e => e.printed_total).filter(Boolean));
  for (const c of Cache.cards) {
    if (c.key && /^\d+$/.test(c.key)) { if (!Cache.setNums.has(c.exp)) Cache.setNums.set(c.exp, new Set()); Cache.setNums.get(c.exp).add(parseInt(c.key, 10)); }
    if (c.key) { if (!Cache.byKey.has(c.key)) Cache.byKey.set(c.key, []); Cache.byKey.get(c.key).push(c); }
    if (c.cn) { if (!Cache.byName.has(c.cn)) Cache.byName.set(c.cn, []); Cache.byName.get(c.cn).push(c); }
  }
}

async function syncCatalog(onProgress) {
  const games = asList(await ctGet("/games"));
  const g = games.find(x => /pok/i.test(x.name || "") || /pok/i.test(x.display_name || ""));
  if (!g) throw new CTError("Gioco Pokémon non trovato su CardTrader.", "nogame");
  const exps = asList(await ctGet("/expansions")).filter(e => e.game_id === g.id);
  await DB.putMany("expansions", exps.map(e => ({ id: e.id, game_id: e.game_id, code: e.code, name: e.name })));
  let done = new Set((await DB.meta("sync_done", [])) || []);
  if (await DB.meta("sync_complete", true)) { done = new Set(); await DB.setMeta("sync_complete", false); }   // nuovo giro
  let i = 0;
  for (const e of exps) {
    i++;
    onProgress && onProgress(i, exps.length, e.name);
    if (done.has(e.id)) continue;
    const bps = asList(await ctGet("/blueprints/export", { expansion_id: e.id }));
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
  onProgress && onProgress(exps.length, exps.length, "totali stampati dei set…");
  const printed = await syncPrintedTotals();
  await loadCache();
  return { printed };
}

// Totale stampato e sigla ufficiale di ogni set da pokemontcg.io (gratuito). Serve a distinguere set con lo stesso numero carta.
async function syncPrintedTotals() {
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 25000);
    const r = await fetch(Settings.get().ptcgBase.replace(/\/+$/, "") + "/sets?pageSize=500&select=id,name,printedTotal,total,ptcgoCode", { signal: ctl.signal });
    clearTimeout(to); if (!r.ok) return false;
    const sets = (await r.json()).data || []; if (!sets.length) return false;
    const exps = await DB.getAll("expansions"); let hit = 0;
    for (const e of exps) {
      const cn = cleanName(e.name);
      let best = null, bs = 0;
      for (const st of sets) { const sc = sim(cn, cleanName(st.name)); if (sc > bs) { bs = sc; best = st; } }
      if (best && bs >= 0.85) { e.printed_total = best.printedTotal || null; e.ptcgo_code = best.ptcgoCode || null; hit++; }
    }
    await DB.putMany("expansions", exps);
    await DB.setMeta("printed_totals_matched", hit);
    return hit > 0;
  } catch (e) { return false; }
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
const sim = (a, b) => (!a || !b) ? 0 : 1 - lev(a, b) / Math.max(a.length, b.length);
const LANG_CODES = new Set(["EN", "IT", "DE", "FR", "ES", "PT", "JP", "KO", "ZH", "NL", "PL", "RU"]);

// Numero stampato in basso a sinistra. Formati gestiti: 01/152, TG01/TG30, GG13/GG70, SWSH300, SM150 (e altre promo: SVP, XY, BW…).
// Ritorna {key, num, total, raw} o null. "total" è il totale numerico (es. 152); per TG/GG/promo è null.
function parseNumber(text) {
  const t = String(text || "").toUpperCase();
  const ok = (n, tot) => n >= 1 && n <= 500 && tot >= 5 && tot <= 500;
  let m = t.match(/([A-Z0-9]{2,12})\s*[\/\\|]\s*([A-Z]{1,3})(\d{1,3})(?!\d)/);              // TG01/TG30, GG13/GG70 (anche "LORENTGO5/TG30")
  if (m) {
    const pre = m[2], idx = m[1].lastIndexOf(pre);
    const digits = idx >= 0 ? m[1].slice(idx + pre.length).replace(/[OQ]/g, "0").replace(/[IL]/g, "1") : "";
    if (/^\d{1,3}$/.test(digits)) return { key: normKey(pre + digits), num: pre + digits, total: null, subset: pre + m[3], raw: m[0] };
  }
  m = t.match(/(?<!\d)(\d{1,3})\s*[\/\\|]\s*(\d{2,3})(?!\d)/);                                  // 01/152, anche se attaccato alle lettere ("SVIEN025/198")
  if (m && ok(+m[1], +m[2])) return { key: normKey(m[1]), num: m[1], total: +m[2], raw: m[0] };
  for (const tok of t.split(/\s+/)) {                                                            // O/0, I/1 confusi dall'OCR
    if (!/^[\dOQIL\/\\|]{5,9}$/.test(tok) || !/\d/.test(tok)) continue;
    const f = tok.replace(/[OQ]/g, "0").replace(/[IL]/g, "1").replace(/[\\|]/g, "/");
    const mm = f.match(/^(\d{1,3})\/(\d{2,3})$/);
    if (mm && ok(+mm[1], +mm[2])) return { key: normKey(mm[1]), num: mm[1], total: +mm[2], raw: tok };
  }
  if (Cache.totals && Cache.totals.size) {                                                       // OCR ha scambiato la barra "/" con "1" o "7" (es. 8/102 → "81102") o l'ha persa ("8102")
    const alts = [], seen = new Set();
    for (const run of (t.match(/\d{3,7}/g) || [])) for (let i = 1; i <= 3 && i < run.length; i++) {
      const n = +run.slice(0, i), add = tot => { const k = n + "/" + tot; if (!seen.has(k) && n >= 1 && n <= tot * 2 && Cache.totals.has(tot)) { seen.add(k); alts.push({ n, total: tot }); } };
      if (/[17]/.test(run[i]) && run.length - i - 1 >= 2) add(+run.slice(i + 1));
      if (run.length - i >= 2 && run[i] !== "0") add(+run.slice(i));
    }
    if (alts.length) return { key: normKey(String(alts[0].n)), num: String(alts[0].n), total: alts[0].total, alts, weak: true, raw: alts.map(a => a.n + "/" + a.total).join(" o ") };
  }
  m = t.match(/(SWSH|SVP|SVE|SMP|HGSS|XY|SM|BW|DP)\s*[-]?\s*0*(\d{1,3})(?!\d)/);   // promo: SWSH300, SM150
  if (m) return { key: normKey(m[1] + m[2]), num: m[1] + m[2], total: null, promo: true, raw: m[0] };
  return null;
}
// Totali stampati trovati da soli (es. "102" di 8/102 quando il numero a sinistra non si legge): servono a restringere il set.
function totalHints(text) {
  const cnt = new Map();
  for (const m of String(text || "").matchAll(/(?<!\d)(\d{2,3})(?!\d)/g)) { const v = +m[1]; if (Cache.totals && Cache.totals.has(v)) cnt.set(v, (cnt.get(v) || 0) + 1); }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).slice(0, 2);
}
// Codice del set stampato accanto al simbolo (es. SVI, PAL, MEW): serve come indizio in più.
const normCode = c => String(c || "").toUpperCase().replace(/I/g, "1").replace(/O/g, "0");
function setCodes(text) {
  const toks = [];
  for (let t of (String(text || "").toUpperCase().match(/[A-Z0-9]{2,5}/g) || [])) {
    if (t.length >= 4 && LANG_CODES.has(t.slice(-2))) t = t.slice(0, -2);        // "SVIEN" = codice SVI + lingua EN
    if (t.length >= 2 && !LANG_CODES.has(t) && /[A-Z]/.test(t) && !/^\d+$/.test(t)) toks.push(t);
  }
  return new Set(toks.map(normCode));
}
// Nome letto in alto a sinistra: tolgo l'etichetta di evoluzione (Base / Fase 1 / Fase 2 / Basic / Stage 1…), "Si evolve da…", PS e numeri.
const STAGE_RX = /\b(?:stage|fase|stadio)\s*[12lI|]?(?![a-z])|\b(?:basic|base|baby|restored)\b/gi;
function nameCandidates(texts) {
  const out = new Set();
  for (const txt of texts) for (const raw of String(txt || "").split(/[\r\n]+/)) {
    if (/evol|metti|sulla carta|evolves/i.test(raw)) continue;                                  // riga "Si evolve da X": non è il nome della carta
    let l = raw.replace(/[|_]/g, " ").replace(STAGE_RX, " ");
    l = l.replace(/\b(?:hp|ps|pv)\s*\d+\b/gi, " ").replace(/\b\d+\s*(?:hp|ps|pv)\b/gi, " ").replace(/\b(?:hp|ps|pv)\b/gi, " ").replace(/\b\d+\b/g, " ").replace(/\bpok[eé]mon\b/gi, " ");
    let toks = cleanName(l).split(" ").filter(Boolean);
    while (toks.length > 1 && toks[0].length < 2) toks.shift();          // rumore del riquadro dell'etichetta
    const cn = toks.join(" ");
    if (cn.length >= 3 && cn.length <= 30) out.add(cn);
    const t2 = toks.slice(); while (t2.length > 1 && t2[t2.length - 1].length <= 2 && t2[t2.length - 1] !== "ex") t2.pop();   // rumore dopo il nome ("Machamp uu")
    const c2 = t2.join(" "); if (c2 !== cn && c2.length >= 3 && c2.length <= 30) out.add(c2);
  }
  return [...out];
}
function nameScore(cn, cands) {
  let best = 0;
  for (const c of cands) {
    let s;
    if (c === cn) s = 1;
    else if (cn.length >= 3 && c.includes(cn)) s = 0.9;
    else if (c.length >= 4 && cn.includes(c)) s = 0.8 * Math.sqrt(c.length / cn.length);
    else { s = sim(c, cn); s = s >= 0.6 ? s * 0.95 : 0; }
    if (s > best) best = s;
  }
  return best;
}
// Totale stampato (es. 148): se conosciamo il totale stampato del set (da pokemontcg.io) deve coincidere;
// altrimenti stima: il set deve avere almeno T carte e non essere molto più grande (le "secret rare" sono oltre il totale).
function totalCompat(expId, total) {
  if (!total) return 0;
  const e = Cache.exps.get(expId) || {};
  if (e.printed_total) return e.printed_total === total ? 1 : 0;
  const nums = Cache.setNums.get(expId); if (!nums || !nums.has(total)) return 0;
  const r = Math.max(...nums) / total;
  return r <= 1.5 ? 0.7 : r <= 2 ? 0.4 : 0.2;
}
const codeBlob = txt => normCode(txt).replace(/[^A-Z0-9]/g, "");
const codeMatch = (expId, blob) => { const e = Cache.exps.get(expId) || {}; return [e.code, e.ptcgo_code].some(c => c && c.length >= 3 && blob.includes(normCode(c))) ? 1 : 0; };

/* ------------------------------------------------ confronto con l'immagine della carta */
// Si confronta il disegno centrale (la zona dell'illustrazione) con l'immagine del catalogo CardTrader.
// Descrittore: griglia 16x12 di colori medi, normalizzata per canale (regge a luce, riflessi e colori diversi della foto).
const ART = { x0: 0.13, x1: 0.87, y0: 0.16, y1: 0.46 }, GW = 16, GH = 12;
function artDescriptor(img, iw, ih) {
  const c = document.createElement("canvas"); c.width = GW; c.height = GH;
  const x = c.getContext("2d", { willReadFrequently: true }); x.imageSmoothingQuality = "high";
  x.drawImage(img, ART.x0 * iw, ART.y0 * ih, (ART.x1 - ART.x0) * iw, (ART.y1 - ART.y0) * ih, 0, 0, GW, GH);
  const d = x.getImageData(0, 0, GW, GH).data, n = GW * GH, out = new Float32Array(3 * n);
  for (let ch = 0; ch < 3; ch++) {
    let m = 0; for (let i = 0; i < n; i++) m += d[4 * i + ch]; m /= n;
    let v = 0; for (let i = 0; i < n; i++) { const t = d[4 * i + ch] - m; out[ch * n + i] = t; v += t * t; }
    const sd = Math.sqrt(v / n) || 1; for (let i = 0; i < n; i++) out[ch * n + i] /= sd;
  }
  return out;
}
function descSim(a, b) { const n = GW * GH; let tot = 0; for (let ch = 0; ch < 3; ch++) { let s = 0; for (let i = 0; i < n; i++) s += a[ch * n + i] * b[ch * n + i]; tot += s / n; } return tot / 3; }   // −1…1
const catImgCache = new Map();
function loadImg(url, timeout = 8000) {
  return new Promise(res => {
    const im = new Image(); im.crossOrigin = "anonymous"; const to = setTimeout(() => res(null), timeout);
    im.onload = () => { clearTimeout(to); res(im.naturalWidth ? im : null); }; im.onerror = () => { clearTimeout(to); res(null); }; im.src = url;
  });
}
// Immagine del catalogo → descrittore. Prima diretta; se il sito non permette l'uso nel browser, passo da un servizio gratuito di immagini (wsrv.nl).
async function catalogDescriptor(url) {
  if (!url) return null;
  if (catImgCache.has(url)) return catImgCache.get(url);
  const p = (async () => {
    for (const u of [url, "https://wsrv.nl/?w=240&output=jpg&url=" + encodeURIComponent(url)]) {
      const im = await loadImg(u);
      if (im) { try { return artDescriptor(im, im.naturalWidth, im.naturalHeight); } catch (e) { /* canvas "sporco": provo il servizio */ } }
    }
    return null;
  })();
  catImgCache.set(url, p);
  return p;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

// Riconoscimento dopo la scansione: nome (alto sx) + numero/totale (basso) + codice set + immagine.
async function identify(input, limit = 5, onStep = () => { }) {
  const inp = typeof input === "string" ? { fullText: input } : (input || {});
  const fullText = inp.fullText || "", nameText = inp.nameText || "", numText = inp.numText || "";
  const parsed = inp.parsed || parseNumber(numText) || parseNumber(fullText);
  const strong = nameCandidates([nameText]);
  const cands = strong.length ? strong : nameCandidates([fullText]);
  const nameFactor = strong.length ? 1 : 0.8;
  const codes = codeBlob(inp.codeText || numText || fullText);
  const hints = !parsed ? (inp.totalHints || []) : [];
  const hasTotal = !!(parsed && parsed.total) || hints.length > 0;
  const W = parsed ? (hasTotal ? { name: 0.5, num: 0.2, tot: 0.2, code: 0.1 } : { name: 0.65, num: 0.25, tot: 0, code: 0.1 }) : hints.length ? { name: 0.7, num: 0, tot: 0.2, code: 0.1 } : { name: 0.65, num: 0.25, tot: 0, code: 0.1 };

  const scoredMap = new Map(), put = (sc, c) => { const o = scoredMap.get(c.id); if (!o || sc > o[0]) scoredMap.set(c.id, [sc, c]); };
  let imgBudget = 0;
  let pool = parsed && Cache.byKey.get(parsed.key), weak = false;
  if (parsed && parsed.alts) {                                     // numero letto in modo incerto (barra scambiata per cifra): provo le interpretazioni compatibili coi totali dei set
    for (const a of parsed.alts) for (const c of (Cache.byKey.get(String(a.n)) || [])) {
      const tc = totalCompat(c.exp, a.total); if (!tc) continue;
      const ns = (cands.length ? nameScore(c.cn, cands) : 0) * nameFactor;
      put(W.name * ns + 0.6 * W.num + W.tot * tc + W.code * codeMatch(c.exp, codes), c);
    }
  } else if (parsed) {
    if (!pool || !pool.length) {                                   // promo / TG / GG: se CardTrader numera solo con le cifre provo con quelle
      const dm = /^[A-Z]+0*(\d+)$/.exec(parsed.key); if (dm) { pool = Cache.byKey.get(dm[1]); weak = !!pool; }
    }
    if (pool && pool.length) for (const c of pool) {
      const ns = (cands.length ? nameScore(c.cn, cands) : 0) * nameFactor;
      if (weak && ns < 0.6) continue;                              // numero incerto: il nome deve combaciare
      put(W.name * ns + (weak ? 0.6 : 1) * W.num + W.tot * totalCompat(c.exp, parsed.total) + W.code * codeMatch(c.exp, codes), c);
    }
  } else if (hints.length) {                                       // si legge solo il totale stampato (es. "102"): cerco nei set con quel totale, decidono nome e immagine
    for (const c of Cache.cards) {
      const pt = (Cache.exps.get(c.exp) || {}).printed_total; if (!hints.includes(pt)) continue;
      const ns = (cands.length ? nameScore(c.cn, cands) : 0) * nameFactor;
      if (cands.length && ns < 0.5) continue;
      put(Math.min(0.7, W.name * ns + W.tot + W.code * codeMatch(c.exp, codes)), c);     // senza numero non si barra da solo (a meno che l'immagine confermi)
    }
    imgBudget = cands.length ? 12 : 120;
  }
  if (cands.length) {                                              // percorso per nome: se il numero è sbagliato o incerto, nome (+ totale stampato) trovano comunque la carta
    for (const [cn, cs] of Cache.byName) {
      const ns = nameScore(cn, cands) * nameFactor;
      if (ns < 0.7) continue;
      for (const c of cs) {
        const pt = (Cache.exps.get(c.exp) || {}).printed_total;
        const tc = parsed && parsed.total ? totalCompat(c.exp, parsed.total) : (hints.length && hints.includes(pt) ? 1 : 0);
        put(Math.min(0.72, 0.6 * ns + 0.2 * tc + 0.05 * codeMatch(c.exp, codes)), c);     // senza numero esatto non si barra da solo (a meno che l'immagine confermi)
      }
    }
  }
  const scored = [...scoredMap.values()];
  const out = [];
  scored.sort((a, b) => b[0] - a[0]);
  // Confronto con l'immagine: rivaluto i migliori candidati (più numerosi se il numero non è stato letto, perché lì conta di più il disegno).
  const nImg = imgBudget || (parsed ? 8 : 16), top = scored.slice(0, Math.max(limit, nImg)), fulls = [];
  for (const [score, c] of top) { const full = await cardFull(c.id); full.base = score; fulls.push(full); }
  if (inp.card && fulls.length) {
    onStep("Confronto con le immagini delle carte…");
    let mine = null; try { mine = artDescriptor(inp.card, inp.card.width, inp.card.height); } catch (e) { mine = null; }
    if (mine) await mapLimit(fulls, 6, async f => { const dsc = await catalogDescriptor(f.image_url); f.imgSim = dsc ? descSim(mine, dsc) : null; });
    const have = fulls.filter(f => f.imgSim != null).length;
    out.imgChecked = have;
    for (const f of fulls) {
      if (f.imgSim == null) { f.score = f.base; continue; }
      const bonus = Math.max(0, Math.min(1, (f.imgSim - 0.25) / 0.5)), w = parsed ? 0.25 : 0.4;       // sim 0,25→0 ; 0,75→1
      f.score = f.base + w * bonus - (f.imgSim < 0.1 && have >= 2 ? 0.1 : 0);
    }
  } else for (const f of fulls) f.score = f.base;
  fulls.sort((a, b) => b.score - a.score);
  for (const full of fulls.slice(0, limit)) { full.confidence = Math.round(Math.max(0, Math.min(full.score, 1)) * 1000) / 1000; out.push(full); }
  out.parsed = parsed; out.nameRead = strong[0] || "";
  if (out.length && strong.length) { const tn = cleanName(out[0].name); out.nameRead = strong.slice().sort((a, b) => sim(b, tn) - sim(a, tn))[0]; } out.totalHint = hints[0] || null;
  return out;
}

// Ricerca manuale: contano soprattutto il nome e il numero in basso a sinistra (es. 050/148).
async function searchCards(nameQ, numQ, limit = 30) {
  let nq = String(nameQ || ""), nuq = String(numQ || "");
  let p = parseNumber(nuq);
  if (!p && /\d/.test(nuq)) { const d = nuq.match(/\d{1,3}/); if (d) p = { key: normKey(d[0]), total: null }; }
  if (!p) {                                         // numero scritto nel campo nome ("Pikachu 025/198")
    const mm = nq.match(/\d{1,3}\s*\/\s*\d{2,3}/) || nq.match(/\b\d{1,3}\b/);
    if (mm) { p = parseNumber(mm[0]) || { key: normKey(mm[0]), total: null }; nq = nq.replace(mm[0], " "); }
  }
  const tokens = cleanName(nq).split(" ").filter(Boolean), full = tokens.join(" ");
  if (!tokens.length && !p) return [];
  const nameMatch = cn => !tokens.length ? 1 : cn === full ? 1 : cn.startsWith(full) ? 0.9 : tokens.every(t => cn.includes(t)) ? 0.75 : 0;
  const compat = c => p && p.total ? totalCompat(c.exp, p.total) : 0;
  let hits = [];
  if (p) {
    let base = Cache.byKey.get(p.key) || [];
    if (!base.length) { const dm = /^[A-Z]+0*(\d+)$/.exec(p.key); if (dm) base = Cache.byKey.get(dm[1]) || []; }
    hits = base.map(c => [nameMatch(c.cn), c]).filter(([ns]) => ns > 0);
    if (!hits.length && tokens.length) hits = base.map(c => [sim(c.cn, full) >= 0.65 ? sim(c.cn, full) * 0.7 : 0, c]).filter(([ns]) => ns > 0);
    hits = hits.map(([ns, c]) => [ns + 1 + 0.5 * compat(c), c]);
  }
  if (!hits.length && tokens.length) {                // nessuna carta con quel numero: mostro per solo nome
    for (const [cn, cs] of Cache.byName) { const ns = nameMatch(cn); if (ns > 0) for (const c of cs) hits.push([ns, c]); }
    if (!hits.length) for (const [cn, cs] of Cache.byName) { const s = sim(cn, full); if (s >= 0.65) for (const c of cs) hits.push([s * 0.7, c]); }
  }
  hits.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
  const out = []; for (const [, c] of hits.slice(0, limit)) out.push(await cardFull(c.id));
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
    const r = await fetch(Settings.get().ptcgBase.replace(/\/+$/, "") + "/cards?q=" + encodeURIComponent(`name:"${name}" number:${c.collector_key}`));
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

/* ---------------------------------------- aggiornamento manuale del valore */
const fmtMoney = (c, cur) => eur(Math.abs(c), cur);
const signOf = d => d > 0 ? "+" : d < 0 ? "−" : "";
// Differenza tra due prezzi: verde se sale, rosso se scende. d = {prev, now, cur}
function deltaHtml(d, opt = {}) {
  if (!d || d.prev == null || d.now == null) return "";
  const diff = d.now - d.prev, cls = diff > 0 ? "up" : diff < 0 ? "down" : "flat", arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "•";
  const pct = d.prev ? Math.abs(diff / d.prev * 100) : null;
  return `<span class="delta ${cls}${opt.big ? " big" : ""}" title="${diff === 0 ? "invariato" : (diff > 0 ? "salito" : "sceso")}"><i>${arrow}</i>${diff === 0 ? "invariato" : signOf(diff) + fmtMoney(diff, d.cur)}${opt.pct !== false && pct != null && diff !== 0 ? ` <small>${signOf(diff)}${pct.toFixed(1)}%</small>` : ""}</span>`;
}

let refreshing = false, cancelRefresh = false;
async function refreshAll() {
  if (refreshing) return;
  const col = await DB.getAll("collection");
  if (!col.length) { $("#refreshBox").hidden = false; $("#refreshBox").innerHTML = '<div class="msg warn">La raccolta è vuota: scansiona prima qualche carta.</div>'; return; }
  refreshing = true; cancelRefresh = false;
  const box = $("#refreshBox"); box.hidden = false;
  $("#btnRefresh").disabled = true; $("#btnRefresh").classList.add("busy");
  const before = {}, qty = {}, cur = {}; let prevTotal = 0;
  for (const c of col) { const card = await DB.get("cards", c.blueprint_id); before[c.blueprint_id] = card ? card.last_price_cents : null; qty[c.blueprint_id] = c.quantity; cur[c.blueprint_id] = card ? card.last_price_currency : null; prevTotal += ((card && card.last_price_cents) || 0) * c.quantity; }
  const after = { ...before }; let errors = 0, lastErr = "", updated = 0, noOffer = 0;
  for (let i = 0; i < col.length; i++) {
    if (cancelRefresh) break;
    box.innerHTML = `<div class="rprog"><b>Aggiorno i prezzi… ${i + 1}/${col.length}</b><progress max="${col.length}" value="${i}"></progress><button class="btn sec" id="cancelRef">Interrompi</button></div>`;
    $("#cancelRef").onclick = () => { cancelRefresh = true; };
    const id = col[i].blueprint_id;
    try { const p = await recordPrice(id, true); if (p.cents != null) { after[id] = p.cents; cur[id] = p.currency; updated++; } else noOffer++; }
    catch (e) { errors++; lastErr = e.message; if (e.code === "auth" || e.code === "network" || e.code === "token") break; }
    if (i < col.length - 1) await sleep(MARKET_DELAY);
  }
  refreshing = false; $("#btnRefresh").disabled = false; $("#btnRefresh").classList.remove("busy");
  const cards = {}; let newTotal = 0;
  for (const c of col) { const id = c.blueprint_id; newTotal += (after[id] || 0) * c.quantity; if (updated && before[id] != null && after[id] != null) cards[id] = [before[id], after[id]]; }
  if (updated) {
    const at = new Date().toISOString();
    await DB.setMeta("last_refresh", { at, prevTotal, newTotal, cards });
    const series = (await DB.meta("totals", [])) || [];
    if (!series.length) {                                           // punto di partenza: quando hai aggiunto la prima carta (mai alla stessa ora del secondo)
      const firstAdded = col.reduce((m, c) => (!m || c.added_at < m ? c.added_at : m), null);
      let t0 = (await DB.meta("prices_updated_at")) || firstAdded || at;
      if (!(t0 < at)) t0 = new Date(+new Date(at) - 60000).toISOString();
      series.push({ at: t0, cents: prevTotal });
    }
    series.push({ at, cents: newTotal }); await DB.setMeta("totals", series.slice(-200));
    if (!errors && !cancelRefresh) await DB.setMeta("prices_updated_at", at);
  }
  await renderCollection();
  box.innerHTML = refreshSummary({ prevTotal, newTotal, cards }, { errors, lastErr, cancelled: cancelRefresh, noOffer, updated });
  const x = $("#closeSum"); if (x) x.onclick = () => { box.hidden = true; box.innerHTML = ""; };
  $$("#refreshBox [data-open]").forEach(el => el.onclick = () => openCard(+el.dataset.open));
}

function refreshSummary(r, st) {
  const ids = Object.keys(r.cards);
  const list = ids.map(id => ({ id: +id, prev: r.cards[id][0], now: r.cards[id][1], diff: r.cards[id][1] - r.cards[id][0] }));
  const up = list.filter(x => x.diff > 0), down = list.filter(x => x.diff < 0), flat = list.length - up.length - down.length;
  const diffTot = r.newTotal - r.prevTotal, cls = diffTot > 0 ? "up" : diffTot < 0 ? "down" : "flat";
  const cur = Settings.get().currency;
  const nameOf = id => { const f = rows.find(x => x.blueprint_id === id); return f ? f : { name: "Carta " + id, expansion_name: "" }; };
  const row = x => { const f = nameOf(x.id); return `<button class="mover" data-open="${x.id}"><span><b>${esc(f.name)}</b><small>${esc(f.expansion_name)} · #${esc(f.collector_number)}</small></span>${deltaHtml({ prev: x.prev, now: x.now, cur })}</button>`; };
  const top = (arr, dir) => arr.sort((a, b) => dir * (b.diff - a.diff)).slice(0, 5).map(row).join("") || '<div class="note">Nessuna</div>';
  const warn = st.errors ? `<div class="msg err">Aggiornamento non completato: ${esc(st.lastErr)}${st.updated ? ` Le prime ${st.updated} carte sono state aggiornate.` : ""}</div>` : st.cancelled ? '<div class="msg warn">Aggiornamento interrotto: sono state aggiornate solo alcune carte.</div>' : "";
  if (!ids.length) return warn + `<div class="rsum"><div class="rt"><b>${st.errors || st.cancelled ? "Nessun prezzo aggiornato" : "Prezzi aggiornati"}</b><button class="btn sec" id="closeSum">Chiudi</button></div>${st.noOffer ? `<div class="note">${st.noOffer} carte senza offerte in vendita: tengo l'ultimo prezzo noto.</div>` : ""}</div>`;
  return warn + `<div class="rsum">
    <div class="rt"><b>Valori aggiornati</b><button class="btn sec" id="closeSum">Chiudi</button></div>
    <div class="rtot ${cls}"><span class="rl">Valore della raccolta</span><span class="rv">${eur(r.newTotal, cur)}</span>${deltaHtml({ prev: r.prevTotal, now: r.newTotal, cur }, { big: true })}</div>
    <div class="rcounts"><span class="up">▲ ${up.length} salite</span><span class="down">▼ ${down.length} scese</span><span class="flat">• ${flat} invariate</span>${st.noOffer ? `<span class="note">${st.noOffer} senza offerte</span>` : ""}</div>
    <div class="movers"><div><h4>Salite maggiori</h4>${top(up, 1)}</div><div><h4>Cali maggiori</h4>${top(down, -1)}</div></div></div>`;
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
    $("#camMsg").innerHTML = ""; $("#cam").classList.remove("off");
    const fit = () => layoutGuide();
    v.onloadedmetadata = fit; fit(); window.addEventListener("resize", fit);
  } catch (e) {
    stream = null;
    $("#camMsg").innerHTML = '<div class="msg warn">Non riesco ad aprire la fotocamera (hai dato il permesso a Safari?). Puoi comunque usare «Usa una foto».</div>';
  }
}
function stopCamera() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; $("#video").srcObject = null; } $("#cam").classList.add("off"); }
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

/* ---------------------------------------------------- trovare la carta nella foto */
// La foto può avere la carta storta, girata di lato, in una taschina del raccoglitore con altre carte attorno.
// Cerco il bordo giallo/arancio della carta, ne ricavo il rettangolo inclinato e lo raddrizzo (anche se la foto è in orizzontale).
function findCardRect(src, W, H) {
  const sc = 380 / Math.max(W, H), w = Math.max(8, Math.round(W * sc)), h = Math.max(8, Math.round(H * sc));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d", { willReadFrequently: true }); cx.drawImage(src, 0, 0, W, H, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data, m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 100 || (mx - mn) < 0.3 * mx) continue;
    let hue = mx === r ? 60 * ((g - b) / (mx - mn)) : mx === g ? 60 * (2 + (b - r) / (mx - mn)) : 60 * (4 + (r - g) / (mx - mn));
    if (hue < 0) hue += 360;
    if (hue >= 28 && hue <= 66) m[i] = 1;
  }
  const lab = new Int32Array(w * h), comps = [], stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || lab[i]) continue;
    const id = comps.length + 1, pts = []; lab[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop(); pts.push(p); const x = p % w, y = (p / w) | 0;
      if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = id; stack.push(p + w); }
    }
    comps.push(pts);
  }
  let best = null;
  for (const pts of comps) {
    if (pts.length < w * h * 0.012) continue;
    const xs = pts.map(p => p % w), ys = pts.map(p => (p / w) | 0);
    let bb = null;
    for (let a = 0; a < 90; a += 1.5) {
      const co = Math.cos(a * Math.PI / 180), si = Math.sin(a * Math.PI / 180);
      const s = new Float32Array(pts.length), t = new Float32Array(pts.length);
      for (let k = 0; k < pts.length; k++) { s[k] = xs[k] * co + ys[k] * si; t[k] = -xs[k] * si + ys[k] * co; }
      const ss = Float32Array.from(s).sort(), ts = Float32Array.from(t).sort(), q = Math.floor(pts.length * 0.005);
      const s0 = ss[q], s1 = ss[pts.length - 1 - q], t0 = ts[q], t1 = ts[pts.length - 1 - q], area = (s1 - s0) * (t1 - t0);
      if (!bb || area < bb.area) bb = { area, a, co, si, s0, s1, t0, t1 };
    }
    const dw = bb.s1 - bb.s0, dh = bb.t1 - bb.t0, ratio = Math.min(dw, dh) / Math.max(dw, dh);
    const fill = pts.length / bb.area;
    if (ratio < 0.6 || ratio > 0.85 || bb.area < w * h * 0.06) continue;
    const mcx = (bb.s0 + bb.s1) / 2, mcy = (bb.t0 + bb.t1) / 2;
    const px = mcx * bb.co - mcy * bb.si, py = mcx * bb.si + mcy * bb.co;
    const dist = Math.hypot(px - w / 2, py - h / 2) / Math.max(w, h);
    const score = bb.area * (1 - dist) * (0.5 + Math.min(fill, 0.5));
    if (!best || score > best.score) best = { score, bb, dw, dh, px, py, ratio, fill };
  }
  if (!best) return null;
  const bb = best.bb, k = 1 / sc;
  const ax = { x: bb.co, y: bb.si }, ay = { x: -bb.si, y: bb.co };
  const longIsT = best.dh >= best.dw;
  const u = longIsT ? ax : ay, v = longIsT ? ay : ax;
  if (u.x * v.y - u.y * v.x < 0) { u.x = -u.x; u.y = -u.y; }                 // niente immagine specchiata: u (destra) e v (giù) devono essere destrorsi
  return { cx: best.px * k, cy: best.py * k, u, v, short: Math.min(best.dw, best.dh) * k, long: Math.max(best.dw, best.dh) * k, fill: best.fill, ratio: best.ratio };
}
function warpCard(src, r, flip, OW, OH) {
  const c = document.createElement("canvas"); c.width = OW; c.height = OH;
  const ctx = c.getContext("2d"); ctx.imageSmoothingQuality = "high";
  const sg = flip ? -1 : 1, ux = sg * r.u.x, uy = sg * r.u.y, vx = sg * r.v.x, vy = sg * r.v.y;
  const kx = OW / r.short, ky = OH / r.long;
  ctx.setTransform(ux * kx, vx * ky, uy * kx, vy * ky, OW / 2 - kx * (ux * r.cx + uy * r.cy), OH / 2 - ky * (vx * r.cx + vy * r.cy));
  ctx.drawImage(src, 0, 0);
  return c;
}

/* ------------------------------------------------------------- OCR per zone */
// Si leggono SOLO gli angoli della carta (mai la carta intera). Frazioni di larghezza/altezza della carta:
//  - nome: in alto a sinistra, dopo l'etichetta Base / Fase 1 / Fase 2
//  - simbolo del set + numero: in basso a sinistra (es. 01/152, TG01/TG30, SWSH300, SM150, GG13/GG70)
const REG = {
  name: { x0: 0.03, x1: 0.74, y0: 0.015, y1: 0.17 },
  numLeft: { x0: 0.02, x1: 0.52, y0: 0.905, y1: 0.995 },
  numRight: { x0: 0.62, x1: 1.0, y0: 0.885, y1: 0.965 },      // carte vecchie (Base Set, Jungle…): il numero sta in basso a DESTRA
  numStrip: { x0: 0.0, x1: 1.0, y0: 0.9, y1: 1.0 },       // tutta la fascia in basso
};
const NUM_WL = "0123456789/ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Ritaglia una zona, la ingrandisce e la prepara: 'gray' = contrasto, 'bin' = bianco/nero con testo scuro, 'binInv' = polarità opposta.
function prep(src, g, reg, targetW, variant) {
  const sx = g.x + reg.x0 * g.w, sy = g.y + reg.y0 * g.h, sw = (reg.x1 - reg.x0) * g.w, sh = (reg.y1 - reg.y0) * g.h;
  const scale = Math.max(1, Math.min(4, targetW / sw)), pad = 16;
  const cw = Math.round(sw * scale), ch = Math.round(sh * scale);
  const c = document.createElement("canvas"); c.width = cw + 2 * pad; c.height = ch + 2 * pad;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high"; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, sx, sy, sw, sh, pad, pad, cw, ch);
  const im = ctx.getImageData(0, 0, c.width, c.height), d = im.data, n = c.width * c.height;
  const gray = new Uint8ClampedArray(n), hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) { const v = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2]; gray[i] = v; hist[v | 0]++; }
  if (variant === "gray") {
    let acc = 0, lo = 0, hi = 255; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > n * 0.02) { lo = i; break; } }
    acc = 0; for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc > n * 0.02) { hi = i; break; } }
    const k = 255 / Math.max(1, hi - lo);
    for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, (gray[i] - lo) * k)); d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v; }
  } else {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let wB = 0, sB = 0, best = 0, thr = 128;                       // soglia di Otsu
    for (let i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; const wF = n - wB; if (!wF) break; sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = i; } }
    let dark = 0; for (let i = 0; i < n; i++) if (gray[i] <= thr) dark++;
    let invert = dark > n * 0.5;                                    // il testo deve essere la parte minoritaria
    if (variant === "binInv") invert = !invert;
    let loc = null;
    if (variant === "ada") {                                        // soglia locale: regge a ombre, riflessi e sfondi sfumati (foto reali)
      const Wd = c.width, Hd = c.height, I = new Float64Array((Wd + 1) * (Hd + 1));
      for (let y = 0; y < Hd; y++) { let row = 0; for (let x = 0; x < Wd; x++) { row += gray[y * Wd + x]; I[(y + 1) * (Wd + 1) + x + 1] = I[y * (Wd + 1) + x + 1] + row; } }
      const half = 40; loc = new Float32Array(n);
      for (let y = 0; y < Hd; y++) { const y0 = Math.max(0, y - half), y1 = Math.min(Hd, y + half + 1); for (let x = 0; x < Wd; x++) { const x0 = Math.max(0, x - half), x1 = Math.min(Wd, x + half + 1); loc[y * Wd + x] = (I[y1 * (Wd + 1) + x1] - I[y0 * (Wd + 1) + x1] - I[y1 * (Wd + 1) + x0] + I[y0 * (Wd + 1) + x0]) / ((x1 - x0) * (y1 - y0)); } }
    }
    for (let i = 0; i < n; i++) { let v; if (loc) v = gray[i] < loc[i] - 10 ? 0 : 255; else { v = gray[i] > thr ? 255 : 0; if (invert) v = 255 - v; } d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v; }
    const bgv = variant === "binInv" ? 0 : 255;                     // cancello linee lunghe (bordo della carta) che toccano il testo
    for (let y = pad; y < c.height - pad; y++) { let k = 0; for (let x = pad; x < c.width - pad; x++) if (d[4 * (y * c.width + x)] !== bgv) k++; if (k > (c.width - 2 * pad) * 0.6) for (let x = 0; x < c.width; x++) { const i = 4 * (y * c.width + x); d[i] = d[i + 1] = d[i + 2] = bgv; } }
    for (let x = pad; x < c.width - pad; x++) { let k = 0; for (let y = pad; y < c.height - pad; y++) if (d[4 * (y * c.width + x)] !== bgv) k++; if (k > (c.height - 2 * pad) * 0.6) for (let y = 0; y < c.height; y++) { const i = 4 * (y * c.width + x); d[i] = d[i + 1] = d[i + 2] = bgv; } }
    const bg = variant === "binInv" ? 0 : 255;                      // bordo uniforme col colore dello sfondo
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (x < pad || y < pad || x >= c.width - pad || y >= c.height - pad) { const i = 4 * (y * c.width + x); d[i] = d[i + 1] = d[i + 2] = bg; }
  }
  ctx.putImageData(im, 0, 0);
  return c;
}
async function getWorker() {
  if (!worker) worker = await Tesseract.createWorker("eng", 1, { workerPath: "worker.min.js", corePath: "./", langPath: "./", gzip: true, cacheMethod: "none" });
  return worker;
}
async function ocrWith(canvas, psm, whitelist) {
  const w = await getWorker();
  await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist || "" });
  const { data } = await w.recognize(canvas);
  return data.text || "";
}

// OCR con dati di riga: mi serve l'altezza delle righe per capire quale è il nome (carattere più grande).
async function ocrLines(canvas, psm, whitelist) {
  const w = await getWorker();
  await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist || "" });
  const { data } = await w.recognize(canvas, {}, { text: true, blocks: true });
  let lines = data.lines;
  if (!lines && data.blocks) lines = data.blocks.flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []));
  lines = (lines || []).map(l => ({ text: l.text || "", h: l.bbox ? l.bbox.y1 - l.bbox.y0 : 0 })).filter(l => l.text.trim());
  return { text: data.text || "", lines };
}
// righe più alte = nome della carta (le righe piccole sono "Evolve da…", "Metti … sulla carta di Fase 1")
function bigLines(r) {
  if (!r.lines.length) return r.text;
  const hs = r.lines.map(l => l.h).sort((a, b) => b - a), ref = hs[Math.min(1, hs.length - 1)] || hs[0];
  return r.lines.filter(l => l.h >= ref * 0.72).map(l => l.text).join("\n");
}

// Riga del nome: nella zona in alto cerco la fascia di testo più alta (il nome è scritto più grande di "Evolve da…", "Fase 2", ecc.) e leggo solo quella.
function textBand(c) {
  const W = c.width, H = c.height, ctx = c.getContext("2d", { willReadFrequently: true }), im = ctx.getImageData(0, 0, W, H), d = im.data, pad = 16;
  const lab = new Int32Array(W * H), keep = new Uint8Array(W * H), st = [];
  for (let y0 = pad; y0 < H - pad; y0++) for (let x0 = pad; x0 < W - pad; x0++) {            // componenti connesse nere: tengo solo quelle grandi come lettere (scarto disegno, cornici, bordi)
    const i0 = y0 * W + x0; if (lab[i0] || d[4 * i0] >= 128) continue;
    const pts = []; let minx = x0, maxx = x0, miny = y0, maxy = y0; lab[i0] = 1; st.push(i0);
    while (st.length) {
      const p = st.pop(); pts.push(p); const x = p % W, y = (p / W) | 0;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) { if (q < 0 || q >= W * H || lab[q]) continue; const qx = q % W; if (Math.abs(qx - x) > 1 || qx < pad || qx >= W - pad) continue; const qy = (q / W) | 0; if (qy < pad || qy >= H - pad) continue; if (d[4 * q] < 128) { lab[q] = 1; st.push(q); } }
    }
    const w = maxx - minx + 1, h = maxy - miny + 1;
    if (w <= W * 0.16 && h <= H * 0.36 && h >= 8 && pts.length >= 25) for (const p of pts) keep[p] = 1;
  }
  const dens = new Float32Array(H);
  for (let y = pad; y < H - pad; y++) { let k = 0; for (let x = pad; x < W - pad; x++) if (keep[y * W + x]) k++; dens[y] = k; }
  for (let i = 0; i < W * H; i++) if (!keep[i]) d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = 255;
  const clean = document.createElement("canvas"); clean.width = W; clean.height = H; clean.getContext("2d").putImageData(im, 0, 0);
  const sm = dens.map((_, y) => { let s = 0, n = 0; for (let j = -3; j <= 3; j++) if (y + j >= 0 && y + j < H) { s += dens[y + j]; n++; } return s / n; });
  const mx = Math.max(...sm); if (mx < 8) return null;
  const bands = []; let s0 = -1;
  for (let y = pad; y <= H - pad; y++) { const on = y < H - pad && sm[y] > mx * 0.28; if (on && s0 < 0) s0 = y; if (!on && s0 >= 0) { bands.push([s0, y - 1]); s0 = -1; } }
  if (!bands.length) return null;
  bands.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  return { band: bands[0], clean };
}
function cropRows(c, y0, y1, targetH) {
  const h = y1 - y0 + 1, sc = Math.max(0.35, Math.min(2.2, targetH / h)), pad = 24;
  const o = document.createElement("canvas"); o.width = Math.round(c.width * sc) + 2 * pad; o.height = Math.round(h * sc) + 2 * pad;
  const x = o.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, o.width, o.height); x.imageSmoothingQuality = "high";
  x.drawImage(c, 0, y0, c.width, h, pad, pad, Math.round(c.width * sc), Math.round(h * sc));
  return o;
}
// Legge il nome sulla carta raddrizzata. Ritorna i testi letti (da provare come candidati) e il ritaglio usato.
async function readName(card, g, full) {
  const A = prep(card, g, REG.name, 1400, "ada"), G = prep(card, g, REG.name, 1400, "gray");
  const texts = [], tb = textBand(A); let crop = A;
  if (tb) {
    const band = tb.band, m = Math.round((band[1] - band[0]) * 0.3), y0 = Math.max(0, band[0] - m), y1 = Math.min(A.height - 1, band[1] + m);
    for (const [src, tH] of [[tb.clean, 70], [G, 70], [tb.clean, 110]]) {
      const c = cropRows(src, y0, y1, tH); if (src === tb.clean && tH === 70) crop = c;
      texts.push(await ocrWith(c, "7")); if (!full && nameCandidates(texts).length >= 1) break;
    }
  }
  if (full || !texts.length) { const r = await ocrLines(A, "6"); texts.push(bigLines(r), r.text); }
  return { texts, crop, A };
}

// Quanto "torna" una carta raddrizzata: nome letto che esiste nel catalogo + numero stampato leggibile.
// Serve a scegliere tra carta dritta e capovolta.
async function quickScore(c) {
  const g = { x: 0, y: 0, w: c.width, h: c.height };
  const nr = await readName(c, g, false);
  const cands = nameCandidates(nr.texts);
  let nb = 0;
  if (cands.length) for (const cn of Cache.byName.keys()) { const sc = nameScore(cn, cands); if (sc > nb) nb = sc; }
  const t1 = await ocrWith(prep(c, g, { x0: 0.80, x1: 1, y0: 0.885, y1: 0.955 }, Math.round(0.2 * g.w * 3), "ada"), "7", NUM_WL), t2 = await ocrWith(prep(c, g, REG.numLeft, 1000, "ada"), "7", NUM_WL);
  const p = parseNumber(t1) || parseNumber(t2), th = totalHints(t1 + " " + t2);
  return nb + (p ? (p.weak ? 0.45 : p.total ? 0.6 : 0.3) : th.length ? 0.2 : 0);
}
function rotCanvas(src, W, H, deg) {
  const s = Math.min(1, 1600 / Math.max(W, H)), w = Math.round(W * s), h = Math.round(H * s), sw = deg % 180 ? h : w, sh = deg % 180 ? w : h;
  const c = document.createElement("canvas"); c.width = sw; c.height = sh;
  const x = c.getContext("2d"); x.translate(sw / 2, sh / 2); x.rotate(deg * Math.PI / 180); x.drawImage(src, 0, 0, W, H, -w / 2, -h / 2, w, h);
  return c;
}
// Trova la carta nella foto e ne ricava la versione dritta (prova le orientazioni possibili e tiene la migliore).
async function straightenCard(src, W, H, cropToGuide, onStep) {
  const r = findCardRect(src, W, H);
  let list;
  if (r) {
    const OH = Math.max(820, Math.min(1500, Math.round(r.long))), OW = Math.round(OH * CARD_RATIO);
    list = [warpCard(src, r, false, OW, OH), warpCard(src, r, true, OW, OH)];
  } else {                                                              // carta non trovata: uso il riquadro di guida (o la foto intera) e provo le rotazioni
    let base = src, bw = W, bh = H;
    if (cropToGuide) { const g = guideRect(W, H); base = document.createElement("canvas"); base.width = Math.round(g.w); base.height = Math.round(g.h); base.getContext("2d").drawImage(src, g.x, g.y, g.w, g.h, 0, 0, base.width, base.height); bw = base.width; bh = base.height; }
    list = (bw > bh ? [90, 270, 0, 180] : [0, 180, 90, 270]).map(d => rotCanvas(base, bw, bh, d));
  }
  onStep(r ? "Carta trovata: controllo da che parte è girata…" : "Carta non individuata: provo il riquadro…");
  let best = null;
  for (const c of list) {
    const sc = await quickScore(c);
    if (!best || sc > best.sc) best = { c, sc };
    if (sc >= 1.45) break;                                              // nome e numero tornano: inutile provare altro
  }
  return { canvas: best.c, found: !!r, score: best.sc };
}

// Legge nome (alto sx) e numero/codice del set (basso) sulla carta già raddrizzata.
async function scanImage(src, W, H, cropToGuide, onStep = () => { }) {
  onStep("Cerco la carta nella foto…");
  const st = await straightenCard(src, W, H, cropToGuide, onStep);
  const card = st.canvas, g = { x: 0, y: 0, w: card.width, h: card.height };
  const dbg = { card, found: st.found, score: st.score };
  onStep("Leggo il nome…");
  const nr = await readName(card, g, true), nameTexts = nr.texts.slice();
  dbg.nameCanvas = nr.crop;
  if (!nameCandidates(nameTexts).length) nameTexts.push(await ocrWith(prep(card, g, REG.name, 2000, "binInv"), "7"));   // ultimo tentativo: polarità opposta
  onStep("Leggo simbolo e numero…");
  const numTexts = [], votes = new Map();
  // finestre: carte vecchie (numero in basso a destra, testo piccolo → ingrandisco 3×) e carte moderne (basso a sinistra)
  const numRuns = [[{ x0: 0.80, x1: 1, y0: 0.885, y1: 0.955 }, 3, "7"], [{ x0: 0.80, x1: 1, y0: 0.90, y1: 0.97 }, 3, "7"], [{ x0: 0.70, x1: 1, y0: 0.885, y1: 0.965 }, 2.6, "7"],
    [REG.numLeft, 1.9, "7"], [{ x0: 0.02, x1: 0.40, y0: 0.915, y1: 0.985 }, 3, "7"], [REG.numLeft, 3, "6"], [REG.numRight, 2.4, "6"], [REG.numStrip, 1.7, "11"]];
  for (const [reg, k, psm] of numRuns) {
    const tw = Math.round((reg.x1 - reg.x0) * g.w * k);
    for (const v of ["ada", "bin", "gray", "binInv"]) {
      const c = prep(card, g, reg, tw, v);
      const t = await ocrWith(c, psm, NUM_WL); numTexts.push(t);
      const p = parseNumber(t);
      if (p) { const kk = p.key + "/" + (p.total || p.subset || ""); const e = votes.get(kk) || { p, n: 0 }; e.n++; votes.set(kk, e); if (!dbg.numCanvas) dbg.numCanvas = c; }
    }
    if ([...votes.values()].some(e => e.n >= 2 && !e.p.weak) || (votes.size && [...votes.values()].some(e => !e.p.weak))) break;
  }
  const parsed = votes.size ? [...votes.values()].sort((a, b) => b.n - a.n)[0].p : null;     // vince la lettura più ripetuta
  if (!dbg.numCanvas) dbg.numCanvas = prep(card, g, { x0: 0.0, x1: 1, y0: 0.885, y1: 0.99 }, Math.round(g.w * 1.6), "gray");
  return { nameText: nameTexts.join("\n"), numText: numTexts.join("\n"), codeText: numTexts.join("\n"), fullText: "", parsed, totalHints: parsed ? [] : totalHints(numTexts.join("\n")), card, dbg };
}

let lastScan = null;
async function scanAndShow(src, w, h, cropToGuide) {
  $("#result").innerHTML = '<div class="panel spin" id="scanStep"><div class="loader"></div><span>Leggo gli angoli della carta…</span></div>';
  try {
    const sc = await scanImage(src, w, h, cropToGuide, s => { const el = $("#scanStep span"); if (el) el.textContent = s; });
    const cands = await identify(sc, 5, t => { const el = $("#scanStep span"); if (el) el.textContent = t; });
    lastCandidates = cands;
    const p = cands.parsed;
    lastScan = { name: cands.nameRead, number: p ? (p.total ? `${p.num}/${p.total}` : p.subset ? `${p.num}/${p.subset}` : p.num) : (cands.totalHint ? `?/${cands.totalHint}` : ""), codes: [...setCodes(sc.codeText)].slice(0, 3).join(" "),
      nameImg: sc.dbg.nameCanvas.toDataURL("image/png"), numImg: sc.dbg.numCanvas.toDataURL("image/png"), cardImg: thumb(sc.card, 260), found: sc.dbg.found };
    $("#qName").value = lastScan.name ? lastScan.name.replace(/^./, ch => ch.toUpperCase()) : ""; $("#qNum").value = lastScan.number.startsWith("?") ? "" : lastScan.number;   // precompilo la ricerca: puoi correggere a mano
    if (!cands.length) {
      $("#result").innerHTML = '<div class="msg warn">Carta non riconosciuta. Guarda qui sotto cosa ho letto: correggi nome o numero nei campi «Cerca / correggi a mano», oppure riprova con più luce e la carta dritta nel riquadro.</div>' + scanInfoHtml();
      return;
    }
    autoAddedId = null;
    await selectCard(cands[0], true);
  } catch (e) { $("#result").innerHTML = `<div class="msg err">Errore: ${esc(e.message)}</div>`; }
}
function thumb(c, w) { const k = w / c.width, t = document.createElement("canvas"); t.width = w; t.height = Math.round(c.height * k); t.getContext("2d").drawImage(c, 0, 0, t.width, t.height); return t.toDataURL("image/jpeg", 0.8); }
function scanInfoHtml() {
  const s = lastScan; if (!s) return "";
  return `<details class="panel read" open><summary>Cosa ho letto negli angoli</summary>
    <div class="kv"><span>Nome</span><span>${esc(s.name || "non letto")}</span><span>Numero</span><span>${esc(s.number || "non letto")}</span><span>Codice set</span><span>${esc(s.codes || "—")}</span></div>
    <div class="crops"><figure><img src="${s.cardImg}" alt=""><figcaption>${s.found ? "Carta trovata e raddrizzata" : "Carta non individuata: uso il riquadro"}</figcaption></figure><figure><img src="${s.nameImg}" alt=""><figcaption>Nome (in alto a sinistra)</figcaption></figure><figure><img src="${s.numImg}" alt=""><figcaption>Numero e simbolo (fascia in basso)</figcaption></figure></div>
    <div class="note">Se è sbagliato, correggi nome o numero nei campi «Cerca / correggi a mano».</div></details>`;
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
    <div class="panel result" style="--t:${typeColor(c.card_type)}">
      <div class="hero">
        <div class="rart">${artHtml(c)}<div class="foil"></div></div>
        <div class="rinfo"><div class="name">${esc(c.name)}</div><div class="coll">${esc(c.expansion_name)}</div>
          <div class="badges"><span class="b t">${esc(c.card_type || "Tipo n/d")}</span><span class="b">PS ${c.hp ?? "—"}</span><span class="b">${esc(c.rarity || "Rarità n/d")}</span><span class="b">#${esc(c.collector_number)}</span></div>
          <div class="price">${eur(c.last_price_cents, c.last_price_currency)}<small>prezzo minimo in vendita su CardTrader${c.last_price_at ? " · " + esc(when(c.last_price_at)) : ""}</small></div>
        </div>
      </div>
      <label class="flag"><input type="checkbox" id="own" ${owned ? "checked" : ""}><span class="box" aria-hidden="true"></span><span class="ft">Ce l'ho nella mia raccolta</span>
        ${owned ? `<span class="qty"><button id="qm" aria-label="Una in meno">−</button><b>${c.owned_qty}</b><button id="qp" aria-label="Una in più">+</button></span>` : ""}</label>
      ${low ? '<div class="msg warn" style="margin:12px 0 0">Non sono sicuro che sia questa: controlla e barra tu il flag, oppure scegli un’altra carta.</div>' : ""}
    </div>
    ${others.length ? `<div class="panel"><div class="ptitle">Forse era un’altra?</div>${others.map(candHtml).join("")}</div>` : ""}${scanInfoHtml()}`;
  $("#own").onchange = async e => { const k = c.confidence; current = await setOwned(c.blueprint_id, e.target.checked); current.confidence = k; if (!e.target.checked) autoAddedId = null; renderResult(); };
  if (owned) {
    const setQ = async n => { const k = c.confidence; current = n < 1 ? await setOwned(c.blueprint_id, false) : await setOwned(c.blueprint_id, true, n); current.confidence = k; renderResult(); };
    $("#qm").onclick = e => { e.preventDefault(); setQ(c.owned_qty - 1); }; $("#qp").onclick = e => { e.preventDefault(); setQ(c.owned_qty + 1); };
  }
  $$("#result [data-pick]").forEach(el => el.onclick = () => selectCard(lastCandidates.find(k => k.blueprint_id == el.dataset.pick), false));
}

let st; ["#qName", "#qNum"].forEach(id => $(id).oninput = () => { clearTimeout(st); st = setTimeout(doSearch, 300); });
async function doSearch() {
  const nq = $("#qName").value.trim(), nu = $("#qNum").value.trim();
  if (nq.length < 2 && !/\d/.test(nu)) { $("#searchOut").innerHTML = ""; return; }
  const list = await searchCards(nq, nu);
  lastCandidates = list;
  $("#searchOut").innerHTML = list.map(candHtml).join("") || '<div class="note" style="margin-top:8px">Nessun risultato</div>';
  $$("#searchOut [data-pick]").forEach(el => el.onclick = () => { autoAddedId = null; selectCard(list.find(k => k.blueprint_id == el.dataset.pick), false); window.scrollTo({ top: 0, behavior: "smooth" }); });
}

/* ------------------------------------------------------------- raccolta */
const TYPE_COL = [[/fuoc|fire/i, "#ff6b3d"], [/acqu|water/i, "#3da5ff"], [/erba|grass/i, "#4cd964"], [/lamp|electr|lightn/i, "#ffd60a"], [/psic|psych/i, "#c06bff"], [/lott|fight/i, "#c7773a"],
  [/oscur|dark/i, "#7b7fb5"], [/metall|steel/i, "#9fb3c8"], [/drag/i, "#d9a441"], [/foll|fairy/i, "#ff8ad8"], [/incol|color/i, "#d6d6e0"], [/allen|trainer/i, "#35d0c0"], [/energ/i, "#f0e68c"]];
const typeColor = t => { for (const [rx, c] of TYPE_COL) if (rx.test(t || "")) return c; return "#8d97ff"; };

const UI = { view: "grid", sort: "recent", group: false, collapsed: new Set() };
try { Object.assign(UI, JSON.parse(localStorage.getItem("pc_ui") || "{}")); } catch (e) { }
UI.collapsed = new Set();
const saveUI = () => { try { localStorage.setItem("pc_ui", JSON.stringify({ view: UI.view, sort: UI.sort, group: UI.group })); } catch (e) { } };

const natCmp = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), "it", { numeric: true, sensitivity: "base" });
const priceCmp = dir => (a, b) => { const x = a.last_price_cents, y = b.last_price_cents; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return dir * (y - x); };
const chgOf = r => r.rd ? r.rd.now - r.rd.prev : null;
const chgCmp = dir => (a, b) => { const x = chgOf(a), y = chgOf(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return dir * (y - x); };
const SORTS = {
  recent: (a, b) => (a.added_at < b.added_at ? 1 : -1),
  valueDesc: priceCmp(1), valueAsc: priceCmp(-1),
  name: (a, b) => natCmp(a.name, b.name),
  number: (a, b) => natCmp(a.collector_number, b.collector_number),
  chgUp: chgCmp(1), chgDown: chgCmp(-1),
};
let rows = [], lastRefreshInfo = null;

async function renderCollection() {
  const col = await DB.getAll("collection"), list = [];
  lastRefreshInfo = await DB.meta("last_refresh", null);
  for (const c of col) {
    const f = await cardFull(c.blueprint_id); if (!f) continue;
    const rc = lastRefreshInfo && lastRefreshInfo.cards && lastRefreshInfo.cards[f.blueprint_id];
    f.rd = rc ? { prev: rc[0], now: rc[1], cur: f.last_price_currency } : null;
    list.push(f);
  }
  rows = list;
  await drawHero();
  drawItems();
}

function spark(series) {
  if (!series || series.length < 2) return "";
  const W = 260, H = 54, xs = series.map(s => +new Date(s.at)), ys = series.map(s => s.cents);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), pad = (y1 - y0) || 1;
  const X = v => 4 + (W - 8) * (x1 === x0 ? .5 : (v - x0) / (x1 - x0)), Y = v => H - 6 - (H - 14) * ((v - y0) / pad);
  const pts = series.map((s, i) => `${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`);
  const up = ys[ys.length - 1] >= ys[0];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Andamento del valore della raccolta"><defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? "#3be3a5" : "#ff5a76"}" stop-opacity=".35"/><stop offset="1" stop-color="${up ? "#3be3a5" : "#ff5a76"}" stop-opacity="0"/></linearGradient></defs>
    <path d="M${pts.join(" L")} L${X(x1).toFixed(1)},${H} L${X(x0).toFixed(1)},${H} Z" fill="url(#sg)"/><path d="M${pts.join(" L")}" fill="none" stroke="${up ? "#3be3a5" : "#ff5a76"}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${X(xs[xs.length - 1])}" cy="${Y(ys[ys.length - 1])}" r="3.6" fill="${up ? "#3be3a5" : "#ff5a76"}"/></svg>`;
}
const placeholder = r => `<div class="ph" style="--t:${typeColor(r.card_type)}"><span>${esc(r.name)}</span></div>`;
const artHtml = r => r.image_url ? `<img src="${esc(r.image_url)}" alt="${esc(r.name)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',innerHTML:'<span>${esc(r.name).replace(/'/g, "")}</span>'}))">` : placeholder(r);

async function drawHero() {
  const cur = Settings.get().currency;
  const total = rows.reduce((a, r) => a + (r.last_price_cents || 0) * r.owned_qty, 0);
  const qtyTot = rows.reduce((a, r) => a + r.owned_qty, 0);
  const updated = await DB.meta("prices_updated_at"), series = (await DB.meta("totals", [])) || [];
  const lr = lastRefreshInfo;
  const top3 = [...rows].filter(r => r.last_price_cents != null).sort((a, b) => b.last_price_cents - a.last_price_cents).slice(0, 3);
  const fan = top3.length ? `<div class="fan" aria-label="Le carte più preziose">${top3.map((r, i) => `<div class="fc fc${i}" style="--t:${typeColor(r.card_type)}">${artHtml(r)}<div class="foil"></div><span class="fp">${eur(r.last_price_cents, r.last_price_currency)}</span></div>`).join("")}</div>` : "";
  $("#collHero").innerHTML = `<div class="hv">
      <div class="hl">Valore della raccolta</div>
      <div class="big" id="total">${eur(total, cur)}</div>
      <div class="hrow">${lr ? deltaHtml({ prev: lr.prevTotal, now: lr.newTotal, cur }, { big: true }) + `<span class="note">dall'ultimo aggiornamento · ${esc(when(lr.at))}</span>` : `<span class="note">${rows.length ? "Premi «Aggiorna valore» per vedere come cambia il valore" : ""}</span>`}</div>
      <div class="hsub" id="totalInfo">${rows.length} carte diverse · ${qtyTot} totali · prezzi aggiornati: ${esc(when(updated))}</div>
      ${spark(series)}
    </div>${fan}`;
}

function filtered() {
  const f = cleanName($("#filter").value);
  const l = rows.filter(r => !f || cleanName([r.name, r.expansion_name, r.card_type, r.collector_number].join(" ")).includes(f));
  l.sort(SORTS[UI.sort] || SORTS.recent);
  return l;
}
function tileHtml(r) {
  return `<article class="tile" data-id="${r.blueprint_id}" tabindex="0" style="--t:${typeColor(r.card_type)}">
    <div class="art">${artHtml(r)}<div class="foil"></div>${r.owned_qty > 1 ? `<span class="qty">×${r.owned_qty}</span>` : ""}${r.rd ? `<span class="chip">${deltaHtml(r.rd, { pct: false })}</span>` : ""}</div>
    <div class="meta"><b class="nm">${esc(r.name)}</b><span class="st">${UI.group ? "" : esc(r.expansion_name) + " · "}#${esc(r.collector_number)}</span><strong class="pr">${eur(r.last_price_cents, r.last_price_currency)}</strong></div></article>`;
}
function listHtml(l) {
  return `<div class="tw"><table><thead><tr><th></th><th>Nome</th><th class="hide-s">Collezione</th><th>N°</th><th class="hide-s">Tipo</th><th class="num hide-s">PS</th><th class="num">Q.tà</th><th class="num">Valore</th><th class="num">Ultimo aggiornamento</th></tr></thead><tbody>${
    l.map(r => `<tr data-id="${r.blueprint_id}" tabindex="0"><td class="th">${r.image_url ? `<img src="${esc(r.image_url)}" loading="lazy" alt="">` : ""}</td><td><b>${esc(r.name)}</b></td><td class="hide-s">${esc(r.expansion_name)}</td><td>${esc(r.collector_number)}</td>
      <td class="hide-s"><span class="dot" style="background:${typeColor(r.card_type)}"></span>${esc(r.card_type)}</td><td class="num hide-s">${r.hp ?? "—"}</td><td class="num">${r.owned_qty}</td>
      <td class="num"><b>${eur(r.last_price_cents, r.last_price_currency)}</b></td><td class="num">${deltaHtml(r.rd) || '<span class="note">—</span>'}</td></tr>`).join("")}</tbody></table></div>`;
}
const itemsHtml = l => UI.view === "grid" ? `<div class="tiles">${l.map(tileHtml).join("")}</div>` : listHtml(l);

function drawItems() {
  const l = filtered(), wrap = $("#tableWrap");
  $("#sort").value = UI.sort; $("#group").checked = UI.group;
  $("#viewGrid").classList.toggle("on", UI.view === "grid"); $("#viewList").classList.toggle("on", UI.view === "list");
  if (!l.length) {
    wrap.innerHTML = rows.length ? '<div class="empty"><b>Nessun risultato</b>Prova con un altro nome o collezione.</div>'
      : '<div class="empty"><div class="ball big"></div><b>La tua raccolta è vuota</b>Scansiona la prima carta: compare qui con il suo valore.<button class="btn" id="goScan">Scansiona una carta</button></div>';
    const g = $("#goScan"); if (g) g.onclick = () => showTab("scan");
    return;
  }
  if (!UI.group) wrap.innerHTML = itemsHtml(l);
  else {
    const groups = new Map();
    for (const r of l) { if (!groups.has(r.expansion_id)) groups.set(r.expansion_id, { name: r.expansion_name || "Senza collezione", items: [], total: 0 }); const g = groups.get(r.expansion_id); g.items.push(r); g.total += (r.last_price_cents || 0) * r.owned_qty; }
    const byValue = UI.sort === "valueDesc" || UI.sort === "valueAsc";
    const order = [...groups.entries()].sort((a, b) => byValue ? (UI.sort === "valueDesc" ? 1 : -1) * (b[1].total - a[1].total) : natCmp(a[1].name, b[1].name));
    wrap.innerHTML = order.map(([id, g]) => `<section class="grp"><header class="ghead" data-g="${id}" tabindex="0" aria-expanded="${!UI.collapsed.has(id)}"><h3>${esc(g.name)}</h3><span class="gs"><b>${g.items.length}</b> ${g.items.length === 1 ? "carta" : "carte"} · <b>${eur(g.total, Settings.get().currency)}</b></span><i class="chev${UI.collapsed.has(id) ? " shut" : ""}"></i></header>${UI.collapsed.has(id) ? "" : itemsHtml(g.items)}</section>`).join("");
    $$("#tableWrap .ghead").forEach(h => { const tg = () => { const id = +h.dataset.g; UI.collapsed.has(id) ? UI.collapsed.delete(id) : UI.collapsed.add(id); drawItems(); }; h.onclick = tg; h.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tg(); } }; });
  }
  $$("#tableWrap [data-id]").forEach(el => { const go = () => openCard(+el.dataset.id); el.onclick = go; el.onkeydown = e => { if (e.key === "Enter") go(); }; });
}
$("#filter").oninput = drawItems;
$("#sort").onchange = e => { UI.sort = e.target.value; saveUI(); drawItems(); };
$("#group").onchange = e => { UI.group = e.target.checked; saveUI(); drawItems(); };
$("#viewGrid").onclick = () => { UI.view = "grid"; saveUI(); drawItems(); };
$("#viewList").onclick = () => { UI.view = "list"; saveUI(); drawItems(); };
$("#btnRefresh").onclick = refreshAll;

/* ---- dettaglio carta con grafico dello storico */
function chart(hist) {
  const pts = hist.filter(h => h.price_cents != null);
  if (pts.length < 2) return '<div class="note chartnote">Servono almeno due controlli per vedere il grafico: premi «Aggiorna valore» nella raccolta.</div>';
  const W = 700, H = 210, P = 44, xs = pts.map(p => +new Date(p.checked_at)), ys = pts.map(p => p.price_cents / 100);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), pad = (y1 - y0) || 1;
  const X = v => P + (W - 2 * P - 10) * (x1 === x0 ? .5 : (v - x0) / (x1 - x0)), Y = v => H - 34 - (H - 56) * ((v - (y0 - pad * .15)) / (pad * 1.3));
  const up = ys[ys.length - 1] >= ys[0], col = up ? "#3be3a5" : "#ff5a76", pth = pts.map((p, i) => `${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Storico del valore"><defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".32"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>
    <line x1="${P}" x2="${W - 8}" y1="${Y(y1)}" y2="${Y(y1)}" class="gl"/><line x1="${P}" x2="${W - 8}" y1="${Y(y0)}" y2="${Y(y0)}" class="gl"/>
    <path d="M${pth.join(" L")} L${X(x1)},${H - 34} L${X(x0)},${H - 34} Z" fill="url(#cg)"/><path d="M${pth.join(" L")}" fill="none" stroke="${col}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    ${pts.map((p, i) => `<circle cx="${X(xs[i])}" cy="${Y(ys[i])}" r="4.5" fill="#10143a" stroke="${col}" stroke-width="2.5"><title>${eur(p.price_cents, p.currency)} · ${when(p.checked_at)}</title></circle>`).join("")}
    <text x="4" y="${Y(y1) + 4}">${y1.toFixed(2)} €</text><text x="4" y="${Y(y0) + 4}">${y0.toFixed(2)} €</text>
    <text x="${P}" y="${H - 10}">${new Date(x0).toLocaleDateString("it-IT")}</text><text x="${W - 8}" y="${H - 10}" text-anchor="end">${new Date(x1).toLocaleDateString("it-IT")}</text></svg>`;
}
async function openCard(id) {
  const c = await cardFull(id); if (!c) return;
  const hist = (await DB.byIndex("history", "blueprint_id", id)).sort((a, b) => a.checked_at < b.checked_at ? -1 : 1);
  const priced = hist.filter(h => h.price_cents != null);
  const since = priced.length > 1 ? { prev: priced[0].price_cents, now: c.last_price_cents ?? priced[priced.length - 1].price_cents, cur: c.last_price_currency } : null;
  const rc = lastRefreshInfo && lastRefreshInfo.cards && lastRefreshInfo.cards[id];
  const lastRef = rc ? { prev: rc[0], now: rc[1], cur: c.last_price_currency } : null;
  let prevP = null;
  const histRows = hist.map(h => { const d = (prevP != null && h.price_cents != null) ? { prev: prevP, now: h.price_cents, cur: h.currency } : null; if (h.price_cents != null) prevP = h.price_cents; return `<div class="hr"><span>${esc(when(h.checked_at))}</span><span>${eur(h.price_cents, h.currency)} <small class="note">· ${h.offers ?? 0} offerte</small></span><span class="hd">${deltaHtml(d, { pct: false })}</span></div>`; }).reverse().join("");
  $("#dlgBody").innerHTML = `<div class="dhero" style="--t:${typeColor(c.card_type)}"><div class="dart">${artHtml(c)}<div class="foil"></div></div>
    <div class="dinfo"><h2>${esc(c.name)}</h2><div class="coll">${esc(c.expansion_name)}</div>
      <div class="badges"><span class="b t">${esc(c.card_type || "Tipo n/d")}</span><span class="b">PS ${c.hp ?? "—"}</span><span class="b">${esc(c.rarity || "Rarità n/d")}</span><span class="b">#${esc(c.collector_number)}</span></div>
      <div class="dval"><span class="note">Valore attuale</span><strong>${eur(c.last_price_cents, c.last_price_currency)}</strong>${c.owned_qty > 1 ? `<span class="note">× ${c.owned_qty} = ${eur((c.last_price_cents || 0) * c.owned_qty, c.last_price_currency)}</span>` : ""}</div>
      <div class="dchg"><div><span class="note">Ultimo aggiornamento</span>${deltaHtml(lastRef) || '<span class="note">—</span>'}</div><div><span class="note">Dall'inizio</span>${deltaHtml(since) || '<span class="note">—</span>'}</div></div>
    </div></div>
    <h3 class="dh">Storico del valore</h3>${chart(hist)}
    <div class="hist">${histRows || '<div class="note">Nessun controllo ancora.</div>'}</div>
    <div class="dfoot"><button class="btn bad" id="rm">Rimuovi dalla raccolta</button><button class="btn sec" id="cl">Chiudi</button></div>`;
  $("#dlg").showModal();
  $("#cl").onclick = () => $("#dlg").close();
  $("#rm").onclick = async () => { if (confirm("Rimuovere questa carta dalla raccolta? Lo storico prezzi resta salvato.")) { await setOwned(id, false); $("#dlg").close(); renderCollection(); } };
}
$("#dlg").addEventListener("click", e => { if (e.target === $("#dlg")) $("#dlg").close(); });

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
    const res = await syncCatalog((i, n, name) => { box.innerHTML = `<b>Collezione ${i}/${n}</b> — ${esc(name)}<progress max="${n}" value="${i}"></progress>`; });
    box.innerHTML = '<div class="msg ok">Catalogo aggiornato.</div>' + (res && res.printed ? "" : '<div class="msg warn">Non sono riuscito a scaricare i totali stampati dei set (sito pokemontcg.io non raggiungibile): uso una stima, il riconoscimento sarà un po\' meno preciso. Riprova più tardi con «Scarica / aggiorna catalogo».</div>');
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
  window.App = { DB, Settings, identify, searchCards, scanImage, parseNumber, nameCandidates, deltaHtml, UI, syncCatalog, setOwned, recordPrice, refreshAll, loadCache, cardFull, ctGet, bestPrice, parseBlueprint, normKey, selectCard };
  window.dispatchEvent(new Event("app-ready"));
})();
