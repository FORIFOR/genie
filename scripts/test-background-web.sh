#!/usr/bin/env bash
# Two disposable apps and a loopback-only static server; no real browser profile.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(cd "$(mktemp -d /tmp/genie-background-web.XXXXXX)" && pwd -P)"
chmod 700 "$WORK"
WEB_PID='' SENTINEL_PID='' SERVER_PID=''
cleanup() {
  [[ -z "$WEB_PID" ]] || kill "$WEB_PID" 2>/dev/null || true
  [[ -z "$SENTINEL_PID" ]] || kill "$SENTINEL_PID" 2>/dev/null || true
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT
cat > "$WORK/server.mjs" <<'JS'
import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.argv[2],counts={};
const server=createServer((request,response)=>{
  const path=request.url;
  counts[path]=(counts[path]??0)+1;
  writeFileSync(join(root,'requests.json'),JSON.stringify(counts));
  response.setHeader('Content-Type','text/html; charset=utf-8');
  response.setHeader('Cache-Control','no-store');
  response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'");
  const port=server.address().port;
  const body=path==='/first'
    ? `<h1>Fixture first page</h1><p><a href="/second">Read fixture details</a></p><p><a href="http://localhost:${port}/second">Forbidden different origin</a></p><p><a href="/first">Forbidden unchanged URL</a></p><p><a href="/blocked">Navigation deliberately blocked</a></p>`
    : path==='/second' ? '<h1>Fixture details page</h1><p>Native background link navigation reached this page once.</p>' : '<h1>Not found</h1>';
  response.statusCode=['/first','/second'].includes(path)?200:404;
  response.end(`<!doctype html><html><head><title>${path==='/second'?'Fixture details page':'Fixture first page'}</title><style>body{font:22px system-ui;margin:32px}p{margin:26px 0}a{color:#005fc4}</style></head><body>${body}</body></html>`);
});
server.listen(0,'127.0.0.1',()=>writeFileSync(join(root,'port'),String(server.address().port)));
JS
node "$WORK/server.mjs" "$WORK" > "$WORK/server.log" 2>&1 & SERVER_PID=$!
for _ in {1..100}; do [[ -f "$WORK/port" ]] && break; sleep 0.05; done
WEB_URL="http://127.0.0.1:$(cat "$WORK/port")/first"
swiftc -j 1 "$ROOT/tools/computer-use/BackgroundWebFixture.swift" -o "$WORK/WebFixture" > "$WORK/web-build.log" 2>&1
swiftc -j 1 "$ROOT/tools/computer-use/BackgroundFixture.swift" -o "$WORK/Fixture" > "$WORK/fixture-build.log" 2>&1
swiftc -j 1 -D GENIE_BACKGROUND_TEST -parse-as-library \
  "$ROOT/tools/computer-use/genie-computer.swift" "$ROOT/tools/computer-use/GeneratedPointerMetrics.swift" \
  "$ROOT/tools/computer-use/PrivateSPIBridge.swift" "$ROOT/tools/computer-use/BackgroundNativeInput.swift" \
  "$ROOT/tools/computer-use/BackgroundTextEdit.swift" "$ROOT/tools/computer-use/BackgroundScroll.swift" \
  "$ROOT/tools/computer-use/BackgroundWebLink.swift" "$ROOT/tools/computer-use/TargetPreview.swift" \
  "$ROOT/tools/computer-use/BackgroundAX.swift" "$ROOT/tools/computer-use/BackgroundWebTests.swift" \
  -o "$WORK/Verify" > "$WORK/build.log" 2>&1
for role in webfixture sentinel; do
  app="$WORK/GenieBackground-$role.app"
  mkdir -p "$app/Contents/MacOS"
  binary=Fixture; [[ "$role" != webfixture ]] || binary=WebFixture
  cp "$WORK/$binary" "$app/Contents/MacOS/Fixture"
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.genie.background.$role</string><key>CFBundleName</key><string>Genie Background $role</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>
PLIST
  if [[ "$role" == webfixture ]]; then
    GENIE_WEB_URL="$WEB_URL" GENIE_WEB_RESULT="$WORK/target.json" "$app/Contents/MacOS/Fixture" > "$WORK/web.log" 2>&1 & WEB_PID=$!
  else
    GENIE_FIXTURE_PASSIVE=1 GENIE_FIXTURE_ROLE=sentinel GENIE_FIXTURE_RESULT="$WORK/sentinel.json" "$app/Contents/MacOS/Fixture" > "$WORK/sentinel.log" 2>&1 & SENTINEL_PID=$!
  fi
done
node --input-type=module - "$WORK" <<'JS'
import {readFileSync} from 'node:fs';import {join} from 'node:path';
const dir=process.argv[2];let ready=false;
for(let i=0;i<100;i++) {try {const data=JSON.parse(readFileSync(join(dir,'target.json')));readFileSync(join(dir,'sentinel.json'));if(data.navigations===1&&!data.loading){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
if(!ready)throw Error('Owned WebKit fixture failed to load its loopback page');
JS
printf 'Evidence: %s\n' "$WORK"
"$WORK/Verify" "$WEB_PID" "$WORK" "$WEB_URL"
