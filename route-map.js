/**
 * 러닝로그 — 지도 여정(GPS 경로) 모듈
 *
 * - GPX·TCX 파싱, 경로 분석(거리·이동시간·1km 구간·평균 심박/케이던스)
 * - 캔버스 지도 렌더러: OpenStreetMap 타일(웹 메르카토르) 위에 진행률만큼 경로를 그린다.
 *   타일이 CORS 를 허용해 캔버스가 오염되지 않으므로 PNG·영상으로 그대로 저장할 수 있다.
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
        pts.push({ lat, lon, t: time ? Date.parse(time) : null, hr: num(textOf(p, 'hr')), cad: num(textOf(p, 'cad')) });
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
    const pts = [];
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
      last = p;
    }
    const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
    const hr = avg(raw.map(p => p.hr).filter(v => v > 0));
    let cad = avg(raw.map(p => p.cad).filter(v => v > 0));
    if (cad && cad < 120) cad *= 2;       // GPX·TCX 는 보통 한쪽 발 기준(rpm) → 분당 걸음 수
    const first = raw.find(p => p.t != null);
    return {
      pts, totalM: d, hasTime,
      movingS: hasTime ? Math.round(mt) : null,
      startT: hasTime && first ? first.t : null,
      avgHr: hr ? Math.round(hr) : null,
      avgCad: cad ? Math.round(cad) : null,
    };
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
  const TILE_CACHE_MAX = 220;

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
  // 빠름(연두) → 느림(빨강)
  const RAMP = [[200, 245, 66], [255, 214, 10], [255, 159, 10], [255, 69, 58]];
  const BUCKETS = 12;
  const PALETTE = Array.from({ length: BUCKETS }, (_, i) => {
    const f = (i / (BUCKETS - 1)) * (RAMP.length - 1), k = Math.min(RAMP.length - 2, Math.floor(f)), r = f - k;
    const c = RAMP[k].map((v, j) => Math.round(v + (RAMP[k + 1][j] - v) * r));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  });

  const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

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

      // 화면 좌표 + 1.5px 미만 간격 점은 합쳐서 가볍게
      const scr = [];
      vis.forEach((p, i) => {
        const x = cx + (mercX(p.lon) - cu) * scale, y = cy + (mercY(p.lat) - cvv) * scale;
        const lastS = scr[scr.length - 1];
        if (lastS && i < vis.length - 1 && Math.hypot(x - lastS.x, y - lastS.y) < 1.5) return;
        let b = 0;
        if (pace[i] > 0 && pHi > pLo) b = Math.round(Math.max(0, Math.min(1, (pace[i] - pLo) / (pHi - pLo))) * (BUCKETS - 1));
        scr.push({ x, y, d: p.d, b });
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
    }

    // 누적 거리 m 의 화면 위치 (보간)
    _at(m) {
      const s = this.scr;
      if (!s || !s.length) return null;
      if (m <= s[0].d) return { x: s[0].x, y: s[0].y, i: 0 };
      if (m >= s[s.length - 1].d) return { x: s[s.length - 1].x, y: s[s.length - 1].y, i: s.length - 1 };
      let lo = 0, hi = s.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (s[mid].d <= m) lo = mid; else hi = mid; }
      const a = s[lo], b = s[hi], f = b.d > a.d ? (m - a.d) / (b.d - a.d) : 0;
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
      const all = Promise.all([...this._pending].map(t => t.promise));
      await Promise.race([all, new Promise(r => setTimeout(r, timeoutMs))]);
      this.draw(this.p);
    }

    _path(ctx, from, to) {
      const s = this.scr;
      ctx.beginPath();
      ctx.moveTo(s[from].x, s[from].y);
      for (let i = from + 1; i <= to; i++) ctx.lineTo(s[i].x, s[i].y);
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
      this._drawTiles(ctx);

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
      const e = easeInOut(Math.max(0, Math.min(1, p)));
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
        ctx.font = `800 ${u * 2.1}px "Pretendard Variable", Pretendard, "Apple SD Gothic Neo", sans-serif`;
        for (const k of this.kms) {
          if (k.m > this.d0 + (this.d1 - this.d0) * e + 1) continue;
          const label = String(Math.round(k.km));
          const w = Math.max(u * 3.6, ctx.measureText(label).width + u * 2.2), h = u * 3.4;
          ctx.fillStyle = 'rgba(13,13,13,0.86)';
          ctx.beginPath(); ctx.roundRect(k.x - w / 2, k.y - h / 2, w, h, h / 2); ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = Math.max(1, u * 0.18); ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.fillText(label, k.x, k.y + u * 0.1);
        }
      }

      // 출발 점
      const dot = (x, y, r, fill, ring) => {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        ctx.lineWidth = Math.max(1.5, r * 0.4); ctx.strokeStyle = ring; ctx.stroke();
      };
      dot(s[0].x, s[0].y, u * 1.05, ACCENT, '#0d0d0d');
      // 도착 점 (다 달렸을 때)
      if (e >= 1) dot(s[s.length - 1].x, s[s.length - 1].y, u * 1.05, '#ffffff', '#0d0d0d');

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

      // 시간·페이스는 실제 진행에 맞춰 흐르고, 평균값(심박·케이던스)은 처음 25% 동안만
      // 빠르게 차오른 뒤 최종값을 유지한다 — 중간에 '심박 60' 처럼 보이면 오해를 부른다.
      const fracAvg = Math.min(1, fracD / 0.25);
      const items = [];
      for (const m of o.metrics || []) {
        if (m === 'time' && o.seconds) items.push(['시간', o.fmtTime(secs)]);
        if (m === 'pace' && o.seconds && o.dist) items.push(['페이스', o.fmtPace(dist > 0.02 ? secs / dist : o.seconds / o.dist)]);
        if (m === 'hr' && o.hr) items.push(['평균 심박', String(Math.round(o.hr * fracAvg))]);
        if (m === 'cadence' && o.cad) items.push(['케이던스', String(Math.round(o.cad * fracAvg))]);
      }
      let x = pad;
      const gap = u * 6, ly = statsY + u * 14.5;
      for (const [label, val] of items) {
        ctx.font = font(600, u * 2.3); ctx.fillStyle = 'rgba(255,255,255,0.68)';
        ctx.fillText(label, x, ly);
        ctx.font = font(800, u * 4.3); ctx.fillStyle = '#fff';
        ctx.fillText(val, x, ly + u * 5);
        ctx.font = font(800, u * 4.3);
        const w1 = ctx.measureText(val).width;
        ctx.font = font(600, u * 2.3);
        x += Math.max(w1, ctx.measureText(label).width) + gap;
      }
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

  window.RouteMap = { parseTrackFile, analyze, splits, compact, mtAt, Renderer, recordVideo, videoType, STYLES };
})();
