import { prisma } from '../../db/prisma';
import { normalizePhone10, toPhoneE164 } from '../../utils/phone';

export const upsertClientByPhone = async (phoneRaw: string, name?: string | null) => {
  const phone10 = normalizePhone10(phoneRaw);
  const phoneE164 = toPhoneE164(phone10);
  const trimmedName = name?.trim() || null;

  const existing = await prisma.client.findUnique({ where: { phone10 } });
  if (!existing) {
    return prisma.client.create({
      data: {
        phone10,
        phoneE164,
        name: trimmedName
      }
    });
  }

  const currentName = existing.name ?? '';
  const nextName = !currentName || (trimmedName && trimmedName.length > currentName.length) ? trimmedName : existing.name;

  return prisma.client.update({
    where: { id: existing.id },
    data: {
      name: nextName,
      phoneE164
    }
  });
};
