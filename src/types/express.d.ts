import 'express';
import { AuthenticatedClient } from './auth';

declare global {
  namespace Express {
    interface Request {
      authClient?: AuthenticatedClient;
    }
  }
}

export {};

