/**
 * 러닝로그 — 지도 여정(GPS 경로) 모듈
 *
 * - GPX·TCX 파싱, 경로 분석(거리·이동시간·1km 구간·평균 심박/케이던스)
 * - 캔버스 지도 렌더러: OpenStreetMap 타일(웹 메르카토르) 위에 진행률만큼 경로를 그린다.
 *   타일이 CORS 를 허용해 캔버스가 오염되지 않으므로 PNG·영상으로 그대로 저장할 수 있다.
 * - 3D 보기: 달리는 방향을 따라가는 기울어진 카메라 (WebGL 로 지면을 그리고 2D 캔버스에 합성)
 * - 거리별 심박·케이던스 곡선 — 애니메이션에서 그 지점의 값을 보여 주고 끝에 평균으로
 * - 영상 녹화: canvas.captureStream + MediaRecorder (MP4 우선, 안 되면 WebM)
 *
 * 외부 의존성 없음. window.RouteMap 으로 노출.
 */
(() => {
  'use strict';

  // ---------- 파싱 ----------
  const byTag = (el, name) => (el ? el.getElementsByTagNameNS('*', name) : []);
  const textOf = (el, name) => { const n = byTag(el, name)[0]; return n ? n.textContent.trim() : null; };
  const num = v => (v == null || v === '' || !isFinite(+v) ? null : +v);

  // GPX(trkpt/rtept) 또는 TCX(Trackpoint) → { name, pts:[{lat, lon, t, hr, cad, dm}] }
  function parseTrackFile(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('파일을 읽지 못했어요. GPX·TCX 파일이 맞는지 확인해 주세요');
    }
    const pts = [];
    let name = null;
    let gpx = byTag(doc, 'trkpt');
    if (!gpx.length) gpx = byTag(doc, 'rtept');
    if (gpx.length) {
      name = textOf(byTag(doc, 'trk')[0], 'name') || textOf(byTag(doc, 'metadata')[0], 'name');
      for (const p of gpx) {
        const lat = num(p.getAttribute('lat')), lon = num(p.getAttribute('lon'));
        if (lat == null || lon == null) continue;
        const time = textOf(p, 'time');
        pts.push({ lat, lon, t: time ? Date.parse(time) : null, hr: num(textOf(p, 'hr')), cad: num(textOf(p, 'cad')), ele: num(textOf(p, 'ele')) });
      }
    } else {
      const tps = byTag(doc, 'Trackpoint');
      if (!tps.length) throw new Error('경로(GPS) 기록이 없는 파일이에요');
      name = textOf(doc, 'Notes');
      for (const p of tps) {
        const lat = num(textOf(p, 'LatitudeDegrees')), lon = num(textOf(p, 'LongitudeDegrees'));
        if (lat == null || lon == null) continue;          // TCX 는 위치 없는 점도 섞여 있다
        const time = textOf(p, 'Time');
        const hrEl = byTag(p, 'HeartRateBpm')[0];
        const runCad = num(textOf(p, 'RunCadence'));
        pts.push({
          lat, lon, t: time ? Date.parse(time) : null,
          hr: hrEl ? num(textOf(hrEl, 'Value')) : null,
          cad: runCad != null ? runCad : num(textOf(p, 'Cadence')),
          dm: num(textOf(p, 'DistanceMeters')),
          ele: num(textOf(p, 'AltitudeMeters')),
        });
      }
    }
    if (pts.length < 2) throw new Error('경로 점이 너무 적어요');
    return { name, pts };
  }

  // ---------- 분석 ----------
  const R = 6371008.8, rad = Math.PI / 180;
  function hav(a, b) {
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  /**
   * 원시 점 → { pts:[{lat, lon, d(누적 m), mt(누적 이동 초)}], totalM, movingS, hasTime, startT, avgHr, avgCad }
   * - GPS 튐(43km/h 초과 순간이동)은 버린다
   * - 20초 넘게 거의 안 움직인 구간(자동 일시정지 등)은 이동시간에서 뺀다
   */
  function analyze(raw) {
    const hasTime = raw.filter(p => p.t != null && isFinite(p.t)).length >= raw.length * 0.8;
    const useDm = raw.filter(p => p.dm != null).length >= raw.length * 0.8;   // TCX 기기 측정 거리 우선
    const pts = [], samples = [];
    let d = 0, mt = 0, last = null;
    for (const p of raw) {
      if (last) {
        const seg = useDm && p.dm != null && last.dm != null ? Math.max(0, p.dm - last.dm) : hav(last, p);
        const dt = hasTime && p.t != null && last.t != null ? (p.t - last.t) / 1000 : null;
        if (dt != null && dt < 0) continue;                          // 시간이 거꾸로 가는 점
        if (dt != null && dt > 0 && seg > 30 && seg / dt > 12) continue;  // GPS 튐
        d += seg;
        if (dt != null && !(dt > 20 && seg / dt < 0.5)) mt += dt;
      }
      pts.push({ lat: p.lat, lon: p.lon, d, mt });
      if (p.hr > 0 || p.cad > 0 || p.ele != null) samples.push({ d, hr: p.hr, cad: p.cad, ele: p.ele });
      last = p;
    }
    const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const hr = avg(raw.map(p => p.hr).filter(v => v > 0));
    let cad = avg(raw.map(p => p.cad).filter(v => v > 0));
    const cadMul = cad && cad < 120 ? 2 : 1;   // GPX·TCX 는 보통 한쪽 발 기준(rpm) → 분당 걸음 수
    if (cad) cad *= cadMul;
    const first = raw.find(p => p.t != null);
    const route = {
      pts, totalM: d, hasTime,
      movingS: hasTime ? Math.round(mt) : null,
      startT: hasTime && first ? first.t : null,
      avgHr: hr ? Math.round(hr) : null,
      avgCad: cad ? Math.round(cad) : null,
      elevGain: null,
    };
    const eles = samples.filter(s => s.ele != null);
    if (eles.length > raw.length * 0.5) route.elevGain = Math.round(gainCurve(eles).total);
    if (samples.length > 10) attachSeries(route, samples, cadMul);
    return route;
  }

  // ---------- 거리별 심박·케이던스 ----------
  // samples [{d, hr, cad}] (d 는 누적 거리, 단위·척도 무관) → 거리 비율 0~1 을 SERIES_N 칸으로 나눈
  // 부드러운 곡선 route.series = {hr:[…], cad:[…]}. 애니메이션에서 '지금 이 지점의 심박'을 보여준다.
  const SERIES_N = 200;

  // 누적 상승 고도 — 고도를 5점 이동평균으로 다듬고, 3m 넘게 오를 때만 센다 (GPS 고도 잡음 제거).
  // 반환 {total, at:[{d, g}]} (g: 그 지점까지의 누적 상승 m)
  function gainCurve(samples) {
    const s = samples.filter(p => p.ele != null && isFinite(p.ele)).sort((a, b) => a.d - b.d);
    const sm = s.map((p, i) => {
      let a = 0, c = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(s.length - 1, i + 2); j++) { a += s[j].ele; c++; }
      return a / c;
    });
    let total = 0, ref = sm[0];
    const at = [];
    for (let i = 0; i < s.length; i++) {
      if (sm[i] - ref >= 3) { total += sm[i] - ref; ref = sm[i]; }
      else if (sm[i] < ref) ref = sm[i];
      at.push({ d: s[i].d, g: total });
    }
    return { total, at };
  }

  function attachSeries(route, samples, cadMul = 1) {
    const dMax = samples.reduce((m, s) => Math.max(m, s.d || 0), 0);
    if (!(dMax > 0)) return route;
    const build = (key, mul) => {
      const sum = new Float64Array(SERIES_N + 1), cnt = new Float64Array(SERIES_N + 1);
      let n = 0;
      for (const s of samples) {
        const v = s[key];
        if (!(v > 0)) continue;
        const i = Math.round(Math.min(1, Math.max(0, s.d / dMax)) * SERIES_N);
        sum[i] += v * mul; cnt[i]++; n++;
      }
      if (n < 10) return null;
      // 빈 칸은 앞뒤 값으로 메우고, 약 150m 폭으로 이동 평균 (순간 튐 제거)
      const raw = Array.from(sum, (v, i) => (cnt[i] ? v / cnt[i] : null));
      let lastV = raw.find(v => v != null);
      for (let i = 0; i <= SERIES_N; i++) { if (raw[i] == null) raw[i] = lastV; else lastV = raw[i]; }
      const w = Math.max(1, Math.round(SERIES_N * 150 / Math.max(route.totalM || dMax, 1)));
      return raw.map((_, i) => {
        let a = 0, c = 0;
        for (let j = Math.max(0, i - w); j <= Math.min(SERIES_N, i + w); j++) { a += raw[j]; c++; }
        return Math.round(a / c);
      });
    };
    route.series = { hr: build('hr', 1), cad: build('cad', cadMul), gain: null };
    // 누적 상승의 모양(0~1000 비율) — 실제 총량은 기록(가민 요약 등)에 맞춰 곱해 쓴다
    const gc = gainCurve(samples);
    if (gc.at.length > 10 && gc.total > 0) {
      const g = new Array(SERIES_N + 1).fill(0);
      let j = 0;
      for (let i = 0; i <= SERIES_N; i++) {
        const dd = dMax * i / SERIES_N;
        while (j < gc.at.length - 1 && gc.at[j + 1].d <= dd) j++;
        g[i] = Math.round(gc.at[j].g / gc.total * 1000);
      }
      g[SERIES_N] = 1000;
      route.series.gain = g;
    }
    return route;
  }

  // 진행률 e 까지의 누적 상승 (m) — 곡선이 없으면 거리 비례
  function gainAt(arr, total, e) {
    if (!total) return 0;
    if (!arr || !arr.length) return total * e;
    const x = Math.max(0, Math.min(1, e)) * (arr.length - 1), i = Math.floor(x), f = x - i;
    const v = arr[i] + ((arr[Math.min(arr.length - 1, i + 1)] - arr[i]) * f);
    return total * v / 1000;
  }

  // 진행률 e(0~1)의 심박·케이던스 — 달리는 동안은 그 지점의 값, 마지막 3% 에서 평균으로 모인다.
  // 반환 {v, avg:bool}. 곡선이 없으면 처음부터 평균 (0 에서 세어 올라가는 오해를 막는다)
  function liveMetric(arr, avg, e) {
    if (!avg) return null;
    if (!arr || !arr.length || e >= 1) return { v: avg, avg: true };
    const x = Math.max(0, e) * (arr.length - 1), i = Math.floor(x), f = x - i;
    const cur = arr[i] + ((arr[Math.min(arr.length - 1, i + 1)] - arr[i]) * f);
    const k = Math.min(1, Math.max(0, (e - 0.97) / 0.03)), s = k * k * (3 - 2 * k);
    return { v: Math.round(cur + (avg - cur) * s), avg: e >= 0.97 };
  }

  // 누적 거리 dm 지점의 누적 이동시간 (선형 보간)
  function mtAt(route, dm) {
    const pts = route.pts;
    if (dm <= 0) return 0;
    if (dm >= route.totalM) return pts[pts.length - 1].mt;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].d <= dm) lo = mid; else hi = mid; }
    const a = pts[lo], b = pts[hi], f = b.d > a.d ? (dm - a.d) / (b.d - a.d) : 0;
    return a.mt + (b.mt - a.mt) * f;
  }

  // 1km 구간 페이스 [{lap, distanceKm, paceSec}] — 마지막 50m 미만 자투리는 버린다
  function splits(route) {
    if (!route.hasTime || !route.movingS) return [];
    const out = [];
    for (let k = 1, prev = 0; prev < route.totalM - 50; k++) {
      const end = Math.min(k * 1000, route.totalM);
      const secs = mtAt(route, end) - mtAt(route, prev);
      const km = (end - prev) / 1000;
      if (secs > 0) out.push({ lap: k, distanceKm: Math.round(km * 100) / 100, paceSec: Math.round(secs / km) });
      prev = end;
    }
    return out;
  }

  // 저장용으로 가볍게 — 거리 기준 균등 샘플(최대 maxN 점)
  function compact(route, maxN = 1500) {
    let pts = route.pts;
    if (pts.length > maxN) {
      const step = route.totalM / (maxN - 1);
      const out = [pts[0]];
      let next = step;
      for (let i = 1; i < pts.length - 1; i++) if (pts[i].d >= next) { out.push(pts[i]); next += step; }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return Object.assign({}, route, {
      pts: pts.map(p => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), d: Math.round(p.d * 10) / 10, mt: Math.round(p.mt * 10) / 10 })),
    });
  }

  // ---------- 지도 타일 ----------
  // OpenStreetMap 표준 타일(키 불필요, CORS 허용). 다크·라이트는 타일을 받은 뒤 한 번만 색을 변환해
  // 캐시한다 — 키가 필요한 CARTO 등 없이도 앱 분위기에 맞는 지도를 만든다.
  const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const STYLES = {
    dark:  { url: OSM_URL, bg: '#171717', light: false, fx: 'dark' },
    light: { url: OSM_URL, bg: '#f1f1ef', light: true, fx: 'light' },
    color: { url: OSM_URL, bg: '#f2efe9', light: true, fx: null },
    none:  { url: null, bg: '#0d0d0d', light: false, fx: null },
  };
  const ATTRIBUTION = '© OpenStreetMap contributors';
  const tileCache = new Map();          // 삽입 순서 = 오래된 순 → 넘치면 앞에서부터 버린다
  const TILE_CACHE_MAX = 420;          // 3D 는 카메라가 지나가는 길의 타일을 미리 받아 둔다

  // 색 변환 (CSS filter 와 같은 행렬): 다크 = invert → hue-rotate(180°) → 채도·밝기 낮춤.
  // 반전 후 색상을 180° 돌리면 물은 푸른 톤, 공원은 초록 톤으로 돌아오고 글씨는 밝아진다.
  function processTile(img, fx) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
    const sat = fx === 'dark' ? 0.45 : 0.12, bri = fx === 'dark' ? 0.78 : 1.04;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], gg = d[i + 1], b = d[i + 2];
      if (fx === 'dark') {
        r = 255 - r; gg = 255 - gg; b = 255 - b;
        const r2 = -0.574 * r + 1.430 * gg + 0.144 * b;   // hue-rotate(180deg)
        const g2 = 0.426 * r + 0.430 * gg + 0.144 * b;
        const b2 = 0.426 * r + 1.430 * gg - 0.856 * b;
        r = r2; gg = g2; b = b2;
      }
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;    // 채도 조절 (회색 쪽으로)
      r = (l + (r - l) * sat) * bri; gg = (l + (gg - l) * sat) * bri; b = (l + (b - l) * sat) * bri;
      d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      d[i + 1] = gg < 0 ? 0 : gg > 255 ? 255 : gg;
      d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
    g.putImageData(id, 0, 0);
    return c;
  }

  function getTile(style, z, x, y) {
    const n = 2 ** z, xx = ((x % n) + n) % n;
    const key = `${style}/${z}/${xx}/${y}`;
    let t = tileCache.get(key);
    if (t) { tileCache.delete(key); tileCache.set(key, t); return t; }   // 최근 사용으로 갱신
    const img = new Image();
    img.crossOrigin = 'anonymous';
    t = { img, src: null, ok: false, failed: false };
    t.promise = new Promise(res => {
      img.onload = () => {
        try { t.src = STYLES[style].fx ? processTile(img, STYLES[style].fx) : img; }
        catch (e) { t.src = img; }                           // 변환 실패해도 원본으로 표시
        t.ok = true; res();
      };
      img.onerror = () => { t.failed = true; res(); };
    });
    img.src = STYLES[style].url.replace('{z}', z).replace('{x}', xx).replace('{y}', y);
    tileCache.set(key, t);
    while (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
    return t;
  }

  const mercX = lon => (lon + 180) / 360;
  const mercY = lat => {
    const s = Math.sin(Math.max(-85.0511, Math.min(85.0511, lat)) * rad);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };

  // ---------- 색 ----------
  const ACCENT = '#c8f542';
  const kmFont = u => `800 ${u * 2.1}px "Pretendard Variable", Pretendard, "Apple SD Gothic Neo", sans-serif`;
  // 빠름(연두) → 느림(빨강)
  const RAMP = [[200, 245, 66], [255, 214, 10], [255, 159, 10], [255, 69, 58]];
  const BUCKETS = 12;
  const PALETTE = Array.from({ length: BUCKETS }, (_, i) => {
    const f = (i / (BUCKETS - 1)) * (RAMP.length - 1), k = Math.min(RAMP.length - 2, Math.floor(f)), r = f - k;
    const c = RAMP[k].map((v, j) => Math.round(v + (RAMP[k + 1][j] - v) * r));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  });

  const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  // ---------- 3D 지면 (WebGL) ----------
  // 기울어진 카메라로 본 지도 바닥을 WebGL 로 그린 뒤 2D 캔버스에 옮겨 담는다(영상 녹화·PNG 저장이
  // 그대로 동작). 모든 렌더러가 GL 캔버스 하나와 텍스처 캐시를 함께 쓴다 — 브라우저의 WebGL
  // 컨텍스트 수 제한(보통 16개)에 걸리지 않게. 다크·라이트 색 변환은 셰이더에서 한다.
  const VS = `attribute vec3 aPos; attribute vec2 aUV; attribute float aShade;
uniform mat4 uM; varying vec2 vUV; varying float vDepth; varying vec2 vW; varying float vShade;
void main(){ vec4 c = uM * vec4(aPos, 1.0); gl_Position = c; vUV = aUV; vDepth = c.w; vW = aPos.xy; vShade = aShade; }`;
  const FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex; uniform int uFx; uniform float uGrid; uniform vec3 uBg; uniform vec2 uFog;
varying vec2 vUV; varying float vDepth; varying vec2 vW; varying float vShade;
void main(){
  vec3 c;
  if (uGrid > 0.5) {
    vec2 g = abs(fract(vW / 100.0 - 0.5) - 0.5) * 100.0;
    float lw = max(0.6, vDepth * 0.0016);
    float a = 1.0 - smoothstep(lw * 0.5, lw, min(g.x, g.y));
    c = mix(uBg, vec3(1.0), a * 0.10);
  } else {
    c = texture2D(uTex, vUV).rgb;
    if (uFx == 1) {
      c = 1.0 - c;
      c = mat3(-0.574, 0.426, 0.426, 1.430, 0.430, 1.430, 0.144, 0.144, -0.856) * c;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = (l + (c - l) * 0.45) * 0.78;
    } else if (uFx == 2) {
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = (l + (c - l) * 0.12) * 1.04;
    }
    c = clamp(c, 0.0, 1.0);
  }
  // 지형 음영 (북서쪽 빛) — 곱하기만 하면 다크 지도에선 안 보여서 밝은 면에 빛을 조금 더한다
  c = clamp(c * vShade + (vShade - 1.0) * 0.14, 0.0, 1.0);
  gl_FragColor = vec4(mix(c, uBg, smoothstep(uFog.x, uFog.y, vDepth)), 1.0);
}`;

  const GL3D = {
    _state: 0,                    // 0 미확인, 1 사용 가능, -1 불가
    tex: new Map(),               // key → {tex} (삽입 순서 = LRU)
    TEX_MAX: 320,
    ok() {
      if (this._state === 0) {
        try { this._init(); this._state = 1; } catch (e) { this._state = -1; }
      }
      return this._state === 1;
    },
    _init() {
      const cv = document.createElement('canvas');
      const gl = cv.getContext('webgl', { preserveDrawingBuffer: true, antialias: true, alpha: false })
        || cv.getContext('experimental-webgl', { preserveDrawingBuffer: true, alpha: false });
      if (!gl) throw new Error('no webgl');
      const sh = (type, src) => {
        const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o);
        if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o));
        return o;
      };
      const pr = gl.createProgram();
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      this.cv = cv; this.gl = gl; this.pr = pr;
      this.loc = {};
      for (const n of ['uM', 'uTex', 'uFx', 'uGrid', 'uBg', 'uFog']) this.loc[n] = gl.getUniformLocation(pr, n);
      this.aPos = gl.getAttribLocation(pr, 'aPos'); this.aUV = gl.getAttribLocation(pr, 'aUV');
      this.aShade = gl.getAttribLocation(pr, 'aShade');
      this.buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      [this.aPos, this.aUV, this.aShade].forEach(a => gl.enableVertexAttribArray(a));
      gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(this.aUV, 2, gl.FLOAT, false, 24, 12);
      gl.vertexAttribPointer(this.aShade, 1, gl.FLOAT, false, 24, 20);
      // 타일 한 장 = N×N 칸 격자 (지형 높이를 싣는다). N 별 삼각형 목록을 미리 만든다
      this.ibuf = {};
      for (const N of [8, 16]) {
        const idx = new Uint16Array(N * N * 6);
        let k = 0;
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
          idx.set([a, c, b, b, c, d], k); k += 6;
        }
        const ib = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        this.ibuf[N] = { ib, count: idx.length };
      }
      this.aniso = gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
      gl.uniform1i(this.loc.uTex, 0);
    },
    // 원본 OSM 타일 → 텍스처 (없으면 요청만 하고 null + 대기 목록에 추가)
    texFor(z, x, y, pending) {
      const n = 2 ** z, xx = ((x % n) + n) % n, key = `${z}/${xx}/${y}`;
      let e = this.tex.get(key);
      if (e) { this.tex.delete(key); this.tex.set(key, e); return e.tex; }
      const t = getTile('color', z, xx, y);
      if (!t.ok) { if (!t.failed && pending) pending.push(t); return null; }
      const gl = this.gl, tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, t.src);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(8, gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      this.tex.set(key, { tex });
      while (this.tex.size > this.TEX_MAX) {
        const k0 = this.tex.keys().next().value;
        gl.deleteTexture(this.tex.get(k0).tex); this.tex.delete(k0);
      }
      return tex;
    },
    /**
     * 지면 그리기. cam: 카메라(행렬·타일 목록 포함), style: STYLES 키.
     * 준비 안 된 타일은 조상 타일의 일부를 늘려 대신 보여 주고, pending 에 모은다.
     */
    render(W, H, cam, style, pending) {
      const gl = this.gl, st = STYLES[style] || STYLES.dark;
      if (this.cv.width !== W || this.cv.height !== H) { this.cv.width = W; this.cv.height = H; }
      gl.viewport(0, 0, W, H);
      const bg = hexRgb(st.bg);
      gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.pr);
      gl.uniformMatrix4fv(this.loc.uM, false, cam.mat);
      gl.uniform3f(this.loc.uBg, bg[0], bg[1], bg[2]);
      gl.uniform2f(this.loc.uFog, cam.fog[0], cam.fog[1]);
      gl.uniform1i(this.loc.uFx, st.fx === 'dark' ? 1 : st.fx === 'light' ? 2 : 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1f(this.loc.uGrid, st.url ? 0 : 1);   // 지도 없음 — 은은한 100m 격자 바닥
      for (const t of cam.tiles) {
        let tex = null, u0 = 0, v0 = 0, us = 1;
        if (st.url) {
          tex = this.texFor(t.z, t.x, t.y, pending);
          for (let k = 1; !tex && k <= 6 && t.z - k >= 0; k++) {       // 조상 타일로 임시 표시
            const m = 2 ** k;
            tex = this.texFor(t.z - k, Math.floor(t.x / m), Math.floor(t.y / m), null);
            if (tex) { us = 1 / m; u0 = (((t.x % m) + m) % m) / m; v0 = (t.y % m) / m; }
          }
          if (!tex) continue;
          gl.bindTexture(gl.TEXTURE_2D, tex);
        }
        const N = t.z >= 16 ? 8 : 16;
        gl.bufferData(gl.ARRAY_BUFFER, tileMesh(t, N, cam.terrain, u0, v0, us), gl.STREAM_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf[N].ib);
        gl.drawElements(gl.TRIANGLES, this.ibuf[N].count, gl.UNSIGNED_SHORT, 0);
      }
      return this.cv;
    },
  };
  const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

  // ---------- 지형 (고도) ----------
  // AWS 공개 지형 타일(Terrarium, 키 불필요·CORS 허용). 픽셀 색 → 해발 m: R·256 + G + B/256 − 32768.
  // z12 한 칸 ≈ 30m (한국 위도) — SRTM 원자료 해상도와 비슷해 이보다 자세히 받을 필요가 없다.
  const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const DEM_Z = 12;
  const TERRAIN_EXAG = 1.6;             // 높낮이를 조금 과장해야 도시의 완만한 언덕도 느껴진다
  const DEM = {
    tiles: new Map(),
    version: 0,                         // 새 타일이 들어올 때마다 증가 → 메시·경로 높이 다시 계산
    tile(tx, ty) {
      const n = 2 ** DEM_Z, xx = ((tx % n) + n) % n, key = `${xx}/${ty}`;
      let t = this.tiles.get(key);
      if (t) return t;
      t = { ok: false, failed: false, h: null };
      const img = new Image();
      img.crossOrigin = 'anonymous';
      t.promise = new Promise(res => {
        img.onload = () => {
          try {
            const c = document.createElement('canvas'); c.width = 256; c.height = 256;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
            for (let i = 0; i < 65536; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
            t.h = h; t.ok = true; this.version++;
          } catch (e) { t.failed = true; }
          res();
        };
        img.onerror = () => { t.failed = true; res(); };
      });
      img.src = DEM_URL.replace('{z}', DEM_Z).replace('{x}', xx).replace('{y}', ty);
      this.tiles.set(key, t);
      if (this.tiles.size > 64) this.tiles.delete(this.tiles.keys().next().value);
      return t;
    },
    // 메르카토르 (U, V) 의 해발 고도 (m). 아직 없으면 null (요청은 해 둔다)
    at(U, V) {
      const n = 2 ** DEM_Z, fx = U * n, fy = V * n, tx = Math.floor(fx), ty = Math.floor(fy);
      const t = this.tile(tx, ty);
      if (!t.ok) return null;
      const px = Math.max(0, Math.min(255, (fx - tx) * 256 - 0.5)), py = Math.max(0, Math.min(255, (fy - ty) * 256 - 0.5));
      const x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1);
      const ax = px - x0, ay = py - y0, h = t.h;
      const top = h[y0 * 256 + x0] * (1 - ax) + h[y0 * 256 + x1] * ax;
      const bot = h[y1 * 256 + x0] * (1 - ax) + h[y1 * 256 + x1] * ax;
      return top * (1 - ay) + bot * ay;
    },
    // 영역(메르카토르)의 타일을 미리 요청 → 모두 도착하면 resolve
    prefetch(u0, v0, u1, v1) {
      const n = 2 ** DEM_Z, list = [];
      for (let tx = Math.floor(u0 * n); tx <= Math.floor(u1 * n); tx++)
        for (let ty = Math.floor(v0 * n); ty <= Math.floor(v1 * n); ty++) if (list.length < 36) list.push(this.tile(tx, ty));
      return Promise.all(list.map(t => t.promise));
    },
  };

  // 지면 좌표(m) → 그려질 높이 z (m, 과장 포함). terrain: {geo, on}
  function terrainZ(tr, x, y) {
    if (!tr || !tr.on) return 0;
    const h = DEM.at(tr.geo.cu + x / tr.geo.C, tr.geo.cv - y / tr.geo.C);
    return h == null ? tr.fallback : (h - tr.base) * TERRAIN_EXAG;
  }

  // 타일 격자 메시: [x, y, z, u, v, 음영] × (N+1)² — 같은 타일·같은 지형 상태면 재사용
  const meshCache = new Map();
  const LIGHT = (() => { const l = [-0.55, 0.6, 1.0], n = Math.hypot(...l); return l.map(v => v / n); })();
  function tileMesh(t, N, tr, u0, v0, us) {
    const key = `${t.z}/${t.x}/${t.y}/${N}/${u0}/${v0}/${us}/${tr && tr.on ? DEM.version + ':' + tr.base : 'flat'}/${tr ? tr.geo.cu : 0}`;
    let m = meshCache.get(key);
    if (m) { meshCache.delete(key); meshCache.set(key, m); return m; }
    const [x0, y0, x1, y1] = t.rect, out = new Float32Array((N + 1) * (N + 1) * 6);
    const e = Math.max(15, (x1 - x0) / N);                 // 기울기 계산 간격
    let k = 0;
    for (let j = 0; j <= N; j++) {
      const fy = j / N, y = y1 + (y0 - y1) * fy;           // j=0 이 북쪽(이미지 첫 줄)
      for (let i = 0; i <= N; i++) {
        const fx = i / N, x = x0 + (x1 - x0) * fx;
        const z = terrainZ(tr, x, y);
        let shade = 1;
        if (tr && tr.on) {
          const dzx = (terrainZ(tr, x + e, y) - terrainZ(tr, x - e, y)) / (2 * e);
          const dzy = (terrainZ(tr, x, y + e) - terrainZ(tr, x, y - e)) / (2 * e);
          const nl = Math.hypot(dzx, dzy, 1);
          const dot = (-dzx * LIGHT[0] - dzy * LIGHT[1] + LIGHT[2]) / nl;
          shade = Math.max(0.5, Math.min(1.45, 1 + 1.2 * (dot - LIGHT[2])));
        }
        out[k++] = x; out[k++] = y; out[k++] = z;
        out[k++] = u0 + us * fx; out[k++] = v0 + us * fy; out[k++] = shade;
      }
    }
    meshCache.set(key, out);
    if (meshCache.size > 500) meshCache.delete(meshCache.keys().next().value);
    return out;
  }

  // ---------- 3D 카메라 ----------
  const FOV = 40 * rad, TY = Math.tan(FOV / 2);
  const smooth = t => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerpAng = (a, b, t) => { let d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t; };

  /**
   * 카메라 {tx, ty(바라보는 지면 점, m), beta(방위, 북=0 시계방향), pitch(0=수직으로 내려다봄), D(거리), oy(화면 세로 치우침)}
   * → 투영에 필요한 값들. 지면 좌표: x 동쪽, y 북쪽, z 위 (m).
   */
  function camBasis(c, W, H) {
    const sb = Math.sin(c.beta), cb = Math.cos(c.beta), sp = Math.sin(c.pitch), cp = Math.cos(c.pitch);
    const h = [sb, cb, 0], r = [cb, -sb, 0];
    const f = [h[0] * sp, h[1] * sp, -cp];                 // 바라보는 방향
    const u = [h[0] * cp, h[1] * cp, sp];                  // 화면 위쪽
    const tz = c.tz || 0;
    const E = [c.tx - f[0] * c.D, c.ty - f[1] * c.D, tz - f[2] * c.D];
    const TX = TY * W / H;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const rE = dot(r, E), uE = dot(u, E), fE = dot(f, E);
    // clip = (r·q/TX, u·q/TY + oy·(f·q), 0, f·q),  q = p − E   (열 우선 4x4)
    const m = new Float32Array(16);
    m[0] = r[0] / TX; m[4] = r[1] / TX; m[8] = r[2] / TX; m[12] = -rE / TX;
    m[1] = u[0] / TY + c.oy * f[0]; m[5] = u[1] / TY + c.oy * f[1]; m[9] = u[2] / TY + c.oy * f[2]; m[13] = -uE / TY - c.oy * fE;
    m[3] = f[0]; m[7] = f[1]; m[11] = f[2]; m[15] = -fE;
    return Object.assign({}, c, { tz, r, u, f, E, TX, mat: m, W, H, near: c.D * 0.02, fog: [c.D * 1.9, c.D * 4.6] });
  }

  // 지면 점 → 동차 좌표 {cx, cy, cw}
  function camClip(k, x, y, z = k.tz) {
    const m = k.mat;
    return { cx: m[0] * x + m[4] * y + m[8] * z + m[12], cy: m[1] * x + m[5] * y + m[9] * z + m[13], cw: m[3] * x + m[7] * y + m[11] * z + m[15] };
  }
  const clipToScreen = (k, c) => ({ x: (c.cx / c.cw + 1) / 2 * k.W, y: (1 - c.cy / c.cw) / 2 * k.H });

  // 화면 가장자리 광선이 땅에 닿는 곳 → 보이는 지면 범위
  function camFootprint(k) {
    const pts = [];
    const far = k.fog[1] * 1.1;
    for (let i = 0; i <= 4; i++) for (const [sx, sy] of [[i / 4, 0], [i / 4, 1], [0, i / 4], [1, i / 4]]) {
      const nx = sx * 2 - 1, ny = 1 - sy * 2;
      const d = [0, 1, 2].map(j => k.f[j] + k.r[j] * nx * k.TX + k.u[j] * (ny - k.oy) * TY);
      let t = d[2] < -1e-4 ? (k.tz - k.E[2]) / d[2] : Infinity;
      const len = Math.hypot(d[0], d[1], d[2]);
      t = Math.min(t, far / len);
      pts.push([k.E[0] + d[0] * t, k.E[1] + d[1] * t]);
    }
    pts.push([k.E[0], k.E[1]]);
    return pts;
  }

  /**
   * 보이는 타일 고르기 — 가까운 곳은 자세한 줌, 먼 곳은 거친 줌(사지 트리).
   * geo: {cu, cv, C} 지면 좌표 ↔ 메르카토르 변환.
   */
  function camTiles(k, geo, maxTiles = 150) {
    const fp = camFootprint(k);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of fp) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const toU = x => geo.cu + x / geo.C, toV = y => geo.cv - y / geo.C;
    const span = Math.max(x1 - x0, y1 - y0);
    const z0 = Math.max(1, Math.min(16, Math.floor(Math.log2(geo.C / span))));
    const tileRect = (z, tx, ty) => {
      const n = 2 ** z;
      return [(tx / n - geo.cu) * geo.C, -((ty + 1) / n - geo.cv) * geo.C, ((tx + 1) / n - geo.cu) * geo.C, -(ty / n - geo.cv) * geo.C];
    };
    const focal = (k.H / 2) / TY;
    const sizeOf = rect => {                       // 화면에서의 대략 크기(px)
      const nx = Math.max(rect[0], Math.min(k.E[0], rect[2])), ny = Math.max(rect[1], Math.min(k.E[1], rect[3]));
      const dist = Math.hypot(nx - k.E[0], ny - k.E[1], k.E[2] - k.tz);
      return (rect[2] - rect[0]) * focal / dist;
    };
    const visible = rect => {
      const cs = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[0], rect[3]], [rect[2], rect[3]]].map(([x, y]) => camClip(k, x, y));
      if (cs.every(c => c.cw <= k.near)) return false;
      if (cs.some(c => c.cw <= k.near)) return true;
      const ss = cs.map(c => clipToScreen(k, c));
      if (ss.every(s => s.x < 0) || ss.every(s => s.x > k.W) || ss.every(s => s.y < 0) || ss.every(s => s.y > k.H)) return false;
      // 안개 너머(완전히 배경색)는 건너뜀
      const nx = Math.max(rect[0], Math.min(k.E[0], rect[2])), ny = Math.max(rect[1], Math.min(k.E[1], rect[3]));
      return Math.hypot(nx - k.E[0], ny - k.E[1]) < k.fog[1] * 1.05;
    };
    const n0 = 2 ** z0;
    let list = [];
    for (let tx = Math.floor(toU(x0) * n0); tx <= Math.floor(toU(x1) * n0); tx++) {
      for (let ty = Math.max(0, Math.floor(toV(y1) * n0)); ty <= Math.min(n0 - 1, Math.floor(toV(y0) * n0)); ty++) {
        const rect = tileRect(z0, tx, ty);
        if (visible(rect)) list.push({ z: z0, x: tx, y: ty, rect, s: sizeOf(rect) });
      }
    }
    // 화면에서 가장 크게 보이는 타일부터 4조각으로 나눈다
    for (let guard = 0; guard < 400; guard++) {
      let bi = -1;
      // 보통은 z17 까지, 발밑처럼 아주 크게 보이는 곳만 z18 (타일 수·서버 부담을 줄인다)
      const need = t => (t.z < 17 && t.s > 480) || (t.z < 18 && t.s > 820);
      for (let i = 0; i < list.length; i++) if (need(list[i]) && (bi < 0 || list[i].s > list[bi].s)) bi = i;
      if (bi < 0 || list.length + 3 > maxTiles) break;
      const t = list[bi];
      list.splice(bi, 1);
      for (let j = 0; j < 4; j++) {
        const z = t.z + 1, tx = t.x * 2 + (j & 1), ty = t.y * 2 + (j >> 1), rect = tileRect(z, tx, ty);
        if (visible(rect)) list.push({ z, x: tx, y: ty, rect, s: sizeOf(rect) });
      }
    }
    list.sort((a, b) => a.z - b.z);
    return list;
  }

  // ---------- 렌더러 ----------
  class Renderer {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.route = null;
      this.opt = { style: 'dark', color: 'pace', trimM: 200, showKm: true, overlay: null, transparent: false };
      this.p = 1;
      this._pending = new Set();
      this._raf = 0;
      this._playing = false;
    }

    set(route, opt) {
      this.route = route;
      Object.assign(this.opt, opt || {});
      this._layout();
    }

    // 캔버스 크기·경로에 맞춰 보기 영역과 화면 좌표를 계산
    _layout() {
      const W = this.cv.width, H = this.cv.height, route = this.route;
      if (!route || !W || !H) { this.scr = null; return; }
      const u = Math.min(W, H) / 100;
      const total = route.totalM;
      const trim = this.opt.trimM && total > this.opt.trimM * 4 ? this.opt.trimM : 0;
      const d0 = trim, d1 = total - trim;
      let vis = route.pts.filter(p => p.d >= d0 && p.d <= d1);
      if (vis.length < 2) vis = route.pts;

      // 경로가 들어갈 안전 영역 — 위 제목·아래 스탯을 피한다
      const hasOv = !!this.opt.overlay;
      const top = H * (hasOv ? 0.17 : 0.08), bottom = H * (hasOv ? 0.70 : 0.92);
      const left = W * 0.08, right = W * 0.92;
      let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
      for (const p of vis) {
        const x = mercX(p.lon), y = mercY(p.lat);
        if (x < u0) u0 = x; if (x > u1) u1 = x; if (y < v0) v0 = y; if (y > v1) v1 = y;
      }
      const spanU = Math.max(u1 - u0, 1e-9), spanV = Math.max(v1 - v0, 1e-9);
      // 아주 짧은 경로가 과도하게 확대되지 않도록 약 z17 에서 멈춘다
      const scale = Math.min((right - left) / spanU, (bottom - top) / spanV, 300 * 2 ** 17);
      const cu = (u0 + u1) / 2, cvv = (v0 + v1) / 2, cx = (left + right) / 2, cy = (top + bottom) / 2;
      this.view = { W, H, u, scale, cu, cv: cvv, cx, cy };

      // 페이스 색: 앞뒤 100m 창의 평균 페이스 → 10~90% 분위로 정규화
      const pace = vis.map(p => {
        if (!route.hasTime) return null;
        const a = Math.max(0, p.d - 100), b = Math.min(total, p.d + 100);
        return b > a ? (mtAt(route, b) - mtAt(route, a)) / (b - a) : null;
      });
      const sorted = pace.filter(v => v > 0).sort((a, b) => a - b);
      const q = f => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))];
      const pLo = sorted.length ? q(0.1) : 0, pHi = sorted.length ? q(0.9) : 1;

      // 화면 좌표 + 1.5px 미만 간격 점은 합쳐서 가볍게 (3D 는 확대해 보므로 모두 유지)
      // 3D 용 지면 좌표(m): x 동쪽, y 북쪽 — 경로 중심 기준
      this.is3d = this.opt.view === '3d' && GL3D.ok();
      const C = 40075016.686 * Math.cos(Math.atan(Math.sinh(Math.PI * (1 - 2 * cvv))));
      this.geo = { cu, cv: cvv, C };
      const scr = [];
      vis.forEach((p, i) => {
        const mx = mercX(p.lon), my = mercY(p.lat);
        const x = cx + (mx - cu) * scale, y = cy + (my - cvv) * scale;
        const lastS = scr[scr.length - 1];
        if (!this.is3d && lastS && i < vis.length - 1 && Math.hypot(x - lastS.x, y - lastS.y) < 1.5) return;
        let b = 0;
        if (pace[i] > 0 && pHi > pLo) b = Math.round(Math.max(0, Math.min(1, (pace[i] - pLo) / (pHi - pLo))) * (BUCKETS - 1));
        scr.push({ x, y, d: p.d, b, wx: (mx - cu) * C, wy: -(my - cvv) * C, ok: true });
      });
      this.scr = scr;
      this.d0 = scr[0].d;
      this.d1 = scr[scr.length - 1].d;

      // km 표시 지점 (전체 거리 기준, 가려진 구간 제외)
      const step = total <= 10500 ? 1000 : total <= 21500 ? 2000 : 5000;
      this.kms = [];
      for (let m = step; m < total - 100; m += step) {
        if (m < this.d0 || m > this.d1) continue;
        const pt = this._at(m);
        if (pt) this.kms.push({ m, km: m / 1000, x: pt.x, y: pt.y });
      }
      this._placeKms(u, W, H);
      if (this.is3d) this._setup3d(total, W, H);
    }

    // ---------- 3D: 달리는 방향을 따라가는 카메라 ----------
    // 시작: 위에서 내려다본 전체 경로 → 출발점으로 내려앉으며 기울어짐 → 진행 방향을 앞에 두고
    // 따라 달림 → 도착 후 비스듬히 전체 경로를 보여 주며 끝.
    _setup3d(total, W, H) {
      const s = this.scr, d0 = this.d0, d1 = this.d1;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of s) { x0 = Math.min(x0, p.wx); x1 = Math.max(x1, p.wx); y0 = Math.min(y0, p.wy); y1 = Math.max(y1, p.wy); }
      const hasOv = !!this.opt.overlay;
      const fracH = hasOv ? 0.53 : 0.84, fracW = 0.84;
      const TX = TY * W / H;
      const fit = Math.max((y1 - y0) / (2 * TY * fracH), (x1 - x0) / (2 * TX * fracW), 150);
      const ovOy = hasOv ? 1 - 2 * 0.435 : 0;
      // 따라가는 카메라는 넉넉히 멀리서(한 화면에 약 0.5~2.6km) — 가까우면 화면이 빨리 흘러 어지럽다
      this.cam3 = {
        top: { tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, beta: 0, pitch: 0, D: fit, oy: ovOy },
        end: { tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, beta: 0, pitch: 45 * rad, D: fit * 1.15, oy: ovOy },
        followD: Math.min(2600, Math.max(500, total * 0.18)) / (2 * TY),
      };
      // 지형: 경로 주변(안개 끝까지) 고도 타일을 미리 요청
      const g = this.geo, mg = this.cam3.followD * 5 + 500;
      this.terrain = { geo: g, on: true, base: null, fallback: 0 };
      this._demReady = DEM.prefetch(g.cu + (x0 - mg) / g.C, g.cv - (y1 + mg) / g.C, g.cu + (x1 + mg) / g.C, g.cv - (y0 - mg) / g.C);
      this._zVer = -1;
      this._demReady.then(() => { if (!this._playing && this.is3d) this.redraw(); });
      // 진행 방향 — 앞뒤 구간의 방향을 거리 기준으로 양방향 지수 평활.
      // 창을 넓게(전체의 15%, 최소 600m) 잡아 굽은 길에서도 카메라가 천천히 돈다
      const N = 400, step = (d1 - d0) / N, L = Math.max(600, total * 0.15), a = Math.min(1, step / L);
      const dl = Math.max(30, total * 0.008);
      const dirs = [];
      for (let i = 0; i <= N; i++) {
        const d = d0 + step * i, p = this._atW(Math.max(d0, d - dl)), q = this._atW(Math.min(d1, d + dl));
        const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        dirs.push([(q.x - p.x) / len, (q.y - p.y) / len]);
      }
      const pass = arr => { const out = [arr[0].slice()]; for (let i = 1; i < arr.length; i++) out.push([lerp(out[i - 1][0], arr[i][0], a), lerp(out[i - 1][1], arr[i][1], a)]); return out; };
      const fwd = pass(dirs), bwd = pass(dirs.slice().reverse()).reverse();
      this.bear = fwd.map((v, i) => Math.atan2(v[0] + bwd[i][0], v[1] + bwd[i][1]));
    }

    _atW(m) {
      const s = this.scr;
      if (m <= s[0].d) return { x: s[0].wx, y: s[0].wy };
      if (m >= s[s.length - 1].d) return { x: s[s.length - 1].wx, y: s[s.length - 1].wy };
      let lo = 0, hi = s.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].d <= m) lo = mid; else hi = mid; }
      const A = s[lo], B = s[hi], f = B.d > A.d ? (m - A.d) / (B.d - A.d) : 0;
      return { x: A.wx + (B.wx - A.wx) * f, y: A.wy + (B.wy - A.wy) * f };
    }

    // 경로 점들의 지형 높이 (고도 타일이 새로 올 때만 다시 계산)
    _heights() {
      const tr = this.terrain;
      if (this._zVer === DEM.version) return;
      this._zVer = DEM.version;
      if (tr.base == null) {                          // 기준 높이 = 경로 가장 낮은 곳 (숫자를 작게)
        let mn = Infinity;
        for (let i = 0; i < this.scr.length; i += 10) {
          const p = this.scr[i], h = DEM.at(tr.geo.cu + p.wx / tr.geo.C, tr.geo.cv - p.wy / tr.geo.C);
          if (h != null) mn = Math.min(mn, h);
        }
        if (isFinite(mn)) tr.base = mn;
      }
      if (tr.base == null) { for (const p of this.scr) p.wz = 0; this._zMid = 0; return; }
      let sum = 0;
      for (const p of this.scr) { p.wz = terrainZ(tr, p.wx, p.wy); sum += p.wz; }
      this._zMid = sum / this.scr.length;
    }

    _zAtD(m) {
      const s = this.scr;
      if (m <= s[0].d) return s[0].wz || 0;
      if (m >= s[s.length - 1].d) return s[s.length - 1].wz || 0;
      let lo = 0, hi = s.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].d <= m) lo = mid; else hi = mid; }
      const A = s[lo], B = s[hi], f = B.d > A.d ? (m - A.d) / (B.d - A.d) : 0;
      return (A.wz || 0) + ((B.wz || 0) - (A.wz || 0)) * f;
    }

    // 진행률 p → {카메라, e(경로 진행 0~1)}
    // 도입(내려앉기)·마무리(전체 보기)를 길게 잡아 전환이 천천히 일어나게 한다
    _cam(p) {
      this._heights();
      const INTRO = 0.14, OUTRO = 0.16, c3 = this.cam3;
      const e = easeInOut(Math.max(0, Math.min(1, (p - INTRO) / (1 - INTRO - OUTRO))));
      const follow = ee => {
        const dm = this.d0 + (this.d1 - this.d0) * ee;
        const h = this._atW(dm);
        const x = ee * (this.bear.length - 1), i = Math.floor(x), f = x - i;
        const beta = lerpAng(this.bear[i], this.bear[Math.min(this.bear.length - 1, i + 1)], f);
        // 카메라 높이는 앞뒤 200m 평균 — 오르막·내리막에서 화면이 출렁이지 않게
        const tz = (this._zAtD(dm - 200) + this._zAtD(dm) * 2 + this._zAtD(dm + 200)) / 4;
        return { tx: h.x, ty: h.y, tz, beta, pitch: 52 * rad, D: c3.followD, oy: -0.1 };
      };
      const zm = this._zMid || 0;
      const top = Object.assign({ tz: zm }, c3.top), end = Object.assign({ tz: zm }, c3.end);
      const mix = (A, B, t) => ({
        tx: lerp(A.tx, B.tx, t), ty: lerp(A.ty, B.ty, t), tz: lerp(A.tz, B.tz, t), beta: lerpAng(A.beta, B.beta, t),
        pitch: lerp(A.pitch, B.pitch, t), D: Math.exp(lerp(Math.log(A.D), Math.log(B.D), t)), oy: lerp(A.oy, B.oy, t),
      });
      let cam;
      if (p < INTRO) cam = mix(top, follow(0), smooth(Math.max(0, p) / INTRO));
      else if (p > 1 - OUTRO) cam = mix(follow(1), end, smooth(Math.min(1, (p - 1 + OUTRO) / OUTRO)));
      else cam = follow(e);
      const k = camBasis(cam, this.view.W, this.view.H);
      k.terrain = this.terrain;
      return { cam: k, e };
    }

    // 경로 점들을 카메라로 투영 (뒤로 넘어간 점은 ok=false)
    _project3d(k) {
      for (const p of this.scr) {
        const c = camClip(k, p.wx, p.wy, p.wz || 0);
        p.cx = c.cx; p.cy = c.cy; p.cw = c.cw; p.ok = c.cw > k.near;
        if (p.ok) { p.x = (c.cx / c.cw + 1) / 2 * k.W; p.y = (1 - c.cy / c.cw) / 2 * k.H; }
      }
      this._k = k;
    }

    // a(보이는 점)와 b(카메라 뒤) 사이에서 가까운 면에 닿는 화면 점
    _clipPt(a, b) {
      const n = this._k.near, t = (a.cw - n) / (a.cw - b.cw);
      const cx = a.cx + (b.cx - a.cx) * t, cy = a.cy + (b.cy - a.cy) * t;
      return { x: (cx / n + 1) / 2 * this._k.W, y: (1 - cy / n) / 2 * this._k.H };
    }

    // km 표시가 서로(또는 출발·도착 점과) 겹치지 않게 자리 잡기.
    // 같은 길을 여러 번 도는 코스는 길 옆으로 비켜 놓고, 끝내 자리가 없으면 생략한다.
    _placeKms(u, W, H) {
      const ctx = this.ctx, s = this.scr, h = u * 3.4, gap = u * 0.5;
      ctx.font = kmFont(u);
      const boxes = [s[0], s[s.length - 1]].map(p => ({ x: p.x, y: p.y, w: u * 2.6, h: u * 2.6 }));
      const hit = b => boxes.some(o => Math.abs(b.x - o.x) * 2 < b.w + o.w + gap && Math.abs(b.y - o.y) * 2 < b.h + o.h + gap);
      for (const k of this.kms) {
        k.label = String(Math.round(k.km));
        const w = Math.max(u * 3.6, ctx.measureText(k.label).width + u * 2.2);
        // 진행 방향의 수직 방향으로 비켜 설 후보들
        const a = this._at(k.m - 40), b = this._at(k.m + 40);
        let dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
        const nx = -dy, ny = dx, off = Math.max(w, h) + gap * 1.5;
        const cands = [[0, 0]];
        for (const f of [1, -1]) cands.push([nx * off * f, ny * off * f]);
        for (const f of [1, -1]) for (const g of [1, -1]) cands.push([(nx * f + dx * g) * off, (ny * f + dy * g) * off]);
        for (const f of [1, -1]) cands.push([nx * off * 2 * f, ny * off * 2 * f]);
        k.hidden = true;
        for (const [ox, oy] of cands) {
          const bx = { x: k.x + ox, y: k.y + oy, w, h };
          if (bx.x - w / 2 < u || bx.x + w / 2 > W - u || bx.y - h / 2 < u || bx.y + h / 2 > H - u) continue;
          if (hit(bx)) continue;
          Object.assign(k, { lx: bx.x, ly: bx.y, w, hidden: false });
          boxes.push(bx);
          break;
        }
      }
    }

    // 누적 거리 m 의 화면 위치 (보간)
    _at(m) {
      const s = this.scr;
      if (!s || !s.length) return null;
      if (m <= s[0].d) return s[0].ok ? { x: s[0].x, y: s[0].y, i: 0 } : null;
      if (m >= s[s.length - 1].d) return s[s.length - 1].ok ? { x: s[s.length - 1].x, y: s[s.length - 1].y, i: s.length - 1 } : null;
      let lo = 0, hi = s.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].d <= m) lo = mid; else hi = mid; }
      const a = s[lo], b = s[hi], f = b.d > a.d ? (m - a.d) / (b.d - a.d) : 0;
      if (!a.ok || !b.ok) return null;                 // 3D: 카메라 뒤
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, i: lo };
    }

    _drawTiles(ctx) {
      const st = STYLES[this.opt.style] || STYLES.dark;
      const { W, H, scale, cu, cv, cx, cy } = this.view;
      if (!(this.opt.transparent && !st.url)) { ctx.fillStyle = st.bg; ctx.fillRect(0, 0, W, H); }
      if (!st.url) return;
      // 256px 타일을 화면에 150~300px 로 — 거의 축소만 해서 선명하게 (OSM 최대 19)
      const zi = Math.max(0, Math.min(19, Math.ceil(Math.log2(scale / 300))));
      const n = 2 ** zi;
      const uL = cu - cx / scale, uR = cu + (W - cx) / scale;
      const vT = cv - cy / scale, vB = cv + (H - cy) / scale;
      const X = t => Math.round(cx + (t / n - cu) * scale), Y = t => Math.round(cy + (t / n - cv) * scale);
      for (let ty = Math.max(0, Math.floor(vT * n)); ty <= Math.min(n - 1, Math.floor(vB * n)); ty++) {
        for (let tx = Math.floor(uL * n); tx <= Math.floor(uR * n); tx++) {
          const t = getTile(this.opt.style, zi, tx, ty);
          if (t.ok) ctx.drawImage(t.src, X(tx), Y(ty), X(tx + 1) - X(tx), Y(ty + 1) - Y(ty));
          else if (!t.failed) this._wait(t);
        }
      }
    }

    // 아직 안 받은 타일 — 도착하면 다시 그린다 (재생 중이면 다음 프레임이 알아서 그림)
    _wait(t) {
      if (this._pending.has(t)) return;
      this._pending.add(t);
      t.promise.then(() => {
        this._pending.delete(t);
        if (!this._playing) this.redraw();
      });
    }

    redraw() {
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(() => this.draw(this.p));
    }

    // 모든 타일이 도착할 때까지 기다림 (녹화·이미지 저장 전)
    async ready(timeoutMs = 12000) {
      this.draw(this.p);
      if (this.is3d && this.scr) {
        // 지형 → 카메라가 지나갈 길의 지도 타일 순으로 미리 받는다 (녹화 중 빈 타일이 보이지 않게)
        await Promise.race([this._demReady, new Promise(r => setTimeout(r, timeoutMs / 2))]);
        this._heights();
        const want = new Map();
        for (let i = 0; i <= 48; i++) {
          for (const t of camTiles(this._cam(i / 48).cam, this.geo)) want.set(`${t.z}/${t.x}/${t.y}`, t);
        }
        const tiles = [...want.values()].map(t => getTile('color', t.z, t.x, t.y));
        await Promise.race([Promise.all(tiles.map(t => t.promise)), new Promise(r => setTimeout(r, timeoutMs))]);
        this.draw(this.p);
        return;
      }
      const all = Promise.all([...this._pending].map(t => t.promise));
      await Promise.race([all, new Promise(r => setTimeout(r, timeoutMs))]);
      this.draw(this.p);
    }

    _path(ctx, from, to) {
      const s = this.scr;
      ctx.beginPath();
      if (!this.is3d) {
        ctx.moveTo(s[from].x, s[from].y);
        for (let i = from + 1; i <= to; i++) ctx.lineTo(s[i].x, s[i].y);
        return;
      }
      // 3D: 카메라 뒤로 넘어가는 부분은 잘라낸다
      let pen = false;
      for (let i = from; i <= to; i++) {
        const a = s[i];
        if (a.ok) {
          if (pen) ctx.lineTo(a.x, a.y);
          else {
            if (i > from && !s[i - 1].ok) { const c = this._clipPt(a, s[i - 1]); ctx.moveTo(c.x, c.y); ctx.lineTo(a.x, a.y); }
            else ctx.moveTo(a.x, a.y);
            pen = true;
          }
        } else if (pen) {
          const c = this._clipPt(s[i - 1], a); ctx.lineTo(c.x, c.y); pen = false;
        }
      }
    }

    // 3D: km 표시는 매 프레임 투영 위치에 — 화면 밖·카메라 뒤·겹치는 것은 생략 (비켜 놓으면 흔들린다)
    _kms3d(list, u, W, H) {
      const out = [], h = u * 3.4;
      for (const k of list) {
        const pt = this._at(k.m);
        if (!pt || pt.x < 0 || pt.x > W || pt.y < 0 || pt.y > H) continue;
        const b = { m: k.m, label: k.label, w: k.w, x: pt.x, y: pt.y, lx: pt.x, ly: pt.y };
        if (out.some(o => Math.abs(o.lx - b.lx) * 2 < o.w + b.w && Math.abs(o.ly - b.ly) < h)) continue;
        out.push(b);
      }
      return out;
    }

    draw(p = this.p, now = performance.now()) {
      this.p = p;
      const ctx = this.ctx;
      if (!this.scr || !this.view) return;
      const { W, H, u } = this.view;
      const st = STYLES[this.opt.style] || STYLES.dark;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      let e = easeInOut(Math.max(0, Math.min(1, p)));
      if (this.is3d) {
        const c = this._cam(p);
        e = c.e;
        this._project3d(c.cam);
        if (!(this.opt.transparent && !st.url)) {
          const pending = [];
          const tiles = camTiles(c.cam, this.geo);
          // 곧 보일 타일을 미리 요청·업로드 (재생 중 빈 칸·흐린 칸이 덜 보이게)
          if (st.url && p > 0 && p < 1) {
            for (const t of camTiles(this._cam(Math.min(1, p + 0.035)).cam, this.geo)) GL3D.texFor(t.z, t.x, t.y, null);
          }
          ctx.drawImage(GL3D.render(W, H, Object.assign(c.cam, { tiles }), this.opt.style, pending), 0, 0);
          pending.forEach(t => this._wait(t));
        }
      } else {
        this._drawTiles(ctx);
      }

      // 글씨가 잘 보이도록 위·아래 그림자 막
      if (this.opt.overlay && st.url) {
        let g = ctx.createLinearGradient(0, 0, 0, H * 0.24);
        g.addColorStop(0, 'rgba(0,0,0,0.62)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * 0.24);
        g = ctx.createLinearGradient(0, H * 0.62, 0, H);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.78)');
        ctx.fillStyle = g; ctx.fillRect(0, H * 0.62, W, H * 0.38);
      }

      const s = this.scr;
      const lw = Math.max(2, u * 0.95);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';

      // 전체 경로 윤곽 (앞으로 달릴 길)
      this._path(ctx, 0, s.length - 1);
      ctx.strokeStyle = st.light ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.16)';
      ctx.lineWidth = lw * 0.7;
      ctx.stroke();

      // 진행한 만큼
      const dNow = this.d0 + (this.d1 - this.d0) * e;
      const head = this._at(dNow);
      const upto = head ? head.i : 0;

      if (e > 0 && head) {
        const segs = [];                    // [{from, to, b}] 같은 색끼리 묶음
        for (let i = 1; i <= upto; i++) {
          const b = this.opt.color === 'pace' ? s[i].b : -1;
          const lastSeg = segs[segs.length - 1];
          if (lastSeg && lastSeg.b === b) lastSeg.to = i; else segs.push({ from: i - 1, to: i, b });
        }
        const stroke = (width, alpha, colorOf) => {
          ctx.globalAlpha = alpha; ctx.lineWidth = width;
          for (const g of segs) {
            this._path(ctx, g.from, g.to);
            ctx.strokeStyle = colorOf(g.b); ctx.stroke();
          }
          // 마지막 점 → 머리까지 이어서
          if (!s[upto].ok) { ctx.globalAlpha = 1; return; }
          ctx.beginPath(); ctx.moveTo(s[upto].x, s[upto].y); ctx.lineTo(head.x, head.y);
          ctx.strokeStyle = colorOf(this.opt.color === 'pace' ? (s[Math.min(s.length - 1, upto + 1)].b) : -1);
          ctx.stroke();
          ctx.globalAlpha = 1;
        };
        const col = b => (b < 0 ? ACCENT : PALETTE[b]);
        if (st.light) stroke(lw * 1.9, 0.55, () => '#1b1b1b');   // 밝은 지도에선 어두운 테두리
        stroke(lw * 3.2, 0.22, col);                              // 번짐(글로우)
        stroke(lw, 1, col);                                       // 본선
      }

      // km 표시
      if (this.opt.showKm) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = kmFont(u);
        const h = u * 3.4;
        let shown = this.kms.filter(k => (this.is3d || !k.hidden) && k.m <= this.d0 + (this.d1 - this.d0) * e + 1);
        if (this.is3d) shown = this._kms3d(shown, u, W, H);
        // 비켜 선 표시는 실제 지점과 가는 선·점으로 잇는다 (표시들 아래에 먼저 그림)
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.fillStyle = '#fff'; ctx.lineWidth = Math.max(1, u * 0.22);
        for (const k of shown) {
          if (k.lx === k.x && k.ly === k.y) continue;
          ctx.beginPath(); ctx.moveTo(k.x, k.y); ctx.lineTo(k.lx, k.ly); ctx.stroke();
          ctx.beginPath(); ctx.arc(k.x, k.y, u * 0.45, 0, Math.PI * 2); ctx.fill();
        }
        for (const k of shown) {
          ctx.fillStyle = 'rgba(13,13,13,0.86)';
          ctx.beginPath(); ctx.roundRect(k.lx - k.w / 2, k.ly - h / 2, k.w, h, h / 2); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = Math.max(1, u * 0.18); ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.fillText(k.label, k.lx, k.ly + u * 0.1);
        }
      }

      // 출발 점
      const dot = (x, y, r, fill, ring) => {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        ctx.lineWidth = Math.max(1.5, r * 0.4); ctx.strokeStyle = ring; ctx.stroke();
      };
      if (s[0].ok) dot(s[0].x, s[0].y, u * 1.05, ACCENT, '#0d0d0d');
      // 도착 점 (다 달렸을 때)
      if (e >= 1 && s[s.length - 1].ok) dot(s[s.length - 1].x, s[s.length - 1].y, u * 1.05, '#ffffff', '#0d0d0d');

      // 달리는 머리 — 은은하게 맥박치는 빛
      if (head && e > 0 && e < 1) {
        const pulse = 1 + 0.22 * Math.sin(now / 180);
        const r = u * 3.2 * pulse;
        const g = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, r);
        g.addColorStop(0, 'rgba(200,245,66,0.55)'); g.addColorStop(1, 'rgba(200,245,66,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(head.x, head.y, r, 0, Math.PI * 2); ctx.fill();
        dot(head.x, head.y, u * 1.15, '#ffffff', ACCENT);
      }

      if (this.opt.overlay) this._drawOverlay(ctx, e);

      // 지도 출처 표기 (라이선스)
      if (st.url) {
        ctx.font = `500 ${Math.max(9, u * 1.35)}px -apple-system, "Helvetica Neue", Arial, sans-serif`;
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText(ATTRIBUTION, W - u * 1.4, H - u * 0.9);
      }
      ctx.restore();
    }

    // 제목·날짜(위) + 거리·기록(아래) — 진행률에 맞춰 숫자가 차오른다
    _drawOverlay(ctx, e) {
      const o = this.opt.overlay, route = this.route;
      const { W, H, u } = this.view;
      const font = (w, s) => `${w} ${s}px "Pretendard Variable", Pretendard, "Helvetica Neue", "Apple SD Gothic Neo", Arial, sans-serif`;
      const pad = u * 6;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = u * 1.2;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';

      let y = pad;
      if (o.title) {
        ctx.font = font(800, u * 4.2); ctx.fillStyle = '#fff';
        ctx.fillText(o.title, pad, y, W - pad * 2); y += u * 5.6;
      }
      if (o.sub) {
        ctx.font = font(600, u * 2.8); ctx.fillStyle = 'rgba(255,255,255,0.78)';
        ctx.fillText(o.sub, pad, y, W - pad * 2);
      }

      // 진행률 → 실제 이동시간 비율 (느린 구간은 시간이 더 빨리 흐른다)
      const fracD = e;
      const fracT = route && route.hasTime && route.movingS
        ? mtAt(route, route.totalM * fracD) / route.pts[route.pts.length - 1].mt : fracD;
      const dist = (o.dist || 0) * fracD;
      const secs = (o.seconds || 0) * fracT;

      const statsY = H - pad - u * 17;
      ctx.textBaseline = 'alphabetic';
      ctx.font = font(800, u * 13); ctx.fillStyle = '#fff';
      const dTxt = dist.toFixed(2);
      ctx.fillText(dTxt, pad - u * 0.6, statsY + u * 11);
      const dW = ctx.measureText(dTxt).width;
      ctx.font = font(700, u * 4.2); ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText('km', pad + dW + u * 0.8, statsY + u * 11);

      // 시간·페이스는 실제 진행에 맞춰 흐르고, 심박·케이던스는 그 지점의 값을 보여주다가
      // 도착하면 평균으로 바뀐다 (거리별 기록이 없으면 처음부터 평균).
      const ser = (route && route.series) || {};
      const hr = liveMetric(ser.hr, o.hr, fracD), cad = liveMetric(ser.cad, o.cad, fracD);
      const items = [];
      for (const m of o.metrics || []) {
        if (m === 'time' && o.seconds) items.push(['시간', o.fmtTime(secs)]);
        if (m === 'pace' && o.seconds && o.dist) items.push(['페이스', o.fmtPace(dist > 0.02 ? secs / dist : o.seconds / o.dist)]);
        if (m === 'hr' && hr) items.push([hr.avg ? '평균 심박' : '심박', String(hr.v), '평균 심박']);
        if (m === 'cadence' && cad) items.push([cad.avg ? '평균 케이던스' : '케이던스', String(cad.v), '평균 케이던스']);
        if (m === 'elev' && o.elev) items.push(['상승 고도', `${Math.round(gainAt(ser.gain, o.elev, fracD))} m`, '상승 고도']);
      }
      let x = pad;
      const ly = statsY + u * 14.5;
      // 항목이 많아 폭을 넘으면 글자·간격을 함께 줄인다 (마지막 값 기준 최대 폭으로 잰다)
      const colW = k => items.map(([label, val, wide]) => {
        ctx.font = font(800, u * 4.3 * k); const a = ctx.measureText(val.replace(/\d/g, '8')).width;
        ctx.font = font(600, u * 2.3 * k); return Math.max(a, ctx.measureText(wide || label).width);
      });
      let k = 1;
      const need = colW(1).reduce((a, b) => a + b, 0) + u * 6 * Math.max(0, items.length - 1);
      if (need > W - pad * 2) k = Math.max(0.6, (W - pad * 2) / need);
      const gap = u * 6 * k, widths = colW(k);
      items.forEach(([label, val], i) => {
        ctx.font = font(600, u * 2.3 * k); ctx.fillStyle = 'rgba(255,255,255,0.68)';
        ctx.fillText(label, x, ly);
        ctx.font = font(800, u * 4.3 * k); ctx.fillStyle = '#fff';
        ctx.fillText(val, x, ly + u * 5 * k);
        x += widths[i] + gap;
      });
      ctx.restore();
    }

    play(durationMs, onEnd) {
      this.stop();
      this._playing = true;
      const t0 = performance.now();
      const tick = now => {
        const p = Math.min(1, (now - t0) / durationMs);
        this.draw(p, now);
        if (p < 1 && this._playing) this._raf = requestAnimationFrame(tick);
        else { this._playing = false; if (onEnd) onEnd(); }
      };
      this._raf = requestAnimationFrame(tick);
    }

    stop() {
      this._playing = false;
      cancelAnimationFrame(this._raf);
    }
  }

  // ---------- 영상 녹화 ----------
  function videoType() {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return null;
    const c = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4',
      'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return c.find(t => MediaRecorder.isTypeSupported(t)) || null;
  }

  /**
   * 경로 애니메이션을 영상으로 녹화한다 (실시간으로 재생하며 녹화 — duration+hold 만큼 걸림).
   * 캡처 도중 탭이 가려지면 브라우저가 그리기를 멈추므로 화면을 켜 둬야 한다.
   */
  async function recordVideo({ route, opt, width, height, durationMs, holdMs = 1500, onProgress }) {
    const type = videoType();
    if (!type) throw new Error('이 브라우저는 영상 저장을 지원하지 않아요');
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = height;
    cv.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none';
    document.body.appendChild(cv);
    const r = new Renderer(cv);
    r.set(route, Object.assign({}, opt, { transparent: false }));
    r.p = 0;
    try {
      await r.ready();
      const stream = cv.captureStream(30);
      const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8000000 });
      const chunks = [];
      rec.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      const stopped = new Promise(res => { rec.onstop = res; });
      rec.start(250);
      await new Promise(resolve => {
        const t0 = performance.now(), total = durationMs + holdMs;
        const tick = now => {
          const el = now - t0;
          r.draw(Math.min(1, el / durationMs), now);
          if (onProgress) onProgress(Math.min(1, el / total));
          if (el < total) requestAnimationFrame(tick); else resolve();
        };
        requestAnimationFrame(tick);
      });
      rec.stop();
      await stopped;
      stream.getTracks().forEach(t => t.stop());
      return { blob: new Blob(chunks, { type: type.split(';')[0] }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
    } finally {
      cv.remove();
    }
  }

  window.RouteMap = { parseTrackFile, analyze, attachSeries, liveMetric, gainAt, splits, compact, mtAt, Renderer, recordVideo, videoType, STYLES, has3d: () => GL3D.ok() };
})();
