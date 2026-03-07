import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import {
  authenticateRequired,
  requirePermission,
  requireStaff,
  requireStaffRolesOrPermission,
} from '../../middlewares/auth';
import { validateBody, validateParams } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { conflict, notFound } from '../../utils/errors';
import { D, toNumber } from '../../utils/money';
import { ok } from '../../utils/response';
import { prisma } from '../../db/prisma';

export const servicesRouter = Router();

const servicePayloadSchema = z.object({
  name: z.string().trim().min(1),
  nameOnline: z.string().trim().min(1).optional().nullable(),
  categoryId: z.string().uuid(),
  description: z.string().trim().optional(),
  durationSec: z.coerce.number().int().min(60),
  priceMin: z.coerce.number().min(0),
  priceMax: z.coerce.number().min(0).optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const categoryPayloadSchema = z.object({
  name: z.string().trim().min(1),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const mapService = (service: {
  id: string;
  externalId: string | null;
  category: { id: string; name: string };
  name: string;
  nameOnline: string | null;
  description: string | null;
  durationSec: number;
  priceMin: Prisma.Decimal;
  priceMax: Prisma.Decimal | null;
  isActive: boolean;
}) => ({
  id: service.id,
  externalId: service.externalId,
  category: { id: service.category.id, name: service.category.name },
  name: service.name,
  nameOnline: service.nameOnline,
  description: service.description,
  durationSec: service.durationSec,
  priceMin: toNumber(service.priceMin),
  priceMax: service.priceMax ? toNumber(service.priceMax) : null,
  isActive: service.isActive,
});

const createServiceHandler = asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof servicePayloadSchema>;
  const category = await prisma.serviceCategory.findUnique({
    where: { id: body.categoryId },
  });
  if (!category) {
    throw notFound('Category not found');
  }

  const created = await prisma.service.create({
    data: {
      categoryId: body.categoryId,
      name: body.name.trim(),
      nameOnline: body.nameOnline?.trim() || body.name.trim(),
      description: body.description?.trim() || null,
      durationSec: body.durationSec,
      priceMin: D(body.priceMin),
      priceMax: body.priceMax === null || body.priceMax === undefined ? null : D(body.priceMax),
      isActive: body.isActive ?? true,
    },
    include: {
      category: true,
    },
  });

  return ok(res, { item: mapService(created) }, 201);
});

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
      items: items.map(mapService)
    });
  })
);

servicesRouter.use(
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('VIEW_SERVICES', 'OWNER'),
);

servicesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const items = await prisma.service.findMany({
      include: {
        category: true
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }]
    });

    return ok(res, {
      items: items.map(mapService)
    });
  })
);

servicesRouter.post(
  '/',
  requirePermission('EDIT_SERVICES'),
  validateBody(servicePayloadSchema),
  createServiceHandler,
);
servicesRouter.post(
  '/create',
  requirePermission('EDIT_SERVICES'),
  validateBody(servicePayloadSchema),
  createServiceHandler,
);

servicesRouter.patch(
  '/:id',
  requirePermission('EDIT_SERVICES'),
  validateParams(idParamSchema),
  validateBody(servicePayloadSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof servicePayloadSchema>;

    const category = await prisma.serviceCategory.findUnique({
      where: { id: body.categoryId },
    });
    if (!category) {
      throw notFound('Category not found');
    }

    try {
      const updated = await prisma.service.update({
        where: { id },
        data: {
          categoryId: body.categoryId,
          name: body.name.trim(),
          nameOnline: body.nameOnline?.trim() || body.name.trim(),
          description: body.description?.trim() || null,
          durationSec: body.durationSec,
          priceMin: D(body.priceMin),
          priceMax:
            body.priceMax === null || body.priceMax === undefined ? null : D(body.priceMax),
          isActive: body.isActive ?? true,
        },
        include: {
          category: true,
        },
      });
      return ok(res, { item: mapService(updated) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Service not found');
      }
      throw error;
    }
  })
);

servicesRouter.put(
  '/:id',
  requirePermission('EDIT_SERVICES'),
  validateParams(idParamSchema),
  validateBody(servicePayloadSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof servicePayloadSchema>;

    const category = await prisma.serviceCategory.findUnique({
      where: { id: body.categoryId },
    });
    if (!category) {
      throw notFound('Category not found');
    }

    try {
      const updated = await prisma.service.update({
        where: { id },
        data: {
          categoryId: body.categoryId,
          name: body.name.trim(),
          nameOnline: body.nameOnline?.trim() || body.name.trim(),
          description: body.description?.trim() || null,
          durationSec: body.durationSec,
          priceMin: D(body.priceMin),
          priceMax:
            body.priceMax === null || body.priceMax === undefined ? null : D(body.priceMax),
          isActive: body.isActive ?? true,
        },
        include: {
          category: true,
        },
      });
      return ok(res, { item: mapService(updated) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Service not found');
      }
      throw error;
    }
  })
);

servicesRouter.delete(
  '/:id',
  requirePermission('EDIT_SERVICES'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    try {
      await prisma.service.delete({ where: { id } });
      return ok(res, { deleted: true, id });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Service not found');
      }
      throw error;
    }
  })
);

servicesRouter.post(
  '/categories',
  requirePermission('EDIT_SERVICES'),
  validateBody(categoryPayloadSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof categoryPayloadSchema>;
    const name = body.name.trim();

    const duplicate = await prisma.serviceCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' as const } },
    });
    if (duplicate) {
      throw conflict('Category already exists');
    }

    const created = await prisma.serviceCategory.create({
      data: { name },
    });
    return ok(res, { item: created }, 201);
  })
);

servicesRouter.post(
  '/category',
  requirePermission('EDIT_SERVICES'),
  validateBody(categoryPayloadSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof categoryPayloadSchema>;
    const name = body.name.trim();

    const duplicate = await prisma.serviceCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' as const } },
    });
    if (duplicate) {
      throw conflict('Category already exists');
    }

    const created = await prisma.serviceCategory.create({
      data: { name },
    });
    return ok(res, { item: created }, 201);
  })
);

servicesRouter.patch(
  '/categories/:id',
  requirePermission('EDIT_SERVICES'),
  validateParams(idParamSchema),
  validateBody(categoryPayloadSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof categoryPayloadSchema>;
    const name = body.name.trim();

    const duplicate = await prisma.serviceCategory.findFirst({
      where: {
        id: { not: id },
        name: { equals: name, mode: 'insensitive' as const },
      },
    });
    if (duplicate) {
      throw conflict('Category already exists');
    }

    try {
      const updated = await prisma.serviceCategory.update({
        where: { id },
        data: { name },
      });
      return ok(res, { item: updated });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Category not found');
      }
      throw error;
    }
  })
);

servicesRouter.patch(
  '/category/:id',
  requirePermission('EDIT_SERVICES'),
  validateParams(idParamSchema),
  validateBody(categoryPayloadSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof categoryPayloadSchema>;
    const name = body.name.trim();

    const duplicate = await prisma.serviceCategory.findFirst({
      where: {
        id: { not: id },
        name: { equals: name, mode: 'insensitive' as const },
      },
    });
    if (duplicate) {
      throw conflict('Category already exists');
    }

    try {
      const updated = await prisma.serviceCategory.update({
        where: { id },
        data: { name },
      });
      return ok(res, { item: updated });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Category not found');
      }
      throw error;
    }
  })
);

servicesRouter.delete(
  '/categories/:id',
  requirePermission('EDIT_SERVICES'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const servicesCount = await prisma.service.count({
      where: { categoryId: id },
    });
    if (servicesCount > 0) {
      throw conflict('Category has services');
    }

    try {
      await prisma.serviceCategory.delete({ where: { id } });
      return ok(res, { deleted: true, id });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Category not found');
      }
      throw error;
    }
  })
);

servicesRouter.delete(
  '/category/:id',
  requirePermission('EDIT_SERVICES'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const servicesCount = await prisma.service.count({
      where: { categoryId: id },
    });
    if (servicesCount > 0) {
      throw conflict('Category has services');
    }

    try {
      await prisma.serviceCategory.delete({ where: { id } });
      return ok(res, { deleted: true, id });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Category not found');
      }
      throw error;
    }
  })
);
