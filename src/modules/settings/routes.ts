import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequired, requirePermission, requireStaff, requireStaffRoles } from '../../middlewares/auth';
import { validateBody } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { ok } from '../../utils/response';
import { getOrCreateAppConfig, updateClientCancelMinNoticeMinutes, updatePrivacyPolicy } from './service';

const updateCancelPolicySchema = z.object({
  minNoticeMinutes: z.coerce.number().int().min(0).max(60 * 24 * 30)
});

const updatePrivacyPolicySchema = z.object({
  content: z.string().max(100_000)
});

function mapSettingsResponse(config: Awaited<ReturnType<typeof getOrCreateAppConfig>>) {
  return {
    clientCancelMinNoticeMinutes: config.clientCancelMinNoticeMinutes,
    clientCancelPolicy: {
      minNoticeMinutes: config.clientCancelMinNoticeMinutes
    },
    privacyPolicy: {
      content: config.privacyPolicy
    }
  };
}

export const settingsRouter = Router();

settingsRouter.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const config = await getOrCreateAppConfig();
    return ok(res, mapSettingsResponse(config));
  })
);

settingsRouter.get(
  '/staff',
  authenticateRequired,
  requireStaff,
  asyncHandler(async (_req, res) => {
    const config = await getOrCreateAppConfig();
    return ok(res, mapSettingsResponse(config));
  })
);

settingsRouter.patch(
  '/client-cancel-policy',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('OWNER'),
  validateBody(updateCancelPolicySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateCancelPolicySchema>;
    const updated = await updateClientCancelMinNoticeMinutes(body.minNoticeMinutes);
    return ok(res, mapSettingsResponse(updated));
  })
);

settingsRouter.patch(
  '/privacy-policy',
  authenticateRequired,
  requireStaff,
  requirePermission('MANAGE_CLIENT_FRONT'),
  validateBody(updatePrivacyPolicySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updatePrivacyPolicySchema>;
    const updated = await updatePrivacyPolicy(body.content);
    return ok(res, mapSettingsResponse(updated));
  })
);
