# 러닝로그 인수인계 문서

> 다른 Claude Code 계정·컴퓨터에서 이어서 작업할 때 이 문서부터 읽어 주세요.
> 새 세션에서는 "docs/HANDOFF.md 읽고 러닝로그 이어서 해 줘"라고 시작하면 돼요.
> 마지막 갱신: 2026-10-26

이 저장소는 **공개**예요. 이 문서에는 비밀번호·토큰·개인 연락처를 적지 않아요.

---

## 1. 지금 상태 한눈에

| 항목 | 상태 |
|---|---|
| 웹 | https://runlog.park3min.com — main 에 병합하면 Vercel 이 자동 배포 |
| 개인정보 처리방침 · 도움말 | `/privacy.html`, `/support.html` (공개 중, 앱·웹 맨 아래 링크) |
| 아이폰 앱 | `ios-app/` (Capacitor 8). App Store 이름 "러닝로그 - 매일의 러닝 기록", 번들 `com.park3min.runlog` |
| App Store | **1.0 (빌드 20261025.2320) 심사 제출함 (2026-10-26)** — 결과 대기 중 |
| TestFlight | 내부 시험용 1.0 (20261025.2255) 설치해 쓰는 중 (가민 연결 포함) |
| 마지막 PR | #40 (App Store 출시 준비) |

## 2. 다음에 할 일

1. **App Store 심사 결과 확인**
   - 통과 → 공개 여부·날짜 확인
   - 거절 → 해결 센터의 사유를 받아 고치고 `npm run appstore` 로 새 빌드 올린 뒤 재제출. 예상 사유:
     - 4.2 최소 기능(웹 감싼 앱) → 건강 앱 연동·사진 저장·공유 시트 등 네이티브 기능 설명
     - 5.1.1 개인정보 → 건강 데이터는 읽기만·기기 안에서만 쓴다고 답변
2. **개선 후보** (우선순위 순)
   1. ~~지도 여정 이미지에 1km 구간 페이스 미니 막대 (선택 옵션)~~ → 완료 (보기 옵션 '구간 페이스 막대', 기본 꺼짐)
   2. 기록이 있는 채로 다시 열면 3단계가 '사진 워터마크' 탭으로 열림 → 경로가 있으면 '지도 여정' 먼저
   3. 모바일 사파리에서 영상 저장 뒤 공유가 막힐 수 있음 → 녹화 뒤 '공유하기' 버튼을 한 번 더 누르게
   4. App Store 스크린샷에 사진 워터마크 장면 추가 (사진 자료 필요)

## 3. 작업 원칙 (사용자와 정한 것)

- **흐름**: 항상 feature 브랜치 → PR → 직접 병합 → 운영 반영 확인(curl). main 에 직접 커밋하지 않음. 커밋할 파일을 지정해서 add (`git add -A` 금지).
- **JS 캐시 버전**: `route-map.js`·`garmin-web.js` 를 고치면 `index.html` 의 `<script src="…?v=해시">` 를 그 파일 sha1 앞 8자로 바꿔요. 커스텀 도메인(Cloudflare)이 JS 를 4시간 캐시해서 안 바꾸면 앱이 깨져요.
- **개인정보**: 실제 GPS 좌표·가민 데이터는 저장소·PR·결과물에 넣지 않아요. 시험은 합성 데이터(`samples/runlog-sample.gpx` 같은 가상 경로)로. 실제 아이폰 건강 앱에 시험 데이터(`-seedHealthDemo`)를 넣지 않아요.
- **디자인**: 토스 미니앱 가이드 기준 — 해요체, '~해 주세요', '돼요', 버튼은 누른 결과가 보이는 말. 색은 토큰(`--accent #178a4c` 등)만, 라이트·다크 둘 다 확인, 360px 폭 가로 넘침 점검. 디자인 요청은 새 기능이 아니라 기존 화면 개선.
- **3D 지도**: 빠르면 어지러워요 → 천천히가 원칙.
- **자율 개선**: 사용자가 "스스로 개선해"라고 맡긴 프로젝트예요. 한 번에 하나씩 구현·검증·배포·짧게 보고. 다만 아래는 **먼저 물어봐요**: 인증·자격 증명 처리, 워커 보안(허용 출처), 방문자 데이터 삭제, 유료 서비스·API 키 도입, 도메인·DNS, 기존 기능 제거. 사용자가 지운 기능(이미지 OCR 캡처, 스트라바 연결)은 되살리지 않아요.
- **모르는 파일**: `subtitle-prototype.html` 은 사용자 파일이라 건드리지 않아요.

## 4. 구조

| 파일 | 역할 |
|---|---|
| `index.html` | 앱 전체 화면·로직 (3단계: 불러오기 → 기록 확인 → 내보내기) |
| `route-map.js` | GPX/TCX 파싱, 경로 분석, 2D/3D 지도 렌더러(WebGL 지형), 영상 녹화 |
| `garmin-web.js` | 가민 커넥트 웹 연동(중계 워커 경유, 비공식 로그인) |
| `cloudflare-worker.js` | 가민 중계 + 방문자 카운터 워커 (`garmin-proxy`) |
| `garmin_server.py` | 로컬 가민 연동 서버(개발용) |
| `privacy.html`, `support.html` | 개인정보 처리방침, 도움말 |
| `ios-app/` | 아이폰 앱 (아래) |

### 아이폰 앱 (`ios-app/`)
- 웹 파일을 `www/` 로 복사해 담는 Capacitor 앱. 웹을 고치면 `npm run sync` 로 반영.
- 네이티브 플러그인 (`ios/App/App/`, `RunlogViewController.capacitorDidLoad` 에서 등록 — 새 Swift 파일은 `project.pbxproj` 에 직접 추가해야 함):
  - `RunlogHealthPlugin` — 건강 앱 읽기(운동·경로·심박·걸음). 평균 심박이 없으면 심박 기록 평균, 걸음은 1분 합계로(아이폰·시계 중복 제거) 케이던스 계산. Debug 전용 `-seedHealthDemo YES` 로 시뮬레이터에 가상 러닝 주입.
  - `RunlogSharePlugin` — 영상·이미지를 iOS 공유 시트로 (웹 공유는 녹화 몇 초 뒤라 막힘).
- **앱 연결**(오른쪽 위 톱니): 건강 앱 / 가민 커넥트. '기록 가져오기' 하나로 연결한 앱의 러닝을 합쳐 보여 줌(가민↔건강 앱 같은 러닝은 가민 쪽 하나).
- **가민 연결은 출시 빌드에서 숨김**: 빌드 설정 `RUNLOG_GARMIN` (Info.plist `RunlogGarmin`). `npm run appstore` → NO, `npm run testflight` → YES. 가민 로그인은 비공식이라 심사 위험.
- 가민이 건강 앱에 넘기는 운동엔 운동 중 심박(최고·최저만)·GPS 경로가 없음 → 가민 연결 시 같은 러닝(시작 ±5분)을 가민에서 찾아 채움.

## 5. 자주 쓰는 명령

```bash
# 웹 로컬 확인
python3 -m http.server 5098            # 저장소 루트에서 → http://localhost:5098

# 아이폰 앱
cd ios-app && npm install              # 처음 한 번
npm run sync                           # 웹 파일 반영
npm run open                           # Xcode 로 열기
npm run testflight                     # 내부 시험용 빌드 업로드 (가민 포함)
npm run appstore                       # App Store 출시용 빌드 업로드 (가민 숨김)

# 실제 아이폰에 개발용 설치 (개발자 모드 켜고 케이블 연결)
xcrun devicectl list devices
cd ios-app/ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<기기 UDID>' -allowProvisioningUpdates -allowProvisioningDeviceRegistration build
xcrun devicectl device install app --device <UDID> <빌드된 App.app 경로>

# 중계 워커 배포 (cloudflare-worker.js 고쳤을 때만, Vercel 과 별개)
wrangler deploy
```

빌드 번호는 `YYYYMMDD.HHMM` 으로 자동이에요. 시뮬레이터는 iOS 27.0 런타임에서 만들어야 해요(27.1 은 기기 생성이 안 됐음).

## 6. 새 컴퓨터·계정에서 준비할 것

1. 저장소 받기: `git clone https://github.com/Park3min/run.git`
2. 로그인 (모두 사용자가 직접):
   - Xcode → Settings → Accounts 에 Apple 개발자 계정 (팀 P9GB897WB4) — 앱 빌드·업로드
   - `gh auth login` — PR 생성·병합
   - `wrangler login` — 중계 워커 배포 (워커 이름 `garmin-proxy`)
3. 아이폰을 연결하고 '이 컴퓨터를 신뢰'
4. Claude Code 메모를 옮기고 싶으면 이전 컴퓨터의 `~/.claude/projects/<프로젝트 경로>/memory/` 를 새 컴퓨터의 같은 위치로 복사 (없어도 이 문서로 충분해요)

## 7. 외부 서비스

| 서비스 | 쓰임 |
|---|---|
| Vercel | 웹 배포 (GitHub main 푸시 시 자동) |
| Cloudflare Workers `garmin-proxy` | 가민 중계, 방문자 카운터(KV `COUNTER`) |
| OpenStreetMap 타일 | 지도 (CARTO 는 2026 기준 API 키 필요라 안 씀) |
| AWS Terrain Tiles (Terrarium) | 3D 지형·지형 음영 |
| App Store Connect | 앱 이름 "러닝로그 - 매일의 러닝 기록" |

## 8. 기타 결과물 (사용자 컴퓨터의 다운로드 폴더, 저장소 밖)

- `~/Downloads/러닝로그_릴스/` — 인스타 릴스 30초 영상(다크·라이트·음악), 표지
- `~/Downloads/러닝로그_앱스토어/` — App Store 스크린샷(여러 크기), `앱스토어_입력내용.md`(설명·키워드·개인정보 라벨·심사 메모)
