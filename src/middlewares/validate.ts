import type { NextFunction, Request, Response } from 'express';
import type { ZodSchema } from 'zod';
import { badRequest } from '../utils/errors';

export const validateBody = (schema: ZodSchema) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return next(
        badRequest('Validation failed', {
          issues: parsed.error.issues
        })
      );
    }
    req.body = parsed.data;
    next();
  };
};

export const validateQuery = (schema: ZodSchema) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
      return next(
        badRequest('Validation failed', {
          issues: parsed.error.issues
        })
      );
    }
    req.validatedQuery = parsed.data;
    next();
  };
};

export const validateParams = (schema: ZodSchema) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      return next(
        badRequest('Validation failed', {
          issues: parsed.error.issues
        })
      );
    }
    req.params = parsed.data as any;
    next();
  };
};
