/** Isolated readiness observation: does no I/O and never alters chat requests. */
export default class CatalogVersionProbe {
  static readonly name = 'catalog-version-probe';
  static readonly version = '1.0.0';
  private catalog: any;
  async init(context: any): Promise<void> {
    this.catalog = context.services.consume('models-dev', 'models-dev.catalog.v1', 1);
  }
  register(hooks: any): void {
    hooks.onInterceptRequest.tapPromise('catalog-version-probe', async (context: any) => {
      if (context.originalUrl.pathname !== '/catalog-fixture-ready') return;
      const match = this.catalog.resolveModel({ model: 'gpt-4o-mini', pricingProvider: 'openai' });
      return { action: 'respond', response: Response.json({ pid: process.pid,
        version: this.catalog.status().version, inputPrice: match?.input ?? null }) };
    });
  }
}
