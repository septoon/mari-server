import type { StaffRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      validatedQuery?: unknown;
      auth?: {
        subjectType: 'CLIENT' | 'STAFF';
        subjectId: string;
        sessionId?: string;
        staffRole?: StaffRole;
        permissions?: string[];
      };
    }
  }
}

export {};
