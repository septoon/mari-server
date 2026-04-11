import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { env } from '../../config/env';
import {
  authenticateRequired,
  hasPermission,
  requirePermission,
  requireStaff,
  requireStaffRoles
} from '../../middlewares/auth';
import { validateBody, validateParams, validateQuery } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { badRequest, forbidden } from '../../utils/errors';
import { ok } from '../../utils/response';
import {
  blockIdParamsSchema,
  bootstrapQuerySchema,
  createBlockSchema,
  createMediaUsageSchema,
  mediaAssetParamsSchema,
  mediaListQuerySchema,
  mediaUploadBodySchema,
  patchClientAppConfigSchema,
  patchSpecialistProfileSchema,
  previewQuerySchema,
  releaseListQuerySchema,
  specialistParamsSchema,
  updateBlockSchema
} from './schemas';
import {
  addMediaUsage,
  createDraftBlock,
  deleteDraftBlock,
  deleteMediaAsset,
  deleteMediaUsage,
  ensureMediaStorageReady,
  getClientBootstrap,
  getDraftClientConfig,
  getDraftClientConfigRaw,
  getMediaAsset,
  getMediaPublicConfiguration,
  listDraftSpecialistsForStaff,
  listDraftBlocks,
  listMediaAssets,
  listReleases,
  patchDraftSpecialistProfile,
  patchDraftClientConfig,
  publishClientFront,
  updateDraftBlock,
  uploadMediaAsset
} from './service';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MEDIA_MAX_UPLOAD_MB * 1024 * 1024,
    files: 1
  }
});

const etagHeaderValue = (etag: string): string => `"${etag}"`;

const parseRequestEtag = (headerValue: string | string[] | undefined): string | null => {
  if (!headerValue) return null;
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) return null;
  return raw.replace('W/', '').replaceAll('"', '').trim();
};

const mediaUsageParamsSchema = z.object({
  id: z.string().uuid(),
  usageId: z.string().uuid()
});

export const clientFrontRouter = Router();

clientFrontRouter.get(
  '/bootstrap',
  validateQuery(bootstrapQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof bootstrapQuerySchema>;
    const bootstrap = await getClientBootstrap(query.platform, query.appVersion);

    const requestEtag = parseRequestEtag(req.headers['if-none-match']);
    if (requestEtag && requestEtag === bootstrap.etag) {
      res.setHeader('ETag', etagHeaderValue(bootstrap.etag));
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      return res.status(304).end();
    }

    res.setHeader('ETag', etagHeaderValue(bootstrap.etag));
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    return ok(res, bootstrap.payload);
  })
);

clientFrontRouter.get(
  '/staff/config',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_FRONT'),
  asyncHandler(async (_req, res) => {
    const config = await getDraftClientConfigRaw();
    return ok(res, config);
  })
);

clientFrontRouter.patch(
  '/staff/config',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_FRONT'),
  validateBody(patchClientAppConfigSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof patchClientAppConfigSchema>;
    const updated = await patchDraftClientConfig(body, req.auth!.subjectId);

    return ok(res, {
      id: updated.id,
      singleton: updated.singleton,
      updatedAt: updated.updatedAt
    });
  })
);

clientFrontRouter.get(
  '/staff/specialists',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  asyncHandler(async (_req, res) => {
    const items = await listDraftSpecialistsForStaff();
    return ok(res, { items });
  })
);

clientFrontRouter.patch(
  '/staff/specialists/:staffId',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateParams(specialistParamsSchema),
  validateBody(patchSpecialistProfileSchema),
  asyncHandler(async (req, res) => {
    const { staffId } = req.params as z.infer<typeof specialistParamsSchema>;
    const body = req.body as z.infer<typeof patchSpecialistProfileSchema>;

    const updated = await patchDraftSpecialistProfile(staffId, body, req.auth!.subjectId);
    return ok(res, updated);
  })
);

clientFrontRouter.get(
  '/staff/blocks',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_FRONT'),
  asyncHandler(async (_req, res) => {
    const items = await listDraftBlocks();
    return ok(res, { items });
  })
);

clientFrontRouter.post(
  '/staff/blocks',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_FRONT'),
  validateBody(createBlockSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createBlockSchema>;
    const created = await createDraftBlock(body, req.auth!.subjectId);
    return ok(res, created, 201);
  })
);

clientFrontRouter.patch(
  '/staff/blocks/:id',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_FRONT'),
  validateParams(blockIdParamsSchema),
  validateBody(updateBlockSchema),
  asyncHandler(async (req, res) => {
    const params = req.params as z.infer<typeof blockIdParamsSchema>;
    const body = req.body as z.infer<typeof updateBlockSchema>;

    const updated = await updateDraftBlock(params.id, body, req.auth!.subjectId);
    return ok(res, updated);
  })
);

clientFrontRouter.delete(
  '/staff/blocks/:id',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_FRONT'),
  validateParams(blockIdParamsSchema),
  asyncHandler(async (req, res) => {
    const params = req.params as z.infer<typeof blockIdParamsSchema>;
    const result = await deleteDraftBlock(params.id, req.auth!.subjectId);
    return ok(res, result);
  })
);

clientFrontRouter.get(
  '/staff/preview',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_FRONT'),
  validateQuery(previewQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof previewQuerySchema>;
    const at = query.at ? new Date(query.at) : new Date();
    const preview = await getDraftClientConfig(query.platform, query.appVersion, at);

    return ok(res, preview);
  })
);

clientFrontRouter.post(
  '/staff/publish',
  authenticateRequired,
  requireStaff,
  requirePermission('PUBLISH_CLIENT_FRONT'),
  asyncHandler(async (req, res) => {
    const result = await publishClientFront(req.auth!.subjectId);

    res.setHeader('ETag', etagHeaderValue(result.etag));
    return ok(res, result, 201);
  })
);

clientFrontRouter.get(
  '/staff/releases',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_FRONT'),
  validateQuery(releaseListQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof releaseListQuerySchema>;
    const list = await listReleases(query.page, query.limit);

    return ok(
      res,
      {
        items: list.items.map((item: (typeof list.items)[number]) => ({
          id: item.id,
          version: item.version,
          etag: item.etag,
          blocksCount: item.blocksCount,
          publishedAt: item.publishedAt,
          publishedByStaff: item.publishedByStaff
        }))
      },
      200,
      {
        page: list.page,
        limit: list.limit,
        total: list.total,
        pages: list.pages
      }
    );
  })
);

clientFrontRouter.get(
  '/staff/media/config',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_MEDIA'),
  asyncHandler(async (_req, res) => {
    return ok(res, getMediaPublicConfiguration());
  })
);

clientFrontRouter.post(
  '/staff/media/upload',
  authenticateRequired,
  requireStaff,
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw badRequest('file is required');
    }

    const bodyValidation = mediaUploadBodySchema.safeParse(req.body);
    if (!bodyValidation.success) {
      throw badRequest('Invalid upload payload', bodyValidation.error.flatten());
    }

    const entity = bodyValidation.data.entity.trim().toLowerCase();
    if (!hasPermission(req, 'MANAGE_MEDIA') && entity !== 'specialists') {
      throw forbidden();
    }

    await ensureMediaStorageReady();
    const uploaded = await uploadMediaAsset(file, entity, req.auth!.subjectId);
    return ok(res, uploaded, 201);
  })
);

clientFrontRouter.get(
  '/staff/media',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_MEDIA'),
  validateQuery(mediaListQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof mediaListQuerySchema>;
    const list = await listMediaAssets(query.page, query.limit, query.entity, query.search);

    return ok(
      res,
      {
        items: list.items
      },
      200,
      {
        page: list.page,
        limit: list.limit,
        total: list.total,
        pages: list.pages
      }
    );
  })
);

clientFrontRouter.get(
  '/staff/media/:id',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_MEDIA'),
  validateParams(mediaAssetParamsSchema.pick({ id: true })),
  asyncHandler(async (req, res) => {
    const params = req.params as z.infer<typeof mediaAssetParamsSchema>;
    const asset = await getMediaAsset(params.id);
    return ok(res, asset);
  })
);

clientFrontRouter.post(
  '/staff/media/:id/usages',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_MEDIA'),
  validateParams(mediaAssetParamsSchema.pick({ id: true })),
  validateBody(createMediaUsageSchema),
  asyncHandler(async (req, res) => {
    const params = req.params as z.infer<typeof mediaAssetParamsSchema>;
    const body = req.body as z.infer<typeof createMediaUsageSchema>;

    const usage = await addMediaUsage(params.id, body, req.auth!.subjectId);
    return ok(res, usage, 201);
  })
);

clientFrontRouter.delete(
  '/staff/media/:id/usages/:usageId',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_MEDIA'),
  validateParams(mediaUsageParamsSchema),
  asyncHandler(async (req, res) => {
    const params = req.params as z.infer<typeof mediaUsageParamsSchema>;
    const result = await deleteMediaUsage(params.id, params.usageId, req.auth!.subjectId);
    return ok(res, result);
  })
);

clientFrontRouter.delete(
  '/staff/media/:id',
  authenticateRequired,
  requireStaff,
  validateParams(mediaAssetParamsSchema.pick({ id: true })),
  asyncHandler(async (req, res) => {
    const params = req.params as z.infer<typeof mediaAssetParamsSchema>;
    if (!hasPermission(req, 'MANAGE_MEDIA')) {
      const asset = await getMediaAsset(params.id);
      if (asset.entity !== 'specialists') {
        throw forbidden();
      }
    }
    const result = await deleteMediaAsset(params.id, req.auth!.subjectId);
    return ok(res, result);
  })
);
