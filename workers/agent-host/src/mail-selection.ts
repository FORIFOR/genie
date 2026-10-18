import { parseAddress, type MailSummary } from '@genie/service-connectors';

/** Push down the same category exclusions used by the local metadata filter. */
export const GMAIL_AUTOMATED_CATEGORY_QUERY =
  '-category:promotions -category:social -category:forums -category:updates';

/** Shared initial-profile/daily-brief policy; metadata only, no inference from bodies. */
export function isAutomatedMail(
  mail: Pick<MailSummary, 'listUnsubscribe' | 'autoSubmitted' | 'precedence'>,
  from: string,
  labels: readonly string[] = [],
): boolean {
  const address = parseAddress(from).email ?? from;
  return (
    Boolean(mail.listUnsubscribe) ||
    Boolean(mail.autoSubmitted && mail.autoSubmitted.trim().toLowerCase() !== 'no') ||
    /^(?:bulk|list|junk)$/i.test(mail.precedence?.trim() ?? '') ||
    /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?|mailer[-_.]?daemon|newsletter|marketing|alerts?)(?:[+._-]|@)/i.test(
      address,
    ) ||
    labels.some((label) =>
      [
        'CATEGORY_PROMOTIONS',
        'CATEGORY_SOCIAL',
        'CATEGORY_FORUMS',
        'CATEGORY_UPDATES',
        'SPAM',
        'TRASH',
        'DRAFT',
      ].includes(label),
    )
  );
}
