/**
 * Test-only adapter: build a models-dev public catalog service from a raw
 * models.dev-shaped catalog literal. Production pricing receives the service from
 * the models-dev plugin; this keeps unit fixtures self-contained.
 */

import type { ModelsDevCatalogService } from '../../../models-dev/contract';
import { buildCatalogIndex } from '../../../models-dev/server/catalog';
import { CatalogView, catalogServiceOf } from '../../../models-dev/server/local';

export function rawCatalogService(catalog: unknown): ModelsDevCatalogService {
  const view = new CatalogView();
  view.apply(buildCatalogIndex({ version: 1, fetchedAt: 0, catalog }));
  return catalogServiceOf(view);
}
