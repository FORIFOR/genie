# 音声入力の検査用アプリ

音声入力が**本人のアプリへ打ち込まずに**、実際に欄へ入るかを確かめるための小さなアプリ。欄の中身を 0.3 秒ごとにファイルへ書く。

- `fieldapp.swift`: ふつうの文字欄（値を外から書き換えられる。AX で入る）。
- `termapp.swift`: ターミナルのように、値を外から書き換えられない欄（書き換えを「成功」と返して無視する）。キー入力で入る。

```sh
swiftc -O fieldapp.swift -o /tmp/fieldapp && /tmp/fieldapp /tmp/field.txt &
# 前面になったのを確かめてから（本人のアプリへ打ち込まないため、selftest も前面を確かめる）
open -g -n Genie.app --args --selftest dictationmic <audio> --real --expect-front fieldapp --text "えっと、…" [--restore]
cat /tmp/field.txt
```
