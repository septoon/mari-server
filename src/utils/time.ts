import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';

import { env } from '../config/env';
import { badRequest } from './errors';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export const MSK_TZ = env.TZ_DEFAULT;

export const parseDateOnlyToUtc = (dateOnly: string): Date => {
  const parsed = dayjs.tz(dateOnly, 'YYYY-MM-DD', MSK_TZ);
  if (!parsed.isValid()) {
    throw badRequest('Invalid date format, expected YYYY-MM-DD', { dateOnly });
  }
  return parsed.startOf('day').utc().toDate();
};

export const mskDayBoundsUtc = (dateOnly: string): { start: Date; end: Date } => {
  const start = parseDateOnlyToUtc(dateOnly);
  const end = dayjs(start).add(1, 'day').toDate();
  return { start, end };
};

export const todayStartMskUtc = (): Date => {
  return dayjs().tz(MSK_TZ).startOf('day').utc().toDate();
};

export const parseMskDateTime = (value: string): Date => {
  const parsed = dayjs.tz(value, MSK_TZ);
  if (!parsed.isValid()) {
    throw badRequest('Invalid datetime', { value });
  }
  return parsed.utc().toDate();
};

export const mskDateToUtcByTime = (dateOnly: string, hhmm: string): Date => {
  const parsed = dayjs.tz(`${dateOnly} ${hhmm}`, 'YYYY-MM-DD HH:mm', MSK_TZ);
  if (!parsed.isValid()) {
    throw badRequest('Invalid date/time value', { dateOnly, hhmm });
  }
  return parsed.utc().toDate();
};

export const toIso = (date: Date): string => dayjs(date).toISOString();

export const nowUtc = (): Date => new Date();
