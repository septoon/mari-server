import fs from 'fs/promises';
import path from 'path';

import { prisma } from '../../db/prisma';
import { exportAppointmentsXlsx, exportClientsXlsx, exportServicesXlsx } from './service';

type Mode = 'clients' | 'services' | 'appointments';

const mode = process.argv[2] as Mode | undefined;
const outputPathArg = process.argv[3];
const fromArg = process.argv[4];
const toArg = process.argv[5];

const run = async () => {
  if (!mode || !['clients', 'services', 'appointments'].includes(mode)) {
    throw new Error(
      'Usage: tsx src/modules/exports/cli.ts <clients|services|appointments> [outputPath] [from] [to]'
    );
  }

  const outputPath = path.resolve(
    outputPathArg ?? `data/export-${mode}-${new Date().toISOString().slice(0, 10)}.xlsx`
  );

  let buffer: Buffer;
  if (mode === 'clients') {
    buffer = await exportClientsXlsx();
  } else if (mode === 'services') {
    buffer = await exportServicesXlsx();
  } else {
    const from = fromArg ?? new Date().toISOString().slice(0, 10);
    const to = toArg ?? from;
    buffer = await exportAppointmentsXlsx(from, to);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  console.log({ ok: true, outputPath });
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
