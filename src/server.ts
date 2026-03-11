import express from 'express';

import { env } from './config/env';
import { prisma } from './db/prisma';
import { errorHandler, notFoundHandler } from './middlewares/error-handler';
import { authRouter } from './modules/auth/routes';
import { appointmentsRouter } from './modules/appointments/routes';
import { clientsRouter } from './modules/clients/routes';
import { clientFrontRouter } from './modules/client-front/routes';
import { exportsRouter } from './modules/exports/routes';
import { importsRouter } from './modules/imports/routes';
import { promoCodesRouter } from './modules/promocodes/routes';
import { reportsRouter } from './modules/reports/routes';
import { scheduleRouter } from './modules/schedule/routes';
import { settingsRouter } from './modules/settings/routes';
import { servicesRouter } from './modules/services/routes';
import { staffRouter } from './modules/staff/routes';
import { ok } from './utils/response';

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', async (_req, res, next) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return ok(res, { status: 'ok', time: new Date().toISOString(), database: 'ok' });
  } catch (error) {
    return next(error);
  }
});

app.use(
  env.MEDIA_PUBLIC_BASE,
  express.static(env.MEDIA_ROOT, {
    fallthrough: true,
    immutable: true,
    maxAge: '365d',
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  })
);

app.use('/auth', authRouter);
app.use('/client-front', clientFrontRouter);
app.use('/staff', staffRouter);
app.use('/clients', clientsRouter);
app.use('/imports', importsRouter);
app.use('/exports', exportsRouter);
app.use('/promocodes', promoCodesRouter);
app.use('/services', servicesRouter);
app.use('/reports', reportsRouter);
app.use('/schedule', scheduleRouter);
app.use('/settings', settingsRouter);
app.use(appointmentsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`Server started on port ${env.PORT}`);
});
