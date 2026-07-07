import fs from 'fs';
import path from 'path';
import type { ValidationResult } from '../types';
import type { AppConfig } from '@jeffusion/bungee-types';
import { migrateConfigToLatest } from '../../config-migrations/migrate-config';

const CONFIG_PATH = process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config.json');
const MAX_BACKUPS = 5;

export class ConfigHandler {
  static get(): Response {
    try {
      const configContent = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const rawConfig = JSON.parse(configContent);
      const config = migrateConfigToLatest(rawConfig).config;

      return new Response(JSON.stringify(config), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      return new Response(
        JSON.stringify({ error: 'Failed to read config: ' + error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  static async update(req: Request): Promise<Response> {
    try {
      const newConfig = await req.json();
      const migrated = migrateConfigToLatest(newConfig).config;

      const validation = this.validateConfig(migrated);
      if (!validation.valid) {
        return new Response(
          JSON.stringify({ error: validation.error }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const backupPath = `${CONFIG_PATH}.backup.${Date.now()}`;
      fs.copyFileSync(CONFIG_PATH, backupPath);
      this.cleanupOldBackups();

      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.sanitizeConfig(migrated), null, 2));

      return new Response(
        JSON.stringify({ success: true, message: 'Config updated, reloading workers...' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error: any) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  static async validate(req: Request): Promise<Response> {
    try {
      const config = await req.json();
      const migrated = migrateConfigToLatest(config).config;
      const validation = this.validateConfig(migrated);

      return new Response(JSON.stringify(validation), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error: any) {
      return new Response(
        JSON.stringify({ valid: false, error: error.message }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  private static validateConfig(config: AppConfig): ValidationResult {
    if (!config) {
      return { valid: false, error: 'Config cannot be empty' };
    }

    if (!config.routes || !Array.isArray(config.routes)) {
      return { valid: false, error: 'routes must be an array' };
    }

    if (config.routes.length === 0) {
      return { valid: false, error: 'At least one route is required' };
    }

    for (let i = 0; i < config.routes.length; i++) {
      const route = config.routes[i];

      if (!route.path) {
        return { valid: false, error: `Route #${i + 1}: path is required` };
      }

  const has_endpoints = route.endpoints && Array.isArray(route.endpoints) && route.endpoints.length > 0;
  const has_service = !!route.service;
  const has_direct_response = !!(route as any).direct_response?.enabled;
  const has_redirect = !!(route as any).redirect?.enabled;
  const has_response_rules = !!(route as any).response_rules?.some((rule: any) => rule.enabled);

  if (!has_endpoints && !has_service && !has_direct_response && !has_redirect && !has_response_rules) {
    return { valid: false, error: `Route "${route.path}": endpoints, service, response_rules, direct_response, or redirect is required` };
  }

      if (has_service) {
        const service = config.services?.find((candidate) => candidate.name === route.service);
        if (!service) {
          return { valid: false, error: `Route "${route.path}": service "${route.service}" not found` };
        }
      }

      for (let j = 0; j < (route.endpoints ?? []).length; j++) {
        const endpoint = route.endpoints![j];

        if (!endpoint.target) {
          return { valid: false, error: `Route "${route.path}", Endpoint #${j + 1}: target is required` };
        }

        try {
          new URL(endpoint.target);
        } catch {
          return { valid: false, error: `Route "${route.path}", Endpoint #${j + 1}: invalid target URL "${endpoint.target}"` };
        }
      }
    }

    for (const service of config.services ?? []) {
      if (!service.name) {
        return { valid: false, error: 'Service name is required' };
      }

      if (!service.endpoints || !Array.isArray(service.endpoints) || service.endpoints.length === 0) {
        return { valid: false, error: `Service "${service.name}": endpoints must be a non-empty array` };
      }

      for (let j = 0; j < service.endpoints.length; j++) {
        const endpoint = service.endpoints[j];

        if (!endpoint.target) {
          return { valid: false, error: `Service "${service.name}", Endpoint #${j + 1}: target is required` };
        }

        try {
          new URL(endpoint.target);
        } catch {
          return { valid: false, error: `Service "${service.name}", Endpoint #${j + 1}: invalid target URL "${endpoint.target}"` };
        }
      }
    }

    return { valid: true };
  }

  private static sanitizeConfig(config: AppConfig): AppConfig {
    return {
      config_version: config.config_version,
      ...(config.body_parser_limit && { body_parser_limit: config.body_parser_limit }),
      ...(config.auth && { auth: this.sanitizeAuth(config.auth) }),
      ...(config.logging && { logging: config.logging }),
      ...(config.plugins && { plugins: config.plugins }),
      ...(config.log_level && { log_level: config.log_level }),
      ...(config.services && { services: config.services.map((s: any) => this.sanitizeService(s)) }),
      routes: config.routes.map((r: any) => this.sanitizeRoute(r))
    };
  }

  private static sanitizeService(service: any): any {
    return {
      name: service.name,
      endpoints: service.endpoints.map((e: any) => this.sanitizeEndpoint(e)),
      ...(service.plugins && { plugins: service.plugins }),
      ...(service.health_check && { health_check: service.health_check }),
      ...(service.failover && { failover: service.failover }),
      ...(service.load_balancing && { load_balancing: service.load_balancing }),
      ...(service.timeouts && { timeouts: service.timeouts })
    };
  }

  private static sanitizeRoute(route: any): any {
    return {
      path: route.path,
      ...(route.path_rewrite && { path_rewrite: route.path_rewrite }),
      ...(route.auth && { auth: this.sanitizeAuth(route.auth) }),
      ...(route.plugins && { plugins: route.plugins }),
      ...(route.timeouts && { timeouts: route.timeouts }),
      ...(route.service && { service: route.service }),
      ...(route.rate_limit && { rate_limit: route.rate_limit }),
      ...(route.cors && { cors: route.cors }),
      ...(route.response_rules && { response_rules: route.response_rules }),
      ...(route.direct_response && { direct_response: route.direct_response }),
      ...(route.redirect && { redirect: route.redirect }),
      ...(route.retry && { retry: route.retry }),
      ...this.sanitizeModificationRules(route),
      ...(route.endpoints && { endpoints: route.endpoints.map((e: any) => this.sanitizeEndpoint(e)) })
    };
  }

  private static sanitizeEndpoint(endpoint: any): any {
    return {
      ...(endpoint.id && { id: endpoint.id }),
      target: endpoint.target,
      ...(endpoint.weight !== undefined && { weight: endpoint.weight }),
      ...(endpoint.priority !== undefined && { priority: endpoint.priority }),
      ...(endpoint.is_disabled !== undefined && { is_disabled: endpoint.is_disabled }),
      ...(endpoint.description && { description: endpoint.description }),
      ...(endpoint.condition !== undefined && { condition: endpoint.condition }),
      ...(endpoint.plugins && { plugins: endpoint.plugins }),
      ...this.sanitizeModificationRules(endpoint)
    };
  }

  private static sanitizeModificationRules(obj: any): any {
    return {
      ...(obj.headers && { headers: obj.headers }),
      ...(obj.body && { body: obj.body }),
      ...(obj.query && { query: obj.query })
    };
  }

  private static sanitizeAuth(auth: any): any {
    return {
      enabled: auth.enabled,
      tokens: auth.tokens
    };
  }

  private static cleanupOldBackups(): void {
    try {
      const configDir = path.dirname(CONFIG_PATH);
      const configBasename = path.basename(CONFIG_PATH);
      const files = fs.readdirSync(configDir);
      const backups = files
        .filter(file => file.startsWith(`${configBasename}.backup.`))
        .map(file => ({
          filename: file,
          filepath: path.join(configDir, file),
          timestamp: parseInt(file.split('.backup.')[1] || '0')
        }))
        .filter(backup => !isNaN(backup.timestamp))
        .sort((a, b) => b.timestamp - a.timestamp);

      if (backups.length > MAX_BACKUPS) {
        const toDelete = backups.slice(MAX_BACKUPS);
        toDelete.forEach(backup => {
          try {
            fs.unlinkSync(backup.filepath);
          } catch (err) {
            console.error(`Failed to delete backup ${backup.filename}:`, err);
          }
        });
      }
    } catch (err) {
      console.error('Failed to cleanup old backups:', err);
    }
  }
}
