import { DiscountType, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma';
import {
  authenticateRequired,
  requirePermission,
  requireStaff,
  requireStaffRolesOrPermissions,
  requireStaffRolesOrPermission,
} from '../../middlewares/auth';
import { validateBody, validateParams, validateQuery } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { badRequest, notFound } from '../../utils/errors';
import { D, toNumber } from '../../utils/money';
import { hashSecret } from '../../utils/password';
import { normalizePhone10, toPhoneE164 } from '../../utils/phone';
import { ok } from '../../utils/response';
import { notifyOnClientDiscountChanged } from '../notifications/service';
import { deleteAppointmentsCascade } from '../appointments/service';
import {
  clientAvatarUpload,
  deleteClientAvatar,
  removeClientAvatarFileByPath,
  resolveClientAvatarUrl,
  saveClientAvatar
} from './avatar';
import { upsertClientByPhone } from './service';

const listClientsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().min(1).optional(),
  categoryId: z.string().uuid().optional()
});

const loyaltyListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().min(1).optional(),
  activeTemporary: z.union([z.literal('true'), z.literal('false')]).optional()
});

const clientIdParamSchema = z.object({
  id: z.string().uuid()
});

const discountPayloadSchema = z.object({
  mode: z.enum(['PERMANENT', 'TEMPORARY']),
  type: z.enum(['NONE', 'FIXED', 'PERCENT']),
  value: z.coerce.number().nonnegative().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const upsertLoyaltySchema = z.object({
  phone: z.string().min(1),
  name: z.string().trim().min(1).optional(),
  discount: discountPayloadSchema
});

const updateDiscountSchema = z.object({
  discount: discountPayloadSchema
});

const nullableTrimmedString = (max: number) =>
  z.union([z.string().trim().max(max), z.literal(''), z.null()]).optional();

const createClientSchema = z.object({
  name: nullableTrimmedString(255),
  phone: z.union([z.string().trim(), z.literal(''), z.null()]).optional(),
  email: z.union([z.string().trim().email(), z.literal(''), z.null()]).optional(),
  comment: nullableTrimmedString(2000)
});

const updateClientSchema = z
  .object({
    name: nullableTrimmedString(255),
    phone: z.union([z.string().trim(), z.literal(''), z.null()]).optional(),
    email: z.union([z.string().trim().email(), z.literal(''), z.null()]).optional(),
    comment: z.union([z.string().trim().max(2000), z.literal(''), z.null()]).optional()
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.phone !== undefined ||
      value.email !== undefined ||
      value.comment !== undefined,
    {
      message: 'At least one field is required'
    }
  );

const createSyntheticClientPhone10 = () => `client-${randomUUID()}`;

const validateDiscountPayload = (payload: z.infer<typeof discountPayloadSchema>) => {
  if (payload.type === 'NONE') {
    return;
  }

  if (payload.value === undefined) {
    throw badRequest('Discount value is required when type is FIXED/PERCENT');
  }

  if (payload.type === 'PERCENT' && payload.value > 100) {
    throw badRequest('Percent discount must be <= 100');
  }

  if (payload.mode === 'TEMPORARY') {
    if (!payload.from || !payload.to) {
      throw badRequest('Temporary discount requires from and to');
    }

    const from = new Date(payload.from);
    const to = new Date(payload.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      throw badRequest('Temporary discount interval is invalid');
    }
  }
};

const applyDiscountToClient = async (clientId: string, payload: z.infer<typeof discountPayloadSchema>) => {
  validateDiscountPayload(payload);

  const discountType = payload.type as DiscountType;
  const discountValue = payload.type === 'NONE' ? null : D(payload.value ?? 0);

  if (payload.mode === 'PERMANENT') {
    return prisma.client.update({
      where: { id: clientId },
      data: {
        discountType,
        discountValue,
        // clear temporary window when explicitly assigning permanent NONE
        ...(payload.type === 'NONE'
          ? {
              temporaryDiscountType: DiscountType.NONE,
              temporaryDiscountValue: null,
              temporaryDiscountFrom: null,
              temporaryDiscountTo: null
            }
          : {})
      },
      include: { category: true }
    });
  }

  return prisma.client.update({
    where: { id: clientId },
    data: {
      temporaryDiscountType: discountType,
      temporaryDiscountValue: discountValue,
      temporaryDiscountFrom: payload.type === 'NONE' ? null : new Date(payload.from!),
      temporaryDiscountTo: payload.type === 'NONE' ? null : new Date(payload.to!)
    },
    include: { category: true }
  });
};

const mapClientForAdmin = (client: {
  id: string;
  name: string | null;
  phoneE164: string;
  phone10: string;
  email?: string | null;
  avatarPath?: string | null;
  discountType: DiscountType;
  discountValue: any;
  temporaryDiscountType: DiscountType;
  temporaryDiscountValue: any;
  temporaryDiscountFrom: Date | null;
  temporaryDiscountTo: Date | null;
  category?: { id: string; name: string } | null;
  comment?: string | null;
}) => ({
  id: client.id,
  name: client.name,
  phoneE164: client.phoneE164,
  phone10: client.phone10,
  email: client.email ?? null,
  avatarUrl: resolveClientAvatarUrl(client.avatarPath),
  comment: client.comment ?? null,
  category: client.category ? { id: client.category.id, name: client.category.name } : null,
  discount: {
    permanent: {
      type: client.discountType,
      value: client.discountValue ? toNumber(client.discountValue) : null
    },
    temporary: {
      type: client.temporaryDiscountType,
      value: client.temporaryDiscountValue ? toNumber(client.temporaryDiscountValue) : null,
      from: client.temporaryDiscountFrom ? client.temporaryDiscountFrom.toISOString() : null,
      to: client.temporaryDiscountTo ? client.temporaryDiscountTo.toISOString() : null
    }
  }
});

export const clientsRouter = Router();

clientsRouter.get(
  '/',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('VIEW_CLIENTS', 'OWNER'),
  validateQuery(listClientsQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof listClientsQuerySchema>;
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;

    const where: Prisma.ClientWhereInput = {
      AND: [
        {
          NOT: {
            phone10: { startsWith: 'anon-' },
            name: null,
            phoneE164: ''
          }
        }
      ],
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { phoneE164: { contains: query.search } },
              { phone10: { contains: query.search.replace(/\D/g, '') } }
            ]
          }
        : {})
    };

    const [total, rows] = await Promise.all([
      prisma.client.count({ where }),
      prisma.client.findMany({
        where,
        include: {
          category: true,
          account: {
            select: { email: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    return ok(
      res,
      {
        items: rows.map((row) =>
          mapClientForAdmin({
            id: row.id,
            name: row.name,
            phone10: row.phone10,
            phoneE164: row.phoneE164,
            email: row.account?.email ?? null,
            avatarPath: row.avatarPath,
            comment: row.comment,
            category: row.category,
            discountType: row.discountType,
            discountValue: row.discountValue,
            temporaryDiscountType: row.temporaryDiscountType,
            temporaryDiscountValue: row.temporaryDiscountValue,
            temporaryDiscountFrom: row.temporaryDiscountFrom,
            temporaryDiscountTo: row.temporaryDiscountTo
          })
        )
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

clientsRouter.get(
  '/:id',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('VIEW_CLIENTS', 'OWNER'),
  validateParams(clientIdParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof clientIdParamSchema>;

    const row = await prisma.client.findUnique({
      where: { id },
      include: {
        category: true,
        account: {
          select: { email: true }
        }
      }
    });
    if (!row) {
      throw notFound('Client not found');
    }

    return ok(
      res,
      mapClientForAdmin({
        id: row.id,
        name: row.name,
        phone10: row.phone10,
        phoneE164: row.phoneE164,
        email: row.account?.email ?? null,
        avatarPath: row.avatarPath,
        comment: row.comment,
        category: row.category,
        discountType: row.discountType,
        discountValue: row.discountValue,
        temporaryDiscountType: row.temporaryDiscountType,
        temporaryDiscountValue: row.temporaryDiscountValue,
        temporaryDiscountFrom: row.temporaryDiscountFrom,
        temporaryDiscountTo: row.temporaryDiscountTo
      })
    );
  })
);

clientsRouter.post(
  '/',
  authenticateRequired,
  requireStaff,
  requirePermission('EDIT_CLIENTS'),
  validateBody(createClientSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createClientSchema>;

    const nextName =
      body.name === undefined || body.name === null || body.name === '' ? null : body.name.trim();
    const nextComment =
      body.comment === undefined || body.comment === null || body.comment === ''
        ? null
        : body.comment.trim();
    const nextEmail =
      body.email === undefined || body.email === null || body.email === ''
        ? null
        : body.email.trim().toLowerCase();
    const phoneRaw =
      body.phone === undefined || body.phone === null || body.phone.trim() === ''
        ? null
        : body.phone.trim();
    const phone10 = phoneRaw ? normalizePhone10(phoneRaw) : createSyntheticClientPhone10();
    const phoneE164 = phoneRaw ? toPhoneE164(phone10) : '';
    const passwordHash = nextEmail ? await hashSecret(randomUUID()) : null;

    try {
      const created = await prisma.client.create({
        data: {
          name: nextName,
          phone10,
          phoneE164,
          comment: nextComment,
          ...(nextEmail && passwordHash
            ? {
                account: {
                  create: {
                    email: nextEmail,
                    passwordHash
                  }
                }
              }
            : {})
        },
        include: {
          category: true,
          account: {
            select: { email: true }
          }
        }
      });

      return ok(
        res,
        {
          client: mapClientForAdmin({
            id: created.id,
            name: created.name,
            phone10: created.phone10,
            phoneE164: created.phoneE164,
            email: created.account?.email ?? null,
            avatarPath: created.avatarPath,
            comment: created.comment,
            category: created.category,
            discountType: created.discountType,
            discountValue: created.discountValue,
            temporaryDiscountType: created.temporaryDiscountType,
            temporaryDiscountValue: created.temporaryDiscountValue,
            temporaryDiscountFrom: created.temporaryDiscountFrom,
            temporaryDiscountTo: created.temporaryDiscountTo
          })
        },
        201
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw badRequest('Phone or email already in use');
      }
      throw error;
    }
  })
);

clientsRouter.post(
  '/:id/avatar',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermissions(['EDIT_CLIENTS', 'MANAGE_CLIENT_AVATARS'], 'OWNER'),
  validateParams(clientIdParamSchema),
  clientAvatarUpload.single('file'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof clientIdParamSchema>;
    const file = req.file;
    if (!file) {
      throw badRequest('file is required');
    }

    await saveClientAvatar(id, file);

    const updated = await prisma.client.findUnique({
      where: { id },
      include: {
        category: true,
        account: {
          select: { email: true }
        }
      }
    });

    if (!updated) {
      throw notFound('Client not found');
    }

    return ok(res, {
      client: mapClientForAdmin({
        id: updated.id,
        name: updated.name,
        phone10: updated.phone10,
        phoneE164: updated.phoneE164,
        email: updated.account?.email ?? null,
        avatarPath: updated.avatarPath,
        comment: updated.comment,
        category: updated.category,
        discountType: updated.discountType,
        discountValue: updated.discountValue,
        temporaryDiscountType: updated.temporaryDiscountType,
        temporaryDiscountValue: updated.temporaryDiscountValue,
        temporaryDiscountFrom: updated.temporaryDiscountFrom,
        temporaryDiscountTo: updated.temporaryDiscountTo
      })
    });
  })
);

clientsRouter.delete(
  '/:id/avatar',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermissions(['EDIT_CLIENTS', 'MANAGE_CLIENT_AVATARS'], 'OWNER'),
  validateParams(clientIdParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof clientIdParamSchema>;

    await deleteClientAvatar(id);

    const updated = await prisma.client.findUnique({
      where: { id },
      include: {
        category: true,
        account: {
          select: { email: true }
        }
      }
    });

    if (!updated) {
      throw notFound('Client not found');
    }

    return ok(res, {
      client: mapClientForAdmin({
        id: updated.id,
        name: updated.name,
        phone10: updated.phone10,
        phoneE164: updated.phoneE164,
        email: updated.account?.email ?? null,
        avatarPath: updated.avatarPath,
        comment: updated.comment,
        category: updated.category,
        discountType: updated.discountType,
        discountValue: updated.discountValue,
        temporaryDiscountType: updated.temporaryDiscountType,
        temporaryDiscountValue: updated.temporaryDiscountValue,
        temporaryDiscountFrom: updated.temporaryDiscountFrom,
        temporaryDiscountTo: updated.temporaryDiscountTo
      })
    });
  })
);

clientsRouter.patch(
  '/:id',
  authenticateRequired,
  requireStaff,
  requirePermission('EDIT_CLIENTS'),
  validateParams(clientIdParamSchema),
  validateBody(updateClientSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof clientIdParamSchema>;
    const body = req.body as z.infer<typeof updateClientSchema>;

    const existing = await prisma.client.findUnique({
      where: { id },
      include: {
        category: true,
        account: {
          select: { email: true }
        }
      }
    });
    if (!existing) {
      throw notFound('Client not found');
    }

    const nextName =
      body.name === undefined
        ? undefined
        : body.name === null || body.name === ''
          ? null
          : body.name.trim();
    const nextComment =
      body.comment === undefined
        ? undefined
        : body.comment === null || body.comment === ''
          ? null
          : body.comment.trim();
    const nextEmail =
      body.email === undefined
        ? undefined
        : body.email === null || body.email === ''
          ? null
          : body.email.trim().toLowerCase();

    const updatePayload: {
      name?: string | null;
      phone10?: string;
      phoneE164?: string;
      comment?: string | null;
    } = {};

    if (nextName !== undefined) {
      updatePayload.name = nextName;
    }
    if (nextComment !== undefined) {
      updatePayload.comment = nextComment;
    }
    if (body.phone !== undefined) {
      if (body.phone === null || body.phone.trim() === '') {
        updatePayload.phone10 = createSyntheticClientPhone10();
        updatePayload.phoneE164 = '';
      } else {
        const normalizedPhone10 = normalizePhone10(body.phone);
        updatePayload.phone10 = normalizedPhone10;
        updatePayload.phoneE164 = toPhoneE164(normalizedPhone10);
      }
    }

    try {
      const passwordHashForNewAccount =
        nextEmail && !existing.account ? await hashSecret(randomUUID()) : null;
      const updated = await prisma.$transaction(async (tx) => {
        if (nextEmail !== undefined) {
          const account = await tx.clientAccount.findUnique({
            where: { clientId: id },
            select: { clientId: true }
          });
          if (account) {
            await tx.clientAccount.update({
              where: { clientId: id },
              data: { email: nextEmail }
            });
          } else if (nextEmail) {
            await tx.clientAccount.create({
              data: {
                clientId: id,
                email: nextEmail,
                passwordHash: passwordHashForNewAccount ?? (await hashSecret(randomUUID()))
              }
            });
          }
        }

        if (Object.keys(updatePayload).length > 0) {
          return tx.client.update({
            where: { id },
            data: updatePayload,
            include: {
              category: true,
              account: {
                select: { email: true }
              }
            }
          });
        }

        return tx.client.findUniqueOrThrow({
          where: { id },
          include: {
            category: true,
            account: {
              select: { email: true }
            }
          }
        });
      });

      return ok(res, {
        client: mapClientForAdmin({
          id: updated.id,
          name: updated.name,
          phone10: updated.phone10,
          phoneE164: updated.phoneE164,
          email: updated.account?.email ?? null,
          avatarPath: updated.avatarPath,
          comment: updated.comment,
          category: updated.category,
          discountType: updated.discountType,
          discountValue: updated.discountValue,
          temporaryDiscountType: updated.temporaryDiscountType,
          temporaryDiscountValue: updated.temporaryDiscountValue,
          temporaryDiscountFrom: updated.temporaryDiscountFrom,
          temporaryDiscountTo: updated.temporaryDiscountTo
        })
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw badRequest('Phone or email already in use');
      }
      throw error;
    }
  })
);

clientsRouter.patch(
  '/:id/discount',
  authenticateRequired,
  requireStaff,
  requirePermission('EDIT_CLIENTS'),
  requirePermission('MANAGE_CLIENT_DISCOUNTS'),
  validateParams(clientIdParamSchema),
  validateBody(updateDiscountSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof clientIdParamSchema>;
    const body = req.body as z.infer<typeof updateDiscountSchema>;

    const existing = await prisma.client.findUnique({ where: { id } });
    if (!existing) {
      throw notFound('Client not found');
    }

    const updated = await applyDiscountToClient(id, body.discount);

    await notifyOnClientDiscountChanged({
      before: {
        id: existing.id,
        name: existing.name,
        discountType: existing.discountType,
        discountValue: existing.discountValue,
        temporaryDiscountType: existing.temporaryDiscountType,
        temporaryDiscountValue: existing.temporaryDiscountValue,
        temporaryDiscountFrom: existing.temporaryDiscountFrom,
        temporaryDiscountTo: existing.temporaryDiscountTo,
      },
      after: {
        id: updated.id,
        name: updated.name,
        discountType: updated.discountType,
        discountValue: updated.discountValue,
        temporaryDiscountType: updated.temporaryDiscountType,
        temporaryDiscountValue: updated.temporaryDiscountValue,
        temporaryDiscountFrom: updated.temporaryDiscountFrom,
        temporaryDiscountTo: updated.temporaryDiscountTo,
      },
    });

    return ok(res, {
      client: mapClientForAdmin({
        id: updated.id,
        name: updated.name,
        phone10: updated.phone10,
        phoneE164: updated.phoneE164,
        avatarPath: updated.avatarPath,
        comment: updated.comment,
        category: updated.category,
        discountType: updated.discountType,
        discountValue: updated.discountValue,
        temporaryDiscountType: updated.temporaryDiscountType,
        temporaryDiscountValue: updated.temporaryDiscountValue,
        temporaryDiscountFrom: updated.temporaryDiscountFrom,
        temporaryDiscountTo: updated.temporaryDiscountTo
      })
    });
  })
);

clientsRouter.delete(
  '/:id',
  authenticateRequired,
  requireStaff,
  requirePermission('EDIT_CLIENTS'),
  validateParams(clientIdParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof clientIdParamSchema>;

    const existing = await prisma.client.findUnique({
      where: { id },
      select: {
        id: true,
        avatarPath: true
      }
    });
    if (!existing) {
      throw notFound('Client not found');
    }

    const appointmentIds = (
      await prisma.appointment.findMany({
        where: { clientId: id },
        select: { id: true }
      })
    ).map((item) => item.id);

    await prisma.$transaction(async (tx) => {
      await deleteAppointmentsCascade(tx, appointmentIds);
      await tx.session.deleteMany({
        where: {
          subjectType: 'CLIENT',
          subjectId: id
        }
      });
      await tx.client.delete({
        where: { id }
      });
    });

    await removeClientAvatarFileByPath(existing.avatarPath);

    return ok(res, {
      deleted: true,
      clientId: id,
      deletedAppointmentsCount: appointmentIds.length
    });
  })
);

clientsRouter.get(
  '/loyalty/list',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_DISCOUNTS'),
  validateQuery(loyaltyListQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof loyaltyListQuerySchema>;
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;

    const now = new Date();

    const where = {
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { phoneE164: { contains: query.search } },
              { phone10: { contains: query.search.replace(/\D/g, '') } }
            ]
          }
        : {}),
      ...(query.activeTemporary === 'true'
        ? {
            temporaryDiscountType: { not: DiscountType.NONE },
            temporaryDiscountFrom: { lte: now },
            temporaryDiscountTo: { gte: now }
          }
        : {})
    };

    const [total, rows] = await Promise.all([
      prisma.client.count({ where }),
      prisma.client.findMany({
        where,
        include: {
          category: true,
          account: {
            select: { email: true }
          }
        },
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    return ok(
      res,
      {
        items: rows.map((row) =>
          mapClientForAdmin({
            id: row.id,
            name: row.name,
            phone10: row.phone10,
            phoneE164: row.phoneE164,
            email: row.account?.email ?? null,
            comment: row.comment,
            category: row.category,
            discountType: row.discountType,
            discountValue: row.discountValue,
            temporaryDiscountType: row.temporaryDiscountType,
            temporaryDiscountValue: row.temporaryDiscountValue,
            temporaryDiscountFrom: row.temporaryDiscountFrom,
            temporaryDiscountTo: row.temporaryDiscountTo
          })
        )
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

clientsRouter.post(
  '/loyalty/upsert',
  authenticateRequired,
  requireStaff,
  requirePermission('EDIT_CLIENTS'),
  requirePermission('MANAGE_CLIENT_DISCOUNTS'),
  validateBody(upsertLoyaltySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof upsertLoyaltySchema>;

    const client = await upsertClientByPhone(body.phone, body.name);
    const before = await prisma.client.findUniqueOrThrow({ where: { id: client.id } });
    const updated = await applyDiscountToClient(client.id, body.discount);

    await notifyOnClientDiscountChanged({
      before: {
        id: before.id,
        name: before.name,
        discountType: before.discountType,
        discountValue: before.discountValue,
        temporaryDiscountType: before.temporaryDiscountType,
        temporaryDiscountValue: before.temporaryDiscountValue,
        temporaryDiscountFrom: before.temporaryDiscountFrom,
        temporaryDiscountTo: before.temporaryDiscountTo,
      },
      after: {
        id: updated.id,
        name: updated.name,
        discountType: updated.discountType,
        discountValue: updated.discountValue,
        temporaryDiscountType: updated.temporaryDiscountType,
        temporaryDiscountValue: updated.temporaryDiscountValue,
        temporaryDiscountFrom: updated.temporaryDiscountFrom,
        temporaryDiscountTo: updated.temporaryDiscountTo,
      },
    });

    return ok(
      res,
      {
        client: mapClientForAdmin({
          id: updated.id,
          name: updated.name,
          phone10: updated.phone10,
          phoneE164: updated.phoneE164,
          avatarPath: updated.avatarPath,
          comment: updated.comment,
          category: updated.category,
          discountType: updated.discountType,
          discountValue: updated.discountValue,
          temporaryDiscountType: updated.temporaryDiscountType,
          temporaryDiscountValue: updated.temporaryDiscountValue,
          temporaryDiscountFrom: updated.temporaryDiscountFrom,
          temporaryDiscountTo: updated.temporaryDiscountTo
        })
      },
      201
    );
  })
);

clientsRouter.post(
  '/phone/normalize',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('VIEW_CLIENTS', 'OWNER'),
  validateBody(z.object({ phone: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    const body = req.body as { phone: string };
    const phone10 = normalizePhone10(body.phone);
    return ok(res, { phone10, phoneE164: toPhoneE164(phone10) });
  })
);
