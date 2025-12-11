"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ping = exports.generateAlertSummary = exports.predictFloodRisk = void 0;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions"));
admin.initializeApp();
const db = admin.firestore();
const RISK_COLLECTION = "riskPredictions";
const SUMMARY_COLLECTION = "alertSummaries";
const env = (globalThis.process?.env ?? {});
const DEFAULT_GEMINI_MODEL = env.GEMINI_MODEL ?? "gemini-2.5-flash";
const config = functions.config();
const GEMINI_API_KEY = env.GEMINI_API_KEY ?? config.gemini?.api_key;
function sanitizeJsonBlock(raw) {
    if (!raw)
        return "";
    const trimmed = raw.trim();
    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
        return trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    }
    return trimmed;
}
function validateFloodRiskInput(data) {
    if (typeof data !== "object" || data === null) {
        throw new functions.https.HttpsError("invalid-argument", "Request payload must be an object.");
    }
    const candidate = data;
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
function validateAlertSummaryRequest(data) {
    if (typeof data !== "object" || data === null) {
        throw new functions.https.HttpsError("invalid-argument", "Request payload must be an object.");
    }
    const candidate = data;
    const currentLevel = Number(candidate.currentLevel);
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
        const item = alert;
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
function heuristicFloodRisk(inputs) {
    let score = 0;
    if (inputs.distance_cm <= 20)
        score += 3;
    else if (inputs.distance_cm <= 50)
        score += 2;
    else if (inputs.distance_cm <= 80)
        score += 1;
    if (inputs.rainfall_mm >= 30)
        score += 3;
    else if (inputs.rainfall_mm >= 15)
        score += 2;
    else if (inputs.rainfall_mm >= 5)
        score += 1;
    if (inputs.humidity >= 90)
        score += 1;
    if (inputs.trend.toLowerCase() === "rising")
        score += 2;
    else if (inputs.trend.toLowerCase() === "falling")
        score -= 1;
    if (inputs.temp <= 2)
        score += 1;
    const riskLevel = score >= 6 ? "High" : score >= 3 ? "Medium" : "Low";
    const explanationFragments = [];
    if (inputs.distance_cm <= 50)
        explanationFragments.push("Water level is close to the sensor");
    if (inputs.rainfall_mm >= 15)
        explanationFragments.push("Heavy rainfall detected in the last hour");
    if (inputs.trend.toLowerCase() === "rising")
        explanationFragments.push("Recent trend indicates rising water");
    if (inputs.humidity >= 90)
        explanationFragments.push("Humidity is high, supporting persistent moisture");
    if (explanationFragments.length === 0) {
        explanationFragments.push("Sensor readings stay within safe thresholds");
    }
    const explanation = `${riskLevel} risk — ${explanationFragments.join("; ")}.`;
    return { riskLevel, explanation };
}
async function callGemini(inputs) {
    if (!GEMINI_API_KEY) {
        return null;
    }
    const prompt = `You are an experienced flood-risk analyst. Analyze the following sensor readings and estimate the flood risk. Only respond with JSON {"riskLevel":"Low|Medium|High","explanation":"short sentence"}.

distance_cm: ${inputs.distance_cm}
rainfall_mm: ${inputs.rainfall_mm}
humidity: ${inputs.humidity}
temperature: ${inputs.temp}
trend: ${inputs.trend}`;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`;
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
    const payload = (await response.json());
    const text = sanitizeJsonBlock(payload.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    if (!text) {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        const riskLevel = (parsed.riskLevel ?? "").trim();
        if (riskLevel !== "Low" && riskLevel !== "Medium" && riskLevel !== "High") {
            return null;
        }
        const explanation = parsed.explanation?.trim() ?? `AI indicates ${riskLevel} flood risk.`;
        return { riskLevel, explanation };
    }
    catch (error) {
        functions.logger.error("Failed to parse Gemini response", error);
        return null;
    }
}
async function callGeminiSummary(request) {
    if (!GEMINI_API_KEY) {
        return null;
    }
    const alertsDescription = request.lastAlerts
        .map(alert => {
        const when = new Date(alert.timestamp).toISOString();
        return `- ${alert.sensor} (${alert.level}) → ${alert.value ?? "n/a"} at ${when}`;
    })
        .join("\n");
    const prompt = `You are summarising a live flood monitoring feed for emergency teams. Provide:
1. A bold markdown headline describing the situation in <= 120 characters.
2. A short bullet list (2-3 bullets) of recommended actions written in markdown.
Respond ONLY in markdown with the headline on the first line followed by the list. Avoid extra commentary.

Context:
- Flood severity level (1-3): ${request.currentLevel}
- Current water height (cm): ${request.waterHeight}
- Distance to sensor (cm): ${request.distance}
- Rainfall in last hour (mm): ${request.rainfall}
- Recent alerts:\n${alertsDescription || "- None"}`;
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`;
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
                temperature: 0.4,
            },
        }),
    });
    if (!response.ok) {
        functions.logger.warn("Gemini summary responded with non-OK status", { status: response.status, statusText: response.statusText });
        return null;
    }
    const payload = (await response.json());
    const summary = payload.candidates?.[0]?.content?.parts?.map(part => part.text?.trim() ?? "").join("\n").trim();
    return summary && summary.length > 0 ? summary : null;
}
function fallbackSummary(request) {
    const levelDescriptions = {
        1: "Situation stable, continue monitoring.",
        2: "Moderate flood indicators, prepare mitigation steps.",
        3: "Critical flood indicators, enact emergency response now.",
    };
    const headline = levelDescriptions[request.currentLevel];
    const alerts = request.lastAlerts.slice(0, 3).map(alert => `${alert.sensor} (${alert.level})`).join(", ");
    return `**${headline}**\n\n- Water height: ${request.waterHeight} cm at sensor distance ${request.distance} cm\n- Rainfall last hour: ${request.rainfall} mm\n- Recent alerts: ${alerts || "No recent alerts"}`;
}
exports.predictFloodRisk = functions
    .region("us-central1")
    .runWith({ timeoutSeconds: 60, memory: "1GB" })
    .https.onCall(async (data, context) => {
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
exports.generateAlertSummary = functions
    .region("us-central1")
    .runWith({ timeoutSeconds: 60, memory: "1GB" })
    .https.onCall(async (data, context) => {
    if (!context.auth && functions.config().env?.require_auth === "true") {
        throw new functions.https.HttpsError("unauthenticated", "Authentication is required to call generateAlertSummary.");
    }
    const payload = validateAlertSummaryRequest(data);
    const geminiSummary = await callGeminiSummary(payload).catch(error => {
        functions.logger.error("Gemini summary call failed", error);
        return null;
    });
    let source = "gemini";
    let llmSummary = geminiSummary;
    if (!llmSummary) {
        llmSummary = fallbackSummary(payload);
        source = "fallback";
    }
    const finalSummary = llmSummary;
    const docRef = await db.collection(SUMMARY_COLLECTION).add({
        summary: finalSummary,
        payload,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        source,
    });
    return { summaryId: docRef.id };
});
exports.ping = functions.https.onRequest((req, res) => {
    res.status(200).send({ ok: true });
});
//# sourceMappingURL=index.js.map