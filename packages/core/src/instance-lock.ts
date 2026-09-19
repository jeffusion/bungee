// Shared lock facade. The existing master implementation remains untouched;
// ingress uses the same SQLite transaction ownership semantics.
export {
  acquireMasterInstanceLock as acquireInstanceLock,
  mintControllerClaimCapability,
  consumeControllerClaimCapability,
  MasterInstanceLockError,
} from './master-runtime/instance-lock';
export type { ControllerClaimCapability, MasterInstanceLock } from './master-runtime/instance-lock';
