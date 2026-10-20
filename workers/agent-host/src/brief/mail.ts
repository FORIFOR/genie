import type { BriefLine, BriefSection } from '@genie/contracts';
import {
  ConnectorError,
  parseAddress,
  type MailSummary,
  type OutlookMailSummary,
} from '@genie/service-connectors';
import type { ConnectorRuntime } from '../connector-steps.js';
import { GMAIL_AUTOMATED_CATEGORY_QUERY, isAutomatedMail } from '../mail-selection.js';

export const BRIEF_MAIL_LIMIT = 100;
const LOOKBACK_MS = 7 * 86_400_000;
const READ_BUDGET_MS = 45_000;

interface Candidate {
  id: string;
  thread: string;
  subject: string;
  sender: string;
  at: string | null;
  url?: string;
  unread: boolean;
  important: boolean;
  starred: boolean;
  directHuman: boolean;
  noise: boolean;
}

const cleanText = (value: string, max: number) =>
  value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// IMPORTANT can be assigned to newsletters by a provider. Only a narrow,
// actionable subject can exempt automated mail; an explicit star is separate.
const PROMOTIONAL_SUBJECT =
  /キャンペーン|クーポン|セール|お得|プレゼント|ポイント(?:還元|山分け)|無料(?:セミナー|ウェビナー)|\b(?:sale|promotion|discount|coupon|newsletter|webinar)\b/i;
const ACTIONABLE_NOTICE = [
  /(?:支払(?:い)?|振込|納付|請求|引き?落とし|引落し?).{0,16}(?:期限|期日|未払い|未納|遅延|失敗|要確認|確認が必要)/,
  /(?:セキュリティ).{0,12}(?:警告|アラート|要確認|確認が必要)|(?:不審|不正|身に覚えのない).{0,12}(?:ログイン|アクセス|取引)/,
  /(?:パスワード).{0,12}(?:変更され|リセットされ)|(?:新しい|未確認の).{0,8}(?:端末|デバイス).{0,12}(?:ログイン|サインイン)/,
  /(?:本人確認|本人認証).{0,12}(?:お願い|依頼|必要|要対応|未完了|期限|完了してください)/,
  /\b(?:payment|invoice|bill).{0,24}\b(?:due|overdue|failed|declined)\b|\b(?:security alert|suspicious login|unrecognized sign-in|identity verification required|verify your identity)\b/i,
];

function dailyPolicy(
  mail: Pick<MailSummary, 'subject' | 'listUnsubscribe' | 'autoSubmitted' | 'precedence'>,
  from: string,
  labels: readonly string[],
  important: boolean,
  starred: boolean,
): { directHuman: boolean; noise: boolean } {
  const automated = isAutomatedMail(mail, from, labels);
  const bulk =
    Boolean(mail.listUnsubscribe) ||
    /^(?:bulk|list|junk)$/i.test(mail.precedence?.trim() ?? '') ||
    labels.some((label) =>
      ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS'].includes(label),
    );
  const subject = cleanText(mail.subject, 300);
  const actionable =
    important &&
    !bulk &&
    !PROMOTIONAL_SUBJECT.test(subject) &&
    ACTIONABLE_NOTICE.some((pattern) => pattern.test(subject));
  return {
    directHuman: !automated,
    noise: !starred && (bulk || (automated && !actionable)),
  };
}

/**
 * 広告・一般の自動通知か（まとめと同じ線引き。スター付きと、対応が要る一部の通知は残す）。
 * Work の同期もこれで入口を絞る。広告が「未返信」「期限切れ」の要対応に上がっていた（2026-10-19）。
 */
export function isGmailNoise(mail: MailSummary): boolean {
  return gmailCandidate(mail).noise;
}

function needsReconnect(error: unknown): boolean {
  const reason = error instanceof ConnectorError ? error.reason : null;
  return reason === 'token_expired' || reason === 'not_connected';
}

function gmailCandidate(mail: MailSummary): Candidate {
  const starred = Boolean(mail.labels?.includes('STARRED'));
  const important = Boolean(
    mail.labels?.some((label) => label === 'IMPORTANT' || label === 'STARRED'),
  );
  const policy = dailyPolicy(mail, mail.from, mail.labels ?? [], important, starred);
  return {
    id: `gmail:${mail.id}`,
    thread: `gmail:${mail.threadId || mail.id}`,
    subject: mail.subject,
    sender: parseAddress(mail.from).name,
    at: mail.receivedAt,
    url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.threadId || mail.id)}`,
    unread: mail.unread,
    important,
    starred,
    directHuman: policy.directHuman,
    noise:
      !mail.id ||
      Boolean(mail.labels?.some((label) => ['SENT', 'SPAM', 'TRASH', 'DRAFT'].includes(label))) ||
      policy.noise,
  };
}

function outlookCandidate(mail: OutlookMailSummary): Candidate {
  const policy = dailyPolicy(mail, mail.from?.address ?? '', [], mail.importance === 'high', false);
  let url: string | undefined;
  try {
    const link = new URL(mail.webLink ?? '');
    if (
      link.protocol === 'https:' &&
      ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com'].includes(link.hostname)
    )
      url = link.href;
  } catch {
    /* A missing provider link is not replaced with an invented destination. */
  }
  return {
    id: `outlook_mail:${mail.id}`,
    thread: `outlook_mail:${mail.conversationId || mail.id}`,
    subject: mail.subject,
    sender: mail.from?.name || mail.from?.address || '',
    at: mail.receivedAt,
    ...(url ? { url } : {}),
    unread: mail.unread,
    important: mail.importance === 'high',
    starred: false,
    directHuman: policy.directHuman,
    noise: !mail.id || mail.isDraft === true || mail.folder === 'sentitems' || policy.noise,
  };
}

/** Fresh read-only metadata. No body, snippet, attachment, model or send path is used. */
export async function readBriefMail(
  connectors: ConnectorRuntime | undefined,
  now: () => Date = () => new Date(),
  signal: AbortSignal = AbortSignal.timeout(READ_BUDGET_MS),
): Promise<BriefSection> {
  const base = { id: 'mail', title: '主要メール', sources: [], lines: [] } as const;
  if (!connectors)
    return {
      ...base,
      sources: [],
      lines: [],
      status: 'none',
      fetched_at: null,
      reason: 'メールの読み取り接続がありません',
    };
  const started = now();
  const since = new Date(started.getTime() - LOOKBACK_MS);
  const active: ('gmail' | 'outlook')[] = [];
  let failures = 0;
  for (const key of ['gmail', 'outlook'] as const) {
    try {
      if ((await connectors.connected(key)) && connectors.granted(key).includes('email.read'))
        active.push(key);
    } catch {
      failures += 1;
    }
  }
  if (!active.length)
    return {
      ...base,
      sources: [],
      lines: [],
      status: failures ? 'stale' : 'none',
      fetched_at: null,
      reason: failures
        ? 'メールの接続状態を確認できませんでした'
        : 'メール接続で読み取りを許可すると表示します',
    };

  const candidates: Candidate[] = [];
  const sources: BriefSection['sources'] = [];
  let metadataCount = 0;
  let completedReads = 0;
  /** 期限切れなどで、つなぎ直さないと読めない接続。 */
  const reconnect = new Set<string>();
  for (const key of active) {
    const budget = Math.floor(BRIEF_MAIL_LIMIT / active.length);
    if (key === 'gmail') {
      sources.push({ name: 'Gmail', url: 'https://mail.google.com/' });
      const gmail = connectors.gmail();
      const query = `after:${Math.floor(since.getTime() / 1000)} -in:sent -in:trash -in:spam -in:drafts`;
      // Starred mail has its own OR branch, so categories cannot erase an explicit choice.
      // Automated IMPORTANT rows still pass the narrow local notice policy below.
      const importantCategories = GMAIL_AUTOMATED_CATEGORY_QUERY.replace(' -category:updates', '');
      const importantBudget = Math.floor(budget / 2);
      let remainingBudget = budget - importantBudget;
      try {
        const important = (
          await gmail.list(
            {
              query: `${query} (is:starred OR (is:important ${importantCategories}))`,
              maxResults: importantBudget,
              retryRateLimits: true,
            },
            signal,
          )
        ).slice(0, importantBudget);
        metadataCount += important.length;
        remainingBudget = budget - important.length;
        candidates.push(...important.map(gmailCandidate));
        completedReads += 1;
      } catch (error) {
        failures += 1;
        if (needsReconnect(error)) reconnect.add('Gmail');
      }
      try {
        const incoming = (
          await gmail.list(
            {
              query: `${query} ${GMAIL_AUTOMATED_CATEGORY_QUERY} -is:important -is:starred`,
              maxResults: remainingBudget,
              retryRateLimits: true,
            },
            signal,
          )
        ).slice(0, remainingBudget);
        metadataCount += incoming.length;
        candidates.push(...incoming.map(gmailCandidate));
        completedReads += 1;
      } catch (error) {
        failures += 1;
        if (needsReconnect(error)) reconnect.add('Gmail');
      }
    } else {
      sources.push({ name: 'Outlook', url: 'https://outlook.office.com/' });
      try {
        const incoming = (
          await connectors.outlookMail().list(
            {
              folder: 'inbox',
              selectionMetadata: true,
              since: since.toISOString(),
              maxResults: budget,
            },
            signal,
          )
        ).slice(0, budget);
        metadataCount += incoming.length;
        candidates.push(...incoming.map(outlookCandidate));
        completedReads += 1;
      } catch (error) {
        failures += 1;
        if (needsReconnect(error)) reconnect.add('Outlook');
      }
    }
  }
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const at = Date.parse(candidate.at ?? '');
    if (candidate.noise || !Number.isFinite(at) || at < since.getTime() || at > started.getTime())
      continue;
    unique.set(candidate.id, candidate);
  }
  const score = (candidate: Candidate) =>
    Number(candidate.directHuman) * 8 +
    Number(candidate.starred) * 4 +
    Number(candidate.important) * 2 +
    Number(candidate.unread);
  const newest = [...unique.values()].sort(
    (a, b) => Date.parse(b.at!) - Date.parse(a.at!) || a.id.localeCompare(b.id),
  );
  const threads = new Map<string, Candidate>();
  for (const candidate of newest)
    if (!threads.has(candidate.thread)) threads.set(candidate.thread, candidate);
  // 同じ差出人の、数字だけ違う件名（ビルド番号・日付・件数）は 1 行にまとめ「ほかN件」と書く。
  const similar = new Map<string, { candidate: Candidate; more: number }>();
  for (const candidate of [...threads.values()].sort(
    (a, b) =>
      score(b) - score(a) || Date.parse(b.at!) - Date.parse(a.at!) || a.id.localeCompare(b.id),
  )) {
    const key = `${cleanText(candidate.sender, 120)}\u0000${cleanText(candidate.subject, 200)
      .normalize('NFKC')
      .replace(/\d+/g, '#')}`;
    const same = similar.get(key);
    if (same) same.more += 1;
    else similar.set(key, { candidate, more: 0 });
  }
  const selected = [...similar.values()].slice(0, BRIEF_MAIL_LIMIT);
  const lines: BriefLine[] = selected.map(({ candidate, more }) => {
    const sender = cleanText(candidate.sender, 120);
    const title = cleanText(candidate.subject, 200) || '（件名なし）';
    const received = new Date(candidate.at!).toISOString();
    const stamp = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(received));
    return {
      // 差出人は副題に出す（見出しは件名だけ。同じ名前を 2 度読ませない）。
      text: title,
      subtitle: [
        candidate.starred ? 'スター付き' : candidate.important ? '重要' : '',
        candidate.unread ? '未読' : '',
        sender,
        more ? `ほか${more}件` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      time: stamp,
      received_at: received,
      ref: candidate.id,
      ...(candidate.url ? { url: candidate.url } : {}),
    };
  });
  return {
    id: 'mail',
    title: '主要メール',
    status: failures ? 'stale' : 'ok',
    fetched_at: completedReads ? now().toISOString() : null,
    reason: !completedReads
      ? reconnect.size
        ? `${[...reconnect].join('・')}の接続の期限が切れました。Apps の「つなぎ直す」から許可し直してください。`
        : 'メールを読み取れませんでした。少し待ってから更新してください。'
      : `${
          reconnect.size
            ? `${[...reconnect].join('・')}の接続の期限が切れました（Apps の「つなぎ直す」から許可し直してください）。`
            : failures
              ? '一部を取得できませんでした。'
              : ''
        }直近7日の受信メールを最大100件確認し、取得${metadataCount}件から広告・一般の自動通知・同じ会話の重複を除いた${lines.length}件を表示しています。人からの連絡を優先し、スター付きと対応が必要な一部の通知も含みます。`,
    sources,
    lines,
  };
}
