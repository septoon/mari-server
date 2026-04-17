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
import { SLOT_STEP_MINUTES } from './service';

const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const staffParamSchema = z.object({
  staffId: z.string().uuid()
});

const idParamSchema = z.object({
  id: z.string().uuid()
});

const staffDateParamSchema = z.object({
  staffId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
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
        dayOfWeek: z.number().int().min(0).max(7),
        startTime: z.string().regex(hhmmRegex),
        endTime: z.string().regex(hhmmRegex),
        bookingStartTime: z.string().regex(hhmmRegex).optional(),
        bookingEndTime: z.string().regex(hhmmRegex).optional()
      })
    )
    .max(200)
});

const dailyScheduleSchema = z.object({
  items: z
    .array(
      z.object({
        startTime: z.string().regex(hhmmRegex),
        endTime: z.string().regex(hhmmRegex),
        bookingStartTime: z.string().regex(hhmmRegex).optional(),
        bookingEndTime: z.string().regex(hhmmRegex).optional(),
        bookingSlotTimes: z.array(z.string().regex(hhmmRegex)).max(288).optional()
      })
    )
    .max(50)
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

const normalizeBookingSlotTimes = (
  value: string[] | undefined,
  bookingStartTime: string,
  bookingEndTime: string
) => {
  if (!value) {
    return null;
  }

  const bookingStart = timeToMinutes(bookingStartTime);
  const bookingEnd = timeToMinutes(bookingEndTime);
  const allowedMinutes = new Set<number>();
  for (let cursor = bookingStart; cursor < bookingEnd; cursor += SLOT_STEP_MINUTES) {
    allowedMinutes.add(cursor);
  }
  const unique = new Set<string>();

  for (const raw of value) {
    const minutes = timeToMinutes(raw);
    if (minutes < bookingStart || minutes >= bookingEnd) {
      throw badRequest('Booking slot must be inside booking interval', {
        slot: raw,
        bookingStartTime,
        bookingEndTime
      });
    }
    if (!allowedMinutes.has(minutes)) {
      throw badRequest(`Booking slot must match ${SLOT_STEP_MINUTES}-minute step`, { slot: raw });
    }
    unique.add(raw);
  }

  return [...unique].sort((left, right) => timeToMinutes(left) - timeToMinutes(right));
};

const readDailyIntervals = (
  value: unknown
): Array<{
  startTime: string;
  endTime: string;
  bookingStartTime: string;
  bookingEndTime: string;
  bookingSlotTimes: string[] | null;
}> => {
  if (!Array.isArray(value)) {
    return [];
  }

  const items: Array<{
    startTime: string;
    endTime: string;
    bookingStartTime: string;
    bookingEndTime: string;
    bookingSlotTimes: string[] | null;
  }> = [];

  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }

    const record = raw as Record<string, unknown>;
    const startTime = typeof record.startTime === 'string' ? record.startTime : '';
    const endTime = typeof record.endTime === 'string' ? record.endTime : '';
    const bookingStartTime =
      typeof record.bookingStartTime === 'string' ? record.bookingStartTime : startTime;
    const bookingEndTime =
      typeof record.bookingEndTime === 'string' ? record.bookingEndTime : endTime;
    if (!hhmmRegex.test(startTime) || !hhmmRegex.test(endTime)) {
      continue;
    }
    if (
      timeToMinutes(endTime) <= timeToMinutes(startTime) ||
      !hhmmRegex.test(bookingStartTime) ||
      !hhmmRegex.test(bookingEndTime) ||
      timeToMinutes(bookingEndTime) <= timeToMinutes(bookingStartTime) ||
      timeToMinutes(bookingStartTime) < timeToMinutes(startTime) ||
      timeToMinutes(bookingEndTime) > timeToMinutes(endTime)
    ) {
      continue;
    }
    items.push({
      startTime,
      endTime,
      bookingStartTime,
      bookingEndTime,
      bookingSlotTimes: normalizeBookingSlotTimes(
        Array.isArray(record.bookingSlotTimes)
          ? record.bookingSlotTimes.filter((item): item is string => typeof item === 'string')
          : undefined,
        bookingStartTime,
        bookingEndTime
      )
    });
  }

  items.sort((left, right) => timeToMinutes(left.startTime) - timeToMinutes(right.startTime));
  return items;
};

const serializeIntervals = (
  items: Array<{
    startTime: string;
    endTime: string;
    bookingStartTime?: string;
    bookingEndTime?: string;
    bookingSlotTimes?: string[] | null;
  }>
) =>
  JSON.parse(JSON.stringify(items));

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

const validateWorkingHours = (
  items: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    bookingStartTime?: string;
    bookingEndTime?: string;
  }>
) => {
  const byDay = new Map<number, Array<{ start: number; end: number }>>();

  for (const item of items) {
    const start = timeToMinutes(item.startTime);
    const end = timeToMinutes(item.endTime);
    const bookingStart = timeToMinutes(item.bookingStartTime || item.startTime);
    const bookingEnd = timeToMinutes(item.bookingEndTime || item.endTime);
    if (end <= start) {
      throw badRequest('Working hours interval must have endTime > startTime', { item });
    }
    if (bookingEnd <= bookingStart) {
      throw badRequest('Booking interval must have bookingEndTime > bookingStartTime', { item });
    }
    if (bookingStart < start || bookingEnd > end) {
      throw badRequest('Booking interval must be inside working hours interval', { item });
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

const validateIntervals = (
  items: Array<{
    startTime: string;
    endTime: string;
    bookingStartTime?: string;
    bookingEndTime?: string;
    bookingSlotTimes?: string[] | null;
  }>
) => {
  validateWorkingHours(
    items.map((item) => ({
      dayOfWeek: 0,
      startTime: item.startTime,
      endTime: item.endTime,
      bookingStartTime: item.bookingStartTime,
      bookingEndTime: item.bookingEndTime
    }))
  );
};

const normalizeWorkingHoursItems = (
  items: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    bookingStartTime?: string;
    bookingEndTime?: string;
  }>
) =>
  items.map((item) => ({
    ...item,
    dayOfWeek: item.dayOfWeek === 7 ? 0 : item.dayOfWeek,
    bookingStartTime: item.bookingStartTime || item.startTime,
    bookingEndTime: item.bookingEndTime || item.endTime
  }));

const loadIntervalsForDate = async (staffId: string, date: string) => {
  const dailyRow = await prisma.staffDailySchedule.findUnique({
    where: {
      staffId_date: {
        staffId,
        date: parseDateOnlyToUtc(date)
      }
    }
  });

  if (dailyRow) {
    return readDailyIntervals(dailyRow.intervals);
  }

  const weekday = dayjs.tz(date, 'YYYY-MM-DD', MSK_TZ).day();
  const weeklyRows = await prisma.workingHours.findMany({
    where: { staffId, dayOfWeek: weekday },
    orderBy: { startTime: 'asc' }
  });

  return weeklyRows.map((item) => ({
    startTime: item.startTime,
    endTime: item.endTime,
    bookingStartTime: item.bookingStartTime || item.startTime,
    bookingEndTime: item.bookingEndTime || item.endTime,
    bookingSlotTimes: null
  }));
};

const expandScheduleItemsForRange = async (staffId: string, from: string, to: string) => {
  const fromDate = parseDateOnlyToUtc(from);
  const toDate = parseDateOnlyToUtc(to);
  if (toDate < fromDate) {
    throw badRequest('to must be greater or equal to from');
  }

  const toExclusive = new Date(toDate.getTime() + 24 * 60 * 60 * 1000);
  const [weeklyRows, dailyRows] = await Promise.all([
    prisma.workingHours.findMany({
      where: { staffId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }]
    }),
    prisma.staffDailySchedule.findMany({
      where: {
        staffId,
        date: {
          gte: fromDate,
          lt: toExclusive
        }
      },
      orderBy: [{ date: 'asc' }]
    })
  ]);

  const weeklyByDay = new Map<
    number,
    Array<{
      startTime: string;
      endTime: string;
      bookingStartTime: string;
      bookingEndTime: string;
      bookingSlotTimes: string[] | null;
    }>
  >();
  weeklyRows.forEach((item) => {
    const current = weeklyByDay.get(item.dayOfWeek) ?? [];
    current.push({
      startTime: item.startTime,
      endTime: item.endTime,
      bookingStartTime: item.bookingStartTime || item.startTime,
      bookingEndTime: item.bookingEndTime || item.endTime,
      bookingSlotTimes: null
    });
    weeklyByDay.set(item.dayOfWeek, current);
  });

  const dailyByDate = new Map<
    string,
    Array<{
      startTime: string;
      endTime: string;
      bookingStartTime: string;
      bookingEndTime: string;
      bookingSlotTimes: string[] | null;
    }>
  >();
  dailyRows.forEach((row) => {
    const dateKey = dayjs(row.date).tz(MSK_TZ).format('YYYY-MM-DD');
    dailyByDate.set(dateKey, readDailyIntervals(row.intervals));
  });

  const items: Array<{
    id: string;
    dayOfWeek: number;
    date: string;
    startTime: string;
    endTime: string;
    bookingStartTime: string;
    bookingEndTime: string;
    bookingSlotTimes?: string[] | null;
  }> = [];

  for (
    let cursor = dayjs.tz(from, 'YYYY-MM-DD', MSK_TZ);
    !cursor.isAfter(dayjs.tz(to, 'YYYY-MM-DD', MSK_TZ), 'day');
    cursor = cursor.add(1, 'day')
  ) {
    const dateKey = cursor.format('YYYY-MM-DD');
    const dayOfWeek = cursor.day();
    const intervals = dailyByDate.get(dateKey) ?? weeklyByDay.get(dayOfWeek) ?? [];
    intervals.forEach((interval, index) => {
      items.push({
        id: `${staffId}:${dateKey}:${index}`,
        dayOfWeek,
        date: dateKey,
        startTime: interval.startTime,
        endTime: interval.endTime,
        bookingStartTime: interval.bookingStartTime,
        bookingEndTime: interval.bookingEndTime,
        bookingSlotTimes: interval.bookingSlotTimes
      });
    });
  }

  return items;
};

export const scheduleRouter = Router();

scheduleRouter.get(
  '/staff/:staffId/working-hours',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('VIEW_SCHEDULE', 'OWNER'),
  validateParams(staffParamSchema),
  validateQuery(workingHoursRangeQuerySchema),
  asyncHandler(async (req, res) => {
    const { staffId } = req.params as z.infer<typeof staffParamSchema>;
    const query = req.validatedQuery as z.infer<typeof workingHoursRangeQuerySchema>;
    await assertStaffExists(staffId);

    if (query.from && query.to) {
      return ok(res, {
        staffId,
        items: await expandScheduleItemsForRange(staffId, query.from, query.to)
      });
    }

    const weeklyItems = await prisma.workingHours.findMany({
      where: { staffId },
      orderBy: [{ dayOfWeek: 'asc' }, { startTime: 'asc' }]
    });

    const items = weeklyItems.map((item) => ({
      id: item.id,
      dayOfWeek: item.dayOfWeek,
      startTime: item.startTime,
      endTime: item.endTime,
      bookingStartTime: item.bookingStartTime || item.startTime,
      bookingEndTime: item.bookingEndTime || item.endTime
    }));

    return ok(res, {
      staffId,
      items
    });
  })
);

scheduleRouter.get(
  '/staff/:staffId/daily-schedule/:date',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('VIEW_SCHEDULE', 'OWNER'),
  validateParams(staffDateParamSchema),
  asyncHandler(async (req, res) => {
    const { staffId, date } = req.params as z.infer<typeof staffDateParamSchema>;
    await assertStaffExists(staffId);

    return ok(res, {
      staffId,
      date,
      items: await loadIntervalsForDate(staffId, date)
    });
  })
);

scheduleRouter.put(
  '/staff/:staffId/daily-schedule/:date',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('EDIT_SCHEDULE', 'OWNER'),
  validateParams(staffDateParamSchema),
  validateBody(dailyScheduleSchema),
  asyncHandler(async (req, res) => {
    const { staffId, date } = req.params as z.infer<typeof staffDateParamSchema>;
    const body = req.body as z.infer<typeof dailyScheduleSchema>;
    await assertStaffExists(staffId);

    const normalizedItems = body.items.map((item) => ({
      ...item,
      bookingStartTime: item.bookingStartTime || item.startTime,
      bookingEndTime: item.bookingEndTime || item.endTime,
      bookingSlotTimes: normalizeBookingSlotTimes(
        item.bookingSlotTimes,
        item.bookingStartTime || item.startTime,
        item.bookingEndTime || item.endTime
      )
    }));

    validateIntervals(normalizedItems);

    const saved = await prisma.staffDailySchedule.upsert({
      where: {
        staffId_date: {
          staffId,
          date: parseDateOnlyToUtc(date)
        }
      },
      update: {
        intervals: serializeIntervals(normalizedItems)
      },
      create: {
        staffId,
        date: parseDateOnlyToUtc(date),
        intervals: serializeIntervals(normalizedItems)
      }
    });

    return ok(res, {
      staffId,
      date,
      id: saved.id,
      items: readDailyIntervals(saved.intervals)
    });
  })
);

scheduleRouter.put(
  '/staff/:staffId/working-hours',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('EDIT_SCHEDULE', 'OWNER'),
  validateParams(staffParamSchema),
  validateBody(workingHoursSchema),
  asyncHandler(async (req, res) => {
    const { staffId } = req.params as z.infer<typeof staffParamSchema>;
    const body = req.body as z.infer<typeof workingHoursSchema>;
    await assertStaffExists(staffId);

    const normalizedItems = normalizeWorkingHoursItems(body.items);

    validateWorkingHours(normalizedItems);

    await prisma.$transaction(async (tx) => {
      await tx.workingHours.deleteMany({ where: { staffId } });
      if (normalizedItems.length > 0) {
        await tx.workingHours.createMany({
          data: normalizedItems.map((item) => ({
            staffId,
            dayOfWeek: item.dayOfWeek,
            startTime: item.startTime,
            endTime: item.endTime,
            bookingStartTime: item.bookingStartTime || item.startTime,
            bookingEndTime: item.bookingEndTime || item.endTime
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
        endTime: item.endTime,
        bookingStartTime: item.bookingStartTime || item.startTime,
        bookingEndTime: item.bookingEndTime || item.endTime
      }))
    });
  })
);

scheduleRouter.get(
  '/staff/:staffId/time-off',
  authenticateRequired,
  requireStaff,
  requireStaffRolesOrPermission('VIEW_SCHEDULE', 'OWNER'),
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
  requireStaffRolesOrPermission('EDIT_SCHEDULE', 'OWNER'),
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
  requireStaffRolesOrPermission('EDIT_SCHEDULE', 'OWNER'),
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
  requireStaffRolesOrPermission('VIEW_SCHEDULE', 'OWNER'),
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
  requireStaffRolesOrPermission('EDIT_SCHEDULE', 'OWNER'),
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
  requireStaffRolesOrPermission('EDIT_SCHEDULE', 'OWNER'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    await prisma.block.delete({ where: { id } });
    return ok(res, { deleted: true });
  })
);
