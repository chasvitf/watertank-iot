// Settings to change for a real installation. The defaults run as-is in the
// Wokwi simulator (Wokwi-GUEST is the simulator's open Wi-Fi with internet).
#pragma once

// Wi-Fi
#define WIFI_SSID "Wokwi-GUEST"
#define WIFI_PASS ""
#define WIFI_CHANNEL 6  // Wokwi-GUEST is on channel 6; use 0 (scan all) on real hardware

// MQTT broker. broker.emqx.io is a free public broker: fine for a demo, but
// anyone can read or publish on it. Use a private broker with a user and
// password (EMQX Cloud, HiveMQ Cloud, Mosquitto) for a real tank.
#define MQTT_HOST "broker.emqx.io"
#define MQTT_PORT 8883  // MQTT over TLS
#define MQTT_USER ""
#define MQTT_PASS ""

// Topics are watertank-th/<DEVICE_ID>/{state,status,history,config,cmd}.
#define DEVICE_ID "demo-01"

// Pins (ESP32 DevKit)
#define PIN_TRIG 5       // HC-SR04 trigger
#define PIN_ECHO 18      // HC-SR04 echo (use a divider to 3.3 V on a real 5 V sensor, or a JSN-SR04T 3.3 V module)
#define PIN_PUMP 26      // relay for the refill pump (or a solenoid valve)
#define PIN_BUZZER 27
#define PIN_PUMP_LED 25
#define PIN_ALARM_LED 33
#define PIN_BUTTON 4     // to GND: short press silences the buzzer, hold 2 s clears a fault
#define RELAY_ACTIVE_LOW false  // most blue relay boards switch on LOW: set true for those

// Tank. Measure on the real tank: distance from the sensor to the bottom, and to
// the water when the tank is full. Litres at 100 % (here a 1,000 L round tank).
#define TANK_EMPTY_CM 120.0f
#define TANK_FULL_CM 20.0f
#define TANK_LITRES 1000.0f

// Timing
#define SENSOR_PERIOD_MS 1000
#define PUBLISH_PERIOD_MS 5000
#define HISTORY_PERIOD_MS 60000   // one averaged point per minute, last 60 kept
