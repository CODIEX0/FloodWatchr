import React, { useMemo } from 'react'
import type { FloodRiskResponse } from '../services/ai'
import type { WeatherSnapshot } from './WeatherPanel'
import type { AlertDocument } from '../firebase'

interface SafetyAssistantProps {
  prediction: FloodRiskResponse | null
  weather: WeatherSnapshot | null
  latestAlert: AlertDocument | null
  isLoading: boolean
  riskError: string | null
}

const ASSISTANT_GIF =
  'https://media.giphy.com/media/v1.Y2lkPWVjZjA1ZTQ3Zng2czA0ZGpqcXRvbDg0NWVhZzV5N2o3cTVvNm8yb2FpdnQwNHQ0MyZlcD12MV9naWZzX3NlYXJjaCZjdD1n/hrd7JFO6lbJNa5LqVb/giphy.gif'

type Tone = 'calm' | 'watch' | 'action'

interface AssistantCopy {
  tone: Tone
  headline: string
  reassurance: string
  actions: string[]
}

function pickTone(prediction: FloodRiskResponse | null): Tone {
  if (!prediction) {
    return 'calm'
  }

  if (prediction.riskLevel === 'High') {
    return 'action'
  }
  if (prediction.riskLevel === 'Medium') {
    return 'watch'
  }
  return 'calm'
}

function buildAssistantCopy(
  prediction: FloodRiskResponse | null,
  weather: WeatherSnapshot | null,
  latestAlert: AlertDocument | null,
  isLoading: boolean,
  riskError: string | null
): AssistantCopy {
  if (riskError) {
    return {
      tone: 'watch',
      headline: 'We had trouble reaching the AI just now.',
      reassurance: 'Sensors continue to report in, but the assistant response is delayed. We will retry shortly.',
      actions: ['Refresh the page if the issue persists.', 'Stay alert to manual updates from local authorities.'],
    }
  }

  if (isLoading) {
    return {
      tone: 'watch',
      headline: 'Analysing live sensor feed…',
      reassurance: 'Hang tight—Gemini is reviewing the newest readings and weather data for you.',
      actions: ['Keep an eye on notifications for the final verdict.', 'Prepare your go-bag if you live in a low area.'],
    }
  }

  const tone = pickTone(prediction)
  const sensorName = latestAlert?.sensor ? latestAlert.sensor.toLowerCase() : 'primary sensor'
  const rainfall = weather?.rain1h ?? weather?.rain3h ?? 0
  const windSpeed = weather?.windSpeed ?? 0
  const location = weather?.location || 'your area'

  const base: AssistantCopy = {
    tone,
    headline: '',
    reassurance: '',
    actions: [],
  }

  if (tone === 'action') {
    base.headline = 'Water is rising quickly—please move to higher ground now.'
    base.reassurance = `Sensor ${sensorName} and local weather show a high flood risk. Prioritise your safety and assist neighbours if possible.`
    base.actions = [
      'Begin evacuation plans immediately, especially for basements or ground floors.',
      'Cut power to low-lying areas if it can be done safely.',
    ]
  } else if (tone === 'watch') {
    base.headline = 'Conditions are shifting—stay on standby.'
    base.reassurance = `We are seeing elevated readings from ${sensorName}, but there is still time to prepare. We will keep you updated every few minutes.`
    base.actions = [
      'Secure valuables and clear drains to speed runoff.',
      'Review your evacuation route and share it with family members.',
    ]
  } else {
    base.headline = 'All clear for now—stay prepared and informed.'
    base.reassurance = `Sensors and weather over ${location} remain within safe ranges. We will alert you instantly if anything changes.`
    base.actions = [
      'Use this time to review your emergency kit.',
      'Check on neighbours who might need extra assistance.',
    ]
  }

  if (rainfall >= 20) {
    base.actions.push('Heavy rain continues—avoid low bridges and fast-moving water.')
  } else if (rainfall >= 5) {
    base.actions.push('Showers are passing through—watch for slick roads and pooling water.')
  }

  if (windSpeed >= 40) {
    base.actions.push('Strong winds detected—secure outdoor items and watch for falling branches.')
  }

  if (!prediction) {
    base.reassurance = `Waiting for the latest flood sensor readout near ${location}. We will ping you as soon as intel arrives.`
  }

  return base
}

export default function SafetyAssistant({
  prediction,
  weather,
  latestAlert,
  isLoading,
  riskError,
}: SafetyAssistantProps): React.ReactElement {
  const copy = useMemo(
    () => buildAssistantCopy(prediction, weather, latestAlert, isLoading, riskError),
    [prediction, weather, latestAlert, isLoading, riskError]
  )

  return (
    <section className={`assistant-panel assistant-${copy.tone}`}>
      <div className="assistant-avatar">
        <img src={ASSISTANT_GIF} alt="Animated flood safety assistant" loading="lazy" />
      </div>
      <div className="assistant-body">
        <header className="assistant-header">
          <h2>Safety Companion AI</h2>
          <p className="assistant-headline">{copy.headline}</p>
        </header>
        <p className="assistant-reassurance">{copy.reassurance}</p>
        <ul className="assistant-actions">
          {copy.actions.map(action => (
            <li key={action}>{action}</li>
          ))}
        </ul>
        <p className="assistant-footer">We are monitoring sensors and weather around the clock—stay tuned and stay safe.</p>
      </div>
    </section>
  )
}
