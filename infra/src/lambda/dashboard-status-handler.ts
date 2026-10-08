/**
 * dashboard-status-handler.ts — Asset reference for the dashboard status Lambda.
 *
 * WHY THIS FILE CHANGED (inline → asset):
 *   The original handler was inline (lambda.Code.fromInline / CloudFormation ZipFile), which
 *   has a hard CloudFormation limit of 4096 characters. Adding the GitHub Actions polling logic
 *   (in-memory cache, rate-limit handling, conclusion→PipelineStatus mapping, env-var guard)
 *   pushed the handler to ~4500 characters — exceeding the limit.
 *
 *   Migration: lambda.Code.fromAsset pointing at the .mjs file next to this one.
 *   Benefits over the inline approach:
 *     - No character budget to fight against.
 *     - The code still lives in the same directory as the stack, staying auditable.
 *     - ESM modules work naturally (.mjs extension, no package.json required).
 *     - The CDK asset hash changes whenever the handler changes → CloudFormation updates.
 *
 * The INLINE_CODE_MAX_CHARS guard that lived in dashboard-stack.ts is no longer needed and has
 * been removed. If you ever revert to inline, re-add it.
 *
 * HANDLER STRING FORMAT:
 *   For AWS Lambda Node.js, the handler string is "<module_name>.<export_name>" where
 *   <module_name> is the filename WITHOUT the extension:
 *     "dashboard-status-handler.handler"
 *   The Node.js runtime resolves the module by trying .js, .mjs, .cjs in order, so the
 *   extension must NOT appear in the handler string. Including ".mjs" would cause
 *   Runtime.HandlerNotFound and a 502 on every invocation.
 *   Reference: https://docs.aws.amazon.com/lambda/latest/dg/nodejs-handler.html
 */

import * as path from "node:path";

/** Absolute path to the directory containing the Lambda handler asset. */
export const DASHBOARD_STATUS_HANDLER_ASSET_PATH = path.join(__dirname, ".");

/**
 * Lambda `handler` property value for the status function.
 * Format: `<module_name>.<export_name>` — the Node.js runtime resolves the module by trying
 * .js / .mjs / .cjs, so the extension must NOT appear in this string.
 * Including ".mjs" would produce Runtime.HandlerNotFound (502).
 */
export const DASHBOARD_STATUS_HANDLER_PROP = "dashboard-status-handler.handler";
