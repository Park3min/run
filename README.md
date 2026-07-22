# RUN RECORD.

러닝 기록을 카운트업 애니메이션으로 보여주고, 사진 위에 기록을 워터마크처럼 새겨 저장하는 웹 앱.

![app](https://img.shields.io/badge/web-vanilla%20JS-c8f542) ![server](https://img.shields.io/badge/server-python-3776ab)

## 기능

- **기록 표시** — 총 거리·시간·페이스(자동 계산)·평균 심박·평균 케이던스를 카운트업 애니메이션으로 표시. 표시 항목은 선택 가능
- **구간(스플릿) 기록** — 1km 페이스 또는 랩 단위 바 차트
- **사진에 기록 새기기** — 사진 위에 기록 오버레이 (그라데이션/미니멀/카드 스타일, 드래그로 위치 조정), PNG 저장 및 인스타 스토리(9:16) 내보내기. 모바일에서는 공유 시트로 사진 저장
- **영상 캡처 모드** — 검정/크로마키/흰색 빈 배경에서 카운트업만 재생 (화면 녹화용)
- **가민 커넥트 연동** — 최근 활동을 불러와 자동 입력 (활동명·날짜·랩 포함)
  - 컴퓨터: 로컬 서버(`garmin_server.py`) 이용
  - 모바일/웹: Cloudflare Workers 중계(`cloudflare-worker.js`)를 통해 브라우저에서 직접 로그인, 토큰은 각 브라우저의 localStorage 에만 저장
- **Nike Run Club 캡처 인식** — NRC 결과 화면 스크린샷을 첨부하면 OCR(Tesseract.js)로 거리·시간·페이스·심박·케이던스를 인식해 자동 입력

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

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 앱 전체 (단일 파일, 의존성 없음) |
| `garmin_server.py` | 가민 커넥트 로컬 연동 서버 + 정적 서빙 |
