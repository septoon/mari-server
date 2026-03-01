import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { unauthorized } from './errors';

export type SubjectType = 'CLIENT' | 'STAFF';

type AccessPayload = {
  sub: string;
  subjectType: SubjectType;
  sessionId: string;
  role?: string;
};

type RefreshPayload = {
  sub: string;
  subjectType: SubjectType;
  sessionId: string;
  type: 'refresh';
};

export const signAccessToken = (payload: AccessPayload): string => {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL_SEC
  });
};

export const signRefreshToken = (payload: RefreshPayload): string => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.REFRESH_TOKEN_TTL_SEC
  });
};

export const verifyAccessToken = (token: string): AccessPayload => {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
};

export const verifyRefreshToken = (token: string): RefreshPayload => {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshPayload;
    if (decoded.type !== 'refresh') {
      throw unauthorized('Invalid token type');
    }
    return decoded;
  } catch {
    throw unauthorized('Invalid or expired refresh token');
  }
};
