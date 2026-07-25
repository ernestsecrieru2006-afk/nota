/**
 * storage.js — image storage backend for menu photos, chosen at runtime by IMAGE_STORAGE.
 *
 *   db (default) — bytes live in the menu_images table. Works out of the box (Neon Postgres is
 *                   persistent, unlike Railway's app filesystem), no external service to set up.
 *                   Fine for a restaurant's menu photo count; not meant to scale to millions of
 *                   images, but this is a per-restaurant menu, not a photo host.
 *   s3            — uploads to an S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2,
 *                   MinIO — anything speaking the S3 API) and stores only the public URL.
 *                   Set IMAGE_STORAGE=s3 plus:
 *                     S3_BUCKET             bucket name
 *                     S3_REGION             region (use "auto" for R2)
 *                     S3_ENDPOINT           custom endpoint (omit for real AWS S3)
 *                     S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
 *                     S3_PUBLIC_URL_BASE    the base URL images are publicly reachable at
 *                                           (bucket public URL, or a CDN in front of it)
 *
 * Processing (sharp): strips EXIF (sharp drops metadata by default — orientation is read via
 * .rotate() before stripping so photos taken sideways on a phone still display upright), resizes
 * to a max width, converts to WebP. Two sizes are produced: "full" (max 1600px, for the elegant
 * hero/detail view) and "thumb" (max 480px, for list/grid thumbnails and lazy-loaded cards).
 */

import sharp from 'sharp';
import crypto from 'crypto';

const BACKEND = (process.env.IMAGE_STORAGE || 'db').toLowerCase();

const FULL_MAX_WIDTH  = 1600;
const THUMB_MAX_WIDTH = 480;
const FULL_QUALITY    = 82;
const THUMB_QUALITY   = 75;

let s3Client = null;
async function getS3Client() {
  if (s3Client) return s3Client;
  const { S3Client } = await import('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: process.env.S3_REGION || 'auto',
    endpoint: process.env.S3_ENDPOINT || undefined,
    credentials: {
      accessKeyId:     process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  return s3Client;
}

async function uploadToS3(buffer, key, contentType) {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = await getS3Client();
  await client.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
  const base = (process.env.S3_PUBLIC_URL_BASE || '').replace(/\/$/, '');
  return `${base}/${key}`;
}

/**
 * processAndStore({ buffer, restaurantId }) -> row fields ready to INSERT into menu_images
 * Returns { mime_type, full_data, thumb_data, full_url, thumb_url, width, height }.
 * Throws if the buffer isn't a decodable image.
 */
export async function processAndStore({ buffer, restaurantId }) {
  const rotated = sharp(buffer).rotate(); // apply EXIF orientation before we strip EXIF itself

  const fullBuf = await rotated.clone()
    .resize({ width: FULL_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: FULL_QUALITY })
    .toBuffer();
  const thumbBuf = await rotated.clone()
    .resize({ width: THUMB_MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();
  const meta = await sharp(fullBuf).metadata();

  if (BACKEND === 's3') {
    const id = crypto.randomBytes(12).toString('hex');
    const [full_url, thumb_url] = await Promise.all([
      uploadToS3(fullBuf, `menu/${restaurantId}/${id}-full.webp`, 'image/webp'),
      uploadToS3(thumbBuf, `menu/${restaurantId}/${id}-thumb.webp`, 'image/webp'),
    ]);
    return { mime_type: 'image/webp', full_data: null, thumb_data: null, full_url, thumb_url, width: meta.width, height: meta.height };
  }

  return { mime_type: 'image/webp', full_data: fullBuf, thumb_data: thumbBuf, full_url: null, thumb_url: null, width: meta.width, height: meta.height };
}

export const STORAGE_BACKEND = BACKEND;
