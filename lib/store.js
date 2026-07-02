// 저장소 인터페이스(동기). 데이터는 하나의 객체 {users,history,seqU,seqH}에 담긴다.
//  · Netlify: 요청마다 Blobs에서 이 객체를 로드 → makeStore로 조작 → 변경 시 저장(함수 래퍼에서).
//  · 로컬   : data.json 파일에 보관(fileStore).
// 검색 기록은 사전(dict)별로 분리되고, 삭제는 '휴지통'으로 옮겨 30일 뒤 완전삭제됩니다.
import fs from "fs";
import path from "path";

const TRASH_MS = 30 * 24 * 60 * 60 * 1000;   // 휴지통 보관 30일
export const emptyData = () => ({ users: [], history: [], seqU: 1, seqH: 1 });

// getData(): 현재 데이터 객체를 돌려주는 함수. 변경 시 data._dirty=true 로 표시.
export function makeStore(getData) {
  const D = () => getData();
  const touch = () => { D()._dirty = true; };
  return {
    createUser({ username, pass, name }) {
      const d = D();
      if (d.users.find(u => u.username === username)) throw new Error("DUP");
      const u = { id: d.seqU++, username, pass, name, created_at: Date.now() };
      d.users.push(u); touch();
      return { id: u.id, username, name };
    },
    getUserByName(username) {
      const u = D().users.find(x => x.username === username);
      return u ? { id: u.id, username: u.username, pass: u.pass, name: u.name } : undefined;
    },
    addHistory(uid, dict, query) {
      const d = D();
      let h = d.history.find(x => x.user_id === uid && x.dict === dict && x.query === query);
      if (h) { h.created_at = Date.now(); h.deleted_at = null; }
      else d.history.push({ id: d.seqH++, user_id: uid, dict, query, created_at: Date.now(), deleted_at: null });
      touch();
    },
    listHistory(uid, dict, limit = 200) {
      return D().history.filter(h => h.user_id === uid && h.dict === dict && !h.deleted_at)
        .sort((a, b) => b.created_at - a.created_at).slice(0, limit)
        .map(h => ({ id: h.id, dict: h.dict, query: h.query, ts: h.created_at }));
    },
    listTrash(uid, dict) {
      return D().history.filter(h => h.user_id === uid && h.dict === dict && h.deleted_at)
        .sort((a, b) => b.deleted_at - a.deleted_at)
        .map(h => ({ id: h.id, dict: h.dict, query: h.query, ts: h.deleted_at }));
    },
    trashHistory(uid, idList) {
      const s = new Set(idList), now = Date.now();
      D().history.forEach(h => { if (h.user_id === uid && s.has(h.id) && !h.deleted_at) h.deleted_at = now; });
      touch();
    },
    restoreHistory(uid, idList) {
      const s = new Set(idList), now = Date.now();
      D().history.forEach(h => { if (h.user_id === uid && s.has(h.id)) { h.deleted_at = null; h.created_at = now; } });
      touch();
    },
    deleteHistory(uid, id) { const d = D(); d.history = d.history.filter(h => !(h.user_id === uid && h.id === id)); touch(); },
    emptyTrash(uid, dict) { const d = D(); d.history = d.history.filter(h => !(h.user_id === uid && h.dict === dict && h.deleted_at)); touch(); },
    purgeExpired(maxAge = TRASH_MS) {
      const d = D(), cut = Date.now() - maxAge, before = d.history.length;
      d.history = d.history.filter(h => !(h.deleted_at && h.deleted_at < cut));
      if (d.history.length !== before) touch();
    },
  };
}

// 로컬 개발용: data.json 파일에 보관(동기 인터페이스, 1초마다 + 종료 시 flush)
export function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "data.json");
  let data = emptyData();
  try { const v = JSON.parse(fs.readFileSync(file, "utf-8")); if (v && v.users) data = v; } catch { /* 새 파일 */ }
  const store = makeStore(() => data);
  const flush = () => {
    if (!data._dirty) return;
    delete data._dirty;
    try { const t = file + ".tmp"; fs.writeFileSync(t, JSON.stringify(data)); fs.renameSync(t, file); } catch { /* 무시 */ }
  };
  const timer = setInterval(flush, 1000); timer.unref?.();
  process.on?.("beforeExit", flush);
  return store;
}
