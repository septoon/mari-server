import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError, ERROR_CODES } from '../utils/errors';
import { fail } from '../utils/response';

export const notFoundHandler = (_req: Request, res: Response) => {
  return fail(res, 404, ERROR_CODES.NOT_FOUND, 'Endpoint not found');
};

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): Response => {
  if (err instanceof AppError) {
    return fail(res, err.status, err.code, err.message, err.details);
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      return fail(res, 409, ERROR_CODES.CONFLICT, 'Unique constraint failed', err.meta);
    }
    if (err.code === 'P2025') {
      return fail(res, 404, ERROR_CODES.NOT_FOUND, 'Record not found');
    }
    return fail(res, 500, ERROR_CODES.INTERNAL_ERROR, 'Database error', { code: err.code });
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    return fail(res, 503, ERROR_CODES.DB_UNAVAILABLE, 'Database unavailable', {
      message: err.message
    });
  }

  console.error(err);
  return fail(res, 500, ERROR_CODES.INTERNAL_ERROR, 'Internal server error');
};
