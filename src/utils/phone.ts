import { badRequest } from './errors';

export function normalizePhone10(phoneRaw: string): string {
  const digits = String(phoneRaw ?? '').replace(/\D/g, '');
  if (!digits) {
    throw badRequest('Phone is required');
  }

  let phone10 = digits;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    phone10 = digits.slice(1);
  }

  if (!/^\d{10}$/.test(phone10)) {
    throw badRequest('Phone must contain 10 digits after normalization', { input: phoneRaw });
  }

  return phone10;
}

export function toPhoneE164(phone10: string): string {
  if (!/^\d{10}$/.test(phone10)) {
    throw badRequest('Phone10 must be 10 digits');
  }
  return `+7${phone10}`;
}
