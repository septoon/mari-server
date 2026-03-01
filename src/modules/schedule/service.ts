import { AppointmentStatus } from '@prisma/client';
import dayjs from 'dayjs';

import { prisma } from '../../db/prisma';
import { mskDateToUtcByTime, mskDayBoundsUtc, MSK_TZ } from '../../utils/time';

export const SLOT_STEP_MINUTES = 10;

type Range = {
  startAt: Date;
  endAt: Date;
};

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean => {
  return aStart < bEnd && bStart < aEnd;
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
  const weekday = dayjs.tz(date, 'YYYY-MM-DD', MSK_TZ).day();
  const hours = await prisma.workingHours.findMany({
    where: { staffId, dayOfWeek: weekday }
  });

  if (hours.length === 0) return false;

  return hours.some((h) => {
    const intervalStart = mskDateToUtcByTime(date, h.startTime);
    const intervalEnd = mskDateToUtcByTime(date, h.endTime);
    return startAt >= intervalStart && endAt <= intervalEnd;
  });
};

export const listSlotsForStaff = async (
  staffId: string,
  date: string,
  durationSec: number
): Promise<Array<{ startAt: Date; endAt: Date }>> => {
  const weekday = dayjs.tz(date, 'YYYY-MM-DD', MSK_TZ).day();
  const { start: dayStart, end: dayEnd } = mskDayBoundsUtc(date);

  const [hours, busyRanges] = await Promise.all([
    prisma.workingHours.findMany({
      where: { staffId, dayOfWeek: weekday },
      orderBy: { startTime: 'asc' }
    }),
    buildBusyRanges(staffId, dayStart, dayEnd)
  ]);

  if (hours.length === 0) return [];

  const slots: Array<{ startAt: Date; endAt: Date }> = [];
  const stepMs = SLOT_STEP_MINUTES * 60 * 1000;
  const durationMs = durationSec * 1000;

  for (const h of hours) {
    const intervalStart = mskDateToUtcByTime(date, h.startTime);
    const intervalEnd = mskDateToUtcByTime(date, h.endTime);

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
