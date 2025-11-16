# RaspberryPi-Firebase-Alerts-WebApp

This project delivers a complete Raspberry Pi + Firebase activity loop for community flood warnings. A Python script running on the Pi streams sensor-triggered alerts into a Firebase Firestore collection, while a modern React (Vite) web dashboard renders the data in real time and pushes browser notifications for anything new.

## Features
- Raspberry Pi publisher that reads your ultrasonic/gas/PIR sensor and writes alert documents to Firestore through the Firebase Admin SDK.
- Real-time React dashboard that listens to the `alerts` collection and renders a responsive alert grid.
- Browser system notifications that surface new alerts instantly after the user grants permission.
- Firebase Hosting configuration for quick deployment of the production build.
- Optional OpenWeather tile that surfaces live conditions beside the alert feed.

## Repository layout
```
.
├─ README.md
├─ pi/
│  └─ pi_alert.py
├─ firebase/
│  ├─ firebase.json
│  ├─ .firebaserc
│  └─ firestore.rules
└─ web/
   ├─ package.json
   ├─ index.html
   ├─ vite.config.js
   ├─ public/
   │  └─ favicon.png
   └─ src/
      ├─ main.jsx
      ├─ App.jsx
      ├─ firebase.js
      ├─ styles.css
      └─ components/
         ├─ AlertCard.jsx
         └─ WeatherPanel.jsx
```

## 1. Firebase setup (one-time)
1. Create a Firebase project, enable Firestore (Native mode), and optionally Hosting.
2. Generate a service account private key (Project Settings → Service accounts) for the Raspberry Pi. Download and store it securely on the Pi.
3. Never commit the service account JSON; keep it private.

## 2. Raspberry Pi alert sender
The script in `pi/pi_alert.py` simulates water level readings, determines severity, and writes alerts to Firestore. Replace the dummy sensor function with your hardware integration and export `GOOGLE_APPLICATION_CREDENTIALS` so the Firebase Admin SDK can locate your service account file.

### Run on Raspberry Pi
```bash
export GOOGLE_APPLICATION_CREDENTIALS="/home/pi/serviceAccountKey.json"
pip install firebase-admin
python3 pi/pi_alert.py
```

## 3. Web dashboard (React + Vite)
1. Update `web/src/firebase.js` with your Firebase web config (Project Settings → General → Your apps).
2. Install dependencies and start the dev server:
   ```bash
   cd web
   npm install
   npm run dev
   ```
3. The app listens to the `alerts` collection and renders a real-time grid. New alerts trigger browser notifications once permission is granted.
4. (Optional) To enable the weather tile, provide OpenWeather credentials using Vite env vars, e.g. create `web/.env.local` (not committed) containing:
   ```bash
   VITE_OPENWEATHER_API_KEY=your_api_key
   VITE_OPENWEATHER_CITY=London,uk   # or set VITE_OPENWEATHER_LAT / VITE_OPENWEATHER_LON
   VITE_OPENWEATHER_UNITS=metric     # metric | imperial | standard
   VITE_OPENWEATHER_REFRESH_MS=600000
   ```
   When deploying on Netlify, add the same keys in **Site settings → Environment variables** and redeploy.

## 4. Firebase Hosting
- The provided `firebase/firebase.json` points Hosting at `web/dist`.
- `firebase/firestore.rules` contains a minimal rule set; tighten it before production.
- Deploy with:
  ```bash
  npm install -g firebase-tools
  firebase login
  firebase use your-project-id
  cd web && npm run build
  firebase deploy --only hosting
  ```

## Next steps & ideas
- Integrate additional sensors or publish acknowledgements.
- Add authentication and an admin interface for manual alerts.
- Use Cloud Functions or FCM for richer push notifications.
- Visualise alert history and location on a map.

MIT License.
