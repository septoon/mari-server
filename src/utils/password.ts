import bcrypt from 'bcrypt';
import { badRequest } from './errors';

const SALT_ROUNDS = 10;

export const hashSecret = async (plain: string): Promise<string> => {
  return bcrypt.hash(plain, SALT_ROUNDS);
};

export const verifySecret = async (plain: string, hash: string): Promise<boolean> => {
  return bcrypt.compare(plain, hash);
};

export const validatePin = (pin: string): void => {
  if (!/^\d{4,8}$/.test(pin)) {
    throw badRequest('PIN must be 4-8 digits');
  }
};

export const validatePassword = (password: string): void => {
  if (password.length < 8) {
    throw badRequest('Password must be at least 8 characters');
  }
};
