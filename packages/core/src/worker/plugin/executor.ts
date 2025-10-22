/**
 * Plugin executor module
 * Implements the onion model for plugin execution
 */

import { logger } from '../../logger';
import type { PluginRegistry } from '../../plugin-registry';
import type { Plugin, PluginContext } from '../../plugin.types';

/**
 * Plugin Executor Class
 *
 * Manages the execution of plugins following the onion model pattern:
 * - Request phase (outer → inner): onRequestInit → onBeforeRequest → onInterceptRequest
 * - Response phase (inner → outer): onResponse
 * - Error phase (inner → outer): onError
 *
 * **Execution order**:
 * 1. Global plugins (from registry)
 * 2. Route-specific plugins
 * 3. Response/Error plugins in reverse order (inbound)
 */
export class PluginExecutor {
  /**
   * Creates a new Plugin Executor
   *
   * @param globalRegistry - Global plugin registry (may be null)
   * @param routePlugins - Route-specific plugins
   */
  constructor(
    private globalRegistry: PluginRegistry | null,
    private routePlugins: Plugin[]
  ) {}

  /**
   * Executes onRequestInit hooks (outer layer)
   *
   * Called at the start of request processing, before any modifications.
   * Plugins can initialize state or perform early validation.
   *
   * **Execution order**: Global → Route
   *
   * @param context - Plugin context
   *
   * @example
   * ```typescript
   * const executor = new PluginExecutor(registry, routePlugins);
   * await executor.executeOnRequestInit(pluginContext);
   * ```
   */
  async executeOnRequestInit(context: PluginContext): Promise<void> {
    // Global plugins
    if (this.globalRegistry) {
      await this.globalRegistry.executeOnRequestInit(context);
    }

    // Route plugins
    for (const plugin of this.routePlugins) {
      if (plugin.onRequestInit) {
        try {
          await plugin.onRequestInit(context);
        } catch (error) {
          logger.error({ error, pluginName: plugin.name }, 'Error in onRequestInit hook');
        }
      }
    }
  }

  /**
   * Executes onBeforeRequest hooks
   *
   * Called after URL/body/header modifications but before sending the request.
   * Plugins can perform final modifications to the request.
   *
   * **Execution order**: Global → Route
   * **Context updates**: Modifications to context.url, context.headers, context.body are applied
   *
   * @param context - Plugin context (will be modified)
   * @param targetUrl - Target URL (will be modified)
   * @param headers - Request headers (will be modified)
   * @param finalBody - Request body (will be returned as modified value)
   * @returns Modified body
   *
   * @example
   * ```typescript
   * let finalBody = initialBody;
   * finalBody = await executor.executeOnBeforeRequest(
   *   pluginContext,
   *   targetUrl,
   *   headers,
   *   finalBody
   * );
   * ```
   */
  async executeOnBeforeRequest(
    context: PluginContext,
    targetUrl: URL,
    headers: Headers,
    finalBody: any
  ): Promise<any> {
    let currentBody = finalBody;

    // Update context before execution
    context.url = new URL(targetUrl.href);
    context.headers = {};
    headers.forEach((value, key) => {
      context.headers[key] = value;
    });
    context.body = currentBody;

    // Global plugins
    if (this.globalRegistry) {
      await this.globalRegistry.executeOnBeforeRequest(context);

      // Apply modifications
      targetUrl.href = context.url.href;
      this.applyHeadersToHeaders(context.headers, headers);
      currentBody = context.body;
    }

    // Route plugins
    for (const plugin of this.routePlugins) {
      if (plugin.onBeforeRequest) {
        try {
          // Update context
          context.url = new URL(targetUrl.href);
          context.headers = {};
          headers.forEach((value, key) => {
            context.headers[key] = value;
          });
          context.body = currentBody;

          await plugin.onBeforeRequest(context);

          // Apply modifications
          targetUrl.href = context.url.href;
          this.applyHeadersToHeaders(context.headers, headers);
          currentBody = context.body;
        } catch (error) {
          logger.error({ error, pluginName: plugin.name }, 'Error in onBeforeRequest hook');
        }
      }
    }

    return currentBody;
  }

  /**
   * Executes onInterceptRequest hooks (may short-circuit)
   *
   * Allows plugins to intercept and handle the request without forwarding to upstream.
   * If any plugin returns a Response, execution stops and that response is returned.
   *
   * **Execution order**: Global → Route (stops on first non-null response)
   *
   * @param context - Plugin context
   * @param targetUrl - Target URL
   * @param headers - Request headers
   * @param finalBody - Request body
   * @returns Response if intercepted, null otherwise
   *
   * @example
   * ```typescript
   * const intercepted = await executor.executeOnInterceptRequest(
   *   pluginContext,
   *   targetUrl,
   *   headers,
   *   finalBody
   * );
   * if (intercepted) {
   *   return intercepted; // Short-circuit
   * }
   * ```
   */
  async executeOnInterceptRequest(
    context: PluginContext,
    targetUrl: URL,
    headers: Headers,
    finalBody: any
  ): Promise<Response | null> {
    // Update context
    context.url = new URL(targetUrl.href);
    context.headers = {};
    headers.forEach((value, key) => {
      context.headers[key] = value;
    });
    context.body = finalBody;

    // Global plugins
    if (this.globalRegistry) {
      const interceptedResponse = await this.globalRegistry.executeOnInterceptRequest(context);
      if (interceptedResponse) {
        return interceptedResponse;
      }
    }

    // Route plugins
    for (const plugin of this.routePlugins) {
      if (plugin.onInterceptRequest) {
        try {
          // Update context
          context.url = new URL(targetUrl.href);
          context.headers = {};
          headers.forEach((value, key) => {
            context.headers[key] = value;
          });
          context.body = finalBody;

          const interceptedResponse = await plugin.onInterceptRequest(context);
          if (interceptedResponse) {
            logger.info({ pluginName: plugin.name }, 'Request intercepted by plugin');
            return interceptedResponse;
          }
        } catch (error) {
          logger.error({ error, pluginName: plugin.name }, 'Error in onInterceptRequest hook');
        }
      }
    }

    return null;
  }

  /**
   * Executes onResponse hooks (inbound phase, reverse order)
   *
   * Called after receiving the response from upstream.
   * Plugins can modify or replace the response.
   *
   * **Execution order**: Route (reversed) → Global
   * **Note**: Non-streaming responses only
   *
   * @param method - Request method
   * @param targetUrl - Target URL
   * @param requestLog - Request log
   * @param initialResponse - Initial response from upstream
   * @returns Modified response
   *
   * @example
   * ```typescript
   * const modifiedResponse = await executor.executeOnResponse(
   *   'POST',
   *   targetUrl,
   *   requestLog,
   *   upstreamResponse
   * );
   * ```
   */
  async executeOnResponse(
    method: string,
    targetUrl: URL,
    requestLog: any,
    initialResponse: Response
  ): Promise<Response> {
    let currentResponse = initialResponse;

    // Route plugins (reverse order for inbound)
    for (const plugin of [...this.routePlugins].reverse()) {
      if (plugin.onResponse) {
        try {
          const responseHeadersObj: Record<string, string> = {};
          currentResponse.headers.forEach((value, key) => {
            responseHeadersObj[key] = value;
          });

          const pluginContext: PluginContext & { response: Response } = {
            method,
            url: new URL(targetUrl.href),
            headers: responseHeadersObj,
            body: null,
            request: requestLog,
            response: currentResponse
          };

          const result = await plugin.onResponse(pluginContext);
          if (result && result instanceof Response) {
            currentResponse = result;
            logger.info(
              { pluginName: plugin.name },
              'Plugin returned modified response'
            );
          }
        } catch (error) {
          logger.error({ error, pluginName: plugin.name }, 'Error in onResponse hook');
        }
      }
    }

    // Global plugins
    if (this.globalRegistry) {
      const responseHeadersObj: Record<string, string> = {};
      currentResponse.headers.forEach((value, key) => {
        responseHeadersObj[key] = value;
      });

      const pluginContext: PluginContext & { response: Response } = {
        method,
        url: new URL(targetUrl.href),
        headers: responseHeadersObj,
        body: null,
        request: requestLog,
        response: currentResponse
      };

      currentResponse = await this.globalRegistry.executeOnResponse(pluginContext);
    }

    return currentResponse;
  }

  /**
   * Executes onError hooks (inbound phase, reverse order)
   *
   * Called when an error occurs during request processing.
   * Plugins can log, report, or handle the error.
   *
   * **Execution order**: Route (reversed) → Global
   * **Note**: Errors in error handlers are logged but not re-thrown
   *
   * @param method - Request method
   * @param targetUrl - Target URL
   * @param headers - Request headers
   * @param finalBody - Request body
   * @param requestLog - Request log
   * @param error - Error that occurred
   *
   * @example
   * ```typescript
   * try {
   *   // ... request processing
   * } catch (error) {
   *   await executor.executeOnError(
   *     method,
   *     targetUrl,
   *     headers,
   *     finalBody,
   *     requestLog,
   *     error
   *   );
   *   throw error; // Re-throw after plugins handle it
   * }
   * ```
   */
  async executeOnError(
    method: string,
    targetUrl: URL,
    headers: Headers,
    finalBody: any,
    requestLog: any,
    error: Error
  ): Promise<void> {
    const headersObj: Record<string, string> = {};
    headers.forEach((value, key) => {
      headersObj[key] = value;
    });

    const pluginContext: PluginContext & { error: Error } = {
      method,
      url: new URL(targetUrl.href),
      headers: headersObj,
      body: finalBody,
      request: requestLog,
      error
    };

    // Route plugins (reverse order for inbound)
    for (const plugin of [...this.routePlugins].reverse()) {
      if (plugin.onError) {
        try {
          await plugin.onError(pluginContext);
        } catch (hookError) {
          logger.error(
            { error: hookError, pluginName: plugin.name },
            'Error in onError hook'
          );
        }
      }
    }

    // Global plugins
    if (this.globalRegistry) {
      await this.globalRegistry.executeOnError(pluginContext);
    }
  }

  /**
   * Helper: Applies context headers to Headers object
   * Clears all existing headers and sets new ones from context
   *
   * @param contextHeaders - Headers from plugin context
   * @param headers - Headers object to update
   */
  private applyHeadersToHeaders(contextHeaders: Record<string, string>, headers: Headers): void {
    // Clear existing headers
    const existingHeaders: string[] = [];
    headers.forEach((_, key) => existingHeaders.push(key));
    existingHeaders.forEach(key => headers.delete(key));

    // Set new headers
    for (const [key, value] of Object.entries(contextHeaders)) {
      headers.set(key, value);
    }
  }
}
