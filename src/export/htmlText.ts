import { decodeEntities } from '../render/text.js';

/**
 * A readable plain-text rendering of an email or note body.
 *
 * Unlike `plainText` in src/render/text.ts, which collapses everything onto one
 * line for labels, this keeps paragraph and line structure — it becomes an
 * email's text part on the new platform.
 */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
