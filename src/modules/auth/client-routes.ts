import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { asyncHandler } from '../../utils/async-handler';
import { hashToken, randomToken } from '../../utils/crypto';
import { conflict, notFound, unauthorized } from '../../utils/errors';
import { sendEmail } from '../../utils/mailer';
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

const passwordResetRequestSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(1).optional()
  })
  .refine((payload) => Boolean(payload.email || payload.phone), {
    message: 'email or phone is required'
  });

const passwordResetConfirmSchema = z.object({
  token: z.string().min(20),
  newPassword: z.string().min(8)
});

const buildClientResetPasswordLink = (token: string): string =>
  `${env.CLIENT_WEB_BASE_URL}${env.CLIENT_WEB_RESET_PASSWORD_PATH}?token=${token}`;

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
  '/password/reset/request',
  validateBody(passwordResetRequestSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof passwordResetRequestSchema>;
    const normalizedEmail = body.email?.toLowerCase();
    const phone10 = body.phone ? normalizePhone10(body.phone) : undefined;

    const account = await prisma.clientAccount.findFirst({
      where: {
        ...(normalizedEmail ? { email: normalizedEmail } : {}),
        ...(phone10 ? { client: { phone10 } } : {})
      },
      include: { client: true }
    });

    let resetLink: string | undefined;
    if (account?.email) {
      const rawToken = randomToken();
      await prisma.clientAccount.update({
        where: { id: account.id },
        data: {
          passwordResetTokenHash: hashToken(rawToken),
          passwordResetExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
          passwordResetUsedAt: null
        }
      });

      resetLink = buildClientResetPasswordLink(rawToken);
      try {
        await sendEmail({
          to: account.email,
          subject: 'Mari Beauty: восстановление пароля',
          text: [
            `Здравствуйте${account.client.name ? `, ${account.client.name}` : ''}!`,
            '',
            'Для восстановления пароля перейдите по ссылке:',
            resetLink,
            '',
            'Ссылка действует 24 часа.'
          ].join('\n')
        });
      } catch (error) {
        console.error('[CLIENT_RESET_PASSWORD_MAIL_ERROR]', { accountId: account.id, error });
      }
    }

    return ok(res, {
      sent: true,
      ...(env.NODE_ENV !== 'production' && env.DEV_SHOW_LINKS && resetLink ? { resetLink } : {})
    });
  })
);

clientAuthRouter.post(
  '/password/reset/confirm',
  validateBody(passwordResetConfirmSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof passwordResetConfirmSchema>;
    validatePassword(body.newPassword);

    const account = await prisma.clientAccount.findFirst({
      where: {
        passwordResetTokenHash: hashToken(body.token),
        passwordResetUsedAt: null,
        passwordResetExpiresAt: { gt: new Date() }
      },
      include: { client: true }
    });
    if (!account) {
      throw notFound('Token not found or expired');
    }

    const nextPasswordHash = await hashSecret(body.newPassword);
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.clientAccount.update({
        where: { id: account.id },
        data: {
          passwordHash: nextPasswordHash,
          lastLoginAt: now,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          passwordResetUsedAt: now
        }
      });

      await tx.session.updateMany({
        where: {
          subjectType: 'CLIENT',
          subjectId: account.clientId,
          revokedAt: null
        },
        data: { revokedAt: now }
      });
    });

    const tokens = await createSession(
      'CLIENT',
      account.clientId,
      undefined,
      req.headers['user-agent'],
      req.ip
    );

    return ok(res, {
      client: {
        id: account.client.id,
        phoneE164: account.client.phoneE164,
        name: account.client.name,
        email: account.email
      },
      tokens
    });
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
