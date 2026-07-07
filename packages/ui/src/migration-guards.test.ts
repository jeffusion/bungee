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
	expect(exportLetCount).toBeLessThanOrEqual(375);
	expect(reactiveCount).toBeLessThanOrEqual(200);
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
      'packages/ui/src/components/domain/route/sections/StickySessionSection.svelte',
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
});
