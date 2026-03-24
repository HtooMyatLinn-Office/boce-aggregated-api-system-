import { NextFunction, Request, Response } from 'express';
import { config } from '../config';

export function requireAdminToken(req: Request, res: Response, next: NextFunction) {
  const expected = config.admin.token;
  const got = req.header('X-Admin-Token')?.trim();
  if (!expected) {
    return res.status(500).json({ success: false, error: 'ADMIN_TOKEN is not configured' });
  }
  if (!got || got !== expected) {
    return res.status(403).json({ success: false, error: 'forbidden' });
  }
  return next();
}

