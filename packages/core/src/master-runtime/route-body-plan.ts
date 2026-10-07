import type { ConfigurationAggregateV2, ModificationRules, ResponseModificationRules, UpstreamV2 } from '@jeffusion/bungee-types';
import { analyzeExpressionDependencies, hasBodyModification } from '../utils/expression-dependencies';
import { deepMergeRules } from '../worker/rules/deep-merge';

function directionPlan(request: ModificationRules, response: ResponseModificationRules, selection: unknown) {
  const requestReasons: string[] = [];
  const responseReasons: string[] = [];
  if (hasBodyModification(request.body)) requestReasons.push('request-body-rules');
  if (analyzeExpressionDependencies(request).requestBody) requestReasons.push('request-expression');
  if (analyzeExpressionDependencies(selection).requestBody) requestReasons.push('selection-expression');
  const responseDependencies = analyzeExpressionDependencies(response, 'response');
  if (responseDependencies.requestBody) requestReasons.push('response-request-expression');
  if (hasBodyModification(response.body)) responseReasons.push('response-body-rules');
  if (responseDependencies.responseBody) responseReasons.push('response-expression');
  return {
    request: { mode: requestReasons.length ? 'conditional-json' : 'opaque-stream', reasons: requestReasons },
    response: { mode: responseReasons.length ? 'conditional-content' : 'opaque-stream', reasons: responseReasons,
      body_formats: response.body_formats ?? ['json', 'sse-json'] },
  };
}

/** A committed configuration plan; dynamic plugin/policy decisions belong to individual request logs. */
export function buildRouteBodyPlans(aggregate: ConfigurationAggregateV2) {
  const logical = aggregate.logical_configuration;
  const active = new Set(aggregate.plugin_activations.map(value => value.plugin_name));
  const pluginNames = (...bindings: Array<readonly {name: string; enabled: boolean}[] | undefined>) =>
    [...new Set(bindings.flatMap(values => (values ?? []).filter(value => value.enabled && active.has(value.name)).map(value => value.name)))];
  return logical.routes.map(route => {
    const service = 'service_id' in route ? logical.services.find(value => value.id === route.service_id) : undefined;
    const endpoints: readonly UpstreamV2[] = service?.endpoints ?? route.endpoints ?? [];
    const retry = Boolean(route.retry?.enabled || service?.failover?.enabled);
    return {
      route_id: route.id, path: route.path,
      ...directionPlan(route.request ?? {}, route.response ?? {}, { rate_limit: route.rate_limit, load_balancing: service?.load_balancing }),
      replay: retry, dynamic_plugins: pluginNames(logical.plugins, route.plugins, service?.plugins),
      endpoints: endpoints.filter(endpoint => !endpoint.is_disabled).map(endpoint => {
        const request = deepMergeRules(route.request ?? {}, endpoint.request ?? {});
        const response = deepMergeRules(endpoint.response ?? {}, route.response ?? {}) as ResponseModificationRules;
        response.body_formats = route.response?.body_formats ?? endpoint.response?.body_formats;
        return { upstream_id: endpoint.id,
          ...directionPlan(request, response, { condition: endpoint.condition, rate_limit: route.rate_limit, load_balancing: service?.load_balancing }),
          replay: retry, dynamic_plugins: pluginNames(logical.plugins, route.plugins, service?.plugins, endpoint.plugins) };
      }),
    };
  });
}
