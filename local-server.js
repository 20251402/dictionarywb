// 로컬 개발용 서버 — `npm start` 로 실행. 저장소는 userdata/data.json 파일.
// (Netlify 배포에서는 netlify/functions/api.js + Blobs 가 대신 동작합니다.)
// .env 로드 — dotenv 미설치(예: npm install --production) 환경에서도 죽지 않도록 안전하게 시도
try { await import("dotenv/config"); } catch { /* dotenv 없음 → 실제 환경변수만 사용 */ }
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createApp } from "./lib/app.js";
import { fileStore } from "./lib/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERDATA = path.join(__dirname, "userdata");
const store = fileStore(USERDATA);

// 세션 서명 키: 없으면 자동 생성·보관(로컬 편의)
if (!process.env.SESSION_SECRET) {
  const f = path.join(USERDATA, "session_secret");
  try { process.env.SESSION_SECRET = fs.readFileSync(f, "utf-8").trim(); } catch { }
  if (!process.env.SESSION_SECRET) {
    const s = crypto.randomBytes(32).toString("hex");
    fs.mkdirSync(USERDATA, { recursive: true });
    fs.writeFileSync(f, s, { mode: 0o600 });
    process.env.SESSION_SECRET = s;
  }
}

const PORT = process.env.PORT || 3000;
const app = createApp({ store, env: process.env, serveStatic: true, publicDir: path.join(__dirname, "public") });
store.purgeExpired?.();
setInterval(() => { try { store.purgeExpired?.(); } catch { } }, 6 * 60 * 60 * 1000).unref?.();
app.listen(PORT, () => console.log(`\n  사전 앱(로컬) → http://localhost:${PORT}\n  상태 확인     → http://localhost:${PORT}/health\n`));
