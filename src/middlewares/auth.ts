import type { NextFunction, Request, Response } from 'express';
import type { StaffRole } from '@prisma/client';

import { prisma } from '../db/prisma';
import { forbidden, unauthorized } from '../utils/errors';
import { verifyAccessToken } from '../utils/jwt';

const PERMISSION_EQUIVALENTS: Record<string, string[]> = {
  VIEW_JOURNAL: ['VIEW_JOURNAL', 'EDIT_JOURNAL', 'ACCESS_JOURNAL'],
  VIEW_ALL_JOURNAL_APPOINTMENTS: ['VIEW_ALL_JOURNAL_APPOINTMENTS'],
  EDIT_JOURNAL: ['EDIT_JOURNAL', 'EDIT_APPOINTMENTS', 'MANAGE_APPOINTMENTS', 'ACCESS_JOURNAL'],
  EDIT_APPOINTMENTS: ['EDIT_APPOINTMENTS', 'EDIT_JOURNAL', 'MANAGE_APPOINTMENTS', 'ACCESS_JOURNAL'],
  CREATE_JOURNAL_APPOINTMENTS: [
    'CREATE_JOURNAL_APPOINTMENTS',
    'EDIT_JOURNAL',
    'EDIT_APPOINTMENTS',
    'MANAGE_APPOINTMENTS',
    'ACCESS_JOURNAL',
  ],
  VIEW_SCHEDULE: ['VIEW_SCHEDULE', 'EDIT_SCHEDULE', 'ACCESS_SCHEDULE'],
  EDIT_SCHEDULE: ['EDIT_SCHEDULE', 'ACCESS_SCHEDULE'],
  VIEW_CLIENTS: ['VIEW_CLIENTS', 'EDIT_CLIENTS', 'ACCESS_CLIENTS'],
  EDIT_CLIENTS: ['EDIT_CLIENTS', 'ACCESS_CLIENTS'],
  VIEW_CLIENT_PHONE: ['VIEW_CLIENT_PHONE', 'VIEW_CLIENTS', 'EDIT_CLIENTS', 'ACCESS_CLIENTS'],
  VIEW_SERVICES: ['VIEW_SERVICES', 'EDIT_SERVICES', 'EDIT_APPOINTMENTS', 'ACCESS_SERVICES'],
  EDIT_SERVICES: ['EDIT_SERVICES', 'ACCESS_SERVICES'],
  VIEW_STAFF: ['VIEW_STAFF', 'EDIT_STAFF', 'ACCESS_STAFF'],
  EDIT_STAFF: ['EDIT_STAFF', 'ACCESS_STAFF'],
  ACCESS_JOURNAL: ['ACCESS_JOURNAL', 'VIEW_JOURNAL', 'EDIT_JOURNAL'],
  ACCESS_SCHEDULE: ['ACCESS_SCHEDULE', 'VIEW_SCHEDULE', 'EDIT_SCHEDULE'],
  ACCESS_CLIENTS: ['ACCESS_CLIENTS', 'VIEW_CLIENTS', 'EDIT_CLIENTS'],
  ACCESS_SERVICES: ['ACCESS_SERVICES', 'VIEW_SERVICES', 'EDIT_SERVICES'],
  ACCESS_STAFF: ['ACCESS_STAFF', 'VIEW_STAFF', 'EDIT_STAFF'],
};

const resolvePermissionCandidates = (permissionCode: string): string[] => {
  return PERMISSION_EQUIVALENTS[permissionCode] ?? [permissionCode];
};

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

  if (!staff || !staff.isActive || staff.firedAt || staff.deletedAt) {
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

export const requireStaffRolesOrPermissions = (
  permissionCodes: string[],
  ...roles: StaffRole[]
) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth || req.auth.subjectType !== 'STAFF') {
      return next(unauthorized('Staff authentication required'));
    }
    if (req.auth.staffRole && roles.includes(req.auth.staffRole)) {
      return next();
    }
    if (permissionCodes.some((code) => hasPermission(req, code))) {
      return next();
    }
    return next(forbidden());
  };
};

export const hasPermission = (req: Request, permissionCode: string): boolean => {
  if (!req.auth || req.auth.subjectType !== 'STAFF') return false;
  if (req.auth.staffRole === 'OWNER') return true;
  const candidates = resolvePermissionCandidates(permissionCode);
  const permissions = req.auth.permissions ?? [];
  return candidates.some((code) => permissions.includes(code));
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
