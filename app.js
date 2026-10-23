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
const Cache = { cards: [], exps: new Map(), byKey: new Map(), byName: new Map(), setNums: new Map() };

async function loadCache() {
  const [cards, exps] = await Promise.all([DB.getAll("cards"), DB.getAll("expansions")]);
  Cache.exps = new Map(exps.map(e => [e.id, e]));
  Cache.cards = cards.map(c => ({ id: c.blueprint_id, name: c.name, cn: cleanName(c.name), key: c.collector_key, exp: c.expansion_id }));
  Cache.byKey = new Map(); Cache.byName = new Map(); Cache.setNums = new Map();
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

// Numero stampato in basso a sinistra, di solito tipo "050/148". Ritorna {key, num, total, raw} o null.
function parseNumber(text) {
  const t = String(text || "").toUpperCase();
  const ok = (n, tot) => n >= 1 && n <= 500 && tot >= 5 && tot <= 500;
  let m = t.match(/(?<!\d)(\d{1,3})\s*[\/\\|]\s*(\d{2,3})(?!\d)/);          // anche se attaccato alle lettere ("SVIEN025/198")
  if (m && ok(+m[1], +m[2])) return { key: normKey(m[1]), num: m[1], total: +m[2], raw: m[0] };
  m = t.match(/(?<![A-Z0-9])([A-Z]{1,3}\d{1,3})\s*[\/\\|]\s*([A-Z]{1,3}\d{1,3})(?!\d)/);          // TG05/TG30, GG05/GG70
  if (m) return { key: normKey(m[1]), num: m[1], total: null, raw: m[0] };
  for (const tok of t.split(/\s+/)) {                                                // O/0, I/1 confusi dall'OCR
    if (!/^[\dOQIL\/\\|]{5,9}$/.test(tok) || !/\d/.test(tok)) continue;
    const f = tok.replace(/[OQ]/g, "0").replace(/[IL]/g, "1").replace(/[\\|]/g, "/");
    const mm = f.match(/^(\d{1,3})\/(\d{2,3})$/);
    if (mm && ok(+mm[1], +mm[2])) return { key: normKey(mm[1]), num: mm[1], total: +mm[2], raw: tok };
  }
  m = t.match(/\b(SVP|SVE|SWSH|SM|XY|BW|HGSS|DP|SMP)\s*0*(\d{1,3})\b/);               // promo
  if (m) return { key: normKey(m[1] + m[2]), num: m[1] + m[2], total: null, raw: m[0] };
  return null;
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
// Nomi candidati letti nella zona in alto a sinistra (tolgo "Basic", "Fase 1", PS…)
function nameCandidates(texts) {
  const out = new Set();
  for (const txt of texts) for (const raw of String(txt || "").split(/[\r\n]+/)) {
    let l = raw.replace(/[|_]/g, " ");
    l = l.replace(/\b(basic|stage\s*[12]|restored|baby|fase\s*[12]|base|pokémon|pokemon)\b/gi, " ");
    l = l.replace(/\b(hp|ps)\s*\d+\b/gi, " ").replace(/\b\d+\s*(hp|ps)\b/gi, " ").replace(/\b\d+\b/g, " ");
    const cn = cleanName(l);
    if (cn.length >= 3 && cn.length <= 30) out.add(cn);
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
const codeMatch = (expId, codes) => { const e = Cache.exps.get(expId) || {}; return [e.code, e.ptcgo_code].some(c => c && codes.has(normCode(c))) ? 1 : 0; };

// Riconoscimento dopo la scansione: nome (alto sx) + numero/totale (basso sx) + codice set.
async function identify(input, limit = 5) {
  const inp = typeof input === "string" ? { fullText: input } : (input || {});
  const fullText = inp.fullText || "", nameText = inp.nameText || "", numText = inp.numText || "";
  const parsed = inp.parsed || parseNumber(numText) || parseNumber(fullText);
  const strong = nameCandidates([nameText]);
  const cands = strong.length ? strong : nameCandidates([fullText]);
  const nameFactor = strong.length ? 1 : 0.8;
  const codes = setCodes(inp.codeText || numText || fullText);
  const hasTotal = !!(parsed && parsed.total);
  const W = hasTotal ? { name: 0.5, num: 0.2, tot: 0.2, code: 0.1 } : { name: 0.65, num: 0.25, tot: 0, code: 0.1 };

  const scored = [];
  const pool = parsed && Cache.byKey.get(parsed.key);
  if (pool && pool.length) {
    for (const c of pool) {
      const ns = (cands.length ? nameScore(c.cn, cands) : 0) * nameFactor;
      scored.push([W.name * ns + W.num + W.tot * totalCompat(c.exp, parsed.total) + W.code * codeMatch(c.exp, codes), c]);
    }
  } else if (cands.length) {                       // numero non letto: solo nome, confidenza bassa (niente flag automatico)
    for (const [cn, cs] of Cache.byName) {
      const ns = nameScore(cn, cands) * nameFactor;
      if (ns < 0.7) continue;
      for (const c of cs) {
        scored.push([0.6 * ns + 0.05 * codeMatch(c.exp, codes), c]);
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
  out.parsed = parsed; out.nameRead = strong[0] || "";
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
    const base = Cache.byKey.get(p.key) || [];
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

/* ------------------------------------------------------------- OCR per zone */
// Zone della carta (frazioni di larghezza/altezza): nome in alto a sinistra, numero e simbolo in basso a sinistra.
const REG = {
  name: { x0: 0.03, x1: 0.74, y0: 0.02, y1: 0.13 },
  numLeft: { x0: 0.02, x1: 0.52, y0: 0.905, y1: 0.995 },
  numStrip: { x0: 0.0, x1: 1.0, y0: 0.9, y1: 1.0 },
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
    for (let i = 0; i < n; i++) { let v = gray[i] > thr ? 255 : 0; if (invert) v = 255 - v; d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v; }
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

// Legge nome (alto sx) e numero/codice (basso sx) e li restituisce già pronti per il riconoscimento.
async function scanImage(src, W, H, cropToGuide, onStep = () => { }) {
  const g = cropToGuide ? guideRect(W, H) : { x: 0, y: 0, w: W, h: H };
  const dbg = {};
  onStep("Leggo il nome…");
  const nameTexts = [];
  for (const [v, psm] of [["gray", "7"], ["bin", "7"], ["gray", "6"]]) {
    const c = prep(src, g, REG.name, 1400, v); if (!dbg.nameCanvas) dbg.nameCanvas = c;
    nameTexts.push(await ocrWith(c, psm));
  }
  onStep("Leggo numero e simbolo…");
  const numTexts = [], votes = new Map();
  for (const [reg, psm] of [[REG.numLeft, "7"], [REG.numStrip, "11"]]) {      // prima in basso a sinistra, poi tutta la fascia
    for (const v of ["bin", "gray", "binInv"]) {
      const c = prep(src, g, reg, 1000, v);
      const t = await ocrWith(c, psm, NUM_WL); numTexts.push(t);
      const p = parseNumber(t);
      if (p) { const k = p.key + "/" + (p.total || ""); const e = votes.get(k) || { p, n: 0, canvas: c }; e.n++; votes.set(k, e); if (!dbg.numCanvas) dbg.numCanvas = c; }
    }
    if (votes.size) break;
  }
  let parsed = null;
  if (votes.size) parsed = [...votes.values()].sort((a, b) => b.n - a.n)[0].p;            // vince la lettura più ripetuta
  if (!dbg.numCanvas) dbg.numCanvas = prep(src, g, REG.numLeft, 1600, "bin");
  let fullText = nameTexts.join("\n") + "\n" + numTexts.join("\n");
  if (!parsed || !nameCandidates(nameTexts).length) {                                       // ultima spiaggia: tutta la carta
    onStep("Leggo tutta la carta…");
    fullText += "\n" + await ocrWith(prep(src, g, { x0: 0, x1: 1, y0: 0, y1: 1 }, 1200, "gray"), "3");
  }
  return { nameText: nameTexts.join("\n"), numText: numTexts.join("\n"), codeText: numTexts.join("\n"), fullText, parsed, dbg };
}

let lastScan = null;
async function scanAndShow(src, w, h, cropToGuide) {
  $("#result").innerHTML = '<div class="panel spin" id="scanStep">⏳ Leggo la carta… (la prima volta ci vuole qualche secondo)</div>';
  try {
    const sc = await scanImage(src, w, h, cropToGuide, s => { const el = $("#scanStep"); if (el) el.textContent = "⏳ " + s; });
    const cands = await identify(sc);
    lastCandidates = cands;
    const p = cands.parsed;
    lastScan = { name: cands.nameRead, number: p ? (p.total ? `${p.num}/${p.total}` : p.num) : "", codes: [...setCodes(sc.codeText)].slice(0, 3).join(" "),
      nameImg: sc.dbg.nameCanvas.toDataURL("image/png"), numImg: sc.dbg.numCanvas.toDataURL("image/png"), text: sc.fullText };
    $("#qName").value = lastScan.name ? lastScan.name.replace(/^./, ch => ch.toUpperCase()) : ""; $("#qNum").value = lastScan.number;   // precompilo la ricerca: puoi correggere a mano
    if (!cands.length) {
      $("#result").innerHTML = '<div class="msg warn">Carta non riconosciuta. Controlla qui sotto cosa ho letto: correggi nome o numero nei campi di ricerca, oppure riprova con più luce e la carta dritta nel riquadro.</div>' + scanInfoHtml();
      return;
    }
    autoAddedId = null;
    await selectCard(cands[0], true);
  } catch (e) { $("#result").innerHTML = `<div class="msg err">Errore: ${esc(e.message)}</div>`; }
}
function scanInfoHtml() {
  const s = lastScan; if (!s) return "";
  return `<details class="panel" open><summary style="margin:0;color:var(--txt);font-weight:600">Cosa ho letto sulla carta</summary>
    <div class="grid"><span>Nome</span><span>${esc(s.name || "non letto")}</span><span>Numero</span><span>${esc(s.number || "non letto")}</span><span>Codice set</span><span>${esc(s.codes || "—")}</span></div>
    <div class="note" style="margin-top:10px">Zone analizzate (nome in alto a sinistra, numero in basso a sinistra):</div>
    <img src="${s.nameImg}" style="max-width:100%;background:#fff;border-radius:6px;margin-top:6px"><img src="${s.numImg}" style="max-width:100%;background:#fff;border-radius:6px;margin-top:6px">
    <div class="note" style="margin-top:8px">Se è sbagliato, correggi nome/numero nei campi «Cerca / correggi a mano».</div></details>`;
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
    ${others.length ? `<div class="panel"><b>Forse era un’altra?</b>${others.map(candHtml).join("")}</div>` : ""}${scanInfoHtml()}`;
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
  window.App = { DB, Settings, identify, searchCards, scanImage, parseNumber, syncCatalog, setOwned, recordPrice, refreshAll, loadCache, cardFull, ctGet, bestPrice, parseBlueprint, normKey, selectCard };
  window.dispatchEvent(new Event("app-ready"));
})();
