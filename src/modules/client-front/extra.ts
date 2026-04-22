import { z } from 'zod';

import { badRequest } from '../../utils/errors';

const sitePageHeroKeys = [
  'about',
  'booking',
  'careers',
  'contacts',
  'gallery',
  'giftCards',
  'masters',
  'masterDetails',
  'news',
  'newsArticle',
  'offers',
  'privacyPolicy',
  'prices',
  'services',
  'serviceCategory',
  'serviceDetails'
] as const;

const sitePageHeroKeySet = new Set<string>(sitePageHeroKeys);

const pageHeroEntrySchema = z.object({
  eyebrow: z.string().trim().max(160).optional(),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(1200).optional(),
  imageAssetId: z.string().uuid().optional()
});

const bookingPageShortTextSchema = z.string().trim().min(1).max(240);
const bookingPageLongTextSchema = z.string().trim().min(1).max(3000);
const bookingPageTemplateTextSchema = z.string().trim().min(1).max(600);
const homePageShortTextSchema = z.string().trim().max(240);
const homePageTitleTextSchema = z.string().trim().max(400);
const homePageLongTextSchema = z.string().trim().max(3000);

const bookingPageSchema = z.object({
  heroActions: z
    .object({
      phoneLabel: bookingPageShortTextSchema.optional(),
      servicesLabel: bookingPageShortTextSchema.optional(),
      contactsLabel: bookingPageShortTextSchema.optional()
    })
    .optional(),
  connectivityNotice: z
    .object({
      title: bookingPageTemplateTextSchema.optional(),
      description: bookingPageLongTextSchema.optional()
    })
    .optional(),
  panel: z
    .object({
      eyebrow: bookingPageShortTextSchema.optional(),
      availabilityBadge: bookingPageShortTextSchema.optional(),
      title: bookingPageTemplateTextSchema.optional(),
      description: bookingPageLongTextSchema.optional(),
      cartEyebrow: bookingPageShortTextSchema.optional(),
      cartDescription: bookingPageLongTextSchema.optional(),
      showCatalogLabel: bookingPageShortTextSchema.optional(),
      hideCatalogLabel: bookingPageShortTextSchema.optional(),
      cartListLabel: bookingPageShortTextSchema.optional(),
      cartSummaryLabel: bookingPageShortTextSchema.optional(),
      searchPlaceholder: bookingPageShortTextSchema.optional(),
      allCategoryLabel: bookingPageShortTextSchema.optional(),
      emptyCartMessage: bookingPageLongTextSchema.optional(),
      emptyCatalogMessage: bookingPageLongTextSchema.optional(),
      emptySearchMessage: bookingPageLongTextSchema.optional(),
      resultsHintTemplate: bookingPageTemplateTextSchema.optional()
    })
    .optional(),
  schedule: z
    .object({
      title: bookingPageShortTextSchema.optional(),
      description: bookingPageLongTextSchema.optional(),
      daysAheadLabel: bookingPageShortTextSchema.optional(),
      emptySelectionMessage: bookingPageLongTextSchema.optional(),
      masterLabel: bookingPageShortTextSchema.optional(),
      anyMasterLabel: bookingPageShortTextSchema.optional(),
      manualDateLabel: bookingPageShortTextSchema.optional(),
      dateHintEmpty: bookingPageTemplateTextSchema.optional(),
      dateHintLoading: bookingPageTemplateTextSchema.optional(),
      dateHintFirstSlotTemplate: bookingPageTemplateTextSchema.optional(),
      dateHintSlotsTemplate: bookingPageTemplateTextSchema.optional(),
      dateHintNoSlots: bookingPageTemplateTextSchema.optional(),
      slotsTitle: bookingPageShortTextSchema.optional(),
      slotsDescription: bookingPageLongTextSchema.optional(),
      slotsEmptyServices: bookingPageLongTextSchema.optional(),
      slotsEmptyResults: bookingPageLongTextSchema.optional(),
      noWindowsLabel: bookingPageShortTextSchema.optional()
    })
    .optional(),
  confirmation: z
    .object({
      eyebrow: bookingPageShortTextSchema.optional(),
      title: bookingPageTemplateTextSchema.optional(),
      authenticatedDescriptionTemplate: bookingPageTemplateTextSchema.optional(),
      guestDescription: bookingPageLongTextSchema.optional(),
      loginCalloutDescription: bookingPageLongTextSchema.optional(),
      loginButtonLabel: bookingPageShortTextSchema.optional(),
      registerButtonLabel: bookingPageShortTextSchema.optional(),
      profileLabel: bookingPageShortTextSchema.optional(),
      discountDescriptionTemplate: bookingPageTemplateTextSchema.optional(),
      promoLabel: bookingPageShortTextSchema.optional(),
      promoPlaceholder: bookingPageShortTextSchema.optional(),
      commentLabel: bookingPageShortTextSchema.optional(),
      commentPlaceholder: bookingPageShortTextSchema.optional(),
      summaryTitle: bookingPageShortTextSchema.optional(),
      summaryServicesLabel: bookingPageShortTextSchema.optional(),
      summaryTimeLabel: bookingPageShortTextSchema.optional(),
      summaryPriceLabel: bookingPageShortTextSchema.optional(),
      summaryServicesEmpty: bookingPageLongTextSchema.optional(),
      summarySlotEmpty: bookingPageLongTextSchema.optional(),
      discountSummaryTemplate: bookingPageTemplateTextSchema.optional(),
      basePriceTemplate: bookingPageTemplateTextSchema.optional(),
      promoPriorityNotice: bookingPageLongTextSchema.optional(),
      successTitle: bookingPageTemplateTextSchema.optional(),
      submitLabel: bookingPageShortTextSchema.optional(),
      submitLoadingLabel: bookingPageShortTextSchema.optional(),
      loginForBookingLabel: bookingPageShortTextSchema.optional()
    })
    .optional()
});

const homePageHeroSchema = z.object({
  eyebrow: homePageShortTextSchema.optional(),
  title: homePageTitleTextSchema.optional(),
  description: homePageLongTextSchema.optional(),
  primaryCtaLabel: homePageShortTextSchema.optional(),
  secondaryCtaLabel: homePageShortTextSchema.optional(),
  visualLabel: homePageShortTextSchema.optional(),
  visualTitle: homePageTitleTextSchema.optional(),
  visualSubtitle: homePageLongTextSchema.optional(),
  visualImageAssetId: z.string().uuid().optional()
});

const homePageActionSectionSchema = z.object({
  eyebrow: homePageShortTextSchema.optional(),
  title: homePageTitleTextSchema.optional(),
  description: homePageLongTextSchema.optional(),
  actionLabel: homePageShortTextSchema.optional()
});

const homePagePopularServicesSchema = homePageActionSectionSchema.extend({
  itemsLimit: z.coerce.number().int().min(1).max(12).optional()
});

const homePageNewsSchema = homePageActionSectionSchema.extend({
  itemsLimit: z.coerce.number().int().min(1).max(12).optional()
});

const homePageValuePillarSchema = z.object({
  title: homePageShortTextSchema.optional(),
  text: homePageLongTextSchema.optional()
});

const homePageValuePillarsSchema = z.object({
  eyebrow: homePageShortTextSchema.optional(),
  title: homePageTitleTextSchema.optional(),
  description: homePageLongTextSchema.optional(),
  items: z.array(homePageValuePillarSchema).max(12).optional()
});

const homePageContactsSchema = z.object({
  eyebrow: homePageShortTextSchema.optional(),
  title: homePageTitleTextSchema.optional(),
  description: homePageLongTextSchema.optional(),
  primaryCtaLabel: homePageShortTextSchema.optional(),
  secondaryCtaLabel: homePageShortTextSchema.optional()
});

const homePageHighlightSchema = z.object({
  title: homePageShortTextSchema.optional(),
  description: homePageLongTextSchema.optional()
});

const homePageBottomCtaSchema = z.object({
  eyebrow: homePageShortTextSchema.optional(),
  title: homePageTitleTextSchema.optional(),
  description: homePageLongTextSchema.optional(),
  primaryCtaLabel: homePageShortTextSchema.optional(),
  secondaryCtaLabel: homePageShortTextSchema.optional()
});

const homePageSchema = z.object({
  hero: homePageHeroSchema.optional(),
  news: homePageNewsSchema.optional(),
  categories: homePagePopularServicesSchema.optional(),
  valuePillars: homePageValuePillarsSchema.optional(),
  featuredServices: homePageActionSectionSchema.optional(),
  featuredSpecialists: homePageActionSectionSchema.optional(),
  contacts: homePageContactsSchema.optional(),
  highlights: z.array(homePageHighlightSchema).max(12).optional(),
  bottomCta: homePageBottomCtaSchema.optional()
});

const offerItemSchema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/),
  title: z.string().trim().min(1).max(180),
  subtitle: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(3000),
  badge: z.string().trim().min(1).max(80),
  priceNote: z.string().trim().min(1).max(300),
  ctaHref: z.string().trim().min(1).max(500),
  imageAssetId: z.string().uuid().optional()
});

const newsArticleSchema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/),
  title: z.string().trim().min(1).max(220),
  category: z.string().trim().min(1).max(120),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  excerpt: z.string().trim().min(1).max(2000),
  body: z.array(z.string().trim().min(1).max(4000)).max(100),
  imageAssetId: z.string().uuid().optional()
});

const locationInteriorMomentSchema = z.object({
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().min(1).max(1200)
});

const locationProfileSchema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1).max(180),
  district: z.string().trim().min(1).max(160),
  address: z.string().trim().min(1).max(300),
  phone: z.string().trim().min(1).max(80),
  workingHours: z.string().trim().min(1).max(160),
  mapUrl: z.string().trim().url().max(1000),
  description: z.string().trim().min(1).max(2000),
  note: z.string().trim().min(1).max(1200),
  imageAssetId: z.string().uuid().optional(),
  serviceSlugs: z.array(z.string().trim().min(1).max(120)).max(200),
  masterSlugs: z.array(z.string().trim().min(1).max(120)).max(200),
  features: z.array(z.string().trim().min(1).max(200)).max(100),
  interiorMoments: z.array(locationInteriorMomentSchema).max(50)
});

const policySectionSchema = z.object({
  id: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/),
  title: z.string().trim().min(1).max(240),
  paragraphs: z.array(z.string().trim().min(1).max(4000)).min(1).max(50)
});

const policyContentSchema = z.object({
  eyebrow: z.string().trim().max(160).optional(),
  title: z.string().trim().max(220).optional(),
  description: z.string().trim().max(2000).optional(),
  summaryEyebrow: z.string().trim().max(160).optional(),
  summaryTitle: z.string().trim().max(220).optional(),
  operatorLabel: z.string().trim().max(160).optional(),
  contactLabel: z.string().trim().max(160).optional(),
  addressLabel: z.string().trim().max(160).optional(),
  summaryNote: z.string().trim().max(3000).optional(),
  contactCtaLabel: z.string().trim().max(160).optional(),
  bookingConsentLabel: z.string().trim().max(600).optional(),
  accountConsentLabel: z.string().trim().max(600).optional(),
  cookieBannerTitle: z.string().trim().max(220).optional(),
  cookieBannerDescription: z.string().trim().max(2000).optional(),
  cookieBannerAcceptLabel: z.string().trim().max(120).optional(),
  cookieBannerNecessaryLabel: z.string().trim().max(160).optional(),
  sections: z.array(policySectionSchema).max(50).optional()
});

const siteContentSchema = z.object({
  homePage: homePageSchema.optional(),
  offers: z.array(offerItemSchema).max(200).optional(),
  news: z.array(newsArticleSchema).max(500).optional(),
  locations: z.array(locationProfileSchema).max(200).optional(),
  policy: policyContentSchema.optional()
});

const siteVisibilitySchema = z.object({
  hiddenBlockKeys: z.array(z.string().trim().min(1).max(160)).max(1000).optional()
});

const asObjectRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
};

const assertUniqueBy = <T extends Record<string, unknown>>(items: T[], key: keyof T, label: string) => {
  const seen = new Set<string>();

  for (const item of items) {
    const value = String(item[key] ?? '').trim();
    if (!value) {
      continue;
    }
    if (seen.has(value)) {
      throw badRequest(`${label} contains duplicate ${String(key)}: ${value}`);
    }
    seen.add(value);
  }
};

export const validateClientFrontExtra = (extra: Record<string, unknown>) => {
  const nextExtra = { ...extra };

  if ('pageHero' in nextExtra) {
    const pageHeroSource = asObjectRecord(nextExtra.pageHero);
    const normalizedPageHero: Record<string, z.infer<typeof pageHeroEntrySchema>> = {};

    for (const [key, value] of Object.entries(pageHeroSource)) {
      if (!sitePageHeroKeySet.has(key)) {
        throw badRequest(`Unknown pageHero key: ${key}`);
      }
      const parsed = pageHeroEntrySchema.safeParse(value);
      if (!parsed.success) {
        throw badRequest('Invalid pageHero payload', parsed.error.flatten());
      }
      normalizedPageHero[key] = parsed.data;
    }

    nextExtra.pageHero = normalizedPageHero;
  }

  if ('siteContent' in nextExtra) {
    const parsed = siteContentSchema.safeParse(nextExtra.siteContent);
    if (!parsed.success) {
      throw badRequest('Invalid siteContent payload', parsed.error.flatten());
    }

    if (parsed.data.offers) {
      assertUniqueBy(parsed.data.offers, 'slug', 'siteContent.offers');
    }
    if (parsed.data.news) {
      assertUniqueBy(parsed.data.news, 'slug', 'siteContent.news');
    }
    if (parsed.data.locations) {
      assertUniqueBy(parsed.data.locations, 'slug', 'siteContent.locations');
    }
    if (parsed.data.policy?.sections) {
      assertUniqueBy(parsed.data.policy.sections, 'id', 'siteContent.policy.sections');
    }

    nextExtra.siteContent = parsed.data;
  }

  if ('bookingPage' in nextExtra) {
    const parsed = bookingPageSchema.safeParse(nextExtra.bookingPage);
    if (!parsed.success) {
      throw badRequest('Invalid bookingPage payload', parsed.error.flatten());
    }

    nextExtra.bookingPage = parsed.data;
  }

  if ('siteVisibility' in nextExtra) {
    const parsed = siteVisibilitySchema.safeParse(nextExtra.siteVisibility);
    if (!parsed.success) {
      throw badRequest('Invalid siteVisibility payload', parsed.error.flatten());
    }

    nextExtra.siteVisibility = parsed.data;
  }

  return nextExtra;
};
