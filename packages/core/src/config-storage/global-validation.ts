import { MAX_WEBSOCKET_MAX_MESSAGE_BYTES, validatePublicationPolicy } from '@jeffusion/bungee-types';
import { validateAuth } from './domain-validation';
import { isBodyParserLimit, isLogLevel } from './global-scalars';
import {
  booleanField,
  numberField,
  objectField,
} from './policy-fields';
import type { JsonObject, ValidationContext } from './validation';

export function validateGlobalPolicies(object: JsonObject, context: ValidationContext): void {
  if (object.log_level !== undefined &&
      (typeof object.log_level !== 'string' || !isLogLevel(object.log_level))) {
    context.add(typeof object.log_level === 'string' ? 'invalid_value' : 'invalid_type', 'log_level', 'Invalid log level');
  }
  if (object.body_parser_limit !== undefined &&
      (typeof object.body_parser_limit !== 'string' || !isBodyParserLimit(object.body_parser_limit))) {
    context.add(typeof object.body_parser_limit === 'string' ? 'invalid_value' : 'invalid_type',
      'body_parser_limit', 'Invalid body parser limit');
  }
  const maxConnections = object.websocket_max_connections;
  if (maxConnections !== undefined && maxConnections !== null
    && (!Number.isSafeInteger(maxConnections) || (maxConnections as number) < 1 || (maxConnections as number) > 0x7fffffff)) {
    context.add('invalid_value', 'websocket_max_connections', 'Expected null or an integer between 1 and 2147483647');
  }
  const maxMessageBytes = object.websocket_max_message_bytes;
  if (maxMessageBytes !== undefined && (!Number.isSafeInteger(maxMessageBytes)
    || (maxMessageBytes as number) < 1 || (maxMessageBytes as number) > MAX_WEBSOCKET_MAX_MESSAGE_BYTES)) {
    context.add('invalid_value', 'websocket_max_message_bytes', `Expected an integer between 1 and ${MAX_WEBSOCKET_MAX_MESSAGE_BYTES}`);
  }
  validateAuth(object.auth, 'auth', context);
  if (object.publication !== undefined) {
    for (const error of validatePublicationPolicy(object.publication)) {
      const path = error.field === 'publication' ? 'publication' : `publication.${error.field}`;
      const code = error.message === 'Required field is missing' ? 'required'
        : error.message.startsWith('Expected') || error.field === 'publication' ? 'invalid_type' : 'invalid_value';
      context.add(code, path, error.message);
    }
  }
  const logging = objectField(object.logging, 'logging', ['body'], context);
  if (!logging || logging.body === undefined) return;
  const body = objectField(logging.body, 'logging.body', ['enabled', 'max_size', 'retention_days'], context);
  if (!body) return;
  booleanField(body, 'enabled', 'logging.body', context);
  numberField(body, 'max_size', 'logging.body', context, { required: true, positive: true });
  numberField(body, 'retention_days', 'logging.body', context, { required: true, positive: true });
}
