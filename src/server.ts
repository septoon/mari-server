import express from 'express';

import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middlewares/error-handler';
import { authRouter } from './modules/auth/routes';
import { appointmentsRouter } from './modules/appointments/routes';
import { clientsRouter } from './modules/clients/routes';
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

app.get('/health', (_req, res) => {
  return ok(res, { status: 'ok', time: new Date().toISOString() });
});

app.use('/auth', authRouter);
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
