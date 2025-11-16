import React from 'react'
import { Timestamp } from 'firebase/firestore'

export interface WeatherSnapshot {
  temperature: number
  feelsLike: number
  humidity: number
  pressure: number
  windSpeed: number
  windDeg: number | null
  description: string
  icon: string | null
  visibilityKm: number | null
  cloudiness: number
  sunrise: Date | null
  sunset: Date | null
  updatedAt: Date | null
  rain1h: number | null
  rain3h: number | null
  location: string
}

export type WeatherStatus = 'disabled' | 'idle' | 'loading' | 'refreshing' | 'ready' | 'error'

interface WeatherPanelProps {
  status: WeatherStatus
  weather: WeatherSnapshot | null
  error: string | null
  onRefresh: () => void
  locationLabel?: string | null
  units: 'metric' | 'imperial' | 'standard'
}

function formatTime(value: Date | Timestamp | null | undefined): string {
  if (!value) return '—'
  if (value instanceof Date) return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (value instanceof Timestamp) {
    return value.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return '—'
}

export default function WeatherPanel({ status, weather, error, onRefresh, locationLabel, units }: WeatherPanelProps) {
  const tempUnit = units === 'imperial' ? '°F' : units === 'standard' ? 'K' : '°C'
  const windUnit = units === 'imperial' ? 'mph' : 'm/s'
  const isLoading = status === 'loading' || status === 'refreshing'

  if (status === 'disabled') {
    return (
      <section className="weather-panel disabled">
        <header className="weather-header">
          <h2>Local weather</h2>
        </header>
        <p className="weather-message">
          Add an OpenWeather API key via <code>VITE_OPENWEATHER_API_KEY</code> to enable live conditions.
        </p>
      </section>
    )
  }

  return (
    <section className={`weather-panel status-${status}`}>
      <header className="weather-header">
        <div>
          <h2>Local weather</h2>
          <p className="weather-location">{locationLabel || weather?.location || 'Select a location'}</p>
        </div>
        <button type="button" className="weather-refresh" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {status === 'error' && <p className="weather-message error">{error || 'Unable to load weather right now.'}</p>}

      {status === 'idle' && !weather && (
        <p className="weather-message">Enter a city or allow location access to fetch live weather data.</p>
      )}

      {(status === 'loading' || status === 'refreshing') && (
        <p className="weather-message">Fetching latest weather data…</p>
      )}

      {status === 'ready' && weather && (
        <div className="weather-body">
          <div className="weather-main">
            {weather.icon && (
              <img
                src={`https://openweathermap.org/img/wn/${weather.icon}@2x.png`}
                alt={weather.description || 'Weather icon'}
                className="weather-icon"
                width={64}
                height={64}
              />
            )}
            <div>
              <div className="weather-temp">
                {Math.round(weather.temperature)}
                <span className="temp-unit">{tempUnit}</span>
              </div>
              <div className="weather-desc">{weather.description || '—'}</div>
              <div className="weather-meta-line">
                Feels like {Math.round(weather.feelsLike)}
                {tempUnit}
              </div>
            </div>
          </div>

          <div className="weather-stats">
            <div className="weather-stat">
              <span className="label">Humidity</span>
              <span>{weather.humidity}%</span>
            </div>
            <div className="weather-stat">
              <span className="label">Wind</span>
              <span>
                {weather.windSpeed} {windUnit}
                {weather.windDeg != null ? ` · ${Math.round(weather.windDeg)}°` : ''}
              </span>
            </div>
            <div className="weather-stat">
              <span className="label">Pressure</span>
              <span>{weather.pressure} hPa</span>
            </div>
            <div className="weather-stat">
              <span className="label">Visibility</span>
              <span>{weather.visibilityKm ?? '—'} km</span>
            </div>
            <div className="weather-stat">
              <span className="label">Cloud cover</span>
              <span>{weather.cloudiness}%</span>
            </div>
            <div className="weather-stat">
              <span className="label">Rain (1h)</span>
              <span>{weather.rain1h != null ? `${weather.rain1h} mm` : 'n/a'}</span>
            </div>
            <div className="weather-stat">
              <span className="label">Rain (3h)</span>
              <span>{weather.rain3h != null ? `${weather.rain3h} mm` : 'n/a'}</span>
            </div>
          </div>

          <div className="weather-footer">
            <span>Sunrise {formatTime(weather.sunrise)}</span>
            <span>Sunset {formatTime(weather.sunset)}</span>
            <span>Updated {formatTime(weather.updatedAt)}</span>
          </div>
        </div>
      )}
    </section>
  )
}
