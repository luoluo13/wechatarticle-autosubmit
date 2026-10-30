import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const dirs = {
  content: path.join(root, 'content'),
  themes: path.join(root, 'themes'),
  build: path.join(root, 'build'),
  auth: path.join(root, 'auth'),
};

export const DEFAULT_THEME = 'orange-heart';
