import { DiscountType, Prisma, PromoCode } from '@prisma/client';
import { randomBytes } from 'crypto';

import { prisma } from '../../db/prisma';
import { badRequest } from '../../utils/errors';

export type PromoValidationResult = {
  valid: boolean;
  reason?: string;
  promo?: PromoCode;
};

export const normalizePromoCode = (raw: string): string => {
  return String(raw ?? '')
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9_-]/g, '');
};

const generateRawCode = (length: number): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
};

export const generateUniquePromoCode = async (prefix = '', length = 8): Promise<string> => {
  const safeLength = Math.max(4, Math.min(24, length));
  const normalizedPrefix = normalizePromoCode(prefix);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = generateRawCode(safeLength);
    const code = normalizePromoCode(`${normalizedPrefix}${suffix}`);
    const exists = await prisma.promoCode.findUnique({ where: { code } });
    if (!exists) return code;
  }

  throw badRequest('Could not generate unique promo code');
};

export const validatePromoForClient = async (
  codeRaw: string,
  clientId?: string
): Promise<PromoValidationResult> => {
  const code = normalizePromoCode(codeRaw);
  if (!code) {
    return { valid: false, reason: 'PROMO_CODE_EMPTY' };
  }

  const promo = await prisma.promoCode.findUnique({ where: { code } });
  if (!promo) {
    return { valid: false, reason: 'PROMO_CODE_NOT_FOUND' };
  }

  const now = new Date();

  if (!promo.isActive) {
    return { valid: false, reason: 'PROMO_CODE_INACTIVE' };
  }
  if (promo.discountType === DiscountType.NONE) {
    return { valid: false, reason: 'PROMO_CODE_INVALID_DISCOUNT' };
  }
  if (promo.startsAt && promo.startsAt > now) {
    return { valid: false, reason: 'PROMO_CODE_NOT_STARTED' };
  }
  if (promo.endsAt && promo.endsAt <= now) {
    return { valid: false, reason: 'PROMO_CODE_EXPIRED' };
  }
  if (promo.maxUsages !== null && promo.maxUsages !== undefined && promo.usedCount >= promo.maxUsages) {
    return { valid: false, reason: 'PROMO_CODE_LIMIT_REACHED' };
  }

  if (clientId && promo.perClientUsageLimit && promo.perClientUsageLimit > 0) {
    const usedByClient = await prisma.promoCodeRedemption.count({
      where: {
        promoCodeId: promo.id,
        clientId
      }
    });
    if (usedByClient >= promo.perClientUsageLimit) {
      return { valid: false, reason: 'PROMO_CODE_CLIENT_LIMIT_REACHED' };
    }
  }

  return { valid: true, promo };
};

export const mapPromoPublic = (promo: PromoCode) => {
  return {
    id: promo.id,
    code: promo.code,
    name: promo.name,
    description: promo.description,
    discountType: promo.discountType,
    discountValue: Number((promo.discountValue as Prisma.Decimal).toFixed(2)),
    isActive: promo.isActive,
    startsAt: promo.startsAt ? promo.startsAt.toISOString() : null,
    endsAt: promo.endsAt ? promo.endsAt.toISOString() : null,
    maxUsages: promo.maxUsages,
    perClientUsageLimit: promo.perClientUsageLimit,
    usedCount: promo.usedCount,
    createdAt: promo.createdAt.toISOString(),
    updatedAt: promo.updatedAt.toISOString()
  };
};
