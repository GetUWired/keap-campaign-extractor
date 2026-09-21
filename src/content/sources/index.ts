import type { ContentKind, ContentSource } from '../types.js';
import { emailSource } from './email.js';
import { httpRequestSource } from './httpRequest.js';
import { noteSource } from './note.js';
import { smsSource } from './sms.js';
import { createWebformSource } from './webform.js';

/**
 * One source per content kind, each settled by the discovery spike
 * (docs/spike-findings.md §18). Not served, and reported as NOT FETCHED by
 * fetch-content: landing pages (all builders), smart and internal forms, SMS
 * steps keyed only by automationMessageId, legacy HTTP Post, email attachments.
 */
export const SOURCES: Partial<Record<ContentKind, ContentSource>> = {
  email: emailSource,
  form: createWebformSource(),
  sms: smsSource,
  note: noteSource,
  http: httpRequestSource,
};
