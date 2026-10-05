/**
 * Lane Router。正本 §7.4、Phase 7 §2.1。
 * **利用者に Lane を見せない**が、なぜそうなったかは説明できる。
 */
import { describe, expect, it } from 'vitest';
import { routeLane } from '../src/lane.js';

const lane = (text: string, over: Record<string, unknown> = {}) =>
  routeLane({ text, modality: 'text', ...over } as never);

describe('routeLane', () => {
  it('sends a question that needs looking up to research', () => {
    for (const text of ['競合を調べて', '半導体市場を調査して', 'A社とB社を比較して']) {
      expect(lane(text).lane, text).toBe('research');
    }
  });

  it('sends an outward request to action', () => {
    for (const text of [
      '見積を送信して',
      '会議室を予約して',
      'CRM を更新して',
      'ボタンをクリックして',
      'GenieTestAppを開いて',
      'アプリを起動して',
      '次へボタンを押して',
      '画面を操作して',
      'computer-useを実行して',
      'Xをsafariでログインを手伝って',
      'Safariでログインして',
      'Googleにログインして',
      '検索欄に入力して',
      'ウィンドウを閉じて',
      'Xを読み取って',
      'Xのタイムラインを読み取って',
      '画面を読み取って',
      'Xから流行を検索して見せて',
      'Xでトレンドを調べて',
      'テストテスト聞こえますか、Xから流行を検索して見せて',
      'Xの流行を教えて',
      'カレンダーの予定を確認して',
      'メモの内容を見て',
      'Slackの未読をチェックして',
      'リマインダーに牛乳を買うと追加して',
      '設定画面を開いて',
      'X（旧Twitter）でトレンドを見て',
      'Twitterの話題を教えて',
      'Xで猫の画像を検索して',
      'Safariで天気を検索して',
      'Excelを開いて',
      'カレンダーの予定を確認してくれない？',
      'Safariを開いて、ログインはしないで、トレンドだけ見て',
    ]) {
      expect(lane(text).lane, text).toBe('action');
    }
  });

  it('answers how-to and explanation questions instead of operating the screen', () => {
    // 操作の語を含んでも、ほしいのは説明。computer.run に回さない。
    for (const text of [
      '設定の方法を教えて',
      'メモの書き方を教えて',
      'カレンダーの使い方を教えて',
      'このページの要点を教えて',
      'Excelの使い方を教えて',
      'Next.jsの新機能を教えて',
      'taxの計算方法を教えて',
      'メールの書き方を教えて',
      'Safariでログインする方法を教えて',
      'Safariでログインするにはどうすればいい？',
      'SafariとChromeの違いを教えて',
      'カレンダーに予定を追加する方法を教えて',
      'アプリの画面で入力する手順を教えて',
      '画面操作とは何か教えて',
      'computer useって何？',
      'このページの内容を教えて',
      'Xcodeの使い方を教えて',
    ]) {
      expect(lane(text).lane, text).toBe('chat');
    }
    for (const text of ['メールの書き方を調べて', 'ページの読み込みが遅い原因を調べて']) {
      expect(lane(text).lane, text).toBe('research');
    }
  });

  it('keeps committing requests as actions even with a question attached', () => {
    // 説明の句で chat に落とすのは画面の操作の規則だけ。送信・予約・削除などの依頼は落とさない。
    for (const text of [
      '請求書を送って。どうすればいい？',
      '会議室を予約して、キャンセルの手順も教えて',
      '古いレコードを削除して。やり方も知りたい',
      '経費を申請して、仕組みも説明して',
      'この下書きを送信して。要点を教えて',
      '予定を作成して。どうやって共有するの？',
    ]) {
      expect(lane(text).lane, text).toBe('action');
    }
  });

  it('reads X only as the standalone letter', () => {
    // /i の [Xx] は Excel・Next.js・tax の x まで拾っていた
    for (const text of [
      'Next.jsのリリースノートを確認して',
      'taxの計算結果を確認して',
      '3x4の結果を表示して',
    ]) {
      expect(lane(text).lane, text).toBe('chat');
    }
  });

  it('does not operate the screen when told not to', () => {
    for (const text of [
      'Safariを開かないで',
      '画面を操作しないで',
      '画面操作はしないで',
      'Safariでログインしないで',
      'Safariでログインしなくていい',
      'カレンダーの予定を削除しないで',
      'Xでポストしないで',
      'Safariで検索しないで',
      '画面を読み取らないで',
    ]) {
      expect(lane(text).lane, text).toBe('chat');
    }
  });

  it('does not take a bare search or a vague request for help as screen control', () => {
    // アプリの名指しが無いものは、これまでどおり（推測で操作にしない）
    for (const text of [
      '最新のAIニュースを検索して',
      'Googleで天気を検索して',
      'レポート作成の作業を手伝って',
    ]) {
      expect(lane(text).lane, text).toBe('chat');
    }
  });

  it('only edits when there is something selected', () => {
    // 選択が無い「直して」は、何を直すか決まらない
    expect(lane('この文を短くして').lane).toBe('chat');
    expect(lane('この文を短くして', { hasSelection: true }).lane).toBe('edit');
  });

  it('treats anything said during a meeting as part of the meeting', () => {
    // ここで chat に落とすと、会議の途中で別の話が始まる
    expect(lane('売上はどうだった', { meetingActive: true }).lane).toBe('meeting');
  });

  it('picks meeting over action when asked to record one', () => {
    // 「記録して」は action にも見える。会議として先に拾う。
    expect(lane('会議を記録して').lane).toBe('meeting');
  });

  it('defers to a named agent above everything else', () => {
    expect(lane('調べて', { namedAgent: 'crm-analyst' }).lane).toBe('specialist-agent');
  });

  it('falls back to chat rather than guessing', () => {
    // 推測で振り分けない
    for (const text of ['こんにちは', 'ありがとう', 'うーん']) {
      expect(lane(text).lane, text).toBe('chat');
    }
  });

  it('creates written deliverables without mistaking them for external actions', () => {
    for (const text of [
      '動画の構成案の文章だけを作成してください。',
      'Webサイトの改善提案をまとめてください。会社の説明は以下です。',
      'アイデアを小さく検証する計画にしてください。',
      '短い動画の構成を3案つくってください。',
      'チーム内レビュー用の案内文を日本語で作成してください。件名と本文を分けてください。',
      '新商品の紹介文を作成してください。',
      'メールを作成してください。',
      'メールの下書きを作成してください。送信しないでください。',
      '新規登録についての案内文を書いてください。',
      '予約についてのメールを作成して。送ってはいけません。',
      '顧客に送るメールの文面を書いてください。',
      'SNS投稿文を書いてください。',
      '新しいものを作成してください。',
    ])
      expect(lane(text).lane, text).toBe('chat');
  });

  it('keeps research and external actions distinct from drafting', () => {
    expect(lane('競合を調べて企画書を作成してください').lane).toBe('research');
    expect(lane('メールの下書きを作成して顧客に送って').lane).toBe('action');
    expect(lane('カレンダーに予定を作成して').lane).toBe('action');
    expect(lane('新しいアカウントを作成してください').lane).toBe('action');
  });

  it('can always say why', () => {
    for (const text of ['調べて', '送信して', 'こんにちは']) {
      expect(lane(text).reason.length, text).toBeGreaterThan(0);
    }
    expect(lane('Safariでログインする方法を教えて').reason).toBe(
      'asked how to do something, not to do it',
    );
  });
});
