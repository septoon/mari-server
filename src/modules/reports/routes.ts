import dayjs from 'dayjs';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma';
import {
  authenticateRequired,
  canViewFinancial,
  requireStaff,
  requireStaffRolesOrPermission,
} from '../../middlewares/auth';
import { validateQuery } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { mskDayBoundsUtc, parseDateOnlyToUtc } from '../../utils/time';
import { ok } from '../../utils/response';
import { toNumber, zero } from '../../utils/money';

const overviewQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

export const reportsRouter = Router();

reportsRouter.get(
  '/overview',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('VIEW_FINANCIAL_STATS', 'ADMIN', 'OWNER'),
  validateQuery(overviewQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof overviewQuerySchema>;

    const from = parseDateOnlyToUtc(query.from);
    const toDayStart = parseDateOnlyToUtc(query.to);
    const toExclusive = dayjs(toDayStart).add(1, 'day').toDate();

    const baseWhere = {
      startAt: {
        gte: from,
        lt: toExclusive
      }
    };

    const [appointmentsCount, arrivedCount, noShowCount, cancelledCount, grouped] = await Promise.all([
      prisma.appointment.count({ where: baseWhere }),
      prisma.appointment.count({ where: { ...baseWhere, status: 'ARRIVED' } }),
      prisma.appointment.count({ where: { ...baseWhere, status: 'NO_SHOW' } }),
      prisma.appointment.count({ where: { ...baseWhere, status: 'CANCELLED' } }),
      prisma.appointment.groupBy({
        by: ['staffId'],
        where: baseWhere,
        _count: { _all: true }
      })
    ]);

    const staffIds = grouped.map((item) => item.staffId);
    const staff = staffIds.length
      ? await prisma.staff.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, name: true }
        })
      : [];
    const staffNameById = new Map(staff.map((s) => [s.id, s.name]));

    const data: Record<string, unknown> = {
      period: { from: query.from, to: query.to },
      appointmentsCount,
      arrivedCount,
      noShowCount,
      cancelledCount,
      byStaff: grouped.map((item) => ({
        staffId: item.staffId,
        staffName: staffNameById.get(item.staffId) ?? 'Unknown',
        appointmentsCount: item._count._all
      }))
    };

    if (canViewFinancial(req)) {
      const [revenueAgg, paidAgg, byMethod] = await Promise.all([
        prisma.appointment.aggregate({
          where: {
            ...baseWhere,
            status: 'ARRIVED'
          },
          _sum: { finalTotalPrice: true }
        }),
        prisma.appointment.aggregate({
          where: baseWhere,
          _sum: { paidAmount: true }
        }),
        prisma.payment.groupBy({
          by: ['method'],
          where: {
            appointment: {
              startAt: {
                gte: from,
                lt: toExclusive
              }
            }
          },
          _sum: { amount: true }
        })
      ]);

      const revenue = revenueAgg._sum.finalTotalPrice ?? zero();
      const paid = paidAgg._sum.paidAmount ?? zero();
      const debt = revenue.minus(paid).greaterThan(0) ? revenue.minus(paid) : zero();

      data.money = {
        revenue: toNumber(revenue),
        paid: toNumber(paid),
        debt: toNumber(debt),
        byMethod: byMethod.map((row) => ({
          method: row.method,
          sum: toNumber(row._sum.amount ?? zero())
        }))
      };
    }

    return ok(res, data);
  })
);
