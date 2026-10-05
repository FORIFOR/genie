#!/usr/bin/env bash
# 安定 C ABI を C から実際に叩き、断片ファイルが書かれることを確かめる。
# Windows(C#/P-Invoke) が使うのと同じ境界を、このホスト(clang)で実証する（build 未検証の Windows とは別）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/build-resource-env.sh"
CORE="$ROOT/core/genie-core"
# 版は package.json 1 か所から取る（Cargo.toml と一致することは verify-release-consistency が見る）。
VERSION="$(node -p "require('$ROOT/package.json').version")"
cd "$CORE"; cargo build --quiet
LIBDIR="$CORE/target/debug"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/t.c" <<'C'
#include "genie_core.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/stat.h>
int main(int argc, char** argv) {
    char* v = genie_core_version();
    if (strcmp(v, EXPECT_VERSION) != 0) { printf("CABI_FAIL version=%s (want %s)\n", v, EXPECT_VERSION); return 2; }
    genie_core_string_free(v);

    /* connector: PKCE (RFC 7636 test vector) + authorize URL */
    char* chal = genie_core_pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    if (strcmp(chal, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM") != 0) { printf("CABI_FAIL pkce=%s\n", chal); return 20; }
    char* url = genie_core_authorize_url("google", "cid-1", "http://127.0.0.1:8123/cb", "openid email", "st-1", chal);
    if (!url || strstr(url, "code_challenge_method=S256") == NULL || strstr(url, "state=st-1") == NULL) { printf("CABI_FAIL authorize_url=%s\n", url ? url : "NULL"); return 21; }
    char* bad = genie_core_authorize_url("google", "cid", "https://evil.example/cb", "", "s", "c");
    if (bad != NULL) { printf("CABI_FAIL non-loopback accepted\n"); return 22; }
    char* cb = genie_core_parse_callback("/callback?code=abc&state=xyz");
    if (!cb || strstr(cb, "\"code\":\"abc\"") == NULL || strstr(cb, "\"state\":\"xyz\"") == NULL) { printf("CABI_FAIL parse_callback=%s\n", cb ? cb : "NULL"); return 23; }
    genie_core_string_free(cb);
    printf("CABI_OK connector: pkce=S256 authorizeUrl ok nonLoopbackRejected parseCallback ok\n");
    genie_core_string_free(chal);
    genie_core_string_free(url);

    /* gateway API 縦断（実バックエンド）。届かなければ skip（CI 等）。 */
    const char* base = getenv("ASTRA_GATEWAY_URL");
    if (!base || !*base) base = "http://127.0.0.1:3000";
    if (genie_core_api_reachable(base) == 1) {
        char* toks = genie_core_api_dev_sign_in(base, "cabi-selftest@astra.local", "CABI");
        if (!toks || strstr(toks, "access_token") == NULL) { printf("CABI_FAIL api sign_in\n"); return 30; }
        /* access_token を JSON から素朴に取り出す。 */
        char at[2048]; at[0] = 0;
        const char* k = strstr(toks, "\"access_token\":\"");
        if (k) { k += strlen("\"access_token\":\""); const char* e = strchr(k, '\"');
                 if (e && (size_t)(e-k) < sizeof(at)) { memcpy(at, k, e-k); at[e-k] = 0; } }
        if (at[0] == 0) { printf("CABI_FAIL api access_token\n"); return 31; }
        char* me = genie_core_api_me(base, at);
        if (!me || strstr(me, "owner") == NULL) { printf("CABI_FAIL api me=%s\n", me?me:"NULL"); return 32; }
        char* mid = genie_core_api_create_meeting(base, at, "CABI 会議", "ja-JP");
        if (!mid || strlen(mid) == 0) { printf("CABI_FAIL api create_meeting\n"); return 33; }
        char* task = genie_core_api_create_task(base, at, "echo", "{\"message\":\"cabi\",\"steps\":1}");
        if (!task || strlen(task) == 0) { printf("CABI_FAIL api create_task\n"); return 34; }
        char* st = genie_core_api_wait_task(base, at, task, 15000);
        if (!st || strstr(st, "COMPLETED") == NULL) { printf("CABI_FAIL api wait_task=%s\n", st?st:"NULL"); return 35; }
        char* apps = genie_core_api_plugin_catalog(base, at);
        char* lib = genie_core_api_library(base, at);
        if (!apps || !lib) { printf("CABI_FAIL api apps/library\n"); return 36; }
        printf("CABI_OK api: me=owner meeting=ok agent=COMPLETED apps=%s... library=%s...\n",
               apps[0]=='['?"[":"?", lib[0]=='['?"[":"?");
        genie_core_string_free(toks); genie_core_string_free(me); genie_core_string_free(mid);
        genie_core_string_free(task); genie_core_string_free(st);
        genie_core_string_free(apps); genie_core_string_free(lib);
    } else {
        printf("CABI_SKIP api: gateway not reachable (%s)\n", base);
    }

    const char* root = argv[1];
    CApiSession* s = genie_core_session_start(root, "cabi");
    if (!s) { printf("CABI_FAIL start\n"); return 3; }
    float* frame = malloc(sizeof(float) * 16000);
    for (int i = 0; i < 16000; i++) frame[i] = 0.1f;
    unsigned closed = 0;
    for (int sec = 0; sec < 6; sec++) closed += genie_core_session_push(s, frame, 16000, 16000);
    free(frame);
    unsigned long long ms = genie_core_session_recorded_ms(s);
    if (genie_core_session_finish(s) != 0) { printf("CABI_FAIL finish\n"); return 4; }
    genie_core_session_free(s);

    char path[1024]; snprintf(path, sizeof(path), "%s/cabi/mic/000001.pcm", root);
    struct stat st;
    if (closed != 1 || ms != 5000 || stat(path, &st) != 0 || st.st_size <= 0) {
        printf("CABI_FAIL closed=%u ms=%llu size=%lld\n", closed, ms, (long long)(stat(path,&st)==0?st.st_size:-1));
        return 5;
    }
    int marked = genie_core_mark_meeting_uploaded(root, "cabi");
    if (marked != 1) { printf("CABI_FAIL mark_uploaded=%d\n", marked); return 6; }
    printf("CABI_OK closed=%u ms=%llu fragmentBytes=%lld markedUploaded=%d\n", closed, ms, (long long)st.st_size, marked);
    return 0;
}
C
OUTDIR="$TMP/rec"; mkdir -p "$OUTDIR"
# SDK を選ぶ。既定（xcrun が返す Command Line Tools の SDK）でリンクできないことがある
# （macOS 27 の SDK の .tbd に、いまのリンカが読めない arm64e.x1 が入っている）。そのときだけ
# Xcode に同梱の SDK を使う。検査の中身（C の境界を往復する）は変えない。GENIE_MACOS_SDK で指定もできる。
SYSROOT=()
if [[ -n "${GENIE_MACOS_SDK:-}" ]]; then
  SYSROOT=(-isysroot "$GENIE_MACOS_SDK")
else
  printf 'int main(void){return 0;}' > "$TMP/probe.c"
  if ! clang "$TMP/probe.c" -o "$TMP/probe" 2>/dev/null; then
    XSDK="$(xcode-select -p 2>/dev/null)/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
    if [[ -d "$XSDK" ]] && clang -isysroot "$XSDK" "$TMP/probe.c" -o "$TMP/probe" 2>/dev/null; then
      SYSROOT=(-isysroot "$XSDK")
      echo "note: default SDK cannot link here; using $XSDK" >&2
    fi
  fi
fi
clang "${SYSROOT[@]}" -DEXPECT_VERSION="\"$VERSION\"" "$TMP/t.c" -I "$CORE/include" -L "$LIBDIR" -lgenie_core -o "$TMP/t"
OUT="$("$TMP/t" "$OUTDIR")"
echo "$OUT"
[[ "$OUT" == CABI_OK* ]] || { echo "FAIL: C ABI round trip" >&2; exit 1; }
