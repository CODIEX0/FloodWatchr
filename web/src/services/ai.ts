import { httpsCallable } from 'firebase/functions'
import {
  collection,
  limit,
  onSnapshot,
  orderBy,
  QuerySnapshot,
  DocumentData,
  FirestoreError,
  Unsubscribe,
  Timestamp,
  query,
} from 'firebase/firestore'
import { functions, db } from '../firebase'

export type FloodTrend = 'stable' | 'rising' | 'falling' | string

export interface FloodRiskInput {
  distance_cm: number
  rainfall_mm: number
  humidity: number
  temp: number
  trend: FloodTrend
}

export type FloodRiskLevel = 'Low' | 'Medium' | 'High'

export interface FloodRiskPrediction {
  predictionId: string
  riskLevel: FloodRiskLevel
  explanation: string
  timestamp: Timestamp | Date
  rawInputs: FloodRiskInput
}

export interface FloodRiskResponse {
  riskLevel: FloodRiskLevel
  explanation: string
  predictionId: string
}

export interface AlertSummaryRequest {
  currentLevel: 1 | 2 | 3
  waterHeight: number
  distance: number
  rainfall: number
  lastAlerts: Array<{
    sensor: string
    level: string
    value: number | null
    timestamp: number
  }>
}

export interface AlertSummaryDoc {
  id: string
  summary: string
  timestamp?: Timestamp | Date
}

const predictFloodRiskCallable = httpsCallable<FloodRiskInput, FloodRiskResponse>(functions, 'predictFloodRisk')
const generateAlertSummaryCallable = httpsCallable<AlertSummaryRequest, { summaryId: string }>(
  functions,
  'generateAlertSummary'
)

export async function predictFloodRisk(inputs: FloodRiskInput): Promise<FloodRiskResponse> {
  const result = await predictFloodRiskCallable(inputs)
  return result.data
}

export async function generateAlertSummary(payload: AlertSummaryRequest): Promise<string> {
  const result = await generateAlertSummaryCallable(payload)
  return result.data.summaryId
}

export function listenAlertSummaries(
  onChange: (docs: AlertSummaryDoc[]) => void,
  onError: (error: FirestoreError) => void = () => {}
): Unsubscribe {
  const summariesRef = collection(db, 'alertSummaries')
  const summariesQuery = query(summariesRef, orderBy('timestamp', 'desc'), limit(20))

  return onSnapshot(summariesQuery, snapshot => handleSnapshot(snapshot, onChange), onError)
}

function handleSnapshot(
  snapshot: QuerySnapshot<DocumentData>,
  onChange: (docs: AlertSummaryDoc[]) => void
): void {
  const docs: AlertSummaryDoc[] = snapshot.docs.map(doc => {
    const data = doc.data()
    const timestamp = data.timestamp as Timestamp | Date | undefined
    return {
      id: doc.id,
      summary: typeof data.summary === 'string' ? data.summary : '',
      timestamp,
    }
  })
  onChange(docs)
}
