export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT_TIME_SLOT: 'CONFLICT_TIME_SLOT',
  STAFF_HAS_FUTURE_APPOINTMENTS: 'STAFF_HAS_FUTURE_APPOINTMENTS',
  IMPORT_FORMAT_ERROR: 'IMPORT_FORMAT_ERROR',
  IMPORT_ROW_ERROR: 'IMPORT_ROW_ERROR',
  CONFLICT: 'CONFLICT',
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const;

export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, ERROR_CODES.VALIDATION_ERROR, message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, ERROR_CODES.AUTH_REQUIRED, message);
export const forbidden = (message = 'Forbidden') => new AppError(403, ERROR_CODES.FORBIDDEN, message);
export const notFound = (message = 'Not found') => new AppError(404, ERROR_CODES.NOT_FOUND, message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, ERROR_CODES.CONFLICT, message, details);
export const conflictSlot = (message: string, details?: unknown) =>
  new AppError(409, ERROR_CODES.CONFLICT_TIME_SLOT, message, details);
export const businessRule = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
