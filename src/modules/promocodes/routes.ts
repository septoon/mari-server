import { DiscountType } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma';
import { authenticateOptional, authenticateRequired, requirePermission, requireStaff } from '../../middlewares/auth';
import { validateBody, validateParams, validateQuery } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { badRequest, notFound } from '../../utils/errors';
import { sendEmail } from '../../utils/mailer';
import { D } from '../../utils/money';
import { normalizePhone10 } from '../../utils/phone';
import { ok } from '../../utils/response';
import {
  generateUniquePromoCode,
  mapPromoPublic,
  normalizePromoCode,
  validatePromoForClient
} from './service';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  isActive: z.union([z.literal('true'), z.literal('false')]).optional(),
  search: z.string().trim().min(1).optional()
});

const createPromoSchema = z.object({
  code: z.string().min(1).optional(),
  generate: z.boolean().optional(),
  prefix: z.string().optional(),
  length: z.coerce.number().int().min(4).max(24).optional(),
  name: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
  discountType: z.enum(['FIXED', 'PERCENT']),
  discountValue: z.coerce.number().positive(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  maxUsages: z.coerce.number().int().positive().optional(),
  perClientUsageLimit: z.coerce.number().int().positive().optional(),
  isActive: z.boolean().optional()
});

const updatePromoSchema = z.object({
  name: z.string().trim().max(120).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  discountType: z.enum(['FIXED', 'PERCENT']).optional(),
  discountValue: z.coerce.number().positive().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  maxUsages: z.coerce.number().int().positive().nullable().optional(),
  perClientUsageLimit: z.coerce.number().int().positive().nullable().optional(),
  isActive: z.boolean().optional()
});

const idParamSchema = z.object({
  id: z.string().uuid()
});

const sendPromoSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
  clientId: z.string().uuid().optional(),
  subject: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(5000).optional()
});

const validateQuerySchema = z.object({
  code: z.string().min(1),
  phone: z.string().min(1).optional()
});

const validatePromoPayload = (payload: {
  discountType: 'FIXED' | 'PERCENT';
  discountValue: number;
  startsAt?: string | null;
  endsAt?: string | null;
}) => {
  if (payload.discountType === 'PERCENT' && payload.discountValue > 100) {
    throw badRequest('Percent discount must be <= 100');
  }

  if (payload.startsAt && payload.endsAt) {
    const startsAt = new Date(payload.startsAt);
    const endsAt = new Date(payload.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      throw badRequest('Invalid promo active interval');
    }
  }
};

export const promoCodesRouter = Router();

promoCodesRouter.get(
  '/validate',
  authenticateOptional,
  validateQuery(validateQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof validateQuerySchema>;

    let clientId: string | undefined;
    if (req.auth?.subjectType === 'CLIENT') {
      clientId = req.auth.subjectId;
    } else if (query.phone) {
      const phone10 = normalizePhone10(query.phone);
      const client = await prisma.client.findUnique({ where: { phone10 }, select: { id: true } });
      clientId = client?.id;
    }

    const result = await validatePromoForClient(query.code, clientId);
    if (!result.valid || !result.promo) {
      return ok(res, {
        valid: false,
        reason: result.reason
      });
    }

    return ok(res, {
      valid: true,
      promo: mapPromoPublic(result.promo)
    });
  })
);

promoCodesRouter.get(
  '/',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_PROMOCODES'),
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof listQuerySchema>;
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;

    const where = {
      ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search.toUpperCase() } },
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { description: { contains: query.search, mode: 'insensitive' as const } }
            ]
          }
        : {})
    };

    const [total, rows] = await Promise.all([
      prisma.promoCode.count({ where }),
      prisma.promoCode.findMany({
        where,
        include: {
          createdByStaff: { select: { id: true, name: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    return ok(
      res,
      {
        items: rows.map((row) => ({
          ...mapPromoPublic(row),
          createdBy: row.createdByStaff
            ? {
                id: row.createdByStaff.id,
                name: row.createdByStaff.name
              }
            : null
        }))
      },
      200,
      {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    );
  })
);

promoCodesRouter.post(
  '/',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_PROMOCODES'),
  validateBody(createPromoSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createPromoSchema>;

    validatePromoPayload({
      discountType: body.discountType,
      discountValue: body.discountValue,
      startsAt: body.startsAt,
      endsAt: body.endsAt
    });

    const generated = body.generate || !body.code;
    const finalCode = generated
      ? await generateUniquePromoCode(body.prefix ?? '', body.length ?? 8)
      : normalizePromoCode(body.code!);

    if (!finalCode) {
      throw badRequest('Promo code is required');
    }

    const exists = await prisma.promoCode.findUnique({ where: { code: finalCode } });
    if (exists) {
      throw badRequest('Promo code already exists');
    }

    const promo = await prisma.promoCode.create({
      data: {
        code: finalCode,
        name: body.name?.trim() || null,
        description: body.description?.trim() || null,
        discountType: body.discountType as DiscountType,
        discountValue: D(body.discountValue),
        isActive: body.isActive ?? true,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        maxUsages: body.maxUsages ?? null,
        perClientUsageLimit: body.perClientUsageLimit ?? null,
        createdByStaffId: req.auth!.subjectId
      }
    });

    return ok(res, { promo: mapPromoPublic(promo) }, 201);
  })
);

promoCodesRouter.patch(
  '/:id',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_PROMOCODES'),
  validateParams(idParamSchema),
  validateBody(updatePromoSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof updatePromoSchema>;

    const existing = await prisma.promoCode.findUnique({ where: { id } });
    if (!existing) {
      throw notFound('Promo code not found');
    }

    validatePromoPayload({
      discountType: body.discountType ?? (existing.discountType as 'FIXED' | 'PERCENT'),
      discountValue: body.discountValue ?? Number(existing.discountValue),
      startsAt: body.startsAt === undefined ? (existing.startsAt ? existing.startsAt.toISOString() : null) : body.startsAt,
      endsAt: body.endsAt === undefined ? (existing.endsAt ? existing.endsAt.toISOString() : null) : body.endsAt
    });

    const updated = await prisma.promoCode.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.discountType ? { discountType: body.discountType as DiscountType } : {}),
        ...(body.discountValue !== undefined ? { discountValue: D(body.discountValue) } : {}),
        ...(body.startsAt !== undefined ? { startsAt: body.startsAt ? new Date(body.startsAt) : null } : {}),
        ...(body.endsAt !== undefined ? { endsAt: body.endsAt ? new Date(body.endsAt) : null } : {}),
        ...(body.maxUsages !== undefined ? { maxUsages: body.maxUsages } : {}),
        ...(body.perClientUsageLimit !== undefined ? { perClientUsageLimit: body.perClientUsageLimit } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {})
      }
    });

    return ok(res, { promo: mapPromoPublic(updated) });
  })
);

promoCodesRouter.post(
  '/:id/send',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_PROMOCODES'),
  validateParams(idParamSchema),
  validateBody(sendPromoSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof sendPromoSchema>;

    if (!body.email && !body.phone && !body.clientId) {
      throw badRequest('Provide one of: email, phone, clientId');
    }

    const promo = await prisma.promoCode.findUnique({ where: { id } });
    if (!promo) {
      throw notFound('Promo code not found');
    }

    let targetEmail = body.email;
    let targetName: string | null = null;
    let targetPhoneE164: string | null = null;

    if (!targetEmail && (body.clientId || body.phone)) {
      const phone10 = body.phone ? normalizePhone10(body.phone) : undefined;
      const client = await prisma.client.findFirst({
        where: {
          ...(body.clientId ? { id: body.clientId } : {}),
          ...(phone10 ? { phone10 } : {})
        },
        include: {
          account: {
            select: { email: true }
          }
        }
      });

      if (!client) {
        throw notFound('Client not found');
      }

      targetEmail = client.account?.email ?? undefined;
      targetName = client.name;
      targetPhoneE164 = client.phoneE164;
    }

    if (!targetEmail) {
      throw badRequest('Target email not found. Pass email directly or attach client account email');
    }

    const discountText =
      promo.discountType === 'PERCENT' ? `${Number(promo.discountValue)}%` : `${Number(promo.discountValue)} ₽`;

    const subject = body.subject ?? `Промокод ${promo.code} для записи в салон`;
    const text =
      body.message ??
      [
        `Здравствуйте${targetName ? `, ${targetName}` : ''}!`,
        '',
        `Ваш промокод: ${promo.code}`,
        `Скидка: ${discountText}`,
        promo.endsAt ? `Действует до: ${promo.endsAt.toISOString()}` : 'Срок действия: без ограничения',
        '',
        'Используйте промокод при создании записи.'
      ].join('\n');

    const result = await sendEmail({
      to: targetEmail,
      subject,
      text
    });

    return ok(res, {
      sent: result.sent,
      deliveryMode: result.deliveryMode,
      email: targetEmail,
      phoneE164: targetPhoneE164,
      promo: mapPromoPublic(promo),
      messageId: result.messageId ?? null,
      preview: result.preview ?? null
    });
  })
);
