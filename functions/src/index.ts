import * as admin from "firebase-admin";
import * as functions from "firebase-functions";

import type { Request, Response } from "express";

admin.initializeApp();

type FloodTrend = "stable" | "rising" | "falling" | string;

interface FloodRiskInput {
  distance_cm: number;
  rainfall_mm: number;
  humidity: number;
  temp: number;
  trend: FloodTrend;
}

type FloodRiskLevel = "Low" | "Medium" | "High";

interface FloodRiskResponse {
  riskLevel: FloodRiskLevel;
  explanation: string;
  predictionId: string;
}

interface AlertSummaryRequest {
  currentLevel: 1 | 2 | 3;
  waterHeight: number;
  distance: number;
  rainfall: number;
  lastAlerts: Array<{
    sensor: string;
    level: string;
    value: number | null;
    timestamp: number;
  }>;
}

interface DeepSeekResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
}

const db = admin.firestore();

const RISK_COLLECTION = "riskPredictions";
const SUMMARY_COLLECTION = "alertSummaries";

const env = ((globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}) as Record<
  string,
  string | undefined
>;

const DEFAULT_GEMINI_MODEL = env.GEMINI_MODEL ?? "gemini-1.5-flash";
const DEFAULT_DEEPSEEK_MODEL = env.DEEPSEEK_MODEL ?? "deepseek-chat";

const config = functions.config() as {
  gemini?: { api_key?: string };
  deepseek?: { api_key?: string };
};

const GEMINI_API_KEY = env.GEMINI_API_KEY ?? config.gemini?.api_key;
const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY ?? config.deepseek?.api_key;

function sanitizeJsonBlock(raw: string | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    return trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  }
  return trimmed;
}

function validateFloodRiskInput(data: unknown): FloodRiskInput {
  if (typeof data !== "object" || data === null) {
    throw new functions.https.HttpsError("invalid-argument", "Request payload must be an object.");
  }

  const candidate = data as Record<string, unknown>;

  const distance = Number(candidate.distance_cm);
  const rainfall = Number(candidate.rainfall_mm);
  const humidity = Number(candidate.humidity);
  const temp = Number(candidate.temp);
  const trendRaw = typeof candidate.trend === "string" ? candidate.trend : "stable";

  const numbers = [distance, rainfall, humidity, temp];
  if (numbers.some(value => Number.isNaN(value))) {
    throw new functions.https.HttpsError("invalid-argument", "Flood risk payload contains invalid numeric values.");
  }

  return {
    distance_cm: distance,
    rainfall_mm: rainfall,
    humidity,
    temp,
    trend: trendRaw,
  };
}

function validateAlertSummaryRequest(data: unknown): AlertSummaryRequest {
  if (typeof data !== "object" || data === null) {
    throw new functions.https.HttpsError("invalid-argument", "Request payload must be an object.");
  }

  const candidate = data as Record<string, unknown>;

  const currentLevel = Number(candidate.currentLevel) as 1 | 2 | 3;
  if (![1, 2, 3].includes(currentLevel)) {
    throw new functions.https.HttpsError("invalid-argument", "currentLevel must be 1, 2, or 3.");
  }

  const waterHeight = Number(candidate.waterHeight);
  const distance = Number(candidate.distance);
  const rainfall = Number(candidate.rainfall);

  if ([waterHeight, distance, rainfall].some(value => Number.isNaN(value))) {
    throw new functions.https.HttpsError("invalid-argument", "Numeric fields in alert summary payload are invalid.");
  }

  const lastAlerts = Array.isArray(candidate.lastAlerts) ? candidate.lastAlerts : [];

  const normalized = lastAlerts.map(alert => {
    if (!alert || typeof alert !== "object") {
      return {
        sensor: "unknown",
        level: "info",
        value: null,
        timestamp: Date.now(),
      };
    }

    const item = alert as Record<string, unknown>;
    const value = item.value != null ? Number(item.value) : null;

    return {
      sensor: String(item.sensor ?? "unknown"),
      level: String(item.level ?? "info"),
      value: value != null && !Number.isNaN(value) ? value : null,
      timestamp: typeof item.timestamp === "number" ? item.timestamp : Date.now(),
    };
  });

  return {
    currentLevel,
    waterHeight,
    distance,
    rainfall,
    lastAlerts: normalized,
  };
}

function heuristicFloodRisk(inputs: FloodRiskInput): { riskLevel: FloodRiskLevel; explanation: string } {
  let score = 0;

  if (inputs.distance_cm <= 20) score += 3;
  else if (inputs.distance_cm <= 50) score += 2;
  else if (inputs.distance_cm <= 80) score += 1;

  if (inputs.rainfall_mm >= 30) score += 3;
  else if (inputs.rainfall_mm >= 15) score += 2;
  else if (inputs.rainfall_mm >= 5) score += 1;

  if (inputs.humidity >= 90) score += 1;
  if (inputs.trend.toLowerCase() === "rising") score += 2;
  else if (inputs.trend.toLowerCase() === "falling") score -= 1;

  if (inputs.temp <= 2) score += 1;

  const riskLevel: FloodRiskLevel = score >= 6 ? "High" : score >= 3 ? "Medium" : "Low";

  const explanationFragments: string[] = [];
  if (inputs.distance_cm <= 50) explanationFragments.push("Water level is close to the sensor");
  if (inputs.rainfall_mm >= 15) explanationFragments.push("Heavy rainfall detected in the last hour");
  if (inputs.trend.toLowerCase() === "rising") explanationFragments.push("Recent trend indicates rising water");
  if (inputs.humidity >= 90) explanationFragments.push("Humidity is high, supporting persistent moisture");
  if (explanationFragments.length === 0) {
    explanationFragments.push("Sensor readings stay within safe thresholds");
  }

  const explanation = `${riskLevel} risk — ${explanationFragments.join("; ")}.`;

  return { riskLevel, explanation };
}

async function callGemini(inputs: FloodRiskInput): Promise<{ riskLevel: FloodRiskLevel; explanation: string } | null> {
  if (!GEMINI_API_KEY) {
    return null;
  }

  const prompt = `You are an experienced flood-risk analyst. Analyze the following sensor readings and estimate the flood risk. Only respond with JSON {"riskLevel":"Low|Medium|High","explanation":"short sentence"}.

distance_cm: ${inputs.distance_cm}
rainfall_mm: ${inputs.rainfall_mm}
humidity: ${inputs.humidity}
temperature: ${inputs.temp}
trend: ${inputs.trend}`;

  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${DEFAULT_GEMINI_MODEL}:generateContent`;

  const response = await fetch(endpoint + `?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
      },
    }),
  });

  if (!response.ok) {
    functions.logger.warn("Gemini responded with non-OK status", { status: response.status, statusText: response.statusText });
    return null;
  }

  const payload = (await response.json()) as GeminiResponse;
  const text = sanitizeJsonBlock(payload.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
  if (!text) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as { riskLevel?: string; explanation?: string };
    const riskLevel = (parsed.riskLevel ?? "").trim();
    if (riskLevel !== "Low" && riskLevel !== "Medium" && riskLevel !== "High") {
      return null;
    }
    const explanation = parsed.explanation?.trim() ?? `AI indicates ${riskLevel} flood risk.`;
    return { riskLevel, explanation };
  } catch (error) {
    functions.logger.error("Failed to parse Gemini response", error);
    return null;
  }
}

async function callDeepSeek(request: AlertSummaryRequest): Promise<string | null> {
  if (!DEEPSEEK_API_KEY) {
    return null;
  }

  const alertsDescription = request.lastAlerts
    .map(alert => {
      const when = new Date(alert.timestamp).toISOString();
      return `- ${alert.sensor} (${alert.level}) → ${alert.value ?? "n/a"} at ${when}`;
    })
    .join("\n");

  const prompt = `You are summarising a live flood monitoring feed for emergency teams. Provide:
1. A single sentence headline describing the situation.
2. A short bullet list (2-3 bullets) of recommended actions.
Respond in markdown with the headline and an unordered list. Avoid extra commentary.

Context:
- Flood severity level (1-3): ${request.currentLevel}
- Current water height (cm): ${request.waterHeight}
- Distance to sensor (cm): ${request.distance}
- Rainfall in last hour (mm): ${request.rainfall}
- Recent alerts:\n${alertsDescription || "- None"}`;

  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: DEFAULT_DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: "You write concise, actionable summaries for flood response coordinators." },
        { role: "user", content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 400,
    }),
  });

  if (!response.ok) {
    functions.logger.warn("DeepSeek responded with non-OK status", { status: response.status, statusText: response.statusText });
    return null;
  }

  const payload = (await response.json()) as DeepSeekResponse;
  const summary = payload.choices?.[0]?.message?.content?.trim();
  return summary && summary.length > 0 ? summary : null;
}

function fallbackSummary(request: AlertSummaryRequest): string {
  const levelDescriptions: Record<1 | 2 | 3, string> = {
    1: "Situation stable, continue monitoring.",
    2: "Moderate flood indicators, prepare mitigation steps.",
    3: "Critical flood indicators, enact emergency response now.",
  };

  const headline = levelDescriptions[request.currentLevel];
  const alerts = request.lastAlerts.slice(0, 3).map(alert => `${alert.sensor} (${alert.level})`).join(", ");

  return `**${headline}**\n\n- Water height: ${request.waterHeight} cm at sensor distance ${request.distance} cm\n- Rainfall last hour: ${request.rainfall} mm\n- Recent alerts: ${alerts || "No recent alerts"}`;
}

export const predictFloodRisk = functions
  .region("us-central1")
  .runWith({ timeoutSeconds: 60, memory: "1GB" })
  .https.onCall(async (data: unknown, context: functions.https.CallableContext): Promise<FloodRiskResponse> => {
    if (!context.auth && functions.config().env?.require_auth === "true") {
      throw new functions.https.HttpsError("unauthenticated", "Authentication is required to call predictFloodRisk.");
    }

    const inputs = validateFloodRiskInput(data);

    const geminiResult = await callGemini(inputs).catch(error => {
      functions.logger.error("Gemini call failed", error);
      return null;
    });

    const result = geminiResult ?? heuristicFloodRisk(inputs);

    const docRef = await db.collection(RISK_COLLECTION).add({
      ...result,
      rawInputs: inputs,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      source: geminiResult ? "gemini" : "heuristic",
    });

    return {
      riskLevel: result.riskLevel,
      explanation: result.explanation,
      predictionId: docRef.id,
    };
  });

export const generateAlertSummary = functions
  .region("us-central1")
  .runWith({ timeoutSeconds: 60, memory: "1GB" })
  .https.onCall(async (data: unknown, context: functions.https.CallableContext): Promise<{ summaryId: string }> => {
    if (!context.auth && functions.config().env?.require_auth === "true") {
      throw new functions.https.HttpsError("unauthenticated", "Authentication is required to call generateAlertSummary.");
    }

    const payload = validateAlertSummaryRequest(data);

    const llmSummary = await callDeepSeek(payload).catch(error => {
      functions.logger.error("DeepSeek call failed", error);
      return null;
    });

    const usedFallback = !llmSummary;
    const finalSummary = llmSummary ?? fallbackSummary(payload);

    const docRef = await db.collection(SUMMARY_COLLECTION).add({
      summary: finalSummary,
      payload,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      source: usedFallback ? "fallback" : "deepseek",
    });

    return { summaryId: docRef.id };
  });

export const ping = functions.https.onRequest((req: Request, res: Response) => {
  res.status(200).send({ ok: true });
});
