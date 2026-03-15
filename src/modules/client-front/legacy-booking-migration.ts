import { validateClientFrontExtra } from './extra';

type LegacyBookingBlock = {
  blockType: string;
  payload: unknown;
};

const LEGACY_BOOKING_BLOCK_TYPES = new Set(['BANNER', 'TEXT', 'BUTTONS', 'FAQ']);

const asObjectRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

const asRecordArray = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asObjectRecord(item))
    .filter((item) => Object.keys(item).length > 0);
};

const asStringValue = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';

const hasConfiguredStrings = (value: Record<string, unknown>) =>
  Object.values(value).some((item) => typeof item === 'string' && item.trim());

const setIfMissing = (
  target: Record<string, unknown>,
  key: string,
  value: unknown
) => {
  const nextValue = asStringValue(value);
  if (!nextValue || asStringValue(target[key])) {
    return false;
  }
  target[key] = nextValue;
  return true;
};

const normalizeLinkTarget = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.toLowerCase().startsWith('tel:')) {
    return 'tel:';
  }

  try {
    const url = new URL(trimmed, 'https://mari.local');
    if (url.protocol === 'tel:') {
      return 'tel:';
    }
    return url.pathname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};

const migrateActionLabel = (
  heroActions: Record<string, unknown>,
  label: unknown,
  href: unknown
) => {
  const nextLabel = asStringValue(label);
  const target = normalizeLinkTarget(asStringValue(href));

  if (!nextLabel || !target) {
    return false;
  }

  if (target === 'tel:') {
    return setIfMissing(heroActions, 'phoneLabel', nextLabel);
  }

  if (
    target.startsWith('/services') ||
    target.startsWith('/prices') ||
    target.startsWith('/booking?service=')
  ) {
    return setIfMissing(heroActions, 'servicesLabel', nextLabel);
  }

  if (target.startsWith('/contacts') || target.startsWith('/locations')) {
    return setIfMissing(heroActions, 'contactsLabel', nextLabel);
  }

  return false;
};

export const migrateLegacyBookingContent = (
  extra: Record<string, unknown>,
  blocks: LegacyBookingBlock[]
) => {
  const relevantBlocks = blocks.filter((block) =>
    LEGACY_BOOKING_BLOCK_TYPES.has(block.blockType)
  );

  if (relevantBlocks.length === 0) {
    return extra;
  }

  const nextExtra = { ...extra };
  const nextPageHero = { ...asObjectRecord(nextExtra.pageHero) };
  const nextBookingHero = { ...asObjectRecord(nextPageHero.booking) };
  const nextBookingPage = { ...asObjectRecord(nextExtra.bookingPage) };
  const nextHeroActions = { ...asObjectRecord(nextBookingPage.heroActions) };
  const nextPanel = { ...asObjectRecord(nextBookingPage.panel) };
  const nextConfirmation = { ...asObjectRecord(nextBookingPage.confirmation) };
  let changed = false;

  const bannerBlock = relevantBlocks.find((block) => block.blockType === 'BANNER');
  const textBlocks = relevantBlocks.filter((block) => block.blockType === 'TEXT');
  const buttonBlocks = relevantBlocks.filter((block) => block.blockType === 'BUTTONS');

  if (bannerBlock) {
    const payload = asObjectRecord(bannerBlock.payload);
    changed = setIfMissing(nextBookingHero, 'title', payload.title) || changed;
    changed = setIfMissing(nextBookingHero, 'description', payload.subtitle) || changed;
    changed =
      migrateActionLabel(nextHeroActions, payload.ctaText, payload.ctaUrl) || changed;
  }

  const primaryTextBlock = textBlocks[0];
  if (primaryTextBlock) {
    const payload = asObjectRecord(primaryTextBlock.payload);
    changed = setIfMissing(nextPanel, 'title', payload.title) || changed;
    changed = setIfMissing(nextPanel, 'description', payload.body) || changed;
  }

  const secondaryTextBlock = textBlocks[1];
  if (secondaryTextBlock) {
    const payload = asObjectRecord(secondaryTextBlock.payload);
    changed = setIfMissing(nextConfirmation, 'title', payload.title) || changed;
    changed =
      setIfMissing(nextConfirmation, 'guestDescription', payload.body) || changed;
  }

  for (const block of buttonBlocks) {
    const payload = asObjectRecord(block.payload);
    for (const item of asRecordArray(payload.items)) {
      changed = migrateActionLabel(nextHeroActions, item.label, item.url) || changed;
    }
  }

  if (!changed) {
    return extra;
  }

  if (hasConfiguredStrings(nextBookingHero)) {
    nextPageHero.booking = nextBookingHero;
    nextExtra.pageHero = nextPageHero;
  }

  if (hasConfiguredStrings(nextHeroActions)) {
    nextBookingPage.heroActions = nextHeroActions;
  }
  if (hasConfiguredStrings(nextPanel)) {
    nextBookingPage.panel = nextPanel;
  }
  if (hasConfiguredStrings(nextConfirmation)) {
    nextBookingPage.confirmation = nextConfirmation;
  }
  if (
    Object.values(nextBookingPage).some(
      (item) => typeof item === 'object' && item !== null && hasConfiguredStrings(asObjectRecord(item))
    )
  ) {
    nextExtra.bookingPage = nextBookingPage;
  }

  return validateClientFrontExtra(nextExtra);
};
