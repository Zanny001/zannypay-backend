import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StorageService } from './storage.service';

@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  // Any authenticated customer can request an upload slot for their own
  // profile photo / chat attachment / KYC document — the resulting key is
  // prefixed by caller-supplied context (see storeImage/keyPrefix usage
  // elsewhere), never trusted as a path to something else.
  @UseGuards(JwtAuthGuard)
  @Post('presigned-upload')
  async presignedUpload(
    @Body() body: { keyPrefix: string; contentType: string },
  ) {
    if (!body?.keyPrefix || !body?.contentType) {
      throw new BadRequestException('keyPrefix and contentType are required.');
    }
    const allowedPrefixes = [
      'avatars',
      'chat-attachments',
      'kyc-documents',
      'admin-avatars',
    ];
    if (
      !allowedPrefixes.some(
        (p) => body.keyPrefix === p || body.keyPrefix.startsWith(`${p}/`),
      )
    ) {
      throw new BadRequestException(
        `keyPrefix must be one of: ${allowedPrefixes.join(', ')}`,
      );
    }
    return this.storageService.createPresignedUpload(
      body.keyPrefix,
      body.contentType,
    );
  }

  // Only reachable at all when STORAGE_DRIVER=local (createPresignedUpload
  // only ever hands out this URL in that mode) — the S3 path uploads
  // directly to the bucket and never touches this route. No auth guard
  // here specifically because the key itself is an unguessable random
  // token minted by this same backend seconds earlier, the same trust
  // model a real presigned URL uses.
  @Post('local-upload/:key')
  async localUpload(
    @Param('key') key: string,
    @Body() body: { dataUri: string },
  ) {
    if (process.env.STORAGE_DRIVER !== 'local') {
      throw new BadRequestException(
        'Local upload is not enabled on this deployment.',
      );
    }
    const url = this.storageService.saveLocalUploadBody(key, body.dataUri);
    return { success: true, url };
  }
}
