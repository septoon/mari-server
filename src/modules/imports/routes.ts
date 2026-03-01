import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { authenticateRequired, requireStaff, requireStaffRoles } from '../../middlewares/auth';
import { validateParams } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { AppError, ERROR_CODES } from '../../utils/errors';
import { ok } from '../../utils/response';
import {
  getImportJobDetails,
  importAppointmentsFromBuffer,
  importClientsFromBuffer,
  importServicesFromBuffer
} from './service';

const upload = multer({ storage: multer.memoryStorage() });
const paramsSchema = z.object({ jobId: z.string().uuid() });

export const importsRouter = Router();

const ensureFile = (file?: Express.Multer.File): Buffer => {
  if (!file) {
    throw new AppError(400, ERROR_CODES.IMPORT_FORMAT_ERROR, 'file is required');
  }
  return file.buffer;
};

importsRouter.post(
  '/clients',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const buffer = ensureFile(req.file);
    const result = await importClientsFromBuffer(buffer, req.auth!.subjectId);
    return ok(res, {
      jobId: result.jobId,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors
    });
  })
);

importsRouter.post(
  '/services',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const buffer = ensureFile(req.file);
    const result = await importServicesFromBuffer(buffer, req.auth!.subjectId);
    return ok(res, {
      jobId: result.jobId,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors
    });
  })
);

importsRouter.post(
  '/appointments',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const buffer = ensureFile(req.file);
    const result = await importAppointmentsFromBuffer(buffer, req.auth!.subjectId);
    return ok(res, {
      jobId: result.jobId,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors
    });
  })
);

importsRouter.get(
  '/:jobId',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateParams(paramsSchema),
  asyncHandler(async (req, res) => {
    const { jobId } = req.params as z.infer<typeof paramsSchema>;
    const details = await getImportJobDetails(jobId);
    return ok(res, {
      job: details.job,
      errors: details.errors.map((row) => ({
        rowNumber: row.rowNumber,
        errorMessage: row.errorMessage,
        rawData: row.rawData
      }))
    });
  })
);
