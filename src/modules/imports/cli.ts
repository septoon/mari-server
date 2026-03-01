import fs from 'fs/promises';
import path from 'path';

import { prisma } from '../../db/prisma';
import {
  importAppointmentsFromBuffer,
  importClientsFromBuffer,
  importServicesFromBuffer
} from './service';

type Mode = 'clients' | 'services' | 'appointments';

const mode = process.argv[2] as Mode | undefined;
const customPath = process.argv[3];

const pickExistingPath = async (candidates: string[]): Promise<string | null> => {
  for (const filePath of candidates) {
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // noop
    }
  }
  return null;
};

const resolveInputPath = async (kind: Mode, explicit?: string): Promise<string> => {
  if (explicit) return path.resolve(explicit);

  const map: Record<Mode, string[]> = {
    clients: ['data/clients.xlsx', 'data/clients.xls'],
    services: ['data/services.xlsx', 'data/services.xls'],
    appointments: [
      'data/appointments-report.xlsx',
      'data/appointments-report.xls',
      'data/Отчет_по_записям.xlsx',
      'data/Отчет_по_записям.xls'
    ]
  };

  const found = await pickExistingPath(map[kind].map((p) => path.resolve(p)));
  if (!found) {
    throw new Error(`Input file not found for ${kind}. Provide path explicitly.`);
  }
  return found;
};

const resolveUploaderStaffId = async (): Promise<string> => {
  if (process.env.IMPORT_UPLOADED_BY_STAFF_ID) {
    return process.env.IMPORT_UPLOADED_BY_STAFF_ID;
  }

  const owner = await prisma.staff.findFirst({ where: { role: 'OWNER' }, orderBy: { createdAt: 'asc' } });
  if (owner) return owner.id;

  const anyStaff = await prisma.staff.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!anyStaff) {
    throw new Error('No staff found. Seed OWNER first.');
  }

  return anyStaff.id;
};

const run = async () => {
  if (!mode || !['clients', 'services', 'appointments'].includes(mode)) {
    throw new Error(
      'Usage: tsx src/modules/imports/cli.ts <clients|services|appointments> [filePath]'
    );
  }

  const uploaderId = await resolveUploaderStaffId();
  const inputPath = await resolveInputPath(mode, customPath);
  const buffer = await fs.readFile(inputPath);

  if (mode === 'clients') {
    const result = await importClientsFromBuffer(buffer, uploaderId);
    console.log(result);
  } else if (mode === 'services') {
    const result = await importServicesFromBuffer(buffer, uploaderId);
    console.log(result);
  } else {
    const result = await importAppointmentsFromBuffer(buffer, uploaderId);
    console.log(result);
  }
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
