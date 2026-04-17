import { ClientContentStatus, ClientPlatform, Prisma, StaffRole } from '@prisma/client';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import type { z } from 'zod';

import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { badRequest, businessRule, conflict, notFound } from '../../utils/errors';
import {
  blockPayloadSchemaByType,
  contactPointSchema,
  createMediaUsageSchema,
  featureFlagsSchema,
  type PlatformInput
} from './schemas';
import { validateClientFrontExtra } from './extra';
import { migrateLegacyBookingContent } from './legacy-booking-migration';

const CLIENT_APP_CONFIG_SINGLETON = 'default';
const MEDIA_MIME_WHITELIST: Record<string, Array<'jpeg' | 'png' | 'webp' | 'heic' | 'avif'>> = {
  'image/jpeg': ['jpeg'],
  'image/jpg': ['jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/heic': ['heic'],
  'image/heif': ['heic'],
  'image/avif': ['avif']
};

const MEDIA_MIME_ALIASES: Record<string, keyof typeof MEDIA_MIME_WHITELIST> = {
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png'
};

type DbClient = typeof prisma | Prisma.TransactionClient;

type DraftBlockInput = {
  blockKey: string;
  blockType: keyof typeof blockPayloadSchemaByType;
  payload: Record<string, unknown>;
  sortOrder: number;
  platform: PlatformInput;
  minAppVersion?: string;
  maxAppVersion?: string;
  startAt?: string;
  endAt?: string;
  isEnabled: boolean;
};

type UpdateDraftBlockInput = Partial<Omit<DraftBlockInput, 'blockKey'>>;

type DraftConfigPatchInput = {
  brandName?: string;
  legalName?: string;
  minAppVersionIos?: string;
  minAppVersionAndroid?: string;
  maintenanceMode?: boolean;
  maintenanceMessage?: string;
  featureFlags?: Record<string, unknown>;
  contacts?: unknown[];
  extra?: Record<string, unknown>;
};

type PatchSpecialistDraftProfileInput = {
  photoAssetId?: string | null;
  specialty?: string | null;
  info?: string | null;
  ctaText?: string | null;
  isVisible?: boolean;
  sortOrder?: number;
};

type PublishResult = {
  version: number;
  etag: string;
  publishedAt: Date;
  blocksCount: number;
};

type BootstrapResult = {
  version: number;
  etag: string;
  publishedAt: Date | null;
  payload: Record<string, unknown>;
};

type ContactPoint = z.infer<typeof contactPointSchema>;

const mediaRoot = path.resolve(env.MEDIA_ROOT);
const mediaPublicBase = env.MEDIA_PUBLIC_BASE;

const enumFromPlatformInput: Record<PlatformInput, ClientPlatform> = {
  all: ClientPlatform.ALL,
  ios: ClientPlatform.IOS,
  android: ClientPlatform.ANDROID,
  web: ClientPlatform.WEB
};

const platformOutputMap: Record<ClientPlatform, PlatformInput> = {
  ALL: 'all',
  IOS: 'ios',
  ANDROID: 'android',
  WEB: 'web'
};

const specialistPhotoInclude = {
  variants: {
    orderBy: { width: 'asc' as const }
  }
};

const specialistStaffInclude = {
  position: true,
  staffServices: {
    include: {
      service: {
        include: {
          category: true
        }
      }
    },
    orderBy: {
      service: {
        name: 'asc' as const
      }
    }
  },
  specialistProfile: {
    include: {
      photoDraft: { include: specialistPhotoInclude },
      photoPublished: { include: specialistPhotoInclude }
    }
  }
} satisfies Prisma.StaffInclude;

type SpecialistStaffRow = Prisma.StaffGetPayload<{
  include: typeof specialistStaffInclude;
}>;

type SpecialistStage = 'DRAFT' | 'PUBLISHED';

const valueToJson = (value: unknown): Prisma.InputJsonValue => {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
};

const readJsonObject = (value: Prisma.JsonValue | null | undefined): Record<string, unknown> => {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return {};
  }
  return value as Record<string, unknown>;
};

const readJsonArray = (value: Prisma.JsonValue | null | undefined): unknown[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value;
};

const parseContactPoints = (value: Prisma.JsonValue | null | undefined): ContactPoint[] => {
  const parsed: ContactPoint[] = [];
  for (const item of readJsonArray(value)) {
    const result = contactPointSchema.safeParse(item);
    if (result.success) {
      parsed.push(result.data);
    }
  }
  return parsed;
};

const parseVersion = (value: string): number[] => {
  return value
    .split('.')
    .map((part) => Number(part.trim()))
    .map((part) => (Number.isFinite(part) && part >= 0 ? part : 0));
};

const compareVersions = (a: string, b: string): number => {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  const length = Math.max(av.length, bv.length);

  for (let idx = 0; idx < length; idx += 1) {
    const left = av[idx] ?? 0;
    const right = bv[idx] ?? 0;
    if (left > right) return 1;
    if (left < right) return -1;
  }

  return 0;
};

const versionMatches = (currentVersion: string | undefined, minVersion?: string | null, maxVersion?: string | null): boolean => {
  if (!minVersion && !maxVersion) {
    return true;
  }
  if (!currentVersion) {
    return false;
  }

  if (minVersion && compareVersions(currentVersion, minVersion) < 0) {
    return false;
  }
  if (maxVersion && compareVersions(currentVersion, maxVersion) > 0) {
    return false;
  }

  return true;
};

const timeMatches = (pointInTime: Date, startAt?: Date | null, endAt?: Date | null): boolean => {
  if (startAt && pointInTime < startAt) {
    return false;
  }
  if (endAt && pointInTime > endAt) {
    return false;
  }
  return true;
};

const platformMatches = (requestPlatform: ClientPlatform, blockPlatform: ClientPlatform): boolean => {
  if (requestPlatform === ClientPlatform.ALL) {
    return true;
  }
  return blockPlatform === ClientPlatform.ALL || blockPlatform === requestPlatform;
};

const ensureMediaPathSafe = (relativePath: string): string => {
  const absolutePath = path.resolve(mediaRoot, relativePath);
  if (absolutePath === mediaRoot || absolutePath.startsWith(`${mediaRoot}${path.sep}`)) {
    return absolutePath;
  }
  throw badRequest('Invalid media path');
};

const toMediaUrlPath = (relativePath: string): string => {
  return path.posix.join(mediaPublicBase, relativePath.replaceAll('\\', '/'));
};

const toMediaPublicUrl = (urlPath: string): string => {
  if (!env.MEDIA_PUBLIC_ORIGIN) {
    return urlPath;
  }
  return `${env.MEDIA_PUBLIC_ORIGIN.replace(/\/+$/, '')}${urlPath}`;
};

const IMAGE_ASSET_KEY = 'imageAssetId';
const IMAGE_URL_KEY = 'imageUrl';

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const collectImageAssetIdsDeep = (value: unknown, ids: Set<string>) => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageAssetIdsDeep(item, ids));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  const assetId = typeof record[IMAGE_ASSET_KEY] === 'string' ? record[IMAGE_ASSET_KEY] : null;
  if (assetId && isUuid(assetId)) {
    ids.add(assetId);
  }

  Object.values(record).forEach((item) => collectImageAssetIdsDeep(item, ids));
};

const resolveImageUrlForAsset = (asset: {
  originalPath: string;
  variants: Array<{ width: number; urlPath: string; path: string }>;
}) => {
  const preferred = [...asset.variants].sort((left, right) => left.width - right.width).at(-1) ?? null;
  if (preferred?.urlPath) {
    return toMediaPublicUrl(preferred.urlPath);
  }
  if (preferred?.path) {
    return toMediaPublicUrl(toMediaUrlPath(preferred.path));
  }
  return toMediaPublicUrl(toMediaUrlPath(asset.originalPath));
};

const buildImageAssetUrlMap = async (value: unknown) => {
  const ids = new Set<string>();
  collectImageAssetIdsDeep(value, ids);

  if (ids.size === 0) {
    return new Map<string, string>();
  }

  const assets = await prisma.mediaAsset.findMany({
    where: { id: { in: Array.from(ids) } },
    select: {
      id: true,
      originalPath: true,
      variants: {
        select: {
          width: true,
          path: true,
          urlPath: true,
        },
      },
    },
  });

  return new Map(assets.map((asset) => [asset.id, resolveImageUrlForAsset(asset)]));
};

const attachImageUrlsDeep = (value: unknown, assetUrlMap: Map<string, string>): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => attachImageUrlsDeep(item, assetUrlMap));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const nextRecord: Record<string, unknown> = {};

  Object.entries(record).forEach(([key, item]) => {
    nextRecord[key] = attachImageUrlsDeep(item, assetUrlMap);
  });

  const assetId = typeof record[IMAGE_ASSET_KEY] === 'string' ? record[IMAGE_ASSET_KEY] : null;
  if (assetId && assetUrlMap.has(assetId)) {
    nextRecord[IMAGE_URL_KEY] = assetUrlMap.get(assetId);
  }

  return nextRecord;
};

const getOrCreateClientAppConfig = async (db: DbClient = prisma) => {
  return db.clientAppConfig.upsert({
    where: { singleton: CLIENT_APP_CONFIG_SINGLETON },
    update: {},
    create: {
      singleton: CLIENT_APP_CONFIG_SINGLETON,
      featureFlagsDraft: valueToJson({}),
      contactsDraft: valueToJson([]),
      extraDraft: valueToJson({}),
      featureFlagsPublished: valueToJson({}),
      contactsPublished: valueToJson([]),
      extraPublished: valueToJson({})
    }
  });
};

const validatePayloadByType = (blockType: keyof typeof blockPayloadSchemaByType, payload: Record<string, unknown>) => {
  const schema = blockPayloadSchemaByType[blockType];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw badRequest('Invalid block payload', parsed.error.flatten());
  }
  return parsed.data;
};

const mapBlockToApi = (block: {
  id: string;
  blockKey: string;
  blockType: string;
  payload: Prisma.JsonValue;
  sortOrder: number;
  status: ClientContentStatus;
  platform: ClientPlatform;
  minAppVersion: string | null;
  maxAppVersion: string | null;
  startAt: Date | null;
  endAt: Date | null;
  isEnabled: boolean;
  releaseId: string | null;
  createdAt: Date;
  updatedAt: Date;
}, assetUrlMap?: Map<string, string>) => {
  return {
    id: block.id,
    blockKey: block.blockKey,
    blockType: block.blockType,
    payload: assetUrlMap ? attachImageUrlsDeep(block.payload, assetUrlMap) : block.payload,
    sortOrder: block.sortOrder,
    status: block.status.toLowerCase(),
    platform: platformOutputMap[block.platform],
    minAppVersion: block.minAppVersion,
    maxAppVersion: block.maxAppVersion,
    startAt: block.startAt,
    endAt: block.endAt,
    isEnabled: block.isEnabled,
    releaseId: block.releaseId,
    createdAt: block.createdAt,
    updatedAt: block.updatedAt
  };
};

const mapSpecialistPhoto = (
  asset:
    | (SpecialistStaffRow['specialistProfile'] extends infer P
        ? P extends { photoDraft: infer A | null }
          ? A
          : never
        : never)
    | null
    | undefined
) => {
  if (!asset) return null;

  const variants = [...asset.variants]
    .sort((left, right) => left.width - right.width)
    .map((variant) => ({
      id: variant.id,
      format: variant.format,
      width: variant.width,
      height: variant.height,
      path: variant.path,
      urlPath: variant.urlPath,
      url: toMediaPublicUrl(variant.urlPath),
      size: variant.size
    }));

  const preferred = variants[variants.length - 1] ?? null;
  const originalUrlPath = toMediaUrlPath(asset.originalPath);

  return {
    assetId: asset.id,
    originalUrlPath,
    originalUrl: toMediaPublicUrl(originalUrlPath),
    preferredUrlPath: preferred?.urlPath ?? null,
    preferredUrl: preferred?.url ?? toMediaPublicUrl(originalUrlPath),
    variants
  };
};

const getSpecialistStageData = (row: SpecialistStaffRow, stage: SpecialistStage) => {
  const profile = row.specialistProfile;
  const fallbackSpecialty = row.position?.name ?? null;

  if (stage === 'DRAFT') {
    return {
      specialty: profile?.specialtyDraft ?? fallbackSpecialty,
      info: profile?.infoDraft ?? null,
      ctaText: profile?.ctaTextDraft ?? 'Записаться',
      isVisible: profile?.isVisibleDraft ?? true,
      sortOrder: profile?.sortOrderDraft ?? 0,
      photoAssetId: profile?.photoAssetIdDraft ?? null,
      photoAsset: profile?.photoDraft ?? null
    };
  }

  return {
    specialty: profile?.specialtyPublished ?? fallbackSpecialty,
    info: profile?.infoPublished ?? null,
    ctaText: profile?.ctaTextPublished ?? 'Записаться',
    isVisible: profile?.isVisiblePublished ?? true,
    sortOrder: profile?.sortOrderPublished ?? 0,
    photoAssetId: profile?.photoAssetIdPublished ?? profile?.photoAssetIdDraft ?? null,
    photoAsset: profile?.photoPublished ?? profile?.photoDraft ?? null
  };
};

const buildSpecialistCard = (row: SpecialistStaffRow, stage: SpecialistStage) => {
  const stageData = getSpecialistStageData(row, stage);
  const services = row.staffServices
    .filter((rowService) => rowService.service.isActive)
    .map((rowService) => ({
      id: rowService.service.id,
      name: rowService.service.name,
      durationSec: rowService.service.durationSec,
      priceMin: rowService.service.priceMin,
      priceMax: rowService.service.priceMax,
      category: {
        id: rowService.service.category.id,
        name: rowService.service.category.name
      }
    }));

  return {
    staffId: row.id,
    name: row.name,
    specialty: stageData.specialty,
    info: stageData.info,
    ctaText: stageData.ctaText,
    isVisible: stageData.isVisible,
    sortOrder: stageData.sortOrder,
    photoAssetId: stageData.photoAssetId,
    photo: mapSpecialistPhoto(stageData.photoAsset),
    services,
    isActive: row.isActive,
    firedAt: row.firedAt,
    updatedAt: row.specialistProfile?.updatedAt ?? row.updatedAt
  };
};

const hasActiveServices = (card: ReturnType<typeof buildSpecialistCard>) => card.services.length > 0;

const listSpecialistCards = async (
  db: DbClient,
  stage: SpecialistStage,
  options: { includeHidden: boolean; onlyActive: boolean; onlyWithServices?: boolean; staffId?: string }
) => {
  const rows = await db.staff.findMany({
    where: {
      role: StaffRole.MASTER,
      ...(options.staffId ? { id: options.staffId } : {}),
      ...(options.onlyActive
        ? {
            isActive: true,
            firedAt: null
          }
        : {})
    },
    include: specialistStaffInclude,
    orderBy: [{ name: 'asc' }]
  });

  return rows
    .map((row) => buildSpecialistCard(row, stage))
    .filter((row) => options.includeHidden || row.isVisible)
    .filter((row) => !options.onlyWithServices || hasActiveServices(row))
    .sort((left, right) => {
      if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
      }
      return left.name.localeCompare(right.name, 'ru');
    });
};

const buildDraftConfigPayload = (
  config: {
    brandNameDraft: string | null;
    legalNameDraft: string | null;
    minAppVersionIosDraft: string | null;
    minAppVersionAndroidDraft: string | null;
    maintenanceModeDraft: boolean;
    maintenanceMessageDraft: string | null;
    featureFlagsDraft: Prisma.JsonValue;
    contactsDraft: Prisma.JsonValue;
    extraDraft: Prisma.JsonValue;
  },
  currentPlatform: PlatformInput,
  appVersion: string | undefined,
  at: Date,
  resolvedExtra?: Record<string, unknown>
) => {
  const featureFlagsRaw = featureFlagsSchema.safeParse(config.featureFlagsDraft);
  const featureFlags = featureFlagsRaw.success ? featureFlagsRaw.data : {};
  const contacts = parseContactPoints(config.contactsDraft)
    .filter((contact) => {
      const startAt = contact.startAt ? new Date(contact.startAt) : null;
      const endAt = contact.endAt ? new Date(contact.endAt) : null;
      return timeMatches(at, startAt, endAt);
    })
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const requestedPlatform = enumFromPlatformInput[currentPlatform];
  const featureFlagState = Object.entries(featureFlags).reduce<Record<string, boolean>>((acc, [code, details]) => {
    let enabled = details.defaultEnabled;

    for (const rule of details.rules) {
      if (!platformMatches(requestedPlatform, enumFromPlatformInput[rule.platform])) {
        continue;
      }

      if (!versionMatches(appVersion, rule.minVersion, rule.maxVersion)) {
        continue;
      }

      const ruleStart = rule.startAt ? new Date(rule.startAt) : null;
      const ruleEnd = rule.endAt ? new Date(rule.endAt) : null;
      if (!timeMatches(at, ruleStart, ruleEnd)) {
        continue;
      }

      enabled = rule.enabled;
    }

    acc[code] = enabled;
    return acc;
  }, {});

  return {
    brandName: config.brandNameDraft,
    legalName: config.legalNameDraft,
    minAppVersionIos: config.minAppVersionIosDraft,
    minAppVersionAndroid: config.minAppVersionAndroidDraft,
    maintenanceMode: config.maintenanceModeDraft,
    maintenanceMessage: config.maintenanceMessageDraft,
    featureFlags,
    featureFlagState,
    contacts,
    extra: resolvedExtra ?? readJsonObject(config.extraDraft)
  };
};

const buildPublishedConfigPayload = (
  config: {
    brandNamePublished: string | null;
    legalNamePublished: string | null;
    minAppVersionIosPublished: string | null;
    minAppVersionAndroidPublished: string | null;
    maintenanceModePublished: boolean;
    maintenanceMessagePublished: string | null;
    featureFlagsPublished: Prisma.JsonValue;
    contactsPublished: Prisma.JsonValue;
    extraPublished: Prisma.JsonValue;
  },
  currentPlatform: PlatformInput,
  appVersion: string | undefined,
  at: Date,
  resolvedExtra?: Record<string, unknown>
) => {
  const featureFlagsRaw = featureFlagsSchema.safeParse(config.featureFlagsPublished);
  const featureFlags = featureFlagsRaw.success ? featureFlagsRaw.data : {};
  const contacts = parseContactPoints(config.contactsPublished)
    .filter((contact) => {
      const startAt = contact.startAt ? new Date(contact.startAt) : null;
      const endAt = contact.endAt ? new Date(contact.endAt) : null;
      return timeMatches(at, startAt, endAt);
    })
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const requestedPlatform = enumFromPlatformInput[currentPlatform];
  const featureFlagState = Object.entries(featureFlags).reduce<Record<string, boolean>>((acc, [code, details]) => {
    let enabled = details.defaultEnabled;

    for (const rule of details.rules) {
      if (!platformMatches(requestedPlatform, enumFromPlatformInput[rule.platform])) {
        continue;
      }

      if (!versionMatches(appVersion, rule.minVersion, rule.maxVersion)) {
        continue;
      }

      const ruleStart = rule.startAt ? new Date(rule.startAt) : null;
      const ruleEnd = rule.endAt ? new Date(rule.endAt) : null;
      if (!timeMatches(at, ruleStart, ruleEnd)) {
        continue;
      }

      enabled = rule.enabled;
    }

    acc[code] = enabled;
    return acc;
  }, {});

  return {
    brandName: config.brandNamePublished,
    legalName: config.legalNamePublished,
    minAppVersionIos: config.minAppVersionIosPublished,
    minAppVersionAndroid: config.minAppVersionAndroidPublished,
    maintenanceMode: config.maintenanceModePublished,
    maintenanceMessage: config.maintenanceMessagePublished,
    featureFlags,
    featureFlagState,
    contacts,
    extra: resolvedExtra ?? readJsonObject(config.extraPublished)
  };
};

const filterBlocksForClient = (
  blocks: Array<{
    id: string;
    blockKey: string;
    blockType: string;
    payload: Prisma.JsonValue;
    sortOrder: number;
    status: ClientContentStatus;
    platform: ClientPlatform;
    minAppVersion: string | null;
    maxAppVersion: string | null;
    startAt: Date | null;
    endAt: Date | null;
    isEnabled: boolean;
    releaseId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
  platform: PlatformInput,
  appVersion: string | undefined,
  at: Date,
  assetUrlMap?: Map<string, string>,
) => {
  const requestedPlatform = enumFromPlatformInput[platform];

  return blocks
    .filter((block) => block.isEnabled)
    .filter((block) => platformMatches(requestedPlatform, block.platform))
    .filter((block) => versionMatches(appVersion, block.minAppVersion, block.maxAppVersion))
    .filter((block) => timeMatches(at, block.startAt, block.endAt))
    .sort((a, b) => (a.sortOrder === b.sortOrder ? a.createdAt.getTime() - b.createdAt.getTime() : a.sortOrder - b.sortOrder))
    .map((block) => mapBlockToApi(block, assetUrlMap));
};

const writeAuditLog = async (
  db: DbClient,
  actorStaffId: string,
  action: string,
  entityType: string,
  entityId: string,
  diff?: unknown,
  metadata?: unknown
) => {
  await db.auditLog.create({
    data: {
      actorStaffId,
      action,
      entityType,
      entityId,
      diff: diff === undefined ? undefined : valueToJson(diff),
      metadata: metadata === undefined ? undefined : valueToJson(metadata)
    }
  });
};

export const getDraftClientConfig = async (platform: PlatformInput, appVersion?: string, at = new Date()) => {
  const config = await getOrCreateClientAppConfig();
  const blocks = await prisma.clientContentBlock.findMany({
    where: {
      status: ClientContentStatus.DRAFT,
      releaseId: null
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
  });
  const migratedExtra = migrateLegacyBookingContent(
    readJsonObject(config.extraDraft),
    blocks.map((block) => ({
      blockType: block.blockType,
      payload: block.payload
    }))
  );
  const [extraAssetUrlMap, blockAssetUrlMap] = await Promise.all([
    buildImageAssetUrlMap(migratedExtra),
    buildImageAssetUrlMap(blocks.map((block) => block.payload)),
  ]);
  const specialists = await listSpecialistCards(prisma, 'DRAFT', {
    includeHidden: false,
    onlyActive: true,
    onlyWithServices: true
  });

  return {
    stage: 'draft',
    version: config.publishedVersion + 1,
    config: buildDraftConfigPayload(
      config,
      platform,
      appVersion,
      at,
      attachImageUrlsDeep(migratedExtra, extraAssetUrlMap) as Record<string, unknown>,
    ),
    blocks: filterBlocksForClient(blocks, platform, appVersion, at, blockAssetUrlMap),
    specialists
  };
};

export const getDraftClientConfigRaw = async () => {
  const config = await getOrCreateClientAppConfig();
  const blocks = await prisma.clientContentBlock.findMany({
    where: {
      status: ClientContentStatus.DRAFT,
      releaseId: null
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: {
      blockType: true,
      payload: true
    }
  });
  const migratedExtra = migrateLegacyBookingContent(
    readJsonObject(config.extraDraft),
    blocks
  );

  return {
    id: config.id,
    singleton: config.singleton,
    brandName: config.brandNameDraft,
    legalName: config.legalNameDraft,
    minAppVersionIos: config.minAppVersionIosDraft,
    minAppVersionAndroid: config.minAppVersionAndroidDraft,
    maintenanceMode: config.maintenanceModeDraft,
    maintenanceMessage: config.maintenanceMessageDraft,
    featureFlags: readJsonObject(config.featureFlagsDraft),
    contacts: readJsonArray(config.contactsDraft),
    extra: migratedExtra,
    publishedVersion: config.publishedVersion,
    publishedAt: config.publishedAt,
    publishedReleaseId: config.publishedReleaseId
  };
};

export const listDraftSpecialistsForStaff = async () => {
  return listSpecialistCards(prisma, 'DRAFT', {
    includeHidden: true,
    onlyActive: false
  });
};

export const patchDraftSpecialistProfile = async (
  staffId: string,
  payload: PatchSpecialistDraftProfileInput,
  actorStaffId: string
) => {
  const master = await prisma.staff.findFirst({
    where: {
      id: staffId,
      role: StaffRole.MASTER
    },
    include: {
      position: true
    }
  });

  if (!master) {
    throw notFound('Master not found');
  }

  if (payload.photoAssetId !== undefined && payload.photoAssetId !== null) {
    const mediaAsset = await prisma.mediaAsset.findUnique({
      where: { id: payload.photoAssetId },
      select: { id: true }
    });
    if (!mediaAsset) {
      throw notFound('Media asset not found');
    }
  }

  const specialtyForCreate = payload.specialty === undefined ? (master.position?.name ?? null) : payload.specialty;

  await prisma.$transaction(async (tx) => {
    await tx.clientSpecialistProfile.upsert({
      where: { staffId },
      update: {
        ...(payload.photoAssetId !== undefined ? { photoAssetIdDraft: payload.photoAssetId } : {}),
        ...(payload.specialty !== undefined ? { specialtyDraft: payload.specialty } : {}),
        ...(payload.info !== undefined ? { infoDraft: payload.info } : {}),
        ...(payload.ctaText !== undefined ? { ctaTextDraft: payload.ctaText ?? 'Записаться' } : {}),
        ...(payload.isVisible !== undefined ? { isVisibleDraft: payload.isVisible } : {}),
        ...(payload.sortOrder !== undefined ? { sortOrderDraft: payload.sortOrder } : {}),
        updatedByStaffId: actorStaffId
      },
      create: {
        staffId,
        photoAssetIdDraft: payload.photoAssetId ?? null,
        specialtyDraft: specialtyForCreate,
        infoDraft: payload.info ?? null,
        ctaTextDraft: payload.ctaText ?? 'Записаться',
        isVisibleDraft: payload.isVisible ?? true,
        sortOrderDraft: payload.sortOrder ?? 0,
        updatedByStaffId: actorStaffId
      }
    });

    if (payload.photoAssetId !== undefined) {
      await tx.mediaUsage.deleteMany({
        where: {
          usageType: 'CLIENT_SPECIALIST_PROFILE',
          entityId: staffId,
          fieldPath: 'photo'
        }
      });

      if (payload.photoAssetId) {
        await tx.mediaUsage.create({
          data: {
            assetId: payload.photoAssetId,
            usageType: 'CLIENT_SPECIALIST_PROFILE',
            entityId: staffId,
            fieldPath: 'photo',
            note: 'Specialist card photo',
            createdByStaffId: actorStaffId
          }
        });
      }
    }

    await writeAuditLog(tx, actorStaffId, 'CLIENT_SPECIALIST_PROFILE_UPDATE', 'ClientSpecialistProfile', staffId, payload);
  });

  const card = await listSpecialistCards(prisma, 'DRAFT', {
    includeHidden: true,
    onlyActive: false,
    staffId
  });

  if (card.length === 0) {
    throw notFound('Master not found');
  }

  return card[0];
};

export const getClientBootstrap = async (platform: PlatformInput, appVersion?: string): Promise<BootstrapResult> => {
  const now = new Date();
  const config = await getOrCreateClientAppConfig();
  const specialists = await listSpecialistCards(prisma, 'PUBLISHED', {
    includeHidden: false,
    onlyActive: true,
    onlyWithServices: true
  });
  const publishedExtraWithoutBlocks = migrateLegacyBookingContent(
    readJsonObject(config.extraPublished),
    []
  );
  const emptyBlockAssetUrlMap = new Map<string, string>();
  const publishedExtraAssetUrlMap = await buildImageAssetUrlMap(publishedExtraWithoutBlocks);

  if (!config.publishedReleaseId) {
    const etag = createHash('sha256')
      .update(
        JSON.stringify({
          v: config.publishedVersion,
          c: buildPublishedConfigPayload(
            config,
            platform,
            appVersion,
            now,
            attachImageUrlsDeep(
              publishedExtraWithoutBlocks,
              publishedExtraAssetUrlMap,
            ) as Record<string, unknown>,
          ),
          b: [],
          s: specialists
        })
      )
      .digest('hex');

    return {
      version: config.publishedVersion,
      etag,
      publishedAt: config.publishedAt,
      payload: {
        version: config.publishedVersion,
        publishedAt: config.publishedAt,
        config: buildPublishedConfigPayload(
          config,
          platform,
          appVersion,
          now,
          attachImageUrlsDeep(
            publishedExtraWithoutBlocks,
            publishedExtraAssetUrlMap,
          ) as Record<string, unknown>
        ),
        blocks: filterBlocksForClient([], platform, appVersion, now, emptyBlockAssetUrlMap),
        specialists
      }
    };
  }

  const release = await prisma.clientContentRelease.findUnique({
    where: { id: config.publishedReleaseId },
    include: {
      blocks: {
        where: {
          status: ClientContentStatus.PUBLISHED
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
      }
    }
  });

  if (!release) {
    throw notFound('Published release not found');
  }

  const publishedExtra = migrateLegacyBookingContent(
    readJsonObject(config.extraPublished),
    release.blocks.map((block) => ({
      blockType: block.blockType,
      payload: block.payload
    }))
  );
  const [publishedExtraResolvedMap, publishedBlockResolvedMap] = await Promise.all([
    buildImageAssetUrlMap(publishedExtra),
    buildImageAssetUrlMap(release.blocks.map((block) => block.payload)),
  ]);
  const blocks = filterBlocksForClient(
    release.blocks,
    platform,
    appVersion,
    now,
    publishedBlockResolvedMap,
  );

  return {
    version: release.version,
    etag: release.etag,
    publishedAt: release.publishedAt,
    payload: {
      version: release.version,
      publishedAt: release.publishedAt,
      config: buildPublishedConfigPayload(
        config,
        platform,
        appVersion,
        now,
        attachImageUrlsDeep(
          publishedExtra,
          publishedExtraResolvedMap,
        ) as Record<string, unknown>
      ),
      blocks,
      specialists
    }
  };
};

export const patchDraftClientConfig = async (payload: DraftConfigPatchInput, actorStaffId: string) => {
  if (payload.contacts !== undefined) {
    const contactValidation = contactPointSchema.array().safeParse(payload.contacts);
    if (!contactValidation.success) {
      throw badRequest('Invalid contacts payload', contactValidation.error.flatten());
    }
    payload.contacts = contactValidation.data.sort((left, right) => left.orderIndex - right.orderIndex);
  }

  if (payload.featureFlags !== undefined) {
    const featureFlagsValidation = featureFlagsSchema.safeParse(payload.featureFlags);
    if (!featureFlagsValidation.success) {
      throw badRequest('Invalid featureFlags payload', featureFlagsValidation.error.flatten());
    }
    payload.featureFlags = featureFlagsValidation.data;
  }

  if (payload.extra !== undefined) {
    payload.extra = validateClientFrontExtra(payload.extra);
  }

  const config = await getOrCreateClientAppConfig();

  const updated = await prisma.clientAppConfig.update({
    where: { id: config.id },
    data: {
      ...(payload.brandName !== undefined ? { brandNameDraft: payload.brandName } : {}),
      ...(payload.legalName !== undefined ? { legalNameDraft: payload.legalName } : {}),
      ...(payload.minAppVersionIos !== undefined ? { minAppVersionIosDraft: payload.minAppVersionIos } : {}),
      ...(payload.minAppVersionAndroid !== undefined
        ? { minAppVersionAndroidDraft: payload.minAppVersionAndroid }
        : {}),
      ...(payload.maintenanceMode !== undefined ? { maintenanceModeDraft: payload.maintenanceMode } : {}),
      ...(payload.maintenanceMessage !== undefined ? { maintenanceMessageDraft: payload.maintenanceMessage } : {}),
      ...(payload.featureFlags !== undefined ? { featureFlagsDraft: valueToJson(payload.featureFlags) } : {}),
      ...(payload.contacts !== undefined ? { contactsDraft: valueToJson(payload.contacts) } : {}),
      ...(payload.extra !== undefined ? { extraDraft: valueToJson(payload.extra) } : {})
    }
  });

  await writeAuditLog(prisma, actorStaffId, 'CLIENT_FRONT_CONFIG_UPDATE', 'ClientAppConfig', updated.id, payload);

  return updated;
};

export const listDraftBlocks = async () => {
  const rows = await prisma.clientContentBlock.findMany({
    where: {
      status: ClientContentStatus.DRAFT,
      releaseId: null
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
  });

  return rows.map((block) => mapBlockToApi(block));
};

export const createDraftBlock = async (payload: DraftBlockInput, actorStaffId: string) => {
  const blockType = payload.blockType;
  const normalizedPayload = validatePayloadByType(blockType, payload.payload);

  const existing = await prisma.clientContentBlock.findFirst({
    where: {
      blockKey: payload.blockKey,
      status: ClientContentStatus.DRAFT,
      releaseId: null
    },
    select: { id: true }
  });

  if (existing) {
    throw conflict(`Draft block with key ${payload.blockKey} already exists`);
  }

  const created = await prisma.clientContentBlock.create({
    data: {
      blockKey: payload.blockKey,
      blockType,
      payload: valueToJson(normalizedPayload),
      sortOrder: payload.sortOrder,
      status: ClientContentStatus.DRAFT,
      platform: enumFromPlatformInput[payload.platform],
      minAppVersion: payload.minAppVersion,
      maxAppVersion: payload.maxAppVersion,
      startAt: payload.startAt ? new Date(payload.startAt) : null,
      endAt: payload.endAt ? new Date(payload.endAt) : null,
      isEnabled: payload.isEnabled,
      createdByStaffId: actorStaffId,
      updatedByStaffId: actorStaffId
    }
  });

  await writeAuditLog(prisma, actorStaffId, 'CLIENT_FRONT_BLOCK_CREATE', 'ClientContentBlock', created.id, {
    blockKey: created.blockKey,
    blockType: created.blockType
  });

  return mapBlockToApi(created);
};

export const updateDraftBlock = async (blockId: string, payload: UpdateDraftBlockInput, actorStaffId: string) => {
  const current = await prisma.clientContentBlock.findFirst({
    where: {
      id: blockId,
      status: ClientContentStatus.DRAFT,
      releaseId: null
    }
  });

  if (!current) {
    throw notFound('Draft block not found');
  }

  const nextBlockType = (payload.blockType ?? current.blockType) as keyof typeof blockPayloadSchemaByType;
  const nextPayload = (payload.payload ?? (current.payload as Record<string, unknown>)) as Record<string, unknown>;
  const normalizedPayload = validatePayloadByType(nextBlockType, nextPayload);

  const updated = await prisma.clientContentBlock.update({
    where: { id: blockId },
    data: {
      ...(payload.blockType !== undefined ? { blockType: payload.blockType } : {}),
      ...(payload.payload !== undefined || payload.blockType !== undefined
        ? { payload: valueToJson(normalizedPayload) }
        : {}),
      ...(payload.sortOrder !== undefined ? { sortOrder: payload.sortOrder } : {}),
      ...(payload.platform !== undefined ? { platform: enumFromPlatformInput[payload.platform] } : {}),
      ...(payload.minAppVersion !== undefined ? { minAppVersion: payload.minAppVersion } : {}),
      ...(payload.maxAppVersion !== undefined ? { maxAppVersion: payload.maxAppVersion } : {}),
      ...(payload.startAt !== undefined ? { startAt: payload.startAt ? new Date(payload.startAt) : null } : {}),
      ...(payload.endAt !== undefined ? { endAt: payload.endAt ? new Date(payload.endAt) : null } : {}),
      ...(payload.isEnabled !== undefined ? { isEnabled: payload.isEnabled } : {}),
      updatedByStaffId: actorStaffId
    }
  });

  await writeAuditLog(prisma, actorStaffId, 'CLIENT_FRONT_BLOCK_UPDATE', 'ClientContentBlock', updated.id, payload);

  return mapBlockToApi(updated);
};

export const deleteDraftBlock = async (blockId: string, actorStaffId: string) => {
  const current = await prisma.clientContentBlock.findFirst({
    where: {
      id: blockId,
      status: ClientContentStatus.DRAFT,
      releaseId: null
    }
  });

  if (!current) {
    throw notFound('Draft block not found');
  }

  await prisma.$transaction(async (tx) => {
    await tx.mediaUsage.deleteMany({
      where: {
        usageType: 'CLIENT_CONTENT_BLOCK',
        entityId: blockId
      }
    });

    await tx.clientContentBlock.delete({ where: { id: blockId } });

    await writeAuditLog(tx, actorStaffId, 'CLIENT_FRONT_BLOCK_DELETE', 'ClientContentBlock', blockId, {
      blockKey: current.blockKey
    });
  });

  return { deleted: true };
};

export const publishClientFront = async (actorStaffId: string): Promise<PublishResult> => {
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const config = await getOrCreateClientAppConfig(tx);

    const draftBlocks = await tx.clientContentBlock.findMany({
      where: {
        status: ClientContentStatus.DRAFT,
        releaseId: null
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }]
    });
    const specialistRows = await tx.staff.findMany({
      where: {
        role: StaffRole.MASTER,
        isActive: true,
        firedAt: null
      },
      include: specialistStaffInclude,
      orderBy: [{ name: 'asc' }]
    });
    const specialistsSnapshot = specialistRows
      .map((row) => buildSpecialistCard(row, 'DRAFT'))
      .filter((row) => hasActiveServices(row))
      .sort((left, right) => {
        if (left.sortOrder !== right.sortOrder) {
          return left.sortOrder - right.sortOrder;
        }
        return left.name.localeCompare(right.name, 'ru');
      });

    const latestRelease = await tx.clientContentRelease.findFirst({
      select: { version: true },
      orderBy: { version: 'desc' }
    });

    const nextVersion = (latestRelease?.version ?? 0) + 1;
    const migratedDraftExtra = migrateLegacyBookingContent(
      readJsonObject(config.extraDraft),
      draftBlocks.map((block) => ({
        blockType: block.blockType,
        payload: block.payload
      }))
    );
    const appConfigSnapshot = buildDraftConfigPayload(
      config,
      'all',
      undefined,
      now,
      migratedDraftExtra
    );

    const snapshotPayload = {
      version: nextVersion,
      appConfig: appConfigSnapshot,
      blocks: draftBlocks.map((block) => ({
        blockKey: block.blockKey,
        blockType: block.blockType,
        payload: block.payload,
        sortOrder: block.sortOrder,
        platform: platformOutputMap[block.platform],
        minAppVersion: block.minAppVersion,
        maxAppVersion: block.maxAppVersion,
        startAt: block.startAt,
        endAt: block.endAt,
        isEnabled: block.isEnabled
      })),
      specialists: specialistsSnapshot
    };

    const etag = createHash('sha256').update(JSON.stringify(snapshotPayload)).digest('hex');

    const release = await tx.clientContentRelease.create({
      data: {
        version: nextVersion,
        etag,
        appConfigSnapshot: valueToJson(appConfigSnapshot),
        blocksCount: draftBlocks.length,
        publishedByStaffId: actorStaffId,
        publishedAt: now
      }
    });

    if (draftBlocks.length > 0) {
      await tx.clientContentBlock.createMany({
        data: draftBlocks.map((block) => ({
          blockKey: block.blockKey,
          blockType: block.blockType,
          payload: block.payload as Prisma.InputJsonValue,
          sortOrder: block.sortOrder,
          status: ClientContentStatus.PUBLISHED,
          platform: block.platform,
          minAppVersion: block.minAppVersion,
          maxAppVersion: block.maxAppVersion,
          startAt: block.startAt,
          endAt: block.endAt,
          isEnabled: block.isEnabled,
          releaseId: release.id,
          createdByStaffId: block.createdByStaffId,
          updatedByStaffId: block.updatedByStaffId,
          publishedByStaffId: actorStaffId
        }))
      });
    }

    for (const row of specialistRows) {
      const stageData = getSpecialistStageData(row, 'DRAFT');
      if (row.specialistProfile) {
        await tx.clientSpecialistProfile.update({
          where: { staffId: row.id },
          data: {
            photoAssetIdPublished: stageData.photoAssetId,
            specialtyPublished: stageData.specialty,
            infoPublished: stageData.info,
            ctaTextPublished: stageData.ctaText,
            isVisiblePublished: stageData.isVisible,
            sortOrderPublished: stageData.sortOrder,
            publishedByStaffId: actorStaffId
          }
        });
      } else {
        await tx.clientSpecialistProfile.create({
          data: {
            staffId: row.id,
            specialtyDraft: stageData.specialty,
            specialtyPublished: stageData.specialty,
            infoDraft: stageData.info,
            infoPublished: stageData.info,
            ctaTextDraft: stageData.ctaText,
            ctaTextPublished: stageData.ctaText,
            isVisibleDraft: stageData.isVisible,
            isVisiblePublished: stageData.isVisible,
            sortOrderDraft: stageData.sortOrder,
            sortOrderPublished: stageData.sortOrder,
            photoAssetIdDraft: stageData.photoAssetId,
            photoAssetIdPublished: stageData.photoAssetId,
            updatedByStaffId: actorStaffId,
            publishedByStaffId: actorStaffId
          }
        });
      }
    }

    await tx.clientAppConfig.update({
      where: { id: config.id },
      data: {
        brandNamePublished: config.brandNameDraft,
        legalNamePublished: config.legalNameDraft,
        minAppVersionIosPublished: config.minAppVersionIosDraft,
        minAppVersionAndroidPublished: config.minAppVersionAndroidDraft,
        maintenanceModePublished: config.maintenanceModeDraft,
        maintenanceMessagePublished: config.maintenanceMessageDraft,
        featureFlagsPublished: valueToJson(config.featureFlagsDraft),
        contactsPublished: valueToJson(config.contactsDraft),
        extraPublished: valueToJson(migratedDraftExtra),
        extraDraft: valueToJson(migratedDraftExtra),
        publishedVersion: release.version,
        publishedReleaseId: release.id,
        publishedAt: now
      }
    });

    await tx.auditLog.createMany({
      data: [
        {
          actorStaffId,
          action: 'CLIENT_FRONT_PUBLISH',
          entityType: 'ClientContentRelease',
          entityId: release.id,
          diff: valueToJson({
            version: release.version,
            blocksCount: draftBlocks.length,
            etag: release.etag
          })
        },
        {
          actorStaffId,
          action: 'CLIENT_FRONT_CONFIG_PUBLISH',
          entityType: 'ClientAppConfig',
          entityId: config.id,
          diff: valueToJson({ version: release.version })
        }
      ]
    });

    return {
      version: release.version,
      etag: release.etag,
      publishedAt: release.publishedAt,
      blocksCount: draftBlocks.length
    };
  });
};

export const listReleases = async (page: number, limit: number) => {
  const skip = (page - 1) * limit;

  const [total, items] = await Promise.all([
    prisma.clientContentRelease.count(),
    prisma.clientContentRelease.findMany({
      include: {
        publishedByStaff: {
          select: {
            id: true,
            name: true,
            role: true
          }
        }
      },
      orderBy: { version: 'desc' },
      skip,
      take: limit
    })
  ]);

  return {
    total,
    items,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit))
  };
};

const detectMagicFormat = (fileBuffer: Buffer): 'jpeg' | 'png' | 'webp' | 'heic' | 'avif' | null => {
  if (fileBuffer.length >= 3 && fileBuffer[0] === 0xff && fileBuffer[1] === 0xd8 && fileBuffer[2] === 0xff) {
    return 'jpeg';
  }

  if (
    fileBuffer.length >= 8 &&
    fileBuffer[0] === 0x89 &&
    fileBuffer[1] === 0x50 &&
    fileBuffer[2] === 0x4e &&
    fileBuffer[3] === 0x47 &&
    fileBuffer[4] === 0x0d &&
    fileBuffer[5] === 0x0a &&
    fileBuffer[6] === 0x1a &&
    fileBuffer[7] === 0x0a
  ) {
    return 'png';
  }

  if (fileBuffer.length >= 12 && fileBuffer.toString('ascii', 0, 4) === 'RIFF' && fileBuffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }

  if (fileBuffer.length >= 12 && fileBuffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = fileBuffer.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') {
      return 'avif';
    }

    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' || brand === 'mif1' || brand === 'msf1') {
      return 'heic';
    }
  }

  return null;
};

const inferOriginalExtension = (format: 'jpeg' | 'png' | 'webp' | 'heic' | 'avif'): string => {
  if (format === 'jpeg') return 'jpg';
  return format;
};

const safeUnlink = async (absolutePath: string) => {
  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[MEDIA] Failed to delete file', absolutePath, error);
    }
  }
};

const mapMediaAsset = (asset: {
  id: string;
  entity: string;
  originalFileName: string;
  originalMime: string;
  originalSize: number;
  originalWidth: number;
  originalHeight: number;
  checksumSha256: string;
  originalPath: string;
  createdByStaffId: string;
  createdAt: Date;
  updatedAt: Date;
  variants: Array<{
    id: string;
    format: string;
    width: number;
    height: number;
    path: string;
    urlPath: string;
    size: number;
    createdAt: Date;
  }>;
  usages?: Array<{
    id: string;
    usageType: string;
    entityId: string;
    fieldPath: string;
    note: string | null;
    createdAt: Date;
  }>;
  _count?: {
    usages: number;
  };
}) => {
  return {
    id: asset.id,
    entity: asset.entity,
    originalFileName: asset.originalFileName,
    originalMime: asset.originalMime,
    originalSize: asset.originalSize,
    originalWidth: asset.originalWidth,
    originalHeight: asset.originalHeight,
    checksumSha256: asset.checksumSha256,
    originalPath: asset.originalPath,
    originalUrlPath: toMediaUrlPath(asset.originalPath),
    originalUrl: toMediaPublicUrl(toMediaUrlPath(asset.originalPath)),
    createdByStaffId: asset.createdByStaffId,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    variants: asset.variants
      .sort((left, right) => left.width - right.width)
      .map((variant) => ({
        id: variant.id,
        format: variant.format,
        width: variant.width,
        height: variant.height,
        path: variant.path,
        urlPath: variant.urlPath,
        url: toMediaPublicUrl(variant.urlPath),
        size: variant.size,
        createdAt: variant.createdAt
      })),
    usages: asset.usages,
    usagesCount: asset._count?.usages ?? asset.usages?.length ?? 0
  };
};

export const uploadMediaAsset = async (
  file: Express.Multer.File,
  entity: string,
  actorStaffId: string
) => {
  const normalizedEntity = entity.trim().toLowerCase();
  const mime = MEDIA_MIME_ALIASES[(file.mimetype ?? '').toLowerCase()] ?? (file.mimetype ?? '').toLowerCase();
  const magicFormat = detectMagicFormat(file.buffer);
  const acceptedMagicFormats =
    MEDIA_MIME_WHITELIST[mime] ??
    (mime === '' || mime === 'application/octet-stream' || mime.startsWith('image/') ? (magicFormat ? [magicFormat] : undefined) : undefined);

  if (!acceptedMagicFormats) {
    throw badRequest('Unsupported mime type');
  }

  if (!magicFormat || !acceptedMagicFormats.includes(magicFormat)) {
    throw badRequest('File signature does not match MIME type');
  }

  const metadata = await sharp(file.buffer).metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    throw badRequest('Unable to read image dimensions');
  }

  if (width > env.MEDIA_MAX_DIMENSION || height > env.MEDIA_MAX_DIMENSION) {
    throw badRequest(`Image dimensions exceed ${env.MEDIA_MAX_DIMENSION}x${env.MEDIA_MAX_DIMENSION}`);
  }

  const checksumSha256 = createHash('sha256').update(file.buffer).digest('hex');
  const now = new Date();
  const yyyy = `${now.getUTCFullYear()}`;
  const mm = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  const relativeDir = path.posix.join(normalizedEntity, yyyy, mm);

  const originalExtension = inferOriginalExtension(magicFormat);
  const originalRelativePath = path.posix.join(relativeDir, `${checksumSha256}_orig.${originalExtension}`);
  const originalAbsolutePath = ensureMediaPathSafe(originalRelativePath);

  await fs.mkdir(path.dirname(originalAbsolutePath), { recursive: true });

  const writtenFiles: string[] = [];

  try {
    await fs.writeFile(originalAbsolutePath, file.buffer);
    writtenFiles.push(originalAbsolutePath);

    const variantWidths = [...new Set(env.MEDIA_VARIANT_WIDTHS.map((variantWidth) => Math.min(variantWidth, width)))].sort(
      (left, right) => left - right
    );

    const variantsData: Array<{
      format: string;
      width: number;
      height: number;
      path: string;
      urlPath: string;
      size: number;
    }> = [];

    for (const variantWidth of variantWidths) {
      const converted = await sharp(file.buffer)
        .rotate()
        .resize({ width: variantWidth, withoutEnlargement: true, fit: 'inside' })
        .webp({ quality: env.MEDIA_WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });

      const actualWidth = converted.info.width;
      const actualHeight = converted.info.height;

      const variantRelativePath = path.posix.join(relativeDir, `${checksumSha256}_${actualWidth}.webp`);
      const variantAbsolutePath = ensureMediaPathSafe(variantRelativePath);

      await fs.writeFile(variantAbsolutePath, converted.data);
      writtenFiles.push(variantAbsolutePath);

      variantsData.push({
        format: 'webp',
        width: actualWidth,
        height: actualHeight,
        path: variantRelativePath,
        urlPath: toMediaUrlPath(variantRelativePath),
        size: converted.info.size
      });
    }

    const dedupedVariants = [...new Map(variantsData.map((item) => [`${item.format}:${item.width}`, item])).values()];

    const created = await prisma.mediaAsset.create({
      data: {
        entity: normalizedEntity,
        originalFileName: file.originalname,
        originalMime: mime,
        originalSize: file.size,
        originalWidth: width,
        originalHeight: height,
        checksumSha256,
        originalPath: originalRelativePath,
        createdByStaffId: actorStaffId,
        variants: {
          create: dedupedVariants.map((variant) => ({
            format: variant.format,
            width: variant.width,
            height: variant.height,
            path: variant.path,
            urlPath: variant.urlPath,
            size: variant.size
          }))
        }
      },
      include: {
        variants: {
          orderBy: { width: 'asc' }
        },
        _count: {
          select: {
            usages: true
          }
        }
      }
    });

    await writeAuditLog(prisma, actorStaffId, 'MEDIA_UPLOAD', 'MediaAsset', created.id, {
      entity: created.entity,
      mime: created.originalMime,
      size: created.originalSize
    });

    return mapMediaAsset(created);
  } catch (error) {
    await Promise.all(writtenFiles.map((filePath) => safeUnlink(filePath)));
    throw error;
  }
};

export const listMediaAssets = async (page: number, limit: number, entity?: string, search?: string) => {
  const skip = (page - 1) * limit;

  const where: Prisma.MediaAssetWhereInput = {
    ...(entity ? { entity } : {}),
    ...(search
      ? {
          OR: [
            { originalFileName: { contains: search, mode: 'insensitive' } },
            { checksumSha256: { contains: search, mode: 'insensitive' } }
          ]
        }
      : {})
  };

  const [total, rows] = await Promise.all([
    prisma.mediaAsset.count({ where }),
    prisma.mediaAsset.findMany({
      where,
      include: {
        variants: true,
        _count: {
          select: {
            usages: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    })
  ]);

  return {
    items: rows.map(mapMediaAsset),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit))
  };
};

export const getMediaAsset = async (assetId: string) => {
  const row = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    include: {
      variants: {
        orderBy: { width: 'asc' }
      },
      usages: {
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  if (!row) {
    throw notFound('Media asset not found');
  }

  return mapMediaAsset(row);
};

export const addMediaUsage = async (
  assetId: string,
  payload: unknown,
  actorStaffId: string
) => {
  const parsedPayloadResult = createMediaUsageSchema.safeParse(payload);
  if (!parsedPayloadResult.success) {
    throw badRequest('Invalid media usage payload', parsedPayloadResult.error.flatten());
  }
  const parsedPayload = parsedPayloadResult.data;

  const asset = await prisma.mediaAsset.findUnique({ where: { id: assetId }, select: { id: true } });
  if (!asset) {
    throw notFound('Media asset not found');
  }

  const usage = await prisma.mediaUsage.upsert({
    where: {
      assetId_usageType_entityId_fieldPath: {
        assetId,
        usageType: parsedPayload.usageType,
        entityId: parsedPayload.entityId,
        fieldPath: parsedPayload.fieldPath
      }
    },
    update: {
      note: parsedPayload.note,
      createdByStaffId: actorStaffId
    },
    create: {
      assetId,
      usageType: parsedPayload.usageType,
      entityId: parsedPayload.entityId,
      fieldPath: parsedPayload.fieldPath,
      note: parsedPayload.note,
      createdByStaffId: actorStaffId
    }
  });

  await writeAuditLog(prisma, actorStaffId, 'MEDIA_USAGE_UPSERT', 'MediaUsage', usage.id, usage);

  return usage;
};

export const deleteMediaUsage = async (assetId: string, usageId: string, actorStaffId: string) => {
  const usage = await prisma.mediaUsage.findFirst({ where: { id: usageId, assetId } });
  if (!usage) {
    throw notFound('Media usage not found');
  }

  await prisma.mediaUsage.delete({ where: { id: usage.id } });
  await writeAuditLog(prisma, actorStaffId, 'MEDIA_USAGE_DELETE', 'MediaUsage', usage.id, usage);

  return { deleted: true };
};

export const deleteMediaAsset = async (assetId: string, actorStaffId: string) => {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    include: {
      variants: true,
      usages: true
    }
  });

  if (!asset) {
    throw notFound('Media asset not found');
  }

  if (asset.usages.length > 0) {
    throw businessRule('MEDIA_IN_USE', 'Cannot delete media asset while it is referenced', {
      usagesCount: asset.usages.length
    });
  }

  await prisma.mediaAsset.delete({ where: { id: assetId } });

  const filePaths = [asset.originalPath, ...asset.variants.map((variant) => variant.path)].map(ensureMediaPathSafe);
  await Promise.all(filePaths.map((filePath) => safeUnlink(filePath)));

  await writeAuditLog(prisma, actorStaffId, 'MEDIA_DELETE', 'MediaAsset', assetId, {
    entity: asset.entity,
    checksumSha256: asset.checksumSha256
  });

  return { deleted: true };
};

export const getMediaPublicConfiguration = () => {
  return {
    mediaRoot,
    mediaPublicBase,
    mediaPublicOrigin: env.MEDIA_PUBLIC_ORIGIN ?? null,
    variants: env.MEDIA_VARIANT_WIDTHS,
    webpQuality: env.MEDIA_WEBP_QUALITY,
    maxUploadMb: env.MEDIA_MAX_UPLOAD_MB,
    maxDimension: env.MEDIA_MAX_DIMENSION
  };
};

export const ensureMediaStorageReady = async () => {
  await fs.mkdir(mediaRoot, { recursive: true });
};
