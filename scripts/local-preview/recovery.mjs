/**
 * 保存サービス（Docker の postgres・redis・temporal）が落ちたときの立て直し。
 *
 * 2026-10-19 14:27 に Docker の仮想マシンでディスクの書き込みエラーが起き、redis が止まった。
 * 起動管理は「保存サービスとの接続が失われました」で全部を止め、作り直そうとしても
 * redis の追記ファイル（AOF）の末尾 632 バイトが壊れていて起き上がらなかった。
 * 利用者が Docker と redis を直すまで、Genie は何も受けられなかった。
 *
 * ここでは:
 *  - まず同じ設定で起こし直す（Docker が戻っていればこれで足りる）
 *  - redis が「AOF の形式が壊れている」で起きないときだけ、壊れた末尾を切り詰める。
 *    切る前に、同じ保存先の中へ写しを 1 つ残す（前の写しは消す。写しが溜まって容量を食わない）
 *  - 待ち時間を伸ばしながら数回だけ試す。直らなければ、これまでどおり止めて理由を言う
 */

/** 立て直しの前に待つ時間。Docker の仮想マシンが戻るのを待つ分。 */
export const RECOVERY_DELAYS_MS = [15_000, 60_000, 180_000];

const AOF_CORRUPT = /Bad file format reading the append only file/;

/** redis のログが「AOF の形式が壊れている」と言っているか。 */
export function redisAofCorrupt(logText) {
  return AOF_CORRUPT.test(String(logText ?? ''));
}

export function infrastructureUpArgs(composeArgs) {
  return [
    ...composeArgs,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '180',
    'postgres',
    'redis',
    'temporal',
  ];
}

/**
 * 壊れた AOF の末尾を切り詰める（redis 付属の redis-check-aof）。同じ volume を使う一回きりの容器で行う。
 * 写しは `/data/appendonlydir.before-repair` の 1 つだけ。
 */
export function repairRedisArgs(composeArgs) {
  return [
    ...composeArgs,
    'run',
    '--rm',
    '--no-deps',
    '--entrypoint',
    'sh',
    'redis',
    '-c',
    'set -e; rm -rf /data/appendonlydir.before-repair; cp -a /data/appendonlydir /data/appendonlydir.before-repair; ' +
      'cd /data/appendonlydir; yes | redis-check-aof --fix appendonly.aof.manifest',
  ];
}

/**
 * 1 回立て直す。`run(name, args)` は docker を呼び、失敗なら投げる。`logs(service)` は容器のログ。
 * 戻り値は何をしたか（`restarted` / `repaired`）。直せなければ投げる。
 */
export async function recoverInfrastructure({ run, logs, composeArgs, note = () => {} }) {
  try {
    await run('infrastructure', infrastructureUpArgs(composeArgs));
    return 'restarted';
  } catch (error) {
    const redisLog = await logs('redis').catch(() => '');
    if (!redisAofCorrupt(redisLog)) throw error;
    note('redis の保存ファイルの末尾が壊れていました。写しを残して、壊れた末尾を切り詰めます…');
    await run('redis-repair', repairRedisArgs(composeArgs));
    await run('infrastructure', infrastructureUpArgs(composeArgs));
    return 'repaired';
  }
}
