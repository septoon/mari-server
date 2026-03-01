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
import * as XLSX from 'xlsx';

import { prisma } from '../../db/prisma';
import { sha1 } from '../../utils/crypto';
import { badRequest } from '../../utils/errors';
import { normalizePhone10 } from '../../utils/phone';
import { upsertClientByPhone } from '../clients/service';
import { findOrCreateStaffByName } from '../staff/routes';
import { D, zero } from '../../utils/money';
import { MSK_TZ } from '../../utils/time';

type ImportType = 'CLIENTS' | 'SERVICES' | 'APPOINTMENTS';

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
  uploadedByStaffId: string
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

        const category = await prisma.serviceCategory.upsert({
          where: { name: categoryName },
          update: {},
          create: { name: categoryName }
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
          await prisma.service.update({ where: { id: existing.id }, data: payload });
          counters.updated += 1;
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

type ImportedServiceRow = {
  rowNumber: number;
  raw: Record<string, unknown>;
  specialization: string | null;
  serviceName: string;
  price: Prisma.Decimal;
  priceWithDiscount: Prisma.Decimal;
  statusRaw: string | null;
  paidRaw: string | null;
  createdAtRaw: Date | null;
  creatorName: string | null;
  visitAt: Date;
  staffName: string;
  clientName: string | null;
  clientPhone: string;
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
    const grouped = new Map<string, ImportedServiceRow[]>();

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const rowNumber = i + 2;

      try {
        const staffName = toStr(valueByAlias(row, ['Сотрудник', 'Имя']));
        const specialization = toStr(valueByAlias(row, ['Специализация', 'Unnamed:1', 'Unnamed: 1', '__EMPTY']));
        const clientName = toStr(valueByAlias(row, ['Клиент']));
        const phoneRaw = valueByAlias(row, ['Телефон', 'Unnamed:3', 'Unnamed: 3', '__EMPTY_1']);
        const visitRaw = valueByAlias(row, ['Время визита']);
        const createdAtRawValue = valueByAlias(row, ['Дата', '__EMPTY_3']);
        const statusRaw = toStr(valueByAlias(row, ['Статус']));
        const paidRaw = toStr(valueByAlias(row, ['Оплачено полностью']));
        const creatorName = toStr(valueByAlias(row, ['Создал']));
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
        const phoneText = toStr(phoneRaw);

        const isHeaderRow =
          ((staffName ?? '').toLowerCase().includes('имя') &&
            (clientName ?? '').toLowerCase().includes('имя')) ||
          (specialization ?? '').toLowerCase().includes('специализа') ||
          (serviceName ?? '').toLowerCase().includes('назван') ||
          (phoneText ?? '').toLowerCase().includes('телефон');

        if (
          isHeaderRow ||
          (staffName ?? '').toLowerCase() === 'имя' ||
          (specialization ?? '').toLowerCase() === 'специализация' ||
          (phoneText ?? '').toLowerCase() === 'телефон'
        ) {
          counters.skipped += 1;
          continue;
        }

        if (!staffName || !serviceName || !phoneRaw || !visitRaw) {
          counters.skipped += 1;
          continue;
        }

        const phone10 = normalizePhone10(String(phoneRaw));
        const visitAt = parseExcelDateTimeMsk(visitRaw);
        if (!visitAt) {
          throw new Error('Invalid visit datetime');
        }
        const createdAtRaw = parseExcelDateTimeMsk(createdAtRawValue);

        const key = groupKeyForAppointment(staffName, phone10, visitAt, createdAtRaw);
        const serviceRow: ImportedServiceRow = {
          rowNumber,
          raw: row,
          specialization,
          serviceName,
          price,
          priceWithDiscount,
          statusRaw,
          paidRaw,
          createdAtRaw,
          creatorName,
          visitAt,
          staffName,
          clientName,
          clientPhone: phone10
        };

        const list = grouped.get(key) ?? [];
        list.push(serviceRow);
        grouped.set(key, list);
      } catch (error) {
        counters.errors += 1;
        await addJobError(job.id, rowNumber, row, (error as Error).message);
      }
    }

    for (const rowsInGroup of grouped.values()) {
      const first = rowsInGroup[0]!;

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

        for (let idx = 0; idx < rowsInGroup.length; idx += 1) {
          const row = rowsInGroup[idx]!;
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
              appointmentServices: {
                createMany: {
                  data: serviceSnapshots
                }
              }
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
