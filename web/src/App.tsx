import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Timestamp } from 'firebase/firestore'
import AlertCard from './components/AlertCard'
import WeatherPanel, { WeatherSnapshot, WeatherStatus } from './components/WeatherPanel'
import RiskCard from './components/RiskCard'
import AlertSummaries from './components/AlertSummaries'
import SafetyAssistant from './components/SafetyAssistant'
import { subscribeAlerts, AlertDocument } from './firebase'
import {
  predictFloodRisk,
  generateAlertSummary,
  listenAlertSummaries,
  FloodRiskInput,
  FloodRiskResponse,
  FloodRiskLevel,
  FloodTrend,
  AlertSummaryDoc,
  AlertSummaryRequest,
} from './services/ai'

interface NotificationStatus {
  label: string
  className: 'status-disabled' | 'status-enabled' | 'status-blocked' | 'status-pending'
}

interface WeatherState {
  status: WeatherStatus
  data: WeatherSnapshot | null
  error: string | null
}

type Coordinates = { lat: number; lon: number; label: string }

const computeNotificationStatus = (): NotificationStatus => {
  if (typeof Notification === 'undefined') {
    return { label: 'Unavailable in this browser', className: 'status-disabled' }
  }
  if (Notification.permission === 'granted') {
    return { label: 'Enabled', className: 'status-enabled' }
  }
  if (Notification.permission === 'denied') {
    return { label: 'Blocked', className: 'status-blocked' }
  }
  return { label: 'Awaiting permission', className: 'status-pending' }
}

const parseCoordinate = (value: string | undefined): number | null => {
  if (!value) return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const titleCase = (text: string): string => text.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1))

const defaultTrend: FloodTrend = 'stable'

const levelDescriptions: Record<1 | 2 | 3, string> = {
  1: 'Conditions look safe right now.',
  2: 'Conditions are shifting, please stay alert.',
  3: 'Immediate action recommended—conditions are dangerous.',
}

function computeLocalFloodRisk(inputs: FloodRiskInput): FloodRiskResponse {
  let score = 0

  if (inputs.distance_cm <= 20) score += 3
  else if (inputs.distance_cm <= 50) score += 2
  else if (inputs.distance_cm <= 80) score += 1

  if (inputs.rainfall_mm >= 30) score += 3
  else if (inputs.rainfall_mm >= 15) score += 2
  else if (inputs.rainfall_mm >= 5) score += 1

  if (inputs.humidity >= 90) score += 1

  const trend = String(inputs.trend ?? '').toLowerCase()
  if (trend === 'rising') score += 2
  else if (trend === 'falling') score -= 1

  if (inputs.temp <= 2) score += 1

  const riskLevel: FloodRiskLevel = score >= 6 ? 'High' : score >= 3 ? 'Medium' : 'Low'

  const explanationPieces: string[] = []
  if (inputs.distance_cm <= 50) explanationPieces.push('Water level is close to the sensor')
  if (inputs.rainfall_mm >= 15) explanationPieces.push('Recent rainfall is heavy')
  if (trend === 'rising') explanationPieces.push('Rising water trend detected')
  if (inputs.humidity >= 90) explanationPieces.push('Humidity remains high')
  if (explanationPieces.length === 0) {
    explanationPieces.push('Sensor readings remain within safe ranges')
  }

  return {
    riskLevel,
    explanation: `${riskLevel} risk — ${explanationPieces.join('; ')}.`,
    predictionId: `local-${Date.now()}`,
  }
}

function buildLocalSummary(payload: AlertSummaryRequest): string {
  const headline = levelDescriptions[payload.currentLevel]
  const alerts = payload.lastAlerts.slice(0, 3)
  const alertLines = alerts
    .map(alert => {
      const when = new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      const reading = alert.value != null ? `${alert.value}` : 'n/a'
      return `  - ${alert.sensor} (${alert.level}) · ${reading} at ${when}`
    })
    .join('\n')

  const alertsSection = alertLines.length > 0 ? `- Recent alerts:\n${alertLines}` : '- Recent alerts: none reported'

  return `**${headline}**\n\n- Water height: ${payload.waterHeight} cm (sensor gap ${payload.distance} cm)\n- Rainfall last hour: ${payload.rainfall} mm\n${alertsSection}\n\n_Local assistant estimate while cloud AI reconnects._`
}

function pickNumericField(document: AlertDocument, keys: string[]): number | null {
  for (const key of keys) {
    const value = (document as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return null
}

export default function App(): React.ReactElement {
  const openWeatherKey = import.meta.env.VITE_OPENWEATHER_API_KEY as string | undefined
  const weatherUnits = ((import.meta.env.VITE_OPENWEATHER_UNITS as string | undefined) || 'metric').toLowerCase() as
    | 'metric'
    | 'imperial'
    | 'standard'
  const defaultCity = import.meta.env.VITE_OPENWEATHER_CITY as string | undefined
  const envLat = parseCoordinate(import.meta.env.VITE_OPENWEATHER_LAT as string | undefined)
  const envLon = parseCoordinate(import.meta.env.VITE_OPENWEATHER_LON as string | undefined)
  const refreshIntervalRaw = Number(import.meta.env.VITE_OPENWEATHER_REFRESH_MS || '600000')
  const refreshIntervalMs = Number.isFinite(refreshIntervalRaw) && refreshIntervalRaw > 0 ? refreshIntervalRaw : 600000

  const initialCoordinates =
    envLat != null && envLon != null
      ? {
          lat: envLat,
          lon: envLon,
          label: defaultCity || `${envLat.toFixed(2)}, ${envLon.toFixed(2)}`,
        }
      : null

  const [alerts, setAlerts] = useState<AlertDocument[]>([])
  const [filter, setFilter] = useState<'all' | 'critical' | 'warning' | 'info'>('all')
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>(() => computeNotificationStatus())
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'online' | 'offline' | 'error'>(
    typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'connecting'
  )
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [locationQuery, setLocationQuery] = useState<string>(defaultCity || '')
  const [coordinates, setCoordinates] = useState<{ lat: number; lon: number; label: string } | null>(initialCoordinates)
  const [weatherState, setWeatherState] = useState<WeatherState>(() => {
    if (!openWeatherKey) {
      return { status: 'disabled', data: null, error: 'Missing OpenWeather API key.' }
    }
    if (initialCoordinates) {
      return { status: 'loading', data: null, error: null }
    }
    return { status: 'idle', data: null, error: null }
  })
  const [geocodeStatus, setGeocodeStatus] = useState<'idle' | 'loading'>('idle')
  const [latestPrediction, setLatestPrediction] = useState<FloodRiskResponse | null>(null)
  const [riskLoading, setRiskLoading] = useState<boolean>(false)
  const [riskError, setRiskError] = useState<string | null>(null)
  const [summaries, setSummaries] = useState<AlertSummaryDoc[]>([])
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<Coordinates[]>([])
  const [suggestionsLoading, setSuggestionsLoading] = useState<boolean>(false)
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false)

  const seenAlertsRef = useRef<Set<string>>(new Set())
  const processedFloodAlerts = useRef<Set<string>>(new Set())
  const lastWaterHeightRef = useRef<number | null>(null)
  const locationInputRef = useRef<HTMLInputElement | null>(null)
  const blurTimeoutRef = useRef<number | null>(null)

  const isBrowser = typeof window !== 'undefined'
  const geolocationSupported = typeof navigator !== 'undefined' && 'geolocation' in navigator

  useEffect(() => {
    const unsubscribe = subscribeAlerts(
      all => {
        setConnectionStatus('online')
        setConnectionError(null)
        setAlerts(all)

        all.forEach(alert => {
          if (!seenAlertsRef.current.has(alert.id)) {
            seenAlertsRef.current.add(alert.id)
            if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
              new Notification(`${(alert.level || 'info').toUpperCase()} – ${alert.sensor}`, {
                body: `Value: ${alert.value ?? 'n/a'}`,
              })
            }
          }
        })
      },
      error => {
        console.error('Firestore subscription error', error)
        setConnectionStatus('error')
        setConnectionError(error.message || 'Unexpected Firestore error')
      }
    )

    if (!isBrowser) {
      return () => {
        unsubscribe()
      }
    }

    const handleOnline = () =>
      setConnectionStatus((prev: 'connecting' | 'online' | 'offline' | 'error') => (prev === 'error' ? prev : 'connecting'))
    const handleOffline = () => {
      setConnectionStatus('offline')
      setConnectionError('No network connection')
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)

    return () => {
      unsubscribe()
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [isBrowser])

  useEffect(() => {
    const unsubscribeSummaries = listenAlertSummaries(
      docs => {
        setSummaries(prev => {
          const localEntries = prev.filter(item => item.id.startsWith('local-'))
          const remoteIds = new Set(docs.map(doc => doc.id))
          const retainedLocal = localEntries.filter(item => !remoteIds.has(item.id))
          return [...retainedLocal, ...docs]
        })
        setSummaryError(null)
      },
      error => {
        console.error('Alert summary listener error', error)
        setSummaryError(error.message)
      }
    )

    return () => {
      unsubscribeSummaries()
    }
  }, [])

  useEffect(() => {
    setNotificationStatus(computeNotificationStatus())
  }, [])

  const fetchWeather = useCallback(
    async (coords: { lat: number; lon: number; label: string }, { silent = false } = {}): Promise<void> => {
      if (!openWeatherKey) {
        setWeatherState({ status: 'disabled', data: null, error: 'Missing OpenWeather API key.' })
        return
      }
      if (!coords) {
    setWeatherState((prev: WeatherState) => ({ ...prev, status: 'idle' }))
        return
      }

  setWeatherState((prev: WeatherState) => ({
        data: prev.data,
        error: null,
        status: prev.status === 'ready' && silent ? 'refreshing' : 'loading',
      }))

      try {
        const params = new URLSearchParams({
          lat: coords.lat.toString(),
          lon: coords.lon.toString(),
          units: weatherUnits,
          appid: openWeatherKey,
        })

        const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?${params.toString()}`)
        if (!response.ok) {
          throw new Error(`OpenWeather responded with ${response.status}`)
        }

        const data = await response.json()
        const windSpeedRaw = Number(data.wind?.speed ?? 0)
        const visibilityKm = data.visibility != null ? Math.round((Number(data.visibility) / 1000) * 10) / 10 : null

        const payload: WeatherSnapshot = {
          location: [data.name, data.sys?.country].filter(Boolean).join(', ') || coords.label,
          temperature: Number(data.main?.temp ?? 0),
          feelsLike: Number(data.main?.feels_like ?? data.main?.temp ?? 0),
          humidity: Number(data.main?.humidity ?? 0),
          pressure: Number(data.main?.pressure ?? 0),
          windSpeed: Number.isFinite(windSpeedRaw) ? Math.round(windSpeedRaw * 10) / 10 : 0,
          windDeg: Number.isFinite(Number(data.wind?.deg)) ? Number(data.wind.deg) : null,
          description: titleCase(data.weather?.[0]?.description || ''),
          icon: data.weather?.[0]?.icon ?? null,
          visibilityKm,
          cloudiness: Number(data.clouds?.all ?? 0),
          sunrise: data.sys?.sunrise ? new Date(data.sys.sunrise * 1000) : null,
          sunset: data.sys?.sunset ? new Date(data.sys.sunset * 1000) : null,
          updatedAt: new Date(),
          rain1h: typeof data.rain?.['1h'] === 'number' ? Number(data.rain['1h']) : null,
          rain3h: typeof data.rain?.['3h'] === 'number' ? Number(data.rain['3h']) : null,
        }

        setWeatherState({ status: 'ready', data: payload, error: null })
      } catch (error) {
        console.error('OpenWeather fetch failed', error)
  setWeatherState((prev: WeatherState) => ({
          status: 'error',
          data: prev.data,
          error: error instanceof Error ? error.message : 'Failed to load weather data.',
        }))
      }
    },
    [openWeatherKey, weatherUnits]
  )

  useEffect(() => {
    if (!isBrowser || !openWeatherKey) {
      setSuggestions([])
      setSuggestionsLoading(false)
      return
    }

    const query = locationQuery.trim()
    if (query.length < 3) {
      setSuggestions([])
      setSuggestionsLoading(false)
      return
    }

    setSuggestionsLoading(true)
    let cancelled = false

    const timerId = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: query, limit: '5', appid: openWeatherKey })
        const response = await fetch(`https://api.openweathermap.org/geo/1.0/direct?${params.toString()}`)
        if (!response.ok) {
          throw new Error(`Geocoding failed with status ${response.status}`)
        }

        const results = (await response.json()) as Array<{
          name: string
          state?: string
          country?: string
          lat: number
          lon: number
        }>

        if (cancelled) return

        const mapped = results.map(result => {
          const labelParts = [result.name, result.state, result.country].filter(Boolean)
          return {
            lat: Number(result.lat),
            lon: Number(result.lon),
            label: labelParts.join(', ') || result.name,
          }
        })

        setSuggestions(mapped)
        if (locationInputRef.current && document.activeElement === locationInputRef.current) {
          setShowSuggestions(mapped.length > 0 || query.length >= 3)
        }
      } catch (error) {
        if (cancelled) return
        console.error('Location suggestion lookup failed', error)
        setSuggestions([])
      } finally {
        if (!cancelled) {
          setSuggestionsLoading(false)
        }
      }
    }, 350)

    return () => {
      cancelled = true
      window.clearTimeout(timerId)
    }
  }, [isBrowser, locationQuery, openWeatherKey])

  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current != null) {
        window.clearTimeout(blurTimeoutRef.current)
      }
    }
  }, [])

  const handleLocationInputChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const value = event.target.value
    setLocationQuery(value)
    if (value.trim().length >= 3) {
      setShowSuggestions(true)
    } else {
      setShowSuggestions(false)
      setSuggestions([])
    }
  }

  const handleLocationFocus = (): void => {
    if (blurTimeoutRef.current != null) {
      window.clearTimeout(blurTimeoutRef.current)
      blurTimeoutRef.current = null
    }
    if (locationQuery.trim().length >= 3 && (suggestions.length > 0 || suggestionsLoading)) {
      setShowSuggestions(true)
    }
  }

  const handleLocationBlur = (): void => {
    if (blurTimeoutRef.current != null) {
      window.clearTimeout(blurTimeoutRef.current)
    }
    blurTimeoutRef.current = window.setTimeout(() => {
      setShowSuggestions(false)
    }, 120)
  }

  const handleSuggestionSelect = useCallback(
    (suggestion: Coordinates): void => {
      setCoordinates(suggestion)
      setLocationQuery(suggestion.label)
      setShowSuggestions(false)
      setSuggestions([])
      fetchWeather(suggestion).catch(console.error)
    },
    [fetchWeather]
  )

  useEffect(() => {
    if (!isBrowser || !openWeatherKey || !coordinates) {
      return undefined
    }

    fetchWeather(coordinates).catch(console.error)

    if (!Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) {
      return undefined
    }

    const intervalId = window.setInterval(() => {
      if (coordinates) {
        fetchWeather(coordinates, { silent: true }).catch(console.error)
      }
    }, refreshIntervalMs)

    return () => window.clearInterval(intervalId)
  }, [coordinates, fetchWeather, refreshIntervalMs, isBrowser, openWeatherKey])

  const handleLocationSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!openWeatherKey) {
      setWeatherState({ status: 'disabled', data: null, error: 'Add an OpenWeather API key to fetch weather.' })
      return
    }
    const query = locationQuery.trim()
    if (!query) {
  setWeatherState((prev: WeatherState) => ({ ...prev, status: 'error', error: 'Enter a city or town to search.' }))
      return
    }

    setGeocodeStatus('loading')
    try {
      const params = new URLSearchParams({ q: query, limit: '1', appid: openWeatherKey })
      const response = await fetch(`https://api.openweathermap.org/geo/1.0/direct?${params.toString()}`)
      if (!response.ok) {
        throw new Error(`Geocoding failed with status ${response.status}`)
      }
      const results = await response.json()
      if (!Array.isArray(results) || results.length === 0) {
        throw new Error('Location not found. Try a broader search.')
      }

      const best = results[0]
      const labelParts = [best.name, best.state, best.country].filter(Boolean)
      const label = labelParts.join(', ')
      const lat = Number(best.lat)
      const lon = Number(best.lon)

  setWeatherState((prev: WeatherState) => ({ ...prev, status: 'loading', error: null }))
      const selected = { lat, lon, label }
      setCoordinates(selected)
      setLocationQuery(label)
      setShowSuggestions(false)
      setSuggestions([])
      fetchWeather(selected).catch(console.error)
    } catch (error) {
      console.error('Geocode error', error)
  setWeatherState((prev: WeatherState) => ({
        status: 'error',
        data: prev.data,
        error: error instanceof Error ? error.message : 'Unable to find that location.',
      }))
    } finally {
      setGeocodeStatus('idle')
    }
  }

  const handleUseCurrentLocation = (): void => {
    if (!geolocationSupported) {
  setWeatherState((prev: WeatherState) => ({ ...prev, status: 'error', error: 'Geolocation is not available in this browser.' }))
      return
    }
    if (!openWeatherKey) {
      setWeatherState({ status: 'disabled', data: null, error: 'Add an OpenWeather API key to fetch weather.' })
      return
    }

    setGeocodeStatus('loading')
    navigator.geolocation.getCurrentPosition(
      position => {
        const { latitude, longitude } = position.coords
        const label = 'Current location'
  setWeatherState((prev: WeatherState) => ({ ...prev, status: 'loading', error: null }))
        setCoordinates({ lat: latitude, lon: longitude, label })
        setLocationQuery(label)
        setShowSuggestions(false)
        setSuggestions([])
        setGeocodeStatus('idle')
      },
      error => {
        console.error('Geolocation error', error)
        setGeocodeStatus('idle')
  setWeatherState((prev: WeatherState) => ({
          status: 'error',
          data: prev.data,
          error: error.message || 'Unable to access your location.',
        }))
      },
      { enableHighAccuracy: false, timeout: 10000 }
    )
  }

  useEffect(() => {
  const latestFloodCandidate =
      alerts.find((alert: AlertDocument) => typeof alert.sensor === 'string' && alert.sensor.toLowerCase().includes('flood')) ??
      alerts.find((alert: AlertDocument) => typeof alert.distance === 'number' && typeof alert.value === 'number') ??
      alerts[0]

    if (!latestFloodCandidate) {
      return
    }

    const alertKey = latestFloodCandidate.id
      ? String(latestFloodCandidate.id)
      : `${latestFloodCandidate.sensor ?? 'sensor'}-${
          latestFloodCandidate.timestamp instanceof Timestamp
            ? latestFloodCandidate.timestamp.toMillis()
            : latestFloodCandidate.timestamp instanceof Date
            ? latestFloodCandidate.timestamp.getTime()
            : Date.now()
        }`

    if (processedFloodAlerts.current.has(alertKey)) {
      return
    }

    const waterHeight =
      pickNumericField(latestFloodCandidate, ['value', 'waterHeight', 'height_cm', 'water_level_cm']) ?? null
    const distance = pickNumericField(latestFloodCandidate, ['distance', 'distance_cm', 'sensor_gap_cm']) ?? null

    if (waterHeight == null || distance == null) {
      processedFloodAlerts.current.add(alertKey)
      return
    }

    processedFloodAlerts.current.add(alertKey)

    const rainfall = weatherState.data?.rain1h ?? weatherState.data?.rain3h ?? 0
    const humidity = weatherState.data?.humidity ?? 0
    const temp = weatherState.data?.temperature ?? 0

    let trend: FloodTrend = defaultTrend
    if (lastWaterHeightRef.current != null) {
      if (waterHeight > lastWaterHeightRef.current + 0.5) trend = 'rising'
      else if (waterHeight < lastWaterHeightRef.current - 0.5) trend = 'falling'
    }
    lastWaterHeightRef.current = waterHeight

    const riskPayload: FloodRiskInput = {
      distance_cm: distance,
      rainfall_mm: rainfall,
      humidity,
      temp,
      trend,
    }

    setRiskLoading(true)
    setRiskError(null)

    predictFloodRisk(riskPayload)
      .then(prediction => {
        setLatestPrediction(prediction)
        setRiskError(null)
      })
      .catch(error => {
        console.error('Predict flood risk failed', error)
        const fallback = computeLocalFloodRisk(riskPayload)
        setLatestPrediction(fallback)
        setRiskError('Cloud AI temporarily unavailable — showing local estimate.')
      })
      .finally(() => {
        setRiskLoading(false)
      })

  const normalizedLevel = (latestFloodCandidate.level || '').toLowerCase()
    const levelToNumber = normalizedLevel === 'critical' || normalizedLevel === 'high' ? 3 : normalizedLevel === 'medium' || normalizedLevel === 'warning' ? 2 : 1

  const lastAlertsPayload = alerts.slice(0, 5).map((alert: AlertDocument) => ({
      sensor: String(alert.sensor || 'unknown'),
      level: String(alert.level || 'info'),
      value: typeof alert.value === 'number' ? alert.value : null,
      timestamp:
        alert.timestamp instanceof Timestamp
          ? alert.timestamp.toMillis()
          : alert.timestamp instanceof Date
          ? alert.timestamp.getTime()
          : Date.now(),
    }))

    generateAlertSummary({
      currentLevel: levelToNumber as 1 | 2 | 3,
      waterHeight,
      distance,
      rainfall,
      lastAlerts: lastAlertsPayload,
    }).catch(error => {
      console.error('generateAlertSummary failed', error)
      const fallbackSummary: AlertSummaryDoc = {
        id: `local-${Date.now()}`,
        summary: buildLocalSummary({
          currentLevel: levelToNumber as 1 | 2 | 3,
          waterHeight,
          distance,
          rainfall,
          lastAlerts: lastAlertsPayload,
        }),
        timestamp: new Date(),
      }

      setSummaries(prev => {
        if (prev.some(item => item.summary === fallbackSummary.summary)) {
          return prev
        }
        return [fallbackSummary, ...prev]
      })
      setSummaryError(null)
    })
  }, [alerts, weatherState.data])

  const stats = useMemo(() => {
    if (alerts.length === 0) {
      return { total: 0, critical: 0, warning: 0, info: 0, lastTimestamp: null as Date | Timestamp | null, latestAlert: null as AlertDocument | null }
    }

    const buckets = alerts.reduce(
      (acc: { critical: number; warning: number; info: number }, alert: AlertDocument) => {
        const level = (alert.level || 'info').toLowerCase()
        if (level === 'critical') acc.critical += 1
        else if (level === 'warning' || level === 'medium') acc.warning += 1
        else acc.info += 1
        return acc
      },
      { critical: 0, warning: 0, info: 0 }
    )

    const latest = alerts[0]
    const ts = latest?.timestamp instanceof Timestamp ? latest.timestamp.toDate() : latest?.timestamp instanceof Date ? latest.timestamp : null

    return {
      total: alerts.length,
      ...buckets,
      lastTimestamp: ts,
      latestAlert: latest,
    }
  }, [alerts])

  const humanLastUpdated =
    stats.lastTimestamp != null
      ? (stats.lastTimestamp instanceof Timestamp ? stats.lastTimestamp.toDate() : stats.lastTimestamp).toLocaleString()
      : 'No data yet'

  const filteredAlerts = useMemo(() => {
    if (filter === 'all') return alerts
  return alerts.filter((alert: AlertDocument) => (alert.level || 'info').toLowerCase() === filter)
  }, [alerts, filter])

  const handleEnableNotifications = (): void => {
    if (typeof Notification === 'undefined') return
    Notification.requestPermission().then(() => setNotificationStatus(computeNotificationStatus()))
  }

  const connectionMessage = useMemo(() => {
    switch (connectionStatus) {
      case 'connecting':
        return 'Connecting to Firebase…'
      case 'offline':
        return 'Offline — reconnect to resume live updates.'
      case 'error':
        return connectionError || 'Firestore connection error.'
      default:
        return null
    }
  }, [connectionStatus, connectionError])

  const weatherStatus = weatherState.status
  const weatherData = weatherState.data
  const weatherError = weatherState.error
  const locationLabel = weatherData?.location || coordinates?.label || locationQuery
  const locationLoading = geocodeStatus === 'loading'
  const showSuggestionsPanel = showSuggestions && (suggestionsLoading || suggestions.length > 0 || locationQuery.trim().length >= 3)
  const showNoMatches = !suggestionsLoading && suggestions.length === 0 && locationQuery.trim().length >= 3
  const latestAlert = stats.latestAlert

  return (
    <div className="app-root">
      <header className="topbar">
        <div>
          <h1>Community Alerts</h1>
          <p className="subtitle">Live flood and hazard updates from the Raspberry Pi network</p>
        </div>
        <div className="headline-stats">
          <span className="badge">Total alerts: {stats.total}</span>
          <span className="badge badge-critical">Critical: {stats.critical}</span>
          <span className="badge badge-warning">Warnings: {stats.warning}</span>
          <span className="badge badge-info">Info: {stats.info}</span>
        </div>
      </header>

      <main className="container">
        {connectionStatus !== 'online' && connectionMessage && (
          <div className={`connection-banner banner-${connectionStatus}`}>{connectionMessage}</div>
        )}

        <section className="weather-section">
          <div className="weather-controls">
            <form className="location-form" onSubmit={handleLocationSubmit}>
              <label className="visually-hidden" htmlFor="location-input">
                Search by city
              </label>
              <div className="location-input-wrapper">
                <input
                  ref={locationInputRef}
                  id="location-input"
                  className="weather-input"
                  type="text"
                  placeholder="Search city or town"
                  value={locationQuery}
                  onChange={handleLocationInputChange}
                  onFocus={handleLocationFocus}
                  onBlur={handleLocationBlur}
                  disabled={locationLoading}
                  autoComplete="off"
                  spellCheck={false}
                />
                {showSuggestionsPanel && (
                  <div className="location-suggestions">
                    {suggestionsLoading && <div className="suggestion-info suggestion-loading">Searching…</div>}
                    {showNoMatches && <div className="suggestion-info suggestion-empty">No matches found.</div>}
                    {!suggestionsLoading &&
                      suggestions.map(suggestion => (
                        <button
                          key={`${suggestion.lat.toFixed(3)}-${suggestion.lon.toFixed(3)}`}
                          type="button"
                          className="suggestion-item"
                          onMouseDown={event => {
                            event.preventDefault()
                            handleSuggestionSelect(suggestion)
                          }}
                        >
                          <span className="suggestion-name">{suggestion.label}</span>
                          <span className="suggestion-coords">
                            {suggestion.lat.toFixed(2)}, {suggestion.lon.toFixed(2)}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
              <button type="submit" className="location-submit" disabled={locationLoading}>
                Set location
              </button>
            </form>
            <button
              type="button"
              className="weather-geolocate"
              onClick={handleUseCurrentLocation}
              disabled={locationLoading || !geolocationSupported}
              title={geolocationSupported ? undefined : 'Geolocation is not supported in this browser'}
            >
              Use current location
            </button>
          </div>

          <WeatherPanel
            status={weatherStatus}
            weather={weatherData}
            error={weatherError}
            locationLabel={locationLabel}
            units={weatherUnits}
            onRefresh={() => coordinates && fetchWeather(coordinates).catch(console.error)}
          />

          <RiskCard prediction={latestPrediction} isLoading={riskLoading} error={riskError} />
          <SafetyAssistant
            prediction={latestPrediction}
            weather={weatherData}
            latestAlert={latestAlert}
            isLoading={riskLoading}
            riskError={riskError}
          />
        </section>

        <section className="status-bar">
          <div className="status-card">
            <div className="status-label">Last updated</div>
            <div className="status-value">{humanLastUpdated}</div>
          </div>
          <div className="status-card">
            <div className="status-label">Sensor network</div>
            <div className="status-value">
              {stats.critical > 0 ? 'Immediate action required' : stats.warning > 0 ? 'Monitor closely' : 'All clear'}
            </div>
            <p className="status-hint">
              {stats.critical > 0
                ? 'Critical water levels detected — evacuate low areas.'
                : stats.warning > 0
                ? 'Flood risk rising — prepare mitigation steps.'
                : 'Water levels within safe range.'}
            </p>
          </div>
          <div className="status-card">
            <div className="status-label">Notification status</div>
            <div className={`status-value ${notificationStatus.className}`}>{notificationStatus.label}</div>
            <p className="status-hint">Browser notifications fire for new alerts once permission is granted.</p>
          </div>
        </section>

        {stats.latestAlert && (
          <section className="latest-alert">
            <div className="latest-header">
              <span className="latest-title">Most recent alert</span>
              <span className={`latest-badge level-${(stats.latestAlert.level || 'info').toLowerCase()}`}>
                {(stats.latestAlert.level || 'info').toUpperCase()}
              </span>
            </div>
            <p className="latest-body">
              {(stats.latestAlert.level || 'info').toUpperCase()} alert from sensor '{stats.latestAlert.sensor}' with value{' '}
              <strong>{stats.latestAlert.value ?? 'n/a'}</strong>
            </p>
            <p className="latest-meta">
              Received
              {stats.latestAlert.timestamp instanceof Timestamp
                ? ` ${stats.latestAlert.timestamp.toDate().toLocaleString()}`
                : stats.latestAlert.timestamp instanceof Date
                ? ` ${stats.latestAlert.timestamp.toLocaleString()}`
                : ' just now'}
            </p>
          </section>
        )}

        {notificationStatus.className === 'status-pending' && (
          <div className="notification-prompt">
            <p>Enable browser notifications to be alerted instantly when new flood warnings arrive.</p>
            <button type="button" onClick={handleEnableNotifications} className="notification-btn">
              Enable notifications
            </button>
          </div>
        )}

        <AlertSummaries items={summaries} />
        {summaryError && <div className="risk-message risk-error">{summaryError}</div>}

        <div className="filters">
          {(['all', 'critical', 'warning', 'info'] as const).map(option => (
            <button
              key={option}
              type="button"
              className={`filter-btn ${filter === option ? 'filter-btn-active' : ''}`}
              onClick={() => setFilter(option)}
            >
              {option === 'all' ? 'All alerts' : option.charAt(0).toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>

        <section className="alerts">
          {filteredAlerts.length === 0 && (
            <div className="empty">
              {alerts.length === 0
                ? 'No alerts yet — system is normal.'
                : 'Nothing to show for this filter. Try another view.'}
            </div>
          )}
          {filteredAlerts.map(alert => (
            <AlertCard key={alert.id} alert={alert} />
          ))}
        </section>
      </main>

      <footer className="footer">FloodWatchr • Community Flood Alerts</footer>
    </div>
  )
}
