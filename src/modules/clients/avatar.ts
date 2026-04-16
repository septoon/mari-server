import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import multer from 'multer';
import sharp from 'sharp';

import { env } from '../../config/env';
import { prisma } from '../../db/prisma';
import { badRequest, notFound } from '../../utils/errors';

const mediaRoot = path.resolve(env.MEDIA_ROOT);
const clientAvatarRoot = path.posix.join('clients', 'avatars');
const clientAvatarMimeWhitelist: Record<string, Array<'jpeg' | 'png' | 'webp' | 'heic' | 'avif'>> = {
  'image/jpeg': ['jpeg'],
  'image/jpg': ['jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/heic': ['heic'],
  'image/heif': ['heic'],
  'image/avif': ['avif']
};

const clientAvatarMimeAliases: Record<string, keyof typeof clientAvatarMimeWhitelist> = {
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png'
};

export const clientAvatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MEDIA_MAX_UPLOAD_MB * 1024 * 1024,
    files: 1
  }
});

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

const ensureMediaPathSafe = (relativePath: string): string => {
  const absolutePath = path.resolve(mediaRoot, relativePath);
  if (absolutePath === mediaRoot || absolutePath.startsWith(`${mediaRoot}${path.sep}`)) {
    return absolutePath;
  }
  throw badRequest('Invalid media path');
};

const toMediaUrlPath = (relativePath: string): string => {
  return path.posix.join(env.MEDIA_PUBLIC_BASE, relativePath.replaceAll('\\', '/'));
};

const toMediaPublicUrl = (urlPath: string): string => {
  if (!env.MEDIA_PUBLIC_ORIGIN) {
    return urlPath;
  }
  return `${env.MEDIA_PUBLIC_ORIGIN.replace(/\/+$/, '')}${urlPath}`;
};

const safeUnlink = async (absolutePath: string) => {
  try {
    await fs.unlink(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[CLIENT_AVATAR_DELETE_FAILED]', absolutePath, error);
    }
  }
};

const buildClientAvatarRelativePath = (clientId: string, checksumSha256: string): string => {
  const now = new Date();
  const yyyy = `${now.getUTCFullYear()}`;
  const mm = `${now.getUTCMonth() + 1}`.padStart(2, '0');
  return path.posix.join(clientAvatarRoot, yyyy, mm, clientId, `${checksumSha256}.webp`);
};

const writeClientAvatarFile = async (clientId: string, file: Express.Multer.File) => {
  const mime = clientAvatarMimeAliases[(file.mimetype ?? '').toLowerCase()] ?? (file.mimetype ?? '').toLowerCase();
  const magicFormat = detectMagicFormat(file.buffer);
  const acceptedMagicFormats =
    clientAvatarMimeWhitelist[mime] ??
    (mime === '' || mime === 'application/octet-stream' || mime.startsWith('image/') ? (magicFormat ? [magicFormat] : undefined) : undefined);

  if (!acceptedMagicFormats) {
    throw badRequest('Unsupported avatar mime type');
  }

  if (!magicFormat || !acceptedMagicFormats.includes(magicFormat)) {
    throw badRequest('Avatar file signature does not match MIME type');
  }

  const metadata = await sharp(file.buffer).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) {
    throw badRequest('Unable to read avatar dimensions');
  }

  if (width > env.MEDIA_MAX_DIMENSION || height > env.MEDIA_MAX_DIMENSION) {
    throw badRequest(`Avatar dimensions exceed ${env.MEDIA_MAX_DIMENSION}x${env.MEDIA_MAX_DIMENSION}`);
  }

  const converted = await sharp(file.buffer)
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: env.MEDIA_WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });

  const checksumSha256 = createHash('sha256').update(converted.data).digest('hex');
  const relativePath = buildClientAvatarRelativePath(clientId, checksumSha256);
  const absolutePath = ensureMediaPathSafe(relativePath);

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, converted.data);

  return {
    relativePath,
    absolutePath,
    width: converted.info.width,
    height: converted.info.height
  };
};

export const resolveClientAvatarUrl = (avatarPath?: string | null): string | null => {
  if (!avatarPath) {
    return null;
  }
  return toMediaPublicUrl(toMediaUrlPath(avatarPath));
};

export const saveClientAvatar = async (clientId: string, file: Express.Multer.File) => {
  const existing = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, avatarPath: true }
  });

  if (!existing) {
    throw notFound('Client not found');
  }

  const savedFile = await writeClientAvatarFile(clientId, file);

  try {
    const updated = await prisma.client.update({
      where: { id: clientId },
      data: {
        avatarPath: savedFile.relativePath
      },
      select: {
        id: true,
        avatarPath: true
      }
    });

    if (existing.avatarPath && existing.avatarPath !== updated.avatarPath) {
      await safeUnlink(ensureMediaPathSafe(existing.avatarPath));
    }

    return {
      clientId: updated.id,
      avatarPath: updated.avatarPath,
      previousAvatarPath: existing.avatarPath
    };
  } catch (error) {
    await safeUnlink(savedFile.absolutePath);
    throw error;
  }
};

export const deleteClientAvatar = async (clientId: string) => {
  const existing = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, avatarPath: true }
  });

  if (!existing) {
    throw notFound('Client not found');
  }

  const updated = await prisma.client.update({
    where: { id: clientId },
    data: {
      avatarPath: null
    },
    select: {
      id: true,
      avatarPath: true
    }
  });

  if (existing.avatarPath) {
    await safeUnlink(ensureMediaPathSafe(existing.avatarPath));
  }

  return {
    clientId: updated.id,
    avatarPath: updated.avatarPath,
    previousAvatarPath: existing.avatarPath
  };
};

export const removeClientAvatarFileByPath = async (avatarPath?: string | null) => {
  if (!avatarPath) {
    return;
  }

  await safeUnlink(ensureMediaPathSafe(avatarPath));
};
