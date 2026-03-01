import { prisma } from '../../db/prisma';

const APP_CONFIG_SINGLETON = 'default';

export const getOrCreateAppConfig = async () => {
  return prisma.appConfig.upsert({
    where: { singleton: APP_CONFIG_SINGLETON },
    update: {},
    create: {
      singleton: APP_CONFIG_SINGLETON,
      clientCancelMinNoticeMinutes: 120
    }
  });
};

export const updateClientCancelMinNoticeMinutes = async (minutes: number) => {
  return prisma.appConfig.upsert({
    where: { singleton: APP_CONFIG_SINGLETON },
    update: { clientCancelMinNoticeMinutes: minutes },
    create: {
      singleton: APP_CONFIG_SINGLETON,
      clientCancelMinNoticeMinutes: minutes
    }
  });
};
