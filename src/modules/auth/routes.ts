import { Router } from 'express';

import { clientAuthRouter } from './client-routes';
import { staffAuthRouter } from './staff-routes';

export const authRouter = Router();

authRouter.use('/client', clientAuthRouter);
authRouter.use('/staff', staffAuthRouter);
