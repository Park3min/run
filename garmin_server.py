#!/usr/bin/env python3
"""러닝 기록 카드 앱용 가민 커넥트 로컬 연동 서버.

사용법:
  1. pip install garminconnect  (최초 1회)
  2. python3 garmin_server.py
  3. 최초 실행 시 터미널에서 가민 계정으로 로그인 (MFA 지원)
     — 로그인 토큰은 ~/.garminconnect 에 저장되어 다음부터는 자동 로그인
  4. 앱(index.html)에서 "가민 커넥트에서 가져오기" 버튼 사용

이 서버는 localhost에서만 동작하며, 자격 증명은 가민 공식 서버로만 전송됩니다.
"""
import inspect
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

try:
    from garminconnect import Garmin
except ImportError:
    print("garminconnect 패키지가 필요합니다:  pip3 install garminconnect")
    sys.exit(1)


def masked_input(prompt: str) -> str:
    """입력한 글자 수만큼 * 를 표시하는 비밀번호 입력 (백스페이스 지원)."""
    if not sys.stdin.isatty():
        from getpass import getpass
        return getpass(prompt)
    try:
        import termios
        import tty
    except ImportError:  # 예외적 환경에서는 숨김 입력으로 대체
        from getpass import getpass
        return getpass(prompt)

    sys.stdout.write(prompt)
    sys.stdout.flush()
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    chars = []
    try:
        tty.setraw(fd)
        while True:
            ch = sys.stdin.read(1)
            if ch in ("\r", "\n"):
                break
            if ch == "\x03":  # Ctrl+C
                raise KeyboardInterrupt
            if ch in ("\x7f", "\b"):  # 백스페이스
                if chars:
                    chars.pop()
                    sys.stdout.write("\b \b")
                    sys.stdout.flush()
                continue
            if ch < " ":  # 기타 제어 문자는 무시
                continue
            chars.append(ch)
            sys.stdout.write("*")
            sys.stdout.flush()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)
        sys.stdout.write("\n")
        sys.stdout.flush()
    return "".join(chars)

PORT = int(os.environ.get("PORT", "5077"))
TOKEN_DIR = "~/.garminconnect"
APP_DIR = os.path.dirname(os.path.abspath(__file__))

RUN_TYPES = {"running", "treadmill_running", "trail_running", "track_running",
             "indoor_running", "virtual_run", "street_running"}


def get_client() -> Garmin:
    # 저장된 토큰으로 먼저 시도
    try:
        client = Garmin()
        client.login(TOKEN_DIR)
        print("저장된 토큰으로 로그인했습니다.")
        return client
    except Exception:
        pass

    print("가민 커넥트 로그인이 필요합니다. (자격 증명은 가민 서버로만 전송됩니다)")
    email = input("가민 이메일: ").strip()
    password = masked_input("가민 비밀번호: ")

    # 설치된 garminconnect 버전에 맞는 로그인 방식 사용
    new_api = "return_on_mfa" in inspect.signature(Garmin.__init__).parameters
    try:
        if new_api:
            client = Garmin(email=email, password=password, return_on_mfa=True)
            result1, result2 = client.login()
            if result1 == "needs_mfa":
                code = input("MFA 인증 코드: ").strip()
                client.resume_login(result2, code)
        else:
            # 구버전 API — MFA가 걸려 있으면 터미널에서 코드를 물어봅니다
            client = Garmin(email=email, password=password)
            client.login()
    except Exception as e:
        msg = str(e)
        print()
        if "401" in msg or "Unauthorized" in msg:
            print("✕ 로그인 실패: 이메일 또는 비밀번호가 올바르지 않습니다.")
        elif "429" in msg or "Too Many" in msg:
            print("✕ 로그인 실패: 시도가 너무 많았습니다. 잠시 후 다시 실행해 주세요.")
        else:
            print(f"✕ 로그인 실패: {msg[:300]}")
            print("  라이브러리 업데이트가 필요할 수 있습니다: pip3 install -U garminconnect garth")
        sys.exit(1)

    client.garth.dump(TOKEN_DIR)
    print(f"로그인 성공. 토큰을 {TOKEN_DIR} 에 저장했습니다.")
    return client


client = get_client()


def fmt_activity(a: dict) -> dict:
    type_key = ((a.get("activityType") or {}).get("typeKey") or "").lower()
    return {
        "id": a.get("activityId"),
        "name": a.get("activityName") or "러닝",
        "start": a.get("startTimeLocal") or "",
        "distanceKm": round((a.get("distance") or 0) / 1000, 2),
        "durationSec": round(a.get("duration") or 0),
        "avgHr": round(a.get("averageHR") or 0),
        "cadence": round(a.get("averageRunningCadenceInStepsPerMinute") or 0),
        "isRun": type_key in RUN_TYPES,
        "type": type_key,
    }


def get_activities(limit: int) -> list:
    acts = client.get_activities(0, limit)
    return [fmt_activity(a) for a in acts]


def get_splits(activity_id: str) -> list:
    data = client.get_activity_splits(activity_id)
    laps = data.get("lapDTOs") or []
    out = []
    for i, lap in enumerate(laps):
        dist_m = lap.get("distance") or 0
        dur = lap.get("duration") or 0
        if dist_m < 10 or dur <= 0:
            continue  # 의미 없는 0m 랩 제외
        out.append({
            "lap": i + 1,
            "distanceKm": round(dist_m / 1000, 2),
            "paceSec": round(dur / (dist_m / 1000)),
        })
    return out


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        # 로컬 파일(file://)에서 열린 앱도 접근할 수 있도록 허용
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # 조용히

    def do_GET(self):
        url = urlparse(self.path)
        try:
            if url.path in ("/", "/index.html"):
                try:
                    with open(os.path.join(APP_DIR, "index.html"), "rb") as f:
                        body = f.read()
                except FileNotFoundError:
                    self._send(404, {"error": "index.html not found"})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif url.path == "/activities":
                limit = int(parse_qs(url.query).get("limit", ["20"])[0])
                self._send(200, {"activities": get_activities(min(limit, 50))})
            elif url.path.startswith("/activity/") and url.path.endswith("/splits"):
                activity_id = url.path.split("/")[2]
                self._send(200, {"splits": get_splits(activity_id)})
            elif url.path == "/ping":
                self._send(200, {"ok": True})
            else:
                self._send(404, {"error": "not found"})
        except Exception as e:  # 토큰 만료 등
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    print(f"서버 실행 중 — 브라우저에서 열기:  http://localhost:{PORT}")
    print("종료: Ctrl+C")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
