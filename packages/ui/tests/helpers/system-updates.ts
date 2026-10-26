import type { SystemUpdateStatus } from '@jeffusion/bungee-types';

/** Shell status read; no release or upgrade is available in unrelated page fixtures. */
export const systemUpdateStatusFixture: SystemUpdateStatus = {
  running_version: '6.6.0', selected_version: null, latest: null, checked_at: null,
  check_error: null, checking: false, can_upgrade: false, unavailable_reason: null, operation: null,
};
