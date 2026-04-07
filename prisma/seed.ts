import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient, StaffRole } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS: Array<{ code: string; description: string }> = [
  { code: 'MANAGE_SERVICES', description: 'Create and update services' },
  { code: 'MANAGE_SCHEDULE', description: 'Manage working hours and blocks' },
  { code: 'MANAGE_APPOINTMENTS', description: 'Move and cancel appointments' },
  { code: 'MANAGE_STAFF', description: 'Create staff and assign roles' },
  { code: 'VIEW_REPORTS', description: 'View analytical reports' },
  { code: 'VIEW_FINANCIAL_STATS', description: 'View financial statistics' },
  { code: 'MANAGE_PERMISSIONS', description: 'Grant and revoke custom permissions' },
  { code: 'MANAGE_CLIENT_DISCOUNTS', description: 'Manage permanent and temporary client discounts' },
  { code: 'MANAGE_CLIENT_AVATARS', description: 'Upload, replace and delete client avatars' },
  { code: 'MANAGE_PROMOCODES', description: 'Create, update and deactivate promo codes' },
  { code: 'MANAGE_CLIENT_FRONT', description: 'Manage client-facing content and settings' },
  { code: 'MANAGE_MEDIA', description: 'Upload and manage client-facing media assets' },
  { code: 'PUBLISH_CLIENT_FRONT', description: 'Publish draft client content to production' }
];

const normalizePhone10 = (raw: string): string => {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) {
    throw new Error('OWNER_PHONE must contain at least 10 digits');
  }
  return digits.slice(-10);
};

const run = async () => {
  const ownerEmail = process.env.OWNER_EMAIL?.toLowerCase() ?? process.env.DIRECTOR_EMAIL?.toLowerCase();
  const ownerName = process.env.OWNER_NAME ?? process.env.DIRECTOR_NAME;
  const ownerPin = process.env.OWNER_PIN ?? process.env.DIRECTOR_PIN;
  const ownerPhoneRaw = process.env.OWNER_PHONE ?? process.env.DIRECTOR_PHONE ?? '';
  const ownerPhone10 = normalizePhone10(ownerPhoneRaw);
  const ownerPhoneE164 = `+7${ownerPhone10}`;

  if (!ownerName || !ownerPin) {
    throw new Error(
      'OWNER_NAME, OWNER_PIN and OWNER_PHONE must be set (DIRECTOR_* variables are supported as fallback)'
    );
  }

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { description: permission.description },
      create: permission
    });
  }

  await prisma.position.upsert({
    where: { name: 'Разработчик' },
    update: { isActive: true },
    create: { name: 'Разработчик' }
  });

  const pinHash = await bcrypt.hash(ownerPin, 10);

  const existingByPhone = await prisma.staff.findUnique({ where: { phone10: ownerPhone10 } });
  const existingByEmail = ownerEmail ? await prisma.staff.findUnique({ where: { email: ownerEmail } }) : null;
  const firstOwner = await prisma.staff.findFirst({
    where: { role: StaffRole.OWNER },
    orderBy: { createdAt: 'asc' }
  });

  const targetOwnerId = existingByPhone?.id ?? existingByEmail?.id ?? firstOwner?.id ?? null;

  if (targetOwnerId) {
    await prisma.staff.update({
      where: { id: targetOwnerId },
      data: {
        email: ownerEmail,
        name: ownerName,
        role: StaffRole.OWNER,
        pinHash,
        phone10: ownerPhone10,
        phoneE164: ownerPhoneE164,
        isActive: true,
        receivesAllAppointmentNotifications: true,
        firedAt: null
      }
    });
  } else {
    await prisma.staff.create({
      data: {
        email: ownerEmail,
        name: ownerName,
        role: StaffRole.OWNER,
        pinHash,
        phone10: ownerPhone10,
        phoneE164: ownerPhoneE164,
        isActive: true,
        receivesAllAppointmentNotifications: true
      }
    });
  }
};

run()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
