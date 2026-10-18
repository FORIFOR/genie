/**
 * 画面操作の「いま見ている画面」を、Genie のアプリが読める場所に 1 つだけ示す。
 *
 * 写真そのものは画面操作が読み取りのために撮ったもの（`VisualContext/cv-*.png`、0600、この Mac の中だけ）。
 * ここでは**どれが最新か**を `live.json` に書くだけで、写真を作り直したり外へ送ったりはしない。
 * アプリは仕事が動いている間これを読み、Dock の作業面に出す（注文などを本人が追えるように。2026-10-19 本人の依頼）。
 * 仕事が終わったら消す（写真も `close` で消える）。
 */
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const LIVE_SCREEN_FILE = 'live.json';

export interface LiveScreen {
  readonly schema: 1;
  /** 同じフォルダの写真のファイル名（`cv-<uuid>.png`）。パスは持たない。 */
  readonly image: string;
  /** 撮った時刻（ms）。 */
  readonly at: number;
  readonly width: number;
  readonly height: number;
  /** 操作しているページの出所（`https://www.mcdonalds.co.jp` など）。取れないときは無し。 */
  readonly origin?: string;
  readonly bundleId: string;
}

export function liveScreenOf(frame: {
  id: string;
  capturedAt: number;
  width: number;
  height: number;
  bundleId: string;
  documentOrigin?: string;
}): LiveScreen {
  return {
    schema: 1,
    image: `${frame.id}.png`,
    at: frame.capturedAt,
    width: frame.width,
    height: frame.height,
    ...(frame.documentOrigin ? { origin: frame.documentOrigin } : {}),
    bundleId: frame.bundleId,
  };
}

/** 途中まで書いたものを読ませない（別名に書いてから置き換える）。 */
export async function writeLiveScreen(root: string, live: LiveScreen): Promise<void> {
  const target = join(root, LIVE_SCREEN_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  const file = await open(temp, 'w', 0o600);
  try {
    await file.writeFile(JSON.stringify(live));
  } finally {
    await file.close();
  }
  await rename(temp, target);
}

export async function clearLiveScreen(root: string): Promise<void> {
  await rm(join(root, LIVE_SCREEN_FILE), { force: true });
}
