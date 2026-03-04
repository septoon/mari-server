import { AppointmentStatus, Prisma } from '@prisma/client';
import dayjs from 'dayjs';

import { prisma } from '../../db/prisma';
import { mskDateToUtcByTime, mskDayBoundsUtc, MSK_TZ, parseDateOnlyToUtc } from '../../utils/time';

export const SLOT_STEP_MINUTES = 10;

type Range = {
  startAt: Date;
  endAt: Date;
};

type TimeInterval = {
  startTime: string;
  endTime: string;
};

const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean => {
  return aStart < bEnd && bStart < aEnd;
};

const timeToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return h * 60 + m;
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
    if (timeToMinutes(end) <= timeToMinutes(start)) continue;

    items.push({ startTime: start, endTime: end });
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

const loadDailyIntervals = async (staffId: string, date: string): Promise<TimeInterval[] | null> => {
  const daily = await prisma.staffDailySchedule.findUnique({
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

const loadWorkingHoursIntervals = async (staffId: string, date: string): Promise<TimeInterval[]> => {
  const weekday = dayjs.tz(date, 'YYYY-MM-DD', MSK_TZ).day();
  const hours = await prisma.workingHours.findMany({
    where: { staffId, dayOfWeek: weekday },
    orderBy: { startTime: 'asc' }
  });

  return hours.map((item) => ({
    startTime: item.startTime,
    endTime: item.endTime
  }));
};

const loadAvailabilityIntervals = async (staffId: string, date: string): Promise<TimeInterval[]> => {
  const daily = await loadDailyIntervals(staffId, date);
  if (daily) {
    return daily;
  }
  return loadWorkingHoursIntervals(staffId, date);
};

const buildBusyRanges = async (staffId: string, dayStart: Date, dayEnd: Date): Promise<Range[]> => {
  const [appointments, blocks, timeOff] = await Promise.all([
    prisma.appointment.findMany({
      where: {
        staffId,
        status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
        AND: [{ startAt: { lt: dayEnd } }, { endAt: { gt: dayStart } }]
      },
      select: { startAt: true, endAt: true }
    }),
    prisma.block.findMany({
      where: {
        staffId,
        AND: [{ startAt: { lt: dayEnd } }, { endAt: { gt: dayStart } }]
      },
      select: { startAt: true, endAt: true }
    }),
    prisma.timeOff.findMany({
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
  excludeAppointmentId?: string
): Promise<boolean> => {
  const busy = await Promise.all([
    prisma.appointment.count({
      where: {
        staffId,
        status: { notIn: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
        AND: [{ startAt: { lt: endAt } }, { endAt: { gt: startAt } }]
      }
    }),
    prisma.block.count({
      where: {
        staffId,
        AND: [{ startAt: { lt: endAt } }, { endAt: { gt: startAt } }]
      }
    }),
    prisma.timeOff.count({
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
  endAt: Date
): Promise<boolean> => {
  const intervals = await loadAvailabilityIntervals(staffId, date);

  if (intervals.length === 0) return false;

  return intervals.some((interval) => {
    const intervalStart = mskDateToUtcByTime(date, interval.startTime);
    const intervalEnd = mskDateToUtcByTime(date, interval.endTime);
    return startAt >= intervalStart && endAt <= intervalEnd;
  });
};

export const listSlotsForStaff = async (
  staffId: string,
  date: string,
  durationSec: number
): Promise<Array<{ startAt: Date; endAt: Date }>> => {
  const { start: dayStart, end: dayEnd } = mskDayBoundsUtc(date);

  const [intervals, busyRanges] = await Promise.all([
    loadAvailabilityIntervals(staffId, date),
    buildBusyRanges(staffId, dayStart, dayEnd)
  ]);

  if (intervals.length === 0) return [];

  const slots: Array<{ startAt: Date; endAt: Date }> = [];
  const stepMs = SLOT_STEP_MINUTES * 60 * 1000;
  const durationMs = durationSec * 1000;

  for (const interval of intervals) {
    const intervalStart = mskDateToUtcByTime(date, interval.startTime);
    const intervalEnd = mskDateToUtcByTime(date, interval.endTime);

    for (
      let cursorMs = intervalStart.getTime();
      cursorMs + durationMs <= intervalEnd.getTime();
      cursorMs += stepMs
    ) {
      const startAt = new Date(cursorMs);
      const endAt = new Date(cursorMs + durationMs);

      const blocked = busyRanges.some((range) => overlaps(startAt, endAt, range.startAt, range.endAt));
      if (!blocked) {
        slots.push({ startAt, endAt });
      }
    }
  }

  return slots;
};
