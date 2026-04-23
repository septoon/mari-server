import {
  ActorType,
  AppointmentStatus,
  DiscountType,
  PaymentMethod,
  PaymentStatus,
  Prisma
} from '@prisma/client';
import dayjs from 'dayjs';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../../db/prisma';
import {
  authenticateOptional,
  authenticateRequired,
  requireClient,
  hasPermission,
  requireStaff,
  requireStaffRoles,
  requirePermission,
} from '../../middlewares/auth';
import { validateBody, validateParams, validateQuery } from '../../middlewares/validate';
import { asyncHandler } from '../../utils/async-handler';
import { badRequest, businessRule, conflictSlot, forbidden, notFound } from '../../utils/errors';
import { D, maxZero, toNumber, zero } from '../../utils/money';
import { ok } from '../../utils/response';
import { MSK_TZ, parseDateOnlyToUtc, todayStartMskUtc } from '../../utils/time';
import { upsertClientByPhone } from '../clients/service';
import { validatePromoForClient } from '../promocodes/service';
import { getOrCreateAppConfig } from '../settings/service';
import {
  notifyOnAppointmentCreated,
  notifyOnAppointmentRescheduled,
  notifyOnAppointmentStatusChanged,
  notifyOnClientCancelled,
  notifyOnPaymentAdded,
} from '../notifications/service';
import {
  buildApiAppointmentExternalId,
  calculatePrices,
  deleteAppointmentsCascade,
  getDurationSec,
  getServicesSnapshot,
  normalizeDiscount,
  resolveStaffCandidates
} from './service';
import {
  fitsBookingHours,
  fitsWorkingHours,
  isStaffAvailable,
  listSlotsForStaff,
  SLOT_STEP_MINUTES
} from '../schedule/service';

const slotsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  serviceIds: z.string().min(1),
  staffId: z.string().uuid().optional(),
  anyStaff: z.union([z.literal('true'), z.literal('false')]).optional()
});

const slotDaysQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.coerce.number().int().min(1).max(31).default(14),
  serviceIds: z.string().min(1),
  staffId: z.string().uuid().optional(),
  anyStaff: z.union([z.literal('true'), z.literal('false')]).optional()
});

const createAppointmentSchema = z.object({
  client: z
    .object({
      name: z.string().min(1),
      phone: z.string().min(1)
    })
    .optional(),
  clientId: z.string().uuid().optional(),
  serviceIds: z.array(z.string().uuid()).min(1),
  staffId: z.string().uuid().optional(),
  anyStaff: z.boolean().optional(),
  startAt: z.string().datetime(),
  comment: z.string().optional(),
  promoCode: z.string().min(1).optional(),
  discountOverride: z
    .object({
      type: z.enum(['NONE', 'FIXED', 'PERCENT']),
      value: z.number().nonnegative().optional()
    })
    .optional()
});

const summaryParamSchema = z.object({
  clientId: z.string().uuid()
});

const idParamSchema = z.object({
  id: z.string().uuid()
});

const appointmentsListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  staffId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  status: z.nativeEnum(AppointmentStatus).optional()
});

const masterAppointmentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const clientAppointmentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.nativeEnum(AppointmentStatus).optional()
});

const statusUpdateSchema = z.object({
  status: z.nativeEnum(AppointmentStatus)
});

const rescheduleSchema = z.object({
  startAt: z.string().datetime(),
  staffId: z.string().uuid().optional(),
  anyStaff: z.boolean().optional()
});

const addPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  method: z.nativeEnum(PaymentMethod)
});

const clientCancelSchema = z.object({
  reason: z.string().trim().max(500).optional()
}).default({});

const buildDateRange = (from?: string, to?: string) => {
  const range: { gte?: Date; lt?: Date } = {};
  if (from) {
    range.gte = parseDateOnlyToUtc(from);
  }
  if (to) {
    range.lt = dayjs(parseDateOnlyToUtc(to)).add(1, 'day').toDate();
  }
  return Object.keys(range).length > 0 ? range : undefined;
};

const JOURNAL_HISTORY_MONTHS = 2;

const buildRestrictedJournalRange = (range?: { gte?: Date; lt?: Date }) => {
  const historyStart = dayjs().tz(MSK_TZ).subtract(JOURNAL_HISTORY_MONTHS, 'month').startOf('day').utc().toDate();
  const nextRange = { ...(range ?? {}) };

  if (!nextRange.gte || nextRange.gte < historyStart) {
    nextRange.gte = historyStart;
  }

  return nextRange;
};

const resolveClientBaseDiscount = (client: {
  discountType: DiscountType;
  discountValue: any;
  temporaryDiscountType: DiscountType;
  temporaryDiscountValue: any;
  temporaryDiscountFrom: Date | null;
  temporaryDiscountTo: Date | null;
}) => {
  const now = new Date();
  const temporaryActive =
    client.temporaryDiscountType !== DiscountType.NONE &&
    !!client.temporaryDiscountValue &&
    (!client.temporaryDiscountFrom || client.temporaryDiscountFrom <= now) &&
    (!client.temporaryDiscountTo || client.temporaryDiscountTo > now);

  if (temporaryActive) {
    return {
      type: client.temporaryDiscountType,
      value: client.temporaryDiscountValue
    };
  }

  return {
    type: client.discountType,
    value: client.discountValue
  };
};

const pickStaffCandidatesForReschedule = async (
  serviceIds: string[],
  currentStaffId: string,
  input: { staffId?: string; anyStaff?: boolean }
): Promise<Array<{ id: string; name: string }>> => {
  if (serviceIds.length > 0) {
    const resolved = await resolveStaffCandidates(serviceIds, input.staffId, input.anyStaff);
    return resolved.map((row) => ({ id: row.id, name: row.name }));
  }

  if (input.staffId) {
    const staff = await prisma.staff.findUnique({ where: { id: input.staffId } });
    if (!staff || !staff.isActive || staff.firedAt) {
      throw notFound('Staff not found or inactive');
    }
    return [{ id: staff.id, name: staff.name }];
  }

  if (input.anyStaff) {
    const staff = await prisma.staff.findMany({
      where: {
        isActive: true,
        firedAt: null,
        role: { in: ['MASTER', 'ADMIN', 'OWNER', 'DEVELOPER', 'SMM'] }
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' }
    });
    return staff;
  }

  const current = await prisma.staff.findUnique({ where: { id: currentStaffId } });
  if (!current) {
    throw notFound('Current staff not found');
  }

  return [{ id: current.id, name: current.name }];
};

const selectAvailableStaff = async (
  db: Prisma.TransactionClient,
  candidates: Array<{ id: string; name: string }>,
  dateMsk: string,
  startAt: Date,
  endAt: Date,
  excludeAppointmentId?: string,
  mode: 'working' | 'booking' = 'working'
): Promise<{ id: string; name: string } | null> => {
  for (const candidate of candidates) {
    const [fits, available] = await Promise.all([
      (mode === 'booking' ? fitsBookingHours : fitsWorkingHours)(
        candidate.id,
        dateMsk,
        startAt,
        endAt,
        db
      ),
      isStaffAvailable(candidate.id, startAt, endAt, excludeAppointmentId, db)
    ]);
    if (fits && available) {
      return { id: candidate.id, name: candidate.name };
    }
  }

  return null;
};

const mapSlotWriteError = (error: unknown): never => {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    throw conflictSlot('Selected time just became unavailable');
  }

  throw error;
};

export const appointmentsRouter = Router();

appointmentsRouter.get(
  '/appointments/slot-days',
  validateQuery(slotDaysQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof slotDaysQuerySchema>;
    const serviceIds = query.serviceIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    const services = await getServicesSnapshot(serviceIds);
    const durationSec = getDurationSec(services);
    const candidates = await resolveStaffCandidates(serviceIds, query.staffId, query.anyStaff === 'true');
    const startDate = dayjs.tz(query.from, 'YYYY-MM-DD', MSK_TZ);

    const items: Array<{
      date: string;
      hasSlots: boolean;
      totalSlots: number;
      firstSlotAt: string | null;
    }> = [];

    for (let offset = 0; offset < query.days; offset += 1) {
      const date = startDate.add(offset, 'day').format('YYYY-MM-DD');
      const slotGroups = await Promise.all(
        candidates.map(async (candidate) => listSlotsForStaff(candidate.id, date, durationSec))
      );

      let totalSlots = 0;
      let firstSlotAtMs: number | null = null;

      slotGroups.forEach((slots) => {
        totalSlots += slots.length;
        const earliestSlot = slots[0]?.startAt;
        if (earliestSlot) {
          const earliestSlotMs = earliestSlot.getTime();
          if (firstSlotAtMs === null || earliestSlotMs < firstSlotAtMs) {
            firstSlotAtMs = earliestSlotMs;
          }
        }
      });

      items.push({
        date,
        hasSlots: totalSlots > 0,
        totalSlots,
        firstSlotAt: firstSlotAtMs === null ? null : new Date(firstSlotAtMs).toISOString()
      });
    }

    return ok(res, {
      from: query.from,
      days: query.days,
      stepMinutes: SLOT_STEP_MINUTES,
      durationSec,
      items
    });
  })
);

appointmentsRouter.get(
  '/appointments/slots',
  validateQuery(slotsQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof slotsQuerySchema>;
    const serviceIds = query.serviceIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    const services = await getServicesSnapshot(serviceIds);
    const durationSec = getDurationSec(services);
    const candidates = await resolveStaffCandidates(serviceIds, query.staffId, query.anyStaff === 'true');

    const results: Array<{
      staffId: string;
      staffName: string;
      slots: Array<{ startAt: string; endAt: string }>;
    }> = [];

    for (const candidate of candidates) {
      const slots = await listSlotsForStaff(candidate.id, query.date, durationSec);
      results.push({
        staffId: candidate.id,
        staffName: candidate.name,
        slots: slots.map((slot) => ({
          startAt: slot.startAt.toISOString(),
          endAt: slot.endAt.toISOString()
        }))
      });
    }

    return ok(res, {
      date: query.date,
      stepMinutes: SLOT_STEP_MINUTES,
      durationSec,
      results
    });
  })
);

appointmentsRouter.post(
  '/appointments',
  authenticateOptional,
  validateBody(createAppointmentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createAppointmentSchema>;

    if (
      req.auth?.subjectType === 'STAFF' &&
      !hasPermission(req, 'CREATE_JOURNAL_APPOINTMENTS') &&
      !hasPermission(req, 'EDIT_JOURNAL')
    ) {
      throw forbidden('No permission to edit journal');
    }

    const startAt = new Date(body.startAt);
    if (Number.isNaN(startAt.getTime())) {
      throw badRequest('Invalid startAt datetime');
    }
    const stepMs = SLOT_STEP_MINUTES * 60 * 1000;
    if (startAt.getTime() % stepMs !== 0) {
      throw badRequest(`startAt must be aligned to ${SLOT_STEP_MINUTES}-minute steps`);
    }

    const services = await getServicesSnapshot(body.serviceIds);
    const durationSec = getDurationSec(services);
    const endAt = new Date(startAt.getTime() + durationSec * 1000);
    const dateMsk = dayjs(startAt).tz(MSK_TZ).format('YYYY-MM-DD');

    let client;
    if (body.clientId) {
      if (req.auth?.subjectType === 'CLIENT' && req.auth.subjectId !== body.clientId) {
        throw forbidden('Client can create appointment only for own account');
      }
      client = await prisma.client.findUnique({ where: { id: body.clientId } });
      if (!client) throw notFound('Client not found');
    } else if (req.auth?.subjectType === 'CLIENT') {
      client = await prisma.client.findUnique({ where: { id: req.auth.subjectId } });
      if (!client) throw notFound('Client not found');
    } else {
      if (!body.client) {
        throw badRequest('client or clientId is required');
      }
      client = await upsertClientByPhone(body.client.phone, body.client.name);
    }

    if (body.discountOverride && body.promoCode) {
      throw badRequest('Use either discountOverride or promoCode, not both');
    }

    if (body.discountOverride) {
      const canSetOverride =
        req.auth?.subjectType === 'STAFF' &&
        (req.auth.staffRole === 'ADMIN' || req.auth.staffRole === 'OWNER');
      if (!canSetOverride) {
        throw forbidden('discountOverride allowed only for ADMIN/OWNER');
      }
    }

    let promoToApply:
      | {
          id: string;
          code: string;
          discountType: DiscountType;
          discountValue: number;
        }
      | null = null;

    if (body.promoCode) {
      const validation = await validatePromoForClient(body.promoCode, client.id);
      if (!validation.valid || !validation.promo) {
        throw businessRule('PROMO_CODE_INVALID', 'Promo code is invalid', {
          reason: validation.reason
        });
      }

      promoToApply = {
        id: validation.promo.id,
        code: validation.promo.code,
        discountType: validation.promo.discountType,
        discountValue: Number(validation.promo.discountValue)
      };
    }

    const candidates = await resolveStaffCandidates(body.serviceIds, body.staffId, body.anyStaff);

    const clientBaseDiscount = resolveClientBaseDiscount(client);

    const discount = normalizeDiscount(
      clientBaseDiscount.type,
      clientBaseDiscount.value,
      body.discountOverride
        ? {
            type: body.discountOverride.type as DiscountType,
            value: body.discountOverride.value
          }
        : promoToApply
          ? {
              type: promoToApply.discountType,
              value: promoToApply.discountValue
            }
          : undefined
    );

    const prices = calculatePrices(services, discount);
    const appointmentComment = body.comment?.trim() || null;
    const appointment = await (async () => {
      try {
        return await prisma.$transaction(
          async (tx) => {
            const selectedStaff = await selectAvailableStaff(
              tx,
              candidates,
              dateMsk,
              startAt,
              endAt,
              undefined,
              req.auth?.subjectType === 'STAFF' ? 'working' : 'booking'
            );
            if (!selectedStaff) {
              throw conflictSlot('No available staff for selected time');
            }

            const externalId = buildApiAppointmentExternalId(selectedStaff.id, client.id, startAt, [...body.serviceIds]);
            const exists = await tx.appointment.findUnique({ where: { externalId } });
            if (exists) {
              throw conflictSlot('Appointment with same payload already exists');
            }

            const created = await tx.appointment.create({
              data: {
                externalId,
                clientId: client.id,
                staffId: selectedStaff.id,
                startAt,
                endAt,
                status: 'PENDING',
                baseTotalPrice: prices.baseTotal,
                discountTypeSnapshot: prices.discountTypeSnapshot,
                discountValueSnapshot: prices.discountValueSnapshot,
                discountAmountSnapshot: prices.discountAmount,
                finalTotalPrice: prices.finalTotal,
                paymentStatus: PaymentStatus.UNPAID,
                paymentMethod: PaymentMethod.OTHER,
                paidAmount: zero(),
                comment: appointmentComment,
                createdByType: req.auth?.subjectType === 'STAFF' ? ActorType.STAFF : ActorType.CLIENT,
                createdById: req.auth?.subjectType === 'STAFF' ? req.auth.subjectId : client.id
              }
            });

            await tx.appointmentService.createMany({
              data: services.map((service, index) => ({
                appointmentId: created.id,
                serviceId: service.id,
                serviceNameSnapshot: service.name,
                durationSnapshotSec: service.durationSec,
                priceSnapshot: service.price,
                priceWithDiscountSnapshot: prices.serviceFinalPrices[index]!,
                sortOrder: index + 1
              }))
            });

            if (promoToApply && prices.discountAmount.greaterThan(0)) {
              await tx.promoCodeRedemption.create({
                data: {
                  promoCodeId: promoToApply.id,
                  clientId: client.id,
                  appointmentId: created.id,
                  discountTypeSnapshot: prices.discountTypeSnapshot,
                  discountValueSnapshot: prices.discountValueSnapshot,
                  discountAmountSnapshot: prices.discountAmount
                }
              });

              await tx.promoCode.update({
                where: { id: promoToApply.id },
                data: { usedCount: { increment: 1 } }
              });
            }

            return tx.appointment.findUniqueOrThrow({
              where: { id: created.id },
              include: {
                appointmentServices: {
                  orderBy: { sortOrder: 'asc' }
                },
                staff: true,
                client: true,
                promoRedemption: {
                  include: { promoCode: true }
                }
              }
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        return mapSlotWriteError(error);
      }
    })();

    await notifyOnAppointmentCreated(appointment.id);

    return ok(
      res,
      {
        appointment: {
          id: appointment.id,
          externalId: appointment.externalId,
          status: appointment.status,
          startAt: appointment.startAt.toISOString(),
          endAt: appointment.endAt.toISOString(),
          comment: appointment.comment,
          staff: {
            id: appointment.staff.id,
            name: appointment.staff.name
          },
          client: {
            id: appointment.client.id,
            name: appointment.client.name
          },
          services: appointment.appointmentServices.map((row) => ({
            serviceId: row.serviceId,
            name: row.serviceNameSnapshot,
            price: toNumber(row.priceSnapshot),
            priceWithDiscount: toNumber(row.priceWithDiscountSnapshot),
            durationSec: row.durationSnapshotSec
          })),
          prices: {
            baseTotal: toNumber(appointment.baseTotalPrice),
            discountAmount: toNumber(appointment.discountAmountSnapshot),
            finalTotal: toNumber(appointment.finalTotalPrice)
          },
          payment: {
            status: appointment.paymentStatus,
            method: appointment.paymentMethod,
            paidAmount: toNumber(appointment.paidAmount)
          },
          promo: appointment.promoRedemption
            ? {
                code: appointment.promoRedemption.promoCode.code,
                discountType: appointment.promoRedemption.discountTypeSnapshot,
                discountValue: appointment.promoRedemption.discountValueSnapshot
                  ? toNumber(appointment.promoRedemption.discountValueSnapshot)
                  : null,
                discountAmount: toNumber(appointment.promoRedemption.discountAmountSnapshot)
              }
            : null
        }
      },
      201
    );
  })
);

appointmentsRouter.get(
  '/appointments',
  authenticateRequired,
  requireStaff,
  validateQuery(appointmentsListQuerySchema),
  asyncHandler(async (req, res) => {
    const actor = req.auth!;
    if (actor.staffRole !== 'OWNER' && !hasPermission(req, 'VIEW_JOURNAL')) {
      throw forbidden('No permission to view journal');
    }

    const query = req.validatedQuery as z.infer<typeof appointmentsListQuerySchema>;
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;
    const hasFullJournalAccess =
      actor.staffRole === 'OWNER' || hasPermission(req, 'VIEW_ALL_JOURNAL_APPOINTMENTS');
    const startAt = hasFullJournalAccess
      ? buildDateRange(query.from, query.to)
      : buildRestrictedJournalRange(buildDateRange(query.from, query.to));
    const canViewClientPhone = actor.staffRole !== 'MASTER' || hasPermission(req, 'VIEW_CLIENT_PHONE');

    const where = {
      ...(startAt ? { startAt } : {}),
      staffId: hasFullJournalAccess ? (query.staffId ?? undefined) : actor.subjectId,
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.status ? { status: query.status } : {})
    };

    const [total, rows] = await Promise.all([
      prisma.appointment.count({ where }),
      prisma.appointment.findMany({
        where,
        include: {
          staff: true,
          client: true,
          appointmentServices: { orderBy: { sortOrder: 'asc' } },
          promoRedemption: {
            include: { promoCode: true }
          }
        },
        orderBy: { startAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    return ok(
      res,
      {
        items: rows.map((row) => ({
          id: row.id,
          externalId: row.externalId,
          status: row.status,
          startAt: row.startAt.toISOString(),
          endAt: row.endAt.toISOString(),
          comment: row.comment,
          staff: {
            id: row.staff.id,
            name: row.staff.name
          },
          client: {
            id: row.client.id,
            name: row.client.name,
            phoneE164: canViewClientPhone ? row.client.phoneE164 : undefined
          },
          services: row.appointmentServices.map((service) => ({
            id: service.id,
            serviceId: service.serviceId,
            name: service.serviceNameSnapshot,
            durationSec: service.durationSnapshotSec,
            price: toNumber(service.priceSnapshot),
            priceWithDiscount: toNumber(service.priceWithDiscountSnapshot),
            sortOrder: service.sortOrder
          })),
          prices: {
            baseTotal: toNumber(row.baseTotalPrice),
            discountAmount: toNumber(row.discountAmountSnapshot),
            finalTotal: toNumber(row.finalTotalPrice)
          },
          payment: {
            status: row.paymentStatus,
            method: row.paymentMethod,
            paidAmount: toNumber(row.paidAmount)
          },
          promo: row.promoRedemption
            ? {
                code: row.promoRedemption.promoCode.code,
                discountType: row.promoRedemption.discountTypeSnapshot,
                discountValue: row.promoRedemption.discountValueSnapshot
                  ? toNumber(row.promoRedemption.discountValueSnapshot)
                  : null,
                discountAmount: toNumber(row.promoRedemption.discountAmountSnapshot)
              }
            : null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString()
        }))
      },
      200,
      {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    );
  })
);

appointmentsRouter.get(
  '/master/appointments',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('MASTER'),
  validateQuery(masterAppointmentsQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof masterAppointmentsQuerySchema>;
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;
    const canViewClientPhone = hasPermission(req, 'VIEW_CLIENT_PHONE');

    const hasFullJournalAccess = hasPermission(req, 'VIEW_ALL_JOURNAL_APPOINTMENTS');
    const startAt = hasFullJournalAccess
      ? buildDateRange(query.from, query.to) ?? { gte: todayStartMskUtc() }
      : buildRestrictedJournalRange(buildDateRange(query.from, query.to) ?? { gte: todayStartMskUtc() });

    const where = {
      staffId: req.auth!.subjectId,
      startAt
    };

    const [total, rows] = await Promise.all([
      prisma.appointment.count({ where }),
      prisma.appointment.findMany({
        where,
        include: {
          client: true,
          appointmentServices: { orderBy: { sortOrder: 'asc' } }
        },
        orderBy: { startAt: 'asc' },
        skip,
        take: limit
      })
    ]);

    return ok(
      res,
      {
        items: rows.map((row) => ({
          id: row.id,
          status: row.status,
          startAt: row.startAt.toISOString(),
          endAt: row.endAt.toISOString(),
          comment: row.comment,
          client: {
            id: row.client.id,
            name: row.client.name,
            phoneE164: canViewClientPhone ? row.client.phoneE164 : undefined,
          },
          services: row.appointmentServices.map((service) => ({
            name: service.serviceNameSnapshot,
            durationSec: service.durationSnapshotSec
          }))
        }))
      },
      200,
      {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    );
  })
);

appointmentsRouter.delete(
  '/appointments/:id',
  authenticateRequired,
  requireStaff,
  requirePermission('EDIT_JOURNAL'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const actor = req.auth!;

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        client: true,
        staff: true
      }
    });
    if (!appointment) {
      throw notFound('Appointment not found');
    }

    if (actor.staffRole === 'MASTER' && appointment.staffId !== actor.subjectId) {
      throw forbidden('MASTER can delete only own appointments');
    }

    await prisma.$transaction(async (tx) => {
      const deletedCount = await deleteAppointmentsCascade(tx, [appointment.id]);
      if (deletedCount === 0) {
        throw notFound('Appointment not found');
      }
    });

    return ok(res, {
      deleted: true,
      appointmentId: appointment.id,
      clientId: appointment.clientId
    });
  })
);

appointmentsRouter.patch(
  '/appointments/:id/status',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('MASTER', 'ADMIN', 'OWNER'),
  requirePermission('EDIT_JOURNAL'),
  validateParams(idParamSchema),
  validateBody(statusUpdateSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof statusUpdateSchema>;
    const actor = req.auth!;

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: { client: true, staff: true }
    });
    if (!appointment) {
      throw notFound('Appointment not found');
    }

    if (actor.staffRole === 'MASTER') {
      if (appointment.staffId !== actor.subjectId) {
        throw forbidden('MASTER can update only own appointments');
      }
      const allowedForMaster: AppointmentStatus[] = [AppointmentStatus.ARRIVED, AppointmentStatus.NO_SHOW];
      if (!allowedForMaster.includes(body.status)) {
        throw forbidden('MASTER can set only ARRIVED or NO_SHOW');
      }
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: body.status },
      include: { client: true, staff: true }
    });

    await notifyOnAppointmentStatusChanged({
      appointmentId: updated.id,
      previousStatus: appointment.status,
      nextStatus: updated.status,
    });

    return ok(res, {
      appointment: {
        id: updated.id,
        status: updated.status,
        startAt: updated.startAt.toISOString(),
        endAt: updated.endAt.toISOString(),
        staff: { id: updated.staff.id, name: updated.staff.name },
        client: { id: updated.client.id, name: updated.client.name }
      }
    });
  })
);

appointmentsRouter.patch(
  '/appointments/:id/reschedule',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  requirePermission('EDIT_JOURNAL'),
  validateParams(idParamSchema),
  validateBody(rescheduleSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof rescheduleSchema>;

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        appointmentServices: {
          orderBy: { sortOrder: 'asc' }
        },
        staff: true,
        client: true
      }
    });
    if (!appointment) {
      throw notFound('Appointment not found');
    }

    const forbiddenStatusesForReschedule: AppointmentStatus[] = [
      AppointmentStatus.CANCELLED,
      AppointmentStatus.NO_SHOW
    ];
    if (forbiddenStatusesForReschedule.includes(appointment.status)) {
      throw businessRule('APPOINTMENT_NOT_RESCHEDULABLE', 'Cancelled/No-show appointment cannot be rescheduled');
    }

    const startAt = new Date(body.startAt);
    if (Number.isNaN(startAt.getTime())) {
      throw badRequest('Invalid startAt datetime');
    }

    const stepMs = SLOT_STEP_MINUTES * 60 * 1000;
    if (startAt.getTime() % stepMs !== 0) {
      throw badRequest(`startAt must be aligned to ${SLOT_STEP_MINUTES}-minute steps`);
    }

    const durationFromSnapshot = appointment.appointmentServices.reduce(
      (acc, service) => acc + Math.max(0, service.durationSnapshotSec),
      0
    );
    const durationFromInterval = Math.max(
      1,
      Math.floor((appointment.endAt.getTime() - appointment.startAt.getTime()) / 1000)
    );
    const durationSec = Math.max(durationFromSnapshot, durationFromInterval);
    const endAt = new Date(startAt.getTime() + durationSec * 1000);
    const dateMsk = dayjs(startAt).tz(MSK_TZ).format('YYYY-MM-DD');

    const serviceIds = appointment.appointmentServices
      .map((item) => item.serviceId)
      .filter((value): value is string => Boolean(value));

    const candidates = await pickStaffCandidatesForReschedule(serviceIds, appointment.staffId, {
      staffId: body.staffId,
      anyStaff: body.anyStaff
    });

    const updated = await (async () => {
      try {
        return await prisma.$transaction(
          async (tx) => {
            const selected = await selectAvailableStaff(
              tx,
              candidates,
              dateMsk,
              startAt,
              endAt,
              appointment.id,
              req.auth?.subjectType === 'STAFF' ? 'working' : 'booking'
            );
            if (!selected) {
              throw conflictSlot('No available staff for selected time');
            }

            return tx.appointment.update({
              where: { id: appointment.id },
              data: {
                staffId: selected.id,
                startAt,
                endAt,
                status:
                  appointment.status === AppointmentStatus.PENDING || appointment.status === AppointmentStatus.CONFIRMED
                    ? AppointmentStatus.CONFIRMED
                    : appointment.status
              },
              include: {
                staff: true,
                client: true,
                appointmentServices: { orderBy: { sortOrder: 'asc' } }
              }
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );
      } catch (error) {
        return mapSlotWriteError(error);
      }
    })();

    await notifyOnAppointmentRescheduled({
      appointmentId: updated.id,
      previousStartAt: appointment.startAt,
      previousEndAt: appointment.endAt,
      previousStaffName: appointment.staff.name,
    });

    return ok(res, {
      appointment: {
        id: updated.id,
        status: updated.status,
        startAt: updated.startAt.toISOString(),
        endAt: updated.endAt.toISOString(),
        staff: {
          id: updated.staff.id,
          name: updated.staff.name
        },
        client: {
          id: updated.client.id,
          name: updated.client.name
        },
        services: updated.appointmentServices.map((service) => ({
          name: service.serviceNameSnapshot,
          durationSec: service.durationSnapshotSec,
          price: toNumber(service.priceSnapshot),
          priceWithDiscount: toNumber(service.priceWithDiscountSnapshot)
        }))
      }
    });
  })
);

appointmentsRouter.post(
  '/appointments/:id/payments',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateParams(idParamSchema),
  validateBody(addPaymentSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;
    const body = req.body as z.infer<typeof addPaymentSchema>;

    const appointment = await prisma.appointment.findUnique({ where: { id } });
    if (!appointment) {
      throw notFound('Appointment not found');
    }

    const amount = D(body.amount).toDecimalPlaces(2);

    const result = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: {
          appointmentId: appointment.id,
          amount,
          method: body.method,
          createdByStaffId: req.auth!.subjectId
        }
      });

      const nextPaidRaw = appointment.paidAmount.plus(amount);
      const nextPaid = nextPaidRaw.greaterThan(appointment.finalTotalPrice)
        ? appointment.finalTotalPrice
        : maxZero(nextPaidRaw);

      const nextPaymentStatus = nextPaid.equals(0)
        ? PaymentStatus.UNPAID
        : nextPaid.greaterThanOrEqualTo(appointment.finalTotalPrice)
          ? PaymentStatus.PAID
          : PaymentStatus.PARTIAL;

      const updatedAppointment = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          paidAmount: nextPaid,
          paymentStatus: nextPaymentStatus,
          paymentMethod: body.method
        }
      });

      return { payment, updatedAppointment };
    });

    await notifyOnPaymentAdded({
      appointmentId: appointment.id,
      method: body.method,
    });

    return ok(res, {
      payment: {
        id: result.payment.id,
        appointmentId: result.payment.appointmentId,
        amount: toNumber(result.payment.amount),
        method: result.payment.method,
        createdAt: result.payment.createdAt.toISOString()
      },
      appointmentPayment: {
        paymentStatus: result.updatedAppointment.paymentStatus,
        paymentMethod: result.updatedAppointment.paymentMethod,
        paidAmount: toNumber(result.updatedAppointment.paidAmount),
        finalTotal: toNumber(result.updatedAppointment.finalTotalPrice)
      }
    }, 201);
  })
);

appointmentsRouter.get(
  '/appointments/:id/payments',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('ADMIN', 'OWNER'),
  validateParams(idParamSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        payments: {
          include: { createdByStaff: true },
          orderBy: { createdAt: 'asc' }
        }
      }
    });
    if (!appointment) {
      throw notFound('Appointment not found');
    }

    return ok(res, {
      appointmentId: appointment.id,
      paymentStatus: appointment.paymentStatus,
      paidAmount: toNumber(appointment.paidAmount),
      finalTotal: toNumber(appointment.finalTotalPrice),
      items: appointment.payments.map((payment) => ({
        id: payment.id,
        amount: toNumber(payment.amount),
        method: payment.method,
        createdAt: payment.createdAt.toISOString(),
        createdBy: payment.createdByStaff
          ? {
              id: payment.createdByStaff.id,
              name: payment.createdByStaff.name
            }
          : null
      }))
    });
  })
);

appointmentsRouter.get(
  '/master/clients/:clientId/summary',
  authenticateRequired,
  requireStaff,
  requireStaffRoles('MASTER'),
  validateParams(summaryParamSchema),
  asyncHandler(async (req, res) => {
    const staffId = req.auth!.subjectId;
    const { clientId } = req.params as z.infer<typeof summaryParamSchema>;

    const client = await prisma.client.findUnique({ where: { id: clientId } });
    if (!client) throw notFound('Client not found');

    const since = dayjs().subtract(14, 'day').toDate();
    const now = new Date();

    const [visitsWithMe, rows] = await Promise.all([
      prisma.appointment.count({
        where: {
          staffId,
          clientId,
          status: 'ARRIVED'
        }
      }),
      prisma.appointment.findMany({
        where: {
          staffId,
          clientId,
          startAt: {
            gte: since,
            lte: now
          }
        },
        include: {
          appointmentServices: {
            orderBy: { sortOrder: 'asc' },
            select: { serviceNameSnapshot: true }
          }
        },
        orderBy: { startAt: 'desc' }
      })
    ]);

    return ok(res, {
      client: {
        id: client.id,
        name: client.name
      },
      visitsWithMe,
      last14DaysAppointments: rows.map((row) => ({
        id: row.id,
        startAt: row.startAt.toISOString(),
        status: row.status,
        services: row.appointmentServices.map((service) => ({ name: service.serviceNameSnapshot }))
      }))
    });
  })
);

appointmentsRouter.get(
  '/client/appointments',
  authenticateRequired,
  requireClient,
  validateQuery(clientAppointmentsQuerySchema),
  asyncHandler(async (req, res) => {
    const query = req.validatedQuery as z.infer<typeof clientAppointmentsQuerySchema>;
    const page = query.page;
    const limit = query.limit;
    const skip = (page - 1) * limit;

    const startAt = buildDateRange(query.from, query.to);

    const where = {
      clientId: req.auth!.subjectId,
      ...(query.status ? { status: query.status } : {}),
      ...(startAt ? { startAt } : {})
    };

    const [total, rows] = await Promise.all([
      prisma.appointment.count({ where }),
      prisma.appointment.findMany({
        where,
        include: {
          staff: true,
          appointmentServices: { orderBy: { sortOrder: 'asc' } },
          promoRedemption: {
            include: { promoCode: true }
          }
        },
        orderBy: { startAt: 'desc' },
        skip,
        take: limit
      })
    ]);

    return ok(
      res,
      {
        items: rows.map((row) => ({
          id: row.id,
          status: row.status,
          startAt: row.startAt.toISOString(),
          endAt: row.endAt.toISOString(),
          comment: row.comment,
          staff: {
            id: row.staff.id,
            name: row.staff.name
          },
          services: row.appointmentServices.map((service) => ({
            name: service.serviceNameSnapshot,
            durationSec: service.durationSnapshotSec,
            price: toNumber(service.priceSnapshot),
            priceWithDiscount: toNumber(service.priceWithDiscountSnapshot)
          })),
          prices: {
            baseTotal: toNumber(row.baseTotalPrice),
            discountAmount: toNumber(row.discountAmountSnapshot),
            finalTotal: toNumber(row.finalTotalPrice)
          },
          payment: {
            status: row.paymentStatus,
            method: row.paymentMethod,
            paidAmount: toNumber(row.paidAmount)
          },
          promo: row.promoRedemption
            ? {
                code: row.promoRedemption.promoCode.code,
                discountType: row.promoRedemption.discountTypeSnapshot,
                discountValue: row.promoRedemption.discountValueSnapshot
                  ? toNumber(row.promoRedemption.discountValueSnapshot)
                  : null,
                discountAmount: toNumber(row.promoRedemption.discountAmountSnapshot)
              }
            : null
        }))
      },
      200,
      {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit))
      }
    );
  })
);

appointmentsRouter.post(
  '/client/appointments/:id/cancel',
  authenticateRequired,
  requireClient,
  validateParams(idParamSchema),
  validateBody(clientCancelSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params as z.infer<typeof idParamSchema>;

    const appointment = await prisma.appointment.findUnique({
      where: { id }
    });
    if (!appointment) {
      throw notFound('Appointment not found');
    }
    if (appointment.clientId !== req.auth!.subjectId) {
      throw forbidden('Cannot cancel another client appointment');
    }

    if (appointment.status === AppointmentStatus.CANCELLED) {
      return ok(res, {
        appointment: {
          id: appointment.id,
          status: appointment.status,
          startAt: appointment.startAt.toISOString()
        }
      });
    }

    const nonCancellableStatuses: AppointmentStatus[] = [AppointmentStatus.ARRIVED, AppointmentStatus.NO_SHOW];
    if (nonCancellableStatuses.includes(appointment.status)) {
      throw businessRule('APPOINTMENT_CANNOT_BE_CANCELLED', 'Appointment cannot be cancelled in current status');
    }

    const config = await getOrCreateAppConfig();
    const minNoticeMinutes = config.clientCancelMinNoticeMinutes;
    const minAllowedMoment = dayjs().add(minNoticeMinutes, 'minute');

    if (dayjs(appointment.startAt).isBefore(minAllowedMoment)) {
      throw businessRule(
        'CLIENT_CANCEL_TOO_LATE',
        'Cancellation is allowed not later than configured minimum notice interval',
        {
          minNoticeMinutes,
          startAt: appointment.startAt.toISOString()
        }
      );
    }

    const updated = await prisma.appointment.update({
      where: { id: appointment.id },
      data: { status: AppointmentStatus.CANCELLED }
    });

    await notifyOnClientCancelled(updated.id);

    return ok(res, {
      appointment: {
        id: updated.id,
        status: updated.status,
        startAt: updated.startAt.toISOString()
      },
      policy: {
        minNoticeMinutes
      }
    });
  })
);
