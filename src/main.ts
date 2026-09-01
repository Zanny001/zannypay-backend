import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import { json, urlencoded } from 'express';
import { join } from 'path';

async function bootstrap() {
  // bodyParser: false lets us set a higher size limit below — the default
  // 100kb Express limit rejects a base64-encoded profile picture outright.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(json({ limit: '6mb' }));
  app.use(urlencoded({ extended: true, limit: '6mb' }));

  // Trust the first hop in front of this app (Render/Railway/Heroku/Nginx/
  // an AWS ALB, etc.) so `req.ip` reflects the real client address instead
  // of the proxy's own address. This matters everywhere Express reads
  // req.ip, but it is load-bearing for the admin IP allowlist guard
  // specifically — without it, that guard would see the same proxy IP for
  // every admin request and the allowlist would be meaningless. If your
  // deployment sits behind more than one hop of proxying, adjust the
  // number accordingly (see Express's `trust proxy` docs).
  app.set('trust proxy', 1);

  // Security headers
  app.use(helmet());

  // Serves locally-uploaded files (STORAGE_DRIVER=local only — see
  // storage/storage.service.ts) as plain static assets. In production
  // (STORAGE_DRIVER=s3) this directory is never written to and this line
  // is a no-op; local disk storage doesn't survive a redeploy or work
  // across more than one instance, so it's a dev convenience only.
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });

  // Gzip/deflate response bodies — free win on the admin dashboard's
  // list-heavy JSON responses (transaction/user search pages) and costs
  // nothing on the money-movement endpoints, whose payloads are tiny.
  app.use(compression());

  // Cross-Origin Resource Sharing (Allows your app to talk to the backend)
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Strict Payload Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // API Versioning (/api/v1/...)
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.setGlobalPrefix('api');

  const port = process.env.PORT || 10000;
  await app.listen(port);
  console.log(`🚀 ZannyPay Backend is running securely on port ${port}`);
  console.log(
    process.env.ADMIN_IP_ALLOWLIST_ENFORCE === 'true'
      ? '🔒 Admin IP allowlist enforcement is ON.'
      : '⚠️  Admin IP allowlist enforcement is OFF (set ADMIN_IP_ALLOWLIST_ENFORCE=true when ready).',
  );
}
bootstrap();
