import React, { useMemo } from 'react'
import { Timestamp } from 'firebase/firestore'
import type { AlertDocument } from '../firebase'

interface AlertCardProps {
  alert: AlertDocument
}

const SENSOR_LABELS: Record<string, { title: string; units: string; valueKey: string }> = {
  flood: { title: 'Water level', units: 'cm', valueKey: 'value' },
  temperature: { title: 'Temperature', units: '°C', valueKey: 'value' },
  gas: { title: 'Gas concentration', units: '', valueKey: 'value' },
  motion: { title: 'Motion detected', units: '', valueKey: 'value' },
}

function formatTimestamp(timestamp?: Timestamp | Date | null): string {
  if (!timestamp) return new Date().toLocaleString()
  if (timestamp instanceof Timestamp) {
    return timestamp.toDate().toLocaleString()
  }
  if (timestamp instanceof Date) {
    return timestamp.toLocaleString()
  }
  return new Date(timestamp as unknown as string).toLocaleString()
}

export default function AlertCard({ alert }: AlertCardProps) {
  const level = (alert.level || 'info').toLowerCase()
  const colorClass = level === 'critical' ? 'card-critical' : level === 'warning' ? 'card-warning' : 'card-info'

  const summary = useMemo(() => {
    const descriptor = SENSOR_LABELS[alert.sensor as string] || {
      title: alert.sensor || 'Sensor',
      units: '',
      valueKey: 'value',
    }

    const rawValue = alert[descriptor.valueKey]
    const value = rawValue === undefined || rawValue === null ? 'n/a' : rawValue
    const suffix = descriptor.units ? ` ${descriptor.units}` : ''

    return {
      label: descriptor.title,
      value: `${value}${suffix}`,
    }
  }, [alert])

  const extras = useMemo(() => {
    const rows: Array<{ label: string; value: string | number }> = []
    if (alert.sensor === 'flood' && typeof alert.distance === 'number') {
      rows.push({ label: 'Distance to sensor', value: `${alert.distance} cm` })
    }
    if (alert.sensor === 'temperature' && typeof alert.humidity === 'number') {
      rows.push({ label: 'Humidity', value: `${alert.humidity}%` })
    }
    if (typeof alert.confirmations === 'number') {
      rows.push({ label: 'Consecutive hits', value: alert.confirmations })
    }
    return rows
  }, [alert])

  return (
    <article className={`alert-card ${colorClass}`}>
      <header className="card-header">
        <h3 className="card-title">{summary.label}</h3>
        <span className={`card-pill level-${level}`}>{(alert.level || 'info').toUpperCase()}</span>
      </header>
      <div className="card-value">{summary.value}</div>
      {extras.length > 0 && (
        <dl className="card-meta">
          {extras.map(item => (
            <div key={item.label} className="meta-row">
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <footer className="card-footer">
        <span>{alert.sensor || 'Unknown sensor'}</span>
        <time dateTime={new Date().toISOString()}>{formatTimestamp(alert.timestamp)}</time>
      </footer>
    </article>
  )
}
