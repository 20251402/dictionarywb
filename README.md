# 국어 · 영어 · 한자 · 중세국어 사전 (GitHub → Netlify 전체 배포)

모바일 우선 한국어 사전 웹앱. **프런트(정적) + 백엔드(Netlify Functions) + 저장소(Netlify Blobs)** 를 한 도메인에서 배포합니다. 로그인·검색기록·휴지통·퀴즈·손글씨까지 전부 동작합니다.

## 구성
- `public/index.html` — 프런트엔드(앱 본체). Netlify가 정적으로 서빙.
- `netlify/functions/api.js` — Express 앱을 serverless-http로 감싼 단일 함수. 저장은 Netlify Blobs.
- `lib/app.js` — 사전/검색/기록/퀴즈/손글씨/인증 라우트. `lib/store.js`(저장소), `lib/auth.js`(계정), `lib/data/`(사전 데이터).
- `local-server.js` — 로컬 개발 서버(`npm start`, 파일 저장소).
- `netlify.toml` — 정적 배포 + 함수 + API 리라이트.

## GitHub → Netlify 배포
1. 이 폴더를 **GitHub 저장소 루트**에 올립니다.
   ```bash
   git init && git add . && git commit -m "deploy"
   git branch -M main
   git remote add origin https://github.com/<사용자>/<저장소>.git
   git push -u origin main
   ```
2. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project** → 저장소 선택.
   - 빌드 설정은 `netlify.toml`이 자동 적용(Publish `public`, 빌드 명령 없음).
3. **Environment variables**(Site configuration → Environment variables)에 아래를 추가:
   | 키 | 값 |
   |---|---|
   | `SESSION_SECRET` | 임의의 긴 무작위 문자열 (예: `openssl rand -hex 32` 결과) — **로그인에 필수** |
   | `STDICT_KEY` | 표준국어대사전 키 (국어) |
   | `OPENDICT_KEY` | 우리말샘 키 (한자어·중세국어) |
   | `BASE_URL` | (선택) `https://<사이트>.netlify.app` |
4. **Deploy**. `https://<사이트>.netlify.app` 가 생성됩니다. 같은 도메인에서 사전·로그인·기록이 모두 동작합니다(CORS 없음).

> Blobs는 Netlify 런타임에서 별도 설정 없이 자동 활성화됩니다. 무료 한도 내에서 계정·검색기록이 영구 저장됩니다.

## 로컬 개발
```bash
cp .env.example .env      # STDICT_KEY/OPENDICT_KEY 채우기(선택). SESSION_SECRET은 비워도 자동 생성.
npm install
npm start                 # http://localhost:3000  (저장소 = userdata/data.json)
```
`netlify dev`(Netlify CLI)로 실행하면 함수·Blobs까지 로컬에서 그대로 재현할 수 있습니다.

## 데이터 출처
- 영한: 구글 번역의 단어 사전(비공식·키 불필요) → kengdic(내장, 폴백)
- 국어: 표준국어대사전(STDICT_KEY) · 한자어/중세국어: 우리말샘(OPENDICT_KEY)
- 손글씨: Google Input Tools(키 불필요)

## 주의
- 저장소는 전체 데이터를 단일 Blob에 보관하는 단순 구조라 개인·소규모 트래픽에 적합합니다. 사용자가 많아지면 외부 DB(Postgres 등)로 교체를 권장합니다(인터페이스 동일).
- `SESSION_SECRET`을 바꾸면 기존 로그인 세션이 모두 만료됩니다. 한 번 정해 고정하세요.
