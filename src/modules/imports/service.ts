import {
  ActorType,
  AppointmentStatus,
  DiscountType,
  Gender,
  PaymentMethod,
  PaymentStatus,
  Prisma
} from '@prisma/client';
import dayjs from 'dayjs';
import pdfParse from 'pdf-parse';
import * as XLSX from 'xlsx';

import { prisma } from '../../db/prisma';
import { sha1 } from '../../utils/crypto';
import { badRequest } from '../../utils/errors';
import { normalizePhone10 } from '../../utils/phone';
import { upsertClientByPhone } from '../clients/service';
import { findOrCreateStaffByName } from '../staff/routes';
import { D, zero } from '../../utils/money';
import { MSK_TZ, parseDateOnlyToUtc } from '../../utils/time';
import { findDefaultServiceSectionByCategoryName } from '../services/sections';

type ImportType = 'CLIENTS' | 'SERVICES' | 'APPOINTMENTS' | 'SCHEDULE';

type Counters = {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
};

type ImportResult = {
  jobId: string;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
};

type DailyInterval = {
  startTime: string;
  endTime: string;
};

const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

const ruMonthToNumber: Record<string, string> = {
  января: '01',
  февраля: '02',
  марта: '03',
  апреля: '04',
  мая: '05',
  июня: '06',
  июля: '07',
  августа: '08',
  сентября: '09',
  октября: '10',
  ноября: '11',
  декабря: '12'
};

const norm = (value: string): string =>
  value
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^a-zа-яё0-9%]/gi, '');

const valueByAlias = (row: Record<string, unknown>, aliases: string[]): unknown => {
  for (const alias of aliases) {
    if (alias in row && row[alias] != null && row[alias] !== '') {
      return row[alias];
    }
    const found = Object.entries(row).find(([key]) => norm(key) === norm(alias));
    if (found && found[1] != null && found[1] !== '') {
      return found[1];
    }
  }
  return null;
};

const toStr = (value: unknown): string | null => {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
};

const parseDecimal = (value: unknown): Prisma.Decimal | null => {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return D(value);

  const prepared = String(value).replace(/\s/g, '').replace(',', '.').replace(/[₽]/g, '');
  if (!prepared) return null;
  const num = Number(prepared);
  if (Number.isNaN(num)) return null;
  return D(num);
};

const parseIntValue = (value: unknown): number | null => {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Math.round(value);
  const num = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (Number.isNaN(num)) return null;
  return Math.round(num);
};

const toDatePartsFromExcelSerial = (serial: number): string | null => {
  const parsed = XLSX.SSF.parse_date_code(serial);
  if (!parsed) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${parsed.y}-${pad(parsed.m)}-${pad(parsed.d)} ${pad(parsed.H || 0)}:${pad(parsed.M || 0)}:${pad(parsed.S || 0)}`;
};

const parseMskByFormats = (text: string, formats: string[]): dayjs.Dayjs | null => {
  for (const format of formats) {
    const parsed = dayjs.tz(text, format, MSK_TZ);
    if (parsed.isValid()) {
      return parsed;
    }
  }
  return null;
};

const parseExcelDateOnly = (value: unknown): Date | null => {
  if (value == null || value === '') return null;

  if (typeof value === 'number') {
    const parts = toDatePartsFromExcelSerial(value);
    if (!parts) return null;
    const parsed = dayjs.tz(parts.slice(0, 10), 'YYYY-MM-DD', MSK_TZ);
    return parsed.isValid() ? parsed.startOf('day').utc().toDate() : null;
  }

  if (value instanceof Date) {
    return dayjs(value).utc().startOf('day').toDate();
  }

  const text = String(value).trim();
  const parsed = parseMskByFormats(text, ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY']);
  if (!parsed) return null;
  return parsed.startOf('day').utc().toDate();
};

const parseExcelDateTimeMsk = (value: unknown): Date | null => {
  if (value == null || value === '') return null;

  if (typeof value === 'number') {
    const parts = toDatePartsFromExcelSerial(value);
    if (!parts) return null;
    const parsed = dayjs.tz(parts, 'YYYY-MM-DD HH:mm:ss', MSK_TZ);
    return parsed.isValid() ? parsed.utc().toDate() : null;
  }

  if (value instanceof Date) {
    return dayjs(value).tz(MSK_TZ).utc().toDate();
  }

  const text = String(value).trim();
  const parsed = parseMskByFormats(text, [
    'YYYY-MM-DDTHH:mm:ss',
    'YYYY-MM-DD HH:mm:ss',
    'YYYY-MM-DD HH:mm',
    'DD.MM.YYYY HH:mm',
    'DD.MM.YYYY HH:mm:ss',
    'DD/MM/YYYY HH:mm'
  ]);
  if (!parsed) return null;
  return parsed.utc().toDate();
};

const readRows = (buffer: Buffer): Record<string, unknown>[] => {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw badRequest('Excel file has no sheets');
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw badRequest('Excel sheet is not available');
  }

  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: true
  });
};

const timeToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map((v) => Number(v));
  return h * 60 + m;
};

const normalizeRu = (value: string): string => value.trim().toLowerCase().replaceAll('ё', 'е');

const parseScheduleDate = (line: string): { dateOnly: string; tail: string } | null => {
  const match = line.match(/^(\d{1,2})\s+([а-яА-ЯёЁ]+)\s+(\d{4})(?:\s+(.*))?$/);
  if (!match) return null;

  const day = Number(match[1]);
  const monthName = normalizeRu(match[2] ?? '');
  const year = Number(match[3]);
  const tail = (match[4] ?? '').trim();

  const month = ruMonthToNumber[monthName];
  if (!month || Number.isNaN(day) || Number.isNaN(year) || day < 1 || day > 31) return null;

  const dateOnly = `${String(year).padStart(4, '0')}-${month}-${String(day).padStart(2, '0')}`;
  return { dateOnly, tail };
};

const extractTimeRanges = (line: string): DailyInterval[] => {
  const ranges: DailyInterval[] = [];
  const regex = /([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)/g;

  for (const match of line.matchAll(regex)) {
    const start = `${match[1]}:${match[2]}`;
    const end = `${match[3]}:${match[4]}`;
    if (!hhmmRegex.test(start) || !hhmmRegex.test(end)) continue;
    if (timeToMinutes(end) <= timeToMinutes(start)) continue;
    ranges.push({ startTime: start, endTime: end });
  }

  return ranges;
};

const assertIntervalsValid = (intervals: DailyInterval[], context: { staffName: string; dateOnly: string }) => {
  const sorted = [...intervals].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const curr = sorted[i]!;
    if (timeToMinutes(curr.startTime) < timeToMinutes(prev.endTime)) {
      throw badRequest('Overlapping schedule intervals in PDF', context);
    }
  }
};

const extractScheduleTextFromPdf = async (buffer: Buffer): Promise<string> => {
  try {
    const parsed = await pdfParse(buffer);
    const text = parsed.text?.trim();
    if (!text) {
      throw badRequest('PDF has no extractable text');
    }
    return text;
  } catch (error) {
    if ((error as Error).message?.includes('PDF has no extractable text')) {
      throw error;
    }
    throw badRequest('Failed to parse PDF schedule', { reason: (error as Error).message });
  }
};

const parseSchedulePdfText = (text: string): Map<string, Map<string, DailyInterval[]>> => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const result = new Map<string, Map<string, DailyInterval[]>>();
  let currentStaff: string | null = null;
  let currentDate: string | null = null;

  for (const line of lines) {
    const lower = normalizeRu(line);
    if (lower.includes('график работы персонала')) continue;

    const dateParsed = parseScheduleDate(line);
    if (dateParsed) {
      if (!currentStaff) continue;
      const staffDays = result.get(currentStaff) ?? new Map<string, DailyInterval[]>();
      const existing = staffDays.get(dateParsed.dateOnly) ?? [];
      const ranges = extractTimeRanges(dateParsed.tail);
      staffDays.set(dateParsed.dateOnly, [...existing, ...ranges]);
      result.set(currentStaff, staffDays);
      currentDate = dateParsed.dateOnly;
      continue;
    }

    const staffMatch = line.match(/^(.+?)\.\s+.+$/);
    if (staffMatch && !/^\d{1,2}\s/.test(line)) {
      const staffName = (staffMatch[1] ?? '').trim();
      if (!staffName) continue;
      currentStaff = staffName;
      currentDate = null;
      if (!result.has(staffName)) {
        result.set(staffName, new Map<string, DailyInterval[]>());
      }
      continue;
    }

    const ranges = extractTimeRanges(line);
    if (ranges.length > 0 && currentStaff && currentDate) {
      const staffDays = result.get(currentStaff)!;
      const existing = staffDays.get(currentDate) ?? [];
      staffDays.set(currentDate, [...existing, ...ranges]);
      continue;
    }
  }

  if (result.size === 0) {
    throw badRequest('No schedule data detected in PDF');
  }

  for (const [staffName, days] of result) {
    for (const [dateOnly, intervals] of days) {
      assertIntervalsValid(intervals, { staffName, dateOnly });
    }
  }

  return result;
};

const initJob = async (type: ImportType, uploadedByStaffId: string) => {
  return prisma.importJob.create({
    data: {
      type,
      uploadedByStaffId,
      status: 'RUNNING'
    }
  });
};

const finishJob = async (jobId: string, counters: Counters, status: 'DONE' | 'FAILED' = 'DONE') => {
  await prisma.importJob.update({
    where: { id: jobId },
    data: {
      createdCount: counters.created,
      updatedCount: counters.updated,
      skippedCount: counters.skipped,
      errorCount: counters.errors,
      status,
      finishedAt: new Date()
    }
  });
};

const addJobError = async (
  jobId: string,
  rowNumber: number,
  rawData: Record<string, unknown>,
  errorMessage: string
) => {
  await prisma.importJobErrorRow.create({
    data: {
      importJobId: jobId,
      rowNumber,
      rawData: JSON.parse(JSON.stringify(rawData)) as Prisma.InputJsonValue,
      errorMessage
    }
  });
};

const parseClientDiscount = (
  raw: unknown
): { discountType: DiscountType; discountValue: Prisma.Decimal | null } => {
  const text = toStr(raw);
  if (!text) {
    return { discountType: DiscountType.NONE, discountValue: null };
  }

  if (text.includes('%')) {
    const value = parseDecimal(text.replace('%', ''));
    if (!value || value.equals(0)) return { discountType: DiscountType.NONE, discountValue: null };
    return { discountType: DiscountType.PERCENT, discountValue: value };
  }

  const value = parseDecimal(text);
  if (!value || value.equals(0)) {
    return { discountType: DiscountType.NONE, discountValue: null };
  }
  return { discountType: DiscountType.FIXED, discountValue: value };
};

const mapGender = (raw: unknown): Gender => {
  const value = toStr(raw)?.toLowerCase();
  if (!value) return Gender.UNKNOWN;
  if (value === 'ж' || value === 'f' || value === 'female') return Gender.FEMALE;
  if (value === 'м' || value === 'm' || value === 'male') return Gender.MALE;
  return Gender.UNKNOWN;
};

export const importScheduleFromBuffer = async (
  buffer: Buffer,
  uploadedByStaffId: string
): Promise<ImportResult> => {
  const job = await initJob('SCHEDULE', uploadedByStaffId);
  const counters: Counters = { created: 0, updated: 0, skipped: 0, errors: 0 };

  try {
    const text = await extractScheduleTextFromPdf(buffer);
    const parsedByStaff = parseSchedulePdfText(text);

    for (const [staffName, dailyEntries] of parsedByStaff) {
      try {
        const staff = await findOrCreateStaffByName(staffName);
        const days = Array.from(dailyEntries.entries()).sort((a, b) => a[0].localeCompare(b[0]));

        if (days.length === 0) {
          counters.skipped += 1;
          continue;
        }

        const minDate = parseDateOnlyToUtc(days[0]![0]);
        const maxDateExclusive = dayjs(parseDateOnlyToUtc(days[days.length - 1]![0])).add(1, 'day').toDate();

        await prisma.$transaction(async (tx) => {
          await tx.staffDailySchedule.deleteMany({
            where: {
              staffId: staff.id,
              date: {
                gte: minDate,
                lt: maxDateExclusive
              }
            }
          });

          await tx.staffDailySchedule.createMany({
            data: days.map(([dateOnly, intervals]) => ({
              staffId: staff.id,
              date: parseDateOnlyToUtc(dateOnly),
              intervals: JSON.parse(JSON.stringify(intervals)) as Prisma.InputJsonValue
            }))
          });
        });

        counters.created += days.length;
      } catch (error) {
        counters.errors += 1;
        await addJobError(job.id, 0, { staffName }, (error as Error).message);
      }
    }

    await finishJob(job.id, counters, 'DONE');
    return { jobId: job.id, ...counters };
  } catch (error) {
    await finishJob(job.id, counters, 'FAILED');
    throw error;
  }
};

export const importClientsFromBuffer = async (
  buffer: Buffer,
  uploadedByStaffId: string
): Promise<ImportResult> => {
  const job = await initJob('CLIENTS', uploadedByStaffId);
  const counters: Counters = { created: 0, updated: 0, skipped: 0, errors: 0 };

  try {
    const rows = readRows(buffer);

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const rowNumber = i + 2;

      try {
        const phoneRaw = valueByAlias(row, ['Телефон']);
        const name = toStr(valueByAlias(row, ['Имя']));
        if (name?.toLowerCase() === 'имя' || String(phoneRaw ?? '').toLowerCase() === 'телефон') {
          counters.skipped += 1;
          continue;
        }

        if (phoneRaw == null || String(phoneRaw).trim() === '') {
          counters.skipped += 1;
          continue;
        }

        const phone10 = normalizePhone10(String(phoneRaw));
        const existedBefore = await prisma.client.findUnique({ where: { phone10 } });
        const client = await upsertClientByPhone(phone10, name ?? undefined);

        const categoryName = toStr(valueByAlias(row, ['Категории']));
        const comment = toStr(valueByAlias(row, ['Комментарий']));
        const birthday = parseExcelDateOnly(valueByAlias(row, ['Дата рождения']));
        const gender = mapGender(valueByAlias(row, ['Пол']));
        const discount = parseClientDiscount(valueByAlias(row, ['Скидка']));

        let categoryId: string | null = null;
        if (categoryName) {
          const category = await prisma.clientCategory.upsert({
            where: { name: categoryName },
            update: {},
            create: { name: categoryName }
          });
          categoryId = category.id;
        }

        const existing = await prisma.client.findUnique({ where: { id: client.id } });
        if (!existing) {
          counters.skipped += 1;
          continue;
        }

        const updated = await prisma.client.update({
          where: { id: existing.id },
          data: {
            name:
              !existing.name || (name && name.length > existing.name.length)
                ? name ?? existing.name
                : existing.name,
            categoryId: categoryId ?? existing.categoryId,
            comment: comment || existing.comment,
            birthday: existing.birthday ?? birthday,
            gender: existing.gender === Gender.UNKNOWN ? gender : existing.gender,
            discountType:
              discount.discountType !== DiscountType.NONE ? discount.discountType : existing.discountType,
            discountValue: discount.discountValue ?? existing.discountValue
          }
        });

        if (existedBefore) {
          counters.updated += 1;
        } else {
          counters.created += 1;
        }
      } catch (error) {
        const message = (error as Error).message;
        const staffCell = toStr(valueByAlias(row, ['Сотрудник', 'Имя']));
        const phoneCell = toStr(valueByAlias(row, ['Телефон', '__EMPTY_1']));
        const serviceCell = toStr(valueByAlias(row, ['Название', '__EMPTY_6']));
        const isTechnicalHeader =
          (staffCell ?? '').toLowerCase().includes('имя') &&
          ((phoneCell ?? '').toLowerCase().includes('телефон') ||
            (serviceCell ?? '').toLowerCase().includes('назван'));

        if (isTechnicalHeader) {
          counters.skipped += 1;
          continue;
        }

        counters.errors += 1;
        await addJobError(job.id, rowNumber, row, message);
      }
    }

    await finishJob(job.id, counters, 'DONE');
    return { jobId: job.id, ...counters };
  } catch (error) {
    await finishJob(job.id, counters, 'FAILED');
    throw error;
  }
};

export const importServicesFromBuffer = async (
  buffer: Buffer,
  uploadedByStaffId: string,
  options?: { createOnly?: boolean }
): Promise<ImportResult> => {
  const job = await initJob('SERVICES', uploadedByStaffId);
  const counters: Counters = { created: 0, updated: 0, skipped: 0, errors: 0 };

  try {
    const rows = readRows(buffer);

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const rowNumber = i + 2;

      try {
        const categoryName = toStr(valueByAlias(row, ['Категория']));
        const externalIdRaw = toStr(valueByAlias(row, ['ID']));
        const name = toStr(valueByAlias(row, ['Название']));
        const nameReceipt = toStr(valueByAlias(row, ['Название в чеке']));
        const nameOnline = toStr(valueByAlias(row, ['Название для онлайн-записи']));
        const description = toStr(valueByAlias(row, ['Описание']));
        const durationSec = parseIntValue(valueByAlias(row, ['Длительность']));
        const priceMin = parseDecimal(valueByAlias(row, ['Цена от']));
        const priceMaxRaw = parseDecimal(valueByAlias(row, ['Цена до']));

        if (!categoryName || !name || !durationSec || !priceMin) {
          counters.skipped += 1;
          continue;
        }

        const defaultSection = findDefaultServiceSectionByCategoryName(categoryName);
        if (defaultSection) {
          await prisma.serviceSection.upsert({
            where: { id: defaultSection.id },
            update: {
              name: defaultSection.name,
              orderIndex: defaultSection.orderIndex
            },
            create: {
              id: defaultSection.id,
              name: defaultSection.name,
              orderIndex: defaultSection.orderIndex
            }
          });
        }

        const category = await prisma.serviceCategory.upsert({
          where: { name: categoryName },
          update: {},
          create: {
            name: categoryName,
            sectionId: defaultSection?.id ?? null
          }
        });

        const externalId = externalIdRaw ? String(externalIdRaw) : null;
        let existing =
          (externalId
            ? await prisma.service.findFirst({ where: { externalId } })
            : await prisma.service.findFirst({
                where: {
                  categoryId: category.id,
                  OR: [
                    ...(nameOnline ? [{ nameOnline }] : []),
                    { name }
                  ]
                }
              })) ?? null;

        const payload = {
          externalId,
          categoryId: category.id,
          name,
          nameReceipt,
          nameOnline,
          description,
          durationSec,
          priceMin,
          priceMax: priceMaxRaw ?? priceMin,
          isActive: true
        };

        if (existing) {
          if (options?.createOnly) {
            counters.skipped += 1;
          } else {
            await prisma.service.update({ where: { id: existing.id }, data: payload });
            counters.updated += 1;
          }
        } else {
          existing = await prisma.service.create({ data: payload });
          counters.created += 1;
        }
      } catch (error) {
        counters.errors += 1;
        await addJobError(job.id, rowNumber, row, (error as Error).message);
      }
    }

    await finishJob(job.id, counters, 'DONE');
    return { jobId: job.id, ...counters };
  } catch (error) {
    await finishJob(job.id, counters, 'FAILED');
    throw error;
  }
};

type ImportedAppointmentRow = {
  rowNumber: number;
  raw: Record<string, unknown>;
  specialization: string | null;
  statusRaw: string | null;
  paidRaw: string | null;
  createdAtRaw: Date | null;
  creatorName: string | null;
  visitAt: Date;
  staffName: string;
  clientName: string | null;
  clientPhone: string;
};

type ImportedServiceRow = {
  serviceName: string;
  price: Prisma.Decimal;
  priceWithDiscount: Prisma.Decimal;
};

type ImportedAppointmentGroup = {
  appointment: ImportedAppointmentRow;
  services: ImportedServiceRow[];
};

type AppointmentImportContext = {
  staffName: string | null;
  specialization: string | null;
  clientName: string | null;
  phoneRaw: unknown;
  visitRaw: unknown;
  createdAtRawValue: unknown;
  statusRaw: string | null;
  paidRaw: string | null;
  creatorName: string | null;
};

const mapAppointmentStatus = (raw: string | null): AppointmentStatus => {
  const status = (raw ?? '').trim().toLowerCase();
  if (status.includes('подтверд')) return AppointmentStatus.CONFIRMED;
  if (status.includes('пришел') || status.includes('пришёл')) return AppointmentStatus.ARRIVED;
  if (status.includes('не приш')) return AppointmentStatus.NO_SHOW;
  if (status.includes('отмен')) return AppointmentStatus.CANCELLED;
  if (status.includes('ожид')) return AppointmentStatus.PENDING;
  return AppointmentStatus.PENDING;
};

const mapPaidFully = (raw: string | null): boolean => {
  const value = (raw ?? '').trim().toLowerCase();
  return ['да', 'yes', 'true', '1'].includes(value);
};

const findServiceByName = async (name: string) => {
  const normalized = name.trim();
  if (!normalized) return null;

  const byExact = await prisma.service.findFirst({
    where: {
      OR: [{ name: normalized }, { nameOnline: normalized }, { nameReceipt: normalized }]
    }
  });
  if (byExact) return byExact;

  return prisma.service.findFirst({
    where: {
      OR: [
        { name: { contains: normalized, mode: 'insensitive' } },
        { nameOnline: { contains: normalized, mode: 'insensitive' } },
        { nameReceipt: { contains: normalized, mode: 'insensitive' } }
      ]
    }
  });
};

const groupKeyForAppointment = (
  staffName: string,
  phone10: string,
  visitAt: Date,
  createdAt?: Date | null
): string => {
  return [staffName, phone10, visitAt.toISOString(), createdAt?.toISOString() ?? ''].join('|');
};

const buildImportedExternalId = (
  staffName: string,
  phone10: string,
  visitAt: Date,
  createdAt?: Date | null
): string => {
  return sha1([staffName, phone10, visitAt.toISOString(), createdAt?.toISOString() ?? ''].join('|'));
};

export const importAppointmentsFromBuffer = async (
  buffer: Buffer,
  uploadedByStaffId: string
): Promise<ImportResult> => {
  const job = await initJob('APPOINTMENTS', uploadedByStaffId);
  const counters: Counters = { created: 0, updated: 0, skipped: 0, errors: 0 };

  try {
    const rows = readRows(buffer);
    const grouped = new Map<string, ImportedAppointmentGroup>();
    const context: AppointmentImportContext = {
      staffName: null,
      specialization: null,
      clientName: null,
      phoneRaw: null,
      visitRaw: null,
      createdAtRawValue: null,
      statusRaw: null,
      paidRaw: null,
      creatorName: null
    };

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const rowNumber = i + 2;

      try {
        const rawStaffName = toStr(valueByAlias(row, ['Сотрудник', 'Имя']));
        const rawSpecialization = toStr(
          valueByAlias(row, ['Специализация', 'Unnamed:1', 'Unnamed: 1', '__EMPTY'])
        );
        const rawClientName = toStr(valueByAlias(row, ['Клиент']));
        const rawPhone = valueByAlias(row, ['Телефон', 'Unnamed:3', 'Unnamed: 3', '__EMPTY_1']);
        const rawVisit = valueByAlias(row, ['Время визита']);
        const rawCreatedAt = valueByAlias(row, ['Дата', '__EMPTY_3']);
        const rawStatus = toStr(valueByAlias(row, ['Статус']));
        const rawPaid = toStr(valueByAlias(row, ['Оплачено полностью']));
        const rawCreatorName = toStr(valueByAlias(row, ['Создал']));
        const serviceName =
          toStr(valueByAlias(row, ['Название', 'Unnamed:14', 'Unnamed: 14', '__EMPTY_6'])) ??
          toStr(valueByAlias(row, ['Услуги']));
        const price =
          parseDecimal(valueByAlias(row, ['Стоимость, ₽', 'Unnamed:15', 'Unnamed: 15', '__EMPTY_7'])) ??
          zero();
        const priceWithDiscount =
          parseDecimal(
            valueByAlias(row, ['Стоимость с учетом скидки, ₽', 'Unnamed:16', 'Unnamed: 16', '__EMPTY_8'])
          ) ?? price;
        const phoneText = toStr(rawPhone);

        const isHeaderRow =
          ((rawStaffName ?? '').toLowerCase().includes('имя') &&
            (rawClientName ?? '').toLowerCase().includes('имя')) ||
          (rawSpecialization ?? '').toLowerCase().includes('специализа') ||
          (serviceName ?? '').toLowerCase().includes('назван') ||
          (phoneText ?? '').toLowerCase().includes('телефон');

        if (
          isHeaderRow ||
          (rawStaffName ?? '').toLowerCase() === 'имя' ||
          (rawSpecialization ?? '').toLowerCase() === 'специализация' ||
          (phoneText ?? '').toLowerCase() === 'телефон'
        ) {
          counters.skipped += 1;
          continue;
        }

        context.staffName = rawStaffName ?? context.staffName;
        context.specialization = rawSpecialization ?? context.specialization;
        context.clientName = rawClientName ?? context.clientName;
        context.phoneRaw = rawPhone ?? context.phoneRaw;
        context.visitRaw = rawVisit ?? context.visitRaw;
        context.createdAtRawValue = rawCreatedAt ?? context.createdAtRawValue;
        context.statusRaw = rawStatus ?? context.statusRaw;
        context.paidRaw = rawPaid ?? context.paidRaw;
        context.creatorName = rawCreatorName ?? context.creatorName;

        if (!context.staffName || !context.phoneRaw || !context.visitRaw) {
          counters.skipped += 1;
          continue;
        }

        const phone10 = normalizePhone10(String(context.phoneRaw));
        const visitAt = parseExcelDateTimeMsk(context.visitRaw);
        if (!visitAt) {
          throw new Error('Invalid visit datetime');
        }
        const createdAtRaw = parseExcelDateTimeMsk(context.createdAtRawValue);

        const key = groupKeyForAppointment(context.staffName, phone10, visitAt, createdAtRaw);
        const appointmentRow: ImportedAppointmentRow = {
          rowNumber,
          raw: row,
          specialization: context.specialization,
          statusRaw: context.statusRaw,
          paidRaw: context.paidRaw,
          createdAtRaw,
          creatorName: context.creatorName,
          visitAt,
          staffName: context.staffName,
          clientName: context.clientName,
          clientPhone: phone10
        };

        let group = grouped.get(key);
        if (!group) {
          group = { appointment: appointmentRow, services: [] };
          grouped.set(key, group);
        }

        if (serviceName) {
          group.services.push({
            serviceName,
            price,
            priceWithDiscount
          });
        }
      } catch (error) {
        counters.errors += 1;
        await addJobError(job.id, rowNumber, row, (error as Error).message);
      }
    }

    for (const group of grouped.values()) {
      const first = group.appointment;

      try {
        const [staff, client] = await Promise.all([
          findOrCreateStaffByName(first.staffName, first.specialization ?? undefined),
          upsertClientByPhone(first.clientPhone, first.clientName ?? undefined)
        ]);

        let creatorStaffId: string | null = null;
        if (first.creatorName) {
          const creator = await prisma.staff.findFirst({ where: { name: first.creatorName } });
          creatorStaffId = creator?.id ?? null;
        }

        const serviceSnapshots: Array<{
          serviceId: string | null;
          serviceNameSnapshot: string;
          durationSnapshotSec: number;
          priceSnapshot: Prisma.Decimal;
          priceWithDiscountSnapshot: Prisma.Decimal;
          sortOrder: number;
        }> = [];

        let baseTotal = zero();
        let finalTotal = zero();
        let totalDurationSec = 0;

        for (let idx = 0; idx < group.services.length; idx += 1) {
          const row = group.services[idx]!;
          const service = await findServiceByName(row.serviceName);
          const durationSec = service?.durationSec ?? 0;

          baseTotal = baseTotal.plus(row.price);
          finalTotal = finalTotal.plus(row.priceWithDiscount);
          totalDurationSec += durationSec;

          serviceSnapshots.push({
            serviceId: service?.id ?? null,
            serviceNameSnapshot: row.serviceName,
            durationSnapshotSec: durationSec,
            priceSnapshot: row.price,
            priceWithDiscountSnapshot: row.priceWithDiscount,
            sortOrder: idx + 1
          });
        }

        const discountAmount = baseTotal.minus(finalTotal).toDecimalPlaces(2);
        const discountType = discountAmount.equals(0) ? DiscountType.NONE : DiscountType.FIXED;
        const discountValue = discountType === DiscountType.FIXED ? discountAmount : null;

        const paidFully = mapPaidFully(first.paidRaw);
        const paymentStatus = paidFully ? PaymentStatus.PAID : PaymentStatus.UNPAID;
        const paidAmount = paidFully ? finalTotal : zero();

        const status = mapAppointmentStatus(first.statusRaw);
        const externalId = buildImportedExternalId(
          first.staffName,
          first.clientPhone,
          first.visitAt,
          first.createdAtRaw
        );

        const endAt = new Date(first.visitAt.getTime() + Math.max(totalDurationSec, 1) * 1000);

        const existing = await prisma.appointment.findUnique({ where: { externalId } });

        if (!existing) {
          await prisma.appointment.create({
            data: {
              externalId,
              clientId: client.id,
              staffId: staff.id,
              startAt: first.visitAt,
              endAt,
              status,
              baseTotalPrice: baseTotal,
              discountTypeSnapshot: discountType,
              discountValueSnapshot: discountValue,
              discountAmountSnapshot: discountAmount,
              finalTotalPrice: finalTotal,
              paymentStatus,
              paymentMethod: PaymentMethod.OTHER,
              paidAmount,
              createdByType: creatorStaffId ? ActorType.STAFF : ActorType.SYSTEM,
              createdById: creatorStaffId,
              ...(serviceSnapshots.length
                ? {
                    appointmentServices: {
                      createMany: {
                        data: serviceSnapshots
                      }
                    }
                  }
                : {})
            }
          });
          counters.created += 1;
        } else {
          await prisma.$transaction(async (tx) => {
            await tx.appointment.update({
              where: { id: existing.id },
              data: {
                clientId: client.id,
                staffId: staff.id,
                startAt: first.visitAt,
                endAt,
                status,
                baseTotalPrice: baseTotal,
                discountTypeSnapshot: discountType,
                discountValueSnapshot: discountValue,
                discountAmountSnapshot: discountAmount,
                finalTotalPrice: finalTotal,
                paymentStatus,
                paymentMethod: PaymentMethod.OTHER,
                paidAmount,
                createdByType: creatorStaffId ? ActorType.STAFF : ActorType.SYSTEM,
                createdById: creatorStaffId
              }
            });

            await tx.appointmentService.deleteMany({ where: { appointmentId: existing.id } });
            if (serviceSnapshots.length) {
              await tx.appointmentService.createMany({
                data: serviceSnapshots.map((item) => ({
                  appointmentId: existing.id,
                  serviceId: item.serviceId,
                  serviceNameSnapshot: item.serviceNameSnapshot,
                  durationSnapshotSec: item.durationSnapshotSec,
                  priceSnapshot: item.priceSnapshot,
                  priceWithDiscountSnapshot: item.priceWithDiscountSnapshot,
                  sortOrder: item.sortOrder
                }))
              });
            }
          });
          counters.updated += 1;
        }
      } catch (error) {
        counters.errors += 1;
        await addJobError(job.id, first.rowNumber, first.raw, (error as Error).message);
      }
    }

    await finishJob(job.id, counters, 'DONE');
    return { jobId: job.id, ...counters };
  } catch (error) {
    await finishJob(job.id, counters, 'FAILED');
    throw error;
  }
};

export const getImportJobDetails = async (jobId: string) => {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } });
  if (!job) {
    throw badRequest('Import job not found');
  }

  const errors = await prisma.importJobErrorRow.findMany({
    where: { importJobId: jobId },
    orderBy: { rowNumber: 'asc' }
  });

  return { job, errors };
};
