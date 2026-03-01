import { Router } from 'express';
import { StaffRole, AppointmentStatus } from '@prisma/client';
import { z } from 'zod';

import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { authenticateRequired, requireStaff, requireStaffRoles } from '../../middlewares/auth';
import { validateBody, validateParams, validateQuery } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { hashToken, randomToken, sha1 } from '../../utils/crypto';
import { businessRule, conflict, forbidden, notFound } from '../../utils/errors';
import { normalizePhone10, toPhoneE164 } from '../../utils/phone';
import { hashSecret, validatePin } from '../../utils/password';
import { ok } from '../../utils/response';
import { parseDateOnlyToUtc } from '../../utils/time';
import { createSession, revokeAllSubjectSessions } from '../auth/service';

const inviteSchema = z.object({
  phone: z.string().min(1),
  email: z.string().email().optional(),
  name: z.string().min(1),
  role: z.enum(['ADMIN', 'MASTER']),
  positionName: z.string().min(1).optional(),
  hiredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const setPinSchema = z.object({
  token: z.string().min(20),
  pin: z.string().min(4).max(8)
});

const resetRequestSchema = z.object({
  phone: z.string().min(1)
});

const resetConfirmSchema = z.object({
  token: z.string().min(20),
  newPin: z.string().min(4).max(8)
});

const roleUpdateSchema = z.object({
  role: z.enum(['ADMIN', 'MASTER'])
});

const fireSchema = z.object({
  firedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

const contactUpdateSchema = z.object({
  phone: z.string().min(1),
  name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  positionName: z.string().min(1).optional()
});

const serviceAssignmentsSchema = z.object({
  serviceIds: z.array(z.string().uuid()).max(500)
});

const grantPermissionSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.string().datetime().optional()
});

const idParamSchema = z.object({
  id: z.string().uuid()
});

const permissionParamsSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1)
});

const staffListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  role: z.enum(['OWNER', 'ADMIN', 'MASTER']).optional(),
  isActive: z.union([z.literal('true'), z.literal('false')]).optional(),
  search: z.string().trim().min(1).optional()
});

const upsertPosition = async (positionName?: string): Promise<string | null> => {
  if (!positionName) return null;
  const name = positionName.trim();
  if (!name) return null;
  const position = await prisma.position.upsert({
    where: { name },
    update: { isActive: true },
    create: { name }
  });
  return position.id;
};

const buildTemporaryPhone10 = (name: string, attempt: number): string => {
  const hash = sha1(`${name.toLowerCase()}|${attempt}`);
  const value = Number(BigInt(`0x${hash.slice(0, 12)}`) % 1000000000n);
  return `9${value.toString().padStart(9, '0')}`;
};

export const staffRouter = Router();

staffRouter.get(
  '/',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateQuery(staffListQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof staffListQuerySchema>;
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;

    const where = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
              { phoneE164: { contains: query.search } }
            ]
          }
        : {})
    };

    const [total, items] = await Promise.all([
      prisma.staff.count({ where }),
      prisma.staff.findMany({
        where,
        include: {
          position: true,
          permissions: {
            where: {
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
            },
            include: { permission: true }
          }
        },
        orderBy: [{ role: 'asc' }, { name: 'asc' }],
        skip,
        take: limit
      })
    ]);

    return ok(
      res,
      {
        items: items.map((row) => ({
          id: row.id,
          name: row.name,
          role: row.role,
          phoneE164: row.phoneE164,
          email: row.email,
          isActive: row.isActive,
          hiredAt: row.hiredAt,
          firedAt: row.firedAt,
          position: row.position ? { id: row.position.id, name: row.position.name } : null,
          permissions: row.permissions.map((sp) => ({
            code: sp.permission.code,
            expiresAt: sp.expiresAt
          }))
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

staffRouter.post(
  '/invite',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateBody(inviteSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof inviteSchema>;
    const actor = req.auth!;

    const phone10 = normalizePhone10(body.phone);
    const phoneE164 = toPhoneE164(phone10);
    const email = body.email?.toLowerCase() ?? null;
    const positionId = body.positionName ? await upsertPosition(body.positionName) : undefined;

    const existing = await prisma.staff.findUnique({ where: { phone10 } });
    if (existing && existing.role === StaffRole.OWNER && actor.staffRole !== StaffRole.OWNER) {
      throw forbidden('ADMIN cannot edit OWNER (Владелец)');
    }

    if (email) {
      const sameEmail = await prisma.staff.findUnique({ where: { email } });
      if (sameEmail && sameEmail.id !== existing?.id) {
        throw conflict('Email already in use');
      }
    }

    const staff = existing
      ? await prisma.staff.update({
          where: { id: existing.id },
          data: {
            email,
            name: body.name,
            role: body.role,
            phone10,
            phoneE164,
            ...(positionId !== undefined ? { positionId } : {}),
            hiredAt: body.hiredAt ? parseDateOnlyToUtc(body.hiredAt) : existing.hiredAt,
            isActive: true,
            firedAt: null
          }
        })
      : await prisma.staff.create({
          data: {
            email,
            name: body.name,
            role: body.role,
            phone10,
            phoneE164,
            positionId: positionId ?? null,
            hiredAt: body.hiredAt ? parseDateOnlyToUtc(body.hiredAt) : null,
            isActive: true
          }
        });

    const rawToken = randomToken();
    await prisma.staffToken.create({
      data: {
        staffId: staff.id,
        type: 'SET_PIN',
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3)
      }
    });

    const inviteLink = `${env.APP_BASE_URL}/staff/set-pin?token=${rawToken}`;

    return ok(res, { staffId: staff.id, inviteLink }, 201);
  })
);

staffRouter.post(
  '/set-pin',
  validateBody(setPinSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof setPinSchema>;
    validatePin(body.pin);

    const tokenHash = hashToken(body.token);
    const token = await prisma.staffToken.findFirst({
      where: {
        tokenHash,
        type: 'SET_PIN',
        usedAt: null,
        expiresAt: { gt: new Date() }
      },
      include: { staff: true }
    });

    if (!token) {
      throw notFound('Token not found or expired');
    }
    if (!token.staff.isActive || token.staff.firedAt) {
      throw notFound('Token not found or expired');
    }

    const pinHash = await hashSecret(body.pin);

    await prisma.$transaction(async (tx) => {
      await tx.staff.update({
        where: { id: token.staffId },
        data: { pinHash }
      });
      await tx.staffToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() }
      });
    });

    const tokens = await createSession(
      'STAFF',
      token.staff.id,
      token.staff.role,
      req.headers['user-agent'],
      req.ip
    );

    return ok(res, {
      staff: {
        id: token.staff.id,
        role: token.staff.role,
        name: token.staff.name
      },
      tokens
    });
  })
);

staffRouter.post(
  '/reset-pin/request',
  validateBody(resetRequestSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof resetRequestSchema>;
    const phone10 = normalizePhone10(body.phone);
    const staff = await prisma.staff.findUnique({ where: { phone10 } });

    let resetLink: string | undefined;
    if (staff && staff.isActive && !staff.firedAt) {
      const rawToken = randomToken();
      await prisma.staffToken.create({
        data: {
          staffId: staff.id,
          type: 'RESET_PIN',
          tokenHash: hashToken(rawToken),
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24)
        }
      });
      resetLink = `${env.APP_BASE_URL}/staff/reset-pin?token=${rawToken}`;
      console.log(`[RESET_PIN] ${staff.phoneE164 ?? toPhoneE164(phone10)} -> ${resetLink}`);
    }

    return ok(res, {
      sent: true,
      ...(env.NODE_ENV !== 'production' && env.DEV_SHOW_LINKS && resetLink ? { resetLink } : {})
    });
  })
);

staffRouter.post(
  '/reset-pin/confirm',
  validateBody(resetConfirmSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof resetConfirmSchema>;
    validatePin(body.newPin);

    const token = await prisma.staffToken.findFirst({
      where: {
        tokenHash: hashToken(body.token),
        type: 'RESET_PIN',
        usedAt: null,
        expiresAt: { gt: new Date() }
      },
      include: { staff: true }
    });

    if (!token) {
      throw notFound('Token not found or expired');
    }
    if (!token.staff.isActive || token.staff.firedAt) {
      throw notFound('Token not found or expired');
    }

    const pinHash = await hashSecret(body.newPin);

    await prisma.$transaction(async (tx) => {
      await tx.staff.update({
        where: { id: token.staffId },
        data: { pinHash }
      });
      await tx.staffToken.update({ where: { id: token.id }, data: { usedAt: new Date() } });
    });

    await revokeAllSubjectSessions('STAFF', token.staff.id);

    const tokens = await createSession(
      'STAFF',
      token.staff.id,
      token.staff.role,
      req.headers['user-agent'],
      req.ip
    );

    return ok(res, {
      staff: {
        id: token.staff.id,
        role: token.staff.role,
        name: token.staff.name
      },
      tokens
    });
  })
);

staffRouter.patch(
  '/:id/contact',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateParams(idParamSchema),
  validateBody(contactUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof contactUpdateSchema>;
    const actor = req.auth!;

    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) throw notFound('Staff not found');
    if (staff.role === StaffRole.OWNER && actor.staffRole !== StaffRole.OWNER) {
      throw forbidden('ADMIN cannot edit OWNER (Владелец)');
    }

    const phone10 = normalizePhone10(body.phone);
    const phoneE164 = toPhoneE164(phone10);
    const email = body.email === undefined ? undefined : (body.email ? body.email.toLowerCase() : null);
    const positionId = body.positionName === undefined ? undefined : await upsertPosition(body.positionName);

    if (email) {
      const sameEmail = await prisma.staff.findUnique({ where: { email } });
      if (sameEmail && sameEmail.id !== id) {
        throw conflict('Email already in use');
      }
    }

    const samePhone = await prisma.staff.findUnique({ where: { phone10 } });
    if (samePhone && samePhone.id !== id) {
      throw conflict('Phone already in use');
    }

    const updated = await prisma.staff.update({
      where: { id },
      data: {
        phone10,
        phoneE164,
        email,
        positionId,
        ...(body.name ? { name: body.name } : {})
      },
      include: { position: true }
    });

    return ok(res, {
      staff: {
        id: updated.id,
        name: updated.name,
        phoneE164: updated.phoneE164,
        email: updated.email,
        position: updated.position ? { id: updated.position.id, name: updated.position.name } : null,
        role: updated.role,
        isActive: updated.isActive
      }
    });
  })
);

staffRouter.get(
  '/:id/services',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) throw notFound('Staff not found');

    const items = await prisma.staffService.findMany({
      where: { staffId: id },
      include: { service: { include: { category: true } } },
      orderBy: { service: { name: 'asc' } }
    });

    return ok(res, {
      staffId: id,
      servicesCount: items.length,
      items: items.map((row) => ({
        id: row.service.id,
        name: row.service.name,
        category: {
          id: row.service.category.id,
          name: row.service.category.name
        },
        durationSec: row.service.durationSec,
        priceMin: row.service.priceMin,
        priceMax: row.service.priceMax,
        isActive: row.service.isActive
      }))
    });
  })
);

staffRouter.put(
  '/:id/services',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateParams(idParamSchema),
  validateBody(serviceAssignmentsSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof serviceAssignmentsSchema>;
    const actor = req.auth!;

    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) throw notFound('Staff not found');
    if (staff.role === StaffRole.OWNER && actor.staffRole !== StaffRole.OWNER) {
      throw forbidden('ADMIN cannot edit OWNER (Владелец)');
    }

    const uniqueServiceIds = [...new Set(body.serviceIds)];
    if (uniqueServiceIds.length > 0) {
      const existingServices = await prisma.service.findMany({
        where: { id: { in: uniqueServiceIds } },
        select: { id: true }
      });
      if (existingServices.length !== uniqueServiceIds.length) {
        throw notFound('One or more services not found');
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.staffService.deleteMany({ where: { staffId: id } });
      if (uniqueServiceIds.length > 0) {
        await tx.staffService.createMany({
          data: uniqueServiceIds.map((serviceId) => ({ staffId: id, serviceId }))
        });
      }
    });

    const items = await prisma.staffService.findMany({
      where: { staffId: id },
      include: { service: { include: { category: true } } },
      orderBy: { service: { name: 'asc' } }
    });

    return ok(res, {
      staffId: id,
      servicesCount: items.length,
      items: items.map((row) => ({
        id: row.service.id,
        name: row.service.name,
        category: {
          id: row.service.category.id,
          name: row.service.category.name
        },
        durationSec: row.service.durationSec,
        priceMin: row.service.priceMin,
        priceMax: row.service.priceMax,
        isActive: row.service.isActive
      }))
    });
  })
);

staffRouter.patch(
  '/:id/role',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('OWNER'),
  validateParams(idParamSchema),
  validateBody(roleUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof roleUpdateSchema>;

    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) throw notFound('Staff not found');
    if (staff.role === StaffRole.OWNER) {
      throw forbidden('OWNER (Владелец) cannot be edited via this endpoint');
    }

    const updated = await prisma.staff.update({
      where: { id },
      data: { role: body.role }
    });

    return ok(res, {
      staff: {
        id: updated.id,
        phoneE164: updated.phoneE164,
        email: updated.email,
        name: updated.name,
        role: updated.role,
        isActive: updated.isActive,
        hiredAt: updated.hiredAt,
        firedAt: updated.firedAt
      }
    });
  })
);

staffRouter.post(
  '/:id/permissions',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('OWNER'),
  validateParams(idParamSchema),
  validateBody(grantPermissionSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof grantPermissionSchema>;

    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) {
      throw notFound('Staff not found');
    }

    const permission = await prisma.permission.upsert({
      where: { code: body.code },
      update: {},
      create: {
        code: body.code,
        description: body.code
      }
    });

    const staffPermission = await prisma.staffPermission.upsert({
      where: {
        staffId_permissionId: {
          staffId: id,
          permissionId: permission.id
        }
      },
      update: {
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        grantedByStaffId: req.auth!.subjectId
      },
      create: {
        staffId: id,
        permissionId: permission.id,
        grantedByStaffId: req.auth!.subjectId,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null
      }
    });

    return ok(res, {
      permission: {
        staffId: id,
        code: permission.code,
        expiresAt: staffPermission.expiresAt
      }
    });
  })
);

staffRouter.delete(
  '/:id/permissions/:code',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('OWNER'),
  validateParams(permissionParamsSchema),
  asyncHandler(async (req, res) => {
    const { id, code } = req.params as z.infer<typeof permissionParamsSchema>;

    const permission = await prisma.permission.findUnique({ where: { code } });
    if (!permission) {
      return ok(res, { revoked: true });
    }

    await prisma.staffPermission.deleteMany({
      where: {
        staffId: id,
        permissionId: permission.id
      }
    });

    return ok(res, { revoked: true });
  })
);

staffRouter.post(
  '/:id/fire',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('OWNER'),
  validateParams(idParamSchema),
  validateBody(fireSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof fireSchema>;

    const staff = await prisma.staff.findUnique({ where: { id } });
    if (!staff) throw notFound('Staff not found');
    if (staff.role === StaffRole.OWNER) {
      throw forbidden('OWNER (Владелец) cannot be fired');
    }

    const futureCount = await prisma.appointment.count({
      where: {
        staffId: id,
        startAt: { gt: new Date() },
        status: {
          notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW]
        }
      }
    });

    if (futureCount > 0) {
      throw businessRule('STAFF_HAS_FUTURE_APPOINTMENTS', 'Cannot fire staff with future appointments', {
        futureCount
      });
    }

    const firedAt = parseDateOnlyToUtc(body.firedAt);
    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      const staffUpdated = await tx.staff.update({
        where: { id },
        data: {
          firedAt,
          isActive: false
        }
      });

      await tx.session.updateMany({
        where: {
          subjectType: 'STAFF',
          subjectId: id,
          revokedAt: null
        },
        data: {
          revokedAt: now
        }
      });

      await tx.staffToken.updateMany({
        where: {
          staffId: id,
          usedAt: null
        },
        data: {
          usedAt: now
        }
      });

      return staffUpdated;
    });

    return ok(res, {
      staff: {
        id: updated.id,
        name: updated.name,
        phoneE164: updated.phoneE164,
        email: updated.email,
        role: updated.role,
        firedAt: updated.firedAt,
        isActive: updated.isActive
      }
    });
  })
);

// Utility for import jobs.
// If staff by name is missing, create a temporary MASTER with generated phone.
export const findOrCreateStaffByName = async (
  staffName: string,
  positionName?: string
): Promise<{ id: string; name: string }> => {
  const normalizedName = staffName.trim();
  if (!normalizedName) {
    throw conflict('Staff name is required');
  }

  const found = await prisma.staff.findFirst({ where: { name: normalizedName } });
  if (found) {
    return { id: found.id, name: found.name };
  }

  const positionId = await upsertPosition(positionName);
  let attempt = 0;
  let phone10 = buildTemporaryPhone10(normalizedName, attempt);

  while (await prisma.staff.findUnique({ where: { phone10 } })) {
    attempt += 1;
    phone10 = buildTemporaryPhone10(normalizedName, attempt);
  }

  const created = await prisma.staff.create({
    data: {
      name: normalizedName,
      role: StaffRole.MASTER,
      phone10,
      phoneE164: toPhoneE164(phone10),
      email: null,
      positionId,
      isActive: true
    }
  });

  return { id: created.id, name: created.name };
};
