import type { ConfigMigration } from './types';
import { v1ToV2Migration } from './versions/v1-to-v2';

export const CONFIG_MIGRATIONS: ConfigMigration[] = [
  v1ToV2Migration,
];
