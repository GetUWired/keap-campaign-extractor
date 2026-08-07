import { type NormalizedNode, referenceValues } from '../normalize/nodes.js';

/**
 * What each tool is called, using the wording on the campaign-builder toolbars.
 *
 * These are styles that ARE tools — a reader picking one from the palette gets
 * exactly this. Keap marks generations itself, with a NEW badge or a "(Legacy)"
 * suffix, and that distinction is kept: for a migration, legacy-builder content
 * is precisely what needs rebuilding, so collapsing it would hide the work.
 */
export const TOOL_LABELS: Record<string, string> = {
  // Timers
  timerDelay: 'Delay Timer',
  timerDate: 'Date Timer',
  timerContact: 'Field Timer',
  // Communications — the toolbar shows three generations
  unlayerEmail: 'Email message',
  email: 'Email (Legacy)',
  bardEmail: 'Email (Legacy)',
  letter: 'Letter',
  automatedSms: 'Text message',
  voice: 'Voice broadcast (Legacy)',
  fax: 'Fax (Legacy)',
  // Process
  tag: 'Apply/Remove Tags',
  note: 'Apply Note',
  task: 'Create Task',
  fieldValue: 'Set Field Value',
  assignOwner: 'Assign an Owner',
  opportunity: 'Create Opportunity',
  stageMove: 'Move Opportunity',
  fulfillment: 'Fulfillment List',
  createOrder: 'Create Order',
  cancelSubscription: 'Cancel Subscription',
  http: 'Send HTTP Post',
  httpRequest: 'Send HTTP Request',
  addToSequence: 'Add to Sequence',
  actionSet: 'Action Set (Legacy)',
  customerHub: 'Add to CustomerHub (Legacy)',
  // Sequences and other canvas items
  emailConfirm: 'Email Confirmation',
  decision: 'Decision',
  notes: 'Notes',
  // Goals with no entity reference — the trigger IS the tool
  tagApplied: 'Tag applied',
  linkClick: 'Email Link clicked',
  websiteTrigger: 'Web Page automation',
  taskComplete: 'Task completed',
  noteApplied: 'Note applied',
  scoreAchieved: 'Lead Score achieved',
  failedPurchase: 'Failed Purchase',
  api: 'API',
};

/**
 * References that identify the mechanism, in priority order.
 *
 * This is the heart of the rework. Many `style` values are not tools at all —
 * they are preset labels from an older palette, describing why someone added
 * the goal rather than what it does. `eventRequest` carries a `landingPageId`
 * 16 times: it is a landing-page goal that somebody labelled "Register for an
 * event". `makeCall` carries a `stageId` 9 times: an opportunity stage move.
 *
 * Deriving the tool from what the node points at is both more accurate and
 * smaller than a hand-maintained table of every historical palette entry — and
 * it cannot go stale when Keap retires a label.
 */
export const REFERENCE_TOOLS: [string, string][] = [
  ['unlayerLandingPageId', 'Landing Page'],
  ['landingPageId', 'Landing Page submitted'],
  ['webformId', 'Web Form submitted'],
  ['smartFormInstanceId', 'Web Form submitted'],
  ['internalFormId', 'Internal Form submitted'],
  ['purchaseId', 'Product purchased'],
  ['stageId', 'Opportunity Stage moved'],
];

/**
 * What this node does, in the words the campaign builder uses.
 *
 * Style wins where the style is genuinely a tool. Otherwise the mechanism is
 * read from what the node references, because a legacy style is a label rather
 * than a tool. A node that is neither is unconfigured, and says so instead of
 * being given an invented type.
 */
export function typeLabel(node: NormalizedNode): string {
  const tool = TOOL_LABELS[node.style];
  if (tool !== undefined) return tool;

  for (const [attribute, label] of REFERENCE_TOOLS) {
    if (referenceValues(node.references, attribute).length > 0) return label;
  }
  if (node.references.tagIds.length > 0) return 'Tag applied';

  // Nothing to go on: no tool, no reference. Saying "Goal (unconfigured)" is
  // honest; inventing a label from a retired palette entry would not be.
  return node.style === 'goal' || node.parent === '1' ? 'Goal (unconfigured)' : node.style;
}
