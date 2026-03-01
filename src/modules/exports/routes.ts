import { Router } from 'express';
import { z } from 'zod';

import { authenticateRequired, requireStaff, requireStaffRoles } from '../../middlewares/auth';
import { validateQuery } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { ok } from '../../utils/response';
import { exportAppointmentsXlsx, exportClientsXlsx, exportServicesXlsx } from './service';

const appointmentsExportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

export const exportsRouter = Router();

const sendXlsx = (res: any, filename: string, buffer: Buffer) => {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
};

exportsRouter.get(
  '/clients.xlsx',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  asyncHandler(async (_req, res) => {
    const buffer = await exportClientsXlsx();
    sendXlsx(res, 'clients.xlsx', buffer);
  })
);

exportsRouter.get(
  '/services.xlsx',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  asyncHandler(async (_req, res) => {
    const buffer = await exportServicesXlsx();
    sendXlsx(res, 'services.xlsx', buffer);
  })
);

exportsRouter.get(
  '/appointments.xlsx',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateQuery(appointmentsExportQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof appointmentsExportQuerySchema>;
    const buffer = await exportAppointmentsXlsx(query.from, query.to);
    sendXlsx(res, 'appointments.xlsx', buffer);
  })
);
