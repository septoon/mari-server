import { Prisma, StaffRole } from '@prisma/client';

import { prisma } from '../../db/prisma';
import { notFound } from '../../utils/errors';

type DbClient = typeof prisma | Prisma.TransactionClient;

export type SpecialistRatingStats = {
  average: number | null;
  count: number;
};

const EMPTY_STATS: SpecialistRatingStats = {
  average: null,
  count: 0
};

const isMissingSpecialistRatingsStorage = (error: unknown) => {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2021' || error.code === 'P2022')
  );
};

const normalizeAverage = (value: number | null): number | null => {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 10) / 10;
};

export const getSpecialistRatingStats = (
  statsByStaffId: Map<string, SpecialistRatingStats>,
  staffId: string
): SpecialistRatingStats => {
  return statsByStaffId.get(staffId) ?? EMPTY_STATS;
};

export const listSpecialistRatingStats = async (
  db: DbClient,
  staffIds: string[]
): Promise<Map<string, SpecialistRatingStats>> => {
  if (staffIds.length === 0) {
    return new Map();
  }

  try {
    const rows = await db.specialistRating.groupBy({
      by: ['staffId'],
      where: {
        staffId: {
          in: staffIds
        }
      },
      _avg: {
        value: true
      },
      _count: {
        _all: true
      }
    });

    return new Map(
      rows.map((row) => [
        row.staffId,
        {
          average: normalizeAverage(row._avg.value),
          count: row._count._all
        }
      ])
    );
  } catch (error) {
    if (isMissingSpecialistRatingsStorage(error)) {
      return new Map();
    }
    throw error;
  }
};

export const submitSpecialistRating = async (
  db: DbClient,
  staffId: string,
  clientId: string,
  value: number
) => {
  const specialist = await db.staff.findFirst({
    where: {
      id: staffId,
      role: StaffRole.MASTER,
      isActive: true,
      firedAt: null,
      deletedAt: null
    },
    select: {
      id: true
    }
  });

  if (!specialist) {
    throw notFound('Specialist not found');
  }

  await db.specialistRating.upsert({
    where: {
      clientId_staffId: {
        clientId,
        staffId
      }
    },
    update: {
      value
    },
    create: {
      clientId,
      staffId,
      value
    }
  });

  const stats = getSpecialistRatingStats(await listSpecialistRatingStats(db, [staffId]), staffId);

  return {
    staffId,
    rating: {
      average: stats.average,
      count: stats.count,
      submittedValue: value
    }
  };
};
