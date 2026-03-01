import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequired, requireStaff, requireStaffRoles } from '../../middlewares/auth';
import { validateBody } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { ok } from '../../utils/response';
import { getOrCreateAppConfig, updateClientCancelMinNoticeMinutes } from './service';

const updateCancelPolicySchema = z.object({
  minNoticeMinutes: z.coerce.number().int().min(0).max(60 * 24 * 30)
});

export const settingsRouter = Router();

settingsRouter.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const config = await getOrCreateAppConfig();
    return ok(res, {
      clientCancelMinNoticeMinutes: config.clientCancelMinNoticeMinutes
    });
  })
);

settingsRouter.get(
  '/staff',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('MASTER', 'ADMIN', 'OWNER'),
  asyncHandler(async (_req, res) => {
    const config = await getOrCreateAppConfig();
    return ok(res, {
      clientCancelMinNoticeMinutes: config.clientCancelMinNoticeMinutes
    });
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
    return ok(res, {
      clientCancelMinNoticeMinutes: updated.clientCancelMinNoticeMinutes
    });
  })
);
