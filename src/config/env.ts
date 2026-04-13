import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),
  API_BASE_URL: z.string().url().optional(),
  STAFF_WEB_BASE_URL: z.string().url().optional(),
  CLIENT_WEB_BASE_URL: z.string().url().optional(),
  CLIENT_WEB_RESET_PASSWORD_PATH: z.string().default('/reset-password'),
  TZ_DEFAULT: z.string().default('Europe/Moscow'),
  DEV_SHOW_LINKS: z.enum(['true', 'false']).default('true'),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  APNS_PRIVATE_KEY: z.string().min(1).optional(),
  APNS_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  OWNER_EMAIL: z.string().email().optional(),
  OWNER_NAME: z.string().optional(),
  OWNER_PIN: z.string().min(4).max(16).optional(),
  OWNER_PHONE: z.string().min(1),
  MEDIA_ROOT: z.string().default('/var/lib/mari-server/media'),
  MEDIA_PUBLIC_BASE: z.string().default('/media'),
  MEDIA_PUBLIC_ORIGIN: z.string().url().optional(),
  MEDIA_MAX_UPLOAD_MB: z.coerce.number().int().positive().max(200).default(15),
  MEDIA_MAX_DIMENSION: z.coerce.number().int().positive().max(12000).default(6000),
  MEDIA_WEBP_QUALITY: z.coerce.number().int().min(1).max(100).default(82),
  MEDIA_VARIANT_WIDTHS: z.string().default('360,720,1280')
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Environment validation failed', parsed.error.format());
  process.exit(1);
}

const normalizeMediaPublicBase = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '/media';
  const withPrefix = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withPrefix.replace(/\/+$/, '');
};

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, '');
const normalizePath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '/';
  const withPrefix = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withPrefix.replace(/\/+$/, '') || '/';
};

const mediaVariantWidths = [...new Set(parsed.data.MEDIA_VARIANT_WIDTHS.split(',').map((item) => Number(item.trim())))]
  .filter((value) => Number.isInteger(value) && value > 0)
  .sort((a, b) => a - b);

if (mediaVariantWidths.length === 0) {
  console.error('Environment validation failed', { MEDIA_VARIANT_WIDTHS: 'No valid widths configured' });
  process.exit(1);
}

const hasAnyApnsConfig = [
  parsed.data.APNS_KEY_ID,
  parsed.data.APNS_TEAM_ID,
  parsed.data.APNS_BUNDLE_ID,
  parsed.data.APNS_PRIVATE_KEY,
  parsed.data.APNS_PRIVATE_KEY_PATH,
].some((value) => Boolean(value));

const hasCompleteApnsConfig =
  Boolean(parsed.data.APNS_KEY_ID) &&
  Boolean(parsed.data.APNS_TEAM_ID) &&
  Boolean(parsed.data.APNS_BUNDLE_ID) &&
  Boolean(parsed.data.APNS_PRIVATE_KEY || parsed.data.APNS_PRIVATE_KEY_PATH);

if (hasAnyApnsConfig && !hasCompleteApnsConfig) {
  console.error('Environment validation failed', {
    APNS: 'Set APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID and either APNS_PRIVATE_KEY or APNS_PRIVATE_KEY_PATH',
  });
  process.exit(1);
}

export const env = {
  ...parsed.data,
  APP_BASE_URL: normalizeBaseUrl(parsed.data.APP_BASE_URL),
  API_BASE_URL: normalizeBaseUrl(parsed.data.API_BASE_URL ?? parsed.data.APP_BASE_URL),
  STAFF_WEB_BASE_URL: normalizeBaseUrl(parsed.data.STAFF_WEB_BASE_URL ?? parsed.data.APP_BASE_URL),
  CLIENT_WEB_BASE_URL: normalizeBaseUrl(parsed.data.CLIENT_WEB_BASE_URL ?? parsed.data.APP_BASE_URL),
  CLIENT_WEB_RESET_PASSWORD_PATH: normalizePath(parsed.data.CLIENT_WEB_RESET_PASSWORD_PATH),
  DEV_SHOW_LINKS: parsed.data.DEV_SHOW_LINKS === 'true',
  SMTP_SECURE: parsed.data.SMTP_SECURE === 'true',
  APNS_ENABLED: hasCompleteApnsConfig,
  MEDIA_PUBLIC_BASE: normalizeMediaPublicBase(parsed.data.MEDIA_PUBLIC_BASE),
  MEDIA_VARIANT_WIDTHS: mediaVariantWidths
};
