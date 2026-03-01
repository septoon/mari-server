import { Prisma } from '@prisma/client';

export const D = (value: Prisma.Decimal | string | number): Prisma.Decimal =>
  new Prisma.Decimal(value);

export const zero = (): Prisma.Decimal => new Prisma.Decimal(0);

export const maxZero = (value: Prisma.Decimal): Prisma.Decimal => {
  return value.lessThan(0) ? zero() : value;
};

export const toNumber = (value: Prisma.Decimal): number => Number(value.toFixed(2));
