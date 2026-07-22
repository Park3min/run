/**
 * 가민 커넥트 중계 워커 (Cloudflare Workers)
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

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://park3min.github.io",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "X-Status,X-Location,X-Set-Cookies",
    "Vary": "Origin",
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
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
