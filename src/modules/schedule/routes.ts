import { Router } from 'express';
import dayjs from 'dayjs';
import { z } from 'zod';

import { prisma } from '../../db/prisma';
import {
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission,
} from '../../middlewares/auth';
import { validateBody, validateParams, validateQuery } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { badRequest, notFound } from '../../utils/errors';
import { ok } from '../../utils/response';
import { MSK_TZ, parseDateOnlyToUtc } from '../../utils/time';

const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const staffParamSchema = z.object({
  staffId: z.string().uuid()
});

const idParamSchema = z.object({
  id: z.string().uuid()
});

const rangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const workingHoursRangeQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const workingHoursSchema = z.object({
  items: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        startTime: z.string().regex(hhmmRegex),
        endTime: z.string().regex(hhmmRegex)
      })
    )
    .max(200)
});

const rangeCreateSchema = z.object({
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  reason: z.string().trim().max(500).optional()
});

const timeToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return h * 60 + m;
};

const readDailyIntervals = (
  value: unknown
): Array<{
  startTime: string;
  endTime: string;
}> => {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: Array<{
    startTime: string;
    endTime: string;
  }> = [];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }

    const record = raw as Record<string, unknown>;
    const startTime = typeof record.startTime === 'string' ? record.startTime : '';
    const endTime = typeof record.endTime === 'string' ? record.endTime : '';
    if (!hhmmRegex.test(startTime) || !hhmmRegex.test(endTime)) {
      continue;
    }
    if (timeToMinutes(endTime) <= timeToMinutes(startTime)) {
      continue;
    }
    items.push({ startTime, endTime });
  }

  items.sort((left, right) => timeToMinutes(left.startTime) - timeToMinutes(right.startTime));
  return items;
};

const assertStaffExists = async (staffId: string) => {
  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) {
    throw notFound('Staff not found');
  }
};

const assertRangeValid = (startAt: Date, endAt: Date) => {
  if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
    throw badRequest('Invalid datetime range');
  }
  if (endAt <= startAt) {
    throw badRequest('endAt must be greater than startAt');
  }
};

const validateWorkingHours = (items: Array<{ dayOfWeek: number; startTime: string; endTime: string }>) => {
  const byDay = new Map<number, Array<{ start: number; end: number }>>();

  for (const item of items) {
    const start = timeToMinutes(item.startTime);
    const end = timeToMinutes(item.endTime);
    if (end <= start) {
      throw badRequest('Working hours interval must have endTime > startTime', { item });
    }

    const ranges = byDay.get(item.dayOfWeek) ?? [];
    ranges.push({ start, end });
    byDay.set(item.dayOfWeek, ranges);
  }

  for (const [day, ranges] of byDay) {
    const sorted = ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const curr = sorted[i]!;
      if (curr.start < prev.end) {
        throw badRequest('Working hours intervals overlap', { dayOfWeek: day });
      }
    }
  }
};

export const scheduleRouter = Router();

scheduleRouter.get(
  '/staff/:staffId/working-hours',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('ACCESS_SCHEDULE', 'ADMIN', 'OWNER'),
  validateParams(staffParamSchema),
  validateQuery(workingHoursRangeQuerySchema),
  asyncHandler(async (req, res) => {
    const { staffId } = req.params as z.infer<typeof staffParamSchema>;
    const query = req.validatedQuery as z.infer<typeof workingHoursRangeQuerySchema>;
    await assertStaffExists(staffId);

    const weeklyItems = await prisma.workingHours.findMany({
      where: { staffId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }]
    });

    let items = weeklyItems.map((item) => ({
      id: item.id,
      dayOfWeek: item.dayOfWeek,
      startTime: item.startTime,
      endTime: item.endTime
    }));

    if (items.length === 0 && query.from && query.to) {
      const from = parseDateOnlyToUtc(query.from);
      const to = parseDateOnlyToUtc(query.to);
      if (to < from) {
        throw badRequest('to must be greater or equal to from');
      }
      const toExclusive = new Date(to.getTime() + 24 * 60 * 60 * 1000);

      const dailyRows = await prisma.staffDailySchedule.findMany({
        where: {
          staffId,
          date: {
            gte: from,
            lt: toExclusive
          }
        },
        orderBy: [{ date: 'asc' }]
      });

      items = dailyRows.flatMap((row) => {
        const intervals = readDailyIntervals(row.intervals);
        const dayOfWeek = dayjs(row.date).tz(MSK_TZ).day();
        return intervals.map((interval, index) => ({
          id: `${row.id}-${index}`,
          dayOfWeek,
          date: row.date.toISOString(),
          startTime: interval.startTime,
          endTime: interval.endTime
        }));
      });
    }

    return ok(res, {
      staffId,
      items
    });
  })
);

scheduleRouter.put(
  '/staff/:staffId/working-hours',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('ACCESS_SCHEDULE', 'ADMIN', 'OWNER'),
  validateParams(staffParamSchema),
  validateBody(workingHoursSchema),
  asyncHandler(async (req, res) => {
    const { staffId } = req.params as z.infer<typeof staffParamSchema>;
    const body = req.body as z.infer<typeof workingHoursSchema>;
    await assertStaffExists(staffId);

    validateWorkingHours(body.items);

    await prisma.$transaction(async (tx) => {
      await tx.workingHours.deleteMany({ where: { staffId } });
      if (body.items.length > 0) {
        await tx.workingHours.createMany({
          data: body.items.map((item) => ({
            staffId,
            dayOfWeek: item.dayOfWeek,
            startTime: item.startTime,
            endTime: item.endTime
          }))
        });
      }
    });

    const items = await prisma.workingHours.findMany({
      where: { staffId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }]
    });

    return ok(res, {
      staffId,
      items: items.map((item) => ({
        id: item.id,
        dayOfWeek: item.dayOfWeek,
        startTime: item.startTime,
        endTime: item.endTime
      }))
    });
  })
);

scheduleRouter.get(
  '/staff/:staffId/time-off',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('ACCESS_SCHEDULE', 'ADMIN', 'OWNER'),
  validateParams(staffParamSchema),
  validateQuery(rangeQuerySchema),
  asyncHandler(async (req, res) => {
    const { staffId } = req.params as z.infer<typeof staffParamSchema>;
    const { from, to } = req.validatedQuery as z.infer<typeof rangeQuerySchema>;
    await assertStaffExists(staffId);

    const where = {
      staffId,
      ...(from || to
        ? {
            AND: [
              ...(to ? [{ startAt: { lt: new Date(to) } }] : []),
              ...(from ? [{ endAt: { gt: new Date(from) } }] : [])
            ]
          }
        : {})
    };

    const items = await prisma.timeOff.findMany({
      where,
      orderBy: { startAt: 'asc' }
    });

    return ok(res, {
      staffId,
      items: items.map((item) => ({
        id: item.id,
        startAt: item.startAt.toISOString(),
        endAt: item.endAt.toISOString(),
        reason: item.reason
      }))
    });
  })
);

scheduleRouter.post(
  '/staff/:staffId/time-off',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('ACCESS_SCHEDULE', 'ADMIN', 'OWNER'),
  validateParams(staffParamSchema),
  validateBody(rangeCreateSchema),
  asyncHandler(async (req, res) => {
    const { staffId } = req.params as z.infer<typeof staffParamSchema>;
    const body = req.body as z.infer<typeof rangeCreateSchema>;
    await assertStaffExists(staffId);

    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);
    assertRangeValid(startAt, endAt);

    const created = await prisma.timeOff.create({
      data: {
        staffId,
        startAt,
        endAt,
        reason: body.reason?.trim() || null
      }
    });

    return ok(
      res,
      {
        item: {
          id: created.id,
          startAt: created.startAt.toISOString(),
          endAt: created.endAt.toISOString(),
          reason: created.reason
        }
      },
      201
    );
  })
);

scheduleRouter.delete(
  '/time-off/:id',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('ACCESS_SCHEDULE', 'ADMIN', 'OWNER'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    await prisma.timeOff.delete({ where: { id } });
    return ok(res, { deleted: true });
  })
);

scheduleRouter.get(
  '/staff/:staffId/blocks',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('ACCESS_SCHEDULE', 'ADMIN', 'OWNER'),
  validateParams(staffParamSchema),
  validateQuery(rangeQuerySchema),
  asyncHandler(async (req, res) => {
    const { staffId } = req.params as z.infer<typeof staffParamSchema>;
    const { from, to } = req.validatedQuery as z.infer<typeof rangeQuerySchema>;
    await assertStaffExists(staffId);

    const where = {
      staffId,
      ...(from || to
        ? {
            AND: [
              ...(to ? [{ startAt: { lt: new Date(to) } }] : []),
              ...(from ? [{ endAt: { gt: new Date(from) } }] : [])
            ]
          }
        : {})
    };

    const items = await prisma.block.findMany({
      where,
      orderBy: { startAt: 'asc' }
    });

    return ok(res, {
      staffId,
      items: items.map((item) => ({
        id: item.id,
        startAt: item.startAt.toISOString(),
        endAt: item.endAt.toISOString(),
        reason: item.reason
      }))
    });
  })
);

scheduleRouter.post(
  '/staff/:staffId/blocks',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('ACCESS_SCHEDULE', 'ADMIN', 'OWNER'),
  validateParams(staffParamSchema),
  validateBody(rangeCreateSchema),
  asyncHandler(async (req, res) => {
    const { staffId } = req.params as z.infer<typeof staffParamSchema>;
    const body = req.body as z.infer<typeof rangeCreateSchema>;
    await assertStaffExists(staffId);

    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);
    assertRangeValid(startAt, endAt);

    const created = await prisma.block.create({
      data: {
        staffId,
        startAt,
        endAt,
        reason: body.reason?.trim() || null
      }
    });

    return ok(
      res,
      {
        item: {
          id: created.id,
          startAt: created.startAt.toISOString(),
          endAt: created.endAt.toISOString(),
          reason: created.reason
        }
      },
      201
    );
  })
);

scheduleRouter.delete(
  '/blocks/:id',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('ACCESS_SCHEDULE', 'ADMIN', 'OWNER'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    await prisma.block.delete({ where: { id } });
    return ok(res, { deleted: true });
  })
);
