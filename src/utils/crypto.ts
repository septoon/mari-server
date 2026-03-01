import { createHash, randomBytes } from 'crypto';

export const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');

export const hashToken = (token: string): string => sha1(token);

export const randomToken = (): string => randomBytes(32).toString('hex');
