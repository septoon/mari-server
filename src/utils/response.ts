import type { Response } from 'express';

export const ok = <T>(res: Response, data: T, status = 200, meta?: Record<string, unknown>) => {
  if (meta) {
    return res.status(status).json({ ok: true, data, meta });
  }
  return res.status(status).json({ ok: true, data });
};

export const fail = (
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: unknown
) => {
  return res.status(status).json({
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {})
    }
  });
};
