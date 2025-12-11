from gpiozero import DistanceSensor
import time
import os
import statistics

# === GPIOZero Ultrasonic Setup ===
# echo=24, trigger=23  (same as your wiring)
sensor = DistanceSensor(echo=24, trigger=23, max_distance=4)  # 4 meters max
sensor.threshold_distance = 0.02  # 2 cm threshold, not used but required by class

# === Container Settings ===
CONTAINER_HEIGHT = 20.0   # cm
ALERT_HEIGHT = 15.0       # cm
AUDIO_FILE = "/home/codie/Downloads/flash_flood_alert.mp3"

def get_distance():
    """
    Take 5 readings using gpiozero sensor.distance (0–1 representing meters)
    Convert to cm and return the median.
    """
    readings = []

    for _ in range(5):
        distance_m = sensor.distance    # distance in meters (0–1)
        distance_cm = distance_m * 100  # convert to cm

        if 1 < distance_cm < 400:
            readings.append(distance_cm)

        time.sleep(0.05)

    if not readings:
        return 999  # fallback if glitch

    return statistics.median(readings)

def play_audio(file_path):
    print("Flood alert ⚠️ Playing alert audio...")
    os.system(f'ffplay -nodisp -autoexit "{file_path}" >/dev/null 2>&1')

try:
    print("Starting Water Level Detection (Pi 5 compatible)...")
    time.sleep(2)

    warning_counter = 0

    while True:
        distance = get_distance()
        water_height = max(CONTAINER_HEIGHT - distance, 0)

        print(f"Distance: {distance:.2f} cm | Water Height: {water_height:.2f} cm")

        # Check flood height
        if water_height >= ALERT_HEIGHT:
            warning_counter += 1
        else:
            warning_counter = 0

        # Alert only after 3 consecutive confirmations
        if warning_counter >= 3:
            play_audio(AUDIO_FILE)
            warning_counter = 0
            time.sleep(10)

        time.sleep(2)

except KeyboardInterrupt:
    print("\nMeasurement stopped by user.")
