import { type ContentItemKey, type ContentKind, KIND_FOLDERS, itemDirName } from '../content/types.js';

export function slugify(name: string | null): string {
  const slug = (name ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug === '' ? 'untitled' : slug;
}

/** The funnel id prefix keeps two campaigns with the same name apart. */
export function campaignFolderName(funnelId: string, name: string | null): string {
  return `${funnelId}-${slugify(name)}`;
}

/** Kinds with no body files are a single JSON file rather than a folder. */
export const SINGLE_FILE_KINDS: ReadonlySet<ContentKind> = new Set(['sms', 'note', 'http']);

export const RECORD_FILE: Partial<Record<ContentKind, string>> = {
  email: 'email.json',
  landingPage: 'page.json',
  form: 'form.json',
};

/** Where an item lives, relative to its campaign folder. */
export function contentRef(key: ContentItemKey): string {
  const folder = KIND_FOLDERS[key.kind];
  const name = itemDirName(key);
  return SINGLE_FILE_KINDS.has(key.kind) ? `${folder}/${name}.json` : `${folder}/${name}`;
}

/** Attachment names come from Keap; they become file names on someone else's disk. */
export function attachmentFileName(name: string, used: Set<string>): string {
  const base =
    name
      .split(/[\\/]/)
      .filter((part) => part !== '' && part !== '.' && part !== '..')
      .join('_')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^[._]+/, '')
      .slice(0, 100) || 'attachment';
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${n}-${base}`;
  used.add(candidate);
  return candidate;
}
