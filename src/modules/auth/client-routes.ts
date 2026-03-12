import { DiscountType, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { authenticateRequired, requireClient } from '../../middlewares/auth';
import { toNumber } from '../../utils/money';
import { asyncHandler } from '../../utils/async-handler';
import { hashToken, randomToken } from '../../utils/crypto';
import { badRequest, conflict, notFound, unauthorized } from '../../utils/errors';
import { sendEmail } from '../../utils/mailer';
import { normalizePhone10, toPhoneE164 } from '../../utils/phone';
import { hashSecret, validatePassword, verifySecret } from '../../utils/password';
import { ok } from '../../utils/response';
import { validateBody } from '../../middlewares/validate';
import { clientAvatarUpload, deleteClientAvatar, resolveClientAvatarUrl, saveClientAvatar } from '../clients/avatar';
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

const mapClientAuthProfile = (payload: {
  id: string;
  phoneE164: string;
  name: string | null;
  email?: string | null;
  avatarPath?: string | null;
  discountType: DiscountType;
  discountValue: Prisma.Decimal | null;
}) => ({
  id: payload.id,
  phoneE164: payload.phoneE164,
  name: payload.name,
  email: payload.email ?? null,
  avatarUrl: resolveClientAvatarUrl(payload.avatarPath),
  discount: {
    permanentPercent:
      payload.discountType === DiscountType.PERCENT && payload.discountValue !== null
        ? toNumber(payload.discountValue)
        : null
  }
});

const buildClientResetPasswordEmail = (payload: { name?: string | null; resetLink: string }) => {
  const greeting = `Здравствуйте${payload.name ? `, ${payload.name}` : ''}!`;
  const text = [
    greeting,
    '',
    'Мы получили запрос на восстановление доступа в личный кабинет Mari.',
    'Чтобы задать новый пароль, перейдите по ссылке:',
    payload.resetLink,
    '',
    'Ссылка действует 24 часа.',
    'Если вы не запрашивали восстановление, просто проигнорируйте это письмо.'
  ].join('\n');

  const html = `
    <div style="margin:0;padding:24px;background:#f5f1ec;font-family:Arial,Helvetica,sans-serif;color:#20343a;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid rgba(12,77,85,.08);border-radius:20px;padding:32px;">
        <div style="font-size:12px;letter-spacing:.28em;text-transform:uppercase;color:#5f7478;">MARI Beauty Salon</div>
        <h1 style="margin:16px 0 12px;font-size:28px;line-height:1.1;color:#0c4d55;">Восстановление доступа</h1>
        <p style="margin:0 0 12px;font-size:16px;line-height:1.7;">${greeting}</p>
        <p style="margin:0 0 12px;font-size:16px;line-height:1.7;">
          Мы получили запрос на восстановление доступа в личный кабинет Mari.
        </p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.7;">
          Чтобы задать новый пароль, нажмите на кнопку ниже.
        </p>
        <p style="margin:0 0 24px;">
          <a href="${payload.resetLink}" style="display:inline-block;padding:14px 22px;border-radius:999px;background:#0c4d55;color:#ffffff;text-decoration:none;font-weight:600;">
            Задать новый пароль
          </a>
        </p>
        <p style="margin:0 0 10px;font-size:14px;line-height:1.7;color:#5f7478;">
          Если кнопка не открывается, используйте эту ссылку:
        </p>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.7;word-break:break-all;">
          <a href="${payload.resetLink}" style="color:#0c4d55;">${payload.resetLink}</a>
        </p>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#5f7478;">
          Ссылка действует 24 часа. Если вы не запрашивали восстановление, просто проигнорируйте это письмо.
        </p>
      </div>
    </div>
  `.trim();

  return { text, html };
};

export const clientAuthRouter = Router();

clientAuthRouter.get(
  '/profile',
  authenticateRequired,
  requireClient,
  asyncHandler(async (req, res) => {
    const client = await prisma.client.findUnique({
      where: { id: req.auth!.subjectId },
      include: { account: true }
    });

    if (!client) {
      throw unauthorized('Client account not found');
    }

    return ok(res, {
      client: mapClientAuthProfile({
        id: client.id,
        phoneE164: client.phoneE164,
        name: client.name,
        email: client.account?.email ?? null,
        avatarPath: client.avatarPath,
        discountType: client.discountType,
        discountValue: client.discountValue
      })
    });
  })
);

clientAuthRouter.post(
  '/avatar',
  authenticateRequired,
  requireClient,
  clientAvatarUpload.single('file'),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      throw badRequest('file is required');
    }

    await saveClientAvatar(req.auth!.subjectId, file);

    const client = await prisma.client.findUnique({
      where: { id: req.auth!.subjectId },
      include: { account: true }
    });

    if (!client) {
      throw unauthorized('Client account not found');
    }

    return ok(res, {
      client: mapClientAuthProfile({
        id: client.id,
        phoneE164: client.phoneE164,
        name: client.name,
        email: client.account?.email ?? null,
        avatarPath: client.avatarPath,
        discountType: client.discountType,
        discountValue: client.discountValue
      })
    });
  })
);

clientAuthRouter.delete(
  '/avatar',
  authenticateRequired,
  requireClient,
  asyncHandler(async (req, res) => {
    await deleteClientAvatar(req.auth!.subjectId);

    const client = await prisma.client.findUnique({
      where: { id: req.auth!.subjectId },
      include: { account: true }
    });

    if (!client) {
      throw unauthorized('Client account not found');
    }

    return ok(res, {
      client: mapClientAuthProfile({
        id: client.id,
        phoneE164: client.phoneE164,
        name: client.name,
        email: client.account?.email ?? null,
        avatarPath: client.avatarPath,
        discountType: client.discountType,
        discountValue: client.discountValue
      })
    });
  })
);

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
        client: mapClientAuthProfile({
          id: client.id,
          phoneE164: client.phoneE164,
          name: client.name,
          email: client.account?.email,
          avatarPath: client.avatarPath,
          discountType: client.discountType,
          discountValue: client.discountValue
        }),
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
        const mail = buildClientResetPasswordEmail({
          name: account.client.name,
          resetLink
        });
        await sendEmail({
          to: account.email,
          subject: 'Восстановление доступа в личный кабинет Mari',
          text: mail.text,
          html: mail.html
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
      client: mapClientAuthProfile({
        id: account.client.id,
        phoneE164: account.client.phoneE164,
        name: account.client.name,
        email: account.email,
        avatarPath: account.client.avatarPath,
        discountType: account.client.discountType,
        discountValue: account.client.discountValue
      }),
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
      client: mapClientAuthProfile({
        id: client.id,
        phoneE164: client.phoneE164,
        name: client.name,
        email: account.email,
        avatarPath: client.avatarPath,
        discountType: client.discountType,
        discountValue: client.discountValue
      }),
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
      client: mapClientAuthProfile({
        id: account.client.id,
        phoneE164: account.client.phoneE164,
        name: account.client.name,
        email: account.email,
        avatarPath: account.client.avatarPath,
        discountType: account.client.discountType,
        discountValue: account.client.discountValue
      }),
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
