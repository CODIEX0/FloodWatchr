"""
FloodWatchr with 3 levels of flood warnings.
Starts sending alerts at Level 2 (medium).
Continuous monitoring with gpiozero on Raspberry Pi 5.
"""

import time
import os
import statistics
from gpiozero import DistanceSensor
import firebase_admin
from firebase_admin import credentials, firestore

# ---------------------------
# FIREBASE SETUP
# ---------------------------
SERVICE_ACCOUNT_PATH = os.getenv(
    "GOOGLE_APPLICATION_CREDENTIALS",
    "/home/pi/serviceAccountKey.json"
)

cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
firebase_admin.initialize_app(cred)
db = firestore.client()

# ---------------------------
# SENSOR SETUP (Pi 5)
# ---------------------------
sensor = DistanceSensor(echo=24, trigger=23, max_distance=4)

# ---------------------------
# SETTINGS
# ---------------------------
CONTAINER_HEIGHT_CM = 20.0
ALERT_HEIGHT_CM = float(os.getenv('ALERT_HEIGHT_CM', '13.0'))  # baseline if needed

# Define three alert thresholds
FLOOD_LEVELS = {
    "low": ALERT_HEIGHT_CM,        # starts at 13 cm by default
    "medium": 15.0,                # Level 2: moderate flood
    "critical": 18.0               # Level 3: severe flood
}

READINGS_PER_SAMPLE = 5
ALERT_CONFIRM_COUNT = 3
LOOP_SLEEP_SECONDS = 2
ALERT_COOLDOWN_SECONDS = 10
AUDIO_FILE = "/home/pi/audiomass-output.mp3"

# ---------------------------
# FUNCTIONS
# ---------------------------
def get_distance_cm():
    readings = []
    for _ in range(READINGS_PER_SAMPLE):
        d = sensor.distance * 100
        if 1 < d < 400:
            readings.append(d)
        time.sleep(0.05)
    return statistics.median(readings) if readings else None

def determine_flood_level(water_height_cm):
    """
    Return flood level string based on water height.
    Level 2 (medium) is where alerts start.
    """
    if water_height_cm >= FLOOD_LEVELS["critical"]:
        return "critical"
    elif water_height_cm >= FLOOD_LEVELS["medium"]:
        return "medium"
    elif water_height_cm >= FLOOD_LEVELS["low"]:
        return "low"
    else:
        return None

def send_alert(level, water_height_cm, distance_cm):
    doc = {
        'sensor': 'flood',
        'level': level,
        'value': water_height_cm,
        'distance': distance_cm,
        'timestamp': firestore.SERVER_TIMESTAMP,
        'confirmations': ALERT_CONFIRM_COUNT,
    }
    db.collection('alerts').add(doc)
    print(f"🔥 Firebase alert sent: {level.upper()} | Water Height: {water_height_cm:.2f} cm")

def play_audio(file_path):
    if os.path.exists(file_path):
        print(f"⚠️ Playing alert audio for flood level!")
        os.system(f'ffplay -nodisp -autoexit "{file_path}" >/dev/null 2>&1')
    else:
        print("⚠️ Audio file missing, skipping.")

# ---------------------------
# MAIN LOOP
# ---------------------------
print("🌊 FloodWatchr 3-level monitoring started...")
time.sleep(2)

warning_counter = 0
current_level = None

try:
    while True:
        distance_cm = get_distance_cm()
        if distance_cm is None:
            print("⚠️ Sensor read failed, retrying...")
            time.sleep(LOOP_SLEEP_SECONDS)
            continue

        water_height_cm = round(max(CONTAINER_HEIGHT_CM - distance_cm, 0), 2)
        print(f"Distance: {distance_cm:.2f} cm | Water Height: {water_height_cm:.2f} cm")

        level = determine_flood_level(water_height_cm)

        # Only start sending alerts at medium or above
        if level in ["medium", "critical"]:
            if level == current_level:
                warning_counter += 1
            else:
                current_level = level
                warning_counter = 1
        else:
            warning_counter = 0
            current_level = None

        # Send alert after consecutive confirmations
        if warning_counter >= ALERT_CONFIRM_COUNT:
            send_alert(current_level, water_height_cm, distance_cm)
            play_audio(AUDIO_FILE)
            warning_counter = 0
            current_level = None
            time.sleep(ALERT_COOLDOWN_SECONDS)

        time.sleep(LOOP_SLEEP_SECONDS)

except KeyboardInterrupt:
    print("\n🛑 FloodWatchr stopped by user.")
