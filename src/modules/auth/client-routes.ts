import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma';
import { asyncHandler } from '../../utils/async-handler';
import { conflict, unauthorized } from '../../utils/errors';
import { normalizePhone10, toPhoneE164 } from '../../utils/phone';
import { hashSecret, validatePassword, verifySecret } from '../../utils/password';
import { ok } from '../../utils/response';
import { validateBody } from '../../middlewares/validate';
import { createSession, revokeByRefreshToken, rotateRefresh } from './service';

const registerSchema = z.object({
  email: z.string().email().optional(),
  password: z.string().min(8),
  phone: z.string().min(1),
  name: z.string().trim().min(1).optional()
});

const loginSchema = z.object({
  phone: z.string().min(1),
  password: z.string().min(1)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

const logoutSchema = refreshSchema;

export const clientAuthRouter = Router();

clientAuthRouter.post(
  '/register',
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof registerSchema>;
    validatePassword(body.password);

    const phone10 = normalizePhone10(body.phone);
    const phoneE164 = toPhoneE164(phone10);
    const normalizedEmail = body.email?.toLowerCase();

    if (normalizedEmail) {
      const existingAccountByEmail = await prisma.clientAccount.findUnique({
        where: { email: normalizedEmail }
      });
      if (existingAccountByEmail) {
        throw conflict('Email already registered');
      }
    }

    const passwordHash = await hashSecret(body.password);

    const client = await prisma.$transaction(async (tx) => {
      const existingClient = await tx.client.findUnique({ where: { phone10 } });
      let clientId: string;

      if (!existingClient) {
        const created = await tx.client.create({
          data: {
            phone10,
            phoneE164,
            name: body.name?.trim() || null
          }
        });
        clientId = created.id;
      } else {
        const incomingName = body.name?.trim();
        const nextName = !existingClient.name
          ? (incomingName ?? null)
          : ((incomingName?.length ?? 0) > existingClient.name.length ? incomingName : existingClient.name);

        const updated = await tx.client.update({
          where: { id: existingClient.id },
          data: {
            name: nextName,
            phoneE164
          }
        });
        clientId = updated.id;

        const linkedAccount = await tx.clientAccount.findUnique({ where: { clientId } });
        if (linkedAccount) {
          throw conflict('Client account already exists for this phone');
        }
      }

      await tx.clientAccount.create({
        data: {
          clientId,
          email: normalizedEmail ?? null,
          passwordHash,
          lastLoginAt: new Date()
        }
      });

      return tx.client.findUniqueOrThrow({
        where: { id: clientId },
        include: {
          account: true
        }
      });
    });

    const tokens = await createSession(
      'CLIENT',
      client.id,
      undefined,
      req.headers['user-agent'],
      req.ip
    );

    return ok(
      res,
      {
        client: {
          id: client.id,
          phoneE164: client.phoneE164,
          name: client.name,
          email: client.account?.email
        },
        tokens
      },
      201
    );
  })
);

clientAuthRouter.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof loginSchema>;
    const phone10 = normalizePhone10(body.phone);
    const client = await prisma.client.findUnique({
      where: { phone10 },
      include: { account: true }
    });
    const account = client?.account;

    if (!account) {
      throw unauthorized('Invalid phone or password');
    }

    const validPassword = await verifySecret(body.password, account.passwordHash);
    if (!validPassword) {
      throw unauthorized('Invalid phone or password');
    }

    await prisma.clientAccount.update({
      where: { id: account.id },
      data: { lastLoginAt: new Date() }
    });

    const tokens = await createSession(
      'CLIENT',
      client.id,
      undefined,
      req.headers['user-agent'],
      req.ip
    );

    return ok(res, {
      client: {
        id: client.id,
        phoneE164: client.phoneE164,
        name: client.name,
        email: account.email
      },
      tokens
    });
  })
);

clientAuthRouter.post(
  '/refresh',
  validateBody(refreshSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof refreshSchema>;
    const refreshed = await rotateRefresh(refreshToken);
    if (refreshed.subjectType !== 'CLIENT') {
      throw unauthorized('Invalid token subject');
    }

    const account = await prisma.clientAccount.findUnique({
      where: { clientId: refreshed.subjectId },
      include: { client: true }
    });
    if (!account) {
      throw unauthorized('Client account not found');
    }

    return ok(res, {
      client: {
        id: account.client.id,
        phoneE164: account.client.phoneE164,
        name: account.client.name,
        email: account.email
      },
      tokens: refreshed.tokens
    });
  })
);

clientAuthRouter.post(
  '/logout',
  validateBody(logoutSchema),
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body as z.infer<typeof logoutSchema>;
    const revoked = await revokeByRefreshToken(refreshToken);
    return ok(res, { revoked });
  })
);
