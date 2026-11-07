export function teamInitials(label: string | null | undefined): string | null {
  if (!label) return null;
  const words = label.match(/[A-Za-z0-9]+/g) ?? [];
  if (words.length === 0) return null;
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((word) => word[0]).join('').toUpperCase();
}

export function formatIplTitleFromOutcomes(labels: Array<string | null | undefined>): string | null {
  if (labels.length < 2) return null;
  const left = teamInitials(labels[0]);
  const right = teamInitials(labels[1]);
  return left && right ? `${left} VS ${right}` : null;
}

export function formatPolymarketTitle({
  title,
  slug,
  outcomes = [],
}: {
  title: string | null | undefined;
  slug?: string | null;
  outcomes?: Array<string | null | undefined>;
}): string {
  const isIpl = slug?.startsWith('cricipl-') || /^Indian Premier League:/i.test(title ?? '');
  if (!isIpl) return title || slug || '--';

  const outcomeTitle = formatIplTitleFromOutcomes(outcomes);
  if (outcomeTitle) return outcomeTitle;

  const cleanTitle = (title || '').replace(/^Indian Premier League:\s*/i, '').trim();
  const parts = cleanTitle.split(/\s+v(?:s\.?|ersus)?\s+/i);
  return formatIplTitleFromOutcomes([parts[0], parts[1]]) || cleanTitle || slug || '--';
}
