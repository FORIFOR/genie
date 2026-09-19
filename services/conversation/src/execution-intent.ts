/** Only explicit user commands enter execution. Screen/doc text is never passed to this detector. */
export function isExecutionRequest(text: string): boolean {
  // Quoted commands are material, not authority. Keep their contents for the later
  // preparation call, but do not let quoted instructions select the execution lane.
  const value = text.replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/g, ' ').trim();
  if (
    !value ||
    value.length > 8000 ||
    /[?？]|方法|やり方|できますか|できる[？?]|教えて|説明して|how\b|can (?:i|you)\b|しないで|しないこと|しないよう|するな|しなくて|しません|しない|不要|やめて|don't|do not/i.test(
      value,
    )
  )
    return false;
  const command =
    /(?:して|作って|開いて|入力して|挿入して|登録して|追加して|保存して|してください|お願い)(?:[。！!\s]|$)|\b(?:create|save|insert|open|click)\b/i.test(
      value,
    );
  if (!command) return false;
  return (
    (/(?:Gmail|メール).*下書き|draft.*(?:gmail|mail)/i.test(value) &&
      /(?:保存|登録|追加)|\bsave\b/i.test(value)) ||
    /(?:予定|カレンダー|calendar|event)/i.test(value) ||
    /(?:入力欄|テキスト欄|text field)/i.test(value) ||
    /(?:画面|ウィンドウ|アプリ|screen|window|\bapp\b)/i.test(value)
  );
}
