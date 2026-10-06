/**
 * config.ts — Reads Vite environment variables (VITE_*) with validation.
 *
 * If any variable is missing, the app does NOT crash: the property is undefined/null
 * and components display a "not configured" notice.
 */

export interface AppConfig {
  /** true if all required MQTT variables are present */
  mqttConfigured: boolean;
  /** true if the polling URL is configured */
  statusApiConfigured: boolean;
  /** AWS Region (default: us-east-1) */
  awsRegion: string;
  /** Cognito Identity Pool ID for guest credentials */
  identityPoolId: string | undefined;
  /** IoT Core ATS endpoint (without protocol) */
  iotEndpoint: string | undefined;
  /** Telemetry topic to subscribe to */
  telemetryTopic: string | undefined;
  /** Lambda Function URL for status polling */
  statusApiUrl: string | undefined;
  /**
   * MQTT clientId prefix.
   * The IoT guest role only allows connections with client/ugp-dashboard-*,
   * so the clientId must start with this prefix.
   * Default: 'ugp-dashboard-' (= MqttClientIdPrefix output from the stack).
   */
  mqttClientIdPrefix: string;
}

function readEnv(key: string): string | undefined {
  const val = import.meta.env[key];
  // Vite replaces import.meta.env.* at build-time; in tests it may be undefined
  if (typeof val === "string" && val.trim().length > 0) {
    return val.trim();
  }
  return undefined;
}

const identityPoolId = readEnv("VITE_IDENTITY_POOL_ID");
const awsRegion = readEnv("VITE_AWS_REGION") ?? "us-east-1";
const iotEndpoint = readEnv("VITE_IOT_ENDPOINT");
const telemetryTopic = readEnv("VITE_TELEMETRY_TOPIC");
const statusApiUrl = readEnv("VITE_STATUS_API_URL");
const mqttClientIdPrefix = readEnv("VITE_MQTT_CLIENT_ID_PREFIX") ?? "ugp-dashboard-";

export const config: AppConfig = {
  awsRegion,
  identityPoolId,
  iotEndpoint,
  telemetryTopic,
  statusApiUrl,
  mqttClientIdPrefix,
  mqttConfigured: Boolean(identityPoolId && iotEndpoint && telemetryTopic),
  statusApiConfigured: Boolean(statusApiUrl),
};
