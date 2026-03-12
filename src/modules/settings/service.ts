import { prisma } from '../../db/prisma';
import {
  DEFAULT_NOTIFICATION_TOGGLES,
  NOTIFICATION_ID_SET,
  NOTIFICATION_SECTIONS,
} from '../notifications/catalog';

const APP_CONFIG_SINGLETON = 'default';

export type NotificationToggleMap = Record<string, boolean>;

export const normalizeNotificationSettings = (value: unknown): NotificationToggleMap => {
  const normalized: NotificationToggleMap = { ...DEFAULT_NOTIFICATION_TOGGLES };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return normalized;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, rawValue]) => {
    if (!NOTIFICATION_ID_SET.has(key) || typeof rawValue !== 'boolean') {
      return;
    }
    normalized[key] = rawValue;
  });

  return normalized;
};

export const getOrCreateAppConfig = async () => {
  return prisma.appConfig.upsert({
    where: { singleton: APP_CONFIG_SINGLETON },
    update: {},
    create: {
      singleton: APP_CONFIG_SINGLETON,
      clientCancelMinNoticeMinutes: 120,
      notificationMinNoticeMinutes: 120,
      notificationSettings: DEFAULT_NOTIFICATION_TOGGLES,
      privacyPolicy: '',
    },
  });
};

export const buildSettingsResponse = (
  config: Awaited<ReturnType<typeof getOrCreateAppConfig>>,
) => {
  const toggles = normalizeNotificationSettings(config.notificationSettings);
  return {
    clientCancelMinNoticeMinutes: config.clientCancelMinNoticeMinutes,
    clientCancelPolicy: {
      minNoticeMinutes: config.clientCancelMinNoticeMinutes,
    },
    notificationMinNoticeMinutes: config.notificationMinNoticeMinutes,
    notifications: {
      minNoticeMinutes: config.notificationMinNoticeMinutes,
      sections: NOTIFICATION_SECTIONS.map((section) => ({
        id: section.id,
        title: section.title,
        groups: section.groups.map((group) => ({
          id: group.id,
          title: group.title,
          items: group.items.map((item) => ({
            id: item.id,
            title: item.title,
            enabled: toggles[item.id],
            channel: 'email',
            channelLabel: 'Email',
          })),
        })),
      })),
    },
    privacyPolicy: {
      content: config.privacyPolicy,
    },
  };
};

export const updateClientCancelMinNoticeMinutes = async (minutes: number) => {
  return prisma.appConfig.upsert({
    where: { singleton: APP_CONFIG_SINGLETON },
    update: { clientCancelMinNoticeMinutes: minutes },
    create: {
      singleton: APP_CONFIG_SINGLETON,
      clientCancelMinNoticeMinutes: minutes,
      notificationMinNoticeMinutes: 120,
      notificationSettings: DEFAULT_NOTIFICATION_TOGGLES,
      privacyPolicy: '',
    },
  });
};

export const updateNotificationSettings = async (input: {
  minNoticeMinutes?: number;
  toggles?: NotificationToggleMap;
}) => {
  const current = await getOrCreateAppConfig();
  const mergedToggles = {
    ...normalizeNotificationSettings(current.notificationSettings),
    ...(input.toggles ?? {}),
  };

  return prisma.appConfig.upsert({
    where: { singleton: APP_CONFIG_SINGLETON },
    update: {
      notificationMinNoticeMinutes:
        input.minNoticeMinutes ?? current.notificationMinNoticeMinutes,
      notificationSettings: mergedToggles,
    },
    create: {
      singleton: APP_CONFIG_SINGLETON,
      clientCancelMinNoticeMinutes: 120,
      notificationMinNoticeMinutes: input.minNoticeMinutes ?? 120,
      notificationSettings: mergedToggles,
      privacyPolicy: '',
    },
  });
};

export const updatePrivacyPolicy = async (content: string) => {
  return prisma.appConfig.upsert({
    where: { singleton: APP_CONFIG_SINGLETON },
    update: { privacyPolicy: content },
    create: {
      singleton: APP_CONFIG_SINGLETON,
      clientCancelMinNoticeMinutes: 120,
      notificationMinNoticeMinutes: 120,
      notificationSettings: DEFAULT_NOTIFICATION_TOGGLES,
      privacyPolicy: content,
    },
  });
};
