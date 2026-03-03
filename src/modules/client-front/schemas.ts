import { z } from 'zod';

const platformSchema = z.enum(['all', 'ios', 'android', 'web']);

const appVersionSchema = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d+){0,3}$/, 'Version must be numeric, for example: 1.0.0');

const phoneSchema = z.object({
  label: z.string().trim().min(1).max(64),
  e164: z.string().trim().regex(/^\+[1-9]\d{6,14}$/),
  display: z.string().trim().min(1).max(64).optional(),
  ext: z.string().trim().max(16).optional(),
  primary: z.boolean().optional(),
  whatsapp: z.boolean().optional(),
  telegram: z.boolean().optional(),
  viber: z.boolean().optional()
});

const addressSchema = z.object({
  label: z.string().trim().min(1).max(64),
  line1: z.string().trim().min(1).max(256),
  line2: z.string().trim().max(256).optional(),
  city: z.string().trim().max(128).optional(),
  region: z.string().trim().max(128).optional(),
  postalCode: z.string().trim().max(32).optional(),
  country: z.string().trim().max(64).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  comment: z.string().trim().max(512).optional()
});

const workingHoursSlotSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  open: z.string().regex(/^\d{2}:\d{2}$/),
  close: z.string().regex(/^\d{2}:\d{2}$/)
});

export const contactPointSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(128),
    publicName: z.string().trim().max(128).optional(),
    legalName: z.string().trim().max(256).optional(),
    aliases: z.array(z.string().trim().min(1).max(128)).max(20).optional(),
    addresses: z.array(addressSchema).min(1).max(20),
    phones: z.array(phoneSchema).min(1).max(20),
    emails: z.array(z.string().trim().email()).max(20).optional(),
    website: z.string().url().optional(),
    mapUrl: z.string().url().optional(),
    workingHours: z.array(workingHoursSlotSchema).max(50).optional(),
    orderIndex: z.number().int().min(0).max(10000).default(0),
    isPrimary: z.boolean().default(false),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(50).optional(),
    note: z.string().trim().max(1000).optional()
  })
  .refine((item) => !item.startAt || !item.endAt || new Date(item.startAt) <= new Date(item.endAt), {
    message: 'startAt must be less or equal to endAt',
    path: ['startAt']
  });

const featureFlagRuleSchema = z
  .object({
    platform: platformSchema.default('all'),
    minVersion: appVersionSchema.optional(),
    maxVersion: appVersionSchema.optional(),
    enabled: z.boolean(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional()
  })
  .refine((item) => !item.minVersion || !item.maxVersion || item.minVersion <= item.maxVersion, {
    message: 'minVersion must be <= maxVersion',
    path: ['minVersion']
  })
  .refine((item) => !item.startAt || !item.endAt || new Date(item.startAt) <= new Date(item.endAt), {
    message: 'startAt must be <= endAt',
    path: ['startAt']
  });

const featureFlagSchema = z.object({
  defaultEnabled: z.boolean().default(false),
  rules: z.array(featureFlagRuleSchema).max(100).default([])
});

export const featureFlagsSchema = z.record(
  z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  featureFlagSchema
);

const bannerPayloadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  subtitle: z.string().trim().max(400).optional(),
  imageAssetId: z.string().uuid().optional(),
  ctaText: z.string().trim().max(80).optional(),
  ctaUrl: z.string().url().optional()
});

const textPayloadSchema = z.object({
  title: z.string().trim().max(160).optional(),
  body: z.string().trim().min(1).max(6000)
});

const buttonPayloadSchema = z.object({
  label: z.string().trim().min(1).max(80),
  url: z.string().url(),
  style: z.enum(['primary', 'secondary', 'ghost']).default('primary')
});

const buttonsPayloadSchema = z.object({
  title: z.string().trim().max(160).optional(),
  items: z.array(buttonPayloadSchema).min(1).max(20)
});

const faqPayloadSchema = z.object({
  title: z.string().trim().max(160).optional(),
  items: z
    .array(
      z.object({
        question: z.string().trim().min(1).max(500),
        answer: z.string().trim().min(1).max(4000)
      })
    )
    .min(1)
    .max(100)
});

const promoPayloadSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).optional(),
  badge: z.string().trim().max(80).optional(),
  imageAssetId: z.string().uuid().optional(),
  ctaText: z.string().trim().max(80).optional(),
  ctaUrl: z.string().url().optional()
});

const offerItemSchema = z.object({
  id: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(180),
  subtitle: z.string().trim().max(300).optional(),
  description: z.string().trim().max(3000).optional(),
  imageAssetId: z.string().uuid().optional(),
  originalPrice: z.number().nonnegative().optional(),
  finalPrice: z.number().nonnegative().optional(),
  currency: z.string().trim().max(8).default('RUB'),
  ctaText: z.string().trim().max(80).optional(),
  ctaUrl: z.string().url().optional()
});

const offersPayloadSchema = z.object({
  title: z.string().trim().max(160).optional(),
  items: z.array(offerItemSchema).min(1).max(200)
});

const contactsPayloadSchema = z.object({
  title: z.string().trim().max(160).optional(),
  items: z.array(contactPointSchema).min(1).max(200)
});

const customPayloadSchema = z.record(z.string(), z.unknown());

export const blockTypeSchema = z.enum(['BANNER', 'TEXT', 'BUTTONS', 'FAQ', 'PROMO', 'OFFERS', 'CONTACTS', 'CUSTOM']);

export const blockPayloadSchemaByType = {
  BANNER: bannerPayloadSchema,
  TEXT: textPayloadSchema,
  BUTTONS: buttonsPayloadSchema,
  FAQ: faqPayloadSchema,
  PROMO: promoPayloadSchema,
  OFFERS: offersPayloadSchema,
  CONTACTS: contactsPayloadSchema,
  CUSTOM: customPayloadSchema
} as const;

export const blockCommonSchema = z
  .object({
    blockKey: z.string().trim().min(1).max(120).regex(/^[a-z0-9._:-]+$/i),
    blockType: blockTypeSchema,
    payload: z.record(z.string(), z.unknown()),
    sortOrder: z.coerce.number().int().min(0).max(100000).default(0),
    platform: platformSchema.default('all'),
    minAppVersion: appVersionSchema.optional(),
    maxAppVersion: appVersionSchema.optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    isEnabled: z.boolean().default(true)
  })
  .refine((item) => !item.minAppVersion || !item.maxAppVersion || item.minAppVersion <= item.maxAppVersion, {
    message: 'minAppVersion must be <= maxAppVersion',
    path: ['minAppVersion']
  })
  .refine((item) => !item.startAt || !item.endAt || new Date(item.startAt) <= new Date(item.endAt), {
    message: 'startAt must be <= endAt',
    path: ['startAt']
  });

export const createBlockSchema = blockCommonSchema;

export const updateBlockSchema = blockCommonSchema
  .omit({ blockKey: true })
  .partial()
  .extend({
    payload: z.record(z.string(), z.unknown()).optional()
  })
  .refine((item) => Object.keys(item).length > 0, {
    message: 'At least one field is required'
  });

export const blockIdParamsSchema = z.object({
  id: z.string().uuid()
});

export const patchClientAppConfigSchema = z
  .object({
    brandName: z.string().trim().max(128).optional(),
    legalName: z.string().trim().max(256).optional(),
    minAppVersionIos: appVersionSchema.optional(),
    minAppVersionAndroid: appVersionSchema.optional(),
    maintenanceMode: z.boolean().optional(),
    maintenanceMessage: z.string().trim().max(500).optional(),
    featureFlags: featureFlagsSchema.optional(),
    contacts: z.array(contactPointSchema).max(500).optional(),
    extra: z.record(z.string(), z.unknown()).optional()
  })
  .refine((item) => Object.keys(item).length > 0, {
    message: 'At least one field is required'
  });

export const previewQuerySchema = z.object({
  platform: platformSchema.default('all'),
  appVersion: appVersionSchema.optional(),
  at: z.string().datetime().optional()
});

export const bootstrapQuerySchema = z.object({
  platform: platformSchema.default('all'),
  appVersion: appVersionSchema.optional()
});

export const releaseListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export const mediaUploadBodySchema = z.object({
  entity: z.string().trim().min(1).max(64).regex(/^[a-z0-9._-]+$/i)
});

export const mediaListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  entity: z.string().trim().regex(/^[a-z0-9._-]+$/i).optional(),
  search: z.string().trim().min(1).max(120).optional()
});

export const mediaAssetParamsSchema = z.object({
  id: z.string().uuid(),
  usageId: z.string().uuid().optional()
});

export const createMediaUsageSchema = z.object({
  usageType: z.string().trim().min(1).max(64).regex(/^[A-Z0-9_]+$/),
  entityId: z.string().trim().min(1).max(120),
  fieldPath: z.string().trim().max(256).default(''),
  note: z.string().trim().max(500).optional()
});

export const specialistParamsSchema = z.object({
  staffId: z.string().uuid()
});

export const patchSpecialistProfileSchema = z
  .object({
    photoAssetId: z.string().uuid().nullable().optional(),
    specialty: z.string().trim().min(1).max(120).nullable().optional(),
    info: z.string().trim().min(1).max(4000).nullable().optional(),
    ctaText: z.string().trim().min(1).max(80).nullable().optional(),
    isVisible: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(100000).optional()
  })
  .refine((item) => Object.keys(item).length > 0, {
    message: 'At least one field is required'
  });

export const BLOCK_PAYLOAD_JSON_SCHEMA: Record<string, unknown> = {
  BANNER: {
    type: 'object',
    required: ['title'],
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      imageAssetId: { type: 'string', format: 'uuid' },
      ctaText: { type: 'string' },
      ctaUrl: { type: 'string', format: 'uri' }
    }
  },
  FAQ: {
    type: 'object',
    required: ['items'],
    properties: {
      title: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['question', 'answer'],
          properties: {
            question: { type: 'string' },
            answer: { type: 'string' }
          }
        }
      }
    }
  },
  CONTACTS: {
    type: 'object',
    required: ['items'],
    properties: {
      title: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name', 'addresses', 'phones'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            addresses: { type: 'array' },
            phones: { type: 'array' }
          }
        }
      }
    }
  }
};

export type PlatformInput = z.infer<typeof platformSchema>;
