import type { StaffRole } from '@prisma/client';

import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { hashToken } from '../../utils/crypto';
import { unauthorized } from '../../utils/errors';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/jwt';

type SubjectType = 'CLIENT' | 'STAFF';

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
};

export const createSession = async (
  subjectType: SubjectType,
  subjectId: string,
  role?: StaffRole,
  userAgent?: string,
  ip?: string
): Promise<TokenPair> => {
  const placeholderSession = await prisma.session.create({
    data: {
      subjectType,
      subjectId,
      refreshTokenHash: 'pending',
      userAgent,
      ip,
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SEC * 1000)
    }
  });

  const refreshToken = signRefreshToken({
    sub: subjectId,
    subjectType,
    sessionId: placeholderSession.id,
    type: 'refresh'
  });

  const accessToken = signAccessToken({
    sub: subjectId,
    subjectType,
    sessionId: placeholderSession.id,
    role
  });

  await prisma.session.update({
    where: { id: placeholderSession.id },
    data: {
      refreshTokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SEC * 1000)
    }
  });

  return {
    accessToken,
    refreshToken,
    expiresInSec: env.ACCESS_TOKEN_TTL_SEC
  };
};

export const rotateRefresh = async (refreshToken: string): Promise<{
  tokens: TokenPair;
  subjectType: SubjectType;
  subjectId: string;
  staffRole?: StaffRole;
}> => {
  const payload = verifyRefreshToken(refreshToken);
  const session = await prisma.session.findUnique({ where: { id: payload.sessionId } });

  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw unauthorized('Session expired or revoked');
  }
  if (session.refreshTokenHash !== hashToken(refreshToken)) {
    throw unauthorized('Refresh token mismatch');
  }
  if (session.subjectType !== payload.subjectType || session.subjectId !== payload.sub) {
    throw unauthorized('Token subject mismatch');
  }

  let staffRole: StaffRole | undefined;
  if (payload.subjectType === 'STAFF') {
    const staff = await prisma.staff.findUnique({ where: { id: payload.sub } });
    if (!staff || !staff.isActive || staff.firedAt || staff.deletedAt) {
      throw unauthorized('Staff account is not active');
    }
    staffRole = staff.role;
  }

  const newRefresh = signRefreshToken({
    sub: payload.sub,
    subjectType: payload.subjectType,
    sessionId: session.id,
    type: 'refresh'
  });

  const newAccess = signAccessToken({
    sub: payload.sub,
    subjectType: payload.subjectType,
    sessionId: session.id,
    role: staffRole
  });

  await prisma.session.update({
    where: { id: session.id },
    data: {
      refreshTokenHash: hashToken(newRefresh),
      expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SEC * 1000)
    }
  });

  return {
    tokens: {
      accessToken: newAccess,
      refreshToken: newRefresh,
      expiresInSec: env.ACCESS_TOKEN_TTL_SEC
    },
    subjectType: payload.subjectType,
    subjectId: payload.sub,
    staffRole
  };
};

export const revokeByRefreshToken = async (refreshToken: string): Promise<boolean> => {
  const payload = verifyRefreshToken(refreshToken);
  const session = await prisma.session.findUnique({ where: { id: payload.sessionId } });
  if (!session) return false;
  if (session.refreshTokenHash !== hashToken(refreshToken)) {
    return false;
  }

  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() }
  });

  return true;
};

export const revokeAllSubjectSessions = async (
  subjectType: SubjectType,
  subjectId: string
): Promise<number> => {
  const result = await prisma.session.updateMany({
    where: {
      subjectType,
      subjectId,
      revokedAt: null
    },
    data: { revokedAt: new Date() }
  });

  return result.count;
};
