import fs from 'node:fs';

import { Prisma, PushEnvironment } from '@prisma/client';
import jwt from 'jsonwebtoken';

import { env } from '../../config/env';
import { prisma } from '../../db/prisma';

const APNS_AUTH_TOKEN_TTL_MS = 50 * 60 * 1000;
const APNS_SANDBOX_HOST = 'https://api.development.push.apple.com';
const APNS_PRODUCTION_HOST = 'https://api.push.apple.com';
const APNS_PRUNE_REASONS = new Set([
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'Unregistered',
]);

type PushDevice = {
  id: string;
  token: string;
  environment: PushEnvironment;
};

let cachedAuthToken: { value: string; issuedAt: number } | null = null;
let cachedPrivateKey: string | null = null;

const resolvePrivateKey = (): string => {
  if (cachedPrivateKey) {
    return cachedPrivateKey;
  }

  if (env.APNS_PRIVATE_KEY?.trim()) {
    cachedPrivateKey = env.APNS_PRIVATE_KEY.replace(/\\n/g, '\n').trim();
    return cachedPrivateKey;
  }

  if (env.APNS_PRIVATE_KEY_PATH?.trim()) {
    cachedPrivateKey = fs.readFileSync(env.APNS_PRIVATE_KEY_PATH, 'utf8').trim();
    return cachedPrivateKey;
  }

  throw new Error('APNS private key is not configured');
};

const getAuthToken = (): string => {
  if (
    cachedAuthToken &&
    Date.now() - cachedAuthToken.issuedAt < APNS_AUTH_TOKEN_TTL_MS
  ) {
    return cachedAuthToken.value;
  }

  const token = jwt.sign({}, resolvePrivateKey(), {
    algorithm: 'ES256',
    issuer: env.APNS_TEAM_ID!,
    header: {
      alg: 'ES256',
      kid: env.APNS_KEY_ID!,
    },
  });

  cachedAuthToken = {
    value: token,
    issuedAt: Date.now(),
  };

  return token;
};

const apnsHost = (environment: PushEnvironment) =>
  environment === PushEnvironment.SANDBOX ? APNS_SANDBOX_HOST : APNS_PRODUCTION_HOST;

const parseApnsReason = async (response: Response): Promise<string | null> => {
  try {
    const payload = (await response.json()) as { reason?: string };
    return payload.reason?.trim() || null;
  } catch {
    return null;
  }
};

const shouldPruneDevice = (statusCode: number, reason: string | null): boolean => {
  if (statusCode === 410) {
    return true;
  }
  if (statusCode === 400 && reason && APNS_PRUNE_REASONS.has(reason)) {
    return true;
  }
  return false;
};

export const pushNotificationsEnabled = (): boolean => env.APNS_ENABLED;

export const sendPushAlert = async (input: {
  dispatchKey: string;
  notificationId: string;
  device: PushDevice;
  title: string;
  body: string;
  payload?: Prisma.InputJsonValue;
}) => {
  if (!pushNotificationsEnabled()) {
    return false;
  }

  const existing = await prisma.pushDispatch.findUnique({
    where: { dispatchKey: input.dispatchKey },
    select: { id: true },
  });
  if (existing) {
    return false;
  }

  const response = await fetch(`${apnsHost(input.device.environment)}/3/device/${input.device.token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${getAuthToken()}`,
      'apns-topic': env.APNS_BUNDLE_ID!,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      aps: {
        alert: {
          title: input.title,
          body: input.body,
        },
        sound: 'default',
      },
      data: input.payload ?? {},
    }),
  }).catch((error) => {
    console.error('APNS request failed', error);
    return null;
  });

  if (!response) {
    return false;
  }

  if (response.ok) {
    try {
      await prisma.pushDispatch.create({
        data: {
          dispatchKey: input.dispatchKey,
          notificationId: input.notificationId,
          staffPushDeviceId: input.device.id,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return false;
      }
      throw error;
    }

    return true;
  }

  const reason = await parseApnsReason(response);
  if (shouldPruneDevice(response.status, reason)) {
    await prisma.staffPushDevice.deleteMany({
      where: { id: input.device.id },
    });
  }

  console.error('APNS delivery rejected', {
    status: response.status,
    reason,
    notificationId: input.notificationId,
    deviceId: input.device.id,
  });

  return false;
};
