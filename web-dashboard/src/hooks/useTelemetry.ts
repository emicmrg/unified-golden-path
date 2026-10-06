/**
 * useTelemetry.ts — Hook that subscribes to the MQTT topic via Amplify PubSub.
 *
 * - Uses Cognito Identity Pool guest (no login) to obtain IoT credentials.
 * - Keeps an in-memory history (last MAX_HISTORY points).
 * - Cleans up the subscription on unmount (correct cleanup).
 * - If the MQTT configuration is incomplete, returns 'disconnected' state
 *   with a warning message, without crashing.
 * - C1: the clientId uses the VITE_MQTT_CLIENT_ID_PREFIX so the IoT guest
 *   role does not reject the connection (policy: client/ugp-dashboard-*).
 */

import { useEffect, useRef, useState } from "react";
import { Amplify } from "aws-amplify";
import { PubSub } from "@aws-amplify/pubsub";
import { classifyReading } from "../classify.js";
import type { TelemetryMessage, TelemetryPoint, TelemetryState } from "../types.js";
import { config } from "../config.js";

const MAX_HISTORY = 30;

let amplifyConfigured = false;

function ensureAmplifyConfigured(): void {
  if (amplifyConfigured || !config.mqttConfigured) return;
  Amplify.configure({
    Auth: {
      Cognito: {
        identityPoolId: config.identityPoolId!,
        allowGuestAccess: true,
      },
    },
  });
  amplifyConfigured = true;
}

const INITIAL_STATE: TelemetryState = {
  connectionStatus: "disconnected",
  latest: null,
  history: [],
  error: null,
};

export function useTelemetry(): TelemetryState {
  const [state, setState] = useState<TelemetryState>(INITIAL_STATE);
  // Ref to accumulate history without creating stale closure captures
  const historyRef = useRef<TelemetryPoint[]>([]);

  useEffect(() => {
    if (!config.mqttConfigured) {
      setState((prev) => ({
        ...prev,
        connectionStatus: "disconnected",
        error:
          "MQTT telemetry not configured. Check VITE_IDENTITY_POOL_ID, VITE_IOT_ENDPOINT and VITE_TELEMETRY_TOPIC.",
      }));
      return;
    }

    ensureAmplifyConfigured();

    setState((prev) => ({ ...prev, connectionStatus: "connecting", error: null }));

    // C1: clientId with prefix required by the guest role (client/ugp-dashboard-*)
    // Random suffix so multiple visitors do not collide on the broker.
    const clientId = `${config.mqttClientIdPrefix}${crypto.randomUUID()}`;

    const pubsub = new PubSub({
      region: config.awsRegion,
      endpoint: `wss://${config.iotEndpoint!}/mqtt`,
      clientId,
    });

    let subscription: { unsubscribe(): void } | undefined;

    try {
      subscription = pubsub.subscribe({ topics: [config.telemetryTopic!] }).subscribe({
        next: (rawData: unknown) => {
          // Payload arrives as a JS object (Amplify deserializes it from JSON)
          const msg = rawData as TelemetryMessage;

          // #6: discard NaN/Infinity — do not classify 'NaN °C' as WARN
          if (
            !Number.isFinite(msg.temperatureCelsius) ||
            !Number.isFinite(msg.humidityPercent)
          ) {
            return; // ignore messages with non-finite values
          }

          const classification = classifyReading(msg.temperatureCelsius, msg.humidityPercent);
          const point: TelemetryPoint = {
            timestamp: msg.timestamp ?? new Date().toISOString(),
            temperatureCelsius: msg.temperatureCelsius,
            humidityPercent: msg.humidityPercent,
            status: classification.status,
          };

          historyRef.current = [...historyRef.current, point].slice(-MAX_HISTORY);

          setState({
            connectionStatus: "connected",
            latest: msg,
            history: historyRef.current,
            error: null,
          });
        },
        error: (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setState((prev) => ({
            ...prev,
            connectionStatus: "error",
            error: `MQTT error: ${message}`,
          }));
        },
        complete: () => {
          setState((prev) => ({ ...prev, connectionStatus: "disconnected" }));
        },
      });

      setState((prev) => ({ ...prev, connectionStatus: "connecting" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({
        ...prev,
        connectionStatus: "error",
        error: `Could not connect to the MQTT broker: ${message}`,
      }));
    }

    return () => {
      subscription?.unsubscribe();
      historyRef.current = [];
    };
  }, []); // No dependencies: runs once on mount

  return state;
}
