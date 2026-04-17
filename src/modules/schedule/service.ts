import { AppointmentStatus, Prisma } from '@prisma/client';
import dayjs from 'dayjs';

import { prisma } from '../../db/prisma';
import { mskDateToUtcByTime, mskDayBoundsUtc, MSK_TZ, parseDateOnlyToUtc } from '../../utils/time';

export const SLOT_STEP_MINUTES = 10;

type ScheduleDbClient = Pick<
  Prisma.TransactionClient,
  'staffDailySchedule' | 'workingHours' | 'appointment' | 'block' | 'timeOff'
>;

type Range = {
  startAt: Date;
  endAt: Date;
};

type TimeInterval = {
  startTime: string;
  endTime: string;
  bookingStartTime: string;
  bookingEndTime: string;
  bookingSlotTimes: string[] | null;
};

const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean => {
  return aStart < bEnd && bStart < aEnd;
};

const timeToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return h * 60 + m;
};

const normalizeBookingSlotTimes = (
  value: unknown,
  bookingStart: string,
  bookingEnd: string
): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const bookingStartMinutes = timeToMinutes(bookingStart);
  const bookingEndMinutes = timeToMinutes(bookingEnd);
  const allowedMinutes = new Set<number>();
  for (
    let cursor = bookingStartMinutes;
    cursor < bookingEndMinutes;
    cursor += SLOT_STEP_MINUTES
  ) {
    allowedMinutes.add(cursor);
  }
  const unique = new Set<string>();

  for (const raw of value) {
    if (typeof raw !== 'string' || !hhmmRegex.test(raw)) continue;
    const minutes = timeToMinutes(raw);
    if (minutes < bookingStartMinutes || minutes >= bookingEndMinutes) continue;
    if (!allowedMinutes.has(minutes)) continue;
    unique.add(raw);
  }

  return [...unique].sort((left, right) => timeToMinutes(left) - timeToMinutes(right));
};

const toIntervalsFromJson = (value: Prisma.JsonValue): TimeInterval[] => {
  if (!Array.isArray(value)) return [];

  const items: TimeInterval[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

    const start = (raw as Record<string, unknown>).startTime;
    const end = (raw as Record<string, unknown>).endTime;
    if (typeof start !== 'string' || typeof end !== 'string') continue;
    if (!hhmmRegex.test(start) || !hhmmRegex.test(end)) continue;
    const bookingStartRaw = (raw as Record<string, unknown>).bookingStartTime;
    const bookingEndRaw = (raw as Record<string, unknown>).bookingEndTime;
    const bookingStart = typeof bookingStartRaw === 'string' && hhmmRegex.test(bookingStartRaw) ? bookingStartRaw : start;
    const bookingEnd = typeof bookingEndRaw === 'string' && hhmmRegex.test(bookingEndRaw) ? bookingEndRaw : end;
    if (
      timeToMinutes(end) <= timeToMinutes(start) ||
      timeToMinutes(bookingEnd) <= timeToMinutes(bookingStart) ||
      timeToMinutes(bookingStart) < timeToMinutes(start) ||
      timeToMinutes(bookingEnd) > timeToMinutes(end)
    ) {
      continue;
    }

    items.push({
      startTime: start,
      endTime: end,
      bookingStartTime: bookingStart,
      bookingEndTime: bookingEnd,
      bookingSlotTimes: normalizeBookingSlotTimes(
        (raw as Record<string, unknown>).bookingSlotTimes,
        bookingStart,
        bookingEnd
      )
    });
  }

  items.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  const deduped: TimeInterval[] = [];
  for (const item of items) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.startTime === item.startTime && prev.endTime === item.endTime) {
      continue;
    }
    deduped.push(item);
  }
  return deduped;
};

const loadDailyIntervals = async (
  staffId: string,
  date: string,
  db: ScheduleDbClient = prisma
): Promise<TimeInterval[] | null> => {
  const daily = await db.staffDailySchedule.findUnique({
    where: {
      staffId_date: {
        staffId,
        date: parseDateOnlyToUtc(date)
      }
    },
    select: {
      intervals: true
    }
  });

  if (!daily) return null;
  return toIntervalsFromJson(daily.intervals);
};

const loadWorkingHoursIntervals = async (
  staffId: string,
  date: string,
  db: ScheduleDbClient = prisma
): Promise<TimeInterval[]> => {
  const weekday = dayjs.tz(date, 'YYYY-MM-DD', MSK_TZ).day();
  const hours = await db.workingHours.findMany({
    where: { staffId, dayOfWeek: weekday },
    orderBy: { startTime: 'asc' }
  });

  return hours.map((item) => ({
    startTime: item.startTime,
    endTime: item.endTime,
    bookingStartTime: item.bookingStartTime || item.startTime,
    bookingEndTime: item.bookingEndTime || item.endTime,
    bookingSlotTimes: null
  }));
};

const loadScheduleIntervals = async (
  staffId: string,
  date: string,
  db: ScheduleDbClient = prisma
): Promise<TimeInterval[]> => {
  const daily = await loadDailyIntervals(staffId, date, db);
  if (daily) {
    return daily;
  }
  return loadWorkingHoursIntervals(staffId, date, db);
};

const buildBusyRanges = async (
  staffId: string,
  dayStart: Date,
  dayEnd: Date,
  db: ScheduleDbClient = prisma
): Promise<Range[]> => {
  const [appointments, blocks, timeOff] = await Promise.all([
    db.appointment.findMany({
      where: {
        staffId,
        status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
        AND: [{ startAt: { lt: dayEnd } }, { endAt: { gt: dayStart } }]
      },
      select: { startAt: true, endAt: true }
    }),
    db.block.findMany({
      where: {
        staffId,
        AND: [{ startAt: { lt: dayEnd } }, { endAt: { gt: dayStart } }]
      },
      select: { startAt: true, endAt: true }
    }),
    db.timeOff.findMany({
      where: {
        staffId,
        AND: [{ startAt: { lt: dayEnd } }, { endAt: { gt: dayStart } }]
      },
      select: { startAt: true, endAt: true }
    })
  ]);

  return [...appointments, ...blocks, ...timeOff];
};

export const isStaffAvailable = async (
  staffId: string,
  startAt: Date,
  endAt: Date,
  excludeAppointmentId?: string,
  db: ScheduleDbClient = prisma
): Promise<boolean> => {
  const busy = await Promise.all([
    db.appointment.count({
      where: {
        staffId,
        status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        AND: [{ startAt: { lt: endAt } }, { endAt: { gt: startAt } }]
      }
    }),
    db.block.count({
      where: {
        staffId,
        AND: [{ startAt: { lt: endAt } }, { endAt: { gt: startAt } }]
      }
    }),
    db.timeOff.count({
      where: {
        staffId,
        AND: [{ startAt: { lt: endAt } }, { endAt: { gt: startAt } }]
      }
    })
  ]);

  return busy.every((count) => count === 0);
};

export const fitsWorkingHours = async (
  staffId: string,
  date: string,
  startAt: Date,
  endAt: Date,
  db: ScheduleDbClient = prisma
): Promise<boolean> => {
  const intervals = await loadScheduleIntervals(staffId, date, db);

  if (intervals.length === 0) return false;

  return intervals.some((interval) => {
    const intervalStart = mskDateToUtcByTime(date, interval.startTime);
    const intervalEnd = mskDateToUtcByTime(date, interval.endTime);
    return startAt >= intervalStart && endAt <= intervalEnd;
  });
};

export const fitsBookingHours = async (
  staffId: string,
  date: string,
  startAt: Date,
  endAt: Date,
  db: ScheduleDbClient = prisma
): Promise<boolean> => {
  const intervals = await loadScheduleIntervals(staffId, date, db);

  if (intervals.length === 0) return false;

  return intervals.some((interval) => {
    const intervalStart = mskDateToUtcByTime(date, interval.bookingStartTime);
    const intervalEnd = mskDateToUtcByTime(date, interval.bookingEndTime);
    if (!(startAt >= intervalStart && endAt <= intervalEnd)) {
      return false;
    }

    if (interval.bookingSlotTimes !== null) {
      const startTime = dayjs(startAt).tz(MSK_TZ).format('HH:mm');
      return interval.bookingSlotTimes.includes(startTime);
    }

    return true;
  });
};

export const listSlotsForStaff = async (
  staffId: string,
  date: string,
  durationSec: number,
  db: ScheduleDbClient = prisma
): Promise<Array<{ startAt: Date; endAt: Date }>> => {
  const { start: dayStart, end: dayEnd } = mskDayBoundsUtc(date);
  const now = new Date();

  const [intervals, busyRanges] = await Promise.all([
    loadScheduleIntervals(staffId, date, db),
    buildBusyRanges(staffId, dayStart, dayEnd, db)
  ]);

  if (intervals.length === 0) return [];

  const slots: Array<{ startAt: Date; endAt: Date }> = [];
  const stepMs = SLOT_STEP_MINUTES * 60 * 1000;
  const durationMs = durationSec * 1000;

  for (const interval of intervals) {
    const intervalStart = mskDateToUtcByTime(date, interval.bookingStartTime);
    const intervalEnd = mskDateToUtcByTime(date, interval.bookingEndTime);
    const allowedSlotTimes =
      interval.bookingSlotTimes === null ? null : new Set(interval.bookingSlotTimes);

    for (
      let cursorMs = intervalStart.getTime();
      cursorMs + durationMs <= intervalEnd.getTime();
      cursorMs += stepMs
    ) {
      const startAt = new Date(cursorMs);
      const endAt = new Date(cursorMs + durationMs);

      if (startAt <= now) {
        continue;
      }

      const startTime = dayjs(startAt).tz(MSK_TZ).format('HH:mm');
      if (allowedSlotTimes && !allowedSlotTimes.has(startTime)) {
        continue;
      }

      const blocked = busyRanges.some((range) => overlaps(startAt, endAt, range.startAt, range.endAt));
      if (!blocked) {
        slots.push({ startAt, endAt });
      }
    }
  }

  return slots;
};
