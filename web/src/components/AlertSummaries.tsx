import React from 'react'
import { Timestamp } from 'firebase/firestore'
import type { AlertSummaryDoc } from '../services/ai'

interface AlertSummariesProps {
  items: AlertSummaryDoc[]
}

interface ParsedSummary {
  headline: string | null
  bullets: string[]
  paragraphs: string[]
  footer: string | null
}

const summaryTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

function stripMarkdown(text: string): string {
  return text.replace(/^[*_`]+/, '').replace(/[*_`]+$/, '').trim()
}

function parseSummary(raw: string): ParsedSummary {
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)

  let headline: string | null = null
  let footer: string | null = null
  const bullets: string[] = []
  const paragraphs: string[] = []

  lines.forEach(line => {
    if (!headline) {
      headline = stripMarkdown(line)
      return
    }

    if (/^[-*•]\s+/.test(line)) {
      bullets.push(stripMarkdown(line.replace(/^[-*•]\s+/, '')))
      return
    }

    if (/^_.*_$/.test(line)) {
      footer = stripMarkdown(line)
      return
    }

    paragraphs.push(stripMarkdown(line))
  })

  return { headline, bullets, paragraphs, footer }
}

function resolveDate(value?: Date | Timestamp | null): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (value instanceof Timestamp) {
    return value.toDate()
  }
  const parsed = new Date(value as unknown as string)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function formatTimestamp(value?: Date | Timestamp | null): string {
  const date = resolveDate(value)
  if (!date) return '—'
  return summaryTimestampFormatter.format(date)
}

function formatTimestampISO(value?: Date | Timestamp | null): string | undefined {
  const date = resolveDate(value)
  return date ? date.toISOString() : undefined
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
        {items.map(item => {
          const parsed = parseSummary(item.summary)
          const headline = parsed.headline || 'Live sensor update'
          const iso = formatTimestampISO(item.timestamp)
          return (
            <li key={item.id} className="summary-item">
              <header className="summary-item-header">
                <p className="summary-headline">{headline}</p>
                <time className="summary-meta" dateTime={iso}>{formatTimestamp(item.timestamp)}</time>
              </header>
              <div className="summary-content">
                {parsed.paragraphs.map((paragraph, index) => (
                  <p key={`paragraph-${item.id}-${index}`} className="summary-body">
                    {paragraph}
                  </p>
                ))}
                {parsed.bullets.length > 0 && (
                  <ul className="summary-points">
                    {parsed.bullets.map((bullet, bulletIndex) => (
                      <li key={`${item.id}-bullet-${bulletIndex}`}>{bullet}</li>
                    ))}
                  </ul>
                )}
                {parsed.footer && <p className="summary-footer">{parsed.footer}</p>}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
