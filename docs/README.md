# ESP8266 PWM-to-Voltage Fan Controller Package

This version is for a 2-pin non-PWM 12V fan driven by a separate PWM-to-voltage / PWM-to-DC controller module.

## What changed from the MOSFET-only version?

The ESP8266 no longer directly switches fan power through a MOSFET stage. Instead:

```text
ESP8266 GPIO PWM signal → PWM-to-voltage module control input
PWM-to-voltage module output → 12V 2-pin fan
```

The web UI still shows speed as percent, but in this version it means the PWM command sent to the PWM-to-voltage module.

## Files

- `firmware/ESP8266_PWM_To_Voltage_FanController/ESP8266_PWM_To_Voltage_FanController.ino`
- `web/index.html`
- `web/style.css`
- `web/app.js`
- `docs/pwm_to_voltage_schematic.svg`
- `docs/README.md`

## Firmware setup

1. Install Arduino IDE.
2. Install ESP8266 board support.
3. Install libraries:
   - DHT sensor library by Adafruit
   - Adafruit Unified Sensor
   - ArduinoJson v6
4. Open the `.ino` file.
5. Edit WiFi credentials:
   ```cpp
   #define WIFI_SSID "YOUR_WIFI_SSID"
   #define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
   ```
6. Upload to ESP8266.
7. Open Serial Monitor at 115200 baud.
8. Copy the ESP8266 IP address.
9. Host the `web` folder on nginx and enter the ESP8266 API URL.

## Default pins

| Function | NodeMCU pin | GPIO |
|---|---:|---:|
| DHT11 data | D4 | GPIO2 |
| Fan 1 PWM control | D1 | GPIO5 |
| Fan 2 PWM control | D2 | GPIO4 |
| Fan 3 PWM control | D5 | GPIO14 |
| Fan 4 PWM control | D6 | GPIO12 |

## PWM frequency

Default:

```cpp
const uint16_t PWM_FREQ_HZ = 1000;
```

Many PWM-to-voltage modules work well at 500 Hz or 1000 Hz. Check your module documentation.

## Wiring reminder

- ESP8266 GND must connect to PWM-to-voltage module GND.
- 12V PSU GND should be common with the module and ESP8266 GND unless your module is opto-isolated and its manual says otherwise.
- Do not connect 12V to ESP8266 GPIO.
- Make sure the module PWM input accepts 3.3V logic. If it needs 5V PWM, use a logic-level shifter or transistor buffer.
