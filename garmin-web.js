/**
 * 가민 커넥트 브라우저 직접 연동 모듈
 *
 * 중계 워커(cloudflare-worker.js)를 통해 가민 SSO 로그인 → OAuth1 → OAuth2 토큰을
 * 발급받고, 토큰은 이 브라우저의 localStorage 에만 저장한다. (garth 라이브러리의
 * 인증 절차를 웹용으로 이식한 것)
 */
(() => {
  'use strict';

  const SSO = 'https://sso.garmin.com/sso';
  const UA_SSO = 'GCM-iOS-5.7.2.1';
  const UA_API = 'com.garmin.android.apps.connectmobile';
  const STORE_KEY = 'garminWebAuth';

  const EMBED_PARAMS = { id: 'gauth-widget', embedWidget: 'true', gauthHost: SSO };
  const SIGNIN_PARAMS = {
    id: 'gauth-widget', embedWidget: 'true',
    gauthHost: SSO + '/embed',
    service: SSO + '/embed',
    source: SSO + '/embed',
    redirectAfterAccountLoginUrl: SSO + '/embed',
    redirectAfterAccountCreationUrl: SSO + '/embed',
  };

  const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const qs = params => Object.entries(params).map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');

  class GarminWeb {
    constructor(proxyUrl) {
      this.proxy = proxyUrl.replace(/\/$/, '');
      this.jar = {};          // 로그인 세션 쿠키 (메모리에만)
      this.pendingMfa = null; // MFA 진행 상태
      this.consumer = null;
      this.oauth2 = null;
      try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY));
        if (saved && saved.oauth1) {
          this.oauth1 = saved.oauth1;
          this.consumer = saved.consumer || null;
        }
      } catch (e) { /* ignore */ }
    }

    hasAuth() { return !!this.oauth1; }
    logout() { this.oauth1 = null; this.oauth2 = null; localStorage.removeItem(STORE_KEY); }
    _save() {
      localStorage.setItem(STORE_KEY, JSON.stringify({ oauth1: this.oauth1, consumer: this.consumer }));
    }

    // ---------- 중계 요청 ----------
    async req(host, path, opts = {}) {
      let url = `${this.proxy}/p/${host}${path}`;
      if (opts.params) url += '?' + qs(opts.params);
      const headers = { 'X-UA': opts.ua || UA_SSO };
      const cookies = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) headers['X-Cookies'] = cookies;
      if (opts.referer) headers['X-Referer'] = opts.referer;
      if (opts.auth) headers['X-Authorization'] = opts.auth;
      let body;
      if (opts.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = qs(opts.form);
      }
      const r = await fetch(url, { method: opts.method || 'GET', headers, body });
      if (!r.ok) throw new Error(`중계 서버 오류 (${r.status})`);
      this._storeCookies(r);
      let status = parseInt(r.headers.get('X-Status') || '0', 10);
      let text = await r.text();
      // 리다이렉트는 쿠키를 유지한 채 중계를 통해 직접 따라간다
      let hops = 0;
      let loc = r.headers.get('X-Location');
      let curHost = host;
      while (status >= 300 && status < 400 && loc && hops < 5) {
        const u = new URL(loc, `https://${curHost}${path}`);
        curHost = u.host;
        const rr = await fetch(`${this.proxy}/p/${u.host}${u.pathname}${u.search}`, {
          headers: {
            'X-UA': opts.ua || UA_SSO,
            ...(Object.keys(this.jar).length
              ? { 'X-Cookies': Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; ') }
              : {}),
          },
        });
        if (!rr.ok) throw new Error(`중계 서버 오류 (${rr.status})`);
        this._storeCookies(rr);
        status = parseInt(rr.headers.get('X-Status') || '0', 10);
        loc = rr.headers.get('X-Location');
        text = await rr.text();
        hops++;
      }
      return { status, text };
    }

    _storeCookies(resp) {
      const raw = resp.headers.get('X-Set-Cookies');
      if (!raw) return;
      try {
        for (const sc of JSON.parse(raw)) {
          const first = sc.split(';')[0];
          const i = first.indexOf('=');
          if (i > 0) {
            const name = first.slice(0, i).trim();
            const val = first.slice(i + 1).trim();
            if (val && val !== '""') this.jar[name] = val;
          }
        }
      } catch (e) { /* ignore */ }
    }

    // ---------- OAuth1 서명 (HMAC-SHA1) ----------
    async _oauth1Header(method, baseUrl, extraParams, token, tokenSecret) {
      const oauth = {
        oauth_consumer_key: this.consumer.consumer_key,
        oauth_nonce: Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''),
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: String(Math.floor(Date.now() / 1000)),
        oauth_version: '1.0',
      };
      if (token) oauth.oauth_token = token;
      const all = { ...extraParams, ...oauth };
      const paramStr = Object.keys(all).sort().map(k => `${enc(k)}=${enc(all[k])}`).join('&');
      const base = [method.toUpperCase(), enc(baseUrl), enc(paramStr)].join('&');
      const keyStr = `${enc(this.consumer.consumer_secret)}&${tokenSecret ? enc(tokenSecret) : ''}`;
      const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(keyStr),
        { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base));
      oauth.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(sig)));
      return 'OAuth ' + Object.keys(oauth).sort()
        .map(k => `${enc(k)}="${enc(oauth[k])}"`).join(', ');
    }

    async _loadConsumer() {
      if (this.consumer) return;
      const r = await this.req('thegarth.s3.amazonaws.com', '/oauth_consumer.json');
      this.consumer = JSON.parse(r.text);
    }

    // ---------- 로그인 ----------
    // 반환: {ok:true} | {mfa:true} — MFA 필요 시 submitMfa(code) 호출
    async login(email, password) {
      this.jar = {};
      await this.req('sso.garmin.com', '/sso/embed', { params: EMBED_PARAMS });
      const page = await this.req('sso.garmin.com', '/sso/signin', { params: SIGNIN_PARAMS });
      const csrf = this._csrf(page.text);
      const referer = `${SSO}/signin?` + qs(SIGNIN_PARAMS);
      const r = await this.req('sso.garmin.com', '/sso/signin', {
        method: 'POST', params: SIGNIN_PARAMS, referer,
        form: { username: email, password, embed: 'true', _csrf: csrf },
      });
      if (r.status === 429) throw new Error('시도가 너무 많았습니다. 잠시 후 다시 해주세요.');
      if (r.status === 401 || r.status === 403) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
      const title = (r.text.match(/<title>(.*?)<\/title>/i) || [])[1] || '';
      if (/MFA|verification/i.test(title) || /mfa-code/i.test(r.text)) {
        this.pendingMfa = { csrf: this._csrf(r.text), referer };
        return { mfa: true };
      }
      await this._finishLogin(r.text);
      return { ok: true };
    }

    async submitMfa(code) {
      if (!this.pendingMfa) throw new Error('MFA 대기 상태가 아닙니다.');
      const r = await this.req('sso.garmin.com', '/sso/verifyMFA/loginEnterMfaCode', {
        method: 'POST', params: SIGNIN_PARAMS, referer: this.pendingMfa.referer,
        form: {
          'mfa-code': code, embed: 'true',
          _csrf: this.pendingMfa.csrf, fromPage: 'setupEnterMfaCode',
        },
      });
      this.pendingMfa = null;
      await this._finishLogin(r.text);
      return { ok: true };
    }

    _csrf(html) {
      const m = html.match(/name="_csrf"\s+value="(.+?)"/);
      if (!m) throw new Error('로그인 페이지 분석 실패 (가민 측 변경 가능성)');
      return m[1];
    }

    async _finishLogin(html) {
      const m = html.match(/embed\?ticket=([^"]+)"/);
      if (!m) {
        if (/locked|잠금/i.test(html)) throw new Error('계정이 잠겨 있습니다. 가민 웹사이트에서 확인해 주세요.');
        throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
      }
      const ticket = m[1];
      await this._loadConsumer();
      // OAuth1 토큰 발급
      const preParams = {
        ticket,
        'login-url': SSO + '/embed',
        'accepts-mfa-tokens': 'true',
      };
      const preUrl = 'https://connectapi.garmin.com/oauth-service/oauth/preauthorized';
      const auth1 = await this._oauth1Header('GET', preUrl, preParams, null, null);
      const pre = await this.req('connectapi.garmin.com', '/oauth-service/oauth/preauthorized', {
        params: preParams, ua: UA_API, auth: auth1,
      });
      if (pre.status !== 200) throw new Error(`토큰 발급 실패 (${pre.status})`);
      const kv = Object.fromEntries(pre.text.split('&').map(p => p.split('=').map(decodeURIComponent)));
      if (!kv.oauth_token) throw new Error('토큰 응답 분석 실패');
      this.oauth1 = { token: kv.oauth_token, secret: kv.oauth_token_secret, mfaToken: kv.mfa_token || '' };
      this._save();
      await this._exchange();
    }

    async _exchange() {
      await this._loadConsumer();
      const url = 'https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0';
      const form = this.oauth1.mfaToken ? { mfa_token: this.oauth1.mfaToken } : {};
      const auth = await this._oauth1Header('POST', url, form, this.oauth1.token, this.oauth1.secret);
      const r = await this.req('connectapi.garmin.com', '/oauth-service/oauth/exchange/user/2.0', {
        method: 'POST', form, ua: UA_API, auth,
      });
      if (r.status !== 200) {
        if (r.status === 401) { this.logout(); throw new Error('연동이 만료되었습니다. 다시 로그인해 주세요.'); }
        throw new Error(`토큰 교환 실패 (${r.status})`);
      }
      const t = JSON.parse(r.text);
      this.oauth2 = {
        accessToken: t.access_token,
        expiresAt: Date.now() + (t.expires_in - 60) * 1000,
      };
    }

    // ---------- API ----------
    async api(path, params) {
      if (!this.oauth1) throw new Error('로그인이 필요합니다.');
      if (!this.oauth2 || Date.now() > this.oauth2.expiresAt) await this._exchange();
      const r = await this.req('connectapi.garmin.com', path, {
        params, ua: UA_API, auth: `Bearer ${this.oauth2.accessToken}`,
      });
      if (r.status === 401) { await this._exchange(); return this.api(path, params); }
      if (r.status !== 200) throw new Error(`가민 API 오류 (${r.status})`);
      return JSON.parse(r.text);
    }

    async getActivities(limit = 20) {
      const RUN_TYPES = new Set(['running', 'treadmill_running', 'trail_running', 'track_running',
        'indoor_running', 'virtual_run', 'street_running']);
      const acts = await this.api('/activitylist-service/activities/search/activities', { start: 0, limit });
      return acts.map(a => {
        const type = ((a.activityType || {}).typeKey || '').toLowerCase();
        return {
          id: a.activityId,
          name: a.activityName || '러닝',
          start: a.startTimeLocal || '',
          distanceKm: Math.round((a.distance || 0) / 10) / 100,
          durationSec: Math.round(a.duration || 0),
          avgHr: Math.round(a.averageHR || 0),
          cadence: Math.round(a.averageRunningCadenceInStepsPerMinute || 0),
          isRun: RUN_TYPES.has(type),
          type,
        };
      });
    }

    async getSplits(activityId) {
      const data = await this.api(`/activity-service/activity/${activityId}/splits`);
      const out = [];
      (data.lapDTOs || []).forEach((lap, i) => {
        const distM = lap.distance || 0, dur = lap.duration || 0;
        if (distM < 10 || dur <= 0) return;
        out.push({
          lap: i + 1,
          distanceKm: Math.round(distM / 10) / 100,
          paceSec: Math.round(dur / (distM / 1000)),
        });
      });
      return out;
    }
  }

  window.GarminWeb = GarminWeb;
})();
