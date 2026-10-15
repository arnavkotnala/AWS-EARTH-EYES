/**
 * Forest Eyes API on AWS Lambda (api/lambda.js)
 * =============================================
 * Handler: lambda.handler     Runtime: Node.js 22.x     Timeout: 29 s
 * Trigger: API Gateway HTTP API, route "ANY /api/{proxy+}" (payload format 2.0)
 *
 * Secrets are Lambda environment variables (encrypted at rest by AWS):
 *   GEMINI_API_KEY, GFW_API_KEY, optional GEMINI_MODEL
 */
'use strict';

const core = require('./core');

exports.handler = async event => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || 'GET';
  const path = event?.rawPath || event?.path || '/';
  let body = event?.body || '';
  if (event?.isBase64Encoded && body) body = Buffer.from(body, 'base64').toString('utf8');

  const result = await core.handleApi({
    method,
    path,
    query: event?.queryStringParameters || {},
    body,
  });

  return {
    statusCode: result.status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(result.headers || {}),
    },
    body: JSON.stringify(result.json),
  };
};
