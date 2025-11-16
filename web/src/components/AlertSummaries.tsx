import React from 'react'
import { Timestamp } from 'firebase/firestore'
import type { AlertSummaryDoc } from '../services/ai'

interface AlertSummariesProps {
  items: AlertSummaryDoc[]
}

function formatTimestamp(value?: Date | Timestamp | null): string {
  if (!value) return '—'
  if (value instanceof Date) return value.toLocaleString()
  if (value instanceof Timestamp) {
    return value.toDate().toLocaleString()
  }
  return new Date(value as unknown as string).toLocaleString()
}

export default function AlertSummaries({ items }: AlertSummariesProps) {
  if (items.length === 0) {
    return (
      <section className="summary-panel">
        <header className="summary-header">
          <h2>AI alert summaries</h2>
        </header>
        <p className="summary-empty">No summaries yet. They will appear here once alerts are processed.</p>
      </section>
    )
  }

  return (
    <section className="summary-panel">
      <header className="summary-header">
        <h2>AI alert summaries</h2>
      </header>
      <ul className="summary-list">
        {items.map(item => (
          <li key={item.id} className="summary-item">
            <div className="summary-content">{item.summary}</div>
            <div className="summary-meta">{formatTimestamp(item.timestamp)}</div>
          </li>
        ))}
      </ul>
    </section>
  )
}
