import type { NextFunction, Request, Response } from 'express';
import type { StaffRole } from '@prisma/client';

import { prisma } from '../db/prisma';
import { forbidden, unauthorized } from '../utils/errors';
import { verifyAccessToken } from '../utils/jwt';

const extractBearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
};

const loadStaffContext = async (staffId: string): Promise<{ role: StaffRole; permissions: string[] }> => {
  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    include: {
      permissions: {
        where: {
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        },
        include: { permission: true }
      }
    }
  });

  if (!staff || !staff.isActive || staff.firedAt) {
    throw unauthorized('Staff account is not active');
  }

  return {
    role: staff.role,
    permissions: staff.permissions.map((sp) => sp.permission.code)
  };
};

export const authenticateOptional = async (req: Request, _res: Response, next: NextFunction) => {
  const token = extractBearer(req);
  if (!token) {
    return next();
  }

  const payload = verifyAccessToken(token);
  req.auth = {
    subjectType: payload.subjectType,
    subjectId: payload.sub,
    sessionId: payload.sessionId
  };

  if (payload.subjectType === 'STAFF') {
    const ctx = await loadStaffContext(payload.sub);
    req.auth.staffRole = ctx.role;
    req.auth.permissions = ctx.permissions;
  }

  return next();
};

export const authenticateRequired = async (req: Request, res: Response, next: NextFunction) => {
  await authenticateOptional(req, res, (error?: unknown) => {
    if (error) {
      return next(error);
    }

    if (!req.auth) {
      return next(unauthorized());
    }

    return next();
  });
};

export const requireStaff = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth || req.auth.subjectType !== 'STAFF') {
    return next(unauthorized('Staff authentication required'));
  }
  return next();
};

export const requireClient = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth || req.auth.subjectType !== 'CLIENT') {
    return next(unauthorized('Client authentication required'));
  }
  return next();
};

export const requireStaffRoles = (...roles: StaffRole[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || req.auth.subjectType !== 'STAFF') {
      return next(unauthorized('Staff authentication required'));
    }
    if (!req.auth.staffRole || !roles.includes(req.auth.staffRole)) {
      return next(forbidden());
    }
    return next();
  };
};

export const requireStaffRolesOrPermission = (permissionCode: string, ...roles: StaffRole[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || req.auth.subjectType !== 'STAFF') {
      return next(unauthorized('Staff authentication required'));
    }
    if (req.auth.staffRole && roles.includes(req.auth.staffRole)) {
      return next();
    }
    if (hasPermission(req, permissionCode)) {
      return next();
    }
    return next(forbidden());
  };
};

export const hasPermission = (req: Request, permissionCode: string): boolean => {
  if (!req.auth || req.auth.subjectType !== 'STAFF') return false;
  if (req.auth.staffRole === 'OWNER') return true;
  return req.auth.permissions?.includes(permissionCode) ?? false;
};

export const requirePermission = (permissionCode: string) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || req.auth.subjectType !== 'STAFF') {
      return next(unauthorized('Staff authentication required'));
    }
    if (!hasPermission(req, permissionCode)) {
      return next(forbidden());
    }
    return next();
  };
};

export const canViewFinancial = (req: Request): boolean => {
  if (!req.auth || req.auth.subjectType !== 'STAFF') return false;
  return req.auth.staffRole === 'OWNER' || (req.auth.permissions?.includes('VIEW_FINANCIAL_STATS') ?? false);
};
