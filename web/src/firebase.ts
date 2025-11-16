import { initializeApp } from 'firebase/app'
import {
  getFirestore,
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  Unsubscribe,
  FirestoreError,
  Timestamp,
  DocumentData,
} from 'firebase/firestore'
import { getFunctions } from 'firebase/functions'

export interface AlertDocument {
  id: string
  sensor?: string
  level?: string
  value?: number
  timestamp?: Timestamp | Date
  distance?: number
  confirmations?: number
  [key: string]: unknown
}

const firebaseConfig = {
  apiKey: 'AIzaSyAiYB9qfEC3XNN4vQa_HsorNHiB4eaqoy0',
  authDomain: 'flood-warning-system-f1fd9.firebaseapp.com',
  projectId: 'flood-warning-system-f1fd9',
  storageBucket: 'flood-warning-system-f1fd9.firebasestorage.app',
  messagingSenderId: '207615094924',
  appId: '1:207615094924:web:48b5f2733c3722999e0ba9',
  measurementId: 'G-QD7SWJVTXB',
}

const app = initializeApp(firebaseConfig)

export const db = getFirestore(app)
export const functions = getFunctions(app)

export function subscribeAlerts(
  onChange: (alerts: AlertDocument[]) => void,
  onError: (error: FirestoreError) => void = () => {}
): Unsubscribe {
  const alertsRef = collection(db, 'alerts')
  const alertsQuery = query(alertsRef, orderBy('timestamp', 'desc'), limit(50))

  return onSnapshot(
    alertsQuery,
    snapshot => {
      const alerts: AlertDocument[] = snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as DocumentData) }))
      onChange(alerts)
    },
    error => {
      onError(error)
    }
  )
}
