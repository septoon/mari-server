import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma';
import { asyncHandler } from '../../utils/async-handler';
import { unauthorized } from '../../utils/errors';
import { normalizePhone10, toPhoneE164 } from '../../utils/phone';
import { validatePin, verifySecret } from '../../utils/password';
import { ok } from '../../utils/response';
import { validateBody } from '../../middlewares/validate';
import { createSession, revokeByRefreshToken, rotateRefresh } from './service';

const loginSchema = z.object({
  phone: z.string().min(1),
  pin: z.string().min(4).max(8)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const logoutSchema = refreshSchema;

export const staffAuthRouter = Router();

staffAuthRouter.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof loginSchema>;
    validatePin(body.pin);
    const phone10 = normalizePhone10(body.phone);

    const staff = await prisma.staff.findUnique({ where: { phone10 } });
    if (!staff || !staff.pinHash || !staff.isActive || staff.firedAt) {
      throw unauthorized('Invalid credentials');
    }

    const pinOk = await verifySecret(body.pin, staff.pinHash);
    if (!pinOk) {
      throw unauthorized('Invalid credentials');
    }

    const tokens = await createSession('STAFF', staff.id, staff.role, req.headers['user-agent'], req.ip);

    return ok(res, {
      staff: {
        id: staff.id,
        name: staff.name,
        role: staff.role,
        phoneE164: staff.phoneE164 ?? toPhoneE164(phone10),
        email: staff.email
      },
      tokens
    });
  })
);

staffAuthRouter.post(
  '/refresh',
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
    const refreshed = await rotateRefresh(refreshToken);
    if (refreshed.subjectType !== 'STAFF') {
      throw unauthorized('Invalid token subject');
    }

    const staff = await prisma.staff.findUnique({
      where: { id: refreshed.subjectId }
    });
    if (!staff || !staff.isActive || staff.firedAt) {
      throw unauthorized('Staff account is not active');
    }

    return ok(res, {
      staff: {
        id: staff.id,
        name: staff.name,
        role: staff.role,
        phoneE164: staff.phoneE164,
        email: staff.email
      },
      tokens: refreshed.tokens
    });
  })
);

staffAuthRouter.post(
  '/logout',
  validateBody(logoutSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof logoutSchema>;
    const revoked = await revokeByRefreshToken(refreshToken);
    return ok(res, { revoked });
  })
);
