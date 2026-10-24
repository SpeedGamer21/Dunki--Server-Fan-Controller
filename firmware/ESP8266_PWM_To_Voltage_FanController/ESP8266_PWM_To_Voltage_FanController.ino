/*
  ESP8266 PWM-to-Voltage 12V 2-wire Fan Controller
  ------------------------------------------------------------
  Use this firmware when your 2-pin non-PWM 12V fan is controlled by an
  external PWM-to-voltage / PWM-to-DC controller module.

  ESP8266 produces a PWM control signal.
  Your PWM-to-voltage module converts that PWM into analog/DC fan voltage.

  Features:
  - Turn each fan on/off
  - Per-fan or global temperature-to-speed curves
  - nginx-hosted web UI with REST API
  - Webhook temperature warning alerts
  - Serial logs for debugging

  Required Arduino libraries:
  - ESP8266 board package
  - DHT sensor library by Adafruit
  - Adafruit Unified Sensor
  - ArduinoJson v6

  Wiring concept:
  ESP8266 GPIO PWM -> PWM input of PWM-to-voltage module
  ESP8266 GND -> module GND
  12V PSU + -> module/fan supply +
  12V PSU GND -> module/fan supply GND
*/

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <EEPROM.h>
#include <ArduinoJson.h>
#include <DHT.h>

// -------------------- USER CONFIG --------------------
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

const char* allowedOrigin = "*";

#define DHT_PIN D4
#define DHT_TYPE DHT11

const uint8_t FAN_COUNT = 4;
const uint8_t FAN_PWM_PINS[FAN_COUNT] = {D1, D2, D5, D6};

// Most PWM-to-voltage modules work with low-frequency PWM.
// Good starting values: 500 or 1000 Hz.
// If your module documentation recommends a frequency, use that.
const uint16_t PWM_FREQ_HZ = 1000;
const uint16_t PWM_RANGE = 1023;

// Optional minimum startup kick.
// When a fan changes from 0% to non-zero, firmware briefly outputs 100%.
// This helps 2-wire fans start reliably when the final voltage/speed is low.
const bool ENABLE_STARTUP_KICK = true;
const uint16_t STARTUP_KICK_MS = 1200;
const uint8_t STARTUP_KICK_THRESHOLD_PERCENT = 5;

ESP8266WebServer server(80);
DHT dht(DHT_PIN, DHT_TYPE);

struct CurvePoint {
  float tempC;
  uint8_t speedPct;
};

struct FanConfig {
  bool enabled;
  CurvePoint points[6];
};

struct Config {
  uint32_t magic;
  bool useGlobalCurve;
  FanConfig fans[FAN_COUNT];
  CurvePoint globalPoints[6];
  float warningTempC;
  char webhookUrl[192];
};

const uint32_t CONFIG_MAGIC = 0xA11F2026;
Config cfg;

float currentTempC = NAN;
float currentHumidity = NAN;

unsigned long lastSensorRead = 0;
unsigned long lastControlUpdate = 0;
unsigned long lastWebhookSent = 0;
bool alertActive = false;

uint8_t lastCommandedSpeed[FAN_COUNT] = {0, 0, 0, 0};
// Kick timing uses start time + elapsed so it stays correct across millis() rollover.
bool kickActive[FAN_COUNT] = {false, false, false, false};
unsigned long kickStartMs[FAN_COUNT] = {0, 0, 0, 0};

const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000;
const unsigned long SENSOR_INTERVAL_MS = 2000;
const unsigned long CONTROL_INTERVAL_MS = 500;
const unsigned long WEBHOOK_COOLDOWN_MS = 300000;

// -------------------- UTILITIES --------------------
void logLine(const String& msg) {
  Serial.printf("[%lu ms] %s\n", millis(), msg.c_str());
}

void defaultCurve(CurvePoint* pts) {
  // Safer default for 2-wire fans controlled by voltage:
  // many fans may not start below about 35-50% equivalent voltage.
  pts[0] = {20, 0};
  pts[1] = {28, 45};
  pts[2] = {35, 55};
  pts[3] = {50, 70};
  pts[4] = {65, 85};
  pts[5] = {80, 100};
}

void setDefaults() {
  cfg.magic = CONFIG_MAGIC;
  cfg.useGlobalCurve = true;
  cfg.warningTempC = 60.0;
  cfg.webhookUrl[0] = '\0';
  defaultCurve(cfg.globalPoints);
  for (uint8_t i = 0; i < FAN_COUNT; i++) {
    cfg.fans[i].enabled = true;
    defaultCurve(cfg.fans[i].points);
  }
}

void saveConfig() {
  EEPROM.put(0, cfg);
  EEPROM.commit();
  logLine("Config saved to EEPROM");
}

void loadConfig() {
  EEPROM.begin(sizeof(Config) + 16);
  EEPROM.get(0, cfg);
  if (cfg.magic != CONFIG_MAGIC) {
    logLine("No valid EEPROM config found; loading PWM-to-voltage defaults");
    setDefaults();
    saveConfig();
  } else {
    logLine("Config loaded from EEPROM");
  }
}

uint8_t clampSpeed(int v) {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return (uint8_t)v;
}

float clampTemp(float t) {
  if (t < -10) return -10;
  if (t > 120) return 120;
  return t;
}

void sortCurve(CurvePoint* pts) {
  for (int i = 0; i < 5; i++) {
    for (int j = i + 1; j < 6; j++) {
      if (pts[j].tempC < pts[i].tempC) {
        CurvePoint tmp = pts[i];
        pts[i] = pts[j];
        pts[j] = tmp;
      }
    }
  }
}

uint8_t speedFromCurve(float tempC, CurvePoint* pts) {
  sortCurve(pts);
  if (isnan(tempC)) return 0;
  if (tempC <= pts[0].tempC) return pts[0].speedPct;
  if (tempC >= pts[5].tempC) return pts[5].speedPct;

  for (uint8_t i = 0; i < 5; i++) {
    if (tempC >= pts[i].tempC && tempC <= pts[i + 1].tempC) {
      float span = pts[i + 1].tempC - pts[i].tempC;
      if (span <= 0.01) return pts[i + 1].speedPct;
      float ratio = (tempC - pts[i].tempC) / span;
      float s = pts[i].speedPct + ratio * (pts[i + 1].speedPct - pts[i].speedPct);
      return clampSpeed(round(s));
    }
  }
  return 0;
}

bool isKicking(uint8_t fan) {
  if (!ENABLE_STARTUP_KICK || !kickActive[fan]) return false;
  if (millis() - kickStartMs[fan] >= STARTUP_KICK_MS) {
    kickActive[fan] = false;
    return false;
  }
  return true;
}

void writePwmPercent(uint8_t fan, uint8_t speedPct) {
  uint16_t duty = map(speedPct, 0, 100, 0, PWM_RANGE);
  analogWrite(FAN_PWM_PINS[fan], duty);
}

void updateFans() {
  if (millis() - lastControlUpdate < CONTROL_INTERVAL_MS) return;
  lastControlUpdate = millis();

  for (uint8_t i = 0; i < FAN_COUNT; i++) {
    uint8_t targetSpeed = 0;

    if (cfg.fans[i].enabled) {
      CurvePoint* curve = cfg.useGlobalCurve ? cfg.globalPoints : cfg.fans[i].points;
      targetSpeed = speedFromCurve(currentTempC, curve);
    }

    if (ENABLE_STARTUP_KICK &&
        lastCommandedSpeed[i] == 0 &&
        targetSpeed >= STARTUP_KICK_THRESHOLD_PERCENT) {
      kickActive[i] = true;
      kickStartMs[i] = millis();
      Serial.printf("[KICK] fan=%u startup kick for %u ms\n", i + 1, STARTUP_KICK_MS);
    }

    uint8_t outputSpeed = targetSpeed;
    if (isKicking(i)) {
      outputSpeed = 100;
    }

    writePwmPercent(i, outputSpeed);
    lastCommandedSpeed[i] = targetSpeed;

    if (isnan(currentTempC)) {
      Serial.printf("[FAN] fan=%u enabled=%s temp=N/A target=%u%% pwm_output=%u%%\n",
        i + 1, cfg.fans[i].enabled ? "true" : "false", targetSpeed, outputSpeed);
    } else {
      Serial.printf("[FAN] fan=%u enabled=%s temp=%.1fC target=%u%% pwm_output=%u%%\n",
        i + 1, cfg.fans[i].enabled ? "true" : "false", currentTempC, targetSpeed, outputSpeed);
    }
  }
}

void readSensor() {
  if (millis() - lastSensorRead < SENSOR_INTERVAL_MS) return;
  lastSensorRead = millis();

  float h = dht.readHumidity();
  float t = dht.readTemperature();

  if (isnan(h) || isnan(t)) {
    logLine("DHT11 read failed; temperature is N/A");
    currentTempC = NAN;
    currentHumidity = NAN;
    return;
  }

  currentHumidity = h;
  currentTempC = t;
  Serial.printf("[DHT] temp=%.1fC humidity=%.1f%%\n", currentTempC, currentHumidity);
}

void sendWebhookIfNeeded() {
  if (isnan(currentTempC)) return;
  if (strlen(cfg.webhookUrl) == 0) return;

  bool over = currentTempC >= cfg.warningTempC;
  if (!over) {
    if (alertActive) logLine("Temperature alert cleared");
    alertActive = false;
    return;
  }

  if (alertActive && millis() - lastWebhookSent < WEBHOOK_COOLDOWN_MS) return;

  alertActive = true;
  lastWebhookSent = millis();

  if (WiFi.status() != WL_CONNECTED) {
    logLine("Webhook skipped: WiFi not connected");
    return;
  }

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, cfg.webhookUrl)) {
    logLine("Webhook failed: invalid URL");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  StaticJsonDocument<256> doc;
  doc["event"] = "temperature_warning";
  doc["temperature_c"] = currentTempC;
  doc["threshold_c"] = cfg.warningTempC;
  doc["humidity"] = currentHumidity;
  doc["device"] = WiFi.hostname();
  doc["controller_mode"] = "pwm_to_voltage";
  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  Serial.printf("[WEBHOOK] POST code=%d body=%s\n", code, body.c_str());
  http.end();
}

// -------------------- HTTP HELPERS --------------------
void sendCors() {
  server.sendHeader("Access-Control-Allow-Origin", allowedOrigin);
  server.sendHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
}

void sendJson(int status, const String& body) {
  sendCors();
  server.send(status, "application/json", body);
}

void handleOptions() {
  sendCors();
  server.send(204);
}

void curveToJson(JsonArray arr, CurvePoint* pts) {
  sortCurve(pts);
  for (uint8_t i = 0; i < 6; i++) {
    JsonObject p = arr.createNestedObject();
    p["temp"] = pts[i].tempC;
    p["speed"] = pts[i].speedPct;
  }
}

void jsonToCurve(JsonArray arr, CurvePoint* pts) {
  uint8_t n = min((size_t)6, arr.size());
  for (uint8_t i = 0; i < n; i++) {
    pts[i].tempC = clampTemp(arr[i]["temp"] | pts[i].tempC);
    // int default (not uint8_t) so out-of-range values reach clampSpeed instead of being ignored
    pts[i].speedPct = clampSpeed(arr[i]["speed"] | (int)pts[i].speedPct);
  }
  sortCurve(pts);
}

void handleStatus() {
  // Heap-allocated: the ESP8266 loop() stack is only ~4 KB.
  DynamicJsonDocument doc(2048);

  if (isnan(currentTempC)) {
    doc["temperatureC"] = nullptr;
  } else {
    doc["temperatureC"] = currentTempC;
  }

  if (isnan(currentHumidity)) {
    doc["humidity"] = nullptr;
  } else {
    doc["humidity"] = currentHumidity;
  }

  doc["warningTempC"] = cfg.warningTempC;
  doc["useGlobalCurve"] = cfg.useGlobalCurve;
  doc["webhookUrlSet"] = strlen(cfg.webhookUrl) > 0;
  doc["ip"] = WiFi.localIP().toString();
  doc["wifiConnected"] = WiFi.status() == WL_CONNECTED;
  doc["rssi"] = WiFi.RSSI();
  doc["uptimeMs"] = millis();
  doc["controllerMode"] = "PWM to voltage";
  doc["pwmFrequencyHz"] = PWM_FREQ_HZ;

  JsonArray fans = doc.createNestedArray("fans");
  for (uint8_t i = 0; i < FAN_COUNT; i++) {
    JsonObject f = fans.createNestedObject();
    f["id"] = i;
    f["enabled"] = cfg.fans[i].enabled;
    CurvePoint* curve = cfg.useGlobalCurve ? cfg.globalPoints : cfg.fans[i].points;
    uint8_t target = cfg.fans[i].enabled ? speedFromCurve(currentTempC, curve) : 0;
    f["speed"] = target;
    f["pwmOutput"] = isKicking(i) ? 100 : target;
  }

  JsonArray global = doc.createNestedArray("globalCurve");
  curveToJson(global, cfg.globalPoints);

  JsonArray fanCurves = doc.createNestedArray("fanCurves");
  for (uint8_t i = 0; i < FAN_COUNT; i++) {
    JsonArray c = fanCurves.createNestedArray();
    curveToJson(c, cfg.fans[i].points);
  }

  String out;
  serializeJson(doc, out);
  sendJson(200, out);
}

void handleConfigPost() {
  if (!server.hasArg("plain")) {
    sendJson(400, "{\"error\":\"missing JSON body\"}");
    return;
  }

  // Heap-allocated: a 4 KB StaticJsonDocument would overflow the ~4 KB stack.
  DynamicJsonDocument doc(4096);
  DeserializationError err = deserializeJson(doc, server.arg("plain"));
  if (err) {
    sendJson(400, "{\"error\":\"invalid JSON\"}");
    return;
  }

  if (doc.containsKey("warningTempC")) cfg.warningTempC = clampTemp(doc["warningTempC"].as<float>());
  if (doc.containsKey("useGlobalCurve")) cfg.useGlobalCurve = doc["useGlobalCurve"].as<bool>();

  if (doc.containsKey("webhookUrl")) {
    String url = doc["webhookUrl"].as<String>();
    url.trim();
    url.toCharArray(cfg.webhookUrl, sizeof(cfg.webhookUrl));
  }

  if (doc.containsKey("globalCurve")) {
    jsonToCurve(doc["globalCurve"].as<JsonArray>(), cfg.globalPoints);
  }

  if (doc.containsKey("fanCurves")) {
    JsonArray fanCurves = doc["fanCurves"].as<JsonArray>();
    for (uint8_t i = 0; i < min((size_t)FAN_COUNT, fanCurves.size()); i++) {
      jsonToCurve(fanCurves[i].as<JsonArray>(), cfg.fans[i].points);
    }
  }

  saveConfig();
  handleStatus();
}

void handleFanPost() {
  if (!server.hasArg("plain")) {
    sendJson(400, "{\"error\":\"missing JSON body\"}");
    return;
  }

  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, server.arg("plain"))) {
    sendJson(400, "{\"error\":\"invalid JSON\"}");
    return;
  }

  int id = doc["id"] | -1;
  if (id < 0 || id >= FAN_COUNT) {
    sendJson(400, "{\"error\":\"invalid fan id\"}");
    return;
  }

  if (doc.containsKey("enabled")) {
    cfg.fans[id].enabled = doc["enabled"].as<bool>();
    if (!cfg.fans[id].enabled) {
      kickActive[id] = false;
      lastCommandedSpeed[id] = 0;
      writePwmPercent(id, 0);
    }
    Serial.printf("[API] fan=%d enabled=%s\n", id + 1, cfg.fans[id].enabled ? "true" : "false");
  }

  saveConfig();
  handleStatus();
}

void handleRoot() {
  sendCors();
  server.send(200, "text/plain", "ESP8266 PWM-to-voltage fan controller API is running. Use /api/status, /api/config, /api/fan");
}

void setupServer() {
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/config", HTTP_OPTIONS, handleOptions);
  server.on("/api/config", HTTP_POST, handleConfigPost);
  server.on("/api/fan", HTTP_OPTIONS, handleOptions);
  server.on("/api/fan", HTTP_POST, handleFanPost);
  server.onNotFound([]() {
    if (server.method() == HTTP_OPTIONS) {
      handleOptions();
    } else {
      sendJson(404, "{\"error\":\"not found\"}");
    }
  });
  server.begin();
  logLine("HTTP API server started");
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  logLine("Booting ESP8266 PWM-to-voltage fan controller");

  loadConfig();
  dht.begin();

  analogWriteRange(PWM_RANGE);
  analogWriteFreq(PWM_FREQ_HZ);
  for (uint8_t i = 0; i < FAN_COUNT; i++) {
    pinMode(FAN_PWM_PINS[i], OUTPUT);
    analogWrite(FAN_PWM_PINS[i], 0);
  }

  WiFi.mode(WIFI_STA);
  WiFi.hostname("esp8266-pwm-voltage-fan");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  // Don't block forever: fan control must run even if WiFi is down.
  // The ESP8266 keeps retrying in the background and auto-reconnects.
  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
  unsigned long wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < WIFI_CONNECT_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WIFI] Connected. IP=%s RSSI=%d\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    logLine("[WIFI] Not connected yet; starting fan control anyway, will keep retrying");
  }

  setupServer();
}

void loop() {
  server.handleClient();
  readSensor();
  updateFans();
  sendWebhookIfNeeded();
}
