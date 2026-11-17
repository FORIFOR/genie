import { describe, expect, it } from 'vitest';
import { FakeLists, SharedSpaceService, dayLabel, parseDates } from './shared-fakes.js';

const NOW = Date.parse('2026-10-23T03:00:00Z'); // 10/23 JST

function setup(householdId: string | null = 'h1') {
  const fakes = new FakeLists();
  const service = new SharedSpaceService({
    shopping: fakes,
    todos: fakes.todoStore,
    polls: fakes.pollStore,
    households: fakes,
    timeZone: 'Asia/Tokyo',
    now: () => NOW,
  });
  const ctx = (name: string, id = name) => ({
    tenantId: 't',
    userId: 'u',
    householdId,
    speaker: { id, name },
  });
  return { fakes, service, ctx };
}

describe('parseDates', () => {
  it('reads 11/3, 11月4日 and 5日, rolling past days into the next month or year', () => {
    expect(parseDates('旅行の日程調整 11/3 11月4日', '2026-10-23')).toEqual([
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(parseDates('25日と5日', '2026-10-23')).toEqual(['2026-10-25', '2026-11-05']);
    expect(parseDates('1/2', '2026-10-23')).toEqual(['2027-01-02']);
    expect(dayLabel('2026-11-03')).toBe('11/3（火）');
  });
});

describe('SharedSpaceService shopping', () => {
  it('adds, refuses duplicates, lists, and marks bought by name or all', async () => {
    const { service, ctx, fakes } = setup();
    expect(await service.handle(ctx('ママ'), '牛乳と卵を追加')).toBe(
      '牛乳・卵を買い物リストに足しました。（2 件）',
    );
    expect(await service.handle(ctx('パパ'), 'パンが切れた')).toBe(
      'パンを買い物リストに足しました。（3 件）',
    );
    expect(await service.handle(ctx('パパ'), '牛乳を買い物リストに入れて')).toBe(
      'もう買い物リストにあります。（3 件）',
    );
    expect(await service.handle(ctx('ママ'), '買い物リスト')).toBe(
      '買い物リスト（3 件）\n・牛乳\n・卵\n・パン',
    );
    expect(await service.handle(ctx('パパ'), '牛乳買った')).toBe(
      '牛乳を買ったことにしました。残り: 卵・パン',
    );
    expect(await service.handle(ctx('パパ'), '買ったよ')).toBe(
      '卵・パンを買ったことにしました。買い物リストは空になりました。',
    );
    expect(fakes.items.find((i) => i.name === '牛乳')?.boughtBy).toBe('パパ');
  });
  // 評価 2026-10-27: リストの名前が先・動詞の無い言い方が届いていなかった
  it('takes the list name first or without a verb', async () => {
    const { service, ctx } = setup();
    expect(await service.handle(ctx('ママ'), '買い物リストに卵と牛乳')).toBe(
      '卵・牛乳を買い物リストに足しました。（2 件）',
    );
    expect(await service.handle(ctx('ママ'), 'パンとバター、買い物リストに')).toBe(
      'パン・バターを買い物リストに足しました。（4 件）',
    );
    expect(await service.handle(ctx('ママ'), 'TODOに区役所で住民票')).toBe(
      'TODO に「区役所で住民票」を足しました。',
    );
  });
});

describe('SharedSpaceService TODO', () => {
  it('adds, assigns to the speaker for 私, lists and completes only matching TODOs', async () => {
    const { service, ctx } = setup();
    expect(await service.handle(ctx('ママ'), 'ゴミ出しをTODOに追加')).toBe(
      'TODO に「ゴミ出し」を足しました。',
    );
    expect(await service.handle(ctx('パパ'), 'ゴミ出しを私の担当にして')).toBe(
      '「ゴミ出し」はパパさんの担当にしました。',
    );
    expect(await service.handle(ctx('パパ'), '洗濯をママの担当にして')).toBe(
      '「洗濯」はママさんの担当にしました。',
    );
    expect(await service.handle(ctx('ママ'), 'TODO')).toBe(
      'TODO（2 件）\n・ゴミ出し（パパ）\n・洗濯（ママ）',
    );
    expect(await service.handle(ctx('パパ'), 'ゴミ出し終わった')).toBe(
      '「ゴミ出し」を済みにしました。ありがとう、パパさん。',
    );
    // 載っていないものの「やった」は TODO の話ではない
    expect(await service.handle(ctx('パパ'), 'ゲームやった')).toBeNull();
  });
});

describe('SharedSpaceService date polls', () => {
  it('collects who can come and decides the date most can make', async () => {
    const { service, ctx } = setup();
    expect(await service.handle(ctx('ママ'), '旅行の日程調整 11/3 11/4 11/5')).toBe(
      '「旅行」の候補: 11/3（火）、11/4（水）、11/5（木）\n行ける日を「@Genie 3日と5日ならOK」のように送ってください。集まったら「@Genie 決めて」。',
    );
    expect(await service.handle(ctx('ママ', 'U1'), '3日と5日ならOK')).toBe(
      'ママさん: 11/3（火）、11/5（木） OK、と記録しました。',
    );
    expect(await service.handle(ctx('パパ', 'U2'), '3日は無理')).toBe(
      'パパさん: 11/4（水）、11/5（木） OK、と記録しました。',
    );
    expect(await service.handle(ctx('パパ', 'U2'), '日程どう？')).toBe(
      '「旅行」（2 人が回答）\n・11/3（火）: 1 人（ママ）\n・11/4（水）: 1 人（パパ）\n・11/5（木）: 2 人（ママ・パパ）',
    );
    expect(await service.handle(ctx('ママ'), '決めて')).toBe(
      '「旅行」は 11/5（木） に決めました（2/2 人: ママ・パパ）。',
    );
  });

  it('does not run polls in a personal (1:1) scope', async () => {
    const { service, ctx } = setup(null);
    expect(await service.handle(ctx('me'), '旅行の日程調整 11/3 11/4')).toBeNull();
  });
});

describe('SharedSpaceService help and photos', () => {
  it('turns automatic receipt reading on and off, and leaves chit-chat alone', async () => {
    const { service, ctx, fakes } = setup();
    expect(await service.handle(ctx('ママ'), 'レシートを自動で読んで')).toContain(
      '家計簿に付けます',
    );
    expect(fakes.autoReceipts).toBe(true);
    expect(await service.handle(ctx('ママ'), '写真は読まないで')).toContain('@Genie を付けて');
    expect(fakes.autoReceipts).toBe(false);
    expect(await service.handle(ctx('ママ'), '使い方')).toContain('買い物');
    expect(await service.handle(ctx('ママ'), '今日はいい天気だね')).toBeNull();
  });
});
