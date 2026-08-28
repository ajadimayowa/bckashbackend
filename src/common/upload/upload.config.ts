import fs from 'fs';
import path from 'path';
import { BadRequestException } from '@nestjs/common';
import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import multer from 'multer';
import type { Request } from 'express';

/**
 * Local-disk multer configuration, adapted from the reference
 * `upload.middleware.ts` supplied for this purpose — same
 * env-configurable root/size-limit, same safe-filename generation, same
 * image-mimetype allowlist. Kept deliberately dependency-light (raw
 * `process.env`, not the app's Joi-validated `ConfigService` layer) to
 * match that reference exactly.
 *
 * Disk storage, not S3 (contrast OrganisationController's `cacDoc` upload,
 * which streams straight to S3 via in-memory multer + S3IntegrationModule)
 * — deliberate, per the reference this was modeled on. Caveat worth
 * flagging: on a platform with an ephemeral filesystem (e.g. Render's web
 * service disk), files written here don't survive a redeploy/restart. Fine
 * for local/dev or a host with a persistent disk/volume; swap for the S3
 * pattern if deploying somewhere ephemeral.
 */

type DestinationCallback = (error: Error | null, destination: string) => void;
type FilenameCallback = (error: Error | null, filename: string) => void;

export const uploadRoot = process.env.UPLOAD_DIR
  ? path.resolve(process.cwd(), process.env.UPLOAD_DIR)
  : path.resolve(process.cwd(), 'uploads');

const imageMimeTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const documentMimeTypes = new Set([...imageMimeTypes, 'application/pdf']);

const ensureDirectory = (directoryPath: string): void => {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
};

const safeName = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_');

const createFilename = (file: Express.Multer.File): string => {
  const ext = path.extname(file.originalname).toLowerCase();
  const base = path.basename(file.originalname, ext);
  const timestamp = Date.now();
  const random = Math.round(Math.random() * 1e9);
  return `${safeName(base)}-${timestamp}-${random}${ext}`;
};

/** Public URL for a file this module saved — see main.ts's static mount of `uploadRoot` at `/uploads`. */
export const toPublicUploadUrl = (directory: string, filename: string): string =>
  `/uploads/${directory}/${filename}`;

/**
 * Staff onboarding's two upload fields — `passportPhoto` (image only) and
 * `idDocument` (image or PDF) — routed to their own subdirectory and
 * validated per-field. One multer instance handles both because
 * `FileFieldsInterceptor` only accepts a single `MulterOptions`; the
 * `fileFilter`/`destination` below branch on `file.fieldname` to apply the
 * right rule to each.
 */
export function staffDocumentUploadOptions(): MulterOptions {
  const photosDir = path.join(uploadRoot, 'staff', 'photos');
  const documentsDir = path.join(uploadRoot, 'staff', 'documents');
  ensureDirectory(photosDir);
  ensureDirectory(documentsDir);

  return {
    storage: multer.diskStorage({
      destination: (_req: Request, file: Express.Multer.File, cb: DestinationCallback) =>
        cb(null, file.fieldname === 'passportPhoto' ? photosDir : documentsDir),
      filename: (_req: Request, file: Express.Multer.File, cb: FilenameCallback) =>
        cb(null, createFilename(file)),
    }),
    limits: {
      fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE ?? 5 * 1024 * 1024),
    },
    fileFilter: (_req, file, cb): void => {
      const mimetype = file.mimetype.toLowerCase();

      if (file.fieldname === 'passportPhoto' && !imageMimeTypes.has(mimetype)) {
        cb(new BadRequestException('passportPhoto must be an image (jpeg, jpg, png, webp)'), false);
        return;
      }

      if (file.fieldname === 'idDocument' && !documentMimeTypes.has(mimetype)) {
        cb(
          new BadRequestException('idDocument must be an image or PDF (jpeg, jpg, png, webp, pdf)'),
          false,
        );
        return;
      }

      cb(null, true);
    },
  };
}

/** Resolves the `directory` segment `toPublicUploadUrl` needs from a saved multer file's own path. */
export function uploadedFileSubdirectory(file: Express.Multer.File): string {
  return path.relative(uploadRoot, path.dirname(file.path)).split(path.sep).join('/');
}

/** Shape `FileFieldsInterceptor([{ name: 'passportPhoto' }, { name: 'idDocument' }])` hands `@UploadedFiles()`. */
export interface StaffDocumentFiles {
  passportPhoto?: Express.Multer.File[];
  idDocument?: Express.Multer.File[];
}

export interface StaffDocumentUrls {
  passportPhotoUrl: string | null;
  idDocumentUrl: string | null;
}

/** Turns whatever `staffDocumentUploadOptions()` just saved to disk into the public URLs Staff.passportPhotoUrl/idDocumentUrl store. */
export function staffDocumentUrlsFromUpload(files: StaffDocumentFiles | undefined): StaffDocumentUrls {
  const photo = files?.passportPhoto?.[0];
  const document = files?.idDocument?.[0];

  return {
    passportPhotoUrl: photo ? toPublicUploadUrl(uploadedFileSubdirectory(photo), photo.filename) : null,
    idDocumentUrl: document ? toPublicUploadUrl(uploadedFileSubdirectory(document), document.filename) : null,
  };
}
