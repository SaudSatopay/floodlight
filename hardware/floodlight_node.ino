/*
 * FLOODLIGHT level node — ₹2,000 bill of materials:
 *   ESP32 DevKit v1  (~₹450)  ·  HC-SR04 / JSN-SR04T ultrasonic  (~₹150/₹550)
 *   IP65 box, mount, PSU/power-bank                             (~rest)
 *
 * Mounted over the kerb pointing straight down. Measures distance to the
 * road (dry) vs distance to the water surface (flooded); the difference
 * is standing-water depth. POSTs to the ward server every INTERVAL_MS.
 *
 * Flash with Arduino IDE: board "ESP32 Dev Module", fill in the four
 * constants below. That's the whole setup.
 */

#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID  = "your-wifi";
const char* WIFI_PASS  = "your-pass";
const char* SERVER     = "http://192.168.1.50:8737/api/sensor"; // ward server
const char* SEGMENT_ID = "amb-02";                              // Hindmata Jn

const int TRIG_PIN = 5;
const int ECHO_PIN = 18;
const unsigned long INTERVAL_MS = 15000;

// Distance from sensor face to dry road, measured once at install time.
float DRY_ROAD_CM = 250.0;

float readDistanceCm() {
  digitalWrite(TRIG_PIN, LOW);  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH); delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long us = pulseIn(ECHO_PIN, HIGH, 30000);
  if (us == 0) return -1;
  return us * 0.0343f / 2.0f;
}

float medianOf5() {
  float v[5];
  for (int i = 0; i < 5; i++) { v[i] = readDistanceCm(); delay(60); }
  for (int i = 0; i < 4; i++)
    for (int j = i + 1; j < 5; j++)
      if (v[j] < v[i]) { float t = v[i]; v[i] = v[j]; v[j] = t; }
  return v[2];
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.println("\nFLOODLIGHT node online");
}

void loop() {
  float d = medianOf5();
  if (d > 0) {
    float depth = DRY_ROAD_CM - d;
    if (depth < 0) depth = 0;
    if (WiFi.status() == WL_CONNECTED) {
      HTTPClient http;
      http.begin(SERVER);
      http.addHeader("Content-Type", "application/json");
      String body = String("{\"segment\":\"") + SEGMENT_ID +
                    "\",\"depth_cm\":" + String(depth, 1) + "}";
      int code = http.POST(body);
      Serial.printf("depth %.1f cm → HTTP %d\n", depth, code);
      http.end();
    }
  }
  delay(INTERVAL_MS);
}
