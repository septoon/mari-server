import { DiscountType, Prisma, StaffRole } from '@prisma/client';

import { prisma } from '../../db/prisma';
import { sha1 } from '../../utils/crypto';
import { badRequest, conflict, notFound } from '../../utils/errors';
import { D, maxZero, zero } from '../../utils/money';

export type ServiceSnapshot = {
  id: string;
  name: string;
  durationSec: number;
  price: Prisma.Decimal;
};

export type DiscountOverrideInput = {
  type: DiscountType;
  value?: number;
};

export const getServicesSnapshot = async (serviceIds: string[]): Promise<ServiceSnapshot[]> => {
  if (!serviceIds.length) {
    return [];
  }

  const uniqueIds = Array.from(new Set(serviceIds));
  const services = await prisma.service.findMany({
    where: { id: { in: uniqueIds }, isActive: true }
  });

  const byId = new Map(services.map((service) => [service.id, service]));
  const ordered = uniqueIds.map((id) => byId.get(id)).filter(Boolean) as typeof services;

  if (ordered.length !== uniqueIds.length) {
    const missing = uniqueIds.filter((id) => !byId.has(id));
    throw notFound(`Some services not found: ${missing.join(', ')}`);
  }

  return ordered.map((service) => ({
    id: service.id,
    name: service.name,
    durationSec: service.durationSec,
    price: service.priceMin
  }));
};

export const getDurationSec = (services: ServiceSnapshot[]): number => {
  return services.reduce((acc, service) => acc + service.durationSec, 0);
};

export const getClientVisibleStaffWhere = (): Prisma.StaffWhereInput => ({
  isActive: true,
  firedAt: null,
  role: StaffRole.MASTER,
  staffServices: {
    some: {
      service: {
        isActive: true
      }
    }
  },
  OR: [
    { specialistProfile: { is: null } },
    { specialistProfile: { is: { isVisiblePublished: true } } }
  ]
});

const staffCanProvideServices = async (staffId: string, serviceIds: string[]): Promise<boolean> => {
  const totalMappings = await prisma.staffService.count({ where: { staffId } });
  if (totalMappings === 0) {
    return true;
  }

  const uniqueServiceIds = Array.from(new Set(serviceIds));
  const count = await prisma.staffService.count({
    where: {
      staffId,
      serviceId: { in: uniqueServiceIds }
    }
  });

  return count === uniqueServiceIds.length;
};

export const resolveStaffCandidates = async (
  serviceIds: string[],
  staffId?: string,
  anyStaff?: boolean,
  options: { clientVisibleOnly?: boolean } = {}
): Promise<Array<{ id: string; name: string; role: StaffRole }>> => {
  if (staffId) {
    const staff = await prisma.staff.findFirst({
      where: {
        ...(options.clientVisibleOnly ? getClientVisibleStaffWhere() : {}),
        id: staffId
      }
    });
    if (!staff || !staff.isActive || staff.firedAt) {
      throw notFound('Staff not found or inactive');
    }
    const canProvide = await staffCanProvideServices(staff.id, serviceIds);
    if (!canProvide) {
      throw conflict('Selected staff does not provide all selected services');
    }

    return [{ id: staff.id, name: staff.name, role: staff.role }];
  }

  if (!anyStaff) {
    throw badRequest('Either staffId or anyStaff=true is required');
  }

  const staff = await prisma.staff.findMany({
    where: options.clientVisibleOnly
      ? getClientVisibleStaffWhere()
      : {
        isActive: true,
        firedAt: null,
        role: { in: ['MASTER', 'ADMIN', 'OWNER', 'DEVELOPER', 'SMM'] }
      },
    orderBy: { name: 'asc' }
  });

  const checks = await Promise.all(
    staff.map(async (member) => ({
      staff: member,
      can: await staffCanProvideServices(member.id, serviceIds)
    }))
  );

  return checks
    .filter((item) => item.can)
    .map((item) => ({ id: item.staff.id, name: item.staff.name, role: item.staff.role }));
};

type NormalizedDiscount = {
  type: DiscountType;
  value: Prisma.Decimal | null;
};

export const normalizeDiscount = (
  clientDiscountType: DiscountType,
  clientDiscountValue: Prisma.Decimal | null,
  override?: DiscountOverrideInput
): NormalizedDiscount => {
  if (override) {
    if (override.type === DiscountType.NONE) {
      return { type: DiscountType.NONE, value: null };
    }

    const value = D(override.value ?? 0);
    if (value.lessThan(0)) {
      throw badRequest('Discount value must be >= 0');
    }

    if (override.type === DiscountType.PERCENT && value.greaterThan(100)) {
      return { type: DiscountType.PERCENT, value: D(100) };
    }

    return { type: override.type, value };
  }

  if (clientDiscountType === DiscountType.NONE || !clientDiscountValue) {
    return { type: DiscountType.NONE, value: null };
  }

  return {
    type: clientDiscountType,
    value: clientDiscountValue
  };
};

export type PriceCalculation = {
  baseTotal: Prisma.Decimal;
  discountTypeSnapshot: DiscountType;
  discountValueSnapshot: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal;
  finalTotal: Prisma.Decimal;
  serviceFinalPrices: Prisma.Decimal[];
};

export const calculatePrices = (
  services: ServiceSnapshot[],
  discount: NormalizedDiscount
): PriceCalculation => {
  const basePrices = services.map((service) => service.price);
  const baseTotal = basePrices.reduce((acc, price) => acc.plus(price), zero());
  const serviceFinalPrices = [...basePrices];

  if (discount.type === DiscountType.NONE || !discount.value || baseTotal.equals(0)) {
    return {
      baseTotal,
      discountTypeSnapshot: DiscountType.NONE,
      discountValueSnapshot: null,
      discountAmount: zero(),
      finalTotal: baseTotal,
      serviceFinalPrices
    };
  }

  if (discount.type === DiscountType.PERCENT) {
    const pct = discount.value.greaterThan(100) ? D(100) : discount.value;
    for (let i = 0; i < basePrices.length; i += 1) {
      const price = basePrices[i]!;
      const amount = price.mul(pct).div(100).toDecimalPlaces(2);
      serviceFinalPrices[i] = maxZero(price.minus(amount));
    }

    const finalTotal = serviceFinalPrices.reduce((acc, price) => acc.plus(price), zero());
    const discountAmount = baseTotal.minus(finalTotal).toDecimalPlaces(2);
    return {
      baseTotal,
      discountTypeSnapshot: discountAmount.equals(0) ? DiscountType.NONE : DiscountType.PERCENT,
      discountValueSnapshot: discountAmount.equals(0) ? null : pct,
      discountAmount,
      finalTotal,
      serviceFinalPrices
    };
  }

  const fixed = discount.value.greaterThan(baseTotal) ? baseTotal : discount.value;
  if (fixed.equals(0)) {
    return {
      baseTotal,
      discountTypeSnapshot: DiscountType.NONE,
      discountValueSnapshot: null,
      discountAmount: zero(),
      finalTotal: baseTotal,
      serviceFinalPrices
    };
  }

  let remainingDiscount = fixed;

  for (let i = 0; i < basePrices.length; i += 1) {
    const price = basePrices[i]!;
    let allocated = zero();

    if (i === basePrices.length - 1) {
      allocated = remainingDiscount;
    } else {
      allocated = price.mul(fixed).div(baseTotal).toDecimalPlaces(2);
      if (allocated.greaterThan(remainingDiscount)) {
        allocated = remainingDiscount;
      }
    }

    serviceFinalPrices[i] = maxZero(price.minus(allocated));
    remainingDiscount = maxZero(remainingDiscount.minus(allocated));
  }

  const finalTotal = serviceFinalPrices.reduce((acc, price) => acc.plus(price), zero());
  const discountAmount = baseTotal.minus(finalTotal).toDecimalPlaces(2);

  return {
    baseTotal,
    discountTypeSnapshot: discountAmount.equals(0) ? DiscountType.NONE : DiscountType.FIXED,
    discountValueSnapshot: discountAmount.equals(0) ? null : discountAmount,
    discountAmount,
    finalTotal,
    serviceFinalPrices
  };
};

export const buildApiAppointmentExternalId = (
  staffId: string,
  clientId: string,
  startAt: Date,
  serviceIds: string[]
): string => {
  return sha1(['api', staffId, clientId, startAt.toISOString(), ...serviceIds.sort()].join('|'));
};

export const deleteAppointmentsCascade = async (
  db: Prisma.TransactionClient,
  appointmentIds: string[]
): Promise<number> => {
  const uniqueAppointmentIds = Array.from(new Set(appointmentIds.filter(Boolean)));
  if (uniqueAppointmentIds.length === 0) {
    return 0;
  }

  const redemptions = await db.promoCodeRedemption.findMany({
    where: {
      appointmentId: {
        in: uniqueAppointmentIds
      }
    },
    select: {
      promoCodeId: true
    }
  });

  const promoUsageById = new Map<string, number>();
  redemptions.forEach((redemption) => {
    promoUsageById.set(
      redemption.promoCodeId,
      (promoUsageById.get(redemption.promoCodeId) ?? 0) + 1
    );
  });

  if (promoUsageById.size > 0) {
    const promoCodes = await db.promoCode.findMany({
      where: {
        id: {
          in: Array.from(promoUsageById.keys())
        }
      },
      select: {
        id: true,
        usedCount: true
      }
    });

    await Promise.all(
      promoCodes.map((promoCode) =>
        db.promoCode.update({
          where: { id: promoCode.id },
          data: {
            usedCount: Math.max(0, promoCode.usedCount - (promoUsageById.get(promoCode.id) ?? 0))
          }
        })
      )
    );
  }

  const result = await db.appointment.deleteMany({
    where: {
      id: {
        in: uniqueAppointmentIds
      }
    }
  });

  return result.count;
};
