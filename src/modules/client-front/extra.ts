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
  'prices',
  'services',
  'serviceCategory',
  'serviceDetails'
] as const;

const sitePageHeroKeySet = new Set<string>(sitePageHeroKeys);

const pageHeroEntrySchema = z.object({
  eyebrow: z.string().trim().max(160).optional(),
  title: z.string().trim().max(200).optional(),
  description: z.string().trim().max(1200).optional()
});

const offerItemSchema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/),
  title: z.string().trim().min(1).max(180),
  subtitle: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(3000),
  badge: z.string().trim().min(1).max(80),
  priceNote: z.string().trim().min(1).max(300),
  ctaHref: z.string().trim().min(1).max(500)
});

const newsArticleSchema = z.object({
  slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/),
  title: z.string().trim().min(1).max(220),
  category: z.string().trim().min(1).max(120),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  excerpt: z.string().trim().min(1).max(2000),
  body: z.array(z.string().trim().min(1).max(4000)).max(100)
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
  serviceSlugs: z.array(z.string().trim().min(1).max(120)).max(200),
  masterSlugs: z.array(z.string().trim().min(1).max(120)).max(200),
  features: z.array(z.string().trim().min(1).max(200)).max(100),
  interiorMoments: z.array(locationInteriorMomentSchema).max(50)
});

const siteContentSchema = z.object({
  offers: z.array(offerItemSchema).max(200).optional(),
  news: z.array(newsArticleSchema).max(500).optional(),
  locations: z.array(locationProfileSchema).max(200).optional()
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

    nextExtra.siteContent = parsed.data;
  }

  return nextExtra;
};
