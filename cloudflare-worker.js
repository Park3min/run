/**
 * 가민 커넥트 중계 + 스트라바 토큰 교환 워커 (Cloudflare Workers)
 *
 * 브라우저에서 직접 접근할 수 없는 가민 서버(CORS 차단)로 요청을 그대로 전달만 한다.
 * - 아무것도 저장하지 않음 (stateless). 로그인 토큰은 각 사용자의 브라우저에만 저장됨.
 * - 가민 도메인으로만 전달 (오픈 프록시 방지)
 * - 허용된 출처(이 앱)에서만 호출 가능
 *
 * 요청 형식:  /p/<가민호스트>/<경로>?<쿼리>
 * 특수 헤더:  X-Cookies(쿠키 전달), X-UA(User-Agent), X-Referer, X-Authorization
 * 응답 헤더:  X-Status(실제 상태코드), X-Location(리다이렉트 대상), X-Set-Cookies(JSON 배열)
 *             — 브라우저가 리다이렉트를 임의로 따라가지 않도록 응답은 항상 200으로 감싼다.
 */

const ALLOWED_TARGETS = new Set([
  "sso.garmin.com",
  "connectapi.garmin.com",
  "connect.garmin.com",
  "thegarth.s3.amazonaws.com", // OAuth consumer key 배포 위치 (garth 프로젝트)
]);

const ALLOWED_ORIGINS = new Set([
  "https://park3min.github.io",
  "http://localhost:5077",
  "http://127.0.0.1:5077",
  "null", // file:// 로 연 로컬 앱
]);

// 정적 목록 + 모든 *.vercel.app (프로덕션·프리뷰 배포) + park3min.com 및 그 하위 도메인 허용
function isAllowedOrigin(origin) {
  return ALLOWED_ORIGINS.has(origin)
    || /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)
    || /^https:\/\/([a-z0-9-]+\.)*park3min\.com$/i.test(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": isAllowedOrigin(origin) ? origin : "https://park3min.github.io",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "X-Status,X-Location,X-Set-Cookies",
    "Vary": "Origin",
  };
}

// 한국 시간(UTC+9) 기준 오늘 날짜 YYYY-MM-DD
function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 방문자 카운터 — /count?vid=<방문자 고유 id>
 * 같은 방문자는 하루에 한 번만 집계 (총 방문자는 평생 한 번).
 * vid 는 각 브라우저에서 만든 난수이며 개인정보와 무관하다.
 */
async function handleCount(request, env, origin) {
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (!env || !env.COUNTER) {
    return new Response(JSON.stringify({ error: "counter unavailable" }), { status: 503, headers });
  }
  const url = new URL(request.url);
  const vid = (url.searchParams.get("vid") || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  const day = todayKST();
  const dayKey = `day:${day}`;

  let [totalRaw, dayRaw] = await Promise.all([
    env.COUNTER.get("total"),
    env.COUNTER.get(dayKey),
  ]);
  let total = parseInt(totalRaw || "0", 10) || 0;
  let today = parseInt(dayRaw || "0", 10) || 0;

  if (vid) {
    const seenTotalKey = `seen:${vid}`;
    const seenDayKey = `seen:${day}:${vid}`;
    const [seenTotal, seenDay] = await Promise.all([
      env.COUNTER.get(seenTotalKey),
      env.COUNTER.get(seenDayKey),
    ]);
    const writes = [];
    if (!seenTotal) {
      total += 1;
      writes.push(env.COUNTER.put("total", String(total)));
      writes.push(env.COUNTER.put(seenTotalKey, "1"));
    }
    if (!seenDay) {
      today += 1;
      writes.push(env.COUNTER.put(dayKey, String(today)));
      // 방문 기록은 이틀 뒤 자동 삭제 (저장소를 깨끗하게 유지)
      writes.push(env.COUNTER.put(seenDayKey, "1", { expirationTtl: 172800 }));
    }
    if (writes.length) await Promise.all(writes);
  }

  return new Response(JSON.stringify({ today, total, date: day }), { headers });
}

/**
 * 스트라바 공식 OAuth 토큰 교환 — 비밀 키(STRAVA_CLIENT_SECRET)를 앱에 넣지 않으려고 여기서만 쓴다.
 *  GET  /strava/config              → { clientId }  (STRAVA_CLIENT_ID 가 없으면 null)
 *  POST /strava/token   {code}      → 스트라바 토큰 응답 (access_token·refresh_token·expires_at·athlete)
 *  POST /strava/refresh {refresh_token}
 * 토큰은 저장하지 않고 그대로 돌려준다 (사용자 기기에만 저장).
 */
async function handleStrava(request, env, origin, path) {
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" };
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers });
  const id = env && env.STRAVA_CLIENT_ID, secret = env && env.STRAVA_CLIENT_SECRET;
  if (path === "/strava/config") return json({ clientId: id && secret ? String(id) : null });
  if (!id || !secret) return json({ error: "스트라바 연결 준비가 아직 안 됐어요" }, 503);
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  let body = {};
  try { body = await request.json(); } catch (e) { /* 빈 본문 */ }
  const form = new URLSearchParams({ client_id: String(id), client_secret: secret });
  if (path === "/strava/token" && body.code) {
    form.set("code", String(body.code));
    form.set("grant_type", "authorization_code");
  } else if (path === "/strava/refresh" && body.refresh_token) {
    form.set("refresh_token", String(body.refresh_token));
    form.set("grant_type", "refresh_token");
  } else {
    return json({ error: "잘못된 요청이에요" }, 400);
  }
  const r = await fetch("https://www.strava.com/oauth/token", { method: "POST", body: form });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: "스트라바 인증에 실패했어요", detail: out.message || null }, r.status);
  // 필요한 것만 돌려준다
  const a = out.athlete || {};
  return json({
    access_token: out.access_token, refresh_token: out.refresh_token, expires_at: out.expires_at,
    athlete: a.id ? { id: a.id, firstname: a.firstname || "", lastname: a.lastname || "" } : undefined,
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    if (url.pathname === "/count") {
      return handleCount(request, env, origin);
    }
    if (url.pathname.startsWith("/strava/")) {
      return handleStrava(request, env, origin, url.pathname);
    }

    const m = url.pathname.match(/^\/p\/([^/]+)(\/.*)$/);
    if (!m) {
      return new Response(JSON.stringify({ error: "usage: /p/<host>/<path>" }), {
        status: 404,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }
    const host = m[1];
    if (!ALLOWED_TARGETS.has(host)) {
      return new Response(JSON.stringify({ error: "host not allowed" }), {
        status: 403,
        headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
      });
    }

    const target = "https://" + host + m[2] + url.search;
    const h = new Headers();
    h.set("Accept", request.headers.get("Accept") || "*/*");
    h.set("Accept-Language", "en-US,en;q=0.9,ko;q=0.8");
    const ct = request.headers.get("Content-Type");
    if (ct) h.set("Content-Type", ct);
    const xAuth = request.headers.get("X-Authorization");
    if (xAuth) h.set("Authorization", xAuth);
    const xCookies = request.headers.get("X-Cookies");
    if (xCookies) h.set("Cookie", xCookies);
    const xRef = request.headers.get("X-Referer");
    if (xRef) h.set("Referer", xRef);
    const xUa = request.headers.get("X-UA");
    if (xUa) h.set("User-Agent", xUa);

    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await request.arrayBuffer();

    const resp = await fetch(target, {
      method: request.method,
      headers: h,
      body,
      redirect: "manual",
    });

    const out = new Headers(corsHeaders(origin));
    out.set("Content-Type", resp.headers.get("Content-Type") || "text/plain");
    out.set("X-Status", String(resp.status));
    const loc = resp.headers.get("Location");
    if (loc) out.set("X-Location", loc);
    const setCookies =
      typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
    if (setCookies.length) out.set("X-Set-Cookies", JSON.stringify(setCookies));

    return new Response(resp.body, { status: 200, headers: out });
  },
};
