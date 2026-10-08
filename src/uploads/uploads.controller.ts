import { Body, Controller, Post, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../common/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';

const signSchema = z.object({ kind: z.enum(['avatar', 'portfolio', 'evidence', 'logo']) });

/** Signed direct-to-Cloudinary upload: the app uploads the file itself, the server only signs. */
@Controller('uploads')
export class UploadsController {
  @Post('sign')
  sign(@CurrentUser() u: AuthUser, @Body(new ZodPipe(signSchema)) { kind }: z.infer<typeof signSchema>) {
    const url = process.env.CLOUDINARY_URL;
    if (!url) throw new ServiceUnavailableException("Uploads aren't available right now.");
    const { username: apiKey, password: apiSecret, hostname: cloudName } = new URL(url);
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = `africre8/${kind}/${u.id}`;
    const signature = createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${apiSecret}`).digest('hex');
    return {
      uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
      apiKey,
      timestamp,
      folder,
      signature,
    };
  }
}
