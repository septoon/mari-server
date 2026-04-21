import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { env } from '../../config/env';
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
import { findDefaultServiceSectionByCategoryName } from './sections';

export const servicesRouter = Router();

const servicePayloadSchema = z.object({
  name: z.string().trim().min(1),
  nameOnline: z.string().trim().min(1).optional().nullable(),
  categoryId: z.string().uuid(),
  imageAssetId: z.string().uuid().nullable().optional(),
  description: z.string().trim().optional(),
  durationSec: z.coerce.number().int().min(60),
  priceMin: z.coerce.number().min(0),
  priceMax: z.coerce.number().min(0).optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const categoryPayloadSchema = z.object({
  name: z.string().trim().min(1),
  imageAssetId: z.string().uuid().nullable().optional(),
  sectionId: z.string().uuid().nullable().optional(),
});

const sectionPayloadSchema = z.object({
  name: z.string().trim().min(1),
  imageAssetId: z.string().uuid().nullable().optional(),
  orderIndex: z.coerce.number().int().optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

type MediaImageAsset = {
  id: string;
  originalPath: string;
  variants: Array<{
    width: number;
    urlPath: string;
    path: string;
  }>;
} | null;

const toMediaUrlPath = (relativePath: string): string => {
  const base = env.MEDIA_PUBLIC_BASE.startsWith('/')
    ? env.MEDIA_PUBLIC_BASE
    : `/${env.MEDIA_PUBLIC_BASE}`;
  return `${base.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '').replaceAll('\\', '/')}`;
};

const toMediaPublicUrl = (urlPath: string): string => {
  const origin = env.MEDIA_PUBLIC_ORIGIN?.replace(/\/+$/, '') || env.API_BASE_URL.replace(/\/+$/, '') || '';
  return origin ? `${origin}${urlPath}` : urlPath;
};

const resolveImageUrl = (asset: MediaImageAsset): string | null => {
  if (!asset) {
    return null;
  }
  const preferred = [...asset.variants].sort((left, right) => left.width - right.width).at(-1) ?? null;
  if (preferred?.urlPath) {
    return toMediaPublicUrl(preferred.urlPath);
  }
  if (preferred?.path) {
    return toMediaPublicUrl(toMediaUrlPath(preferred.path));
  }
  return toMediaPublicUrl(toMediaUrlPath(asset.originalPath));
};

const buildCategoryImageInclude = () =>
  Prisma.validator<Prisma.MediaAssetInclude>()({
    variants: {
      select: {
        width: true,
        path: true,
        urlPath: true
      }
    }
  });

const buildSectionInclude = () =>
  Prisma.validator<Prisma.ServiceSectionInclude>()({
    imageAsset: {
      include: buildCategoryImageInclude()
    }
  });

const mapSection = (section: {
  id: string;
  name: string;
  orderIndex?: number;
  imageAssetId?: string | null;
  imageAsset?: MediaImageAsset;
}) => ({
  id: section.id,
  name: section.name,
  orderIndex: section.orderIndex ?? 0,
  imageAssetId: section.imageAssetId ?? null,
  imageUrl: resolveImageUrl(section.imageAsset ?? null),
});

const mapCategory = (category: {
  id: string;
  name: string;
  imageAssetId?: string | null;
  imageAsset?: MediaImageAsset;
  sectionId?: string | null;
  section?: {
    id: string;
    name: string;
    orderIndex?: number;
    imageAssetId?: string | null;
    imageAsset?: MediaImageAsset;
  } | null;
  _count?: {
    services?: number;
  };
}) => ({
  id: category.id,
  name: category.name,
  imageAssetId: category.imageAssetId ?? null,
  imageUrl: resolveImageUrl(category.imageAsset ?? null),
  sectionId: category.sectionId ?? category.section?.id ?? null,
  section: category.section ? mapSection(category.section) : null,
  count: category._count?.services ?? 0,
});

const mapService = (service: {
  id: string;
  externalId: string | null;
  imageAssetId?: string | null;
  imageAsset?: MediaImageAsset;
  category: {
    id: string;
    name: string;
    imageAssetId?: string | null;
    imageAsset?: MediaImageAsset;
    sectionId?: string | null;
    section?: {
      id: string;
      name: string;
      orderIndex?: number;
      imageAssetId?: string | null;
      imageAsset?: MediaImageAsset;
    } | null;
  };
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
  category: mapCategory(service.category),
  imageAssetId: service.imageAssetId ?? null,
  imageUrl: resolveImageUrl(service.imageAsset ?? null),
  name: service.name,
  nameOnline: service.nameOnline,
  description: service.description,
  durationSec: service.durationSec,
  priceMin: toNumber(service.priceMin),
  priceMax: service.priceMax ? toNumber(service.priceMax) : null,
  isActive: service.isActive,
});

const ensureCategoryImageAsset = async (imageAssetId?: string | null) => {
  if (!imageAssetId) {
    return null;
  }

  const asset = await prisma.mediaAsset.findUnique({
    where: { id: imageAssetId },
    select: {
      id: true,
      entity: true,
    },
  });

  if (!asset || asset.entity !== 'services') {
    throw notFound('Category image asset not found');
  }

  return asset;
};

const ensureSectionImageAsset = async (imageAssetId?: string | null) => {
  if (!imageAssetId) {
    return null;
  }

  const asset = await prisma.mediaAsset.findUnique({
    where: { id: imageAssetId },
    select: {
      id: true,
      entity: true,
    },
  });

  if (!asset || asset.entity !== 'services') {
    throw notFound('Section image asset not found');
  }

  return asset;
};

const ensureServiceImageAsset = async (imageAssetId?: string | null) => {
  if (!imageAssetId) {
    return null;
  }

  const asset = await prisma.mediaAsset.findUnique({
    where: { id: imageAssetId },
    select: {
      id: true,
      entity: true,
    },
  });

  if (!asset || asset.entity !== 'services') {
    throw notFound('Service image asset not found');
  }

  return asset;
};

const resolveCategorySectionId = async ({
  name,
  sectionId
}: {
  name: string;
  sectionId?: string | null;
}) => {
  if (sectionId === null) {
    return null;
  }

  if (sectionId) {
    const section = await prisma.serviceSection.findUnique({
      where: { id: sectionId },
      select: { id: true }
    });
    if (!section) {
      throw notFound('Section not found');
    }
    return section.id;
  }

  const defaultSection = findDefaultServiceSectionByCategoryName(name);
  if (!defaultSection) {
    return null;
  }

  await prisma.serviceSection.upsert({
    where: { id: defaultSection.id },
    update: {
      name: defaultSection.name,
      orderIndex: defaultSection.orderIndex
    },
    create: {
      id: defaultSection.id,
      name: defaultSection.name,
      orderIndex: defaultSection.orderIndex
    }
  });

  return defaultSection.id;
};

const createServiceHandler = asyncHandler(async (req, res) => {
  const body = req.body as z.infer<typeof servicePayloadSchema>;
  const category = await prisma.serviceCategory.findUnique({
    where: { id: body.categoryId },
  });
  if (!category) {
    throw notFound('Category not found');
  }
  await ensureServiceImageAsset(body.imageAssetId);

  const created = await prisma.service.create({
    data: {
      categoryId: body.categoryId,
      imageAssetId: body.imageAssetId ?? null,
      name: body.name.trim(),
      nameOnline: body.nameOnline?.trim() || body.name.trim(),
      description: body.description?.trim() || null,
      durationSec: body.durationSec,
      priceMin: D(body.priceMin),
      priceMax: body.priceMax === null || body.priceMax === undefined ? null : D(body.priceMax),
      isActive: body.isActive ?? true,
    },
    include: {
      imageAsset: {
        include: buildCategoryImageInclude()
      },
      category: {
        include: {
          imageAsset: {
            include: buildCategoryImageInclude()
          },
          section: {
            include: buildSectionInclude()
          }
        }
      },
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
        imageAsset: {
          include: buildCategoryImageInclude()
        },
        category: {
          include: {
            imageAsset: {
              include: buildCategoryImageInclude()
            },
            section: {
              include: buildSectionInclude()
            }
          }
        }
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
        imageAsset: {
          include: buildCategoryImageInclude()
        },
        category: {
          include: {
            imageAsset: {
              include: buildCategoryImageInclude()
            },
            section: {
              include: buildSectionInclude()
            }
          }
        }
      },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }]
    });

    return ok(res, {
      items: items.map(mapService)
    });
  })
);

servicesRouter.get(
  '/categories',
  asyncHandler(async (_req, res) => {
    const items = await prisma.serviceCategory.findMany({
      include: {
        imageAsset: {
          include: buildCategoryImageInclude()
        },
        section: {
          include: buildSectionInclude()
        },
        _count: {
          select: {
            services: true
          }
        }
      },
      orderBy: [{ name: 'asc' }]
    });

    return ok(res, {
      items: items.map(mapCategory)
    });
  })
);

servicesRouter.get(
  '/sections',
  asyncHandler(async (_req, res) => {
    const items = await prisma.serviceSection.findMany({
      include: {
        imageAsset: {
          include: buildCategoryImageInclude()
        },
        categories: {
          include: {
            _count: {
              select: {
                services: true
              }
            }
          }
        }
      },
      orderBy: [{ orderIndex: 'asc' }, { name: 'asc' }]
    });

    return ok(res, {
      items: items.map((item) => ({
        ...mapSection(item),
        categoriesCount: item.categories.length,
        servicesCount: item.categories.reduce((sum, category) => sum + category._count.services, 0)
      }))
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
  await ensureServiceImageAsset(body.imageAssetId);

  try {
      const updated = await prisma.service.update({
        where: { id },
        data: {
          categoryId: body.categoryId,
          imageAssetId: body.imageAssetId ?? null,
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
          imageAsset: {
            include: buildCategoryImageInclude()
          },
          category: {
            include: {
              imageAsset: {
                include: buildCategoryImageInclude()
              },
              section: {
                include: buildSectionInclude()
              }
            }
          },
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
  await ensureServiceImageAsset(body.imageAssetId);

  try {
      const updated = await prisma.service.update({
        where: { id },
        data: {
          categoryId: body.categoryId,
          imageAssetId: body.imageAssetId ?? null,
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
          imageAsset: {
            include: buildCategoryImageInclude()
          },
          category: {
            include: {
              imageAsset: {
                include: buildCategoryImageInclude()
              },
              section: {
                include: buildSectionInclude()
              }
            }
          },
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
    await ensureCategoryImageAsset(body.imageAssetId);
    const sectionId = await resolveCategorySectionId({ name, sectionId: body.sectionId });

    const duplicate = await prisma.serviceCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' as const } },
    });
    if (duplicate) {
      throw conflict('Category already exists');
    }

    const created = await prisma.serviceCategory.create({
      data: {
        name,
        imageAssetId: body.imageAssetId ?? null,
        sectionId,
      },
      include: {
        imageAsset: {
          include: buildCategoryImageInclude()
        },
        section: {
          include: buildSectionInclude()
        }
      }
    });
    return ok(res, { item: mapCategory(created) }, 201);
  })
);

servicesRouter.post(
  '/category',
  requirePermission('EDIT_SERVICES'),
  validateBody(categoryPayloadSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof categoryPayloadSchema>;
    const name = body.name.trim();
    await ensureCategoryImageAsset(body.imageAssetId);
    const sectionId = await resolveCategorySectionId({ name, sectionId: body.sectionId });

    const duplicate = await prisma.serviceCategory.findFirst({
      where: { name: { equals: name, mode: 'insensitive' as const } },
    });
    if (duplicate) {
      throw conflict('Category already exists');
    }

    const created = await prisma.serviceCategory.create({
      data: {
        name,
        imageAssetId: body.imageAssetId ?? null,
        sectionId,
      },
      include: {
        imageAsset: {
          include: buildCategoryImageInclude()
        },
        section: {
          include: buildSectionInclude()
        }
      }
    });
    return ok(res, { item: mapCategory(created) }, 201);
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
    await ensureCategoryImageAsset(body.imageAssetId);
    const sectionId = await resolveCategorySectionId({ name, sectionId: body.sectionId });

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
        data: {
          name,
          imageAssetId: body.imageAssetId ?? null,
          sectionId,
        },
        include: {
          imageAsset: {
            include: buildCategoryImageInclude()
          },
          section: {
            include: buildSectionInclude()
          }
        }
      });
      return ok(res, { item: mapCategory(updated) });
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
    await ensureCategoryImageAsset(body.imageAssetId);
    const sectionId = await resolveCategorySectionId({ name, sectionId: body.sectionId });

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
        data: {
          name,
          imageAssetId: body.imageAssetId ?? null,
          sectionId,
        },
        include: {
          imageAsset: {
            include: buildCategoryImageInclude()
          },
          section: {
            include: buildSectionInclude()
          }
        }
      });
      return ok(res, { item: mapCategory(updated) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Category not found');
      }
      throw error;
    }
  })
);

servicesRouter.post(
  '/sections',
  requirePermission('EDIT_SERVICES'),
  validateBody(sectionPayloadSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof sectionPayloadSchema>;
    const name = body.name.trim();
    await ensureSectionImageAsset(body.imageAssetId);

    const duplicate = await prisma.serviceSection.findFirst({
      where: { name: { equals: name, mode: 'insensitive' as const } }
    });
    if (duplicate) {
      throw conflict('Section already exists');
    }

    const lastOrderIndexRow = await prisma.serviceSection.findFirst({
      orderBy: [{ orderIndex: 'desc' }]
    });

    const created = await prisma.serviceSection.create({
      data: {
        name,
        imageAssetId: body.imageAssetId ?? null,
        orderIndex: body.orderIndex ?? (lastOrderIndexRow?.orderIndex ?? 0) + 10
      },
      include: {
        imageAsset: {
          include: buildCategoryImageInclude()
        }
      }
    });

    return ok(res, { item: mapSection(created) }, 201);
  })
);

servicesRouter.patch(
  '/sections/:id',
  requirePermission('EDIT_SERVICES'),
  validateParams(idParamSchema),
  validateBody(sectionPayloadSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof sectionPayloadSchema>;
    const name = body.name.trim();
    await ensureSectionImageAsset(body.imageAssetId);

    const duplicate = await prisma.serviceSection.findFirst({
      where: {
        id: { not: id },
        name: { equals: name, mode: 'insensitive' as const }
      }
    });
    if (duplicate) {
      throw conflict('Section already exists');
    }

    try {
      const updated = await prisma.serviceSection.update({
        where: { id },
        data: {
          name,
          imageAssetId: body.imageAssetId ?? null,
          ...(body.orderIndex === undefined ? {} : { orderIndex: body.orderIndex })
        },
        include: {
          imageAsset: {
            include: buildCategoryImageInclude()
          }
        }
      });

      return ok(res, { item: mapSection(updated) });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Section not found');
      }
      throw error;
    }
  })
);

servicesRouter.delete(
  '/sections/:id',
  requirePermission('EDIT_SERVICES'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;

    try {
      await prisma.serviceSection.delete({ where: { id } });
      return ok(res, { deleted: true, id });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw notFound('Section not found');
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
