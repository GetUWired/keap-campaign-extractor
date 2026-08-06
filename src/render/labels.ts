import type { NormalizedNode } from '../normalize/nodes.js';

/**
 * Styles whose meaning depends on what they reference, not on the style.
 *
 * `newsletterRequest` is a web form submission 106 times, a landing page 20
 * times and an internal form 7 times across this corpus. The legacy style name
 * describes none of them.
 */
export const SUBMISSION_STYLES = new Set(['newsletterRequest', 'requestInfo']);

/**
 * What each style is called in output.
 *
 * Wording comes from Keap's own default names wherever possible — the most
 * common `name` across nodes of that style. Several styles collapse together
 * because Keap has shipped multiple builders over the years and the generation
 * is an implementation detail no reader needs.
 *
 * CORRECT THIS TABLE ON SIGHT if you know the builder. Nothing else in the
 * renderer depends on the wording, and a style missing here falls through to
 * its raw name rather than being guessed at.
 *
 * Known-unsettled: stageMove, makeCall, indicateInterest and fileDownload all
 * carry an optional stageId that most instances leave unset — 7 of 82 for
 * indicateInterest, 2 of 13 for fileDownload. They may be one goal type in the
 * current UI or four; until that is answered they stay distinct, because
 * calling them all "stage move" would misdescribe the majority that move no
 * stage.
 */
export const STYLE_LABELS: Record<string, string> = {
  // Email — three builder generations, one meaning
  email: 'Email',
  bardEmail: 'Email',
  unlayerEmail: 'Email',
  emailConfirm: 'Confirmation email',
  confirmEmail: 'Email confirmed',
  // Landing pages — two builder generations
  landingPage: 'Landing page submitted',
  convrrtLandingPage: 'Landing page submitted',
  // Timers
  timerDelay: 'Wait',
  timerDate: 'Wait until date',
  timerContact: 'Wait until contact date',
  // Tags and notes
  tag: 'Tag applied',
  tagApplied: 'Tag applied (goal)',
  notes: 'Note',
  note: 'Apply note',
  noteApplied: 'Note applied',
  // Actions
  http: 'Send HTTP Post',
  task: 'Create Task',
  taskComplete: 'Task completed',
  fulfillment: 'Fulfillment List',
  actionSet: 'Apply Action Set',
  fieldValue: 'Set Field Value',
  assignOwner: 'Assign an Owner',
  opportunity: 'Create Opportunity',
  createOrder: 'Create Order',
  addToSequence: 'Add to Sequence',
  cancelSubscription: 'Cancel subscription',
  customerHub: 'Add to CustomerHub',
  letter: 'Letter',
  voice: 'Voice broadcast',
  fax: 'Fax',
  // Goals
  internalForm: 'Internal form submitted',
  purchaseSuccess: 'Purchase made',
  failedPurchase: 'Purchase failed',
  eventRequest: 'Event registration',
  eventAttend: 'Event attended',
  liveEvent: 'Live event',
  meetingRequest: 'Appointment scheduled',
  meetingAttend: 'Appointment attended',
  linkClick: 'Link clicked',
  fileDownload: 'File downloaded',
  scoreAchieved: 'Lead score reached',
  websiteTrigger: 'Web page automation',
  website: 'Website',
  api: 'API',
  blog: 'Blog',
  facebook: 'Facebook',
  facebookParticipate: 'Facebook promotion',
  twitter: 'Twitter',
  radioAd: 'Radio ad',
  existingList: 'Existing list',
  goal: 'Goal',
  decision: 'Decision',
  // The unsettled stageId group — see the note above
  stageMove: 'Opportunity stage moved',
  makeCall: 'Call made',
  indicateInterest: 'Interest indicated',
};

/** Which entity a submission-style node actually points at. */
function submissionLabel(node: NormalizedNode): string {
  const { references } = node;
  if (typeof references.webformId === 'string') return 'Web form submitted';
  if (typeof references.landingPageId === 'string') return 'Landing page submitted';
  if (typeof references.internalFormId === 'string') return 'Internal form submitted';
  return 'Form submitted (unconfigured)';
}

/**
 * What this node does, in words a Keap operator would recognize.
 *
 * Takes a node rather than a style because one style can mean several things.
 * Never returns an internal style name for a style in the tables; an unknown
 * style returns its raw name so it is visibly odd and asks to be added.
 */
export function typeLabel(node: NormalizedNode): string {
  if (SUBMISSION_STYLES.has(node.style)) return submissionLabel(node);
  return STYLE_LABELS[node.style] ?? node.style;
}
