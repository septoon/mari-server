import { Router } from 'express';
import { z } from 'zod';

import {
  authenticateRequired,
  requirePermission,
  requireStaff,
  requireStaffRoles,
} from '../../middlewares/auth';
import { validateBody } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { badRequest } from '../../utils/errors';
import { ok } from '../../utils/response';
import { NOTIFICATION_ID_SET } from '../notifications/catalog';
import {
  buildSettingsResponse,
  getOrCreateAppConfig,
  updateClientCancelMinNoticeMinutes,
  updateNotificationSettings,
  updatePrivacyPolicy,
} from './service';

const updateCancelPolicySchema = z.object({
  minNoticeMinutes: z.coerce.number().int().min(0).max(60 * 24 * 30),
});

const updateNotificationsSchema = z.object({
  minNoticeMinutes: z.coerce.number().int().min(1).max(60 * 24 * 30).optional(),
  toggles: z.record(z.string(), z.boolean()).optional(),
}).refine((value) => value.minNoticeMinutes !== undefined || value.toggles !== undefined, {
  message: 'At least one field is required',
});

const updatePrivacyPolicySchema = z.object({
  content: z.string().max(100_000),
});

export const settingsRouter = Router();

settingsRouter.get(
  '/public',
  asyncHandler(async (_req, res) => {
    const config = await getOrCreateAppConfig();
    const payload = buildSettingsResponse(config);
    return ok(res, {
      clientCancelMinNoticeMinutes: payload.clientCancelMinNoticeMinutes,
      clientCancelPolicy: payload.clientCancelPolicy,
      notificationMinNoticeMinutes: payload.notificationMinNoticeMinutes,
      notifications: {
        minNoticeMinutes: payload.notifications.minNoticeMinutes,
      },
      privacyPolicy: payload.privacyPolicy,
    });
  }),
);

settingsRouter.get(
  '/staff',
  authenticateRequired,
  requireStaff,
  asyncHandler(async (_req, res) => {
    const config = await getOrCreateAppConfig();
    return ok(res, buildSettingsResponse(config));
  }),
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
    return ok(res, buildSettingsResponse(updated));
  }),
);

settingsRouter.patch(
  '/notifications',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('OWNER'),
  validateBody(updateNotificationsSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateNotificationsSchema>;

    if (body.toggles) {
      Object.keys(body.toggles).forEach((key) => {
        if (!NOTIFICATION_ID_SET.has(key)) {
          throw badRequest('Unknown notification toggle id', { id: key });
        }
      });
    }

    const updated = await updateNotificationSettings({
      minNoticeMinutes: body.minNoticeMinutes,
      toggles: body.toggles,
    });
    return ok(res, buildSettingsResponse(updated));
  }),
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
    return ok(res, buildSettingsResponse(updated));
  }),
);
