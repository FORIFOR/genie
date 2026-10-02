import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const base = process.env.GENIE_VISION_TEST_DIST
  ? pathToFileURL(path.resolve(process.env.GENIE_VISION_TEST_DIST) + '/').href
  : new URL('../dist/', import.meta.url).href;
const { visionPromptFor } = await import(new URL('computer-vision-prompts.js', base));

test('background planning uses empty-field AX input, not focus or keyboard fallback', () => {
  const prompt=visionPromptFor('llm.plan_computer_action',{goal:'fill draft',observation:{deliveryMode:'background'}});
  assert.match(prompt,/EMPTY editable native field/);
  // キーの押下／解放は背景でも届くようになった。守り続けるのは前面化・ドラッグ・
  // クリップボードを使わないことと、フォーカス済みを前提にしないこと。
  assert.match(prompt,/Horizontal scrolling, drag and clipboard are unsupported/);
  assert.match(prompt,/Never request foreground activation/);
  assert.match(prompt,/must not be replaced with a foreground action/);
  /*
   * `type_keys` が**本物の打鍵**であること。9/20 に文面を書き直したとき、
   * この行だけ古い言い回しを探したままになっていて落ちていた。
   * 見るべきは言い回しではなく、モデルに伝わる中身のほう——
   * 物理キーであること、入力方式を通ること、値の設定とは別物であること。
   */
  assert.match(prompt,/real keystrokes/);
  assert.match(prompt,/physical keys pass through the target's input method/);
  assert.doesNotMatch(prompt,/MUST already be focused/);
  const legacy=visionPromptFor('llm.plan_computer_action',{goal:'fill draft'});
  assert.match(legacy,/MUST already be focused/);
});

test('background helper cannot call shared input/clipboard or legacy focus helpers',async()=>{
  const source=await readFile(new URL('../../../tools/computer-use/BackgroundAX.swift',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\.post\(|\.postToPid\(|keyboardSetUnicodeString|CGWarpMouseCursorPosition|setString\(|clearContents\(/);
  assert.doesNotMatch(source,/Helper\.(restore|rescopeActivating|selectTarget|canType|secureFocus|respond)\(/);
  assert.match(source,/AXUIElementPerformAction/);assert.match(source,/AXUIElementSetAttributeValue/);
  assert.match(source,/event\.cgEvent\?\.location/);
  assert.doesNotMatch(source,/try\? privateFile\(Data\("human_takeover"/);
});

/*
 * 見張りの抑止窓。**静的な検査**で、実際に人が触った実行時の証拠ではない。
 *
 * 以前は、こちらが操作している 2 秒の間、**理由を問わず**割り込みを落としていた。
 * つまり操作中に人が対象を押しても無かったことになっていた——人の操作を奪わない
 * ための見張りが、いちばん奪いやすい瞬間だけ目を閉じていた。
 * 除いてよいのは、こちらの focusWithoutRaise が生む `target-activated` だけ。
 */
test('自分が出した分だけを除く（人の入力は抑止窓の中でも数える）',async()=>{
  const source=await readFile(new URL('../../../tools/computer-use/BackgroundAX.swift',import.meta.url),'utf8');
  assert.match(source,/func selfInflicted\(_ reason: String\) -> Bool \{[\s\S]{0,80}?guard reason == "target-activated" else \{ return false \}/);
  // 抑止の判断は selfInflicted の中だけ。interrupted() が直接 .acting を見ないこと。
  const body=source.slice(source.indexOf('func interrupted('),source.indexOf('let observer='));
  assert.doesNotMatch(body,/\.acting/);
  // 人の手が動いた時刻は、止めるかどうかに関わらず残す（再開の判断に要る）。
  assert.match(body,/markHumanInput\(path\)/);
  // 世代を先に進めてから印を置く。逆だと古い世代の操作が 1 つ通り抜けうる。
  assert.match(body,/try advanceEpoch\(path\)[\s\S]{0,40}?try privateFile\(Data\("human_takeover/);
});

test('再開は必ず実行世代を進め、明示的な停止は再開しない',async()=>{
  const source=await readFile(new URL('../../../tools/computer-use/BackgroundAX.swift',import.meta.url),'utf8');
  const resume=source.slice(source.indexOf('if request.op == "resume"'),source.indexOf('if request.op == "begin"'));
  assert.match(resume,/session_stopped/);
  assert.match(resume,/human_active/);
  assert.match(resume,/try advanceEpoch\(path\)/);
  // 人を前面から退かす・対象を上げるといった操作を再開経路に持たない。
  assert.doesNotMatch(resume,/activate\(|unhide\(|orderFront|\.hide\(/);
});

test('送る前の関門は、承認・対象・停止に加えて実行世代を見る',async()=>{
  const source=await readFile(new URL('../../../tools/computer-use/BackgroundAX.swift',import.meta.url),'utf8');
  assert.match(source,/func current\(\) throws -> Target \{[\s\S]*?stale_generation/);
  /*
   * apply 経路で permitted を直に呼ぶのは `current()` の中の 1 か所だけ。
   * ほかに素の permitted が残っていると、そこだけ世代を見ない関門になる。
   */
  const start=source.indexOf('guard ["apply", "preview_target"].contains(request.op)');
  assert.ok(start >= 0, 'apply and preview share the authority guard');
  const apply=source.slice(start);
  assert.equal(apply.match(/permitted\(f,\s*dir:\s*dir\)/g)?.length,1);
  const guardBody=apply.slice(apply.indexOf('func current()'),apply.indexOf('let t=try current()'));
  assert.match(guardBody,/permitted\(f,\s*dir:\s*dir\)/);
  assert.match(apply,/snapshot\.frame\.backgroundEpoch == f\.backgroundEpoch/);
  // 1 打ごとの確認も同じ物差しを使う。
  assert.match(apply,/func inputStillAllowed\(\) -> Bool[\s\S]*?try\? current\(\)/);
  assert.match(apply,/func inputStillAllowed\(\) -> Bool[\s\S]*?keyWindowIsTarget\(t\)/);
  assert.equal((apply.match(/stillAllowed: inputStillAllowed/g) ?? []).length, 2);
});

/*
 * 反復試験のためだけの無人経路が、**出荷する実行ファイルに混ざらない**こと。
 * 静的な検査で、実行時の証拠ではない。
 */
test('無人試験の経路は出荷ビルドに入らない',async()=>{
  const source=await readFile(new URL('../../../tools/computer-use/BackgroundAX.swift',import.meta.url),'utf8');
  // 経路そのものは条件付きコンパイルの中にしかない。
  const guarded=source.slice(source.indexOf('#if GENIE_UNATTENDED_TEST'),source.indexOf('#endif',source.indexOf('#if GENIE_UNATTENDED_TEST')));
  assert.match(guarded,/unattended-test-target/);
  // 対象名を読む場所は 1 か所だけ（もう 1 件は止まった段階を残す stage の文字列）。
  assert.equal(source.match(/appendingPathComponent\("unattended-test-target"\)/g).length,1);
  // 出荷ビルドの手順はこの旗を定義しない。
  const ship=await readFile(new URL('../../../scripts/build-computer-helper.sh',import.meta.url),'utf8');
  assert.doesNotMatch(ship,/GENIE_UNATTENDED_TEST/);
  // 試験用ビルドは別名・別の出力先で、印を自分で確かめてから終わる。
  const test=await readFile(new URL('../../../scripts/build-computer-helper-unattended-test.sh',import.meta.url),'utf8');
  assert.match(test,/-D GENIE_UNATTENDED_TEST/);
  assert.match(test,/genie-computer-unattended-test/);
  assert.match(test,/unattendedTest":true/);
  // 出力先が本番と同じ `.build/computer` でないこと（`-` で始まる別名は可）。
  assert.doesNotMatch(test,/\.build\/computer(?![-\w])/);
  /*
   * 省いてよいのは対象を選ぶ操作だけ。許可を書いて見張りを立てる部分は
   * 本番と同じ `establish` を通る（別経路に複製されていないこと）。
   */
  assert.equal(source.match(/try privateFile\(JSONEncoder\(\)\.encode\(grant\),path\)/g).length,1);
  assert.match(guarded,/return try await establish\(hits\[0\], dir: dir, recipient: request\.recipient\)/);
  // 伏せ字を扱うアプリを除く一覧は、同意経路と共有していること。
  assert.equal(source.match(/com\.1password/g).length,1);
  /*
   * 目的の語から窓を自動で選ぶ経路は、試験用ビルドの中にだけある。出荷ビルドでそれが動くと、
   * 選択ダイアログ（対象と画像の送信先を人に見せる唯一の画面）が一度も出ない。
   */
  const shipped=source.replace(/#if GENIE_UNATTENDED_TEST[\s\S]*?#endif/g,'');
  assert.doesNotMatch(shipped,/autoResolveTargetWindow/);
  const select=shipped.slice(shipped.indexOf('static func select('),shipped.indexOf('static func respond('));
  // 出荷ビルドの select が対象を決めるのは、生きた許可の引き継ぎか、選択ダイアログの答えだけ。
  assert.equal(select.match(/establish\(/g).length,1);
  assert.ok(select.indexOf('establish(')>select.indexOf('alert.runModal()'));
  // ダイアログは送信先を内部の種別名でなく、提供元の名前で見せる（前面の選択ダイアログと同じ対応表）。
  assert.match(select,/画像の送信先: \\\(imageDestinationLabel\(request\.recipient\)\)/);
});

test('背景で失敗しても前面操作へ切り替えない（経路の取り違えを静的に禁じる）',async()=>{
  const source=await readFile(new URL('../../../tools/computer-use/BackgroundAX.swift',import.meta.url),'utf8');
  // 前面化・可視化・最前面化を行う既存ヘルパーを、この経路から一切呼ばない。
  assert.doesNotMatch(source,/Helper\.(restore|reveal|rescopeActivating|activate)\(/);
  // rescope は「明かさない・前面に出さない」版だけ。
  assert.match(source,/Helper\.rescope\(frame\).*Does not reveal, unhide, raise or activate/);
});

test('append retains native current-value binding and exact post-write readback without enabling replacement',async()=>{
  const source=await readFile(new URL('../../../tools/computer-use/BackgroundAX.swift',import.meta.url),'utf8');
  assert.match(source,/digest\(Data\(currentValue\.utf8\)\) == chosen\?\.valueHash/);
  assert.match(source,/BackgroundTextEdit\.value\(current: currentValue, text: text, mode: a\.textMode\)/);
  assert.match(source,/describe\(element, path: chosen\.path, bounds: t\.bounds\) != chosen/);
  assert.match(source,/describe\(targetElement,path:expected\.path,bounds:t\.bounds\) == expected/);
  assert.match(source,/AXUIElementSetAttributeValue\(targetElement,kAXValueAttribute as CFString,valueForInput! as CFString\)/);
  assert.match(source,/string\(element!,kAXValueAttribute\) == valueForInput/);
  assert.match(source,/"elementRole": selected\.role/);
  const legacy=await readFile(new URL('../../../tools/computer-use/genie-computer.swift',import.meta.url),'utf8');
  assert.match(legacy,/guard a\.textMode == nil, a\.direction == nil, a\.action != "scroll" else \{ throw Failure\("policy_action_not_allowed"\) \}/);
});
