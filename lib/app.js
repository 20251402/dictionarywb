// =====================================================================
//  사전 앱(팩토리). 로컬 서버와 Netlify 함수가 공유한다.
//    · 영한 : 구글 번역 사전(비공식·키 불필요) → kengdic(내장)
//    · 국어 : 표준국어대사전(STDICT_KEY) + 용례
//    · 한자 : 글자정보(내장) + 한자어(우리말샘 OPENDICT_KEY, 폴백 내장)
//    · 중세 : 우리말샘 옛말(OPENDICT_KEY)
//    · 로그인/검색기록/퀴즈/손글씨
// =====================================================================
import express from "express";
import cors from "cors";
import { createAuth } from "./auth.js";

// 사전 데이터를 함수 번들에 직접 포함(런타임 파일경로 의존성 제거 → Netlify 함수에서 안전)
import ENDIC from "./data/endic.json" with { type: "json" };
import HANJA from "./data/hanja-chars.json" with { type: "json" };
import HW from "./data/hanja-words.json" with { type: "json" };
const WORD_IDX = {};
for (const list of [HW.words, HW.idioms])
  for (const it of list) for (const ch of it.w)
    if (/[\u4E00-\u9FFF]/.test(ch)) (WORD_IDX[ch] ||= []).push({ w: it.w, k: it.k });

async function fetchT(url, opts = {}, ms = 9000) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(id); }
}
const stripTags = s => String(s || "").replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, " ").trim();
const isCJK = c => /[\u4E00-\u9FFF]/.test(c);
const hanOnly = s => (String(s || "").match(/[\u4E00-\u9FFF]/g) || []).join("");
const cleanWord = w => stripTags(String(w || "")).replace(/\^/g, " ").replace(/-/g, "").trim();
const cleanDef = d => stripTags(String(d || "").replace(/\{[^}]*\}/g, "")).replace(/\s+/g, " ").trim();
const radicalText = rad => { const r = HANJA[rad]; return r ? `${rad} (${r.read.replace(/\s+/g, "")})` : (rad || ""); };

export function createApp({ store, env = process.env, serveStatic = false, publicDir } = {}) {
  const app = express();
  app.use(cors({ origin: env.FRONTEND_URL || true, credentials: true }));
  app.use(express.json({ limit: "64kb" }));
  const { OPENDICT_KEY, STDICT_KEY } = env;

  // ── 영한 ──────────────────────────────────────────────────────────
  function searchEnglishKengdic(q) {
    const key = q.trim().toLowerCase().replace(/^(to|a|an|the)\s+/, "");
    const list = ENDIC[key];
    if (!list || !list.length) return [];
    return [{ headword: q.trim(), phon: "", speak: q.trim(), lang: "en-US",
      senses: [{ pos: "한국어 뜻", defs: list.map(e => (e.h ? `${e.k} (${e.h})` : e.k)) }] }];
  }
  const POS_KO = { noun: "명사", verb: "동사", adjective: "형용사", adverb: "부사", pronoun: "대명사", preposition: "전치사", conjunction: "접속사", interjection: "감탄사", determiner: "한정사", abbreviation: "약어", prefix: "접두사", suffix: "접미사", article: "관사", numeral: "수사", particle: "불변화사", phrase: "구" };
  async function searchEnglishGoogle(q) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dj=1&sl=en&tl=ko&dt=t&dt=bd&q=${encodeURIComponent(q)}`;
    const r = await fetchT(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error("gtranslate " + r.status);
    const data = await r.json();
    let senses = (data.dict || []).map(d => ({ pos: POS_KO[d.pos] || d.pos || "", defs: (d.terms || []).slice(0, 8) })).filter(s => s.defs.length);
    if (!senses.length) {
      const trans = (data.sentences || []).map(s => s.trans).filter(Boolean).join("").trim();
      if (!trans || trans.toLowerCase() === q.trim().toLowerCase()) return [];
      senses = [{ pos: "", defs: [trans] }];
    }
    return [{ headword: q.trim(), phon: "", speak: q.trim(), lang: "en-US", senses }];
  }
  async function searchEnglish(q) {
    try { const g = await searchEnglishGoogle(q); if (g.length) return g; } catch (e) { console.warn("[구글 사전 실패 → kengdic]", e.message); }
    return searchEnglishKengdic(q);
  }

  // ── 국어 ──────────────────────────────────────────────────────────
  function deepCollect(node, key, out) {
    if (Array.isArray(node)) { for (const x of node) deepCollect(x, key, out); return; }
    if (node && typeof node === "object")
      for (const k in node) (k === key && typeof node[k] === "string") ? out.push(node[k]) : deepCollect(node[k], key, out);
  }
  async function searchStdict(q) {
    const r = await fetchT(`https://stdict.korean.go.kr/api/search.do?key=${STDICT_KEY}&q=${encodeURIComponent(q)}&req_type=json&num=10`);
    if (!r.ok) throw new Error("stdict " + r.status);
    const data = await r.json();
    const items = data?.channel?.item || [];
    const clean = w => stripTags(w).replace(/\^/g, " ").replace(/-/g, "").trim();
    const map = new Map();
    for (const it of items) {
      const w = clean(it.word);
      const def = stripTags(it?.sense?.definition || it?.definition || "");
      if (!w || !def) continue;
      const pos = it.pos || it?.sense?.pos || "";
      const ex = it?.sense?.example ? [{ text: stripTags(it.sense.example) }] : [];
      if (!map.has(w)) map.set(w, { headword: w, senses: [], codes: [] });
      map.get(w).senses.push({ pos, defs: [def], examples: ex });
      const tc = it?.target_code || it?.sense?.target_code;
      if (tc) map.get(w).codes.push(String(tc));
    }
    let entries = [...map.values()];
    const exact = entries.filter(e => e.headword === q.trim());
    if (exact.length) entries = exact;
    entries = entries.slice(0, 5);
    await Promise.all(entries.slice(0, 3).map(async e => {
      if (e.senses.some(s => s.examples?.length) || !e.codes.length) return;
      try {
        const vr = await fetchT(`https://stdict.korean.go.kr/api/view.do?key=${STDICT_KEY}&req_type=json&method=target_code&target_code=${e.codes[0]}`);
        if (!vr.ok) return;
        const exs = []; deepCollect(await vr.json(), "example", exs);
        if (exs.length) e.senses[0].examples = exs.slice(0, 2).map(t => ({ text: stripTags(t) }));
      } catch { /* 무시 */ }
    }));
    entries.forEach(e => delete e.codes);
    return entries;
  }
  async function searchKorean(q) {
    if (!STDICT_KEY) return [];
    try { return await searchStdict(q); } catch (e) { console.warn("[국립국어원 실패]", e.message); return []; }
  }

  // ── 우리말샘 공통 ──────────────────────────────────────────────────
  const firstSense = it => Array.isArray(it.sense) ? it.sense[0] : it.sense;
  const itemOrigin = it => it.origin || firstSense(it)?.origin || "";
  async function uvalSearch(params) {
    if (!OPENDICT_KEY) throw new Error("OPENDICT_KEY(우리말샘) 미설정");
    const qs = new URLSearchParams({ key: OPENDICT_KEY, req_type: "json", ...params });
    const r = await fetchT(`https://opendict.korean.go.kr/api/search?${qs}`);
    if (!r.ok) throw new Error("opendict " + r.status);
    const data = await r.json();
    if (data?.error) throw new Error("opendict " + (data.error.message || data.error.error_code));
    const items = data?.channel?.item;
    return !items ? [] : (Array.isArray(items) ? items : [items]);
  }

  // ── 중세국어(옛말) ────────────────────────────────────────────────
  async function searchAncient(q) {
    if (!OPENDICT_KEY) return [];   // 키 미설정 → 국어와 동일하게 '결과 없음'으로 처리(에러 화면 방지)
    let list = [];
    try { list = await uvalSearch({ q, advanced: "y", target: 1, method: "exact", type3: "ancient", num: 20 }); }
    catch { }
    if (!list.length) { try { list = await uvalSearch({ q, advanced: "y", target: 1, method: "start", type3: "ancient", num: 20 }); } catch { } }
    if (!list.length) { try { list = await uvalSearch({ q, advanced: "y", target: 1, method: "include", type3: "ancient", num: 20 }); } catch { } }
    if (!list.length) { try { list = await uvalSearch({ q, advanced: "y", target: 9, method: "include", type3: "ancient", num: 30 }); } catch { } }
    const out = [], seen = new Set();
    for (const it of list) {
      const head = cleanWord(it.word); const key = head + "|" + (it.sense_no || "");
      if (!head || seen.has(key)) continue; seen.add(key);
      const origin = hanOnly(itemOrigin(it));
      const senses = (Array.isArray(it.sense) ? it.sense : [it.sense]).filter(Boolean)
        .map(s => ({ pos: s.pos || "옛말", defs: [cleanDef(s.definition || "")].filter(Boolean), examples: [] }))
        .filter(s => s.defs.length);
      if (!senses.length) continue;
      out.push({ headword: head, origin, senses });
      if (out.length >= 20) break;
    }
    return out;
  }

  // ── 한자 ──────────────────────────────────────────────────────────
  async function hanjaWordsUval(ch) {
    const items = await uvalSearch({ q: ch, advanced: "y", target: 2, method: "include", type2: "chinese", sort: "popular", num: 100 });
    const words = [], seen = new Set();
    for (const it of items) {
      const k = cleanWord(it.word);
      const origin = hanOnly(itemOrigin(it));
      if (!k || seen.has(k)) continue;
      if (origin && !origin.includes(ch)) continue;
      seen.add(k); words.push({ w: origin || k, k });
      if (words.length >= 24) break;
    }
    return words;
  }
  async function hanjaEntry(ch) {
    const e = HANJA[ch];
    if (!e) return null;
    let words = [];
    if (OPENDICT_KEY) { try { words = await hanjaWordsUval(ch); } catch (err) { console.warn("[우리말샘 한자어 실패]", err.message); } }
    if (!words.length) words = (WORD_IDX[ch] || []).map(w => ({ w: w.w, k: w.k }));
    return { kind: "char", char: ch, read: e.read, radical: radicalText(e.radical), strokes: e.strokes, grade: e.grade, defs: e.defs, words: words.slice(0, 18) };
  }
  async function hanjaWordLookup(t) {
    if (!OPENDICT_KEY) return [];
    const hasHan = [...t].some(isCJK);
    let items = [];
    try {
      items = hasHan
        ? await uvalSearch({ q: t, advanced: "y", target: 2, method: "exact", sort: "popular", num: 10 })
        : await uvalSearch({ q: t, advanced: "y", target: 1, method: "exact", type2: "chinese", sort: "popular", num: 10 });
    } catch (e) { console.warn("[한자어 검색 실패]", e.message); return []; }
    const out = [], seen = new Set();
    for (const it of items) {
      const word = cleanWord(it.word);
      const origin = hanOnly(itemOrigin(it));
      if (!word || !origin) continue;
      const key = word + "|" + origin;
      if (seen.has(key)) continue; seen.add(key);
      const s = firstSense(it);
      const def = cleanDef(s?.definition || "");
      const chars = [...origin].filter(isCJK).map(c => ({ char: c, read: HANJA[c]?.read || "" }));
      out.push({ kind: "word", word, origin, pos: s?.pos || "", defs: def ? [def] : [], chars });
      if (out.length >= 8) break;
    }
    return out;
  }
  function parseRead(read) {
    const parts = String(read || "").trim().split(/\s+/).filter(Boolean);
    return { hun: parts.slice(0, -1).join(" "), eum: parts[parts.length - 1] || "" };
  }
  // 급수 → 사용빈도 순위(8급이 가장 기초·흔함 … 1급·특급이 희귀). 큰 값일수록 자주 씀.
  //  급수 순서(흔함→희귀): 8급 > 7급Ⅱ > 7급 > 6급Ⅱ > 6급 > … > 1급 > 특급Ⅱ > 특급.
  //  'Ⅱ'(준급)는 같은 숫자 급수보다 더 기초라서 +0.5.
  function gradeRank(g) {
    g = String(g || "");
    const ii = g.includes("Ⅱ") ? 0.5 : 0;
    if (g.includes("특급")) return -1 + ii;   // 특급=-1, 특급Ⅱ=-0.5 → 가장 뒤(1급보다 아래)
    const m = g.match(/(\d)\s*급/);
    if (!m) return -2;                        // 급수 정보 없음 → 맨 뒤
    return Number(m[1]) + ii;                 // 8급=8 … 7급Ⅱ=7.5 > 7급=7 …
  }
  function hanjaBrowse(t, mode) {
    let chars = [];
    for (const ch in HANJA) {
      const { hun, eum } = parseRead(HANJA[ch].read);
      const defs = HANJA[ch].defs || [];
      const ok = mode === "hun"
        ? (hun.includes(t) || defs.some(d => d.includes(t)))
        : (eum === t);
      if (ok) chars.push({ char: ch, read: HANJA[ch].read, grade: HANJA[ch].grade });
    }
    chars.sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade));   // 자주 쓰는(급수 높은) 한자부터
    chars = chars.slice(0, 80).map(c => ({ char: c.char, read: c.read }));
    return [{ kind: "browse", mode: mode === "hun" ? "hun" : "eum", query: t, chars }];
  }
  async function searchHanja(q, mode = "eum") {
    const t = q.trim();
    const cjk = [...t].filter(isCJK);
    const hangul = /[\uAC00-\uD7A3]/.test(t);
    // 한글 한 음절 입력 → 음/뜻으로 한자 찾아보기(네이버식)
    if (hangul && !cjk.length && [...t].length === 1) return hanjaBrowse(t, mode === "hun" ? "hun" : "eum");
    // 두 글자 이상 → 어휘(한자어) 우선
    if (t.length >= 2) {
      const words = await hanjaWordLookup(t);
      if (words.length) return words;
      if (cjk.length >= 2) return (await Promise.all(cjk.map(hanjaEntry))).filter(Boolean);
    }
    if (cjk.length === 1) { const e = await hanjaEntry(cjk[0]); return e ? [e] : []; }
    // 그 외 한글(여러 음절) → 음/뜻 브라우즈로도 시도
    if (hangul) return hanjaBrowse(t, mode === "hun" ? "hun" : "eum");
    return [];
  }

  // ── 로그인 + 검색기록 ─────────────────────────────────────────────
  const auth = createAuth(store, env);
  auth.mount(app);

  const reqUser = (req, res) => { const u = auth.currentUser(req); if (!u) { res.status(401).json({ error: "login required" }); return null; } return u; };
  const bodyIds = req => (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);

  app.get("/api/history", (req, res) => {
    const u = reqUser(req, res); if (!u) return;
    res.json({ items: store.listHistory(u.uid, String(req.query.dict || ""), Math.min(Number(req.query.limit) || 200, 500)) });
  });
  app.post("/api/history", (req, res) => {                  // 단어 선택 시 검색기록 저장
    const u = reqUser(req, res); if (!u) return;
    const dict = String(req.body?.dict || ""), query = String(req.body?.query || "").trim();
    if (["korean", "english", "hanja", "ancient"].includes(dict) && query) store.addHistory(u.uid, dict, query);
    res.json({ ok: true });
  });
  app.get("/api/history/trash", (req, res) => {
    const u = reqUser(req, res); if (!u) return;
    res.json({ items: store.listTrash(u.uid, String(req.query.dict || "")) });
  });
  app.post("/api/history/trash", (req, res) => { const u = reqUser(req, res); if (!u) return; store.trashHistory(u.uid, bodyIds(req)); res.json({ ok: true }); });
  app.post("/api/history/restore", (req, res) => { const u = reqUser(req, res); if (!u) return; store.restoreHistory(u.uid, bodyIds(req)); res.json({ ok: true }); });
  app.delete("/api/history/trash", (req, res) => { const u = reqUser(req, res); if (!u) return; store.emptyTrash(u.uid, String(req.query.dict || "")); res.json({ ok: true }); });
  app.delete("/api/history/:id", (req, res) => { const u = reqUser(req, res); if (!u) return; store.deleteHistory(u.uid, Number(req.params.id)); res.json({ ok: true }); });

  // ── 퀴즈(4지선다) ─────────────────────────────────────────────────
  async function meaningOf(dict, q) {
    try {
      if (dict === "english") { const r = await searchEnglish(q); const s = r[0]?.senses?.[0]; return s ? (s.defs || []).slice(0, 3).join(", ") : ""; }
      if (dict === "korean" || dict === "ancient") { const r = await (dict === "ancient" ? searchAncient(q) : searchKorean(q)); return r[0]?.senses?.[0]?.defs?.[0] || ""; }
      if (dict === "hanja") {
        const r = await searchHanja(q); const e = r[0]; if (!e) return "";
        return e.kind === "word" ? (e.defs?.[0] || e.origin || "")
          : ((e.read ? e.read + (e.defs?.length ? " · " : "") : "") + (e.defs || []).slice(0, 2).join(", "));
      }
    } catch { /* 무시 */ }
    return "";
  }
  const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  app.post("/api/quiz", async (req, res) => {
    const dict = String(req.body?.dict || "");
    if (!["korean", "english", "hanja", "ancient"].includes(dict)) return res.status(400).json({ error: "bad dict" });
    let items = (Array.isArray(req.body?.items) ? req.body.items : []).map(s => String(s).trim()).filter(Boolean);
    items = [...new Set(items)].slice(0, 30);
    if (items.length < 4) return res.status(400).json({ error: "need4", message: "단어가 4개 이상일 때만 퀴즈를 만들 수 있어요." });
    const meaning = {};
    const pool = [...items];
    const worker = async () => { while (pool.length) { const q = pool.shift(); meaning[q] = await meaningOf(dict, q); } };
    await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
    const answerable = items.filter(q => meaning[q]);
    const questions = answerable.map(ans => {
      const distractors = shuffle(items.filter(x => x !== ans)).slice(0, 3);
      return { prompt: meaning[ans], answer: ans, options: shuffle([ans, ...distractors]) };
    });
    if (!questions.length) return res.status(422).json({ error: "nomeaning", message: "선택한 단어의 뜻을 찾지 못해 퀴즈를 만들 수 없어요." });
    res.json({ dict, total: questions.length, questions });
  });

  // ── 손글씨 인식(Google Input Tools 프록시) ────────────────────────
  const HW_ITC = { hanja: "zh_TW", hanzi: "zh_CN", hangul: "ko", english: "en" };
  app.post("/handwriting", async (req, res) => {
    const itc = HW_ITC[String(req.body?.lang || "hanja")] || "zh_TW";
    const ink = req.body?.ink;
    const width = Number(req.body?.width) || 400, height = Number(req.body?.height) || 400;
    if (!Array.isArray(ink) || !ink.length) return res.json({ candidates: [] });
    try {
      const r = await fetchT(`https://inputtools.google.com/request?itc=${itc}-t-i0-handwrit&num=12&cp=0&cs=1&bm=1`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ options: "enable_pre_space", requests: [{ writing_guide: { writing_area_width: width, writing_area_height: height }, ink }] }),
      }, 8000);
      const j = await r.json();
      const candidates = (j && j[0] === "SUCCESS" && j[1]?.[0]?.[1]) ? j[1][0][1] : [];
      res.json({ candidates });
    } catch (e) { console.warn("[handwriting]", e.message); res.status(502).json({ candidates: [], error: "인식 서버에 연결하지 못했어요." }); }
  });

  // ── 유의어(유의어사전) ────────────────────────────────────────────
  //   영어: Datamuse(무료·키 불필요) / 국어: 표준국어대사전 '비슷한말'
  async function synonymsEnglish(word) {
    // md=f 로 말뭉치 사용빈도를 받아 자주 쓰는 순으로 정렬
    const r = await fetchT(`https://api.datamuse.com/words?rel_syn=${encodeURIComponent(word)}&md=f&max=20`);
    if (!r.ok) return [];
    const data = await r.json();
    const freq = x => { const t = (x.tags || []).find(s => s.startsWith("f:")); return t ? parseFloat(t.slice(2)) : 0; };
    return (Array.isArray(data) ? data : [])
      .filter(x => x.word)
      .sort((a, b) => freq(b) - freq(a))
      .map(x => x.word)
      .slice(0, 10);
  }
  function collectSyn(node, out) {
    if (Array.isArray(node)) { for (const x of node) collectSyn(x, out); return; }
    if (node && typeof node === "object") {
      if (String(node.type || "").includes("비슷한말") && node.word) out.push(node.word);
      for (const k in node) collectSyn(node[k], out);
    }
  }
  async function synonymsKorean(word) {
    if (!STDICT_KEY) return [];
    const clean = w => stripTags(w).replace(/\^/g, "").replace(/-/g, "").trim();
    const r = await fetchT(`https://stdict.korean.go.kr/api/search.do?key=${STDICT_KEY}&q=${encodeURIComponent(word)}&req_type=json&num=5`);
    if (!r.ok) return [];
    const items = (await r.json())?.channel?.item || [];
    const it = items.find(i => clean(i.word) === word) || items[0];
    const code = it?.target_code || it?.sense?.target_code;
    if (!code) return [];
    const vr = await fetchT(`https://stdict.korean.go.kr/api/view.do?key=${STDICT_KEY}&req_type=json&method=target_code&target_code=${code}`);
    if (!vr.ok) return [];
    const out = []; collectSyn(await vr.json(), out);
    return [...new Set(out.map(clean).filter(w => w && w !== word))].slice(0, 10);
  }
  app.get("/synonyms", async (req, res) => {
    const dict = String(req.query.dict || ""), word = String(req.query.word || "").trim();
    if (!word) return res.json({ synonyms: [] });
    try {
      let synonyms = [];
      if (dict === "english") synonyms = await synonymsEnglish(word);
      else if (dict === "korean") synonyms = await synonymsKorean(word);
      res.json({ synonyms });
    } catch (e) { console.warn("[synonyms]", e.message); res.json({ synonyms: [] }); }
  });

  // ── 상태 + 검색 ───────────────────────────────────────────────────
  app.get("/health", (_req, res) => res.json({
    ok: true,
    providers: {
      english: `구글 번역 사전(영한) · 폴백 kengdic(${Object.keys(ENDIC).length})`,
      korean: STDICT_KEY ? "국립국어원 표준국어대사전" : "미설정(STDICT_KEY 필요)",
      ancient: OPENDICT_KEY ? "중세국어(우리말샘 옛말)" : "미설정(OPENDICT_KEY 필요)",
      hanja: `한자 ${Object.keys(HANJA).length}자 + 한자어 ${OPENDICT_KEY ? "우리말샘" : "내장"}`,
      handwriting: "Google Input Tools(한자/한글/영어, 키 불필요)",
    },
  }));
  app.get("/search", async (req, res) => {
    const dict = String(req.query.dict || "");
    const query = String(req.query.query || "").trim();
    if (!query) return res.json({ results: [] });
    try {
      let results = [];
      if (dict === "english") results = await searchEnglish(query);
      else if (dict === "korean") results = await searchKorean(query);
      else if (dict === "hanja") results = await searchHanja(query, String(req.query.mode || "eum"));
      else if (dict === "ancient") results = await searchAncient(query);
      else return res.status(400).json({ error: "dict 값은 korean | english | hanja | ancient 중 하나여야 합니다." });
      res.json({ results });
    } catch (e) { console.error("[search]", e.message); res.status(500).json({ error: e.message }); }
  });

  if (serveStatic && publicDir) app.use(express.static(publicDir));
  return app;
}
