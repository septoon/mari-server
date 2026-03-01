import { Router } from 'express';

import { authenticateRequired, requireStaff, requireStaffRoles } from '../../middlewares/auth';
import { asyncHandler } from '../../utils/async-handler';
import { ok } from '../../utils/response';
import { prisma } from '../../db/prisma';
import { toNumber } from '../../utils/money';

export const servicesRouter = Router();

servicesRouter.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const items = await prisma.service.findMany({
      where: { isActive: true },
      include: {
        category: true
      },
      orderBy: [{ category: { name: 'asc' } }, { name: 'asc' }]
    });

    return ok(res, {
      items: items.map((s) => ({
        id: s.id,
        externalId: s.externalId,
        category: { id: s.category.id, name: s.category.name },
        name: s.name,
        nameOnline: s.nameOnline,
        durationSec: s.durationSec,
        priceMin: toNumber(s.priceMin),
        priceMax: s.priceMax ? toNumber(s.priceMax) : null,
        isActive: s.isActive
      }))
    });
  })
);

servicesRouter.get(
  '/',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  asyncHandler(async (_req, res) => {
    const items = await prisma.service.findMany({
      include: {
        category: true
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }]
    });

    return ok(res, {
      items: items.map((s) => ({
        id: s.id,
        externalId: s.externalId,
        category: { id: s.category.id, name: s.category.name },
        name: s.name,
        nameOnline: s.nameOnline,
        durationSec: s.durationSec,
        priceMin: toNumber(s.priceMin),
        priceMax: s.priceMax ? toNumber(s.priceMax) : null,
        isActive: s.isActive
      }))
    });
  })
);
