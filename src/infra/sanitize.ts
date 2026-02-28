/**
 * Strip Unicode control/format characters that could be used for prompt injection.
 * Strips: Cc (control), Cf (format), Zl (line separator), Zp (paragraph separator).
 * Preserves: \t (0x09), \n (0x0A), \r (0x0D), space (0x20).
 */
export function sanitizeForPrompt(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => {
    const code = ch.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) return ch;
    return "";
  });
}
