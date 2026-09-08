import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE_ROOT = path.resolve(__dirname, '../../../');
const UI_SRC_DIR = path.join(WORKSPACE_ROOT, 'packages/ui/src');
const TOKEN_STATS_UI_DIR = path.join(WORKSPACE_ROOT, 'plugins/token-stats/ui');
const MIGRATION_GUARDS_TEST_FILE = path.join(WORKSPACE_ROOT, 'packages/ui/src/migration-guards.test.ts');

function shouldSkipGuardFile(filePath: string): boolean {
  return path.resolve(filePath) === path.resolve(MIGRATION_GUARDS_TEST_FILE);
}


// Helper to find all .svelte files recursively
function getSvelteFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getSvelteFiles(filePath));
    } else if (filePath.endsWith('.svelte')) {
      results.push(filePath);
    }
  });
  return results;
}

function getSourceFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const list = fs.readdirSync(dir);
  list.forEach((file) => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat && stat.isDirectory()) {
      results = results.concat(getSourceFiles(filePath));
    } else if (/\.(svelte|ts)$/.test(filePath)) {
      results.push(filePath);
    }
  });
  return results;
}

function uniquePaths(list: string[]): string[] {
  return [...new Set(list)].sort();
}

function cleanLine(line: string): string {
  let cleaned = line.replace(/\/\/.*$/, '');
  cleaned = cleaned.replace(/'[^']*'/g, '');
  cleaned = cleaned.replace(/"[^"]*"/g, '');
  cleaned = cleaned.replace(/`[^`]*`/g, '');
  return cleaned;
}

const ALL_SVELTE_FILES = getSvelteFiles(UI_SRC_DIR).concat(getSvelteFiles(TOKEN_STATS_UI_DIR));
const ALL_SOURCE_FILES = uniquePaths(getSourceFiles(UI_SRC_DIR).concat(getSourceFiles(TOKEN_STATS_UI_DIR)));

describe('Migration Guards', () => {
  // 1. Forbidden component layers and legacy directories
  test('Forbidden component layers and legacy directories must not exist', () => {
    const forbiddenDirs = [
      path.join(UI_SRC_DIR, 'components/controls'),
      path.join(UI_SRC_DIR, 'components/form'),
      path.join(UI_SRC_DIR, 'components/common'),
      path.join(UI_SRC_DIR, 'components/compat'),
      path.join(UI_SRC_DIR, 'components/legacy'),
      path.join(UI_SRC_DIR, 'components/smart-input'),
      path.join(UI_SRC_DIR, 'components/sections'),
      path.join(UI_SRC_DIR, 'components/model-mapping'),
      path.join(UI_SRC_DIR, 'lib'),
    ];

    forbiddenDirs.forEach((dir) => {
      expect(fs.existsSync(dir)).toBe(false);
    });
  });

  // 2. Direct Bits import boundaries
  test('Direct bits-ui imports must be restricted to allowed files', () => {
    const allowedFiles: string[] = [];

    ALL_SVELTE_FILES.forEach((filePath) => {
      if (shouldSkipGuardFile(filePath)) {
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(WORKSPACE_ROOT, filePath);
      if (content.includes('bits-ui')) {
        const isAllowed = allowedFiles.includes(filePath) || relativePath.startsWith('packages/ui/src/components/ui/');
        if (!isAllowed) {
          throw new Error(`Forbidden direct bits-ui import in: ${relativePath}`);
        }
      }
    });
  });

  test('Removed compatibility layers and legacy component paths must not exist or be referenced', () => {
    const legacyDirectoryNames = [
      'components/common',
      'components/compat',
      'components/legacy',
      'components/form',
      'components/controls',
      'components/smart-input',
      'components/sections',
      'components/model-mapping',
    ];

    const legacyIdentifiers = [
      'smart-input',
      'SmartInput',
      'NxSmartInput',
      'NxUrlInput',
      'NxExpressionInput',
      'NxHeaderKeyInput',
      'NxComboInput',
      'NxNumberInput',
      'NxRegexInput',
      'NxSelect',
      'NxDropdownMenu',
      '/src/lib',
      '$lib/',
      '/lib/',
    ];

    const sourceRoots = [
      UI_SRC_DIR,
      TOKEN_STATS_UI_DIR,
    ];

    for (const root of sourceRoots) {
      getSourceFiles(root).forEach((filePath) => {
        const relative = path.relative(WORKSPACE_ROOT, filePath);
        if (shouldSkipGuardFile(filePath)) {
          return;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        if (legacyDirectoryNames.some((name) => content.includes(name))) {
          throw new Error(`Legacy directory name reference in: ${relative}`);
        }

        if (legacyIdentifiers.some((name) => content.includes(name))) {
          throw new Error(`Legacy identifier reference in: ${relative}`);
        }
      });
    }

    const forbiddenString = path.join(WORKSPACE_ROOT, 'packages/ui/src/lib');
    expect(fs.existsSync(forbiddenString)).toBe(false);
    expect(fs.existsSync(path.join(WORKSPACE_ROOT, 'packages/ui/src/smart-input'))).toBe(false);
  });

  test('Legacy Nx-style identifiers must be absent from source', () => {
    const forbiddenPattern = /\bNx[A-Z][A-Za-z0-9_-]*\b/g;

    ALL_SOURCE_FILES.forEach((filePath) => {
      if (shouldSkipGuardFile(filePath)) {
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      if (forbiddenPattern.test(content)) {
        throw new Error(`Forbidden Nx-style identifier in: ${path.relative(WORKSPACE_ROOT, filePath)}`);
      }
    });
  });

  test('Legacy theme class tokens must be absent from migrated surfaces', () => {
    const forbiddenClassPattern = /(?:^|\s)(?:btn(?:-[a-z0-9/]+)?|badge(?:-[a-z0-9/]+)?|card(?:-[a-z0-9/]+)?|toggle(?:-[a-z0-9/]+)?|form-control|label-text(?:-[a-z0-9/]+)?|alert(?:-[a-z0-9/]+)?|modal(?:-[a-z0-9/]+)?|table(?:-[a-z0-9/]+)?|dropdown-content|tabs-boxed|join|input-bordered|base-100|base-content|text-error)(?:\s|$)/;

    ALL_SVELTE_FILES.forEach((filePath) => {
      if (shouldSkipGuardFile(filePath)) {
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const classAttrs = content.match(/class(?:=|:)({[^}]+}|"[^"]+"|'[^']+'|[a-zA-Z0-9_/-]+)/g) ?? [];
      const offending = classAttrs.filter((classAttr) => forbiddenClassPattern.test(classAttr));
      if (offending.length > 0) {
        throw new Error(`Forbidden legacy theme class token in ${path.relative(WORKSPACE_ROOT, filePath)}: ${offending.join(', ')}`);
      }
    });
  });

  // 5. Legacy Svelte syntax candidates baseline guard
  test('Legacy Svelte syntax candidates must not exceed baseline counts', () => {
    let exportLetCount = 0;
    let reactiveCount = 0;
    let onEventCount = 0;
    let slotCount = 0;
    let dispatcherCount = 0;

    ALL_SVELTE_FILES.forEach((filePath) => {
      if (shouldSkipGuardFile(filePath)) {
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');

      const exportLetMatches = content.match(/\bexport\s+let\b/g);
      if (exportLetMatches) exportLetCount += exportLetMatches.length;

      const reactiveMatches = content.match(/^\s*\$:/gm);
      if (reactiveMatches) reactiveCount += reactiveMatches.length;

      const onEventMatches = content.match(/\bon:[a-zA-Z0-9_]+/g);
      if (onEventMatches) onEventCount += onEventMatches.length;

      const slotMatches = content.match(/<slot\b/g);
      if (slotMatches) slotCount += slotMatches.length;

      const dispatcherMatches = content.match(/\bcreateEventDispatcher\b/g);
      if (dispatcherMatches) dispatcherCount += dispatcherMatches.length;
    });

    // Baselines: export let: 259, $: 194, on: 377, <slot>: 22, createEventDispatcher: 36
	expect(exportLetCount).toBeLessThanOrEqual(380);
	expect(reactiveCount).toBeLessThanOrEqual(203);
	expect(onEventCount).toBeLessThanOrEqual(520);
	expect(slotCount).toBeLessThanOrEqual(180);
	expect(dispatcherCount).toBeLessThanOrEqual(40);
  });

	// 6. shadcn-svelte source layer: components/ui/ must not contain business logic
	test('components/ui/ shadcn source layer must not contain business logic wrappers', () => {
		const uiDir = path.join(UI_SRC_DIR, 'components/ui');
		if (!fs.existsSync(uiDir)) return;

		const forbiddenBusinessPatterns = [
			/clearable/,
			/maxTags/,
			/removeTag/,
			/selectedMultipleItems/,
			/multiSelectTags/,
			/countOverflow/,
		];

		getSourceFiles(uiDir).forEach((filePath) => {
			if (shouldSkipGuardFile(filePath)) return;
			const content = fs.readFileSync(filePath, 'utf-8');
			const relative = path.relative(WORKSPACE_ROOT, filePath);
			forbiddenBusinessPatterns.forEach((pattern) => {
				if (pattern.test(content)) {
					throw new Error(`Forbidden business logic pattern ${pattern} in shadcn source layer: ${relative}`);
				}
			});
		});
	});

	test('$_() inside reactive blocks must be guarded by $isLoading', () => {
    const allowlist = [
      'packages/ui/src/routes/Dashboard.svelte',
      'packages/ui/src/routes/ServiceEditor.svelte',
      'packages/ui/src/routes/RoutesIndex.svelte',
      'packages/ui/src/routes/ServicesIndex.svelte',
      'packages/ui/src/routes/Plugins.svelte',
      'packages/ui/src/routes/RouteEditor.svelte',
      'packages/ui/src/routes/Configuration.svelte',
      'packages/ui/src/components/AuthEditor.svelte',
      'packages/ui/src/components/EndpointQuickPreview.svelte',
      'packages/ui/src/components/ModelMappingEditor.svelte',
      'packages/ui/src/components/domain/route/UpstreamsModal.svelte',
      'packages/ui/src/components/domain/route/HeadersEditor.svelte',
      'packages/ui/src/components/domain/route/QueryEditor.svelte',
      'packages/ui/src/components/PluginEditor.svelte',
      'packages/ui/src/components/PluginConfigDisplay.svelte',
      'packages/ui/src/components/domain/route/RouteCard.svelte',
      'packages/ui/src/components/LoggingEditor.svelte',
      'packages/ui/src/components/LogDetailModal.svelte',
      'packages/ui/src/components/DynamicPluginForm.svelte',
      'packages/ui/src/components/domain/route/sections/DirectResponseSection.svelte',
      'packages/ui/src/components/FailoverEditor.svelte',
      'packages/ui/src/components/ModelMappingCatalogManager.svelte',
      'packages/ui/src/components/domain/service/LoadBalancingSection.svelte',
      'packages/ui/src/components/domain/route/UpstreamForm.svelte',
      'packages/ui/src/components/shell/ConfirmDialog.svelte',
      'packages/ui/src/components/domain/route/sections/PreviewSection.svelte',
      'packages/ui/src/components/domain/route/sections/UpstreamTargetSection.svelte',
      'packages/ui/src/components/domain/route/BodyEditor.svelte',
      'packages/ui/src/components/domain/route/sections/UpstreamsSection.svelte',
      'packages/ui/src/components/domain/route/sections/RetrySection.svelte',
      'packages/ui/src/components/domain/route/sections/ModificationSection.svelte',
      'packages/ui/src/components/domain/route/sections/CorsSection.svelte',
      'packages/ui/src/components/domain/route/sections/FailoverSection.svelte',
      'packages/ui/src/components/domain/route/sections/BasicInfoSection.svelte',
      'packages/ui/src/components/domain/route/sections/RateLimitSection.svelte',
      'plugins/token-stats/ui/TokenStatsChart.svelte',
    ].map((p) => path.resolve(WORKSPACE_ROOT, p));

    ALL_SVELTE_FILES.forEach((filePath) => {
      if (shouldSkipGuardFile(filePath)) {
        return;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith('$:')) {
          let statement = line;
          const startLine = i + 1;
          if (trimmed.includes('{')) {
            const cleanedTrimmed = cleanLine(trimmed);
            let braceCount = (cleanedTrimmed.match(/\{/g) || []).length - (cleanedTrimmed.match(/\}/g) || []).length;
            i++;
            while (i < lines.length && braceCount > 0) {
              const nextLine = lines[i];
              statement += '\n' + nextLine;
              const cleanedNextLine = cleanLine(nextLine);
              braceCount += (cleanedNextLine.match(/\{/g) || []).length - (cleanedNextLine.match(/\}/g) || []).length;
              i++;
            }
          }

          if (statement.includes('$_') && !statement.includes('$isLoading')) {
            if (!allowlist.includes(filePath)) {
              throw new Error(
                `Unguarded $_() in reactive block at line ${startLine} of ${path.relative(WORKSPACE_ROOT, filePath)}:\n${statement}`,
              );
            }
          }
        }
        i++;
      }
    });
  });
});

// BSelect single-mode must keep its width-stabilization ghost span.
// Without it, the trigger resizes every time the user picks a different
// option — a regression that has happened three times because the ghost
// span was overwritten by subsequent BSelect refactors. This guard locks
// the structural defense in place.
describe('Migration Guards', () => {
  const BSELECT_PATH = path.join(UI_SRC_DIR, 'components/industrial/BSelect.svelte');

  test('BSelect.svelte must retain the width-stabilization ghost span', () => {
    if (!fs.existsSync(BSELECT_PATH)) {
      throw new Error(`BSelect.svelte not found at ${BSELECT_PATH}`);
    }
    const content = fs.readFileSync(BSELECT_PATH, 'utf-8');

    const requiredTokens = [
      'ghostEl',                          // $state ref bound to the ghost span
      'longestLabel',                     // $derived longest label across options
      'ResizeObserver',                   // observes ghost span and re-measures
      'stableWidth',                      // CSS width string applied to outer wrapper
      'aria-hidden="true"',              // ghost span must be hidden from AT
      'longestLabel || placeholder',      // fallback when options is empty
      'autoWidth',                        // prop that gates ghost span rendering (route filter bars set true; default false = fill container)
    ];

    const missing = requiredTokens.filter((token) => !content.includes(token));
    if (missing.length > 0) {
      throw new Error(
        `BSelect.svelte is missing width-stabilization tokens: ${missing.join(', ')}.\n` +
        `Without the ghost span, single-mode BSelect width collapses every time the user picks a different option ` +
        `(regression has happened three times — see session history compartment 2156 and the dev branch investigation). ` +
        `Re-implement the ghost span before changing BSelect.svelte further.`,
      );
    }
  });

  // Timeout ownership split (Route owns request_ms, Service owns connect_ms).
  // Connect timeout moved from RouteConfig to Service on 2026-07-07 to align
  // with industry mainstream (Envoy/APISIX) — connect describes the backend
  // pool, request deadline describes the client contract. This guard prevents
  // future refactors from adding connect_ms back to RouteTimeoutsConfig.
  const TYPES_CORE_PATH = path.join(WORKSPACE_ROOT, 'packages/types/src/types.ts');
  const TYPES_UI_PATH = path.join(UI_SRC_DIR, 'types/index.ts');

  test('RouteTimeoutsConfig must NOT own connect_ms (timeout ownership split)', () => {
    for (const p of [TYPES_CORE_PATH, TYPES_UI_PATH]) {
      if (!fs.existsSync(p)) throw new Error(`types file not found at ${p}`);
      const content = fs.readFileSync(p, 'utf-8');

      const routeTimeoutsMatch = content.match(/export interface RouteTimeoutsConfig\s*\{([^}]*)\}/);
      if (!routeTimeoutsMatch) {
        throw new Error(`RouteTimeoutsConfig not found in ${p}`);
      }
      if (routeTimeoutsMatch[1].includes('connect_ms')) {
        throw new Error(
          `RouteTimeoutsConfig in ${p} must not contain connect_ms. ` +
          `Connect timeout belongs to Service.timeouts (ServiceTimeoutsConfig). ` +
          `See .omo/plans/timeout-ownership-split.md for design rationale.`,
        );
      }
      if (!routeTimeoutsMatch[1].includes('request_ms')) {
        throw new Error(`RouteTimeoutsConfig in ${p} must contain request_ms.`);
      }
    }
  });

  test('Service must own ServiceTimeoutsConfig with connect_ms', () => {
    for (const p of [TYPES_CORE_PATH, TYPES_UI_PATH]) {
      if (!fs.existsSync(p)) throw new Error(`types file not found at ${p}`);
      const content = fs.readFileSync(p, 'utf-8');

      const serviceTimeoutsMatch = content.match(/export interface ServiceTimeoutsConfig\s*\{([^}]*)\}/);
      if (!serviceTimeoutsMatch) {
        throw new Error(`ServiceTimeoutsConfig interface not found in ${p}`);
      }
      if (!serviceTimeoutsMatch[1].includes('connect_ms')) {
        throw new Error(`ServiceTimeoutsConfig in ${p} must contain connect_ms.`);
      }

      const serviceMatch = content.match(/export interface Service\s*\{([^}]*)\}/);
      if (!serviceMatch) {
        throw new Error(`Service interface not found in ${p}`);
      }
      if (!serviceMatch[1].includes('timeouts?')) {
        throw new Error(`Service interface in ${p} must have timeouts? field.`);
      }
    }
  });

  test('StickySessionConfig must NOT exist; Service must own LoadBalancingConfig', () => {
    for (const p of [TYPES_CORE_PATH, TYPES_UI_PATH]) {
      if (!fs.existsSync(p)) throw new Error(`types file not found at ${p}`);
      const content = fs.readFileSync(p, 'utf-8');

      if (/export\s+interface\s+StickySessionConfig/.test(content)) {
        throw new Error(`StickySessionConfig interface still defined in ${p} — sticky_session was replaced by load_balancing.consistent_hash.`);
      }
      if (/sticky_session\??\s*:/.test(content)) {
        throw new Error(`sticky_session field still present in ${p}.`);
      }

      const lbMatch = content.match(/export\s+interface\s+LoadBalancingConfig\s*\{([^}]*)\}/);
      if (!lbMatch) {
        throw new Error(`LoadBalancingConfig interface not found in ${p}`);
      }
      if (!lbMatch[1].includes('policy')) {
        throw new Error(`LoadBalancingConfig in ${p} must contain policy field.`);
      }

      const serviceMatch = content.match(/export\s+interface\s+Service\s*\{([^}]*)\}/);
      if (!serviceMatch) {
        throw new Error(`Service interface not found in ${p}`);
      }
      if (!serviceMatch[1].includes('load_balancing?')) {
        throw new Error(`Service interface in ${p} must have load_balancing? field.`);
      }
    }
  });

  test('FailoverConfig must NOT own health_check (health_check extraction)', () => {
    for (const p of [TYPES_CORE_PATH, TYPES_UI_PATH]) {
      if (!fs.existsSync(p)) throw new Error(`types file not found at ${p}`);
      const content = fs.readFileSync(p, 'utf-8');

      const failoverMatch = content.match(/export\s+interface\s+FailoverConfig\s*\{([\s\S]*?)\}/);
      if (!failoverMatch) {
        throw new Error(`FailoverConfig interface not found in ${p}`);
      }
      if (failoverMatch[1].includes('health_check')) {
        throw new Error(
          `FailoverConfig in ${p} must not contain health_check. ` +
          `Active health check is an independent subsystem owned by Service.health_check. ` +
          `See .omo/plans/failover-design.md for design rationale.`,
        );
      }
    }
  });

  test('Service must own ServiceHealthCheckConfig', () => {
    for (const p of [TYPES_CORE_PATH, TYPES_UI_PATH]) {
      if (!fs.existsSync(p)) throw new Error(`types file not found at ${p}`);
      const content = fs.readFileSync(p, 'utf-8');

      const hcMatch = content.match(/export\s+interface\s+ServiceHealthCheckConfig\s*\{([\s\S]*?)\}/);
      if (!hcMatch) {
        throw new Error(`ServiceHealthCheckConfig interface not found in ${p}`);
      }
      if (!hcMatch[1].includes('enabled')) {
        throw new Error(`ServiceHealthCheckConfig in ${p} must contain enabled field.`);
      }
      if (!hcMatch[1].includes('auto_enable_on_active_health_check')) {
        throw new Error(`ServiceHealthCheckConfig in ${p} must contain auto_enable_on_active_health_check field.`);
      }

      const serviceMatch = content.match(/export\s+interface\s+Service\s*\{([\s\S]*?)\}/);
      if (!serviceMatch) {
        throw new Error(`Service interface not found in ${p}`);
      }
      if (!serviceMatch[1].includes('health_check?')) {
        throw new Error(`Service interface in ${p} must have health_check? field.`);
      }
    }
  });

  test('FailoverRecovery must use backoff_base_ms not probe_interval_ms', () => {
    for (const p of [TYPES_CORE_PATH, TYPES_UI_PATH]) {
      if (!fs.existsSync(p)) throw new Error(`types file not found at ${p}`);
      const content = fs.readFileSync(p, 'utf-8');

      const recoveryMatch = content.match(/export\s+interface\s+FailoverRecoveryConfig\s*\{([\s\S]*?)\}/);
      if (!recoveryMatch) {
        throw new Error(`FailoverRecoveryConfig interface not found in ${p}`);
      }
      if (recoveryMatch[1].includes('probe_interval_ms')) {
        throw new Error(
          `FailoverRecoveryConfig in ${p} must not contain probe_interval_ms. ` +
          `Renamed to backoff_base_ms (exponential backoff base, not a fixed interval).`,
        );
      }
      if (!recoveryMatch[1].includes('backoff_base_ms')) {
        throw new Error(`FailoverRecoveryConfig in ${p} must contain backoff_base_ms.`);
      }
    }
  });

  const LOGS_UI_API_PATH = path.join(UI_SRC_DIR, 'api/logs.ts');
  const LOGS_CORE_API_PATH = path.join(WORKSPACE_ROOT, 'packages/core/src/api/logs.ts');
  const LOGS_HANDLER_PATH = path.join(WORKSPACE_ROOT, 'packages/core/src/api/handlers/logs.ts');
  const ROUTER_PATH = path.join(WORKSPACE_ROOT, 'packages/core/src/api/router.ts');
  const LOGS_ROUTE_PATH = path.join(UI_SRC_DIR, 'routes/Logs.svelte');

  test('chain aggregation — UI api/logs.ts must expose chain types and functions', () => {
    if (!fs.existsSync(LOGS_UI_API_PATH)) throw new Error(`api/logs.ts not found at ${LOGS_UI_API_PATH}`);
    const content = fs.readFileSync(LOGS_UI_API_PATH, 'utf-8');

    const required = [
      'interface ChainEntry',
      'interface ChainDetail',
      'interface ChainQueryResult',
      'export async function queryChains',
      'export async function getChainDetail',
      'isFailoverAttempt',
      'parentRequestId',
      'attemptNumber',
      'attemptUpstream',
      'encodeURIComponent',
    ];
    const missing = required.filter((t) => !content.includes(t));
    if (missing.length > 0) {
      throw new Error(`api/logs.ts missing chain tokens: ${missing.join(', ')}. See .omo/plans/access-log-chain-aggregation.md.`);
    }
  });

  test('chain aggregation — Logs.svelte must render chain-level fields', () => {
    if (!fs.existsSync(LOGS_ROUTE_PATH)) throw new Error(`Logs.svelte not found at ${LOGS_ROUTE_PATH}`);
    const content = fs.readFileSync(LOGS_ROUTE_PATH, 'utf-8');

    const required = ['chainAttempts', 'chainStatus', 'chainDurationMs', 'hasRetryFilter', 'ChainEntry', 'queryChains', 'ChainDetailModal'];
    const missing = required.filter((t) => !content.includes(t));
    if (missing.length > 0) {
      throw new Error(`Logs.svelte missing chain tokens: ${missing.join(', ')}. See .omo/plans/access-log-chain-aggregation.md.`);
    }
  });

  test('chain aggregation — core LogQueryService must expose queryChains', () => {
    if (!fs.existsSync(LOGS_CORE_API_PATH)) throw new Error(`core api/logs.ts not found at ${LOGS_CORE_API_PATH}`);
    const content = fs.readFileSync(LOGS_CORE_API_PATH, 'utf-8');

    const required = ['queryChains', 'getChainDetail', 'getChainUpstreams', 'CHAIN_SORT_COLUMNS', 'attemptUpstream', 'parentRequestId'];
    const missing = required.filter((t) => !content.includes(t));
    if (missing.length > 0) {
      throw new Error(`core api/logs.ts missing chain tokens: ${missing.join(', ')}. See .omo/plans/access-log-chain-aggregation.md.`);
    }
  });

  test('chain aggregation — handler must accept groupBy and chain route', () => {
    if (!fs.existsSync(LOGS_HANDLER_PATH)) throw new Error(`logs handler not found at ${LOGS_HANDLER_PATH}`);
    const content = fs.readFileSync(LOGS_HANDLER_PATH, 'utf-8');

    if (!content.includes("groupBy") || !content.includes("'chain'")) {
      throw new Error(`logs handler must accept groupBy param and check 'chain' value. See .omo/plans/access-log-chain-aggregation.md.`);
    }
    if (!content.includes('getChainDetail') && !content.includes('getChainUpstreams')) {
      throw new Error(`logs handler must call getChainDetail/getChainUpstreams for chain detail endpoint.`);
    }
  });

  test('chain aggregation — chain detail route must be registered before :requestId catch-all', () => {
    if (!fs.existsSync(ROUTER_PATH)) throw new Error(`router not found at ${ROUTER_PATH}`);
    const content = fs.readFileSync(ROUTER_PATH, 'utf-8');

    const chainIdx = content.indexOf("'/api/logs/chain/'");
    if (chainIdx === -1) {
      throw new Error(`router must register /api/logs/chain/ route (startsWith pattern).`);
    }
    const catchAllIdx = content.indexOf("'/api/logs/'");
    if (catchAllIdx === -1) {
      throw new Error(`router must register /api/logs/ catch-all route.`);
    }
    if (chainIdx > catchAllIdx) {
      throw new Error(
        `/api/logs/chain/ must be registered BEFORE /api/logs/ catch-all in router.ts. ` +
        `Otherwise the catch-all shadows the chain route and it never matches.`,
      );
    }
  });

  test('packages/core/src/api/logs.ts getTimeSeriesStats must use COALESCE(parent_request_id, request_id) for chain dimension', () => {
    const content = fs.readFileSync(path.resolve(WORKSPACE_ROOT, 'packages/core/src/api/logs.ts'), 'utf-8');
    const getTimeSeriesMatch = content.match(/getTimeSeriesStats[\s\S]*?COALESCE\(parent_request_id, request_id\)/);
    expect(getTimeSeriesMatch).toBeTruthy();
  });

  test('packages/core/src/api/logs.ts getStats must use COALESCE(parent_request_id, request_id) for chain dimension', () => {
    const content = fs.readFileSync(path.resolve(WORKSPACE_ROOT, 'packages/core/src/api/logs.ts'), 'utf-8');
    const getStatsMatch = content.match(/getStats[\s\S]*?COALESCE\(parent_request_id, request_id\)/);
    expect(getStatsMatch).toBeTruthy();
  });

  test('packages/core/src/api/logs.ts getStats must use ROW_NUMBER() AS status_rank for final-status selection', () => {
    const content = fs.readFileSync(path.resolve(WORKSPACE_ROOT, 'packages/core/src/api/logs.ts'), 'utf-8');
    const getStatsSection = content.match(/getStats[\s\S]*?async getTimeSeriesStats/);
    expect(getStatsSection).toBeTruthy();
    const hasStatusRank = getStatsSection![0].includes('status_rank');
    expect(hasStatusRank).toBe(true);
  });

  test('packages/core/src/api/logs.ts getTimeSeriesStats must use ROW_NUMBER() AS status_rank for final-status selection', () => {
    const content = fs.readFileSync(path.resolve(WORKSPACE_ROOT, 'packages/core/src/api/logs.ts'), 'utf-8');
    const tsSection = content.match(/getTimeSeriesStats[\s\S]*?async getUpstreamDistribution/);
    expect(tsSection).toBeTruthy();
    const hasStatusRank = tsSection![0].includes('status_rank');
    expect(hasStatusRank).toBe(true);
  });

  test('packages/core/tests/unit/stats-chain-dimension.test.ts must import LogQueryService (no production SQL copy)', () => {
    const content = fs.readFileSync(path.resolve(WORKSPACE_ROOT, 'packages/core/tests/unit/stats-chain-dimension.test.ts'), 'utf-8');
    expect(content.includes('import { LogQueryService }')).toBe(true);
    const hasProdSqlCopy = /COALESCE\(parent_request_id,\s*request_id\)/.test(content) && !content.includes('import { LogQueryService }');
    expect(hasProdSqlCopy).toBe(false);
  });

  test('BasicInfoSection.svelte path_rewrite sync must be guarded by showOnly + init flag (no dual-instance race)', () => {
    const content = fs.readFileSync(path.join(UI_SRC_DIR, 'components/domain/route/sections/BasicInfoSection.svelte'), 'utf-8');
    expect(content.includes("showOnly === 'rewrite'")).toBe(true);
    expect(content.includes('rewriteInitialized')).toBe(true);
    expect(content).not.toMatch(/\$:\s*\{\s*if\s*\(\s*!pathRewriteEntries\.length\s*&&\s*route\.path_rewrite\s*\)/);
  });

  test('packages/types/src/types.ts FailoverConfig.retry_on_response must be string[] keywords', () => {
    const content = fs.readFileSync(path.resolve(WORKSPACE_ROOT, 'packages/types/src/types.ts'), 'utf-8');
    const failoverConfigMatch = content.match(/export interface FailoverConfig[\s\S]*?slow_start\?: FailoverSlowStartConfig;[\s\S]*?\}/);
    expect(failoverConfigMatch).toBeTruthy();
    expect(failoverConfigMatch![0].includes('retry_on_response?: string[]')).toBe(true);
    expect(content.includes('export interface ResponseRetryRule')).toBe(false);
  });

  test('packages/core/src/worker/request/response-detector.ts must exist and export checkResponseForFailover', () => {
    const detectorPath = path.resolve(WORKSPACE_ROOT, 'packages/core/src/worker/request/response-detector.ts');
    expect(fs.existsSync(detectorPath)).toBe(true);
    const content = fs.readFileSync(detectorPath, 'utf-8');
    expect(content.includes('export async function checkResponseForFailover')).toBe(true);
    expect(content.includes('MAX_BODY_INSPECT')).toBe(true);
    expect(content.includes('MAX_PEEK_BYTES')).toBe(true);
    expect(content.includes('matchedKeyword')).toBe(true);
  });

  test('packages/core/src/worker/request/handler.ts must integrate detector call at failover checkpoint', () => {
    const content = fs.readFileSync(path.resolve(WORKSPACE_ROOT, 'packages/core/src/worker/request/handler.ts'), 'utf-8');
    expect(content.includes("import { checkResponseForFailover } from './response-detector'")).toBe(true);
    expect(content.includes('checkResponseForFailover(result.response, responseKeywords)')).toBe(true);
    expect(content).toMatch(/export function isStreamingResponse/);
  });

  test('FailoverEditor.svelte must render keyword list for retry_on_response with working remove', () => {
    const content = fs.readFileSync(path.join(UI_SRC_DIR, 'components/domain/service/FailoverEditor.svelte'), 'utf-8');
    expect(content.includes('responseKeywords')).toBe(true);
    expect(content.includes('addKeyword')).toBe(true);
    expect(content.includes('removeKeyword')).toBe(true);
    expect(content.includes("failover?.retry_on_response")).toBe(true);
    expect(content.includes('retry_on_response:')).toBe(true);
    expect(content.includes('on:click={() => removeKeyword(idx)}')).toBe(true);
    expect(content.includes('IconButton')).toBe(false);
  });
});

// Explicit classification contract for the single 1280px page-width standard
// (docs/INDUSTRIAL_DESIGN_SYSTEM.md §4.8). Every App-routed surface uses the
// standard nx-page container; Login/NotFound are purpose-built and excluded.
// New route files fail the completeness test below until they are added here.
const PAGE_WIDTH_PAGES = [
  'Dashboard.svelte',
  'ServicesIndex.svelte',
  'Configuration.svelte',
  'Plugins.svelte',
  'PluginDetailLayout.svelte',
  'DesignSystem.svelte',
  'ServiceEditor.svelte',
  'RouteEditor.svelte',
  'RoutesIndex.svelte',
  'Logs.svelte',
];
const PAGE_WIDTH_EXEMPT = ['Login.svelte', 'NotFound.svelte'];
const EDITOR_PAGES = ['ServiceEditor.svelte', 'RouteEditor.svelte'];

describe('Page-width guards', () => {
  const ROUTES_DIR = path.join(UI_SRC_DIR, 'routes');

  test('every routes/*.svelte file is classified or purpose-built', () => {
    const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.svelte'));
    files.forEach((file) => {
      const classified = PAGE_WIDTH_PAGES.includes(file) || PAGE_WIDTH_EXEMPT.includes(file);
      expect(classified, `${file} must be added to PAGE_WIDTH_PAGES or PAGE_WIDTH_EXEMPT`).toBe(true);
    });
  });

  test('app.css defines only the nx-page standard-width utility', () => {
    const content = fs.readFileSync(path.join(UI_SRC_DIR, 'app.css'), 'utf-8');
    expect(content).toContain('.nx-page {\n    @apply w-full max-w-screen-xl mx-auto px-4 sm:px-6;');
    expect(content).not.toContain('nx-page-wide');
  });

  test('no route uses a page-width tier other than nx-page', () => {
    fs.readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith('.svelte'))
      .forEach((file) => {
        const content = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf-8');
        expect(content, `${file} must not reference nx-page-wide`).not.toContain('nx-page-wide');
      });
  });

  test.each(PAGE_WIDTH_PAGES)('%s uses the standard nx-page container and no raw max-width', (file) => {
    const content = fs.readFileSync(path.join(ROUTES_DIR, file), 'utf-8');
    const tierCount = (content.match(/\bnx-page\b(?!-)/g) || []).length;
    expect(tierCount).toBeGreaterThan(0);
    // Page-level caps must come from the nx-page class; inner detail/modal max widths stay untouched.
    expect(content).not.toMatch(/\bmax-w-(?:6xl|7xl|screen-[\w-]+)/);
    if (EDITOR_PAGES.includes(file)) {
      // Editors keep an unconstrained min-h-screen shell; exactly the three
      // header / main / footer inner wrappers carry the tier class.
      expect(tierCount).toBe(3);
      expect(content).not.toMatch(/\bnx-page\b[^"]*nx-page/);
    }
  });

  test('App.svelte wraps the extension PluginHost in the standard tier', () => {
    const content = fs.readFileSync(path.join(UI_SRC_DIR, 'App.svelte'), 'utf-8');
    expect(content).toMatch(/<div class="nx-page[^"]*">\s*<PluginHost/);
  });

  test('ServiceEditor keeps fixed-action clearance on the content section like RouteEditor', () => {
    const route = fs.readFileSync(path.join(ROUTES_DIR, 'RouteEditor.svelte'), 'utf-8');
    const service = fs.readFileSync(path.join(ROUTES_DIR, 'ServiceEditor.svelte'), 'utf-8');
    // Keep the reserved space off the wrapper whose sm:py-6 overrides base pb-*.
    expect(route.match(/<section class="([^"]+)"/)?.[1]).toContain('pb-16');
    expect(service.match(/<section class="([^"]+)"/)?.[1]).toBe(route.match(/<section class="([^"]+)"/)?.[1]);
    expect(service.match(/<div class="(nx-page flex [^"]+)"/)?.[1]).toBe(route.match(/<div class="(nx-page flex [^"]+)"/)?.[1]);
    expect(service).toContain('class="fixed bottom-0 left-0 right-0');
  });
});
