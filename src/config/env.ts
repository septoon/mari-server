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
  TZ_DEFAULT: z.string().default('Europe/Moscow'),
  DEV_SHOW_LINKS: z.enum(['true', 'false']).default('true'),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.enum(['true', 'false']).default('false'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),
  SMTP_FROM: z.string().min(1).optional(),
  OWNER_EMAIL: z.string().email().optional(),
  OWNER_NAME: z.string().optional(),
  OWNER_PIN: z.string().min(4).max(16).optional(),
  OWNER_PHONE: z.string().min(1)
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Environment validation failed', parsed.error.format());
  process.exit(1);
}

export const env = {
  ...parsed.data,
  DEV_SHOW_LINKS: parsed.data.DEV_SHOW_LINKS === 'true',
  SMTP_SECURE: parsed.data.SMTP_SECURE === 'true'
};
