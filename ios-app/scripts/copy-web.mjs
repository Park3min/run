// 저장소 루트의 웹 파일을 www/ 로 복사한다 (앱은 이 사본을 번들로 담는다)
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..', '..');
const out = path.resolve(import.meta.dirname, '..', 'www');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'route-map.js', 'garmin-web.js']) fs.copyFileSync(path.join(root, f), path.join(out, f));
console.log('copied web files →', out);
