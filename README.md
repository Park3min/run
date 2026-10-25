# 러닝로그

러닝 기록을 카운트업 애니메이션으로 보여주고, 사진 위에 기록을 워터마크처럼 새겨 저장하는 웹 앱.

![app](https://img.shields.io/badge/web-vanilla%20JS-c8f542) ![server](https://img.shields.io/badge/server-python-3776ab)

## 기능

- **3단계 진행** — ① 불러오기 → ② 기록 확인 → ③ 내보내기를 한 화면씩 [다음 단계]로 진행. 입력 칸·구간 기록·세부 옵션은 접혀 있다가 필요할 때 펼침 ('기록 고치기')
- **기록 표시** — 총 거리·시간·페이스(자동 계산)·평균 심박·평균 케이던스·상승 고도(선택)를 카운트업 애니메이션으로 표시. 심박·케이던스는 0 에서 세지 않고 거리가 차오르는 동안 그 지점의 값을 보여 준 뒤 평균으로 끝남(거리별 기록이 있을 때). 표시 항목은 선택 가능
- **구간(스플릿) 기록** — 1km 페이스 또는 랩 단위 바 차트
- **사진에 기록 새기기** — 사진 위에 기록 오버레이 (그라데이션/미니멀/카드 스타일, 드래그로 위치 조정), PNG 저장 및 인스타 스토리(9:16) 내보내기. 모바일에서는 공유 시트로 사진 저장
- **지도 여정** — GPS 경로를 지도 위에 그리며 따라가는 애니메이션. 페이스별 색(빠름 연두 → 느림 빨강), km 표시, 거리·시간이 함께 차오름. **2D**(위에서 내려다봄, 지형 음영 선택) 또는 **3D**(달리는 방향을 따라가는 입체 카메라 · 실제 지형 높낮이와 음영, 언덕에 가린 경로는 흐리게, 2D 보다 두 배 천천히) 선택. 다크/라이트/컬러/지도 없음 · 1:1/4:5/9:16 · **MP4 영상**과 이미지로 저장(영상 저장이 안 되는 브라우저는 전체 화면 재생 → 화면 녹화). 출발·도착 200m 가리기로 집 위치 노출 방지
- **카운트업** — 검정/크로마키/흰색 빈 배경에서 숫자 카운트업만 재생 (화면 녹화용)
- **가민 커넥트 연동** — 최근 활동을 불러와 자동 입력 (활동명·날짜·랩·GPS 경로·거리별 심박/케이던스·상승 고도 포함, 목록에 GPS 유무 표시)
  - 컴퓨터: 로컬 서버(`garmin_server.py`) 이용
  - 모바일/웹: Cloudflare Workers 중계(`cloudflare-worker.js`)를 통해 브라우저에서 직접 로그인, 토큰은 각 브라우저의 localStorage 에만 저장
- **GPX · TCX 불러오기** (보조 기능) — 가민 커넥트·스트라바 웹에서 내려받은 경로 파일로 거리·이동시간(정지 구간 제외)·날짜·시작 시각·평균 심박·케이던스·1km 구간을 자동 입력하고 지도 여정까지 한 번에

## 실행

### 웹 앱만 쓰기

`index.html` 을 브라우저에서 열면 됩니다. 별도 설치 불필요. (가민 연동 버튼 제외한 모든 기능 동작)

### 가민 커넥트 연동까지 쓰기

```bash
python3 -m venv .venv
./.venv/bin/pip install garminconnect
./.venv/bin/python3 garmin_server.py
```

브라우저에서 http://localhost:5077 접속. 최초 1회 터미널에서 가민 계정 로그인(MFA 지원, 비밀번호는 `*` 마스킹)하면 토큰이 `~/.garminconnect` 에 저장되어 이후 자동 로그인됩니다.

> 가민 연동은 커뮤니티 라이브러리([garminconnect](https://github.com/cyberjunky/python-garminconnect))를 사용합니다. 자격 증명은 가민 서버로만 전송되며, 서버는 localhost 에서만 동작합니다.

### 아이폰 앱 (`ios-app/`)

웹 코드(`index.html`·`route-map.js`·`garmin-web.js`)를 그대로 담은 [Capacitor](https://capacitorjs.com) 앱입니다. 웹에는 없는 기능:

- **건강 앱에서 가져오기** — 애플워치 등으로 기록한 러닝의 거리·시간·GPS 경로·심박·걸음 수(케이던스)를 HealthKit 으로 읽어요 (`RunlogHealthPlugin.swift`).
- **공유 시트로 저장** — 지도 영상·이미지를 앱이 직접 iOS 공유 시트로 넘겨 '비디오/이미지 저장'·인스타그램으로 보내요 (`RunlogSharePlugin.swift`). 웹 공유는 영상을 만드는 몇 초 사이 막히기 때문.
- 가민 중계·방문자 수 요청은 앱의 네이티브 HTTP(`CapacitorHttp`)로 보내 CORS 제한을 받지 않아요.

```bash
cd ios-app
npm install
npm run sync      # 루트 웹 파일을 www/ 로 복사 → iOS 프로젝트에 반영 (웹 코드를 고친 뒤마다)
npm run open      # Xcode 로 열기 → 실행
```

개발 빌드(Debug)에서 `-seedHealthDemo YES` 인자로 실행하면 시뮬레이터 건강 앱에 가상의 남산 러닝 기록(경로·심박·걸음 포함)과 실내 러닝 1개를 넣어 시험할 수 있어요.

```bash
xcrun simctl launch booted com.park3min.runlog -seedHealthDemo YES
```

#### 테스트플라이트에 올리기

1. (처음 한 번) [App Store Connect](https://appstoreconnect.apple.com) → 앱 → **+ 신규 앱** — 번들 ID `com.park3min.runlog`, 기본 언어 한국어
2. `cd ios-app && npm run testflight` — 웹 파일 반영 → 릴리스 아카이브 → 업로드 (빌드 번호는 날짜·시각으로 자동)
3. App Store Connect → TestFlight 에서 처리(10~30분)가 끝나면 내부 테스터에 추가 → 아이폰 TestFlight 앱에서 설치

웹 코드를 고친 뒤 앱에도 반영하려면 2번만 다시 실행하면 돼요. 암호화 규정 답변은 `ITSAppUsesNonExemptEncryption=false` 로 자동 처리돼요.

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 앱 화면·기록·사진·카운트업 (의존성 없음) |
| `route-map.js` | 지도 여정 — GPX/TCX 파싱, 경로 분석, 캔버스 지도 렌더러, 영상 녹화 |
| `garmin_server.py` | 가민 커넥트 로컬 연동 서버 + 정적 서빙 |
