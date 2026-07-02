// 웹 자체 계정(아이디/비밀번호) 로그인 + 서명 쿠키 세션. 외부 npm 패키지 없음(crypto만 사용).
//  · 비밀번호는 scrypt 해시(+무작위 salt)로 저장하며 평문은 보관하지 않습니다.
//  · 세션은 HMAC 서명된 HttpOnly 쿠키(dict_sid)로 관리합니다. SESSION_SECRET 필요.
import crypto from "crypto";

const b64u = s => Buffer.from(s).toString("base64url");
const unb64u = s => Buffer.from(s, "base64url").toString();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 64);
  return "scrypt$" + salt.toString("base64url") + "$" + dk.toString("base64url");
}
function verifyPassword(pw, stored) {
  try {
    const [algo, saltB, hashB] = String(stored).split("$");
    if (algo !== "scrypt") return false;
    const salt = Buffer.from(saltB, "base64url");
    const expected = Buffer.from(hashB, "base64url");
    const dk = crypto.scryptSync(pw, salt, expected.length);
    return crypto.timingSafeEqual(dk, expected);
  } catch { return false; }
}

export function createAuth(store, env) {
  const base = (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, "");
  const front = (env.FRONTEND_URL || base).replace(/\/$/, "");
  const secret = env.SESSION_SECRET || "";
  const secure = base.startsWith("https");
  let crossSite = false;
  try { crossSite = new URL(front).origin !== new URL(base).origin; } catch { }
  const sameSite = crossSite ? "None" : "Lax";

  function sign(payload) {
    const body = b64u(JSON.stringify(payload));
    const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    return body + "." + mac;
  }
  function verify(token) {
    if (!token || !secret) return null;
    const [body, mac] = token.split(".");
    if (!body || !mac) return null;
    const exp = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    try { if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null; } catch { return null; }
    try { const p = JSON.parse(unb64u(body)); if (p.exp && Date.now() > p.exp) return null; return p; } catch { return null; }
  }
  function getCookie(req, name) {
    const m = (req.headers.cookie || "").match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(res, name, val, maxAgeSec) {
    const parts = [`${name}=${encodeURIComponent(val)}`, "Path=/", "HttpOnly", `SameSite=${sameSite}`];
    if (secure) parts.push("Secure");
    if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`);
    res.append("Set-Cookie", parts.join("; "));
  }
  const currentUser = req => verify(getCookie(req, "dict_sid"));
  function startSession(res, user) {
    setCookie(res, "dict_sid", sign({ uid: user.id, name: user.name || user.username, exp: Date.now() + 30 * 864e5 }), 30 * 86400);
  }

  const clean = s => String(s || "").trim();
  const validUser = u => /^[A-Za-z0-9가-힣._-]{2,20}$/.test(u);

  function mount(app) {
    app.get("/api/me", (req, res) => res.json({ user: currentUser(req), authReady: !!secret }));

    app.post("/auth/register", (req, res) => {
      if (!secret) return res.status(500).json({ error: "server", message: "서버에 SESSION_SECRET이 설정되지 않았습니다." });
      const username = clean(req.body?.username), password = String(req.body?.password || "");
      if (!validUser(username)) return res.status(400).json({ error: "username", message: "아이디는 2~20자(한글·영문·숫자·._-)로 입력하세요." });
      if (password.length < 6) return res.status(400).json({ error: "password", message: "비밀번호는 6자 이상으로 입력하세요." });
      let user;
      try { user = store.createUser({ username, pass: hashPassword(password), name: username }); }
      catch { return res.status(409).json({ error: "dup", message: "이미 사용 중인 아이디예요." }); }
      startSession(res, user);
      res.json({ user: { uid: user.id, name: user.name || user.username } });
    });

    app.post("/auth/login", (req, res) => {
      if (!secret) return res.status(500).json({ error: "server", message: "서버에 SESSION_SECRET이 설정되지 않았습니다." });
      const username = clean(req.body?.username), password = String(req.body?.password || "");
      const u = store.getUserByName(username);
      if (!u || !verifyPassword(password, u.pass)) return res.status(401).json({ error: "bad", message: "아이디 또는 비밀번호가 올바르지 않아요." });
      startSession(res, { id: u.id, name: u.name || u.username });
      res.json({ user: { uid: u.id, name: u.name || u.username } });
    });

    app.post("/auth/logout", (req, res) => { setCookie(res, "dict_sid", "", 0); res.json({ ok: true }); });
  }
  return { mount, currentUser, ready: !!secret };
}
