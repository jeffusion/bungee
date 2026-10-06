/**
 * Production journal seam for peer-delivered durable commands.
 *
 * This is not a second journal and owns no storage of its own: it constructs the
 * existing P3 {@link CommandJournal} over the *real* {@link PluginDurableStateStore}
 * database, so the journal's atomic planner/reader sees exactly the
 * `plugin_durable_records` rows the provider plugin sees through
 * `durableState.forNamespace(<plugin name>)`. The private state namespace is that
 * same plugin name; the journal's own namespace is a stable
 * `provider.service.v<major>.<method>` so two different methods of one contract
 * can never collide on a persisted quota/private-namespace binding
 * (the journal persists a binding per namespace).
 *
 * Each publication gets its own journal facade with immutable capabilities.
 * Durable identity lives in SQLite, not in a shared mutable capability cache;
 * accepted work from an old owner cannot switch to a replacement owner's plan.
 *
 * Recovery stays fail-closed: `authorizeRecovery` is only passed through from a
 * caller that owns a real terminal proof. Without it, a pending command has no
 * recovery evidence and the reviewed journal reports `unknown` rather than
 * guessing `true`.
 *
 * Every failure (identifier validation, journal
 * construction) makes `resolve` return `null`, which the canonical adapter
 * reports as `capability_unavailable` for that command. A query never touches
 * this path.
 */

import { CommandJournal, type CommandRecoveryAuthorizer } from './command-journal';
import type { HostRpcJournalRequest } from './host-rpc';
import type { PluginDurableStateStore } from '../plugin-durable-state';
import { createHash } from 'node:crypto';

export interface PluginPeerJournalOptions {
  /**
   * The real durable-state store whose database and namespace hold the plugin's
   * private state; the journal shares it so a planner and the plugin observe the
   * same rows.
   */
  readonly store: PluginDurableStateStore;
  /** Real terminal proof only; omitted means pending commands are never recovered. */
  readonly authorizeRecovery?: CommandRecoveryAuthorizer;
  readonly now?: () => number;
}

export interface PluginPeerJournalResolver {
  /** Canonical host journal factory for one command key; `null` refuses it. */
  resolve(request: HostRpcJournalRequest): CommandJournal | null;
  /** Bounded Host lifecycle work; never executes/reconciles business callbacks. */
  maintain(options?: { readonly namespaceLimit?: number; readonly recordLimit?: number }): PluginPeerJournalMaintenance;
  /** Releases this resolver's caches. The shared database is owned elsewhere. */
  close(): void;
}

export interface PluginPeerJournalMaintenance {
  readonly namespaces: number;
  readonly recovered: number;
  readonly collected: number;
  /** Failed namespace operations are observable and retried on the next scan. */
  readonly failures: readonly { readonly namespace: string; readonly code: string }[];
}

function maintenanceLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('invalid journal maintenance limit');
  return Math.min(value ?? fallback, maximum);
}

function methodNamespace(request: HostRpcJournalRequest): string {
  // Tuple encoding avoids dotted-name collisions and overlong valid IDs.
  // Logical scope is stable across physical owner restarts; instance/generation
  // must not enter this key or command deduplication would reset on replacement.
  return `rpc.${createHash('sha256').update(JSON.stringify([
    request.provider, request.service, request.major, request.method,
    request.scope, request.bindingScope ?? null,
  ])).digest('hex')}`;
}

export function createPluginPeerJournalResolver(options: PluginPeerJournalOptions): PluginPeerJournalResolver {
  let closed = false;
  let namespaceCursor = '';
  // Exactly one capability-free facade survives a batch, solely for its key cursor.
  let active: { namespace: string; journal: CommandJournal } | null = null;

  return Object.freeze({
    resolve(request: HostRpcJournalRequest): CommandJournal | null {
      if (closed) return null;
      const namespace = methodNamespace(request);
      const { atomic, external } = request;
      try {
        const journal = new CommandJournal({
          db: options.store.database,
          namespace,
          // The provider's real durable namespace is its plugin name; the same
          // namespace the host injects into the plugin.
          privateStateNamespace: request.provider,
          quotaBytes: request.policy.quotaBytes,
          resolveAtomic: () => atomic ?? null,
          resolveExternal: () => external ?? null,
          ...(options.authorizeRecovery === undefined ? {} : { authorizeRecovery: options.authorizeRecovery }),
          ...(options.now === undefined ? {} : { now: options.now }),
        });
        return journal;
      } catch {
        return null;
      }
    },
    maintain(limits: { readonly namespaceLimit?: number; readonly recordLimit?: number } = {}): PluginPeerJournalMaintenance {
      const namespaceLimit = maintenanceLimit(limits.namespaceLimit, 8, 32);
      const recordLimit = maintenanceLimit(limits.recordLimit, 128, 256);
      let namespaces = 0, recovered = 0, collected = 0;
      const failures: { namespace: string; code: string }[] = [];
      if (closed) return Object.freeze({ namespaces, recovered, collected, failures: Object.freeze(failures) });
      for (let batch = 0; batch < namespaceLimit; batch += 1) {
        if (active === null) {
          const row = options.store.database.query<{ namespace: string }, [string]>(
            `SELECT namespace FROM plugin_communication_records
             WHERE key = 'journal-policy-binding' AND namespace LIKE 'rpc.%' AND namespace > ?
             ORDER BY namespace LIMIT 1`,
          ).get(namespaceCursor);
          if (row === null) { namespaceCursor = ''; break; }
          namespaceCursor = row.namespace;
          try {
            active = { namespace: row.namespace, journal: CommandJournal.forMaintenance({
              db: options.store.database, namespace: row.namespace,
              ...(options.authorizeRecovery === undefined ? {} : { authorizeRecovery: options.authorizeRecovery }),
              ...(options.now === undefined ? {} : { now: options.now }),
            }) };
          } catch (error) {
            failures.push({ namespace: row.namespace, code: String((error as { code?: unknown }).code ?? 'storage_failure') });
            continue;
          }
        }
        namespaces += 1;
        const current = active;
        try {
          collected += current.journal.collect(recordLimit);
          recovered += current.journal.recoverPending(recordLimit);
          if (current.journal.recoveryScanComplete()) active = null;
        } catch (error) {
          failures.push({ namespace: current.namespace, code: String((error as { code?: unknown }).code ?? 'storage_failure') });
          active = null;
        }
      }
      return Object.freeze({ namespaces, recovered, collected, failures: Object.freeze(failures.map(failure => Object.freeze(failure))) });
    },
    close(): void {
      closed = true; active = null;
    },
  });
}
