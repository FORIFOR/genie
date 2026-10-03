reference : shared/design/DESIGN.md §1 Apple + Linear の既存 Home 面と docs/DESIGN_SYSTEM.md DS-05/06（2026-10-02確認）。エラーの横に具体的な次の操作を示し、OSの判断を代行しない。
hypothesis: キーチェーンの非対話読取拒否の説明に、本人だけが押す既存接続情報の読取確認を1個追加すると、入力を失わずOSの確認へ進める。
measured  : 現行 Home は submitIssue の secondary 文字だけ。復帰ボタン0個、contentWidth760pt、Space.base8pt、既存 bordered button を使用。
candidates: A=説明のみ / B=同じエラー領域へ読取確認ボタン1個（採用候補） / C=新しい設定窓への遷移（不採用）。既存入力・送信ボタンの寸法や文言は変えない。
gate      : 合成Keychain/session回帰で単一read・no refresh/signIn/save・拒否/nil/取消保持、明暗エラーfixtureの全文/ボタン/AX名とfocusを確認。OS側許可の実選択は自動化しない。既存goldenは上書きせず補足画像を保存。
