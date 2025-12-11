import React from 'react'
import type { FloodRiskLevel, FloodRiskResponse } from '../services/ai'

interface RiskCardProps {
  prediction: FloodRiskResponse | null
  isLoading: boolean
  error: string | null
}

const RISK_COLORS: Record<FloodRiskLevel, string> = {
  Low: 'risk-low',
  Medium: 'risk-medium',
  High: 'risk-high',
}

export default function RiskCard({ prediction, isLoading, error }: RiskCardProps) {
  return (
    <section className="risk-card">
      <header className="risk-header">
        <h2>AI flood Risk Detector</h2>
      </header>

      {isLoading && <p className="risk-message">Evaluating flood risk…</p>}

      {error && !isLoading && <p className="risk-message risk-error">{error}</p>}

      {!isLoading && !prediction && <p className="risk-message">Awaiting the next sensor update.</p>}

      {prediction && !isLoading && (
        <div className={`risk-body ${RISK_COLORS[prediction.riskLevel] ?? 'risk-low'}`}>
          <div className="risk-level">{prediction.riskLevel}</div>
          <p className="risk-explanation">{prediction.explanation}</p>
        </div>
      )}
    </section>
  )
}
