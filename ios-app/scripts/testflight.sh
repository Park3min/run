#!/bin/bash
# 테스트플라이트에 올리기: 루트 웹 파일 반영 → 릴리스 아카이브 → 앱스토어 커넥트 업로드
# Xcode 에 로그인된 애플 계정(팀 P9GB897WB4)으로 서명·업로드한다. 빌드 번호는 날짜·시각으로 자동.
#   bash scripts/testflight.sh            내부 시험용 — 가민 연결 포함
#   bash scripts/testflight.sh appstore   App Store 출시용 — 가민 연결 숨김 (심사에 낼 빌드)
set -euo pipefail
MODE=${1:-internal}
GARMIN=YES; [ "$MODE" = "appstore" ] && GARMIN=NO
cd "$(dirname "$0")/.."
npm run sync
BUILD=$(date +%Y%m%d.%H%M)
OUT=$(mktemp -d)
xcodebuild archive -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Runlog.xcarchive" \
  -allowProvisioningUpdates CURRENT_PROJECT_VERSION="$BUILD" RUNLOG_GARMIN="$GARMIN" | grep -E "error:|ARCHIVE"
xcodebuild -exportArchive -archivePath "$OUT/Runlog.xcarchive" -exportPath "$OUT/export" \
  -exportOptionsPlist scripts/ExportOptions-upload.plist -allowProvisioningUpdates | grep -E "error|EXPORT|Upload"
[ "$GARMIN" = NO ] && KIND="App Store 출시용(가민 연결 숨김)" || KIND="내부 시험용(가민 연결 포함)"
echo "올렸어요 — $KIND · 버전 $(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$OUT/Runlog.xcarchive/Info.plist") (빌드 $BUILD). 앱스토어 커넥트에서 처리되면(10~30분) 테스트플라이트에 나타나요."
