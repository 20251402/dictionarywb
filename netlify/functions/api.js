// Netlify Function — Express 앱을 serverless-http로 감싸고,
// 요청마다 Netlify Blobs에서 데이터(계정·검색기록)를 로드 → 처리 → 변경 시 저장한다.
import serverless from "serverless-http";
import { getStore, connectLambda } from "@netlify/blobs";
import { createApp } from "../../lib/app.js";
import { makeStore, emptyData } from "../../lib/store.js";

// 요청마다 교체되는 데이터 객체(웜 인스턴스는 요청을 직렬 처리하므로 안전)
const STATE = { data: emptyData() };
const store = makeStore(() => STATE.data);
const app = createApp({ store, env: process.env, serveStatic: false });
const sls = serverless(app);

// consistency:"strong"은 람다형 함수에서 uncachedEdgeURL이 없어 읽기 실패 → 기본(eventual) 사용.
// (저장 직전 재로드+병합 로직이 있어 소규모에선 일관성 문제 거의 없음)
const blob = () => getStore({ name: "dict-db" });
async function load() {
  try { const v = await blob().get("db", { type: "json" }); return (v && v.users) ? v : emptyData(); }
  catch { return emptyData(); }
}

// 서로 다른 인스턴스의 동시 쓰기로 기록이 통째로 덮어써지는 것을 막기 위해,
// 저장 직전 최신본을 다시 읽어 '레코드 단위'로 병합한 뒤 기록한다.
//  · 사용자   : username 기준 합집합
//  · 검색기록 : (user_id|dict|query) 기준 합집합, 더 최근에 바뀐 쪽을 채택
// (Blobs가 조건부 쓰기(CAS)를 제공하지 않아 완벽한 원자성은 아니지만, 통째 덮어쓰기 위험을 크게 줄인다.)
function mergeDB(remote, ours) {
  const users = [...(remote.users || [])];
  const uSeen = new Set(users.map(u => u.username));
  for (const u of (ours.users || [])) if (!uSeen.has(u.username)) users.push(u);
  const key = h => h.user_id + "|" + h.dict + "|" + h.query;
  const map = new Map();
  for (const h of (remote.history || [])) map.set(key(h), h);
  for (const h of (ours.history || [])) {
    const k = key(h), ex = map.get(k);
    if (!ex) { map.set(k, h); continue; }
    const tOurs = Math.max(h.created_at || 0, h.deleted_at || 0);
    const tEx = Math.max(ex.created_at || 0, ex.deleted_at || 0);
    if (tOurs >= tEx) map.set(k, h);
  }
  const history = [...map.values()];
  const seqU = Math.max(remote.seqU || 1, ours.seqU || 1, ...users.map(u => (u.id || 0) + 1));
  const seqH = Math.max(remote.seqH || 1, ours.seqH || 1, ...history.map(h => (h.id || 0) + 1));
  return { users, history, seqU, seqH };
}
async function save(data) {
  try {
    const latest = await load();                 // 저장 직전 최신본을 다시 로드
    const merged = mergeDB(latest, data);         // 다른 인스턴스 변경과 병합
    delete merged._dirty;
    await blob().setJSON("db", merged);
  } catch (e) { console.error("[blob save]", e.message); }
}

export const handler = async (event, context) => {
  // Netlify Blobs 컨텍스트 초기화. serverless-http(람다형) 함수에서는 이 호출이 없으면
  // 자동 컨텍스트가 잡히지 않아 저장/조회가 실패한다(계정·검색기록이 안 남는 원인).
  try { connectLambda(event); } catch { }
  // 원본 요청 경로 보장(리라이트로 들어와도 Express가 실제 경로를 보도록)
  if (event.rawUrl) { try { event.path = new URL(event.rawUrl).pathname; } catch { } }
  // Blobs 자가진단: GET /api/blobcheck → 저장(계정/기록) 가능 여부를 원격에서 바로 확인
  if (event.path === "/api/blobcheck") {
    let roundTrip = false, error = null;
    try { const b = blob(); await b.setJSON("__healthcheck", { t: Date.now() }); roundTrip = !!(await b.get("__healthcheck", { type: "json" })); }
    catch (e) { error = e.message; }
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ blobsContext: !!event.blobs, roundTrip, error }) };
  }
  STATE.data = await load();
  try { store.purgeExpired?.(); } catch { }       // 30일 지난 휴지통 정리
  const res = await sls(event, context);
  if (STATE.data._dirty) await save(STATE.data);
  return res;
};
