/**
 * Return true only when the current user turn explicitly asks to create/save a
 * memo. This is intentionally narrower than generic remembering, summarizing,
 * Markdown conversion, or file-save requests.
 */
export function hasExplicitMemoIntent(query: string | undefined): boolean {
  if (!query) return false;

  let text = query.normalize('NFKC').toLowerCase().trim();
  if (!text) return false;

  // Ignore example/code fragments in a larger request. A request consisting
  // solely of one quoted instruction is treated as that instruction.
  const quotePairs: Array<[string, string]> = [
    ['"', '"'],
    ['「', '」'],
    ['『', '』'],
  ];
  const wrapper = quotePairs.find(([open, close]) => text.startsWith(open) && text.endsWith(close));
  if (wrapper) {
    text = text.slice(wrapper[0].length, -wrapper[1].length);
  } else {
    text = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`]*`/g, ' ')
      .replace(/"[^"]*"/g, ' ')
      .replace(/「[^」]*」|『[^』]*』/g, ' ');
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return false;

  if (
    /\b(?:do\s+not|don't|dont|never|not|without)\b.{0,64}\bmemo\b/.test(text) ||
    /(?:メモ|memo).{0,24}(?:しないで|しない|作らない|書かない|保存しない|不要)/.test(text)
  ) {
    return false;
  }

  const memo = '(?:メモ|memo)';
  const japanesePatterns = [
    new RegExp(`${memo}(?:に|として)(?:して|まとめて|保存して|残して|書いて|作って|取って)`),
    new RegExp(`${memo}(?:を)?(?:書いて|作って|作成して|生成して|保存して|残して|取って|して)`),
    /メモ化(?:して|する|してください|してほしい)?/,
  ];
  if (japanesePatterns.some((pattern) => pattern.test(text))) return true;

  return [
    /\b(?:write|draft|create|save|make|record)\b\s+.{0,48}\b(?:an?\s+)?memo\b/,
    /\b(?:turn|convert)\b\s+.{0,48}\binto\s+(?:an?\s+)?memo\b/,
    /\bmemo\s+(?:on|for|about)\b/,
  ].some((pattern) => pattern.test(text));
}
